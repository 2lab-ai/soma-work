import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContinuationHandler } from '../agent-session-types.js';
import { TurnResultCollector } from '../turn-result-collector.js';
import { V1QueryAdapter } from '../v1-query-adapter.js';

// Trace: Scenario 2 — V1QueryAdapter.startWithContinuation()

function createMockExecuteParams() {
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
  };
}

function createCollectorWithContinuation(continuation: any = null) {
  const collector = new TurnResultCollector();
  collector.onText('Response');
  collector.onEndTurn({ reason: 'end_turn', timestamp: Date.now() });
  if (continuation) {
    collector.setContinuation(continuation);
  }
  return collector;
}

describe('V1QueryAdapter.startWithContinuation', () => {
  let mockExecutor: any;
  let mockRunner: any;

  beforeEach(() => {
    mockRunner = {
      begin: vi.fn(),
      update: vi.fn(),
      finish: vi.fn(),
      fail: vi.fn(),
    };
  });

  // Trace: S2, 3a — no continuation returns single result
  it('returns single result when no continuation', async () => {
    const collector = createCollectorWithContinuation(null);
    mockExecutor = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        messageCount: 1,
        turnCollector: collector,
      }),
    };

    const handler: ContinuationHandler = {
      shouldContinue: () => ({ continue: false }),
    };

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
    });

    const result = await adapter.startWithContinuation('Hello', handler);
    expect(result.messages).toEqual(['Response']);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  // Trace: S2, 3b — continuation loops
  it('loops when handler.shouldContinue returns true', async () => {
    let callCount = 0;
    mockExecutor = {
      execute: vi.fn().mockImplementation(() => {
        callCount++;
        const collector = createCollectorWithContinuation(callCount < 3 ? { prompt: `Turn ${callCount + 1}` } : null);
        return Promise.resolve({
          success: true,
          messageCount: 1,
          turnCollector: collector,
        });
      }),
    };

    const handler: ContinuationHandler = {
      shouldContinue: (result) => {
        const cont = result.continuation as any;
        if (!cont) return { continue: false };
        return { continue: true, prompt: cont.prompt };
      },
    };

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
    });

    await adapter.startWithContinuation('Turn 1', handler);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(3);
    expect(adapter.getTurnCount()).toBe(3);
  });

  // Trace: S2, 3b — resetSession calls handler
  it('calls onResetSession when continuation has resetSession', async () => {
    let callCount = 0;
    mockExecutor = {
      execute: vi.fn().mockImplementation(() => {
        callCount++;
        const continuation =
          callCount === 1 ? { prompt: 'after reset', resetSession: true, dispatchText: 'dispatch' } : null;
        const collector = createCollectorWithContinuation(continuation);
        return Promise.resolve({
          success: true,
          messageCount: 1,
          turnCollector: collector,
        });
      }),
    };

    const onResetSession = vi.fn();
    const refreshSession = vi.fn().mockReturnValue({ id: 'new-session' });

    const handler: ContinuationHandler = {
      shouldContinue: (result) => {
        const cont = result.continuation as any;
        if (!cont) return { continue: false };
        return { continue: true, prompt: cont.prompt };
      },
      onResetSession,
      refreshSession,
    };

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
    });

    await adapter.startWithContinuation('Start', handler);

    expect(onResetSession).toHaveBeenCalledTimes(1);
    expect(onResetSession).toHaveBeenCalledWith(
      expect.objectContaining({ resetSession: true, dispatchText: 'dispatch' }),
    );
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  // Trace: S2, 3c — processedFiles only on first turn
  it('passes processedFiles only on first turn', async () => {
    let callCount = 0;
    mockExecutor = {
      execute: vi.fn().mockImplementation((params: any) => {
        callCount++;
        const continuation = callCount === 1 ? { prompt: 'continue' } : null;
        const collector = createCollectorWithContinuation(continuation);
        return Promise.resolve({
          success: true,
          messageCount: 1,
          turnCollector: collector,
        });
      }),
    };

    const handler: ContinuationHandler = {
      shouldContinue: (result) => {
        const cont = result.continuation as any;
        if (!cont) return { continue: false };
        return { continue: true, prompt: cont.prompt };
      },
    };

    const files = [{ name: 'test.txt', content: 'data' }];
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
    });

    await adapter.startWithContinuation('Start', handler, files);

    // First call should have processedFiles
    const firstCallParams = mockExecutor.execute.mock.calls[0][0];
    expect(firstCallParams.processedFiles).toEqual(files);

    // Second call should have empty processedFiles
    const secondCallParams = mockExecutor.execute.mock.calls[1][0];
    expect(secondCallParams.processedFiles).toEqual([]);
  });

  // Trace: S2, 5 — session lost after reset throws
  it('throws when session lost after reset', async () => {
    mockExecutor = {
      execute: vi.fn().mockImplementation(() => {
        const collector = createCollectorWithContinuation({
          prompt: 'after reset',
          resetSession: true,
        });
        return Promise.resolve({
          success: true,
          messageCount: 1,
          turnCollector: collector,
        });
      }),
    };

    const handler: ContinuationHandler = {
      shouldContinue: (result) => {
        const cont = result.continuation as any;
        if (!cont) return { continue: false };
        return { continue: true, prompt: cont.prompt };
      },
      onResetSession: vi.fn(),
      refreshSession: () => null, // Session lost!
    };

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
    });

    await expect(adapter.startWithContinuation('Start', handler)).rejects.toThrow('Session lost after reset');
  });

  // TurnRunner integration: begin/finish called per turn
  it('calls turnRunner.begin and finish per turn', async () => {
    let callCount = 0;
    mockExecutor = {
      execute: vi.fn().mockImplementation(() => {
        callCount++;
        const continuation = callCount < 2 ? { prompt: 'next' } : null;
        const collector = createCollectorWithContinuation(continuation);
        return Promise.resolve({
          success: true,
          messageCount: 1,
          turnCollector: collector,
        });
      }),
    };

    const handler: ContinuationHandler = {
      shouldContinue: (result) => {
        const cont = result.continuation as any;
        if (!cont) return { continue: false };
        return { continue: true, prompt: cont.prompt };
      },
    };

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner,
    });

    await adapter.startWithContinuation('Start', handler);

    // 2 turns → 2 begin + 2 finish
    expect(mockRunner.begin).toHaveBeenCalledTimes(2);
    expect(mockRunner.finish).toHaveBeenCalledTimes(2);
  });
});
