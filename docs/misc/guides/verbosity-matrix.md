# Verbosity Matrix

Complete mapping of 20 output flags across 4 verbosity levels.

## Verbosity Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| **minimal** | Final result + essential interactions only | Automated pipelines, quiet mode |
| **compact** | Thinking + tool names + status/meta (no detail) | Daily use, reduced noise |
| **detail** | Full output (default behaviour) | Standard development |
| **verbose** | Everything including raw data | Debugging, troubleshooting |

## Flag Matrix

| # | Flag | Bit | minimal | compact | detail | verbose | Description |
|---|------|-----|:-------:|:-------:|:------:|:-------:|-------------|
| 0 | `FINAL_RESULT` | `1<<0` | **on** | on | on | on | Final assistant text response |
| 1 | `THINKING` | `1<<1` | - | **on** | on | on | LLM extended thinking / reasoning output |
| 2 | `TOOL_CALL` | `1<<2` | - | **on** | on | on | Tool call notification — name only (e.g. "Edit file.ts") |
| 3 | `TOOL_DETAIL` | `1<<3` | - | - | **on** | on | Tool call detail — args, diff, command, MCP inputs |
| 4 | `TOOL_RESULT` | `1<<4` | - | - | **on** | on | Tool execution result |
| 5 | `MCP_PROGRESS` | `1<<5` | - | - | **on** | on | MCP / subagent progress status messages |
| 6 | `STATUS_MESSAGE` | `1<<6` | - | **on** | on | on | Status text messages (Thinking / Working / Completed) |
| 7 | `STATUS_REACTION` | `1<<7` | - | **on** | on | on | Emoji reactions (thinking_face, gear, check_mark) |
| 8 | `STATUS_SPINNER` | `1<<8` | - | **on** | on | on | Native Slack assistant spinner |
| 9 | `USER_CHOICE` | `1<<9` | **on** | on | on | on | User choice / form prompts (**ALWAYS** shown) |
| 10 | `PERMISSION` | `1<<10` | **on** | on | on | on | Permission approval prompts (**ALWAYS** shown) |
| 11 | `ACTION_PANEL` | `1<<11` | - | **on** | on | on | Action panel updates |
| 12 | `THREAD_HEADER` | `1<<12` | - | **on** | on | on | Thread header (title, workflow badge, dispatch status) |
| 13 | `SESSION_FOOTER` | `1<<13` | - | **on** | on | on | Session footer (timing, context, usage) |
| 14 | `CONTEXT_EMOJI` | `1<<14` | - | **on** | on | on | Context window emoji (80p, 60p, ...) |
| 15 | `TODO_UPDATE` | `1<<15` | - | - | **on** | on | Todo list create / update |
| 16 | `TODO_REACTION` | `1<<16` | - | - | **on** | on | Todo progress reactions |
| 17 | `ERROR` | `1<<17` | **on** | on | on | on | Error messages and error status (**ALWAYS** shown) |
| 18 | `SYSTEM` | `1<<18` | - | - | **on** | on | System / command responses, onboarding, conversation URL |
| 19 | `RAW_DATA` | `1<<19` | - | - | - | **on** | Raw model response data (debug) |

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

## Render Modes

Some categories use a multi-level render mode instead of simple on/off:

| Category | hidden | compact | detail | verbose |
|----------|--------|---------|--------|---------|
| Tool Call | no output | name only | name + args/diff | name + args + raw |
| Tool Result | no output | in-place update | separate message | separate + raw |
| Thinking | no output | full text | full text | full text |
