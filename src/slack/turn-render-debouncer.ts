import { Logger } from '../logger';

interface PendingEntry {
  fn: () => Promise<void>;
  /** Undefined while the fn is held for a currently-in-flight run on this key. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Trailing-edge debouncer keyed by an arbitrary K (turnId in practice).
 *
 * Guarantees:
 *   1. Rapid schedule(key, fn) calls coalesce into a single tail invocation
 *      fired `delayMs` after the last schedule on that key.
 *   2. Each schedule() replaces the pending fn — the newest snapshot wins.
 *      This matches P2's "full-snapshot rerender" invariant: TodoWrite sends
 *      the entire todo list each tick, so a newer callback supersedes older
 *      ones without loss of information.
 *   3. In-flight lock: if a tail fn is currently executing, new schedule()
 *      calls queue a fresh tail trigger after the current run completes. No
 *      two runs for the same key ever overlap.
 *   4. flush(key) drains pending immediately (no wait). Useful for
 *      TurnSurface.end() to render the final todo state synchronously.
 *   5. cancel(key) drops pending without firing fn.
 *   6. Internal maps are cleared after the tail invocation settles so long-
 *      running processes don't accumulate state per-turn.
 *   7. fn errors are logged but do not poison the key — the next schedule()
 *      on that key starts fresh.
 */
export class TurnRenderDebouncer<K> {
  private logger = new Logger('TurnRenderDebouncer');

  /** Pending per-key state: the latest fn + an optional active timer. */
  private pending = new Map<K, PendingEntry>();

  /**
   * Keys whose tail fn is currently running. schedule() arriving for a key in
   * this set stashes the new fn (timer=undefined); runFn() re-arms a tail
   * timer when it finishes and finds a queued entry.
   */
  private running = new Set<K>();

  constructor(private delayMs: number = 500) {}

  /**
   * Schedule a trailing-edge invocation of `fn` for `key`.
   *
   * - If a timer is pending, it is cancelled and replaced with a fresh one
   *   armed for `delayMs` from now.
   * - If a previous fn is in-flight on this key, the new fn is held without a
   *   timer; runFn() re-arms after the running fn resolves.
   */
  schedule(key: K, fn: () => Promise<void>): void {
    const existing = this.pending.get(key);
    if (existing?.timer !== undefined) {
      clearTimeout(existing.timer);
    }

    if (this.running.has(key)) {
      // In-flight: stash fn; runFn() will arm a tail timer after completion.
      this.pending.set(key, { fn });
      return;
    }

    const timer = setTimeout(() => {
      void this.fire(key);
    }, this.delayMs);
    this.pending.set(key, { fn, timer });
  }

  /**
   * Drain pending immediately — cancel the timer, run the fn synchronously
   * (as far as async/await allows). Safe to call on an empty key.
   */
  async flush(key: K): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.pending.delete(key);
    await this.runFn(key, entry.fn);
  }

  /** Drop pending without firing fn. No-op if nothing pending. */
  cancel(key: K): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.pending.delete(key);
  }

  /** Timer-driven tail fire. */
  private async fire(key: K): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    await this.runFn(key, entry.fn);
  }

  /**
   * Execute fn under the in-flight lock. On completion, if any schedule()
   * landed while we were running, re-arm the timer with the newest fn.
   */
  private async runFn(key: K, fn: () => Promise<void>): Promise<void> {
    this.running.add(key);
    try {
      await fn();
    } catch (err) {
      this.logger.warn('debounced fn threw', {
        error: (err as Error).message,
      });
    } finally {
      this.running.delete(key);
      const queued = this.pending.get(key);
      if (queued && queued.timer === undefined) {
        const timer = setTimeout(() => {
          void this.fire(key);
        }, this.delayMs);
        this.pending.set(key, { fn: queued.fn, timer });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test-only helpers
  // -------------------------------------------------------------------------

  /** @internal */
  _hasPending(key: K): boolean {
    return this.pending.has(key);
  }

  /** @internal */
  _isInFlight(key: K): boolean {
    return this.running.has(key);
  }
}
