# Turn Summary & Lifecycle — Vertical Trace

> STV Trace | Created: 2026-03-28
> Spec: docs/turn-summary-lifecycle/spec.md

## Table of Contents
1. [S1 — Timer Start on Turn Completion](#s1)
2. [S2 — Timer Cancel on User Input](#s2)
3. [S3 — Timer Fire → Fork Session → Summary Display](#s3)
4. [S4 — ES Command → Immediate Summary](#s4)
5. [S5 — Summary Clear on New User Input](#s5)
6. [S6 — Completion Message Track](#s6)
7. [S7 — Completion Message Delete on User Input](#s7)
8. [S8 — Completion Message Delete on Choice Click](#s8)
9. [S9 — Error Messages Persist](#s9)
10. [S10 — Day Pipeline Orchestration](#s10)

---

## S1 — Timer Start on Turn Completion

### 1. Event Entry
- Trigger: `StreamExecutor.execute()` completes (turn ends)
- Location: `src/slack/pipeline/stream-executor.ts:684` (after TurnNotifier.notify)
- Condition: `category !== 'Exception'` (only done/waiting triggers timer)

### 2. Input
- `sessionKey: string` — identifies the session
- `category: TurnCategory` — 'WorkflowComplete' | 'UIUserAskQuestion'
- `session: ConversationSession` — current session state

### 3. Layer Flow

#### 3a. StreamExecutor (Trigger Point)
- After `enrichAndNotify()` call at line ~733
- NEW: Call `summaryTimer.start(sessionKey, callback)`
- Transformation: `determineTurnCategory({hasPendingChoice, isError})` → `TurnCategory`
- Guard: `if (category === 'Exception') skip`

#### 3b. SummaryTimer.start()
- File: `src/slack/summary-timer.ts` (NEW)
- `sessionKey` → `this.timers.get(sessionKey)` → if exists, `clearTimeout` first
- `setTimeout(callback, 180_000)` → stored in `this.timers.set(sessionKey, timerId)`
- Transformation: `sessionKey` → `Map<string, NodeJS.Timeout>.set(sessionKey, timerId)`

### 4. Side Effects
- In-memory: `SummaryTimer.timers` Map gets new entry `sessionKey → timerId`
- No DB change, no Slack API call

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| category === 'Exception' | Skip | No timer started |
| Timer already exists for session | Reset | Old timer cleared, new one started |

### 6. Output
- No visible output. Timer runs silently in background.

### 7. Observability
- Log: `SummaryTimer: started for ${sessionKey}, fires in 180s`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `SummaryTimer_start_setsTimer` | Happy Path | S1, Section 3b |
| `SummaryTimer_start_skipsException` | Sad Path | S1, Section 5 |
| `SummaryTimer_start_resetsExisting` | Happy Path | S1, Section 5 row 2 |

---

## S2 — Timer Cancel on User Input

### 1. Event Entry
- Trigger: New user message arrives in session thread
- Location: `src/slack/pipeline/input-processor.ts` or `src/slack/event-router.ts`
- Before StreamExecutor runs for the new message

### 2. Input
- `sessionKey: string`

### 3. Layer Flow

#### 3a. EventRouter / InputProcessor (Trigger Point)
- On incoming user message, before dispatching to StreamExecutor
- NEW: Call `summaryTimer.cancel(sessionKey)`

#### 3b. SummaryTimer.cancel()
- `this.timers.get(sessionKey)` → `clearTimeout(timerId)` → `this.timers.delete(sessionKey)`
- If no timer exists → no-op

### 4. Side Effects
- In-memory: `SummaryTimer.timers` entry removed

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| No timer for session | No-op | Silent return |

### 6. Output
- No visible output

### 7. Observability
- Log: `SummaryTimer: cancelled for ${sessionKey}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `SummaryTimer_cancel_clearsTimer` | Happy Path | S2, Section 3b |
| `SummaryTimer_cancel_noopIfNone` | Sad Path | S2, Section 5 |

---

## S3 — Timer Fire → Fork Session → Summary Display

### 1. Event Entry
- Trigger: 180s timer fires (no user input arrived)
- Location: `SummaryTimer` callback → `SummaryService.execute()`

### 2. Input
- `session: ConversationSession` — captured at timer start
- `sessionKey: string`
- `summary.prompt` template (hardcoded constant)

### 3. Layer Flow

#### 3a. SummaryTimer Callback
- Timer fires → removes self from `timers` Map
- Calls `summaryService.execute(session, sessionKey)`

#### 3b. SummaryService.execute()
- File: `src/slack/summary-service.ts` (NEW)
- Step 1: Fork session
  - `session.model` → forked session model
  - `session.workingDirectory` → forked session cwd
  - `session.links` → forked session links context
  - Transformation: `ConversationSession` → `ForkedSessionConfig { model, cwd, links, prompt }`
- Step 2: Inject `SUMMARY_PROMPT` constant into forked session
- Step 3: Stream forked session response, collect text
  - Uses `ClaudeHandler` API to create+stream a temporary session
- Step 4: Terminate forked session (cleanup)
- Step 5: Return collected text

#### 3c. SummaryService.displayOnThread()
- `summaryText` → Slack mrkdwn blocks
- Transformation: `string` → `KnownBlock[]` (summaryBlocks)
- `session.actionPanel.summaryBlocks = blocks`
- Calls `threadSurface.requestRender(session, sessionKey)` to display

#### 3d. ThreadSurface (Render)
- Existing render pipeline picks up `summaryBlocks` from `session.actionPanel`
- Appends after action buttons section in block layout
- Calls `chat.update` with combined blocks

### 4. Side Effects
- Slack: Thread header message updated with summary blocks appended
- Memory: `session.actionPanel.summaryBlocks` set
- Temporary session created and destroyed

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Session no longer active | Skip | Log warning, no summary |
| Fork session fails | Skip | Log error, no summary displayed |
| Summary response empty | Skip | No blocks appended |
| ThreadSurface update fails | Log | Non-blocking, summary lost |

### 6. Output
- Thread header message updated with summary section at bottom:
  ```
  ━━━━ Executive Summary ━━━━
  [as-is/to-be report]
  [executive summary]
  [3 suggested actions in code blocks]
  ```

### 7. Observability
- Log: `SummaryService: executing for ${sessionKey}`
- Log: `SummaryService: fork session completed in ${durationMs}ms`
- Log: `SummaryService: displayed summary (${blocks.length} blocks)`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `SummaryService_execute_forkAndCollect` | Happy Path | S3, Section 3b |
| `SummaryService_execute_skipsInactiveSession` | Sad Path | S3, Section 5 row 1 |
| `SummaryService_displayOnThread_setSummaryBlocks` | Side-Effect | S3, Section 3c |
| `SummaryTimer_fire_triggersSummaryService` | Contract | S3, Section 3a→3b |

---

## S4 — ES Command → Immediate Summary

### 1. Event Entry
- Trigger: User types `es` in thread
- Location: `CommandRouter.route()` → `EsHandler.execute()`

### 2. Input
- `text: string` — "es"
- `CommandContext: { user, channel, threadTs, say }`

### 3. Layer Flow

#### 3a. CommandParser
- `canHandle(text)`: `/^\/?es$/i.test(text.trim())` → true

#### 3b. EsHandler.execute()
- File: `src/slack/commands/es-handler.ts` (NEW)
- Retrieves session from `claudeHandler.getSession(channel, threadTs)`
- Guard: if no session → say error message, return `{ handled: true }`
- Calls `summaryTimer.cancel(sessionKey)` — cancel any pending timer
- Calls `summaryService.execute(session, sessionKey)`
- Calls `summaryService.displayOnThread(session, sessionKey, result)`
- Returns `{ handled: true }`

### 4. Side Effects
- Summary timer cancelled (if any)
- Thread header updated with summary blocks
- `session.actionPanel.summaryBlocks` set

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| No active session | Error msg | `say("❌ 활성 세션이 없습니다")`, handled: true |
| Summary execution fails | Error msg | `say("❌ 요약 생성 실패")`, handled: true |

### 6. Output
- Command handled silently (no separate reply message)
- Thread header updated with summary section

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `EsHandler_canHandle_matchesEs` | Happy Path | S4, Section 3a |
| `EsHandler_execute_callsSummaryService` | Happy Path | S4, Section 3b |
| `EsHandler_execute_noSession_error` | Sad Path | S4, Section 5 row 1 |
| `EsHandler_execute_cancelsTimer` | Side-Effect | S4, Section 3b |

---

## S5 — Summary Clear on New User Input

### 1. Event Entry
- Trigger: New user message arrives in session thread
- Location: Same hook point as S2 (timer cancel)

### 2. Input
- `sessionKey: string`

### 3. Layer Flow

#### 3a. EventRouter / InputProcessor
- On incoming user message, alongside timer cancel
- NEW: Call `summaryService.clearDisplay(sessionKey)`

#### 3b. SummaryService.clearDisplay()
- `session.actionPanel.summaryBlocks = undefined`
- Calls `threadSurface.requestRender(session, sessionKey)`

### 4. Side Effects
- Thread header message re-rendered without summary blocks
- Memory: `session.actionPanel.summaryBlocks` cleared

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| No summary displayed | No-op | summaryBlocks already undefined |

### 6. Output
- Thread header returns to normal state (summary section removed)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `SummaryService_clearDisplay_removesSummaryBlocks` | Happy Path | S5, Section 3b |
| `SummaryService_clearDisplay_noopIfEmpty` | Sad Path | S5, Section 5 |

---

## S6 — Completion Message Track

### 1. Event Entry
- Trigger: `StreamExecutor.execute()` sends turn completion message to thread
- Location: `src/slack/pipeline/stream-executor.ts` (after say() for completion message)

### 2. Input
- `sessionKey: string`
- `messageTs: string` — timestamp of the completion message just posted
- `category: TurnCategory`

### 3. Layer Flow

#### 3a. StreamExecutor (after posting completion message)
- After `say({ text: "🟢 작업 완료" })` or `say({ text: "🟠 유저 입력 대기" })`
- Captures returned `messageTs`
- NEW: Call `completionMessageTracker.track(sessionKey, messageTs, category)`

#### 3b. CompletionMessageTracker.track()
- File: `src/slack/completion-message-tracker.ts` (NEW)
- Guard: `if (category === 'Exception') return` — errors persist
- `this.tracked.get(sessionKey)` → if not exists, `new Set()`
- `set.add(messageTs)`
- Transformation: `(sessionKey, messageTs)` → `Map<string, Set<string>>.get(sessionKey).add(messageTs)`

### 4. Side Effects
- In-memory: `CompletionMessageTracker.tracked` Map entry updated

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| category === 'Exception' | Skip | Message NOT tracked → persists |
| First message for session | Create | New Set created in Map |

### 6. Output
- No visible output

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `CompletionMessageTracker_track_addsTs` | Happy Path | S6, Section 3b |
| `CompletionMessageTracker_track_skipsException` | Sad Path | S6, Section 5 row 1 |
| `CompletionMessageTracker_track_createsSetIfNew` | Happy Path | S6, Section 5 row 2 |

---

## S7 — Completion Message Delete on User Input

### 1. Event Entry
- Trigger: New user message arrives (same hook as S2 + S5)
- Location: EventRouter / InputProcessor

### 2. Input
- `sessionKey: string`
- `channel: string`
- `slackApi: SlackApiHelper`

### 3. Layer Flow

#### 3a. EventRouter / InputProcessor
- On incoming user message, alongside timer cancel and summary clear
- NEW: Call `completionMessageTracker.deleteAll(sessionKey, slackApi, channel)`

#### 3b. CompletionMessageTracker.deleteAll()
- `this.tracked.get(sessionKey)` → if empty/undefined, return
- `Promise.allSettled([...set].map(ts => slackApi.deleteMessage(channel, ts)))`
- `this.tracked.delete(sessionKey)` — clear tracking
- Transformation: `Set<messageTs>` → batch `chat.delete` calls → `Map.delete(sessionKey)`

### 4. Side Effects
- Slack: done/waiting messages deleted from thread via `chat.delete`
- In-memory: `CompletionMessageTracker.tracked` entry removed

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| No tracked messages | No-op | Silent return |
| Individual delete fails | Swallowed | `Promise.allSettled` — other deletes proceed |
| Message already deleted | Swallowed | Slack API returns error, ignored |

### 6. Output
- Done/waiting messages disappear from thread

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `CompletionMessageTracker_deleteAll_callsChatDelete` | Happy Path | S7, Section 3b |
| `CompletionMessageTracker_deleteAll_noopIfEmpty` | Sad Path | S7, Section 5 row 1 |
| `CompletionMessageTracker_deleteAll_toleratesFailure` | Sad Path | S7, Section 5 row 2 |

---

## S8 — Completion Message Delete on Choice Click

### 1. Event Entry
- Trigger: User clicks decision button in action panel
- Location: `src/slack/actions/choice-action-handler.ts`

### 2. Input
- `sessionKey: string`
- `channel: string`

### 3. Layer Flow

#### 3a. ChoiceActionHandler
- After processing user choice selection
- NEW: Call `completionMessageTracker.deleteAll(sessionKey, slackApi, channel)`
- Same deletion logic as S7

### 4. Side Effects
- Same as S7

### 5. Error Paths
- Same as S7

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `ChoiceAction_deletesCompletionMessages` | Side-Effect | S8, Section 3a |

---

## S9 — Error Messages Persist

### 1. Event Entry
- Trigger: Turn completion with category 'Exception'
- Location: `StreamExecutor.execute()` error path

### 2. Input
- `category: 'Exception'`
- `messageTs: string` — timestamp of error message

### 3. Layer Flow

#### 3a. CompletionMessageTracker.track()
- `category === 'Exception'` → `return` immediately
- Message ts NOT added to tracked set

#### 3b. SummaryTimer (NOT started)
- `category === 'Exception'` → timer NOT started

### 4. Side Effects
- None — error message remains in thread permanently

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `ErrorMessage_notTracked_persists` | Contract | S9, Section 3a |
| `ErrorMessage_noTimerStarted` | Contract | S9, Section 3b |

---

## S10 — Day Pipeline Orchestration

### 1. Event Entry
- Trigger: User types `autowork` command
- Location: `CommandRouter.route()` → `DayPipelineHandler.execute()`

### 2. Input
- `CommandContext: { user, channel, threadTs, say }`
- `session: ConversationSession`

### 3. Layer Flow

#### 3a. DayPipelineHandler
- File: `src/slack/commands/day-pipeline-handler.ts` (NEW)
- `canHandle(text)`: `/^\/?autowork$/i.test(text.trim())`
- Gets session → passes to `DayPipelineRunner.run(session, sessionKey)`
- Returns `{ handled: true, continueWithPrompt: pipelinePrompt }`

#### 3b. DayPipelineRunner.run()
- File: `src/slack/pipeline/day-pipeline-runner.ts` (NEW)
- Iterates through phases: `[day0, day1, day2]`
- For each phase:
  - Iterates through `steps: PipelineStep[]`
  - Each step: constructs prompt with skill invocation
  - Returns prompt as `Continuation` for StreamExecutor
  - Phase boundary: asks user confirmation via `AskUserQuestion`

#### 3c. Day0 Phase (conditional: bug only)
- Step 1: `stv:debug` — analyze the issue
- Step 2: `stv:new-task` — create Jira bug ticket
- Condition: `ctx.isBug === true`

#### 3d. Day1 Phase
- Step 1: `stv:new-task` (if no issue exists)
  - Condition: `!session.links?.issue`
- Step 2: `stv:do-work` — implement
- Step 3: PR creation (within do-work)
- Step 4: `stv:verify` — loop:
  - if fail → `stv:do-work` again → `stv:verify` again
  - if pass → continue
- Step 5: `github-pr` review
- Step 6: fix/update workflow if review issues
- Step 7: merge

#### 3e. Day2 Phase
- Step 1: Report — work summary + Jira/PR links
- Step 2: as-is/to-be + `stv:verify` + executive summary
- Step 3: Red/green test verification
- Step 4: Parallel LLM reviews (4 concurrent):
  - `llm_chat(model: codex)` — code review
  - `llm_chat(model: codex)` — test coverage review
  - `llm_chat(model: gemini)` — code review
  - `llm_chat(model: gemini)` — test coverage review
- Step 5: Fix based on reviews → `stv:debug` → Jira update → PR → verify loop → merge

### 4. Side Effects
- Jira: Issues created/updated
- GitHub: PRs created, reviewed, merged
- Slack: Progress messages posted throughout
- Session: links updated (issue, PR)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| No active session | Error msg | `say("❌ 활성 세션이 없습니다")` |
| Phase step fails | Halt | Report error, ask user decision |
| Verify loop > 5 iterations | Halt | Report stuck, ask user |
| LLM review timeout | Skip | Log warning, continue with available reviews |
| Merge conflict | Halt | Report conflict, ask user |

### 6. Output
- Progressive status updates throughout pipeline
- Final: merged PR + complete report

### 7. Observability
- Log: `DayPipelineRunner: starting phase ${phase.name}`
- Log: `DayPipelineRunner: step ${step.skill} completed`
- Log: `DayPipelineRunner: phase ${phase.name} completed`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `DayPipelineHandler_canHandle_matchesAutowork` | Happy Path | S10, Section 3a |
| `DayPipelineRunner_run_executesPhasesSequentially` | Happy Path | S10, Section 3b |
| `DayPipelineRunner_day1_skipsNewTaskIfIssueExists` | Contract | S10, Section 3d Step 1 |
| `DayPipelineRunner_day1_verifyLoopRetriesOnFail` | Contract | S10, Section 3d Step 4 |
| `DayPipelineRunner_day2_parallelReviews` | Contract | S10, Section 3e Step 4 |
| `DayPipelineRunner_haltsOnError` | Sad Path | S10, Section 5 row 2 |
| `DayPipelineRunner_verifyLoopMaxIterations` | Sad Path | S10, Section 5 row 3 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| summaryBlocks follows choiceBlocks pattern in ActionPanelState | small | Identical slot mechanism, ~15 lines |
| SUMMARY_PROMPT as const string (not configurable) | tiny | User specified exact prompt |
| autowork command name | tiny | User specified, distinct from existing |
| Verify loop max 5 iterations | small | Reasonable guard, prevents infinite loop |
| LLM review timeout 120s | small | Conservative but prevents blocking |
| Day0 skipped if not bug (no isBug flag) | tiny | Spec says "버그일 경우" |

## Implementation Status

| Scenario | Trace | Tests (RED) | Size | Status |
|----------|-------|-------------|------|--------|
| S1 — Timer Start | done | RED | small | Ready |
| S2 — Timer Cancel | done | RED | tiny | Ready |
| S3 — Timer Fire → Summary | done | RED | large | Ready |
| S4 — ES Command | done | RED | medium | Ready |
| S5 — Summary Clear | done | RED | small | Ready |
| S6 — Message Track | done | RED | small | Ready |
| S7 — Message Delete (Input) | done | RED | small | Ready |
| S8 — Message Delete (Click) | done | RED | tiny | Ready |
| S9 — Error Persist | done | RED | tiny | Ready |
| S10 — Day Pipeline | done | RED | xlarge | Ready |

## Next Step
→ Proceed with implementation via `stv:do-work` or `stv:work docs/turn-summary-lifecycle/trace.md`
