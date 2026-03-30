# Daily/Weekly Report — Spec

> STV Spec | Created: 2026-03-25

## 1. Overview

soma-work Slack bot에 일간/주간 메트릭 리포트 기능을 추가한다. 세션 활동, GitHub 작업, 대화 턴 등 10가지 핵심 메트릭을 이벤트 소싱 방식으로 수집하고, 지정된 Slack 채널에 자동 포스팅한다. 주간 리포트에는 사용자별 랭킹이 포함된다.

## 2. User Stories

- As a **팀 리더**, I want to see daily aggregate metrics of soma-work usage, so that I can track team productivity and bot utilization.
- As a **팀원**, I want to see my weekly ranking compared to teammates, so that I can understand my contribution level.
- As a **관리자**, I want to configure report channel and schedule, so that reports go to the right audience.
- As a **유저**, I want to manually trigger a report via slash command, so that I can check metrics on demand.

## 3. Acceptance Criteria

- [ ] 10개 메트릭 이벤트가 발생 시점에 `/data/metrics-events.jsonl`에 append된다
- [ ] 일간 리포트: 매일 자정(KST) 전일 메트릭 집계를 지정 채널에 포스팅
- [ ] 주간 리포트: 매주 월요일 09:00(KST) 전주 메트릭 집계 + 사용자별 랭킹 포스팅
- [ ] `/report daily` 명령으로 일간 리포트 수동 트리거
- [ ] `/report weekly` 명령으로 주간 리포트 수동 트리거
- [ ] 리포트 채널은 환경변수 `REPORT_CHANNEL_ID`로 설정
- [ ] 이벤트 로그 파일은 일 단위 rotation 지원 (metrics-events-YYYY-MM-DD.jsonl)
- [ ] 모든 이벤트에는 userId, userName, timestamp, eventType 포함

## 4. Scope

### In-Scope
- 10가지 메트릭 이벤트 수집 (Event Sourcing)
- 일간/주간 리포트 생성 및 Slack 채널 포스팅
- `/report` 슬래시 커맨드 (daily/weekly)
- 리포트 스케줄러 (setInterval 기반)
- 이벤트 로그 일별 rotation
- Slack Block Kit 포맷 리포트 메시지

### Out-of-Scope
- 유저별 DM 발송
- 웹 대시보드 / 차트 시각화
- 커스텀 기간 조회
- 이벤트 로그 압축/아카이빙
- 외부 분석 서비스 연동

## 5. Architecture

### 5.1 Layer Structure

```
[이벤트 발생지점]        [수집 계층]           [집계/리포트 계층]      [배포 계층]
SessionRegistry    →  MetricsEventEmitter  →  ReportAggregator    →  ReportPublisher
ConversationRecorder     ↓                       ↓                      ↓
GitHub operations   MetricsEventStore      ReportFormatter       Slack Channel
                   (JSONL append)         (Block Kit)           (postMessage)
```

### 5.2 New Modules

| Module | Path | Responsibility |
|--------|------|---------------|
| `MetricsEventEmitter` | `src/metrics/event-emitter.ts` | 이벤트 emit 인터페이스, EventStore에 기록 |
| `MetricsEventStore` | `src/metrics/event-store.ts` | JSONL 파일 append/read, 일별 rotation |
| `ReportAggregator` | `src/metrics/report-aggregator.ts` | 기간별 이벤트 집계, 사용자별 그룹핑 |
| `ReportFormatter` | `src/metrics/report-formatter.ts` | Slack Block Kit 메시지 포맷팅 |
| `ReportPublisher` | `src/metrics/report-publisher.ts` | Slack 채널 포스팅 |
| `ReportScheduler` | `src/metrics/report-scheduler.ts` | 일간/주간 스케줄 관리 (setInterval) |
| `ReportHandler` | `src/slack/commands/report-handler.ts` | `/report` 커맨드 핸들러 |

### 5.3 Event Schema

```typescript
interface MetricsEvent {
  id: string;              // UUID
  timestamp: number;       // Unix ms
  eventType: MetricsEventType;
  userId: string;          // Slack user ID
  userName: string;        // Slack display name
  sessionKey?: string;     // Session reference
  metadata?: Record<string, unknown>;  // Event-specific data
}

type MetricsEventType =
  | 'session_created'
  | 'session_slept'
  | 'session_closed'
  | 'issue_created'
  | 'pr_created'
  | 'commit_created'
  | 'code_lines_added'
  | 'pr_merged'
  | 'merge_lines_added'
  | 'turn_used';
```

### 5.4 Event Metadata per Type

| Event Type | metadata fields |
|------------|----------------|
| `session_created` | `{ channelId, threadTs }` |
| `session_slept` | `{ channelId, sleepReason }` |
| `session_closed` | `{ channelId, closeReason }` |
| `issue_created` | `{ issueUrl, repo, issueNumber }` |
| `pr_created` | `{ prUrl, repo, prNumber }` |
| `commit_created` | `{ commitSha, repo, linesAdded, linesDeleted }` |
| `code_lines_added` | `{ linesAdded, linesDeleted, repo, prNumber }` |
| `pr_merged` | `{ prUrl, repo, prNumber }` |
| `merge_lines_added` | `{ linesAdded, linesDeleted, repo, prNumber }` |
| `turn_used` | `{ conversationId, role }` |

