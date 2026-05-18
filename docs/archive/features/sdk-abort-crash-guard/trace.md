# Trace: SDK Abort Crash Guard

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | uncaughtException handler saves sessions before exit | small | GREEN |
| 2 | unhandledRejection handler saves sessions before exit | small | GREEN |
| 3 | Periodic session auto-save every 5 minutes | small | GREEN |

---

## Scenario 1: uncaughtException handler saves sessions before exit

### Trace

```
process.on('uncaughtException', handler)
  └─ handler(error):
       ├─ logger.error('Uncaught exception', error)
       ├─ slackHandler.saveSessions()
       ├─ slackHandler.savePendingForms()
       └─ process.exit(1)
```

### Contract Test

```typescript
it('saves sessions on uncaughtException', () => {
  // Verify process.on('uncaughtException') is registered
  // Verify handler calls saveSessions and savePendingForms
});
```

---

## Scenario 2: unhandledRejection handler saves sessions before exit

### Trace

```
process.on('unhandledRejection', handler)
  └─ handler(reason):
       ├─ logger.error('Unhandled rejection', reason)
       ├─ slackHandler.saveSessions()
       ├─ slackHandler.savePendingForms()
       └─ process.exit(1)
```

---

## Scenario 3: Periodic session auto-save every 5 minutes

### Trace

```
startPeriodicSave(slackHandler, intervalMs = 300_000)
  └─ setInterval(() => {
       ├─ slackHandler.saveSessions()
       └─ logger.debug('Periodic session save')
     }, intervalMs)
```
