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
  | 'ghost-session';

/**
 * Manages request concurrency for sessions.
 *
 * Responsibilities:
 * - Track active AbortControllers per session
 * - Enforce one active request per session
 * - Handle request cancellation on owner interrupt
 */
export class RequestCoordinator {
  private logger = new Logger('RequestCoordinator');
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
   * @returns true if a request was aborted, false if no active request
   */
  abortSession(sessionKey: string, reason: RequestAbortReason = 'user-stop'): boolean {
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
   */
  clearAll(): void {
    for (const [sessionKey, controller] of this.activeControllers) {
      controller.abort('shutdown' satisfies RequestAbortReason);
      this.logger.debug('Cleared controller on shutdown', { sessionKey });
    }
    this.activeControllers.clear();
    this.lastActivityAt.clear();
  }
}
