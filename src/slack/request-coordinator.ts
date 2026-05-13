import { Logger } from '../logger';

/**
 * Why an in-flight request was aborted. Plumbed through
 * `AbortController.abort(reason)` so downstream consumers (StreamExecutor
 * error handling) can distinguish a passive "new message displaced an
 * idle/stalled turn" from an explicit user cancel.
 *
 *   `supersede`     — new message in the same session displaces the prior
 *                     (often stalled) turn. The user is waiting for *some*
 *                     turn-end signal — surface a completion card.
 *   `user-stop`     — explicit Stop button / dashboard stop / `!`. The user
 *                     already knows the turn ended; stay quiet.
 *   `session-close` — Close button / session expiry. Same: quiet.
 *   `shutdown`      — process-wide shutdown of all in-flight requests.
 *   `stall-timeout` — (reserved) future stall watchdog will use this when
 *                     no SDK event has arrived for N minutes. Treated the
 *                     same as `supersede` by the notification gate.
 *
 * NOTE: extending this union has fan-out — every consumer that switches on
 * the reason (`stream-executor.handleError` notify gate, supersede card
 * messaging, future telemetry) must be updated together with the type.
 */
export type RequestAbortReason = 'supersede' | 'user-stop' | 'session-close' | 'shutdown' | 'stall-timeout';

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
    this.logger.debug('Set controller for session', { sessionKey });
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
  }
}
