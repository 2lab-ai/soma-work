import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnResult, EndTurnInfo } from '../agent-session-types.js';
import { TurnRunner } from '../turn-runner.js';

// Trace: Scenario 4 — TurnRunner lifecycle

function createMockThreadSurface() {
  return {
    setStatus: vi.fn().mockResolvedValue(undefined),
    finalizeOnEndTurn: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTurnResult(overrides: Partial<AgentTurnResult> = {}): AgentTurnResult {
  return {
    messages: [],
    askUserQuestions: [],
    toolCalls: [],
    modelCommandResults: [],
    endTurn: { reason: 'end_turn', timestamp: Date.now() },
    continuation: null,
    hasPendingChoice: false,
    ...overrides,
  };
}

describe('TurnRunner', () => {
  let mockSurface: ReturnType<typeof createMockThreadSurface>;
  const session = {} as any;
  const sessionKey = 'C1-171.100';

  beforeEach(() => {
    mockSurface = createMockThreadSurface();
  });

  // Trace: S4, Section 3a — begin sets status to '생각 중'
  it('begin() sets status to 생각 중', async () => {
    const runner = new TurnRunner({
      threadSurface: mockSurface as any,
      session,
      sessionKey,
    });

    await runner.begin('turn-1');
    expect(mockSurface.setStatus).toHaveBeenCalledWith(
      session,
      sessionKey,
      expect.objectContaining({ agentPhase: '생각 중' }),
    );
  });

  // Trace: S4, Section 3c — finish calls finalizeOnEndTurn
  it('finish() calls finalizeOnEndTurn', async () => {
    const runner = new TurnRunner({
      threadSurface: mockSurface as any,
      session,
      sessionKey,
    });

    const result = makeTurnResult({
      endTurn: { reason: 'end_turn', timestamp: Date.now() },
      hasPendingChoice: false,
    });

    await runner.begin('turn-1');
    await runner.finish(result);

    expect(mockSurface.finalizeOnEndTurn).toHaveBeenCalledWith(session, sessionKey, result.endTurn, false);
  });

  // Trace: S4, Section 3c — finish calls deriveStatus
  it('finish() with pending choice results in 입력 대기', async () => {
    const runner = new TurnRunner({
      threadSurface: mockSurface as any,
      session,
      sessionKey,
    });

    const result = makeTurnResult({ hasPendingChoice: true });

    await runner.begin('turn-1');
    await runner.finish(result);

    expect(mockSurface.finalizeOnEndTurn).toHaveBeenCalledWith(session, sessionKey, result.endTurn, true);
  });

  // Trace: S4, Section 3d — fail sets status to '오류'
  it('fail() sets status to 오류', async () => {
    const runner = new TurnRunner({
      threadSurface: mockSurface as any,
      session,
      sessionKey,
    });

    await runner.begin('turn-1');
    await runner.fail(new Error('test error'));

    expect(mockSurface.setStatus).toHaveBeenLastCalledWith(
      session,
      sessionKey,
      expect.objectContaining({ agentPhase: '오류' }),
    );
  });

  // Trace: S4, Section 5 — no threadSurface is noop
  it('works without threadSurface (noop)', async () => {
    const runner = new TurnRunner({
      session,
      sessionKey,
    });

    // Should not throw
    await runner.begin('turn-1');
    await runner.finish(makeTurnResult());
    await runner.fail(new Error('test'));
  });

  // Trace: S4, Section 5 — finish without begin is safe
  it('finish() without begin() is safe', async () => {
    const runner = new TurnRunner({
      threadSurface: mockSurface as any,
      session,
      sessionKey,
    });

    // Should not throw
    await runner.finish(makeTurnResult());
  });
});
