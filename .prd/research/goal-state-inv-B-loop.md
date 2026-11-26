# Inventory B — the goal loop driver and the evaluator

Region: `src/slack/goal-loop-controller.ts` (GLC), `src/slack/goal-completion-evaluator.ts` (GCE),
`src/prompt/goal-eval.prompt`, `src/prompt/session-goal-block.ts` (SGB), the wiring in `src/index.ts`,
and `docs/goal-command/spec.md`. Repo HEAD `cda77e0a` (after PR #1458). All line numbers are at that HEAD.
Read-only: nothing in the repo was changed.

Abbreviations: SH = `src/slack-handler.ts`, SG = `packages/slack/src/session-goal.ts`,
SI = `packages/slack/src/pipeline/session-initializer.ts`, RC = `packages/slack/src/request-coordinator.ts`.

---

## 0. Wiring (index.ts) — who can wake the loop

The controller is built once in `src/index.ts:2544-2587`. It has exactly one entry point,
`onTurnSettled(sessionKey, { cause })` (GLC:299). The callers reach it through three late-bound
holes, each a mutable field or module singleton:

| Hole | Set at | Field | Callers that fire it |
|---|---|---|---|
| `slackHandler.setGoalTurnSettledHandler` | index.ts:2594-2596 | `SH.goalTurnSettledHandler` (SH:3615) | turn end `handleAssistantTurnCompleteForGoal` SH:3718 (cause `turn`); slot-hold / deferral release `releaseDeferredGoalDriver` SH:7674 (`kick` if `goalDriverKickOnRelease`, else `turn`), SH:7684 (`turn`); restart hand-back SH:8708 (`kick`); restart pass `resumeActiveGoals` SH:8748/8874 (`kick`); dashboard add that resumed a capped goal SH:9799 (`kick`) |
| `setGoalLoopResumeHandler` | index.ts:2600-2606 | module `resumeFn` (`goal-loop-resume.ts:15`) | cap decision Continue `goal-cap-decision.ts:236`; goal-list Delete/Update `goal-action-handler.ts:121,295`; `goal <text>` that resumed a capped goal `goal-handler.ts:213`; `goal resume` on a stalled goal `goal-handler.ts:444`. The index.ts wrapper also calls `retractFollowUpQuestion` and `rearmGoalErrorResume` before the `kick`. |
| `setGoalLoopActingProbe` | index.ts:2607 | `SH.goalLoopActing` (SH:9280) | read-only probe of `GLC.isActing` (see §1) |

Injected deps that feed decisions (index.ts):
- `registry.getActivityStateByKey` → `session.activityState` (session-registry.ts:2264-2267).
- `requestCoordinator.isRequestActive` → `activeControllers.has(key)` (RC:235-237). The controller is set in
  `SI.handleConcurrency` (SI:1685), i.e. after the follow-up slot was taken and after session-init awaits.
- `isShuttingDown` → `SH.followupShutdownPreparing` (SH:8393-8395).
- `awaitingHostWork` → `waitsOnHost(channelId, threadTs)` (index.ts:2576-2579).
- `injectContinuation` → `goalMessageInjector` → `await slackHandler.handleMessage(event, say)` (index.ts:2525-2538).
  `handleMessage` awaits the whole run and the follow-up drain (SH:2224-2231) and rethrows a stored
  initial error afterwards (SH:2233-2234).
- `onRunSettled` → `setImmediate(askFollowUpQuestion)` when `!continued && !queued` (index.ts:2571-2573).
- `evalModelOverride` → `process.env.GOAL_EVAL_MODEL` (index.ts:2586).

Stale comment: index.ts:2500-2507 still says the driver "fires from the session idle-after-drain hook";
the spec (spec.md:110) and SH:3617-3633 say it moved to `onAssistantTurnComplete` (TurnRunner.finish).

---

## 1. In-memory state

### 1a. Controller instance state (GLC)

| Name | Type | Key | Writers (file:line + condition) | Readers (file:line + decision) | Cleared when |
|---|---|---|---|---|---|
| `queues` | `Map<string, Promise<void>>` | sessionKey | `enqueue` GLC:367 sets the new tail on every `onTurnSettled` | GLC:352 (chain behind previous run); `isActing` GLC:328; `settled()` GLC:347 (no production caller — grep finds none outside tests) | GLC:365 in `.finally` only if the entry is still this tail. Never on goal pause/clear/delete or session close. |
| `runsWaiting` | `Map<string, number>` | sessionKey | +1 at GLC:301 (every trigger); -1 / delete at GLC:307-309 (run's `finally`) | GLC:307 → `queued: left > 0` → `onRunSettled` (index.ts:2572 asks the follow-up question only when 0) | when count reaches 0 (GLC:309) |
| `continuedThisRun` | `Set<string>` | sessionKey | delete at run start GLC:303; add in `injectContinuationTurn` GLC:1197 (after the epoch/status re-check passed, before the inject) | GLC:310 → `continued` flag to `onRunSettled` | GLC:303 and GLC:310 |
| `injecting` | `Set<string>` (not a counter) | sessionKey | add GLC:1206 before calling `injectContinuation` | `isActing` GLC:328 → SH:8685 (restart hand-back skips), SH:9255 (no follow-up question), SH:9292 `isTaskRunning` (user task queue), SH:9491 `runningTasksOf` | GLC:1210 `.finally` of the injection promise = when `handleMessage` returns, i.e. after the continuation's whole run AND its follow-up drain (SH:2224-2231), or on throw |
| `armedEvalRetries` | `Map<string, {token, goalId, epoch, cause}>` | sessionKey | set GLC:1141 (new intent); cause upgraded to `turn` GLC:1136 (same intent, a real turn) | GLC:1128-1135 dedup on goalId+epoch (delay ignored); GLC:1145 token check at fire | GLC:1146 when its timer fires. Not cleared on pause, clear, delete, complete, epoch bump; lost on restart. |
| retry timer | `setTimeout` (unref'd), handle discarded | — | GLC:283-289 via `scheduleEvalRetry` from `armEvalRetry` GLC:1142 | fire callback GLC:1142-1155: lifts `evalBackoffUntil`/`evalRetryReason`, persists, calls `onTurnSettled(entry.cause)` | cannot be cancelled (no handle kept); no-ops at fire when token/epoch mismatch (GLC:1145-1148) |
| eval timers | `abortTimer`, `failTimer` (locals) + `AbortController` | per eval call | GLC:938-950 | `Promise.race` GLC:956-977 | GLC:979-980 `finally` |
| per-run locals | `startedAt`, `snapshot {epoch, goalId}`, `summaryHash`, `cause` | per run | GLC:510-511, 454, 300 | lease ownership checks GLC:565, 580, 591, 1016, 1051; epoch checks GLC:572, 994, 1096→1148 | end of run |
| `deps.now`, `evalTimeoutMs` | config | — | constructor GLC:279-290 | — | — |

### 1b. Evaluator module state (GCE)

| Name | Type | Writers | Readers | Cleared |
|---|---|---|---|---|
| `cachedSystemPrompt` | module `string \| null` | GCE:120 (first load, from two candidate paths GCE:114-117) | GCE:109 | only by `__resetGoalEvalPromptCacheForTests` GCE:129 |
| `logger` | module `Logger('GoalEval')` | GCE:25 | — | — |

GCE has no other state; `decideGoalEvalOutcome`, `apply*`, `shouldRunGoalIdleDriver` are pure over their arguments
except for mutating the passed goal. SGB is pure (no state).

### 1c. Module singletons the loop's callers use

| Name | File:line | Set by | Read by |
|---|---|---|---|
| `resumeFn` | goal-loop-resume.ts:15 | index.ts:2600 | `resumeGoalLoop` goal-loop-resume.ts:23-25 (no-op before wiring) |
| `hostGoalActionFn` | goal-loop-resume.ts:33 | index.ts:2610 | goal-action-handler.ts |
| `SH.goalTurnSettledHandler` | SH:3615 | index.ts:2594 | SH:3718, 7674, 7684, 8708, 8748, 9799 |
| `SH.goalLoopActing` | SH:9280 | index.ts:2607 | SH:8685, 9255, 9292, 9491 |

### 1d. Persisted goal/session fields the loop reads or writes (the loop's durable half)

Not in-memory, but they are the loop's state, and the controller is a writer of all of them:

| Field | Loop writers | Loop readers |
|---|---|---|
| `goal.pendingEval` (lease) | set GLC:512; released GLC:566, 581, 592, 1017, 1052; GCE:328, 349, 364 | gate GCE:469; dashboard `goal-eval` kind dashboard.ts:2636; follow-up-question.ts:106; SH:1709 |
| `goal.evalBackoffUntil`, `evalDispatchRetryCount`, `evalRetryReason` | GLC:554-556 (any successful dispatch, before the epoch check), 1020-1022, 1078-1083, 1101-1102, 1151-1152 | gate GLC:435; GLC:1075; dashboard.ts:2626-2634 |
| `goal.continuationCount`, `lastContinuationAt` | GCE:430-431 (continue); refund GLC:790-792 | GCE:426; SGB:92 |
| `goal.lastEvalReason`, `lastEvalRemaining` | GCE:329, 350-351 | reuse GLC:472, 497-498; previous verdict GLC:540-542; stall GCE:416; SGB:93 |
| `goal.lastEvalSummaryHash` | GLC:646 | GLC:473 |
| `goal.lastEvalGateOpen` | GLC:637 (judged verdicts only); GCE:330 | `gateGoalVerdictOnTasks` GLC:625-630; `taskGateGapClosed` GLC:479 |
| `goal.firstFailure` | GLC:484 (`progressed = true` on no-text reuse); `trackGoalFirstFailure` GLC:639 | `goalStallRollbackOffer` GLC:821 |
| `goal.stall` | `openGoalStall` GLC:821 | gate GCE:471 |
| `goal.capDmPendingAt`, `capDecisionId`, `capDmRef` | `openGoalCapDecision` GLC:708; `recordGoalCapDm` GLC:738; `retireGoalCapDecision` GLC:820, GCE:332 | GLC:713, 718 |
| `goal.status`, `completedAt`, `completedVia`, `completionReason`, `evalAttemptCount` | GCE:324-334, 352; GLC:652 | gate GCE:468; GLC:1170 |
| `session.goalLastTurnText` (runtime only) / `goal.lastAssistantTurnSummary` (persisted mirror) | written by SH:3672-3676, not by the loop | GLC:399 (evidence; runtime wins) |
| `session.systemPrompt` | cleared GLC:514, 647, 1063 | — |
| `session.safeguardHalt` | GLC:1013-1015 | GLC:394, 564 |
| `session.autoCompactPending`, `autoCompactStoppedAtMs` | — | GLC:411 |
| `session.taskLedger` | — | GLC:479, 520, 627 |

---

## 2. Decision function

### 2a. `onTurnSettled` (GLC:299-313)
No guard. Always: `runsWaiting++`, enqueue one run on the session's promise chain, return. Every trigger
produces exactly one run; dedup happens only inside `runOnce`. Runs for one session never overlap.

### 2b. `runOnce` guard order (GLC:371-605)

| # | Line | Guard | Inputs (P = persisted goal/session field, S = runtime session field, D = injected dep) | Outcome when it trips |
|---|---|---|---|---|
| 1 | GLC:375 | host shutting down | D `isShuttingDown` | skip (logged) |
| 2 | GLC:379-388 → GCE:466-475 | `shouldRunGoalIdleDriver`: no session; `goal.status !== 'active'`; `goal.pendingEval`; `goal.stall`; `isRequestActive`; `activityState !== 'idle'` | P status, P pendingEval, P stall, D isRequestActive, P/S `activityState` | silent return — none of the five reasons is logged |
| 3 | GLC:394 | safeguard halt | P `session.safeguardHalt` | skip (logged) |
| 4 | GLC:399-400 | evidence = `goalLastTurnText ?? lastAssistantTurnSummary`; `noTurnText` | S goalLastTurnText, P lastAssistantTurnSummary | — |
| 5 | GLC:409-427 | waits on host work, unless the turn was cut by an auto-compact stop (`noTurnText && autoCompactPending && autoCompactStoppedAtMs !== undefined`) | D awaitingHostWork, P autoCompact fields | skip (logged) |
| 6 | GLC:435-449 | transient-failure backoff: `now < evalBackoffUntil` | P evalBackoffUntil, D now | skip + `armEvalRetry` for the remaining window (dedup) |
| 7 | GLC:472-505 | reuse (no eval): `hasGap && (noTurnText \|\| (cause==='kick' && lastEvalSummaryHash === hash)) && !taskGateGapClosed(...)` | P lastEvalReason, P lastEvalSummaryHash, cause, P taskLedger, held tasks of waiting goals | `handleVerdict(reused: 'interrupted' \| 'unchanged')`, no lease, no eval |
| 8 | GLC:510-515 | stamp lease `pendingEval`, persist + board push | — | — |
| 9 | GLC:545-550 | eval under timeout (GLC:932-982: abort at `evalTimeoutMs` (120 s default GLC:71), fail after a further `min(5 s, timeout)` grace) | D dispatcher, model selection GLC:951-966 | throw → `handleEvalDispatchFailure` |
| 10 | GLC:554-556 | clear retry streak (runs before the epoch check, on the captured goal object) | — | — |
| 11 | GLC:564-571 | halt landed during eval | P safeguardHalt (re-read by key) | release own lease, drop verdict |
| 12 | GLC:572-585 | epoch moved / goal replaced (`epochStillValid` GLC:1234-1243: same `goalId`, same `epoch`) | P goal.goalId, P goal.epoch (re-read by key) | release own lease (if `requestedAt === startedAt`), drop verdict |
| 13 | GLC:589-596 | shutdown began during eval | D isShuttingDown | release own lease (no goalId check), drop |
| 14 | GLC:600-604 | kick + `sameAsPrevious` | cause | `stallAllowed = false` passed to handleVerdict |

### 2c. `handleEvalDispatchFailure` (GLC:984-1110)

| # | Line | Branch | Effect |
|---|---|---|---|
| 1 | GLC:1003-1043 | error carries a safeguards flag (`safeguardFlagOf` or parse error raw) — epoch ignored on purpose | halt live session/tombstone, release lease, clear retry fields, persist, abort a running turn (`abortSession(...,'safeguard')`), notice |
| 2 | GLC:1050-1057 | epoch moved | release own lease, no retry, no notice |
| 3 | GLC:1061-1069 | live goal | `applyGoalEvalDispatchFailure` (clears lease), save without board push |
| 4 | GLC:1074-1097 | `evalDispatchRetryCount < 3` | count+1, `evalBackoffUntil = now + delay` (gateway window bounded 1 s..1 h, else 60 s: GLC:99-109), reason, persist, notice, `armEvalRetry(snapshot, delay, cause)` |
| 5 | GLC:1099-1109 | budget exhausted | reset count and reason (backoff left as is), persist, terminal `⚠️` notice. No state marks "loop stopped on eval failure". |

### 2d. `handleVerdict` order (GLC:613-803)

1. Task gate GLC:625-634 (`gateGoalVerdictOnTasks`): a `completed=true` with open tasks becomes a gap; same open tasks twice becomes `sameAsPrevious` (#968).
2. `lastEvalGateOpen` GLC:637 and `trackGoalFirstFailure` GLC:639 — judged verdicts only.
3. Kick-stall suppression GLC:641-642.
4. `decideGoalEvalOutcome` GCE:406-434, in this order: `completed` → `complete`; `isGoalStallVerdict` (needs a previous `lastEvalReason`, `sameAsPrevious`, confidence ≥ 0.95, GCE:382-385) → `stalled`; `continuationCount >= maxContinuations` → `cap-paused`; else count+1 → `continue`. It mutates the goal (lease cleared, reason recorded, `evalAttemptCount++`) in every branch — including reused verdicts.
5. `lastEvalSummaryHash` GLC:646.
6. `complete` GLC:649-681: `advanceGoalQueue` then one persist, `✅` notice (awaited), if a next goal: `▶️` notice (awaited), `isRequestActive` → defer, else `injectContinuationTurn(next)` (not `spent`).
7. persist GLC:687.
8. `stalled` GLC:693-696 → `stopOnStall` GLC:810-865: retire cap decision, open stall, persist, `🛑` notice, `askStallQuestion`.
9. `cap-paused` GLC:698-768: open decision (persist + push if new), DM once per round, one of three notices.
10. `continue` GLC:772-802: `🔄` notice (awaited) → `isRequestActive` → refund one and return (GLC:786-799) → else `injectContinuationTurn(spent: true)`.

### 2e. `injectContinuationTurn` (GLC:1158-1226)
Re-reads the live goal: same goalId + epoch and `status === 'active'`, else drop (logged, no refund) — GLC:1167-1177.
Builds the synthetic event (`skipDispatch`, `routeContext.goalContinuation`, `goalContinuationSpent` when spent),
marks `continuedThisRun` and `injecting`, fires `injectContinuation` without awaiting. No `isShuttingDown` check
and no `isRequestActive` check here (the caller did it before its last await, or the fence does it).

### 2f. The idle driver predicate's inputs, by kind
- Persisted goal: `status`, `pendingEval`, `stall` (GCE:468-471).
- Session field used as a proxy: `activityState === 'idle'` (GCE:473). `waiting` means "a question is open";
  `working` means "SDK answered for a running turn" — SH:3800-3806 documents that `working` is set only once the
  SDK query answers (85 s later on dev 2026-11-06), so a dispatching turn reads `idle`.
- Injected dep used as a proxy: `isRequestActive` (GCE:472) = an AbortController registered (RC:235). SH:1980-1984
  states that `RequestCoordinator` "has no 'may start' policy" and "neither can answer 'is this session busy?'";
  the follow-up dispatcher's slot can.
- The controller never reads `actionPanel`, the follow-up slot (`isFollowupSlotHeld` / `isFollowupTurnBusy`),
  `followupDeferredGoalSessions`, `followupSlotHeldGoalSessions`, `goalErrorResumeSpent`, or `restart*SessionKeys`.

---

## 3. Implicit states of the loop per session

| State | How it is represented | Observable from one place? |
|---|---|---|
| L0 Idle, waiting for a turn end | nothing: no `queues`, `injecting`, `armedEvalRetries` entry; goal active, no lease/stall/cap/backoff | No — indistinguishable from L0x below |
| L0x Idle and stuck (no driver will come) | nothing. Arrives via: retries exhausted (GLC:1099-1109); injection failed (GLC:1211-1225); epoch-stale discard with no follow-up trigger (§5.3); silent gate refusal on stale `activityState` (§5.9); continuation dropped during shutdown (§5.4) | No — only a past thread notice or a log line |
| L1 Run queued behind another run | `runsWaiting[k] ≥ 2` and `queues[k]` | Only inside the controller (private) |
| L2 Run checking gates | `queues[k]`, synchronous | — |
| L3 Eval in flight | persisted `goal.pendingEval` + `queues[k]` + local timers | Partly: dashboard reads `pendingEval` → `goal-eval` (dashboard.ts:2636); after a crash the lease is on disk and is wiped at load (session-goal-lifecycle.ts:89-90) |
| L3b Eval aborted, in the 5 s grace window | local `AbortController.aborted` + `failTimer` | No |
| L4 Backoff waiting (timer armed) | persisted `evalBackoffUntil` + count + reason; in-memory `armedEvalRetries[k]` + an unreferenced timer | Dashboard sees the persisted half only (dashboard.ts:2626-2634) |
| L4' Backoff without a timer (after restart, before any run hits gate 6) | persisted fields only | Dashboard shows a re-check time that nothing will run until a trigger arrives |
| L5 Verdict epoch-stale (discard) | transient inside the run; afterwards nothing records it | No |
| L6 Verdict applied, notices/DM in flight | `queues[k]`; goal already mutated and persisted (count+1, lease cleared) | No — the goal reads "continuing" but no continuation exists yet |
| L7 Continuation injected, not yet holding the slot | `injecting[k]`, `continuedThisRun[k]` (until the run ends); on the SH side maybe `followupSlotHeldGoalSessions` + `goalDriverKickOnRelease` if the fence dropped it (SH:7581-7603) | Through `isActing` only, and see §5.7 |
| L8 Continuation turn running | `injecting[k]` still set (whole `handleMessage`), RC controller, `activityState` `working` once the SDK answers | No single field; three predicates disagree (§5.1) |
| L9 Parked on cap decision | persisted `capDmPendingAt`/`capDecisionId` (+`capDmRef`) | Yes (persisted) |
| L10 Parked on stall | persisted `goal.stall` | Yes (persisted) |
| L11 Parked on a question | `activityState === 'waiting'` + `actionPanel` (SH side) | Via proxies |
| L12 Parked on host work | external `waitsOnHost` | Via dep only |
| L13 Parked on safeguard halt | persisted `safeguardHalt` | Yes |
| L14 Deferred by the follow-up queue / slot hold / error-resume mark | SH in-memory sets (SH:3690-3712, 7581-7684) | Not by the controller at all |
| L15 Shutting down | `followupShutdownPreparing` | Dep only |

No single place answers "what is the loop doing for session X now?". The controller's own state is private
(`isActing` collapses L1-L8 to one boolean), the durable half is spread over ~20 goal fields, the deferral half lives in
SlackHandler sets, and the dashboard re-derives a subset from `evalBackoffUntil` and `pendingEval` (dashboard.ts:2624-2637).

---

## 4. Transitions

| From | Event | Guard | To | Side effects | File:line |
|---|---|---|---|---|---|
| any | `onTurnSettled(k, cause)` | none | L1/L2 | `runsWaiting++`, chain run | GLC:299-313 |
| L2 | run starts | shutting down | L0 | log | GLC:375-378 |
| L2 | run starts | idle-driver gate fails | L0 (or stays parked L9-L11) | none, silent | GLC:379-388 |
| L2 | run starts | safeguard halt | L13 | log | GLC:394-397 |
| L2 | run starts | waits on host and not an auto-compact cut | L12 | log | GLC:409-420 |
| L2 | run starts | `now < evalBackoffUntil` | L4 | arm retry (dedup) | GLC:435-449 |
| L2 | run starts | reuse condition | L6 (no eval) | `firstFailure.progressed = true` when no text; handleVerdict(reused) | GLC:476-505 |
| L2 | run starts | otherwise | L3 | stamp lease, clear systemPrompt, persist + push | GLC:510-515 |
| L3 | eval resolves | safeguard halt on session | L13 | release own lease | GLC:564-571 |
| L3 | eval resolves | epoch/goal moved | L5 → L0 | release own lease | GLC:572-585 |
| L3 | eval resolves | shutting down | L0 | release own lease | GLC:589-596 |
| L3 | eval resolves | valid | L6 | retry streak cleared (GLC:554-556), handleVerdict | GLC:604 |
| L3 | eval throws | safeguard flag | L13 | halt, abort running turn, notice | GLC:1003-1043 |
| L3 | eval throws | epoch moved | L0 | release own lease | GLC:1050-1057 |
| L3 | eval throws | retries < 3 | L4 | count+1, backoff stamp, notice, arm timer | GLC:1074-1097 |
| L3 | eval throws | retries exhausted | L0x | reset count, `⚠️` notice | GLC:1099-1109 |
| L4 | timer fires | token or epoch stale | (no-op) | entry deleted | GLC:1145-1148 |
| L4 | timer fires | valid | L1 | lift backoff, persist, `onTurnSettled(entry.cause)` | GLC:1149-1154 |
| L6 | verdict `complete` | no queued goal | complete | archive, persist, `✅` | GLC:649-669 |
| L6 | verdict `complete` | queued goal, request active | L0 (promoted goal, no opening turn) | `✅`, `▶️`, defer | GLC:670-677 |
| L6 | verdict `complete` | queued goal, idle | L7 | inject continuation nudge for the promoted goal (not spent) | GLC:678 |
| L6 | verdict `stalled` | — | L10 | retire cap round, open stall, persist, `🛑`, ask question | GLC:693-696, 810-865 |
| L6 | verdict `cap-paused` | — | L9 | open decision, push, DM once, notice | GLC:698-768 |
| L6 | verdict `continue` | request became active | L0 | refund one, persist | GLC:786-799 |
| L6 | verdict `continue` | idle | L7 | `🔄` notice then inject (spent) | GLC:772-802 |
| L7 | inject | live goal changed or not active | L0 (count stays spent) | log | GLC:1167-1177 |
| L7 | `handleMessage` takes the slot | — | L8 | — | SH:2224 |
| L7 | fence: slot busy / user-task drop | — | L14 | refund if same intent and no cap round, hold driver as kick | SH:2087-2088, 2152-2160, 2206-2207, 7581-7603; SI:36-39 |
| L7/L8 | `handleMessage` throws | — | L0x | `⚠️ … failed to start … The loop is paused` | GLC:1211-1225 |
| L7/L8 | `handleMessage` returns | — | (n/a) | `injecting` deleted | GLC:1210 |
| L8 | turn ends | SH deferral rules | L1 or L14 | SH stashes evidence first | SH:3634-3718 |
| run end | `finally` | — | — | `runsWaiting--`, `onRunSettled({continued, queued})` → maybe follow-up question | GLC:306-311, index.ts:2571-2573 |

---

## 5. Suspicious spots

### 5.1 Three different "a turn runs" predicates (proxy)
- The loop: `isRequestActive || activityState !== 'idle'` (GCE:472-473; re-checked alone at GLC:674, 786).
- Restart pass (PR #1458): `isRequestActive || isFollowupSlotHeld` (SH:8807-8809).
- Restart hand-back: `isRequestActive || goalLoopActing` (SH:8685). User task queue: `isFollowupTurnBusy || goalLoopActing` (SH:9292, 9491).
SH:1980-1984 says the request coordinator cannot answer "busy?"; SH:3800-3806 says `activityState` turns `working` only
when the SDK answers. The RC controller is set in `SI.handleConcurrency` (SI:1685) after session-init awaits.
Failure scenario: a kick (Continue, `goal resume`, restart pass, dashboard add) or a queued run lands after a host turn
or a person's message took the follow-up slot but before `handleConcurrency`. The loop sees "idle": it spends an eval,
and a `complete` verdict closes the goal (or a promoted goal is injected) while that turn starts; a `continue` posts
`🔄`, then the fence drops the continuation and refunds (SH:7581-7603). Same family as #1458, which fixed only the
restart pass's own predicate.

### 5.2 The restart pass ignores `isActing`
SH:8807-8809 checks `isRequestActive || isFollowupSlotHeld` but not `goalLoopActing`; the hand-back at SH:8685 does
(added in c4c5ed3e). Scenario: a person writes within the 25 s boot window; the turn ends; a loop run is evaluating
(lease set, slot free, `idle`) when the pass runs. The pass kicks (and claims `pendingRetryAt`). The kick is queued
behind the eval run. If that run injected continuation C and C has not reached `handleConcurrency` yet, the kick passes
the gate, takes the reuse path (`cause === 'kick' && alreadyJudged`, GLC:478), counts +1 and posts
"🔄 Goal continues — no new evaluation (nothing changed since the last evaluation)" next to C (GLC:772-777), then
refunds at GLC:790 or is dropped at the fence.

### 5.3 Epoch discard with no follow-up driver
M1 assumes whoever moved the epoch also drives the loop. `goal max N` does not: it bumps the epoch through
`persistGoalChange` (goal-handler.ts:150-152, 651-661), starts no turn, does not kick, and goal commands return before
the user-message reset (spec.md:252).
- Eval in flight → verdict discarded at GLC:572-585 → nothing re-drives. The goal stays active and idle until a person writes or a restart.
- `🔄` notice in flight → `injectContinuationTurn` drops at GLC:1167-1177 → the count was already spent and persisted (GCE:430, GLC:687), with no refund and no driver.
Nothing in the state says "discarded, waiting for X".

### 5.4 Shutdown can start between the last check and the injection
`isShuttingDown` is read at GLC:375 and GLC:589 only. `handleVerdict` then awaits notices (GLC:665, 671, 772) before it
injects (GLC:678, 802). `injectContinuationTurn` does not re-check. During shutdown preparation `handleMessage` parks
events (SH:2032-2035), but a synthetic event is not queueable (SH:4329), so it is refused: "Message refused" (SH:6790),
a warning reaction on a minted ts, and the thread notice "⚠️ 재시작 준비 중이라 이 메시지를 받지 못했습니다 — 잠시 후
다시 보내주세요." (SH:6815), which is addressed to a user who sent nothing. The spent continuation is not refunded. The
restart refund covers only sessions recorded `working` at shutdown (SH:8837-8846), and this one was idle. The no-eval
reuse path has the same window. 8011fd0a closed only the after-eval half.

### 5.5 Host turns do not move the epoch
The reset that bumps the epoch skips synthetic events and `hostTurn` (SH:2852). A verdict on text from before a host
turn (env hand-off result, work-queue wake, autoResume, `/compact` replay) applies while that host turn starts or runs.
Scenario: the eval judges "waiting for the lane" as the same failure, and the wake turn starts during the eval. The
`stalled` outcome opens `goal.stall` (GLC:821). The question is skipped because a turn runs. When the wake turn ends,
the gate refuses on `stall` (GCE:471), so its output (the actual deploy) is never judged until the owner writes. A
`complete` verdict in the same window closes the goal under a running turn.

### 5.6 Late epoch bump for a person's message
`resetGoalContinuationOnUserMessage` runs in `processMessage` after session init (SH:2875), after the slot was taken and
after `setController`. A verdict that lands between "message admitted" and SH:2875 is still in-epoch. A `complete`
closes the goal (and promotes the next) although the person's message (for example "also add tests") was already sent.
A `cap-paused` opens a decision and DM that the reset retires a moment later (DM rewritten to "no longer valid").

### 5.7 `injecting` is a Set held for the whole run, not until the slot is taken
GLC:319 and 323-326 say "a continuation that has not yet claimed the turn slot". The mark is cleared only when
`handleMessage` returns (GLC:1210). That call awaits `run.settled` and `drainFollowups` (SH:2224-2231), so `isActing`
is true for the whole continuation turn and any follow-up drain after it. The mark is not counted. If run N+1 injects
C2 before C1's `handleMessage` returned (for example C1 left no text, so its slot-held driver fires inside C1's drain,
SH:7647-7675, and N+1 takes the no-eval reuse path), C1's `finally` deletes the mark while C2 is still pending. Then
`isActing` reads false, and the follow-up question (SH:9255), user-task accounting (SH:9292, 9491) and the restart
hand-back (SH:8685) can act beside C2. This depends on timing.

### 5.8 "Failed to start" covers "threw during the run"
`handleMessage` rethrows an initial dispatch error after the run and the drain (SH:2233-2234; stored by SH:6855 when
`processMessage` throws). The controller then posts "⚠️ Goal continuation failed to start … The loop is paused"
(GLC:1214-1218). This also happens when the turn ran and its end already re-drove the loop. "Paused" is a notice, not a
state.

### 5.9 Silent gate
GLC:379-388 returns with no log for five different reasons. A stale `activityState` of `working` or `waiting` (no turn,
no question) makes every trigger a silent no-op. This is the proxy that the restart pass forces to `idle`
(SH:8823-8828), which is the #1458 history.

### 5.10 One persisted lease, many owners
`pendingEval` is persisted (GLC:512-515) but owned by an in-memory promise. It is cleared at load
(session-goal-lifecycle.ts:89-90), on archive restore (session-registry.ts:2065), on rebase or slot change (SG:478, 499),
by `goal done` (goal-handler.ts:471), at five controller release sites that each re-derive ownership with
`requestedAt === startedAt` (GLC:565, 580, 591 — this one has no goalId check, 1016, 1051), and in three evaluator
applies (GCE:328, 349, 364). A bot-thread migration deep-clones the goal including a live lease into a new key
(SI:1476-1478); no run owns that lease, so the new session's gate refuses at GCE:469 until a restart. That is unlikely
at first-message time.

### 5.11 Retry bookkeeping outlives its goal
`armedEvalRetries` entries and their timers survive pause, clear, delete and complete (they no-op at fire, GLC:1145-1148).
Timers cannot be cancelled (GLC:285-289 keeps no handle). Dedup ignores the delay (GLC:1135). After a restart a session
the pass skipped (`waiting`, live turn) keeps `evalBackoffUntil` with no timer, and the dashboard advertises a re-check
(dashboard.ts:2626-2634) that nothing runs. The streak reset at GLC:554-556 runs before the epoch check, on the captured
object.

### 5.12 Reuse counts as an eval
The reuse path goes through `decideGoalEvalOutcome` → `applyGoalEvalFailure`, which bumps `evalAttemptCount` (GCE:352).
GCE:366-367 says that counter means "completed eval cycles". A reused verdict at the cap opens the cap decision
(GLC:698-708) without any eval.

### 5.13 Two shapes of "a promoted goal's first turn"
- `goal done` and pause promote with `admitOpening`: the verbatim objective, plus `goalOpeningId` and `openingPending` (spec.md:90, 253).
- The eval-complete advance injects a continuation nudge instead (GLC:678 → SGB:92, "Auto-continuation 0/N", no objective in the user turn, no `openingPending`).
If that advance is deferred (GLC:674-677) or dropped at the fence, the turn that ends next is credited to no goal
(leg-goal mismatch, SH:3654-3662). The promoted goal's first eval then runs on "(no assistant text was produced this
turn)" (GLC:525): an eval spent on nothing.

### 5.14 Duplicated guards
- `isRequestActive`: checked at GLC:383, 674 and 786, then again at the fence (SI:36-39 `goalContinuation` drop; SH:2087-2088, 2206-2207).
- Refund: done in two places (GLC:790-792 and SH:7596-7603) with different conditions (the loop's refund has no cap-round check).
- Epoch: checked at GLC:572, 994/1050, 1148 and 1168, but not after the DM or notice awaits in the cap and stall branches. Those rely on `decisionId` and `questionTurnId`.
- Shutdown: checked at GLC:375 and 589, and at SH:3683.

### 5.15 Drift between docs and comments and the code
- GCE:458 says "All four must hold", but there are five checks (GCE:468-473).
- spec.md:112-117 lists four gate conditions; `stall` is missing.
- spec.md:135 says the snapshot is `epoch + createdAt`; the code uses `goalId` (GLC:244-254).
- spec.md:193 says the slack-handler stamps `pendingEval`; the controller does (GLC:512).
- index.ts:2500-2507 describes the old idle-after-drain trigger.

---

## 6. Past fixes tied to the spots

`git log` counts: GLC 45 commits, GCE 13, goal-eval.prompt 2, SGB 7. There are 52 `fix(goal…)` subjects repo-wide since
2026-09-26.

| Commit | Date | Subject (short) | Spot |
|---|---|---|---|
| f51ac24d | 06-04 | drive continuation from turn-end eval loop (#1054) | 5.1 — first spin (injection superseded a live turn) |
| c274203d | 06-05 | drive continuation from idle-settle, never supersede (#1058) | 5.1 — `isRequestActive`/`activityState` gate introduced (GCE:466-475) |
| 6b1a61d5 | 06-06 | own the ralph loop in GoalLoopController (#1069; #1054/#1058/#1061) | queues, epoch M1, fence M2, timeout M3; 5.10 lease |
| f367cd30 | 07-08 | self-heal goal eval on transient API errors | 5.11 — backoff, `armedEvalRetries` |
| a733d642 | 10-22 | drop a dead eval-retry window on epoch bump | 5.11 — backoff outlived its epoch (goal-continuation.ts:40-41) |
| 9398415b / 6db73f58 / db85ee1b | 11-02 | S9 reuse on kicks only; kicks reuse the verdict | 2b guard 7; 5.2 reuse beside a live continuation |
| 142a4ada | 11-02 | restart no longer stops interrupted goals as the same failure | 2b guard 7 (`noTurnText`); kick never stalls (GLC:600-604, 641-642) |
| 8011fd0a | 11-02 | #788 r2 — retries keep cause, no verdict while stopping | 5.4 — closed GLC:589 only; the notice → inject window stays open |
| 40f26753 / bb3f70d3 | 11-04 | #917 — `isActing`, `runsWaiting`, `injecting` | 5.7 |
| afdc12ac | 11-04 | safeguard halt on eval flag (#906) | 2c branch 1; GLC:564-571 |
| 64549dd0 / 0e48787e / 22b20b8e / b377c3bb | 11-05..06 | task gate; reuse only when gate gap closed; repeated hold = stall (#968) | 2d step 1; 2b guard 7 |
| c4c5ed3e | 11-05 | skip the hand-back kick while the loop acts | 5.2 — the hand-back got `isActing`, the pass did not |
| e40958c0 | 11-06 | #893 — refund a continuation that never ran | 5.14 — two refund sites; 5.3 has no refund at the epoch drop |
| 36dd5f5b | 11-19 | re-read the goal before injecting (#1378) | 5.3 — GLC:1167-1177 added; drops without refund or driver |
| d62def3d | 11-25 | #1426 auto-compact cut resumes while waiting on host | 2b guard 5 (a proxy for "chose to wait") |
| 76a168e4 / bbb70609 (PR #1458) | 11-26 | restart pass leaves a live turn alone; counts the held slot | 5.1, 5.2, 5.9 — `activityState` read as "no turn runs" |
