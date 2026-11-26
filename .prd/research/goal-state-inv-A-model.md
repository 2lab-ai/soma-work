# Inventory A — goal data model and its pure transitions

Repo: `soma-work_20261126_184702_goal-state-machine` at `cda77e0a` (2026-11-26). Read-only.
Region: `packages/slack/src/session-goal.ts`, `src/slack/{goal-continuation,goal-cap-decision,goal-stall,goal-task-gate,session-goal-lifecycle,goal-loop-resume,goal-host-actions}.ts`, `src/task-turn/task-goal.ts`, the goal types in `src/types.ts` and `packages/slack/src/pipeline/types.ts`, and `docs/goal-command/spec.md`.
Writers and readers outside the region are listed where they write a region field; their surrounding logic is the other inventories' job.

Abbreviations: `SG` = `packages/slack/src/session-goal.ts`, `GC` = `src/slack/goal-continuation.ts`, `CD` = `src/slack/goal-cap-decision.ts`, `ST` = `src/slack/goal-stall.ts`, `TG` = `src/slack/goal-task-gate.ts`, `LC` = `src/slack/session-goal-lifecycle.ts`, `LR` = `src/slack/goal-loop-resume.ts`, `EV` = `src/slack/goal-completion-evaluator.ts`, `CTL` = `src/slack/goal-loop-controller.ts`, `GH` = `src/slack/commands/goal-handler.ts`, `GA` = `src/slack/actions/goal-action-handler.ts`, `SH` = `src/slack-handler.ts`, `SR` = `src/session-registry.ts`, `T` = `src/types.ts`, `PT` = `packages/slack/src/pipeline/types.ts`.

Headline facts:

- The declared state is one field, `goal.status` (`'active' | 'paused' | 'complete' | 'queued'`, `T:202`, mirrored `SG:20`). The working state of the loop is not in it. "Running", "waiting for the cap answer", "stalled", "eval in flight", "eval backing off", "opening not yet run", "paused in the slot" and "paused on the shelf" are all `status: 'active'` or `status: 'paused'` plus other fields.
- Status lives in two places at once: the `status` field and which container holds the object (`session.goal`, `goalQueue`, `goalPaused`, `goalHistory`). They can disagree: `paused` exists both in the slot and on the shelf; a `complete` goal sits in the slot and in the history at the same time (the same object until a restart, two copies after).
- Goal state is also held in module-level mutable singletons (`SG:380`, `SG:410`, `CD:66`, `CD:267`, `ST:88`, `LR:15`, `LR:33`) and a separate on-disk journal (`DATA_DIR/goal-cap-dm-sync.json`, `CD:270`).
- 10 places write `status`, 11 write `continuationCount`, 8 write `epoch` directly plus 3 calls to `bumpGoalEpoch`. Only part of them go through the helpers in `SG`.

---

## 1. State variables

### 1a. Persisted on `SessionGoal` (`T:229-400`; structural mirror `SessionGoalState` `SG:80-148`)

