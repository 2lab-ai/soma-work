import { Logger } from '@soma/common/logger';
import { classifySlackDeliveryError } from '../slack-rejection';
import {
  buildCanceledPollMessage,
  buildClosedPollMessage,
  buildOpenPollMessage,
  buildResultNotices,
  MAX_OPTION_CHARS,
  MAX_OPTIONS,
  MAX_TITLE_CHARS,
  noticeMarker,
} from './poll-blocks';
import { PollLane } from './poll-lane';
import type { PollStore } from './poll-store';
import type { PollDelivery, PollRecord } from './poll-types';

/** Minimal Slack surface the poll service needs (SlackApiHelper satisfies it). */
export interface PollSlackApi {
  postMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; blocks?: any[]; strictBlocks?: boolean },
  ): Promise<{ ts?: string; threadTs?: string; echoedMessage?: boolean }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: any[]): Promise<void>;
  deleteMessage?(channel: string, ts: string): Promise<void>;
  /**
   * Whether a message authored by THIS bot and containing `marker` exists in
   * the thread at/after `oldestSec`, scanning every page. Throws on any Slack
   * error (the service classifies it); never returns `false` on a partial scan.
   */
  threadHasBotMessage?(channel: string, threadTs: string, oldestSec: string, marker: string): Promise<boolean>;
}

export interface PollServiceDeps {
  store: PollStore;
  slack: PollSlackApi;
  now?: () => number;
  newId?: () => string;
  lane?: PollLane;
}

export interface CreatePollInput {
  invocationId?: string;
  channel: string;
  threadTs: string;
  creatorId: string;
  title: string;
  options: string[];
  /** Epoch ms. */
  closesAt: number;
}

export type CreatePollFailure =
  | 'invalid_input'
  | 'duplicate_invocation'
  | 'closes_at_out_of_range'
  | 'thread_has_open_poll'
  | 'post_failed'
  | 'post_outcome_unknown'
  | 'misthreaded'
  | 'store_failed';

export type CreatePollResult =
  | { ok: true; poll: PollRecord }
  | { ok: false; reason: CreatePollFailure; detail?: string };

export type VoteResult =
  | { kind: 'recorded'; optionIndex: number; label: string; previous?: number }
  | { kind: 'unchanged'; optionIndex: number; label: string }
  | { kind: 'stale' }
  | { kind: 'closed' }
  | { kind: 'mismatch' }
  | { kind: 'not_found' }
  | { kind: 'invalid_option' };

export type CloseResult = 'closed' | 'already' | 'inactive' | 'forbidden' | 'mismatch' | 'not_found';
export type CancelResult = 'canceled' | 'already' | 'inactive' | 'forbidden' | 'mismatch' | 'not_found';

