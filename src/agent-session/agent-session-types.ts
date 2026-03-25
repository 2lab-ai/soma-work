/**
 * Agent Session Types — Issue #42
 *
 * AgentSession 기반 명시적 endTurn 호출 구조의 핵심 타입 정의.
 * S1-S2에서 확립. S3(TurnObserver)부터 소비한다.
 */

// ─── EndTurn ───────────────────────────────────────────

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';

export interface EndTurnInfo {
  reason: StopReason;
  timestamp: number;
  /** 마지막 tool 이름 (tool_use 종료일 때) */
  lastToolUse?: string;
}

// ─── MCP 결과 ──────────────────────────────────────────

export interface ModelCommandResult {
  commandId: string;
  ok: boolean;
  payload?: any;
  error?: { code: string; message: string };
}

export interface UserChoiceQuestion {
  type: 'user_choice' | 'user_choice_group';
  question: string;
  choices: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
}

// ─── Tool 요약 ─────────────────────────────────────────

export interface ToolCallSummary {
  toolName: string;
  toolUseId: string;
  startedAt: number;
  duration?: number;
}

// ─── Agent Phase ───────────────────────────────────────

export type AgentPhase =
  | '생각 중'
  | '도구 실행 중'
  | '결과 반영 중'
  | '입력 대기'
  | '완료'
  | '오류'
  | '취소됨'
  | '토큰 한도 도달'
  | '사용자 액션 대기';

// ─── Turn Result ───────────────────────────────────────

export interface AgentTurnResult {
  /** 어시스턴트 텍스트 메시지들 */
  messages: string[];

  /** ASK_USER_QUESTION 호출 결과들 */
  askUserQuestions: UserChoiceQuestion[];

  /** 도구 호출 요약 */
  toolCalls: ToolCallSummary[];

  /** MCP model-command 결과들 */
  modelCommandResults: ModelCommandResult[];

  /** 종료 정보 */
  endTurn: EndTurnInfo;

  /** 후속 처리 (CONTINUE_SESSION or renew) */
  continuation: unknown | null;

  /** 유저 입력 대기 중 */
  hasPendingChoice: boolean;

  /** 토큰 사용량 (Issue #84) */
  usage?: UsageData;

  /** 턴 실행 소요 시간 ms (Issue #84) */
  durationMs?: number;
}

// ─── Continuation ────────────────────────────────────

/** continuation 루프 제어 콜백 (Issue #87) */
export interface ContinuationHandler {
  /** AgentTurnResult에서 continuation 여부 판정 + 다음 프롬프트 추출 */
  shouldContinue(result: AgentTurnResult): { continue: boolean; prompt?: string };
  /** resetSession 요청 시 세션 초기화 + dispatch 재실행 */
  onResetSession?(continuation: any): Promise<void>;
  /** 세션 재조회 (reset 후 갱신된 세션 반환) */
  refreshSession?(): any;
}

// ─── Usage ────────────────────────────────────────────

/** 토큰 사용량 — stream-processor.ts의 UsageData와 호환 */
export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}
