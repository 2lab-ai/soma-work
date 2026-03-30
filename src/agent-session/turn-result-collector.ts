/**
 * TurnResultCollector — TurnObserver 구현체
 *
 * StreamExecutor 콜백에서 호출되어, 턴 동안 발생하는 모든 이벤트를
 * AgentTurnResult로 수집한다.
 *
 * 이 객체는 턴 시작 시 생성되고, 턴 종료 시 getResult()로 결과를 반환한다.
 */

import type { TurnObserver } from './turn-observer.js';
import type {
  AgentPhase,
  AgentTurnResult,
  EndTurnInfo,
  ModelCommandResult,
  ToolCallSummary,
  UsageData,
  UserChoiceQuestion,
} from './agent-session-types.js';

export class TurnResultCollector implements TurnObserver {
  private readonly messages: string[] = [];
  private readonly askUserQuestions: UserChoiceQuestion[] = [];
  private readonly toolCalls: ToolCallSummary[] = [];
  private readonly modelCommandResults: ModelCommandResult[] = [];
  private readonly toolStartTimes = new Map<string, number>();

  private endTurnInfo: EndTurnInfo | null = null;
  private _hasPendingChoice = false;
  private _continuation: unknown | null = null;
  private _usage: UsageData | undefined;
  private currentPhase: AgentPhase = '생각 중';

  // ─── TurnObserver 구현 ───────────────────────────────

  onToolStart(toolName: string, toolUseId: string): void {
    const now = Date.now();
    this.toolStartTimes.set(toolUseId, now);
    this.toolCalls.push({
      toolName,
      toolUseId,
      startedAt: now,
    });
  }

  onToolEnd(toolName: string, toolUseId: string, duration?: number): void {
    const call = this.toolCalls.find(c => c.toolUseId === toolUseId);
    if (call) {
      call.duration = duration ?? (Date.now() - (this.toolStartTimes.get(toolUseId) ?? Date.now()));
    }
    this.toolStartTimes.delete(toolUseId);
  }

  onModelCommandResult(result: ModelCommandResult): void {
    this.modelCommandResults.push(result);

    // ASK_USER_QUESTION → 자동으로 choice 수집
    if (result.commandId === 'ASK_USER_QUESTION' && result.ok && result.payload?.question) {
      this.askUserQuestions.push(result.payload.question);
      this._hasPendingChoice = true;
    }

    // CONTINUE_SESSION → continuation 캡처
    if (result.commandId === 'CONTINUE_SESSION' && result.ok && result.payload) {
      this._continuation = result.payload;
    }
  }

  onPhaseChange(phase: AgentPhase): void {
    this.currentPhase = phase;
    if (phase === '입력 대기') {
      this._hasPendingChoice = true;
    }
  }

  onEndTurn(info: EndTurnInfo): void {
    this.endTurnInfo = info;
  }

  onText(text: string): void {
    if (text.trim()) {
      this.messages.push(text);
    }
  }

  // ─── 외부에서 설정 ──────────────────────────────────

  /** StreamExecutor의 handleModelCommandToolResults에서 감지한 continuation 설정 */
  setContinuation(continuation: unknown): void {
    this._continuation = continuation;
  }

  /** StreamResult.hasUserChoice에서 감지한 pending choice 설정 */
  setHasPendingChoice(value: boolean): void {
    this._hasPendingChoice = value;
  }

  /** StreamResult.usage에서 수집한 토큰 사용량 설정 (Issue #84) */
  setUsage(usage: UsageData): void {
    this._usage = usage;
  }

  // ─── 결과 반환 ──────────────────────────────────────

  /** 현재 phase 조회 */
  get phase(): AgentPhase {
    return this.currentPhase;
  }

  /** endTurn 정보 조회 */
  get endTurn(): EndTurnInfo | null {
    return this.endTurnInfo;
  }

  /** 수집된 턴 결과를 AgentTurnResult로 반환 */
  getResult(): AgentTurnResult {
    return {
      messages: [...this.messages],
      askUserQuestions: [...this.askUserQuestions],
      toolCalls: [...this.toolCalls],
      modelCommandResults: [...this.modelCommandResults],
      endTurn: this.endTurnInfo ?? {
        reason: 'end_turn',
        timestamp: Date.now(),
      },
      continuation: this._continuation,
      hasPendingChoice: this._hasPendingChoice,
      usage: this._usage,
    };
  }
}
