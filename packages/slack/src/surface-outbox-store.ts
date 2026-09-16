import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup, type WarnFn } from '@soma/common/atomic-json';
import { DATA_DIR } from '@soma/common/env-paths';
import { Logger } from '@soma/common/logger';

/**
 * Durable delivery-intent store for the thread panel (A24a of
 * `.prd/slack-agent-ui` — "재시작 후 idempotent(중복 카드 없음)").
 *
 * The hazard it closes is an ack-before-persist window in the render path:
 * `thread-surface.ts:867` posts the panel message and `:873` writes the
 * returned `ts` to **memory only** (`panelState.messageTs = result?.ts`). A
 * process that dies in between has delivered a card it has no record of, so the
 * next render takes the `!panelState.messageTs` branch and posts a second one.
 * Nothing on disk can tell the two cases apart afterwards.
 *
 * The fix is ordering, not retries: the intent to post is committed to disk
 * *before* the post, so every crash leaves a `pending` record — which means
 * "unknown outcome", never "not posted". Three rules follow from that and are
 * the whole contract:
 *
 *  1. **Persist the intent before the side effect.** `beginPost` returns only
 *     after the record is durable.
 *  2. **An ambiguous outcome never authorises a repost.** A surviving `pending`
 *     record is handed back as-is; only an *absent* record or one the caller
 *     explicitly marked `rejected` mints a fresh intent.
 *  3. **A known `sent` record carries its exact `messageTs`**, so after a
 *     restart the surface updates the existing card instead of creating one.
 *
 * `sent` is not terminal, because the card can be deleted in Slack afterwards.
 * `markDeleted` is the single transition out of it, and it demands proof in the
 * shape of the exact `ts` the caller watched 404 — see its own doc.
 *
 * Deliberately out of scope: deciding what a pending record *means*. Resolving
 * it needs Slack-side knowledge (which errors are definitive rejections, what
 * `conversations.history` says), and that classification belongs to the caller
 * that owns the API client — this file would have to guess. There is no
 * reconciliation scan and no read-all accessor for the same reason: a sweeper
 * over every surface is exactly the component that would decide, on its own,
 * that a card was never posted.
 *
 * The atomic write / `.bak` fallback machinery is NOT reimplemented here — it
 * is `@soma/common/atomic-json` (`rules/config.md` §절대규칙 3–4), with the same
 * schema gate passed as `validatePrevious` so a corrupt live file can never be
 * promoted over a healthy backup.
 *
 * Not a singleton: each instance carries its own path, so tests and a future
 * second surface can hold independent stores without module-level state.
 */

/** File name under `DATA_DIR`. Exported so operators/runbooks can name it once. */
export const SURFACE_OUTBOX_STORE_FILENAME = 'surface-outbox.json';

/**
 * The only surface this store covers. The thread panel is a single-writer
 * message per session (`thread-surface.ts:832-878`), which is what makes "one
 * record per surface" a correct model; a second surface with different
 * multiplicity would need its own key space, not a reuse of this one.
 */
export const THREAD_PANEL_SURFACE = 'thread-panel';

const logger = new Logger('surface-outbox-store');

/** `<sessionKey>::thread-panel` — derived, never stored independently. */
export function threadPanelSurfaceKey(sessionKey: string): string {
  return `${sessionKey}::${THREAD_PANEL_SURFACE}`;
}

export type DeliveryIntentState = 'pending' | 'sent' | 'rejected';

/**
 * One delivery intent.
 *
 * Addressing only: no message text, no blocks, no tokens. The record exists to
 * answer "did I already post here, and where", and a copy of the payload would
 * turn a crash-recovery file into a second store of user content with its own
 * retention question.
 */
export interface DeliveryIntentRecord {
  /** `<sessionKey>::thread-panel`. */
  readonly surfaceKey: string;
  readonly sessionKey: string;
  readonly channelId: string;
  /** Absent for a top-level (non-threaded) surface. */
  readonly threadTs?: string;
  /** Identifies one attempt; a late ack naming a different one is refused. */
  readonly intentId: string;
  readonly state: DeliveryIntentState;
  /** Present exactly when `state === 'sent'`. */
  readonly messageTs?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The caller's rejection code. Present exactly when `state === 'rejected'`. */
  readonly reason?: string;
}