const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 7 * 24 * 60 * 60_000;
const RETRY_WINDOW_MS = 24 * 60 * 60_000;
const RESUME_HORIZON_MS = 7 * 24 * 60 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function slackTsToNumber(ts: string): number {
  const n = Number.parseFloat(ts);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/**
 * Native button poll domain service.
 *
 * Concurrency: every mutation of a poll runs in that poll's `PollLane` slot,
 * claimed synchronously at entry. Inside the slot the record is re-read, the
 * transition is decided and persisted without yielding, and only then are the
 * Slack calls made — still inside the slot, so renders land in order.
 */
export class PollService {
  private logger = new Logger('PollService');
  private store: PollStore;
  private slack: PollSlackApi;
  private now: () => number;
  private newId: () => string;
  private lane: PollLane;
  /** Threads with a creation in flight (held until the record is written). */
  private creating = new Set<string>();

  constructor(deps: PollServiceDeps) {
    this.store = deps.store;
    this.slack = deps.slack;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `poll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    this.lane = deps.lane ?? new PollLane();
  }

  // ── create ────────────────────────────────────────────────────────────

  createPoll(input: CreatePollInput): Promise<CreatePollResult> {
    // Everything up to the reservation is synchronous: check + reserve is one
    // span, so two overlapping creates in a thread can't both pass.
    const title = input.title.trim();
    const options = input.options.map((o) => o.trim());
    if (
      title.length === 0 ||
      codePoints(title) > MAX_TITLE_CHARS ||
      options.length === 0 ||
      options.length > MAX_OPTIONS ||
      options.some((o) => o.length === 0 || codePoints(o) > MAX_OPTION_CHARS || /[\r\n]/.test(o)) ||
      !Number.isFinite(input.closesAt)
    ) {
      return Promise.resolve({ ok: false, reason: 'invalid_input' });
    }
    if (input.invocationId && this.store.findByInvocation(input.invocationId)) {
      return Promise.resolve({ ok: false, reason: 'duplicate_invocation' });
    }
    const now = this.now();
    if (input.closesAt < now + MIN_LEAD_MS || input.closesAt > now + MAX_LEAD_MS) {
      return Promise.resolve({ ok: false, reason: 'closes_at_out_of_range' });
    }
    const threadKey = `${input.channel}\u0000${input.threadTs}`;
    if (this.creating.has(threadKey) || this.store.findOpenInThread(input.channel, input.threadTs)) {
      return Promise.resolve({ ok: false, reason: 'thread_has_open_poll' });
    }
    this.creating.add(threadKey);

    const id = this.newId();
    return this.lane
      .run(id, () => this.postAndPersist(id, { ...input, title, options }, now))
      .finally(() => this.creating.delete(threadKey));
  }

  private async postAndPersist(id: string, input: CreatePollInput, now: number): Promise<CreatePollResult> {
    const draft: PollRecord = {
      id,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      channel: input.channel,
      threadTs: input.threadTs,
      messageTs: '',
      creatorId: input.creatorId,
      title: input.title,
      options: input.options,
      votes: {},
      voteActionTs: {},
      closesAt: input.closesAt,
      status: 'open',
      createdAt: now,
    };
    const card = buildOpenPollMessage(draft);

    let posted: { ts?: string; threadTs?: string; echoedMessage?: boolean };
    try {
      posted = await this.slack.postMessage(input.channel, card.text, {
        threadTs: input.threadTs,
        blocks: card.blocks,
        strictBlocks: true,
      });
    } catch (error) {
      const cls = classifySlackDeliveryError(error);
      this.logger.warn('Poll card post failed', { id, channel: input.channel, cls });
      return cls.kind === 'unknown'
        ? { ok: false, reason: 'post_outcome_unknown', detail: cls.code }
        : { ok: false, reason: 'post_failed', detail: cls.code };
    }
    if (!posted.ts) return { ok: false, reason: 'post_outcome_unknown' };

    // A dead thread anchor makes Slack post at the channel root instead
    // (`ok: true`, no `thread_ts`). Placement must be PROVEN from the echoed
    // message: an absent echo is "unknown", never "in the thread". Either way a
    // card that may sit outside the thread is removed and nothing is recorded.
    if (!posted.echoedMessage || posted.threadTs !== input.threadTs) {
      this.logger.warn('Poll card placement not confirmed in the thread — deleting', {
        id,
        ts: posted.ts,
        echoed: posted.echoedMessage === true,
      });
      await this.slack
        .deleteMessage?.(input.channel, posted.ts)
        .catch((err) => this.logger.warn('Failed to delete unplaced poll card', { id, err: String(err) }));
      return { ok: false, reason: posted.echoedMessage ? 'misthreaded' : 'post_outcome_unknown' };
    }

    const record: PollRecord = { ...draft, messageTs: posted.ts };
    try {
      this.store.insert(record);
    } catch (error) {
      this.logger.error('Poll record write failed after posting the card', { id, error: String(error) });
      await this.slack
        .updateMessage(input.channel, posted.ts, '⚠️ 투표를 만들지 못했습니다 (저장 오류). 다시 실행해 주세요.', [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '⚠️ 투표를 만들지 못했습니다 (저장 오류). 다시 실행해 주세요.' },
          },
        ])
        .catch(() => undefined);
      return { ok: false, reason: 'store_failed' };
    }
    return { ok: true, poll: record };
  }

  // ── vote ──────────────────────────────────────────────────────────────

  castVote(input: {
    pollId: string;
    userId: string;
    optionIndex: number;
    actionTs: string;
    channel: string;
    messageTs: string;
  }): Promise<VoteResult> {
    return this.lane.run(input.pollId, async (): Promise<VoteResult> => {
      const poll = this.store.get(input.pollId);
      if (!poll) return { kind: 'not_found' };
      if (poll.channel !== input.channel || poll.messageTs !== input.messageTs) return { kind: 'mismatch' };
      if (poll.status !== 'open' || this.now() >= poll.closesAt) return { kind: 'closed' };
      if (!Number.isInteger(input.optionIndex) || input.optionIndex < 0 || input.optionIndex >= poll.options.length) {
        return { kind: 'invalid_option' };
      }
      const prevTs = poll.voteActionTs[input.userId];
      if (prevTs !== undefined && !(slackTsToNumber(input.actionTs) > slackTsToNumber(prevTs))) {
        return { kind: 'stale' };
      }
      const previous = poll.votes[input.userId];
      const changed = previous !== input.optionIndex;
      // The ordering clock advances even for a same-option click, so a delayed
      // older click on another option can never win afterwards.
      const updated = this.store.update(poll.id, (p) => {
        p.voteActionTs[input.userId] = input.actionTs;
        if (changed) p.votes[input.userId] = input.optionIndex;
      });
      const label = poll.options[input.optionIndex];
      if (!changed) return { kind: 'unchanged', optionIndex: input.optionIndex, label };

      const card = buildOpenPollMessage(updated);
      try {
        await this.slack.updateMessage(updated.channel, updated.messageTs, card.text, card.blocks);
      } catch (error) {
        // Counts converge on the next accepted click; the vote is persisted.
        this.logger.warn('Poll card count update failed', { id: poll.id, error: String(error) });
      }
      return { kind: 'recorded', optionIndex: input.optionIndex, label, previous };
    });
  }

  // ── close / cancel ────────────────────────────────────────────────────

  close(input: { pollId: string; actorId?: string; channel?: string; messageTs?: string }): Promise<CloseResult> {
    return this.lane.run(input.pollId, async (): Promise<CloseResult> => {
      const poll = this.store.get(input.pollId);
      if (!poll) return 'not_found';
      if (input.actorId !== undefined) {
        if (poll.channel !== input.channel || poll.messageTs !== input.messageTs) return 'mismatch';
        if (poll.creatorId !== input.actorId) return 'forbidden';
      }
      if (poll.status === 'closed') return 'already';
      if (poll.status !== 'open') return 'inactive';
      const now = this.now();
      this.store.update(poll.id, (p) => {
        p.status = 'closed';
        p.closedAt = now;
        p.delivery = freshDelivery(now, false);
      });
      await this.deliver(poll.id);
      return 'closed';
    });
  }

  cancel(input: { pollId: string; actorId: string; channel: string; messageTs: string }): Promise<CancelResult> {
    return this.lane.run(input.pollId, async (): Promise<CancelResult> => {
      const poll = this.store.get(input.pollId);
      if (!poll) return 'not_found';
      if (poll.channel !== input.channel || poll.messageTs !== input.messageTs) return 'mismatch';
      if (poll.creatorId !== input.actorId) return 'forbidden';
      if (poll.status === 'canceled') return 'already';
      if (poll.status !== 'open') return 'inactive';
      const now = this.now();
      this.store.update(poll.id, (p) => {
        p.status = 'canceled';
        p.closedAt = now;
        p.delivery = freshDelivery(now, true);
      });
      await this.deliver(poll.id);
      return 'canceled';
    });
  }

  // ── scheduler entry points ────────────────────────────────────────────

  /**
   * Close due polls and retry pending deliveries. Called every scheduler tick
   * (and once at start, after `resumeExpiredDeliveries`).
   */
  async closeDue(): Promise<{ closed: number; retried: number; expired: number }> {
    let closed = 0;
    let retried = 0;
    let expired = 0;
    for (const poll of this.store.all()) {
      const now = this.now();
      if (poll.status === 'open') {
        if (now >= poll.closesAt && (await this.close({ pollId: poll.id })) === 'closed') closed += 1;
        continue;
      }
      const d = poll.delivery;
      if (!d || d.expiredAt !== undefined || !hasPendingDelivery(d) || now < d.nextAttemptAt) continue;
      if (now > d.retryUntil) {
        await this.lane.run(poll.id, () => this.expire(poll.id));
        expired += 1;
        continue;
      }
      await this.lane.run(poll.id, () => this.deliver(poll.id));
      retried += 1;
    }
    return { closed, retried, expired };
  }

  /**
   * Restart recovery: re-arm unfinished deliveries of polls closed within the
   * last 7 days — both those a running tick expired (`expiredAt` set) and those
   * whose retry window lapsed while the bot was down (no tick ran `expire()`,
   * so `expiredAt` is unset but `retryUntil` is past). Without the second case
   * the first `closeDue()` after restart would expire them without a single
   * attempt. Only the unfinished parts of the frozen result are resumed; the
   * poll is never reopened. Returns how many were re-armed.
   */
  resumeExpiredDeliveries(): number {
    const now = this.now();
    let count = 0;
    for (const poll of this.store.all()) {
      const d = poll.delivery;
      if (!d || poll.closedAt === undefined || !hasPendingDelivery(d)) continue;
      const lapsed = d.expiredAt !== undefined || now > d.retryUntil;
      if (!lapsed) continue;
      if (now - poll.closedAt > RESUME_HORIZON_MS) continue;
      this.store.update(poll.id, (p) => {
        if (!p.delivery) return;
        p.delivery.expiredAt = undefined;
        p.delivery.attempts = 0;
        p.delivery.nextAttemptAt = 0;
        p.delivery.retryUntil = Math.min(now + RETRY_WINDOW_MS, (p.closedAt ?? now) + RESUME_HORIZON_MS);
      });
      count += 1;
    }
    return count;
  }

  // ── delivery ──────────────────────────────────────────────────────────

  /** Deliver the frozen terminal result. Must run inside the poll's lane slot. */
  private async deliver(pollId: string): Promise<void> {
    const poll = this.store.get(pollId);
    if (!poll || poll.status === 'open' || !poll.delivery) return;
    let transient = false;

    // 1) Card (canonical visual). Independent of the notices.
    if (!poll.delivery.cardDone && !poll.delivery.cardError) {
      const card = poll.status === 'closed' ? buildClosedPollMessage(poll) : buildCanceledPollMessage(poll);
      try {
        await this.slack.updateMessage(poll.channel, poll.messageTs, card.text, card.blocks);
        this.patchDelivery(pollId, (d) => {
          d.cardDone = true;
        });
      } catch (error) {
        const cls = classifySlackDeliveryError(error);
        if (cls.kind === 'permanent') {
          this.logger.warn('Poll card update permanently failed', { pollId, code: cls.code });
          this.patchDelivery(pollId, (d) => {
            d.cardError = cls.code;
          });
        } else {
          transient = true;
        }
      }
    }

    // 2) Roster notices (closed only) — attempted regardless of the card outcome.
    const current = this.store.get(pollId);
    if (
      current?.status === 'closed' &&
      current.delivery &&
      !current.delivery.noticeDone &&
      !current.delivery.noticeError
    ) {
      const notices = buildResultNotices(current);
      for (let i = current.delivery.noticesDone; i < notices.length; i++) {
        const marker = noticeMarker(current.id, i, notices.length);
        const step = await this.deliverNoticePart(current, i, notices[i].text, marker);
        if (step === 'done') continue;
        if (step === 'transient') transient = true;
        break;
      }
      const after = this.store.get(pollId);
      if (after?.delivery && after.delivery.noticesDone >= notices.length && !after.delivery.noticeDone) {
        this.patchDelivery(pollId, (d) => {
          d.noticeDone = true;
        });
      }
    }

    const now = this.now();
    this.patchDelivery(pollId, (d) => {
      if (transient) {
        d.attempts += 1;
        d.nextAttemptAt = now + backoffMs(d.attempts);
      } else {
        d.attempts = 0;
        d.nextAttemptAt = 0;
      }
    });
  }

  private async deliverNoticePart(
    poll: PollRecord,
    index: number,
    text: string,
    marker: string,
  ): Promise<'done' | 'transient' | 'stopped'> {
    // A previous attempt of THIS part had an unknown outcome: look before reposting.
    if (poll.delivery?.noticeUnknownPart === index && this.slack.threadHasBotMessage) {
      const oldestSec = (Math.floor((poll.closedAt ?? 0) / 1000) - 1).toString();
      try {
        const found = await this.slack.threadHasBotMessage(poll.channel, poll.threadTs, oldestSec, marker);
        if (found) {
          this.patchDelivery(poll.id, (d) => {
            d.noticesDone = index + 1;
            d.noticeUnknownPart = undefined;
          });
          return 'done';
        }
      } catch (error) {
        const cls = classifySlackDeliveryError(error);
        if (cls.kind === 'permanent' && (cls.code === 'thread_not_found' || cls.code === 'channel_not_found')) {
          this.patchDelivery(poll.id, (d) => {
            d.noticeError = cls.code;
          });
          return 'stopped';
        }
        return 'transient'; // not yet checked — never treated as "absent"
      }
    }

    // Write-ahead intent: persist "part `index` may be in flight" BEFORE the
    // post. If the process dies after Slack accepted the message but before the
    // success is recorded (deploy restart, OOM, a failed store write), the next
    // attempt sees the intent and scans for the marker instead of reposting.
    // A write failure here throws before anything is sent.
    if (poll.delivery?.noticeUnknownPart !== index) {
      this.patchDelivery(poll.id, (d) => {
        d.noticeUnknownPart = index;
      });
    }
    try {
      await this.slack.postMessage(poll.channel, text, { threadTs: poll.threadTs });
    } catch (error) {
      const cls = classifySlackDeliveryError(error);
      if (cls.kind === 'permanent') {
        this.logger.warn('Poll roster notice permanently failed', { pollId: poll.id, code: cls.code });
        this.patchDelivery(poll.id, (d) => {
          d.noticeError = cls.code;
        });
        return 'stopped';
      }
      if (cls.kind === 'transient') {
        // Definitively not sent (queue_overflow / ratelimited): nothing to look up next time.
        this.patchDelivery(poll.id, (d) => {
          d.noticeUnknownPart = undefined;
        });
      }
      return 'transient'; // unknown keeps the intent → marker scan before any repost
    }
    // Outside the try: a store failure after a successful post must not be
    // classified as a Slack outcome. It propagates with the intent still on disk.
    this.patchDelivery(poll.id, (d) => {
      d.noticesDone = index + 1;
      d.noticeUnknownPart = undefined;
    });
    return 'done';
  }

  /** Give up transient retries: persisted state + log + best-effort thread note. */
  private async expire(pollId: string): Promise<void> {
    const poll = this.store.get(pollId);
    if (!poll?.delivery || poll.delivery.expiredAt !== undefined) return;
    const now = this.now();
    this.patchDelivery(pollId, (d) => {
      d.expiredAt = now;
    });
    this.logger.warn('Poll result delivery expired — will resume on restart within 7 days of close', {
      pollId,
      channel: poll.channel,
      threadTs: poll.threadTs,
    });
    await this.slack
      .postMessage(
        poll.channel,
        `⚠️ 투표 결과 전달을 완료하지 못했습니다 (ref ${poll.id}). 마감 후 7일 이내 봇 재시작 시 다시 시도합니다.`,
        { threadTs: poll.threadTs },
      )
      .catch(() => undefined);
  }

  private patchDelivery(pollId: string, mutate: (d: PollDelivery) => void): void {
    this.store.update(pollId, (p) => {
      if (p.delivery) mutate(p.delivery);
    });
  }
}

function freshDelivery(closedAt: number, canceled: boolean): PollDelivery {
  return {
    cardDone: false,
    noticesDone: 0,
    noticeDone: canceled,
    attempts: 0,
    nextAttemptAt: 0,
    retryUntil: closedAt + RETRY_WINDOW_MS,
  };
}

/** Length in Unicode code points — the unit the somalib validator uses. */
function codePoints(value: string): number {
  return Array.from(value).length;
}

function hasPendingDelivery(d: PollDelivery): boolean {
  return (!d.cardDone && !d.cardError) || (!d.noticeDone && !d.noticeError);
}

// ── singleton seam (composition root wires it; host-apply + scheduler read it) ──

let activePollService: PollService | undefined;

export function setActivePollService(service: PollService | undefined): void {
  activePollService = service;
}

export function getActivePollService(): PollService | undefined {
  return activePollService;
}
