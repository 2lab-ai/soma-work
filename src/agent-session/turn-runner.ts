/**
 * TurnRunner — Slack-facing 턴 라이프사이클 관리자 (Issue #84)
 *
 * AgentSession이 Slack을 모르게 분리하는 레이어.
 * begin/update/finish/fail 4개 메서드로 ThreadSurface 상태를 제어한다.
 *
 * 설계 원칙:
 * 1. fire-and-forget — ThreadSurface 에러가 턴 실행을 방해하지 않음
 * 2. Optional deps — threadSurface 없으면 모든 메서드가 no-op
 * 3. deriveStatus() 순수 함수로 상태 결정
 */

import type { AgentPhase, AgentTurnResult, EndTurnInfo } from './agent-session-types.js';
import { deriveStatus } from './derive-status.js';

/** ThreadSurface의 필요한 메서드만 추출한 인터페이스 */
export interface TurnRunnerSurface {
  setStatus(
    session: any,
    sessionKey: string,
    patch: { agentPhase?: string; activeTool?: string; waitingForChoice?: boolean },
  ): Promise<void>;
  finalizeOnEndTurn(
    session: any,
    sessionKey: string,
    endTurnInfo: EndTurnInfo,
    hasPendingChoice: boolean,
  ): Promise<void>;
}

export interface TurnRunnerDeps {
  threadSurface?: TurnRunnerSurface;
  session: any;
  sessionKey: string;
}

export class TurnRunner {
  private readonly surface?: TurnRunnerSurface;
  private readonly session: any;
  private readonly sessionKey: string;
  private _currentTurnId: string | undefined;
  private _turnStartTime: number | undefined;

  constructor(deps: TurnRunnerDeps) {
    this.surface = deps.threadSurface;
    this.session = deps.session;
    this.sessionKey = deps.sessionKey;
  }

  /** 턴 시작 — '생각 중' 상태로 전환 */
  async begin(turnId: string): Promise<void> {
    this._currentTurnId = turnId;
    this._turnStartTime = Date.now();
    await this.safeSetStatus({ agentPhase: '생각 중', waitingForChoice: false });
  }

  /** 턴 중간 업데이트 — coarse-grained phase 변경만 */
  async update(event: { phase: AgentPhase; activeTool?: string }): Promise<void> {
    await this.safeSetStatus({ agentPhase: event.phase, activeTool: event.activeTool });
  }

  /** 턴 정상 종료 — deriveStatus() → finalizeOnEndTurn() */
  async finish(result: AgentTurnResult): Promise<void> {
    // Trace S4 3c: deriveStatus로 최종 phase 결정
    // Phase 3c에서 TurnRunnerSurface API를 확장하여 finalPhase를 전달할 예정
    const _finalPhase = deriveStatus(result.endTurn, result.hasPendingChoice);

    try {
      await this.surface?.finalizeOnEndTurn(
        this.session,
        this.sessionKey,
        result.endTurn,
        result.hasPendingChoice,
      );
    } catch {
      // fire-and-forget
    }
    this._currentTurnId = undefined;
  }

  /** 턴 실패 — '오류' 상태로 전환 */
  async fail(_error: Error): Promise<void> {
    await this.safeSetStatus({ agentPhase: '오류', waitingForChoice: false });
    this._currentTurnId = undefined;
  }

  /** 현재 턴 ID */
  get currentTurnId(): string | undefined {
    return this._currentTurnId;
  }

  /** 턴 시작 시간 */
  get turnStartTime(): number | undefined {
    return this._turnStartTime;
  }

  private async safeSetStatus(patch: { agentPhase?: string; activeTool?: string; waitingForChoice?: boolean }): Promise<void> {
    try {
      await this.surface?.setStatus(this.session, this.sessionKey, patch);
    } catch {
      // fire-and-forget — ThreadSurface 에러가 턴 실행을 방해하지 않음
    }
  }
}
