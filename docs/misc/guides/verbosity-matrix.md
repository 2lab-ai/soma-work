# Verbosity Matrix

Complete mapping of the output flags in `packages/slack/src/output-flags.ts` across 4 verbosity levels.

## Verbosity Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| **minimal** | Task list + final answer + essential interactions only (default; narration and progress go to the dashboard work log) | Daily use, quiet threads |
| **compact** | Narration + progress + thinking + tool names + status/meta (no detail) | Watching a turn live |
| **detail** | Full output | Standard development |
| **verbose** | Everything including raw data | Debugging, troubleshooting |

## Flag Matrix

| # | Flag | Bit | minimal | compact | detail | verbose | Description |
|---|------|-----|:-------:|:-------:|:------:|:-------:|-------------|
| 0 | `FINAL_RESULT` | `1<<0` | **on** | on | on | on | Final assistant text response |
| 1 | `THINKING` | `1<<1` | - | **on** | on | on | LLM extended thinking / reasoning output |
| 2 | `TOOL_CALL` | `1<<2` | - | **on** | on | on | Tool call notification — name only (e.g. "Edit file.ts") |
| 3 | `TOOL_DETAIL` | `1<<3` | - | - | **on** | on | Tool call detail — args, diff, command, MCP inputs |
| 4 | `TOOL_RESULT` | `1<<4` | - | - | **on** | on | Tool execution result |
| 5 | `MCP_PROGRESS` | `1<<5` | - | **on** | on | on | MCP / subagent / background-Bash progress status messages |
| 6 | `STATUS_MESSAGE` | `1<<6` | - | **on** | on | on | Status text messages (Thinking / Working / Completed) |
| 7 | `STATUS_REACTION` | `1<<7` | - | **on** | on | on | Emoji reactions (thinking_face, gear, check_mark) |
| 8 | `STATUS_SPINNER` | `1<<8` | - | **on** | on | on | Native Slack assistant spinner |
| 9 | `USER_CHOICE` | `1<<9` | **on** | on | on | on | User choice / form prompts (**ALWAYS** shown) |
| 10 | `PERMISSION` | `1<<10` | **on** | on | on | on | Permission approval prompts (**ALWAYS** shown) |
| 11 | `ACTION_PANEL` | `1<<11` | - | **on** | on | on | Action panel updates |
| 12 | `THREAD_HEADER` | `1<<12` | - | **on** | on | on | Thread header (title, workflow badge, dispatch status) |
| 13 | `SESSION_FOOTER` | `1<<13` | - | **on** | on | on | Session footer (timing, context, usage) |
| 14 | `CONTEXT_EMOJI` | `1<<14` | - | **on** | on | on | Context window emoji (80p, 60p, ...) |
| 15 | `TODO_UPDATE` | `1<<15` | **on** | on | on | on | Todo list create / update |
| 16 | `TODO_REACTION` | `1<<16` | **on** | on | on | on | Todo progress reactions |
| 17 | `ERROR` | `1<<17` | **on** | on | on | on | Error messages and error status (**ALWAYS** shown) |
| 18 | `SYSTEM` | `1<<18` | - | - | **on** | on | System / command responses, onboarding, conversation URL |
| 19 | `RAW_DATA` | `1<<19` | - | - | - | **on** | Raw model response data (debug) |
| 20 | `SKILL_INVOCATION` | `1<<20` | - | **on** | on | on | Skill invocation announcement |
| 21 | `NARRATION` | `1<<21` | - | **on** | on | on | Mid-turn model narration (assistant text while the turn runs) |

**Bold "on"** = the level where the flag first appears.

## Always-On Flags

These three flags are active regardless of verbosity level:

- `USER_CHOICE` — User-facing selection prompts must always be visible
- `PERMISSION` — Permission approval prompts are critical for security
- `ERROR` — Error messages must never be suppressed

**Structural UI flags** (defined in level presets but never gated in code — always output):

- `ACTION_PANEL` — Action panel is the user's control surface (abort, choices)
- `THREAD_HEADER` — Thread root message is the structural entry point of bot-initiated threads

## Gating Implementation

Each flag is checked at the point of output using `shouldOutput(flag, verbosityMask)`.

