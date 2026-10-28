// Per-request approval, received by the broker itself (.prd/16-devops-tools-architecture.md §5): a card in
// each admin's DM from the broker's own Slack app, an admin's own ✅ / ❌ reaction read back with
// reactions.get or an admin's own 승인 / 거부 button click delivered over Socket Mode (`decide`), and an
// approval that can be used exactly once. Slack errors never approve; every state transition is on disk
// before anyone acts on it; nothing here writes a token anywhere. Reactions keep being polled when the cards
// have buttons, so a Socket Mode outage never blocks an approval.

import { createHash, randomBytes } from 'node:crypto';
import type { DevopsTool, UnverifiedRequesterClaim } from '@soma/process-shared/devops/protocol.js';
import type { Ledger } from './ledger.js';
import type { BrokerPolicy } from './policy.js';
import { type SlackApi, SlackApiError } from './slack-api.js';
import {
  ApprovalError,
  type ApprovalRequest,
  type CardStatus,
  renderApprovalCard,
  renderCardStatus,
  renderResultReply,
  type SlackCard,
} from './slack-card.js';
import type { StateStore } from './state.js';

export { ApprovalError, type ApprovalErrorCode, type ApprovalRequest } from './slack-card.js';

export type ApprovalOutcome =
  | { outcome: 'approved'; approvalId: string; consume(): Promise<void> }
  | { outcome: 'denied' | 'expired' | 'cancelled'; approvalId: string };

export interface Approvals {
  /**
   * Posts a card (or joins the pending card of an identical request) and resolves with the decision.
   * Throws ApprovalError for too-many-pending-approvals / card-too-long / slack-unavailable.
   */
  request(
    req: ApprovalRequest,
    hooks: {
      onPending(p: { approvalId: string; digestPrefix: string; expiresAt: string }): void;
      signal?: AbortSignal;
    },
  ): Promise<ApprovalOutcome>;
  /** One line in each card's thread and the cards marked done; best effort, never throws. */
  postResult(approvalId: string, line: string): Promise<void>;
  /**
   * The holder will not use this approval: once every holder of an approved record has released it (identical
   * requests share one), the record moves to `cancelled` on disk with a ledger row and the cards say why.
   * A consumed or already decided record is left alone. Never throws.
   */
  release(approvalId: string, reason: ApprovalReleaseReason): Promise<void>;
  /**
   * A 승인 / 거부 button click delivered over Socket Mode. Counts only when the clicker is an admin, the approval
   * is still pending, and the click came from one of that approval's own cards; then it is decided exactly
   * like a reaction (expiry, one use and disk-first all apply). Never throws.
   */
  decide(click: ButtonClick): Promise<'accepted' | 'ignored'>;
  /** Cancels what is still open (approved-but-unused included) and waits for the card updates. */
  close(): Promise<void>;
}

/** What the Socket Mode client reads from a block_actions payload (Slack, not the requester, sets `user`). */
export interface ButtonClick {
  approvalId: string;
  action: 'approve' | 'deny';
  user: string;
  channel: string;
  messageTs: string;
}

/** How long a click on a card that is still being posted to the other admins waits for it to open. */
const CLICK_WHILE_POSTING_WAIT_MS = 5_000;

/** Why a handed-out approval goes unused. */
export type ApprovalReleaseReason = 'requester-stopped-waiting';

const RELEASE_LINES: Record<ApprovalReleaseReason, string> = {
  'requester-stopped-waiting': '취소됨 — 요청자가 응답을 기다리지 않음',
};

/**
 * Why `consume()` refused: `used` = already consumed (by this or an identical request); `closed` = the
 * broker is shutting down; `not-approved` = no longer approved (expired or cancelled, e.g. after a restart).
 */
export type ApprovalConsumeReason = 'used' | 'closed' | 'not-approved';

const CONSUME_MESSAGES: Record<ApprovalConsumeReason, string> = {
  used: 'was already used',
  closed: 'cannot be used: the broker is shutting down',
  'not-approved': 'is no longer approved (it expired or was cancelled)',
};

/** Thrown by `consume()`; nothing ran. */
export class ApprovalConsumeError extends Error {
  readonly approvalId: string;
  readonly reason: ApprovalConsumeReason;

  constructor(approvalId: string, reason: ApprovalConsumeReason = 'used') {
    super(`approval ${approvalId} ${CONSUME_MESSAGES[reason]}`);
    this.name = 'ApprovalConsumeError';
    this.approvalId = approvalId;
    this.reason = reason;
  }
}

/**
 * How many new cards may reach the admins' DMs. A new card = a request that is not an identical copy of a
 * pending one and reached at least one admin. Over a limit → ApprovalError('too-many-pending-approvals').
 */
