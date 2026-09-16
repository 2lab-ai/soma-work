import type { MessageEvent } from './pipeline/types';

/**
 * Follow-up message queue — pure domain + state machine (U1 of `.prd/slack-agent-ui`).
 *
 * Why this exists: a user message that arrives while a turn is running must
 * neither be answered-and-consumed by the harness nor abort the live request.
 * It is parked here, shown as `Queue`, and dispatched later — either by the
 * drain at the next safe turn boundary (U4) or by an explicit `Send now`
 * reservation (U6). See `.prd/slack-agent-ui/ssot.md` §3.1–§3.5.
 *
 * Scope discipline (U1): NO Slack, network, env or filesystem access lives in
 * this file. Durability is an injected synchronous `save(snapshot)` boundary
 * that U2 implements on top of the repo's atomic temp+rename store pattern
 * (`packages/process-shared/src/mcp-tool-grant-store.ts:121`, `rules/config.md` §3).
 * Persistence is committed BEFORE memory: `save` throwing leaves the queue
 * exactly as it was, so the UI receipt can never claim an item the disk lost.
 *
 * There is no timer, no auto-drain and no auto-replay in here. Every state
 * change is an explicit call from a caller that owns the execution boundary.
 */

/** Default per-session cap on pending (non-terminal) items. Overflow is rejected visibly (A15). */
export const FOLLOWUP_QUEUE_DEFAULT_CAPACITY = 100;

export type FollowupItemState =
  | 'queued'
  | 'reserved'
  | 'claimed'
  | 'dispatched'
  | 'resolved'
  | 'failed'
  | 'uncertain'
  | 'paused'
  | 'cancelled';

/**
 * Execution context captured at enqueue time and replayed verbatim at dispatch.
 * The clicker of `Send now` is an authorization subject only — no field is
 * ever rewritten with the clicker's values (A30).
 */
export interface FollowupContext {
  /** Resolved working directory of the enqueueing turn, when the caller has one. */
  workingDirectory?: string;
}

export interface FollowupItem {
  /** Deterministic, stable across restarts: `<sessionKey>#<seq>`. */
  id: string;
  sessionKey: string;
  /** Monotone per session; survives rollback/retry so FIFO position is never lost. */
  seq: number;
  /**
   * Per-ITEM CAS version, bumped on every committed state change of this item.
   * Two tokens exist on purpose and they answer different questions:
   *   - `item.epoch`      — "is my view of THIS item current?" (lost-update guard)
   *   - `session.turnEpoch` — "is my button/write from the CURRENT turn generation?"
   *     (`ssot.md:116-120`, A12/A28)
   * A caller holding a button passes both; neither one substitutes for the other.
   */
  epoch: number;
  state: FollowupItemState;
  /** Slack event identity (`<channel>:<ts>`) — the dedup key for redelivery (A3). */
  eventKey: string;
  /** The original Slack payload, stored unmodified (text/files/author) (A14/A30). */
  message: MessageEvent;
  context: FollowupContext;
  enqueuedAt: number;
  updatedAt: number;
  /**
   * Why the item sits in its current state. A denied dispatch is
   * `state: 'queued'` + a reason (item stays in the queue, A13/A29); a freeze
   * is `state: 'paused'` and only an explicit resume clears it. The two are
   * never collapsed into one label.
   */
  stateReason?: string;
}

export interface FollowupSessionSnapshot {
  sessionKey: string;
  nextSeq: number;
  /**
   * Turn-generation counter of the session (`ssot.md:116-120`). Advanced by
   * `beginTurn` at the start of EVERY dispatch — including a plain user message
   * that never touched the queue — and stamped into button payloads so a click
   * from an older generation is rejected as stale. This is NOT `item.epoch`:
   * see the two-token note on `FollowupItem.epoch`.
   */
  turnEpoch: number;
  /** Present while the session is frozen (stop / session end / restart). Blocks drain. */
  freeze?: { reason: string; at: number };
  items: FollowupItem[];
}

/** Plain JSON — this is exactly what U2 writes to disk. */
export interface FollowupQueueSnapshot {
  version: 1;
  sessions: FollowupSessionSnapshot[];
}