| Field | Type / values | Writers (file:line — condition) | Main readers (file:line — decision it drives) |
|---|---|---|---|
| `goalId` | string, set once | `SG:201` create active; `SG:227` create queued; `LC:98-100` backfill `goal-legacy-<createdAt>-<rand>` when missing on load | `SG:288,299-307` lookup; `SG:523-535` delete; `CD:161` answer stale check; `CTL` epoch snapshot `{epoch, goalId}` (`CTL:511`); `SH:4603,4696` opening match; `LC:48` leg credit |
| `objective` | string ≤4000 | create `SG:202,228`; **`GA:270` objective Update (in place, any container via `findGoalById` `GA:256`)** | prompt block `src/prompt/session-goal-block.ts:42-46`; eval dispatch `CTL:451`; `SG:265-290` duplicate detection |
| `status` | `'active' \| 'paused' \| 'complete' \| 'queued'` (+ legacy `'blocked'` coerced on load) | `SG:474` rebase→active; `SG:598` pause→paused (moves to shelf); `SG:642` pause in place; `SG:737` resume behind running goal→queued; `CD:202` Continue→active; `CD:204` Cancel→paused **in slot**; `CD:221` rollback on failed save; `EV:324` eval complete; `GH:466` `goal done` (any status, incl. already complete); `SH:10203` opening cancelled→paused **in slot**; `LC:93-95` `'blocked'`→`'paused'` on load | see §2 — tested at ≥40 sites; driver gate `EV:468`; prompt `session-goal-block.ts:42`; `SG:262` in-flight; `CD:92`; `LC:48,61`; `SR:4411` sleep-on-load exemption; `SH:3026,3643,4676,7217,7589,8580,8676,8690,8779,8990,9247,10133,10142,10159`; dashboard `dashboard.ts:2589,2625,2685,2708`; `follow-up-question.ts:105`; `goal-blocks.ts:177,188` |
| `createdAt` / `createdBy` | number / Slack user id | create only (`SG:204,206,230,232`) | `CD:162` only the owner may answer the cap decision; `SH` opening author (`promoted.createdBy`, `SH:9877,9890`); `LC:99` legacy id |
| `updatedAt` | number | `SG:371,477,601,645,739`; `CD:206,222`; `ST:75`; `EV:334,353,365,432`; `CTL:513`; `GA:271`; `GH:151,439,476`; `SH:10205` | **`SG:726` — tie-break: which paused goal `goal resume` (no index) picks** (slot-paused vs newest shelf entry). Any later write to `updatedAt` on either goal changes the choice. |
| `continuationCount` | int ≥0 | reset 0: `SG:368` (budget/stall restart on goal add), `SG:475` rebase, `GC:66` real user message, `CD:201` Continue, `GH:438` `goal resume` on a stall; `CD:220` rollback; +1: `EV:430` `continue` verdict; −1 refunds: `CTL:791` turn started during eval, `SH:7602` continuation dropped at busy slot (sameIntent && !capDecisionOpen), `SH:8702` failed restart resume hand-back (!capDecisionOpen), `SH:8846` restart cut turn (!capDecisionOpen) | `EV:426` cap check (`>= maxContinuations` ⇒ `cap-paused`); `SG:366` "stopped at budget" on goal add; dashboard `dashboard.ts:2713`; `goal-blocks.ts:178`; continuation prompt text |
| `maxContinuations` | int 1..1000 (default 10, `T:211` and duplicate constant `SG:28`) | create `SG:208,234`; **`GH:150` `goal max N` on an active or paused goal (no retire, no count reset)**; `LC:113-116` backfill | `EV:426`; `SG:366`; dashboard `dashboard.ts:2714,2692`; cap DM text |
| `lastContinuationAt` | number | `EV:431` only | none in the region (types-only field; **absent from the package mirror `SG:80-148`**) |
| `capDmPendingAt` | number \| undefined — "cap decision open" | open `CD:105`; clear `CD:260` (endDecision via answer/retire), `SG:381` default retirer, `SG:684` undoPause, `CD:217` rollback | `CD:92` `isGoalCapDecisionPending`; `CD:100` open dedupe; `CD:250` broadcast-on-retire; `dashboard.ts:2686`; `follow-up-question.ts:108`; `index.ts:2642` restart DM-journal flush; `SH:7599,8701,8839` refund suppression |
| `capDecisionId` | uuid — round id | `CD:106` open; **`CD:102` assigned inside `openGoalCapDecision` when an id-less legacy round exists (a mutation in a "return false" path)**; clear `CD:261`, `SG:382`, `SG:685`; rollback `CD:218` | `CD:164-170` answer staleness; `CTL:713` DM button value; `dashboard.ts:2687` (card needs it); `follow-up-question.ts:108`; `index.ts:2642` |
| `capDmRef` | `{channel, ts}` | `CD:118` after DM post (pending && same round && no ref); clear `CD:107` (new round), `CD:262`, `SG:383`, `SG:686`; rollback `CD:219` | `CTL:718` "DM not sent yet ⇒ retry it"; `CD:173` answer rewrites the DM; `CD:251` retire rewrites it |
| `openingPending` | boolean \| undefined — "first turn admitted, not yet at the model" | `SH:4604` set at admission; `SH:4697` cleared at model boundary (`markGoalOpeningStarted`); `GH:395` cleared on in-slot resume without host intake. Kept through pause (`SG:577`), cleared by nothing in `SG` (rebase keeps it) | `SH:10162` cancel-of-opening = cancel-the-goal veto. **Not read by `goal resume`** — both resume paths re-admit the objective unconditionally (`GH:398`, `SH:10111`) |
| `heldTaskIds` / `heldListAt` | string[] / number (TaskLedger.updatedAt) | `SG:669-670` `holdOpenTasks` on pause (both pause functions); cleared `SG:487-488` rebase | `TG:98-110` `heldByWaitingGoals` (goalPaused + goalQueue only; **not a goal paused in the slot**); `SG:663-667` dedupe across waiting goals |
| `pendingEval` | `{requestedAt, turnId}` — eval lease | set `CTL:512`; clear `CTL:566,581,592,1017,1052`, `EV:328,349,364`, `GH:471`, `SG:478,499` (rebase / dropScheduledEval), `LC:89-91` on every load, `SR:2065` on revive | `EV:469` driver gate; `follow-up-question.ts:106`; dashboard RUNNING card; `CTL:566-592` lease identity `requestedAt === startedAt` |
| `lastEvalReason` | string — the last gap | `EV:350` failure verdict (incl. reused verdicts); clear `EV:329` complete, `GH:472` done, `GA:283` objective update, `SG:479` rebase | `EV:385` stall needs a previous reason; `ST:252` first-failure "same reason"; `CTL:472` reuse needs a gap; continuation prompt; dashboard `dashboard.ts:2715`; cap card reason `dashboard.ts:2693` |
| `lastEvalRemaining` | string[] | `EV:351`; clear `SG:480`, `GA:284` | eval `<previous-evaluation>` (`CTL:540-542`); reused verdict `CTL:498` |
| `lastEvalGateOpen` | string[] — task ids the task gate held | `CTL:637` (judged verdicts only); clear `EV:330`, `GH:473`, `GA:285`, `SG:481` | `TG:142` `taskGateGapClosed`; `TG:183` repeated hold ⇒ synthetic stall verdict |
| `stall` | `SessionGoalStall` (`SG:38-59`) — "stopped on same failure, owner asked" | open `ST:74` (from `CTL:821`); clear `ST:102` `retireGoalStall`, `SG:384` default retirer, `SG:482` rebase (**bypasses the retired listener**), `SG:683` undoPause (bypasses listener) | `EV:471` driver gate; `SG:365` "stalled" on goal add; `GH:343` `goal resume` meaning; `ST:229-230` question still current; `ST:178,182` rollback offer; `SH:8789-8791` false-stall repair on restart; `follow-up-question.ts:106`; dashboard `dashboard.ts:2718` (shown regardless of status) |
| `stall.questionTurnId` | string | `SH:9231` after the question posts | retract on retire (`SH.onGoalStallRetired`) |
| `stall.rollbackAnchor/Turns/KeptUntil` | string/number/number | `ST:66-71` at open, from `goalStallRollbackOffer` `ST:267-278` | `ST:178-188` rollback request; stall question second item `ST:134-147` |
| `firstFailure` | `{anchor?, at, turns, progressed}` | `ST:249` cleared on complete verdict; `ST:254` new reason; `ST:258-259` increments; `CTL:484` `progressed=true` on no-text reuse; `src/claude-handler.ts:1587` cleared when any rollback applies; `SG:483` rebase | `ST:273-277` rollback offer |
| `evalAttemptCount` | int | `EV:333` complete, `EV:352` failure (**also on reused verdicts where no eval ran**); create sets 0; backfill `LC:117` | audit/display only |
| `evalDispatchRetryCount` | int | `CTL:1078` +1 on dispatch failure; clear `CTL:554,1020,1101`, `GC:75`, `SG:500` | `CTL` retry budget (3) |
| `evalBackoffUntil` / `evalRetryReason` | ms / string | set `CTL:1082-1083`; clear `CTL:555-556,1021-1022,1102,1151-1152`, `GC:40-41` (bumpGoalEpoch), `GC:76-77`, `SG:501-502` | `CTL:435` runOnce gate (re-arms a retry for the rest of the window); `follow-up-question.ts:107`; dashboard RUNNING card |
| `epoch` | int, monotonic — intent version | `SG:210` create (prior+1); `SG:236` queued=0; `SG:476` rebase max(own, prior)+1; `SG:600,644` pause; `GC:33` `bumpGoalEpoch` (callers `GC:80`, `GH:656` persistGoalChange, `SH:10275` persistHostGoalMutation); `CD:210` answer; `CD:223` rollback; **`GA:275` objective update (inline, not `bumpGoalEpoch`)**; `SR:2064` revive | `CTL` `epochStillValid` discard (M1); `CTL:1151` retry fire; `SH:7598` `goalContinuationSpent` refund match; `LC:63` leg epoch |
| `lastAssistantTurnSummary` | string ≤16k | `SH:3676` turn-end stash; clear `GA:282`, `SG:485` | `CTL:399` evidence after restart; `SH:8788` false-stall test (no turn text) |
| `lastEvalSummaryHash` | string | `CTL:646` (cleared on complete); clear `GA:286`, `SG:484` | `CTL:473` S9 reuse on kicks |
| `completedAt` / `completedBy` / `completedVia` / `completionReason` | audit | `EV:325-327` + `CTL:652` (eval); `GH:467-470` (`goal done`, **also re-stamps an already-complete goal**) | `goal-blocks.ts:180-184`; dashboard history `dashboard.ts:2759-2762` |
| `activeMsUsed`, `tokens*`, `costUsd` | accumulators | `LC:50` (time); `updateSessionUsage` (tokens) | display |

