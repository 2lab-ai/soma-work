# SlackApiHelper Hot Path Integration — Vertical Trace

> STV Trace | Created: 2026-03-06
> Spec: docs/slack-api-helper-hotpath/spec.md

## Table of Contents
1. [Scenario 1 — StatusReporter uses SlackApiHelper for status lifecycle](#scenario-1)
2. [Scenario 2 — TodoDisplayManager updates existing todo messages through SlackApiHelper](#scenario-2)
3. [Scenario 3 — StreamExecutor compact tool updates use SlackApiHelper queue](#scenario-3)

---

## Scenario 1 — StatusReporter uses SlackApiHelper for status lifecycle

### 1. API Entry
- Invocation: `StatusReporter.createStatusMessage()`, `updateStatus()`, `updateStatusDirect()`
- Entry points: `src/slack/status-reporter.ts:39`, `src/slack/status-reporter.ts:72`, `src/slack/status-reporter.ts:96`
- Auth/AuthZ: N/A, internal Slack bot path

### 2. Input (Request)
- Request payload:
  ```json
  {
    "channel": "Slack channel ID",
    "threadTs": "Slack thread timestamp when creating",
    "sessionKey": "Session identifier for status message cache",
    "status": "thinking|working|waiting|completed|error|cancelled",
    "tag": "optional verbose prefix"
  }
  ```
- Validation rules:
  - `status` maps to a known `STATUS_CONFIG` key
  - `channel` and `ts` are forwarded unchanged
  - `threadTs` is only used for creation path

### 3. Layer Flow

#### 3a. Controller/Handler
- `SlackHandler` constructs one shared helper and injects it:
  - `SlackHandler.slackApi → new StatusReporter(slackApi)`
  - `src/slack-handler.ts:132`
- `createStatusMessage()` resolves `STATUS_CONFIG[initialStatus].text`
- Transformation arrows:
  - `initialStatus → STATUS_CONFIG[initialStatus].text → slackApi.postMessage(text)`
  - `tag + STATUS_CONFIG[status].text → slackApi.updateMessage(text)`

#### 3b. Service
- `StatusReporter` delegates all Slack mutations to helper:
  - `channel/threadTs/text → SlackApiHelper.postMessage(channel, text, { threadTs })`
  - `channel/ts/text → SlackApiHelper.updateMessage(channel, ts, text)`
- Session cache update occurs only after helper returns `ts`

#### 3c. Repository/DB
- No DB transaction
- External mutation mapping:
  - `SlackApiHelper.postMessage payload.channel → Slack chat.postMessage.channel`
  - `SlackApiHelper.postMessage options.threadTs → Slack chat.postMessage.thread_ts`
  - `SlackApiHelper.updateMessage payload.ts → Slack chat.update.ts`

### 4. Side Effects
- Slack side effects:
  - POST: create status message in thread
  - UPDATE: mutate existing status message text
- In-memory side effects:
  - `statusMessages.set(sessionKey, { channel, ts })` after create success

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| helper post fails | Slack API or queue error | logger.error, returns `undefined`, cache not updated |
| helper update fails | Slack API or queue error | logger.error, method resolves without throw |
| unknown sessionKey on update | N/A | early return, debug log |

### 6. Output (Response)
- `createStatusMessage()` returns created message `ts` or `undefined`
- `updateStatus()` and `updateStatusDirect()` resolve `void`

### 7. Observability Hooks
- Logs:
  - `Created status message`
  - `Updated status message`
  - `Failed to create status message`
  - `Failed to update status message`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `createStatusMessage uses slackApi.postMessage and stores ts` | Happy Path | Scenario 1, Section 3 |
| `updateStatus uses slackApi.updateMessage for cached session message` | Contract | Scenario 1, Section 3 |
| `updateStatusDirect uses slackApi.updateMessage with explicit ts` | Contract | Scenario 1, Section 3 |

---

## Scenario 2 — TodoDisplayManager updates existing todo messages through SlackApiHelper

### 1. API Entry
- Invocation: `TodoDisplayManager.handleTodoUpdate()`
- Entry point: `src/slack/todo-display-manager.ts:33`
- Auth/AuthZ: N/A, internal stream callback path

### 2. Input (Request)
- Request payload:
  ```json
  {
    "sessionKey": "Session identifier",
    "sessionId": "TodoManager session identifier",
    "channel": "Slack channel ID",
    "threadTs": "Slack thread timestamp",
    "todos": [
      {
        "content": "todo text",
        "status": "pending|in_progress|completed"
      }
    ]
  }
  ```
- Validation rules:
  - `sessionId` and `todos` must exist or function returns early
  - only significant todo changes trigger message mutation
  - existing message path is used only when `todoMessages.get(sessionKey)` returns a ts

### 3. Layer Flow

#### 3a. Controller/Handler
- `StreamExecutor.onTodoUpdate()` forwards stream todo input:
  - `ctx.sessionKey → TodoDisplayManager.handleTodoUpdate(sessionKey)`
  - `input.todos → todoManager.formatTodoList() → todoList`

#### 3b. Service
- Existing message path:
  - `channel/messageTs/todoList → SlackApiHelper.updateMessage(channel, messageTs, todoList)`
- Fallback path on helper failure:
  - `todoList/channel/threadTs → say({ text, thread_ts })`
- Transformation arrows:
  - `input.todos → TodoManager.formatTodoList() → todoList string → slackApi.updateMessage.text`
  - `say result.ts → todoMessages.set(sessionKey, result.ts)`

#### 3c. Repository/DB
- No DB transaction
- External mutation mapping:
  - `SlackApiHelper.updateMessage(channel, ts, todoList) → Slack chat.update`
  - `say({ text, thread_ts }) → Bolt say → Slack chat.postMessage`

### 4. Side Effects
- Slack side effects:
  - UPDATE existing todo message when helper succeeds
  - POST new todo message when there is no existing message or update fails
  - POST status-change notification when `TodoManager.getStatusChange()` returns text
- In-memory side effects:
  - `todoManager.updateTodos(sessionId, newTodos)`
  - `todoMessages.set(sessionKey, newTs)` when a new todo message is created

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| helper update fails | Slack API or queue error | warn log, create replacement message via `say()` |
| no significant change | N/A | no Slack mutation |
| missing `sessionId` or `todos` | N/A | early return |

### 6. Output (Response)
- Resolves `void`
- Existing message ts remains cached on successful update
- Replacement message ts overwrites cached ts on fallback create

### 7. Observability Hooks
- Logs:
  - `Updated existing todo message`
  - `Failed to update todo message, creating new one`
  - `Created new todo message`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `handleTodoUpdate uses slackApi.updateMessage for existing todo message` | Happy Path | Scenario 2, Section 3 |
| `handleTodoUpdate falls back to say when slackApi.updateMessage fails` | Sad Path | Scenario 2, Section 5 |

---

## Scenario 3 — StreamExecutor compact tool updates use SlackApiHelper queue

### 1. API Entry
- Invocation: `StreamExecutor.execute()` creates `streamCallbacks.onUpdateMessage`
- Entry point: `src/slack/pipeline/stream-executor.ts:343`
- Auth/AuthZ: N/A, internal stream processor callback

### 2. Input (Request)
- Request payload:
  ```json
  {
    "channel": "Slack channel ID",
    "ts": "existing tool-call message ts",
    "text": "rebuilt compact tool summary"
  }
  ```
- Validation rules:
  - callback only fires when compact mode rebuild is enabled in `StreamProcessor`
  - `channel`, `ts`, `text` are passed through unchanged

### 3. Layer Flow

#### 3a. Controller/Handler
- `StreamProcessor.rebuildCompactMessage()` invokes callback:
  - `channel/ts/text → StreamCallbacks.onUpdateMessage(channel, ts, text)`

#### 3b. Service
- `StreamExecutor` callback delegates to helper:
  - `channel/ts/text → SlackApiHelper.updateMessage(channel, ts, text)`
- Transformation arrows:
  - `rebuildCompactMessage.text → StreamExecutor.onUpdateMessage.text → SlackApiHelper.updateMessage.text`

#### 3c. Repository/DB
- No DB transaction
- External mutation mapping:
  - `SlackApiHelper.updateMessage(channel, ts, text) → Slack chat.update`

### 4. Side Effects
- Slack side effect:
  - UPDATE existing compact tool-call message in-place
- No additional in-memory state is mutated in `StreamExecutor`

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| helper update fails | Slack API or queue error | debug log, stream continues |

### 6. Output (Response)
- Callback resolves `void`
- Compact tool rendering remains best-effort and non-fatal

### 7. Observability Hooks
- Logs:
  - `Failed to update tool call message`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `updateToolCallMessage uses slackApi.updateMessage` | Contract | Scenario 3, Section 3 |
| `updateToolCallMessage swallows helper failures after debug logging` | Sad Path | Scenario 3, Section 5 |

---

## Implementation Status

| # | Scenario | Size | Trace | Tests | Status |
|---|----------|------|-------|-------|--------|
| 1 | StatusReporter uses SlackApiHelper for status lifecycle | small | Complete | GREEN | GREEN |
| 2 | TodoDisplayManager updates existing todo messages through SlackApiHelper | small | Complete | GREEN | GREEN |
| 3 | StreamExecutor compact tool updates use SlackApiHelper queue | tiny | Complete | GREEN | GREEN |

## Auto-Decision Log

### Auto-Decision Log: Keep new todo message creation on `say()`
- **Decision**: only existing-message update path moves to `SlackApiHelper`
- **switching cost**: small (~20 lines)
- **Rationale**: rate-limit hot path is update burst, while initial todo creation already happens once per session branch and is not the observed bypass root cause
- **Generic pattern applied**: preserve current fallback semantics
- **Impact if changed**: revisit `TodoDisplayManager.createNewMessage()` and call sites
