# Cron Execution History — Spec

> STV Spec | Created: 2026-04-02 | Size: medium (~50 lines)

## 1. Overview

크론 작업 실행 시 결과(성공/실패, 타임스탬프, 실행 경로)를 기록하고,
MCP 도구(`cron_history`)로 이력을 조회할 수 있게 한다.
현재는 `lastRunAt`/`lastRunMinute`만 기록하여 "마지막 실행 시각"만 알 수 있지만,
과거 실행 이력은 전혀 볼 수 없다.

## 2. User Stories

- As a user, I want to see when my cron jobs ran and whether they succeeded
- As a user, I want to diagnose failed cron executions (which path: idle/busy/new-thread)

## 3. Acceptance Criteria

- [ ] 크론 실행 시 `CronExecutionRecord` 기록 (jobId, jobName, timestamp, status, executionPath)
- [ ] `cron_history` MCP 도구로 특정 job 또는 전체 이력 조회
- [ ] 이력 보존 제한: job당 최근 20건 (FIFO)
- [ ] 실패 시 error message 포함

## 4. Scope

### In-Scope
- `CronExecutionRecord` 타입 정의
- `CronStorage` 확장: `addExecution()`, `getExecutionHistory()`
- `CronScheduler` 수정: 실행 결과 기록
- `CronMcpServer` 확장: `cron_history` 도구 추가

### Out-of-Scope
- 실행 결과 본문(LLM 응답) 저장 — 너무 크다
- Web UI 이력 조회
- 이력 기반 알림/경고

## 5. Architecture

### 5.1 Data Schema

```typescript
interface CronExecutionRecord {
  jobId: string;
  jobName: string;
  executedAt: string;           // ISO 8601
  status: 'success' | 'failed' | 'queued';
  executionPath: 'idle_inject' | 'busy_queue' | 'new_thread';
  error?: string;               // only on failure
  sessionKey?: string;          // channel-threadTs
}
```

Storage: `${DATA_DIR}/cron-history.json` (별도 파일, jobs와 분리)
- 구조: `{ history: CronExecutionRecord[] }`
- Job당 최근 20건 유지 (addExecution 시 FIFO trim)

### 5.2 New MCP Tool

```
cron_history
  input: { name?: string, limit?: number }
  output: 해당 job(또는 전체)의 최근 실행 이력
```

### 5.3 Integration Points

| Where | Change |
|-------|--------|
| `CronStorage` | `addExecution()`, `getExecutionHistory()` 추가 |
| `CronScheduler.injectMessage()` | 성공 시 기록 |
| `CronScheduler.enqueueForIdle()` | queued 기록 |
| `CronScheduler.executeWithNewThread()` | 성공/실패 기록 |
| `CronScheduler.tick()` catch 블록 | 실패 기록 |
| `CronMcpServer` | `cron_history` 도구 등록 |

## 6. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 별도 파일 `cron-history.json` | tiny | jobs 파일 비대화 방지, 독립 lifecycle |
| Job당 20건 제한 | tiny | 매분 실행 시 20분치, 충분한 디버깅 윈도우 |
| LLM 응답 본문 미저장 | small | 저장 비용 대비 효용 낮음, sessionKey로 추적 가능 |
| `queued` status 별도 기록 | tiny | busy→idle drain 경로 추적에 필요 |

## 7. Open Questions

None — 모든 결정이 small 이하.

## 8. Scenarios (3)

| # | Scenario | Size | Status |
|---|----------|------|--------|
| S1 | Record execution on cron fire | small | Ready |
| S2 | MCP cron_history tool | small | Ready |
| S3 | History FIFO trim (20 per job) | tiny | Ready |

## 9. Next Step

→ `stv:trace docs/cron-execution-history/spec.md`
