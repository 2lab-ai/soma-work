import { Logger } from '@soma/common/logger';

/**
 * Why an in-flight request was aborted. Plumbed through
 * `AbortController.abort(reason)` so downstream consumers (StreamExecutor
 * error handling) can distinguish a passive "new message displaced an
 * idle/stalled turn" from an explicit user cancel.
 *
 *   `supersede`     — new message in the same session displaced a *healthy*
 *                     prior turn (user-driven mid-turn steering). The user
 *                     just talked to us; surfacing a red card here looks
 *                     like a false-positive failure. Stay quiet.
 *   `user-stop`     — explicit Stop button / dashboard stop / `!`. The user
 *                     already knows the turn ended; stay quiet.
 *   `session-close` — Close button / session expiry. Same: quiet.
 *   `shutdown`      — process-wide shutdown of all in-flight requests.
 *   `stall-timeout` — the dispatcher's stall heuristic (or a future
 *                     watchdog) observed no SDK activity for the
 *                     configured stall window before aborting. The user
 *                     was waiting on a dead turn — surface a terminal
 *                     card so the thread doesn't read as half-finished.
 *   `user-interrupted` — the user EXPLICITLY interrupted the running turn to
 *                     run something else now (`Send now` on a queued
 *                     follow-up, U6). Distinct from `user-stop` (stop and
 *                     stay stopped) and from `supersede` (a new message
 *                     passively displaced the turn): the interrupt is an
 *                     authorized, deliberate action whose partial output
 *                     must be PRESERVED and labelled literally, never
 *                     downgraded to an error or a stall. Stay quiet — the
 *                     user pressed the button. Trace:
 *                     `.prd/slack-agent-ui/ssot.md` §3.3, A11.
 *   `ghost-session`  — `StreamCallbacks.onToolUse` / `onToolResult` observed
 *                     `session.terminated === true` mid-stream and aborted
 *                     the local controller. Distinct from the explicit
 *                     `session-close` action (Close button / dashboard /
 *                     expiry): the session died out-of-band while a turn
 *                     was running, so the user has no other terminal
 *                     signal. Surface a terminal card. Trace:
 *                     `docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md`
 *                     §B-1.
 *
 * NOTE: extending this union has fan-out — every consumer that switches on
 * the reason (`stream-executor.handleError` notify gate, supersede card
 * messaging, future telemetry) must be updated together with the type.
 */
export type RequestAbortReason =
  | 'supersede'
  | 'user-stop'
  | 'session-close'
  | 'shutdown'
  | 'stall-timeout'
  | 'user-interrupted'
  | 'ghost-session';

/**
 * The abort reasons that mean "this session is being STOPPED", as opposed to
 * "this turn is being replaced". Only these notify {@link RequestCoordinatorDeps.beforeAbort}.
 *
 * `user-interrupted` (`Send now`) and `supersede` (mid-turn steering) are
 * deliberately absent: both abort the current turn so the NEXT one can run
 * immediately. Freezing the follow-up queue there would strand the very items
 * the user is trying to advance (U8 / ssot.md §3.3).
 */
const STOP_CLASS_ABORT_REASONS: ReadonlySet<RequestAbortReason> = new Set(['user-stop', 'session-close', 'shutdown']);

export interface RequestCoordinatorDeps {
  /**
   * Called SYNCHRONOUSLY, BEFORE the abort, whenever a session is stopped with
   * a {@link STOP_CLASS_ABORT_REASONS} reason — including when there is no
   * in-flight controller (a "stop" on an idle session is exactly when the
   * follow-up queue must freeze).
   *
   * Contract:
   *   - Ordering is load-bearing. The observer records DURABLE state (queue
   *     freeze). If the abort landed first and the write then failed, the
   *     queue would keep draining into a session the user just stopped, with
   *     no signal that anything went wrong.
   *   - THROWING IS FAIL-CLOSED, NOT ADVISORY. A throw propagates to the
   *     caller and the coordinator performs no abort and no state mutation
   *     for that session: nothing is aborted, the controller stays registered,
   *     the activity clock is untouched. A stop that could not be recorded is
   *     a stop that did not happen.
   *   - Must be synchronous. A promise would let the abort race the write,
   *     which is the ordering this seam exists to prevent.
   */
  beforeAbort?: (sessionKey: string, reason: RequestAbortReason) => void;
}

