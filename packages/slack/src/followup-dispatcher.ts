import { randomUUID } from 'node:crypto';
import {
  FOLLOWUP_PENDING_DISPATCH_STATES,
  type FollowupContext,
  type FollowupItem,
  type FollowupOpFailure,
  type FollowupOpResult,
} from './followup-queue';
import type { MessageEvent } from './pipeline/types';

/**
 * Follow-up runtime coordination — the single owner of "is this session
 * running something?" (U4b/U6 of `.prd/slack-agent-ui`).
 *
 * Why this exists as its own service: nothing else in the process can answer
 * that question truthfully. `RequestCoordinator.canStartRequest`
 * (`request-coordinator.ts:173-174`) always returns true, and the controller
 * slot is removed at the TOP of `StreamExecutor.cleanup`
 * (`pipeline/stream-executor.ts:3702`) while the cleanup still has awaits
 * ahead of it (`:3726`) — so "no slot" does NOT mean "torn down". A drain or a
 * `Send now` that trusted the slot would start a fresh dispatch into a session
 * that is still unwinding. This class therefore keeps its own per-session
 * record that opens SYNCHRONOUSLY (before any await) and closes only when the
 * host's dispatch promise — which resolves after the full `finally` — settles.
 *
 * Scope discipline: service-DI only. No Slack, no filesystem, no env, no root
 * imports, no timers. Everything the coordination needs (the queue, the real
 * dispatch, the interrupt, both authorization checks, the surface fence) is
 * injected. The class starts no work on its own and never freezes or resumes
 * the queue — freeze/resume stay with the caller that owns the stop signal.
 *
 * Two different epochs live here, and they are not the same number:
 *   - **item epoch** — the queue's per-item CAS token (`FollowupItem.epoch`).
 *     Guards item transitions.
 *   - **turn epoch** — the per-session turn generation, owned by the queue
 *     (`beginTurn`/`getTurnEpoch`). Fences late surface writes from a turn that
 *     has been superseded (A28). A rendered `Send now` control must carry BOTH
 *     (`controlPayload`).
 */

export type DispatchKind = 'initial' | 'drain' | 'send-now';

/** Exactly what the host has to execute. Built from the ORIGINAL message (A30). */
export interface DispatchRequest {
  sessionKey: string;
  kind: DispatchKind;
  /** Turn generation that owns this run; surface writes tagged older must lose. */
  turnEpoch: number;
  /** Author/text/files as captured at enqueue — never the clicker's values. */
  message: MessageEvent;
  context: FollowupContext;
  /** The queue item being replayed; absent on the idle (`initial`) path. */
  item?: FollowupItem;
  /** Who authorized this dispatch to jump the queue. Authorization subject only. */
  requestedBy?: string;
}

/**
 * The host must SAY how the run ended. A resolved promise is not evidence of
 * success — `stream-executor.ts:2497` ends every turn in a `finally`, including
 * the failed ones.
 */
export type DispatchOutcome =
  | { result: 'safe' }
  | { result: 'blocked'; reason: string }
  | { result: 'error'; reason: string }
  | { result: 'interrupted'; reason?: string };

/** `denied`/`aborted` never reach the host runner — they describe a run that never started. */
export type RunOutcome = DispatchOutcome | { result: 'denied'; reason: string } | { result: 'aborted'; reason: string };

/** `uncertain-unrecorded` = the fact is known but the queue has no transition for it yet. */
export type ItemDisposition = 'none' | 'resolved' | 'failed' | 'uncertain' | 'uncertain-unrecorded';

export interface RunReport {
  sessionKey: string;
  runId: number;
  turnEpoch: number;
  kind: DispatchKind;
  itemId?: string;
  outcome: RunOutcome;
  itemDisposition: ItemDisposition;
  /** Only a `safe` outcome opens the next drain boundary. */
  canDrain: boolean;
}

export interface StartedRun {
  runId: number;
  turnEpoch: number;
  itemId?: string;
  /** Resolves when the run is fully settled — never rejects. */
  settled: Promise<RunReport>;
}

export type AuthDecision = { allowed: true } | { allowed: false; reason: string };

export interface InterruptAuthContext {
  sessionKey: string;
  itemId: string;
  requestedBy: string;
  /** The run that would be cut; absent when the session is idle. */
  live?: { turnEpoch: number; kind: DispatchKind; itemId?: string };
}

export interface DispatchAuthContext {
  sessionKey: string;
  kind: DispatchKind;
  /** Carries the ORIGINAL author in `item.message.user` — authorize that, not the clicker. */
  item: FollowupItem;
  requestedBy?: string;
}

export interface InterruptContext {
  sessionKey: string;
  supersededTurnEpoch: number;
  itemId: string;
  requestedBy: string;
}

export interface SurfaceFenceContext {
  sessionKey: string;
  supersededTurnEpoch: number;
  reason: string;
}

export type DrainHaltReason = 'blocked' | 'error' | 'authorization';

export interface DrainHalt {
  reason: DrainHaltReason;
  detail: string;
}

/** A halt is only lifted by something the user (or a permission event) actually did. */
export type DrainHaltTrigger = 'resume' | 'permission-change' | 'retry' | 'user-action';

export interface DispatcherSnapshot {
  sessionKey: string;
  busy: boolean;
  turnEpoch: number;
  kind?: DispatchKind;
  itemId?: string;
  halt?: DrainHalt;
  frozenReason?: string;
  queued: number;
}

/** Everything a rendered `Send now` button must carry back (both epochs). */
export interface SendNowControlPayload {
  sessionKey: string;
  itemId: string;
  itemEpoch: number;
  turnEpoch: number;
}

export type DispatcherNotice =
  | { type: 'run-started'; sessionKey: string; runId: number; turnEpoch: number; kind: DispatchKind; itemId?: string }
  | { type: 'run-settled'; sessionKey: string; report: RunReport }
  | { type: 'drain-halted'; sessionKey: string; reason: DrainHaltReason; detail: string }
  | { type: 'drain-resumed'; sessionKey: string; trigger: DrainHaltTrigger }
  | { type: 'item-denied'; sessionKey: string; itemId: string; stage: 'interrupt' | 'dispatch'; detail: string }
  | { type: 'item-uncertain'; sessionKey: string; itemId: string; recorded: boolean; detail: string }
  /** Pushed into the live turn's input channel under `uuid` — the model has not necessarily read it. */
  | { type: 'item-steered'; sessionKey: string; itemId: string; uuid: string }
  /** The SDK's receipt says the model took it: the item is now terminal history. */
  | { type: 'item-consumed'; sessionKey: string; itemId: string; uuid: string }
  /** Back to `queued`: the push was refused, the turn ended unread, or `Send now` took it. */
  | { type: 'item-unsteered'; sessionKey: string; itemId: string; reason: string }
  /** An injected observer threw. Reported, never fatal — observers do not govern execution. */
  | { type: 'observer-failed'; sessionKey: string; hook: 'invalidate-surface'; detail: string };

