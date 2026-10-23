/**
 * deriveStatus — endTurn 정보에서 최종 AgentPhase를 결정하는 순수 함수 (Issue #84)
 *
 * ThreadSurface.finalizeOnEndTurn()에서 추출.
 * TurnRunner.finish()에서 호출된다.
 */

import type { AgentPhase, EndTurnInfo } from './agent-session-types.js';

/**
 * Whether a finished turn leaves the session waiting on the user's choice.
 *
 * The session's open-choice bit (`actionPanel.waitingForChoice`) is the live
 * truth: every answer path clears it. The turn result is a snapshot taken
 * before the host reads it, so it only decides when no thread panel ever
 * wrote the bit.
 */
export function isAwaitingUserChoice(turnHasPendingChoice: boolean | undefined, liveBit: boolean | undefined): boolean {
  if (liveBit !== undefined) return liveBit;
  return turnHasPendingChoice === true;
}

export function deriveStatus(endTurnInfo: EndTurnInfo, hasPendingChoice: boolean): AgentPhase {
  if (hasPendingChoice) {
    return '입력 대기';
  }
  if (endTurnInfo.reason === 'max_tokens') {
    return '토큰 한도 도달';
  }
  return '사용자 액션 대기';
}
