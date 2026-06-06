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
- `status: "active" | "paused" | "complete"` (the codex `"blocked"` arm is intentionally not implemented — N11; a legacy persisted `"blocked"` is migrated to `"paused"` on load)
- `createdAt: number`
- `updatedAt: number`
- `createdBy: string`
- `completedAt?: number`
- `completedBy?: string` — the Slack userId that closed the goal. Set on the user-driven path (`goal done`); left **undefined** on the eval path so the field keeps a single meaning ("which human closed it"). `completedVia` is the path discriminator (S7).
- `completedVia?: 'user' | 'eval-model'` — audit trail of which path closed the goal; this, not `completedBy`, distinguishes user-driven from eval-driven completion
- Ralph-loop control:
  - `continuationCount: number` — auto-continuation turns fired since the last real user message
  - `maxContinuations: number` — cap (default 10)
  - `lastContinuationAt?: number`
- Eval tracking:
  - `pendingEval?: { requestedAt: number; turnId: string }` — set while an eval is in flight; dedupes a concurrent turn end until the verdict resolves
  - `lastEvalReason?: string` — verbatim verdict from the last `completed=false` eval; injected into the next continuation
  - `evalAttemptCount?: number`
  - `epoch?: number` — monotonic intent epoch. Bumped by every goal mutation (set / pause / resume / done / clear) and by every real (non-synthetic) user message. The completion eval captures it at dispatch and discards its verdict if the epoch moved while the eval was in flight, so a stale verdict can never apply against state the user already moved past (`GoalLoopController` M1).
  - `lastAssistantTurnSummary?: string` — persisted, bounded (≤16k chars) mirror of the runtime-only `session.goalLastTurnText`. Survives a restart so the eval on the next post-restart turn-settled trigger has real evidence; the runtime stash takes precedence when present. Not a crash-replay mechanism.

The objective must be trimmed, non-empty, and at most 4,000 Unicode characters.

Legacy goals serialized before this followup (lacking the ralph-loop fields) are migrated on load by `SessionRegistry.migrateLegacyGoal`, which back-fills `continuationCount=0`, `maxContinuations=10`, and zeroed counters.

## Prompt Injection

Only active goals are injected into the system prompt. Paused and complete goals remain visible through `goal status` but do not steer the model.

The injected block must:

- XML-escape objective delimiters (`&`, `<`, `>`) before prompt insertion.
- State that the objective is user-provided task data, not higher-priority instruction.
- Preserve Codex's completion-audit rule: completion must be proven against the current workspace or external state before the assistant says the goal is complete.
- Avoid claiming a local `update_goal` tool exists. Completion is adjudicated by the host eval model, which forks a clean eval turn after every turn end; the work model never flips the status itself.

Changing goal state (set/pause/resume/complete/clear, plus every ralph-loop continuation and every eval verdict) must clear `session.systemPrompt` so the next model turn rebuilds against the current goal. This applies because `applySessionGoal` only injects when `goal.status === 'active'`, and the cached prompt would otherwise embed a stale steering block.

## Auto-Continuation Loop (Ralph Loop)

The loop is driven from the **idle-settle** boundary — when the session has genuinely settled to idle with no in-flight request — NOT per-turn-end:

1. User input → 2. model WORKS on the goal (a real, possibly multi-tool, minutes-long turn) → 3. the work turn ENDS and the session settles to idle → 4. if a goal is `active`, the host forks a clean eval turn and asks the model whether the goal is complete (y/n) → 5. on **"no"**, the host feeds the goal back to the model as the next continuation turn (loop to step 2); on **"yes"**, the loop stops.

**Two failure modes this balances:**
- *Spin* — injecting a continuation while a turn is live makes `handleConcurrency` **supersede (abort)** it, killing the model mid-work → empty output → tight eval loop (PTN-4695). Guarded by the injection-time `isRequestActive` check (never supersede).
- *Never-checks* — firing the driver too early, before the just-finished turn released its request slot, makes `shouldRunGoalIdleDriver` see `requestActive === true` and bail silently → the eval never runs. This is why the trigger must fire AFTER slot release.

**Trigger:** `onAssistantTurnComplete` (from `TurnRunner.finish()`) both *stashes* the turn's assistant text (`session.goalLastTurnText`, runtime-only) and *invokes the driver*. `finish()` runs after `StreamExecutor.execute()` has returned and its `finally` has called `removeController` — so the slot is released and `shouldRunGoalIdleDriver` passes. (An earlier version fired from `setActivityState('idle')`'s idle-after-drain hook, which runs ~1s before `removeController`; the gate always saw an active request and the eval never fired.)

**Driver gate (`shouldRunGoalIdleDriver`, all must pass):**

1. Session has an `active` goal (paused / complete both suppress).
2. `session.goal.pendingEval` is unset (no eval already in flight — dedupe).
3. `requestCoordinator.isRequestActive(sessionKey) === false` — no live/fresh turn to step on.
4. activity state is `'idle'`.

**Loop owner (`GoalLoopController`, `src/slack/goal-loop-controller.ts`):** the loop is owned end-to-end by one controller; `index.ts` only constructs it and forwards the turn-settled trigger to `onTurnSettled(sessionKey)`. The controller:

