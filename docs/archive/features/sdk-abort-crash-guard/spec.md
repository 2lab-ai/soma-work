# Spec: SDK Abort Crash Guard

## Problem

Claude Agent SDK internally writes to an already-aborted process (`H4.write` in `handleControlRequest`). This throws an uncaught exception that crashes the entire Node process. All in-memory sessions are lost because `sessions.json` is only saved on graceful shutdown (SIGINT/SIGTERM), not on crash.

### Timeline (observed)

```
17:03    ClaudeHandler catches "Operation aborted" → handled correctly
17:03-12 Slack rate limit errors flood (retry-after: 10)
~17:12   SDK async write to aborted process → uncaught exception → Node crash
17:12:20 LaunchDaemon auto-restarts → sessions gone
```

### Root Cause

1. First "Operation aborted" caught by `streamQuery` try-catch — OK
2. SDK internally retries write in a separate async context — escapes our try-catch
3. No `process.on('uncaughtException')` handler → instant crash
4. No session save on crash → all active sessions lost

## Solution

### 1. Add uncaughtException/unhandledRejection handlers (src/index.ts)

Save sessions and pending forms before crash exit. This is a safety net — the process still exits but sessions survive.

### 2. Add periodic session auto-save

Currently sessions are only saved on graceful shutdown. Add periodic auto-save (every 5 minutes) so crash recovery loses at most 5 minutes of session data.

## Scope

- `src/index.ts`: Add crash handlers + periodic save
- No changes to SDK integration or stream handling
- Existing `saveSessions()` and `savePendingForms()` methods already exist

## Sizing

**small** (~30 lines) — 1 file, straightforward additions
