/**
 * V1QueryAdapter — IAgentSession의 v1 SDK 구현체 (Issue #84)
 *
 * 기존 StreamExecutor.execute()를 감싸서 IAgentSession 인터페이스를 제공한다.
 * StreamExecutor의 내부 구조를 변경하지 않고, adapter 패턴으로 구조화된 API를 노출.
 *
 * Option C 마이그레이션 2단계: IAgentSession + V1QueryAdapter
 */

import type { IAgentSession } from './agent-session.js';
import type { AgentTurnResult, ContinuationHandler } from './agent-session-types.js';
import { mapToExecuteResult } from './map-to-execute-result.js';
import type { TurnRunner } from './turn-runner.js';

/** StreamExecutor.execute()의 최소 인터페이스 */
export interface StreamExecutorLike {
  execute(params: any): Promise<{
    success: boolean;
    messageCount: number;
    continuation?: any;
    turnCollector?: {
      getResult(): AgentTurnResult;
    };
  }>;
}

/** V1QueryAdapter 설정 */
export interface V1QueryAdapterConfig {
  streamExecutor: StreamExecutorLike;
  /** text를 제외한 execute() 파라미터 */
  executeParams: Record<string, any>;
  /** Slack-facing lifecycle 관리자 (optional) */
  turnRunner?: TurnRunner;
}

export class V1QueryAdapter implements IAgentSession {
  private readonly executor: StreamExecutorLike;
  private readonly baseParams: Record<string, any>;
  private readonly runner?: TurnRunner;
  private turnCount = 0;
  private _started = false;
  private _abortController: AbortController;
  private _lastResult?: ReturnType<typeof mapToExecuteResult>;
  private _lastRetryAfterMs?: number;

  constructor(config: V1QueryAdapterConfig) {
    this.executor = config.streamExecutor;
    this.baseParams = config.executeParams;
    this.runner = config.turnRunner;
    this._abortController = (config.executeParams as any).abortController ?? new AbortController();
  }

  async start(prompt: string): Promise<AgentTurnResult> {
    this._started = true;
    this.turnCount = 1;
    // Ghost Session Fix #99: reuse baseParams.abortController (registered in RequestCoordinator)
    // instead of creating a new one that abort signals can't reach
    return this.executeTurn(prompt);
  }

  async continue(userPrompt: string): Promise<AgentTurnResult> {
    if (!this._started) {
      throw new Error('Session not started. Call start() first.');
    }
    this.turnCount++;
    // Ghost Session Fix #99: reuse baseParams.abortController — same as start()
    return this.executeTurn(userPrompt);
  }

  cancel(): void {
    // Ghost Session Fix #99: abort the current baseParams controller
    const controller = (this.baseParams as any).abortController ?? this._abortController;
    controller.abort();
  }

  dispose(): void {
    // v1 query 기반이라 연결 유지 없음 — abort and cleanup
    const controller = (this.baseParams as any).abortController ?? this._abortController;
    controller.abort();
  }

  /** 마지막 실행의 ExecuteResult 호환 반환 */
  getLastExecuteResult(): ReturnType<typeof mapToExecuteResult> | undefined {
    return this._lastResult;
  }

  /** 현재 턴 카운트 */
  getTurnCount(): number {
    return this.turnCount;
  }

  /** 마지막 실행에서 recoverable error로 인한 retry delay (ms) */
  getRetryAfterMs(): number | undefined {
    return this._lastRetryAfterMs;
  }

  /**
   * start + continuation 루프 (Issue #87, Phase 3c)
   *
   * handleMessage의 while(true) 루프를 adapter 내부로 이동.
   * ContinuationHandler 콜백으로 continuation 판정, reset, session refresh를 외부에서 주입.
   */
  async startWithContinuation(
    prompt: string,
    handler: ContinuationHandler,
    processedFiles?: any[],
  ): Promise<AgentTurnResult> {
    // First turn: processedFiles 포함
    if (processedFiles?.length) {
      this.baseParams.processedFiles = processedFiles;
    }

    let lastResult = await this.start(prompt);

    // Continuation loop
    while (true) {
      const decision = handler.shouldContinue(lastResult);
      if (!decision.continue || !decision.prompt) break;

      // Reset session if continuation requests it
      const continuation = lastResult.continuation as any;
      if (continuation?.resetSession && handler.onResetSession) {
        await handler.onResetSession(continuation);

        // Refresh session after reset
        if (handler.refreshSession) {
          const newSession = handler.refreshSession();
          if (!newSession) {
            throw new Error('Session lost after reset');
          }
          // Update base params with refreshed session
          this.baseParams.session = newSession;
        }
      }

      // 후속 턴: processedFiles 제거
      this.baseParams.processedFiles = [];

      lastResult = await this.continue(decision.prompt);
    }

    return lastResult;
  }

  /** 내부 baseParams 업데이트 (session refresh 등) */
  updateBaseParams(patch: Record<string, any>): void {
    Object.assign(this.baseParams, patch);
  }

  private async executeTurn(text: string): Promise<AgentTurnResult> {
    const startTime = Date.now();
    const turnId = `turn-${this.turnCount}-${Date.now()}`;

    // TurnRunner lifecycle: begin
    await this.runner?.begin(turnId);

    try {
      // Ghost Session Fix #99: always use the current baseParams.abortController
      // (the one registered in RequestCoordinator), not a cached copy
      const currentController = (this.baseParams as any).abortController ?? this._abortController;
      const params = {
        ...this.baseParams,
        text,
        abortController: currentController,
      };

      const executeResult = await this.executor.execute(params);

      // success=false without collector → 실패 (Review: Gemini P0 → P2)
      // catch block이 runner.fail()을 호출하므로 여기선 throw만
      // retryAfterMs 보존: handleMessage에서 auto-retry 스케줄링에 사용
      if (!executeResult.success && !executeResult.turnCollector) {
        this._lastRetryAfterMs = (executeResult as any).retryAfterMs;
        throw new Error('StreamExecutor returned success=false');
      }

      // turnCollector에서 AgentTurnResult 추출
      const turnResult: AgentTurnResult = executeResult.turnCollector
        ? {
            ...executeResult.turnCollector.getResult(),
            durationMs: Date.now() - startTime,
          }
        : {
            // turnCollector 없는 fallback
            messages: [],
            askUserQuestions: [],
            toolCalls: [],
            modelCommandResults: [],
            endTurn: { reason: 'end_turn', timestamp: Date.now() },
            continuation: executeResult.continuation ?? null,
            hasPendingChoice: false,
            durationMs: Date.now() - startTime,
          };

      // mapToExecuteResult wiring (Scenario 6)
      this._lastResult = mapToExecuteResult(turnResult);

      // TurnRunner lifecycle: finish
      await this.runner?.finish(turnResult);

      return turnResult;
    } catch (error) {
      // TurnRunner lifecycle: fail
      await this.runner?.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