export type StartResult =
  | { status: 'dispatched'; run: StartedRun }
  | { status: 'busy'; detail: string }
  /** The session could not be advanced at all (e.g. the queue refused a turn generation). */
  | { status: 'failed'; detail: string };

export type DrainResult =
  | { status: 'dispatched'; run: StartedRun }
  | { status: 'idle'; reason: 'busy' | 'empty' | 'frozen' | 'halted'; detail?: string }
  | { status: 'denied'; itemId: string; detail: string }
  | { status: 'aborted'; itemId: string; detail: string };

export type SendNowRejection =
  | 'stale-turn-epoch'
  | 'interrupt-denied'
  | 'reserve-lost'
  | 'stale-epoch'
  | 'not-found'
  | 'frozen'
  | 'invalid-state'
  | 'interrupt-failed'
  | 'reservation-lost'
  | 'dispatch-denied'
  /** The queue could not be advanced (threw / refused a generation); nothing was dispatched. */
  | 'dispatch-unavailable';

export type SendNowResult =
  | { status: 'dispatched'; run: StartedRun }
  | { status: 'rejected'; reason: SendNowRejection; detail: string };

/**
 * Why an auto-steer did not happen (06 §3.2).
 *
 * `not-busy` is the one that is not a failure: with no live turn there is no
 * input channel to push into, so the item stays `queued` and the ordinary drain
 * takes it at the next boundary. `push-refused` means the channel itself said
 * no (closed between our check and the push) and the item was put back.
 *
 * `busy` is its mirror image: there IS a live slot, but a `Send now` already
 * owns the session (an item is `reserved`/`claimed`), so the turn we would push
 * into is the one about to be killed. Like `not-busy` the item simply stays
 * `queued`; unlike it, the host should not read it as "no turn was running".
 */
export type SteerRejection =
  | 'not-busy'
  | 'busy'
  | 'stale-epoch'
  | 'frozen'
  | 'invalid-state'
  | 'not-found'
  | 'push-refused'
  | 'dispatch-unavailable';

export type SteerResult =
  | { status: 'steered'; uuid: string }
  | { status: 'rejected'; reason: SteerRejection; detail?: string };

/**
 * The slice of `FollowupQueue` this service uses. Declared structurally so the
 * dispatcher depends on the operations, not on the class — and so a caller
 * cannot reach a queue method this coordination does not account for.
 */
export interface FollowupQueuePort {
  claimNext(sessionKey: string): FollowupOpResult;
  /** `expectedTurnEpoch` is required — an optional turn fence is skipped by the one caller that forgets it. */
  reserve(sessionKey: string, itemId: string, expectedEpoch: number, expectedTurnEpoch: number): FollowupOpResult;
  promote(sessionKey: string, itemId: string, expectedEpoch: number): FollowupOpResult;
  markDispatched(sessionKey: string, itemId: string, expectedEpoch: number): FollowupOpResult;
  settle(
    sessionKey: string,
    itemId: string,
    expectedEpoch: number,
    outcome: 'resolved' | 'failed',
    reason?: string,
  ): FollowupOpResult;
  rollback(sessionKey: string, itemId: string, expectedEpoch: number, reason: string): FollowupOpResult;
  get(sessionKey: string, itemId: string): FollowupItem | undefined;
  list(sessionKey: string): FollowupItem[];
  freezeReason(sessionKey: string): string | undefined;
  /**
   * Bump + return the persisted per-session turn generation. The queue is the
   * SSOT for it — this service keeps no counter of its own, so a restart does
   * not hand a stale generation back to rendered controls.
   */
  beginTurn(sessionKey: string): number;
  getTurnEpoch(sessionKey: string): number;
  /** `dispatched → uncertain` WITHOUT freezing the session (the `Send now` cut). */
  markInterrupted(sessionKey: string, itemId: string, expectedEpoch: number, reason: string): FollowupOpResult;
  /** `queued → steered` under `uuid`, persisted BEFORE the push (06 §3.2). */
  steer(sessionKey: string, itemId: string, expectedEpoch: number, uuid: string): FollowupOpResult;
  /** `steered → resolved` on the SDK's consumption receipt. Addressed by uuid — the SDK knows no item id. */
  markConsumed(sessionKey: string, uuid: string): FollowupOpResult;
  /** `steered → queued` at the same seq. The returned item carries the NEW epoch a reserve must use. */
  unsteer(sessionKey: string, uuid: string, reason: string): FollowupOpResult;
  /** End-of-turn sweep: every `steered` item of the session back to `queued`, returned. */
  unsteerAll(sessionKey: string, reason: string): FollowupItem[];
}

export interface FollowupDispatcherDeps {
  queue: FollowupQueuePort;
  /**
   * Runs ONE real dispatch. Must resolve only after the turn's full teardown
   * (the `finally`), and must report how it ended — see `DispatchOutcome`.
   */
  dispatch: (request: DispatchRequest) => Promise<DispatchOutcome>;
  /** Signals the abort. Resolving means "abort delivered", NOT "run finished". */
  interrupt: (context: InterruptContext) => void | Promise<void>;
  /** Click-time `canInterrupt` check (A12/§3.4). A throw is a denial (fail closed). */
  authorizeInterrupt: (context: InterruptAuthContext) => AuthDecision | Promise<AuthDecision>;
  /** Dispatch-time execution check on the ORIGINAL author (§3.4). A throw is a denial. */
  authorizeDispatch: (context: DispatchAuthContext) => AuthDecision | Promise<AuthDecision>;
  /** Fence the superseded turn's surface before the interrupt lands (A28). */
  invalidateSurface?: (context: SurfaceFenceContext) => void;
  /**
   * UI/metrics feed. A REPORT sink, not a control path: it fires synchronously
   * inside the settle, so starting a drain from it would re-enter the
   * dispatcher on its own stack. The host owns the drain loop and should drive
   * it from the awaited `StartedRun.settled` instead.
   */
  notify?: (notice: DispatcherNotice) => void;
}

