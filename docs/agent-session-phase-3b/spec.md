# AgentSession Phase 3b — IAgentSession + V1QueryAdapter + TurnRunner

> STV Spec | Created: 2026-03-25 | Parent: Issue #42 (Phase 3a complete via PR #73)

## 1. Overview

Issue #42의 Option C 설계에서 마이그레이션 2~3단계에 해당하는 작업이다.
Phase 3a에서 TurnResultCollector, EndTurnInfo 파싱, Observer wiring을 완료했다.
이제 그 위에 **IAgentSession 인터페이스**, **V1QueryAdapter** (StreamExecutor 래퍼),
**TurnRunner** (Slack-facing lifecycle 관리자)를 구축하여 구조화된 세션 API를 제공한다.

핵심 가치: StreamExecutor의 1600줄짜리 모놀리스를 건드리지 않고, adapter 패턴으로
깔끔한 start/continue API를 만들어 향후 V2 SDK 전환의 토대를 마련한다.

## 2. User Stories

- As a **slack-handler**, I want to call `session.start(prompt)` and get a structured `AgentTurnResult`,
  so that I can mechanically process askUserQuestions, continuation, codeReview without ad-hoc parsing.
- As a **TurnRunner**, I want to observe turn lifecycle events (begin/update/finish/fail),
  so that ThreadSurface status updates are centralized and endTurn-driven.
- As a **future V2 adapter**, I want to implement IAgentSession with a different SDK backend,
  so that the migration is confined to one adapter swap.

## 3. Acceptance Criteria

- [ ] `IAgentSession` 인터페이스 정의: `start()`, `continue()`, `cancel()`, `dispose()`
- [ ] `V1QueryAdapter` 구현: StreamExecutor.execute()를 감싸서 IAgentSession 구현
- [ ] `V1QueryAdapter.start()` → `AgentTurnResult` 반환 (turnCollector.getResult() 사용)
- [ ] `V1QueryAdapter.continue()` → continuation prompt로 재실행 → AgentTurnResult 반환
- [ ] `TurnRunner` 구현: begin/update/finish/fail lifecycle
- [ ] `TurnRunner.finish()` → `deriveStatus()` 호출 → `ThreadSurface.finalizeOnEndTurn()` wiring
- [ ] `deriveStatus()` 순수 함수 추출 (endTurnInfo + hasPendingChoice → agentPhase)
- [ ] `AgentTurnResult`에 `usage: UsageData`, `durationMs: number` 필드 추가
- [ ] `TurnResultCollector`에서 usage, durationMs 수집 로직 추가
- [ ] `mapToExecuteResult()` 실제 호출 wiring (V1QueryAdapter 내부)
- [ ] 기존 1143+ 테스트 regression 없음
- [ ] tsc --noEmit 0 errors
- [ ] 신규 테스트: IAgentSession 단위 테스트, TurnRunner 단위 테스트, deriveStatus 테스트

## 4. Scope

### In-Scope
- IAgentSession 인터페이스 + V1QueryAdapter 구현
- TurnRunner lifecycle 관리자
- deriveStatus() 순수 함수 추출 + wiring
- AgentTurnResult 필드 확장 (usage, durationMs)
- mapToExecuteResult() wiring
- 단위 테스트

### Out-of-Scope
- handleMessage() 진입점 전환 (Phase 3c)
- V2SessionAdapter (미래)
- CodeReviewResult 타입 (Phase 3c)
- rawMcpResults[] 확장 (별도 이슈)
- continuation 루프 AgentSession 내부 이동 (Phase 3c)

## 5. Architecture

### 5.1 Layer Structure

```
┌─────────────────────────────────────────────────────┐
│  IAgentSession (인터페이스)                            │
│  - start(prompt): Promise<AgentTurnResult>           │
│  - continue(userPrompt): Promise<AgentTurnResult>    │
│  - cancel(): void                                    │
│  - dispose(): void                                   │
└───────────┬─────────────────────────────────────────┘
            │ implements
  ┌─────────▼──────────┐
  │ V1QueryAdapter     │ ← StreamExecutor.execute() 래핑
  │ (query() 기반)      │    ExecuteResult → AgentTurnResult 변환
  └─────────┬──────────┘
            │ uses
  ┌─────────▼──────────┐
  │ TurnResultCollector │ ← 이미 구현됨 (Phase 3a)
  │ + usage/durationMs  │    필드 확장만 필요
  └─────────┬──────────┘
            │
  ┌─────────▼──────────┐
  │ TurnRunner          │ ← Slack-facing 오케스트레이터
  │ - begin(turnId)     │    → ThreadSurface.setStatus('running')
  │ - update(event)     │    → ThreadSurface.setStatus(progress)
  │ - finish(result)    │    → deriveStatus() → finalizeOnEndTurn()
  │ - fail(error)       │    → ThreadSurface.setStatus('error')
  └────────────────────┘
```

