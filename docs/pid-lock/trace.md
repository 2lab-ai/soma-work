# Trace: PID Lock — Single Instance Guard

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | acquirePidLock — no existing lock | tiny | 🔴 |
| 2 | acquirePidLock — stale lock (dead PID) | small | 🔴 |
| 3 | acquirePidLock — live lock (running PID) | small | 🔴 |
| 4 | releasePidLock — cleanup on shutdown | tiny | 🔴 |
| 5 | index.ts integration — startup + shutdown | small | 🔴 |
| 6 | service.sh — PID file fallback stop | small | 🔴 |

---

## Scenario 1: acquirePidLock — no existing lock

### Trace
```
start() [index.ts:24]
  → validateConfig() [index.ts:33]
  → acquirePidLock(DATA_DIR) [pid-lock.ts:NEW]
    → fs.existsSync(`${DATA_DIR}/soma-work.pid`) → false
    → fs.writeFileSync(`${DATA_DIR}/soma-work.pid`, String(process.pid))
    → return true
```

### Contract Test
```typescript
// pid-lock.test.ts
it('creates lock file when none exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pid-'));
  const result = acquirePidLock(dir);
  expect(result).toBe(true);
  expect(readFileSync(join(dir, 'soma-work.pid'), 'utf-8')).toBe(String(process.pid));
});
```

---

## Scenario 2: acquirePidLock — stale lock (dead PID)

### Trace
```
acquirePidLock(DATA_DIR) [pid-lock.ts:NEW]
  → fs.existsSync(`${DATA_DIR}/soma-work.pid`) → true
  → fs.readFileSync → pidStr = "99999"
  → parseInt(pidStr) → pid = 99999
  → process.kill(99999, 0) → throws ESRCH (no such process)
  → logger.warn("Stale PID lock detected (pid=99999), removing")
  → fs.unlinkSync(`${DATA_DIR}/soma-work.pid`)
  → fs.writeFileSync(`${DATA_DIR}/soma-work.pid`, String(process.pid))
  → return true
```

### Contract Test
```typescript
it('removes stale lock and acquires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pid-'));
  writeFileSync(join(dir, 'soma-work.pid'), '999999'); // non-existent PID
  const result = acquirePidLock(dir);
  expect(result).toBe(true);
  expect(readFileSync(join(dir, 'soma-work.pid'), 'utf-8')).toBe(String(process.pid));
});
```

---

## Scenario 3: acquirePidLock — live lock (running PID)

### Trace
```
acquirePidLock(DATA_DIR) [pid-lock.ts:NEW]
  → fs.existsSync → true
  → fs.readFileSync → pidStr = "<current_pid>"
  → process.kill(<current_pid>, 0) → no error (process alive)
  → logger.error("Another instance already running (pid=<current_pid>). Exiting.")
  → return false  // caller does process.exit(1)
```

### Contract Test
```typescript
it('refuses to acquire when another instance is running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pid-'));
  // Use current process PID (definitely alive)
  writeFileSync(join(dir, 'soma-work.pid'), String(process.pid));
  const result = acquirePidLock(dir);
  // Should fail because process.pid is alive and it's not "us" re-acquiring
  // Actually: we need to distinguish self vs other. Use a different alive PID.
  // process.ppid is always alive.
  writeFileSync(join(dir, 'soma-work.pid'), String(process.ppid));
  const result2 = acquirePidLock(dir);
  expect(result2).toBe(false);
});
```

---

## Scenario 4: releasePidLock — cleanup on shutdown

### Trace
```
cleanup() [index.ts:259]
  → releasePidLock(DATA_DIR) [pid-lock.ts:NEW]
    → fs.existsSync(`${DATA_DIR}/soma-work.pid`) → true
    → fs.readFileSync → pidStr matches process.pid
    → fs.unlinkSync(`${DATA_DIR}/soma-work.pid`)
```

### Contract Test
```typescript
it('removes lock file on release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pid-'));
  acquirePidLock(dir);
  releasePidLock(dir);
  expect(existsSync(join(dir, 'soma-work.pid'))).toBe(false);
});
```

---

## Scenario 5: index.ts integration

### Trace
```
start() [index.ts:24]
  → validateConfig() [index.ts:33]
  → acquirePidLock(DATA_DIR) [NEW LINE ~35]
    → if (!result) process.exit(1)
  → ... rest of startup ...

cleanup() [index.ts:259]
  → releasePidLock(DATA_DIR) [NEW LINE ~266]
  → ... rest of cleanup ...
```

---

## Scenario 6: service.sh PID file fallback

### Trace
```
cmd_stop() [service.sh:214]
  → launchctl unload ...
  → NEW: if PID file exists at $PROJECT_DIR/data/soma-work.pid
    → read PID from file
    → kill $PID (SIGTERM)
    → sleep 2
    → if still alive: kill -9 $PID
    → rm PID file
```
