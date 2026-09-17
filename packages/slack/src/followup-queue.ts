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

/** Stored as the `stateReason` of an item the user cancelled from the Queue panel. */
export const FOLLOWUP_CANCEL_DEFAULT_REASON = '사용자가 취소했습니다';

export type FollowupItemState =
  | 'queued'
  | 'steered'
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
  /**
   * The `SDKUserMessage` uuid this item was pushed into the running turn's
   * input channel under (`steered`), and the ONLY handle the settlement events
   * carry back — the SDK never echoes a queue id (06 §6.6). Present exactly in
   * `steered` and in the `resolved` row a `markConsumed` produced, where it
   * stays as the receipt of which SDK message this item became; every other
   * transition clears it, so a uuid never names an item that is not the one the
   * SDK is holding (`enter`).
   */
  steerUuid?: string;
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
/**
 * States a single-item Cancel may leave. `failed`/`uncertain` are included on
 * purpose — closing a known-bad item is the alternative to `retry` — while the
 * in-flight trio (`reserved`/`claimed`/`dispatched`) is deliberately absent:
 * aborting a running turn is the executor's job, not the queue's (§3.3).
 * `resolved`/`cancelled` are absent too, so history is never rewritten.
 */
const CANCELLABLE_STATES: readonly FollowupItemState[] = ['queued', 'paused', 'failed', 'uncertain'];
/**
 * `steered` is deliberately NOT in `CANCELLABLE_STATES`: the message is already
 * sitting in the SDK's own input queue, so cancelling it here would only
 * rewrite our row while the model still reads it (06 §3.4). The cancel path for
 * a steered item is `cancelSteered`, which the host calls **after** the SDK
 * confirmed `cancel_async_message`; a plain `cancelItem` keeps answering
 * `invalid-state` so the refusal is explicit instead of a silent lie.
 */
/**
 * A dispatch is being set up — blocks a competing `Send now` reservation.
 *
 * Exported because the dispatcher asks the same question about a session before
 * it steers (06 §3.2): while one of these is held, the turn a steer would push
 * into is the one `Send now` is about to kill. A second, hand-copied list is how
 * the two sides of that fence quietly drift apart.
 */
export const FOLLOWUP_PENDING_DISPATCH_STATES: readonly FollowupItemState[] = ['reserved', 'claimed'];
/**
 * Anything the executor may still be running — blocks a drain claim.
 *
 * `steered` is absent on purpose (06 §6.2): a steered item was handed to the
 * turn that is ALREADY running, so it is not a dispatch of ours and it must not
 * block one. Once that turn ends, a queued sibling is still drainable even
 * while the steered item waits for its consumption receipt — treating it as
 * in-flight would wedge the lane on an item no dispatch will ever settle.
 */
const IN_FLIGHT_STATES: readonly FollowupItemState[] = ['reserved', 'claimed', 'dispatched'];

/**
 * The states a freeze PARKS — the rows it exists to hold back (`freezeSessions`
 * writes exactly these, per `STOP_TRANSITIONS`/`RESTART_TRANSITIONS`).
 *
 * This is the SCOPE of a freeze, and it is a per-ITEM question, not a
 * per-session one. Everything the session held when it froze left `queued`, so
 * a `queued` row in a frozen session can only be a message that arrived AFTER
 * the freeze: it never ran, nothing about it is uncertain, and the pause has
 * nothing to protect it from. Holding those back was the 2026-09-17 live bug —
 * a thread frozen by a restart answered every new message with
 * "큐가 멈춰 있어 자동으로 실행되지 않습니다" and ran nothing until a Resume.
 *
 * Deliberately NOT a timestamp comparison (`enqueuedAt` vs `freeze.at`):
 * `Date.now()` has millisecond resolution, so a message enqueued in the same
 * millisecond as the freeze would be classified by a coin flip. The state IS
 * the record of what the freeze touched.
 *
 * Exported for the same reason as {@link FOLLOWUP_PENDING_DISPATCH_STATES}: the
 * renderer has to scope a freeze exactly as the gates here do (a control the
 * panel offers on a row the gates refuse is a button that can only fail), and a
 * second hand-copied list is how the two sides drift apart.
 */
export const FREEZE_PARKED_STATES: readonly FollowupItemState[] = ['paused', 'uncertain'];

/**
 * A freeze target: the state to enter, and optionally a note appended to the
 * freeze reason. The note exists for the one mapping whose STATE understates
 * what is known (`steered` on restart) — the row itself has to carry the doubt,
 * because nothing downstream can reconstruct it from `paused`.
 */