### 1b. Persisted on `ConversationSession`

| Field | Type | Writers | Main readers |
|---|---|---|---|
| `goal` (`T:863`) | SessionGoal \| undefined — "the slot" | `SG:255` apply; `SG:455-456` advance with empty queue (keep finished or clear); `SG:562,612` delete/pause with empty queue; `SG:811` restore; `GH:532` clear; **`SR:3334` `resetSessionContext` (`/new`, `/renew`) — clears only the slot**; **`packages/slack/src/pipeline/session-initializer.ts:1477` bot-thread migration `structuredClone(session.goal)` (queue/paused/history not carried; epoch not bumped; open cap round and stall copied)**; `SR:2101` revive; load `SR:4167,4581` | everything |
| `goalQueue` (`T:872`) | SessionGoal[] FIFO, each `status:'queued'` | `SG:342-343` append; `SG:453,555,605` shift on promote; `SG:524` delete; `SG:740-741` resume unshift; `SG:812` restore; `GH:533` clear. **Not cleared by `resetSessionContext` (`SR:3330-3334`); not archived (`src/session-archive.ts:137-141,253-255`); not carried on bot migration** | `SG:340` decides queue-vs-activate only through the slot; `SH:3027` autogoal skip; `SH:8764` stranded-queue repair; `TG:105`; dashboard queue list |
| `goalPaused` (`T:882`) | SessionGoal[] "shelf", each `status:'paused'` | `SG:528` delete; `SG:603-604` pause push; `SG:734,747` resume; `SG:813` restore; `GH:534` clear | `SG:283-285` SET_GOAL dedupe; `SG:716-731` resume target; `TG:105`; `SG:664` |
| `goalHistory` (`T:891`) | SessionGoal[] ≤20 | `SG:440-449` archive on advance (id-dedupe); `SG:532` delete; `SG:814` restore; `GH:535` clear | `SG:307` lookup; dashboard `completedCount`; `SG:444` idempotency |
| `activeLegGoalId` / `activeLegGoalEpoch` (`T:1160,1169`) | string / number | `LC:62-63` at beginTurn — **only an `active` slot goal** | `LC:48` time credit; turn-end evidence stash (in-turn objective change) |

### 1c. Runtime-only on the session

| Field | Writers | Readers |
|---|---|---|
| `goalLastTurnText` (`T:900`) | `SH:3672` turn end; clear `SG:257,457,563,613`, `GH:536`, `GA:281`; restore `SG:815` | `CTL:399` evidence (precedence over the persisted mirror); `SH:8788` false-stall |
| `systemPrompt` (`T:850`) — cached prompt that embeds the `<session-goal>` block | clear `SG:256,458,564,614,649`, `CD:211`, `CTL:514,647`, `GH:657`, `GA:276`, `SH:10276`; restore `SG:818`. **Not cleared by `resumePausedGoal`'s `next` placement (`SG:736-743`), by `holdOpenTasks`, nor by `GH:150` (`goal max`, but persistGoalChange clears it)** | prompt builder |

### 1d. Per-turn flags on `routeContext` (`PT`)

| Flag | Meaning | Notes |
|---|---|---|
| `goalContinuation` (`PT:206`) | synthetic continuation, never supersedes | dropped at a busy slot (`SH:7587`) |
| `goalContinuationSpent` (`PT:213`) | `{goalId, epoch}` of the continuation spent | refund only while the same goal and epoch are live (`SH:7596-7603`) |
| `goalOpeningId` (`PT:239`) | the opening turn of goal X | run only while X is the `active` slot goal (`SH:4676`) |
| `verbatimPrompt` (`PT:230`), `hostTurn` (`PT:199`), `autoResume` (`PT:221`) | dispatch shape | also decide whether a turn counts as "the user's word" |

### 1e. Module-level mutable state in the region (in-memory, per process)

| Name | Where | What it holds | Hazard |
|---|---|---|---|
| `capDecisionRetirer` | `SG:380-385`, set by `setGoalCapDecisionRetirer` `SG:388` from `index.ts:2621` | how "end the cap decision" behaves. Default only clears fields (also `stall`, without calling `retireGoalStall` ⇒ no question retraction, no DM rewrite). Production = `retireGoalCapDecision` | wired inside a `try` that logs failure as non-critical (`index.ts:2645-2647`); until/unless it runs, every `SG` pause/delete/resume/goal-add ends rounds silently |
| `resumedFromStall` | `SG:410` WeakSet | "this goal was restarted out of a stall" for the notice line | set `SG:367`, consumed only by `formatResumedGoalLine` `SG:403`; callers that never format (e.g. `index.ts:1638` `openPlanGoal`) leave the mark behind |
| `surfaces` | `CD:66` | DM updater + board broadcaster | |
| `rewrites` | `CD:267`, file `DATA_DIR/goal-cap-dm-sync.json` (`CD:270`) | DM rewrites pending delivery, tagged with the round id | survives the goal; restart drops entries whose round is "still open" by `index.ts:2641-2643` (looks only at `s.goal`) |
| DM retry timers | `CD:392` | retries 2s/15s/60s | lost on restart (journal replays) |
| `onRetired` | `ST:88`, set `SH:1008` | stall-retired listener (retract question) | swallowed errors `ST:105-107` |
| `resumeFn` / `hostGoalActionFn` | `LR:15,33`, set `index.ts:2600,2610` | loop kick / host goal action | no-op until wired (`LR:24`) |

Outside the region but holding goal state (for the other inventories): `followupSlotHeldGoalSessions`, `goalDriverKickOnRelease` (`SH:7590-7591`), `restartResumedSessionKeys`, `restartCutSessionKeys`, `restartGoalPassRan` (`SH:8676-8678,8801,8844,8904`), `skippedGoalOpenings`, the controller's per-session promise queue and retry timers (`CTL`).

---

## 2. Implicit states

Each row: the fields, where code tests for it, and whether the testers agree.

### 2.1 "Running" (loop may drive the goal)
- Fields: slot goal, `status==='active'`, `!pendingEval`, `!stall`, no live request, `activityState==='idle'`.
- Testers: `EV:466-475` (`shouldRunGoalIdleDriver`); `CTL:435` adds `evalBackoffUntil`; `CTL:399-427` adds `awaitingHostWork`; `CTL:391` adds `safeguardHalt`.
- **Not tested anywhere on this path: `capDmPendingAt`.** A goal with an open cap decision passes the driver gate.
- Other "is it running" readers use `status==='active'` alone: `SR:4411` (sleep exemption), `SH:9247` (`notWithActiveGoal`), `SH:8990` (retry rearm), `stampActiveLegGoalOwner` `LC:61`, prompt block `session-goal-block.ts:42`, `goal-blocks.ts:189` (shows ⏸️ pause button). They count a stalled, cap-stopped or opening-pending goal as running.
- **Disagree.**

