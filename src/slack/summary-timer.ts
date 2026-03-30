import { Logger } from '../logger.js';

const logger = new Logger('SummaryTimer');

/**
 * Per-session 180s timer that fires a summary callback after turn completion.
 * Trace: docs/turn-summary-lifecycle/trace.md, S1 + S2
 */
export class SummaryTimer {
  private timers = new Map<string, NodeJS.Timeout>();

  /** Duration before summary fires (ms) */
  static readonly DELAY_MS = 180_000;

  /**
   * Start a timer for the given session. Resets any existing timer.
   * Trace: S1, Section 3b
   */
  start(sessionKey: string, callback: () => void | Promise<void>): void {
    this.cancel(sessionKey);
    const timerId = setTimeout(() => {
      this.timers.delete(sessionKey);
      logger.info('Timer fired', { sessionKey });
      try {
        const result = callback();
        // If callback returns a promise, catch async rejections
        if (result && typeof result.catch === 'function') {
          result.catch((err: any) => {
            logger.error('Summary timer async callback failed', {
              sessionKey,
              error: err?.message || String(err),
            });
          });
        }
      } catch (err: any) {
        logger.error('Summary timer callback threw', {
          sessionKey,
          error: err?.message || String(err),
        });
      }
    }, SummaryTimer.DELAY_MS);
    this.timers.set(sessionKey, timerId);
    logger.info('Timer started', { sessionKey, delayMs: SummaryTimer.DELAY_MS });
  }

  /**
   * Cancel the timer for the given session. No-op if none exists.
   * Trace: S2, Section 3b
   */
  cancel(sessionKey: string): void {
    const timerId = this.timers.get(sessionKey);
    if (timerId) {
      clearTimeout(timerId);
      this.timers.delete(sessionKey);
      logger.info('Timer cancelled', { sessionKey });
    }
  }

  /** Check if a timer is active for the session */
  has(sessionKey: string): boolean {
    return this.timers.has(sessionKey);
  }

  /** Cancel all active timers (cleanup on shutdown) */
  cancelAll(): void {
    for (const [key, timerId] of this.timers) {
      clearTimeout(timerId);
    }
    this.timers.clear();
  }
}
