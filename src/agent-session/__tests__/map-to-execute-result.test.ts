import { describe, it, expect } from 'vitest';
import { mapToExecuteResult } from '../map-to-execute-result.js';
import type { AgentTurnResult } from '../agent-session-types.js';

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

describe('mapToExecuteResult', () => {
  it('maps normal turn (no continuation)', () => {
    const result = mapToExecuteResult(makeTurnResult({
      messages: ['Hello', 'World'],
    }));
    expect(result).toEqual({
      success: true,
      messageCount: 2,
      continuation: undefined,
    });
  });

  it('maps turn with continuation', () => {
    const continuation = { prompt: 'continue...', resetSession: false };
    const result = mapToExecuteResult(makeTurnResult({
      messages: ['msg'],
      continuation,
    }));
    expect(result).toEqual({
      success: true,
      messageCount: 1,
      continuation,
    });
  });

  it('maps empty turn', () => {
    const result = mapToExecuteResult(makeTurnResult());
    expect(result).toEqual({
      success: true,
      messageCount: 0,
      continuation: undefined,
    });
  });

  it('maps max_tokens turn as success (executor catch handles errors)', () => {
    const result = mapToExecuteResult(makeTurnResult({
      endTurn: { reason: 'max_tokens', timestamp: Date.now() },
      messages: ['partial...'],
    }));
    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(1);
  });

  it('null continuation becomes undefined', () => {
    const result = mapToExecuteResult(makeTurnResult({ continuation: null }));
    expect(result.continuation).toBeUndefined();
  });
});
