import { describe, it, expect } from 'vitest';
import { deriveStatus } from '../derive-status.js';
import type { EndTurnInfo } from '../agent-session-types.js';

// Trace: Scenario 1 — IAgentSession interface + deriveStatus

describe('deriveStatus', () => {
  // Trace: S1, Section 3b — pendingChoice overrides everything
  it('returns 입력 대기 when hasPendingChoice is true', () => {
    const info: EndTurnInfo = { reason: 'end_turn', timestamp: Date.now() };
    expect(deriveStatus(info, true)).toBe('입력 대기');
  });

  // Trace: S1, Section 3b — max_tokens
  it('returns 토큰 한도 도달 when reason is max_tokens', () => {
    const info: EndTurnInfo = { reason: 'max_tokens', timestamp: Date.now() };
    expect(deriveStatus(info, false)).toBe('토큰 한도 도달');
  });

  // Trace: S1, Section 3b — end_turn
  it('returns 사용자 액션 대기 when reason is end_turn', () => {
    const info: EndTurnInfo = { reason: 'end_turn', timestamp: Date.now() };
    expect(deriveStatus(info, false)).toBe('사용자 액션 대기');
  });

  // Trace: S1, Section 3b — tool_use without pending choice
  it('returns 사용자 액션 대기 when reason is tool_use and no pending', () => {
    const info: EndTurnInfo = { reason: 'tool_use', timestamp: Date.now(), lastToolUse: 'Read' };
    expect(deriveStatus(info, false)).toBe('사용자 액션 대기');
  });

  // Trace: S1, Section 5 — pendingChoice takes priority over max_tokens
  it('pendingChoice takes priority over max_tokens', () => {
    const info: EndTurnInfo = { reason: 'max_tokens', timestamp: Date.now() };
    expect(deriveStatus(info, true)).toBe('입력 대기');
  });
});
