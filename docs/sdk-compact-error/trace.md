# Trace: SDK Error Detail + Auto-Compact Handling

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| S1 | System message handler (compact_boundary + status) | small ~20줄 | 🔴 Ready |
| S2 | formatErrorForUser stderrContent 출력 | tiny ~10줄 | 🔴 Ready |
| S3 | handleResultMessage error subtype 처리 | small ~15줄 | 🔴 Ready |

---

## S1: System Message Handler

### Entry Point
`stream-processor.ts:263` → `process()` for-await loop

### Current Flow
```
message.type === 'system'
  → (no handler) → dropped silently
```

### Target Flow
```
message.type === 'system'
  → subtype === 'compact_boundary'
    → log compact metadata (trigger, pre_tokens)
    → callbacks.onStatusUpdate?.('working') // optional: notify user
  → subtype === 'status' && status === 'compacting'
    → log compacting event
    → callbacks.onStatusUpdate?.('working')
  → subtype === 'init'
    → (already handled in claude-handler.ts:586-595, no action needed here)
  → other subtypes → debug log only
```

### Files
- `src/slack/stream-processor.ts:263-279` — add `else if (message.type === 'system')` branch

---

## S2: formatErrorForUser stderrContent Output

### Entry Point
`stream-executor.ts:1149` → `formatErrorForUser()`

### Current Flow
```
error.message → lines[0]: "❌ *[Bot Error]* {errorMessage}"
error.stderrContent → (not used in output, only in pattern matching)
```

### Target Flow
```
error.message → lines[0]: "❌ *[Bot Error]* {errorMessage}"
error.stderrContent → lines[N]: "> *SDK Details:* {sanitized stderrContent (last 500 chars)}"
```

### Sanitization
- Strip ANSI escape codes
- Truncate to last 500 chars (stderr can be very long)
- Mask token-like strings (oauth tokens, API keys)

### Files
- `src/slack/pipeline/stream-executor.ts:1149-1200` — add stderrContent block

---

## S3: handleResultMessage Error Subtype

### Entry Point
`stream-processor.ts:909` → `handleResultMessage()`

### Current Flow
```
message.subtype === 'success' → process result text
message.subtype === 'error_*' → (ignored)
```

### Target Flow
```
message.subtype === 'success' → process result text (unchanged)
message.subtype starts with 'error_' → {
  log error details: subtype, errors[], is_error, num_turns
  extract usage data (same as success path)
  if errors[] non-empty → log each error line
}
```

### SDK Error Subtypes (from SDKResultError)
- `error_during_execution` — runtime error
- `error_max_turns` — exceeded maxTurns limit
- `error_max_budget_usd` — exceeded budget
- `error_max_structured_output_retries` — structured output failures

### Files
- `src/slack/stream-processor.ts:909-943` — add error subtype handling