export interface ApprovalLimits {
  /** Sliding window for the two per-window counts. */
  windowMs: number;
  globalCardsPerWindow: number;
  /** Per claimed sessionKey (self-claimed, so this only slows one honest-but-looping session). */
  sessionCardsPerWindow: number;
  /** Cards one sessionKey may have waiting at once (policy.maxPendingApprovals stays the global cap). */
  sessionPending: number;
  /** After a session abandoned its card (every waiter left), no new card from it for this long. */
  abandonedCoolDownMs: number;
}

export const DEFAULT_APPROVAL_LIMITS: Readonly<ApprovalLimits> = Object.freeze({
  windowMs: 10 * 60 * 1000,
  globalCardsPerWindow: 12,
  sessionCardsPerWindow: 4,
  sessionPending: 2,
  abandonedCoolDownMs: 60 * 1000,
});

export type ApprovalStatus = 'pending' | 'approved' | 'consumed' | 'denied' | 'expired' | 'cancelled';

export interface ApprovalCardPost {
  admin: string;
  channel: string;
  ts: string;
}

export interface ApprovalRecord {
  approvalId: string;
  tool: DevopsTool;
  digest: string;
  status: ApprovalStatus;
  claimedRequester: UnverifiedRequesterClaim;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  consumedAt?: string;
  reason?: string;
  posts: ApprovalCardPost[];
  /** The posted card, kept while a later chat.update still needs it. */
  card?: SlackCard;
}

export interface ApprovalState {
  approvals: Record<string, ApprovalRecord>;
}

/** Lives in the broker's state directory (`state/approvals.json`). */
export const APPROVAL_STATE_FILE = 'approvals.json';
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

export function initialApprovalState(): ApprovalState {
  return { approvals: {} };
}

const APPROVE_REACTION = 'white_check_mark';
const DENY_REACTION = 'x';
/** Used when Slack rate-limits without a usable Retry-After. */
const DEFAULT_RETRY_AFTER_SECONDS = 30;
/** Decided records are dropped from the state file after this long; the ledger keeps the history. */
const RECORD_RETENTION_MS = 24 * 3600 * 1000;
/** Approved cards remembered in memory for postResult. */
const MAX_REMEMBERED_DECISIONS = 100;

/** Key-sorted JSON at every level; same values give the same text whatever the key order. */
function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(entry).sort()) sorted[key] = (entry as Record<string, unknown>)[key];
    return sorted;
  });
  if (text === undefined) throw new TypeError('approval request has no JSON form');
  return text;
}

/** sha256 hex of the key-sorted JSON of `{tool, canonical, claimedRequester}`. */
export function approvalDigest(req: Pick<ApprovalRequest, 'tool' | 'canonical' | 'claimedRequester'>): string {
  return createHash('sha256')
    .update(canonicalJson({ tool: req.tool, canonical: req.canonical, claimedRequester: req.claimedRequester }))
    .digest('hex');
}

type Decision =
  | { kind: 'approved'; by: string }
  | { kind: 'denied'; by: string }
  | { kind: 'expired'; reason?: string }
  | { kind: 'cancelled'; reason: string };

interface Waiter {
  resolve(outcome: ApprovalOutcome): void;
  reject(err: unknown): void;
  onPending(p: { approvalId: string; digestPrefix: string; expiresAt: string }): void;
  detach(): void;
}

interface Entry {
  approvalId: string;
  digest: string;
  sessionKey: string;
  /** When this card was counted against the windows (released if it reached no admin). */
  countedAt: number;
  expiresAtMs: number;
  card: SlackCard;
  /** posting → pending → settled; only posting/pending entries count against the cap or take duplicates. */
  status: 'posting' | 'pending' | 'settled';
  posts: ApprovalCardPost[];
  waiters: Set<Waiter>;
}

