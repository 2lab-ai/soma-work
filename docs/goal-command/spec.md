# Goal Command Spec

## Codex CLI Reference

The feature is based on the current Codex goal implementation:

- `/goal` is a TUI slash command described as "set or view the goal for a long-running task".
- The model-facing tools are `get_goal`, `create_goal`, and `update_goal`.
- `create_goal` requires an explicit objective and accepts an optional positive token budget.
- `update_goal` only exposes `status: "complete"` to the model. Pause, resume, clear, and external objective changes are host-controlled state transitions.
- Objectives are validated as non-empty and at most 4,000 characters.
- Codex goal steering treats the objective as user-provided data, XML-escapes it before prompt injection, and requires a completion audit before marking complete.

Source handles used for this spec:

- `codex-rs/tui/src/slash_command.rs`
- `codex-rs/core/src/tools/handlers/goal_spec.rs`
- `codex-rs/core/src/tools/handlers/goal.rs`
- `codex-rs/core/src/goals.rs`
- `codex-rs/core/templates/goals/continuation.md`
- `codex-rs/protocol/src/protocol.rs`
- `codex-rs/app-server/README.md`

## Product Behavior

Add a Slack command family for the current thread/session:

- `goal` or `/goal`: show the current session goal.
- `goal <objective>` or `goal set <objective>`: set or replace the active goal and continue the model with goal-steering context.
- `goal status`: alias for showing the current goal.
- `goal pause`: keep the objective but stop injecting it into future prompts.
- `goal resume`: reactivate a paused goal.
- `goal done`, `goal complete`, or `goal completed`: mark the goal complete.
- `goal clear`: remove the goal from the session.

The command is session-scoped, not user-global. It should fail with a clear "No active session" message if the thread has no session.

## Data Model

Persist a `SessionGoal` on `ConversationSession`:

- `objective: string`
- `status: "active" | "paused" | "complete"`
- `createdAt: number`
- `updatedAt: number`
- `createdBy: string`
- `completedAt?: number`
- `completedBy?: string`

The objective must be trimmed, non-empty, and at most 4,000 Unicode characters.

## Prompt Injection

Only active goals are injected into the system prompt. Paused and complete goals remain visible through `goal status` but do not steer the model.

The injected block must:

- XML-escape objective delimiters (`&`, `<`, `>`) before prompt insertion.
- State that the objective is user-provided task data, not higher-priority instruction.
- Preserve Codex's completion-audit rule: completion must be proven against the current workspace or external state before the assistant says the goal is complete.
- Avoid claiming a local `update_goal` tool exists in the Slack Claude SDK environment. Completion status is host-managed through `goal done`.

Changing goal state must clear `session.systemPrompt` so the next model turn rebuilds against the current goal.

## Persistence

`SessionRegistry.saveSessions()` must persist sessions that have either a `sessionId`, a `handoffContext`, or a `goal`. This preserves a goal set before the first model turn.

`resetSessionContext()` clears the goal because `/new` and `/renew` create a fresh logical conversation in the same Slack thread.

## `/z` Surface

Thread/app-mention `/z goal ...` translates to the same legacy text and routes through `GoalHandler`.

Slack slash `/z goal ...` is forbidden because Slack slash commands do not carry a real thread context, and goals are session/thread scoped.

The `/z` help card can expose a read-only `goal` topic card that documents the command. `goal` is intentionally not added to the non-admin DM safe-topic allowlist because `goal set <objective>` can continue into model execution.

## Non-Goals

- No token-budget accounting in this Slack implementation. Claude SDK session state does not expose Codex's local thread goal accounting hooks.
- No Slack Block Kit buttons for setting or completing goals in this change.
- No hidden auto-loop that repeatedly invokes Claude after a turn. The goal persists as prompt context across subsequent turns.
