# Trace: SDK "Operation aborted" Crash Defense

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | PreToolUse abort guard blocks tools after abort | small | GREEN |
| 2 | isAbortLikeError recognizes "operation aborted" | tiny | GREEN |
| 3 | Crash handlers use console.error + writeFileSync directly | small | GREEN |
| 4 | Restart notification for previously active sessions | small | GREEN |

---

## Scenario 1: PreToolUse abort guard blocks tools after abort

### Trace

```
ClaudeHandler.streamQuery()
  └─ options.hooks.PreToolUse
       └─ matcher: '*' (all tools)
       └─ hook(input):
            ├─ abortController.signal.aborted?
            │    └─ YES → { permissionDecision: 'deny' }
            └─ NO → { continue: true }
```

### Contract Test

```typescript
it('adds PreToolUse abort guard for all tools when slackContext provided', async () => {
  // streamQuery with slackContext should include abort guard hook
  // hook should deny when abort signal is set
});
```

---

## Scenario 2: isAbortLikeError recognizes "operation aborted"

### Trace

```
StreamExecutor.isAbortLikeError(error)
  └─ message.includes('operation aborted')  // NEW: without "was"
  └─ message.includes('operation was aborted')  // existing
```

### Contract Test

```typescript
it('recognizes "Operation aborted" as abort-like error', () => {
  const error = new Error('Operation aborted');
  expect(executor.isAbortLikeError(error)).toBe(true);
});
```

---

## Scenario 3: Crash handlers use console.error + writeFileSync directly

### Trace

```
process.on('uncaughtException', handler)
  └─ handler(error):
       ├─ console.error('CRASH: uncaught exception', error)  // direct stderr, no logger
       ├─ slackHandler.saveSessions()  // already uses writeFileSync
       ├─ slackHandler.savePendingForms()
       └─ process.exit(1)
```

---

## Scenario 4: Restart notification for previously active sessions

### Trace

```
SlackHandler.loadSavedSessions()
  └─ claudeHandler.loadSessions()
       └─ sessionRegistry.loadSessions()
            └─ for each loaded session:
                 ├─ session.activityState !== 'idle' ?
                 │    └─ crashRecoverySessions.push(session)
                 └─ reset activityState to 'idle'
  └─ for each crashRecoverySessions:
       └─ app.client.chat.postMessage({
            channel: session.channelId,
            thread_ts: session.threadTs,
            text: "⚠️ 서비스가 재시작되었습니다. 이전 작업이 중단되었을 수 있습니다."
          })
```
