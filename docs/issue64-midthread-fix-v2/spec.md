# Issue #64 Mid-Thread Fix v2 — Spec

> STV Spec | Created: 2026-03-25
> Debug trace: `docs/debugging/issue64-202603250015/trace.md`

## 1. Overview

Issue #64의 mid-thread 멘션 수정이 머지되었으나 3가지 증상이 잔존한다.
근본 원인은 두 가지: (A) MCP 서버가 스레드 부모 메시지를 skip, (B) 디스패치 후 메시지 삭제 순서가 잘못됨.
이 스펙은 두 버그를 동시에 수정한다.

## 2. User Stories

- As a user who mentions the bot mid-thread, I want the bot to read the thread's parent message so it understands the full context.
- As a user who mentions the bot mid-thread, I want dispatch clutter removed and a clean retention message left in the original thread with a link to the new work thread.
- As a user who closes a mid-thread session, I want a summary posted back to the original thread.

## 3. Acceptance Criteria

- [ ] `get_thread_messages` returns the thread root (parent message) in a dedicated `thread_root` field
- [ ] Thread root is NOT counted toward `before`/`after` limits (bonus inclusion)
- [ ] `createBotInitiatedThread()` always runs `deleteThreadBotMessages` (both mid-thread and top-level)
- [ ] After deletion, mid-thread posts retention message ("📋 요청을 확인했습니다 → [permalink]")
- [ ] Top-level mention behavior unchanged (delete + "🧵" redirect message)
- [ ] `sourceThread` correctly set on bot session for mid-thread mentions (existing, unchanged)
- [ ] `postSourceThreadSummary` fires on session close/PR merge for mid-thread sessions (existing, unchanged)
- [ ] All existing tests updated to reflect new behavior
- [ ] No regression in top-level mention flow

## 4. Scope

### In-Scope
- Fix A: `slack-thread-mcp-server.ts` — include thread root in results
- Fix B: `session-initializer.ts` — reorder delete/retention logic
- Test updates for both fixes

### Out-of-Scope
- `channel-route-action-handler.ts` mid-thread guard (separate, PR-workflow-only issue)
- Retention message content/format redesign
- New MCP tools or parameters

## 5. Architecture

### 5.1 Fix A: Thread Root Inclusion

**File**: `src/slack-thread-mcp-server.ts`

**Current flow**:
```
conversations.replies → messages[0] is thread root → SKIP (line 279/315) → model never sees it
```

**New flow**:
```
conversations.replies → messages[0] is thread root → CAPTURE as thread_root → return separately
```

**Changes**:

1. `fetchMessagesBefore()` (line 262-293):
   - Instead of `continue` on root, capture it into a class-level `threadRoot` variable
   - Still exclude from `collected[]` (so `count` is not affected)

2. `fetchMessagesAfter()` (line 299-326):
   - Keep `continue` on root (root is already captured by fetchBefore or dedicated fetch)

3. `handleGetThreadMessages()` (line 231-254):
   - If `threadRoot` not captured by fetchBefore (e.g., `before: 0`), fetch it directly via single API call
   - Include `thread_root` in result

4. `formatMessages()` / result interface:
   - Add `thread_root: ThreadMessage | null` to `GetThreadMessagesResult`

**Result format change**:
```typescript
interface GetThreadMessagesResult {
  thread_ts: string;
  channel: string;
  thread_root: ThreadMessage | null;  // NEW — always included when available
  returned: number;                    // does NOT count thread_root
  messages: ThreadMessage[];
  has_more_before: boolean;
  has_more_after: boolean;
}
```

### 5.2 Fix B: Delete-then-Retain Order

**File**: `src/slack/pipeline/session-initializer.ts`

**Current flow** (line 678-695):
```
if (isMidThread) → post retention    // retention posted BEFORE delete
if (shouldOutput) → post context summary + redirect
if (!isMidThread) → deleteThreadBotMessages  // delete only for top-level
```

**New flow**:
```
// 1. Always clean up dispatch clutter
await deleteThreadBotMessages(channel, threadTs)

// 2. Post messages into clean thread
if (shouldOutput && !isMidThread) → post redirect "🧵 새 스레드에서 작업을 시작합니다 →"
if (isMidThread) → post retention "📋 요청을 확인했습니다 → [permalink]"
```

**Key insight**: `deleteThreadBotMessages` removes ALL bot messages in the original thread. By running it first, we ensure a clean slate. The retention message is posted AFTER deletion, so it survives.

### 5.3 Integration Points

| Component | Impact |
|-----------|--------|
| `session-initializer-midthread.test.ts` | Update: `deleteThreadBotMessages` IS now called for mid-thread; retention posted AFTER |
| `session-initializer-onboarding.test.ts` | Verify no regression |
| `source-thread-summary.ts` | No change needed — `sourceThread` is set correctly |
| `source-thread-summary.test.ts` | No change needed |

## 6. Non-Functional Requirements

- **Performance**: No additional API calls for Fix B. Fix A adds at most 1 extra `conversations.replies` call when `before: 0` (rare case).
- **Security**: No change.
- **Backward compatibility**: `thread_root` is a new field — consumers that don't read it are unaffected.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Thread root as separate `thread_root` field (not inline in `messages[]`) | small (~15 lines) | Avoids breaking `returned` count semantics. Model sees root clearly separated from replies. |
| Always run `deleteThreadBotMessages` (remove `!isMidThread` guard) | small (~10 lines) | User explicitly requested: "디스패치 메시지 삭제 후에 retention 메시지 남기면 될듯". Simplifies logic. |
| Capture root in `fetchMessagesBefore`, not a separate method | tiny (~5 lines) | Root is always on first page of `conversations.replies`. No need for separate API call in the common case. |
| Keep `shouldOutput` context summary for new thread only (not original thread) | tiny (~3 lines) | Context summary belongs in the work thread. Original thread only needs the retention pointer. |

## 8. Open Questions

None — all decisions confirmed by user evidence and code analysis.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/issue64-midthread-fix-v2/spec.md`
