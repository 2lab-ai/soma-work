# Bug Trace: FILE-ACCESS-BLOCKED — NormalizedProviderError stops execution

## AS-IS: When Claude SDK encounters "File access blocked" (sandbox restriction), the entire stream crashes and execution stops. User sees error and must manually retry.
## TO-BE: Error is caught, session preserved, and model automatically retries with error context injected — allowing it to choose an alternative approach without stopping.

## Phase 1: Heuristic Top-3

### Hypothesis 1: Error not classified as recoverable → no auto-retry scheduled
- `stream-executor.ts:922-944` → `shouldClearSessionOnError()` runs error through classification chain
- `isSlackApiError` → false (not a slack error)
- `isImageProcessingError` → false (doesn't match "could not process image")
- `isContextOverflowError` → false
- `isRecoverableClaudeSdkError` → false ("file access blocked" not in pattern list)
- Falls through to `isInvalidResumeSessionError` → false
- **Result**: `sessionCleared = false`, enters else branch at line 826
- Auto-retry logic at line 838 DOES fire (budget < 3)
- **BUT**: retry uses generic `AUTO_RESUME_PROMPT` (line 658-659) which doesn't mention the blocked file
- Model may attempt same blocked file again → same error → 3 retries exhausted → stops
- ✅ **ROOT CAUSE CONFIRMED**

### Hypothesis 2: Error crashes Node.js process entirely
- `claude-handler.ts:598-606` → error caught in try-catch, re-thrown with stderrContent
- `stream-executor.ts:727` → caught by execute() try-catch
- Process does NOT crash. Error IS caught. ❌ Ruled out

### Hypothesis 3: Session cleared incorrectly, losing context
- `shouldClearSessionOnError` returns false for unrecognized patterns
- Session IS preserved. ❌ Ruled out

## Conclusion

**Hypothesis 1 confirmed.** The error IS caught and auto-retry IS scheduled, but the retry prompt lacks error context. The model repeats the same file access attempt, exhausts 3 retries in ~90 seconds, then stops permanently.

## Fix Design

1. Add `isFileAccessBlockedError()` detection in `stream-executor.ts`
2. Add `lastErrorContext` field to `ConversationSession` in `types.ts`
3. When file access blocked: store error path in `session.lastErrorContext`, use 5s retry delay
4. Modify `autoResumeSession` to include error context when retrying
5. Clear `lastErrorContext` on successful execution
