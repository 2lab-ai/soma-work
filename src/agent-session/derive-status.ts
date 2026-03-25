/**
 * deriveStatus — endTurn 정보에서 최종 AgentPhase를 결정하는 순수 함수 (Issue #84)
 *
 * ThreadSurface.finalizeOnEndTurn()에서 추출.
 * TurnRunner.finish()에서 호출된다.
 */

import type { AgentPhase, EndTurnInfo } from './agent-session-types.js';

export function deriveStatus(endTurnInfo: EndTurnInfo, hasPendingChoice: boolean): AgentPhase {
  if (hasPendingChoice) {
    return '입력 대기';
  }
  if (endTurnInfo.reason === 'max_tokens') {
    return '토큰 한도 도달';
  }
  return '사용자 액션 대기';
}
