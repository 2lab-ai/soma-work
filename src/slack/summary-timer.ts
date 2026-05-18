import { Logger } from '../logger.js';

const logger = new Logger('SummaryTimer');

/**
 * Read a positive-millisecond env var with a fallback. Anything non-numeric or
 * sub-second is treated as a typo and replaced with the default — the timer
 * is user-visible UI so a misconfig must not yield an absurd cadence.
 */
function readMsEnv(envVar: string, defaultMs: number): number {
  const raw = process.env[envVar];
  if (!raw) return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    logger.warn(`Invalid ${envVar}="${raw}" — falling back to default ${defaultMs}ms`);
    return defaultMs;
  }
  return parsed;
}

/** Per-session timer state — main firing timeout + optional countdown interval. */
interface TimerEntry {
  timerId: NodeJS.Timeout;
  intervalId?: NodeJS.Timeout;
}

/**
 * Per-session timer that fires a summary callback after a configurable wait
 * window and, optionally, emits countdown ticks during the wait so the
 * surface can show "Executive Summary in Xm Ys" — MCP-completion style.
 *
 * Defaults:
 * - DELAY_MS = 5 min (matches Anthropic prompt-cache TTL).
 * - COUNTDOWN_INTERVAL_MS = 1 min.
 *
 * Both overridable via env (`SUMMARY_DELAY_MS`, `SUMMARY_COUNTDOWN_INTERVAL_MS`).
 *
 * Trace: docs/current/plans/turn-summary-lifecycle/trace.md, S1 + S2.
 */
export class SummaryTimer {
  private timers = new Map<string, TimerEntry>();

  /** Duration before summary fires (ms). Default 5 min. Override via `SUMMARY_DELAY_MS`. */
  static readonly DELAY_MS = readMsEnv('SUMMARY_DELAY_MS', 300_000);

  /** Countdown tick cadence (ms). Default 1 min. Override via `SUMMARY_COUNTDOWN_INTERVAL_MS`. */
  static readonly COUNTDOWN_INTERVAL_MS = readMsEnv('SUMMARY_COUNTDOWN_INTERVAL_MS', 60_000);

  /**
   * Start a timer for the given session. Resets any existing timer.
   *
   * @param sessionKey  per-session key (channel:thread).
   * @param callback    runs once when the wait window elapses.
   * @param tick        optional countdown callback. If provided, fires
   *                    immediately at t=0 (so the user sees the countdown
   *                    right away) and then every {@link COUNTDOWN_INTERVAL_MS}
   *                    until the main timeout fires or the entry is cancelled.
   *                    Errors thrown by the callback are caught so a single
   *                    bad tick cannot kill the interval.
   *
   * Trace: S1, Section 3b.
   */
  start(sessionKey: string, callback: () => void | Promise<void>, tick?: (remainingMs: number) => void): void {
    this.cancel(sessionKey);
    const startedAt = Date.now();

    const timerId = setTimeout(() => {
      // Stop the countdown interval BEFORE firing the callback so a slow
      // callback can't get an extra tick mid-flight.
      const entry = this.timers.get(sessionKey);
      if (entry?.intervalId) clearInterval(entry.intervalId);
      this.timers.delete(sessionKey);

      logger.info('Timer fired', { sessionKey });
      try {
        const result = callback();
        if (result && typeof result.catch === 'function') {
          result.catch((err: unknown) => {
            logger.error('Summary timer async callback failed', {
              sessionKey,
              error: (err as Error)?.message ?? String(err),
            });
          });
        }
      } catch (err: unknown) {
        logger.error('Summary timer callback threw', {
          sessionKey,
          error: (err as Error)?.message ?? String(err),
        });
      }
    }, SummaryTimer.DELAY_MS);

    const entry: TimerEntry = { timerId };

    if (tick) {
      const safeTick = (remainingMs: number) => {
        try {
          tick(remainingMs);
        } catch (err: unknown) {
          logger.error('Summary timer countdown tick threw', {
            sessionKey,
            error: (err as Error)?.message ?? String(err),
          });
        }
      };

      // Fire immediately so the user sees the countdown before the first
      // interval elapses (otherwise it'd take a full minute to appear).
      safeTick(SummaryTimer.DELAY_MS);

      entry.intervalId = setInterval(() => {
        const remaining = SummaryTimer.DELAY_MS - (Date.now() - startedAt);
        if (remaining <= 0) {
          // The main setTimeout owns the final fire. Drop the tick to avoid
          // a confusing "0s" or "-1s" render race.
          return;
        }
        safeTick(remaining);
      }, SummaryTimer.COUNTDOWN_INTERVAL_MS);
    }

    this.timers.set(sessionKey, entry);
    logger.info('Timer started', {
      sessionKey,
      delayMs: SummaryTimer.DELAY_MS,
      countdownEnabled: !!tick,
    });
  }

  /**
   * Cancel the timer for the given session. Clears both the firing timeout
   * AND the countdown interval. No-op if none exists.
   *
   * Trace: S2, Section 3b.
   */
  cancel(sessionKey: string): void {
    const entry = this.timers.get(sessionKey);
    if (!entry) return;
    clearTimeout(entry.timerId);
    if (entry.intervalId) clearInterval(entry.intervalId);
    this.timers.delete(sessionKey);
    logger.info('Timer cancelled', { sessionKey });
  }

  /** Check if a timer is active for the session. */
  has(sessionKey: string): boolean {
    return this.timers.has(sessionKey);
  }

  /** Cancel all active timers (cleanup on shutdown). */
  cancelAll(): void {
    for (const entry of this.timers.values()) {
      clearTimeout(entry.timerId);
      if (entry.intervalId) clearInterval(entry.intervalId);
    }
    this.timers.clear();
  }
}