| Flag | Gated In | Notes |
|------|----------|-------|
| `FINAL_RESULT` | `stream-processor.ts` | Always shown at minimal+ |
| `NARRATION` | `stream-processor.ts` | `handleTextMessage` + interrupt rescue; when off, the segment equal to the SDK `finalText` is posted once at the result event |
| `SKILL_INVOCATION` | `stream-processor.ts` | RPG skill banner (PHASE=0) |
| `THINKING` | `stream-processor.ts` | `getThinkingRenderMode()` |
| `TOOL_CALL` | `stream-processor.ts` | `getToolCallRenderMode()` |
| `TOOL_DETAIL` | `stream-processor.ts` | `getToolCallRenderMode()` |
| `TOOL_RESULT` | `tool-event-processor.ts` | `getToolResultRenderMode()` |
| `MCP_PROGRESS` | `tool-event-processor.ts` | Guards `mcpStatusDisplay.start*()` |
| `STATUS_MESSAGE` | `stream-executor.ts` | Status create/update calls |
| `STATUS_REACTION` | `stream-executor.ts` | Reaction add/update calls |
| `STATUS_SPINNER` | `stream-executor.ts` | Native Slack spinner |
| `USER_CHOICE` | _(always on)_ | Never suppressed |
| `PERMISSION` | _(always on)_ | Never suppressed |
| `ACTION_PANEL` | _(ungated — structural UI)_ | Always rendered; user control surface |
| `THREAD_HEADER` | _(ungated — structural UI)_ | Always rendered; thread entry point |
| `SESSION_FOOTER` | `stream-executor.ts` | `buildFinalResponseFooter` callback |
| `CONTEXT_EMOJI` | `stream-executor.ts` | `onUsageUpdate` callback |
| `TODO_UPDATE` | `stream-executor.ts` | `onTodoUpdate` callback |
| `TODO_REACTION` | `todo-display-manager.ts` | Reaction in `handleTodoUpdate()` |
| `ERROR` | _(always on)_ | Never suppressed |
| `SYSTEM` | `session-initializer.ts` | Conversation URL, migration notice |
| `RAW_DATA` | `output-flags.ts` | `verboseTag()` prefix |

## Work log (all levels)

Verbosity decides what reaches the Slack thread, never what is recorded. Everything is
recorded at every level through `streamExecutorProviders.appendWorkLog(conversationId, entry)`
(types: `packages/slack/src/work-log.ts`), for the dashboard's per-session work log, along two
paths:

- Turn entries, stamped with the turn's `turnId`: the user instruction, narration segments,
  tool calls/results, the final answer, turn errors and aborts (`StreamContext.workLog`), and
  the threshold checker's "next turn will auto /compact" announcement (recorded at turn end
  through the same turn sink).
- Conversation entries, with no `turnId`: the compaction start/complete notices, recorded by
  `compact-hooks.ts` through `recordConversationWorkLog` (below).

A store that throws never breaks what records into it: the entry is dropped and reported at
warn, throttled process-wide — the first drop at once, then at most one summary per
`WORK_LOG_DROP_WARN_INTERVAL_MS` (60 s) with the count and the latest drop. Every write is
still attempted.

Errors and aborts follow the same split as the user-facing error card:

- `error` — a turn error with no retry scheduled, and an abort that gets the 🔴 card
  (stall-timeout, ghost-session, unknown reason).
- `notice` — a quiet abort the user already knows about (supersede, user-stop, session-close,
  shutdown, user-interrupted), and a recoverable error with a retry scheduled
  (`retrying in Ns: …`).

Entry contract for the final answer (the log is append-only):

- The final answer is always recorded exactly once, as `final` (directive markup stripped).
- A suppressed transport-error leak (below) is recorded once, as `error` — never as
  `narration` or `final`, whatever the turn's ending (`finalText` = the leak, empty, absent,
  or no `result`). When the executor then recovers the turn it adds its own `notice`
  (retry scheduled) or `error` entry.
- A narration segment is recorded as `narration` once the turn moves on past it: a tool call
  or result, thinking, or more text. Bookkeeping frames (`usage`, `status`,
  `compact_boundary`) do not move the turn on, so they can sit between the answer and `result`.
  If the turn's answer IS that segment, it is recorded only as `final`.
