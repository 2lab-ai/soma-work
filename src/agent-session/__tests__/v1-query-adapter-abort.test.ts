import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnResultCollector } from '../turn-result-collector.js';
import type { StreamExecutorLike } from '../v1-query-adapter.js';
import { V1QueryAdapter } from '../v1-query-adapter.js';

// Trace: Ghost Session Fix, Scenario 1 — AbortController Unification (P0)
// These tests verify that V1QueryAdapter does NOT create new AbortControllers,
// ensuring requestCoordinator.abortSession() reaches the SDK.

function createMockStreamExecutor() {
  const collector = new TurnResultCollector();
  collector.onEndTurn({ reason: 'end_turn', timestamp: Date.now() });
  return {
    execute: vi.fn().mockResolvedValue({
      success: true,
      messageCount: 1,
      continuation: undefined,
      turnCollector: collector,
    }),
  };
}

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

describe('V1QueryAdapter — AbortController Unification (Ghost Session Fix #99)', () => {
  let mockExecutor: ReturnType<typeof createMockStreamExecutor>;

  beforeEach(() => {
    mockExecutor = createMockStreamExecutor();
  });

  // Trace: Scenario 1, Section 3c→3d — start() must use baseParams abortController
  it('start() should pass the SAME abortController from baseParams to executor', async () => {
    const params = createMockExecuteParams();
    const originalController = params.abortController;

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as StreamExecutorLike,
      executeParams: params,
    });

    await adapter.start('Hello');

    // The abortController passed to execute() must be the original one from baseParams
    const executedParams = mockExecutor.execute.mock.calls[0][0];
    expect(executedParams.abortController).toBe(originalController);
  });

  // Trace: Scenario 1, Section 3c→3d — continue() must use baseParams abortController
  it('continue() should pass the SAME abortController from baseParams to executor', async () => {
    const params = createMockExecuteParams();
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as StreamExecutorLike,
      executeParams: params,
    });

    await adapter.start('Hello');

    // Update baseParams with a new controller (simulating sessionInitializer creating new one for next turn)
    const newController = new AbortController();
    params.abortController = newController;

    await adapter.continue('Follow up');

    const executedParams = mockExecutor.execute.mock.calls[1][0];
    expect(executedParams.abortController).toBe(newController);
  });

  // Trace: Scenario 1, Section 4 — abort via cancel() reaches the controller used by SDK
  it('abort via requestCoordinator should reach the SDK-used controller', async () => {
    const params = createMockExecuteParams();
    const registeredController = params.abortController;

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as StreamExecutorLike,
      executeParams: params,
    });

    // Simulate: start is called, then requestCoordinator aborts the registered controller
    await adapter.start('Hello');

    // The controller passed to executor should be the registered one
    const executedParams = mockExecutor.execute.mock.calls[0][0];
    const sdkController = executedParams.abortController as AbortController;

    // Simulate requestCoordinator.abortSession() → aborts the registered controller
    registeredController.abort();

    // SDK controller must also be aborted (same instance)
    expect(sdkController.signal.aborted).toBe(true);
  });

  // Trace: Scenario 1 — start() must NOT create a new AbortController
  it('start() should not create a different AbortController than the one in baseParams', async () => {
    const params = createMockExecuteParams();

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as StreamExecutorLike,
      executeParams: params,
    });

    await adapter.start('Hello');

    // cancel() should abort the same controller that was passed to executor
    const executedParams = mockExecutor.execute.mock.calls[0][0];
    adapter.cancel();
    expect(executedParams.abortController.signal.aborted).toBe(true);
  });
});
