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
    /**
     * `true` when StreamExecutor's catch branch already surfaced the failure
     * to the user (Exception card via `turnNotifier`, status/reaction updates,
     * thread-panel close). The adapter treats this as a graceful turn end
     * instead of throwing — re-throwing would only generate a duplicate Bolt
     * `slack_bolt_unknown_error` log line because the user already saw the
     * 🔴 카드. Stall-timeout abort is the primary trigger.
     */
    handled?: boolean;
  }>;
}

/** V1QueryAdapter 설정 */
export interface V1QueryAdapterConfig {
  streamExecutor: StreamExecutorLike;
  /** text를 제외한 execute() 파라미터 */
  executeParams: Record<string, any>;
  /** Slack-facing lifecycle 관리자 (optional) */
  turnRunner?: TurnRunner;
  /**
   * Follow-up yield seam (U4a, optional DI).
   *
   * `startWithContinuation`이 정착한(settled) 턴마다 continuation 판정·reset보다
   * 먼저 물어본다. `true`면 루프를 끝내고 마지막 결과를 반환 — 호스트가 큐의
   * follow-up을 새 dispatch로 돌린다 (adapter에 텍스트를 주입하지 않는다).
   *
   * settled = `executor.execute()` + `runner.finish()` 두 await 완료. 슬롯 부재는
   * 경계가 아니다: RequestCoordinator 슬롯은 `stream-executor.ts` cleanup 초반
   * (`removeController`, line 3702)에 비워지지만 async tool cleanup은 line 3726에서야
   * await된다.
   *
   * 호출하지 않는 경우 (yield 자체가 안전하지 않음): 실패 턴(`success === false`,
   * `handled === true` 포함 — fallback 결과의 `endTurn.reason === 'end_turn'`은
   * 건강함의 증거가 아니다) · `hasPendingChoice` · 이미 abort된 controller ·
   * `endTurn.reason`이 `end_turn`/`stop_sequence`가 아닌 경우(`tool_use`·
   * `max_tokens`는 기존 continuation 의미론 소유, 중단 안전성 미증명).
   */
  shouldYieldToFollowup?(result: AgentTurnResult): Promise<boolean> | boolean;
}

export class V1QueryAdapter implements IAgentSession {
  private readonly executor: StreamExecutorLike;
  private readonly baseParams: Record<string, any>;
  private readonly runner?: TurnRunner;
  private readonly shouldYieldToFollowup?: (result: AgentTurnResult) => Promise<boolean> | boolean;
  private turnCount = 0;
  private _started = false;
  private _abortController: AbortController;
  private _lastResult?: ReturnType<typeof mapToExecuteResult>;
  private _lastRetryAfterMs?: number;
  /**
   * 마지막으로 정착한 턴의 `execute()` 성공 여부 — 로컬 실행 결과이지 결과 타입의
   * 일부가 아니다 (AgentTurnResult는 이 파일 소유가 아니므로 필드를 늘리지 않는다).
   * 실패 턴(`success === false`, `handled === true` 포함)은 turnCollector가 없으면
   * `endTurn.reason: 'end_turn'` fallback으로 포장되기 때문에, 결과만 봐서는
   * 건강한 턴과 구분되지 않는다. yield 게이트는 이 플래그로 구분한다.
   */
  private _lastTurnSucceeded = false;

  constructor(config: V1QueryAdapterConfig) {
    this.executor = config.streamExecutor;
    this.baseParams = config.executeParams;
    this.runner = config.turnRunner;
    this.shouldYieldToFollowup = config.shouldYieldToFollowup;
    this._abortController = (config.executeParams as any).abortController ?? new AbortController();
  }

  async start(prompt: string): Promise<AgentTurnResult> {
    this._started = true;
    this.turnCount = 1;
    // Ghost Session Fix #99: reuse baseParams.abortController (registered in RequestCoordinator)
    // instead of creating a new one that abort signals can't reach
    return this.executeTurn(prompt, { isFirstDispatchTurn: true });
  }

