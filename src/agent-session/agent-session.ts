/**
 * IAgentSession — 구조화된 세션 API 인터페이스 (Issue #84)
 *
 * Option C 설계의 핵심. StreamExecutor를 직접 호출하는 대신
 * start/continue로 턴을 실행하고 AgentTurnResult를 받는다.
 *
 * V1QueryAdapter: 현재 query() 기반 SDK 래핑
 * V2SessionAdapter: 미래 unstable_v2 SDK 교체 시 구현
 */

import type { AgentTurnResult } from './agent-session-types.js';

export interface IAgentSession {
  /** 첫 번째 턴 실행 */
  start(prompt: string): Promise<AgentTurnResult>;

  /** 후속 턴 실행 (유저 응답 또는 continuation prompt) */
  continue(userPrompt: string): Promise<AgentTurnResult>;

  /** 현재 실행 중인 턴 취소 */
  cancel(): void;

  /** 세션 정리 (자원 해제) */
  dispose(): void;
}
