# Cron Scheduler — Spec

> STV Spec | Created: 2026-03-28 | Status: Implemented

## 1. Overview

Cron Scheduler는 유저가 등록한 반복 작업(cron job)을 정해진 시각에 자동으로 세션에 주입하는 post-turn 인프라다.
Claude Agent SDK의 내장 cron 도구를 차단하고, soma 자체 MCP 서버를 통해 CRUD를 제공하며,
60초 간격 폴링으로 cron expression을 평가하여 세션 상태(idle/busy/없음)에 따라 적절한 방식으로 프롬프트를 주입한다.

## 2. User Stories

- As a user, I want to register recurring tasks so that soma executes them automatically on schedule
- As a user, I want cron jobs to respect my session state — idle이면 즉시 실행, busy면 대기열에 넣기
- As a user, I want cron jobs to create new threads when no active session exists
- As a user, I want to list/delete my cron jobs via natural language (MCP tools)

## 3. Acceptance Criteria

- [x] SDK 내장 cron 도구 (`CronCreate`, `CronDelete`, `CronList`) 차단
- [x] MCP cron_create: name, expression(5-field), prompt, channel, threadTs 지원
- [x] MCP cron_delete: owner+name 기반 삭제
- [x] MCP cron_list: owner별 등록 작업 조회
- [x] 60초 간격 폴링, UTC 기준 cron expression 매칭
- [x] lastRunMinute 기반 분 단위 dedup (동일 분 내 재실행 방지)
- [x] Idle 세션 → 즉시 synthetic message 주입
- [x] Busy 세션 → pendingCronQueue에 적재, onIdle 콜백으로 1-job-per-idle 드레인
- [x] 세션 없음 → 새 Slack 스레드 생성 후 주입
- [x] tick() overlap guard (isRunning flag)
- [x] SLEEPING 세션 제외 (cron이 깨우지 않음)
- [x] cron expression 검증: */0 거부, 역순 range(5-1) 거부, 필드별 범위 검증

## 4. Scope

### In-Scope
- SDK 내장 cron 도구 차단 (disallowedTools)
- MCP cron CRUD (cron_create, cron_delete, cron_list)
- CronScheduler 60s 폴링 엔진
- Idle-aware injection (idle/busy/no-session 3분기)
- CronStorage file-based JSON persistence (atomic write)
- SessionRegistry onIdle callback mechanism

### Out-of-Scope
- Cron timezone 지원 (현재 UTC 고정)
- Cron job 실행 결과 추적/리포팅
- Web UI cron 관리
- Advisory file lock (MCP subprocess vs main process 동시 접근)

## 5. Architecture

### 5.1 Layer Structure

```
Model (Claude)
  ↓ MCP tool call
CronMcpServer (mcp-servers/cron/)          ← CRUD: create/delete/list
  ↓ file I/O
CronStorage (mcp-servers/_shared/)          ← JSON persistence + cron matching
  ↑ reads
CronScheduler (src/cron-scheduler.ts)       ← 60s polling engine
  ↓ synthetic event
MessageInjector (slack-handler.ts)          ← Slack message injection
  ↓ creates thread if needed
ThreadCreator (Slack API)                   ← New thread for no-session case
```

### 5.2 Key Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `CronMcpServer` | `mcp-servers/cron/cron-mcp-server.ts` | MCP tool definitions, context parsing |
| `CronStorage` | `mcp-servers/_shared/cron-storage.ts` | CronJob CRUD, cron expression matching, file persistence |
| `CronScheduler` | `src/cron-scheduler.ts` (dist/) | 60s tick loop, idle/busy/no-session dispatch |
| `McpConfigBuilder` | `src/mcp-config-builder.ts` (dist/) | SDK tool blocking, MCP server registration |

### 5.3 Data Schema

```typescript
interface CronJob {
  id: string;                    // crypto.randomUUID()
  name: string;                  // unique per owner, [a-zA-Z0-9_-]{1,64}
  expression: string;            // 5-field cron: min hour dom mon dow (UTC)
  prompt: string;                // max 4000 chars
  owner: string;                 // Slack user ID
  channel: string;               // Slack channel ID
  threadTs: string | null;       // target thread (null = any/new)
  createdAt: string;             // ISO 8601
  lastRunAt: string | null;      // ISO 8601
  lastRunMinute: string | null;  // YYYY-MM-DDTHH:mm (dedup key)
}
```

Persistence: `${DATA_DIR}/cron-jobs.json` (atomic tmp+rename write)

### 5.4 Integration Points

| Integration | Mechanism |
|-------------|-----------|
| SDK tool blocking | `disallowedTools: ['CronCreate', 'CronDelete', 'CronList']` in McpConfigBuilder |
| MCP server spawn | `npx tsx cron-mcp-server.ts` with `SOMA_CRON_CONTEXT` env |
| SessionRegistry | `registerOnIdle(sessionKey, callback)` for deferred cron drain |
| MessageInjector | `deps.messageInjector(syntheticEvent)` — reuses Slack handler pipeline |
| ThreadCreator | `deps.threadCreator(channel, text)` — posts root message, returns ts |

## 6. Non-Functional Requirements

- **Performance**: 60s polling interval, tick() overlap guard prevents accumulation
- **Reliability**: Atomic file writes, lastRunMinute dedup, error → mark as run (prevent retry storm)
- **Scalability**: Single-process polling, file-based storage — sufficient for current scale

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| UTC-only cron evaluation | tiny | Simplicity, no timezone DB dependency |
| File-based JSON storage | tiny | Follows existing pattern (report-scheduler.ts) |
| 1-job-per-idle drain policy | small | Prevents model flooding from queued crons |
| `[cron:name] prompt` message format | tiny | Distinguishable synthetic messages |
| CronMcpServer NOT migrated to BaseMcpServer | small | Pre-dates base class, works correctly |

## 8. Open Questions

- Advisory file lock for CronStorage (MCP subprocess vs main process concurrent access) — deferred
- Cron timezone support — deferred (UTC sufficient for now)

## 9. Implementation History (PRs)

| PR | Date | Title | Status |
|----|------|-------|--------|
| [#133](https://github.com/2lab-ai/soma-work/pull/133) | 2026-03-28 | feat: CronScheduler with idle-aware injection and native tool blocking | Merged |
| [#138](https://github.com/2lab-ai/soma-work/pull/138) | 2026-03-28 | fix: harden CronScheduler — Codex review findings | Merged |
| [#146](https://github.com/2lab-ai/soma-work/pull/146) | 2026-03-28 | fix: cron expression matching uses UTC, immediate tick on start | Merged |
| [#148](https://github.com/2lab-ai/soma-work/pull/148) | 2026-03-28 | test: harden cron UTC and immediate-tick tests | Merged |
| [#151](https://github.com/2lab-ai/soma-work/pull/151) | 2026-03-28 | fix: remove mcp-servers/ dependency on src/ for production deployment | Merged |

## 10. Scenarios (6)

| # | Scenario | Size | Status |
|---|----------|------|--------|
| S1 | SDK Cron Tool Blocking | small | Implemented |
| S2 | Cron MCP: cron_create | medium | Implemented |
| S3 | Cron MCP: cron_delete & cron_list | small | Implemented |
| S4 | CronScheduler: Idle Injection | medium | Implemented |
| S5 | CronScheduler: Busy Queue + Idle Drain | large | Implemented |
| S6 | CronScheduler: No Session → New Thread | medium | Implemented |

## 11. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/cron-scheduler/spec.md`
