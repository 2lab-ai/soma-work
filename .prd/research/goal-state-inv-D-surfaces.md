# Inventory D — goal surfaces (where a person or the model changes or reads a goal)

Repo: `soma-work_20261126_184702_goal-state-machine` at `cda77e0a`. Read-only. All paths are repo-relative.
Abbreviations: `SG` = `packages/slack/src/session-goal.ts` (re-exported by `src/slack/session-goal.ts:1`),
`GH` = `src/slack/commands/goal-handler.ts`, `GAH` = `src/slack/actions/goal-action-handler.ts`,
`SH` = `src/slack-handler.ts`, `DB` = `src/conversation/dashboard.ts`, `CAP` = `src/slack/goal-cap-decision.ts`,
`SE` = `packages/slack/src/pipeline/stream-executor.ts`.

Shared transition helpers that exist (in `SG` unless noted). Every surface below either calls one of these or writes fields itself:

| helper | what it writes | file:line |
|---|---|---|
| `enqueueOrActivateGoal` | append `goalQueue` (status `queued`) or `applyGoalToSession`; may call `resumeGoalStoppedAtBudget` on the current goal | SG:332-350 |
| `resumeGoalStoppedAtBudget` (private) | `continuationCount=0`, `endGoalCapDecision`, `updatedAt`, adds to module `WeakSet resumedFromStall` | SG:361-373, 410 |
| `advanceGoalQueue` | push to `goalHistory`, shift queue, `rebaseGoalAsActive`, or keep the finished goal in `session.goal` | SG:434-465 |
| `rebaseGoalAsActive` (private) | status, count, epoch, 11 scratch fields, held tasks, `dropScheduledEval` | SG:473-490 |
| `deleteGoalById` / `deleteCurrentGoal` | queue/paused/history filter, or drop current + promote | SG:519-539 / 550-566 |
| `pauseCurrentGoal` | `status='paused'`, epoch++, move to `goalPaused`, promote next or clear slot | SG:584-616 |
| `pauseCurrentGoalHoldingQueue` | as above but pauses IN PLACE (stays in `session.goal`) when the queue is non-empty | SG:633-651 |
| `resumePausedGoal` | shelf → head of queue (`queued`) if a goal is active, else → current (rebased) | SG:712-753 |
| `undoPause` / `snapshotGoalState` / `restoreGoalState` | whole-goal-state snapshot and in-place restore | SG:681-687, 798-819 |
| `endGoalCapDecision` → late-bound `capDecisionRetirer` | default only clears 4 fields; production retirer = `retireGoalCapDecision` (CAP:246-257) wired at `src/index.ts:2621` | SG:380-395 |
| `bumpGoalEpoch` | `epoch++`, clears `evalBackoffUntil`, `evalRetryReason` | `src/slack/goal-continuation.ts:32-42` |
| `resetGoalContinuationOnUserMessage` | count=0, retire stall ('user-message'), retire cap decision, clear 3 eval-retry fields, `bumpGoalEpoch` | `src/slack/goal-continuation.ts:64-81` |
| `answerGoalCapDecision` | the only cap answer path (Slack DM + dashboard) | CAP:157-239 |
| `retireGoalStall` | `stall=undefined`, calls late-bound `onRetired` listener (question retraction, wired `SH:1008`) | `src/slack/goal-stall.ts:99-108` |

There is no single "persist a goal change" function. Four copies of the "invalidate after a goal mutation" step exist and differ:

| copy | epoch | clears backoff | systemPrompt | save | broadcast | file:line |
|---|---|---|---|---|---|---|
| `GoalHandler.persistGoalChange` | `bumpGoalEpoch` | yes | yes | yes | yes | GH:651-662 |
| `SlackHandler.persistHostGoalMutation` | `bumpGoalEpoch` | yes | yes | yes | **no** (callers broadcast some paths) | SH:10274-10278 |
| `answerGoalCapDecision` | manual `epoch+1` | **no** | yes | `saveSessionsOrThrow` | yes (`surfaces.broadcast`) | CAP:206-213, 237 |
| `GoalActionHandler.handleUpdateSubmit` | manual `epoch+1` | **no** | yes | `saveSessions` | **no** | GAH:270-289 |
| SET_GOAL host-apply / autogoal / first-message goal | (new goal epoch from `createActiveSessionGoal`) | n/a | via `applyGoalToSession` | `saveSessions` | **no** | SE:6868-6874; SH:3029-3034; SH:2933-2939 |

---

## 1. Mutation paths

Guards column: **owner** = who may act; **status** = goal-status precondition; **epoch** = epoch bump / stale guard; **pos** = check that the goal is still where the user saw it.

### 1a. Typed `goal …` command (Slack thread, also the dashboard composer via `POST /api/dashboard/session/:key/command` DB:5493-5556, `instruct: true` access)

Entry `GoalHandler.execute` GH:36-104. No owner/creator check anywhere in `GoalHandler`. Mid-turn the host intake checks only `authorizeFollowupDispatch` (may this author run in this thread) SH:4398-4413 and supplies `admitOpening` SH:4435-4462. `rules/permission.md` already lists "typed `goal` … skip owner guard".