export type FollowupEnqueueResult =
  | { status: 'queued'; item: FollowupItem }
  | { status: 'duplicate'; item: FollowupItem }
  | { status: 'capacity'; capacity: number; pending: number };

/**
 * `stale-epoch` = the caller's view of the item is outdated; `stale-turn` = the
 * caller's button belongs to an earlier turn generation (`ssot.md:116-120`).
 * They are separate codes because the UI message differs: the first is a
 * lost race on one item, the second is a stale surface. `empty` is claim-only.
 * `busy` means another dispatch is already in flight for the session (single
 * winner). `frozen` means the session awaits an explicit resume. `capacity` is
 * the same visible ceiling `enqueue` enforces, reported from `retry`.
 */
export type FollowupOpFailure =
  | 'not-found'
  | 'stale-epoch'
  | 'stale-turn'
  | 'invalid-state'
  | 'busy'
  | 'frozen'
  | 'empty'
  | 'capacity';

export type FollowupOpResult = { ok: true; item: FollowupItem } | { ok: false; reason: FollowupOpFailure };

export interface FollowupQueueOptions {
  capacity?: number;
  /**
   * Durable sink for the about-to-be-committed snapshot. Synchronous on
   * purpose: the whole state machine is an in-process transaction, so there
   * is no await between check and commit and no mutex is needed. Throwing
   * aborts the transaction.
   */
  save?: (snapshot: FollowupQueueSnapshot) => void;
  /** Previously persisted state. Call `recover()` after restoring across a restart. */
  snapshot?: FollowupQueueSnapshot;
}

/**
 * Terminal = no longer occupies capacity and is NOT touched by session
 * cancellation. `ssot.md:157` enumerates exactly which states deletion cancels
 * (`queued`/`reserved`/`claimed`/`dispatched`/`paused`/`uncertain`) — `failed`
 * is deliberately absent, so a confirmed failure keeps its own reason as
 * history and never blocks new messages. `retry` (`ssot.md:150`) is its only
 * non-terminal exit.
 */
const TERMINAL_STATES: readonly FollowupItemState[] = ['resolved', 'failed', 'cancelled'];
/** A dispatch is being set up — blocks a competing `Send now` reservation. */
const PENDING_DISPATCH_STATES: readonly FollowupItemState[] = ['reserved', 'claimed'];
/** Anything the executor may still be running — blocks a drain claim. */
const IN_FLIGHT_STATES: readonly FollowupItemState[] = ['reserved', 'claimed', 'dispatched'];

/** States rewritten when a session is frozen; anything absent is left untouched. */
type FreezeTransitions = Partial<Record<FollowupItemState, FollowupItemState>>;

/**
 * stop / session end (`ssot.md:128-129`): a live process witnesses the event,
 * so an un-started `claimed` item is provably un-started → `paused`. Only the
 * item that was really executing is `uncertain`.
 */
const STOP_TRANSITIONS: FreezeTransitions = {
  queued: 'paused',
  reserved: 'paused',
  claimed: 'paused',
  dispatched: 'uncertain',
};

/**
 * restart (`ssot.md:124`): nobody witnessed the crash, so `claimed` may already
 * have produced a query. `claimed` and `dispatched` both come back `uncertain`
 * — never blind-replayed.
 */
