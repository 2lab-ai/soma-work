# Bug Trace: /compact follow-up — duplicate starting message, runaway ticker, empty auto-compact stats

## AS-IS

1. `/compact` → 3 Slack messages appear:
   - `🗜️ Triggering context compaction...` (from `CompactHandler.execute`)
   - `⏳ 🗜️ Compaction starting · trigger=manual — 2m 16s (edited)` — ticker KEEPS UPDATING long after completion
   - `🟢 🗜️ Compaction completed …` (separate message; not in-place edit)
2. Auto-compact (SDK-triggered, threshold-driven or context-full) produces:
   - `🟢 🗜️ Compaction completed\nContext: now ~?% ← was ~?%`
   (Both percentages are `?`; no token info.)
3. `/compact` slash trigger has no user confirmation.

## TO-BE

1. `/compact` posts exactly ONE live-updating "starting" message that is
   edited in place to the "completed" state. No orphan ticker.
2. Auto-compact completion message includes real pre/post %, token counts,
   trigger, and duration — whichever metadata the SDK provides.
3. `/compact` shows a yes/no confirm button; compaction only runs on
   explicit confirmation.

## Phase 1: Heuristic Top-3

### Hypothesis 1 (duplicate + runaway ticker): race between PreCompact hook and `onStatusUpdate('compacting')` fallback

`src/slack/hooks/compact-hooks.ts:323` — `postCompactStartingIfNeeded`:

```typescript
const marker = ensurePostedMap(session)[epoch];
if (!marker || marker.pre) return;
// ... resolve trigger, format text ...
const result = await slackApi.postSystemMessage(channel, initialText, { threadTs });
marker.pre = true;                     // <<< set AFTER await
session.compactStartingMessageTs = result.ts ?? null;
session.compactTickInterval = setInterval(…);  // <<< overwrites any existing interval
```

Two callsites can fire near-simultaneously:
- `claude-handler.ts:911` — `PreCompact` SDK hook → `handlePreCompact` → `postCompactStartingIfNeeded(…, 'manual'|'auto')`.
- `stream-executor.ts:900` — `onStatusUpdate('compacting')` fire-and-forget IIFE → `postCompactStartingIfNeeded(…, 'unknown (fallback)')`.

Both IIFEs enter before either awaits. Both pass the `marker.pre === false` guard synchronously. Both await `postSystemMessage`. Both then set `marker.pre = true`, overwrite `session.compactStartingMessageTs`, and overwrite `session.compactTickInterval` — the earlier `setInterval` is NEVER cleared, so it keeps ticking forever against its (now stale) message ts.

Evidence: `compaction #6` + 2m 16s elapsed elapsed → user ran compact multiple times; a leaked interval from a prior race keeps running. In-place edit fails because the completion path resolves `session.compactStartingMessageTs` to the second ts, not the leaked one.

**Status**: ✅ Confirmed — atomic dedupe was never performed.

### Hypothesis 2 (auto-compact `~?%`): PostCompact hook fires before `onCompactBoundary`

SDK emits two END signals:
- `compact_boundary` system message (has `compact_metadata`: trigger + pre_tokens + post_tokens + duration_ms). Handled by `stream-processor.ts:1029` → `onCompactBoundary` callback → sets `session.compactPreTokens/compactPostTokens/compactTrigger/compactDurationMs` + calls `postCompactCompleteIfNeeded`.
- `PostCompact` hook (has only `trigger` + `compact_summary`). Handled by `compact-hooks.ts:447` → `handlePostCompact` → calls `postCompactCompleteIfNeeded` directly.

SDK does not guarantee order. When `PostCompact` arrives first:
- `session.compactPreTokens/compactPostTokens` are still `null`.
- `session.lastKnownUsagePct` may be `null` (e.g. first compaction after bot restart).
- `buildCompactCompleteMessage` renders `~?% ← was ~?%`.
- `marker.post = true` gets set, so when `onCompactBoundary` fires a moment later with real metadata, the helper sees `marker.post === true` and SKIPS the post.

**Status**: ✅ Confirmed — no ordering guarantee, and the helper posts eagerly on whichever signal arrives first.

### Hypothesis 3 (no confirmation): by design, not a bug

`CompactHandler.execute` posts "Triggering…" and returns `{ continueWithPrompt: '/compact' }` immediately. No intermediate prompt exists.

**Status**: Confirmed — requires feature work, not fix.

## Fix Plan

### Fix 1 — Atomic START dedupe + defensive ticker cleanup

In `postCompactStartingIfNeeded`:
- Move `marker.pre = true` BEFORE the `postSystemMessage` await so racing callers can't both pass the guard.
- Call `stopStartingTicker(session)` BEFORE `setInterval(…)` so any leaked interval from a prior cycle is cleared.

### Fix 2 — Capture trigger + wait for `compact_boundary` on PostCompact path

- `handlePostCompact` reads `payload.trigger` (SDK guarantees it) and writes `session.compactTrigger` — guarantees the trigger segment even if `onCompactBoundary` never fires.
- `postCompactCompleteIfNeeded` accepts `{ source: 'post-compact-hook' | 'on-compact-boundary' }`. When source is `post-compact-hook` and metadata is absent, the helper awaits a short grace window (500 ms). If `onCompactBoundary` races in during the wait, it posts first, sets `marker.post = true`, and the PostCompact path sees the closed cycle.

### Fix 3 — `/compact` yes/no confirmation

- Extend `CommandParser.isCompactCommand` to also match `/compact --yes` / `compact --yes`.
- `CompactHandler.execute`: when text lacks `--yes`, post Block Kit buttons (✅ 압축 진행 / 취소) and return `{ handled: true }` (no `continueWithPrompt`). When `--yes` is present, run the original flow.
- New `compact_confirm` action handler: `slackApi.updateMessage` with "🗜️ Triggering context compaction..." and `dispatchPendingUserMessage(ctx, '/compact --yes')` so the pipeline re-enters and the SDK actually runs.
- New `compact_cancel` action handler: replace original with "취소되었습니다."

## Verification

- Unit tests (`src/slack/hooks/compact-hooks.test.ts`, `compact-complete-message.test.ts`, `compact-fallback.test.ts`):
  - New RED test: two parallel `postCompactStartingIfNeeded` calls produce exactly one Slack post and one ticker.
  - New RED test: PostCompact-hook-first ordering waits for metadata before posting.
  - New RED test: `handlePostCompact` sets `session.compactTrigger` from payload.
- New `compact-handler.test.ts` cases:
  - `/compact` (no `--yes`) posts buttons and returns `{ handled: true }` only.
  - `/compact --yes` returns `{ handled: true, continueWithPrompt: '/compact' }`.
- New `session-action-handler.test.ts` cases for `compact_confirm` / `compact_cancel`.
