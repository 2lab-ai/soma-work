/**
 * Follow-up yield seam (U4a) — adapter side.
 *
 * The host wants a *safe* point at which an in-flight dispatch can stop
 * continuing and hand control back so a queued follow-up can be dispatched
 * fresh (U4b). The only safe point is a turn that has **fully settled**:
 *
 *   - `StreamExecutor.execute()` has resolved (`v1-query-adapter.ts:195`), and
 *   - `TurnRunner.finish()` has resolved (`v1-query-adapter.ts:253`).
 *
 * Controller-slot absence is NOT a boundary: `stream-executor.ts` `cleanup()`
 * releases the RequestCoordinator slot at line 3702, *before* it awaits the
 * async tool-event cleanup at line 3726. So these tests drive the seam with a
 * deferred `execute()` promise AND a deferred `runner.finish()` promise and
 * assert the gate is not consulted until both have settled.
 *
 * The gate is consulted after each settled turn and BEFORE
 * `handler.shouldContinue`/reset (`v1-query-adapter.ts:132-155`), so a yield
 * cancels the *upcoming* continuation turn, never an in-flight one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnResult, ContinuationHandler } from '../agent-session-types.js';
import { TurnResultCollector } from '../turn-result-collector.js';
import { V1QueryAdapter } from '../v1-query-adapter.js';

function createMockExecuteParams(overrides: Record<string, any> = {}) {
  return {
    session: {} as any,
    sessionKey: 'C1-171.100',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    channel: 'C1',
    threadTs: '171.100',
    user: 'U1',
    say: vi.fn(),
    ...overrides,
  };
}

function createCollector(options: { continuation?: any; endTurn?: AgentTurnResult['endTurn']; text?: string } = {}) {
  const collector = new TurnResultCollector();
  collector.onText(options.text ?? 'Response');
  collector.onEndTurn(options.endTurn ?? { reason: 'end_turn', timestamp: Date.now() });
  if (options.continuation) {
    collector.setContinuation(options.continuation);
  }
  return collector;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** macrotask flush — lets every already-queued microtask chain run to rest */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Continuation handler that agrees to continue at most `maxContinuations`
 * times. The bound is a test-harness safety net: when the yield gate is
 * missing/broken the loop would otherwise spin forever on a mock that always
 * reports a continuation, and an OOM kill hides the real assertion failure.
 */
function boundedHandler(maxContinuations: number, onCall?: () => void): ContinuationHandler & { calls: number } {
  const handler = {
    calls: 0,
    shouldContinue(result: AgentTurnResult) {
      handler.calls++;
      onCall?.();
      const cont = result.continuation as any;
      if (!cont || handler.calls > maxContinuations) return { continue: false };
      return { continue: true, prompt: cont.prompt ?? 'next' };
    },
  };
  return handler;
}

