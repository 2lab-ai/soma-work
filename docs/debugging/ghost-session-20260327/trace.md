# Bug Trace: Ghost Session — 세션이 종료되지 않고 계속 동작

## AS-IS (현재 동작)
1. Thread 세션에서 대화를 많이 보내면, 같은 채널에서 **복수의 스트리밍 프로세스**가 동시에 돌아감
2. `!{프롬프트}` (abort + 새 프롬프트)를 보내면 이전 스트리밍이 멈추지 않고 계속 Slack에 메시지를 전송
3. `close` 명령으로 세션을 종료해도 **고스트 프로세스**가 유저 명령을 무시하고 계속 동작
4. 유저가 제어권을 완전히 상실

## TO-BE (기대 동작)
1. 하나의 thread에는 **하나의 스트리밍 프로세스만** 존재해야 함
2. `!{프롬프트}` 전송 시 기존 스트리밍이 **즉시 중단**되고, 새 프롬프트로 교체되어야 함
3. `close` 실행 시 모든 진행 중인 스트리밍이 **완전히 중단**되고 세션이 삭제되어야 함
4. 유저가 항상 세션을 제어할 수 있어야 함

---

## 1st Principle 분석: "abort가 왜 안 먹히는가?"

### 사실 1: abort의 물리적 메커니즘
AbortController는 **참조 기반**이다. `controller.abort()`를 호출하면, 그 controller의 `.signal`을 듣고 있는 코드만 중단된다. **다른 AbortController 인스턴스를 듣고 있는 코드에는 효과가 없다.**

### 사실 2: abort 제어의 단일 진입점
시스템에서 abort를 발동하는 경로는 오직 하나다:
- `RequestCoordinator.abortSession(sessionKey)` → `this.activeControllers.get(sessionKey).abort()`
- `request-coordinator.ts:42-49`

### 사실 3: 스트리밍이 듣는 AbortController
SDK 스트리밍은 `StreamExecutor.execute()`에 전달된 `abortController` 파라미터의 `.signal`을 사용한다.
- `stream-executor.ts:566-568` → `processor.process(streamQuery, streamContext, abortController.signal)`

### 핵심 질문: RequestCoordinator가 abort하는 controller와 SDK가 사용하는 controller가 **동일 인스턴스**인가?

---

## Phase 1: Callstack 추적

### 경로 A — Controller 등록 (RequestCoordinator 쪽)

```
session-initializer.ts:884  const abortController = new AbortController();     ← 인스턴스 "A" 생성
session-initializer.ts:885  this.deps.requestCoordinator.setController(key, A) ← "A"를 등록
session-initializer.ts:888  return abortController;                            ← "A"를 반환
```

→ `SessionInitResult.abortController` = **A**

```
slack-handler.ts:464   executeParams.abortController = sessionResult.abortController  ← A
slack-handler.ts:475   new V1QueryAdapter({ executeParams })                          ← A가 executeParams에 포함
```

→ `V1QueryAdapter.baseParams.abortController` = **A**

```
v1-query-adapter.ts:50   this._abortController = executeParams.abortController ?? new AbortController()  ← A
```

→ `this._abortController` = **A** (이 시점에서 일치)

### 경로 B — Controller 사용 (SDK 쪽)

```
v1-query-adapter.ts:53-57  async start(prompt) {
                              this._abortController = new AbortController();  ← 인스턴스 "B" 생성! A 덮어씀!
                              return this.executeTurn(prompt);
                            }
```

→ `this._abortController` = **B** (A가 아님!)

```
v1-query-adapter.ts:154-158  const params = {
                                ...this.baseParams,              ← abortController: A 포함
                                text,
                                abortController: this._abortController,  ← B가 A를 덮어씀
                              };
```

→ `StreamExecutor.execute()`에 전달되는 것 = **B**