### 5.5 Storage Format

```
/data/metrics-events-2026-03-25.jsonl
/data/metrics-events-2026-03-24.jsonl
...
```

Each line: JSON-encoded MetricsEvent, newline-delimited.

### 5.6 Report Aggregation Output

```typescript
interface DailyReport {
  date: string;            // YYYY-MM-DD
  period: 'daily';
  metrics: AggregatedMetrics;
}

interface WeeklyReport {
  weekStart: string;       // YYYY-MM-DD (Monday)
  weekEnd: string;         // YYYY-MM-DD (Sunday)
  period: 'weekly';
  metrics: AggregatedMetrics;
  rankings: UserRanking[];
}

interface AggregatedMetrics {
  sessionsCreated: number;
  sessionsSlept: number;
  sessionsClosed: number;
  issuesCreated: number;
  prsCreated: number;
  commitsCreated: number;
  codeLinesAdded: number;
  prsMerged: number;
  mergeLinesAdded: number;
  turnsUsed: number;
}

interface UserRanking {
  userId: string;
  userName: string;
  metrics: AggregatedMetrics;
  rank: number;           // Overall rank (weighted score)
}
```

### 5.7 Integration Points (Event Emit Hooks)

| # | File | Hook Location | Event |
|---|------|--------------|-------|
| 1 | `session-registry.ts` | `createSession()` | `session_created` |
| 2 | `session-registry.ts` | `sleepSession()` | `session_slept` |
| 3 | `session-registry.ts` | `closeSession()` / `deleteSession()` | `session_closed` |
| 4 | `conversation/recorder.ts` | `recordUserTurn()` | `turn_used` |
| 5 | `conversation/recorder.ts` | `recordAssistantTurn()` | `turn_used` |
| 6-10 | Model command results / directives | GitHub issue/PR/commit/merge 감지 | `issue_created`, `pr_created`, `commit_created`, `code_lines_added`, `pr_merged`, `merge_lines_added` |

GitHub 이벤트(6-10)는 모델 커맨드 결과나 세션 링크 업데이트 시점에서 감지. 구체적으로:
- `session-registry.ts`의 `updateResourceLinks()` 에서 issue/PR link 추가 시 emit
- Agent의 `git commit`, `gh pr create`, `gh pr merge` 등의 tool 실행 결과에서 감지

### 5.8 Slash Command

```
/report          → 도움말 표시
/report daily    → 오늘(또는 직전 날) 일간 리포트 수동 트리거
/report weekly   → 이번 주(또는 직전 주) 주간 리포트 수동 트리거
```

### 5.9 Scheduling

```typescript
// KST = UTC+9
// Daily: 매일 00:00 KST (= 15:00 UTC 전일)
// Weekly: 매주 월요일 09:00 KST (= 00:00 UTC 월요일)

// setInterval 기반, 1분마다 현재 시각 체크
// 마지막 실행 시각을 /data/report-schedule.json에 저장하여 중복 방지
```

### 5.10 Configuration

```
REPORT_CHANNEL_ID    # Slack 채널 ID (필수)
REPORT_TIMEZONE      # 기본값: 'Asia/Seoul' (optional)
REPORT_DAILY_HOUR    # 기본값: 0 (00시, optional)
REPORT_WEEKLY_DAY    # 기본값: 1 (월요일, optional)
REPORT_WEEKLY_HOUR   # 기본값: 9 (09시, optional)
```

## 6. Non-Functional Requirements

- **Performance**: 이벤트 emit은 fire-and-forget (비동기 append, 메인 플로우 블로킹 없음)
- **Reliability**: JSONL append는 atomic write 불필요 (append-only, 라인 단위 무결성)
- **Scalability**: 일 단위 파일 rotation으로 단일 파일 크기 제한. 일 1000이벤트 기준 ~200KB/일
- **Security**: 이벤트 데이터에 민감 정보 미포함 (userId, userName, URL만)

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 모듈 위치 `src/metrics/` | tiny | 기능 단위 디렉토리 구조, 기존 패턴 따름 |
| JSONL 포맷 | tiny | 이벤트 로그에 최적. append-only, 라인 단위 파싱 |
| 일별 파일 rotation | small | 파일 크기 관리 + 기간 조회 성능. 파일명으로 날짜 범위 필터 |
| setInterval 1분 폴링 | small | cron 라이브러리 미도입, 기존 패턴(token-refresh-scheduler) 따름 |
| 슬래시 커맨드 `/report` | tiny | 기존 command-router 패턴 그대로 |
| Block Kit 메시지 포맷 | small | 기존 Slack 메시지 패턴 따름. 가독성 우수 |
| 랭킹 기준: weighted score | small | `turnsUsed*1 + prsCreated*5 + prsMerged*10 + commitsCreated*3` 가중치 적용 |
| 환경변수 기반 설정 | tiny | 기존 패턴 따름. config.json보다 단순 |

## 8. Open Questions

None — 모든 결정 완료.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/daily-weekly-report/spec.md`