| action | function | fields written | shared fn or direct | guards | file:line |
|---|---|---|---|---|---|
| `goal auto [on/off]` | `toggleAutoGoal` | user setting `autoGoalEnabled` | store | none (per-user) | GH:110-126 |
| `goal max N` | `setMaxContinuations` | user default; **current goal `maxContinuations`, `updatedAt`** when status active or paused | **direct** + `persistGoalChange` | status active/paused only; does NOT retire an open cap decision, does NOT kick the loop | GH:132-165 (writes 146, 150-152) |
| `goal <obj>` / `goal set <obj>`, no session | returns `setGoalObjective` | (applied later in SH:2926-2960) | — | objective validation only | GH:56-71 |
| `goal <obj>`, session exists | `setGoal` | queue append, or new active goal; resumed current goal count/cap | `enqueueOrActivateGoal` | snapshot/restore on refused admission (GH:181, 226); queued branch: `saveSessions` only, no epoch bump (by design), broadcast only if `resumedCurrent` | GH:167-252 |
| `goal pause` | `pauseGoal` | current → shelf, next promoted | `pauseCurrentGoal` + `undoPause` | status != complete (GH:266); no owner | GH:259-321 |
| `goal resume [n]` on a stalled active goal | `resumeStalledGoal` | `retireGoalCapDecision`, `continuationCount=0`, `updatedAt` | **direct** + `persistGoalChange` + `resumeGoalLoop` | `current.status==='active' && current.stall` and `index===undefined` (GH:343) | GH:431-446 |
| `goal resume [n]` on a paused goal | `resumeGoal` | shelf/slot-paused → current or queue head; **`goal.openingPending = undefined`** (direct) when no `admitOpening` | `resumePausedGoal` | shelf index check (GH:359-370) | GH:332-423 (direct write 395) |
| `goal done` | `completeGoal` | `status, completedAt, completedBy, completedVia, completionReason, pendingEval, lastEvalReason, lastEvalGateOpen, updatedAt`; retire cap; archive + promote | **direct** + `advanceGoalQueue` | **only `if (!session.goal)`** — no status check (GH:455) | GH:448-518 (writes 466-476) |
| `goal clear` | `clearGoal` | `goal, goalQueue, goalPaused, goalHistory, goalLastTurnText` | **direct** (+ `retireGoalCapDecision`) | none | GH:520-544 (writes 531-536) |
| `goal` (status) | `showStatus` | none (read) | — | — | GH:546-591 |

### 1b. Slack interactive buttons (`GoalActionHandler`)

Owner guard for list buttons: `session.ownerId === body.user.id` (GAH:55-65). Cap DM buttons: `goal.createdBy === actor` inside `answerGoalCapDecision` (CAP:162).

| action | function | fields written | shared fn or direct | guards | file:line |
|---|---|---|---|---|---|
| 🗑️ Delete (current/queued/paused) | `handleDelete` → host action | see 1c delete | `handleHostGoalAction` | owner=session owner; **`expect` is computed from LIVE state at click time** (GAH:81-88), not from the row the user clicked | GAH:67-110 |
| 🗑️ Delete (history goal, or host action not wired) | `handleDelete` local fallback | queue/paused/history filter, or current + promote | `deleteGoalById` then `saveSessions` only, `resumeGoalLoop` if promoted | no epoch bump of the promoted goal beyond rebase; no broadcast; no thread notice | GAH:112-131 |
| ⏸️ Pause | `handlePause` → `runHostLifecycle` | see 1c pause | host action | owner=session owner; goalId stale check in host | GAH:142-148, 159-197 |
| ▶️ Resume | `handleResume` → `runHostLifecycle` | see 1c resume | host action | as above | GAH:150-156 |
| ✏️ Update (modal open) | `handleUpdate` | none | — | goal resolved by `findGoalById` incl. **history** | GAH:199-234 (207) |
| ✏️ Update (modal submit) | `handleUpdateSubmit` | `objective, updatedAt, epoch(+1), lastAssistantTurnSummary, lastEvalReason, lastEvalRemaining, lastEvalGateOpen, lastEvalSummaryHash`; session `systemPrompt, goalLastTurnText`; `retireGoalStall` | **direct** (no shared fn) | owner=session owner (GAH:253); **no status check** (history goals editable, GAH:257); no position check; **does not retire an open cap decision**; manual epoch (no backoff clear); no broadcast; kicks loop if active (GAH:294-296) | GAH:236-313 |
| ✅ 계속 / 🛑 취소 (cap DM) | `answerCapDecision` → `answerGoalCapDecision` | continue: `continuationCount=0, status='active'`; cancel: **`status='paused'` in the slot** (not the shelf); both: clear 3 cap fields, `updatedAt`, `epoch+1`, `systemPrompt` | shared (`answerGoalCapDecision`) | owner=`createdBy`; status active; `decisionId` round match; synchronous check→save before side effects; rollback on save failure | GAH:322-373; CAP:157-239 (writes 199-211) |