/**
 * Manages request concurrency for sessions.
 *
 * Responsibilities:
 * - Track active AbortControllers per session
 * - Enforce one active request per session
 * - Handle request cancellation on owner interrupt
 * - Give a host observer the chance to record a stop BEFORE it happens
 *   ({@link RequestCoordinatorDeps.beforeAbort})
 */
export class RequestCoordinator {
  private logger = new Logger('RequestCoordinator');
  private readonly deps: RequestCoordinatorDeps;
  private activeControllers: Map<string, AbortController> = new Map();
  /**
   * Last "sign of life" timestamp (ms since epoch) for each active session.
   *
   * Updated when the controller is set (turn started) and on every
   * `touchSession` call (every SDK stream event the dispatcher forwards).
   * Consumed by `session-initializer.handleConcurrency` to tell a healthy
   * mid-turn steering (`supersede`, silent) from a stalled-turn displace
   * (`stall-timeout`, terminal card).
   *
   * Lifetime is tied to the controller — `removeController` and `clearAll`
   * drop the entry so a stale timestamp from a finished turn can't leak
   * into a brand-new turn that starts on the same sessionKey.
   */
  private lastActivityAt: Map<string, number> = new Map();

  /** `deps` is optional — every pre-U8 caller constructs with no arguments. */
  constructor(deps: RequestCoordinatorDeps = {}) {
    this.deps = deps;
  }

  /**
   * Get the active AbortController for a session
   */
  getController(sessionKey: string): AbortController | undefined {
    return this.activeControllers.get(sessionKey);
  }

  /**
   * Set the active AbortController for a session
   */
  setController(sessionKey: string, controller: AbortController): void {
    this.activeControllers.set(sessionKey, controller);
    // Bootstrap the activity clock at turn start so the stall heuristic
    // doesn't fire on a brand-new turn whose first SDK event hasn't
    // arrived yet (cold start / model warmup).
    this.lastActivityAt.set(sessionKey, Date.now());
    this.logger.debug('Set controller for session', { sessionKey });
  }

  /**
   * Knock the activity clock forward — call this on every SDK stream
   * event the dispatcher forwards so the stall heuristic in
   * `session-initializer.handleConcurrency` sees the turn as healthy.
   *
   * Gated on the presence of an active controller: if the controller has
   * already been removed (turn finished / aborted) we don't want a
   * late-arriving event to repopulate a stale entry. Cheap to call.
   */
  touchSession(sessionKey: string): void {
    if (!this.activeControllers.has(sessionKey)) {
      return;
    }
    this.lastActivityAt.set(sessionKey, Date.now());
  }

  /**
   * Last recorded activity timestamp (ms since epoch) for an active
   * session, or `undefined` if there's no active controller or no event
   * has fired yet. Consumers MUST treat `undefined` as "unknown" and not
   * as "stale" — the conservative default is silent supersede.
   */
  getLastActivityAt(sessionKey: string): number | undefined {
    return this.lastActivityAt.get(sessionKey);
  }

  /**
   * Remove the controller for a session (on completion or cleanup).
   * Ghost Session Fix #99: CAS guard — if expectedController is provided,
   * only remove if the current controller matches (reference equality).
   * Prevents older request's finally block from removing newer request's controller.
   */
  removeController(sessionKey: string, expectedController?: AbortController): void {
    if (expectedController) {
      const current = this.activeControllers.get(sessionKey);
      if (current !== expectedController) {
        this.logger.debug('CAS mismatch: skipping removeController', { sessionKey });
        return;
      }
    }
    this.activeControllers.delete(sessionKey);
    // Drop the activity entry so a stale timestamp from this finished
    // turn cannot influence the stall heuristic of the next turn that
    // starts on the same sessionKey.
    this.lastActivityAt.delete(sessionKey);
    this.logger.debug('Removed controller for session', { sessionKey });
  }

