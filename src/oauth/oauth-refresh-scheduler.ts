/**
 * OAuthRefreshScheduler — boot-time tick wrapper around
 * `TokenManager.refreshAllAttachedOAuthTokens` (#653 M2).
 *
 * Purpose:
 *   Every registered OAuth-attached CCT slot gets its access_token
 *   force-refreshed on a fixed cadence (default 1 hour), regardless of
 *   whether the SDK dispatch path has touched it. This guarantees:
 *     - Stale `refreshToken` gets surfaced as `refresh_failed` within
 *       one tick (1h) rather than waiting for the next dispatch.
 *     - `subscriptionType` / `rateLimitTier` mutations on the Anthropic
 *       side propagate to the local snapshot within 1h.
 *     - The "OAuth refreshes in X" hint on the card matches the
 *       scheduler's actual cadence — users stop seeing week-old hints
 *       on idle slots.
 *
 * Why a separate module (not folded into UsageRefreshScheduler):
 *   - Different cadence — usage needs 5min ticks to stay fresh, OAuth
 *     tokens have 8h TTLs and hourly refresh is the right cost/benefit
 *     balance (8x redundancy against 1 missed tick).
 *   - Different semantics — usage fan-out respects per-slot throttles
 *     (`nextUsageFetchAllowedAt`); OAuth refresh has no such throttle
 *     (the Anthropic endpoint has its own server-side rate limit, and
 *     we expect <50 slots per bot).
 *   - Failure surface — a usage tick failure is silently backed off;
 *     an OAuth refresh failure marks the slot's authState, which is
 *     a durable signal we want visible in logs.
 *
 * Invariant (locked by test in `oauth-refresh-scheduler.test.ts`):
 *   The scheduler must NEVER be disabled silently. `enabled: false`
 *   returns null + logs a warning so operators notice the missing
 *   background refresh (which is what lets stale refreshTokens
 *   eventually surface). Default is ON.
 */

import { Logger } from '../logger';
import type { TokenManager } from '../token-manager';

const logger = new Logger('OAuthRefreshScheduler');

/** Default 1 hour between ticks — the user spec explicitly calls this out. */
export const DEFAULT_OAUTH_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
/** Default 30s per-fan-out deadline (`refreshClaudeCredentials` has its own 10s timeout per slot). */
export const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 30_000;

export interface OAuthRefreshSchedulerOpts {
  /** Interval between ticks, ms. */
  intervalMs: number;
  /** Per-fan-out deadline (ms) forwarded to `refreshAllAttachedOAuthTokens`. */
  timeoutMs?: number;
  /** When false, the factory returns null and never starts. */
  enabled?: boolean;
  /** Injection seam for tests (fake clock). Default: Node's setInterval. */
  clock?: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (h: ReturnType<typeof setInterval>) => void;
  };
  /**
   * #737 — invoked AFTER every successful (or failed) refresh fan-out
   * settles, in the same tick. Production wiring: auto CCT rotation
   * evaluator. Errors are caught and logged so they cannot kill the
   * scheduler. The hook runs sequentially after refresh — never
   * concurrently — so it can read the freshly-refreshed snapshot
   * without racing the refresh writes.
   *
   * KEEP THIS OPTIONAL: tests that don't care about auto-rotation
   * shouldn't have to stub out a no-op callback.
   */
  onAfterTick?: () => Promise<void>;
}

/**
 * Thin scheduler that pumps `TokenManager.refreshAllAttachedOAuthTokens`
 * on a fixed interval. Re-entrancy-safe: if a previous tick's async
 * work hasn't resolved when the next interval fires, the scheduler kicks
 * off another tick — the TokenManager's per-keyId `refreshInFlight`
 * dedupe (composite key: `${keyId}:${attachedAt}`) ensures overlapping
 * ticks share in-flight HTTP calls rather than stacking them.
 */
export class OAuthRefreshScheduler {
  readonly #tm: TokenManager;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #clock: NonNullable<OAuthRefreshSchedulerOpts['clock']>;
  readonly #onAfterTick: (() => Promise<void>) | undefined;
  #handle: ReturnType<typeof setInterval> | null = null;

  constructor(tm: TokenManager, opts: OAuthRefreshSchedulerOpts) {
    this.#tm = tm;
    this.#intervalMs = opts.intervalMs;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_OAUTH_REFRESH_TIMEOUT_MS;
    this.#clock = opts.clock ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h),
    };
    this.#onAfterTick = opts.onAfterTick;
  }

  /** Start pumping. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.#handle) return;
    this.#handle = this.#clock.setInterval(() => {
      void this.tickNow();
    }, this.#intervalMs);
    // Don't keep Node alive solely for this timer under scripts / tests.
    const h = this.#handle as unknown as { unref?: () => void };
    if (typeof h?.unref === 'function') h.unref();
  }

  /**
   * Stop pumping. Safe to call multiple times.
   *
   * KNOWN LIMITATION (mirrors UsageRefreshScheduler): does NOT await an
   * in-flight tickNow() — a tick fired just before stop() may settle
   * after. Production is safe because (a) the fan-out has its own
   * timeoutMs deadline and (b) the only side effect is a store mutate
   * which is itself atomic under CAS.
   */
  stop(): void {
    if (!this.#handle) return;
    this.#clock.clearInterval(this.#handle);
    this.#handle = null;
  }

  /**
   * Run one tick synchronously and return the awaitable promise. Tests
   * use this after poking the fake clock; production reaches it only
   * via the interval closure. Errors are logged and swallowed so the
   * next tick still fires.
   */
  async tickNow(): Promise<void> {
    const startedAt = Date.now();
    try {
      const results = await this.#tm.refreshAllAttachedOAuthTokens({
        timeoutMs: this.#timeoutMs,
      });
      const total = Object.keys(results).length;
      const errors = Object.values(results).filter((r) => r === 'error').length;
      logger.info('OAuth refresh tick complete', {
        total,
        ok: total - errors,
        errors,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      logger.warn('OAuth refresh tick failed (next interval will retry)', {
        err,
        durationMs: Date.now() - startedAt,
        timeoutMs: this.#timeoutMs,
        intervalMs: this.#intervalMs,
      });
    }
    // #737 — auto-rotation hook. Runs even if the refresh fan-out
    // failed, because rotation only depends on the persisted snapshot:
    // a stale tick still has the previous snapshot's usage to work with,
    // and skipping rotation on every refresh hiccup would defeat the
    // hourly cadence the user spec calls out.
    if (this.#onAfterTick) {
      try {
        await this.#onAfterTick();
      } catch (err) {
        logger.warn('OAuth refresh tick onAfterTick hook threw (swallowed)', {
          err,
        });
      }
    }
  }
}

/**
 * Factory. Returns `null` when `opts.enabled === false` so the caller
 * does not need to branch on the feature flag. Mirrors the
 * `startUsageRefreshScheduler` contract so bootstrap wiring reads
 * identically for both schedulers.
 */
export function startOAuthRefreshScheduler(
  tm: TokenManager,
  opts: OAuthRefreshSchedulerOpts,
): OAuthRefreshScheduler | null {
  if (opts.enabled === false) {
    logger.warn(
      'OAuth refresh scheduler DISABLED (OAUTH_REFRESH_ENABLED=0). ' +
        'Stale refreshTokens will not be surfaced until next dispatch touches the slot.',
    );
    return null;
  }
  const scheduler = new OAuthRefreshScheduler(tm, opts);
  scheduler.start();
  logger.info('OAuth refresh scheduler started', {
    intervalMs: opts.intervalMs,
    timeoutMs: opts.timeoutMs ?? DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
  });
  return scheduler;
}