export interface SurfaceOutboxSnapshot {
  readonly version: 1;
  readonly records: DeliveryIntentRecord[];
}

/** Where a card would go. `sessionKey` determines the surface key. */
export interface SurfaceAddress {
  readonly sessionKey: string;
  readonly channelId: string;
  readonly threadTs?: string;
}

/**
 * What the caller is allowed to do next. Exhaustive on purpose: `begin` is the
 * only value that permits a `chat.postMessage`, so a caller that forgets a
 * branch fails to post rather than double-posting.
 */
export type BeginPostOutcome =
  /** No prior delivery. The pending intent is durable; post now, then ack. */
  | { readonly status: 'begin'; readonly record: DeliveryIntentRecord }
  /** A prior attempt's outcome is unknown. Do not post. Resolve it, then ack or reject. */
  | { readonly status: 'pending'; readonly record: DeliveryIntentRecord }
  /**
   * Already delivered. Update `record.messageTs` instead of posting.
   *
   * The record carries the address the card was posted to, which is not
   * necessarily the one just asked for. A `ts` is only meaningful together with
   * its channel, so the caller MUST compare `record.channelId`/`threadTs` with
   * its own before calling `chat.update`: updating a different channel with
   * this `ts` either 404s or edits an unrelated message. This store does not
   * resolve the mismatch — it cannot know whether the surface moved or the
   * caller is wrong.
   */
  | { readonly status: 'sent'; readonly record: DeliveryIntentRecord }
  /** State came from a backup generation, so absence proves nothing. Do not post. */
  | { readonly status: 'blocked'; readonly reason: string };

export interface SurfaceOutboxStoreOptions {
  /** Explicit file path. Defaults to `<DATA_DIR>/surface-outbox.json`. */
  path?: string;
  /** WARN sink for `.bak` fallbacks. Defaults to this module's logger. */
  warn?: WarnFn;
  /** Clock seam for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const INTENT_STATES: readonly DeliveryIntentState[] = ['pending', 'sent', 'rejected'];

function fail(where: string, why: string): never {
  throw new Error(`surface-outbox-store: ${where} ${why}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(where, 'is not an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(where, 'is not a non-empty string');
  return value as string;
}

function timestamp(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(where, 'is not a non-negative finite number');
  }
  return value as number;
}

/**
 * One record. Identity must be self-consistent and the state must carry exactly
 * the fields that state implies — a `sent` row without a `ts` cannot be used to
 * update anything, and a `pending` row carrying one means an ack half-landed.
 * Neither is repaired: this writer never produces them, so they are skew or
 * tampering, and guessing would either resurrect a wrong message id or hide a
 * delivered card.
 */
function validateRecord(value: unknown, where: string): { surfaceKey: string; intentId: string } {
  const entry = asRecord(value, where);
  const sessionKey = text(entry.sessionKey, `${where}.sessionKey`);
  const surfaceKey = text(entry.surfaceKey, `${where}.surfaceKey`);
  if (surfaceKey !== threadPanelSurfaceKey(sessionKey)) {
    fail(`${where}.surfaceKey`, 'is not "<sessionKey>::thread-panel"');
  }

  text(entry.channelId, `${where}.channelId`);
  if (entry.threadTs !== undefined) text(entry.threadTs, `${where}.threadTs`);
  const intentId = text(entry.intentId, `${where}.intentId`);

  const state = entry.state as DeliveryIntentState;
  if (!INTENT_STATES.includes(state)) fail(`${where}.state`, `is not one of ${INTENT_STATES.join('/')}`);

  if (state === 'sent') text(entry.messageTs, `${where}.messageTs`);
  else if (entry.messageTs !== undefined) fail(`${where}.messageTs`, `is set on a ${state} record`);

  if (state === 'rejected') text(entry.reason, `${where}.reason`);
  else if (entry.reason !== undefined) fail(`${where}.reason`, `is set on a ${state} record`);

  const createdAt = timestamp(entry.createdAt, `${where}.createdAt`);
  const updatedAt = timestamp(entry.updatedAt, `${where}.updatedAt`);
  if (updatedAt < createdAt) fail(`${where}.updatedAt`, 'is before createdAt');

  return { surfaceKey, intentId };
}

/**
 * Schema gate for persisted outbox state. Throws on anything unusable; returns
 * the input unchanged on success so no field is lost in translation.
 */
export function parseSurfaceOutboxSnapshot(raw: unknown): SurfaceOutboxSnapshot {
  const snapshot = asRecord(raw, 'snapshot');
  if (snapshot.version !== 1) fail('snapshot.version', 'is not 1');
  if (!Array.isArray(snapshot.records)) fail('snapshot.records', 'is not an array');

  const surfaceKeys = new Set<string>();
  const intentIds = new Set<string>();
  snapshot.records.forEach((entry, index) => {
    const parsed = validateRecord(entry, `snapshot.records[${index}]`);
    // Two rows for one surface means the single-writer invariant was already
    // broken on disk, and whichever row loses is a card nobody will ever update.
    if (surfaceKeys.has(parsed.surfaceKey)) {
      fail(`snapshot.records[${index}].surfaceKey`, `is a duplicate (${parsed.surfaceKey})`);
    }
    // One intent id on two surfaces makes acks ambiguous — the CAS below could
    // then apply a ts to the wrong thread.
    if (intentIds.has(parsed.intentId)) {
      fail(`snapshot.records[${index}].intentId`, `is a duplicate (${parsed.intentId})`);
    }
    surfaceKeys.add(parsed.surfaceKey);
    intentIds.add(parsed.intentId);
  });

  return snapshot as unknown as SurfaceOutboxSnapshot;
}

function isSurfaceOutboxSnapshot(raw: unknown): boolean {
  parseSurfaceOutboxSnapshot(raw);
  return true;
}

export class SurfaceOutboxStore {
  readonly path: string;
  private readonly warn: WarnFn;
  private readonly now: () => number;
  private records?: Map<string, DeliveryIntentRecord>;
  private lastLoadWarning?: string;

