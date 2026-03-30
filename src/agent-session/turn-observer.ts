/**
 * TurnObserver — StreamExecutor 콜백의 단일 관찰자 인터페이스
 *
 * Issue #42 S3: StreamExecutor의 13개 StreamCallbacks를 그대로 유지하되,
 * 각 콜백 내부에서 observer 메서드를 추가 호출하여 턴 결과를 구조화 수집한다.
 *
 * 설계 원칙:
 * 1. Append-only — 기존 콜백 로직 제거/변경 없음
 * 2. Observer는 순수 수집자 — side-effect(Slack 렌더링 등)는 기존 콜백이 담당
 * 3. fire-and-forget — observer 메서드는 동기적이며, 실패해도 기존 흐름에 영향 없음
 */

import type {
  AgentPhase,
  EndTurnInfo,
  ModelCommandResult,
} from './agent-session-types.js';

export interface TurnObserver {
  // === 도구 이벤트 ===
  /** 도구 실행 시작 */
  onToolStart(toolName: string, toolUseId: string): void;
  /** 도구 실행 종료 */
  onToolEnd(toolName: string, toolUseId: string, duration?: number): void;

  // === MCP 결과 수집 ===
  /** model-command 도구 결과 수신 */
  onModelCommandResult(result: ModelCommandResult): void;

  // === 상태 전이 ===
  /** 에이전트 실행 단계 변경 */
  onPhaseChange(phase: AgentPhase): void;

  // === 종료 ===
  /** 턴 종료 — stop_reason 기반 */
  onEndTurn(info: EndTurnInfo): void;

  // === 텍스트 수집 ===
  /** 어시스턴트 텍스트 메시지 수신 */
  onText(text: string): void;
}

/**
 * No-op 기본 구현.
 * TurnObserver가 설정되지 않은 경우의 fallback.
 */
export const NULL_OBSERVER: TurnObserver = {
  onToolStart() {},
  onToolEnd() {},
  onModelCommandResult() {},
  onPhaseChange() {},
  onEndTurn() {},
  onText() {},
};
