# Slack MCP Cross-Thread Access — Vertical Trace

> STV Trace | Created: 2026-04-02
> Spec: docs/slack-mcp-cross-thread/spec.md

## Table of Contents
1. [Scenario 1 — Context passes both threads](#scenario-1)
2. [Scenario 2 — Read source thread messages](#scenario-2)
3. [Scenario 3 — Read work thread messages (backward compat)](#scenario-3)
4. [Scenario 4 — Send message to source thread](#scenario-4)
5. [Scenario 5 — Source thread unavailable error](#scenario-5)

---

## Scenario 1 — Context passes both threads

### 1. Entry Point
- Module: `src/mcp-config-builder.ts`
- Method: `McpConfigBuilder.buildSlackMcpServer(slackContext)`
- Trigger: mid-thread mention with bot thread migration

### 2. Input
- `SlackContext`:
  ```typescript
  {
    channel: "C_WORK",           // work thread channel
    threadTs: "1700000099.000",  // work thread ts
    mentionTs: "1700000010.000", // mention ts in original thread
    sourceThreadTs: "1700000000.000", // original thread ts
    sourceChannel: "C_ORIGINAL",      // original thread channel (if different)
    user: "U123"
  }
  ```

### 3. Layer Flow

#### 3a. mcp-config-builder.ts:buildSlackMcpServer()
- **BEFORE**: `threadTs = slackContext.sourceThreadTs || slackContext.threadTs` — collapses to one
- **AFTER**: Passes both as separate fields:
  - `SlackContext.threadTs` → `SLACK_MCP_CONTEXT.threadTs` (work thread — primary)
  - `SlackContext.sourceThreadTs` → `SLACK_MCP_CONTEXT.sourceThreadTs` (source thread — optional)
  - `SlackContext.sourceChannel` → `SLACK_MCP_CONTEXT.sourceChannel` (source channel — optional)
  - `SlackContext.channel` → `SLACK_MCP_CONTEXT.channel` (work channel)
  - `SlackContext.mentionTs` → `SLACK_MCP_CONTEXT.mentionTs`

#### 3b. slack-mcp-server.ts constructor
- Parses `SLACK_MCP_CONTEXT` JSON
- `this.context.channel` = work channel
- `this.context.threadTs` = work thread ts
- `this.context.sourceChannel` = original channel (optional)
- `this.context.sourceThreadTs` = original thread ts (optional)

### 4. Side Effects
- None (config construction only)

### 5. Error Paths
| Condition | Error | Result |
|-----------|-------|--------|
| Missing threadTs | `Cannot build slack-mcp server without threadTs` | throw Error |

### 6. Output
- `SLACK_MCP_CONTEXT` env var JSON with both thread references:
  ```json
  {
    "channel": "C_WORK",
    "threadTs": "1700000099.000",
    "mentionTs": "1700000010.000",
    "sourceChannel": "C_ORIGINAL",
    "sourceThreadTs": "1700000000.000"
  }
  ```

### 7. Observability
- Logger: McpConfigBuilder debug log includes both thread refs

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| context_includes_both_threads | Contract | S1, Section 3a |
| context_work_thread_is_primary | Contract | S1, Section 3a |
| context_source_fields_optional | Contract | S1, Section 3a |

---

## Scenario 2 — Read source thread messages

### 1. Entry Point
- MCP Tool: `get_thread_messages`
- File: `mcp-servers/slack-mcp/slack-mcp-server.ts`

### 2. Input
```json
{
  "thread": "source",
  "offset": 0,
  "limit": 10
}
```
- Validation: `thread` must be `"source"` or `"work"` (default: `"work"`)

### 3. Layer Flow

#### 3a. handleGetThreadMessages()
- New param: `args.thread?: "source" | "work"`
- Calls `resolveThread(args.thread)` to get `{ channel, threadTs }`
  - `args.thread="source"` → `{ channel: this.context.sourceChannel || this.context.channel, threadTs: this.context.sourceThreadTs }`
- Routes to `handleArrayMode()` or `handleLegacyMode()` as before

#### 3b. handleArrayMode() / handleLegacyMode()
- **BEFORE**: Used `this.context.channel` and `this.context.threadTs` directly
- **AFTER**: Receives resolved `{ channel, threadTs }` and uses those
- Transformation: `resolvedThread.channel` → `getTotalCount(slack, channel, threadTs)` → `fetchThreadSlice(slack, channel, threadTs, ...)`

#### 3c. helpers/thread-fetcher.ts
- No change — already accepts `channel` and `threadTs` as parameters

### 4. Side Effects
- None (read-only)

### 5. Error Paths
| Condition | Error | Result |
|-----------|-------|--------|
| `thread: "source"` but no sourceThreadTs | `No source thread available` | ToolResult with isError: true |

### 6. Output
```json
{
  "thread_ts": "1700000000.000",
  "channel": "C_ORIGINAL",
  "total_count": 15,
  "offset": 0,
  "returned": 10,
  "messages": [...],
  "has_more": true
}
```

### 7. Observability
- Logs which thread type was resolved

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| get_thread_messages_has_thread_param | Contract | S2, Section 2 |
| get_thread_messages_source_uses_source_thread | Happy Path | S2, Section 3a |
| get_thread_messages_resolveThread_exists | Contract | S2, Section 3a |

---

## Scenario 3 — Read work thread messages (backward compat)

### 1. Entry Point
- MCP Tool: `get_thread_messages`

### 2. Input
```json
{
  "offset": 0,
  "limit": 10
}
```
- No `thread` param → default "work"

### 3. Layer Flow

#### 3a. handleGetThreadMessages()
- `args.thread` is undefined → `resolveThread(undefined)` → returns `{ channel: this.context.channel, threadTs: this.context.threadTs }` (work thread)
- Rest of flow identical to existing behavior

### 4-7. Same as existing behavior

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| get_thread_messages_default_is_work | Contract | S3, Section 3a |
| get_thread_messages_backward_compat | Contract | S3, Section 3a |

---

## Scenario 4 — Send message to source thread

### 1. Entry Point
- MCP Tool: `send_thread_message` (NEW)
- File: `mcp-servers/slack-mcp/slack-mcp-server.ts`

### 2. Input
```json
{
  "text": "작업 완료 요약입니다.",
  "thread": "source"
}
```
- `text`: string, required
- `thread`: "source" | "work", optional, default "work"

### 3. Layer Flow

#### 3a. Tool Definition
- New tool `send_thread_message` registered in `defineTools()`
- inputSchema: `{ text: string (required), thread: string (optional, enum: source|work) }`

#### 3b. handleSendThreadMessage()
- `resolveThread(args.thread)` → `{ channel, threadTs }`
- `this.slack.chat.postMessage({ channel, thread_ts: threadTs, text: args.text })`
- Transformation: `args.text` → `chat.postMessage.text`, resolved `channel` → `chat.postMessage.channel`, resolved `threadTs` → `chat.postMessage.thread_ts`

### 4. Side Effects
- Slack API: `chat.postMessage` to target thread

### 5. Error Paths
| Condition | Error | Result |
|-----------|-------|--------|
| `thread: "source"` but no sourceThreadTs | `No source thread available` | ToolResult isError: true |
| Missing `text` | `text is required` | throw Error |
| Slack API failure | Slack error code | ToolResult isError: true (via formatError) |

### 6. Output
```json
{
  "sent": true,
  "channel": "C_ORIGINAL",
  "thread_ts": "1700000000.000",
  "message_ts": "1700000500.000"
}
```

### 7. Observability
- Logger: `Sent message to {thread_type} thread`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| send_thread_message_tool_exists | Contract | S4, Section 3a |
| send_thread_message_requires_text | Sad Path | S4, Section 5 |
| send_thread_message_uses_resolveThread | Contract | S4, Section 3b |

---

## Scenario 5 — Source thread unavailable error

### 1. Entry Point
- Any tool with `thread: "source"` when `sourceThreadTs` is absent

### 2. Input
- Context: `{ channel, threadTs, mentionTs }` — NO sourceThreadTs/sourceChannel
- Tool call: `get_thread_messages({ thread: "source" })`

### 3. Layer Flow

#### 3a. resolveThread("source")
- Checks `this.context.sourceThreadTs`
- `sourceThreadTs` is undefined → throws error

### 4. Side Effects
- None

### 5. Error Paths
| Condition | Error | Result |
|-----------|-------|--------|
| sourceThreadTs absent | `No source thread available — this session was not created from a mid-thread mention with thread migration` | ToolResult isError: true |

### 6. Output
```json
{
  "error": "No source thread available — this session was not created from a mid-thread mention with thread migration"
}
```

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| resolveThread_source_error_when_absent | Sad Path | S5, Section 3a |
| types_include_source_fields | Contract | S5, Section 2 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| resolveThread as private helper method | tiny | DRY — 4 tools share same logic, ~10 lines |
| thread param type = string with "source"/"work" enum | tiny | JSON Schema doesn't support TS unions; use enum in description |
| handleArrayMode/handleLegacyMode receive resolved thread | small | Minimal change — add `channel`/`threadTs` params instead of reading from `this.context` |
| send_thread_message uses chat.postMessage | tiny | Standard Slack API for text messages |
| send_file/send_media thread param | tiny | Same resolveThread pattern, just pass to filesUploadV2 args |
| Version bump to 4.0.0 | tiny | Breaking change in context shape warrants major version |

## Implementation Status
| Scenario | Trace | Tests | Verify | Status |
|----------|-------|-------|--------|--------|
| 1. Context passes both threads | done | GREEN | Verified | Complete |
| 2. Read source thread messages | done | GREEN | Verified | Complete |
| 3. Read work thread messages (backward compat) | done | GREEN | Verified | Complete |
| 4. Send message to source thread | done | GREEN | Verified | Complete |
| 5. Source thread unavailable error | done | GREEN | Verified | Complete |

## Trace Deviations
None

## Verified At
2026-04-02 — All 5 scenarios GREEN + Verified