```
stream-executor.ts:566  streamQuery(finalPrompt, session, abortController=B, ...)
stream-executor.ts:568  abortController.signal  ← B의 signal
```

→ SDK가 사용하는 것 = **B**

### 경로 C — abort 발동

```
slack-handler.ts:248      requestCoordinator.abortSession(sessionKey)
request-coordinator.ts:43 controller = this.activeControllers.get(sessionKey)  ← A
request-coordinator.ts:45 controller.abort()                                    ← A.abort()
```

→ abort되는 것 = **A**

### 판정

| 항목 | 인스턴스 |
|------|----------|
| RequestCoordinator에 등록된 것 | **A** |
| SDK 스트리밍이 사용하는 것 | **B** |
| abort가 죽이는 것 | **A** |

**A ≠ B**. abort 신호는 SDK에 도달하지 않는다. **이것이 고스트 세션의 원인이다.**

---

## 보조 버그: finally에서의 Controller 삭제 레이스

```
stream-executor.ts:741-743  finally {
                              await this.cleanup(session, sessionKey);
                            }
stream-executor.ts:1062-1063  cleanup() {
                                this.deps.requestCoordinator.removeController(sessionKey);
                              }
```

`removeController`는 "현재 등록된 것"을 키 기준으로 삭제한다. 동시에 두 스트리밍이 돌 때:
1. 프로세스1 (오래된 것)의 finally → 프로세스2의 controller를 삭제해버림
2. 프로세스2는 이제 abort 불가

이건 AbortController 분열 문제와 **독립적으로** 존재하는 2차 버그다.

---

## 보조 버그: `!{prompt}` 자체가 새 handleMessage를 생성

```
slack-handler.ts:244-273
  if (trimmedText.startsWith('!')) {
    requestCoordinator.abortSession(sessionKey);  ← A를 abort (B는 안 죽음)
    event.text = followUpPrompt;
    // 파이프라인 계속 → sessionInitializer.initialize() → 새 Controller C 등록
    // → V1QueryAdapter.start() → Controller D 생성
    // → 새 스트리밍 시작
  }
```

`!{prompt}`는 Slack의 새 메시지이므로 Bolt가 별도의 `handleMessage()` 호출을 트리거한다.
이전 `handleMessage()`의 `await agentSession.startWithContinuation()`은 여전히 실행 중이다.
두 프로세스가 동시에 같은 thread에 메시지를 보낸다.

---

## 근본 원인 요약

```
┌─────────────────────────────────┐
│  SessionInitializer             │
│  creates Controller A           │
│  registers A in Coordinator     │──────► Coordinator: abort(A)
└───────────┬─────────────────────┘
            │ A
            ▼
┌─────────────────────────────────┐
│  V1QueryAdapter.start()         │
│  this._abortController = new()  │──► Controller B (A는 버려짐)
└───────────┬─────────────────────┘
            │ B
            ▼
┌─────────────────────────────────┐
│  StreamExecutor → SDK           │
│  uses B.signal                  │──────► SDK: listening to B (only)
└─────────────────────────────────┘

abort(A) → A dies → B alive → SDK keeps running → GHOST
```

하나의 문장으로: **abort 제어권(RequestCoordinator)과 abort 수신자(SDK)가 서로 다른 AbortController 인스턴스를 참조하기 때문에 abort 신호가 전달되지 않는다.**

---

## 수정 전략

### P0 (즉시): AbortController 통합
`V1QueryAdapter.start()`와 `continue()`에서 `new AbortController()` 제거.
`baseParams.abortController` (= RequestCoordinator가 관리하는 것)을 그대로 사용.

### P1 (방어): CAS 방식 removeController
`removeController(sessionKey, expectedController)`로 변경하여, 자신이 등록한 것만 삭제.

### P2 (방어): session.terminated 플래그
`terminateSession()` 시 session 객체에 `terminated = true` 설정.
`StreamProcessor`가 매 이벤트마다 확인하여 자체 중단.
