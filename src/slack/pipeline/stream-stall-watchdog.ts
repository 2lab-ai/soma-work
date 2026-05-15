/**
 * Per-stream watchdog that fires a single `abort()` call after a configurable
 * window of no `touch()` activity. Used by StreamExecutor to auto-abort a hung
 * SDK stream with the `'stall-timeout'` reason so handleError surfaces the
 * 🔴 "오류 발생" terminal card instead of the thread reading half-finished
 * forever.
 *
 * Companion to:
 *  - PR #912: `RequestAbortReason` union + abort-reason plumbing.
 *  - PR #923: enrichment-rail terminal card guarantee.
 *  - PR #924: dispatcher-level stall heuristic on next-message arrival.
 *
 * Codex decision (session `2a332a29-23ae-4fda-933f-b33ebd365ddc`, 2026-05-14):
 * default 10 minutes, configurable via `SOMA_STREAM_STALL_TIMEOUT_MS`, `<= 0`
 * disables; invalid env values fall back to the default. The watchdog must
 * `unref()` its timer so it can never keep the Node process alive at
 * shutdown.
 *
 * Trace: docs/turn-end-surface-guarantee/trace.md, S4 (stall-timeout arm).
 */

/** Default stall window — 10 min. Long-running tools (Playwright sweep,
 *  big grep, Docker pull) routinely stay quiet for several minutes; 10
 *  minutes only trips on genuine hangs. */
export const DEFAULT_STALL_TIMEOUT_MS = 600_000;

/** Env var operators can use to tune or disable the watchdog without a
 *  redeploy. `0` disables; invalid/non-finite values fall back to the
 *  default. */
export const STALL_TIMEOUT_ENV_VAR = 'SOMA_STREAM_STALL_TIMEOUT_MS';

/**
 * Read the configured stall timeout from `process.env`.
 *
 * Operator contract:
 *  - unset → `DEFAULT_STALL_TIMEOUT_MS`
 *  - `0` (or any non-positive number) → disables the watchdog
 *  - invalid/non-finite → falls back to `DEFAULT_STALL_TIMEOUT_MS`
 *  - positive integer → that many ms
 *
 * The "invalid → default" branch is deliberate: a typo'd env var should
 * not silently disable the safety net. A typo'd `0` (with zero) is
 * unlikely; operators who want it off can set exactly `0`.
 */
export function readStallTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[STALL_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_STALL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_STALL_TIMEOUT_MS;
  if (parsed <= 0) return 0; // explicit disable
  return Math.floor(parsed);
}