  async continue(userPrompt: string): Promise<AgentTurnResult> {
    if (!this._started) {
      throw new Error('Session not started. Call start() first.');
    }
    this.turnCount++;
    // Ghost Session Fix #99: reuse baseParams.abortController — same as start()
    return this.executeTurn(userPrompt, { isFirstDispatchTurn: false });
  }

  cancel(): void {
    // Ghost Session Fix #99: abort the current baseParams controller.
    // B-2: tag the reason so handleError's notifyWorthyAbort gate routes
    // the resulting AbortError to the silent `'user-stop'` branch (the
    // user already knows they hit cancel — no card needed) rather than
    // the unknown-abort fallback card.
    const controller = (this.baseParams as any).abortController ?? this._abortController;
    controller.abort('user-stop');
  }

  dispose(): void {
    // v1 query 기반이라 연결 유지 없음 — abort and cleanup.
    // B-2: tag with `'session-close'` (per-session lifecycle teardown,
    // distinct from `'shutdown'` which is reserved for process-wide
    // `RequestCoordinator.clearAll`).
    const controller = (this.baseParams as any).abortController ?? this._abortController;
    controller.abort('session-close');
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
   * 마지막으로 정착한 턴의 execute() 성공 여부 (U4a).
   *
   * 호스트 dispatcher가 "정상 완료"와 "handled된 실패"를 구분하는 신호다.
   * `getLastExecuteResult()`로는 구분할 수 없다 — `mapToExecuteResult`는
   * `success: true`를 고정으로 넣고(`map-to-execute-result.ts:28`),
   * 실패 fallback 결과의 `endTurn.reason`도 `'end_turn'`이다.
   * 턴 실행 전에는 false.
   */
  getLastTurnSucceeded(): boolean {
    return this._lastTurnSucceeded;
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
      // Follow-up yield seam (U4a): `lastResult`는 executeTurn이 execute()와
      // runner.finish()를 모두 await한 뒤에만 여기 도달한다 — 즉 이 지점은
      // 진행 중인 턴이 없는 유일한 안전 지점이다. continuation 판정/reset보다
      // 먼저 물어보므로, yield는 *다음* 턴을 취소할 뿐 실행 중인 턴을 자르지 않는다.
      if (await this.shouldYieldAfterSettledTurn(lastResult)) {
        return lastResult;
      }

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

  /**
   * 정착한 턴 하나에 대해 follow-up yield 여부를 판정한다 (U4a).
   *
   * 콜백이 없으면 항상 false — 루프 판정은 기존과 동일하다 (await 한 번이
   * 추가되므로 마이크로태스크 틱은 늘어난다). 안전 조건(성공·pending choice
   * 없음·abort 아님·종료 사유)이 모두 참일 때만 콜백을 호출하고, 콜백이
   * 명시적으로 `true`를 줄 때만 yield한다.
   */
  private async shouldYieldAfterSettledTurn(result: AgentTurnResult): Promise<boolean> {
    const gate = this.shouldYieldToFollowup;
    if (!gate) return false;

    // 실패 턴은 yield 대상이 아니다 — handled=true(Exception 카드 노출 완료)라도
    // 마찬가지다. 실패 경로의 fallback 결과는 endTurn.reason이 'end_turn'이라
    // 결과 모양만으로는 건강해 보인다.
    if (!this._lastTurnSucceeded) return false;

    // 유저 선택 대기 중이면 세션은 유저 소유 — follow-up이 가로챌 수 없다.
    if (result.hasPendingChoice) return false;

    // cancel()/dispose()/stall abort 이후에는 새 dispatch를 띄우지 않는다.
    const controller: AbortController | undefined = (this.baseParams as any).abortController ?? this._abortController;
    if (controller?.signal?.aborted) return false;

    // tool_use·max_tokens는 "작업이 남은" 종료 — 기존 continuation 의미론이
    // 소유한다. 중단 안전성이 증명되기 전까지 seam은 관여하지 않는다.
    const reason = result.endTurn?.reason;
    if (reason !== 'end_turn' && reason !== 'stop_sequence') return false;

    return (await gate(result)) === true;
  }

  /** 내부 baseParams 업데이트 (session refresh 등) */
  updateBaseParams(patch: Record<string, any>): void {
    Object.assign(this.baseParams, patch);
  }

  private async executeTurn(text: string, options: { isFirstDispatchTurn: boolean }): Promise<AgentTurnResult> {
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
        // SET_GOAL/SSOT gate (stream-executor): only the FIRST turn of a
        // dispatch may carry the caller's `isUserInput` (slack-handler sets
        // `!context.synthetic`); continuation turns are always synthetic.
        // NOTE: do NOT infer this from `turnCount` — `start()` bumps the
        // counter to 1 BEFORE this runs, so a `turnCount === 0` check is
        // never true and silently demoted every user turn to `false`
        // (SET_GOAL was refused 100% of the time). The explicit flag from
        // start()/continue() is authorization state; the counter is not.
        // Pass the base value through untouched on the first turn —
        // `undefined` and `false` mean different things downstream
        // (SSOT tracking checks `!== false`, SET_GOAL checks `=== true`).
        isUserInput: options.isFirstDispatchTurn ? (this.baseParams as any).isUserInput : false,
      };

      const executeResult = await this.executor.execute(params);

      // success=false without collector → 실패 (Review: Gemini P0 → P2)
      // catch block이 runner.fail()을 호출하므로 여기선 throw만
      // retryAfterMs 보존: handleMessage에서 auto-retry 스케줄링에 사용
      //
      // Bug fix: when `handled === true`, StreamExecutor's catch branch
      // already surfaced the failure to the user (Exception card +
      // status/reaction). Throwing here would propagate to slack-handler's
      // catch and out to Bolt as `slack_bolt_unknown_error`, polluting logs
      // without any added UX. Resolve with a degraded-but-valid AgentTurnResult
      // and let the normal turn-end path run (runner.finish below). Stall-
      // timeout abort is the primary trigger — see `stream-executor.ts`
      // `handleError()` and PR fix/exception-card-render-message-not-sessiontitle.
      // Emergency prompt-too-long recovery (auto fallback compact):
      // StreamExecutor's handleError already switched `session.model` to the
      // configured 1M compact model (default `opus[1m]`) and stashed the
      // triggering user text. Re-enter immediately with the SDK-local
      // `/compact` command — it runs on the 1M window, so it fits. The compact
      // boundary handler then restores the original model and re-dispatches
      // the stashed text. `session` is shared by reference with the executor,
      // so the model switch is already visible on `baseParams.session`.
      // `_lastRetryAfterMs` stays unset so SlackHandler's generic auto-retry
      // does not double-fire alongside this in-adapter retry.
      if (!executeResult.success && (executeResult as any).fallbackCompact) {
        this._lastRetryAfterMs = undefined;
        return await this.continue('/compact');
      }

      // U4a: 이 턴의 실행 결과를 기록한다. fallbackCompact 재진입 뒤에 두어야
      // 재진입 턴(실제로 반환되는 턴)의 결과가 플래그를 소유한다.
      this._lastTurnSucceeded = executeResult.success === true;

      if (!executeResult.success && !executeResult.turnCollector) {
        this._lastRetryAfterMs = (executeResult as any).retryAfterMs;
        if (!executeResult.handled) {
          throw new Error('StreamExecutor returned success=false');
        }
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
      // U4a: 던지는 턴은 정착한 턴이 아니다 — yield 게이트가 닫히도록 기록.
      this._lastTurnSucceeded = false;
      // TurnRunner lifecycle: fail
      await this.runner?.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
