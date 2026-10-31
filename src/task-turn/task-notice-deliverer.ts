import { markdownToBlocks } from '@soma/slack/formatters/markdown-to-blocks';
import type { ConversationSession, TaskNoticeIntent } from '../types';
import type { TaskNotificationLedger, TaskNotificationLedgerEntry } from './task-notification-ledger';

/**
 * E2 ⑤ — the only thing that posts a Slack-less task's notices to its
 * instruction thread (.prd/18 D6 · D7 · D8 · D10 · D13, §6.3).
 *
 * What a task owes is on its record (`notices`, written with the outcome — E2
 * ③). `enqueue` registers it in the ledger (E2 ④), addressed to the thread,
 * with what rendering needs later (the task may be closed by then). `deliver`
 * posts what is owed:
 *  - a task's link first — its other notices wait while the link is owed;
 *  - each notice claimed in the ledger before its post, marked with the
 *    message ts after (at least once: a crash in between posts it again);
 *  - a failed post retried up to `maxAttempts`, then marked failed;
 *  - a question only while the task still waits on that same askId —
 *    otherwise it is closed (answered → resolved, replaced → superseded).
 * One pass at a time; a pass asked for during one runs once after it.
 *
 * The task runner never calls Slack (A0 T9); this module is the boundary.
 */

export interface TaskNoticeDelivererDeps {
  ledger: Pick<
    TaskNotificationLedger,
    'register' | 'claim' | 'markPosted' | 'markFailed' | 'close' | 'owed' | 'get' | 'list'
  >;
  /** Post one message in the instruction thread. */
  post(
    target: { channel: string; threadTs: string },
    message: { text: string; blocks?: unknown[] },
  ): Promise<{ ts?: string }>;
  /** The main agent's `final` text for that turn of that conversation, if any; `clipped` when the stored line was cut. */
  readFinal(conversationId: string, turnId: string): Promise<{ text: string; clipped: boolean } | undefined>;
  /** The task card's dashboard URL, or undefined when the dashboard is not listening. */
  cardUrl(ownerId: string, sessionKey: string): string | undefined;
  /** The live task by id (for a question's current state); undefined once it is closed. */
  getTask(taskId: string): { session: ConversationSession; sessionKey: string } | undefined;
  maxAttempts?: number;
  /** A notice reached the thread or was closed: its intent may leave the task record (next save). */
  settled?(taskId: string, noticeId: string): void;
  /** Delay before a pass retries a post that failed and has attempts left (default 30s). */
  retryDelayMs?: number;
  logger: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}

export interface TaskNoticeDeliverer {
  /** Register a task's owed notices in the ledger (idempotent). Throws if the ledger cannot be written. */
  enqueue(session: ConversationSession, sessionKey: string): void;
  /**
   * The delete boundary (D6): hand a task's owed notices to the ledger before
   * the task goes — plus an `interrupted` one while its chain is still open.
   * Throws if the ledger cannot be written; the registry then refuses the deletion.
   */
  handoff(session: ConversationSession, sessionKey: string): void;
  /**
   * Post what is owed. Never throws; failures are recorded in the ledger.
   * `retryFailed` (the boot pass, D13) also tries once more each notice that
   * had failed; otherwise a failed notice is left alone in this process.
   */
  deliver(options?: { retryFailed?: boolean }): Promise<void>;
  /** Notices of this task card that could not be delivered (spent attempts). */
  failures(sessionKey: string): Array<{ kind: TaskNotificationLedgerEntry['kind']; error: string }>;
  /** Shutdown: no new pass and no retry from now on. */
  stop(): void;
}

const NO_FINAL = '답변 기록 없음 — 카드에서 확인';
const FINAL_UNREADABLE = '결과를 읽지 못했어요 — 카드에서 확인';
const MORE_ON_CARD = '…(이하 카드에서)';
/** Slack's per-message block cap, kept with room for the link context. */
const MAX_BLOCKS = 48;