- Compaction start/complete notices belong to the conversation, not to a turn:
  `compact-hooks.ts` records them against `session.conversationId` through
  `recordConversationWorkLog` (no `turnId`; nothing without a conversation). Once per cycle —
  one start and one completion — whichever path signals it (the SDK PreCompact/PostCompact
  hooks or the stream's `compacting` status / `compact_boundary`), at every level, including a
  completion that arrives after the turn that ran the compaction has ended. The threshold
  announcement is a turn entry and carries the turn's `turnId`.
- When the fallback (below) posts a segment that was already recorded as `narration`, that
  text appears once as `narration` and once as `final` — never two of either.

## Final answer at `minimal`

- Narration is withheld; the segment equal to the SDK `finalText` (by raw or
  directive-stripped text) is posted once, through the final-answer path, without dispatching
  its directives again.
- A turn whose final answer shows nothing (no `finalText`, an empty one, a directive-only or
  blank segment, or no `result` at all) posts its last withheld narration instead — except
  when the host posted a question form this turn (the form is what the user answers; nothing
  is posted under it), or when the turn ended on a transport-error leak (below).
- Compaction start/complete notices and the threshold checker's "next turn will auto
  /compact" announcement are not posted (`src/slack/hooks/compact-hooks.ts`,
  `src/session/compact-threshold-checker.ts`); they are recorded as work-log `notice` entries
  at every level. The level is read when each notice would be posted, and only new posts are
  gated: the cycle bookkeeping (epoch markers, usage snapshot, deferred re-dispatch of a
  message typed during compaction) runs at every level, and a "starting" message already on
  the thread (posted at `compact` or above) is still replaced in place by the completion (or,
  if that update fails, posted fresh — the existing fallback). At `compact` and above the
  compaction notices behave exactly as before this change.
- Every consumer reads a stored mask through `resolveVerbosityMask`: a missing or non-numeric
  mask is `detail`.

## Transport-error leaks (all levels)

A transport error surfaced as assistant text (prompt-too-long, a failed compaction, the
empty-text-block 400) is never posted, at any level — whether it streamed as a segment or
arrived only as the SDK `finalText`. The checks are short-text heuristics (an error string, not
prose: prompt-too-long ≤ 160 chars), so an answer that discusses such an error at length is
posted normally.

When the turn ENDS on a leak, the processor returns the leak text as
`StreamResult.transportLeak`, and stream-executor runs its content guards on that text (falling
back to the whole `collectedText`). The guards convert the leak into a thrown error so
`handleError` takes the matching recovery (fallback `/compact`, transcript repair, terminal
compact failure) — also when narration preceded the leak, which the joined `collectedText`
used to hide. No withheld narration is posted as the answer of such a turn.

If the final answer or a question form reached Slack this turn, the turn did not end on a
leak and no recovery runs. The answer becomes the turn's terminal segment whether it is a real
answer after the leak (streamed, or a new `finalText`) or an earlier segment that `finalText`
names (e.g. text A is withheld, a later leak L is suppressed, then `finalText` = A: A is posted
once and L stays an `error` entry). Then there is no `transportLeak`, and the executor's
guards read `StreamResult.guardText` — the leak the turn ended on, else the turn text without
suppressed segments — so a recovered leak cannot reach them through `collectedText`. When the
host posted a question form this turn, A is not posted under it — the form is what the user
answers — and the turn still does not recover (recovering would duplicate the form). If
posting A throws, the turn fails on that error (`handleError`); no leak recovery runs this
turn. The work log then already holds A's `final` entry, followed by the executor's own entry
for that error (`error`, or `notice` when a retry is scheduled — the split above). A
`finalText` that differs from a suppressed leak only by whitespace is the same leak.

## Migration and stored masks

A one-time boot migration (`src/deploy/migrate-all-users-minimal-once.ts`, marker
`.all-users-log-minimal-once-2026-10-16.json`) moved every user default and every persisted
session mask to `minimal` on 2026-10-16; later choices are never overwritten. Stored session
masks carry `logVerbosityVersion` (`LOG_VERBOSITY_MASK_VERSION` = 2); a mask stored without it
predates `NARRATION` and is mapped to the current preset on load (`upgradeLegacyVerbosityMask`).

## Render Modes

Some categories use a multi-level render mode instead of simple on/off:

| Category | hidden | compact | detail | verbose |
|----------|--------|---------|--------|---------|
| Tool Call | no output | name only | name + args/diff | name + args + raw |
| Tool Result | no output | in-place update | separate message | separate + raw |
| Thinking | no output | full text | full text | full text |