### 5.2 File Structure

| File | Type | Description | Est. LOC |
|------|------|-------------|----------|
| `src/agent-session/agent-session.ts` | NEW | IAgentSession 인터페이스 | ~30 |
| `src/agent-session/v1-query-adapter.ts` | NEW | V1QueryAdapter 구현 | ~120 |
| `src/agent-session/turn-runner.ts` | NEW | TurnRunner lifecycle | ~80 |
| `src/agent-session/derive-status.ts` | NEW | deriveStatus() 순수 함수 | ~20 |
| `src/agent-session/agent-session-types.ts` | MOD | usage, durationMs 추가 | ~15 |
| `src/agent-session/turn-result-collector.ts` | MOD | usage, durationMs 수집 | ~20 |
| `src/agent-session/index.ts` | MOD | 새 export 추가 | ~10 |
| `src/agent-session/__tests__/v1-query-adapter.test.ts` | NEW | V1QueryAdapter 테스트 | ~150 |
| `src/agent-session/__tests__/turn-runner.test.ts` | NEW | TurnRunner 테스트 | ~100 |
| `src/agent-session/__tests__/derive-status.test.ts` | NEW | deriveStatus 테스트 | ~50 |

### 5.3 Interface Definitions

```typescript
// IAgentSession — 핵심 인터페이스
interface IAgentSession {
  start(prompt: string): Promise<AgentTurnResult>;
  continue(userPrompt: string): Promise<AgentTurnResult>;
  cancel(): void;
  dispose(): void;
}

// V1QueryAdapter — IAgentSession 구현
interface V1QueryAdapterDeps {
  streamExecutor: StreamExecutor;
  turnRunner?: TurnRunner;
}

// TurnRunner — Slack-facing lifecycle
interface TurnRunnerDeps {
  threadSurface: ThreadSurface;  // or ThreadPanel
}

interface TurnRunnerCallbacks {
  onBegin?(turnId: string): void;
  onUpdate?(event: TurnEvent): void;
  onFinish?(result: AgentTurnResult): void;
  onFail?(error: Error): void;
}

// deriveStatus — 순수 함수
type ThreadSurfaceStatus = '입력 대기' | '토큰 한도 도달' | '사용자 액션 대기' | '완료' | '오류';

function deriveStatus(
  endTurnInfo: EndTurnInfo,
  hasPendingChoice: boolean
): ThreadSurfaceStatus;
```

### 5.4 Integration Points

| 기존 코드 | 연결 방식 | 파괴 여부 |
|-----------|----------|----------|
| StreamExecutor.execute() | V1QueryAdapter가 호출 → ExecuteResult 수신 | 없음 (소비자) |
| TurnResultCollector.getResult() | V1QueryAdapter가 호출 → AgentTurnResult 반환 | 없음 (소비자) |
| ThreadSurface.finalizeOnEndTurn() | TurnRunner.finish()에서 호출 | 없음 (기존 scaffolding wiring) |
| mapToExecuteResult() | V1QueryAdapter 내부에서 역방향 참조용 | 없음 (기존 scaffolding) |
| StreamResult.usage | TurnResultCollector에서 수집 | 추가만 (append-only) |

## 6. Non-Functional Requirements

- **Performance**: V1QueryAdapter는 StreamExecutor 위의 thin wrapper. 오버헤드 < 1ms/turn.
- **Regression Safety**: 기존 코드 수정 최소화. adapter 패턴으로 새 파일만 추가.
- **Testability**: IAgentSession 인터페이스로 mock 가능. TurnRunner는 ThreadSurface mock으로 독립 테스트.
- **Future-proofing**: V2SessionAdapter 교체 시 IAgentSession 인터페이스 변경 없음.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| IAgentSession에 start/continue/cancel/dispose 4 메서드 | small | Option C 합의 + SDK v2 형태와 일치 |
| V1QueryAdapter가 StreamExecutor를 직접 주입받음 | small | DI 패턴, 14개 deps 재생성 불필요 |
| TurnRunner가 ThreadSurface를 주입받음 (ThreadPanel 아님) | tiny | ThreadPanel은 ThreadSurface의 thin wrapper |
| deriveStatus()를 별도 파일로 분리 | tiny | 순수 함수, 테스트 용이 |
| AgentTurnResult.usage는 UsageData 타입 재사용 | tiny | stream-processor.ts에 이미 정의 |
| durationMs는 execute() 시작~종료 시간차 | tiny | TurnResultCollector 아닌 V1QueryAdapter에서 계산 |
| 파일 위치: src/agent-session/ | tiny | Phase 3a에서 확립된 모듈 |

## 8. Open Questions

None — Option C 설계가 충분히 구체적이고, Phase 3a 구현으로 패턴이 확립됨.

## 9. Next Step

→ `stv:trace docs/agent-session-phase-3b/spec.md`로 시나리오별 vertical trace 생성