export function createTaskNoticeDeliverer(deps: TaskNoticeDelivererDeps): TaskNoticeDeliverer {
  const maxAttempts = deps.maxAttempts ?? 3;
  const retryDelayMs = deps.retryDelayMs ?? 30_000;
  let running: Promise<void> | null = null;
  let again = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryFailedNext = false;
  let stopped = false;
  /**
   * Posted, but the mark could not be saved: still `unknown` on disk. Not
   * posted again in this process (a full disk would re-post on every pass);
   * a restart claims it again — one duplicate per crash, as D7 allows.
   */
  const markLost = new Set<string>();

  function enqueue(session: ConversationSession, sessionKey: string): void {
    if (session.slackless === true && !session.originThread && (session.notices?.length ?? 0) > 0) {
      // Its thread went to another task (a load collision): these cannot be delivered.
      deps.logger.warn('Task notices with no instruction thread — not deliverable', {
        sessionKey,
        notices: session.notices?.map((n) => n.id),
      });
      return;
    }
    register(session, sessionKey, session.notices ?? []);
  }

  function handoff(session: ConversationSession, sessionKey: string): void {
    if (session.slackless !== true || !session.originThread || !session.taskId) return;
    const notices = [...(session.notices ?? [])];
    // A chain still open (or a turn still working) when its task goes ends
    // here: the same id reconciliation and endStranded give that chain.
    const lost = session.openChain ?? (session.activityState === 'working' ? session.activeTaskTurnId : undefined);
    if (lost) {
      notices.push({
        id: `${session.taskId}:${lost}:interrupted`,
        kind: 'interrupted',
        ...(session.openChain ? { chainId: session.openChain } : {}),
        ...(session.activeTaskTurnId ? { turnId: session.activeTaskTurnId } : {}),
        outcome: 'interrupted',
        reason: '턴이 끝나기 전에 작업이 닫혔어요',
        at: Date.now(),
      });
    }
    register(session, sessionKey, notices);
  }

  function register(session: ConversationSession, sessionKey: string, notices: TaskNoticeIntent[]): void {
    const origin = session.originThread;
    if (session.slackless !== true || !origin || !session.taskId) return;
    for (const notice of notices) {
      deps.ledger.register({
        id: notice.id,
        taskId: session.taskId,
        kind: notice.kind,
        channel: origin.channel,
        threadTs: origin.threadTs,
        intent: intentOf(notice, session, sessionKey),
      });
    }
  }

  function deliver(options?: { retryFailed?: boolean }): Promise<void> {
    if (stopped) return Promise.resolve();
    if (options?.retryFailed) retryFailedNext = true;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await pass();
          } catch (error) {
            // Never a rejection for a caller that joined this pass: what is owed stays in the ledger.
            deps.logger.error('Task notice pass failed', { error: (error as Error)?.message });
          }
        } while (again && !stopped);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function pass(): Promise<void> {
    const retryFailed = retryFailedNext;
    retryFailedNext = false;
    const owed = deps.ledger.owed();
    // Tasks whose link is still to be posted: their other notices wait (one scan per pass).
    const linkPending = new Set(owed.filter((e) => isOwedLink(e)).map((e) => e.taskId));
    for (const entry of owed) {
      if (stopped) return;
      if (markLost.has(entry.id)) continue;
      if (entry.state === 'failed' && !retryFailed) continue;
      if (entry.kind !== 'link' && linkPending.has(entry.taskId)) continue;
      try {
        await deliverOne(entry);
      } catch (error) {
        // Before the claim (a write that failed): still owed, tried again later.
        deps.logger.error('Task notice not delivered', { id: entry.id, error: (error as Error)?.message });
        scheduleRetry();
      }
      if (entry.kind === 'link') {
        const now = deps.ledger.get(entry.id);
        if (!now || !isOwedLink(now)) linkPending.delete(entry.taskId);
      }
    }
    // A post that failed with attempts left is retried by a later pass.
    if (deps.ledger.owed().some((e) => e.state === 'pending' && e.attempts > 0)) scheduleRetry();
  }

  function scheduleRetry(): void {
    // A pass stopped during its last post still reaches here (grok #668 R2).
    if (retry || stopped) return;
    retry = setTimeout(() => {
      retry = null;
      void deliver();
    }, retryDelayMs);
    retry.unref?.();
  }

  function settle(entry: TaskNotificationLedgerEntry): void {
    try {
      deps.settled?.(entry.taskId, entry.id);
    } catch (error) {
      deps.logger.warn('Task notice settled, but not pruned from its task', {
        id: entry.id,
        error: (error as Error)?.message,
      });
    }
  }

  /** A link still to be posted (not posted, not given up, not posted-with-a-lost-mark). */
  function isOwedLink(e: TaskNotificationLedgerEntry): boolean {
    return e.kind === 'link' && !markLost.has(e.id) && (e.state === 'pending' || e.state === 'unknown');
  }

  async function deliverOne(entry: TaskNotificationLedgerEntry): Promise<void> {
    if (entry.kind === 'question') {
      const verdict = questionStillOpen(entry);
      if (verdict !== 'open') {
        deps.ledger.close(entry.id, verdict);
        settle(entry);
        return;
      }
    }
    const message = await render(entry);
    deps.ledger.claim(entry.id);
    let ts: string | undefined;
    try {
      ts = (await deps.post({ channel: entry.channel, threadTs: entry.threadTs }, message)).ts;
    } catch (error) {
      const attempts = deps.ledger.get(entry.id)?.attempts ?? maxAttempts;
      deps.ledger.markFailed(entry.id, describe(error), { final: attempts >= maxAttempts });
      return;
    }
    try {
      deps.ledger.markPosted(entry.id, ts ?? '');
    } catch (error) {
      markLost.add(entry.id);
      deps.logger.error('Task notice posted, but its mark was not saved — not posted again until a restart', {
        id: entry.id,
        ts,
        error: (error as Error)?.message,
      });
      return;
    }
    settle(entry);
  }

  function questionStillOpen(entry: TaskNotificationLedgerEntry): 'open' | 'resolved' | 'superseded' {
    const live = deps.getTask(entry.taskId)?.session;
    if (!live || live.activityState !== 'waiting') return 'resolved';
    const askId = (live.actionPanel?.pendingQuestion as { askId?: unknown } | undefined)?.askId;
    return askId === entry.intent.askId ? 'open' : 'superseded';
  }

  async function render(entry: TaskNotificationLedgerEntry): Promise<{ text: string; blocks?: unknown[] }> {
    const url =
      entry.intent.ownerId && entry.intent.sessionKey
        ? deps.cardUrl(entry.intent.ownerId, entry.intent.sessionKey)
        : undefined;
    const card = url ? `<${url}|카드 열기>` : '';
    switch (entry.kind) {
      case 'link':
        return {
          text: url
            ? `:clipboard: 대시보드 작업으로 시작했어요 — ${card} (${url})\n결과와 입력 요청이 이 스레드에 올라옵니다.`
            : ':clipboard: 대시보드 작업으로 시작했어요.\n결과와 입력 요청이 이 스레드에 올라옵니다.',
        };
      case 'result':
        return renderResult(entry, url);
      case 'question':
        return { text: `:raising_hand: 답이 필요해요 — 카드에서 답해 주세요. ${url ?? ''}`.trim() };
      case 'interrupted':
        return {
          text: withLink(`:double_vertical_bar: 작업이 중단됐어요: ${entry.intent.reason ?? '이유 없음'}`, url),
        };
      default:
        return {
          text: withLink(
            entry.intent.outcome === 'cancelled'
              ? `:stop_sign: 작업이 중지됐어요: ${entry.intent.reason ?? '이유 없음'}`
              : `:warning: 작업이 끝나지 못했어요: ${entry.intent.reason ?? '이유 없음'}`,
            url,
          ),
        };
    }
  }

  async function renderResult(
    entry: TaskNotificationLedgerEntry,
    url: string | undefined,
  ): Promise<{ text: string; blocks?: unknown[] }> {
    const { conversationId, turnId } = entry.intent;
    let final: { text: string; clipped: boolean } | undefined;
    try {
      final = conversationId && turnId ? await deps.readFinal(conversationId, turnId) : undefined;
    } catch (error) {
      // The result is still owed: post that it ended, and where to read it.
      deps.logger.warn('Task result final not readable', { id: entry.id, error: (error as Error)?.message });
      return { text: withLink(FINAL_UNREADABLE, url) };
    }
    if (!final || final.text.trim() === '') return { text: withLink(NO_FINAL, url) };
    const { blocks, fallbackText, overflow } = markdownToBlocks(final.text);
    // Conversion failed: the Slack-session renderer's plain text (§6.3), not raw markdown.
    if (blocks.length === 0) return { text: withLink(fallbackText || final.text, url) };
    const kept = blocks.slice(0, MAX_BLOCKS);
    const cut = final.clipped || overflow.length > 0 || kept.length < blocks.length;
    const tail = [cut ? MORE_ON_CARD : '', url ? `<${url}|카드에서 전체 보기>` : ''].filter(Boolean).join(' ');
    const context = tail ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: tail }] }] : [];
    return { text: fallbackText, blocks: [...kept, ...context] };
  }

  function failures(sessionKey: string): Array<{ kind: TaskNotificationLedgerEntry['kind']; error: string }> {
    return deps.ledger
      .list()
      .filter((e) => e.state === 'failed' && e.intent.sessionKey === sessionKey)
      .map((e) => ({ kind: e.kind, error: e.error ?? 'unknown error' }));
  }

  /** Shutdown: no new pass, no retry; a pass under way ends after its current post. */
  function stop(): void {
    stopped = true;
    retryFailedNext = false;
    if (retry) clearTimeout(retry);
    retry = null;
  }

  return { enqueue, handoff, deliver, failures, stop };
}

/**
 * The task still owes its instruction thread something — saved notices, or a
 * chain/turn whose end would owe one. With no ledger to hand it to, deleting
 * the task must be refused (D6 fail-closed).
 */
export function owesInstructionThread(session: ConversationSession): boolean {
  if (session.slackless !== true || !session.originThread) return false;
  return (session.notices?.length ?? 0) > 0 || !!session.openChain || session.activityState === 'working';
}

function intentOf(notice: TaskNoticeIntent, session: ConversationSession, sessionKey: string) {
  return {
    ...(notice.chainId ? { chainId: notice.chainId } : {}),
    ...(notice.turnId ? { turnId: notice.turnId } : {}),
    ...(notice.askId ? { askId: notice.askId } : {}),
    ...(notice.outcome ? { outcome: notice.outcome } : {}),
    ...(notice.reason ? { reason: notice.reason } : {}),
    at: notice.at,
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    ownerId: session.ownerId,
    sessionKey,
  };
}

function withLink(text: string, url: string | undefined): string {
  return url ? `${text}\n${url}` : text;
}

function describe(error: unknown): string {
  const data = (error as { data?: { error?: unknown } })?.data?.error;
  if (typeof data === 'string') return data;
  return (error as Error)?.message ?? String(error);
}
