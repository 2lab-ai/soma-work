import { describe, it, expect, vi, beforeEach } from 'vitest';
import { V1QueryAdapter } from '../v1-query-adapter.js';
import type { AgentTurnResult } from '../agent-session-types.js';
import { TurnResultCollector } from '../turn-result-collector.js';

// Trace: Scenario 2 & 3 — V1QueryAdapter.start() / continue()

// Mock StreamExecutor
function createMockStreamExecutor(overrides: Partial<{ turnCollector: TurnResultCollector }> = {}) {
  const collector = overrides.turnCollector ?? new TurnResultCollector();
  return {
    execute: vi.fn().mockResolvedValue({
      success: true,
      messageCount: 1,
      continuation: undefined,
      turnCollector: collector,
    }),
  };
}

// Mock TurnRunner
function createMockTurnRunner() {
  return {
    begin: vi.fn(),
    update: vi.fn(),
    finish: vi.fn(),
    fail: vi.fn(),
  };
}

// Minimal executeParams
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

describe('V1QueryAdapter', () => {
  let mockExecutor: ReturnType<typeof createMockStreamExecutor>;
  let mockRunner: ReturnType<typeof createMockTurnRunner>;

  beforeEach(() => {
    mockExecutor = createMockStreamExecutor();
    mockRunner = createMockTurnRunner();
  });

  // Trace: S2, Section 3a-3b — start delegates to StreamExecutor
  it('start() delegates to streamExecutor.execute()', async () => {
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
    });

    await adapter.start('Hello');
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello' }),
    );
  });

  // Trace: S2, Section 3c — start returns AgentTurnResult
  it('start() returns AgentTurnResult from turnCollector', async () => {
    const collector = new TurnResultCollector();
    collector.onText('Response text');
    collector.onEndTurn({ reason: 'end_turn', timestamp: Date.now() });
    mockExecutor = createMockStreamExecutor({ turnCollector: collector });

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
    });

    const result = await adapter.start('Hello');
    expect(result.messages).toEqual(['Response text']);
    expect(result.endTurn.reason).toBe('end_turn');
  });

  // Trace: S2, Section 3c — start computes durationMs
  it('start() computes durationMs', async () => {
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
    });

    const result = await adapter.start('Hello');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });

  // Trace: S2, Section 4 — start calls turnRunner begin/finish
  it('start() calls turnRunner.begin() and turnRunner.finish()', async () => {
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner as any,
    });

    await adapter.start('Hello');
    expect(mockRunner.begin).toHaveBeenCalledTimes(1);
    expect(mockRunner.finish).toHaveBeenCalledTimes(1);
  });

  // Trace: S2, Section 5 — on error, calls turnRunner.fail()
  it('start() on error calls turnRunner.fail()', async () => {
    const error = new Error('SDK failure');
    mockExecutor.execute.mockRejectedValue(error);

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner as any,
    });

    await expect(adapter.start('Hello')).rejects.toThrow('SDK failure');
    expect(mockRunner.fail).toHaveBeenCalledWith(error);
  });

  // Trace: S2, Section 5 — without turnCollector returns defaults
  it('start() without turnCollector returns default AgentTurnResult', async () => {
    mockExecutor.execute.mockResolvedValue({
      success: true,
      messageCount: 0,
    });

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
    });

    const result = await adapter.start('Hello');
    expect(result.messages).toEqual([]);
    expect(result.endTurn.reason).toBe('end_turn');
  });

  // Trace: S3, Section 3a — continue delegates with new prompt
  it('continue() delegates to streamExecutor with new prompt', async () => {
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
    });

    await adapter.start('First');
    await adapter.continue('Second');

    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
    expect(mockExecutor.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Second' }),
    );
  });

  // Trace: S3, Section 3a — continue increments turnCount
  it('continue() increments turnCount', async () => {
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
    });

    await adapter.start('First');
    expect(adapter.getTurnCount()).toBe(1);
    await adapter.continue('Second');
    expect(adapter.getTurnCount()).toBe(2);
    await adapter.continue('Third');
    expect(adapter.getTurnCount()).toBe(3);
  });

  // Review Fix: success=false without turnCollector should throw
  it('start() with success=false and no turnCollector throws', async () => {
    mockExecutor.execute.mockResolvedValue({
      success: false,
      messageCount: 0,
    });

    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
      turnRunner: mockRunner as any,
    });

    await expect(adapter.start('Hello')).rejects.toThrow('success=false');
    expect(mockRunner.fail).toHaveBeenCalledTimes(1);
    expect(mockRunner.finish).not.toHaveBeenCalled();
  });

  // Review Fix: start() after cancel() should work with fresh AbortController
  it('start() after cancel() uses fresh AbortController', async () => {
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
    });

    await adapter.start('First');
    adapter.cancel();
    // Second start should not fail due to aborted controller
    await adapter.start('Second');
    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
  });

  // Trace: S3, Section 5 — continue before start throws
  it('continue() before start() throws', async () => {
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
    });

    await expect(adapter.continue('Second')).rejects.toThrow();
  });

  // Trace: S6, Section 3a — adapter exposes lastExecuteResult
  it('getLastExecuteResult() returns mapped result after start()', async () => {
    const adapter = new V1QueryAdapter({
      streamExecutor: mockExecutor as any,
      executeParams: createMockExecuteParams(),
    });

    expect(adapter.getLastExecuteResult()).toBeUndefined();
    await adapter.start('Hello');
    const compat = adapter.getLastExecuteResult();
    expect(compat).toBeDefined();
    expect(compat!.success).toBe(true);
  });
});
