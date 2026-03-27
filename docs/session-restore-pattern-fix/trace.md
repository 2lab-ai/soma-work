# Trace: Fix Session Restore Error Pattern Mismatch

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| S1 | isInvalidResumeSessionError matches "no conversation found" | tiny | ✅ GREEN |
| S2 | shouldClearSessionOnError defaults to true for unknown errors | tiny | ✅ GREEN |
| S3 | Existing recoverable errors still preserved | tiny | ✅ GREEN |
| S4 | Existing invalid session patterns still matched | tiny | ✅ GREEN |

---

## S1: isInvalidResumeSessionError matches "no conversation found"

### 1. Entry Point
- `stream-executor.ts:1058` → `isInvalidResumeSessionError(error)`

### 2. Parameter Flow
```
error.message = "No conversation found with session ID: 5f232806-..."
→ lowercased: "no conversation found with session id: 5f232806-..."
→ invalidSessionPatterns.some(p => message.includes(p))
→ BEFORE: 'conversation not found' ⊄ 'no conversation found...' → false
→ AFTER:  'no conversation found' ⊂ 'no conversation found...' → true
```

### 3. Implementation
- `stream-executor.ts:1061` → Add `'no conversation found'` to `invalidSessionPatterns` array

### 4. Contract Test
```typescript
it('detects "No conversation found" SDK error as invalid resume session', () => {
  const error = new Error('No conversation found with session ID: 5f232806-df17-47a3-9eb0-8bc76a2bac99');
  expect(executor['isInvalidResumeSessionError'](error)).toBe(true);
});
```

### 5. Side Effects
None — additive change only.

### 6. Verification
- isInvalidResumeSessionError returns true → shouldClearSessionOnError returns true → session cleared → no auto-retry

### 7. Boundary
- Only `stream-executor.ts` affected

---

## S2: shouldClearSessionOnError defaults to true for unknown errors

### 1. Entry Point
- `stream-executor.ts:932` → `shouldClearSessionOnError(error)`

### 2. Parameter Flow
```
BEFORE: return this.isInvalidResumeSessionError(error); // false for unrecognized → preserve
AFTER:  return true; // unrecognized errors clear session (safe default)
```

### 3. Implementation
- `stream-executor.ts:953` → Change `return this.isInvalidResumeSessionError(error)` to:
```typescript
// Unrecognized errors: clear session as safe default.
// Preserving a broken session causes infinite retry loops.
// isInvalidResumeSessionError is now redundant but kept for logging clarity.
if (this.isInvalidResumeSessionError(error)) {
  return true;
}
// Unknown error — clear session to prevent infinite retry loops
return true;
```

### 4. Contract Test
```typescript
it('clears session on unrecognized error (safe default)', () => {
  const error = new Error('Some completely unexpected error from SDK');
  expect(executor['shouldClearSessionOnError'](error)).toBe(true);
});
```

### 5. Side Effects
- Errors that were previously preserved (unrecognized) will now clear session
- This is the intended behavior — prevents infinite retry loops

### 6. Verification
- Unknown error → shouldClearSessionOnError returns true → session cleared → no auto-retry

### 7. Boundary
- Only `stream-executor.ts` affected

---

## S3: Existing recoverable errors still preserved

### 4. Contract Test
```typescript
it.each([
  'rate limit exceeded',
  'process exited with code 1',
  'temporarily unavailable',
  'timed out',
])('preserves session on recoverable error: %s', (msg) => {
  const error = new Error(msg);
  expect(executor['shouldClearSessionOnError'](error)).toBe(false);
});
```

---

## S4: Existing invalid session patterns still matched

### 4. Contract Test
```typescript
it.each([
  'conversation not found',
  'session not found',
  'cannot resume this session',
  'invalid resume token',
])('clears session on invalid resume error: %s', (msg) => {
  const error = new Error(msg);
  expect(executor['shouldClearSessionOnError'](error)).toBe(true);
});
```