- **Serializes** per-session work through a promise queue, so two evals (or an eval and an injection) for the same session can never overlap.
- **Snapshots the intent epoch** (`epoch` + `createdAt`) at eval dispatch and **discards** the verdict if it moved while the eval was in flight — no mutate / persist / notice / increment / complete / inject. The user's newer intent always wins (M1). The controller still clears its own stale `pendingEval` lease so the loop cannot wedge.
- **Bounds the eval** with a timeout + `AbortController` (`DEFAULT_GOAL_EVAL_TIMEOUT_MS`); a hung dispatch is aborted and routed to the dispatch-failure path instead of wedging the loop on a never-clearing lease (M3).
- **Re-arms** (bounded: `DEFAULT_GOAL_MAX_REARM_ATTEMPTS` × `DEFAULT_GOAL_REARM_DELAY_MS`) when a trigger observes the request slot still busy, so an eval is never silently lost just because the trigger fired slightly before `removeController` — the controller, not the call-site trigger ordering, guarantees the eval runs once the slot frees (M4; this structurally forecloses the #1058 "never-checks" regression). It still never supersedes: a slot that stays busy past the re-arm budget simply defers to the next turn-settled trigger.

On a valid (in-epoch) verdict it stamps `pendingEval`, clears `systemPrompt`, runs the eval (see §Completion) with `goalLastTurnText` (or the persisted `lastAssistantTurnSummary` after a restart) as work-summary evidence, then:

- `completed === true` → mark complete, post `✅`, stop.
- `completed === false` → record the gap (`lastEvalReason`), and if `continuationCount < maxContinuations`, increment `continuationCount`, stamp `lastContinuationAt`, persist, post `🔄`. Then — **only if the session is still idle** (re-checks `isRequestActive`; a user turn may have started during the eval, which must win) — inject the next continuation: a `SyntheticMessageEvent` dispatched **fire-and-forget** through the same `messageInjector` surface as the cron-scheduler injection path, text `buildGoalContinuationPrompt(goal)` with the `[goal-continuation]` prefix. The continuation turn runs to completion (never superseded); when it ends and the session settles idle again, the controller re-runs — that is the loop.

**Cap policy:** when `continuationCount >= maxContinuations` the host posts a single in-thread notice that the loop has paused and any new message resumes it — it does **not** inject a continuation. The cap counter is reset to zero by every real (non-synthetic) user message via `resetGoalContinuationOnUserMessage` invoked from `slack-handler.ts`.

**User-message reset:** A real user message zeroes `continuationCount` and bumps the intent `epoch`. It does **not** clear `pendingEval` — an in-flight eval triggered by a previous turn must still resolve — but the epoch bump makes `GoalLoopController` discard that eval's (now stale) verdict when it returns (M1).

**Continuation prompt body** is the codex `continuation.md` template ported into `buildGoalContinuationPrompt`, with three Slack-environment adaptations:

- The token-budget block is replaced by `Continuation turns used / cap / remaining`, which is the real governor in this environment.
- The `update_goal` tool reference is replaced by a plain-language completion self-assessment (N10 — there is **no** `<goal-complete-request>` sentinel; the host never parsed one). The model is told it cannot mark the goal complete itself and to state a completion belief with evidence in its closing summary; that text is one input to the eval's work-summary evidence. It is **not** a loop trigger — the host runs an eval after every active-goal turn regardless.
- When `session.goal.lastEvalReason` is set, the prompt appends a `### Previous evaluation gap` section reproducing the verdict verbatim so the next turn closes that specific gap.

The Fidelity and Completion-audit sections are carried verbatim from codex. The codex Blocked-audit is dropped (N11 — the `blocked` status is not implemented); the prompt instead carries a lightweight "impasse" note that tells the model not to give up early and to keep going rather than self-declare a stop.

## Completion via Host-Side Eval Model

**The work model is not allowed to flip `status` to `complete` on its own.** Codex enforces this through the in-tool gate; soma-work has no comparable tool surface, so the host parses the assistant text and runs an external evaluator before any transition.

**Trigger:** there is no sentinel — the work model is not relied upon to announce completion. The host runs an eval each time the session settles to idle with an active goal (see §Auto-Continuation Loop).

**Dispatch** (`src/slack/goal-completion-evaluator.ts`):

1. The slack-handler post-turn surface hook (`onAssistantTurnComplete`) stamps `session.goal.pendingEval = { requestedAt, turnId }`, persists, and hands off to the registered orchestrator. The pending eval dedupes a concurrent turn end while the eval is in flight (Trigger guard #2 above).
2. The orchestrator (wired in `index.ts`) constructs a fresh, clean-context dispatch through `ClaudeHandler.dispatchOneShot` — no `resumeSessionId`, so the eval model cannot peek at the work model's session history. The model identifier and reasoning effort are matched to the work model so the evaluator is **not** weaker than the worker.
3. The system prompt is `src/prompt/goal-eval.prompt`. The user prompt contains `<objective>`, `<work-summary>`, and an `<evaluation-instruction>` block. The work-summary concatenates the assistant turn output and the detector's reason; future iterations may add tool-call summaries and `git status -s` / `git diff --stat` output, but the contract is "evidence the host can authenticate."
4. The evaluator must emit exactly one JSON object: `{"completed": boolean, "reason": string, "remaining": string[]}`. The parser tolerates a `\`\`\`json` fence or surrounding prose but rejects missing or wrong-typed fields with `GoalEvalParseError`.

**Verdict application** (`applyGoalEvalSuccess` / `applyGoalEvalFailure` / `applyGoalEvalDispatchFailure` helpers):

- `completed === true` → `status='complete'`, `completedAt=now`, `completedBy=undefined` (the Slack-userId slot stays empty on the eval path), `completedVia='eval-model'`, `pendingEval=undefined`, `lastEvalReason=undefined`, `evalAttemptCount++`. Slack posts `✅ Goal completed (eval-model verdict)` with the objective and verbatim eval reason. The loop stops (no continuation injected).
- `completed === false` → `pendingEval=undefined`, `lastEvalReason=verdict.reason`, `evalAttemptCount++`, status stays `active`. Slack posts `🔄 Goal not yet complete` with the reason and remaining items, then (unless the cap is hit) the handler injects a continuation turn that embeds the reason via the `### Previous evaluation gap` block.
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