### 1c. Host goal action (`SlackHandler.handleHostGoalAction`) — shared by dashboard goal route and Slack list buttons

SH:9730-9907. Every branch: anchor notice posted first (`postGoalAnchor` SH:10281), then re-check → mutate → persist → admit opening synchronously; refused admission → `restoreGoalState` / `undoPause`. Session must exist and not be `terminated` (`liveGoalSession` SH:10233). **No owner check in the handler itself**; `actor` is used only as the opening author (`assertGoalOpeningAuthor`, SH:9750/9764).

| action | fields written | shared fn | guards | file:line |
|---|---|---|---|---|
| add | queue append or new active goal; `resumedCurrent` → `retractFollowUpQuestion`, `rearmGoalErrorResume`, `goalTurnSettledHandler(kick)` | `enqueueOrActivateGoal` (SH:9776) | author check before+after anchor; same-session-object check; queued branch `saveSessions` only | SH:9741-9822 (kick 9792-9800) |
| delete queued/paused | filter | `deleteGoalById` | `assertGoalWhereExpected` (SH:10254) | SH:9829-9839 |
| delete current | drop + promote | `deleteCurrentGoal` (SH:9869) | `assertGoalWhereExpected(…'current')` after the anchor; author of promoted goal; **no promoted goal → `saveSessions` only (no epoch bump, no broadcast in handler)** (SH:9870-9873) | SH:9841-9907 |
| pause | shelf + promote | `pauseCurrentGoal` (SH:9953) | `assertGoalPausable` accepts `active` OR `paused` current (SH:10131) | `pauseGoalFromHost` |
| resume | shelf → current/queue | `resumePausedGoal` (SH:10096) | `assertGoalResumable` (shelf or slot-paused) SH:10139 | `resumeGoalFromHost` |

Other host-side goal mutations reached from a surface:

| surface | action | fields | shared or direct | guards | file:line |
|---|---|---|---|---|---|
| dashboard 중지 with `pauseGoalId`; admin bare `!` in Slack | `pauseGoalForStop` | pause in place if queue non-empty, else shelf | `pauseCurrentGoalHoldingQueue` (SH:10033) + `persistHostGoalMutation` | status `active` else `not-running`; goalId must match (409) | SH:10021-10055; `src/task-turn/task-stop.ts:20-29`; admin bare `!` SH:2443-2449, 7212-7228 |
| owner's own Slack bare `!` | abort only | none — goal stays active ("The owner's own `!` keeps its meaning") | — | — | SH:2446-2449 |
| cancel of a goal's unstarted opening item (dashboard queue / Slack) | `onGoalOpeningCancelled` | **`goal.status='paused'` direct**, `retireGoalCapDecision`, `updatedAt`, then async host delete-current | direct then host action | `openingPending===true` and status active (`goalOfUnstartedOpening`) | SH:10194-10208 (direct write 10203) |

### 1d. Dashboard routes (`DB`)