### 2.2 "Stopped at budget, owner asked" (cap decision)
- Fields: `status==='active'` ∧ `continuationCount >= maxContinuations` ∧ `capDmPendingAt !== undefined` (+ `capDecisionId`, `capDmRef`).
- Testers (seven, not identical):
  1. `CD:92` `isGoalCapDecisionPending`: active ∧ `capDmPendingAt` defined.
  2. `CD:100` (open dedupe): `capDmPendingAt` defined, any status.
  3. `CD:250` (retire broadcast): `capDmPendingAt` defined, any status.
  4. `CD:163-170` answer: (1) ∧ id matches, or id-less legacy round answered only by an id-less button.
  5. `dashboard.ts:2685-2687`: active ∧ finite `capDmPendingAt` ∧ non-empty `capDecisionId` — a legacy id-less round is invisible on the dashboard.
  6. `follow-up-question.ts:105-108`: active ∧ `capDecisionId` ∧ `capDmPendingAt`.
  7. `index.ts:2641-2643` restart flush: `capDecisionId===id ∧ capDmPendingAt` defined, any status, slot only.
- "Stopped at budget" without the decision is tested separately: `SG:366` (`continuationCount >= maxContinuations`, no look at `capDmPendingAt`), `EV:426`.
- The two halves can split: count < max with a decision open (after `goal max` raised the cap, `GH:150`), or count ≥ max with no decision (after `goal max` lowered it, before the next eval; or after an objective update which retires nothing).
- An explicit field for this state existed for one day: `capReachedAt` (commit `789a3525`, #581) — reverted by `85783005` (#585).
- **Disagree.**

### 2.3 "Stalled" (stopped on the same failure, owner asked)
- Fields: `status==='active'` ∧ `stall` set.
- Testers: `EV:471` (gate, given active); `SG:365` (active ∧ stall); `GH:343` (active ∧ stall ⇒ `goal resume` means "run again"); `ST:229-230` (`stallId` match; status not checked); `follow-up-question.ts:105-106` (active ∧ stall); `SH:8789` (stall ∧ no turn text ⇒ "false stall", retire); dashboard `dashboard.ts:2718` (stall, status not checked).
- `stall` and cap decision are meant to be exclusive: `CTL:820` retires the cap decision before `openGoalStall`. Nothing prevents a cap decision opening on a stalled goal except the driver gate.
- Mostly agree on "active ∧ stall"; dashboard and `shouldAskGoalStallQuestion` ignore status.

### 2.4 "Eval in flight"
- Fields: `pendingEval` set (lease) + the controller's in-memory queue.
- Testers: `EV:469`; `follow-up-question.ts:106`; dashboard RUNNING.
- The persisted lease is meaningless after a restart and is dropped on every load (`LC:89-91`) and on revive (`SR:2065`). A real user message does **not** clear it (`GC:54-58`); the epoch bump (`GC:80`) makes the verdict a discard instead.
- So "eval in flight" is inferred from a persisted field that is only true inside one process.

### 2.5 "Eval backing off"
- Fields: `evalBackoffUntil > now` (+ `evalRetryReason`, `evalDispatchRetryCount`, an in-memory timer).
- Testers: `CTL:435`; `follow-up-question.ts:107`; dashboard.
- Cleared by `bumpGoalEpoch` (`GC:40-41`) but **not** by the inline epoch bumps at `GA:275`, `CD:210`, `SR:2064`.

### 2.6 "Paused in the slot" vs "paused on the shelf"
- Fields: `session.goal.status==='paused'` vs `goalPaused[i].status==='paused'`.
- Creators of slot-paused: cap Cancel `CD:204`; stop-with-queue `SG:642`; opening cancelled `SH:10203`; legacy `'blocked'` on load `LC:93-95`; records from before the shelf existed.
- Slot-paused counts as **in flight** (`SG:262`) ⇒ every goal added queues behind it (`SG:340`), and the queue waits until the owner resumes it. The spec calls this out as "Not yet" (`spec.md:228`).
- Testers: `SG:262`, `SG:596`, `SG:718`, `GH:149` (`goal max` applies to paused too), `GH:341`, `SH:3026`, `SH:8764-8765` (restart repair must not advance past it), `SH:10133`, `SH:10142`, `goal-blocks.ts:189` (▶️), `stream-executor.ts:6858`.
- `heldByWaitingGoals` (`TG:105`) and `holdOpenTasks` (`SG:664`) ignore a slot-paused goal's `heldTaskIds`.
- `pauseCurrentGoalHoldingQueue` sets `heldTaskIds` on the slot goal (`SG:648`); cap Cancel (`CD:204`) and `onGoalOpeningCancelled` (`SH:10203`) do not, and do not drop the eval lease (`dropScheduledEval` not called).
- **Three creators leave three different field sets.**

### 2.7 "Opening owed" (first turn not run)
- Fields: `openingPending===true` (+ a follow-up-queue item carrying `goalOpeningId`).
- Testers: `SH:10162` only (cancel veto). `goal resume` ignores it (re-admits the objective always: `GH:398`, `SH:10111`), whereas `spec.md:257` still says a goal that already had its first turn "resumes as before".
- `rebaseGoalAsActive` keeps it (`SG:473-490` does not touch it).

### 2.8 "No current goal, queue non-empty"
- Arises from `resetSessionContext` (`SR:3333-3334`, queue kept), and from a crash between status flip and advance (`CTL:654-661` comment).
- Testers disagree on what it means:
  - `SH:8764-8766` restart pass: "stranded" ⇒ `advanceGoalQueue` promotes the head (no opening turn admitted, `openingPending` not set).
  - `SG:340-349` `enqueueOrActivateGoal`: no goal in flight ⇒ the NEW objective activates at once, ahead of the waiting queue.
  - `SH:3027` autogoal: queue non-empty ⇒ do not autogoal.
- **Disagree.**

### 2.9 "Completed goal kept in the slot"
- Fields: `session.goal.status==='complete'` ∧ same `goalId` in `goalHistory` (same object in memory: `SG:446` + `SG:456`).
- After a save/load the two become separate objects (`SR:4167,4170`; archive `session-archive.ts:253-254` serializes them separately).
- Testers that handle it: `SG:444` (idempotent archive), `SG:541-549` (`deleteCurrentGoal` by position), `dashboard.ts:2739-2741`.
- Mutations through `findGoalById` (`SG:301` returns the slot first) — `GA:270` objective update, `GH:466-476` repeated `goal done` — change the history entry too before a restart and only the slot copy after one.

### 2.10 "Queued status in the slot" / "active status in the queue"
- No code creates either, and no code rejects or repairs either: `migrateLegacyGoal` (`LC:85-119`) only coerces `'blocked'`. Dashboard drops an unknown slot status (`dashboard.ts:2589,2708`). The spec data model still lists only three statuses (`spec.md:58`), the type has four (`T:202`).

### 2.11 "Resumed behind the running goal"
- `status:'queued'` in `goalQueue` but with the paused goal's spend, `heldTaskIds`, `openingPending`, `firstFailure`, `lastEvalReason` (`SG:736-742` only drops the scheduled eval). Its `epoch` is not bumped (it is rebased when promoted).

---

## 3. Transitions

Format: from | event / function | guard | to | side effects | file:line.

### 3.1 Creation and queue (region `SG`)
| From | Event / function | Guard | To | Side effects | file:line |
|---|---|---|---|---|---|
| no goal / complete in slot | `enqueueOrActivateGoal` | slot not active/paused | new `active` in slot | `createActiveSessionGoal` (epoch = prior+1, count 0); `applyGoalToSession` clears `systemPrompt`, `goalLastTurnText`. Prior complete goal dropped from slot (already in history) | `SG:347-349`, `SG:188-212`, `SG:251-258` |
| active/paused in slot | `enqueueOrActivateGoal` | in flight | new `queued` appended | `createQueuedSessionGoal` (epoch 0) | `SG:340-345` |
| active at budget or stalled | same call (side transition) | `status==='active' ∧ (count ≥ max ∨ stall)` | active, count 0 | `endGoalCapDecision` (retires cap round AND stall via the host retirer); `resumedFromStall.add`; **no epoch bump, no `systemPrompt` clear** | `SG:361-373` |
| complete or none + queue | `advanceGoalQueue` | queue non-empty | head → `active` in slot | archive finished (dedupe by id, cap 20); `rebaseGoalAsActive` (status, count 0, epoch max+1, clears eval scratch, stall **directly**, firstFailure, held tasks, scheduled eval); apply. **Does not call `endGoalCapDecision` on either goal** | `SG:434-465`, `SG:473-490` |
| any + empty queue | `advanceGoalQueue` | queue empty | slot keeps finished goal (or `undefined` with `clearCurrent`) | clears `goalLastTurnText`, `systemPrompt` | `SG:454-459` |
| queued / paused / history | `deleteGoalById` | id found in that container | removed | none (no retire) | `SG:519-534` |
| any in slot | `deleteCurrentGoal` | slot non-empty | next queued → active, else none | `endGoalCapDecision(finished)`; `rebaseGoalAsActive(next)`; `endGoalCapDecision(next)`; deleted goal not archived | `SG:550-566` |
| active or slot-paused | `pauseCurrentGoal` | status active/paused | shelf `paused`; next queued → active | retire round; `dropScheduledEval`; epoch +1; `holdOpenTasks`; dedupe shelf by id; rebase+retire next | `SG:584-616` |
| active | `pauseCurrentGoalHoldingQueue` | active ∧ queue non-empty | slot `paused` (in place) | retire; drop eval; epoch +1; hold tasks; clear `systemPrompt`. Empty queue ⇒ delegates to `pauseCurrentGoal` | `SG:633-651` |
| (after a pause) | `undoPause` | — | snapshot state | `restoreGoalState` then **force-clears `stall` and cap fields on the paused goal** (the retirer already withdrew their surfaces) | `SG:681-687` |
| shelf or slot-paused | `resumePausedGoal` | slot goal `active` | `queued` at queue head | shelf filter; `dropScheduledEval`; no retire, no epoch change on either goal | `SG:736-742` |
| shelf or slot-paused | `resumePausedGoal` | slot not active | `active` in slot | slot-paused (not the target) pushed to shelf; `endGoalCapDecision(target)`; rebase past `current?.epoch`; apply | `SG:745-752` |
| any | `restoreGoalState` | caller's admission failed | snapshot fields written back into the same objects | does **not** undo retirer side effects (DM journal, question retraction, `resumedFromStall`) | `SG:798-819` |

### 3.2 Cap decision (region `CD`)
| From | Event | Guard | To | Side effects | file:line |
|---|---|---|---|---|---|
| active, count ≥ max | `openGoalCapDecision` (from `CTL:708`) | no `capDmPendingAt` | decision open (`capDmPendingAt`, new `capDecisionId`, `capDmRef` cleared) | returns true; if already open, assigns an id to a legacy round and returns false | `CD:99-109` |
| decision open | `recordGoalCapDm` | pending ∧ same round ∧ no ref | `capDmRef` set | else journal "superseded" rewrite for the late DM | `CD:116-123` |
| decision open | `answerGoalCapDecision` continue | owner ∧ pending ∧ round id | active, count 0 | journal DM rewrite (refuse if journal write fails); `endDecision`; epoch +1; `systemPrompt` cleared; sync `save()` (full rollback of 8 fields on failure); `resumeGoalLoop`; broadcast | `CD:157-239` |
| decision open | `answerGoalCapDecision` cancel | same | **slot `paused`** | same, no loop kick; `stall` untouched; goal stays in slot | `CD:203-205` |
| decision open / stall open | `retireGoalCapDecision` | — | no decision, no stall | `retireGoalStall(goal, 'lifecycle')`; journal "superseded" DM; microtask broadcast if a round was pending | `CD:246-257` |

Callers of `retireGoalCapDecision`: `GC:71`, `EV:332`, `CTL:820`, `GH:437,475,531`, `SH:10204`; through `endGoalCapDecision`: `SG:370,554,558,597,608,641,749`, `SR:3333`.

### 3.3 Stall (region `ST`)
| From | Event | Guard | To | Side effects | file:line |
|---|---|---|---|---|---|
| active | `openGoalStall` (from `CTL:821`) | verdict `stalled` (≥0.95, prior reason) | stall open | new `stallId`; actions; optional rollback offer; `updatedAt` | `ST:54-77` |
| stall open | `retireGoalStall(goal, cause)` | stall set | no stall | listener (retract question unless `user-message`) | `ST:99-108` |
| — | `trackGoalFirstFailure` (from `CTL:639`) | judged verdict only | `firstFailure` new / +1 / cleared | must run before `decideGoalEvalOutcome` overwrites `lastEvalReason` | `ST:242-260` |

Callers of `retireGoalStall`: `GC:68` (`user-message`), `CD:249`, `GA:288`, `SH:8793`. Direct `stall = undefined` without the listener: `SG:384`, `SG:482`, `SG:683`.

### 3.4 User message and epoch (region `GC`)
| From | Event | Guard | To | Side effects | file:line |
|---|---|---|---|---|---|
| any slot goal (any status) | `resetGoalContinuationOnUserMessage` (from `SH:2875`) | slot goal exists | count 0 | stall retired (`user-message`), cap decision retired, retry streak + backoff cleared, epoch +1 (via `bumpGoalEpoch`). `pendingEval` deliberately kept | `GC:64-81` |
| any | `bumpGoalEpoch` | — | epoch +1 | clears `evalBackoffUntil`, `evalRetryReason` | `GC:32-42` |

The reset applies to a slot goal of any status, including `complete` and slot-`paused` (count reset on a paused goal; harmless but untested). Goal commands bypass it (`spec.md:252`).

### 3.5 Task gate (region `TG`, pure)
| Input | Function | Guard | Output | file:line |
|---|---|---|---|---|
| `completed` verdict | `gateGoalVerdictOnTasks` | ledger has open tasks (minus held) | `completed:false` gap; if same ids as `lastEvalGateOpen` ⇒ synthetic stall (`sameAsPrevious:true`, confidence 1, `progressed ?? true`, task actions) | `TG:160-203` |
| recorded gate gap | `taskGateGapClosed` | `lastEvalGateOpen` non-empty | true when no listed task open (or no ledger) ⇒ loop re-judges instead of reusing | `TG:137-144` |
| pause | `heldTasksOf` | ledger present | open ids + `ledger.updatedAt` | `TG:77-85` |

### 3.6 Lifecycle helpers (region `LC`)
| Event | Function | Effect | file:line |
|---|---|---|---|
| load / revive | `migrateLegacyGoal` | drop `pendingEval`; `'blocked'`→`'paused'`; backfill `goalId`, counters. Does **not** touch `stall`, cap fields, `openingPending`, `evalBackoffUntil`, `evalDispatchRetryCount`, or an out-of-union status | `LC:85-119` |
| beginTurn | `stampActiveLegGoalOwner` | leg owner = active slot goal or none | `LC:60-64` |
| leg end / orphan sweep | `creditActiveGoalMs` | credit leg owner (any container) or the active slot goal | `LC:41-51` |

### 3.7 Writers outside the region that mutate status / count / epoch / stall / cap / queue / history
| From | Event | Guard | To | Side effects | file:line |
|---|---|---|---|---|---|
| active | `applyGoalEvalSuccess` | verdict complete (after task gate) | `complete` | audit, clears pendingEval/reason/gate, retire round, `evalAttemptCount+1` | `EV:317-335` |
| active | `decideGoalEvalOutcome` | not complete | stalled / cap-paused / continue (count +1) | `applyGoalEvalFailure` (reason, remaining, `evalAttemptCount+1`) — also for **reused** verdicts (no eval ran) | `EV:406-434`, `EV:343-354` |
| active | dispatch failure | — | active | pendingEval cleared; retry count/backoff set | `EV:363-367`, `CTL:1078-1083` |
| any slot goal | `goal done` | slot non-empty (any status) | `complete` + advance | audit fields re-stamped even when already complete; retire; `advanceGoalQueue`; epoch +1 on the new slot goal | `GH:448-483` |
| active ∧ stall | `goal resume` (no index) | stall | active, count 0 | retire round; epoch +1; kick | `GH:343-344`, `GH:431-446` |
| active/paused slot | `goal max N` | — | `maxContinuations=N` | epoch +1; **no retire, no count change** | `GH:148-152` |
| any | `goal clear` | anything to clear | everything empty | retire slot round; queue/shelf/history dropped | `GH:520-537` |
| any container | objective Update modal | owner | same status, new objective | epoch +1 **inline**; clears evidence + gap + gate + hash; `retireGoalStall`; **no cap retire, no count reset, no backoff clear, `firstFailure` kept**; kick if active slot goal | `GA:256-296` |
| slot active with unrun opening | opening cancelled | `openingPending` | slot `paused` then delete | retire round; epoch +1 (`bumpGoalEpoch` via `SH:10275`); **no `dropScheduledEval`, not moved to shelf** | `SH:10194-10208` |
| active | busy-slot drop of continuation | same goal ∧ epoch ∧ count>0 ∧ no decision | count −1 | | `SH:7596-7603` |
| active | restart pass | stranded queue / false stall / cut turn | promote / retire stall / count −1 | see `SH:8755-8850` | `SH:8764-8846` |
| slot | `/new`, `/renew` | goal or sessionId | `goal = undefined` | retire round; queue/shelf/history **kept** | `SR:3330-3334` |
| archive → live | revive | — | goal restored | epoch +1, pendingEval cleared; `goalQueue` not in the archive | `SR:2062-2066`, `SR:2101-2104` |
| thread A → bot thread B | migration | goal exists | cloned slot goal | queue/shelf/history not carried; cap round and stall cloned with the same ids | `session-initializer.ts:1476-1478` |
| plan 시작 | `openPlanGoal` | — | as `enqueueOrActivateGoal` | **no loop kick and no resumed line for `resumedCurrent`; undo = plain `restoreGoalState`** | `index.ts:1635-1656` |

---

## 4. Suspicious spots

Each: what, where, a concrete failure scenario.

**S1. Plain `restoreGoalState` resurrects a decision round whose surfaces were already withdrawn.** `undoPause` (`SG:681-687`) exists because of this (commit `fee82a80`), but the other rollback sites use plain `restoreGoalState` (`GH:226`, `GH:400`, `GH:489`, `SH:9810`, `SH:9880`, `SH:9895`, `SH:10117`, `index.ts:1650`). Of these, the ones whose mutation retired a live round first are `GH:489` (`goal done` retires at `GH:475`), `SH:9880`/`SH:9895` (delete current, `SG:554`) and `index.ts:1650` (plan goal undo after `resumeGoalStoppedAtBudget` retired a cap round or stall, `SG:370`); the set/add/resume sites start from a slot with no open round. Scenario: goal A is at 10/10 with the cap DM open; a turn runs; the owner deletes A from the dashboard; `deleteCurrentGoal` calls `endGoalCapDecision(A)` (`SG:554`) → DM rewritten "no longer valid" and journalled; the promoted goal's opening admission fails → `restoreGoalState` (`SH:9895`) puts `capDmPendingAt/capDecisionId/capDmRef` back. The dashboard card shows the decision again (`dashboard.ts:2685`), the DM does not. Same with a stall: the question was retracted (session no longer `waiting`) but `goal.stall` comes back, so the driver refuses (`EV:471`) and nothing asks — the goal stops until someone writes.

**S2. Inline epoch bumps skip the fix of `a733d642`.** `bumpGoalEpoch` (`GC:32-42`) drops `evalBackoffUntil/evalRetryReason` because a retry armed for the old epoch no-ops. `GA:275` (objective update), `CD:210` (cap answer) and `SR:2064` (revive) bump the epoch inline. Scenario: an eval hits a 429 and backs off for 40 minutes; the owner edits the objective; the armed retry fires, sees a moved epoch, does nothing; the kick at `GA:295` hits the `CTL:435` gate and re-arms for the rest of the window — the edited goal waits up to the remaining window and the card advertises the old re-check.

**S3. The driver gate does not know the cap decision.** `EV:466-475` tests `pendingEval` and `stall` but not `capDmPendingAt`; `CTL:371-449` adds nothing either. Any kick while the round is open (restart pass `SH:8779-8883` kicks every active, non-stalled goal with `cause: kick` and no cap check — `SH:8883`; objective update `GA:295`) evaluates or reuses, reaches `cap-paused` again, `openGoalCapDecision` returns false, and with `capDmRef` already set the controller posts "⏹️ Goal auto-continuation paused after N turns" again (`CTL:761-766`). Each such kick also bumps `evalAttemptCount` (`EV:352`) though, on a reused verdict, no eval ran.

**S4. `goal max` splits "at budget" from "decision open".** `GH:148-152` changes `maxContinuations` without retiring the round or touching the count. Raise 10→20 while the round is open: count 10 < 20 and the round stays open; the next turn end passes the gate, the loop continues, while the DM and the dashboard card still ask "keep going?" and every refund is suppressed (`SH:7599-7600`, `SH:8701-8702`, `SH:8839-8845` test `isGoalCapDecisionPending`). Lower 20→5 at count 7: no round until the next eval; `resumeGoalStoppedAtBudget` (`SG:366`) now treats it as stopped.

**S5. "Stopped at budget" was an explicit field for one day.** `capReachedAt` (`789a3525`, #581) was reverted by `85783005` (#585). The state is now inferred from `continuationCount >= maxContinuations` at `SG:366` and `EV:426`, and from `capDmPendingAt` elsewhere (§2.2).

**S6. Seven different tests for "cap decision pending"** (§2.2). A legacy id-less round is pending for `CD:92` and the refund guards, invisible for the dashboard (`dashboard.ts:2687`) and `follow-up-question.ts:108`. `openGoalCapDecision` writes an id into it (`CD:102`) on a path that returns false, and the controller persists only when it returns true (`CTL:709-712`).

**S7. Three ways to be "paused in the slot", three field sets** (§2.6). Cap Cancel (`CD:204`) keeps `continuationCount` at max, does not `dropScheduledEval`, sets no `heldTaskIds`; `pauseCurrentGoalHoldingQueue` (`SG:642-649`) drops the eval and holds tasks; `onGoalOpeningCancelled` (`SH:10203`) bumps the epoch via `bumpGoalEpoch` but keeps `pendingEval` and `evalDispatchRetryCount`. All three make `isGoalInFlight` true (`SG:262`), so a new goal queues behind a goal that will never run on its own until the owner resumes it.

**S8. `/new` / `/renew` orphan the queue and the shelf.** `SR:3333-3334` clears only `session.goal` (spec `spec.md:302` says "clears the goal"). Scenario: goal A active with B queued; the user types `new`; the next restart's pass sees "no goal + queue" and promotes B (`SH:8764-8766`) into the fresh conversation with no opening turn; or before any restart the user types `goal C`, which activates C ahead of B (`SG:340-349`), while autogoal refuses to start because the queue is non-empty (`SH:3027`).

**S9. The archive drops `goalQueue`.** `session-archive.ts:137-141,253-255` keep `goal`, `goalHistory`, `goalPaused` only; revive restores those three (`SR:2101-2104`). Commit `32ccac71` fixed exactly this for `goalPaused`. Scenario: a session sleeps with A active and B, C queued, is archived, is revived — B and C are gone.

**S10. Bot-thread migration clones only the slot goal.** `session-initializer.ts:1476-1478` `structuredClone(session.goal)`: the queue, shelf and history stay on the terminated session; the clone keeps the open `capDecisionId`/`capDmRef` and `stall` (their DM/question point at the old thread) and the same epoch (revive bumps it, `SR:2064`; migration does not).

**S11. The completed current goal is aliased in memory and duplicated on disk** (§2.9). `advanceGoalQueue` pushes `finished` to history and keeps it in the slot (`SG:446,456`). Before a restart, `goal done` on it (`GH:466-470`) rewrites the history entry's `completedVia` from `'eval-model'` to `'user'`; after a restart only the slot copy changes. Same for an objective Update on a completed goal (`GA:256-270`).

**S12. `goal done` accepts any status and re-stamps audit fields.** `GH:455-476` guards only `!session.goal`. On an already-complete goal it overwrites `completedAt/By/Via/completionReason`; on a slot-paused goal it completes it directly (paused → complete), skipping `active`.

**S13. `rebaseGoalAsActive` clears `stall` directly** (`SG:482`), and `undoPause` too (`SG:683`), bypassing `retireGoalStall`'s listener. `advanceGoalQueue` also never calls `endGoalCapDecision` for the finished or the promoted goal (`SG:434-465`) — it relies on the caller having retired the finished goal (`EV:332`, `GH:475`); the restart repair path (`SH:8770`) calls it with no retire at all (safe only while a complete goal never carries a round).

**S14. `resumeGoalStoppedAtBudget` changes loop state without an epoch bump or prompt invalidation** (`SG:361-373`), unlike every other count reset except `GC:66` (which bumps). It also writes the `resumedFromStall` WeakSet (`SG:367`) that only `formatResumedGoalLine` clears (`SG:403`). `openPlanGoal` (`index.ts:1638-1648`) neither formats the line nor kicks the loop: a stalled goal gets its stall retired and counter reset, but nothing drives it until a turn ends; the stale WeakSet mark later makes an unrelated budget restart of the same object print "stopped on a repeated failure".

**S15. The cap-decision retirer is a swappable global wired late.** `SG:380-385` default vs `index.ts:2621` production. The default clears `stall` without `retireGoalStall` and rewrites no DM. The wiring sits in a `try` whose failure is logged "non-critical" (`index.ts:2645-2647`).

**S16. `openingPending` and `goal resume` disagree with the spec.** `spec.md:257`: a goal that already had its first turn "resumes as before". Code: both resume paths admit the objective as a new opening turn regardless of `openingPending` (`GH:398`, `SH:10111`; non-intake path returns `continueWithPrompt: goal.objective`, `GH:422`). `openingPending` is read only by the cancel veto (`SH:10162`).

**S17. Objective Update ends the stall but not the cap round** (`GA:288` vs no `retireGoalCapDecision`), keeps `firstFailure` (anchored on the old objective; a later stall can offer a rollback to a point judged against the old objective) and keeps `continuationCount`. Compare `goal resume` on a stall (`GH:437-438`: retire both, count 0) and goal add (`SG:368-370`: retire both, count 0).

**S18. `goal resume` at the cap says "already running".** `GH:343-357`: with no paused goal and an active slot goal that is not stalled, the reply is "▶️ The current goal is already running — no goal is paused", including when it is stopped on the cap decision. Goal commands skip the user-message reset (`spec.md:252`), so the goal stays stopped.

**S19. Stale type docs describe a removed mechanism.** `T:308-313` (`pendingEval` "set when the work model emits `<goal-complete-request>`") and `T:318-319` (`lastEvalReason` "cleared when the model next emits a completion sentinel"); the sentinel was removed (N10, `spec.md:179`). `spec.md:193` says the slack-handler hook stamps `pendingEval`; the controller does (`CTL:512`). `spec.md:53-78` data model omits `queued` and about 15 fields; `spec.md:78` names `SessionRegistry.migrateLegacyGoal` (now `LC:85`).

**S20. Two copies of the model.** `SessionGoalState` (`SG:80-148`) is a hand-kept mirror of `SessionGoal` (`T:229-400`) and already differs (`lastContinuationAt` missing). `DEFAULT_GOAL_MAX_CONTINUATIONS` is defined twice (`SG:28`, `T:211`). `SessionGoalStatus` twice (`SG:20`, `T:202`).

**S21. `evalAttemptCount` counts reused verdicts.** `T:344` says "how many eval cycles have run"; `EV:352` increments inside `applyGoalEvalFailure`, which `decideGoalEvalOutcome` also runs for the reused (no-eval) verdicts of `CTL:472-500`.

**S22. `heldByWaitingGoals` and `holdOpenTasks` ignore the slot-paused goal.** `TG:105`, `SG:664` iterate `goalPaused` and `goalQueue` only, though `pauseCurrentGoalHoldingQueue` stores `heldTaskIds` on the slot goal (`SG:648`). Today no other goal can run while a goal sits paused in the slot, so it is latent; it becomes live the moment any path promotes past a slot-paused goal.

**S23. `migrateLegacyGoal` repairs one proxy and keeps the others.** It drops `pendingEval` because "no eval survives a restart" (`LC:78-91`) but keeps `evalDispatchRetryCount` (the retry budget carries over restarts), `evalBackoffUntil` (self-expiring), `stall`, open cap rounds and `openingPending`; it validates no status other than `'blocked'`.

---

## 5. Past fixes that patched these spots

| Commit | Date | Spot patched |
|---|---|---|
| `a733d642` fix(goal): drop a dead eval-retry window on epoch bump | 2026-10-22 | `bumpGoalEpoch` `GC:34-41`. Missed the inline bumps (S2) |
| `789a3525` (#581) goal parked at 10/10 … | 2026-10-30 | added explicit `capReachedAt`, `isGoalParkedAtCap` |
| `85783005` (#585) reverts #581 | 2026-10-30 | removed `capReachedAt`; added `resumeGoalStoppedAtBudget` `SG:361-373` (S5, S14) |
| `3db96d6f` (#624) cap decision = one request, two surfaces | 2026-10-31 | `capDecisionId`, `capDmRef`, journal, `answerGoalCapDecision`, `endGoalCapDecision(next)` |
| `0dbd54a1` stop on same failure | 2026-11-02 | `stall`, `openGoalStall`, retirer also ends stall |
| `db85ee1b` stall review round 1 | 2026-11-02 | stall retire paths: `resumedFromStall`, stall branch in `resumeGoalStoppedAtBudget` `SG:365-367`, objective update retires stall `GA:288`, single `SessionGoalStall` definition |
| `6db73f58` stall review round 2 | 2026-11-02 | default retirer clears `stall` `SG:384`; `goal clear` / `new` retract; resumed line used once |
| `9398415b` (#742) | 2026-11-02 | `GC:68` `retireGoalStall(…, 'user-message')` |
| `c7811667` (#745) | 2026-11-02 | `rollbackKeptUntil` fixed at offer time `ST:58,70,277` |
| `1b38e83f` (#745) | 2026-11-02 | rollback clears `firstFailure` (`claude-handler.ts:1587`) |
| `0a9443ef` keep goal identity on rollback | 2026-10-21 | `restoreGoal` writes into the same objects `SG:777-784`; `deleteCurrentGoal` by position `SG:550` (S11) |
| `fac2981f` record whether a goal's first turn ran | 2026-10-21 | `openingPending` (S16) |
| `64549dd0`, `0e48787e`, `22b20b8e`, `dd35095f` task gate | 2026-11-05 | `gateGoalVerdictOnTasks`, `taskGateGapClosed` `TG:137-144` |
| `b377c3bb` (#968) gate gap is a typed field | 2026-11-06 | replaced a text-prefix proxy (`TASK_GATE_REASON_START`) with `lastEvalGateOpen`; added clears at `SG:481`, `EV:330`, `GH:473`, `GA:285` |
| `1e983e22` (#968 review) | 2026-11-06 | `progressed ?? true` `TG:197` |
| `83918472` pause moves the goal aside | 2026-11-06 | `goalPaused`, `pauseCurrentGoal`, `resumePausedGoal`, `rebaseGoalAsActive`, `dropScheduledEval` |
| `fee82a80` review round 1 | 2026-11-06 | `findPausedGoal`, `heldTaskIds`, `undoPause` `SG:681-687` (S1 — only for pause) |
| `4115f59b` review round 2 | 2026-11-06 | held tasks clear only in `rebaseGoalAsActive`; `heldByWaitingGoals` covers queue; no double hold `SG:663-667` |
| `f007fb92` review round 2 (astra) | 2026-11-06 | `heldListAt` (proxy: ledger matches by text, so an id alone was not ownership) |
| `32ccac71` paused goals survive archive and revive | 2026-11-06 | `goalPaused` archived; `goalQueue` still not (S9) |
| `bc5310be` (#590) revive | 2026-10-30 | revive bumps epoch + drops `pendingEval` inline `SR:2062-2066` (S2) |
| `f51ac24d` (#1054) | 2026-06-04 | `pendingEval` dropped on load (now `LC:89-91`) |
| `36dd5f5b` (#1378) stop pauses the goal first | 2026-11-19 | `pauseCurrentGoalHoldingQueue` `SG:633-651` — third creator of slot-paused (S7) |
| `5e3fb4b6` (#1458) restart pass leaves a live turn alone | 2026-11-26 | outside the region (`SH:8801-8820`, `liveTurn` at `SH:8807`); same pattern: "no turn runs" inferred from "process just booted" |

Count: `git log --since=2026-09-20` has 52 subjects starting `fix(goal`; 156 subjects mention `goal` since 2026-09-26.