function errorCode(err: unknown): string {
  if (err instanceof SlackApiError) return err.code;
  if (err instanceof Error && err.name.length > 0) return err.name;
  return 'error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own entries only: an approval id from a caller is never looked up on the prototype. */
function recordOf(state: ApprovalState, approvalId: string): ApprovalRecord | undefined {
  return Object.hasOwn(state.approvals, approvalId) ? state.approvals[approvalId] : undefined;
}

export function createApprovals(opts: {
  policy: BrokerPolicy;
  slack: SlackApi;
  store: StateStore<ApprovalState>;
  ledger: Ledger;
  now?: () => number;
  pollIntervalMs?: number;
  limits?: Partial<ApprovalLimits>;
  /** Put 승인 / 거부 buttons on new cards (only when something calls `decide` with their clicks). */
  buttons?: boolean;
  /** Operator log line (never a secret); default stderr. */
  log?: (line: string) => void;
}): Approvals {
  const { policy, slack, store, ledger } = opts;
  const clock = opts.now ?? Date.now;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const limits: ApprovalLimits = { ...DEFAULT_APPROVAL_LIMITS, ...opts.limits };
  const log = opts.log ?? ((line: string) => process.stderr.write(`soma-devops-broker: ${line}\n`));
  const admins = new Set(policy.admins);
  const iso = (ms: number) => new Date(ms).toISOString();

  /** Times new cards were counted, overall and per session (pruned to the window on every check). */
  const globalCards: { at: number; approvalId: string }[] = [];
  const sessionCards = new Map<string, { at: number; approvalId: string }[]>();
  /** sessionKey → clock() until which it may not open a new card. */
  const coolDowns = new Map<string, number>();
  /** finish() calls not yet done; close() waits for them. */
  const finishing = new Set<Promise<void>>();

  /** posting/pending entries by approval id. */
  const active = new Map<string, Entry>();
  /** Approved entries this process handed out, for postResult, release and close. `holders` = waiters handed it. */
  const decided = new Map<string, { posts: ApprovalCardPost[]; card: SlackCard | undefined; holders: number }>();
  const dmChannels = new Map<string, Promise<string>>();
  /** Card updates per approval run in order, so a late "approved" never overwrites "done". */
  const cardChains = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();
  const postings = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let loopRunning = false;
  let wakeLoop: (() => void) | undefined;
  /** performance.now() before which reactions.get is not called (Retry-After). */
  let blockedUntil = 0;

  /** Every transition re-reads the file first: the file, not this process's memory, is the authority. */
  async function mutate<R>(fn: (draft: ApprovalState) => R): Promise<R> {
    await store.load();
    return store.update((draft) => {
      if (!isRecord(draft.approvals)) draft.approvals = {};
      return fn(draft);
    });
  }

  function track(work: Promise<void>): void {
    const done = work.catch(() => undefined);
    inflight.add(done);
    void done.then(() => inflight.delete(done));
  }

  function onCards(approvalId: string, work: () => Promise<void>): Promise<void> {
    const next = (cardChains.get(approvalId) ?? Promise.resolve()).then(work).catch(() => undefined);
    cardChains.set(approvalId, next);
    void next.then(() => {
      if (cardChains.get(approvalId) === next) cardChains.delete(approvalId);
    });
    track(next);
    return next;
  }

  function updateCards(approvalId: string, posts: readonly ApprovalCardPost[], card: SlackCard): Promise<void> {
    return onCards(approvalId, async () => {
      for (const post of posts) {
        try {
          await slack.updateMessage(post.channel, post.ts, card);
        } catch (err) {
          await ledger
            .append({ event: 'approval.card-update-failed', approvalId, admin: post.admin, code: errorCode(err) })
            .catch(() => undefined);
        }
      }
    });
  }

  function prune(draft: ApprovalState, nowMs: number): void {
    for (const [id, record] of Object.entries(draft.approvals)) {
      if (record.status === 'pending' || record.status === 'approved') continue;
      const last = Date.parse(record.consumedAt ?? record.decidedAt ?? record.createdAt);
      if (!Number.isFinite(last) || nowMs - last > RECORD_RETENTION_MS) delete draft.approvals[id];
    }
  }

  /**
   * A previous process's open approvals have no client any more: void them before anything else. A failed
   * sweep is retried by the next request; records already voided on disk keep their place in `toAnnounce`
   * so a retry writes each ledger row once.
   */
  let swept = false;
  let sweeping: Promise<void> | undefined;
  let toAnnounce: { approvalId: string; posts: ApprovalCardPost[]; card?: SlackCard }[] | undefined;

  async function sweep(): Promise<void> {
    if (toAnnounce === undefined) {
      const nowMs = clock();
      toAnnounce = await mutate((draft) => {
        const out: { approvalId: string; posts: ApprovalCardPost[]; card?: SlackCard }[] = [];
        for (const record of Object.values(draft.approvals)) {
          if (record.status !== 'pending' && record.status !== 'approved') continue;
          out.push({ approvalId: record.approvalId, posts: record.posts ?? [], card: record.card });
          record.status = 'expired';
          record.decidedAt = iso(nowMs);
          record.reason = 'restart';
          delete record.card;
        }
        prune(draft, nowMs);
        return out;
      });
    }
    while (toAnnounce.length > 0) {
      const { approvalId, posts, card } = toAnnounce[0];
      await ledger.append({ event: 'approval.expired', approvalId, reason: 'restart' });
      toAnnounce.shift();
      updateCards(approvalId, posts, renderCardStatus(card, { kind: 'expired' }));
    }
    swept = true;
  }

  function ready(): Promise<void> {
    if (swept) return Promise.resolve();
    if (sweeping === undefined) {
      const attempt = sweep().catch((err: unknown) => {
        log(`approval start-up sweep failed (${errorCode(err)}); retrying on the next request`);
        throw err;
      });
      sweeping = attempt;
      void attempt.then(
        () => undefined,
        () => {
          if (sweeping === attempt) sweeping = undefined;
        },
      );
    }
    return sweeping;
  }
  ready().catch(() => undefined);

  function announce(entry: Entry, waiter: Waiter): void {
    try {
      waiter.onPending({
        approvalId: entry.approvalId,
        digestPrefix: entry.digest.slice(0, 12),
        expiresAt: iso(entry.expiresAtMs),
      });
    } catch {
      // The caller's callback failing does not change the approval.
    }
  }

  function consumer(approvalId: string): () => Promise<void> {
    return async () => {
      await mutate((draft) => {
        const record = recordOf(draft, approvalId);
        if (record?.status === 'consumed') throw new ApprovalConsumeError(approvalId, 'used');
        if (closed) throw new ApprovalConsumeError(approvalId, 'closed');
        if (record?.status !== 'approved') throw new ApprovalConsumeError(approvalId, 'not-approved');
        record.status = 'consumed';
        record.consumedAt = iso(clock());
      });
      await ledger.append({ event: 'approval.consumed', approvalId });
    };
  }

  function addWaiter(
    entry: Entry,
    hooks: Parameters<Approvals['request']>[1],
    resolve: (outcome: ApprovalOutcome) => void,
    reject: (err: unknown) => void,
  ): Waiter {
    const signal = hooks.signal;
    const onAbort = () => {
      if (!entry.waiters.delete(waiter)) return;
      resolve({ outcome: 'cancelled', approvalId: entry.approvalId });
      if (entry.waiters.size === 0 && entry.status === 'pending') {
        void finish(entry, { kind: 'cancelled', reason: 'requester-gone' });
      }
    };
    const waiter: Waiter = {
      resolve,
      reject,
      onPending: hooks.onPending,
      detach: () => signal?.removeEventListener('abort', onAbort),
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.waiters.add(waiter);
    return waiter;
  }

  function settleWaiters(entry: Entry, settle: (waiter: Waiter) => void): void {
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) {
      waiter.detach();
      settle(waiter);
    }
  }

  function finish(entry: Entry, decision: Decision): Promise<void> {
    if (entry.status !== 'pending') return Promise.resolve();
    const work = settle(entry, decision).catch(() => undefined);
    finishing.add(work);
    void work.then(() => finishing.delete(work));
    return work;
  }

  /** Set before any await, so the session's very next request already sees it. */
  function coolDown(entry: Entry): void {
    coolDowns.set(entry.sessionKey, clock() + limits.abandonedCoolDownMs);
  }

  async function settle(entry: Entry, reported: Decision): Promise<void> {
    entry.status = 'settled';
    active.delete(entry.approvalId);
    const approvalId = entry.approvalId;
    // The card states its deadline; a ✅ first seen after it does not count (the clock is read once, here).
    const decidedAtMs = clock();
    const decision: Decision =
      reported.kind === 'approved' && decidedAtMs >= entry.expiresAtMs
        ? { kind: 'expired', reason: 'approved-after-expiry' }
        : reported;
    let final: Decision = decision;
    const decidedAt = iso(decidedAtMs);
    if (decision.kind === 'cancelled' && decision.reason === 'requester-gone') coolDown(entry);
    try {
      await mutate((draft) => {
        const record = draft.approvals[approvalId];
        if (record === undefined || record.status !== 'pending') throw new Error('approval record is not pending');
        record.status = decision.kind;
        record.decidedAt = decidedAt;
        if (decision.kind === 'approved' || decision.kind === 'denied') record.decidedBy = decision.by;
        if ((decision.kind === 'expired' || decision.kind === 'cancelled') && decision.reason !== undefined) {
          record.reason = decision.reason;
        }
        if (decision.kind !== 'approved') delete record.card;
      });
    } catch (err) {
      // An approval that is not on disk is never handed out.
      if (decision.kind === 'approved') final = { kind: 'cancelled', reason: 'state-write-failed' };
      await ledger
        .append({ event: 'approval.state-write-failed', approvalId, code: errorCode(err) })
        .catch(() => undefined);
    }
    const by = final.kind === 'approved' || final.kind === 'denied' ? { by: final.by } : {};
    const reason =
      (final.kind === 'expired' || final.kind === 'cancelled') && final.reason ? { reason: final.reason } : {};
    try {
      await ledger.append({ event: `approval.${final.kind}`, approvalId, ...by, ...reason });
    } catch {
      // No audit row, no execution.
      if (final.kind === 'approved') {
        final = { kind: 'cancelled', reason: 'ledger-write-failed' };
        await mutate((draft) => {
          const record = draft.approvals[approvalId];
          if (record?.status === 'approved') record.status = 'cancelled';
        }).catch(() => undefined);
      }
    }
    if (final.kind === 'approved' && (closed || entry.waiters.size === 0)) {
      // Nobody is left to use it (or the broker is closing): never leave an approved record behind.
      const reason = closed ? 'broker-closing' : 'requester-gone';
      final = { kind: 'cancelled', reason };
      if (reason === 'requester-gone') coolDown(entry);
      await mutate((draft) => {
        const record = recordOf(draft, approvalId);
        if (record?.status !== 'approved') return;
        record.status = 'cancelled';
        record.reason = reason;
        delete record.card;
      }).catch(() => undefined);
      await ledger.append({ event: 'approval.cancelled', approvalId, reason }).catch(() => undefined);
    }
    if (final.kind === 'approved') {
      const consume = consumer(approvalId);
      decided.set(approvalId, { posts: entry.posts, card: entry.card, holders: entry.waiters.size });
      if (decided.size > MAX_REMEMBERED_DECISIONS) {
        const oldest = decided.keys().next().value;
        if (oldest !== undefined) decided.delete(oldest);
      }
      settleWaiters(entry, (waiter) => waiter.resolve({ outcome: 'approved', approvalId, consume }));
    } else {
      const outcome = final.kind;
      settleWaiters(entry, (waiter) => waiter.resolve({ outcome, approvalId }));
    }
    const status: CardStatus = final.kind === 'approved' || final.kind === 'denied' ? final : { kind: final.kind };
    updateCards(approvalId, entry.posts, renderCardStatus(entry.card, status));
  }

  function dmChannel(admin: string): Promise<string> {
    let channel = dmChannels.get(admin);
    if (channel === undefined) {
      channel = slack.openDm(admin);
      dmChannels.set(admin, channel);
      const cached = channel;
      cached.catch(() => {
        if (dmChannels.get(admin) === cached) dmChannels.delete(admin);
      });
    }
    return channel;
  }

  async function post(entry: Entry, req: ApprovalRequest, createdAtMs: number): Promise<void> {
    const approvalId = entry.approvalId;
    try {
      await mutate((draft) => {
        prune(draft, createdAtMs);
        draft.approvals[approvalId] = {
          approvalId,
          tool: req.tool,
          digest: entry.digest,
          status: 'pending',
          claimedRequester: { ...req.claimedRequester },
          createdAt: iso(createdAtMs),
          expiresAt: iso(entry.expiresAtMs),
          posts: [],
          card: entry.card,
        };
      });
      await ledger.append({
        event: 'approval.requested',
        approvalId,
        tool: req.tool,
        digest: entry.digest,
        claimedRequester: {
          slackUserId: req.claimedRequester.slackUserId,
          sessionKey: req.claimedRequester.sessionKey,
        },
        expiresAt: iso(entry.expiresAtMs),
      });
      for (const admin of policy.admins) {
        let posted: ApprovalCardPost;
        try {
          const channel = await dmChannel(admin);
          const { ts } = await slack.postMessage(channel, entry.card);
          posted = { admin, channel, ts };
        } catch (err) {
          await ledger.append({ event: 'approval.card-post-failed', approvalId, admin, code: errorCode(err) });
          continue;
        }
        entry.posts.push(posted);
        await mutate((draft) => {
          draft.approvals[approvalId]?.posts.push(posted);
        });
        await ledger.append({
          event: 'approval.card-posted',
          approvalId,
          admin,
          channel: posted.channel,
          messageTs: posted.ts,
        });
      }
    } catch (err) {
      // State or ledger write failed: nothing may be approved from this card.
      entry.status = 'settled';
      active.delete(approvalId);
      if (entry.posts.length === 0) uncount(entry);
      await mutate((draft) => {
        const record = draft.approvals[approvalId];
        if (record?.status === 'pending') record.status = 'cancelled';
      }).catch(() => undefined);
      updateCards(approvalId, entry.posts, renderCardStatus(entry.card, { kind: 'cancelled' }));
      settleWaiters(entry, (waiter) => waiter.reject(err));
      return;
    }
    if (entry.posts.length === 0) {
      entry.status = 'settled';
      active.delete(approvalId);
      uncount(entry);
      await mutate((draft) => {
        const record = draft.approvals[approvalId];
        if (record?.status !== 'pending') return;
        record.status = 'cancelled';
        record.reason = 'slack-unavailable';
        record.decidedAt = iso(clock());
        delete record.card;
      }).catch(() => undefined);
      await ledger
        .append({ event: 'approval.cancelled', approvalId, reason: 'slack-unavailable' })
        .catch(() => undefined);
      settleWaiters(entry, (waiter) => waiter.reject(new ApprovalError('slack-unavailable')));
      return;
    }
    entry.status = 'pending';
    for (const waiter of entry.waiters) announce(entry, waiter);
    if (entry.waiters.size === 0) {
      await finish(entry, { kind: 'cancelled', reason: 'requester-gone' });
      return;
    }
    startLoop();
  }

  function watched(): Entry[] {
    return [...active.values()].filter((entry) => entry.status === 'pending');
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeLoop = undefined;
        resolve();
      }, ms);
      wakeLoop = () => {
        clearTimeout(timer);
        wakeLoop = undefined;
        resolve();
      };
    });
  }

  /** Reads every card of one approval; a decision needs a clean read, except that a ❌ always wins. */
  async function readDecision(entry: Entry): Promise<{ decision?: Decision; ratelimited: boolean }> {
    let approvedBy: string | undefined;
    let deniedBy: string | undefined;
    let complete = true;
    for (const post of entry.posts) {
      let reactions: { name: string; users: string[] }[];
      try {
        reactions = await slack.getReactions(post.channel, post.ts);
      } catch (err) {
        if (err instanceof SlackApiError && err.code === 'ratelimited') {
          blockedUntil = performance.now() + (err.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000;
          return { decision: deniedBy === undefined ? undefined : { kind: 'denied', by: deniedBy }, ratelimited: true };
        }
        complete = false;
        continue;
      }
      for (const reaction of reactions) {
        const name = reaction.name.split('::')[0];
        const admin = reaction.users.find((user) => admins.has(user));
        if (admin === undefined) continue;
        if (name === DENY_REACTION) deniedBy ??= admin;
        else if (name === APPROVE_REACTION) approvedBy ??= admin;
      }
    }
    if (deniedBy !== undefined) return { decision: { kind: 'denied', by: deniedBy }, ratelimited: false };
    if (approvedBy !== undefined && complete)
      return { decision: { kind: 'approved', by: approvedBy }, ratelimited: false };
    return { ratelimited: false };
  }

  async function pollOnce(): Promise<void> {
    for (const entry of watched()) {
      if (clock() >= entry.expiresAtMs) await finish(entry, { kind: 'expired' });
    }
    if (performance.now() < blockedUntil) return;
    for (const entry of watched()) {
      if (closed) return;
      const { decision, ratelimited } = await readDecision(entry);
      if (decision !== undefined) await finish(entry, decision);
      if (ratelimited) return;
    }
  }

  /** One loop for all cards: the gap grows with the number of cards so the reactions.get rate stays flat. */
  async function loop(): Promise<void> {
    while (!closed) {
      const entries = watched();
      if (entries.length === 0) return;
      const cards = entries.reduce((sum, entry) => sum + entry.posts.length, 0);
      await sleep(pollIntervalMs * Math.max(1, Math.ceil(cards / 2)));
      if (closed) return;
      try {
        await pollOnce();
      } catch {
        // A failed round decides nothing; the next round tries again.
      }
    }
  }

  function startLoop(): void {
    if (loopRunning || closed) return;
    loopRunning = true;
    void loop().finally(() => {
      loopRunning = false;
      if (!closed && watched().length > 0) startLoop();
    });
  }

  type Refusal = { limit: string; message?: string; retryAfterSeconds?: number };

  async function refuse(
    req: ApprovalRequest,
    digest: string,
    code: ApprovalError['code'],
    refusal: Refusal = { limit: code },
  ): Promise<never> {
    await ledger
      .append({
        event: 'approval.refused',
        tool: req.tool,
        digest,
        reason: code,
        limit: refusal.limit,
        claimedRequester: {
          slackUserId: req.claimedRequester.slackUserId,
          sessionKey: req.claimedRequester.sessionKey,
        },
      })
      .catch(() => undefined);
    throw new ApprovalError(code, refusal.message, refusal.retryAfterSeconds);
  }

  function inWindow(list: { at: number }[], nowMs: number): void {
    while (list.length > 0 && nowMs - list[0].at >= limits.windowMs) list.shift();
  }

  function secondsUntil(ms: number, nowMs: number): number {
    return Math.max(1, Math.ceil((ms - nowMs) / 1000));
  }

  /** Drops marks and cool-downs that no longer matter, so the maps stay as small as the window. */
  function forget(nowMs: number): void {
    inWindow(globalCards, nowMs);
    for (const [key, mine] of sessionCards) {
      inWindow(mine, nowMs);
      if (mine.length === 0) sessionCards.delete(key);
    }
    for (const [key, until] of coolDowns) if (nowMs >= until) coolDowns.delete(key);
  }

  /** The first limit a new card from this session would break, or null. Synchronous: check and count are atomic. */
  function overLimit(sessionKey: string, nowMs: number): Refusal | null {
    forget(nowMs);
    if (active.size >= policy.maxPendingApprovals) return { limit: 'pending' };
    const pendingHere = [...active.values()].filter((entry) => entry.sessionKey === sessionKey).length;
    if (pendingHere >= limits.sessionPending) {
      return {
        limit: 'session-pending',
        message: `this session already has ${pendingHere} approval cards waiting; try again after one is decided`,
      };
    }
    const coolUntil = coolDowns.get(sessionKey);
    if (coolUntil !== undefined) {
      const wait = secondsUntil(coolUntil, nowMs);
      return {
        limit: 'session-cool-down',
        message: `approval cards from this session are rate-limited for ${wait} s after an abandoned card`,
        retryAfterSeconds: wait,
      };
    }
    const minutes = Math.round(limits.windowMs / 60_000);
    const mine = sessionCards.get(sessionKey) ?? [];
    if (mine.length >= limits.sessionCardsPerWindow) {
      const wait = secondsUntil(mine[0].at + limits.windowMs, nowMs);
      return {
        limit: 'session-rate',
        message: `approval cards are rate-limited: at most ${limits.sessionCardsPerWindow} new cards per session in ${minutes} min; try again in ${wait} s`,
        retryAfterSeconds: wait,
      };
    }
    if (globalCards.length >= limits.globalCardsPerWindow) {
      const wait = secondsUntil(globalCards[0].at + limits.windowMs, nowMs);
      return {
        limit: 'global-rate',
        message: `approval cards are rate-limited: at most ${limits.globalCardsPerWindow} new cards in ${minutes} min; try again in ${wait} s`,
        retryAfterSeconds: wait,
      };
    }
    return null;
  }

  function count(entry: Entry): void {
    globalCards.push({ at: entry.countedAt, approvalId: entry.approvalId });
    chargeSession(entry.sessionKey, entry.approvalId, entry.countedAt);
  }

  function chargeSession(sessionKey: string, approvalId: string, at: number): void {
    const mine = sessionCards.get(sessionKey) ?? [];
    mine.push({ at, approvalId });
    sessionCards.set(sessionKey, mine);
  }

  /** A card that reached no admin cost them nothing; it does not count. */
  function uncount(entry: Entry): void {
    const drop = (list: { approvalId: string }[]) => {
      const at = list.findIndex((mark) => mark.approvalId === entry.approvalId);
      if (at >= 0) list.splice(at, 1);
    };
    drop(globalCards);
    const mine = sessionCards.get(entry.sessionKey);
    if (mine !== undefined) {
      drop(mine);
      if (mine.length === 0) sessionCards.delete(entry.sessionKey);
    }
  }

  return {
    async request(req, hooks) {
      if (closed) throw new Error('approvals are closed');
      // A sweep that was already running when this request came in may fail; this request tries once itself.
      await ready().catch(() => ready());
      if (closed) throw new Error('approvals are closed');
      const freshId = () => randomBytes(16).toString('base64url');
      if (hooks.signal?.aborted) return { outcome: 'cancelled', approvalId: freshId() };
      const digest = approvalDigest(req);

      // From here to `active.set` nothing awaits, so concurrent requests see each other.
      const same = [...active.values()].find((entry) => entry.digest === digest);
      if (same !== undefined) {
        return new Promise<ApprovalOutcome>((resolve, reject) => {
          const waiter = addWaiter(same, hooks, resolve, reject);
          void ledger.append({ event: 'approval.attached', approvalId: same.approvalId }).catch(() => undefined);
          if (same.status === 'pending') announce(same, waiter);
        });
      }

      const createdAtMs = clock();
      const approvalId = freshId();
      const expiresAtMs = createdAtMs + policy.approvalTimeoutSeconds * 1000;
      // Limits first: an over-limit session is refused without rendering anything.
      const sessionKey = req.claimedRequester.sessionKey;
      const over = overLimit(sessionKey, createdAtMs);
      if (over !== null) return refuse(req, digest, 'too-many-pending-approvals', over);
      let card: SlackCard;
      try {
        card = renderApprovalCard(req, { approvalId, digest, expiresAtMs }, { buttons: opts.buttons === true });
      } catch (err) {
        if (err instanceof ApprovalError) {
          // Nothing reached an admin, but a session looping on oversized requests spends its own window
          // (not the global one, so it cannot lock other sessions out).
          if (err.code === 'card-too-long') chargeSession(sessionKey, approvalId, createdAtMs);
          return refuse(req, digest, err.code);
        }
        throw err;
      }

      const entry: Entry = {
        approvalId,
        digest,
        sessionKey,
        countedAt: createdAtMs,
        expiresAtMs,
        card,
        status: 'posting',
        posts: [],
        waiters: new Set(),
      };
      active.set(approvalId, entry);
      count(entry);
      return new Promise<ApprovalOutcome>((resolve, reject) => {
        addWaiter(entry, hooks, resolve, reject);
        const posting = post(entry, req, createdAtMs).catch(() => undefined);
        postings.add(posting);
        void posting.then(() => postings.delete(posting));
      });
    },

    async postResult(approvalId, line) {
      try {
        let target: { posts: ApprovalCardPost[]; card: SlackCard | undefined } | undefined = decided.get(approvalId);
        if (target === undefined) {
          const record = recordOf(store.get(), approvalId);
          if (record === undefined) return;
          target = { posts: record.posts, card: record.card };
        }
        const { posts, card } = target;
        const reply = renderResultReply(line);
        const done = renderCardStatus(card, { kind: 'done', line });
        await onCards(approvalId, async () => {
          for (const post of posts) {
            try {
              await slack.postMessage(post.channel, { ...reply, threadTs: post.ts });
            } catch (err) {
              await ledger
                .append({ event: 'approval.result-post-failed', approvalId, admin: post.admin, code: errorCode(err) })
                .catch(() => undefined);
            }
            try {
              await slack.updateMessage(post.channel, post.ts, done);
            } catch (err) {
              await ledger
                .append({ event: 'approval.card-update-failed', approvalId, admin: post.admin, code: errorCode(err) })
                .catch(() => undefined);
            }
          }
        });
        decided.delete(approvalId);
        await mutate((draft) => {
          const record = recordOf(draft, approvalId);
          if (record !== undefined) delete record.card;
        }).catch(() => undefined);
      } catch {
        // Best effort: the result is already in the ledger through the caller.
      }
    },

    async decide(click) {
      const ignore = async (reason: string): Promise<'ignored'> => {
        await ledger
          .append({ event: 'approval.click-ignored', approvalId: click.approvalId, user: click.user, reason })
          .catch(() => undefined);
        return 'ignored';
      };
      try {
        if (closed) return ignore('closed');
        if (!admins.has(click.user)) return ignore('not-admin');
        const entry = active.get(click.approvalId);
        if (entry === undefined) return ignore('not-pending');
        // Clicked on the first admin's card while the others are still being posted: wait for the card to open.
        // Real time, not the injectable clock: this is a wait, not a decision.
        const deadline = performance.now() + CLICK_WHILE_POSTING_WAIT_MS;
        while (entry.status === 'posting' && performance.now() < deadline && !closed) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (entry.status !== 'pending') return ignore('not-pending');
        const ownCard = entry.posts.some((p) => p.channel === click.channel && p.ts === click.messageTs);
        if (!ownCard) return ignore('wrong-card');
        await finish(
          entry,
          click.action === 'approve' ? { kind: 'approved', by: click.user } : { kind: 'denied', by: click.user },
        );
        return 'accepted';
      } catch (err) {
        log(`button click on approval ${click.approvalId} failed (${errorCode(err)})`);
        return 'ignored';
      }
    },

    async release(approvalId, reason) {
      try {
        const held = decided.get(approvalId);
        // Another identical request holds the same approval and may still use it.
        if (held !== undefined && held.holders > 1) {
          held.holders -= 1;
          return;
        }
        const released = await mutate((draft) => {
          const record = recordOf(draft, approvalId);
          if (record?.status !== 'approved') return null;
          const card = record.card;
          record.status = 'cancelled';
          record.reason = reason;
          delete record.card;
          return { posts: record.posts ?? [], card };
        });
        if (released === null) return;
        decided.delete(approvalId);
        await ledger.append({ event: 'approval.cancelled', approvalId, reason }).catch(() => undefined);
        const posts = held?.posts ?? released.posts;
        const reply = renderResultReply(RELEASE_LINES[reason]);
        const status = renderCardStatus(held?.card ?? released.card, { kind: 'cancelled' });
        void onCards(approvalId, async () => {
          for (const post of posts) {
            try {
              await slack.postMessage(post.channel, { ...reply, threadTs: post.ts });
            } catch (err) {
              await ledger
                .append({ event: 'approval.result-post-failed', approvalId, admin: post.admin, code: errorCode(err) })
                .catch(() => undefined);
            }
            try {
              await slack.updateMessage(post.channel, post.ts, status);
            } catch (err) {
              await ledger
                .append({ event: 'approval.card-update-failed', approvalId, admin: post.admin, code: errorCode(err) })
                .catch(() => undefined);
            }
          }
        });
      } catch (err) {
        log(`releasing approval ${approvalId} failed (${errorCode(err)}); close() cancels it at the latest`);
      }
    },

    close() {
      if (closing !== undefined) return closing;
      closed = true;
      wakeLoop?.();
      closing = (async () => {
        await sweeping?.catch(() => undefined);
        await Promise.allSettled([...postings]);
        for (const entry of [...active.values()]) await finish(entry, { kind: 'cancelled', reason: 'broker-closing' });
        // An approval being recorded right now is cancelled by finish itself (it sees `closed`).
        while (finishing.size > 0) await Promise.allSettled([...finishing]);
        const leftover = [...decided.entries()];
        decided.clear();
        if (leftover.length === 0) {
          while (inflight.size > 0) await Promise.allSettled([...inflight]);
          return;
        }
        const voided = await mutate((draft) => {
          const ids: string[] = [];
          for (const [approvalId] of leftover) {
            const record = draft.approvals[approvalId];
            if (record?.status !== 'approved') continue;
            record.status = 'cancelled';
            record.reason = 'broker-closing';
            delete record.card;
            ids.push(approvalId);
          }
          return ids;
        }).catch(() => [] as string[]);
        for (const [approvalId, { posts, card }] of leftover) {
          if (!voided.includes(approvalId)) continue;
          await ledger
            .append({ event: 'approval.cancelled', approvalId, reason: 'broker-closing' })
            .catch(() => undefined);
          updateCards(approvalId, posts, renderCardStatus(card, { kind: 'cancelled' }));
        }
        while (inflight.size > 0) await Promise.allSettled([...inflight]);
      })();
      return closing;
    },
  };
}
