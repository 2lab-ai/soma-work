# MCP Session Tick — Vertical Trace

> STV Trace | Created: 2026-03-04
> Spec: docs/mcp-session-tick/spec.md

## 목차
1. [Scenario 1 — Session Tick 생명주기](#scenario-1)
2. [Scenario 2 — Adaptive Backoff](#scenario-2)
3. [Scenario 3 — 2시간 Hard Timeout](#scenario-3)
4. [Scenario 4 — Stream Abort Cleanup](#scenario-4)
5. [Scenario 5 — Queue Overflow Safety Net](#scenario-5)
6. [Scenario 6 — 통합 메시지 렌더링](#scenario-6)

---

## Scenario 1 — Session Tick 생명주기

### 1.1 ASCII Diagram

```
 ToolEventProcessor.handleToolUse(toolUses, context)
   src/slack/tool-event-processor.ts:106
       │
       │  MCP 호출 감지: name.startsWith('mcp__')
       │  callId = mcpCallTracker.startCall(serverName, toolName)
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  McpStatusDisplay.registerCall(                     │
 │    sessionKey: string,                              │
 │    callId: string,                                  │
 │    config: StatusUpdateConfig,                      │
 │    channel: string,                                 │
 │    threadTs: string)                                │
 │  src/slack/mcp-status-tracker.ts (NEW METHOD)       │
 │                                                     │
 │  Step 1: activeCalls.set(callId, {                  │
 │    callId, sessionKey, config,                      │
 │    channel, threadTs,                               │
 │    startTime: Date.now(),                           │
 │    status: 'running'                                │
 │  })                                                 │
 │                                                     │
 │  Step 2: sessionTick 조회/생성                      │
 │    if (!sessionTicks.has(sessionKey))                │
 │      → createSessionTick(sessionKey, channel,       │
 │          threadTs)                                   │
 │    else                                             │
 │      → rescheduleTickIfNeeded(sessionKey)           │
 │                                                     │
 │  Invariants:                                        │
 │    - activeCalls에 동일 callId 중복 불가            │
 │    - sessionKey당 최대 1개 SessionTick              │
 └──────────────────────┬──────────────────────────────┘
                        │
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  createSessionTick(sessionKey, channel, threadTs)   │
 │                                                     │
 │  Step 1: sessionTick = {                            │
 │    sessionKey, channel, threadTs,                   │
 │    messageTs: null,                                 │
 │    interval: null,                                  │
 │    currentIntervalMs: 10000  (초기값)               │
 │  }                                                  │
 │                                                     │
 │  Step 2: sessionTicks.set(sessionKey, sessionTick)  │
 │                                                     │
 │  Step 3: startTick(sessionKey)                      │
 │    → interval = setInterval(() => tick(sessionKey), │
 │        currentIntervalMs)                           │
 │    → 즉시 첫 tick 실행 (tick(sessionKey))           │
 └──────────────────────┬──────────────────────────────┘
                        │ tick fires
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  tick(sessionKey)                                   │
 │                                                     │
 │  Step 1: calls = getSessionCalls(sessionKey)        │
 │    → activeCalls에서 sessionKey 매칭 필터           │
 │                                                     │
 │  Step 2: timeout 체크                               │
 │    for (call of calls)                              │
 │      if (elapsed >= MCP_TIMEOUT_MS)                 │
 │        call.status = 'timed_out'                    │
 │        logger.warn(...)                             │
 │                                                     │
 │  Step 3: adaptive interval 재계산                   │
 │    runningCalls = calls.filter(running)              │
 │    if (runningCalls.length === 0)                    │
 │      → 최종 렌더 + stopTick(sessionKey)             │
 │      return                                         │
 │    minInterval = min(runningCalls.map(adaptive))     │
 │    if (minInterval !== currentIntervalMs)            │
 │      → clearInterval + setInterval(newInterval)     │
 │                                                     │
 │  Step 4: 통합 메시지 렌더                           │
 │    text = buildConsolidatedText(calls)               │
 │    if (!messageTs)                                   │
 │      → postMessage → messageTs 저장                 │
 │    else                                              │
 │      → updateMessage (실패 시 warn, skip)            │
 │                                                     │
 │  MAX 1 Slack API call per tick                      │
 └─────────────────────────────────────────────────────┘
                        │ MCP tool_result arrives
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  McpStatusDisplay.completeCall(callId, duration)    │
 │                                                     │
 │  Step 1: call = activeCalls.get(callId)             │
 │    if (!call) return  // already completed/removed  │
 │                                                     │
 │  Step 2: activeCalls.set(callId, {                  │
 │    ...call, status: 'completed', duration           │
 │  })                                                 │
 │                                                     │
 │  Step 3: 다음 tick에서 자동 렌더                    │
 │    (모든 호출 completed → tick이 최종 렌더 후 정리)  │
 │                                                     │
 │  Invariants:                                        │
 │    - completeCall은 idempotent                      │
 │    - activeCalls에서 즉시 제거하지 않음             │
 │      (다음 tick의 최종 렌더에 표시하기 위해)         │
 └─────────────────────────────────────────────────────┘
```

### 1.2 Error Paths

| Condition | Error | Action |
|-----------|-------|--------|
| callId already registered | N/A | 기존 엔트리 덮어쓰기 (warn 로그) |
| postMessage 실패 | Slack API error | messageTs=null 유지, 다음 tick에서 재시도 |
| updateMessage 실패 | Slack API error | warn 로그, skip (다음 tick에서 재시도) |
| sessionKey에 활성 호출 없는데 tick | N/A | stopTick() 호출 |

### 1.3 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `registerCall creates session tick on first call` | Happy Path | Scenario 1, Step 2 |
| `registerCall reuses existing session tick` | Happy Path | Scenario 1, Step 2 else |
| `tick renders consolidated message via postMessage on first tick` | Happy Path | Scenario 1, tick Step 4 |
| `tick renders via updateMessage on subsequent ticks` | Happy Path | Scenario 1, tick Step 4 |
| `completeCall marks call as completed` | Happy Path | Scenario 1, completeCall |
| `tick stops when all calls completed` | Happy Path | Scenario 1, tick Step 3 |
| `completeCall is idempotent` | Invariant | Scenario 1, completeCall |
| `max 1 Slack API call per tick` | Invariant | Scenario 1, tick |

---

## Scenario 2 — Adaptive Backoff

### 2.1 ASCII Diagram

```
 tick(sessionKey)
       │
       ├─ calls = getSessionCalls(sessionKey)
       │    → [call1: elapsed 30s, call2: elapsed 5m]
       │
       ├─ adaptive intervals:
       │    call1: 30s < 60s → 10,000ms
       │    call2: 5m < 10m → 30,000ms
       │
       ├─ minInterval = min(10000, 30000) = 10,000ms
       │
       └─ if (currentIntervalMs !== 10000)
            clearInterval(this.interval)
            this.interval = setInterval(tick, 10000)
            this.currentIntervalMs = 10000
```

### 2.2 Adaptive Schedule

```typescript
function getAdaptiveInterval(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 10_000;     // 0-1분: 10초
  if (elapsedMs < 600_000) return 30_000;    // 1-10분: 30초
  if (elapsedMs < 1_800_000) return 60_000;  // 10-30분: 1분
  return 300_000;                             // 30분+: 5분
}
const MCP_TIMEOUT_MS = 2 * 60 * 60 * 1000;  // 2시간
```

### 2.3 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `getAdaptiveInterval returns 10s for <1m elapsed` | Contract | Scenario 2, schedule |
| `getAdaptiveInterval returns 30s for 1-10m elapsed` | Contract | Scenario 2, schedule |
| `getAdaptiveInterval returns 60s for 10-30m elapsed` | Contract | Scenario 2, schedule |
| `getAdaptiveInterval returns 300s for 30m+ elapsed` | Contract | Scenario 2, schedule |
| `tick reschedules interval when adaptive interval changes` | Happy Path | Scenario 2, diagram |
| `tick uses minimum interval across all active calls` | Invariant | Scenario 2, minInterval |
| `new short call reschedules to shorter interval` | Happy Path | Scenario 2 |

---

## Scenario 3 — 2시간 Hard Timeout

### 3.1 ASCII Diagram

```
 tick(sessionKey)
       │
       ├─ call.elapsed = Date.now() - call.startTime
       │
       ├─ if (elapsed >= 7,200,000)  // 2시간
       │    activeCalls.set(callId, { ...call, status: 'timed_out' })
       │    logger.warn('MCP call timed out', { callId, elapsed })
       │
       └─ 렌더 시: "⏱️ 타임아웃: {label} (2시간+)"
```

### 3.2 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `tick marks call as timed_out after 2 hours` | Happy Path | Scenario 3 |
| `timed_out call shown with timeout indicator` | Contract | Scenario 3, render |
| `tick stops after all calls completed or timed_out` | Happy Path | Scenario 3 |
| `timeout does not force-kill MCP call` | Invariant | Scenario 3 |

---

## Scenario 4 — Stream Abort Cleanup

### 4.1 ASCII Diagram

```
 StreamExecutor.execute() → finally block
   src/slack/pipeline/stream-executor.ts:704
       │
       │ cleanup(session, sessionKey)
       ▼
 ┌─────────────────────────────────────────────────────┐
 │ StreamExecutor.cleanup()                            │
 │                                                     │
 │  NEW: this.deps.toolEventProcessor                  │
 │       .cleanup(sessionKey)                          │
 └──────────────────────┬──────────────────────────────┘
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │ ToolEventProcessor.cleanup(sessionKey)  (CHANGED)   │
 │ src/slack/tool-event-processor.ts:309               │
 │                                                     │
 │  Step 1: activeMcpCallIds =                         │
 │    toolTracker.getActiveMcpCallIds()                │
 │    → string[] (callIds with no tool_result)         │
 │                                                     │
 │  Step 2: for (callId of activeMcpCallIds)           │
 │    mcpCallTracker.endCall(callId)                   │
 │    mcpStatusDisplay.completeCall(callId, null)      │
 │                                                     │
 │  Step 3: mcpStatusDisplay                           │
 │    .cleanupSession(sessionKey)                      │
 │    → tick 정리 + 최종 렌더                          │
 └─────────────────────────────────────────────────────┘
```

### 4.2 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `cleanup stops all active MCP status updates` | Happy Path | Scenario 4, Step 2 |
| `cleanup cleans up session tick` | Happy Path | Scenario 4, Step 3 |
| `cleanup is safe when no active calls` | Sad Path | Scenario 4 |
| `cleanupSession removes session tick and clears interval` | Side-Effect | Scenario 4, Step 3 |

---

## Scenario 5 — Queue Overflow Safety Net

### 5.1 ASCII Diagram

```
 SlackApiHelper.enqueue(execute)
   src/slack/slack-api-helper.ts:69
       │
       ├─ if (this.queue.length >= maxQueueSize)
       │    dropped = this.queue.shift()
       │    dropped.reject(new Error('Queue overflow'))
       │    logger.warn('dropped oldest request',
       │      { queueLength, maxQueueSize })
       │
       └─ this.queue.push({ execute, resolve, reject })
           this.processQueue()
```

### 5.2 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `enqueue drops oldest when queue at maxQueueSize` | Happy Path | Scenario 5 |
| `dropped item promise is rejected` | Contract | Scenario 5 |
| `enqueue logs warning on overflow` | Side-Effect | Scenario 5 |
| `queue accepts items below maxQueueSize` | Happy Path | Scenario 5 |
| `queue recovers after drain` | Happy Path | Scenario 5 |

---

## Scenario 6 — 통합 메시지 렌더링

### 6.1 Render Logic

```typescript
buildConsolidatedText(calls: ActiveCallEntry[]): string {
  const total = calls.length;
  const completed = calls.filter(c => c.status === 'completed').length;
  const timedOut = calls.filter(c => c.status === 'timed_out').length;
  const running = total - completed - timedOut;

  // Header
  if (running === 0)
    header = `🟢 ${total}개 작업 완료`;
  else
    header = `📊 ${total}개 작업 실행 중 (${completed}/${total} 완료)`;

  // Lines (기존 buildGroupStatusText 로직 재사용)
  for (call of calls):
    if completed: "🟢 {label} ({duration})"
    if timed_out: "⏱️ {label} (타임아웃)"
    if running: "⏳ {label} — {elapsed} {progressBar}"
}
```

### 6.2 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `renders running calls with elapsed and progress` | Contract | Scenario 6 |
| `renders completed calls with duration` | Contract | Scenario 6 |
| `renders timed_out calls with timeout indicator` | Contract | Scenario 6 |
| `renders mixed status correctly` | Contract | Scenario 6 |
| `header shows completion count` | Contract | Scenario 6 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| group/individual 구분 제거 → 통합 모드 | medium | 유저 선택, 메시지 수 감소로 큐 부담 감소 |
| activeCalls에서 completed 즉시 제거 안함 | small | 최종 렌더에 완료 상태 표시 필요 |
| tick에서 timeout 체크 | tiny | tick 실행 시점에 자연스럽게 체크 |
| queue overflow: FIFO drop (priority queue 아님) | small | safety net 용도로 단순 구현 충분 |
| cleanupSession: 최종 렌더 후 정리 | small | 사용자에게 마지막 상태 보여준 후 정리 |

## Implementation Status

| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. Session Tick 생명주기 | done | Ready | Ready for stv:work |
| 2. Adaptive Backoff | done | Ready | Ready for stv:work |
| 3. 2시간 Hard Timeout | done | Ready | Ready for stv:work |
| 4. Stream Abort Cleanup | done | Ready | Ready for stv:work |
| 5. Queue Overflow Safety Net | done | Ready | Ready for stv:work |
| 6. 통합 메시지 렌더링 | done | Ready | Ready for stv:work |

## Next Step

→ `stv:work` 로 구현 + Trace Verify 진행
