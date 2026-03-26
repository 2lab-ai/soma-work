# AgentSession Phase 3c — handleMessage → V1QueryAdapter 연결

> STV Spec | Created: 2026-03-25 | Parent: Issue #42 (Phase 3a: PR #73, Phase 3b: PR #85)

## 1. Overview

Phase 3b에서 IAgentSession + V1QueryAdapter + TurnRunner를 구축했다.
Phase 3c는 **실제 연결**: slack-handler.ts의 handleMessage()가 StreamExecutor.execute()를
직접 호출하는 `while(true)` continuation 루프(lines 361-407)를 V1QueryAdapter의
start/continue API로 전환한다.

핵심 가치: handleMessage가 더 이상 StreamExecutor를 직접 알지 않고,
IAgentSession 인터페이스만 사용하게 된다. 이것이 V2 SDK 전환의 실질적 관문이다.

## 2. User Stories

- As a **slack-handler**, I want to call `agentSession.start(prompt)` instead of
  `streamExecutor.execute(params)`, so that the execution layer is abstracted behind
  a clean interface.
- As a **continuation flow**, I want the continuation loop to be managed inside
  V1QueryAdapter, so that handleMessage doesn't need to know about reset/dispatch/refetch logic.
- As a **future V2 adapter**, I want handleMessage to depend only on IAgentSession,
  so that swapping the adapter is the only change needed for V2 migration.

## 3. Acceptance Criteria

- [ ] handleMessage의 `while(true)` continuation 루프가 V1QueryAdapter 내부로 이동
- [ ] handleMessage에서 `this.streamExecutor.execute()` 직접 호출 제거
- [ ] 대신 `agentSession.start(prompt)` → AgentTurnResult 사용
- [ ] continuation 시 `agentSession.continue(prompt)` 호출
- [ ] V1QueryAdapter에 continuation 루프 내장 (startWithContinuation)
- [ ] session reset + dispatch 콜백을 V1QueryAdapter에 주입 가능
- [ ] TurnRunner가 ThreadSurface와 실제 연결 (not just test mock)
- [ ] 기존 handleMessage의 모든 기능 보존 (abort, file processing, session init 등)
- [ ] 기존 테스트 regression 없음
- [ ] tsc --noEmit 0 errors
- [ ] 신규 integration 테스트

## 4. Scope

### In-Scope
- handleMessage의 Step 5 (continuation 루프) → V1QueryAdapter 전환
- V1QueryAdapter.startWithContinuation() — 내부 continuation 루프
- ContinuationHandler 콜백 인터페이스 (resetSession, dispatch 등)
- TurnRunner ↔ ThreadSurface 실제 wiring
- handleMessage가 IAgentSession factory를 통해 adapter를 생성

### Out-of-Scope
- handleMessage의 Step 1-4 (file processing, command routing, session init) 변경 없음
- StreamExecutor 내부 수정 (adapter가 감싸기만)
- V2SessionAdapter (미래)
- auto-resume.ts 연결 (별도 이슈)

## 5. Architecture

### 5.1 Before vs After

```
BEFORE (현재):
handleMessage
  └── while(true)
        ├── streamExecutor.execute(params)
        ├── if continuation → resetSession + dispatch
        └── refetch session, loop

AFTER (Phase 3c):
handleMessage
  └── agentSession = createAgentSession(sessionResult)
  └── result = agentSession.start(prompt)
  └── (continuation은 adapter 내부에서 처리)
```

### 5.2 New/Modified Files

| File | Type | Description | Est. LOC |
|------|------|-------------|----------|
| `src/agent-session/v1-query-adapter.ts` | MOD | startWithContinuation() + ContinuationHandler | ~80 |
| `src/slack-handler.ts` | MOD | Step 5 교체: while loop → agentSession.start() | ~40 (net reduction) |
| `src/agent-session/agent-session-types.ts` | MOD | ContinuationHandler 타입 추가 | ~15 |
| `src/agent-session/__tests__/v1-query-adapter-continuation.test.ts` | NEW | continuation 루프 테스트 | ~120 |
| `src/slack-handler.test.ts` | MOD | 기존 테스트 어댑터 전환 반영 | ~30 |

### 5.3 ContinuationHandler Interface

```typescript
export interface ContinuationHandler {
  /** continuation 결과에서 다음 프롬프트 추출 */
  shouldContinue(result: AgentTurnResult): { continue: boolean; prompt?: string };
  /** resetSession 요청 처리 */
  onResetSession?(continuation: unknown): Promise<void>;
  /** 세션 재조회 */
  refreshSession?(): any;
}
```

### 5.4 Integration Points

| 기존 코드 | 연결 방식 | 파괴 여부 |
|-----------|----------|----------|
| StreamExecutor.execute() | V1QueryAdapter가 내부 호출 (이미 Phase 3b) | 없음 |
| claudeHandler.resetSessionContext() | ContinuationHandler.onResetSession()에서 호출 | 없음 |
| sessionInitializer.runDispatch() | ContinuationHandler.onResetSession()에서 호출 | 없음 |
| claudeHandler.getSession() | ContinuationHandler.refreshSession()에서 호출 | 없음 |
| ThreadSurface/ThreadPanel | TurnRunnerSurface adapter로 wiring | 없음 |

## 6. Constraints

- 기존 StreamExecutor, StreamProcessor 파괴 금지
- handleMessage의 Step 1-4 로직 변경 금지
- 기존 1300+ 테스트 regression 없어야 함
- Slack 렌더링 즉시성 보장 유지

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| ContinuationHandler를 콜백 인터페이스로 | small | DI 패턴, handleMessage가 구체 로직 주입 |
| startWithContinuation()을 별도 메서드로 | small | 기존 start()와 구분, 기존 테스트 유지 |
| ThreadPanel을 TurnRunnerSurface로 adapter | tiny | setStatus/finalizeOnEndTurn 2메서드만 |
| factory function으로 adapter 생성 | small | handleMessage에서 생성 시 sessionResult 주입 |

## 8. Risks

| Risk | Mitigation |
|------|------------|
| continuation 루프 동작 차이 | 기존 while loop 행 동을 정확히 preserve하는 테스트 |
| abort 동작 변경 | V1QueryAdapter.cancel()이 AbortController.abort() 호출 확인 |
| ThreadPanel wiring 타이밍 | fire-and-forget 유지, error swallow |

## 9. Next Step

→ `stv:trace docs/agent-session-phase-3c/spec.md`로 시나리오별 vertical trace 생성
