# Spec: Fix Session Restore Error Pattern Mismatch

## Problem Statement

`isInvalidResumeSessionError()` fails to match the Claude SDK's actual error message `"No conversation found with session ID: xxx"` because the pattern `"conversation not found"` is not a substring of `"no conversation found"`.

This causes the error to be classified as "unknown" → session preserved → 3x auto-retry with same broken session ID → user sees repeated errors.

## Requirements

### R1: Match actual SDK error message
- `isInvalidResumeSessionError()` must detect `"no conversation found"` as invalid resume

### R2: Safe default for unrecognized errors
- `shouldClearSessionOnError()` must clear session on unrecognized errors (current default: preserve → dangerous)

### R3: Backward compatibility
- Existing patterns must continue to work
- Recoverable error classification unchanged

## Architecture Decision

**AD1**: Add pattern vs rewrite matching logic
- Decision: **Add pattern** — minimal change, zero regression risk
- `'no conversation found'` added to `invalidSessionPatterns`

**AD2**: Change default behavior of shouldClearSessionOnError
- Decision: **Change default to true** — unrecognized errors should clear session
- Reasoning: Preserving a potentially broken session causes infinite retry loops. Clearing is the safe default. Cost of clearing (context loss) < cost of infinite error loop.

## Affected Files

| File | Change |
|------|--------|
| `src/slack/pipeline/stream-executor.ts` | Pattern + default fix |
| `src/slack/pipeline/stream-executor.test.ts` | New test cases |

## Size: tiny (~5 lines implementation + tests)