type FreezeTarget = FollowupItemState | { to: FollowupItemState; note: string };

/** States rewritten when a session is frozen; anything absent is left untouched. */
type FreezeTransitions = Partial<Record<FollowupItemState, FreezeTarget>>;

/**
 * stop / session end (`ssot.md:128-129`): a live process witnesses the event,
 * so an un-started `claimed` item is provably un-started → `paused`. Only the
 * items whose outcome nobody witnessed are `uncertain`.
 *
 * `steered` is one of them (review round 3). `freeze()` runs SYNCHRONOUSLY
 * inside the stop path, before the turn's settlement frame arrives, so at this
 * instant nobody knows whether the model already read the pushed message —
 * exactly the question `dispatched → uncertain` exists for. Calling it `paused`
 * would promise the user an un-run message and let `resume` replay it, which is
 * the double delivery the uuid dedup exists to stop.
 */
const STOP_TRANSITIONS: FreezeTransitions = {
  queued: 'paused',
  steered: 'uncertain',
  reserved: 'paused',
  claimed: 'paused',
  dispatched: 'uncertain',
};

/**
 * restart (`ssot.md:124`): nobody witnessed the crash, so `claimed` may already
 * have produced a query. `claimed` and `dispatched` both come back `uncertain`
 * — never blind-replayed.
 *
 * `steered` comes back `paused` (06 §4 S7): the SDK process that held the input
 * channel died with the restart, so nothing can still act on the message and
 * the uuid it was pushed under is meaningless to the next process. That is a
 * statement about the FUTURE, not about the past — the model may well have read
 * it before the crash — so the pause carries that doubt in its reason and only
 * an explicit resume puts it back in line.
 */
