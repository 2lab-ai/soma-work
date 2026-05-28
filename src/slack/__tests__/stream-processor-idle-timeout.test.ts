/**
 * Phase 2 of turn-end-surface-guarantee:
 *   C-1 fix — `StreamProcessor.process` must surface a terminal signal
 *   when the SDK iterator's `.next()` never resolves.
 *
 * The previous fail-safe (PR #926 `StreamStallWatchdog`) sat OUTSIDE the
 * stuck `.next()` await and depended on the SDK honoring an abort signal
 * to unblock the iterator. When the SDK ignored the abort, the watchdog
 * fired but the executor still hung on `await processor.process(...)`.
 * Trace: docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md §C-1.
 *
 * This file pins the new contract: `StreamProcessor` races each
 * `iterator.next()` against an idle-timeout. When the timer wins, it
 * calls `onIdleTimeout()` (executor wires this to
 * `abortController.abort('stall-timeout')`) and returns with
 * `aborted: true` — even if the underlying SDK never honors the abort.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readIdleTimeoutMs, type StreamCallbacks, type StreamContext, StreamProcessor } from '../stream-processor';

const baseContext = (): StreamContext => ({
  channel: 'C1',
  threadTs: 'T1',
  sessionKey: 'C1:T1',
  sessionId: 's1',
  say: vi.fn().mockResolvedValue({ ts: 'm' }) as unknown as StreamContext['say'],
});

/** Async iterable whose `.next()` never resolves — simulates a hung SDK stream. */
function neverYieldingStream(): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise(() => {
            /* never resolves */
          });
        },
      };
    },
  };
}

describe('StreamProcessor — idle timeout (C-1 replacement for PR #926 watchdog)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires onIdleTimeout and returns aborted=true when iterator.next() never resolves', async () => {
    const onIdleTimeout = vi.fn();
    const callbacks: StreamCallbacks = { onIdleTimeout };
    const processor = new StreamProcessor(callbacks, { idleTimeoutMs: 1000 });

    const abortController = new AbortController();
    const promise = processor.process(neverYieldingStream(), baseContext(), abortController.signal);

    // Advance past the idle threshold. The race resolves with the
    // timeout branch, onIdleTimeout fires, and the loop returns.
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;

    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
  });

  it('does not idle-timeout while the iterator keeps yielding (each yield resets the timer)', async () => {
    const onIdleTimeout = vi.fn();
    // Three sparse text messages then a hang. With idleTimeoutMs=500 and
    // 300ms between yields, the timer should reset on each yield and only
    // fire 500ms after the LAST yield.
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'c' }] } },
    ];

    // Sync generator — three yields resolve immediately (microtask-fast,
    // NOT paced by the fake clock). The timer-reset-per-yield assertion
    // below holds because the generator drains before the test advances
    // any time, so the active idle window is the one armed AFTER the
    // final yield.
    function* pace() {
      yield messages[0];
      yield messages[1];
      yield messages[2];
    }
    const gen = pace();
    const stream: AsyncIterable<any> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const r = gen.next();
            if (!r.done) {
              return { value: r.value, done: false };
            }
            return new Promise(() => {
              /* hang after yields exhausted */
            });
          },
        };
      },
    };

    const processor = new StreamProcessor({ onIdleTimeout }, { idleTimeoutMs: 500 });
    const promise = processor.process(stream, baseContext(), new AbortController().signal);

    // The three yields consume the queue ~immediately. The timer should
    // then fire 500ms after the last yield.
    await vi.advanceTimersByTimeAsync(400);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    await promise;
  });

  it('idleTimeoutMs <= 0 disables the idle timeout entirely', async () => {
    const onIdleTimeout = vi.fn();
    const processor = new StreamProcessor({ onIdleTimeout }, { idleTimeoutMs: 0 });

    const abortController = new AbortController();
    const promise = processor.process(neverYieldingStream(), baseContext(), abortController.signal);

    // Advance well past any conceivable timeout.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(onIdleTimeout).not.toHaveBeenCalled();

    // Tear down explicitly — the iterator is genuinely hung, so without
    // an abort the promise would dangle and could leak into other tests.
    abortController.abort('user-stop');
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(onIdleTimeout).not.toHaveBeenCalled();
  });

  it('external abort while next() is pending exits promptly without waiting for idle timeout', async () => {
    const onIdleTimeout = vi.fn();
    const processor = new StreamProcessor({ onIdleTimeout }, { idleTimeoutMs: 60_000 });

    const abortController = new AbortController();
    const promise = processor.process(neverYieldingStream(), baseContext(), abortController.signal);

    // Abort externally well before the idle timeout would fire.
    abortController.abort('supersede');
    const result = await promise;

    expect(onIdleTimeout).not.toHaveBeenCalled();
    expect(result.aborted).toBe(true);
  });

  it('normal completion clears the idle timer (no late onIdleTimeout fire)', async () => {
    const onIdleTimeout = vi.fn();
    const messages = [{ type: 'result', subtype: 'success', usage: {}, total_cost_usd: 0 }];

    const processor = new StreamProcessor({ onIdleTimeout }, { idleTimeoutMs: 1000 });
    const result = await processor.process(
      // Yield once then end (done:true) — normal completion path.
      (() => {
        let yielded = false;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (!yielded) {
                  yielded = true;
                  return { value: messages[0], done: false };
                }
                return { value: undefined, done: true };
              },
            };
          },
        } as AsyncIterable<any>;
      })(),
      baseContext(),
      new AbortController().signal,
    );

    // No idle-timeout — process completed normally.
    expect(result.aborted).toBe(false);

    // Advance well past the idle window: the cleared timer must not fire.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onIdleTimeout).not.toHaveBeenCalled();
  });
});

describe('readIdleTimeoutMs (env reader for C-1 idle timeout)', () => {
  // 2 h default — raised from 30 min after the 2026-05-28 production
  // false-positive where the assistant emitted a textual "waiting for
  // your response" without firing a formal ASK tool. The SDK iterator
  // was genuinely idle but the turn was healthy; 30 min killed the
  // turn after the user paused to think.
  const DEFAULT_2H = 2 * 60 * 60 * 1000;

  it('returns the 2h default when env unset', () => {
    expect(readIdleTimeoutMs({})).toBe(DEFAULT_2H);
  });

  it('returns the 2h default when env is empty string', () => {
    expect(readIdleTimeoutMs({ SOMA_STREAM_STALL_TIMEOUT_MS: '' })).toBe(DEFAULT_2H);
  });

  it('returns 0 (disabled) when env is explicit 0', () => {
    expect(readIdleTimeoutMs({ SOMA_STREAM_STALL_TIMEOUT_MS: '0' })).toBe(0);
  });

  it('returns 0 (disabled) for any non-positive number', () => {
    expect(readIdleTimeoutMs({ SOMA_STREAM_STALL_TIMEOUT_MS: '-500' })).toBe(0);
  });

  it('falls back to default for invalid (non-finite) env values — typo must not silently disable', () => {
    expect(readIdleTimeoutMs({ SOMA_STREAM_STALL_TIMEOUT_MS: 'oops' })).toBe(DEFAULT_2H);
  });

  it('returns parsed positive int for valid values (operators can still set short windows)', () => {
    expect(readIdleTimeoutMs({ SOMA_STREAM_STALL_TIMEOUT_MS: '90000' })).toBe(90_000);
  });
});