describe('V1QueryAdapter — follow-up yield seam', () => {
  let mockRunner: any;

  beforeEach(() => {
    mockRunner = {
      begin: vi.fn(),
      update: vi.fn(),
      finish: vi.fn(),
      fail: vi.fn(),
    };
  });

  // Boundary: never consult the gate while execute()/finish() are still in flight.
  it('consults the gate only after execute() AND runner.finish() have settled', async () => {
    const executeGate = deferred<any>();
    const finishGate = deferred<void>();
    const execute = vi.fn().mockReturnValue(executeGate.promise);
    mockRunner.finish = vi.fn().mockReturnValue(finishGate.promise);

    const order: string[] = [];
    const shouldYieldToFollowup = vi.fn(async () => {
      order.push('gate');
      return true;
    });
    const handler = boundedHandler(1, () => order.push('shouldContinue'));

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
      shouldYieldToFollowup,
    });

    const pending = adapter.startWithContinuation('Hello', handler);

    await flush();
    // execute() still in flight → no yield opportunity
    expect(shouldYieldToFollowup).not.toHaveBeenCalled();

    executeGate.resolve({
      success: true,
      messageCount: 1,
      turnCollector: createCollector({ continuation: { prompt: 'continue me' } }),
    });
    await flush();
    // runner.finish() still in flight → still no yield opportunity
    expect(mockRunner.finish).toHaveBeenCalledTimes(1);
    expect(shouldYieldToFollowup).not.toHaveBeenCalled();

    finishGate.resolve();
    const result = await pending;

    expect(shouldYieldToFollowup).toHaveBeenCalledTimes(1);
    expect(shouldYieldToFollowup).toHaveBeenCalledWith(expect.objectContaining({ messages: ['Response'] }));
    // Yield short-circuits the continuation decision entirely.
    expect(order).toEqual(['gate']);
    expect(handler.calls).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.messages).toEqual(['Response']);
  });

  // Gate runs once per settled turn, always before the continuation decision.
  it('consults the gate before shouldContinue on every settled turn', async () => {
    const order: string[] = [];
    let callCount = 0;
    const execute = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        success: true,
        messageCount: 1,
        turnCollector: createCollector({ continuation: { prompt: `turn ${callCount + 1}` } }),
      });
    });

    // false on turn 1 (keep looping), true on turn 2 (yield)
    const shouldYieldToFollowup = vi.fn(() => {
      order.push('gate');
      return order.filter((e) => e === 'gate').length === 2;
    });

    // Bound 2: with a working gate only 1 continuation happens; the bound just
    // keeps a broken gate from spinning forever on the always-continuing mock.
    const onResetSession = vi.fn();
    const handler: ContinuationHandler = {
      ...boundedHandler(2, () => order.push('shouldContinue')),
      onResetSession,
    };

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
      shouldYieldToFollowup,
    });

    await adapter.startWithContinuation('Hello', handler);

    expect(order).toEqual(['gate', 'shouldContinue', 'gate']);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(onResetSession).not.toHaveBeenCalled();
  });

  // A pending user choice owns the session — the follow-up must not preempt it.
  it('does not consult the gate when the turn ends with a pending choice', async () => {
    const collector = new TurnResultCollector();
    collector.onText('Pick one');
    collector.onModelCommandResult({
      commandId: 'ASK_USER_QUESTION',
      ok: true,
      payload: {
        question: {
          type: 'user_choice',
          question: 'Pick one',
          choices: [{ id: 'a', label: 'A' }],
        },
      },
    });
    collector.onEndTurn({ reason: 'end_turn', timestamp: Date.now() });

    const execute = vi.fn().mockResolvedValue({ success: true, messageCount: 1, turnCollector: collector });
    const shouldYieldToFollowup = vi.fn(() => true);

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
      shouldYieldToFollowup,
    });

    const result = await adapter.startWithContinuation('Hello', { shouldContinue: () => ({ continue: false }) });

    expect(result.hasPendingChoice).toBe(true);
    expect(shouldYieldToFollowup).not.toHaveBeenCalled();
  });

  // handled:true means the user already saw the 🔴 card — the fallback result
  // still reports endTurn.reason='end_turn', which must NOT read as healthy.
  it('does not consult the gate for a failed execute even when handled:true', async () => {
    const execute = vi.fn().mockResolvedValue({
      success: false,
      messageCount: 0,
      handled: true,
      retryAfterMs: 1000,
    });
    const shouldYieldToFollowup = vi.fn(() => true);

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
      shouldYieldToFollowup,
    });

    const result = await adapter.startWithContinuation('Hello', { shouldContinue: () => ({ continue: false }) });

    // fallback shape: healthy-looking endTurn on a failed turn
    expect(result.endTurn.reason).toBe('end_turn');
    expect(shouldYieldToFollowup).not.toHaveBeenCalled();
    expect(adapter.getRetryAfterMs()).toBe(1000);
  });

  // Cancel/dispose/stall-abort already tore the session down.
  it('does not consult the gate when the abort controller is already aborted', async () => {
    const abortController = new AbortController();
    const execute = vi.fn().mockImplementation(() => {
      abortController.abort('user-stop');
      return Promise.resolve({
        success: true,
        messageCount: 1,
        turnCollector: createCollector({ continuation: { prompt: 'next' } }),
      });
    });
    const shouldYieldToFollowup = vi.fn(() => true);

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams: createMockExecuteParams({ abortController }),
      turnRunner: mockRunner,
      shouldYieldToFollowup,
    });

    await adapter.startWithContinuation('Hello', { shouldContinue: () => ({ continue: false }) });

    expect(shouldYieldToFollowup).not.toHaveBeenCalled();
  });

  // tool_use / max_tokens are mid-work stops; existing continuation semantics
  // own them, so the seam stays out (only end_turn/stop_sequence are proven).
  it.each([
    ['tool_use'],
    ['max_tokens'],
  ] as const)('does not consult the gate when endTurn.reason is %s', async (reason) => {
    const execute = vi.fn().mockResolvedValue({
      success: true,
      messageCount: 1,
      turnCollector: createCollector({ endTurn: { reason, timestamp: Date.now() } }),
    });
    const shouldYieldToFollowup = vi.fn(() => true);

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
      shouldYieldToFollowup,
    });

    await adapter.startWithContinuation('Hello', { shouldContinue: () => ({ continue: false }) });

    expect(shouldYieldToFollowup).not.toHaveBeenCalled();
  });

  it('consults the gate for a stop_sequence turn', async () => {
    const execute = vi.fn().mockResolvedValue({
      success: true,
      messageCount: 1,
      turnCollector: createCollector({
        endTurn: { reason: 'stop_sequence', timestamp: Date.now() },
        continuation: { prompt: 'next' },
      }),
    });
    const shouldYieldToFollowup = vi.fn(() => true);
    const handler = boundedHandler(1);

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
      shouldYieldToFollowup,
    });

    await adapter.startWithContinuation('Hello', handler);

    expect(shouldYieldToFollowup).toHaveBeenCalledTimes(1);
    expect(handler.calls).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // No callback → byte-identical continuation behavior (Issue #87 loop).
  it('keeps the original continuation loop when no callback is configured', async () => {
    let callCount = 0;
    const execute = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        success: true,
        messageCount: 1,
        turnCollector: createCollector({ continuation: callCount < 3 ? { prompt: `Turn ${callCount + 1}` } : null }),
      });
    });

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
    });

    await adapter.startWithContinuation('Turn 1', {
      shouldContinue: (result) => {
        const cont = result.continuation as any;
        return cont ? { continue: true, prompt: cont.prompt } : { continue: false };
      },
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(adapter.getTurnCount()).toBe(3);
  });

  // The seam must not disturb first-dispatch authorization state or attachments.
  it('preserves processedFiles and isUserInput=true on the first dispatch turn', async () => {
    let callCount = 0;
    const execute = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        success: true,
        messageCount: 1,
        turnCollector: createCollector({ continuation: callCount === 1 ? { prompt: 'continue' } : null }),
      });
    });

    // Gate declines on turn 1 so the continuation turn still runs.
    const shouldYieldToFollowup = vi.fn(() => false);
    const files = [{ name: 'test.txt', content: 'data' }];

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams: createMockExecuteParams({ isUserInput: true }),
      turnRunner: mockRunner,
      shouldYieldToFollowup,
    });

    await adapter.startWithContinuation(
      'Start',
      {
        shouldContinue: (result) => {
          const cont = result.continuation as any;
          return cont ? { continue: true, prompt: cont.prompt } : { continue: false };
        },
      },
      files,
    );

    const firstCall = execute.mock.calls[0][0];
    expect(firstCall.processedFiles).toEqual(files);
    expect(firstCall.isUserInput).toBe(true);

    const secondCall = execute.mock.calls[1][0];
    expect(secondCall.processedFiles).toEqual([]);
    expect(secondCall.isUserInput).toBe(false);
    expect(shouldYieldToFollowup).toHaveBeenCalledTimes(2);
  });

  // getLastTurnSucceeded(): the host dispatcher's completed-safe vs
  // handled-failure classifier. getLastExecuteResult() cannot answer it — the
  // failure fallback maps a degraded turn into a success-looking ExecuteResult.
  describe('getLastTurnSucceeded()', () => {
    it('is false before any turn has run', () => {
      const adapter = new V1QueryAdapter({
        streamExecutor: { execute: vi.fn() } as any,
        executeParams: createMockExecuteParams(),
        turnRunner: mockRunner,
      });

      expect(adapter.getLastTurnSucceeded()).toBe(false);
    });

    it('is true after a successful turn', async () => {
      const execute = vi.fn().mockResolvedValue({
        success: true,
        messageCount: 1,
        turnCollector: createCollector(),
      });

      const adapter = new V1QueryAdapter({
        streamExecutor: { execute } as any,
        executeParams: createMockExecuteParams(),
        turnRunner: mockRunner,
      });

      await adapter.start('Hello');

      expect(adapter.getLastTurnSucceeded()).toBe(true);
    });

    it('is false after a handled:true failure that getLastExecuteResult() reports as success', async () => {
      const execute = vi.fn().mockResolvedValue({
        success: false,
        messageCount: 0,
        handled: true,
        retryAfterMs: 1000,
      });

      const adapter = new V1QueryAdapter({
        streamExecutor: { execute } as any,
        executeParams: createMockExecuteParams(),
        turnRunner: mockRunner,
      });

      const result = await adapter.start('Hello');

      // The degraded turn looks healthy in both the result and the mapped
      // ExecuteResult — this accessor is the only honest signal.
      expect(result.endTurn.reason).toBe('end_turn');
      expect(adapter.getLastExecuteResult()?.success).toBe(true);
      expect(adapter.getLastTurnSucceeded()).toBe(false);
    });

    it('is false after a handled:false failure that throws', async () => {
      const execute = vi.fn().mockResolvedValue({
        success: false,
        messageCount: 0,
        handled: false,
        retryAfterMs: 30_000,
      });

      const adapter = new V1QueryAdapter({
        streamExecutor: { execute } as any,
        executeParams: createMockExecuteParams(),
        turnRunner: mockRunner,
      });

      await expect(adapter.start('Hello')).rejects.toThrow('StreamExecutor returned success=false');
      expect(adapter.getLastTurnSucceeded()).toBe(false);
    });

    it('reflects the latest turn, not a sticky earlier one', async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ success: true, messageCount: 1, turnCollector: createCollector() })
        .mockResolvedValueOnce({ success: false, messageCount: 0, handled: true });

      const adapter = new V1QueryAdapter({
        streamExecutor: { execute } as any,
        executeParams: createMockExecuteParams(),
        turnRunner: mockRunner,
      });

      await adapter.start('Hello');
      expect(adapter.getLastTurnSucceeded()).toBe(true);

      await adapter.continue('again');
      expect(adapter.getLastTurnSucceeded()).toBe(false);
    });
  });
});
