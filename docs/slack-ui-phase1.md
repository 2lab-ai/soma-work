# Slack UI Phase 1 — B1 stream consolidation + `TurnSurface` façade

Scope: issue [#525](https://github.com/2lab-ai/soma-work/issues/525) Phase 1.
Phase 0 (#538/#543/#548) proved `chat.startStream` / `appendStream` /
`stopStream` and the `plan` / `task_card` blocks work through the bolt 4.7.0 +
`@slack/web-api` 7.15.1 runtime. Phase 1 takes the first step of the actual
migration: consolidate the **B1 stream block** (narrative / tool output) into
a single per-turn writer owned by `TurnSurface`, behind a cumulative rollout
flag.

## What Phase 1 changes

The 5-block per-turn UI (from plan v2, §3):

| Block | Owner after P1 | Status in this PR |
|---|---|---|
| **B1** stream (markdown / tool output) | `TurnSurface` via `chat.startStream` / `appendStream` / `stopStream` | **migrated** |
| **B2** plan / task_card | `ThreadSurface` (legacy) | unchanged — P2 |
| **B3** UIAskUserQuestion slot | `ThreadSurface` (legacy) | unchanged — P3 |
| **B4** AI working indicator | `AssistantStatusManager` (legacy) | unchanged — P4 |
| **B5** `<작업 완료>` marker | `TurnNotifier` + `CompletionMessageTracker` (legacy) | unchanged — P5 |

Single-writer invariant enforced in this PR:

> When `SOMA_UI_5BLOCK_PHASE >= 1`, **only `TurnSurface` writes B1**. No other
> component may call `chat.postMessage` / `chat.update` with B1 content for an
> active turn. `stream-processor.ts` and `stream-executor.ts` route to
> `ThreadPanel.appendText(turnId, …)` instead of the legacy `context.say`
> path.

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

1. Merge this PR with `SOMA_UI_5BLOCK_PHASE=0` in `.env.example`. Prod stays
   PHASE=0 → zero behavior change.
2. Flip dev / staging to `SOMA_UI_5BLOCK_PHASE=1`. Smoke: short + long agent
   turns, cancel mid-turn, concurrent turn supersede.
3. Flip prod to `SOMA_UI_5BLOCK_PHASE=1`. Monitor:
   - `streaming_mode_mismatch` errors from `chat.stopStream` (expected: 0)
   - duplicate B1 messages per turn (expected: 0 — single-writer)
   - turns stuck with an unclosed stream (expected: 0 — finally-guarded `end`)
4. If any red flag, flip back to `0`. Legacy path resumes without a deploy.

## B1 single-writer whitelist

Only these call sites may write to B1 under PHASE>=1:

| Call site | API | Notes |
|---|---|---|
| `TurnSurface.begin()` | `chat.startStream` | opens M1 (`streamTs`) |
| `TurnSurface.appendText()` | `chat.appendStream` with `chunks: [{ type: 'markdown_text', text }]` | append-only |
| `TurnSurface.end()` / `.fail()` | `chat.stopStream` with `chunks: []` | chunks-mode symmetry |

Any other component that calls `chat.postMessage` / `chat.update` during an
active turn **must not** carry B1 payload. B2/B3/B4/B5 writers continue to
own their own messages.

## Chunks-mode invariant

See [`docs/slack-ui-phase0.md` § Streaming mode invariant](./slack-ui-phase0.md#streaming-mode-invariant).

`appendStream({ chunks: [...] })` locks the stream into chunks mode. The
matching `stopStream` **must** pass `chunks: []` (empty array), not a
top-level `markdown_text`. Otherwise the server raises
`streaming_mode_mismatch`. `TurnSurface.end` / `TurnSurface.fail` both obey
this in the close path; a lint rule should keep it that way (see Test /
regression guards below).

## Concurrent turn supersede

`TurnSurface` maintains two maps:

- `turns: Map<turnId, TurnState>` — per-turn state (streamTs, closing flag, …)
- `activeTurn: Map<sessionKey, turnId>` — most recent turn per session

`begin(ctx)` checks for an existing `activeTurn[sessionKey]`. If one exists
and it is not the incoming `turnId`, the old turn is first **failed** with
`Error('superseded')` before the new turn opens. This keeps the single-writer
invariant intact across rapid follow-up user messages in the same thread.

`end()` and `fail()` are idempotent and clear their state from both maps in
`finally`. A second call becomes a no-op.

## Test / regression guards

- `src/slack/turn-surface.test.ts` — begin/appendText/end order invariant,
  PHASE=0 fail-closed (no Slack API calls), concurrent supersede
  (`begin(B)` while A is in-flight → `fail(A)` then `begin(B)`),
  `fail()` idempotency, `renderTasks` / `askUser` placeholders in P1.
- `src/slack/stream-processor.test.ts` — PHASE=0 regression (legacy
  `context.say`) and PHASE=1 path (routes to `appendText`).
- Lint / CI grep: forbid `chat.stopStream(... markdown_text: ...)` to keep
  chunks-mode symmetry. Prefer `stopStream({ chunks: [] })`.

## Out-of-scope (Phase 1)

- `src/slack/tool-event-processor.ts` — **P2**
- `src/slack/todo-display-manager.ts` — **P2**
- `src/slack/task-list-block-builder.ts` (`buildPlanTasks`) — **P2**
- `src/slack/choice-message-builder.ts` — **P3**
- `src/slack/actions/choice-action-handler.ts` — **P3**
- `src/slack/assistant-status-manager.ts` — **P4**
- `src/slack/completion-message-tracker.ts` — **P5**
- `src/slack-handler.ts` `app.assistant(…)` registration — **P4**
- `TurnNotifier.send` / `AssistantStatusManager.clearStatus` relocation —
  **P5** (`TurnSurface.end()` will absorb these then; for now they stay in
  `stream-executor.ts`)
- RPG skill / emoji flavor text in streaming — dropped in P1 for B1
  simplification. Restore via separate issue if needed.

## File map

| File | Change |
|---|---|
| `src/config.ts` | Add `parseFiveBlockPhase()` + `config.ui.fiveBlockPhase` (default 0) |
| `src/slack/turn-surface.ts` | **New** — `TurnSurface` class with `begin` / `appendText` / `end` / `fail` (+ P2/P3 placeholders: `renderTasks`, `askUser`) |
| `src/slack/turn-surface.test.ts` | **New** — unit tests (PHASE 0/1 paths, supersede, idempotency) |
| `src/slack/thread-panel.ts` | Add `beginTurn` / `appendText` / `endTurn` / `failTurn` / `isTurnSurfaceActive` façade methods; mark `ThreadSurface` as `@internal` |
| `src/slack/stream-processor.ts` | PHASE>=1 guard: route narrative chunks to `threadPanel.appendText(turnId, …)`; skip `handleToolUseMessage` self `context.say`; skip `rebuildCompactMessage` |
| `src/slack/pipeline/stream-executor.ts` | Compute `turnId = ${sessionKey}:${turnStartTs}`; call `threadPanel.beginTurn` before turn; `endTurn('completed')` in `finally`; `failTurn(err)` / `endTurn('aborted')` in `catch` |
| `.env.example` | Add `SOMA_UI_5BLOCK_PHASE=0` |
| `docs/slack-ui-phase1.md` | This document |