interface WatchdogLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export class StreamStallWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fired = false;
  /**
   * Tool-use ids whose `tool_result` has not yet been observed. While this
   * set is non-empty, the silence timer is suspended — the SDK is
   * legitimately blocked waiting for a tool result, NOT hung. Each pending
   * tool owns its own timeout (MCP `timeoutMs`, Bash watchdog, sub-agent
   * budget); the stall watchdog only guards SDK-level silence with nothing
   * in flight.
   *
   * Tracking by id (not by count) makes lifecycle bookkeeping idempotent:
   * a duplicate `beginToolCall('x')` cannot bump a phantom counter, and a
   * spurious `endToolCall('unknown')` from a retry / stale event cannot
   * underflow into "all tools done → re-arm".
   */
  private readonly pendingTools = new Set<string>();

  constructor(
    /** Window of no `touch()` after which `abort` fires. `<= 0` disables. */
    private readonly timeoutMs: number,
    /** Single-shot abort. Codex P4: must target the local turn controller,
     *  NOT route through RequestCoordinator, so a stale watchdog firing
     *  after the turn moved on doesn't abort a newer controller. */
    private readonly abort: () => void,
    private readonly logger?: WatchdogLogger,
  ) {}

  /**
   * Start (or restart) the silence timer. Called once at turn start and
   * again from every `touch()`. No-op after the watchdog has already fired
   * — first abort wins, defense-in-depth against a re-arm-after-fire bug
   * spawning a second abort. Also a no-op while any tool is in flight, so
   * an interleaved `arm()` (e.g. from a stray `touch()` racing with a tool
   * gap) cannot defeat the suspension owned by `beginToolCall`.
   */
  arm(): void {
    if (this.fired) return;
    if (this.timeoutMs <= 0) return; // disabled
    if (this.pendingTools.size > 0) return; // suspended — tool in flight
    this.clear();
    this.timer = setTimeout(() => this.fire(), this.timeoutMs);
    // Watchdog is a fail-safe; it must not keep Node alive at shutdown.
    // `unref` is missing on browser/jsdom timers and on the stub object
    // some tests return — guard with a typeof check rather than `unref?.()`
    // (the object lookup itself is fine, but linters tend to flag the
    // optional-chained call form as unnecessary).
    if (typeof (this.timer as { unref?: () => void } | undefined)?.unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  /**
   * Reset the silence timer. Call on every SDK stream event (assistant
   * delta, tool_use, tool_result, system message, etc). After firing,
   * `touch()` is a no-op so a late event doesn't extend a dead turn.
   * While a tool is in flight `touch()` is also a no-op — suspension is
   * owned by `beginToolCall` / `endToolCall`, and we must not let a chatty
   * mid-tool SDK event (system message, partial assistant delta) defeat it.
   */
  touch(): void {
    if (this.fired) return;
    if (this.pendingTools.size > 0) return;
    this.arm();
  }

  /**
   * Note that a `tool_use` has been emitted and the SDK is now waiting on
   * its `tool_result`. Suspends the silence timer for the duration of this
   * (and any other concurrent) pending tool call.
   *
   * Why: the SDK emits NO stream events between `tool_use` and `tool_result`,
   * so a single long-running tool (codex / gemini MCP with `timeoutMs:
   * 600_000`, big grep, Playwright sweep) would otherwise trip the
   * watchdog at exactly the stall window. Per-tool timeouts already handle
   * tool-level hangs; the stall watchdog's job is only "SDK silent with
   * nothing pending".
   *
   * Idempotent on duplicate ids — a re-emitted tool_use (rare but possible
   * during stream replay) does not over-count.
   */
  beginToolCall(id: string): void {
    if (this.fired) return;
    if (this.timeoutMs <= 0) return; // disabled — nothing to suspend
    if (this.pendingTools.has(id)) return; // dedup
    this.pendingTools.add(id);
    // Cancel the current timer for the duration of this (and any other)
    // pending tool. We re-arm in `endToolCall` once the last one finishes.
    this.clear();
  }

  /**
   * Note that a `tool_result` matching `id` has arrived. When this drains
   * the pending set, re-arms the silence timer with a fresh window — a
   * post-tool SDK silence must still surface a terminal card. No-op when:
   *   - the watchdog has already fired,
   *   - the watchdog is disabled (`timeoutMs <= 0`),
   *   - `id` is not in the pending set (unknown / duplicate / out-of-order).
   *
   * The "unknown id" branch is critical: a spurious `endToolCall` must not
   * be misread as "all tools done → re-arm", which would clobber a healthy
   * suspension or spawn a duplicate timer.
   */
  endToolCall(id: string): void {
    if (this.fired) return;
    if (this.timeoutMs <= 0) return;
    if (!this.pendingTools.delete(id)) return;
    if (this.pendingTools.size === 0) {
      this.arm();
    }
  }

  /**
   * Cancel the watchdog (turn completed / errored / aborted via a different
   * path). Safe to call multiple times.
   *
   * Note: `clear()` cancels the TIMER, not the `pendingTools` set. The
   * watchdog instance is per-turn and discarded immediately after the outer
   * `finally`, so leaving the set populated is harmless.
   */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private fire(): void {
    if (this.fired) return;
    this.fired = true;
    this.timer = undefined;
    this.logger?.warn('Stream stall watchdog fired', { timeoutMs: this.timeoutMs });
    try {
      this.abort();
    } catch (err) {
      // Abort closure throws should NOT crash the timer callback; log so
      // operators can triage abort-side failures separately from the
      // trigger.
      this.logger?.warn('Stream stall watchdog abort threw', {
        error: (err as { message?: string })?.message ?? String(err),
      });
    }
  }
}
