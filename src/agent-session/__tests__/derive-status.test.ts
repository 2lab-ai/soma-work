import { describe, expect, it } from 'vitest';
import type { EndTurnInfo } from '../agent-session-types.js';
import { deriveStatus, isAwaitingUserChoice } from '../derive-status.js';

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

// A turn result is a snapshot. The session's open-choice bit is the live
// truth: every answer path clears it, so a snapshot taken before an answer
// must not hold the follow-up drain as "awaiting user choice".
describe('isAwaitingUserChoice', () => {
  it('follows the live bit when the session has one', () => {
    expect(isAwaitingUserChoice(true, true)).toBe(true);
    expect(isAwaitingUserChoice(false, true)).toBe(true);
    // answered after the turn result was taken
    expect(isAwaitingUserChoice(true, false)).toBe(false);
    expect(isAwaitingUserChoice(false, false)).toBe(false);
  });

  it('falls back to the turn result when no thread panel ever wrote the bit', () => {
    expect(isAwaitingUserChoice(true, undefined)).toBe(true);
    expect(isAwaitingUserChoice(false, undefined)).toBe(false);
    expect(isAwaitingUserChoice(undefined, undefined)).toBe(false);
  });
});
