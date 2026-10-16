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

Verbosity decides what reaches the Slack thread, never what is recorded. Every turn's
user instruction, narration segments, tool calls/results, final answer, compaction notices
(including the "next turn will auto /compact" announcement), turn errors and aborts are
emitted at every level through `StreamContext.workLog` →
`streamExecutorProviders.appendWorkLog(conversationId, entry)` (types:
`packages/slack/src/work-log.ts`), for the dashboard's per-session work log.

Errors and aborts follow the same split as the user-facing error card:

- `error` — a turn error with no retry scheduled, and an abort that gets the 🔴 card
  (stall-timeout, ghost-session, unknown reason).
- `notice` — a quiet abort the user already knows about (supersede, user-stop, session-close,
  shutdown, user-interrupted), and a recoverable error with a retry scheduled
  (`retrying in Ns: …`).

Entry contract for the final answer (the log is append-only):

- The final answer is always recorded exactly once, as `final` (directive markup stripped).
- A narration segment is recorded as `narration` once the turn moves on past it (a tool,
  thinking, more text, a status frame). If the turn's answer IS that segment, it is recorded
  only as `final`.
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
  `src/session/compact-threshold-checker.ts`).
  A "starting" message that was already posted is always replaced — by the completion, or at
  turn end by a neutral "ended" line when no END signal arrived. END waits at most 10 s for
  an in-flight "starting" post; a later-landing one replaces itself.

## Transport-error leaks (all levels)

A transport error surfaced as assistant text (prompt-too-long, a failed compaction, the
empty-text-block 400) is never posted. When the turn ENDS on such a segment, the processor
returns it as `StreamResult.transportLeak`, and stream-executor runs its content guards on that
text (falling back to the whole `collectedText`). The guards convert it into a thrown error so
`handleError` takes the matching recovery (fallback `/compact`, transcript repair, terminal
compact failure) — also when narration preceded the leak, which the joined `collectedText`
used to hide. No withheld narration is posted as the answer of such a turn.

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
