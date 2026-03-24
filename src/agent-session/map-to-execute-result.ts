/**
 * AgentTurnResult → ExecuteResult 호환 매핑 (Issue #42 S5)
 *
 * AgentSession 레이어의 구조화된 결과를 기존 ExecuteResult 형식으로 변환.
 * slack-handler.ts의 continuation 루프가 변경 없이 동작하도록 보장.
 */

import type { AgentTurnResult } from './agent-session-types.js';

/** ExecuteResult 인터페이스 (stream-executor.ts에서 정의) */
interface ExecuteResultCompat {
  success: boolean;
  messageCount: number;
  continuation?: any;
}

/**
 * AgentTurnResult → ExecuteResult 변환
 *
 * 매핑 규칙:
 * - success: endTurn.reason이 'end_turn' | 'tool_use' | 'stop_sequence' | 'max_tokens' → true
 *            (에러는 AgentTurnResult까지 도달하지 않음 — executor의 catch에서 처리)
 * - messageCount: messages 배열 길이
 * - continuation: 그대로 전달 (null → undefined)
 */
export function mapToExecuteResult(turnResult: AgentTurnResult): ExecuteResultCompat {
  return {
    success: true,  // AgentTurnResult는 정상 완료된 턴만 표현
    messageCount: turnResult.messages.length,
    continuation: turnResult.continuation ?? undefined,
  };
}
