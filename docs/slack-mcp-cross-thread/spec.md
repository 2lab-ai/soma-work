# Slack MCP Cross-Thread Access — Spec

> STV Spec | Created: 2026-04-02

## 1. Overview

mid-thread mention으로 시작한 세션은 원본 스레드(source)와 작업 스레드(work) 2개를 가진다.
현재 slack-mcp는 `SLACK_MCP_CONTEXT`에 하나의 thread 정보만 전달하여, 작업 스레드에서 원본 스레드 메시지를 읽거나 메시지를 보낼 수 없다.

이 기능은 slack-mcp에 cross-thread 접근을 추가하여 두 스레드 모두 읽기/쓰기가 가능하게 한다.

## 2. User Stories

- As a Claude agent in a work thread, I want to read messages from the original (source) thread, so that I can understand the full context of the user's request.
- As a Claude agent in a work thread, I want to send messages to the original thread, so that I can post status updates or summaries back to where the conversation started.
- As a Claude agent, I want to continue using all existing tools (get_thread_messages, send_file, send_media) on the work thread by default, so that nothing breaks.

## 3. Acceptance Criteria

- [ ] `get_thread_messages({ thread: "source" })` returns messages from the original thread
- [ ] `get_thread_messages({ thread: "work" })` or `get_thread_messages({})` returns messages from the work thread (backward compatible)
- [ ] `send_thread_message({ thread: "source", text: "..." })` posts a text message to the original thread
- [ ] `send_thread_message({ thread: "work", text: "..." })` posts a text message to the work thread
- [ ] `send_file` and `send_media` accept optional `thread` parameter ("source" | "work")
- [ ] When `sourceThreadTs` is absent (non-migration case), using `thread: "source"` returns a clear error
- [ ] `SLACK_MCP_CONTEXT` passes both source and work thread info
- [ ] Tool descriptions include cross-thread access documentation
- [ ] Existing tests pass; new contract tests for cross-thread scenarios

## 4. Scope

### In-Scope
- Extend `SlackMcpContext` type with `sourceChannel`/`sourceThreadTs`
- Add `thread` parameter to `get_thread_messages`
- Add `send_thread_message` tool
- Add `thread` parameter to `send_file`/`send_media`
- Update `mcp-config-builder.ts` to pass both thread refs
- Update tool descriptions
- Contract tests

### Out-of-Scope
- `download_thread_file` cross-thread (files have direct URLs, no thread needed)
- Thread-aware system prompt changes (handled by thread-awareness header separately)
- Changing when slack-mcp is registered (isMidThreadMention logic stays)

## 5. Architecture

### 5.1 Layer Structure

```
mcp-config-builder.ts (SlackContext → SLACK_MCP_CONTEXT env var)
    ↓
slack-mcp-server.ts (parses context, defines tools, handles calls)
    ↓
helpers/thread-fetcher.ts (Slack API calls — unchanged)
```

### 5.2 Data Flow Change

**Before:**
```
SlackContext.sourceThreadTs || SlackContext.threadTs → SLACK_MCP_CONTEXT.threadTs (one thread)
```

**After:**
```
SlackContext.threadTs → SLACK_MCP_CONTEXT.threadTs (work thread)
SlackContext.sourceThreadTs → SLACK_MCP_CONTEXT.sourceThreadTs (source thread, optional)
SlackContext.sourceChannel → SLACK_MCP_CONTEXT.sourceChannel (source channel, optional)
```

### 5.3 Type Changes

```typescript
// types.ts
export interface SlackMcpContext {
  channel: string;
  threadTs: string;
  mentionTs: string;
  sourceChannel?: string;    // NEW
  sourceThreadTs?: string;   // NEW
}
```

### 5.4 Tool Changes

| Tool | Change |
|------|--------|
| `get_thread_messages` | Add `thread?: "source" \| "work"` param (default: "work") |
| `send_thread_message` | NEW tool: `{ thread?: "source" \| "work", text: string }` |
| `send_file` | Add optional `thread?: "source" \| "work"` param |
| `send_media` | Add optional `thread?: "source" \| "work"` param |
| `download_thread_file` | No change (uses direct URL) |

### 5.5 Thread Resolution Logic

```typescript
// In slack-mcp-server.ts
private resolveThread(thread?: "source" | "work"): { channel: string; threadTs: string } {
  if (thread === "source") {
    if (!this.context.sourceThreadTs) {
      throw new Error("No source thread available — this session was not created from a mid-thread mention");
    }
    return {
      channel: this.context.sourceChannel || this.context.channel,
      threadTs: this.context.sourceThreadTs,
    };
  }
  // default: work thread
  return { channel: this.context.channel, threadTs: this.context.threadTs };
}
```

### 5.6 Integration Points

- `mcp-config-builder.ts:buildSlackMcpServer()` — stop collapsing threads, pass both
- `slack-handler.ts` — no change (already computes sourceThreadTs/sourceChannel)
- `stream-executor.ts` — no change (already passes sourceThreadTs to SlackContext)

## 6. Non-Functional Requirements

- **Backward Compatibility**: All existing tool calls without `thread` param work identically (default: "work")
- **Security**: `send_thread_message` uses same bot token; no new auth surface
- **Error Handling**: Clear error when `thread: "source"` used without source context

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Default thread = "work" | tiny | Work thread is where the session runs; existing behavior preserved |
| thread param as string union | tiny | "source" / "work" — simple, descriptive, extensible |
| resolveThread as shared helper | small | DRY — used by get_thread_messages, send_thread_message, send_file, send_media |
| No change to download_thread_file | tiny | Files have direct URLs; thread context irrelevant |
| mcp-config-builder passes work threadTs (not source) as primary | small | Reverses current behavior of `sourceThreadTs \|\| threadTs` — work thread should be primary since it's where the session runs |

## 8. Open Questions

None — all requirements clear, all decisions resolved.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/slack-mcp-cross-thread/spec.md`
