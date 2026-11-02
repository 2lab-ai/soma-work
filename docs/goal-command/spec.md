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
- `goal <objective>` or `goal set <objective>`: set or replace the active goal and continue the model with the objective itself as the opening turn (steering rules come from the `<session-goal>` system block).
- `goal status`: alias for showing the current goal.
- `goal pause`: keep the objective but stop injecting it into future prompts.
- `goal resume`: reactivate a paused goal.
- `goal done`, `goal complete`, or `goal completed`: mark the goal complete **(user-driven; bypasses host eval)**.
- `goal clear`: remove the goal from the session.

The command is session-scoped, not user-global.

### No-Session Fall-Through

When the thread has no session, the behavior depends on whether the message carries a free-form objective:

- **Bare lifecycle forms** (`goal`, `goal status`, `goal pause|resume|done|clear`, and a malformed `goal set` with no objective): genuine session-scoped commands with nothing to act on. These fail with a clear "No active session. Start a conversation first." message.
- **`goal <objective>` / `goal set <objective>`** (a free-form objective is present): the word "goal" is everyday English, so a first message like `goal ship the parser, see attached` is almost certainly a task — not a lifecycle command — and the session-scoped reading is impossible anyway (there is no session to attach a goal to). The handler must **not** swallow it with "No active session" and drop the user's text + attachments. Instead it returns *unhandled* so `CommandRouter` falls through and the message starts a fresh conversation with the user's full text as the first prompt.

The same fall-through rule applies to `renew <instruction>` (greedy, session-required): bare `renew` with no session keeps the "No active session to renew" hint, while `renew <free-form text>` falls through to start a new conversation.

The slash forms (`/goal <objective>`, `/renew <text>`) fall through identically. `CommandParser.isPotentialCommand` treats these greedy free-form roots like the plain-text branch: an argument-carrying slash form is an instruction (`isPotential:false`), so `CommandRouter` does **not** emit the ❓ unrecognized-command hint and the message reaches the work turn. Bare `/goal` / `/renew` (no argument) stay potential and keep the hint.

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

The `<session-goal>` block is the **single** place the objective and the steering rules reach the model. It must:

