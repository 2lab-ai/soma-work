# Slack UI Phase 2 — B2 plan block via `TurnSurface.renderTasks`

Scope: issue [#577](https://github.com/2lab-ai/soma-work/issues/577),
umbrella [#525](https://github.com/2lab-ai/soma-work/issues/525) Phase 2.
Phase 1 (PR #556) consolidated the **B1 stream block** into `TurnSurface`
behind `SOMA_UI_5BLOCK_PHASE>=1`. Phase 2 takes the second step: move the
**B2 plan block** (TodoWrite snapshots) out of the combined-header embed and
into its own single-writer Slack message rendered by
`TurnSurface.renderTasks`, gated on `SOMA_UI_5BLOCK_PHASE>=2`.

## What Phase 2 changes

The 5-block per-turn UI (from plan v2, §3):

| Block | Owner after P2 | Status in this PR |
|---|---|---|
| **B1** stream (assistant markdown **+ tool verbose at PHASE>=2**) | `TurnSurface` via `chat.startStream` / `appendStream` / `stopStream` | **absorbs tool verbose** (see §Tool Verbose Absorb) |
| **B2** plan / task_card | `TurnSurface.renderTasks` via `chat.postMessage` / `chat.update` on `planTs` | **migrated** |
| **B3** UIAskUserQuestion slot | `ThreadSurface` (legacy) | unchanged — P3 |
| **B4** AI working indicator | `AssistantStatusManager` (legacy) | unchanged — P4 |
| **B5** `<작업 완료>` marker | `TurnNotifier` + `CompletionMessageTracker` (legacy) | unchanged — P5 |

B1 ownership under PHASE>=2 covers **two input streams**: the assistant
text chunks emitted by the SDK (P1, unchanged) and the formatted tool
result bodies that previously posted as standalone `chat.postMessage`
bubbles (P2, this PR). Both ride the same `streamTs` via `appendStream`
chunks.

Message-ownership table (PHASE>=2):

| Slack message ts | Owner | Written by |
|---|---|---|
| `streamTs` (B1) | `TurnSurface` | `begin` / `appendText` / `end` / `fail` |
| `planTs` (B2) | `TurnSurface` | `renderTasks` |
| `headerTs` (combined header + panel) | `ThreadSurface` | `updatePanel` / `refreshAndRender` |

`planTs` and `headerTs` are **separate** Slack messages. There is no shared
`ts` race: the task-list embed that previously lived inside `headerTs` is
skipped under PHASE>=2 (see `thread-surface.ts` guard) so the two surfaces
don't dual-render the same todos.

Scope boundary: **B2 single-writer** means the plan-block message
(`planTs`) only. In P2 the combined-header message (`headerTs`) still
updates on every TodoWrite so the ETA / progress chip stays fresh; it just
no longer carries the verbose task-list rows. B3/B4/B5 stay on their legacy
surfaces until P3/P4/P5 ship.

## Rollout flag

```bash
# cumulative prefix: N enables P1..PN, everything > N stays legacy
# valid values: 0 (default) | 1 | 2 | 3 | 4 | 5
# any value outside [0..5] → warn + fallback to 0 (fail closed)
SOMA_UI_5BLOCK_PHASE=0
```

Parsed in `src/config.ts` as `config.ui.fiveBlockPhase`. Every new code path
reads this value **per call** (not cached), so a runtime restart with a new
value is sufficient to roll forward or back.

### Rollout sequence

1. Merge this PR with `SOMA_UI_5BLOCK_PHASE=1` in dev (already set from P1).
   Prod stays PHASE=0 or 1 → zero B2 behavior change.
2. **PHASE flip gate** — before flipping dev to `SOMA_UI_5BLOCK_PHASE=2`,
   run the `ui-test plan` smoke on **iOS**, **Android**, and **desktop
   web**. If any client fails to render the `plan` / `task_card` blocks (or
   fails to fall back to the `section` + top-level `text`), **hold the
   flip**. This is a deploy gate, not a merge gate.
3. Flip dev to `SOMA_UI_5BLOCK_PHASE=2`. Smoke: short + long TodoWrite
   plans, rapid updates (debouncer coalescing), turn cancel mid-plan, tasks
   cleared mid-turn.
4. 1-week soak on dev → flip prod to `SOMA_UI_5BLOCK_PHASE=2`. Monitor:
   - duplicate plan messages per turn (expected: 0 — single-writer)
   - stranded `planTs` after turn end (expected: 0 — debouncer flush on end)
   - missing task-list on combined header (expected: 0 — header keeps chip
     even though the rows moved)
5. If any red flag, flip back to `1`. Caveat below.

### Rollback caveat

PHASE=2 → PHASE=1 downgrade leaves existing `planTs` messages **orphaned**
in Slack: the legacy embed resumes rendering the task list inside
`headerTs`, and the previously-posted plan messages are never updated
again. Slack preserves them in thread history, so functional impact is
**none** and UX-wise they remain visible (a minor duplication for one
deploy cycle). No data loss. Subsequent turns under PHASE=1 won't create
new plan messages.

## B2 single-writer whitelist

Only this call site may write a task-list-only Slack message under
PHASE>=2:

| Call site | API | Notes |
|---|---|---|
| `TurnSurface.renderTasks()` (first call per turn) | `chat.postMessage` with `{ text, blocks: [plan, section] }` | opens `planTs` on `TurnState` |
| `TurnSurface.renderTasks()` (subsequent calls) | `chat.update` against `planTs` | idempotent full-snapshot rerender |

No other component may post or update a message that carries **only** the
TodoWrite blocks under PHASE>=2. The legacy `todo-display-manager`
fallback (standalone todo message via `say`) only fires when
`onRenderRequest` throws — not as a parallel B2 writer.

## Debounce contract

Rapid TodoWrite emissions (the agent can fire 3–10 updates per second while
marking items in_progress / completed) would hit Slack rate limits if each
triggered a `chat.update`. `TurnRenderDebouncer` sits between
`renderTasks` and the SDK with a **500 ms trailing-edge debounce** plus an
**in-flight lock** per `turnId`:

- Each `renderTasks(turnId, todos)` call replaces the scheduled closure, so
  the **latest** snapshot wins. Matches TodoWrite's full-snapshot contract —
  intermediate states are disposable.
- If a render is currently in flight when a new call arrives, the new call
  is coalesced into the next trailing trigger, not dropped.
- `flush(turnId)` runs synchronously on `end(turnId)` / `fail(turnId)` so
  the final plan state lands on Slack before the turn cleans up.
- `cancel(turnId)` runs on `cleanupTurn` to drop any pending timer after
  state removal.

## Fallback contract

Slack's `plan` and `task_card` blocks (2026-02 rollout) are invisible on
older clients. `buildPlanTasks(todos)` therefore returns **three** views:

1. `blocks[0]` — `{ type: 'plan', task_cards: [...] }` (new rich render).
2. `blocks[1]` — `{ type: 'section', text: { type: 'mrkdwn', text: ... } }`
   (plain emoji-prefixed checklist: ✅ / ⏳ / ⬜ / 🚧).
3. Top-level `text` — plain-text fallback for notification previews and
   clients that render neither blocks nor mrkdwn (e.g. Slack CLI / API
   consumers).

Any client that cannot render `plan` falls through to (2); any client that
cannot render blocks at all falls through to (3). No one ever sees nothing.

## Dual-render under PHASE>=2

Both `TurnSurface.renderTasks` (via `onPlanRender` in `TodoDisplayManager`)
and `ThreadSurface.updatePanel` (via `onRenderRequest`) fire on every
TodoWrite, but they write to **different messages**:

- `onPlanRender` → `planTs` (full task-list rows, debounced).
- `onRenderRequest` → `headerTs` (combined header + progress chip;
  `thread-surface.ts` skips the task-list embed under PHASE>=2).

So the invariant "no message shows the same todos twice" holds because the
task-list rows live **only** on `planTs` under PHASE>=2.

## Invariants

1. **Single-writer per message** — `planTs` owned exclusively by
   `TurnSurface.renderTasks`; `headerTs` exclusively by `ThreadSurface`.
2. **Idempotent full-snapshot rerender** — `renderTasks` always receives
   the entire todos array; `chat.update` is safe to repeat.
3. **500 ms debounce + in-flight lock** — per `turnId`, coalesces bursty
   TodoWrite streams.
4. **Graceful degradation** — `plan` / `task_card` invisible → `section`
   fallback + top-level `text` still convey the plan state.
5. **Per-call PHASE read** — `config.ui.fiveBlockPhase` consulted on every
   call; no cached values; hot-flip supported.
6. **PHASE<2 code paths untouched** — every new branch is guarded by
   `config.ui.fiveBlockPhase >= 2`; PHASE=0 and PHASE=1 bytes are identical
   to pre-PR.
7. **Dual-render is safe** — `TurnSurface` writes `planTs`, `updatePanel`
   writes `headerTs`; they never overlap.

## Test / regression guards

- `src/slack/turn-surface.test.ts` — P2 section: first-call `postMessage` +
  `planTs` store, second-call `update`, supersede preserves `planTs` on
  old turn (Slack history), ad-hoc entry (renderTasks before begin) →
  works with ctx, missing ctx + no state → warn + return false, boolean
  return contract, PHASE<2 → early `false`.
- `src/slack/turn-render-debouncer.test.ts` — 5 rapid calls → 1 tail
  trigger, latest fn wins, in-flight lock coalesces, `flush` drains
  immediately, `cancel` prevents pending, per-key isolation, state
  cleanup, error recovery.
- `src/slack/task-list-block-builder.test.ts` — `buildPlanTasks`: 4-state
  icon mapping, block structure (`plan` + `section`), top-level `text`
  format, mrkdwn escaping, unique `task_id`, empty todos.
- `src/slack/todo-display-manager.test.ts` — PHASE=2 + turnId + turnCtx →
  BOTH callbacks fire; PHASE=2 without turnId → `onRenderRequest` only;
  PHASE=1 / PHASE=0 → legacy-only; `onPlanRender` throws → does NOT block
  `onRenderRequest`; empty todos under PHASE=2 → skip plan, still render
  header.
- `src/slack/thread-surface.test.ts` — PHASE=0/1 embeds task list;
  PHASE=2/3 skips task section (no `getTodos` call).

## Tool Verbose Absorb

**Problem before P2**: `ToolEventProcessor.sendToolResult` posted every
formatted tool result as a standalone `context.say({ text, thread_ts })`
message. A single turn with N tool uses produced N+1 Slack bubbles
(AI body + N tool bubbles), shredding the visual focus the P1 stream
was supposed to restore. The issue body of [#664][issue-664] calls this
out as the "verbose suppress → B1 흡수" gap.

**Contract at PHASE>=2**:

| State | Route |
|---|---|
| `logVerbosity` → `hidden` / `compact` render mode | short-circuit (legacy invariant, unchanged) |
| PHASE<2 | legacy `context.say` bubble (unchanged) |
| PHASE>=2, sink installed, `context.turnId` present, sink→`true` | absorbed into B1 via `appendText`, no legacy bubble |
| PHASE>=2, any precondition missing OR sink→`false` | graceful fallback to `context.say` |

**Sink architecture**:

- `ToolEventProcessor.setToolResultSink(cb)` — optional callback, installed
  by `slack-handler.ts` as `async (turnId, md) => (await this.threadPanel?.appendText(turnId, '\n\n' + md)) ?? false`.
- The processor stays decoupled from `ThreadPanel` / `TurnSurface`; it only
  knows the `ToolResultSink` type. Matches the existing
  `setCompactDurationCallback` callback-injection pattern.
- The `\n\n` separator lives in the **wiring closure**, not inside
  `TurnSurface`. TurnSurface stays a generic B1 write primitive that has
  no concept of "tool result".

**Graceful degrade, not silent drop**: `appendText` returns `false`
when the turn has no open stream, the stream is closing (`end()` / `fail()`
in flight), or `chat.appendStream` itself raises. The sink propagates that
`false`, and the processor logs at debug then calls `context.say` so the
tool output still reaches the user. Under no circumstance does a tool
result disappear.

**Fence preservation**: `ToolFormatter.formatToolResult` embeds its own
` ```diff ` fences for file edits and similar outputs. The wiring deliberately
does **not** wrap the formatted string in an outer triple-backtick fence —
doing so would nest and break Slack's markdown renderer. The sink writes
the formatted string as-is with a leading blank line for visual separation.

**Accepted tradeoff — first-chunk blank artifact**: When a tool result is
the first absorbed chunk in a turn (no prior assistant text), the `\n\n`
separator surfaces as two blank lines at the top of the B1 stream.
Cosmetic only; content is preserved, and PHASE=0/1 behavior is
completely untouched. A future refinement could condition the separator
on a `TurnSurface` chunk-count getter, but that widens public API
surface for a marginal UX gain. Not worth it at the MVP rollout.

**Rate-limit monitoring point**: `chat.appendStream` goes through raw
`client.chat.appendStream` (not the queued helper path). Tool output can
fire in bursts — 4+ rapid `Bash` or `Read` results during a planning turn
is normal. Stream chunks are lightweight relative to `postMessage`, but
this is still a monitoring surface: watch the `appendStream` Slack
rate-limit counter in the P2 soak window and flip back to PHASE=1 if it
trips. No in-code throttle was added — the existing stream backpressure
is expected to be sufficient.

[issue-664]: https://github.com/2lab-ai/soma-work/issues/664

## Out-of-scope (Phase 2)

- `src/slack/choice-message-builder.ts` — **P3**
- `src/slack/actions/choice-action-handler.ts` — **P3**
- `src/slack/assistant-status-manager.ts` — **P4**
- `src/slack/completion-message-tracker.ts` — **P5**
- `src/slack-handler.ts` `app.assistant(…)` registration — **P4**
- `TurnNotifier.send` / `AssistantStatusManager.clearStatus` relocation —
  **P5**
- Full removal of `ThreadSurface` combined header — deferred until P5 so
  we keep a working fallback throughout the migration.

## Visual smoke precondition

Before a production `SOMA_UI_5BLOCK_PHASE=2` flip, run `ui-test plan` and
confirm on all three clients:

- **iOS** (Slack 25.0+): `plan` block renders with task_cards, check boxes,
  progress bar.
- **Android** (Slack 25.0+): same.
- **desktop web**: same; also confirm the `section` fallback is visible
  below (it should not be — but a visible fallback is not a bug, just a
  render-order quirk on old clients).

If any of the three fails to render `plan`, the **`section` fallback**
must still show the 4-state emoji checklist. If even the section is
missing, **hold the flip** and investigate.

This is a **PHASE flip gate**, not a merge gate — code can land at
PHASE=0 regardless of client render results. The gate protects the
production rollout, not the PR.

## File map

| File | Change |
|---|---|
| `src/slack/turn-surface.ts` | `TurnState.planTs` + `adHoc` fields; real `renderTasks(turnId, todos, ctx?)` impl using `TurnRenderDebouncer`; `end` / `fail` flush debouncer synchronously |
| `src/slack/turn-render-debouncer.ts` | **New** — 500 ms tail-trigger + in-flight lock utility |
| `src/slack/turn-render-debouncer.test.ts` | **New** — debouncer unit tests |
| `src/slack/task-list-block-builder.ts` | Static `buildPlanTasks(todos)` helper — returns `{ text, blocks: [plan, section] }` |
| `src/slack/task-list-block-builder.test.ts` | `buildPlanTasks` tests (4-state mapping, block structure, fallback, mrkdwn escaping) |
| `src/slack/thread-panel.ts` | `renderTasks(turnId, todos, ctx?)` façade with PHASE<2 early return |
| `src/slack/thread-surface.ts` | PHASE>=2 guard skips the task-list embed in `buildCombinedBlocks` |
| `src/slack/thread-surface.test.ts` | **New** — narrow P2 guard coverage (PHASE 0/1/2/3) |
| `src/slack/todo-display-manager.ts` | `PlanRenderCallback` + `setPlanRenderCallback` + dual-call in `handleTodoUpdate` under PHASE>=2 |
| `src/slack/todo-display-manager.test.ts` | PHASE>=2 dual-call + fallback tests |
| `src/slack/pipeline/stream-executor.ts` | `onTodoUpdate` passes `turnId` + ctx to `handleTodoUpdate`; `onToolUse` / `onToolResult` propagate `turnId` into `ToolEventContext` (#664) |
| `src/slack-handler.ts` | Wires `setPlanRenderCallback` → `threadPanel.renderTasks`; installs `setToolResultSink` closure (#664) |
| `src/slack/tool-event-processor.ts` | **#664** — `ToolEventContext.turnId?`, `setToolResultSink`, PHASE>=2 sink path with graceful fallback |
| `src/slack/tool-event-processor.test.ts` | **#664** — Tool verbose absorb (PHASE 0/1 regression + PHASE 2 sink matrix) |
| `src/slack/pipeline/stream-executor.test.ts` | **#664** — turnId propagation via real execute() closure exercise |
| `docs/slack-ui-phase2.md` | This document |