| route | action | handler | guards | file:line |
|---|---|---|---|---|
| `POST /api/dashboard/session/:key/goal` | add / delete / pause / resume | `_goalActionHandlerFn` = `handleHostGoalAction` (`src/index.ts:1252`) | `resolveSelfActionKeyAndOwner` → `requireSessionOwner` (#716 write policy) (DB:1097-1116, 5668); objective ≤4000; `expect` required for delete; `broadcastSessionUpdate` after success (DB:5682) | DB:5631-5694 |
| `POST /api/dashboard/session/:key/goal-decision` | cap continue/cancel | `answerGoalCapDecision` (`src/index.ts:2627-2638`) | only `resolveSelfActionKey` (no owner gate at route; owner = `createdBy` in the answer fn); `decisionId` required | DB:6138-6190 |
| `POST /api/dashboard/session/:key/stop` | stop, optionally pause goal first | `createDashboardStopHandler` | `requireStopAccess` (owner or any admin); **409 + goal payload if `task.goal.status==='active'` and no `pauseGoalId`** (DB:5304-5315) | DB:5285-5336 |
| `answer-choice` / `answer-multi-choice` | stall question answer (as a user turn) | `ChoiceActionHandler` | cross-surface hold `answering` map (`src/slack/actions/choice-action-handler.ts:100`); `isAnswerableFromDashboard` (`:61-67`) | DB:6434-6606 |
| `command` | typed `goal …` from the composer | → GoalHandler (1a) | `instruct: true` (any signed-in user; #767 approval for non-owners) | DB:5493-5556 |

### 1e. Model command `SET_GOAL`

MCP side is echo-only: `somalib/model-commands/catalog.ts:761-771` (definition), `:1438-1450` (run echo), validator `somalib/model-commands/validator.ts:410-447`, enum `packages/mcp-servers/model-command/model-command-mcp-server.ts:215-216`. Host-apply in SE:6763-6893:

| step | fields | shared or direct | guards | file:line |
|---|---|---|---|---|
| refuse | none | — | `isUserInputTurn` (user input, not host turn, SE:2130), evidence verbatim substring of current user text | SE:6768-6809 |
| dedupe | none | `findPendingGoalPosition` (slot active/paused or queue), `findPausedGoal` (shelf) | SE:6826-6866 |
| apply | queue append or new active goal; may reset a cap-/stall-stopped current goal | `enqueueOrActivateGoal` | **`createdBy` = `session.ownerId`** (SE:6822), not the turn user; `saveSessions` only (SE:6874); no broadcast; no loop kick for `resumedCurrent` (turn end drives) | SE:6868-6893 |

### 1f. Autogoal, first-message goal, user-message reset (all in `SH.processMessage`)

| path | fields | shared or direct | guards | file:line |
|---|---|---|---|---|
| goal-prefixed first message (`setGoalObjective`) | new active goal (or queue) | `enqueueOrActivateGoal`, `createdBy = event.user` | none beyond session init; `saveSessions` only | SH:2926-2960; dropped-goal notice SH:2635-2640 |
| autogoal | new active goal from the instruction text | `enqueueOrActivateGoal`, `createdBy = event.user` | own in-flight predicate: `goal.status` active/paused **in the slot** and empty `goalQueue` — **ignores `goalPaused` shelf** (SH:3025-3028); setting or per-task `autoGoalOverride` (SH:3020-3022); not synthetic / host turn / incident / slash / planning | SH:2988-3048 |
| real user message | `resetGoalContinuationOnUserMessage` on `session.goal` **whatever its status** (active, slot-paused, complete) | shared | `!event.synthetic && routeContext.hostTurn !== true`; consumed commands return earlier (spec §252) | SH:2846-2877 (call 2875); stall rollback answer read first SH:2861 |

Only one caller of `resetGoalContinuationOnUserMessage` exists (SH:2875).

### 1g. Read-only / non-mutating surfaces

- `/z goal` topic: help card; `applyGoal` refuses every change (`src/slack/z/topics/goal-topic.ts:38-44`).
- Per-user goal-max default from settings: `src/user-settings-registry.ts:311, 605-607` (default only; never touches the current goal, unlike typed `goal max`).

---

## 2. Read / projection paths

### 2a. Slack goal block (`buildGoalStatusBlocks`, `src/slack/goal-blocks.ts:164-256`)

| shown | derived from | line |
|---|---|---|
| "Current goal — _<status>_" | `goal.status` only | 175 |
| "Auto-continuations n/max" | only when `status==='active'` | 177-179 |
| "Completed: …" | `goal.completedAt` (any status) | 180-185 |
| button row ⏸️/▶️ + ✏️ + 🗑️ | `status` active → pause; paused → resume; complete → none | 188-190 |
| queued rows with ✏️ 🗑️ | `goalQueue` | 193-203 |
| paused rows ▶️ ✏️ 🗑️ (max 5) | `goalPaused` | 205-225 |
| history (joined text) | `goalHistory`, newest first | 227-253 |

Not shown at all: `stall`, `capDmPendingAt`/`capDecisionId`, `pendingEval`, `evalBackoffUntil`, `openingPending`, `lastEvalReason`. Text fallback GH:578-585 shows status + counts only.

Cap DM (`buildCapDecisionDmBlocks` goal-blocks.ts:293-335): "reached its {maxContinuations}-turn budget", objective, `reason` (from caller), ✅/🛑 with `decisionId` in the value.

Stall question (`buildGoalStallQuestion` `src/slack/goal-stall.ts:118-150`): a host `user_choices` form, posted only if `shouldAskGoalStallQuestion` (`goal-stall.ts:219-233`: same goalId+stallId, no running request, no other open question) — `SH:9217-9235`. Its `questionTurnId` is written back to `goal.stall` (SH:9227-9231).

### 2b. Dashboard server projection

| field on the card | rule | file:line |
|---|---|---|
| `goal.current` | `session.goal` if `status ∈ {active, paused, complete}` (`KANBAN_GOAL_STATUSES`) | DB:2589, 2706-2729 |
| `goal.current.stalled` | `goal.stall.reason` present | DB:2718-2728 |
| `goal.queue / paused / history / completedCount` | `goalQueue`, `goalPaused`, `goalHistory` (history includes a complete current goal too) | DB:2730-2745 |
| `pendingGoalDecision` | `status==='active'` && `capDmPendingAt` finite && `capDecisionId` non-empty; `ownerId=createdBy` | DB:2683-2697 |
| `autoResume` goal part | `status==='active'`: `evalBackoffUntil > now` → `goal-eval-retry`; else `pendingEval` (presence only, no age) → `goal-eval`; error retry outranks both | DB:2605-2638 (goal 2624-2636) |
| card `activityState` | `'waiting'` if any ask (permissions, **goal decision**, instruction approvals) or plan awaiting; else session `activityState` | DB:3103-3111, 3137 |
| column | epic state → userQueue (`waiting`) → SLEEPING (`closed`) → `activityState` working/waiting → idle: `autoResume || queueWait` → working, else **idle (DONE)** | `placeOnBoard` DB:3470-3505 |
| "shown activity" | idle + (`autoResume` or `queueWait`) → working | `shownActivity` DB:3528-3530 |

A stall itself is NOT an ask in `asks` (DB:3107-3111). A stall makes the card waiting only through the host question's `activityState: 'waiting'` (`SE` `askUserQuestionFromHost`, comment SE:7136-7145).

### 2c. Dashboard client re-derivations (page script inside DB)

| function | what it decides | inputs | file:line |
|---|---|---|---|
| `cardSummary` | face line "목표 계속 진행할까요? — 응답 대기" | `pendingGoalDecision` | DB:14023-14047 (14026) |
| `cardAsks` | card asks now | `pendingGoalDecision`, etc. | DB:14645-14654 |
| `pendingAutoResume` / `autoResumeLabel` | "목표 완료 판정 중" / "목표 판정 재시도" | `col==='working'`, `activityState!=='working'`, `autoResume` | DB:14051-14054, 14077-14089 |
| `rootStatusOf` | waiting/resuming/running/idle | `col`, `activityState`, `autoResume` | DB:14851-14860 |
| `epicChildCol` | an epic child's column | `activityState`, `autoResume` — **ignores `queueWait` and `userQueue`** that server `placeOnBoard` uses | DB:25707-25713 |
| `cardGoalLine` | chip 진행 중/일시정지/완료, `n/max` (active only), 대기 n, 일시정지 n; no current → "대기 중인 goal n개" / "일시정지된 goal n개" / "완료된 goal n개" / "현재 goal 없음" | `goal.current.status`, counts | DB:18279-18303; labels DB:19476-19477 |
| `goalCardData` | `<ui-goal-card>` data; meta 이어하기 n/max; note "남은 것"; meta 멈춤 when `stalled` | `goal.current`, queue, history | DB:19502-19530 (stall 19511-19515) |
| `renderPanelGoalPaused` | paused list + hint "재개하면 지금 목표 다음에 / 바로" | `goal.current.status==='active'` | DB:17775-17806 (17786) |
| mid-tab "목표" count | `(cur ? past+1 : past) + '/' + all` | history + current + queue + paused | DB:16835-16848 |
| `stopGoalOf` | whether 중지 must ask to pause | `goal.current.status==='active'` | DB:21137-21141 |
| `acGoalDecisionData` | approval card label "목표 자동 진행 n/n", "n회 한도에 닿았습니다" | `maxContinuations` used as **both** numerator and denominator | DB:10288-10308 (10295-10296) |
| `acGoalDecisionLock` | who may answer | `ownerId (=createdBy) === _viewerUserId` | DB:10284-10287 |
| work-log system turn | "목표 #n/m" | regex on the injected prompt text `Auto-continuation (\d+)/(\d+)` | DB:23820-23834 |
| `nextActionsOpen` | next-action buttons hidden while a goal decision waits | `pendingGoalDecision` | DB:18787-18792 |

### 2d. Places that re-derive the same state differently

1. "Is a goal in flight?" — `isGoalInFlight` = slot active|paused (SG:261-263); autogoal = slot active|paused **and** empty queue, shelf ignored (SH:3025-3028); `findPendingGoalPosition` = slot active|paused or queue (SG:287-291); `goal pause` = slot not complete (GH:266); `stopGoalOf`/stop route = slot `active` only (DB:21139, 5304).
2. "Is the goal stopped and resumable?" — `resumeGoalStoppedAtBudget`: active && (count ≥ max || stall) (SG:365-366); `goal resume`: only `active && stall` (GH:343), a cap-stopped goal gets "already running" (GH:351-353); user message: any `session.goal` (goal-continuation.ts:64-81).
3. "Is a cap decision open?" — `isGoalCapDecisionPending`: active && `capDmPendingAt` (CAP:91-93); dashboard: active && `capDmPendingAt` finite && `capDecisionId` (DB:2683-2687); `answerGoalCapDecision` accepts a round with no id only from a button without id (CAP:164-170); `flushGoalCapDmSync` round-open probe: `capDecisionId` match && `capDmPendingAt !== undefined` with no status check (`src/index.ts:2640-2644`).
4. "Who owns the goal?" — cap answer: `createdBy` (CAP:162, DB:2695/10284); goal list buttons: `session.ownerId` (GAH:63, 253); dashboard goal route: session-owner write policy (DB:1113); host action: none (author check only); typed command: none.
5. "What is `createdBy`?" — typed `goal`: `ctx.user` (GH:190); dashboard add: `actor` = dashboard user (owner or admin), bearer → owner (DB:5680, SH:9736); SET_GOAL: `session.ownerId` (SE:6822); autogoal and first message: `event.user` (SH:3032, 2936).
6. "Paused" — two storage places: `session.goal.status==='paused'` (slot) vs `session.goalPaused[]` (shelf). Slot-paused comes from cap 🛑 (CAP:204), `pauseCurrentGoalHoldingQueue` with a queue (SG:640-650), opening cancel (SH:10203), legacy data. Shelf-paused from `pauseCurrentGoal` (every ⏸️ and `goal pause`). `resumePausedGoal` picks between the two by `updatedAt` (SG:720-731).
7. Card column vs goal chip: column ignores `goal` except through `pendingGoalDecision` and `autoResume`; the goal chip reads `goal.current.status`. They are computed independently (DB:3470-3505 vs DB:18279-18303).
8. Completed goal counted twice: the finished goal stays in `session.goal` AND is in `goalHistory` (SG:456, 446); the Slack block lists it under "Current goal — complete" and "Completed goals"; dashboard mid-tab counts `past+1` (DB:16843).
9. Continuation count: `goal.continuationCount` (Slack block GH/goal-blocks.ts:178; card DB:18295-18297) vs prompt-text regex in the work log (DB:23822) vs `n/n` on the decision card (DB:10295).

---

## 3. Implicit states visible to users

| implicit state | stored as | Slack `goal` block | Dashboard | disagreement |
|---|---|---|---|---|
| Running a goal turn | `status active` + `activityState working` | "active", n/max, ⏸️ | RUNNING, chip 진행 중 | — |
| Eval in flight between turns | active + `pendingEval` | "active" (no sign) | RUNNING, "목표 완료 판정 중" (DB:14079) | Slack shows nothing |
| Eval retry backoff | active + `evalBackoffUntil` | "active" | RUNNING, "HH:MM 목표 판정 재시도 · 시도 a/b" | Slack shows nothing |
| Waiting on cap decision | active + `capDmPendingAt` + `capDecisionId` (+ `capDmRef`) | "active", "Auto-continuations: 10/10", ⏸️ button; DM with ✅/🛑 | WAITING, approval card, face "목표 계속 진행할까요?" | Slack status does not say it waits; `goal resume` says "already running" (GH:353) |
| Cap decision open after `goal max` raised the cap | active + `capDmPendingAt` + count < max | "10/20" | WAITING, card "목표 자동 진행 20/20 … 20회 한도" (DB:10295-10296) | count shown three ways; decision stays open (GH:148-152) |
| Stall question open | active + `stall` (+ `questionTurnId`) | "active" (no sign) | goal card meta "멈춤", note "멈춘 이유"; WAITING only via the host question | Slack status block has no stall marker |
| Stall open, question not posted (turn ran or another question open, `goal-stall.ts:229-232`) | active + `stall`, no `questionTurnId` | "active" | goal card "멈춤" but column from `activityState` → can be DONE | goal card says waiting, column says done |
| "Goal active but nothing runs" (loop deferred, host-wait, owner's own `!`, after restart before the resume pass, opening not yet dispatched while idle) | active, no `pendingEval`, no backoff, `activityState idle` | "active" | DONE column (unless `queueWait`/`userQueue`), chip 진행 중 (run tone) | column DONE + run chip at once |
| Stale `pendingEval` (eval gone) | active + `pendingEval` | "active" | RUNNING "목표 완료 판정 중" for as long as the field stays (presence-only, DB:2636) | — |
| Opening admitted, not yet run | active + `openingPending` | "active" | 진행 중 | no surface shows it; only the follow-up item has `goalOpeningId` (DB:2057 makes it non-editable) |
| Paused in slot, no queue | `goal.status paused` | "Current goal — paused", ▶️ | DONE, chip 일시정지 | new `goal X` QUEUES behind it (SG:340); autogoal off (SH:3027) |
| Paused in slot with queue ("paused with queue") | slot paused + `goalQueue` | current paused + "Queued goals (n) — start automatically in order" | DONE, chip 일시정지 · 대기 n | Slack text says the queue "start[s] automatically" but it waits behind the slot-paused goal |
| Paused on the shelf, no current | `goal` undefined + `goalPaused` | "Paused goals (n)" | card line "일시정지된 goal n개" (only if no queue) | next message → autogoal activates a NEW goal (SH:3025-3028) |
| Completed, queue empty | `goal.status complete` (also in history) | current "complete" + history row | DONE, chip 완료, tab "2/2" for one goal | double count |

---

## 4. Suspicious spots

S1. **Slack Delete has no stale-view protection.** `expect` is derived from live state at click time (GAH:81-88), so `assertGoalWhereExpected` (SH:10254) always passes. Scenario: `goal` status message shows A current, B queued. A completes and B is promoted. The owner clicks 🗑️ on B's (queued) row in the old message → `expect='current'` → `deleteCurrentGoal` deletes the running goal B. The dashboard sends `expect` from what was shown (DB:19590) and gets 409.

S2. **`goal done` has no status guard and overwrites a completed goal's record.** GH:455 checks only `!session.goal`; GH:466-470 rewrite `completedAt/completedBy/completedVia='user'/completionReason='user'`. After an eval-model completion with an empty queue, `session.goal` is the same object as the history entry (SG:446, 456), so `goal done` turns the history row from "평가 모델 완료" into "직접 완료" with a new time. `advanceGoalQueue` idempotency (SG:444) prevents only the double push.

S3. **Slack objective edit writes fields directly and skips three things other paths do.** GAH:270-289: manual `epoch+1` (no `bumpGoalEpoch`, so `evalBackoffUntil`/`evalRetryReason` stay — the exact case a733d642 fixed for `goal max`/`resume`), no `retireGoalCapDecision` (an open cap DM keeps the old objective), no broadcast. It also edits history goals (`findGoalById` includes history, GAH:257; SG:307). Scenario: eval dispatch failed, backoff 60s armed; owner edits the objective; epoch moves so the armed retry no-ops, but the backoff window stays; `resumeGoalLoop` kick (GAH:295) hits the backoff gate and the card shows "목표 판정 재시도" for a re-check that never runs.

S4. **`goal max` leaves an open cap decision open.** GH:148-152 writes `maxContinuations` and bumps the epoch, but does not end `capDmPendingAt` and does not kick the loop; a consumed command skips the user-message reset (spec line 252). Scenario: goal at 10/10 with DM pending; owner types `goal max 20`; dashboard stays WAITING with "목표 자동 진행 20/20 … 20회 한도에 닿았습니다" (DB:10295-10296) while the goal has 10 turns left; nothing runs until someone answers.

S5. **Four different owner rules for one goal.** Cap answer = `createdBy` (CAP:162); list buttons/modal = `session.ownerId` (GAH:63, 253); dashboard goal route = session-owner write policy incl. admin mode (DB:1113); typed `goal` = none (GH:36-104); host action = none (SH:9730-9740). `createdBy` itself differs by surface (2d item 5). Scenario: a non-owner (allowed to instruct) types `goal X` → `createdBy` = that user; the cap DM goes to them (`goal-loop-controller.ts:733` `postOwnerDm(activeGoal.createdBy, …)`); the session owner sees the dashboard decision card locked "목표 소유자만 응답할 수 있습니다" (DB:10286) but can delete or pause the goal via the list buttons.

S6. **Cap 🛑 pauses in the slot; ⏸️ pauses on the shelf.** CAP:204 vs SG:598-604. Scenario: owner cancels at 10/10 with two goals queued; the queue never advances (`enqueueOrActivateGoal` keeps queueing behind a slot-paused goal, SG:340), the Slack block still says the queue starts "automatically in order" (goal-blocks.ts:195), and the card sits in DONE with 일시정지 · 대기 2. Commit 32ccac71 documents "where cap Cancel still stops in place".

S7. **Autogoal ignores the paused shelf.** SH:3025-3028 checks only the slot and `goalQueue`. Scenario: owner pauses goal A (shelf, no queue → slot empty), then sends "어떻게 됐어?" with autogoal ON → that chat line becomes a new active goal and the loop runs on it, while A waits on the shelf. SET_GOAL checks the shelf (SE:6827-6844, fee82a80) but autogoal does not.

S8. **Stop disagrees between Slack and dashboard.** Dashboard 중지 forces a pause choice when `goal.status==='active'` (DB:5304-5315; client DB:21181-21185); an admin's bare `!` pauses (SH:7212-7228); the owner's own bare `!` only aborts (SH:2446-2449), so the cut turn's end can drive the next goal turn — the failure 36dd5f5b fixed for the dashboard.

S9. **`goal resume` and "goal X" disagree on a cap-stopped goal.** `goal resume` with nothing paused and no stall answers "▶️ The current goal is already running — no goal is paused." (GH:346-357) although the goal waits on the cap decision; `goal X` resumes the same goal through `resumeGoalStoppedAtBudget` (SG:361-373). History: #581 (789a3525) changed this, #585 (85783005) reverted it; e26bfa9a added the stall-only branch.

S10. **Dashboard card can show DONE for a goal that still owns the loop.** `placeOnBoard` (DB:3492-3501) reads only `activityState`, `autoResume` (eval/backoff) and `queueWait`. Any active goal between turns without `pendingEval`/backoff (loop deferred §3.6, after an owner `!`, restart before resume, stall whose question was skipped) is in DONE with a 진행 중 chip. Conversely `pendingEval` alone (presence, no age, DB:2636) keeps a card RUNNING. a733d642 ("no DONE flash on eval failure") patched one transient of this.

S11. **Two-surface cap answer is guarded; the guard relies on a single process.** `answerGoalCapDecision` is synchronous from checks to save (CAP:172-213); a second answer reads stale. The DM rewrite journal is a second store (`DATA_DIR/goal-cap-dm-sync.json`, CAP:265-414) with module-level state `rewrites` (CAP:267). A typed message also ends the round (goal-continuation.ts:71) and the DM is rewritten "superseded" (CAP:254). Stall answers are guarded by the in-memory `answering` map (`choice-action-handler.ts:100`). Both guards are per-process memory.

S12. **Hidden module-level state on the surface path.** `capDecisionRetirer` default (SG:380-385) until `src/index.ts:2621`; `surfaces` (CAP:66); `resumeFn` / `hostGoalActionFn` (`src/slack/goal-loop-resume.ts:15, 33`); `onRetired` (`goal-stall.ts:88`); `resumedFromStall` WeakSet (SG:410) that only feeds the notice text. Before wiring, `GAH.handleDelete` falls back to local delete + loop kick (GAH:112-131) and pause/resume refuse (GAH:173-179).

S13. **Several mutations do not push the dashboard.** SET_GOAL (SE:6874), autogoal (SH:3034), first-message goal (SH:2939), GoalHandler queued branch (GH:199), host delete-current with no promoted goal (SH:9870-9873, the dashboard route broadcasts after, but the Slack-button path does not), Slack modal edit (GAH:289), Slack local delete (GAH:117). The card shows the old goal until the next push from something else.

S14. **Mid-turn `goal done` / `goal pause` race is designed in.** The host intake runs the command while a turn runs and admits the promoted opening in the same synchronous step (SH:4398-4462; GH:484-497, 285-299). The idle path returns `continueWithPrompt` instead (GH:313, 422, 513). Two code paths for one action; 18339835, fac2981f, 42180ee1, 4c6ebcd2 are fixes in this area.

S15. **Help text disagrees with behaviour.** `/z goal` card: "`goal set <objective>` 또는 `goal <objective>` — 활성 목표 설정/교체" (goal-topic.ts:19); the command queues behind a running goal and never replaces it (GH:183-216). `postUsage` (GH:672-686) omits `goal auto` and `goal max`.

S16. **User-message reset ignores status.** `resetGoalContinuationOnUserMessage` runs on any `session.goal` (goal-continuation.ts:64-81): it zeroes `continuationCount` and bumps the epoch of a slot-paused or complete goal too, but never resumes a slot-paused goal. Spec line 145 promises "any new message resumes it" for the cap stop only.

---

## 5. Past fixes tied to the spots

`git log --since=2026-09-26 | grep "fix(goal"` = 50 commits (plus `goal:` and `feat(goal)` ones). Per-file logs (`git log --format='%h %ad %s' --date=short -- <file>`):

| spot | commits |
|---|---|
| S1 Slack delete / host action order and stale view | 83312ddf 2026-10-21 feat(goal): run goal commands at once mid-turn; dashboard goal list · 220b1f3a 2026-10-21 pre-authorize a dashboard-started goal's opening author · 9d7c17ac 2026-10-21 dedupe goal-command redelivery; re-check the promoted goal's author · c948cb1e 2026-11-06 host pause refuses a replaced session |
| S2 `goal done` / completion | 3bdaca7a, e3a6ce8b 2026-10-20 (goal-handler) — no fix touched the status guard |
| S3 objective edit / epoch / backoff | a733d642 2026-10-22 drop a dead eval-retry window on epoch bump (did not touch goal-action-handler.ts) · f726445d 2026-10-22 cap-decision DM Continue/Cancel drop the cached system prompt · db85ee1b 2026-11-02 stall review round 1 (edit retires the stall) |
| S4 / S9 cap stop and resume semantics | 789a3525 2026-10-30 a goal parked at 10/10 no longer blocks other goals (#581) · 85783005 2026-10-30 input at 10/10 runs the stopped goal again (reverts #581) · 3db96d6f 2026-10-31 10/10 DM is also a dashboard approval card · e26bfa9a 2026-11-02 `goal resume` on a stalled goal gives the budget back · ea5cdf8b 2026-11-02 a stall ends an open 10/10 decision so one question stays |
| S5 owner rules | 32b6d5cc 2026-11-03 a task goal is its turn user's · 09d11a64 2026-11-03 a dashboard task's host start never sets a goal · e0a7c707 2026-11-23 fix(stop): an admin stops anyone's work |
| S6 / S16 two kinds of paused | 83918472 2026-11-06 wip(goal): pause moves the current goal aside · fee82a80 2026-11-06 paused goals stay out of SET_GOAL, the task gate and a refused pause · 4115f59b, f007fb92 2026-11-06 held tasks · 32ccac71 2026-11-06 paused goals survive archive and revive; docs say where cap Cancel still stops in place |
| S7 autogoal / SET_GOAL dedupe | a1850a64 2026-11-03 SET_GOAL never queues the same goal twice (#865) · fee82a80 (shelf check added to SET_GOAL only) · faa544e7, cdf01edf 2026-10-02 fix(goal-loop) autogoal driver deferral |
| S8 stop | 36dd5f5b 2026-11-19 feat(dashboard): 중지 asks to pause the goal (#1378) · e0a7c707 2026-11-23 admin bare `!` pauses |
| S10 card column | a733d642 2026-10-22 no DONE flash on eval failure · 29787c38 2026-11-06 restart badge; a dropped resume frees a goal-less session |
| S11 cross-surface answers | df12f2e6, d67d7ea3, a62d95c4, b7cbcba7, 1bfba2c2 2026-11-02 (one answer per question across Slack and the dashboard; PR #730) · 9398415b 2026-11-02 retracting a stall question frees the session |
| S14 mid-turn command intake / openings | 18339835, fac2981f, 0a9443ef, 42180ee1, 4c6ebcd2 2026-10-21 · eaf59805 2026-11-03 a goal's first turn is owed until its opening starts |
| S15 help text | a670f267 2026-11-06 docs(goal): pause/resume — help, /z goal (left "설정/교체") |

Fix density per region file since 2026-09-20: goal-handler.ts 17 commits, session-goal.ts 17, goal-action-handler.ts 8, goal-cap-decision.ts 2, goal-blocks.ts 2, goal-host-actions.ts 3, goal-topic.ts 1.
