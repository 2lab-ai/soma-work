# Bug Trace: CRON-SYSTEM — Cron 시스템 설계 및 버그 분석

## Issue 1: SDK Cron 충돌
### AS-IS: Claude Agent SDK의 CronCreate/CronDelete/CronList가 모델에 노출됨
### TO-BE: SDK Cron 차단, soma 자체 cron만 사용

## Issue 2: soma Cron MCP 미구현
### AS-IS: cron 모듈이 존재하지 않음
### TO-BE: MCP 서버로 cron CRUD를 모델에 제공

## Issue 3: Cron 실행 타이밍 버그 (CRITICAL)
### AS-IS: cron 발동 시 모델 busy여도 처리 시도 → 실패/충돌
### TO-BE: cron 발동 → activityState 확인 → idle이 아니면 큐에 적재 → idle 전환 시 유저 메시지처럼 주입

---

## Phase 1: Heuristic Top-3

### Hypothesis 1: SDK Cron 차단 경로
- `src/mcp-config-builder.ts:27` → `NATIVE_INTERACTIVE_TOOLS = ['AskUserQuestion']`
- `src/mcp-config-builder.ts:236` → `config.disallowedTools = [...NATIVE_INTERACTIVE_TOOLS]`
- `src/claude-handler.ts:447-449` → `options.disallowedTools = mcpConfig.disallowedTools`
- **해법**: `NATIVE_INTERACTIVE_TOOLS`에 `CronCreate`, `CronDelete`, `CronList` 추가
- ✅ 확인됨 — 단순 배열 추가로 해결 가능

### Hypothesis 2: 메시지 주입 경로 (Cron → handleMessage)
- `src/slack-handler.ts:745-762` → `autoResumeSession()` — synthetic event로 `handleMessage` 호출하는 패턴 이미 존재
- `syntheticEvent` 패턴: `{ user, channel, thread_ts, ts, text }` → `handleMessage(syntheticEvent, noopSay)`
- **해법**: cron 발동 시 동일 패턴으로 synthetic message 주입
- ✅ 확인됨 — 기존 패턴 재사용 가능

### Hypothesis 3: idle 전환 감지 & 큐 드레인
- `src/slack/pipeline/stream-executor.ts:612-616` → 턴 완료 시 `setActivityState(channel, threadTs, hasPendingChoice ? 'waiting' : 'idle')`
- `src/slack/pipeline/stream-executor.ts:778` → 에러 시 `setActivityState(channel, threadTs, 'idle')`
- `src/session-registry.ts:369-387` → `setActivityState()` — idle 전환 시 `saveSessions()` 호출
- **해법**: `setActivityState` 안에 idle 전환 콜백(또는 EventEmitter) 추가, 큐에 적재된 cron 메시지를 드레인
- ✅ 확인됨 — SessionRegistry에 onIdleCallback 패턴 추가 필요

---

## Callstack Summary

### 메시지 처리 파이프라인:
```
Slack Event → EventRouter.setupMessageHandlers()
  → SlackHandler.handleMessage(event, say)
    → InputProcessor.processFiles()
    → SessionInitializer.initialize()
    → StreamExecutor.execute()
      → ClaudeHandler.queryStream() [activityState = 'working']
      → ... streaming ...
      → setActivityState('idle' or 'waiting') [턴 완료]
```

### Cron 주입 경로 (설계):
```
CronScheduler.tick()
  → check: session.activityState === 'idle'?
    → YES: inject synthetic message via handleMessage()
    → NO: enqueue to pendingCronQueue

SessionRegistry.setActivityState('idle')
  → drain pendingCronQueue
  → inject first queued cron via handleMessage()
```

### SDK Cron 차단:
```
McpConfigBuilder.buildConfig()
  → config.disallowedTools = ['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList']
  → ClaudeHandler.queryStream() → options.disallowedTools passed to SDK
```

---

## Architecture Decision: Cron MCP Server

New file: `mcp-servers/cron-mcp-server.ts`

Tools exposed to model:
- `cron_create(name, expression, prompt, channel, threadTs)` → 크론 등록
- `cron_delete(name)` → 크론 삭제
- `cron_list()` → 등록된 크론 목록

Storage: `${DATA_DIR}/cron-jobs.json`

Runtime: `CronScheduler` class in `src/cron-scheduler.ts`
- setInterval polling (60s)
- Matches cron expressions
- Checks session activityState before injection
- Queues if busy, drains on idle transition

## Files to Create/Modify

### New files:
1. `src/cron-scheduler.ts` — CronScheduler (polling + queue + injection)
2. `src/cron-scheduler.test.ts` — Tests
3. `mcp-servers/cron-mcp-server.ts` — MCP server for model CRUD
4. `src/cron-storage.ts` — Persistent cron job storage
5. `src/cron-storage.test.ts` — Tests

### Modified files:
1. `src/mcp-config-builder.ts` — SDK Cron 차단 + cron MCP 서버 등록
2. `src/mcp-config-builder.test.ts` — Tests
3. `src/session-registry.ts` — idle 전환 시 콜백 메커니즘
4. `src/slack-handler.ts` — CronScheduler 초기화 + handleMessage 연결
5. `src/index.ts` — CronScheduler 시작/종료
