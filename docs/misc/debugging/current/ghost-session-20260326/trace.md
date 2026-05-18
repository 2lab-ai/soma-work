# Bug Trace: Ghost Session — 고스트 세션이 종료되지 않음

## AS-IS
Thread 세션에서 대화를 많이 보내면(특히 `!{프롬프트}` 사용 시) 같은 채널에서 여러 세션이 동시에 돌아감.
`close`로 종료해도 고스트 세션이 유저 명령 무시하고 계속 동작함.

## TO-BE
하나의 thread에는 하나의 세션만 존재해야 하고, close/abort 시 모든 스트리밍이 확실히 중단되어야 함.

---

## Phase 1: Heuristic Top-3

### Hypothesis 1: AbortController 분열 — RequestCoordinator와 SDK가 다른 컨트롤러 사용 ✅ **ROOT CAUSE**

**전체 흐름:**

1. `slack-handler.ts:325` → `sessionInitializer.initialize()` 호출
2. `session-initializer.ts:884` → `new AbortController()` 생성 = **Controller A**
3. `session-initializer.ts:885` → `requestCoordinator.setController(sessionKey, A)` 등록
4. `slack-handler.ts:362` → `createAgentSession(sessionResult)` 호출
5. `slack-handler.ts:464` → `executeParams.abortController = sessionResult.abortController` (= A)
6. `v1-query-adapter.ts:50` → `this._abortController = executeParams.abortController` (= A)
7. **`v1-query-adapter.ts:56`** → `this._abortController = new AbortController()` = **Controller B** ← 여기서 분열
8. `v1-query-adapter.ts:157` → `params.abortController = this._abortController` (= B)
9. `stream-executor.ts:566` → `claudeHandler.streamQuery(..., abortController=B, ...)`
10. SDK 스트리밍은 **Controller B**를 사용

**abort 시:**
- `slack-handler.ts:248` → `requestCoordinator.abortSession(sessionKey)` → **Controller A를 abort**
- Controller A는 abort됨, 하지만 SDK는 Controller B를 듣고 있음
- **SDK 스트리밍은 abort 신호를 받지 못하고 계속 실행됨**

**`!{프롬프트}` 시나리오:**
```
1. 메시지1 → handleMessage() → 컨트롤러 A 등록, SDK는 B 사용 → 스트리밍 시작
2. "!새프롬프트" → handleMessage() → requestCoordinator.abort(A) → A만 abort됨, B는 살아있음
   → 새 컨트롤러 C 등록, SDK는 D 사용 → 새 스트리밍 시작
3. 이제 스트리밍 2개가 동시 실행:
   - 프로세스1: Controller B (abort 불가 - 참조 유실)
   - 프로세스2: Controller D (abort 불가 - C만 등록됨)
```

**close 시나리오:**
```
1. close → session-action-handler.ts:73 → requestCoordinator.abortSession() → 등록된 컨트롤러만 abort
2. terminateSession() → Map에서 세션 삭제
3. 하지만 실행 중인 SDK 스트리밍은 자체 AbortController를 들고 있어 abort 불가
4. 스트리밍 프로세스가 여전히 session 객체 참조를 갖고 있어 Slack에 계속 메시지 전송
```

### Hypothesis 2: Slack Bolt 이벤트 핸들러 동시 실행으로 다중 handleMessage 호출 — 보조 원인

- `event-router.ts:110-141` → `app.event('message')` 핸들러
- `event-router.ts:78` → `app.event('app_mention')` 핸들러
- Slack Bolt은 각 이벤트를 독립적으로 처리 → 동일 thread에서 빠른 연속 메시지 시 `handleMessage` 다중 동시 실행
- Hypothesis 1과 결합하여 각 동시 실행마다 고스트 프로세스 생성

### Hypothesis 3: `V1QueryAdapter.continue()`도 같은 문제 — 추가 경로

- `v1-query-adapter.ts:64-65` → `continue()`도 `new AbortController()` 생성
- continuation 루프(line 112-136)에서 매 턴마다 새 컨트롤러 생성 → 등록된 것과 불일치
- 장시간 세션에서 continuation이 반복될수록 abort 불가 상태 누적

---

## Conclusion

**Root Cause: `V1QueryAdapter.start()` (line 56)과 `V1QueryAdapter.continue()` (line 65)에서
`new AbortController()`를 생성하여 `requestCoordinator`에 등록된 컨트롤러와 분리됨.**

`requestCoordinator`가 abort하는 컨트롤러(A)와 SDK가 실제 사용하는 컨트롤러(B)가 다르기 때문에,
abort 신호가 SDK 스트리밍에 도달하지 않는다.

## Fix Strategy

**Option A (최소 변경)**: `V1QueryAdapter`가 자체 AbortController를 만들지 않고, `requestCoordinator`에서 관리하는 것을 그대로 사용하도록 수정.

```typescript
// v1-query-adapter.ts
async start(prompt: string): Promise<AgentTurnResult> {
    this._started = true;
    this.turnCount = 1;
    // 삭제: this._abortController = new AbortController();
    // baseParams의 abortController를 그대로 사용
    this._abortController = (this.baseParams as any).abortController;
    return this.executeTurn(prompt);
}

async continue(userPrompt: string): Promise<AgentTurnResult> {
    if (!this._started) throw new Error('Session not started');
    this.turnCount++;
    // 삭제: this._abortController = new AbortController();
    // 현재 등록된 controller를 그대로 사용
    this._abortController = (this.baseParams as any).abortController;
    return this.executeTurn(userPrompt);
}
```

**Option B (정석)**: AbortController 소유권을 단일 지점(requestCoordinator)으로 통합.
`V1QueryAdapter`가 새 컨트롤러를 만들어야 한다면, 만든 직후 `requestCoordinator`에 재등록.

**Option C (방어적)**: `StreamExecutor.execute()`가 시작 시 자신의 컨트롤러를 `requestCoordinator`에 재등록.

**추천: Option A** — 원인이 명확하고 변경 범위가 최소.

추가로, `terminateSession()` 호출 시 세션 객체에 `terminated = true` 플래그를 세워서
StreamProcessor/StreamExecutor가 매 이벤트마다 이 플래그를 확인하고 자체 중단하는 방어 로직도 필요.
