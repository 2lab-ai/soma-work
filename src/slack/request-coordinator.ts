import { Logger } from '../logger';

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
   * Remove the controller for a session (on completion or cleanup)
   */
  removeController(sessionKey: string): void {
    this.activeControllers.delete(sessionKey);
    this.logger.debug('Removed controller for session', { sessionKey });
  }

  /**
   * Abort the active request for a session
   * @returns true if a request was aborted, false if no active request
   */
  abortSession(sessionKey: string): boolean {
    const controller = this.activeControllers.get(sessionKey);
    if (controller) {
      controller.abort();
      this.logger.debug('Aborted session', { sessionKey });
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
   * Clear all controllers (for shutdown)
   */
  clearAll(): void {
    for (const [sessionKey, controller] of this.activeControllers) {
      controller.abort();
      this.logger.debug('Cleared controller on shutdown', { sessionKey });
    }
    this.activeControllers.clear();
  }
}