- Escape the tag delimiters `<` and `>` so the objective cannot open or close a tag. `&` is deliberately left alone: Slack already delivers `<`/`>`/`&` as `&lt;`/`&gt;`/`&amp;`, and re-escaping `&` turned every `&gt;` into `&amp;gt;`.
- Carry exactly four rules: the goal persists across turns and a host evaluator (not the model) decides completion; do not shrink the objective; end each turn with a short summary of actions and evidence (the evaluator's input); say the goal is done only when every requirement has concrete evidence.
- Avoid claiming a local `update_goal` tool exists. Completion is adjudicated by the host eval model, which forks a clean eval turn after every turn end; the work model never flips the status itself.

**Opening turn.** Every surface that starts a goal — autogoal promotion, `goal <objective>` / `new goal <objective>`, a goal-prefixed first message, and `goal done` advancing to the next queued goal — dispatches the user's raw text (or the promoted objective) as the turn's message. The turn is never rewritten into a continuation prompt: that duplicated the objective and ~4 KB of rules into the user message, the conversation record, and the work log, and made episodic memory skip the real first instruction as a "system re-injection".

**Verbatim re-entry.** `GoalHandler` marks its `continueWithPrompt` with `verbatimPrompt: true` (set and queue-advance paths). The two `/z` consumers that feed a command's prompt back into the full message pipeline — the admin DM branch and `@bot /z …` app_mention — copy that marker onto `routeContext.verbatimPrompt`. A verbatim event skips the `!` abort check, inline `%` directives, command routing, and steer parsing, and always counts as a real turn for the follow-up queue (the stored message keeps the marker). Without it, an objective such as `new dashboard`, `!urgent …`, or `%nogoal …` was executed as that command right after the goal was set.

**Literal opening turn.** The opening turn of an explicitly set goal (a goal command's prompt, a verbatim `/z goal` event, or a goal-prefixed first message) is dispatched with `literalPrompt`. The executor then never forwards it raw as an SDK local slash command (`shouldForwardAsLocalSlashCommand`), so `goal /compact 명령의 버그를 고쳐라` reaches the model as a task. The adapter carries the flag on the first dispatch turn only — a host `/compact` continuation and a typed `/compact` stay commands. Autogoal never promotes a typed SDK slash command (`/compact focus on X`) to a goal.

**Replay keeps the marker.** A goal-opening turn can be replayed later: after an emergency prompt-too-long `/compact` (`fallbackCompactPendingEventContext`), or when it arrives during compaction and is stashed (`compactPendingDispatches`). Both stashes carry `verbatimPrompt` on their context, and `EventRouter.dispatchPendingUserMessage` puts it back on `routeContext`, so the replay is dispatched as the objective — never re-parsed as `new …` (which would reset the session and erase the goal) or run as `/clear …`. The stash never merges a verbatim entry with ordinary text, and keeps the dispatched objective rather than the directive-bearing raw text. A channel `goal …` turn is marked verbatim before session init for the same reason, and a verbatim objective starting with `/compact` does not claim the compaction-turn marker.

Changing goal state (set/pause/resume/complete/clear, the cap-decision DM Continue/Cancel, plus every ralph-loop continuation and every eval verdict) must clear `session.systemPrompt` and advance the goal epoch so the next model turn rebuilds against the current goal. Continuation turns depend on this: their one-line text carries no objective, so the rebuilt `<session-goal>` block is the only place the model reads it. This applies because `applySessionGoal` only injects when `goal.status === 'active'`, and the cached prompt would otherwise embed a stale steering block.

## Auto-Continuation Loop (Ralph Loop)

The loop is driven from the **idle-settle** boundary — when the session has genuinely settled to idle with no in-flight request — NOT per-turn-end:

1. User input → 2. model WORKS on the goal (a real, possibly multi-tool, minutes-long turn) → 3. the work turn ENDS and the session settles to idle → 4. if a goal is `active`, the host forks a clean eval turn and asks the model whether the goal is complete (y/n) → 5. on **"no"**, the host feeds the goal back to the model as the next continuation turn (loop to step 2); on **"yes"**, the loop stops.

**Two failure modes this balances:**
- *Spin* — injecting a continuation while a turn is live makes `handleConcurrency` **supersede (abort)** it, killing the model mid-work → empty output → tight eval loop (PROJ-4695). Guarded by the injection-time `isRequestActive` check (never supersede).
- *Never-checks* — firing the driver too early, before the just-finished turn released its request slot, makes `shouldRunGoalIdleDriver` see `requestActive === true` and bail silently → the eval never runs. This is why the trigger must fire AFTER slot release.

**Trigger:** `onAssistantTurnComplete` (from `TurnRunner.finish()`) both *stashes* the turn's assistant text (`session.goalLastTurnText`, runtime-only) and *invokes the driver*. `finish()` runs after `StreamExecutor.execute()` has returned and its `finally` has called `removeController` — so the slot is released and `shouldRunGoalIdleDriver` passes. (An earlier version fired from `setActivityState('idle')`'s idle-after-drain hook, which runs ~1s before `removeController`; the gate always saw an active request and the eval never fired.)

**Driver gate (`shouldRunGoalIdleDriver`, all must pass):**

1. Session has an `active` goal (paused / complete both suppress).
2. `session.goal.pendingEval` is unset (no eval already in flight — dedupe).
3. `requestCoordinator.isRequestActive(sessionKey) === false` — no live/fresh turn to step on.
4. activity state is `'idle'`.

**Follow-up queue priority (`.prd/slack-agent-ui/ssot.md` §3.6):** at a turn end, `SlackHandler.handleAssistantTurnCompleteForGoal` still stashes the turn text but HOLDS the driver (`shouldDeferGoalDriver`) while the session's follow-up queue has outstanding user work (`queued` / `steered` / `reserved` / `claimed`). The deferral is released by `drainFollowups` → `releaseDeferredGoalDriver` (and by a human-driven Resume/Retry drain) when the last run settled `safe` and nothing is outstanding. Contract the loop depends on:

- A drained follow-up that a command answers in full without starting a turn (for example a goal command restored from the persisted queue after a restart, or the announced dropped-goal case of #1082) settles `safe`. A goal command typed while a turn runs is no longer parked at all — see §Goal Commands While a Turn Runs. The dispatcher reads `blocked` as a turn torn down mid-flight: the item becomes `uncertain` and the lane halts until a human clicks Resume — reported that way, the queued goal stranded both the lane and the goal loop that was supposed to finish the active goal (work-m64 dev incident, 2026-10-01 11:25Z). A command handler crash settles `error` (item `failed`, Retry offered); a cross-user `$skill` parked behind its owner's permission settles `blocked` (item `uncertain`).
- A drain halt by itself does not hold the driver. A halt set by an initial run (no item) has no Resume/Retry control that could clear it, so gating on it left the loop deferred for the rest of the session; with items outstanding the item clause already holds the driver. A turn that ends on a pending user choice (ASK) is not held by this clause either: it leaves `activityState = 'waiting'`, and `shouldRunGoalIdleDriver` refuses to run the eval until the session is `idle` again — the halt its `blocked` outcome installs is not what protects it.

**Loop owner (`GoalLoopController`, `src/slack/goal-loop-controller.ts`):** the loop is owned end-to-end by one controller; `index.ts` only constructs it and forwards the turn-settled trigger to `onTurnSettled(sessionKey)`. The controller:

- **Serializes** per-session work through a promise queue, so two evals (or an eval and an injection) for the same session can never overlap.
- **Snapshots the intent epoch** (`epoch` + `createdAt`) at eval dispatch and **discards** the verdict if it moved while the eval was in flight — no mutate / persist / notice / increment / complete / inject. The user's newer intent always wins (M1). The controller still clears its own stale `pendingEval` lease so the loop cannot wedge.
- **Bounds the eval** with a timeout + `AbortController` (`DEFAULT_GOAL_EVAL_TIMEOUT_MS`); a hung dispatch is aborted and routed to the dispatch-failure path instead of wedging the loop on a never-clearing lease (M3).

On a valid (in-epoch) verdict it stamps `pendingEval`, clears `systemPrompt`, runs the eval (see §Completion) with `goalLastTurnText` (or the persisted `lastAssistantTurnSummary` after a restart) as work-summary evidence, then:

- `completed === true` → mark complete, post `✅`, stop.
- `completed === false` → record the gap (`lastEvalReason`), and if `continuationCount < maxContinuations`, increment `continuationCount`, stamp `lastContinuationAt`, persist, post `🔄` (at `compact` and above; recorded as a work-log `notice` at every level when the session has a conversation — see the verdict-application rules below). Then — **only if the session is still idle** (re-checks `isRequestActive`; a user turn may have started during the eval, which must win) — inject the next continuation: a `SyntheticMessageEvent` dispatched **fire-and-forget** through the same `messageInjector` surface as the cron-scheduler injection path, text `buildGoalContinuationPrompt(goal)` with the `[goal-continuation]` prefix. The continuation turn runs to completion (never superseded); when it ends and the session settles idle again, the controller re-runs — that is the loop.

**Cap decision — one request, two surfaces** (requested 2026-10-31: "goal이 10/10이 되면 slack dm으로 재가 할건지 묻고 있는데 이거 Approval 카드로 대시보드에도 같은 내용 표시해줘. 아무데서나 수락하면 둘다 수락 처리"). At the cap the controller opens a decision on the goal (`openGoalCapDecision`: `capDmPendingAt` + a UUID round id `capDecisionId`), pushes the board, and DMs the owner Continue/Cancel buttons that carry the round id. The DM's `{channel, ts}` is kept in `capDmRef` only after the post succeeded; a round without a ref retries only the DM on the next cap trigger, and a DM that lands after its round ended is rewritten at once. The dashboard shows the open round as `KanbanSession.pendingGoalDecision` — an approval card (question, 계속 / 취소, no recommended default) in the open card and the panel's 입력 필요, and the card reads `waiting`. The Slack buttons and `POST /api/dashboard/session/:key/goal-decision` answer through one function, `answerGoalCapDecision` (`src/slack/goal-cap-decision.ts`): only the goal's owner (`createdBy`), only the active goal's pending round, decided and saved synchronously before any side effect, so a second answer from either surface is stale. A dashboard answer rewrites the DM (kept in `capDmSync` until it lands — retried, and again after a restart via `flushGoalCapDmSync`); a DM answer pushes the board so the card leaves. Every path that ends a round without an answer (a real user message, pause, done, eval completion, a cancelled opening, the budget reset, deleting the goal) calls `retireGoalCapDecision`, which rewrites the DM to a no-longer-valid line.

**Cap policy:** when `continuationCount >= maxContinuations` the host posts a single in-thread notice that the loop has paused and any new message resumes it (at every verbosity level — the user has to act; also recorded as a work-log `notice` when the session has a conversation) — it does **not** inject a continuation. The cap counter is reset to zero by every real (non-synthetic) user message via `resetGoalContinuationOnUserMessage` invoked from `slack-handler.ts`.

**Stall: same failure twice** (requested 2026-11-02: "goal이 실패시 지난번 goal을 실패한 이유랑 비교(…그 모델에게 지난번 골 실패 원인을 같이 전달.)해서 이유가 같으면 (0.95이상의 확신일 경우) 거기서 goal을 즉시 중단 처리하고 goal을 완료 하기위해 마지막으로 유저가 지시할만한 대표 행동 3개만 꼽고 그것을 유저에게 질문 하도록 처리"). Most 10/10 runs were not long work: of the 49 runs that reached the cap on the fable-m5max dev host (2026-06-17 to 2026-11-02), 20 ended in three or more continuation turns of under two minutes each, the model restating that it waited on the owner (an approval, a button choice, a manual measurement) or on an outage. The evaluator could not see this: it never got its own previous verdict.

- The eval prompt now carries the previous `completed=false` verdict (`lastEvalReason` + `lastEvalRemaining`) in a `<previous-evaluation>` block. The verdict gains `sameAsPrevious`, `sameConfidence` (0 to 1), `progressed` and `userActions` (the three instructions the owner is most likely to give next). Old-shape verdicts still parse and read as "not the same".
- `decideGoalEvalOutcome` returns `stalled` when a previous failure is on record and the verdict says `sameAsPrevious` with `sameConfidence ≥ 0.95` (`GOAL_STALL_MIN_CONFIDENCE`). The check runs before the cap, so a repeat at 10/10 asks this question instead of the cap's. The counter is not bumped.
- On `stalled` the controller injects nothing, opens `goal.stall` (`stallId`, reason, three actions — the evaluator's, topped up from fixed fallbacks), posts `🛑 Goal 자동 진행을 멈췄습니다` at every level (a result notice, recorded in the work log), and asks the owner through `SlackHandler.askGoalStallQuestion` → `StreamExecutor.askUserQuestionFromHost`. That is the model's ASK_USER_QUESTION renderer: a one-item multi-choice form in the thread, `pendingQuestion` + `waiting` for the dashboard card, answerable from either surface. The answer reaches the model as `<question>: <id>. <label>` in a real user turn. The question is skipped when a turn started in the meantime or another question is open.
- While `goal.stall` is open `shouldRunGoalIdleDriver` refuses, so a settle or a restart runs no eval and asks nothing again. A real user message ends the round (`resetGoalContinuationOnUserMessage` → `retireGoalStall(goal, 'user-message')`) — that turn clears the question itself. Every other ending retracts the question (`SlackHandler.onGoalStallRetired` → `StreamExecutor.retractHostQuestion`: the form stops accepting answers, the session stops waiting): pause, done, completion, delete, `goal clear`, `new` / `renew`, `goal resume` (which also re-drives the loop), an objective update, and a goal added (`enqueueOrActivateGoal` restarts a stalled current goal as it restarts one stopped at its budget, with `▶️ The current goal had stopped on a repeated failure — it runs again now`). `lastEvalReason` survives the message, so if the next turn fails the same way the loop stops after one turn instead of running ten more.
- The question is bound to its round (`stall.questionTurnId`). The round is re-checked after the Slack post: if the owner wrote or a turn started while it was in flight, the question is retracted instead of re-opening the session as `waiting`. The 🛑 notice lists the three actions too, so they reach the owner when the question cannot be posted (another question is open, Slack failed), and a failed notice never keeps the question from being asked.
- The loop knows what woke it (`GoalLoopController.onTurnSettled(key, { cause })`): `turn` when a work turn ended, `kick` when none ran — `goal resume`, Continue, a goal added (`resumeGoalLoop`, the dashboard add) or a restart (`resumeActiveGoals`). The S9 unchanged-summary shortcut reuses the last verdict only on a kick or at the cap: a kick runs the next turn instead of re-judging the old text (it would only stall again), while a NEW turn with the same output is exactly the repeat the stall check exists for, so it goes to the evaluator, which can stall it and name the three actions.
- The evaluator also keeps requirements it already accepted with direct evidence, unless the latest turn contradicts them — the work model no longer re-fetches and re-prints the same proof every turn.
- The dashboard goal card shows `멈춤` and the stall reason (`KanbanGoal.current.stalled`).

**Stall → roll back to the first failure** (#745, requested 2026-11-02: "이러한 경우에 goal이 실패할경우 아무것도 하지 않았을 경우 처음 goal이 실패한 지점으로 롤백 (유저에게 위에 질문에 이어서 같이 물어봐줘 해당 지점으로 롤백할 것인지)"). The repeated turns of a stall usually only restate the blocker, and they stay in the model's context afterwards.

- Every real verdict updates `goal.firstFailure` (`trackGoalFirstFailure`, before `decideGoalEvalOutcome` overwrites `lastEvalReason`). A new failure reason, or the first failure of the goal, records the context anchor at the end of the turn just judged (`session.contextAnchor`, see `docs/current/spec/context-rollback.md`). A verdict that says `sameAsPrevious` counts one more turn there and records whether that turn `progressed`. Completion drops it. A reused (S9) verdict judged no new turn and changes nothing.
- On a stall, `goalStallRollbackOffer` offers the rollback when no turn since the first failure did new work (the stall verdict included), at least one turn would leave the context, and the anchor is still usable (same SDK session, no compaction since). The stall then carries `rollbackAnchor` / `rollbackTurns`, and the question has a second item, `처음 실패한 지점으로 문맥 되돌리기` (예 / 아니오, 예 recommended), that says how many turns leave the context.
- Answering 예 (Slack form or dashboard — both send `<question>: yes. <label>`) is read in `processMessage` before the user-message reset ends the round (`applyGoalStallRollbackAnswer`): it stores a rollback to the first failure through the same `requestContextRollback` gate, so this very turn — the chosen next instruction — runs from there. The thread is told, files are not touched. A refused rollback is told too (`goalStallRollbackNotice`: ⛔ with the gate's reason — not the owner, a compaction since — and that the turn runs in the current context); it is never dropped silently.
- The 🛑 notice carries the offer as well (`rollback goal`), because it stands in for the question when the question cannot be posted (another question is open, Slack failed). `rollback goal` asks for the same rollback from the thread.
- Once a rollback is applied (any source), `goal.firstFailure` is cleared: it lies on the dropped branch, and the next failure starts a new one.

**A question still open at the cap is answerable** (requested 2026-11-02: "goal이 10/10이 되서 goal을 계속 진행할지를 묻고 그리고 동시에 유저에게 질문이 올경우 이거 질문에 답하면 에러나서 답변을 못하고 goal을 진행하는 입력을 하면 질문이 사라짐 — 이거 질문에 답해서 자연스럽게 진행되도록 픽스"). The open cap round makes the card read `waiting`, so it also shows a question the model asked earlier and that is still recorded on the idle session. The dashboard answer paths accept it (`isAnswerableFromDashboard`, `docs/current/spec/12-ui-ask-user-question.md` §8.3); the answer is a real user message, so `resetGoalContinuationOnUserMessage` ends the round and resets the counter, and the goal continues after that turn. A typed reply clears the recorded question, and a restart keeps a session waiting on its question waiting, so the loop no longer runs over an unanswered question.

**Adding a goal at the cap is user input too** (requested 2026-10-30: "10/10 일때 유저가 새로 채팅으로 지시하면 신규 goal이 추가되는데 기존 골이 10/10으로 스턱됨 이거 픽스해줘" / "정상적인 경우라면 goal이 10/10 되고 goal이 완료 안됐으면 마지막 골을 다시 실행해야하는거야"). A goal command (`goal <text>`) or a dashboard add is consumed — no turn starts, so the chat-message reset never ran and the stopped goal stayed at its cap while the new goal waited behind it forever. Now `enqueueOrActivateGoal` gives an ACTIVE goal stopped at its budget the budget back (counter 0, pending cap DM answered) and returns it as `resumedCurrent`; the caller adds `▶️ The current goal … runs again now` to the queued notice and re-drives the loop (`goal <text>` via `resumeGoalLoop`, dashboard add via the turn-settled handler). The stopped goal runs again; the new goal stays queued and starts when it completes. A `paused` goal is left alone. `SET_GOAL` runs inside the user's own turn, whose message already reset the counter.

**User-message reset:** A real user message zeroes `continuationCount` and bumps the intent `epoch`. It does **not** clear `pendingEval` — an in-flight eval triggered by a previous turn must still resolve — but the epoch bump makes `GoalLoopController` discard that eval's (now stale) verdict when it returns (M1).

**Continuation prompt body** (`buildGoalContinuationPrompt`) is one line: `Continue working toward the active session goal (objective in <session-goal>). Auto-continuation N/cap.` The objective and rules are not repeated — they already sit in the `<session-goal>` system block. The first sentence is also the episodic-memory filter marker (`memory-auto-capture.ts`), so it must stay verbatim. There is **no** `<goal-complete-request>` sentinel (N10); the host runs an eval after every active-goal turn regardless.

When `session.goal.lastEvalReason` is set, the prompt appends a `Previous evaluation gap` line and the verdict inside `<previous-eval-reason>` (tag delimiters escaped) so the next turn closes that specific gap.

The codex `continuation.md` Fidelity, Completion-audit, and Impasse sections are intentionally **not** carried: the host evaluator re-audits completion every turn, "do not shrink the objective" covers Fidelity, and the loop itself re-injects turns, so an Impasse rule only added ~3 KB per turn and contradicted user instructions to stop for confirmation.

## Completion via Host-Side Eval Model

**The work model is not allowed to flip `status` to `complete` on its own.** Codex enforces this through the in-tool gate; soma-work has no comparable tool surface, so the host parses the assistant text and runs an external evaluator before any transition.

**Trigger:** there is no sentinel — the work model is not relied upon to announce completion. The host runs an eval each time the session settles to idle with an active goal (see §Auto-Continuation Loop).

**Dispatch** (`src/slack/goal-completion-evaluator.ts`):

1. The slack-handler post-turn surface hook (`onAssistantTurnComplete`) stamps `session.goal.pendingEval = { requestedAt, turnId }`, persists, and hands off to the registered orchestrator. The pending eval dedupes a concurrent turn end while the eval is in flight (Trigger guard #2 above).
2. The orchestrator (wired in `index.ts`) constructs a fresh, clean-context dispatch through `ClaudeHandler.dispatchOneShot` — no `resumeSessionId`, so the eval model cannot peek at the work model's session history. The model identifier and reasoning effort are matched to the work model so the evaluator is **not** weaker than the worker.
3. The system prompt is `src/prompt/goal-eval.prompt`. The user prompt contains `<objective>`, `<previous-evaluation>` (when a `completed=false` verdict is on record — see §Stall), `<work-summary>`, and an `<evaluation-instruction>` block. The work-summary concatenates the assistant turn output and the detector's reason; future iterations may add tool-call summaries and `git status -s` / `git diff --stat` output, but the contract is "evidence the host can authenticate."
4. The evaluator must emit exactly one JSON object: `{"completed": boolean, "reason": string, "remaining": string[], "sameAsPrevious": boolean, "sameConfidence": number, "progressed": boolean, "userActions": string[]}`. The parser tolerates a `\`\`\`json` fence or surrounding prose but rejects missing or wrong-typed required fields (`completed`, `reason`, `remaining`) with `GoalEvalParseError`; the four comparison fields are optional (see §Stall).

**Verdict application** (`applyGoalEvalSuccess` / `applyGoalEvalFailure` / `applyGoalEvalDispatchFailure` helpers):

- `completed === true` → `status='complete'`, `completedAt=now`, `completedBy=undefined` (the Slack-userId slot stays empty on the eval path), `completedVia='eval-model'`, `pendingEval=undefined`, `lastEvalReason=undefined`, `evalAttemptCount++`. Slack posts `✅ Goal completed (eval-model verdict)` with the objective and verbatim eval reason, at every verbosity level (it carries the result); it is also recorded as a work-log `notice` when the session has a conversation. The loop stops (no continuation injected).
- `completed === false` → `pendingEval=undefined`, `lastEvalReason=verdict.reason`, `evalAttemptCount++`, status stays `active`. Slack posts `🔄 Goal not yet complete` with the reason and remaining items only at `compact` and above (a status message, `STATUS_MESSAGE`); at every level it is recorded as a work-log `notice` when the session has a conversation — see `docs/misc/guides/verbosity-matrix.md`. Then (unless the cap is hit) the handler injects a continuation turn that embeds the reason via the `### Previous evaluation gap` block.
- Dispatch / parse / timeout failure → `pendingEval=undefined`, status preserved, `evalAttemptCount` **not** bumped (infra flakes aren't completed eval attempts). The loop then **self-heals**: while the consecutive-failure streak (`evalDispatchRetryCount`) is below `GOAL_EVAL_DISPATCH_MAX_RETRIES` (3), a re-eval is scheduled after the failure's advertised rate-limit window (gateway "retry in Ns", bounded to [1s, 1h]) or a 60s default backoff, and Slack posts `⏳ Goal completion evaluation hit a transient API error — retrying in Ns (attempt k/3)`. The first line of the failure is kept as `evalRetryReason` (set and cleared with `evalBackoffUntil`), and every loop-state persist also pushes the dashboard board — the session is idle through the whole wait, so the card would otherwise sit in DONE; with `evalBackoffUntil` in the future (or `pendingEval` set) the card stays in RUNNING showing the re-check time, attempt k/3 and that error line. While the window is open, `evalBackoffUntil` gates `runOnce` so ordinary settles (e.g. a duplicate trigger queued behind the failing run) cannot re-dispatch against the same rate limit and burn the budget; the scheduled retry lifts the gate when it fires, a gated settle re-arms a (per-session deduped) retry for the remaining window — so a restart that loses the timer self-heals on the first post-restart settle — and the timestamp self-expires as a last resort. The scheduled retry re-enters through `onTurnSettled` after revalidating the failure-time `goalId`+`epoch` snapshot, so it re-checks every gate (idle / requestActive / pendingEval) at fire time and no-ops if the user weighed in during the wait; if the epoch moved during the failed eval itself, the lease is released and no retry (or notice) happens at all. A successful eval dispatch or any real user message resets the streak. Only when the budget is exhausted does Slack post the terminal `⚠️ Goal completion evaluation failed` with instructions to use `goal done` / `goal pause` / `goal clear` (the streak is reset there too, so a later user nudge starts a fresh budget). To make the advertised window visible through the eval timeout, the timeout aborts the dispatch first and only fails with the generic timeout error after a short grace window — the dispatch seam's abort rejection carries `poolRateLimitRetryMs` when the abort interrupted a rate-limit wait.

**User-bypass:** `goal done` (and aliases) is the only path that can flip status to `complete` without running the eval. The handler also clears `pendingEval` and `lastEvalReason` and stamps `completedVia='user'` for audit symmetry.

**Invariant:** the work model can only request completion. The eval model (or the user) decides.

## Multi-Goal Queue (T2)

A session holds **one active goal plus a FIFO queue** of pending goals and a capped history of completed ones (`session.goal`, `session.goalQueue`, `session.goalHistory`).

- Setting a goal while one is already **active or paused** does NOT replace it — the new objective is appended to `goalQueue` with `status='queued'` (never injected into the prompt, never drives the loop). This is enforced at the single chokepoint `enqueueOrActivateGoal`, shared by typed `goal <text>`, the `SET_GOAL` model-command, and the goal-prefixed first message, so the activate-vs-queue decision can't drift between surfaces.
- When the active goal **completes** (user `goal done` OR the eval-model `complete` verdict), `advanceGoalQueue` archives it to `goalHistory` (cap `MAX_GOAL_HISTORY`) and promotes the head of the queue to `session.goal` with a fresh active run (`continuationCount=0`, epoch rebased strictly past the finished goal, all per-eval scratch cleared). The promoted goal re-enters the ralph loop via the same continuation injection. On the eval path the promotion is announced with `▶️ Starting next queued goal` — posted only at `compact` and above, recorded as a work-log `notice` at every level when the session has a conversation (see `docs/misc/guides/verbosity-matrix.md`). Both completion paths share `advanceGoalQueue` so the semantics are identical.
- `goal clear` is the full escape hatch: it drops the current goal **and** the entire queue + history.

Each goal carries a stable `goalId`; the completion-eval snapshot guard (M1) keys on `goalId` (not `createdAt`) so a verdict can never apply against a different goal that shares a `createdAt` — including a queue-promoted goal created in the same millisecond.

## Goal Commands While a Turn Runs

A goal command is the user changing the goal list, not a follow-up for the running turn. Typed while the session's turn runs, it is run at once instead of being parked in the follow-up (steering) queue (`SlackHandler.runGoalCommandNow`; requested 2026-10-21: "goal을 추가 입력한 경우 추가 goal이 입력되야함").

- **Which messages.** Every goal command — `goal <objective>`, `goal set …`, `goal done|pause|resume|clear|status`, the `/z goal …` spelling and the `goal … $skill` split — decided by one predicate, `CommandRouter.isGoalIntakeText` (`isGoalCommandText`: the text routes to `GoalHandler` alone; `isGoalSkillSplitText`: the split). Kept on the queue path: non-admin DM input (Gate A lives in `processMessage`), a verbatim objective or any goal's opening turn, a synthetic turn, and a thread with no session yet (`goal <objective>` then starts a conversation, #1068). The intercept sits in the busy branch of the fence, in the same-tick lost race (`runInitial` → `busy`), and in the idle immediate-control branch (so an idle `goal done` that promotes the next goal also takes the slot through the fence).
- **Every ingress reaches it.** A typed thread message, `@bot goal …` (the event router strips the bot mention), `@bot /z goal …` in a thread that has a session (the event router hands it to the host pipeline as typed instead of running it inside ZRouter — `EventRouter.isThreadGoalCommand`; with no session in the thread nothing can be running, so ZRouter keeps it), and a file upload in an existing session (the bot mention is stripped there too).
- **Same gate as the drain.** The author is checked with `authorizeFollowupDispatch` (acceptance + working directory) before anything runs; a refusal keeps the old queue path, where the drain shows the refusal.
- **No epoch bump.** The intake never reaches `processMessage`, so `resetGoalContinuationOnUserMessage` does not run: a goal appended behind the running goal leaves that goal's in-flight eval valid (M1). The same holds for a goal command that does reach `processMessage` (idle `goal <objective>`, or an item parked before this release and restored after a restart): commands are routed and a consumed one returns before the real-user-message reset, and `GoalHandler`'s queued branch only saves.
- **Opening turn admitted with the mutation.** When the command starts a goal (none in flight) or `goal done` promotes the next queued goal, `GoalHandler` receives `CommandContext.admitOpening` and calls it in the same synchronous step as the mutation — before any Slack write — with `cause: 'set' | 'promoted'`. `admitGoalOpeningTurn` feeds the opening to `handleMessage` without awaiting; the fence has no await before `queue.enqueue` / `runInitial`, so on return the turn is either parked (`queued`) or holds the slot (`started`). The result is read back from those two facts. Anything else is a failure: `GoalHandler` restores the pre-mutation snapshot (`snapshotGoalState` / `restoreGoalState`), persists it and says so — it never falls back to `continueWithPrompt`. A failed notice after a successful admission is only logged.
- **What the opening turn is.** The objective, verbatim (`routeContext.verbatimPrompt` + `routeContext.goalOpeningId`). For a `goal … $skill` split it is the `$skill` part instead (`GoalOpening.prompt`, `goalOpeningId` only), routed as a command when it runs so the skill is resolved then; if it no longer yields a prompt (handled or not), the turn runs the objective (`ensureGoalOpeningPrompt`). Attachments ride on the opening of the goal the message SET (`cause: 'set'`), never on a promoted goal. When the goal queues behind the one in flight there is no opening to carry them: a `$skill` part or an attachment that cannot ride along is announced, never dropped silently.
- **The opening turn waits, it is not steered.** An event with `goalOpeningId` is never steered into the running turn (`isSteerableText`), so the new goal's first instruction gets its own turn. While it waits, §3.6 holds the goal driver, and `handleAssistantTurnCompleteForGoal` does not stash the running turn's text as evidence for the new goal (`isGoalOpeningOutstanding`).
- **The goal records whether its first turn ran.** `goal.openingPending` is set when the opening is admitted (the callers' snapshots predate it, so a refused admission removes it again) and cleared right before the opening's model call (`markGoalOpeningStarted`). It is persisted with the goal. A throw while admitting is reported as a failed admission, so the caller restores its snapshot.
- **Stale openings are skipped.** `processMessage` runs a `goalOpeningId` event only while that goal is still the active goal — on the first dispatch, after a wait in the queue, and on `Send now` alike. Otherwise it posts a notice and settles `safe`. A goal paused before its first turn keeps `openingPending`, and `goal resume` then re-admits the opening with the resume (`cause: 'resumed'`; refused admission → stays paused). A goal that already had its first turn resumes as before ("It will be injected into future prompts"). A goal has at most one opening: admission reuses an opening of the same goal that still waits or is being dispatched — except one `isStaleGoalOpening` already committed to skipping (`skippedGoalOpenings`), so `goal pause` + `goal resume` never runs the objective twice and never loses it.
- **Cancelling the opening cancels the goal.** The queued opening sits on the user's own `goal …` message (or the notice that started the goal), so its Cancel control means "cancel this goal" — while the goal's first turn has not run (`openingPending`; a row a Retry put back into `queued` after it ran is an ordinary cancel). Only the session owner or the goal's author may press it (`vetoGoalOpeningCancel`; interrupting is not enough). In the same synchronous step as the queue write the goal is paused and its epoch bumped (`onGoalOpeningCancelled`) — no driver or in-flight eval can act on it — then it is deleted through the host action, which promotes the next queued goal with its own opening. If the delete fails, the goal stays paused (and `goal resume` restarts it from its first turn) and the thread is told: an active goal never sits without its first turn.
- **Attachments in a second envelope.** A mention with files can arrive as `app_mention` without them and then `file_share` with them, same `channel:ts`. The second copy is a redelivery of the goal command, so its files are attached to the queued opening of the goal the first copy set (`FollowupQueue.attachFilesQueued`); when that opening is no longer waiting (or the goal queued), the thread is told.
- **Edits.** Editing the `goal …` message after it ran does not rewrite its queued opening (`handleQueuedMessageEdit` skips `goalOpeningId` items and says once that the edit was not applied).
- **Redelivery.** A goal-command event is claimed by `channel:ts` before it runs; a Slack redelivery of the same event is ignored on every path. A user's resend is a new event and always runs. The claim is released only when the command fails before `GoalHandler` could change anything (a throw from `CommandRouter.route` — goal handlers' own crashes are consumed there with a visible notice, including the split branch).

## Dashboard Goal List

The dashboard work item (expanded card) shows the session's goal list and lets the owner change it (requested 2026-10-21).

- **Read.** `KanbanSession.goal = { current?: { goalId, objective, status: active|paused|complete, continuationCount, maxContinuations, lastEvalReason? }, queue: [{ goalId, objective }], completedCount }`, built by `goalToKanban` in `src/conversation/dashboard.ts`. The card renders the objective, a status badge, `N/max` auto-continuations, what the last eval said is missing, the queued goals in start order and the completed count.
- **Write.** `POST /api/dashboard/session/:key/goal` with `{ action: 'add', objective }` or `{ action: 'delete', goalId, expect: 'current' | 'queued' }`, behind the dashboard auth, CSRF and owner gate (`resolveSelfActionKeyAndOwner`). The handler is `SlackHandler.handleHostGoalAction`; refusals are `HostGoalActionError` with the HTTP status: 400 invalid objective, 403 the author would be refused by the drain (`authorizeFollowupDispatch`, checked before anything is posted and again before the change), 404 no session, 409 closed or replaced session, or a stale `expect` (the goal is no longer where the card saw it), 502 the thread notice could not be posted (nothing changed), 503 the opening turn could not be admitted (rolled back).
- **Semantics.** `add` goes through `enqueueOrActivateGoal` like the typed command. Deleting the current goal is `deleteGoalById`: the next queued goal is promoted and the deleted goal is not archived as complete. There is no dashboard `clear` — `goal clear` also drops the queue and history. The running turn is never cut.
- **Order.** A thread notice is posted first (it anchors the opening turn's reactions; if it fails nothing changes), then the state is re-checked, mutated, persisted and the opening turn admitted in one synchronous step, exactly as for typed commands. For `add`, whether the goal starts or queues is only known after that await, so nothing before it depends on it: the author is checked unconditionally, the notice is neutral (`🎯 Goal added via dashboard`), and after the await the session identity and the author are re-checked; a queued result posts its position.
- **Slack goal-list Delete button.** For a current or queued goal it calls the same host action (late-bound through `setHostGoalActionHandler`), so a promoted goal starts with its opening turn instead of a bare loop kick. A completed (history) goal is still removed locally.
- **Card UI.** Controls are disabled for non-owners, sibling instances and closed sessions; the add box appears only on a live owner card. While the add box has focus the card body is not re-rendered (typing and IME composition stay intact); an unfocused draft is carried into the next render.

## Per-Goal Accounting (T3)

Each goal live-accumulates its own spend while it is the active goal: `activeMsUsed` (folded by the turn timer — `beginTurn`/`endTurn`/load-time orphan sweep) and `tokensInput/Output/CacheRead/CacheCreate` + `costUsd` (the same aggregate deltas added to `session.usage.total*`, credited in `updateSessionUsage`). Live accumulation is used rather than a snapshot-diff of `session.usage` because `session.usage` is in-memory and reset on compaction. Bare `goal` renders the current goal, the queue, and the completed history, each with its time/token spend and completion result.

## Restart Resume (T1)

The goal, queue, and history are persisted, so they survive a process restart. On startup, after crash-recovery notices are posted, `SlackHandler.resumeActiveGoals()` scans **all** loaded sessions (not only the crash-recovered set — a goal session that was idle between continuations at shutdown is not flagged as crash-recovered) and, for every session whose `goal.status==='active'`, forces a stale `activityState` to `idle` and re-triggers the goal loop (`goalTurnSettledHandler`). A session saved `waiting` on a question it asked (`actionPanel.waitingForChoice` or a recorded `pendingQuestion`) is not stale — no turn has to run for the question to stay open — so it stays `waiting` and its goal is not re-triggered; the answer runs as the user's turn and its idle settle drives the loop (2026-11-02: forcing it idle ran ten continuations over the unanswered question until the cap decision asked next to it). The completion eval runs first against the persisted `lastAssistantTurnSummary`, then completes / advances / continues. Crash-recovery's generic auto-resume **skips** active-goal sessions so the goal loop is the sole resumer (no double turn).

## Persistence

`SessionRegistry.saveSessions()` must persist sessions that have a `sessionId`, a `handoffContext`, a `goal`, a non-empty `goalQueue`, or a non-empty `goalHistory`. This preserves a goal set before the first model turn and the multi-goal queue/history across restarts. `migrateLegacyGoal` backfills `goalId` for goals persisted before the field existed.

`resetSessionContext()` clears the goal because `/new` and `/renew` create a fresh logical conversation in the same Slack thread.

## `/z` Surface

Thread/app-mention `/z goal ...` translates to the same legacy text and routes through `GoalHandler`.

Slack slash `/z goal ...` is forbidden because Slack slash commands do not carry a real thread context, and goals are session/thread scoped.

The `/z` help card can expose a read-only `goal` topic card that documents the command. `goal` is intentionally not added to the non-admin DM safe-topic allowlist because `goal set <objective>` can continue into model execution.

## Non-Goals

- No token-**budget** enforcement: per-goal time/token spend is tracked and displayed (T3), but it does not bound the loop — the ralph loop is bounded by `maxContinuations`, not by a token budget.
- No Slack Block Kit buttons for setting or completing goals. (The goal list has Delete / Update buttons, and the dashboard work item can add and delete goals — see §Dashboard Goal List.)
