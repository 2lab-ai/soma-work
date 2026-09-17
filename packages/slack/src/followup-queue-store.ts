import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup, type WarnFn } from '@soma/common/atomic-json';
import { DATA_DIR } from '@soma/common/env-paths';
import { Logger } from '@soma/common/logger';
import type { FollowupItemState, FollowupQueueSnapshot } from './followup-queue';

/**
 * Durable store for the follow-up queue (U2 of `.prd/slack-agent-ui`).
 *
 * This is the only place the queue's 10 states touch the disk. It owns exactly
 * two responsibilities and deliberately no more:
 *
 *  1. **Path** — `<DATA_DIR>/followup-queue.json`, with `DATA_DIR` taken from
 *     the single resolver (`rules/config.md` §절대규칙 2). No second path logic.
 *  2. **Trust boundary** — everything read back is *untrusted JSON*: a file a
 *     crash truncated, an operator hand-edited, or an older schema wrote. It is
 *     validated in full and **rejected**, never silently repaired. A queue that
 *     quietly drops a malformed item is indistinguishable, to the user, from
 *     "my message vanished" (A1/A16).
 *
 * The atomic write / `.bak` fallback machinery is NOT reimplemented here — it
 * is `@soma/common/atomic-json` (`rules/config.md` §절대규칙 3–4). The same
 * schema gate is passed to `atomicWriteJson` as `validatePrevious`, so a
 * corrupt live file can never be promoted over a healthy backup.
 *
 * Explicitly out of scope: recovery. `load()` returns what the file says, with
 * `dispatched` still `dispatched`. Turning that into `paused`/`uncertain` is
 * `FollowupQueue.recover()`, an explicit call the host makes after restore —
 * the loader must not decide on its own that a turn died (A21).
 *
 * Not a singleton: each instance carries its own path, so tests and a future
 * second surface can hold independent stores without module-level state.
 */

/** File name under `DATA_DIR`. Exported so operators/runbooks can name it once. */
export const FOLLOWUP_QUEUE_STORE_FILENAME = 'followup-queue.json';

const logger = new Logger('followup-queue-store');

export interface FollowupQueueStoreOptions {
  /** Explicit file path. Defaults to `<DATA_DIR>/followup-queue.json`. */
  path?: string;
  /** WARN sink for `.bak` fallbacks. Defaults to this module's logger. */
  warn?: WarnFn;
}

const ITEM_STATES: readonly FollowupItemState[] = [
  'queued',
  // Auto-steering (06 §3.1): pushed into the running turn's SDK input channel.
  // Several items may hold it at once — unlike `reserved`/`claimed` it is not a
  // dispatch of ours, so there is no single-winner ceiling to enforce here.
  'steered',
  'reserved',
  'claimed',
  'dispatched',
  'resolved',
  'failed',
  'uncertain',
  'paused',
  'cancelled',
];

/** At most one item per session may be setting up a dispatch (single winner, A12). */
const PENDING_DISPATCH_STATES: readonly FollowupItemState[] = ['reserved', 'claimed'];

