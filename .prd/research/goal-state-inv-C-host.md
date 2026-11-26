# Inventory C — how the host drives goals around turns, restarts, follow-ups and stops

Repo: `soma-work_20261126_184702_goal-state-machine` at `cda77e0a` (after PR #1458 / #1463).
All line numbers are from that tree. `SH` = `src/slack-handler.ts`, `SR` = `src/session-registry.ts`,
`SE` = `packages/slack/src/pipeline/stream-executor.ts`, `IDX` = `src/index.ts`,
`RC` = `packages/slack/src/request-coordinator.ts`, `GLC` = `src/slack/goal-loop-controller.ts` (read only where the host's signals meet it).

Facts only. Where a claim depends on code outside this region it says so.

---

## 1. Host state that gates goals

### 1a. In-memory state on `SlackHandler` (all lost on restart)

| Name | Stored where | Writers (file:line, condition) | Readers (file:line, decision) | Cleared when |
|---|---|---|---|---|
| `goalTurnSettledHandler` | SH:3615, set by `setGoalTurnSettledHandler` SH:3612 | IDX:2594 (wired after `app.start()` IDX:2001 and an `await agentManager.startAll()` IDX:2041) | Fired at SH:3718, 7674, 7684, 8708, 8748 (resumeActiveGoals bails if unset), 9799 | Never. Before IDX:2594 every `?.()` call is a silent no-op |
| `goalLoopActing` probe | SH:9281, set SH:9277 | IDX:2607 → `GLC.isActing` (GLC:327: a loop run queued/running or a continuation `injecting`) | SH:8684 (handBack: skip), SH:9258 (follow-up question: don't ask), SH:9292 (`isTaskRunning`) | Never. NOT read by `resumeActiveGoals` |
| `followupDeferredGoalSessions` (Set) | SH:441 | add SH:3710 (turn end while `shouldDeferGoalDriver` — outstanding follow-up rows); add SH:7655 (slot-held release but rows outstanding) | SH:7679 `releaseDeferredGoalDriver` fires the driver if `canDrain` and no rows outstanding | delete SH:3716 (direct fire), 7667 (#948 stop), 7671 (slot release fire), 7682 (deferred release), 1418 (session deleted) |
| `followupSlotHeldGoalSessions` (Set) | SH:443 (#891) | add SH:3701 (turn left NO text and `isFollowupSlotHeld`), add SH:7597 (`holdDroppedGoalContinuation`: a synthetic goal continuation dropped at the busy fence) | SH:7646 (release: fire / defer / cut / #948) | delete SH:3717 (direct fire), 7646 (release consumes), 1419 |
| `goalDriverKickOnRelease` (Set) | SH:467 (#893) | add SH:7598 (dropped continuation) | SH:7648 → fire with `{cause:'kick'}` at SH:7674 | delete SH:3655 (any turn end on the session, before the goal-active check), 7648, 1421 |
| `goalErrorResumeSpent` (Set) | SH:452 (#948) | add SH:7670 (slot-held release fires after a failed outcome: `error` or `stall-timeout`, SH:7563) | SH:7661 → driver NOT fired, notice SH:7613 | delete SH:3695 (turn left text), 7643 (outcome not a failure), 3139 (person's word `userWord`), 7570 (`rearmGoalErrorResume`, from IDX:2604 and SH:9798), 1420 |
| `goalTurnOrder` (Map key→{begun,endedBegin}) | SH:460 (#893) | `onTurnBegin` SH:3537-3541 (`begun++`), `onAssistantTurnComplete` SH:3546-3548 | SH:3547 `outlived` → skip this turn end entirely (no stash, no driver) | delete SH:1422 (session deleted) |
| `nestedAutoCompactStops` (Map key→turnEpoch) | SH:478 (#1305) | SH:2127 (post-compact replay inside a held slot ended `auto-compact`) | SH:7163-7168 `takeNestedAutoCompactStop` → `resumeIfAutoCompactStop` SH:7177 | take SH:7168, retire SH:7174 (newer run), SH:1423 |
| `personStopCount` / `personStopOrder` (WeakMap session→count) | SH:485-486 | SH:7260 `noteSessionStop` for `user-stop` only (from `beforeAbort` SH:743) | SH:2307/2475 (`preparingSinceStop`), SH:3163 `stoppedWhilePreparing` (drop turn before model), SH:8592/8595 crash-recovery resume "stopped by a person → do not hand back" | Never (process lifetime) |
| `followupShutdownPreparing` | SH:621 | true SH:8399 (`prepareFollowupShutdown`); false SH:8412 (prep failed), SH:8440 (`cancelFollowupShutdownPreparation`) | SH:2042 park instead of dispatch; SH:3683 hold goal driver (#788); SH:4562 refuse goal opening; `isShuttingDown` SH:8393 → GLC `runOnce` skip (IDX:2581, GLC:377) and SH:9248; `followupAdmission` SH:7768 → no drain (SH:7465, 1702) | only on failure/cancel; process exits otherwise |
| `restartCutSessionKeys` (Set) | SH:630 | add SH:8524 in `notifyCrashRecovery` when `isWorking` (= `shouldAutoResume`, fallback `activityState==='working'`, SH:8509-8510), after the incident (SH:8515) and `safeguardHalt` (SH:8518) skips, and BEFORE the Slack notice (so also for sessions whose notice fails) | SH:8843 `cutTurn` → refund one continuation | `clear()` SH:8902 at end of `resumeActiveGoals` |
| `restartResumedSessionKeys` (Set) | SH:637 | add SH:8580 (crash recovery auto-resumes the cut turn) | SH:8798 `resumedByRestart` → no force-idle, no refund, no kick; SH:8677 handBack | delete SH:8677 (handBack before the pass), `clear()` SH:8903 |
| `restartGoalPassRan` | SH:639 | true SH:8904 | SH:8676 handBack: before the pass → leave the session to the pass | Never reset |
| `followupResumeMark` (Map key→{cause,at,items}) | SH:646 | SH:6896 via `noteFollowupResume` from SH:8590 (crash recovery), SH:8878 (resumeActiveGoals before the kick), SH:6935 (`noteAutoCompactCut`) | SH:6941 `claimFollowupResume` (next dispatch keeps it only if `isRestartResumeDispatch` SH:240-244: synthetic initial with `autoResume` or `goalContinuation`) | SH:6905 (person stop via `beforeAbort` SH:739), 6948 (10-min window), 6958 (person's message), 6961 (claimed), 8892 (goal kick threw) |
| `followupResumeRun` (Map slot→{turnEpoch,items}) | SH:652 | SH:6962 | SH:7006 `onFollowupTurnReachedModel` → take over cut rows | SH:6867 (run ended before model), 6907, 7008 |
| `followupSteerOnOpen` (Map slot→rows) | SH:671 | `waitForTurnOpen` SH:1736, from restart redelivery SH:1630 (all requeued rows if the session "resumes", else only steered ones) | pushed when a run reaches the model (SH:7002) | per-row; `forgetFollowupsWaitingForOpen` SH:1751 on delete |
| `followupRestartKick` (Set) | SH:692 | SH:1632 (requeued rows, session does not "resume") | SH:1645 `drainRestartRequeuedFollowups` | SH:1646 |
| `followupRestartRequeued` (Set) + sweep timers | SH:694, timers SH:1648-1653 (`setTimeout`, unref, delays `followupRestartSweepDelaysMs`) | SH:1619 | SH:1667-1688 sweeps; last sweep clears an `error` drain halt once (SH:1680-1686) | SH:1673 when no requeued row is left |
| `goalIntakeSeen` (Map `ch:ts`→{at,hadFiles,setGoalId}) | SH:4715 | SH:4735 claim; SH:4453 setGoalId | SH:2017 redelivered goal command → ignored | 10-min age sweep SH:4728-4731; `releaseGoalIntake` SH:4790 |
| `skippedGoalOpenings` (Set `ch:ts`) | SH:4786 | SH:4643 (`isStaleGoalOpening` true) | SH:4574 (a dispatched opening row counts as "the opening" unless skipped) | Never (process lifetime) |
| `followupMigration` (bySlot/byCanonical) | SH:4836 | `bindFollowupMigration` | every slot-busy check (SH:2097, 3830, 4580, 7539, 9198) | `releaseFollowupMigration` SH:4879 |
| `followupDegradedReason` / `followupReadFailed` | SH:430, 436 | queue init | SH:4559 goal opening refused → callers restore the goal snapshot | — |
| Dispatcher slot + drain halt (inside `FollowupDispatcher`) | `followupDispatcher` | `runInitial` (SH:2178), `drainNext` (SH:7472); halt `blocked: awaiting user choice` SH:2238 | `isBusy` everywhere (§2); `drainHalt` SH:1678, 1710, 2267 | `reopenDrainAfterAnswer` SH:2260 on a person's word (SH:3137) |
| `userTaskSlots` | SH:9300 | `noteUserTaskSlot` SH:2179 | `isTaskRunning`/`runningTasksOf` (SH:9291, 9455) | when the slot is no longer busy (SH:9456) |

### 1b. Session fields (persisted unless noted)

| Field | Writers | Readers (decision) | Cleared when |
|---|---|---|---|
| `activityState` (+`activityStateChangedAt`) | Via hooks: `SR.setActivityState` SR:2169 / `setActivityStateByKey` SR:2214 (idle → save + `drainOnIdleCallbacks` + `fireOnIdleAfterDrainHook`; waiting → save + cron drain; working → `clearPersonStop`, NOT saved). Callers: SE:1703 `working` (after `await threadPanel.beginTurn`, up to 5 s, SE:1697-1703 — the dispatch slot and the request controller already exist by then); SE:3239 `idle`/`waiting` at turn end unless a continuation or compact replay follows; SE:4126 idle after a compact replay that never took over; SE:4217 (`refuseHaltedTurn`), SE:4321, 4407, 4454 (error/halt rails); SE:7220 (retract host question: waiting→idle); SE:7288 (host question → waiting); SH:3128 (`working` when a person answers a choice); SH:3170 (idle on a stale opening with a pending choice). **Direct writes that bypass every hook (no save, no cron drain, no broadcast, no stamp):** SH:7239 `releaseStoppedPreparation`, SH:8689 handBack, SH:8822 resumeActiveGoals, SR:651 incident load, SR:3343 `resetSessionContext`, SR:4461 load (persisted value, `idle` only if slept/stopped by person), `session-initializer.ts:1466` (copied on bot-thread migration) | GLC:384 → `shouldRunGoalIdleDriver` (`goal-completion-evaluator.ts:473`: must be `'idle'`, else the loop run returns silently); SH:8812 (`waiting` + question → hold), SH:8820 (force idle); SH:8688 handBack; SH:7238; `session-manager.ts:1291` shutdown snapshot; SR:4763-4772 crash fallback; SH:1573/8510 fallback; SE:4124, 7218 | Never cleared; persisted value after a restart is whatever the last save saw (`working` is not saved on entry, SR:2186) |
| `actionPanel.waitingForChoice` | SE:3249 (turn end, unregistered choice), thread panel; cleared by `threadPanel.clearChoice` SH:3125 on `userWord` | SE:3216-3218 `choiceStillOpen`; SH:3123; SH:8813 resume hold | answer paths |
| `actionPanel.pendingQuestion` | SE:7281 (host question raw data) and model questions | SH:8813 (resume hold); dashboard NEEDS YOU | SH:3134 (person's word) |
| `pendingRetryAt` / `pendingRetrySessionId` / `pendingRetryDetail` / runtime `pendingRetryTimer` | SH:3443 detail; `scheduleErrorRetry` SH:9035 (timer), SH:9073-9075 (marker, saved); load SR:4425-4474 | SH:1624 (restart rows "resume" → steer back); SH:8939-8951 re-arm/drop; SH:8987 notice minutes; timer SH:9043/9049; `follow-up-question.ts:110`; dashboard 2607. **Not read by GLC** | `clearPendingErrorRetry` SH:9001 (from SH:8588 crash-resume supersede, SH:8865 live turn, SH:8889 goal kick, SH:8956 drop, SH:9044/9055 timer); SR:3213-3220 (`clearSessionId`), SR:3348-3357 (reset); SE:4284 (safeguard halt — marker only, timer left; the timer then skips at SH:9049) |
| `safeguardHalt` | SE:4276; `SR.haltSafeguardByKey` SR:1117; tombstone restore SR:1174; GLC:1014-1015; load SR:4475; migration copy `session-initializer.ts:1470` | SH:8517 (no crash resume), SH:8780 (no goal resume), SH:8947 (drop retry), GLC:394/564 (no eval), SE:1413 (refuse turn), SE:2994, 3926, 4055, 5480; SH:3918 gate | `SR.liftSafeguardHalt` SR:1074 (admin) |
| `goalLastTurnText` (runtime only, `types.ts:900`) | SH:3672 at every goal turn end unless the goal changed mid-leg (SH:3666) or the goal's opening is still queued (SH:3667) — **written `''` for a no-text turn** | GLC:399 evidence (`??` — a runtime `''` beats the persisted summary); SH:8790 false-stall test | `goal-action-handler.ts:281`, `goal-handler.ts:536`, `session-goal.ts:257/457/563/613`, `restoreGoalState` 815; not migrated (`session-initializer.ts:1474`); not persisted |
| `goal.lastAssistantTurnSummary` | SH:3675 (bounded mirror, saved SH:3676) | GLC:399, SH:8790 | goal helpers |
| `goal.openingPending` | SH:4604 (before handing the opening to `handleMessage`) | SH:10162 (`goalOfUnstartedOpening` → cancelling the row deletes the goal) | SH:4697 at the opening's last pre-model check; restored by snapshot on a refused admission. Survives restart (`migrateLegacyGoal` does not touch it) |
| `goal.pendingEval` | GLC (eval lease) | SH:1707 (don't drain restart-cut rows while judged); evaluator:469 | dropped at load `session-goal-lifecycle.ts:89-91` |
| `activeLegGoalId` / `activeLegGoalEpoch` | `SR.beginTurn` SR:1771 per leg | SH:3664-3667 (stale evidence) | next leg |
| `shutdownNotificationSent` / `shutdownNotifiedAt` / `wasWorkingAtShutdown` | `session-manager.ts:1298-1300` (stamped before the Slack post; `wasWorking = activityState==='working' && !stoppedByPersonSinceTurnStart`; only sessions WITH `sessionId`, not incident threads); undone on post failure :1317-1319 | SR:4749-4759 → `shouldAutoResume`; SH:1622 | SH:8642-8645 after crash recovery (only if `shutdownNotificationSent`) |
| `CrashRecoveredSession.shouldAutoResume` (in `SR._crashRecoveredSessions`) | SR:4759 (graceful: `wasWorkingAtShutdown && !sleptOnLoad && !personStopped`), SR:4772 (crash: persisted `activityState==='working' && !stoppedByPerson`) | SH:1573, SH:8510 | `clearCrashRecoveredSessions` SH:8634 |
| `lastStopAtMs`, person-stop stamp (`markPersonStop`), `autoCompactStoppedAtMs` | SH:7255-7259 (`beforeAbort`, stop-class reasons only: `user-stop`, `session-close`, `shutdown`, RC:21) | SH:7290 (no auto-compact resume), SH:6917, SR:4376 (load), `session-manager.ts:1291` | `clearPersonStop` on `working` SR:2178/2223 and `beginTurn` SR:1768. **Not read by `resumeActiveGoals` nor by GLC** |
| `compactPendingDispatches` / `compactDispatchInFlight` / `compactTurnActive` | SE:4053-4110 | SE:3235 `workingForCompactReplay` keeps `working` past turn end | SE:4096 |
| `goal.stall.questionTurnId`, `followUp.questionTurnId` | SH:9231, follow-up-question module | SH:9559 retract, SH:9512 | retire paths |
| Host-wait (no stored field) | derived: `work-queue/host-wait.ts:24-50` from `getActiveWorkQueueHost().statusFor` + `envHandoffRuns` (in memory; `env-handoff-runs.ts` header: "a restart cuts the hand-off anyway") | GLC:409 via IDX:2575-2579 (skip the run unless an auto-compact cut, #1426); SH:9259 (no follow-up question); SH:9442 (guard of 먼저 진행); dashboard 3097/4071 | n/a |
| `onIdleCallbacks` / `onIdleAfterDrainHook` | `SR.registerOnIdle` SR:2274 (cron only: `cron-scheduler.ts:551,624`); `setOnIdleAfterDrainHook` SR:768 has **no production caller** | `fireOnIdleAfterDrainHook` SR:2251 (no-op) | SR:2292, 2308 |

---

## 2. "Is a turn running?" answers

Three clocks start a turn at different moments: the dispatcher slot (`runInitial`, SH:2178, synchronous at ingress), the request controller (set during session init; removed at SH:3166/3169 on the pre-model drop), and `activityState='working'` (SE:1703, after `threadPanel.beginTurn`). SH:3801-3805 documents an 85 s gap between slot and `working` on dev. On shutdown, `RC.clearAll` deletes controllers immediately (RC `clearAll`), while turns keep unwinding.

| Place | Question it answers | Signal(s) |
|---|---|---|
| `handleMessage` fence SH:2097-2101 | may this message dispatch? | `dispatcher.isBusy(key)` or `isBusy(slotKey)` |
| `isFollowupTurnBusy` SH:3807-3812 (dashboard) | is a turn running? | same `isBusy` pair (copy 2) |
| `isFollowupSlotHeld` SH:7535-7540 | does a run hold the slot? | same `isBusy` pair (copy 3) |
| `admitGoalOpeningTurnOrThrow` SH:4580-4581 | did the opening start or queue? | `isBusy` pair before/after (copy 4) |
| `isHostTurnFree` SH:9190-9199 (#929) | would a host turn start now? | `isRequestActive` OR `isBusy` pair |
| `drainIdleRestartRequeued` SH:1706-1710 | may restart-cut rows drain? | `isBusy(key)` OR `isRequestActive(key)` OR `goal.pendingEval` OR drain halt (no slotKey) |
| `resumeActiveGoals` SH:8807-8809 (PR #1458) | is a live turn running after boot? | `isRequestActive` OR `isFollowupSlotHeld`. Not `goalLoopActing`, not `activityState` |
| `handBackFailedRestartResume` SH:8684 | is the session driven? | `isRequestActive` OR `goalLoopActing`. **Not `isFollowupSlotHeld`** |
| `releaseStoppedPreparation` SH:7238 | is the `working` stale? | `!isRequestActive` AND `activityState==='working'` |
| `resumeAfterAutoCompactStop` SH:7286 | may the host continue? | `isBusy(key)` only; active goal → leave to loop (SH:7285) |
| `noteChainSettled` SH:7131/7140/7144 | is the chain over? | `isBusy(key)` only |
| `askFollowUpQuestion` SH:9254-9259 | is anyone about to act? | `isRequestActive` OR `goalLoopActing` OR `sessionWaitsOnHost` |
| `askGoalStallQuestion` SH:9219, 9222-9224 | did a turn start meanwhile? | `isRequestActive` only (+ stall id) |
| `isTaskRunning` SH:9291 | does the user's task run? | `isFollowupTurnBusy` OR `goalLoopActing` |
| `handleAssistantTurnCompleteForGoal` SH:3700 | can the driver fire now? | `isFollowupSlotHeld` (no-text turns only) |
| GLC `runOnce` GLC:380-385 + evaluator:466-475 | may the loop run? | `!isRequestActive` AND `activityState==='idle'` (+ no `pendingEval`, no stall). No slot check |
| GLC:674, GLC:786 | may a continuation be injected? | `isRequestActive` only |
| SE:4067, SE:4120-4124 | may a post-compact replay dispatch / should the session go idle? | `isRequestActive`; `getActivityStateByKey==='working'` |
| `new` command `new-handler.ts:25` | may the session reset? | `isRequestActive` only |
| Safeguard ports SH:1110 | stop a running turn? | `isRequestActive` |
| Shutdown snapshot `session-manager.ts:1291` | was the session working? | `activityState==='working'` |
| Crash load SR:4763-4772 | was it working? | persisted `activityState` |
| `redeliverRestartCutFollowups` SH:1620-1624 | will the session resume? | autoResumed OR `wasWorkingAtShutdown` OR goal `active` OR `pendingRetryAt` |
| Error-retry timer SH:9035-9058 | — | no busy check; relies on the fence (a synthetic autoResume dropped at the fence is not held: `holdDroppedGoalContinuation` SH:7586 acts only on `goalContinuation`) |

Disagreements on the same question:
1. **Boot "is something running?"**: `resumeActiveGoals` (SH:8807) counts the held slot but not `goalLoopActing`; `handBackFailedRestartResume` (SH:8684) counts `goalLoopActing` but not the held slot. Both decide "force `activityState` idle and kick".
2. **Stale `working`**: `releaseStoppedPreparation` (SH:7238) uses the controller only; a slot held before its controller exists reads as "no turn".
3. **Loop gate vs host fence**: GLC requires `activityState==='idle'` + no controller; the host's fence uses the slot. The host therefore has to manufacture `idle` (SH:8689, 8822) for the gate to pass — the proxy #1458 tripped on. A loop run in the slot-held-before-controller window passes the gate; its continuation is then dropped at the fence and refunded (SH:7581-7606).
4. **Questions**: the follow-up question counts host-wait and `goalLoopActing` (SH:9257-9259); the stall question counts neither (SH:9219).
5. **Chain end / auto-compact resume** use `isBusy` alone; drain admission uses `isBusy || isRequestActive`.
6. Three identical copies of the slot check (SH:2097, 3810, 7539) plus a fourth inline (SH:4580, 9198).

---

## 3. Entry points into the goal loop

Direct calls of `goalTurnSettledHandler` → `GLC.onTurnSettled` (IDX:2594-2596):

| # | Site | Cause | Guards before firing |
|---|---|---|---|
| E1 | SH:3718 `handleAssistantTurnCompleteForGoal`, from `onAssistantTurnComplete` SH:3542 (`TurnRunner.finish`, `turn-runner.ts:90`; runs for handled ends incl. aborted turns with `messages: []` via `v1-query-adapter.ts:383-401`; NOT for a recoverable error, which throws → `fail`) | `turn` | session not terminated SH:3543; not outlived (#893) SH:3547; goal `active` SH:3657; not shutting down SH:3683 (#788); no-text + slot held → hold in `followupSlotHeldGoalSessions` SH:3700 (#891); outstanding follow-ups → defer SH:3709 (§3.6) |
| E2 | SH:7674 `releaseDeferredGoalDriver` slot-held branch | `kick` if `goalDriverKickOnRelease` else `turn` | rows outstanding → defer; outcome `interrupted` with reason in `GOAL_LAST_WORD_ABORT_REASONS` (SH:4799-4805) → no fire; failed twice (#948) → no fire + notice |
| E3 | SH:7684 same, deferred branch | `turn` | `canDrain`, no rows outstanding |
| — | callers of E2/E3: `drainFollowups` SH:7123 (end of every ingress run, SH:2231); action `runDrain` SH:1312 (Send now/Resume/Retry); action `chainSettled` SH:1327; `drainIdleRestartRequeued` SH:1717 | | |
| E4 | SH:8708 `handBackFailedRestartResume` | `kick` | from SH:8600 (resume not taken, not stopped by a person) and SH:8613 (resume threw); goal active; before the pass → leave to it (SH:8674-8682); no controller, loop not acting |
| E5 | SH:8886 `resumeActiveGoals` | `kick` | goal active, not `safeguardHalt`, not waiting on a question, not `resumedByRestart`, not live turn |
| E6 | SH:9799 dashboard `add` that resumed a cap-stopped current goal (`resumedCurrent`) | `kick` | none beyond retract + rearm |
| E7 | IDX:2600-2606 `setGoalLoopResumeHandler` → `resumeGoalLoop` (`goal-loop-resume.ts:23`) from `goal-cap-decision.ts:236`, `actions/goal-action-handler.ts:121,295`, `commands/goal-handler.ts:213,444` (other inventories) | `kick` | retract follow-up question, rearm #948 |
| E8 | GLC:1154 self re-enqueue (other inventory) | stored cause | |

Paths that start a turn whose end later reaches E1: goal continuation injector IDX:2525-2537 → `handleMessage` (dropped and held at SH:2111 / 2161 / 2200 when busy or user-task-dropped); goal opening `admitGoalOpeningTurn` SH:4606; `autoResumeSession` SH:9145 (crash recovery SH:8594, error retry SH:9058); `resumeAfterAutoCompactStop` SH:7320 (never for an active goal); restart-requeued drains SH:1715.

Non-entry: `SR.fireOnIdleAfterDrainHook` (SR:2207/2242) — no production code installs the hook. IDX:2499-2506 still describes the driver as firing "from the session idle-after-drain hook" (stale comment; the real trigger is E1, SH:3617-3634).

---

## 4. Restart lifecycle

Phase order and the in-memory sets each one reads/writes:

| Phase | Where | Reads | Writes |
|---|---|---|---|
| S1 prepare | IDX:2733 → SH:8397 | queue snapshot | `followupShutdownPreparing=true`; `abortSession(key,'shutdown')` for sessions with live rows → freeze rows (`paused`/`uncertain`), `noteSessionStop` (`lastStopAtMs`) |
| S2 clearAll | IDX:2734 → RC `clearAll` | controllers | aborts + deletes every controller at once (`isRequestActive` false while turns unwind). Turn ends arriving now: E1 stashes text, driver held SH:3683; GLC skips SH:377 |
| S3 notifyShutdown | IDX:2807 → SH:8369 → `session-manager.ts:1252` | `activityState`, person stop | `wasWorkingAtShutdown`, `shutdownNotificationSent` (sessions with `sessionId` only) |
| S4 save | IDX:2810 | | sessions.json |
| L1 load | IDX:893 → SH:8451 → SR `loadSessions` | persisted fields | `activityState` restored as saved (SR:4461); `goal.pendingEval` dropped; `_crashRecoveredSessions` with `shouldAutoResume`; queue reconcile → `redeliverRestartCutFollowups` SH:1565 (writes `followupRestartRequeued`, `followupSteerOnOpen`, `followupRestartKick`) |
| L2 dashboard live | IDX:1972 `startWebServer` | | dashboard actions admitted |
| L3 Slack live | IDX:2001 `app.start()`, then `await agentManager.startAll()` IDX:2041 | | user messages admitted; goal handler still unwired |
| L4 goal driver wired | IDX:2594-2607 | | `goalTurnSettledHandler`, `goalLoopActing`, resume hook |
| C1 crash recovery | IDX:2652 → SH:8489 (sequential, `await` Slack post per session + 2 s sleep SH:8622) | `shouldAutoResume`, `safeguardHalt`, `incidentRequest`, `pendingRetryAt` | `restartCutSessionKeys` (SH:8524), `restartResumedSessionKeys` (SH:8580), `followupResumeMark` (SH:8590), clears pending retry (SH:8588), fire-and-forget `autoResumeSession`; at the end clears `wasWorkingAtShutdown`/`shutdownNotificationSent` (SH:8640-8651) |
| G1 resumeActiveGoals | IDX:2664 (in `.then` of C1) → SH:8747 | `restartResumedSessionKeys`, `restartCutSessionKeys`, `isRequestActive`, `isFollowupSlotHeld`, `activityState`, `actionPanel`, `safeguardHalt`, `goalLastTurnText`/summary, stall | promotes stranded queue (SH:8763-8775), retires false stall (SH:8791-8796), forces idle (SH:8822), refunds (SH:8844-8851), `followupResumeMark` (SH:8878), kick (SH:8881), claims retry (SH:8888-8890); clears both sets and sets `restartGoalPassRan` (SH:8902-8904) |
| R1 resumePendingErrorRetries | IDX:2673 → SH:8934 | `pendingRetryAt`, `pendingRetryTimer` | re-arms `setTimeout` (SH:8970) for every marker not claimed above |
| D1 drain requeued rows | IDX:2687 (`.finally`) → SH:1644 | `followupRestartKick` | drains idle sessions; schedules sweeps (SH:1648-1653) |
| H handBack (any time later) | SH:8600/8613 → SH:8669 | `restartGoalPassRan`, `restartResumedSessionKeys`, `isRequestActive`, `goalLoopActing` | direct `activityState='idle'`, refund, kick |

Interleaving windows:
- **W1 (L3 → L4)**: Slack is live while `goalTurnSettledHandler`, `goalLoopActing` and the resume hook are unset. A turn that ends here deletes the deferral marks (SH:3716-3717) and calls a no-op (SH:3718); a dashboard `add` with `resumedCurrent` kicks nothing (SH:9799). G1 later kicks the session only if it is idle by then.
- **W2 (L3 → C1 resume for that session)**: sessions load with the persisted `working`. A person's message to a cut session dispatches (slot free). The crash-recovery resume then hits the busy fence and is dropped without a hold (autoResume is not `goalContinuation`, SH:7586) → `taken=false` → H. If H runs before G1, G1 sees a cut, not-resumed session: refund, then either "live turn" (still running) or force idle + kick (already ended — its E1 already fired the loop, so the loop is triggered twice; GLC serializes).
- **W3 (L3 → G1, ~25 s per SH:8803)**: the #1458 window. A live turn is now detected by controller or slot (SH:8807-8809). A turn ended inside the window has already fired E1 and may be in the eval (`goalLoopActing` true, no controller, no slot) — G1 does not check `goalLoopActing`, so it forces idle (no-op) and kicks again. A dashboard goal action in the window mutates the goal before G1 reads it (pause → skipped; `pauseGoalForStop` → skipped).
- **W4 (C1 resume prepared ↔ a person's stop)**: SH:3163 drops the turn; SH:8595 keeps the session from being handed back. It stays in `restartResumedSessionKeys`, so G1 leaves it "to the resume turn" (SH:8856-8862) that will never run: no force idle (its persisted `working` is fixed by `releaseStoppedPreparation` SH:7239 only if `working`), no kick. The goal stays `active` with no driver.
- **W5 (H after G1)**: `restartGoalPassRan` true; H forces idle / refunds / kicks unless controller or `goalLoopActing` — a slot held by a preparing dispatch is not checked.
- **W6 (G1 → R1)**: synchronous; but G1 `continue`s waiting-on-question (SH:8817) and safeguard sessions before claiming the retry, so R1 re-arms their retry.
- **W7 (sweeps)**: SH:1663 runs at timers for minutes after boot, reading `goal.pendingEval` as "the eval's continuation will carry the rows".

---

## 5. Implicit states (nobody declares them)

| Implicit state | Encoded as | Tested at |
|---|---|---|
| Turn dispatched, not yet working | slot busy, controller set or not, `activityState` still idle/stale | SH:3807 (dashboard), SH:8809 (#1458), SH:7700 hold; GLC cannot see it |
| Driver held for its run's slot | `followupSlotHeldGoalSessions` (+ `goalDriverKickOnRelease` = "the held driver is for a dropped continuation, no turn ended") | SH:7646-7675 |
| Driver deferred behind user work | `followupDeferredGoalSessions` | SH:7679-7684, SH:3716 |
| Automatic error resume spent | `goalErrorResumeSpent` | SH:7661 |
| Restart-cut | `restartCutSessionKeys` (from `wasWorkingAtShutdown`) or `falseStall` | SH:8843 |
| Restart-resumed but not yet started | `restartResumedSessionKeys` ∧ ¬`restartGoalPassRan` | SH:8676, 8798 |
| Restart pass done | `restartGoalPassRan` | SH:8676 |
| Resume-takeover pending | `followupResumeMark` → `followupResumeRun` | SH:6941, 7006 |
| Waiting on the owner's question | `activityState==='waiting'` ∧ (`waitingForChoice` ∨ `pendingQuestion`) | SH:8812-8818; drain halt `awaiting user choice` SH:2238/2267; GLC refuses (not idle) |
| Waiting on host work | `waitsOnHost` (work-queue host + env hand-offs) | GLC:409 (+ #1426 auto-compact exception), SH:9259 |
| Halted (safeguards) | `safeguardHalt` (+ registry tombstone) | §1b row |
| Stopping (host) | `followupShutdownPreparing` / `isShuttingDown()` | SH:2042, 3683, 4562, 9248; GLC:377 |
| Stopped by a person, goal still active | `lastStopAtMs`/person-stop stamp + goal `active`; driver not fired only through the no-text + `GOAL_LAST_WORD_ABORT_REASONS` path | SH:7650-7656; SH:8595; nothing in G1 or GLC |
| Stopped while being prepared | `personStopOrder > preparingSinceStop` | SH:3163 |
| Goal opening pending | `goal.openingPending` (persisted) and/or a queue row with `goalOpeningId` in `OUTSTANDING_FOLLOWUP_STATES` (not `paused`) | SH:10162; SH:3667; SH:4570-4576 |
| Goal under judgement | `goal.pendingEval` (dropped at load) / `goalLoopActing` | SH:1707; SH:8684 |
| Auto-compact cut, resume owed | `autoCompactPending` ∧ `autoCompactStoppedAtMs` ∧ no later stop; `nestedAutoCompactStops` | SH:7177-7204, 7290; GLC:410-412 |
| Compaction inside the turn | `compactTurnActive` ∧ replay waiting → `working` kept | SE:3235-3239 |
| Pending error retry | `pendingRetryAt` (+ timer only in this process) | SH:1624, 8864, 8888, 8939 |
| Stranded queue | `!goal ∨ goal complete` ∧ `goalQueue.length>0` | SH:8763 (boot only) |

---

## 6. Suspicious spots (facts + concrete scenario)

1. **Two boot "is it driven?" tests disagree** — SH:8684 vs SH:8807-8809. A restart resume dropped at the fence (W2) reaches H after G1. A person's next message has taken the slot and is still in its pre-controller awaits (reactions, file download, routing; SH:2440-2700). H sees no controller and no loop → writes `activityState='idle'` directly (SH:8689), refunds a continuation (SH:8703) and kicks (SH:8708). The loop's continuation is then dropped at the fence and refunded again by `holdDroppedGoalContinuation` (SH:7601-7604) — the budget gains one. Same signal gap that #1458 closed in G1 (`bbb70609`), still open in H.
2. **G1 ignores `goalLoopActing`** — SH:8807. A person's turn that ended in W3 already fired E1; the loop is in its eval. G1 forces idle (harmless) and calls the handler again with `cause:'kick'` (SH:8881) and writes a restart `followupResumeMark` (SH:8878) for a session whose next dispatch is that loop's continuation — the continuation then takes over host-cut rows the person may have chosen to leave (SH:6941-6963).
3. **A person's stop does not survive a restart for an active goal** — `stoppedByPersonSinceTurnStart` is honoured by the shutdown snapshot (`session-manager.ts:1291`) and load (SR:4376), but `resumeActiveGoals` (SH:8777-8886) never reads it. Owner presses `!` (owner's own `!` does not pause the goal, SH:7212-7216); the stopped turn's no-text end is not fired (SH:7650-7656). After the next deploy G1 kicks the loop, which judges the last text turn and may inject a continuation: the stopped work resumes with nobody asking. Inside one process, a stop pressed while the loop is evaluating (no controller) aborts nothing (SH:2467, RC `abortSession` returns false) and GLC has no stop check (no reference to `lastStopAtMs` / person stop in GLC), so the continuation is injected; `preparingSinceStop` is taken after the stop, so SH:3163 does not catch it.
4. **W4 leaves a goal active and undriven** — SH:8595-8600 returns without un-marking `restartResumedSessionKeys`; G1 then skips the session at SH:8856-8862. Fine when the person also paused the goal; with a plain stop (Slack `!`), the goal shows active with no loop and no turn until a person writes, and the next restart kicks it (spot 3).
5. **Cut detection is the `activityState` proxy** — `wasWorkingAtShutdown = activityState==='working'` (`session-manager.ts:1291`), only for sessions with a `sessionId` (:1281). A goal continuation that was dispatched (count already spent by the eval verdict) but not yet `working` at shutdown (the slot→working gap, SH:3801-3805) is not cut: no auto-resume, no refund at SH:8843; one continuation is lost per restart in that window. A first turn with no `sessionId` yet is not stamped at all.
6. **G1 is gated on C1 resolving** — IDX:2650-2681: `resumeActiveGoals` and `resumePendingErrorRetries` run inside `.then`; a rejection of `notifyCrashRecovery` (e.g. an exception from `saveSessions`/registry calls after the per-session try blocks, SH:8634-8651) skips both: every active goal stays undriven, every persisted retry stays unarmed, and `restartGoalPassRan` stays false so H defers every hand-back to a pass that never comes (SH:8674-8682). Low likelihood; no retry of the pass.
7. **Driver wired after Slack is live** — IDX:2001/2041 vs IDX:2594 (W1). A turn ending there clears `followupDeferredGoalSessions`/`followupSlotHeldGoalSessions` (SH:3716-3717) and calls a missing handler (SH:3718). Recovery relies on G1 seeing the session idle; a session `waiting` on a question or `safeguardHalt` is not kicked later, which matches intent, but a session whose turn ended just as G1 skipped it as "live turn" (still slot-held during teardown, SH:8809) is left to an E1 that already fired into nothing.
8. **Direct `activityState` writes skip the idle hooks** — SH:7239, 8689, 8822, SR:3343. A cron fire queued with `registerOnIdle` behind the stale `working` (`cron-scheduler.ts:551,624`) is not drained by these writes; it waits for the next real idle transition. These writes also skip `activityStateChangedAt` and (SH:8822) the broadcast until the batch save.
9. **`/new` keeps the goal queue** — SR:3333-3334 clears only `session.goal`; `goalQueue`/`goalPaused` survive (no other writer clears them on reset; only `goal-handler.ts:533`). G1 treats `!goal ∧ queue` as a stranded queue and promotes the next queued goal at the next boot (SH:8763-8775), kicking it — a goal from before `/new` starts after a deploy. `new-handler.ts:25` also checks only `isRequestActive`, so `/new` during a goal eval clears the goal under an in-flight eval (GLC epoch guards, other inventory). SlackHandler's driver marks (§1a) are cleared on deletion (SH:1417) but not on reset.
10. **Goal opening frozen by the shutdown** — the opening row is `queued` behind a running turn; S1 freezes it, L1 requeues it (`isRestartCutUndelivered` accepts `paused`, `followup-restart-redelivery.ts:45`); it cannot be steered (SH:5862) so it waits for the next run's end. G1 meanwhile kicks the loop for the active goal (SH:8881) although `goal.openingPending` is still true; GLC has no `openingPending` check (no reference in GLC). The loop runs on the previous goal's or empty evidence and may inject a continuation before the opening. While the opening row still waits, its cancel deletes the goal (SH:10162) even after continuation turns ran.
11. **Error retry vs goal loop are two drivers** — a recoverable error throws past `TurnRunner.finish` (`v1-query-adapter.ts:373-409`), so E1 never runs; only the timer (SH:9035) drives the goal session. The timer has no busy/goal check and its synthetic `autoResume` turn dropped at a busy fence is not held (SH:7586) — the goal then depends on the occupying turn's own E1. After a restart, G1 claims the retry only when it kicks or sees a live turn (SH:8864, 8888); a goal session waiting on a question keeps its retry (SH:8817 before the claim) and R1 re-arms it, running a turn next to the open question.
12. **`goalLastTurnText=''` beats the persisted summary** — SH:3672 writes `''` for a no-text turn; GLC:399 and SH:8790 use `??`, so the empty runtime stash hides `lastAssistantTurnSummary` within the process (also written `''` at SH:3675). Evidence for the next eval is "nothing" even when an earlier text turn exists; after a restart the stash is gone and the persisted (now empty) summary is used.
13. **Three clocks for one turn** — slot (SH:2178), controller (session init), `working` (SE:1703 after `beginTurn`, SE:1697-1702). Every guard in §2 picks one or two of them; #1458 (SH:8800-8809) and `releaseStoppedPreparation` (SH:7238) are the documented collisions.

---

## 7. Past fixes tied to the spots

`git log -L` on the ranges (newest first):

- `resumeActiveGoals` SH:8747-8932: `bbb70609`, `76a168e4` (2026-11-26, PR #1458: live turn → not forced idle; slot counts; live turn claims retry) · `8d8aa4c3`, `437bc6ed`, `23551211` (2026-11-05, #960/#961: resume a cut goal turn as itself; one refund owner) · `afdc12ac` (2026-11-04, #906 safeguard) · `5147f1f2`, `eb3471a1` (2026-11-03, #861) · `8011fd0a`, `5b076f12`, `885d1bc6`, `142a4ada` (2026-11-02, #788: false stall, refund cut turn, no loop while stopping) · `6db73f58`, `df12f2e6` (2026-11-02 stall/question) · `a9d09f62`, `bd4e66fd` (#351) · `271bfd66` (2026-06-25 origin). → spots 1, 2, 3, 4, 5, 13.
- `handBackFailedRestartResume` SH:8662-8707: `29787c38` (#989 review: free a goal-less session), `8d8aa4c3`, `437bc6ed` (#961), `c4c5ed3e` (#960 review: skip while the loop acts — added `goalLoopActing`), `972251eb` (#960 review: created). None added the slot check → spot 1.
- `notifyCrashRecovery` SH:8489-8660: `e0a7c707` (2026-11-23, person stop holds; no hand-back when stopped while preparing) → spots 3, 4 · `62aaafd4` (#966) · `972251eb`, `23551211` (#960) · `afdc12ac` (#906) · `5b076f12` (#788) · `bd4e66fd` (#351) · `156cecd6` (#916 symmetric notices) · `630a593f`, `05b2db3e` (2026-03 auto-resume).
- `handleAssistantTurnCompleteForGoal` SH:3635-3718: `e40958c0` (2026-11-06, #950/#893: one turn end per turn, refund dropped continuation, deletion clears marks) · `1f2b5210`, `8a486a04` (#948) · `c01d3f47`, `4e28a483` (#891 slot hold) · `5b076f12` (#788 hold while stopping) · `9398415b` (#742) · `83312ddf` (goal commands mid-turn) · `cdf01edf` (direct fire consumes deferral) · `29942fd1` (follow-up queue) · `db2f4ec6` (#1061: trigger from turn-settled, not idle hook) → spot 7 and the stale IDX comment in §3; spot 12.
- `releaseDeferredGoalDriver` / `holdDroppedGoalContinuation` SH:7535-7685: `e40958c0` (#893), `de4700c0`, `1f2b5210`, `8a486a04` (#948), `c01d3f47`, `4e28a483` (#891), `faa544e7` (command-consumed settles safe), `d2ea4cba` (#891 Send now release) → spots 1, 11.
- Restart redelivery / drains SH:1565-1730: `bb7c4d51` (#879 R2: skip a halted lane and a goal under judgement), `1465f720` (#879 R3), `ac604284` (#962 one ordered line), `c85de8de`…`62dd9380` (#1305 nested auto-compact stop) → spot 10, W7.
- Host-wait and the loop: `d62def3d` (2026-11-25, #1426: an auto-compact cut goal turn resumes while the session waits on host work — GLC only) → §5 host-wait row.
- Follow-up question gating: `40f26753`, `0b357ae1`, `bb3f70d3`, `7f5445f2` (#917, added `goalLoopActing`, host-wait to SH:9254-9259) → §2 disagreement 4.
- `resetSessionContext` goal clear SR:3329-3334: `e65abf2d` (2026-05-18, introduced `session.goal = undefined`), `6db73f58` (2026-11-02, end cap decision). No commit touches the queue on reset → spot 9.
- Shutdown snapshot `session-manager.ts:1252-1320`: `156cecd6` (#916 pre-await stamp), `e0a7c707` (person stop) → spot 5.

Pattern: of the ~20 commits on the restart/driver ranges since 2026-11-02, each adds one more signal to one guard (`goalLoopActing` to H in `c4c5ed3e`, the slot to G1 in `bbb70609`, the person stop to C1 in `e0a7c707`), and none adds it to the sibling guard that answers the same question.