  constructor(options: SurfaceOutboxStoreOptions = {}) {
    this.path = options.path ?? path.join(DATA_DIR, SURFACE_OUTBOX_STORE_FILENAME);
    // Defaulted here rather than left undefined: `load()` wraps this sink to
    // capture the reason, and an unset sink would swallow the WARN that
    // `rules/config.md` §절대규칙 4 requires.
    this.warn = options.warn ?? ((message, detail) => logger.warn(message, detail));
    this.now = options.now ?? Date.now;
  }

  /**
   * Why the last `load()` did not return the newest state — `undefined` when it
   * did. Reset on every load, so a later healthy load clears it.
   */
  get recoveryWarning(): string | undefined {
    return this.lastLoadWarning;
  }

  /**
   * Read persisted state into memory.
   *
   * Explicit rather than done in the constructor: this reads a file and can
   * throw, and a constructor that throws (or silently starts empty) is the
   * failure mode `rules/config.md` §절대규칙 4 forbids. Until it has succeeded
   * every delivery method throws, so an unreadable store fails closed — it can
   * never answer "no record here, go ahead and post".
   *
   * `undefined` from the reader means a genuinely new store (live and `.bak`
   * both absent) and nothing else; both-unusable throws.
   *
   * Transactional in both directions, which matters on a *re*load: the store is
   * invalidated first and the records and the recovery warning are committed
   * together only after a successful read. Clearing the warning up front while
   * keeping the old records would lift a quarantine on a failed reload — the
   * store would resume minting fresh intents against a generation it can no
   * longer confirm. A failed load leaves the store closed, not stale.
   */
  load(): void {
    this.records = undefined;
    this.lastLoadWarning = undefined;

    let warning: string | undefined;
    const capture: WarnFn = (message, detail) => {
      warning = message;
      this.warn(message, detail);
    };

    const snapshot = readJsonWithBackup(this.path, parseSurfaceOutboxSnapshot, { warn: capture });
    const restored = new Map<string, DeliveryIntentRecord>();
    for (const entry of snapshot?.records ?? []) {
      restored.set(entry.surfaceKey, Object.freeze({ ...entry }));
    }

    this.lastLoadWarning = warning;
    this.records = restored;
  }

