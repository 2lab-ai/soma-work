# AgentSession Phase 3c — Vertical Trace

> STV Trace | Created: 2026-03-25
> Spec: docs/agent-session-phase-3c/spec.md

## Table of Contents
1. [Scenario 1 — ContinuationHandler 인터페이스 + 타입](#scenario-1)
2. [Scenario 2 — V1QueryAdapter.startWithContinuation()](#scenario-2)
3. [Scenario 3 — handleMessage Step 5 교체](#scenario-3)
4. [Scenario 4 — TurnRunner ↔ ThreadPanel 실제 wiring](#scenario-4)
5. [Scenario 5 — AgentSession factory function](#scenario-5)

---

## Scenario 1 — ContinuationHandler 인터페이스 + 타입

### 1. Entry Point
- Module: `src/agent-session/agent-session-types.ts` (MOD)
- Consumer: V1QueryAdapter, slack-handler.ts
- Type: Interface definition

### 2. Input
```typescript
export interface ContinuationHandler {
  shouldContinue(result: AgentTurnResult): { continue: boolean; prompt?: string };
  onResetSession?(continuation: unknown): Promise<void>;
  refreshSession?(): any;
}
```

### 3. Layer Flow

#### 3a. ContinuationHandler Type
- `shouldContinue()`: AgentTurnResult.continuation 검사 → {continue, prompt}
- `onResetSession()`: resetSession flag 시 claudeHandler.resetSessionContext + runDispatch
- `refreshSession()`: claudeHandler.getSession으로 세션 재조회

#### 3b. Export
- `src/agent-session/index.ts`에 ContinuationHandler export 추가

### 4. Side Effects
- None — pure type definition

### 5. Error Paths
- None

### 6. Output
- `ContinuationHandler` type available for import

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `ContinuationHandler_shouldContinue_returns_false_when_no_continuation` | Happy Path | S1, 3a |
| `ContinuationHandler_shouldContinue_returns_true_with_prompt` | Happy Path | S1, 3a |

---

## Scenario 2 — V1QueryAdapter.startWithContinuation()

### 1. Entry Point
- Module: `src/agent-session/v1-query-adapter.ts` (MOD)
- Method: `startWithContinuation(prompt, handler): Promise<AgentTurnResult>`
- Consumer: slack-handler.ts handleMessage

### 2. Input
```typescript
// Method signature
async startWithContinuation(
  prompt: string,
  handler: ContinuationHandler,
  processedFiles?: ProcessedFile[]
): Promise<AgentTurnResult>
```

### 3. Layer Flow

#### 3a. Initial execution
```
startWithContinuation(prompt, handler)
  → this.start(prompt)
  → result = AgentTurnResult
```

#### 3b. Continuation loop (moved from handleMessage)
```
while (true):
  { continue, prompt } = handler.shouldContinue(lastResult)
  if !continue → break

  if lastResult has resetSession:
    await handler.onResetSession(lastResult.continuation)
    session = handler.refreshSession()
    // Update internal executor params with new session

  this._abortController = new AbortController()
  lastResult = await this.continue(nextPrompt)

return lastResult
```

#### 3c. processedFiles handling
- First iteration: processedFiles 전달
- 후속 iteration: processedFiles = [] (기존 handleMessage 동작 보존)

### 4. Side Effects
- TurnRunner.begin/finish/fail called per turn (기존 동작)
- ContinuationHandler.onResetSession → session reset + dispatch

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| executor.execute throws | catch → runner.fail() → throw (기존 동작) |
| handler.onResetSession throws | propagate — critical path |
| handler.refreshSession returns null | throw Error('Session lost after reset') |

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `startWithContinuation_no_continuation_returns_single_result` | Happy Path | S2, 3a |
| `startWithContinuation_with_continuation_loops` | Happy Path | S2, 3b |
| `startWithContinuation_resetSession_calls_handler` | Integration | S2, 3b |
| `startWithContinuation_processedFiles_only_first_turn` | Edge Case | S2, 3c |
| `startWithContinuation_session_lost_after_reset_throws` | Sad Path | S2, 5 |

---

## Scenario 3 — handleMessage Step 5 교체

### 1. Entry Point
- Module: `src/slack-handler.ts` (MOD)
- Method: `handleMessage()` lines 355-407
- Change: `while(true)` loop → `agentSession.startWithContinuation()`

### 2. Input
- `sessionResult`, `effectiveText`, `processedFiles`, `wrappedSay`

### 3. Layer Flow

#### 3a. Before (current code, lines 355-407)
```typescript
// Step 5: Execute stream with continuation loop
let currentText = effectiveText;
while (true) {
  const result = await this.streamExecutor.execute({...params, text: currentText});
  if (!result.continuation) break;
  if (result.continuation.resetSession) { ... }
  currentText = result.continuation.prompt;
}
```

#### 3b. After (Phase 3c)
```typescript
// Step 5: Execute via AgentSession
const agentSession = this.createAgentSession(sessionResult, wrappedSay, {
  channel: activeChannel,
  threadTs: activeThreadTs,
  user: event.user,
  mentionTs: ts,
  originalThreadTs,
  originalChannel: channel,
});

const continuationHandler: ContinuationHandler = {
  shouldContinue: (result) => {
    if (!result.continuation) return { continue: false };
    return { continue: true, prompt: result.continuation.prompt };
  },
  onResetSession: async (continuation) => {
    this.claudeHandler.resetSessionContext(activeChannel, activeThreadTs);
    const dispatchText = continuation.dispatchText || continuation.prompt;
    await this.sessionInitializer.runDispatch(
      activeChannel, activeThreadTs, dispatchText, continuation.forceWorkflow
    );
  },
  refreshSession: () => this.claudeHandler.getSession(activeChannel, activeThreadTs),
};

await agentSession.startWithContinuation(effectiveText, continuationHandler, processedFiles);
```

#### 3c. Net code change
- ~45줄 while loop 제거
- ~25줄 agentSession 생성 + handler 정의 추가
- Net: ~20줄 감소

### 4. Side Effects
- 동일 — StreamExecutor.execute()가 동일하게 호출됨 (V1QueryAdapter 내부에서)

### 5. Error Paths
- 기존과 동일 — error는 handleMessage의 try-catch까지 propagate

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `handleMessage_uses_agentSession_instead_of_streamExecutor` | Integration | S3, 3b |
| `handleMessage_continuation_handled_by_adapter` | Integration | S3, 3b |
| `handleMessage_abort_cancels_agentSession` | Edge Case | S3, 3b |

---

## Scenario 4 — TurnRunner ↔ ThreadPanel 실제 wiring

### 1. Entry Point
- Module: `src/slack-handler.ts` (MOD)
- Change: TurnRunner 생성 시 ThreadPanel을 TurnRunnerSurface로 adapt

### 2. Input
```typescript
// ThreadPanel already has:
// - create(session, sessionKey) → initializes panel
// ThreadSurface already has:
// - setStatus(session, sessionKey, patch)
// - finalizeOnEndTurn(session, sessionKey, endTurnInfo, hasPendingChoice)
```

### 3. Layer Flow

#### 3a. ThreadPanel → TurnRunnerSurface adapter
```typescript
const turnRunnerSurface: TurnRunnerSurface = {
  setStatus: (session, sessionKey, patch) =>
    this.threadPanel?.setStatus(session, sessionKey, patch) ?? Promise.resolve(),
  finalizeOnEndTurn: (session, sessionKey, endTurnInfo, hasPendingChoice) =>
    this.threadPanel?.finalizeOnEndTurn(session, sessionKey, endTurnInfo, hasPendingChoice) ?? Promise.resolve(),
};
```

#### 3b. TurnRunner 생성
```typescript
const turnRunner = new TurnRunner({
  threadSurface: turnRunnerSurface,
  session: sessionResult.session,
  sessionKey: sessionResult.sessionKey,
});
```

### 4. Side Effects
- ThreadPanel status updates now flow through TurnRunner (fire-and-forget)

### 5. Error Paths
- ThreadPanel 없으면 noop (optional chaining)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `TurnRunner_wired_to_ThreadPanel_setStatus` | Integration | S4, 3a |
| `TurnRunner_wired_to_ThreadPanel_finalizeOnEndTurn` | Integration | S4, 3a |

---

## Scenario 5 — AgentSession factory function

### 1. Entry Point
- Module: `src/slack-handler.ts` (MOD)
- Method: `createAgentSession(sessionResult, say, context): V1QueryAdapter`

### 2. Input
```typescript
private createAgentSession(
  sessionResult: SessionInitResult,
  say: WrappedSay,
  context: {
    channel: string;
    threadTs: string;
    user: string;
    mentionTs: string;
    originalThreadTs: string;
    originalChannel: string;
  }
): V1QueryAdapter
```

### 3. Layer Flow

#### 3a. Factory assembles adapter
```typescript
createAgentSession(sessionResult, say, context) {
  // 1. Build TurnRunnerSurface from ThreadPanel
  const surface = this.buildTurnRunnerSurface();

  // 2. Create TurnRunner
  const turnRunner = new TurnRunner({
    threadSurface: surface,
    session: sessionResult.session,
    sessionKey: sessionResult.sessionKey,
  });

  // 3. Build execute params (same as current streamExecutor.execute params)
  const executeParams = {
    session: sessionResult.session,
    sessionKey: sessionResult.sessionKey,
    userName: sessionResult.userName,
    workingDirectory: sessionResult.workingDirectory,
    abortController: sessionResult.abortController,
    channel: context.channel,
    threadTs: context.threadTs,
    user: context.user,
    say,
    mentionTs: context.mentionTs,
  };

  // 4. Create V1QueryAdapter
  return new V1QueryAdapter({
    streamExecutor: this.streamExecutor,
    executeParams,
    turnRunner,
  });
}
```

### 4. Side Effects
- None — pure factory

### 5. Error Paths
- None

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `createAgentSession_returns_V1QueryAdapter` | Happy Path | S5, 3a |
| `createAgentSession_wires_TurnRunner_with_ThreadPanel` | Integration | S5, 3a |

---

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | ContinuationHandler 인터페이스 | small ~20줄 | 🔲 Ready |
| 2 | V1QueryAdapter.startWithContinuation() | medium ~80줄 | 🔲 Ready |
| 3 | handleMessage Step 5 교체 | medium ~40줄 | 🔲 Ready |
| 4 | TurnRunner ↔ ThreadPanel wiring | small ~20줄 | 🔲 Ready |
| 5 | AgentSession factory function | small ~30줄 | 🔲 Ready |
