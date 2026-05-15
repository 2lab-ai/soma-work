/**
 * Unit tests for StreamStallWatchdog — the per-stream timer that auto-
 * aborts an SDK stream after N ms of silence so a hung turn surfaces a
 * 🔴 "오류 발생" terminal card instead of leaving the thread half-finished.
 *
 * Trace: docs/turn-end-surface-guarantee/trace.md, S4 (stall-timeout arm).
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

  // ---------------------------------------------------------------------------
  // Pending-tool suspension — see soma-work follow-up to PR #926.
  //
  // PR #926 added the watchdog with the assumption that `touch()` would fire
  // on every SDK event. That assumption fails for a single long tool call:
  // between the `tool_use` event (SDK pauses to wait for result) and the
  // matching `tool_result` event (SDK resumes), NO SDK events fire. A tool
  // that legitimately runs longer than the stall window (e.g.
  // `mcp__llm__chat` with `timeoutMs: 600_000` reaching its own ceiling)
  // tripped the watchdog and aborted the entire turn, surfacing a misleading
  // "이전 턴이 일정 시간 응답이 없어 중단되었습니다." card even though work
  // was healthy.
  //
  // Fix: `beginToolCall(id)` / `endToolCall(id)`. While any tool is in
  // flight, the watchdog timer is suspended (a tool that owns its own
  // timeout is responsible for its own hang detection). When the last
  // pending tool finishes, the watchdog re-arms with a fresh window so a
  // post-tool SDK silence still surfaces a terminal card.
  // ---------------------------------------------------------------------------
  describe('pending-tool suspension', () => {
    it('does not fire while any tool is in flight, even past timeoutMs', () => {
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(1000, abort);

      wd.arm();
      wd.beginToolCall('tool_1');

      // A real codex MCP call can take 10+ minutes. Simulate one that
      // exceeds the stall window by 60x — the watchdog must stay quiet.
      vi.advanceTimersByTime(60 * 1000);
      expect(abort).not.toHaveBeenCalled();
    });

    it('re-arms with a full window after the last pending tool ends', () => {
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(1000, abort);

      wd.arm();
      wd.beginToolCall('tool_1');
      vi.advanceTimersByTime(5000); // tool ran for 5s (longer than 1s window)
      wd.endToolCall('tool_1');

      // The new window starts NOW — not from `arm()` 5s ago.
      vi.advanceTimersByTime(999);
      expect(abort).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('parallel tools: only resumes after every pending id ends', () => {
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(1000, abort);

      wd.arm();
      wd.beginToolCall('tool_a');
      wd.beginToolCall('tool_b');

      vi.advanceTimersByTime(5000);
      wd.endToolCall('tool_a');

      // tool_b still pending — watchdog must stay suspended.
      vi.advanceTimersByTime(5000);
      expect(abort).not.toHaveBeenCalled();

      wd.endToolCall('tool_b');
      vi.advanceTimersByTime(999);
      expect(abort).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('touch() during a pending tool is a no-op (no premature re-arm)', () => {
      // Regression guard: `onSdkActivity` is allowed to fire even during a
      // tool gap (the SDK can emit a system message, partial assistant
      // delta, etc). If `touch()` re-armed unconditionally, a chatty SDK
      // mid-tool would prematurely reset the timer to "no pending tool"
      // semantics — defeating the suspension.
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(1000, abort);

      wd.arm();
      wd.beginToolCall('tool_1');

      // A burst of stray `touch()` calls during the tool gap.
      for (let i = 0; i < 100; i++) {
        wd.touch();
        vi.advanceTimersByTime(50);
      }
      // 100 * 50 = 5000ms elapsed, but watchdog must stay suspended.
      expect(abort).not.toHaveBeenCalled();

      wd.endToolCall('tool_1');
      // Now the timer starts fresh.
      vi.advanceTimersByTime(999);
      expect(abort).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('endToolCall with unknown id is a no-op (no underflow, no spurious re-arm)', () => {
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(1000, abort);

      wd.arm();
      wd.beginToolCall('tool_1');

      // Spurious endToolCall — duplicate result from a retry, or a bug in
      // the SDK's tool_result emission. Must not affect pending state.
      wd.endToolCall('not_a_real_id');
      wd.endToolCall('tool_1'); // legitimate end — now duplicate to ensure idempotence
      wd.endToolCall('tool_1');

      // Re-arm happened on the first legitimate end. Subsequent duplicates
      // must NOT call clear()+arm() again (which would double-reset).
      vi.advanceTimersByTime(999);
      expect(abort).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('duplicate beginToolCall same id is idempotent (no nested suspension)', () => {
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(1000, abort);

      wd.arm();
      wd.beginToolCall('tool_1');
      wd.beginToolCall('tool_1'); // dedup — must not add a second pending entry

      // One end is enough to resume.
      wd.endToolCall('tool_1');
      vi.advanceTimersByTime(1000);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('clear() while a tool is pending leaves no live timer', () => {
      // Turn-end `finally { stallWatchdog.clear() }` must work whether or
      // not a tool happened to be pending at the moment of clearing.
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(1000, abort);

      wd.arm();
      wd.beginToolCall('tool_1');
      wd.clear();

      vi.advanceTimersByTime(60 * 1000);
      expect(abort).not.toHaveBeenCalled();
    });

    it('fired watchdog ignores subsequent beginToolCall / endToolCall', () => {
      // Defense-in-depth: once we've fired, lifecycle calls from the
      // continuing stream (e.g. a late tool_result arriving after abort)
      // must not re-arm or double-fire.
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(100, abort);

      wd.arm();
      vi.advanceTimersByTime(100);
      expect(abort).toHaveBeenCalledTimes(1);

      wd.beginToolCall('late_tool');
      wd.endToolCall('late_tool');
      vi.advanceTimersByTime(60 * 1000);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('endToolCall with no pending state is a no-op', () => {
      // If somehow endToolCall is called before any beginToolCall (out-of-
      // order events, stale event from a previous turn), it must not be
      // misinterpreted as "all tools done → re-arm".
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(1000, abort);

      wd.arm();
      wd.endToolCall('phantom'); // no pending — must not clear+rearm
      // Original timer must still be on its original schedule.
      vi.advanceTimersByTime(999);
      expect(abort).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('disabled watchdog (timeoutMs <= 0) ignores tool lifecycle calls', () => {
      // When operators set SOMA_STREAM_STALL_TIMEOUT_MS=0, the watchdog is
      // off entirely. Tool calls must not silently re-enable it.
      const abort = vi.fn();
      const wd = new StreamStallWatchdog(0, abort);

      wd.arm();
      wd.beginToolCall('tool_1');
      wd.endToolCall('tool_1');
      vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour

      expect(abort).not.toHaveBeenCalled();
    });
  });
});
