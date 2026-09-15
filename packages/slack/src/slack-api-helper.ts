import type { App } from '@slack/bolt';
import { Logger } from '@soma/common/logger';

export interface SlackAuthContext {
  userId: string;
  teamId: string;
  url: string;
  enterpriseId?: string;
  /** Bot's Slack username/handle (from auth.test response) */
  botName?: string;
}

export interface MessageOptions {
  threadTs?: string;
  blocks?: any[];
  attachments?: any[];
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
}

/**
 * Rate limiting 설정
 */
interface RateLimitConfig {
  bucketSize: number; // 최대 버스트 크기
  refillRate: number; // 초당 리필 토큰 수
  minInterval: number; // 최소 요청 간격 (ms)
  maxQueueSize: number; // 최대 큐 크기 (초과 시 oldest drop)
}

interface UpdateMessageOptions {
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
}

/** Max length of a DERIVED fallback. Caller-supplied text is never truncated. */
const DERIVED_FALLBACK_MAX_LENGTH = 300;

/** Payload shape the rendered-empty guard inspects (post + update share it). */
export interface RenderedMessagePayload {
  text?: string;
  blocks?: unknown[];
  attachments?: unknown[];
}

/** Read-only view of the few named fields the guard is allowed to look at. */
type RenderedNode = Record<string, unknown>;

