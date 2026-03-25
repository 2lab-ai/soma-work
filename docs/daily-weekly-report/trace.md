# Daily/Weekly Report — Vertical Trace

> STV Trace | Created: 2026-03-25
> Spec: docs/daily-weekly-report/spec.md

## Table of Contents
1. [Scenario 1 — MetricsEventStore (JSONL Storage Layer)](#scenario-1)
2. [Scenario 2 — MetricsEventEmitter + Session Lifecycle Hooks](#scenario-2)
3. [Scenario 3 — MetricsEventEmitter + Turn & GitHub Hooks](#scenario-3)
4. [Scenario 4 — ReportAggregator (Daily/Weekly Aggregation)](#scenario-4)
5. [Scenario 5 — ReportFormatter + Publisher (Block Kit → Slack)](#scenario-5)
6. [Scenario 6 — ReportScheduler + ReportHandler (Scheduling + Slash Command)](#scenario-6)

---

## Scenario 1 — MetricsEventStore (JSONL Storage Layer)

> Foundation layer. All other scenarios depend on this.

### 1. API Entry
- Internal module (no HTTP endpoint)
- Called by: `MetricsEventEmitter.emit()` → `MetricsEventStore.append()`
- Called by: `ReportAggregator` → `MetricsEventStore.readRange()`

### 2. Input

**append(event):**
```typescript
MetricsEvent {
  id: string;              // UUID, auto-generated
  timestamp: number;       // Unix ms, auto-generated
  eventType: MetricsEventType;  // required
  userId: string;          // required
  userName: string;        // required
  sessionKey?: string;     // optional
  metadata?: Record<string, unknown>;  // optional
}
```

**readRange(startDate, endDate):**
```typescript
startDate: string;   // 'YYYY-MM-DD' (required)
endDate: string;     // 'YYYY-MM-DD' (required)
```

- Validation: startDate <= endDate, valid date format

### 3. Layer Flow

#### 3a. MetricsEventStore.append(event)

- File: `src/metrics/event-store.ts`
- Transformation:
  - `event` → `JSON.stringify(event) + '\n'` → file append
  - `event.timestamp` → Date → `YYYY-MM-DD` → filename: `metrics-events-YYYY-MM-DD.jsonl`
- Derived values:
  - filename: `path.join(DATA_DIR, \`metrics-events-${dateStr}.jsonl\`)`
- Implementation:
  ```
  event.timestamp → toDateString() → dateStr
  dateStr → path.join(DATA_DIR, `metrics-events-${dateStr}.jsonl`) → filePath
  event → JSON.stringify(event) → line
  line + '\n' → fs.appendFile(filePath) [async, fire-and-forget safe]
  ```

#### 3b. MetricsEventStore.readRange(startDate, endDate)

- File: `src/metrics/event-store.ts`
- Transformation:
  - `[startDate..endDate]` → date list → filename list → read each → parse lines → `MetricsEvent[]`
- Implementation:
  ```
  startDate, endDate → generateDateRange() → ['2026-03-20', '2026-03-21', ...]
  each dateStr → path.join(DATA_DIR, `metrics-events-${dateStr}.jsonl`) → filePath
  filePath → fs.readFile() → lines → JSON.parse(each line) → MetricsEvent[]
  all events concatenated → filtered by timestamp range → sorted by timestamp
  ```

### 4. Side Effects
- **File APPEND**: `{DATA_DIR}/metrics-events-{YYYY-MM-DD}.jsonl`
  - One JSON line per event
  - File created on first write of the day
- No DB, no cache, no events published

### 5. Error Paths

| Condition | Error | Handling |
|-----------|-------|----------|
| Append write failure (disk full) | ENOSPC | Log error, swallow (fire-and-forget, must not crash main flow) |
| File not found on read | ENOENT | Return empty array for that date (no events that day) |
| Corrupted JSON line | SyntaxError | Skip line, log warning, continue parsing |
| Invalid date format | ValueError | Throw, caller handles |

### 6. Output

**append()**: `void` (fire-and-forget)

**readRange()**: `MetricsEvent[]` sorted by timestamp ascending

### 7. Observability
- Log: `metrics-event-store: appended event {eventType} to {filename}` (debug)
- Log: `metrics-event-store: read {count} events from {startDate} to {endDate}` (debug)
- Log: `metrics-event-store: skipped corrupted line in {filename}:{lineNumber}` (warn)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `EventStore_append_writesToCorrectDateFile` | Happy Path | Scenario 1, Section 3a |
| `EventStore_readRange_returnsSortedEvents` | Happy Path | Scenario 1, Section 3b |
| `EventStore_readRange_emptyForMissingDate` | Sad Path | Scenario 1, Section 5, ENOENT |
| `EventStore_readRange_skipsCorruptedLines` | Sad Path | Scenario 1, Section 5, SyntaxError |
| `EventStore_append_fileCreatedOnFirstWrite` | Side-Effect | Scenario 1, Section 4 |
| `EventStore_readRange_multiDayAggregation` | Contract | Scenario 1, Section 3b, dateRange→files→events |

---

## Scenario 2 — MetricsEventEmitter + Session Lifecycle Hooks

> Hooks into SessionRegistry for session_created, session_slept, session_closed events.

### 1. API Entry
- Internal module (no HTTP endpoint)
- Trigger: SessionRegistry method calls
- File: `src/metrics/event-emitter.ts` (new)
- Hook locations: `src/session-registry.ts` (existing, modified)

### 2. Input

**emitSessionCreated(session):**
```typescript
session: ConversationSession  // from SessionRegistry.createSession()
// Extracted: session.ownerId, session.ownerName, session.channelId, session.threadTs
```

**emitSessionSlept(session):**
```typescript
session: ConversationSession  // from SessionRegistry.transitionToSleep()
```

**emitSessionClosed(session, sessionKey):**
```typescript
session: ConversationSession  // from SessionRegistry.terminateSession()
sessionKey: string
```

### 3. Layer Flow

#### 3a. MetricsEventEmitter (new module)

- File: `src/metrics/event-emitter.ts`
- Singleton pattern (like existing stores)
- Transformation:
  ```
  session.ownerId → event.userId
  session.ownerName → event.userName
  getSessionKey(session.channelId, session.threadTs) → event.sessionKey
  'session_created' | 'session_slept' | 'session_closed' → event.eventType
  Date.now() → event.timestamp
  randomUUID() → event.id
  { channelId: session.channelId, threadTs: session.threadTs } → event.metadata
  ```

#### 3b. SessionRegistry Integration (existing, modified)

- File: `src/session-registry.ts`
- Hook 1 — `createSession()` (line ~225, after `this.sessions.set()`):
  ```typescript
  metricsEmitter.emitSessionCreated(session);
  ```
- Hook 2 — `transitionToSleep()` (line ~325, after `this.saveSessions()`):
  ```typescript
  metricsEmitter.emitSessionSlept(session);
  ```
- Hook 3 — `terminateSession()` (line ~940, before `this.sessions.delete()`):
  ```typescript
  metricsEmitter.emitSessionClosed(session, sessionKey);
  ```

#### 3c. EventStore (delegates)

- `MetricsEventEmitter.emit*()` → constructs `MetricsEvent` → `MetricsEventStore.append(event)`

### 4. Side Effects
- File APPEND: via MetricsEventStore (Scenario 1)
- No changes to existing session persistence behavior

### 5. Error Paths

| Condition | Error | Handling |
|-----------|-------|----------|
| EventStore append failure | Any | Swallowed in fire-and-forget. Must not affect session operations |
| Session has no ownerId | Missing data | Skip emit, log warning |

### 6. Output
- `void` (all fire-and-forget)

### 7. Observability
- Log: `metrics-emitter: emitted {eventType} for user {userName}` (debug)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `Emitter_sessionCreated_writesEventToStore` | Happy Path | Scenario 2, Section 3a-3c |
| `Emitter_sessionSlept_writesEventToStore` | Happy Path | Scenario 2, Section 3a-3c |
| `Emitter_sessionClosed_writesEventToStore` | Happy Path | Scenario 2, Section 3a-3c |
| `Emitter_sessionCreated_containsCorrectMetadata` | Contract | Scenario 2, Section 3a, session→event transformation |
| `Emitter_fireAndForget_doesNotBlockOnFailure` | Sad Path | Scenario 2, Section 5 |

---

## Scenario 3 — MetricsEventEmitter + Turn & GitHub Hooks

> Hooks into ConversationRecorder for turn_used, and session link updates for GitHub events.

### 1. API Entry
- Internal module (no HTTP endpoint)
- Trigger: ConversationRecorder calls, SessionRegistry link updates
- Hook locations:
  - `src/conversation/recorder.ts` (existing, modified)
  - `src/session-registry.ts` `updateSessionResources()` (existing, modified)

### 2. Input

**emitTurnUsed(conversationId, userId, userName, role):**
```typescript
conversationId: string;
userId: string;
userName: string;
role: 'user' | 'assistant';
```

**emitGitHubEvent(eventType, userId, userName, sessionKey, metadata):**
```typescript
eventType: 'issue_created' | 'pr_created' | 'pr_merged';
userId: string;
userName: string;
sessionKey: string;
metadata: { url: string; repo?: string; number?: number };
```

### 3. Layer Flow

#### 3a. Turn Hooks in ConversationRecorder

- File: `src/conversation/recorder.ts`
- Hook in `recordUserTurn()` (line ~125):
  ```typescript
  metricsEmitter.emitTurnUsed(conversationId, userId ?? 'unknown', userName ?? 'unknown', 'user');
  ```
- Hook in `recordAssistantTurn()` (line ~165):
  ```typescript
  // Assistant turns: userId/userName from the session owner
  // Need to pass session context or use a thread-local approach
  metricsEmitter.emitTurnUsed(conversationId, 'assistant', 'assistant', 'assistant');
  ```
- Transformation:
  ```
  conversationId → event.metadata.conversationId
  userId → event.userId
  userName → event.userName
  role → event.metadata.role
  'turn_used' → event.eventType
  ```

#### 3b. GitHub Hooks in SessionRegistry.updateSessionResources()

- File: `src/session-registry.ts`
- In `updateSessionResources()`, after a link is added with `action: 'add'`:
  ```
  operation.resourceType === 'issue' && operation.action === 'add'
    → metricsEmitter.emitGitHubEvent('issue_created', session.ownerId, session.ownerName, sessionKey, { url: link.url })
  operation.resourceType === 'pr' && operation.action === 'add'
    → metricsEmitter.emitGitHubEvent('pr_created', session.ownerId, session.ownerName, sessionKey, { url: link.url })
  ```
- PR merge detection: when link status changes to 'merged':
  ```
  link.type === 'pr' && link.status === 'merged' && previousStatus !== 'merged'
    → metricsEmitter.emitGitHubEvent('pr_merged', session.ownerId, session.ownerName, sessionKey, { url: link.url })
  ```

### 4. Side Effects
- File APPEND: via MetricsEventStore (Scenario 1)
- No changes to existing conversation/session behavior

### 5. Error Paths

| Condition | Error | Handling |
|-----------|-------|----------|
| Missing userId in recordUserTurn | undefined | Default to 'unknown', still emit |
| EventStore failure | Any | Fire-and-forget, swallowed |

### 6. Output
- `void` (all fire-and-forget)

### 7. Observability
- Log: `metrics-emitter: emitted turn_used for {userId} in {conversationId}` (debug)
- Log: `metrics-emitter: emitted {eventType} for {url}` (debug)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `Emitter_turnUsed_userTurn_writesEvent` | Happy Path | Scenario 3, Section 3a |
| `Emitter_turnUsed_assistantTurn_writesEvent` | Happy Path | Scenario 3, Section 3a |
| `Emitter_issueCreated_onLinkAdd` | Happy Path | Scenario 3, Section 3b |
| `Emitter_prCreated_onLinkAdd` | Happy Path | Scenario 3, Section 3b |
| `Emitter_prMerged_onStatusChange` | Happy Path | Scenario 3, Section 3b |
| `Emitter_turnUsed_missingUserId_defaultsToUnknown` | Sad Path | Scenario 3, Section 5 |

---

## Scenario 4 — ReportAggregator (Daily/Weekly Aggregation)

> Reads events from EventStore and produces aggregated metrics.

### 1. API Entry
- Internal module (no HTTP endpoint)
- Called by: ReportScheduler, ReportHandler

### 2. Input

**aggregateDaily(date):**
```typescript
date: string;  // 'YYYY-MM-DD'
```

**aggregateWeekly(weekStart):**
```typescript
weekStart: string;  // 'YYYY-MM-DD' (Monday)
```

### 3. Layer Flow

#### 3a. ReportAggregator.aggregateDaily(date)

- File: `src/metrics/report-aggregator.ts`
- Transformation:
  ```
  date → MetricsEventStore.readRange(date, date) → events: MetricsEvent[]
  events → groupByEventType() → { session_created: [...], turn_used: [...], ... }
  counts per type → AggregatedMetrics {
    sessionsCreated: events.filter(e => e.eventType === 'session_created').length,
    sessionsSlept:   events.filter(e => e.eventType === 'session_slept').length,
    sessionsClosed:  events.filter(e => e.eventType === 'session_closed').length,
    issuesCreated:   events.filter(e => e.eventType === 'issue_created').length,
    prsCreated:      events.filter(e => e.eventType === 'pr_created').length,
    commitsCreated:  events.filter(e => e.eventType === 'commit_created').length,
    codeLinesAdded:  sum(events.filter(e => e.eventType === 'code_lines_added').map(e => e.metadata.linesAdded)),
    prsMerged:       events.filter(e => e.eventType === 'pr_merged').length,
    mergeLinesAdded: sum(events.filter(e => e.eventType === 'merge_lines_added').map(e => e.metadata.linesAdded)),
    turnsUsed:       events.filter(e => e.eventType === 'turn_used').length,
  }
  → DailyReport { date, period: 'daily', metrics }
  ```

#### 3b. ReportAggregator.aggregateWeekly(weekStart)

- File: `src/metrics/report-aggregator.ts`
- Transformation:
  ```
  weekStart → weekEnd = addDays(weekStart, 6)
  MetricsEventStore.readRange(weekStart, weekEnd) → events
  events → aggregate total (same as daily)
  events → groupByUserId() → Map<userId, MetricsEvent[]>
  per-user events → per-user AggregatedMetrics
  per-user metrics → sort by weightedScore (turnsUsed*1 + prsCreated*5 + prsMerged*10 + commitsCreated*3)
  → assign rank 1..N
  → WeeklyReport { weekStart, weekEnd, period: 'weekly', metrics, rankings }
  ```

#### 3c. Weighted Score Calculation

```
weightedScore = turnsUsed * 1
              + prsCreated * 5
              + prsMerged * 10
              + commitsCreated * 3
              + issuesCreated * 2
              + sessionsCreated * 1
```

### 4. Side Effects
- None (pure read + computation)

### 5. Error Paths

| Condition | Error | Handling |
|-----------|-------|----------|
| No events for date range | - | Return metrics with all zeros |
| EventStore read failure | Error | Propagate to caller (scheduler/handler will catch) |

### 6. Output

**aggregateDaily():** `DailyReport`
**aggregateWeekly():** `WeeklyReport`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `Aggregator_daily_countsAllEventTypes` | Happy Path | Scenario 4, Section 3a |
| `Aggregator_daily_noEvents_allZeros` | Sad Path | Scenario 4, Section 5 |
| `Aggregator_weekly_aggregatesSevenDays` | Happy Path | Scenario 4, Section 3b |
| `Aggregator_weekly_ranksUsersByWeightedScore` | Happy Path | Scenario 4, Section 3b-3c |
| `Aggregator_weekly_tiedScores_alphabeticalOrder` | Contract | Scenario 4, Section 3c |
| `Aggregator_codeLinesAdded_sumsMetadata` | Contract | Scenario 4, Section 3a, metadata.linesAdded aggregation |

---

## Scenario 5 — ReportFormatter + Publisher (Block Kit → Slack)

> Formats aggregated reports into Slack Block Kit and posts to channel.

### 1. API Entry
- Internal module (no HTTP endpoint)
- Called by: ReportScheduler, ReportHandler

### 2. Input

**formatDaily(report):** `DailyReport`
**formatWeekly(report):** `WeeklyReport`
**publish(channelId, blocks):** `string, Block[]`

### 3. Layer Flow

#### 3a. ReportFormatter.formatDaily(report)

- File: `src/metrics/report-formatter.ts`
- Transformation:
  ```
  DailyReport → Slack Block Kit blocks:
    - Header: ":bar_chart: 일간 리포트 — {date}"
    - Section: 세션 (생성/슬립/닫기)
    - Section: GitHub (이슈/PR/커밋/코드라인)
    - Section: 머지 (PR/코드라인)
    - Section: 대화 (턴)
    - Context: 생성 시각
  ```

#### 3b. ReportFormatter.formatWeekly(report)

- File: `src/metrics/report-formatter.ts`
- Transformation:
  ```
  WeeklyReport → Slack Block Kit blocks:
    - Header: ":trophy: 주간 리포트 — {weekStart} ~ {weekEnd}"
    - Section: 전체 메트릭 (daily와 동일 포맷)
    - Divider
    - Header: ":medal: 사용자 랭킹"
    - For each ranking:
      - Section: "{rank}. {userName} — {weightedScore}점"
      - Fields: 주요 메트릭 수치
    - Context: 생성 시각
  ```

#### 3c. ReportPublisher.publish(channelId, blocks, text)

- File: `src/metrics/report-publisher.ts`
- Transformation:
  ```
  channelId, blocks, text → slackApiHelper.postMessage(channelId, text, { blocks })
  ```
- Dependency: `SlackApiHelper` instance (injected via constructor or global)

### 4. Side Effects
- Slack message posted to channel (via Slack Web API `chat.postMessage`)

### 5. Error Paths

| Condition | Error | Handling |
|-----------|-------|----------|
| REPORT_CHANNEL_ID not configured | Missing config | Log error, skip publishing |
| Slack API failure (channel_not_found) | SlackApiError | Log error, do not retry |
| Slack API rate limit | 429 | SlackApiHelper already handles queuing |
| Block Kit too large (>50 blocks) | BlockLimitError | Truncate rankings to top 10 |

### 6. Output

**formatDaily/Weekly():** `{ blocks: Block[], text: string }` (text = fallback plain text)
**publish():** `{ ts?: string }` (posted message timestamp)

### 7. Observability
- Log: `report-publisher: published {period} report to {channelId}, ts={messageTs}` (info)
- Log: `report-publisher: failed to publish report` (error)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `Formatter_daily_producesValidBlockKit` | Happy Path | Scenario 5, Section 3a |
| `Formatter_weekly_includesRankings` | Happy Path | Scenario 5, Section 3b |
| `Formatter_weekly_truncatesRankingsOver10` | Sad Path | Scenario 5, Section 5 |
| `Publisher_publish_callsSlackPostMessage` | Happy Path | Scenario 5, Section 3c |
| `Publisher_publish_skipsWhenNoChannelConfigured` | Sad Path | Scenario 5, Section 5 |
| `Formatter_daily_allZeros_stillRendersBlocks` | Contract | Scenario 5, Section 3a |

---

## Scenario 6 — ReportScheduler + ReportHandler (Scheduling + Slash Command)

> Automatic scheduling (daily/weekly) and manual /report command.

### 1. API Entry

**Scheduler**: Internal, starts on app boot
**Command**: Slack message matching `/report` pattern

- Text patterns: `report`, `report daily`, `report weekly`
- Auth: any user can trigger (no special permission)

### 2. Input

**ReportHandler.execute(ctx):**
```typescript
ctx: CommandContext {
  user: string;       // Slack user ID
  channel: string;
  threadTs: string;
  text: string;       // 'report daily' | 'report weekly' | 'report'
  say: SayFn;
}
```

**ReportScheduler**: No external input. Reads system clock.

### 3. Layer Flow

#### 3a. ReportHandler (slash command)

- File: `src/slack/commands/report-handler.ts`
- `canHandle(text)`: `CommandParser.isReportCommand(text)` — matches `report`, `report daily`, `report weekly`
- `execute(ctx)`:
  ```
  text → parse subcommand ('daily' | 'weekly' | none)
  if none → say(help message) → return { handled: true }
  if 'daily':
    yesterday = getYesterdayDateStr()
    ReportAggregator.aggregateDaily(yesterday) → report
    ReportFormatter.formatDaily(report) → { blocks, text }
    say({ blocks, text, thread_ts: threadTs }) → post in thread
  if 'weekly':
    lastWeekStart = getLastMondayDateStr()
    ReportAggregator.aggregateWeekly(lastWeekStart) → report
    ReportFormatter.formatWeekly(report) → { blocks, text }
    say({ blocks, text, thread_ts: threadTs }) → post in thread
  return { handled: true }
  ```

#### 3b. ReportScheduler (automatic)

- File: `src/metrics/report-scheduler.ts`
- `start()`: called on app boot
  ```
  setInterval(checkAndRun, 60_000)  // every 1 minute
  ```
- `checkAndRun()`:
  ```
  now = new Date() in configured timezone (default 'Asia/Seoul')
  lastRun = loadScheduleState() from /data/report-schedule.json

  if now.getHours() === REPORT_DAILY_HOUR && now.getMinutes() === 0:
    if lastRun.lastDailyDate !== todayStr:
      yesterday = getYesterdayDateStr()
      report = ReportAggregator.aggregateDaily(yesterday)
      formatted = ReportFormatter.formatDaily(report)
      ReportPublisher.publish(REPORT_CHANNEL_ID, formatted.blocks, formatted.text)
      saveScheduleState({ ...lastRun, lastDailyDate: todayStr })

  if now.getDay() === REPORT_WEEKLY_DAY && now.getHours() === REPORT_WEEKLY_HOUR && now.getMinutes() === 0:
    if lastRun.lastWeeklyDate !== todayStr:
      lastWeekStart = getLastMondayDateStr()
      report = ReportAggregator.aggregateWeekly(lastWeekStart)
      formatted = ReportFormatter.formatWeekly(report)
      ReportPublisher.publish(REPORT_CHANNEL_ID, formatted.blocks, formatted.text)
      saveScheduleState({ ...lastRun, lastWeeklyDate: todayStr })
  ```

#### 3c. Schedule State Persistence

- File: `{DATA_DIR}/report-schedule.json`
- Schema:
  ```json
  {
    "lastDailyDate": "2026-03-25",
    "lastWeeklyDate": "2026-03-24"
  }
  ```

#### 3d. CommandRouter Integration

- File: `src/slack/commands/command-router.ts`
- Add `new ReportHandler(deps)` to handlers array
- Position: before HelpHandler (low priority, not conflicting)

### 4. Side Effects
- Slack message posted (via ReportPublisher)
- File WRITE: `/data/report-schedule.json` (schedule state)

### 5. Error Paths

| Condition | Error | Handling |
|-----------|-------|----------|
| Aggregation failure | Error | Log error, skip this run, retry next interval |
| Publish failure | Error | Log error, do not update lastRun (will retry next minute) |
| schedule.json corrupted | SyntaxError | Reset to empty state, log warning |
| REPORT_CHANNEL_ID missing | Missing config | Scheduler skips, Handler responds with config error message |

### 6. Output

**ReportHandler.execute():** `CommandResult { handled: true }`
**ReportScheduler**: No direct output (publishes to Slack via ReportPublisher)

### 7. Observability
- Log: `report-scheduler: daily report triggered for {date}` (info)
- Log: `report-scheduler: weekly report triggered for week {weekStart}` (info)
- Log: `report-handler: manual {period} report triggered by {userId}` (info)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `Handler_reportDaily_triggersAggregationAndFormats` | Happy Path | Scenario 6, Section 3a |
| `Handler_reportWeekly_triggersAggregationAndFormats` | Happy Path | Scenario 6, Section 3a |
| `Handler_reportNoArgs_showsHelp` | Happy Path | Scenario 6, Section 3a |
| `Scheduler_dailyTrigger_atConfiguredTime` | Happy Path | Scenario 6, Section 3b |
| `Scheduler_weeklyTrigger_atConfiguredTime` | Happy Path | Scenario 6, Section 3b |
| `Scheduler_skipsDuplicate_sameDay` | Sad Path | Scenario 6, Section 3b, lastRun check |
| `Scheduler_corruptedState_resetsGracefully` | Sad Path | Scenario 6, Section 5 |
| `Handler_missingChannelConfig_showsError` | Sad Path | Scenario 6, Section 5 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| EventStore as class with singleton | tiny | Matches existing pattern (ConversationStorage) |
| EventEmitter as module-level functions | tiny | Matches existing pattern (conversation/recorder.ts) |
| 1-minute polling for scheduler | small | Matches token-refresh-scheduler pattern. Simpler than cron dependency |
| Weighted score formula | small | `turns*1 + prs*5 + merged*10 + commits*3 + issues*2 + sessions*1` — emphasizes value-creating actions |
| Rankings truncated to top 10 | tiny | Block Kit 50-block limit safety margin |
| Schedule state in JSON file | tiny | Matches existing persistence pattern |
| Assistant turns tracked as 'assistant' userId | small | No session context in recordAssistantTurn. Owner attribution requires refactor — defer |
| `commit_created` and `code_lines_added` tracked via tool observer | small | Hook into TurnObserver.onToolEnd for `Bash` tool with git/gh commands |

## Implementation Status

| # | Scenario | Size | Trace | Tests | Status |
|---|----------|------|-------|-------|--------|
| 1 | MetricsEventStore (JSONL Storage Layer) | small | done | GREEN (6/6) | Complete |
| 2 | MetricsEventEmitter + Session Lifecycle Hooks | small | done | GREEN (11/11) | Complete |
| 3 | MetricsEventEmitter + Turn & GitHub Hooks | medium | done | GREEN (included in S2) | Complete |
| 4 | ReportAggregator (Daily/Weekly Aggregation) | medium | done | GREEN (6/6) | Complete |
| 5 | ReportFormatter + Publisher (Block Kit → Slack) | medium | done | GREEN (6/6) | Complete |
| 6 | ReportScheduler + ReportHandler (Scheduling + Slash Command) | medium | done | GREEN (9/9) | Complete |

## Next Step

→ Proceed with implementation + Trace Verify via `stv:work` or `stv:do-work`