function fail(where: string, why: string): never {
  throw new Error(`followup-queue-store: ${where} ${why}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(where, 'is not an object');
  return value as Record<string, unknown>;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, 'is not an array');
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(where, 'is not a non-empty string');
  return value;
}

/** Optional fields are checked when present and left untouched when absent. */
function optionalText(value: unknown, where: string): void {
  if (value !== undefined && typeof value !== 'string') fail(where, 'is not a string');
}

function optionalBool(value: unknown, where: string): void {
  if (value !== undefined && typeof value !== 'boolean') fail(where, 'is not a boolean');
}

function integer(value: unknown, where: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(where, `is not a safe integer >= ${min}`);
  }
  return value as number;
}

function timestamp(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    fail(where, 'is not a non-negative finite number');
}

function number(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, 'is not a finite number');
}

/**
 * Validate the stored Slack payload.
 *
 * The object is checked, never rebuilt: unknown/newer optional fields
 * (`routeContext`, `team`, `modelOverride`, …) must survive a round-trip
 * verbatim, because the message is replayed to the model as the user wrote it
 * (A14/A30). Stripping an unrecognised field here would silently rewrite the
 * user's turn.
 */
function validateMessage(value: unknown, where: string): { channel: string; ts: string } {
  const message = record(value, where);
  text(message.user, `${where}.user`);
  const channel = text(message.channel, `${where}.channel`);
  const ts = text(message.ts, `${where}.ts`);

  for (const field of ['team', 'thread_ts', 'text', 'inlineDirectiveRawText', 'modelOverride']) {
    optionalText(message[field], `${where}.${field}`);
  }
  for (const field of ['synthetic', 'skipDispatch']) {
    optionalBool(message[field], `${where}.${field}`);
  }

  if (message.routeContext !== undefined) {
    const route = record(message.routeContext, `${where}.routeContext`);
    for (const field of ['sourceChannel', 'sourceThreadTs']) {
      optionalText(route[field], `${where}.routeContext.${field}`);
    }
    for (const field of ['skipAutoBotThread', 'compactRedispatch', 'goalContinuation']) {
      optionalBool(route[field], `${where}.routeContext.${field}`);
    }
  }

  if (message.files !== undefined) {
    array(message.files, `${where}.files`).forEach((entry, index) => {
      const file = record(entry, `${where}.files[${index}]`);
      for (const field of ['id', 'name', 'mimetype', 'filetype', 'url_private', 'url_private_download']) {
        text(file[field], `${where}.files[${index}].${field}`);
      }
      number(file.size, `${where}.files[${index}].size`);
    });
  }

  return { channel, ts };
}

/** One item. Identity must be self-consistent — a mismatch means tampered/skewed state, not a repair job. */
function validateItem(
  value: unknown,
  sessionKey: string,
  where: string,
): { id: string; seq: number; eventKey: string; state: FollowupItemState } {
  const item = record(value, where);
  const id = text(item.id, `${where}.id`);
  const seq = integer(item.seq, `${where}.seq`, 1);
  integer(item.epoch, `${where}.epoch`, 0);

  if (item.sessionKey !== sessionKey) fail(`${where}.sessionKey`, `does not match its session (${sessionKey})`);
  if (id !== `${sessionKey}#${seq}`) fail(`${where}.id`, `is not "<sessionKey>#<seq>" (${sessionKey}#${seq})`);

  const state = item.state as FollowupItemState;
  if (!ITEM_STATES.includes(state)) fail(`${where}.state`, `is not one of ${ITEM_STATES.join('/')}`);

  const eventKey = text(item.eventKey, `${where}.eventKey`);
  const message = validateMessage(item.message, `${where}.message`);
  if (eventKey !== `${message.channel}:${message.ts}`) {
    fail(`${where}.eventKey`, 'does not match its message channel:ts');
  }

  const context = record(item.context, `${where}.context`);
  optionalText(context.workingDirectory, `${where}.context.workingDirectory`);

  timestamp(item.enqueuedAt, `${where}.enqueuedAt`);
  timestamp(item.updatedAt, `${where}.updatedAt`);
  optionalText(item.stateReason, `${where}.stateReason`);
  // The SDK handle a `steered` item was pushed under. Only its type is checked:
  // whether it is still meaningful is a question about a process that no longer
  // exists, and `FollowupQueue.recover()` — not the loader — decides that (A21).
  optionalText(item.steerUuid, `${where}.steerUuid`);

  return { id, seq, eventKey, state };
}

function validateSession(value: unknown, where: string): string {
  const session = record(value, where);
  const sessionKey = text(session.sessionKey, `${where}.sessionKey`);
  const nextSeq = integer(session.nextSeq, `${where}.nextSeq`, 1);

  if (session.freeze !== undefined) {
    const freeze = record(session.freeze, `${where}.freeze`);
    text(freeze.reason, `${where}.freeze.reason`);
    timestamp(freeze.at, `${where}.freeze.at`);
  }

  // Required, not optional. `FollowupQueue`'s own constructor rejects a restored
  // session whose turnEpoch is not a non-negative integer
  // (`followup-queue.ts:221-223`) and `ensureSession` always writes one
  // (`:576`), so accepting a file without it would hand the queue a snapshot it
  // refuses. The format has never shipped — there is no legacy generation to
  // migrate, and defaulting a missing value to 0 would silently mint a turn
  // generation that makes stale button clicks look current (A12/A28).
  integer(session.turnEpoch, `${where}.turnEpoch`, 0);

  const ids = new Set<string>();
  const seqs = new Set<number>();
  const eventKeys = new Set<string>();
  let maxSeq = 0;
  let pendingDispatch = 0;
  let dispatched = 0;

  array(session.items, `${where}.items`).forEach((entry, index) => {
    const item = validateItem(entry, sessionKey, `${where}.items[${index}]`);
    if (ids.has(item.id)) fail(`${where}.items[${index}].id`, `is a duplicate (${item.id})`);
    if (seqs.has(item.seq)) fail(`${where}.items[${index}].seq`, `is a duplicate (${item.seq})`);
    // Two rows for one Slack event means the dedup key (A3) was already broken
    // on disk — running both is exactly the double-answer this queue prevents.
    if (eventKeys.has(item.eventKey)) fail(`${where}.items[${index}].eventKey`, `is a duplicate (${item.eventKey})`);
    ids.add(item.id);
    seqs.add(item.seq);
    eventKeys.add(item.eventKey);
    maxSeq = Math.max(maxSeq, item.seq);
    if (PENDING_DISPATCH_STATES.includes(item.state)) pendingDispatch += 1;
    if (item.state === 'dispatched') dispatched += 1;
  });

  // A reused nextSeq would hand a later enqueue an id that already exists.
  if (nextSeq <= maxSeq) fail(`${where}.nextSeq`, `(${nextSeq}) collides with an existing seq (max ${maxSeq})`);
  // `dispatched` + `reserved` is legal (Send now reserves while a turn runs);
  // two items *setting up* a dispatch is not — that is two winners.
  if (pendingDispatch > 1) fail(`${where}.items`, `has ${pendingDispatch} items in reserved/claimed (max 1)`);
  // One in-flight turn per session, enforced by `markDispatched`. Two on disk is
  // skew or tampering, and replaying both is the double-answer A3 exists to stop.
  if (dispatched > 1) fail(`${where}.items`, `has ${dispatched} items in dispatched (max 1)`);

  return sessionKey;
}

/**
 * Schema gate for persisted queue state. Throws on anything unusable; returns
 * the input unchanged on success so no field is lost in translation.
 */
export function parseFollowupQueueSnapshot(raw: unknown): FollowupQueueSnapshot {
  const snapshot = record(raw, 'snapshot');
  if (snapshot.version !== 1) fail('snapshot.version', 'is not 1');

  const keys = new Set<string>();
  array(snapshot.sessions, 'snapshot.sessions').forEach((entry, index) => {
    const sessionKey = validateSession(entry, `snapshot.sessions[${index}]`);
    if (keys.has(sessionKey)) fail(`snapshot.sessions[${index}].sessionKey`, `is a duplicate (${sessionKey})`);
    keys.add(sessionKey);
  });

  return snapshot as unknown as FollowupQueueSnapshot;
}

function isFollowupQueueSnapshot(raw: unknown): boolean {
  parseFollowupQueueSnapshot(raw);
  return true;
}

export class FollowupQueueStore {
  readonly path: string;
  private readonly warn: WarnFn;
  private lastLoadWarning?: string;

  constructor(options: FollowupQueueStoreOptions = {}) {
    this.path = options.path ?? path.join(DATA_DIR, FOLLOWUP_QUEUE_STORE_FILENAME);
    // Defaulted here rather than left undefined: `load()` wraps this sink to
    // capture the reason, and an unset sink would swallow the WARN that
    // `rules/config.md` §절대규칙 4 requires.
    this.warn = options.warn ?? ((message, detail) => logger.warn(message, detail));
  }

  /**
   * Why the last `load()` did not return the newest state — `undefined` when it
   * did.
   *
   * A `.bak` fallback is a *generation rollback*: the backup is by contract the
   * state before the last committed write, so the most recent enqueue is gone.
   * The user was already shown a `Queue` receipt for it, so "the queue is
   * smaller than you remember" needs a reason the host can render (A16), not
   * just a server log line. Scoped to `load()` and reset on every call, so a
   * later healthy load clears it.
   */
  get recoveryWarning(): string | undefined {
    return this.lastLoadWarning;
  }

  /**
   * Read persisted state.
   *
   * `undefined` means "genuinely new store" (live and `.bak` both absent) and
   * nothing else: an unreadable or schema-broken file falls back to `.bak` with
   * a WARN, and throws if that is unusable too. The caller passes the result
   * straight to `new FollowupQueue({ snapshot })` and then calls `recover()`
   * itself — no state transition happens in here.
   */
  load(): FollowupQueueSnapshot | undefined {
    this.lastLoadWarning = undefined;
    const capture: WarnFn = (message, detail) => {
      this.lastLoadWarning = message;
      this.warn(message, detail);
    };
    return readJsonWithBackup(this.path, parseFollowupQueueSnapshot, { warn: capture });
  }

  /**
   * Persist the committed snapshot. Validated first, so the queue can never
   * write a file it would later refuse to read; then written atomically with
   * the same gate guarding the `.bak` promotion.
   *
   * Synchronous and throwing on purpose: this is the `save` sink of
   * `FollowupQueue`, whose transaction is "durable first, memory second". A
   * throw here must abort the caller's state change.
   */
  save(snapshot: FollowupQueueSnapshot): void {
    parseFollowupQueueSnapshot(snapshot);
    atomicWriteJson(this.path, snapshot, { validatePrevious: isFollowupQueueSnapshot, warn: this.warn });
  }
}