  /**
   * Abort the active request for a session.
   *
   * The `reason` is forwarded to `controller.abort(reason)` so it surfaces
   * as `signal.reason` in the catch handler — that's how
   * `StreamExecutor.handleError` decides whether to post a "🔴 오류 발생"
   * card for the aborted turn (supersede / stall-timeout) or stay quiet
   * (user-stop / session-close / shutdown).
   *
   * Defaults to `'user-stop'` to preserve the historical "explicit cancel"
   * semantics of the unparameterized call.
   *
   * For stop-class reasons the host observer runs FIRST and may refuse (by
   * throwing), in which case this method throws and nothing is aborted — see
   * {@link RequestCoordinatorDeps.beforeAbort}.
   *
   * @returns true if a request was aborted, false if no active request
   */
  abortSession(sessionKey: string, reason: RequestAbortReason = 'user-stop'): boolean {
    // Before the lookup, so an idle session (no controller) still freezes, and
    // before any mutation, so a refusal leaves the coordinator exactly as it
    // was. Deliberately NOT wrapped in try/catch: the throw is the signal.
    this.notifyBeforeAbort(sessionKey, reason);

    const controller = this.activeControllers.get(sessionKey);
    if (controller) {
      controller.abort(reason);
      this.logger.debug('Aborted session', { sessionKey, reason });
      return true;
    }
    return false;
  }

  /**
   * Check if a session has an active request
   */
  isRequestActive(sessionKey: string): boolean {
    return this.activeControllers.has(sessionKey);
  }

  /**
   * Check if a new request can start for a session.
   * Currently always returns true (requests queue naturally).
   * This method exists for future expansion of concurrency policies.
   */
  canStartRequest(_sessionKey: string): boolean {
    return true;
  }

  /**
   * Get the count of active requests
   */
  getActiveCount(): number {
    return this.activeControllers.size;
  }

  /**
   * Clear all controllers (for shutdown).
   *
   * Tags every abort with `'shutdown'` so the notification gate stays
   * quiet — a process-wide shutdown is not user-relevant feedback.
   *
   * Per-session fail-closed: each session is observed before its own abort, so
   * one refusing observer does not block the rest of the shutdown. A refused
   * session keeps its controller registered and un-aborted (its queue never
   * froze), and the first refusal is rethrown after the sweep so the failure
   * is not swallowed.
   */
  clearAll(): void {
    let firstRefusal: unknown;
    let refusalSeen = false;

    for (const [sessionKey, controller] of [...this.activeControllers]) {
      try {
        this.notifyBeforeAbort(sessionKey, 'shutdown');
      } catch (err) {
        if (!refusalSeen) {
          firstRefusal = err;
          refusalSeen = true;
        }
        this.logger.warn('beforeAbort refused a shutdown — session left active', {
          sessionKey,
          error: (err as Error)?.message ?? String(err),
        });
        // Leave this session's controller and activity entry in place.
        continue;
      }
      controller.abort('shutdown' satisfies RequestAbortReason);
      this.activeControllers.delete(sessionKey);
      this.lastActivityAt.delete(sessionKey);
      this.logger.debug('Cleared controller on shutdown', { sessionKey });
    }

    if (refusalSeen) {
      throw firstRefusal;
    }
  }

  /**
   * Run the host observer for stop-class reasons. Throws propagate on purpose
   * ({@link RequestCoordinatorDeps.beforeAbort}); non-stop reasons and a
   * missing observer are no-ops.
   */
  private notifyBeforeAbort(sessionKey: string, reason: RequestAbortReason): void {
    if (!this.deps.beforeAbort) return;
    if (!STOP_CLASS_ABORT_REASONS.has(reason)) return;
    this.deps.beforeAbort(sessionKey, reason);
  }
}
