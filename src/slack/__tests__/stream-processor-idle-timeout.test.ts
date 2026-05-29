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

import {
  POST_RESULT_DRAIN_MS,
  readIdleTimeoutMs,
  type StreamCallbacks,
  type StreamContext,
  StreamProcessor,
} from '../stream-processor';

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

/**
 * Phase 7 of turn-end-surface-guarantee:
 *   C-7 — the SDK `result` (SDKResultMessage) is the turn-terminal signal.
 *   `process()` must finalize the turn on `result` regardless of whether the
 *   SDK ever closes the iterator afterwards.
 *
 * Prod incident (2026-05-29, iq-64 dev): a 19-min / $82 turn emitted a
 * `result` (subtype:"success", hasResult:true), posted its final answer to
 * Slack, then the SDK async generator NEVER closed — `iterator.next()` for
 * the terminal `done` hung. The loop sat in raceNextStep until the 2h idle
 * timer fired a SPURIOUS ⚫ stall card; the completion card / idle transition
 * (post-loop `onUsageUpdate`) never ran, leaving the session pinned in MAIN.
 *
 * The pre-existing "normal completion" test masked this: its mock returns
 * `done:true` right after `result` (a COOPERATIVE SDK). Production's SDK does
 * not reliably close after `result` on long turns.
 *
 * Contract pinned here: on `result`, the loop finalizes via a bounded
 * post-result drain (POST_RESULT_DRAIN_MS) — NOT the 2h idle timer — and
 * returns `aborted:false` (healthy completion), draining any trailing
 * SDK events that arrive inside the bounded window.
 * Trace: docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md §C-7.
 */
describe('StreamProcessor — result is the turn-terminal signal (C-7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Yields one `result` then hangs forever — models the SDK that never
   *  closes its generator after the terminal result. No `return()` method,
   *  so the no-return-method branch of tryReturnIterator is exercised. */
  function resultThenHangStream(resultMsg: any): AsyncIterable<any> {
    let sent = false;
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (!sent) {
              sent = true;
              return Promise.resolve({ value: resultMsg, done: false });
            }
            return new Promise<IteratorResult<any>>(() => {
              /* SDK never closes after result */
            });
          },
        };
      },
    };
  }

  const resultMsg = () => ({
    type: 'result',
    subtype: 'success',
    modelUsage: {
      'claude-test': { inputTokens: 1, outputTokens: 1, costUSD: 1, contextWindow: 1000 },
    },
  });

  it('finalizes (aborted=false) when the SDK yields result then never closes — no false idle-timeout/stall', async () => {
    const onIdleTimeout = vi.fn();
    const onUsageUpdate = vi.fn();
    // idleTimeoutMs is the 2h-analog here: the OLD code could ONLY escape the
    // post-result hang via this timer (firing a spurious stall). The fix must
    // finalize via the bounded drain FIRST, long before the idle timer.
    const processor = new StreamProcessor({ onIdleTimeout, onUsageUpdate }, { idleTimeoutMs: 60_000 });

    const promise = processor.process(resultThenHangStream(resultMsg()), baseContext(), new AbortController().signal);

    let settled = false;
    promise.then(() => {
      settled = true;
    });

    // Advance past the bounded drain window but NOT past the 60s idle timer.
    await vi.advanceTimersByTimeAsync(POST_RESULT_DRAIN_MS + 100);
    await Promise.resolve();

    // RED before fix: still pending here (only the 60s idle timer would free
    // it, and that fires onIdleTimeout + returns aborted:true).
    expect(settled).toBe(true);

    const result = await promise;
    expect(result.aborted).toBe(false);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    // Post-loop finalization ran → completion card / idle transition path.
    expect(onUsageUpdate).toHaveBeenCalledTimes(1);
  });

  it('drains a trailing event that arrives after result, then finalizes (no dropped events)', async () => {
    const onUsageUpdate = vi.fn();
    const msgs = [resultMsg(), { type: 'system', subtype: 'trailing-observability' }];
    let i = 0;
    const stream: AsyncIterable<any> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (i < msgs.length) {
              return Promise.resolve({ value: msgs[i++], done: false });
            }
            return new Promise<IteratorResult<any>>(() => {
              /* hang after trailing event */
            });
          },
        };
      },
    };

    const processor = new StreamProcessor({ onUsageUpdate }, { idleTimeoutMs: 60_000 });
    const promise = processor.process(stream, baseContext(), new AbortController().signal);

    await vi.advanceTimersByTimeAsync(POST_RESULT_DRAIN_MS + 100);
    const result = await promise;

    expect(result.aborted).toBe(false);
    // Both the result and the trailing system event were consumed (i advanced
    // past both) before the bounded drain finalized the turn.
    expect(i).toBe(2);
    expect(onUsageUpdate).toHaveBeenCalledTimes(1);
  });

  it('result followed by a cooperative done:true still finalizes immediately (no drain latency)', async () => {
    const onIdleTimeout = vi.fn();
    const onUsageUpdate = vi.fn();
    let phase = 0;
    const stream: AsyncIterable<any> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            phase += 1;
            if (phase === 1) return Promise.resolve({ value: resultMsg(), done: false });
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };

    const processor = new StreamProcessor({ onIdleTimeout, onUsageUpdate }, { idleTimeoutMs: 60_000 });
    const result = await processor.process(stream, baseContext(), new AbortController().signal);

    expect(result.aborted).toBe(false);
    expect(onUsageUpdate).toHaveBeenCalledTimes(1);

    // The cooperative `done` resolved the race; the drain timer must have been
    // cleared and must never fire late.
    await vi.advanceTimersByTimeAsync(POST_RESULT_DRAIN_MS + 60_000);
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