  /**
   * The record for a surface, or `undefined` if there is none.
   *
   * Always allowed, including under a recovery quarantine: a record that is
   * present can only *prevent* a post (it names a card that already exists),
   * never cause one.
   */
  get(surfaceKey: string): DeliveryIntentRecord | undefined {
    return this.requireLoaded('get').get(surfaceKey);
  }

  /**
   * Claim the right to post to a surface, committing the intent first.
   *
   * The caller must post only on `begin`. `pending` and `sent` hand back the
   * existing record instead of minting a second intent — that substitution is
   * what makes a restart idempotent.
   */
  beginPost(address: SurfaceAddress): BeginPostOutcome {
    const records = this.requireLoaded('beginPost');
    const surfaceKey = threadPanelSurfaceKey(address.sessionKey);
    const existing = records.get(surfaceKey);

    // The stored address wins over the caller's: it describes the message that
    // was actually posted. Reconciling a moved surface is not this unit's job —
    // the caller compares the returned address with its own (see `sent` above).
    if (existing?.state === 'sent') return { status: 'sent', record: existing };
    if (existing?.state === 'pending') return { status: 'pending', record: existing };

    // Only the mint path is quarantined. After a `.bak` fallback the state is a
    // previous generation, so "no record" and "rejected" have both lost their
    // meaning: the newest intent may simply have been in the lost generation,
    // already posted. The block is global rather than scoped to the keys in the
    // rolled-back file, because the dropped records are precisely the ones we
    // cannot enumerate.
    if (this.lastLoadWarning) {
      return {
        status: 'blocked',
        reason:
          'surface-outbox-store: refusing a new delivery — state was restored from a backup generation ' +
          `(${this.lastLoadWarning})`,
      };
    }

    const at = this.now();
    const created: DeliveryIntentRecord = {
      surfaceKey,
      sessionKey: address.sessionKey,
      channelId: address.channelId,
      ...(address.threadTs === undefined ? {} : { threadTs: address.threadTs }),
      intentId: randomUUID(),
      state: 'pending',
      createdAt: at,
      updatedAt: at,
    };

    return { status: 'begin', record: this.commit(records, created) };
  }

  /**
   * Record that Slack accepted the post, with the `ts` it returned.
   *
   * CAS on `intentId` + `pending`: a late ack from a turn that already lost
   * (A28) must not repoint the surface at a different message. A mismatch
   * throws rather than returning a flag — it is a protocol violation by the
   * caller, and the safe default for an unexpected ack is to keep the record
   * ambiguous, not to overwrite it.
   */
  markSent(surfaceKey: string, intentId: string, messageTs: string): DeliveryIntentRecord {
    const records = this.requireLoaded('markSent');
    const current = this.requireIntent(records, surfaceKey, intentId, 'markSent', 'pending');
    const next: DeliveryIntentRecord = {
      ...current,
      state: 'sent',
      messageTs: text(messageTs, 'markSent messageTs'),
      updatedAt: this.now(),
    };

    return this.commit(records, next);
  }

  /**
   * Record that the delivery definitively did NOT happen, releasing the surface
   * for a fresh intent.
   *
   * `code` is the caller's classification (it owns the Slack error taxonomy);
   * this store only demands that *something* explicit was decided, because
   * `rejected` is the one state that re-authorises a post.
   */
  markRejected(surfaceKey: string, intentId: string, code: string): DeliveryIntentRecord {
    const records = this.requireLoaded('markRejected');
    const current = this.requireIntent(records, surfaceKey, intentId, 'markRejected', 'pending');
    const next: DeliveryIntentRecord = {
      ...current,
      state: 'rejected',
      messageTs: undefined,
      reason: text(code, 'markRejected code'),
      updatedAt: this.now(),
    };

    return this.commit(records, next);
  }

