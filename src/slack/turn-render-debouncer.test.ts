import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnRenderDebouncer } from './turn-render-debouncer';

/**
 * TurnRenderDebouncer unit tests (Issue #525, P2).
 *
 * Invariants under test:
 *   1. Rapid schedule() calls on the same key coalesce into ONE tail invocation
 *      fired `delayMs` after the LAST call.
 *   2. In-flight lock: calls arriving while a previous fn is executing must
 *      get coalesced into a single fresh tail trigger (never overlap).
 *   3. Per-key isolation — work on key "a" doesn't cancel or delay key "b".
 *   4. flush(key) drains pending immediately (useful in TurnSurface.end()).
 *   5. cancel(key) removes pending without invoking fn.
 *   6. State map is cleared after trailing invocation completes (no memory leak).
 */
describe('TurnRenderDebouncer', () => {
  const delayMs = 500;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces 5 rapid calls into 1 tail invocation at delayMs', async () => {
    const debouncer = new TurnRenderDebouncer<string>(delayMs);
    const fn = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 5; i += 1) {
      debouncer.schedule('turn-1', fn);
    }

    // Before delay elapses — no invocation
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(fn).not.toHaveBeenCalled();

    // After delay — exactly one invocation (tail trigger)
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses the latest fn — each schedule() replaces the pending callback', async () => {
    // Matches TurnSurface.renderTasks semantics: each todo-update snapshot is
    // self-sufficient (full state), so the most recent snapshot wins.
    const debouncer = new TurnRenderDebouncer<string>(delayMs);
    const fnOld = vi.fn().mockResolvedValue(undefined);
    const fnNew = vi.fn().mockResolvedValue(undefined);

    debouncer.schedule('turn-1', fnOld);
    debouncer.schedule('turn-1', fnNew);

    await vi.advanceTimersByTimeAsync(delayMs);

    expect(fnOld).not.toHaveBeenCalled();
    expect(fnNew).toHaveBeenCalledTimes(1);
  });

  it('in-flight lock: schedule during fn execution queues one more tail call', async () => {
    const debouncer = new TurnRenderDebouncer<string>(delayMs);
    let releaseFirst: () => void = () => {};
    const firstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstFn = vi.fn().mockReturnValue(firstPromise);
    const secondFn = vi.fn().mockResolvedValue(undefined);

    debouncer.schedule('turn-1', firstFn);
    await vi.advanceTimersByTimeAsync(delayMs);
    expect(firstFn).toHaveBeenCalledTimes(1);
    // firstFn is now in-flight — schedule a second call while locked
    debouncer.schedule('turn-1', secondFn);
    debouncer.schedule('turn-1', secondFn); // extra — still coalesced

    // Release first; second should schedule after
    releaseFirst();
    await firstPromise;
    // Drain any microtask queue work triggered by firstPromise resolution.
    await vi.advanceTimersByTimeAsync(0);

    // Second call must still wait `delayMs` for its own tail trigger
    expect(secondFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(delayMs);
    expect(secondFn).toHaveBeenCalledTimes(1);
  });

  it('flush(key) drains pending immediately (no wait for timer)', async () => {
    const debouncer = new TurnRenderDebouncer<string>(delayMs);
    const fn = vi.fn().mockResolvedValue(undefined);

    debouncer.schedule('turn-1', fn);
    // fn hasn't fired yet
    expect(fn).not.toHaveBeenCalled();

    await debouncer.flush('turn-1');
    expect(fn).toHaveBeenCalledTimes(1);

    // Advance past original delay — no duplicate invocation
    await vi.advanceTimersByTimeAsync(delayMs);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() on an empty key is a safe no-op', async () => {
    const debouncer = new TurnRenderDebouncer<string>(delayMs);
    await expect(debouncer.flush('unknown-turn')).resolves.toBeUndefined();
  });

  it('cancel(key) drops pending without invoking fn', async () => {
    const debouncer = new TurnRenderDebouncer<string>(delayMs);
    const fn = vi.fn().mockResolvedValue(undefined);

    debouncer.schedule('turn-1', fn);
    debouncer.cancel('turn-1');
    await vi.advanceTimersByTimeAsync(delayMs);
    expect(fn).not.toHaveBeenCalled();
  });

  it('per-key isolation — two keys operate independently', async () => {
    const debouncer = new TurnRenderDebouncer<string>(delayMs);
    const fnA = vi.fn().mockResolvedValue(undefined);
    const fnB = vi.fn().mockResolvedValue(undefined);

    debouncer.schedule('A', fnA);
    debouncer.schedule('B', fnB);

    // Cancel A → only B should fire
    debouncer.cancel('A');
    await vi.advanceTimersByTimeAsync(delayMs);
    expect(fnA).not.toHaveBeenCalled();
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('clears internal state after tail invocation completes', async () => {
    const debouncer = new TurnRenderDebouncer<string>(delayMs);
    const fn = vi.fn().mockResolvedValue(undefined);

    debouncer.schedule('turn-1', fn);
    await vi.advanceTimersByTimeAsync(delayMs);
    // Drain the microtask that awaits fn() inside the trailing handler.
    await Promise.resolve();

    expect(debouncer._hasPending('turn-1')).toBe(false);
    expect(debouncer._isInFlight('turn-1')).toBe(false);
  });

  it('fn throwing is logged but does not poison the key — next schedule works', async () => {
    const debouncer = new TurnRenderDebouncer<string>(delayMs);
    const thrower = vi.fn().mockRejectedValue(new Error('boom'));
    const good = vi.fn().mockResolvedValue(undefined);

    debouncer.schedule('turn-1', thrower);
    await vi.advanceTimersByTimeAsync(delayMs);
    // Drain the microtask so the rejection handler completes.
    await Promise.resolve();
    await Promise.resolve();
    expect(thrower).toHaveBeenCalledTimes(1);

    // Key is reusable after error
    debouncer.schedule('turn-1', good);
    await vi.advanceTimersByTimeAsync(delayMs);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
