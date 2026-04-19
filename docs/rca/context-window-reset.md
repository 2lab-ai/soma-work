# RCA — Context% does not reset after `/new` and `/compact`

Status: **Investigation only — fix split to follow-up issue** (see "Resolution").
Owner: dashboard-improvements-v2 (issue #597).

## 1. Symptom

After a user runs `/new` or `/compact` in a thread, the dashboard Kanban
card (and the Slack context emoji) continue to show the pre-reset context
window percentage for the next assistant turn, sometimes for several turns
in a row. Expected behaviour:

- `/new`   → next turn reports context < 10% (only the new prompt fits).
- `/compact` → next turn reports context near the compacted-window target
  (small, relative to the pre-compact value).

## 2. Reproduction path

1. User starts a session, drives it until context > 50%.
2. User posts `/new` (or `/compact`). Bot acknowledges.
3. User posts a short follow-up (e.g. `hi`).
4. Expected: card shows ~5–10% context usage.
5. Observed: card still shows the pre-reset value, decaying only as new
   turns accumulate.

Code path walkthrough:

- `/new` → `NewHandler.execute()` →
  `claudeHandler.resetSessionContext(channel, threadTs)` →
  `SessionRegistry.resetSessionContext()` at
  `src/session-registry.ts:1064` clears `session.usage = undefined`. So at
  `src/slack/pipeline/stream-executor.ts:318` the next turn computes
  `contextUsagePercentBefore` as `undefined` (usage is `undefined`). The
  registry mutation is correct in isolation.
- `/compact` → `CompactHandler.execute()` → returns
  `{ continueWithPrompt: '/compact' }`. The SDK emits `compact_boundary`
  and `onCompactBoundary` fires at
  `src/slack/pipeline/stream-executor.ts:762`, which only sets
  `session.compactionOccurred = true`. **`session.usage` is not touched.**

## 3. Expected vs observed state

| Signal | Expected after reset | Observed |
|---|---|---|
| `session.usage.currentInputTokens` | 0 (or per-turn small value) | Unchanged (stale carry-over) |
| `session.usage.currentCacheReadTokens` | 0 or reduced | Unchanged |
| `session.usage.currentCacheCreateTokens` | 0 or reduced | Unchanged |
| `contextUsagePercentBefore` (line 318) | undefined or low | High (matches pre-reset) |
| `calculateRemainingPercent()` output | ~90–100% remaining | Low remaining |

Hypothesised variance between `/new` and `/compact`:

- `/new` **does** null out `session.usage`. If the symptom reproduces for
  `/new` at all, the culprit is downstream (dashboard snapshot cache,
  context-window-manager emoji state, or WebSocket push timing) — not the
  registry.
- `/compact` does not null out `session.usage`. The SDK is expected to
  send fresh per-turn token counts on the next assistant turn — i.e.
  `usage.lastTurnInputTokens` should already be the post-compact
  occupancy. If the SDK does **not** emit per-turn tokens on the
  compact-response path, `updateSessionUsage()` falls into the aggregate
  branch (`!hasPerTurn`, logged at line 2083) and double-counts cache
  reads from the whole agent loop.

## 4. Candidate root causes

1. **SDK per-turn gap after compact_boundary**
   `updateSessionUsage` at `src/slack/pipeline/stream-executor.ts:2049`
   branches on `usage.lastTurnInputTokens !== undefined`. If the SDK omits
   per-turn fields for the first message after compaction (or `/new`
   re-dispatch), `currentInputTokens` inherits the aggregate sum from the
   entire API loop — which includes the pre-reset cache window, giving
   the illusion that `/compact` did nothing.
2. **Dashboard WebSocket snapshot caching**
   `dashboard.ts` `buildKanbanBoard` reads `session.usage` on broadcast.
   If no broadcast fires between reset and the next user message, the
   client-side cache keeps the stale % until the next activity event.
3. **Context emoji state not cleared**
   `ContextWindowManager.contextState` is keyed by `sessionKey`. The
   `/new` handler clears the emoji (`cleanupEmojisBeforeReset`) but
   `/compact` does not. The stale emoji can persist visually even when
   `session.usage` is already correct — giving a user-facing symptom that
   looks identical to the actual stale-state bug.
4. **`compactionOccurred` flag re-injects pre-compact context**
   Line 400 block reads `session.compactionOccurred` and re-injects the
   pre-compact conversation context into the next prompt. If this path
   inflates `currentInputTokens` on the follow-up turn, context% will
   appear to remain high for one extra turn even when compaction did
   succeed.

## 5. Evidence gaps (what we still need)

- Log tail capturing `'Updated session usage'` (debug) for the two turns
  straddling `/compact`. Need: `usageSource`, `hasPerTurn`,
  `currentContext` values.
- WebSocket trace: does `broadcastSessionUpdate` fire between the
  `/compact` ack and the next user message?
- `ContextWindowManager.contextState` snapshot across the reset.

Without these three signals we cannot pick between hypotheses 1 and 2
(the other two can be settled by static reading of the code paths).

## 6. Proposed fixes (by hypothesis)

| Hypothesis | Fix | Risk |
|---|---|---|
| 1 | On `onCompactBoundary`, null out `session.usage` OR force-reset `currentInput/Cache*` to 0, then broadcast. On next usage event, per-turn data re-populates. | Medium — changes token accounting semantics. Must verify billing totals (`total*Tokens`) are unaffected. |
| 2 | Fire `broadcastSessionUpdate()` from the `/new` and `/compact` handlers at ack time. | Low — pure UI path, already guarded. |
| 3 | Extend `cleanupEmojisBeforeReset` to `/compact` flow (or move it into `resetSessionContext` + add an equivalent `onCompactBoundary` hook). | Low — mirrors existing pattern. |
| 4 | Revisit `compactionOccurred` re-injection ordering so that per-turn token accounting sees post-compact state. | High — touches core compaction-aware context preservation. |

## 7. Resolution

Per plan v2.1 decision tree (LOC > +300 OR 2+ modules OR no log evidence
→ split), and because we have **no runtime log evidence** to disambiguate
hypotheses 1 vs 2, the fix is split to a follow-up issue.

- This PR (#597): ship the RCA document + timer/counter/displayTitle
  infrastructure. Dashboard now fires `broadcastSessionUpdate()` more
  aggressively via the turn-timer path, which partially mitigates
  hypothesis 2.
- Follow-up issue: `[follow-up] /new·/compact context% reset fix`
  (linked from the PR body). Includes:
  - Capture the three missing signals listed in §5.
  - Implement hypothesis 1 + 3 fix chunks.
  - Add the regression test
    `src/slack/pipeline/stream-executor.context-reset.test.ts`
    asserting `contextUsagePercent < 10%` on the first turn after `/new`.