const RESTART_TRANSITIONS: FreezeTransitions = {
  queued: 'paused',
  reserved: 'paused',
  claimed: 'uncertain',
  dispatched: 'uncertain',
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Items currently occupying a capacity slot. Single definition on purpose:
 * `enqueue` and `retry` are the only two doors into `queued`, so they must
 * count the ceiling identically — a second, slightly different tally is how a
 * terminal item ends up charged twice or not at all.
 */
function pendingCount(session: FollowupSessionSnapshot): number {
  return session.items.filter((item) => !TERMINAL_STATES.includes(item.state)).length;
}

/**
 * Identity invariants this module OWNS, checked once at load — it mints the
 * ids, so nobody else can guarantee they stay unique. Deliberately narrow: U2
 * validates the disk schema, this only rejects a snapshot that would make the
 * id/sequence space ambiguous (a lagging `nextSeq` mints a duplicate id, and
 * then every op silently hits the wrong item — the wrong person's message runs).
 *
 * Fail closed, never silently repaired: `rules/config.md:11` and `ssot.md:139-141`
 * both say a bad load must surface, not be quietly normalized away.
 */
function assertLoadableSnapshot(snapshot: FollowupQueueSnapshot): void {
  if (snapshot.version !== 1) {
    throw new Error(`FollowupQueue: unsupported snapshot version ${String(snapshot.version)} (expected 1)`);
  }
  const seenSessions = new Set<string>();
  for (const session of snapshot.sessions) {
    if (seenSessions.has(session.sessionKey)) {
      throw new Error(`FollowupQueue: duplicate session key ${session.sessionKey}`);
    }
    seenSessions.add(session.sessionKey);

    const ids = new Set<string>();
    const seqs = new Set<number>();
    let maxSeq = 0;
    for (const item of session.items) {
      if (ids.has(item.id)) throw new Error(`FollowupQueue: duplicate item id ${item.id}`);
      if (seqs.has(item.seq)) {
        throw new Error(`FollowupQueue: duplicate item seq ${item.seq} in ${session.sessionKey}`);
      }
      ids.add(item.id);
      seqs.add(item.seq);
      maxSeq = Math.max(maxSeq, item.seq);
    }
    if (!Number.isSafeInteger(session.nextSeq) || session.nextSeq <= maxSeq) {
      throw new Error(
        `FollowupQueue: nextSeq ${String(session.nextSeq)} is behind max seq ${maxSeq} in ${session.sessionKey}`,
      );
    }
    if (!Number.isSafeInteger(session.turnEpoch) || session.turnEpoch < 0) {
      throw new Error(`FollowupQueue: invalid turnEpoch ${String(session.turnEpoch)} in ${session.sessionKey}`);
    }
  }
}

export class FollowupQueue {
  readonly capacity: number;
  private readonly persist?: (snapshot: FollowupQueueSnapshot) => void;
  private state: FollowupQueueSnapshot;

  constructor(options: FollowupQueueOptions = {}) {
    const capacity = options.capacity ?? FOLLOWUP_QUEUE_DEFAULT_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error(`FollowupQueue: capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.capacity = capacity;
    this.persist = options.save;
    if (options.snapshot) assertLoadableSnapshot(options.snapshot);
    this.state = options.snapshot ? cloneJson(options.snapshot) : { version: 1, sessions: [] };
  }

  /**
   * Current turn generation of the session (0 before the first dispatch).
   * Stamp it into every `Send now` button payload and into any deferred
   * surface write; compare on arrival to drop stale ones (A12/A28).
   */
  getTurnEpoch(sessionKey: string): number {
    return this.findSession(this.state, sessionKey)?.turnEpoch ?? 0;
  }

  /**
   * Open a new turn generation and persist it BEFORE the dispatch starts.
   * The host calls this for EVERY dispatch — drained item, `Send now`
   * promotion, and an ordinary user message that never entered the queue —
   * because a turn generation is a property of the session, not of an item.
   * Sole mutator of `turnEpoch`: no other method advances it, so a host that
   * already called `beginTurn` can never be double-incremented by
   * `markDispatched`.
   */
  beginTurn(sessionKey: string): number {
    const next = cloneJson(this.state);
    const session = this.ensureSession(next, sessionKey);
    session.turnEpoch += 1;
    this.commit(next);
    return session.turnEpoch;
  }

  /**
   * Park a follow-up message. Callers decide WHETHER to enqueue (the queue only
   * intervenes while a turn is running, A26) — this method only decides how the
   * item lands: accepted, deduped, or visibly rejected for capacity.
   */
  enqueue(sessionKey: string, message: MessageEvent, context: FollowupContext = {}): FollowupEnqueueResult {
    const eventKey = `${message.channel}:${message.ts}`;
    const existing = this.findSession(this.state, sessionKey);

    // History (resolved/cancelled included) is kept so a Slack redelivery after
    // the item was already handled still dedups instead of running twice.
    const duplicate = existing?.items.find((item) => item.eventKey === eventKey);
    if (duplicate) return { status: 'duplicate', item: cloneJson(duplicate) };

    const pending = existing ? pendingCount(existing) : 0;
    if (pending >= this.capacity) return { status: 'capacity', capacity: this.capacity, pending };

    const next = cloneJson(this.state);
    const session = this.ensureSession(next, sessionKey);
    const seq = session.nextSeq;
    session.nextSeq = seq + 1;
    const now = Date.now();
    const item: FollowupItem = {
      id: `${sessionKey}#${seq}`,
      sessionKey,
      seq,
      epoch: 0,
      state: 'queued',
      eventKey,
      message: cloneJson(message),
      context: cloneJson(context),
      enqueuedAt: now,
      updatedAt: now,
    };
    session.items.push(item);
    this.commit(next);
    return { status: 'queued', item: cloneJson(item) };
  }

  /** Items in arrival order. Defensive clone — callers cannot reach queue state. */
  list(sessionKey: string): FollowupItem[] {
    const session = this.findSession(this.state, sessionKey);
    return session ? cloneJson(session.items) : [];
  }

  get(sessionKey: string, itemId: string): FollowupItem | undefined {
    const item = this.findSession(this.state, sessionKey)?.items.find((candidate) => candidate.id === itemId);
    return item ? cloneJson(item) : undefined;
  }

  /** Full persistable state (defensive clone). */
  snapshot(): FollowupQueueSnapshot {
    return cloneJson(this.state);
  }

  /** Why the session is frozen, for the UI to show alongside the paused items (A17). */
  freezeReason(sessionKey: string): string | undefined {
    return this.findSession(this.state, sessionKey)?.freeze?.reason;
  }

  /**
   * FIFO claim of one item, called by the drain at a safe turn boundary (U4).
   * Never called from inside this module — the domain does not start work.
   */
  claimNext(sessionKey: string): FollowupOpResult {
    const next = cloneJson(this.state);
    const session = this.findSession(next, sessionKey);
    if (!session) return { ok: false, reason: 'empty' };
    if (session.freeze) return { ok: false, reason: 'frozen' };
    if (session.items.some((item) => IN_FLIGHT_STATES.includes(item.state))) return { ok: false, reason: 'busy' };

    const item = session.items.filter((candidate) => candidate.state === 'queued').sort((a, b) => a.seq - b.seq)[0];
    if (!item) return { ok: false, reason: 'empty' };

    this.enter(item, 'claimed');
    this.commit(next);
    return { ok: true, item: cloneJson(item) };
  }

  /**
   * `Send now`: take one specific queued item out of FIFO order. Allowed while
   * an earlier item is `dispatched` — that running turn is precisely what the
   * caller is about to interrupt — but not while another reservation or claim
   * is already setting up a dispatch (single winner, A12).
   *
   * `expectedTurnEpoch` is the generation stamped into the clicked button and
   * it is REQUIRED: an optional fence is no fence, because the one caller that
   * forgets it silently skips the stale-turn check and a button rendered turns
   * ago jumps the queue (`ssot.md:116-120`, A12/A28).
   */
  reserve(sessionKey: string, itemId: string, expectedEpoch: number, expectedTurnEpoch: number): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item, session) => {
      if (session.freeze) return 'frozen';
      if (expectedTurnEpoch !== session.turnEpoch) return 'stale-turn';
      if (item.state !== 'queued') return 'invalid-state';
      if (session.items.some((other) => PENDING_DISPATCH_STATES.includes(other.state))) return 'busy';
      this.enter(item, 'reserved');
      return undefined;
    });
  }

  /** Reserved item goes straight to claimed — a reservation is never re-claimed through the drain. */
  promote(sessionKey: string, itemId: string, expectedEpoch: number): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item) => {
      if (item.state !== 'reserved') return 'invalid-state';
      this.enter(item, 'claimed');
      return undefined;
    });
  }

  /**
   * The fresh user dispatch actually started. Refuses while another item of the
   * session is still `dispatched`: §3.3 (`ssot.md:109-111`) requires the old
   * turn to be interrupted and torn down FIRST — settle it, roll it back, or
   * `markInterrupted` it. Two live dispatches would also make a later stop
   * label both items `uncertain`, which would be a lie about the torn-down one.
   *
   * Does not touch `turnEpoch` — `beginTurn` is its sole mutator.
   */
  markDispatched(sessionKey: string, itemId: string, expectedEpoch: number): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item, session) => {
      if (item.state !== 'claimed') return 'invalid-state';
      if (session.items.some((other) => other.id !== item.id && other.state === 'dispatched')) return 'busy';
      this.enter(item, 'dispatched');
      return undefined;
    });
  }

  /**
   * `Send now` interrupt: the running item was torn down mid-flight, so its
   * outcome is unknown → `uncertain` (`ssot.md:154`). Unlike `freeze` this does
   * NOT freeze the session, which is what lets the reserved item be promoted
   * and dispatched in the same breath while the interrupted item keeps its
   * `user-interrupted` history (A10/A11). Only a confirmed result may later
   * pin it via `settle`.
   */
  markInterrupted(sessionKey: string, itemId: string, expectedEpoch: number, reason: string): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item) => {
      if (item.state !== 'dispatched') return 'invalid-state';
      this.enter(item, 'uncertain', reason);
      return undefined;
    });
  }

  /**
   * Record a CONFIRMED outcome. `uncertain` is accepted on purpose: an item
   * parked as `uncertain` by a stop or a restart is only ever pinned to
   * `resolved`/`failed` once the result is actually known (`ssot.md:129`).
   * That confirmation is the only exit from `uncertain` besides an explicit
   * `retry` — nothing here decides an outcome on its own.
   *
   * `claimed` is NOT accepted: the state machine (`05-slack-agent-ui-architecture.md:145-164`)
   * gives a claim no terminal edge, because nothing has run yet. A claim that
   * cannot proceed leaves through `rollback` (back to the same seq) or a
   * freeze — settling it here would invent an outcome for a dispatch that
   * never started.
   */
  settle(
    sessionKey: string,
    itemId: string,
    expectedEpoch: number,
    outcome: 'resolved' | 'failed',
    reason?: string,
  ): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item) => {
      if (item.state !== 'dispatched' && item.state !== 'uncertain') return 'invalid-state';
      this.enter(item, outcome, reason);
      return undefined;
    });
  }

  /**
   * Give a reserved/claimed item back to the queue at its original position —
   * used when `canInterrupt` or dispatch-time authorization says no. The item
   * is NOT lost and NOT paused: it stays `queued` with a denial reason (A13/A29).
   */
  rollback(sessionKey: string, itemId: string, expectedEpoch: number, reason: string): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item) => {
      if (item.state !== 'reserved' && item.state !== 'claimed') return 'invalid-state';
      this.enter(item, 'queued', reason);
      return undefined;
    });
  }

  /**
   * Explicit requeue of a confirmed `failed` or an `uncertain` item. Never
   * automatic (A16). Refused while the session is frozen: a `queued` item in a
   * frozen session renders exactly like a drainable one but can never drain,
   * which is the conflation A29 forbids. Resume first, then retry.
   *
   * Retrying a TERMINAL item (`failed`) re-admits it into the pending set, so
   * it faces the same visible ceiling as a fresh message (§3.1) — otherwise
   * retry is a side door around capacity. An `uncertain` item is already
   * counted, so it is let through even at a full queue.
   */
  retry(sessionKey: string, itemId: string, expectedEpoch: number): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item, session) => {
      if (session.freeze) return 'frozen';
      if (item.state !== 'failed' && item.state !== 'uncertain') return 'invalid-state';
      if (TERMINAL_STATES.includes(item.state) && pendingCount(session) >= this.capacity) return 'capacity';
      this.enter(item, 'queued');
      return undefined;
    });
  }

  /**
   * stop / session end / ASK gate: freeze the session and settle each item into
   * a state instead of replaying it. A live process is observing this event, so
   * a `claimed` item is known not to have started yet → `paused`; only the item
   * that was actually running becomes `uncertain` (`ssot.md:128-129`, A17/A31).
   */
  freeze(sessionKey: string, reason: string): void {
    this.freezeSessions(reason, (session) => session.sessionKey === sessionKey, STOP_TRANSITIONS);
  }

  /** The only way out of `paused` — explicit user action (A17). Queue history is untouched. */
  resume(sessionKey: string): void {
    const next = cloneJson(this.state);
    const session = this.findSession(next, sessionKey);
    if (!session) return;
    session.freeze = undefined;
    for (const item of session.items) {
      if (item.state === 'paused') this.enter(item, 'queued');
    }
    this.commit(next);
  }

  /**
   * Process restart — deliberately NOT the same mapping as stop. After a crash
   * nobody observed what the claim did, so `claimed` is not provably unstarted
   * and comes back `uncertain` together with `dispatched` (`ssot.md:124`, A16).
   * `queued`/`reserved` come back `paused`, a confirmed `failed` stays `failed`,
   * and every session stays frozen until the user explicitly resumes (A16/A21).
   */
  recover(reason: string): void {
    this.freezeSessions(reason, () => true, RESTART_TRANSITIONS);
  }

  /** Session deletion: cancel visibly, keep the history (A18). */
  cancelSession(sessionKey: string, reason: string): void {
    const next = cloneJson(this.state);
    const session = this.findSession(next, sessionKey);
    if (!session) return;
    for (const item of session.items) {
      if (!TERMINAL_STATES.includes(item.state)) this.enter(item, 'cancelled', reason);
    }
    this.commit(next);
  }

  private freezeSessions(
    reason: string,
    selector: (session: FollowupSessionSnapshot) => boolean,
    transitions: FreezeTransitions,
  ): void {
    const next = cloneJson(this.state);
    const targets = next.sessions.filter(selector);
    if (targets.length === 0) return;
    const at = Date.now();
    for (const session of targets) {
      session.freeze = { reason, at };
      for (const item of session.items) {
        const target = transitions[item.state];
        if (target) this.enter(item, target, reason);
      }
    }
    this.commit(next);
  }

  /**
   * One transaction: locate, check the epoch token, apply, bump the epoch,
   * persist, then swap memory. A stale token rejects late writes from a
   * superseded turn without touching state (A12/A28).
   */
  private mutate(
    sessionKey: string,
    itemId: string,
    expectedEpoch: number,
    apply: (item: FollowupItem, session: FollowupSessionSnapshot) => FollowupOpFailure | undefined,
  ): FollowupOpResult {
    const next = cloneJson(this.state);
    const session = this.findSession(next, sessionKey);
    const item = session?.items.find((candidate) => candidate.id === itemId);
    if (!session || !item) return { ok: false, reason: 'not-found' };
    if (item.epoch !== expectedEpoch) return { ok: false, reason: 'stale-epoch' };

    const failure = apply(item, session);
    if (failure) return { ok: false, reason: failure };

    this.commit(next);
    return { ok: true, item: cloneJson(item) };
  }

  /** State change on a not-yet-committed item: new state, fresh epoch, reason. */
  private enter(item: FollowupItem, state: FollowupItemState, reason?: string): void {
    item.state = state;
    item.stateReason = reason;
    item.epoch += 1;
    item.updatedAt = Date.now();
  }

  /**
   * Durable first, memory second. If the sink throws, committed memory still
   * holds the previous state and the caller's transaction never happened.
   * The sink gets its own copy so a misbehaving writer cannot mutate ours.
   */
  private commit(next: FollowupQueueSnapshot): void {
    this.persist?.(cloneJson(next));
    this.state = next;
  }

  private findSession(snapshot: FollowupQueueSnapshot, sessionKey: string): FollowupSessionSnapshot | undefined {
    return snapshot.sessions.find((session) => session.sessionKey === sessionKey);
  }

  private ensureSession(snapshot: FollowupQueueSnapshot, sessionKey: string): FollowupSessionSnapshot {
    const existing = this.findSession(snapshot, sessionKey);
    if (existing) return existing;
    const created: FollowupSessionSnapshot = { sessionKey, nextSeq: 1, turnEpoch: 0, items: [] };
    snapshot.sessions.push(created);
    return created;
  }
}
