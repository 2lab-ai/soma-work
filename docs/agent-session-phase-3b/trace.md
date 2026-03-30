# AgentSession Phase 3b — Vertical Trace

> STV Trace | Created: 2026-03-25
> Spec: docs/agent-session-phase-3b/spec.md

## Table of Contents
1. [Scenario 1 — IAgentSession interface + deriveStatus](#scenario-1)
2. [Scenario 2 — V1QueryAdapter.start()](#scenario-2)
3. [Scenario 3 — V1QueryAdapter.continue()](#scenario-3)
4. [Scenario 4 — TurnRunner lifecycle](#scenario-4)
5. [Scenario 5 — AgentTurnResult field extension (usage + durationMs)](#scenario-5)
6. [Scenario 6 — mapToExecuteResult wiring](#scenario-6)

---

## Scenario 1 — IAgentSession interface + deriveStatus

### 1. Entry Point
- Module: `src/agent-session/agent-session.ts` (NEW)
- Consumer: V1QueryAdapter, future V2SessionAdapter
- Type: Interface definition (no runtime behavior)

### 2. Input
```typescript
interface IAgentSession {
  start(prompt: string): Promise<AgentTurnResult>;
  continue(userPrompt: string): Promise<AgentTurnResult>;
  cancel(): void;
  dispose(): void;
}
```

### 3. Layer Flow

#### 3a. IAgentSession Interface
- Pure type definition — no implementation
- `start(prompt)` → `Promise<AgentTurnResult>`
- `continue(userPrompt)` → `Promise<AgentTurnResult>` (same return type as start)
- `cancel()` → void (abort current turn)
- `dispose()` → void (cleanup resources)

#### 3b. deriveStatus() Pure Function
- File: `src/agent-session/derive-status.ts` (NEW)
- Input: `(endTurnInfo: EndTurnInfo, hasPendingChoice: boolean)`
- Output: `AgentPhase`
- Logic (extracted from thread-surface.ts:finalizeOnEndTurn):
  ```
  if hasPendingChoice → '입력 대기'
  if endTurnInfo.reason === 'max_tokens' → '토큰 한도 도달'
  if endTurnInfo.reason === 'end_turn' → '사용자 액션 대기'
  default → '사용자 액션 대기'
  ```
- Transformation: `EndTurnInfo.reason + hasPendingChoice → AgentPhase`

### 4. Side Effects
- None — pure type + pure function

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| Unknown stop_reason | Default to '사용자 액션 대기' |

### 6. Output
- `IAgentSession` type exported from `src/agent-session/index.ts`
- `deriveStatus()` function exported from `src/agent-session/index.ts`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `deriveStatus_pendingChoice_returns_입력대기` | Happy Path | S1, Section 3b |
| `deriveStatus_maxTokens_returns_토큰한도도달` | Happy Path | S1, Section 3b |
| `deriveStatus_endTurn_returns_사용자액션대기` | Happy Path | S1, Section 3b |
| `deriveStatus_toolUse_noPending_returns_사용자액션대기` | Happy Path | S1, Section 3b |
| `deriveStatus_unknownReason_defaults` | Sad Path | S1, Section 5 |

---

## Scenario 2 — V1QueryAdapter.start()

### 1. Entry Point
- Module: `src/agent-session/v1-query-adapter.ts` (NEW)
- Consumer: slack-handler.ts (future Phase 3c), tests
- Method: `V1QueryAdapter.start(prompt: string): Promise<AgentTurnResult>`

### 2. Input
```typescript
// Constructor deps
interface V1QueryAdapterConfig {
  streamExecutor: StreamExecutor;
  executeParams: Omit<StreamExecuteParams, 'text'>;  // session, sessionKey, etc.
  turnRunner?: TurnRunner;
}

// start() input
prompt: string  // user message text
```

### 3. Layer Flow

#### 3a. V1QueryAdapter.start()
- Transformation: `prompt → StreamExecuteParams.text`
- Merge: `config.executeParams + { text: prompt }` → full `StreamExecuteParams`
- Records `startTime = Date.now()` for durationMs calculation
- Calls `turnRunner?.begin(turnId)` if present

#### 3b. StreamExecutor.execute() (existing, unchanged)
- Input: `StreamExecuteParams`
- Output: `ExecuteResult { success, messageCount, continuation?, turnCollector? }`
- TurnResultCollector collects events during execution

#### 3c. Result Extraction
- Transformation:
  ```
  ExecuteResult.turnCollector.getResult() → AgentTurnResult (base)
  Date.now() - startTime → AgentTurnResult.durationMs
  ExecuteResult.turnCollector.usage → AgentTurnResult.usage (if collected)
  ```
- Calls `turnRunner?.finish(result)` if present

### 4. Side Effects
- StreamExecutor.execute() side effects (Slack messages, reactions, etc.) — delegated, not owned
- TurnRunner.begin/finish lifecycle events

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| StreamExecutor throws | Catch → `turnRunner?.fail(error)` → rethrow |
| ExecuteResult.success === false | Convert to AgentTurnResult with empty messages |
| turnCollector is undefined | Return minimal AgentTurnResult with defaults |

### 6. Output
```typescript
AgentTurnResult {
  messages: string[];           // from turnCollector
  askUserQuestions: [];          // from turnCollector
  toolCalls: [];                // from turnCollector
  modelCommandResults: [];      // from turnCollector
  endTurn: EndTurnInfo;         // from turnCollector
  continuation: unknown | null; // from turnCollector
  hasPendingChoice: boolean;    // from turnCollector
  usage?: UsageData;            // NEW: from streamResult via collector
  durationMs: number;           // NEW: computed in adapter
}
```

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `start_delegates_to_streamExecutor` | Happy Path | S2, Section 3a-3b |
| `start_returns_agentTurnResult` | Contract | S2, Section 3c |
| `start_computes_durationMs` | Contract | S2, Section 3c |
| `start_calls_turnRunner_begin_finish` | Side-Effect | S2, Section 4 |
| `start_on_error_calls_turnRunner_fail` | Sad Path | S2, Section 5 |
| `start_without_turnCollector_returns_defaults` | Sad Path | S2, Section 5 |

---

## Scenario 3 — V1QueryAdapter.continue()

### 1. Entry Point
- Method: `V1QueryAdapter.continue(userPrompt: string): Promise<AgentTurnResult>`

### 2. Input
```typescript
userPrompt: string  // user's response or continuation prompt
```

### 3. Layer Flow

#### 3a. V1QueryAdapter.continue()
- Transformation: `userPrompt → StreamExecuteParams.text`
- Same as `start()` but with updated text
- Increments internal `turnCount`
- Creates new `AbortController` for the new turn

#### 3b. StreamExecutor.execute() (same as Scenario 2)

#### 3c. Result Extraction (same as Scenario 2)

### 4. Side Effects
- Same as Scenario 2

### 5. Error Paths
- Same as Scenario 2
- Additional: `continue()` called before `start()` → throw Error('Session not started')

### 6. Output
- Same shape as Scenario 2

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `continue_delegates_to_streamExecutor_with_new_prompt` | Happy Path | S3, Section 3a |
| `continue_increments_turnCount` | Contract | S3, Section 3a |
| `continue_before_start_throws` | Sad Path | S3, Section 5 |

---

## Scenario 4 — TurnRunner lifecycle

### 1. Entry Point
- Module: `src/agent-session/turn-runner.ts` (NEW)
- Consumer: V1QueryAdapter
- Class: `TurnRunner`

### 2. Input
```typescript
interface TurnRunnerDeps {
  threadSurface?: {
    finalizeOnEndTurn(
      session: ConversationSession,
      sessionKey: string,
      endTurnInfo: EndTurnInfo,
      hasPendingChoice: boolean
    ): Promise<void>;
    setStatus(
      session: ConversationSession,
      sessionKey: string,
      patch: { agentPhase?: string; activeTool?: string; waitingForChoice?: boolean }
    ): Promise<void>;
  };
  session: ConversationSession;
  sessionKey: string;
}
```

### 3. Layer Flow

#### 3a. begin(turnId: string)
- Sets internal `_currentTurnId = turnId`
- Calls `threadSurface?.setStatus(session, sessionKey, { agentPhase: '생각 중' })`
- Records `_turnStartTime = Date.now()`

#### 3b. update(event: TurnEvent)
- Coarse-grained phase update only (not every tool call)
- TurnEvent: `{ phase: AgentPhase; activeTool?: string }`
- Calls `threadSurface?.setStatus(session, sessionKey, event)`

#### 3c. finish(result: AgentTurnResult)
- Calls `deriveStatus(result.endTurn, result.hasPendingChoice)` → finalPhase
- Calls `threadSurface?.finalizeOnEndTurn(session, sessionKey, result.endTurn, result.hasPendingChoice)`
- Clears `_currentTurnId`

#### 3d. fail(error: Error)
- Calls `threadSurface?.setStatus(session, sessionKey, { agentPhase: '오류' })`
- Clears `_currentTurnId`

### 4. Side Effects
- ThreadSurface.setStatus() → Slack action panel update
- ThreadSurface.finalizeOnEndTurn() → Slack final status update

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| threadSurface is undefined | No-op (TurnRunner works without Slack) |
| finish() without begin() | No-op or warning log |
| setStatus throws | Log error, don't propagate (fire-and-forget) |

### 6. Output
- No return value — side-effect only (Slack status updates)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `begin_sets_status_thinking` | Happy Path | S4, Section 3a |
| `finish_calls_finalizeOnEndTurn` | Happy Path | S4, Section 3c |
| `finish_calls_deriveStatus` | Contract | S4, Section 3c |
| `fail_sets_status_error` | Sad Path | S4, Section 3d |
| `no_threadSurface_is_noop` | Sad Path | S4, Section 5 |
| `finish_without_begin_is_safe` | Sad Path | S4, Section 5 |

---

## Scenario 5 — AgentTurnResult field extension (usage + durationMs)

### 1. Entry Point
- Module: `src/agent-session/agent-session-types.ts` (MOD)
- Module: `src/agent-session/turn-result-collector.ts` (MOD)

### 2. Input
- `UsageData` from `stream-processor.ts` (existing type)
- `durationMs` computed in V1QueryAdapter

### 3. Layer Flow

#### 3a. Type Extension
```typescript
// agent-session-types.ts additions:
interface AgentTurnResult {
  // ... existing fields ...
  usage?: UsageData;    // NEW
  durationMs?: number;  // NEW
}
```

#### 3b. TurnResultCollector Extension
- New method: `setUsage(usage: UsageData): void`
- `getResult()` includes `usage` field in returned AgentTurnResult
- `durationMs` is NOT set by collector — set by V1QueryAdapter after execute()

#### 3c. Wiring in StreamExecutor
- In `execute()` post-stream block (after line 573):
  ```
  streamResult.usage → turnCollector.setUsage(streamResult.usage)
  ```
- Transformation: `StreamResult.usage → TurnResultCollector._usage → AgentTurnResult.usage`

### 4. Side Effects
- None — data collection only

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| streamResult.usage is undefined | usage field remains undefined in result |

### 6. Output
- AgentTurnResult now includes `usage?: UsageData` and `durationMs?: number`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `collector_setUsage_included_in_result` | Happy Path | S5, Section 3b |
| `collector_no_usage_returns_undefined` | Sad Path | S5, Section 5 |
| `agentTurnResult_has_usage_and_durationMs_fields` | Contract | S5, Section 3a |

---

## Scenario 6 — mapToExecuteResult wiring

### 1. Entry Point
- Module: `src/agent-session/map-to-execute-result.ts` (existing, unchanged)
- Consumer: V1QueryAdapter (for reverse compatibility if needed)

### 2. Input
```typescript
AgentTurnResult → ExecuteResultCompat { success, messageCount, continuation? }
```

### 3. Layer Flow

#### 3a. V1QueryAdapter Internal Use
- `mapToExecuteResult()` is available for consumers who need ExecuteResult format
- V1QueryAdapter exposes: `getLastExecuteResult(): ExecuteResultCompat | undefined`
- Transformation: `AgentTurnResult → mapToExecuteResult() → ExecuteResultCompat`

### 4. Side Effects
- None — pure transformation

### 5. Error Paths
- None — mapToExecuteResult handles all AgentTurnResult shapes

### 6. Output
```typescript
ExecuteResultCompat {
  success: true,
  messageCount: result.messages.length,
  continuation: result.continuation ?? undefined,
}
```

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `adapter_exposes_lastExecuteResult` | Contract | S6, Section 3a |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| V1QueryAdapter takes StreamExecutor as dep (not deps separately) | small | 기존 14 deps 재조립 불필요, DI 원칙 |
| TurnRunner deps에 threadSurface optional | tiny | Slack 없이도 AgentSession 테스트 가능 |
| durationMs를 collector가 아닌 adapter에서 계산 | tiny | Collector는 execute() 범위 모름 |
| cancel()은 AbortController.abort() 위임 | tiny | 기존 abort 패턴과 동일 |
| dispose()는 v1에서 no-op (자원 해제 없음) | tiny | Query 기반이라 연결 유지 안 함 |
| TurnRunner.update()는 coarse event만 | small | 모든 tool call 전달 시 Slack API 과부하 |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. IAgentSession + deriveStatus | done | RED | Ready for stv:work |
| 2. V1QueryAdapter.start() | done | RED | Ready for stv:work |
| 3. V1QueryAdapter.continue() | done | RED | Ready for stv:work |
| 4. TurnRunner lifecycle | done | RED | Ready for stv:work |
| 5. AgentTurnResult field extension | done | RED | Ready for stv:work |
| 6. mapToExecuteResult wiring | done | RED | Ready for stv:work |

## Next Step
→ Proceed with implementation via `stv:work docs/agent-session-phase-3b/trace.md`
