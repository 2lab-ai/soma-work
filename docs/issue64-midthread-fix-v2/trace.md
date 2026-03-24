# Issue #64 Mid-Thread Fix v2 — Vertical Trace

> STV Trace | Created: 2026-03-25
> Spec: docs/issue64-midthread-fix-v2/spec.md
> Debug: docs/debugging/issue64-202603250015/trace.md

## Table of Contents
1. [Scenario 1 — Thread root included in get_thread_messages](#scenario-1)
2. [Scenario 2 — Thread root with before:0](#scenario-2)
3. [Scenario 3 — Mid-thread: delete-then-retain ordering](#scenario-3)
4. [Scenario 4 — Top-level: delete + redirect preserved](#scenario-4)
5. [Scenario 5 — Mid-thread: retention message has permalink](#scenario-5)

---

## Scenario 1 — Thread root included in get_thread_messages

### 1. Entry Point
- Tool: `get_thread_messages`
- Handler: `SlackThreadMcpServer.handleGetThreadMessages()`
- File: `src/slack-thread-mcp-server.ts:231`

### 2. Input
```json
{
  "before": 10,
  "after": 0
}
```
- SLACK_THREAD_CONTEXT: `{ channel: "C123", threadTs: "1700000000.000000", mentionTs: "1700000010.000000" }`

### 3. Layer Flow

#### 3a. handleGetThreadMessages (slack-thread-mcp-server.ts:231)
- `anchorTs` ← args.anchor_ts || context.mentionTs → "1700000010.000000"
- `before` ← Math.min(Math.max(args.before ?? 10, 0), 50) → 10
- Calls `fetchMessagesBefore(anchorTs, before)`
- **NEW**: After fetch, calls `fetchThreadRoot()` if root not captured during fetchBefore
- Calls `formatMessages(messages, threadRoot, hasMoreBefore, hasMoreAfter)`

#### 3b. fetchMessagesBefore (slack-thread-mcp-server.ts:262)
- Calls `conversations.replies({ channel, ts: threadTs, limit: 200 })`
- API returns `[rootMsg, reply1, reply2, ...]` (root always at messages[0] on first page)
- **CURRENT (BUG)**: `if (m.ts === this.context.threadTs) continue` → root skipped
- **NEW**: When `m.ts === this.context.threadTs` → capture into `this.capturedRoot = m`, then `continue`
- Root is NOT added to `collected[]` (count semantics preserved)
- Transformation: `raw Slack message → captured as raw object (formatted later)`

#### 3c. fetchMessagesAfter (slack-thread-mcp-server.ts:299)
- `if (m.ts === this.context.threadTs) continue` → keep skip (root already captured)

#### 3d. handleGetThreadMessages — root fallback (NEW)
- If `this.capturedRoot` is null after fetchBefore (e.g., before=0 skips fetch):
  - Calls `fetchThreadRoot()` → single `conversations.replies({ channel, ts: threadTs, limit: 1 })`
  - API returns `[rootMsg]` → captures root
- Transformation: `this.capturedRoot → formatSingleMessage(root) → result.thread_root`

#### 3e. formatMessages — updated signature
- **CURRENT**: `formatMessages(messages, hasMoreBefore, hasMoreAfter)`
- **NEW**: `formatMessages(messages, hasMoreBefore, hasMoreAfter, threadRoot: any | null)`
- `threadRoot` → `formatSingleMessage(threadRoot)` → same ThreadMessage shape
- Result includes: `thread_root: ThreadMessage | null`
- `returned` count: `formatted.length` (excludes thread_root)

### 4. Side Effects
- None (read-only MCP tool)

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| conversations.replies fails | Existing error handler returns `{ error, isError: true }` |
| Root message deleted | `capturedRoot` remains null → `thread_root: null` in result |
| Root has no text (file-only) | `thread_root.text: ""`, files array populated |

### 6. Output
```json
{
  "thread_ts": "1700000000.000000",
  "channel": "C123",
  "thread_root": {
    "ts": "1700000000.000000",
    "user": "U_AUTHOR",
    "user_name": "Author Name",
    "text": "로그인 화면 리디자인 해야 합니다",
    "timestamp": "2023-11-14T22:13:20.000Z",
    "files": [],
    "reactions": [],
    "is_bot": false,
    "subtype": null
  },
  "returned": 10,
  "messages": [ ... ],
  "has_more_before": true,
  "has_more_after": false
}
```

### 7. Observability
- Existing: `logger.debug('Tool call: get_thread_messages', args)`
- NEW: `logger.debug('Thread root captured', { ts: root.ts })` (or 'Thread root not found')

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `threadRoot_includedInResult` | Happy Path | S1, Sec 3e — thread_root field in result |
| `threadRoot_notCountedInReturned` | Contract | S1, Sec 3e — returned excludes root |
| `threadRoot_formattedAsThreadMessage` | Contract | S1, Sec 3d — same ThreadMessage shape |

---

## Scenario 2 — Thread root with before:0

### 1. Entry Point
- Same as Scenario 1

### 2. Input
```json
{
  "before": 0,
  "after": 10
}
```

### 3. Layer Flow

#### 3a. handleGetThreadMessages
- `before` = 0 → `fetchMessagesBefore()` returns `[]` immediately (line 263: `if (count === 0) return []`)
- `capturedRoot` remains null (fetchBefore never runs API call)
- **NEW fallback**: calls `fetchThreadRoot()` → `conversations.replies({ channel, ts: threadTs, limit: 1 })`
- Root captured from fallback

#### 3b. fetchMessagesAfter
- Fetches messages after anchor
- Skips root (already captured by fallback)

### 4-7. Same as Scenario 1

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `threadRoot_beforeZero_stillReturnsRoot` | Happy Path | S2, Sec 3a — fallback fetch |
| `threadRoot_deletedRoot_returnsNull` | Sad Path | S2, Sec 5 — root deleted |

---

## Scenario 3 — Mid-thread: delete-then-retain ordering

### 1. Entry Point
- Function: `SessionInitializer.createBotInitiatedThread()`
- File: `src/slack/pipeline/session-initializer.ts:621`
- Trigger: `initialize()` → new session + mid-thread mention (thread_ts !== undefined)

### 2. Input
- `channel`: "C123"
- `threadTs`: "1711234567.000100" (original thread parent ts)
- `isMidThread`: true (thread_ts !== undefined, line 89)
- `session`: ConversationSession with dispatch results

### 3. Layer Flow

#### 3a. Session setup (unchanged, line 654-676)
- Creates bot session on new thread (rootResult.ts)
- Sets `botSession.sourceThread = { channel, threadTs }` (line 664-666)
- Terminates original session (line 675-676)

#### 3b. Message cleanup + retention (line 678-695) ★CHANGED★

**CURRENT flow**:
```
line 678: if (isMidThread) → postMessage("📋 요청을...") to original thread
line 686: if (shouldOutput) → postMigratedContextSummary to NEW thread
line 689: if (shouldOutput && !isMidThread) → postMessage("🧵") to original thread
line 693: if (!isMidThread) → deleteThreadBotMessages(channel, threadTs)
```

**NEW flow**:
```
line 678: deleteThreadBotMessages(channel, threadTs)          ← ALWAYS (removes dispatch clutter)
line 680: if (shouldOutput && !isMidThread) → postMessage("🧵") to original thread
line 683: if (shouldOutput) → postMigratedContextSummary to NEW thread
line 687: if (isMidThread) → getPermalink → postMessage("📋") to original thread  ← AFTER delete
```

Transformation:
- `deleteThreadBotMessages(channel, threadTs)` — removes all bot messages (dispatch status, conversation URL, etc.)
- `getPermalink(channel, rootResult.ts)` → `newThreadPermalink` (URL string or null)
- `postMessage(channel, "📋...${linkText}", { threadTs })` — retention survives because posted AFTER delete

### 4. Side Effects
- DB changes: None (session state is in-memory)
- Slack API calls:
  - DELETE: `deleteThreadBotMessages(C123, 1711234567.000100)` — removes all bot messages in original thread
  - POST: `postMessage(C123, "📋 요청을 확인했습니다...", { threadTs: 1711234567.000100 })` — retention in original thread

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| deleteThreadBotMessages fails | Logs warning, continues (existing behavior in `deleteThreadBotMessages` — caught internally) |
| getPermalink returns null | Posts retention without link: "📋 요청을 확인했습니다. 새 스레드에서 작업을 진행합니다" |
| postMessage (retention) fails | Logs error, does not block session creation |

### 6. Output
- Returns `SessionInitResult` with `session.sourceThread = { channel, threadTs }` (unchanged)

### 7. Observability
- Existing: `logger.info('🧵 Bot-initiated thread created, session migrated', { ... })`
- deleteThreadBotMessages has its own internal logging

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `midThread_deletesBeforeRetention` | Contract | S3, Sec 3b — delete THEN post ordering |
| `midThread_alwaysCallsDelete` | Happy Path | S3, Sec 3b — deleteThreadBotMessages called |
| `midThread_retentionPostedAfterDelete` | Side-Effect | S3, Sec 4 — retention survives |
| `midThread_permalinkNull_graceful` | Sad Path | S3, Sec 5 — null permalink |

---

## Scenario 4 — Top-level: delete + redirect preserved

### 1. Entry Point
- Same function: `createBotInitiatedThread()`
- `isMidThread`: false (thread_ts === undefined)

### 2. Input
- `channel`: "C123"
- `threadTs`: "thread123" (= ts, since thread_ts is undefined)
- `isMidThread`: false

### 3. Layer Flow

#### 3b. Message cleanup (line 678-695) — NEW flow for top-level
```
line 678: deleteThreadBotMessages(channel, threadTs)          ← ALWAYS (same as before)
line 680: if (shouldOutput && !isMidThread) → postMessage("🧵") to original thread  ← redirect
line 683: if (shouldOutput) → postMigratedContextSummary to NEW thread
line 687: if (isMidThread) → SKIP (isMidThread is false)
```

**Key**: Top-level behavior is functionally identical to before:
- deleteThreadBotMessages runs (was: `if (!isMidThread)`, now: always → same for top-level)
- "🧵" redirect message posted (unchanged)
- No retention message (unchanged)
- sourceThread NOT set (unchanged)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `topLevel_deletesAndRedirects` | Happy Path | S4, Sec 3b — delete + redirect |
| `topLevel_noRetentionMessage` | Contract | S4, Sec 3b — no 📋 message |
| `topLevel_noSourceThread` | Contract | S4, Sec 3a — sourceThread undefined |

---

## Scenario 5 — Mid-thread: retention message has permalink

### 1. Entry Point
- Same function: `createBotInitiatedThread()`
- `isMidThread`: true

### 3. Layer Flow

#### 3b. Permalink + retention (line 687-692 in NEW flow)
- `getPermalink(channel, rootResult.ts)` → permalink URL
- Transformation: `permalink → linkText = " → ${permalink}"` or `""` if null
- `postMessage(channel, "📋 요청을 확인했습니다. 새 스레드에서 작업을 진행합니다${linkText}", { threadTs })`
- Message text: `"📋 요청을 확인했습니다. 새 스레드에서 작업을 진행합니다 → https://workspace.slack.com/archives/C123/p..."`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `midThread_retentionIncludesPermalink` | Contract | S5, Sec 3b — permalink in message |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Capture root via instance field `capturedRoot` (not return value) | tiny (~3 lines) | Simplest way to pass root between fetchBefore and handleGetThreadMessages without changing return signatures |
| `fetchThreadRoot()` as separate private method | tiny (~8 lines) | Clean separation; only called when before=0 fallback needed |
| Format thread root with existing `formatSingleMessage` helper (extracted from formatMessages) | small (~10 lines) | DRY — same ThreadMessage transformation logic |
| Reorder lines 678-695 in createBotInitiatedThread without new methods | tiny (~5 lines) | Minimal diff; all logic stays in same function |

## Implementation Status
| Scenario | Trace | Tests | Verify | Status |
|----------|-------|-------|--------|--------|
| 1. Thread root included | done | GREEN | Verified | Complete |
| 2. Thread root before:0 | done | GREEN | Verified | Complete |
| 3. Mid-thread delete-then-retain | done | GREEN | Verified | Complete |
| 4. Top-level preserved | done | GREEN | Verified | Complete |
| 5. Mid-thread permalink | done | GREEN | Verified | Complete |

### Test Results
- `src/slack-thread-mcp-server-root.test.ts` — **5/5 pass**
- `src/slack/pipeline/session-initializer-midthread.test.ts` — **16/16 pass**
- `src/slack/source-thread-summary.test.ts` — **7/7 pass** (regression)
- `src/slack/pipeline/session-initializer-onboarding.test.ts` — **7/7 pass** (regression)
- `src/slack/pipeline/session-initializer-routing.test.ts` — **4/4 pass** (regression)

### v1 Tests Updated
- `midThread_doesNotDeleteBotMessages` → renamed to `midThread_deletesDispatchClutter`, now expects delete IS called
- `midThread_permalinkNull_gracefulDegradation` → now expects delete IS called

## Trace Deviations
None — implementation matches trace exactly.

## Verified At
2026-03-25 — All 5 scenarios GREEN + Verified
