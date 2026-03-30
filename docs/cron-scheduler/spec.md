# Cron Scheduler System — Spec

> STV Spec | Created: 2026-03-28

## 1. Overview

soma-work에 cron 스케줄링 시스템을 추가한다. 모델이 MCP를 통해 cron을 등록/삭제/조회하고, 등록된 cron이 발동 시 해당 세션의 모델이 idle 상태가 될 때까지 대기한 뒤 유저 메시지처럼 주입하여 처리한다. Claude Agent SDK 내장 CronCreate/CronDelete/CronList 툴은 차단하여 충돌을 방지한다.

## 2. User Stories

- As a model, I want to register a recurring cron job via MCP, so that I can schedule periodic tasks (daily reports, reminders, health checks).
- As a model, I want to list and delete existing cron jobs, so that I can manage scheduled tasks.
- As a user, I want cron jobs to wait until the model is idle before executing, so that my current conversation is not interrupted.
- As an operator, I want SDK native cron tools blocked, so that only soma's managed cron system is used.

## 3. Acceptance Criteria

- [ ] SDK CronCreate/CronDelete/CronList tools are blocked via `disallowedTools`
- [ ] Cron MCP server exposes `cron_create`, `cron_delete`, `cron_list` tools to model
- [ ] Cron jobs persist across server restarts (`${DATA_DIR}/cron-jobs.json`)
- [ ] CronScheduler polls every 60 seconds, matches cron expressions against current time
- [ ] When cron fires and session is idle → immediately inject as synthetic user message
- [ ] When cron fires and session is busy → queue and drain on idle transition
- [ ] When cron fires and no active session → create new bot-initiated thread
- [ ] Cron jobs are scoped to owner(userId) + channel
- [ ] Red-Green TDD for all new code

## 4. Scope

### In-Scope
- SDK Cron tool blocking
- Cron MCP server (CRUD)
- CronScheduler (polling, queue, idle-aware injection)
- Cron storage (persistent JSON)
- onIdle callback mechanism in SessionRegistry
- Integration with startup/shutdown lifecycle

### Out-of-Scope
- Cron expression validation UI
- Complex recurrence rules (only standard 5-field cron)
- Cron execution history/logging dashboard
- Multi-timezone per-cron support (uses server timezone)

## 5. Architecture

### 5.1 Layer Structure

```
Model (via MCP)
  → cron-mcp-server.ts [CRUD tools]
    → cron-storage.ts [persistent JSON read/write]

CronScheduler (setInterval 60s)
  → cron-storage.ts [read jobs]
  → session-registry.ts [check activityState]
  → slack-handler.ts [inject synthetic message via handleMessage]

SessionRegistry.setActivityState('idle')
  → onIdleCallback [drain pending cron queue]
```

### 5.2 MCP Tools (cron-mcp-server)

| Tool | Params | Description |
|------|--------|-------------|
| `cron_create` | `name`, `expression`, `prompt`, `channel`, `threadTs?` | 크론 등록. owner는 SOMA_CRON_CONTEXT에서 추출 |
| `cron_delete` | `name` | 해당 유저의 크론 삭제 |
| `cron_list` | (none) | 해당 유저의 등록된 크론 목록 |

### 5.3 Data Schema

**cron-jobs.json**:
```json
{
  "jobs": [
    {
      "id": "uuid",
      "name": "daily-standup",
      "expression": "0 9 * * 1-5",
      "prompt": "오늘의 스탠드업 리포트를 작성해줘",
      "owner": "U094E5L4A15",
      "channel": "C0ANF3L7H0V",
      "threadTs": null,
      "createdAt": "2026-03-28T00:00:00Z",
      "lastRunAt": null,
      "lastRunDate": null
    }
  ]
}
```

### 5.4 Integration Points

| Component | File | Change |
|-----------|------|--------|
| SDK Cron blocking | `src/mcp-config-builder.ts:27` | `NATIVE_INTERACTIVE_TOOLS`에 3개 추가 |
| Cron MCP 등록 | `src/mcp-config-builder.ts:buildConfig()` | `internalServers['cron']` 추가 |
| onIdle callback | `src/session-registry.ts` | `onIdleCallbacks` Map + `registerOnIdle()` + drain in `setActivityState` |
| Scheduler lifecycle | `src/index.ts` | `CronScheduler.start()` / `.stop()` |
| Message injection | `src/slack-handler.ts` | `injectCronMessage()` — autoResumeSession 패턴 |

### 5.5 Idle-Aware Injection Flow

```
CronScheduler.tick() {
  for each due job:
    sessionKey = findSession(job.owner, job.channel)

    if no session:
      → create bot-initiated thread with synthetic message
    elif session.activityState === 'idle':
      → inject synthetic message immediately via handleMessage
    else:
      → pendingCronQueue.set(sessionKey, [..., job])
      → register onIdle callback for sessionKey
}

SessionRegistry.setActivityState(channel, threadTs, 'idle') {
  // ... existing logic ...
  // NEW: drain onIdle callbacks
  const callbacks = this.onIdleCallbacks.get(sessionKey)
  if (callbacks) {
    for (const cb of callbacks) cb()
    this.onIdleCallbacks.delete(sessionKey)
  }
}
```

## 6. Non-Functional Requirements

- **Performance**: 60초 폴링. 크론 수 <100 기준. O(N) scan 충분.
- **Reliability**: 서버 재시작 시 크론 유실 없음 (JSON 영속화). lastRunDate로 중복 실행 방지.
- **Security**: 크론은 owner별 격리. 타 유저의 크론 삭제/조회 불가.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| SDK Cron 차단: NATIVE_INTERACTIVE_TOOLS 배열에 추가 | tiny (~3 lines) | 기존 패턴, 배열에 문자열 3개 추가 |
| 저장소: `${DATA_DIR}/cron-jobs.json` | tiny (~5 lines) | report-schedule.json과 동일 패턴 |
| 폴링 주기: 60초 setInterval | tiny (~3 lines) | ReportScheduler와 동일 |
| MCP 서버 구조: model-command 패턴 | small (~20 lines) | 기존 패턴 그대로 복제 |
| Synthetic message: autoResumeSession 패턴 | small (~15 lines) | 기존 패턴 재사용 |
| Cron expression: 표준 5필드 (min hour dom mon dow) | small (~10 lines) | 업계 표준, node-cron 패키지 사용 |

## 8. Open Questions

None — 모든 결정 완료.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace`
