/**
 * UsageRefreshScheduler — boot-time tick wrapper around
 * `TokenManager.fetchUsageForAllAttached` (#641 M1-S1).
 *
 * Why a separate module:
 *   - TokenManager is already ~1400 lines and carries enough responsibility.
 *     A periodic pump has no new persistence semantics — it is a thin
 *     scheduled caller that can be injected / stopped independently for
 *     tests and graceful shutdown.
 *   - Injectable `clock` (setInterval / clearInterval) means the scheduler
 *     is fully deterministic under a fake clock — a property the Node
 *     timer primitives do not offer directly.
 *
 * Invariant (locked by test in `usage-scheduler.test.ts`):
 *   The scheduler tick MUST NOT pass `force: true` to
 *   `fetchUsageForAllAttached`. A force-propagating pump bypasses every
 *   slot's `nextUsageFetchAllowedAt` gate on every tick, which translates
 *   to a self-inflicted DDoS against Anthropic's usage endpoint when the
 *   default 2-minute per-slot cooldown is in effect.
 */

import { Logger } from '../logger';
import type { TokenManager } from '../token-manager';

const logger = new Logger('UsageRefreshScheduler');

/**
 * Options for the scheduler. All fields except `intervalMs` are optional;
 * `clock` is an injection seam used by tests to avoid real setInterval.
 */
export interface UsageSchedulerOpts {
  /** Interval between ticks, ms. Defaults to 5 * 60_000 via config wiring. */
  intervalMs: number;
  /** Per-fan-out deadline (ms) forwarded to `fetchUsageForAllAttached`. */
  timeoutMs?: number;
  /** When false, `startUsageRefreshScheduler` returns null and never starts. */
  enabled?: boolean;
  /** Injection seam for tests (fake clock). Default: Node's setInterval. */
  clock?: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (h: ReturnType<typeof setInterval>) => void;
  };
}

/**
 * Thin scheduler that pumps `TokenManager.fetchUsageForAllAttached` on a
 * fixed interval. Re-entrancy-safe: if a previous tick's async work has
 * not yet resolved when the next interval fires, the scheduler simply
 * kicks off another one — the TM already de-dupes per-keyId in-flight
 * fetches via `usageFetchInFlight`.
 */
export class UsageRefreshScheduler {
  readonly #tm: TokenManager;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #clock: NonNullable<UsageSchedulerOpts['clock']>;
  #handle: ReturnType<typeof setInterval> | null = null;

  constructor(tm: TokenManager, opts: UsageSchedulerOpts) {
    this.#tm = tm;
    this.#intervalMs = opts.intervalMs;
    this.#timeoutMs = opts.timeoutMs ?? 2_000;
    this.#clock = opts.clock ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h),
    };
  }

  /** Start pumping. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.#handle) return;
    this.#handle = this.#clock.setInterval(() => {
      // Fire-and-forget. tickNow() absorbs any error so a throw inside
      // fetchUsageForAllAttached never propagates into the timer thread.
      void this.tickNow();
    }, this.#intervalMs);
    // Don't keep Node alive solely for this timer when running inside
    // scripts/tests. The real bot process is held alive by Slack /
    // HTTP servers anyway.
    const h = this.#handle as unknown as { unref?: () => void };
    if (typeof h?.unref === 'function') h.unref();
  }

  /**
   * Stop pumping. Safe to call multiple times.
   *
   * KNOWN LIMITATION: does NOT await an in-flight tickNow() — a tick fired
   * just before stop() may settle after. Production is safe (fan-out has
   * its own timeout and no post-resolve side effects); tests needing that
   * guarantee must await the in-flight promise directly.
   * TODO(#644 M2): optional drain() for bounded graceful shutdown.
   */
  stop(): void {
    if (!this.#handle) return;
    this.#clock.clearInterval(this.#handle);
    this.#handle = null;
  }

  /**
   * Run one tick synchronously and return the awaitable promise. Tests use
   * this after poking the fake clock; production reaches it only via the
   * interval closure. Errors are logged and swallowed so the next tick
   * still fires.
   *
   * INVARIANT: never pass `force: true` — see module header.
   */
  async tickNow(): Promise<void> {
    // Capture start time so the failure log distinguishes a fast reject
    // from a timeout stall (durationMs vs configured timeoutMs).
    const startedAt = Date.now();
    try {
      await this.#tm.fetchUsageForAllAttached({ timeoutMs: this.#timeoutMs });
    } catch (err) {
      logger.warn('usage refresh tick failed (next interval will retry)', {
        err,
        durationMs: Date.now() - startedAt,
        timeoutMs: this.#timeoutMs,
        intervalMs: this.#intervalMs,
      });
    }
  }
}

/**
 * Factory. Returns `null` when `opts.enabled === false` so the caller
 * does not need to branch on the feature flag. Production call site is
 * `src/index.ts` after `runPreflightChecks()`.
 */
export function startUsageRefreshScheduler(tm: TokenManager, opts: UsageSchedulerOpts): UsageRefreshScheduler | null {
  if (opts.enabled === false) {
    logger.info('usage refresh scheduler disabled (USAGE_REFRESH_ENABLED=0)');
    return null;
  }
  const scheduler = new UsageRefreshScheduler(tm, opts);
  scheduler.start();
  logger.info('usage refresh scheduler started', {
    intervalMs: opts.intervalMs,
    timeoutMs: opts.timeoutMs ?? 2_000,
  });
  return scheduler;
}