/** Collapse whitespace; `undefined` when the value is missing or whitespace-only. */
function meaningful(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

/** `undefined` for anything that is not a plain object node. */
function asNode(value: unknown): RenderedNode | undefined {
  return value && typeof value === 'object' ? (value as RenderedNode) : undefined;
}

/** Text of a Slack text object (`{type:'mrkdwn'|'plain_text', text}`) at a known position. */
function textObject(value: unknown): string | undefined {
  return meaningful(asNode(value)?.text);
}

/**
 * Text carried by `rich_text` children. Only `text` fields authored for display
 * are read — `url`/`user_id`/`channel_id` and friends are never echoed.
 */
function richTextContent(elements: unknown): string | undefined {
  if (!Array.isArray(elements)) {
    return undefined;
  }
  for (const element of elements) {
    const node = asNode(element);
    if (!node) {
      continue;
    }
    const own = meaningful(node.text);
    if (own) {
      return own;
    }
    const nested = richTextContent(node.elements);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

/**
 * First human-meaningful string in a block list, in document order.
 *
 * Deliberately narrow: only the block types that actually carry prose are
 * recognized. `divider`/`actions`/`input` carry no message content (a button
 * label is a control, not the message), and no arbitrary metadata
 * (`url`, `image_url`, `value`, `block_id`, …) is traversed or echoed.
 */
function blocksContent(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) {
    return undefined;
  }
  for (const block of blocks) {
    const node = asNode(block);
    if (!node) {
      continue;
    }
    switch (typeof node.type === 'string' ? node.type : '') {
      case 'section': {
        const body = textObject(node.text);
        if (body) {
          return body;
        }
        if (Array.isArray(node.fields)) {
          for (const field of node.fields) {
            const fieldText = textObject(field);
            if (fieldText) {
              return fieldText;
            }
          }
        }
        break;
      }
      case 'header': {
        const header = textObject(node.text);
        if (header) {
          return header;
        }
        break;
      }
      case 'context': {
        if (Array.isArray(node.elements)) {
          for (const element of node.elements) {
            // context elements are text objects or image elements (alt_text).
            const elementText = textObject(element) || meaningful(asNode(element)?.alt_text);
            if (elementText) {
              return elementText;
            }
          }
        }
        break;
      }
      case 'markdown': {
        const markdown = meaningful(node.text);
        if (markdown) {
          return markdown;
        }
        break;
      }
      case 'image': {
        const alt = meaningful(node.alt_text) || textObject(node.title);
        if (alt) {
          return alt;
        }
        break;
      }
      case 'rich_text': {
        const rich = richTextContent(node.elements);
        if (rich) {
          return rich;
        }
        break;
      }
      default:
        break;
    }
  }
  return undefined;
}

/** First human-meaningful string in an attachment list, in document order. */
function attachmentsContent(attachments: unknown): string | undefined {
  if (!Array.isArray(attachments)) {
    return undefined;
  }
  for (const attachment of attachments) {
    const node = asNode(attachment);
    if (!node) {
      continue;
    }
    // `fallback` is Slack's own accessibility string — prefer it when present.
    const direct =
      meaningful(node.fallback) || meaningful(node.text) || meaningful(node.title) || meaningful(node.pretext);
    if (direct) {
      return direct;
    }
    if (Array.isArray(node.fields)) {
      for (const field of node.fields) {
        const fieldNode = asNode(field);
        const fieldText = meaningful(fieldNode?.title) || meaningful(fieldNode?.value);
        if (fieldText) {
          return fieldText;
        }
      }
    }
    const nested = blocksContent(node.blocks);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

/**
 * Central rendered-empty guard (U11 / A23) — the ONE place that decides what
 * top-level `text` a Slack message carries.
 *
 * - Non-blank caller text is returned unchanged, byte for byte.
 * - Blank text + meaningful blocks/attachments derives an accessibility
 *   fallback from the first prose the message actually renders (section /
 *   header / context / markdown / image alt_text / rich_text text, attachment
 *   fallback / text / title / pretext / fields / nested blocks), collapsed to a
 *   single line and capped at {@link DERIVED_FALLBACK_MAX_LENGTH}. Attachment-only
 *   messages are ALLOWED — `docs/misc/reference/slack-block-kit.md:83` only
 *   requires that a top-level `text` fallback exist.
 * - A payload with nothing meaningful to render (no text, empty blocks, or only
 *   controls such as `divider`/`actions`) is rejected here, before the API call,
 *   with an explicit Error. Nothing is silently dropped: the original blocks and
 *   attachments are never rewritten or sanitized, only read.
 *
 * An update whose text is blank AND whose blocks/attachments render nothing is
 * rejected too — clearing a message is done by `deleteMessage` or by updating to
 * an explicit marker text (e.g. `actions/click-classifier.ts` STALE_CLICK_TEXT),
 * never by pushing a message the reader sees as empty.
 */
export function resolveRenderedMessageText(payload: RenderedMessagePayload, apiMethod: string): string {
  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return payload.text;
  }

  const derived = blocksContent(payload.blocks) || attachmentsContent(payload.attachments);
  if (derived) {
    return derived.length > DERIVED_FALLBACK_MAX_LENGTH
      ? `${derived.slice(0, DERIVED_FALLBACK_MAX_LENGTH - 1)}…`
      : derived;
  }

  throw new Error(
    `${apiMethod}: refusing to send a rendered-empty message — text is blank and blocks/attachments carry no meaningful content`,
  );
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  bucketSize: 10, // 최대 10개 버스트
  refillRate: 3, // 초당 3개 리필
  minInterval: 100, // 최소 100ms 간격
  maxQueueSize: 200, // 최대 큐 크기 (초과 시 oldest drop)
};

/**
 * Slack API 호출을 위한 헬퍼 클래스
 * Slack Web API를 래핑하여 일관된 에러 처리와 로깅 제공
 * Rate limiting을 통해 API 리미트 방지
 */
export class SlackApiHelper {
  private logger = new Logger('SlackApiHelper');
  private botUserId: string | null = null;
  private authContext: SlackAuthContext | null = null;

  // Rate limiting state
  private tokens: number;
  private lastRefill: number;
  private lastRequest: number = 0;
  private queue: Array<{
    execute: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private processing = false;
  private rateLimit: RateLimitConfig;

  constructor(
    private app: App,
    rateLimit?: Partial<RateLimitConfig>,
  ) {
    this.rateLimit = { ...DEFAULT_RATE_LIMIT, ...rateLimit };
    this.tokens = this.rateLimit.bucketSize;
    this.lastRefill = Date.now();
  }

  /**
   * Get the underlying Slack WebClient for direct API access
   */
  getClient() {
    return this.app.client;
  }

  /**
   * Rate limit 큐에 API 호출 추가
   */
  private async enqueue<T>(execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Drop oldest if queue exceeds maxQueueSize
      if (this.queue.length >= this.rateLimit.maxQueueSize) {
        const dropped = this.queue.shift()!;
        dropped.reject(new Error('Queue overflow: dropped oldest request'));
        this.logger.warn('Queue overflow: dropped oldest request', {
          queueLength: this.queue.length,
          maxQueueSize: this.rateLimit.maxQueueSize,
        });
      }

      this.queue.push({ execute, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * 큐 처리
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      // 토큰 리필
      this.refillTokens();

      // 토큰이 없으면 대기
      if (this.tokens < 1) {
        const waitTime = Math.ceil(1000 / this.rateLimit.refillRate);
        this.logger.debug('Rate limit: waiting for token', {
          waitTime,
          queueLength: this.queue.length,
        });
        await this.sleep(waitTime);
        continue;
      }

      // 최소 간격 보장
      const elapsed = Date.now() - this.lastRequest;
      if (elapsed < this.rateLimit.minInterval) {
        await this.sleep(this.rateLimit.minInterval - elapsed);
      }

      // 요청 실행
      const item = this.queue.shift()!;
      this.tokens--;
      this.lastRequest = Date.now();

      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (error: any) {
        // Rate limit 에러 처리
        if (error?.data?.error === 'ratelimited') {
          const retryAfter = parseInt(error?.data?.headers?.['retry-after'] || '5', 10);
          this.logger.warn('Slack rate limited, waiting', { retryAfter });
          this.tokens = 0; // 토큰 비우기
          await this.sleep(retryAfter * 1000);
          // 다시 큐에 넣기
          this.queue.unshift(item);
        } else {
          item.reject(error);
        }
      }
    }

    this.processing = false;
  }

  /**
   * 토큰 리필
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const refill = elapsed * this.rateLimit.refillRate;

    if (refill >= 1) {
      this.tokens = Math.min(this.rateLimit.bucketSize, this.tokens + Math.floor(refill));
      this.lastRefill = now;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 큐 상태 조회
   */
  getQueueStatus(): { queueLength: number; tokens: number } {
    return {
      queueLength: this.queue.length,
      tokens: this.tokens,
    };
  }

  /**
   * 사용자 ID로 사용자 이름 조회
   */
  async getUserName(userId: string): Promise<string> {
    try {
      const result = await this.enqueue(() => this.app.client.users.info({ user: userId }));
      return result.user?.real_name || result.user?.name || userId;
    } catch (error) {
      this.logger.warn('Failed to get user name', { userId, error });
      return userId;
    }
  }

  /**
   * 사용자 프로필 조회 (표시 이름 + 이메일)
   * 이메일 조회에는 Slack Bot Token의 users:read.email scope가 필요
   */
  async getUserProfile(userId: string): Promise<{
    displayName: string;
    email?: string;
  }> {
    try {
      const result = await this.enqueue(() => this.app.client.users.info({ user: userId }));
      const profile = (result.user as any)?.profile;
      return {
        displayName: profile?.display_name || (result.user as any)?.real_name || (result.user as any)?.name || userId,
        email: profile?.email,
      };
    } catch (error) {
      this.logger.warn('Failed to get user profile', { userId, error });
      return { displayName: userId };
    }
  }

  /**
   * 채널 ID로 채널 이름 조회
   * DM 채널은 'DM' 반환
   */
  async getChannelName(channelId: string): Promise<string> {
    try {
      if (channelId.startsWith('D')) {
        return 'DM';
      }
      const result = await this.enqueue(() => this.app.client.conversations.info({ channel: channelId }));
      return `#${(result.channel as any)?.name || channelId}`;
    } catch (error) {
      this.logger.warn('Failed to get channel name', { channelId, error });
      return channelId;
    }
  }

  /**
   * 메시지 퍼머링크 조회
   */
  async getPermalink(channel: string, messageTs: string): Promise<string | null> {
    try {
      const result = await this.enqueue(() =>
        this.app.client.chat.getPermalink({
          channel,
          message_ts: messageTs,
        }),
      );
      return result.permalink || null;
    } catch (error) {
      this.logger.warn('Failed to get permalink', { channel, messageTs, error });
      return null;
    }
  }

  /**
   * Fetch a single message by channel and timestamp.
   */
  async getMessage(channel: string, ts: string): Promise<any | null> {
    try {
      const response = await this.enqueue(() =>
        this.app.client.conversations.history({
          channel,
          latest: ts,
          oldest: ts,
          inclusive: true,
          limit: 1,
        }),
      );
      const messages = (response.messages as any[]) || [];
      const exact = messages.find((message) => message?.ts === ts);
      return exact || messages[0] || null;
    } catch (error) {
      this.logger.warn('Failed to fetch message', { channel, ts, error });
      return null;
    }
  }

  /**
   * Report whether `threadTs` is still usable as a thread anchor.
   *
   * `chat.postMessage` does NOT validate `thread_ts`: given the ts of a message
   * that no longer exists it returns `ok: true` and posts the message as a plain
   * top-level channel message (verified against the live API on 2026-08-28 —
   * `message.thread_ts` comes back `null`). So an anchor that has died silently
   * turns every "thread reply" into a public channel post.
   *
   * `conversations.replies` is the matching predicate. Measured on the same run:
   *
   * | root state                      | conversations.replies | postMessage threads? |
   * |---------------------------------|-----------------------|----------------------|
   * | alive                           | ok                    | yes                  |
   * | deleted, replies survived       | ok (tombstone parent) | yes                  |
   * | deleted, no replies left        | `thread_not_found`    | NO — lands at root   |
   *
   * A parent deleted while replies remain leaves a `subtype: 'tombstone'`
   * placeholder that keeps threading intact, so `thread_not_found` maps exactly
   * onto the leaking case and nothing else.
   *
   * Three-valued on purpose: a transient Slack failure is `unknown`, never
   * `missing`. Callers may suppress output on `unknown`, but must not treat it
   * as proof that the thread is gone.
   */
  async getThreadRootState(channel: string, threadTs: string): Promise<'exists' | 'missing' | 'unknown'> {
    try {
      await this.enqueue(() => this.app.client.conversations.replies({ channel, ts: threadTs, limit: 1 }));
      return 'exists';
    } catch (error) {
      const platformErrorCode = (error as any)?.data?.error;
      if (platformErrorCode === 'thread_not_found' || platformErrorCode === 'message_not_found') {
        return 'missing';
      }
      this.logger.warn('Could not determine thread root state', { channel, threadTs, error });
      return 'unknown';
    }
  }

  /**
   * Fetch a single message that lives inside a thread (a reply, or the root)
   * by paginating conversations.replies. Thread replies are NOT returned by
   * conversations.history, so getMessage() cannot find them — this method is
   * required for permalinks that point at a thread reply.
   */
  async getThreadMessage(channel: string, threadTs: string, ts: string): Promise<any | null> {
    let cursor: string | undefined;
    try {
      do {
        const response = await this.enqueue(() =>
          this.app.client.conversations.replies({
            channel,
            ts: threadTs,
            limit: 200,
            cursor,
          }),
        );
        const messages = (response.messages as any[]) || [];
        const exact = messages.find((message) => message?.ts === ts);
        if (exact) {
          return exact;
        }
        const nextCursor = response.response_metadata?.next_cursor;
        cursor = nextCursor && nextCursor.length > 0 ? nextCursor : undefined;
      } while (cursor);
      return null;
    } catch (error) {
      this.logger.warn('Failed to fetch thread message', { channel, threadTs, ts, error });
      return null;
    }
  }

  /**
   * Fetch and cache the full auth context from Slack's auth.test API.
   */
  async getAuthContext(): Promise<SlackAuthContext> {
    if (!this.authContext) {
      const response = await this.enqueue(() => this.app.client.auth.test());
      this.authContext = {
        userId: response.user_id as string,
        teamId: response.team_id as string,
        url: response.url as string,
        enterpriseId: (response as any).enterprise_id as string | undefined,
        botName: response.user as string | undefined,
      };
    }
    return this.authContext;
  }

  /**
   * 봇 사용자 ID 조회 (캐싱됨)
   */
  async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const ctx = await this.getAuthContext();
        this.botUserId = ctx.userId;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  /**
   * Open a DM channel with a user.
   * Trace: docs/turn-notification/trace.md, Scenario 2, Section 3b
   */
  async openDmChannel(userId: string): Promise<string> {
    const result = await this.enqueue(() => this.app.client.conversations.open({ users: userId }));
    const channelId = result.channel?.id;
    if (!channelId) {
      throw new Error(`Failed to open DM channel for user ${userId}`);
    }
    return channelId;
  }

  /**
   * 시스템 메시지 전송 (⚡ zap 리액션으로 모델 응답과 구분)
   * 프로그램에서 직접 보내는 메시지에 사용
   */
  async postSystemMessage(
    channel: string,
    text: string,
    options?: MessageOptions,
  ): Promise<{ ts?: string; channel?: string }> {
    const result = await this.postMessage(channel, text, options);
    if (result.ts) {
      await this.addReaction(channel, result.ts, 'zap');
    }
    return result;
  }

  /**
   * 메시지 전송
   */
  async postMessage(
    channel: string,
    text: string,
    options?: MessageOptions,
  ): Promise<{ ts?: string; channel?: string; threadTs?: string; echoedMessage?: boolean }> {
    // Central rendered-empty guard (U11/A23) — runs BEFORE the API call so an
    // empty message is rejected, not posted. Attachment-only stays allowed.
    const payload: any = {
      channel,
      text: resolveRenderedMessageText(
        { text, blocks: options?.blocks, attachments: options?.attachments },
        'chat.postMessage',
      ),
      thread_ts: options?.threadTs,
      blocks: options?.blocks,
      attachments: options?.attachments,
    };

    if (typeof options?.unfurlLinks === 'boolean') {
      payload.unfurl_links = options.unfurlLinks;
    }
    if (typeof options?.unfurlMedia === 'boolean') {
      payload.unfurl_media = options.unfurlMedia;
    }

    try {
      const result = await this.enqueue(() => this.app.client.chat.postMessage(payload));
      // `threadTs` is what Slack ACTUALLY threaded the message under, which is not
      // always what we asked for: a dead `thread_ts` is silently dropped and the
      // message becomes a top-level channel post. Surfacing it lets callers detect
      // that and undo it. See getThreadRootState() for the measured behaviour.
      return {
        ts: result.ts,
        channel: result.channel,
        threadTs: (result.message as any)?.thread_ts,
        echoedMessage: !!result.message,
      };
    } catch (error) {
      // 2026-07-09 incident: an over-limit goal-status section (3000-char cap)
      // made chat.postMessage fail with `invalid_blocks`, the throw crashed
      // the command handler, and the raw command text got hijacked by
      // autogoal. Every caller supplies `text` as the notification fallback
      // for exactly this kind of degradation — so when the BLOCKS are the
      // problem, strip them and deliver the text instead of throwing.
      const platformErrorCode = (error as any)?.data?.error;
      if (platformErrorCode === 'invalid_blocks' && payload.blocks) {
        this.logger.warn('invalid_blocks — retrying with text-only fallback', { channel, error });
        const fallback = { ...payload };
        fallback.blocks = undefined;
        const result = await this.enqueue(() => this.app.client.chat.postMessage(fallback));
        return {
          ts: result.ts,
          channel: result.channel,
          threadTs: (result.message as any)?.thread_ts,
          echoedMessage: !!result.message,
        };
      }
      this.logger.error('Failed to post message', { channel, error });
      throw error;
    }
  }

  /**
   * 메시지 업데이트
   */
  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: any[],
    attachments?: any[],
    options?: UpdateMessageOptions,
  ): Promise<void> {
    // Same central guard as postMessage, resolved outside the try so a
    // rendered-empty rejection is not mislabeled as a Slack API failure.
    const resolvedText = resolveRenderedMessageText({ text, blocks, attachments }, 'chat.update');

    try {
      const payload: any = {
        channel,
        ts,
        text: resolvedText,
        blocks,
        attachments,
      };

      if (typeof options?.unfurlLinks === 'boolean') {
        payload.unfurl_links = options.unfurlLinks;
      }
      if (typeof options?.unfurlMedia === 'boolean') {
        payload.unfurl_media = options.unfurlMedia;
      }

      await this.enqueue(() => this.app.client.chat.update(payload));
    } catch (error) {
      this.logger.warn('Failed to update message', { channel, ts, error });
      throw error;
    }
  }

  /**
   * 메시지 삭제 (봇이 보낸 메시지만 삭제 가능)
   */
  async deleteMessage(channel: string, ts: string): Promise<void> {
    try {
      await this.enqueue(() => this.app.client.chat.delete({ channel, ts }));
    } catch (error) {
      this.logger.warn('Failed to delete message', { channel, ts, error });
      throw error;
    }
  }

  /**
   * Delete bot-authored messages within a thread (keeps the root message).
   *
   * Two-phase: first enumerate ALL bot-authored target messages (so the total
   * count is known up front), then delete them one by one. `onProgress` is
   * invoked after each successful delete with `{ deleted, total }` so callers
   * can render progress for long-running bulk deletes.
   *
   * @returns `{ total, deleted }` — total targets found and how many were deleted.
   */
  async deleteThreadBotMessages(
    channel: string,
    threadTs: string,
    options?: {
      excludeTs?: string[];
      onProgress?: (progress: { deleted: number; total: number }) => unknown;
    },
  ): Promise<{ total: number; deleted: number }> {
    const excludeTs = new Set(options?.excludeTs || []);
    const onProgress = options?.onProgress;
    const botUserId = await this.getBotUserId();

    // Phase 1: enumerate all target message timestamps (total known up front)
    const targets: string[] = [];
    let cursor: string | undefined;
    try {
      do {
        const response = await this.enqueue(() =>
          this.app.client.conversations.replies({
            channel,
            ts: threadTs,
            limit: 200,
            cursor,
          }),
        );

        const messages = (response.messages as any[]) || [];
        for (const message of messages) {
          const messageTs = message?.ts as string | undefined;
          if (!messageTs || messageTs === threadTs || excludeTs.has(messageTs)) {
            continue;
          }
          if (message?.user !== botUserId) {
            continue;
          }
          targets.push(messageTs);
        }

        const nextCursor = response.response_metadata?.next_cursor;
        cursor = nextCursor && nextCursor.length > 0 ? nextCursor : undefined;
      } while (cursor);
    } catch (error) {
      this.logger.warn('Failed to enumerate bot messages in thread', { channel, threadTs, error });
    }

    const total = targets.length;
    let deleted = 0;

    // Emit an initial progress event so callers can show the total immediately.
    if (onProgress) {
      try {
        await onProgress({ deleted, total });
      } catch (error) {
        this.logger.debug('onProgress callback failed', { channel, threadTs, error });
      }
    }

    // Phase 2: delete each target, reporting progress as we go.
    for (const messageTs of targets) {
      try {
        await this.deleteMessage(channel, messageTs);
        deleted += 1;
      } catch (error) {
        this.logger.debug('Failed to delete thread message', { channel, messageTs, error });
      }
      if (onProgress) {
        try {
          await onProgress({ deleted, total });
        } catch (error) {
          this.logger.debug('onProgress callback failed', { channel, threadTs, error });
        }
      }
    }

    return { total, deleted };
  }

  /**
   * 임시 메시지 전송 (특정 사용자에게만 보임)
   */
  async postEphemeral(
    channel: string,
    user: string,
    text: string,
    threadTs?: string,
    blocks?: any[],
  ): Promise<{ ts?: string }> {
    try {
      const result = await this.enqueue(() =>
        this.app.client.chat.postEphemeral({
          channel,
          user,
          text,
          thread_ts: threadTs,
          blocks,
        }),
      );
      return { ts: (result as any).message_ts || (result as any).ts };
    } catch (error) {
      this.logger.warn('Failed to post ephemeral message', { channel, user, error });
      throw error;
    }
  }

  /**
   * 리액션 추가
   * @returns true if successful or already exists, false on actual failure
   */
  async addReaction(channel: string, ts: string, emoji: string): Promise<boolean> {
    try {
      await this.enqueue(() =>
        this.app.client.reactions.add({
          channel,
          timestamp: ts,
          name: emoji,
        }),
      );
      return true;
    } catch (error: any) {
      // 이미 추가된 리액션은 성공으로 간주
      if (error?.data?.error === 'already_reacted') {
        return true;
      }
      this.logger.warn('Failed to add reaction', { channel, ts, emoji, error });
      return false;
    }
  }

  /**
   * 리액션 제거
   */
  async removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.enqueue(() =>
        this.app.client.reactions.remove({
          channel,
          timestamp: ts,
          name: emoji,
        }),
      );
    } catch (error: any) {
      // 존재하지 않는 리액션 에러는 무시
      if (error?.data?.error !== 'no_reaction') {
        this.logger.debug('Failed to remove reaction (might not exist)', { channel, ts, emoji });
      }
    }
  }

  /**
   * 채널 정보 조회
   */
  async getChannelInfo(channelId: string): Promise<any> {
    try {
      const result = await this.enqueue(() => this.app.client.conversations.info({ channel: channelId }));
      return result.channel;
    } catch (error) {
      this.logger.warn('Failed to get channel info', { channelId, error });
      return null;
    }
  }

  /**
   * Map turn-owned loading intent to Slack's agent session lifecycle.
   * Empty legacy loading text does not clear an agent session's processing state.
   */
  async setAssistantStatus(channelId: string, threadTs: string, status: string): Promise<void> {
    await this.enqueue(() =>
      this.app.client.apiCall('agents.sessions.setStatus', {
        channel_id: channelId,
        thread_ts: threadTs,
        status: status === '' ? 'active' : 'processing',
      }),
    );
  }

  /**
   * Assistant thread title 설정 (DM 히스토리용)
   */
  async setAssistantTitle(channelId: string, threadTs: string, title: string): Promise<void> {
    await this.enqueue(() =>
      this.app.client.assistant.threads.setTitle({
        channel_id: channelId,
        thread_ts: threadTs,
        title,
      }),
    );
  }

  /**
   * 모달 열기
   */
  async openModal(triggerId: string, view: any): Promise<void> {
    try {
      await this.enqueue(() =>
        this.app.client.views.open({
          trigger_id: triggerId,
          view,
        }),
      );
    } catch (error) {
      this.logger.error('Failed to open modal', { triggerId, error });
      throw error;
    }
  }

  /**
   * Update an already-open modal.
   *
   * Pass `hash` (taken from the inbound view payload) to guard against
   * stale-write races — Slack rejects the update when the stored hash has
   * moved on. See https://api.slack.com/methods/views.update.
   */
  async updateModal(viewId: string, view: any, hash?: string): Promise<void> {
    try {
      await this.enqueue(() =>
        this.app.client.views.update({
          view_id: viewId,
          hash,
          view,
        }),
      );
    } catch (error) {
      this.logger.error('Failed to update modal', { viewId, error });
      throw error;
    }
  }

  /**
   * Push a new modal onto the modal stack. Requires a fresh `trigger_id`
   * sourced from the originating interaction.
   */
  async pushModal(triggerId: string, view: any): Promise<void> {
    try {
      await this.enqueue(() =>
        this.app.client.views.push({
          trigger_id: triggerId,
          view,
        }),
      );
    } catch (error) {
      this.logger.error('Failed to push modal', { triggerId, error });
      throw error;
    }
  }
}
