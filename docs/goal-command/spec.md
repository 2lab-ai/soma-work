# Goal Command Spec

## Codex CLI Reference

The feature is based on the current Codex goal implementation. Pinned permalinks (commit `46946bb91c25b45dec125e29a933b019c61856ff`):

- `/goal` is a TUI slash command described as "set or view the goal for a long-running task".
- The model-facing tools are `get_goal`, `create_goal`, and `update_goal`.
- `create_goal` requires an explicit objective and accepts an optional positive token budget.
- `update_goal` only exposes `status: "complete"` (and `"blocked"` after the three-turn audit). Pause, resume, clear, and external objective changes are host-controlled state transitions. See [`codex-rs/core/src/tools/handlers/goal/update_goal.rs#L54-L62`](https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/src/tools/handlers/goal/update_goal.rs#L54-L62).
- Objectives are validated as non-empty and at most 4,000 characters.
- Codex goal steering treats the objective as user-provided data, XML-escapes it before prompt injection, and requires a completion audit before marking complete.
- Codex runs an **auto-continuation loop**: after every turn ends idle, the runtime calls [`maybe_continue_goal_if_idle_runtime`](https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/src/goals.rs#L1270), which forwards to [`maybe_start_goal_continuation_turn`](https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/src/goals.rs#L1275). The candidate is filtered by [`goal_continuation_candidate_if_active`](https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/src/goals.rs#L1360) (six guards) and held against a single-permit semaphore. Reservations are cleared on user input via [`clear_reserved_goal_continuation_turn`](https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/src/goals.rs#L901).
- Continuation behavior, fidelity, completion-audit, and blocked-audit rules live verbatim in [`codex-rs/core/templates/goals/continuation.md`](https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/templates/goals/continuation.md).

Source handles used for this spec:

- `codex-rs/tui/src/slash_command.rs`
- `codex-rs/core/src/tools/handlers/goal_spec.rs`
- `codex-rs/core/src/tools/handlers/goal.rs`
- `codex-rs/core/src/goals.rs`
- `codex-rs/core/templates/goals/continuation.md`
- `codex-rs/core/templates/goals/budget_limit.md`
- `codex-rs/core/templates/goals/objective_updated.md`
- `codex-rs/protocol/src/protocol.rs`
- `codex-rs/app-server/README.md`

## Product Behavior

Add a Slack command family for the current thread/session:

- `goal` or `/goal`: show the current session goal.
- `goal <objective>` or `goal set <objective>`: set or replace the active goal and continue the model with goal-steering context.
- `goal status`: alias for showing the current goal.
- `goal pause`: keep the objective but stop injecting it into future prompts.
- `goal resume`: reactivate a paused goal.
- `goal done`, `goal complete`, or `goal completed`: mark the goal complete **(user-driven; bypasses host eval)**.
- `goal clear`: remove the goal from the session.

The command is session-scoped, not user-global. It should fail with a clear "No active session" message if the thread has no session.

## Data Model

Persist a `SessionGoal` on `ConversationSession`:

- `objective: string`
- `status: "active" | "paused" | "complete" | "blocked"`
- `createdAt: number`
- `updatedAt: number`
- `createdBy: string`
- `completedAt?: number`
- `completedBy?: string` (slack userId for user-driven, `'eval-model'` for eval-driven)
- `completedVia?: 'user' | 'eval-model'` — audit trail of which path closed the goal
- Ralph-loop control:
  - `continuationCount: number` — auto-continuation turns fired since the last real user message
  - `maxContinuations: number` — cap (default 10)
  - `lastContinuationAt?: number`
  - `consecutiveBlockedSignals?: number` — codex three-turn rule counter
- Eval tracking:
  - `pendingEval?: { requestedAt: number; turnId: string }` — set while an eval is in flight; the ralph loop is paused
  - `lastEvalReason?: string` — verbatim verdict from the last `completed=false` eval; injected into the next continuation
  - `evalAttemptCount?: number`

The objective must be trimmed, non-empty, and at most 4,000 Unicode characters.

Legacy goals serialized before this followup (lacking the ralph-loop fields) are migrated on load by `SessionRegistry.migrateLegacyGoal`, which back-fills `continuationCount=0`, `maxContinuations=10`, and zeroed counters.

## Prompt Injection

Only active goals are injected into the system prompt. Paused, complete, and blocked goals remain visible through `goal status` but do not steer the model.

The injected block must:

- XML-escape objective delimiters (`&`, `<`, `>`) before prompt insertion.
- State that the objective is user-provided task data, not higher-priority instruction.
- Preserve Codex's completion-audit rule: completion must be proven against the current workspace or external state before the assistant says the goal is complete.
- Avoid claiming a local `update_goal` tool exists. Completion is signaled via the sentinel `<goal-complete-request reason="..."/>` and adjudicated by the host eval model.

Changing goal state (set/pause/resume/complete/clear, plus every ralph-loop continuation and every eval verdict) must clear `session.systemPrompt` so the next model turn rebuilds against the current goal. This applies because `applySessionGoal` only injects when `goal.status === 'active'`, and the cached prompt would otherwise embed a stale steering block.

## Auto-Continuation Loop (Ralph Loop)

After every turn ends with the session transitioning to `idle`, the host evaluates whether to fire a synthetic continuation turn. This is a direct port of codex's `maybe_continue_goal_if_idle_runtime` / `goal_continuation_candidate_if_active` flow.

**Trigger:** the `SessionRegistry` idle-transition path drains cron `onIdle` callbacks first, then fires `onIdleAfterDrainHook(sessionKey)`. The hook calls `maybeScheduleGoalContinuation` (in `src/slack/goal-continuation.ts`).

**Guards (all must pass):**

1. Session resolvable.
2. `session.goal.status === 'active'` (paused / complete / blocked all suppress).
3. `session.goal.pendingEval` is unset — while an eval is in flight, the ralph loop is paused.
4. Activity state re-checked as `'idle'` (a racing user turn that flipped `working` between drain and fire is honored).
5. Module-level `Set<sessionKey>` lock free — mirrors codex `continuation_lock: Semaphore::new(1)`. The lock is released in a `finally` so an injector failure does not permanently mask future continuations.
6. `continuationCount < maxContinuations`.

**Effect on fire:** `continuationCount` is incremented, `lastContinuationAt` stamped, sessions persisted, and a `SyntheticMessageEvent` is dispatched through the existing `messageInjector` (same surface as the cron-scheduler injection path). The injected text is `buildGoalContinuationPrompt(goal)` with the `[goal-continuation]` prefix.

**Cap policy:** when `continuationCount >= maxContinuations` the host posts a single in-thread notice telling the user the ralph loop has paused and any new message resumes it. The cap counter is reset to zero by every real (non-synthetic) user message via `resetGoalContinuationOnUserMessage` invoked from `slack-handler.ts`.

**User-message reset:** A real user message zeroes `continuationCount` and `consecutiveBlockedSignals`. It does **not** clear `pendingEval` — an in-flight eval triggered by a previous synthetic turn must still resolve.

**Continuation prompt body** is the codex `continuation.md` template ported into `buildGoalContinuationPrompt`, with three Slack-environment adaptations:

- The token-budget block is replaced by `Continuation turns used / cap / remaining`, which is the real governor in this environment.
- The `update_goal` tool reference is replaced by an instruction to emit the sentinel `<goal-complete-request reason="..."/>` — the host will run the external evaluator.
- When `session.goal.lastEvalReason` is set, the prompt appends a `### Previous evaluation gap` section reproducing the verdict verbatim so the next turn closes that specific gap.

The Fidelity, Completion-audit, and Blocked-audit sections are carried verbatim from codex.

## Completion via Host-Side Eval Model

**The work model is not allowed to flip `status` to `complete` on its own.** Codex enforces this through the in-tool gate; soma-work has no comparable tool surface, so the host parses the assistant text and runs an external evaluator before any transition.

**Detection** (`src/slack/goal-completion-detector.ts`):

- The contract surface is the sentinel `<goal-complete-request reason="..."/>` emitted on its own line by the work model.
- A natural-language safety net matches narrow phrases like "the goal appears complete" or "the objective has been achieved" — narrow enough to reject "the goal is to X" and "I need to make the goal complete".

**Dispatch** (`src/slack/goal-completion-evaluator.ts`):

1. The slack-handler post-turn surface hook (`onAssistantTurnComplete`) detects the signal, stamps `session.goal.pendingEval = { requestedAt, turnId }`, persists, and hands off to the registered orchestrator. The pending eval pauses the ralph loop on the next idle (Guard #3 above).
2. The orchestrator (wired in `index.ts`) constructs a fresh, clean-context dispatch through `ClaudeHandler.dispatchOneShot` — no `resumeSessionId`, so the eval model cannot peek at the work model's session history. The model identifier and reasoning effort are matched to the work model so the evaluator is **not** weaker than the worker.
3. The system prompt is `src/prompt/goal-eval.prompt`. The user prompt contains `<objective>`, `<work-summary>`, and an `<evaluation-instruction>` block. The work-summary concatenates the assistant turn output and the detector's reason; future iterations may add tool-call summaries and `git status -s` / `git diff --stat` output, but the contract is "evidence the host can authenticate."
4. The evaluator must emit exactly one JSON object: `{"completed": boolean, "reason": string, "remaining": string[]}`. The parser tolerates a `\`\`\`json` fence or surrounding prose but rejects missing or wrong-typed fields with `GoalEvalParseError`.

**Verdict application** (`applyGoalEvalSuccess` / `applyGoalEvalFailure` / `applyGoalEvalDispatchFailure` helpers):

- `completed === true` → `status='complete'`, `completedAt=now`, `completedBy='eval-model'`, `completedVia='eval-model'`, `pendingEval=undefined`, `lastEvalReason=undefined`, `evalAttemptCount++`. Slack posts `✅ Goal completed (eval-model verdict)` with the objective and verbatim eval reason. The ralph loop does not fire on the next idle because Guard #2 (status active) fails.
- `completed === false` → `pendingEval=undefined`, `lastEvalReason=verdict.reason`, `evalAttemptCount++`, status stays `active`. Slack posts `🔄 Goal not yet complete` with the reason and remaining items. The next idle fires a continuation that embeds the reason via the `### Previous evaluation gap` block.
- Dispatch / parse / timeout failure → `pendingEval=undefined`, status preserved, `evalAttemptCount` **not** bumped (infra flakes aren't completed eval attempts). Slack posts `⚠️ Goal completion evaluation failed` with instructions to use `goal done` / `goal pause` / `goal clear`.

**User-bypass:** `goal done` (and aliases) is the only path that can flip status to `complete` without running the eval. The handler also clears `pendingEval` and `lastEvalReason` and stamps `completedVia='user'` for audit symmetry.

**Invariant:** the work model can only request completion. The eval model (or the user) decides.

## Persistence

`SessionRegistry.saveSessions()` must persist sessions that have either a `sessionId`, a `handoffContext`, or a `goal`. This preserves a goal set before the first model turn.

`resetSessionContext()` clears the goal because `/new` and `/renew` create a fresh logical conversation in the same Slack thread.

## `/z` Surface

Thread/app-mention `/z goal ...` translates to the same legacy text and routes through `GoalHandler`.

Slack slash `/z goal ...` is forbidden because Slack slash commands do not carry a real thread context, and goals are session/thread scoped.

The `/z` help card can expose a read-only `goal` topic card that documents the command. `goal` is intentionally not added to the non-admin DM safe-topic allowlist because `goal set <objective>` can continue into model execution.

## Non-Goals

- No token-budget accounting in this Slack implementation. Claude SDK session state does not expose Codex's local thread goal accounting hooks; the ralph loop is bounded by `maxContinuations` instead.
- No Slack Block Kit buttons for setting or completing goals in this change.
