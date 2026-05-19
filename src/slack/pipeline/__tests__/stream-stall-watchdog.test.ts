/**
 * Unit tests for StreamStallWatchdog — the per-stream timer that auto-
 * aborts an SDK stream after N ms of silence so a hung turn surfaces a
 * 🔴 "오류 발생" terminal card instead of leaving the thread half-finished.
 *
 * Trace: docs/current/plans/turn-end-surface-guarantee/trace.md, S4 (stall-timeout arm).
 * Companion to PR #924 (dispatcher heuristic on next-message arrival) —
 * this watchdog fires WITHOUT waiting for the user to displace the turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamStallWatchdog } from '../stream-stall-watchdog';

describe('StreamStallWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires abort after timeoutMs of silence (no touch())', () => {
    const abort = vi.fn();
    const wd = new StreamStallWatchdog(1000, abort);

    wd.arm();
    expect(abort).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(abort).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('touch() resets the countdown — abort fires from the LAST touch+timeoutMs', () => {
    const abort = vi.fn();
    const wd = new StreamStallWatchdog(1000, abort);

    wd.arm();
    vi.advanceTimersByTime(500); // 500ms into the first window
    wd.touch(); // resets — window restarts at this point
    vi.advanceTimersByTime(500); // 500ms into the new window
    expect(abort).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500); // total 1000ms since the last touch
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('clear() cancels the pending abort', () => {
    const abort = vi.fn();
    const wd = new StreamStallWatchdog(1000, abort);

    wd.arm();
    wd.clear();
    vi.advanceTimersByTime(5000);

    expect(abort).not.toHaveBeenCalled();
  });

  it('disabled when timeoutMs <= 0 — never fires', () => {
    const abort = vi.fn();
    const wd = new StreamStallWatchdog(0, abort);

    wd.arm();
    wd.touch();
    vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour

    expect(abort).not.toHaveBeenCalled();
  });

  it('idempotent — already-fired watchdog never fires twice', () => {
    const abort = vi.fn();
    const wd = new StreamStallWatchdog(100, abort);

    wd.arm();
    vi.advanceTimersByTime(100);
    expect(abort).toHaveBeenCalledTimes(1);

    // touch() after firing is a no-op — must not re-arm.
    wd.touch();
    vi.advanceTimersByTime(500);
    expect(abort).toHaveBeenCalledTimes(1);

    // arm() after firing is also a no-op — defense-in-depth against
    // double-abort if someone re-arms us by accident.
    wd.arm();
    vi.advanceTimersByTime(500);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing abort() — logs warn, does not crash', () => {
    const abort = vi.fn(() => {
      throw new Error('abort exploded');
    });
    const warn = vi.fn();
    const wd = new StreamStallWatchdog(100, abort, { warn });

    wd.arm();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    // First warn is the "stream stall watchdog fired" log; the abort throw
    // adds a second warn so operators can triage abort-side failures
    // separately from the trigger.
    const messages = warn.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => /stall/i.test(m))).toBe(true);
    expect(messages.some((m) => /abort threw/i.test(m))).toBe(true);
  });

  it('calls timer.unref so the watchdog cannot keep Node alive', () => {
    // We can't easily observe unref() through fake timers, but we can lock
    // in that the watchdog DOES try to call it on whatever object setTimeout
    // returns. Stub global setTimeout to return an object whose unref is a
    // spy.
    const unref = vi.fn();
    const stubTimer = { unref };
    const origSetTimeout = globalThis.setTimeout;
    // @ts-expect-error overriding setTimeout for the duration of this test
    globalThis.setTimeout = vi.fn(() => stubTimer);

    try {
      const wd = new StreamStallWatchdog(1000, vi.fn());
      wd.arm();
      expect(unref).toHaveBeenCalledTimes(1);

      // touch() rearms — should call unref again on the new timer
      wd.touch();
      expect(unref).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});