interface LiveRun {
  runId: number;
  sessionKey: string;
  turnEpoch: number;
  kind: DispatchKind;
  itemId?: string;
  /** Item CAS token captured at `markDispatched` — guards the settle against a stale owner. */
  itemEpoch?: number;
  /** Set once the run has settled; a finished run is never restored as the slot owner. */
  done?: boolean;
  settled: Promise<RunReport>;
  finish: (report: RunReport) => void;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FollowupDispatcher {
  private readonly deps: FollowupDispatcherDeps;
  /** The session's dispatch slot. Its presence IS `isBusy` — see the class doc. */
  private readonly slots = new Map<string, LiveRun>();
  private readonly halts = new Map<string, DrainHalt>();
  private runSeq = 0;

  constructor(deps: FollowupDispatcherDeps) {
    this.deps = deps;
  }

  /** True from the synchronous reservation until the run's full teardown settles. */
  isBusy(sessionKey: string): boolean {
    return this.slots.has(sessionKey);
  }

  /**
   * The adapter's continuation seam asks this at a settled-turn boundary:
   * is there user work that must go before autogoal (§3.6)? Deliberately does
   * NOT look at the busy slot — at the seam the finishing turn still owns it.
   */
  shouldYield(sessionKey: string): boolean {
    if (this.halts.has(sessionKey)) return false;
    // A freeze is NOT asked about here: the rows it parked are `paused`/
    // `uncertain` and this predicate already ignores them. A `queued` row in a
    // frozen session is a message that arrived after the freeze — ordinary user
    // work, and §3.6 puts user work before autogoal either way.
    return this.deps.queue.list(sessionKey).some((item) => item.state === 'queued');
  }

  snapshot(sessionKey: string): DispatcherSnapshot {
    const live = this.slots.get(sessionKey);
    return {
      sessionKey,
      busy: live !== undefined,
      turnEpoch: this.currentTurnEpoch(sessionKey),
      kind: live?.kind,
      itemId: live?.itemId,
      halt: this.halts.get(sessionKey),
      frozenReason: this.deps.queue.freezeReason(sessionKey),
      queued: this.deps.queue.list(sessionKey).filter((item) => item.state === 'queued').length,
    };
  }

  /** Both epochs a `Send now` control must round-trip. `undefined` = nothing to render. */
  controlPayload(sessionKey: string, itemId: string): SendNowControlPayload | undefined {
    const item = this.deps.queue.get(sessionKey, itemId);
    if (!item) return undefined;
    return { sessionKey, itemId, itemEpoch: item.epoch, turnEpoch: this.currentTurnEpoch(sessionKey) };
  }

  drainHalt(sessionKey: string): DrainHalt | undefined {
    return this.halts.get(sessionKey);
  }

  /**
   * The ONLY way a halted drain reopens — an explicit user action or a
   * permission event. Nothing in here retries on its own (A16). Queue-level
   * freeze/resume is the caller's business and is untouched.
   */
  clearDrainHalt(sessionKey: string, trigger: DrainHaltTrigger): void {
    if (!this.halts.delete(sessionKey)) return;
    this.deps.notify?.({ type: 'drain-resumed', sessionKey, trigger });
  }

  /**
   * Idle path (A26): a message that arrives with nothing running dispatches
   * immediately and bypasses the queue. Fully synchronous — the slot is taken
   * before the first await, so a same-tick competitor sees `busy`. A frozen
   * queue does not block this (and no paused item is auto-resumed).
   */
  runInitial(sessionKey: string, message: MessageEvent, context: FollowupContext = {}): StartResult {
    if (this.slots.has(sessionKey)) return { status: 'busy', detail: 'a dispatch is already in flight' };

    const opened = this.openSlot(sessionKey, 'initial');
    if (!opened.ok) return { status: 'failed', detail: opened.detail };

    const run = opened.run;
    void this.startRun(run, {
      sessionKey,
      kind: 'initial',
      turnEpoch: run.turnEpoch,
      message: cloneJson(message),
      context: cloneJson(context),
    });
    return { status: 'dispatched', run: this.handle(run) };
  }

  /**
   * Auto drain at a safe turn boundary: claim exactly ONE item, check the
   * author's execution permission, then dispatch it. A denial puts the item
   * back at the same seq and HALTS the drain — re-claiming it in a loop would
   * spin on the same denial (A13/A16).
   */
  async drainNext(sessionKey: string): Promise<DrainResult> {
    // --- synchronous prologue: claim + slot must be committed before any await
    if (this.slots.has(sessionKey)) return { status: 'idle', reason: 'busy', detail: 'a dispatch is in flight' };
    const halt = this.halts.get(sessionKey);
    if (halt) return { status: 'idle', reason: 'halted', detail: halt.detail };

    // No freeze short-circuit: the queue decides per ITEM. It answers `frozen`
    // when the session is frozen and every row it holds is one the freeze
    // parked, and hands back a message that arrived after the freeze exactly
    // like any other queued item (`followup-queue.ts`, `FREEZE_PARKED_STATES`).
    const claimed = this.attempt(() => this.deps.queue.claimNext(sessionKey));
    if (!claimed.ok) {
      if (claimed.reason === undefined) {
        // The queue itself threw (durability refused the claim). Fail closed:
        // halt rather than re-enter a claim that will throw again.
        this.haltDrain(sessionKey, 'error', claimed.detail);
        return { status: 'idle', reason: 'halted', detail: claimed.detail };
      }
      const reason = claimed.reason === 'frozen' || claimed.reason === 'busy' ? claimed.reason : 'empty';
      // The freeze reason is what the caller shows the user; `queue refused:
      // frozen` is our vocabulary, not theirs.
      const detail = reason === 'frozen' ? this.frozenDetail(sessionKey, claimed.detail) : claimed.detail;
      return { status: 'idle', reason, detail };
    }
    const item = claimed.item;
    const opened = this.openSlot(sessionKey, 'drain', item.id);
    if (!opened.ok) {
      // No generation, no dispatch. Put the claim back and stop — an orphan
      // `claimed` item would block every later drain.
      const orphan = this.returnToQueue(sessionKey, item.id, 'claimed', opened.detail);
      this.haltDrain(sessionKey, 'error', orphan ? `${opened.detail}; rollback failed: ${orphan}` : opened.detail);
      return { status: 'aborted', itemId: item.id, detail: opened.detail };
    }
    const run = opened.run;
    // --- awaits from here ---

    const exec = await this.ask(this.deps.authorizeDispatch, { sessionKey, kind: 'drain', item });
    if (!exec.allowed) {
      return this.denyOpenRun(run, item.id, 'claimed', exec.reason, (detail) => ({
        status: 'denied',
        itemId: item.id,
        detail,
      }));
    }

    const fresh = this.deps.queue.get(sessionKey, item.id);
    if (!fresh || fresh.state !== 'claimed') {
      return this.abandon(run, 'claim no longer held', (detail) => ({
        status: 'aborted',
        itemId: item.id,
        detail,
      }));
    }
    const marked = this.attempt(() => this.deps.queue.markDispatched(sessionKey, item.id, fresh.epoch));
    if (!marked.ok) {
      // Same rule as the refused generation above: an orphan `claimed` item
      // blocks every later drain, so a rollback that ALSO fails must halt the
      // lane instead of leaving the queue and this service silently disagreeing.
      const orphan = this.returnToQueue(sessionKey, item.id, 'claimed', `dispatch aborted: ${marked.detail}`);
      if (orphan) this.haltDrain(sessionKey, 'error', `${marked.detail}; rollback failed: ${orphan}`);
      return this.abandon(run, marked.detail, (detail) => ({ status: 'aborted', itemId: item.id, detail }));
    }

    run.itemEpoch = marked.item.epoch;
    void this.startRun(run, this.requestFor(run, 'drain', marked.item));
    return { status: 'dispatched', run: this.handle(run) };
  }

  /**
   * Auto-steering (06 §3.2): hand a queued item to the turn that is ALREADY
   * running, without cutting it. Nothing is dispatched, no slot is taken and no
   * turn generation opens — the message joins the live turn's SDK input queue
   * and the model reads it at the next tool-call boundary.
   *
   * Only while `isBusy`: with no live slot there is no channel to push into, so
   * the answer is `not-busy` and the host drains normally (a steer into a dead
   * channel would strand the item in `steered` with no receipt ever coming).
   *
   * And only while NOTHING is setting up a dispatch (`reserved`/`claimed`,
   * review round 3): during a `Send now` the slot is already held by the
   * replacement run BEFORE the interrupt lands, so a steer in that window
   * pushes into a turn that is about to be killed — the settlement frame of a
   * turn that dies never names it, and the row is stranded `steered`, which no
   * drain can take. `busy` says so explicitly instead of letting `isBusy` stand
   * in for "a turn that will still be alive in a moment".
   *
   * Fully synchronous, like the rest of the fence — the queue write and the push
   * happen with no await between them, so nothing can settle the turn in the
   * middle and leave the item pushed into a channel that is closing.
   *
   * Order is durable-first: `queued → steered` is committed BEFORE the push, so
   * a crash between the two leaves a row that says "may have been delivered"
   * rather than a silent delivery. `push` returning false (or throwing) is the
   * only case that walks it back, and it walks it back all the way to `queued`
   * at the same seq — never to a state that hides the item from the drain.
   */
  steer(sessionKey: string, itemId: string, expectedEpoch: number, push: (uuid: string) => boolean): SteerResult {
    if (!this.slots.has(sessionKey)) {
      return { status: 'rejected', reason: 'not-busy', detail: 'no live turn to steer into' };
    }
    let pending: FollowupItem[];
    try {
      pending = this.deps.queue.list(sessionKey);
    } catch (error) {
      // Unreadable queue state cannot clear the fence: fail closed rather than
      // push into a turn we cannot prove is staying alive.
      return { status: 'rejected', reason: 'dispatch-unavailable', detail: `queue threw: ${errorText(error)}` };
    }
    const setup = pending.find((item) => FOLLOWUP_PENDING_DISPATCH_STATES.includes(item.state));
    if (setup) {
      return {
        status: 'rejected',
        reason: 'busy',
        detail: `a dispatch is being set up for ${setup.id} (${setup.state}) — the live turn is about to be replaced`,
      };
    }

    const uuid = randomUUID();
    const steered = this.attempt(() => this.deps.queue.steer(sessionKey, itemId, expectedEpoch, uuid));
    if (!steered.ok) {
      const reason = steered.reason ? this.steerRejection(steered.reason) : 'dispatch-unavailable';
      return { status: 'rejected', reason, detail: steered.detail };
    }

    let refusal: string | undefined;
    try {
      if (!push(uuid)) refusal = 'the input channel refused the message';
    } catch (error) {
      // A throwing channel is a refusal, not a delivery: fail closed, exactly
      // like the authorization hooks.
      refusal = `push threw: ${errorText(error)}`;
    }
    if (refusal) {
      // The row records WHY it came back — the channel's own words. A fixed
      // string here ('no live turn to steer') told the panel a story the code
      // had just disproved: the turn was live, the push was not taken.
      const rolled = this.attempt(() => this.deps.queue.unsteer(sessionKey, uuid, refusal));
      if (rolled.ok) {
        this.safeNotify({ type: 'item-unsteered', sessionKey, itemId, reason: refusal });
      }
      const detail = rolled.ok ? refusal : `${refusal}; unsteer failed: ${rolled.detail}`;
      return { status: 'rejected', reason: 'push-refused', detail };
    }

    this.safeNotify({ type: 'item-steered', sessionKey, itemId, uuid });
    return { status: 'steered', uuid };
  }

  /**
   * The SDK's consumption receipt arrived: `steered → resolved` (terminal
   * history). Pass-through by design — the host owns the frame observation and
   * this service owns nobody's opinion about what a frame means.
   *
   * Unlike the dispatch paths this does NOT swallow a throwing store: it holds
   * no slot and strands no run, and the host calling it from an event handler
   * is the only party that can decide what an unrecordable settlement means.
   */
  markConsumed(sessionKey: string, uuid: string): FollowupOpResult {
    const result = this.deps.queue.markConsumed(sessionKey, uuid);
    if (result.ok) {
      this.safeNotify({ type: 'item-consumed', sessionKey, itemId: result.item.id, uuid });
    }
    return result;
  }

  /**
   * The turn ended with the message still unread (`still_queued`, 06 §6.6), so
   * the item goes back to `queued` at its original seq and the ordinary drain
   * owns it again. Same pass-through discipline as `markConsumed`.
   */
  unsteer(sessionKey: string, uuid: string, reason: string): FollowupOpResult {
    const result = this.deps.queue.unsteer(sessionKey, uuid, reason);
    if (result.ok) {
      this.safeNotify({ type: 'item-unsteered', sessionKey, itemId: result.item.id, reason });
    }
    return result;
  }

  /**
   * End-of-turn sweep (06 §6.6): everything still `steered` goes back to
   * `queued`, one notice per item. The host calls this when the turn it steered
   * into is over — a settlement frame that never names an item (killed turn,
   * dropped frame) would otherwise leave it `steered`, and no drain can take a
   * `steered` row, so the message would sit in the panel forever.
   *
   * Idempotent by construction: a second call finds nothing steered and returns
   * an empty list, so calling it after a full set of receipts changes nothing.
   * Pass-through like `markConsumed` — a throwing store is the host's to handle.
   */
  unsteerAll(sessionKey: string, reason: string): FollowupItem[] {
    const moved = this.deps.queue.unsteerAll(sessionKey, reason);
    for (const item of moved) {
      this.safeNotify({ type: 'item-unsteered', sessionKey, itemId: item.id, reason });
    }
    return moved;
  }

  /**
   * `Send now` (§3.3, 05 §4). Order is load-bearing:
   *   turn-epoch fence → canInterrupt → fence re-check → RESERVE + take the
   *   slot (single winner, synchronous, before any abort) → interrupt →
   *   **only once the abort is delivered**: open the new generation and fence
   *   the superseded surface → await the interrupted run's FULL teardown →
   *   re-check the reservation → authorize the ORIGINAL author → promote
   *   (never re-claimed) → fresh dispatch of the original item.
   *
   * The generation/fence sit AFTER the interrupt on purpose (review round 2):
   * while the abort is merely pending there is no successor, so the running
   * turn is still the current one and must keep writing its own surface. If
   * the interrupt never lands, nothing was superseded and nothing is undone.
   *
   * `expectedTurnEpoch` is REQUIRED: it is what pins the run being cut to the
   * run the click was rendered against. It is re-checked after the
   * authorization await, with no await between that check and the reservation
   * — and since a new generation is only ever taken by `openSlot`, an unchanged
   * turn epoch proves no other dispatch slipped in.
   *
   * A denial BEFORE the reservation does not touch the item at all: it was
   * never taken out of the queue, so there is nothing to roll back and the
   * clicker's identity is never written anywhere (A30). The one exception is a
   * `steered` item, which must leave `steered` before it can be reserved at all
   * — see `unsteerForSendNow`, which fences that transition with the caller's
   * `expectedEpoch`. That unsteer is speculative: if the reserve or the
   * interrupt then fails, the item goes back to `steered` under the SAME uuid
   * (`restoreSteer`), because the SDK is still holding the copy and a `queued`
   * row it also holds is delivered twice.
   *
   * No mutex is held across any await. Mutual exclusion is the queue
   * reservation plus this session's dispatch slot, neither of which the
   * cleanup path waits on.
   */
  async sendNow(
    sessionKey: string,
    itemId: string,
    expectedEpoch: number,
    requestedBy: string,
    expectedTurnEpoch: number,
  ): Promise<SendNowResult> {
    const staleBefore = this.staleTurn(sessionKey, expectedTurnEpoch);
    if (staleBefore) return { status: 'rejected', reason: 'stale-turn-epoch', detail: staleBefore };

    const victimBefore = this.slots.get(sessionKey);
    const canInterrupt = await this.ask(this.deps.authorizeInterrupt, {
      sessionKey,
      itemId,
      requestedBy,
      live: victimBefore
        ? { turnEpoch: victimBefore.turnEpoch, kind: victimBefore.kind, itemId: victimBefore.itemId }
        : undefined,
    });
    if (!canInterrupt.allowed) {
      this.safeNotify({ type: 'item-denied', sessionKey, itemId, stage: 'interrupt', detail: canInterrupt.reason });
      return { status: 'rejected', reason: 'interrupt-denied', detail: canInterrupt.reason };
    }

    // --- single winner: re-check the fence, reserve, and take the slot with
    // --- no await in between, so the authorized victim is still the victim.
    const staleAfter = this.staleTurn(sessionKey, expectedTurnEpoch);
    if (staleAfter) return { status: 'rejected', reason: 'stale-turn-epoch', detail: staleAfter };

    // A steered item is still the user's queued message — `Send now` on it means
    // "stop waiting for the model to get around to it". The queue only reserves
    // `queued`, so take it out of `steered` first. The CAS is done HERE, against
    // the steered epoch the control was rendered with, because `unsteer` is
    // addressed by uuid and carries no epoch fence of its own; `reserve` then
    // runs against the NEW epoch that transition produced. Still no await
    // between the check, the unsteer and the reserve, so nothing can slip in.
    const prepared = this.unsteerForSendNow(sessionKey, itemId, expectedEpoch);
    if (!prepared.ok) return prepared.rejection;
    // Kept for every failure path below: while this is set, the SDK is holding a
    // copy of the message that only this uuid can settle (`restoreSteer`).
    const steerUuid = prepared.steerUuid;

    const reserved = this.attempt(() => this.deps.queue.reserve(sessionKey, itemId, prepared.epoch, expectedTurnEpoch));
    if (!reserved.ok) {
      // Nothing was interrupted and nothing was dispatched, so the pushed copy
      // is still in the live turn's channel — the row must name it again or the
      // drain will send the same message a second time.
      const stranded = this.restoreSteer(sessionKey, itemId, steerUuid);
      const reason = reserved.reason ? this.reserveRejection(reserved.reason) : 'dispatch-unavailable';
      return {
        status: 'rejected',
        reason,
        detail: stranded ? `${reserved.detail}; ${stranded}` : reserved.detail,
      };
    }
    const victim = this.slots.get(sessionKey);
    // Reserve the replacement slot now (serialisation), but do NOT open a
    // generation yet: nothing has been superseded until the abort lands.
    const run = this.takeSlot(sessionKey, 'send-now', victim?.turnEpoch ?? expectedTurnEpoch, itemId);
    // --- awaits from here ---

    if (victim) {
      let interruptFailure: string | undefined;
      try {
        await this.deps.interrupt({ sessionKey, supersededTurnEpoch: victim.turnEpoch, itemId, requestedBy });
      } catch (error) {
        interruptFailure = errorText(error);
      }
      if (interruptFailure) {
        // No abort was delivered, so the victim may never end (parked on an ASK
        // gate, long tool call). Waiting on it would hang this promise forever
        // AND hold the reservation. Bail out here — and because no generation
        // was opened and no fence was raised, the still-running turn keeps its
        // render authority exactly as it was.
        this.restoreOwner(run, victim);
        const orphan = this.returnToQueue(sessionKey, itemId, 'reserved', `interrupt failed: ${interruptFailure}`);
        if (orphan) {
          this.haltDrain(sessionKey, 'error', `interrupt failed: ${interruptFailure}; rollback failed: ${orphan}`);
        }
        // The abort never landed, so the turn — and the copy we pushed into it —
        // are both still alive. The row is `queued` again, which is exactly the
        // shape a drain takes: re-attach the uuid or it runs twice.
        const stranded = this.restoreSteer(sessionKey, itemId, steerUuid);
        const failure = stranded
          ? `interrupt failed: ${interruptFailure}; ${stranded}`
          : `interrupt failed: ${interruptFailure}`;
        return this.abandon(run, failure, (detail) => ({
          status: 'rejected',
          reason: 'interrupt-failed',
          detail,
        }));
      }

      // The abort is delivered: the supersede is now real, so take the
      // generation and fence the dying turn's surface — both still BEFORE any
      // successor dispatch exists.
      const started = this.startGeneration(run);
      if (!started.ok) {
        // The old turn is dying but no new turn can open. Give the session back
        // to it until it settles (no overlap), put the item back, and say so.
        this.restoreOwner(run, victim);
        const orphan = this.returnToQueue(sessionKey, itemId, 'reserved', started.detail);
        if (orphan) this.haltDrain(sessionKey, 'error', `${started.detail}; rollback failed: ${orphan}`);
        return this.abandon(run, started.detail, (detail) => ({
          status: 'rejected',
          reason: 'dispatch-unavailable',
          detail,
        }));
      }
      try {
        this.deps.invalidateSurface?.({ sessionKey, supersededTurnEpoch: victim.turnEpoch, reason: 'send-now' });
      } catch (error) {
        // The fence is an observer of ours; the persisted generation is the
        // actual guard, and it is already advanced above.
        this.safeNotify({ type: 'observer-failed', sessionKey, hook: 'invalidate-surface', detail: errorText(error) });
      }

      // The abort was only SIGNALLED. The run is finished when its own promise
      // settles — not when the coordinator slot disappears.
      await victim.settled;
    } else {
      // Idle session: there is nothing to interrupt, so the supersede is
      // immediate and the generation opens right away.
      const started = this.startGeneration(run);
      if (!started.ok) {
        this.releaseSlot(run);
        const orphan = this.returnToQueue(sessionKey, itemId, 'reserved', started.detail);
        if (orphan) this.haltDrain(sessionKey, 'error', `${started.detail}; rollback failed: ${orphan}`);
        return { status: 'rejected', reason: 'dispatch-unavailable', detail: started.detail };
      }
    }

    const fresh = this.deps.queue.get(sessionKey, itemId);
    if (!fresh || fresh.state !== 'reserved' || fresh.epoch !== reserved.item.epoch) {
      return this.abandon(run, `reservation lost during teardown (${fresh?.state ?? 'missing'})`, (detail) => ({
        status: 'rejected',
        reason: 'reservation-lost',
        detail,
      }));
    }

    const exec = await this.ask(this.deps.authorizeDispatch, {
      sessionKey,
      kind: 'send-now',
      item: fresh,
      requestedBy,
    });
    if (!exec.allowed) {
      return this.denyOpenRun(run, itemId, 'reserved', exec.reason, (detail) => ({
        status: 'rejected',
        reason: 'dispatch-denied',
        detail,
      }));
    }

    const promoted = this.attempt(() => this.deps.queue.promote(sessionKey, itemId, fresh.epoch));
    if (!promoted.ok) {
      // The reservation is ours and nothing ran: give it back at the same seq.
      // Left `reserved` it would refuse every later claim and reservation while
      // `isBusy` says idle — the queue and the lane disagreeing in silence.
      const orphan = this.returnToQueue(sessionKey, itemId, 'reserved', `dispatch aborted: ${promoted.detail}`);
      if (orphan) this.haltDrain(sessionKey, 'error', `${promoted.detail}; rollback failed: ${orphan}`);
      return this.abandon(run, promoted.detail, (detail) => ({
        status: 'rejected',
        reason: 'reservation-lost',
        detail,
      }));
    }
    const marked = this.attempt(() => this.deps.queue.markDispatched(sessionKey, itemId, promoted.item.epoch));
    if (!marked.ok) {
      const orphan = this.returnToQueue(sessionKey, itemId, 'claimed', `dispatch aborted: ${marked.detail}`);
      if (orphan) this.haltDrain(sessionKey, 'error', `${marked.detail}; rollback failed: ${orphan}`);
      return this.abandon(run, marked.detail, (detail) => ({
        status: 'rejected',
        reason: 'reservation-lost',
        detail,
      }));
    }

    run.itemEpoch = marked.item.epoch;
    void this.startRun(run, this.requestFor(run, 'send-now', marked.item, requestedBy));
    return { status: 'dispatched', run: this.handle(run) };
  }

  // ---------------------------------------------------------------- internals

  /**
   * `Send now` pre-step: if the item is `steered`, pull it back to `queued` and
   * return the epoch `reserve` must use, together with the uuid it was steered
   * under. Returns the caller's own `expectedEpoch` untouched for every other
   * state, so all existing rejection paths (`stale-epoch`, `frozen`,
   * `invalid-state`, …) keep being decided by `reserve` exactly as before.
   *
   * The uuid is HANDED BACK, not discarded, because this unsteer is speculative:
   * it happens before the reserve and before the interrupt, and either of them
   * can still fail. Until the abort is delivered the SDK keeps the copy we
   * pushed, so every failure path after this point owes the row that handle back
   * (`restoreSteer`) — a `queued` row the SDK is still holding is the one shape
   * that makes the drain deliver the same message twice.
   *
   * Known residual (06 §3.3 assigns it to the host, not here): once the abort
   * DOES land, cancelling that copy (`cancel_queued` / `still_queued`) is part
   * of the interrupt — this service neither observes nor performs it.
   */
  private unsteerForSendNow(
    sessionKey: string,
    itemId: string,
    expectedEpoch: number,
  ): { ok: true; epoch: number; steerUuid?: string } | { ok: false; rejection: SendNowResult } {
    let current: FollowupItem | undefined;
    try {
      current = this.deps.queue.get(sessionKey, itemId);
    } catch {
      // Unreadable state: let `reserve` be the single decider, as before.
      return { ok: true, epoch: expectedEpoch };
    }
    if (current?.state !== 'steered') return { ok: true, epoch: expectedEpoch };

    // The control was rendered against the steered row, so THAT epoch is the
    // fence. Without this check the unsteer below would happily bump an item a
    // concurrent steer/consume already moved on.
    if (current.epoch !== expectedEpoch) {
      return {
        ok: false,
        rejection: {
          status: 'rejected',
          reason: 'stale-epoch',
          detail: `control rendered at item epoch ${expectedEpoch}, item is at ${current.epoch}`,
        },
      };
    }
    const steerUuid = current.steerUuid;
    if (!steerUuid) {
      // A steered row with no uuid cannot be settled by anything; refuse rather
      // than invent a transition for a row the queue could not have written.
      return {
        ok: false,
        rejection: { status: 'rejected', reason: 'invalid-state', detail: 'steered item carries no steer uuid' },
      };
    }

    const unsteered = this.attempt(() => this.deps.queue.unsteer(sessionKey, steerUuid, 'send now'));
    if (!unsteered.ok) {
      const reason = unsteered.reason ? this.reserveRejection(unsteered.reason) : 'dispatch-unavailable';
      return { ok: false, rejection: { status: 'rejected', reason, detail: unsteered.detail } };
    }
    this.safeNotify({ type: 'item-unsteered', sessionKey, itemId, reason: 'send now' });
    return { ok: true, epoch: unsteered.item.epoch, steerUuid };
  }

  /**
   * Undo of `unsteerForSendNow`: put the uuid back on a row that is `queued`
   * again while the SDK still holds the copy it names.
   *
   * Only a `queued` row is restored, and that is the whole point — `steered` is
   * invisible to the drain, so a row in any other state cannot be double-sent
   * and needs nothing from us. `queue.steer` takes an arbitrary uuid, so the
   * ORIGINAL handle goes back: a fresh one would leave the SDK's eventual
   * receipt naming nothing.
   *
   * A restore that itself fails halts the drain, like every other silent
   * disagreement between this service and the queue: the alternative is a lane
   * that keeps draining an item the SDK is also about to run.
   */
  private restoreSteer(sessionKey: string, itemId: string, steerUuid: string | undefined): string | undefined {
    if (!steerUuid) return undefined;
    let item: FollowupItem | undefined;
    try {
      item = this.deps.queue.get(sessionKey, itemId);
    } catch (error) {
      const detail = `re-steer failed: queue threw: ${errorText(error)}`;
      this.haltDrain(sessionKey, 'error', detail);
      return detail;
    }
    if (!item || item.state !== 'queued') return undefined;
    const epoch = item.epoch;
    const restored = this.attempt(() => this.deps.queue.steer(sessionKey, itemId, epoch, steerUuid));
    if (restored.ok) {
      this.safeNotify({ type: 'item-steered', sessionKey, itemId, uuid: steerUuid });
      return undefined;
    }
    const detail = `re-steer failed: ${restored.detail}`;
    this.haltDrain(sessionKey, 'error', detail);
    return detail;
  }

  /**
   * Take the session's dispatch slot — SYNCHRONOUSLY, before any await, so a
   * competing message or click sees `busy` immediately. Does NOT open a turn
   * generation: until `startGeneration` runs, this run is only a reservation
   * and `turnEpoch` mirrors the generation still in force.
   */
  private takeSlot(sessionKey: string, kind: DispatchKind, currentTurnEpoch: number, itemId?: string): LiveRun {
    let finish!: (report: RunReport) => void;
    const settled = new Promise<RunReport>((resolve) => {
      finish = resolve;
    });
    const run: LiveRun = {
      runId: ++this.runSeq,
      sessionKey,
      turnEpoch: currentTurnEpoch,
      kind,
      itemId,
      settled,
      finish,
    };
    this.slots.set(sessionKey, run);
    return run;
  }

  /**
   * Open this run's turn generation — the moment the previous turn is
   * superseded (A28).
   *
   * RULING (revised in review round 2; the earlier rule took the generation at
   * slot time): the generation is taken when the supersede is REAL, not when a
   * dispatch is merely reserved. For `Send now` that is after `deps.interrupt`
   * has returned — an abort that was never delivered leaves the old turn
   * running, and bumping the generation for it would silently revoke that live
   * turn's render authority forever (its header writes would be fenced out by
   * a generation nothing ever dispatched into). Reserving the slot early is
   * what serialises callers; the generation is what fences surfaces, and the
   * two no longer happen at the same instant.
   *
   * Fallible on purpose: `beginTurn` persists, so it can refuse. A caller that
   * cannot get a generation must NOT dispatch.
   */
  private startGeneration(run: LiveRun): { ok: true } | { ok: false; detail: string } {
    try {
      run.turnEpoch = this.deps.queue.beginTurn(run.sessionKey);
    } catch (error) {
      return { ok: false, detail: `turn generation unavailable: ${errorText(error)}` };
    }
    this.safeNotify({
      type: 'run-started',
      sessionKey: run.sessionKey,
      runId: run.runId,
      turnEpoch: run.turnEpoch,
      kind: run.kind,
      itemId: run.itemId,
    });
    return { ok: true };
  }

  /**
   * Slot + generation in one step, for the paths with nothing to interrupt
   * (`runInitial`, `drainNext`): there the supersede is immediate.
   */
  private openSlot(
    sessionKey: string,
    kind: DispatchKind,
    itemId?: string,
  ): { ok: true; run: LiveRun } | { ok: false; detail: string } {
    const run = this.takeSlot(sessionKey, kind, this.currentTurnEpoch(sessionKey), itemId);
    const started = this.startGeneration(run);
    if (!started.ok) {
      this.releaseSlot(run);
      return { ok: false, detail: started.detail };
    }
    return { ok: true, run };
  }

  /** Drop a slot whose run never announced itself — no report, no notice. */
  private releaseSlot(run: LiveRun): void {
    run.done = true;
    if (this.slots.get(run.sessionKey) === run) this.slots.delete(run.sessionKey);
  }

  /**
   * Ownership CAS, the same discipline as `request-coordinator.ts:121-134`: a
   * run that finishes AFTER `Send now` took the slot must never clear the new
   * live run. Nothing in here may throw — this is the only path that resolves
   * `settled`, so a throw would strand the session forever.
   */
  private closeSlot(run: LiveRun, report: RunReport): RunReport {
    run.done = true;
    if (this.slots.get(run.sessionKey) === run) this.slots.delete(run.sessionKey);
    run.finish(report);
    this.safeNotify({ type: 'run-settled', sessionKey: run.sessionKey, report });
    return report;
  }

  private async startRun(run: LiveRun, request: DispatchRequest): Promise<RunReport> {
    let outcome: DispatchOutcome;
    try {
      // `deps.dispatch` is invoked synchronously here — the slot is already ours.
      outcome = (await this.deps.dispatch(request)) ?? { result: 'error', reason: 'dispatch returned no outcome' };
    } catch (error) {
      outcome = { result: 'error', reason: errorText(error) };
    }

    // Bookkeeping must never strand the run: whatever the queue does here, the
    // slot closes and `settled` resolves.
    let disposition: ItemDisposition = 'none';
    let unrecorded: string | undefined;
    try {
      const recorded = this.recordItemOutcome(run, outcome);
      disposition = recorded.disposition;
      unrecorded = recorded.error;
    } catch (error) {
      unrecorded = errorText(error);
      disposition = run.itemId ? 'uncertain-unrecorded' : 'none';
      if (run.itemId) {
        this.safeNotify({
          type: 'item-uncertain',
          sessionKey: run.sessionKey,
          itemId: run.itemId,
          recorded: false,
          detail: unrecorded,
        });
      }
    }

    if (outcome.result === 'blocked' || outcome.result === 'error') {
      this.haltDrain(run.sessionKey, outcome.result, outcome.reason);
    } else if (unrecorded) {
      // The item's real state is now unknown to the store. Draining past it
      // would be guessing — stop until someone acts explicitly.
      this.haltDrain(run.sessionKey, 'error', `outcome not recorded: ${unrecorded}`);
    }
    return this.closeSlot(run, this.report(run, outcome, disposition));
  }

  /**
   * Pin the item to what the run actually proved. An interrupted item is
   * `uncertain`, never `failed` — the work may well have happened (§3.5, R6),
   * and a `blocked` turn is recorded the same way (see the case below).
   */
  private recordItemOutcome(run: LiveRun, outcome: DispatchOutcome): { disposition: ItemDisposition; error?: string } {
    const { itemId, itemEpoch, sessionKey } = run;
    if (!itemId || itemEpoch === undefined) return { disposition: 'none' };
    const item = this.deps.queue.get(sessionKey, itemId);
    // Stale-owner guard: the item moved on, so this run no longer speaks for it.
    if (!item || item.epoch !== itemEpoch || item.state !== 'dispatched') return { disposition: 'none' };

    switch (outcome.result) {
      case 'safe': {
        const settled = this.attempt(() => this.deps.queue.settle(sessionKey, itemId, itemEpoch, 'resolved'));
        return settled.ok ? { disposition: 'resolved' } : { disposition: 'none', error: settled.detail };
      }
      case 'error': {
        const settled = this.attempt(() =>
          this.deps.queue.settle(sessionKey, itemId, itemEpoch, 'failed', outcome.reason),
        );
        return settled.ok ? { disposition: 'failed' } : { disposition: 'none', error: settled.detail };
      }
      // Both mean the turn was torn down or parked mid-flight: the item may or
      // may not have had its effect, so the honest state is `uncertain` —
      // never `failed`, never `resolved`. Leaving it `dispatched` would wedge
      // the whole lane: `claimNext` and `markDispatched` both refuse while an
      // item is in flight (`followup-queue.ts:350`, `:403`) and no live run
      // would ever be left to clear it.
      case 'blocked':
      case 'interrupted': {
        const detail = outcome.reason ?? 'interrupted';
        const marked = this.attempt(() => this.deps.queue.markInterrupted(sessionKey, itemId, itemEpoch, detail));
        this.safeNotify({ type: 'item-uncertain', sessionKey, itemId, recorded: marked.ok, detail });
        return marked.ok ? { disposition: 'uncertain' } : { disposition: 'uncertain-unrecorded', error: marked.detail };
      }
      default:
        return { disposition: 'none' };
    }
  }

  /**
   * Dispatch-time authorization said no: the item goes back to the SAME seq
   * with a visible reason, the drain halts (re-claiming would spin on the same
   * denial), and the run that never started is closed as `denied`.
   */
  private denyOpenRun<T>(
    run: LiveRun,
    itemId: string,
    expectedState: 'reserved' | 'claimed',
    reason: string,
    shape: (detail: string) => T,
  ): T {
    const orphan = this.returnToQueue(run.sessionKey, itemId, expectedState, reason);
    this.haltDrain(run.sessionKey, 'authorization', orphan ? `${reason}; rollback failed: ${orphan}` : reason);
    this.safeNotify({ type: 'item-denied', sessionKey: run.sessionKey, itemId, stage: 'dispatch', detail: reason });
    this.closeSlot(run, this.report(run, { result: 'denied', reason }, 'none'));
    return shape(reason);
  }

  /**
   * Give a reserved/claimed item back at the SAME seq with a visible reason
   * (A13/A29). Returns a detail string when the rollback itself failed — the
   * caller decides how loudly to fail, but never throws out of a path that
   * owns an open slot.
   */
  private returnToQueue(
    sessionKey: string,
    itemId: string,
    expectedState: 'reserved' | 'claimed',
    reason: string,
  ): string | undefined {
    let item: FollowupItem | undefined;
    try {
      item = this.deps.queue.get(sessionKey, itemId);
    } catch (error) {
      return errorText(error);
    }
    if (!item || item.state !== expectedState) return undefined;
    const epoch = item.epoch;
    const rolled = this.attempt(() => this.deps.queue.rollback(sessionKey, itemId, epoch, reason));
    return rolled.ok ? undefined : rolled.detail;
  }

  /**
   * Hand the session back to the run that still owns it, for an attempt that
   * took the slot and then failed before dispatching. Without this the slot
   * would be empty beside a live turn and a fresh idle message could overlap
   * it. The turn generation is NOT rolled back — it is monotone and persisted,
   * so the restored run simply keeps its older epoch and the controls rendered
   * under it are stale by design (they were fenced before the interrupt).
   */
  private restoreOwner(run: LiveRun, victim: LiveRun): void {
    if (victim.done) return; // it ended on its own — leaving the slot free is correct
    if (this.slots.get(run.sessionKey) !== run) return; // someone else already took it
    this.slots.set(run.sessionKey, victim);
  }

  /** Close a slot for a run that never dispatched, and shape the caller's failure. */
  private abandon<T>(run: LiveRun, detail: string, shape: (detail: string) => T): T {
    this.closeSlot(run, this.report(run, { result: 'aborted', reason: detail }, 'none'));
    return shape(detail);
  }

  /** The stored freeze reason, or our own words when the store cannot say. */
  private frozenDetail(sessionKey: string, fallback: string): string {
    try {
      return this.deps.queue.freezeReason(sessionKey) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private haltDrain(sessionKey: string, reason: DrainHaltReason, detail: string): void {
    this.halts.set(sessionKey, { reason, detail });
    this.safeNotify({ type: 'drain-halted', sessionKey, reason, detail });
  }

  private report(run: LiveRun, outcome: RunOutcome, itemDisposition: ItemDisposition): RunReport {
    return {
      sessionKey: run.sessionKey,
      runId: run.runId,
      turnEpoch: run.turnEpoch,
      kind: run.kind,
      itemId: run.itemId,
      outcome,
      itemDisposition,
      canDrain: outcome.result === 'safe',
    };
  }

  private requestFor(run: LiveRun, kind: DispatchKind, item: FollowupItem, requestedBy?: string): DispatchRequest {
    // The runner gets its own copy of the ORIGINAL payload — a mutating host
    // cannot reach queue state, and no field is rewritten with the clicker's.
    const copy = cloneJson(item);
    return {
      sessionKey: run.sessionKey,
      kind,
      turnEpoch: run.turnEpoch,
      message: copy.message,
      context: copy.context,
      item: copy,
      requestedBy,
    };
  }

  private handle(run: LiveRun): StartedRun {
    return { runId: run.runId, turnEpoch: run.turnEpoch, itemId: run.itemId, settled: run.settled };
  }

  private async ask<C>(hook: (context: C) => AuthDecision | Promise<AuthDecision>, context: C): Promise<AuthDecision> {
    try {
      return await hook(context);
    } catch (error) {
      // Fail closed: an authorization check that blew up is not a yes.
      return { allowed: false, reason: errorText(error) };
    }
  }

  /** Every mutating queue call goes through here, so a throwing store is a value, not a strand. */
  private attempt(
    call: () => FollowupOpResult,
  ): { ok: true; item: FollowupItem } | { ok: false; detail: string; reason?: FollowupOpFailure } {
    try {
      const result = call();
      return result.ok ? result : { ok: false, detail: `queue refused: ${result.reason}`, reason: result.reason };
    } catch (error) {
      return { ok: false, detail: `queue threw: ${errorText(error)}` };
    }
  }

  /** Observers report; they never govern. A throwing sink cannot break a dispatch. */
  private safeNotify(notice: DispatcherNotice): void {
    try {
      this.deps.notify?.(notice);
    } catch {
      // Deliberately swallowed: there is no second sink to report this to.
    }
  }

  private staleTurn(sessionKey: string, expectedTurnEpoch: number): string | undefined {
    const current = this.currentTurnEpoch(sessionKey);
    if (current === expectedTurnEpoch) return undefined;
    return `control rendered at turn ${expectedTurnEpoch}, session is at ${current}`;
  }

  private reserveRejection(reason: FollowupOpFailure): SendNowRejection {
    switch (reason) {
      case 'busy':
        return 'reserve-lost';
      case 'stale-epoch':
        return 'stale-epoch';
      // The queue re-checks the generation too; keep the caller's vocabulary
      // identical whether this service or the queue caught the stale control.
      case 'stale-turn':
        return 'stale-turn-epoch';
      case 'not-found':
      case 'empty':
        return 'not-found';
      case 'frozen':
        return 'frozen';
      default:
        return 'invalid-state';
    }
  }

  /**
   * Queue vocabulary → steer vocabulary. `stale-turn` cannot come out of `steer`
   * (it takes no turn fence), so anything unexpected collapses to
   * `invalid-state` rather than being reported as a condition this path can
   * actually produce. `busy` is kept verbatim: this service raises exactly that
   * condition itself, so mapping the queue's own `busy` to something else would
   * make one fact answer under two names.
   */
  private steerRejection(reason: FollowupOpFailure): SteerRejection {
    switch (reason) {
      case 'stale-epoch':
        return 'stale-epoch';
      case 'busy':
        return 'busy';
      case 'frozen':
        return 'frozen';
      case 'not-found':
      case 'empty':
        return 'not-found';
      default:
        return 'invalid-state';
    }
  }

  /**
   * The generation in force for the session. Guarded: a store that cannot
   * answer must not throw out of a path holding a slot, and reporting 0 fences
   * every rendered control instead of admitting one (fail closed).
   */
  private currentTurnEpoch(sessionKey: string): number {
    try {
      return this.deps.queue.getTurnEpoch(sessionKey);
    } catch {
      return 0;
    }
  }
}
