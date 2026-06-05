# 14 — Turn Surface Output (user-visible surface)

How soma-work turns a user's input into the Slack surface the user actually
sees. The history: responses were originally a flat **chat-interface** stream;
they were later restructured into **5 distinct block sections (B1–B5)** owned by
a single per-turn writer. This document is the single reference for that surface
and the baseline for modernizing it with Slack's agent/AI-app Block Kit blocks.

## Overview

```
user message
   │
   ▼
StreamProcessor / StreamExecutor  ──drives──▶  ThreadPanel (facade)
                                                   │ PHASE>=1
                                                   ▼
                                              TurnSurface  (single writer per turn)
                                                   │ emits
        ┌──────────────┬──────────────┬───────────┼───────────────┬────────────────┐
        ▼              ▼              ▼            ▼                ▼
       B1            B2             B3           B4               B5
   streaming      plan/tasks     ASK form    native status    completion card
   body           (task_card)   (choices)    spinner          (telemetry)
```

- `TurnSurface` — `packages/slack/src/turn-surface.ts`. Single-writer for one
  turn. `begin() → chat.startStream`, `appendText() → chat.appendStream`,
  `end()/fail() → chat.stopStream`. Owns `turnId` (`turn-surface.ts:54`).
- `ThreadPanel` — `packages/slack/src/thread-panel.ts`. Facade. At PHASE>=1
  delegates to `TurnSurface`; at PHASE=0 the legacy path streams via
  `context.say` (`thread-panel.ts:158`).
- `turnId` — generated in `stream-executor.ts:789`
  (`${sessionKey}:${requestStartedAt}:${randomUUID()}`), stable per turn,
  threaded through `TurnSurface` and the B5 path.

## The five block sections

### B1 — Streaming body
Live model output. `begin()` opens the stream (`turn-surface.ts:297`,
`chat.startStream`); each delta is `chat.appendStream({ chunks: [{ type:
'markdown_text', text }] })` (`:387`); `closeStream()` runs `chat.stopStream`
(`:943`). Once chunks-mode is entered, `stopStream` MUST also pass `chunks`
(`:17-20`). The raw `markdown_text` is rendered server-side by Slack's markdown
block — it does NOT support tables / syntax highlighting / horizontal rules /
task lists (see `docs/misc/reference/slack-block-kit.md` §1.1; the model is
steered toward Slack-renderable markdown by the "Slack Output Formatting" block
in `src/prompt/common.prompt`, issue #1043).

On stream failure `appendText()` returns `false` — the explicit "fall back to
legacy `context.say`" signal (`turn-surface.ts:355-366`).

### B2 — Plan / task list
The agent's TodoWrite state, rendered as a `plan` block containing `task_card`
children. Built by `TaskListBlockBuilder.buildPlanTasks`
(`task-list-block-builder.ts:117`, `task_card` at `:173`). First render
`chat.postMessage` stores `planTs` (`turn-surface.ts:494`); later renders
`chat.update` against `planTs` (`:527`). A 500ms trailing debouncer
(`TurnRenderDebouncer`, `:221`) coalesces rapid TodoWrite ticks. On turn-end
`finalizePlanIfNeeded()` demotes lingering `in_progress` cards to stop the
native spinner (`:989`).

### B3 — Choice / ASK form
Structured user-choice UI (`ASK_USER_QUESTION`). `askUser()`
(`turn-surface.ts:570`) and `askUserForm()` (`:603`) post pre-built payloads;
`resolveChoice()`/`resolveMultiChoice()` update them in place (`:635`, `:668`).
Spec: `docs/current/spec/12-ui-ask-user-question.md`.

### B4 — Native status spinner
The Slack assistant status line. `begin()` calls
`mgr.setStatus(channelId, threadTs, 'is thinking…')` (`turn-surface.ts:341`);
`end()/fail()` clear it (`:760`, `:909`). Backed by `AssistantStatusManager`
(`assistant-status-manager.ts`) with a `TOOL_STATUS_MAP` ("is reading files…",
"is running commands…"), a 20s heartbeat, epoch guards against stale clears, and
auto-disable on permanent scope errors. A second, older progress channel —
`ReactionManager` emoji reactions (`reaction-manager.ts`: hourglass / check /
crescent_moon) — runs in parallel.

### B5 — Completion card
The terminal "what just happened" card. Built by
`SlackBlockKitChannel.send()` (`src/notification-channels/slack-block-kit-channel.ts`)
from a `TurnCompletionEvent` (`turn-notifier.ts:39`). Categories:
`WorkflowComplete` / `UIUserAskQuestion` / `Exception` / `Stalled`
(`determineTurnCategory`, `turn-notifier.ts:72`). Three themes
(default / compact / minimal) render section + context blocks: header
(emoji+label), identity (persona | model | effort | clock), usage (Ctx% bar,
duration, 5h/7d), tool stats. Posted as a colored **attachment**:
`postMessage(channel, fallbackText, { threadTs, attachments: [{ color, blocks }] })`
(`slack-block-kit-channel.ts:62`). Turn-end guarantee §C-2: if the snapshot
misses a 3s race, `end()` returns `{ snapshotResolved: false }` and the caller
posts a `turnNotifier.notify()` fallback (`turn-surface.ts:850`).

## Slack agent/AI-app features: used vs. unused

| Feature | Status | Evidence |
|---|---|---|
| `chat.startStream/appendStream/stopStream` | ✅ used (B1) | `turn-surface.ts:297/387/943` |
| `assistant.threads.setStatus` | ✅ used (B4) | `slack-api-helper.ts:548` |
| `assistant.threads.setTitle` | ✅ used (rare) | `assistant-status-manager.ts:162` |
| `assistant.threads.setSuggestedPrompts` | ⚠️ placeholders only | `assistant-container.ts:54` |
| `context_actions` block | ❌ unused | reference doc only |
| `feedback_buttons` element | ❌ unused | reference doc only |
| `icon_button` element | ❌ unused | reference doc only |

The three ❌ rows are the modernization surface. Slack's AI-app best-practice
(`docs/misc/reference/slack-block-kit.md` §2.6) prescribes a `context_actions`
block carrying `feedback_buttons` (👍/👎) at the bottom of an agent response —
soma-work captures **no response feedback today**.

## Constraints that bound any change

- `context_actions`: max **5** elements (feedback_buttons / icon_button).
- `feedback_buttons`: must live inside `context_actions`; requires
  `positive_button` + `negative_button`; button `text` ≤75, `value` ≤2000,
  `action_id` ≤255.
- Interaction: ACK within 3s; `block_id` must be regenerated on `chat.update`;
  `button.disabled` is unsupported.
- Newer interactive blocks are not documented as supported inside legacy
  message **attachments** — feedback affordances must ride **top-level**
  message `blocks`, not `attachments[].blocks`.

## Modernization plan (tracked by the surface-feedback epic)

1. **Increment 1 (this work):** `feedback_buttons` on the B5 `WorkflowComplete`
   card via a `context_actions` block, posted as top-level blocks; an action
   handler (`turn_feedback_v1`) that ACKs, persists minimal feedback, and
   acknowledges in place.
2. Follow-ups: `icon_button` (retry / dismiss) on the action panel; workflow-aware
   `setSuggestedPrompts` content; auto `setTitle` from the turn summary;
   consolidating the dual status channels (emoji reactions vs. native spinner).