  /**
   * Record that a card this store believed delivered is GONE from Slack,
   * releasing the surface for a fresh intent.
   *
   * The state that needs this is exactly the one `markRejected` refuses: a
   * `sent` record whose `messageTs` now 404s on `chat.update`. Without a
   * transition out of it the caller clears its in-memory ts, re-enters the post
   * branch, and `beginPost` hands the same dead ts straight back — a loop on a
   * message that no longer exists.
   *
   * The CAS is one field tighter than {@link markSent}'s: the caller must name
   * the `messageTs` it watched fail, not just the intent. A 404 about any other
   * ts is evidence about some other message, and acting on it would discard the
   * address of a card that is still in the thread. Mismatches throw, like every
   * other protocol violation here.
   *
   * `reason` is fixed rather than caller-supplied: this transition means one
   * specific thing, and a free-text code would let it stand in for the generic
   * rejection path it deliberately does not duplicate.
   *
   * Allowed under a `.bak` quarantine, unlike a mint: removing an address can
   * only ever *prevent* a post. The re-mint it enables stays blocked by
   * `beginPost`'s own rule, which is where that decision belongs.
   */
  markDeleted(surfaceKey: string, intentId: string, observedMessageTs: string): DeliveryIntentRecord {
    const records = this.requireLoaded('markDeleted');
    const current = this.requireIntent(records, surfaceKey, intentId, 'markDeleted', 'sent');
    const observed = text(observedMessageTs, 'markDeleted observedMessageTs');
    if (current.messageTs !== observed) {
      throw new Error(
        `surface-outbox-store: markDeleted names a message ts (${observed}) that ${surfaceKey} does not hold; ` +
          `it is on ${current.messageTs}`,
      );
    }

    const next: DeliveryIntentRecord = {
      ...current,
      state: 'rejected',
      messageTs: undefined,
      reason: 'message_not_found',
      updatedAt: this.now(),
    };

    return this.commit(records, next);
  }

  private requireLoaded(operation: string): Map<string, DeliveryIntentRecord> {
    if (!this.records) {
      throw new Error(`surface-outbox-store: ${operation} called before a successful load()`);
    }
    return this.records;
  }

  /**
   * The record this call claims to be about, or a throw naming why not.
   *
   * `expected` is the state the transition is defined on — `pending` for an
   * ack/rejection, `sent` for an observed deletion — so every caller states its
   * precondition instead of inheriting one.
   */
  private requireIntent(
    records: Map<string, DeliveryIntentRecord>,
    surfaceKey: string,
    intentId: string,
    operation: string,
    expected: DeliveryIntentState,
  ): DeliveryIntentRecord {
    const current = records.get(surfaceKey);
    if (!current) throw new Error(`surface-outbox-store: ${operation} has no record for ${surfaceKey}`);
    if (current.intentId !== intentId) {
      throw new Error(
        `surface-outbox-store: ${operation} names a stale intent (${intentId}); ` +
          `${surfaceKey} is on ${current.intentId}`,
      );
    }
    if (current.state !== expected) {
      throw new Error(
        `surface-outbox-store: ${operation} requires a ${expected} intent; ${surfaceKey} is ${current.state}`,
      );
    }
    return current;
  }

  /**
   * Persist first, swap memory second.
   *
   * The write is validated with the same gate that reads it, so the store can
   * never commit a file it would later refuse to load. If anything throws —
   * serialization, a read-only directory, a rejected schema — the in-memory map
   * is still the pre-call one, so a caller that saw a throw has genuinely not
   * claimed an intent and has nothing to undo.
   */
  private commit(records: Map<string, DeliveryIntentRecord>, changed: DeliveryIntentRecord): DeliveryIntentRecord {
    // `undefined`-valued keys (a cleared messageTs) are dropped by JSON, so
    // they are dropped here too: what the caller gets back is byte-for-byte
    // what a reload will yield, and frozen so it cannot drift from disk.
    const stored = Object.freeze(JSON.parse(JSON.stringify(changed)) as DeliveryIntentRecord);
    const next = new Map(records);
    next.set(stored.surfaceKey, stored);

    const snapshot: SurfaceOutboxSnapshot = { version: 1, records: [...next.values()] };
    parseSurfaceOutboxSnapshot(snapshot);
    atomicWriteJson(this.path, snapshot, { validatePrevious: isSurfaceOutboxSnapshot, warn: this.warn });

    this.records = next;
    return stored;
  }
}