const RESTART_TRANSITIONS: FreezeTransitions = {
  queued: 'paused',
  steered: { to: 'paused', note: '모델이 읽었는지 미확인' },
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
   *
   * Only `queued` items are candidates: a `steered` item was already handed to
   * the running turn, so claiming it here would deliver the same message twice
   * (06 §3.2, "중복 전달 금지"). It does not block the claim of a queued sibling
   * either — see `IN_FLIGHT_STATES`.
   *
   * A freeze does not block the claim by itself, because it does not need to:
   * every row it parked is `paused`/`uncertain` and therefore not a candidate
   * (`FREEZE_PARKED_STATES`). What is left `queued` in a frozen session arrived
   * after the freeze and is ordinary work. The `frozen` answer survives for the
   * case it actually describes — a frozen session with nothing but parked rows —
   * so the caller still says "waiting for Resume" instead of "empty".
   */
  claimNext(sessionKey: string): FollowupOpResult {
    const next = cloneJson(this.state);
    const session = this.findSession(next, sessionKey);
    if (!session) return { ok: false, reason: 'empty' };
    if (session.items.some((item) => IN_FLIGHT_STATES.includes(item.state))) return { ok: false, reason: 'busy' };

    const item = session.items.filter((candidate) => candidate.state === 'queued').sort((a, b) => a.seq - b.seq)[0];
    if (!item) return { ok: false, reason: session.freeze ? 'frozen' : 'empty' };

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
      if (this.parkedByFreeze(session, item)) return 'frozen';
      if (expectedTurnEpoch !== session.turnEpoch) return 'stale-turn';
      if (item.state !== 'queued') return 'invalid-state';
      if (session.items.some((other) => FOLLOWUP_PENDING_DISPATCH_STATES.includes(other.state))) return 'busy';
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
    return this.mutate(sessionKey, itemId, expectedEpoch, (item, session) => {
      if (item.state !== 'dispatched' && item.state !== 'uncertain') return 'invalid-state';
      this.enter(item, outcome, reason);
      // A confirmed `uncertain` row is the fourth way out of a parked state.
      this.settleFreeze(session);
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
   * automatic (A16).
   *
   * NOT refused while the session is frozen: a retry IS the explicit user
   * decision the freeze is waiting for, aimed at one specific row (A17). The
   * old session-level refusal ("resume first") made the panel's own Retry a
   * dead end on exactly the rows that need it — and `resume` does not even move
   * an `uncertain` item, so there was no other door. Nothing undrainable is
   * created either: {@link settleFreeze} lifts the freeze once the last parked
   * row has left, and until then `claimNext` still only sees `queued` rows.
   *
   * Retrying a TERMINAL item (`failed`) re-admits it into the pending set, so
   * it faces the same visible ceiling as a fresh message (§3.1) — otherwise
   * retry is a side door around capacity. An `uncertain` item is already
   * counted, so it is let through even at a full queue.
   */
  retry(sessionKey: string, itemId: string, expectedEpoch: number): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item, session) => {
      if (item.state !== 'failed' && item.state !== 'uncertain') return 'invalid-state';
      if (TERMINAL_STATES.includes(item.state) && pendingCount(session) >= this.capacity) return 'capacity';
      this.enter(item, 'queued');
      this.settleFreeze(session);
      return undefined;
    });
  }

  /**
   * Edit = the user edited their own Slack message (06 §3.4/D3): the stored
   * text is replaced in place, nothing else is. There is no edit UI — the Slack
   * edit IS the edit — so this is the one write that changes `message` after
   * the enqueue, and it changes ONLY `text`: author, files, `eventKey` and
   * `seq` stay the original event's (A30), so the item keeps its FIFO position
   * and its dedup identity.
   *
   * `queued` only. A `steered` item is already sitting in the SDK's input queue
   * under a uuid, so rewriting our row would leave the model reading the OLD
   * text while the panel shows the new one; everything in flight or terminal is
   * refused for the same reason (`invalid-state`), and the caller says so
   * instead of silently editing nothing.
   *
   * The epoch still bumps even though the STATE is unchanged: a control
   * rendered against the previous text must not act on the new one (A12/A28).
   */
  editQueued(sessionKey: string, itemId: string, expectedEpoch: number, text: string): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item) => {
      if (item.state !== 'queued') return 'invalid-state';
      item.message = { ...item.message, text };
      this.enter(item, 'queued', '편집됨');
      return undefined;
    });
  }

  // ------------------------------------------------------------- auto-steering
  //
  // `steered` = "pushed into the RUNNING turn's SDK input channel; the model has
  // not necessarily read it yet" (06 §3.1). It is the one state this queue does
  // not own the execution of: the message is in the SDK's queue, and the only
  // handle that comes back is the uuid it was pushed under, so the three
  // settlement doors below (`markConsumed`/`unsteer`/`cancelSteered`) exist to
  // translate an SDK fact into a queue transition — never to guess one.

  /**
   * `queued → steered`: the caller is about to push this item into the live
   * turn's input channel under `uuid`. Persisted BEFORE the push (the usual
   * durable-first rule) so a push that lands while we crash is still explained
   * by the stored row instead of vanishing.
   *
   * Refused for an item the freeze PARKED — that one is waiting for an explicit
   * resume (A17/A29). Not refused for a message that arrived after the freeze:
   * the turn it is being pushed into is alive right now, and the pause was never
   * about this message (`FREEZE_PARKED_STATES`). Refused unless the item is
   * `queued`: re-steering a steered item is exactly the double delivery `uuid`
   * dedup exists to stop.
   */
  steer(sessionKey: string, itemId: string, expectedEpoch: number, uuid: string): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item, session) => {
      if (this.parkedByFreeze(session, item)) return 'frozen';
      if (item.state !== 'queued') return 'invalid-state';
      this.enter(item, 'steered', 'steered');
      item.steerUuid = uuid;
      return undefined;
    });
  }

  /**
   * The SDK confirmed the model took the message (06 §6.6): `steered → resolved`
   * with a `consumed` reason. Terminal, so the item stops occupying capacity and
   * leaves the live queue — it is history, not a dispatch of ours, and no
   * `settle` will ever follow it.
   *
   * Addressed by uuid, not by item id, because the uuid is the only identity the
   * SDK's receipt carries. The uuid is KEPT on the resolved row, which is what
   * makes a redelivered settlement event answer `invalid-state` (already
   * consumed) instead of the misleading `not-found`.
   */
  markConsumed(sessionKey: string, uuid: string): FollowupOpResult {
    return this.mutateBySteerUuid(sessionKey, uuid, (item) => {
      if (item.state !== 'steered') return 'invalid-state';
      this.enter(item, 'resolved', 'consumed');
      item.steerUuid = uuid;
      return undefined;
    });
  }

  /**
   * `steered → queued`: the push did not stick, or the turn ended with the
   * message still sitting unread in the SDK queue (`still_queued`, 06 §3.2 S3).
   * The item returns to its original seq — FIFO position is never lost — and the
   * uuid is dropped, so the ordinary drain owns it again and no stale receipt
   * can re-settle it.
   */
  unsteer(sessionKey: string, uuid: string, reason: string): FollowupOpResult {
    return this.mutateBySteerUuid(sessionKey, uuid, (item) => {
      if (item.state !== 'steered') return 'invalid-state';
      this.enter(item, 'queued', reason);
      return undefined;
    });
  }

  /**
   * End-of-turn sweep: every item still `steered` in this session goes back to
   * `queued` (uuid cleared) in ONE transaction, and the moved items are
   * returned so the caller can report each one.
   *
   * Why a sweep exists at all: `steered` is the only state whose exit depends on
   * a receipt this process does not produce. A settlement frame that never names
   * an item — a turn killed mid-flight, a frame the SDK dropped — would leave it
   * `steered` forever, and `steered` is invisible to the drain (`claimNext`
   * takes `queued` only). The host calls this when the turn it steered into is
   * over: after that instant no receipt can legitimately arrive, so anything
   * still holding the state was never witnessed and belongs back in line.
   *
   * Not a settlement of its own: it claims nothing about whether the model read
   * the message — it only restores drainability, which is why the caller passes
   * the reason the panel will show.
   */
  unsteerAll(sessionKey: string, reason: string): FollowupItem[] {
    const next = cloneJson(this.state);
    const session = this.findSession(next, sessionKey);
    if (!session) return [];
    const moved = session.items.filter((item) => item.state === 'steered');
    if (moved.length === 0) return []; // nothing to commit — no write, no epoch bump
    for (const item of moved) this.enter(item, 'queued', reason);
    this.commit(next);
    return cloneJson(moved);
  }

  /**
   * Cancel of a steered item — allowed ONLY once the SDK confirmed
   * `cancel_async_message(uuid)`, which is why it is a separate door from
   * `cancelItem` (06 §3.4). This queue cannot dequeue the SDK's copy, so a
   * cancel that is not backed by that confirmation would mark the item
   * `cancelled` here while the model still reads it.
   *
   * Keyed by item id + `expectedEpoch` like every other panel operation: the
   * caller is a user action holding a rendered control, not an SDK receipt.
   */
  cancelSteered(sessionKey: string, itemId: string, expectedEpoch: number, reason?: string): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item) => {
      if (item.state !== 'steered') return 'invalid-state';
      this.enter(item, 'cancelled', reason ?? FOLLOWUP_CANCEL_DEFAULT_REASON);
      return undefined;
    });
  }

  /**
   * stop / session end / ASK gate: freeze the session and settle each item into
   * a state instead of replaying it. A live process is observing this event, so
   * a `claimed` item is known not to have started yet → `paused`; the items
   * whose outcome nobody witnessed — the one that was running and the ones
   * pushed into its input channel — become `uncertain` (`ssot.md:128-129`,
   * A17/A31). See `STOP_TRANSITIONS`.
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
   * and a session that had work in flight stays frozen until the user explicitly
   * resumes (A16/A21).
   *
   * Only sessions that still hold a NON-terminal item are frozen. A freeze is
   * the thing that holds items back, so a session whose queue is nothing but
   * history (or is empty) has nothing to hold: freezing it only makes the next
   * message the user sends wait for a Resume they were never told to press —
   * the 2026-09-17 live bug. Same rule the stop path already applies before it
   * freezes (`slack-handler.ts:3614`).
   */
  recover(reason: string): void {
    this.freezeSessions(
      reason,
      (session) => session.items.some((item) => !TERMINAL_STATES.includes(item.state)),
      RESTART_TRANSITIONS,
    );
    // A freeze that holds nothing back (written by an earlier build, or left
    // behind once its rows were cancelled) must not survive the restart: it
    // would only put a stale "재시작 전 항목" banner on a thread with no such item.
    const next = cloneJson(this.state);
    let changed = false;
    for (const session of next.sessions) {
      if (!session.freeze) continue;
      this.settleFreeze(session);
      if (!session.freeze) changed = true;
    }
    if (changed) this.commit(next);
  }

  /**
   * Per-item Cancel from the Queue panel. The item becomes `cancelled` — a
   * terminal state that stays visible as history (A18) and gives its capacity
   * slot back exactly like a confirmed `failed` does.
   *
   * NOT allowed on `reserved`/`claimed`/`dispatched`: a turn that is already
   * being set up or running is torn down through the dispatch path
   * (`rollback`/`markInterrupted`), never by a queue write behind its back
   * (`ssot.md:109-111`). The panel still SHOWS Cancel there so the refusal is
   * an explicit `invalid-state` answer instead of a missing control.
   *
   * A freeze does not block this: `paused` items only exist while the session
   * is frozen, so gating on the freeze would make them uncancellable.
   */
  cancelItem(sessionKey: string, itemId: string, expectedEpoch: number, reason?: string): FollowupOpResult {
    return this.mutate(sessionKey, itemId, expectedEpoch, (item, session) => {
      if (!CANCELLABLE_STATES.includes(item.state)) return 'invalid-state';
      // A blank reason is a MISSING reason: storing `''` would leave the panel's
      // history line saying only `cancelled`, with no who and no why.
      this.enter(item, 'cancelled', reason?.trim() || FOLLOWUP_CANCEL_DEFAULT_REASON);
      this.settleFreeze(session);
      return undefined;
    });
  }

  /** Session deletion: cancel visibly, keep the history (A18). */
  cancelSession(sessionKey: string, reason: string): void {
    const next = cloneJson(this.state);
    const session = this.findSession(next, sessionKey);
    if (!session) return;
    for (const item of session.items) {
      if (!TERMINAL_STATES.includes(item.state)) this.enter(item, 'cancelled', reason);
    }
    this.settleFreeze(session);
    this.commit(next);
  }

  /**
   * Is this item one of the rows the session's freeze is holding back?
   *
   * The single definition of a freeze's SCOPE, asked by every gate that used to
   * ask `if (session.freeze)`. A session-level answer conflated two different
   * items: the restored/stopped row the user must decide about, and the message
   * they sent afterwards into a session that is still running (A29 — a pause and
   * a live message never share a sentence).
   */
  private parkedByFreeze(session: FollowupSessionSnapshot, item: FollowupItem): boolean {
    return session.freeze !== undefined && FREEZE_PARKED_STATES.includes(item.state);
  }

  /**
   * Drop a freeze that has nothing left to hold.
   *
   * A freeze IS its parked rows ({@link parkedByFreeze}). Once the last one has
   * left — resumed, retried, cancelled one by one or with the session — the
   * session is frozen in name only, and that name is not harmless: the panel
   * keeps showing a banner the user cannot clear, `claimNext` answers `frozen`
   * instead of `empty`, and the host reads "this thread is stopped" off a queue
   * that holds nothing but ordinary work.
   *
   * Called on the not-yet-committed session INSIDE the transaction that moved
   * the last row, so the freeze and the row it was holding disappear in one
   * durable write — never in two, with a crash in between.
   */
  private settleFreeze(session: FollowupSessionSnapshot): void {
    if (!session.freeze) return;
    if (session.items.some((item) => FREEZE_PARKED_STATES.includes(item.state))) return;
    session.freeze = undefined;
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
        if (!target) continue;
        if (typeof target === 'string') this.enter(item, target, reason);
        else this.enter(item, target.to, `${reason} — ${target.note}`);
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

  /**
   * Same transaction as `mutate`, addressed by the uuid the item was steered
   * under instead of by item id. There is no epoch CAS here on purpose: the
   * caller is an SDK settlement receipt, not a rendered control, and the uuid is
   * itself a single-use token minted for exactly one push. `not-found` covers
   * both "no such session" and "no item carries that uuid" — including an item
   * that already left `steered` through a freeze, which clears it.
   */
  private mutateBySteerUuid(
    sessionKey: string,
    uuid: string,
    apply: (item: FollowupItem, session: FollowupSessionSnapshot) => FollowupOpFailure | undefined,
  ): FollowupOpResult {
    const next = cloneJson(this.state);
    const session = this.findSession(next, sessionKey);
    const item = session?.items.find((candidate) => candidate.steerUuid === uuid);
    if (!session || !item) return { ok: false, reason: 'not-found' };

    const failure = apply(item, session);
    if (failure) return { ok: false, reason: failure };

    this.commit(next);
    return { ok: true, item: cloneJson(item) };
  }

  /**
   * State change on a not-yet-committed item: new state, fresh epoch, reason.
   *
   * Clearing `steerUuid` is part of the transition, not of each call site: an
   * item that is no longer `steered` must not stay addressable by the uuid the
   * SDK holds, or a late receipt would settle a row that has since been paused,
   * requeued or cancelled. The two transitions that legitimately keep the uuid
   * (`steer`, `markConsumed`) re-set it right after calling this.
   */
  private enter(item: FollowupItem, state: FollowupItemState, reason?: string): void {
    item.state = state;
    item.stateReason = reason;
    item.steerUuid = undefined;
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
