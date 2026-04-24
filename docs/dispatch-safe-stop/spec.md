# Safe-Stop on Dispatch Failure (Remove Default Fallback for Forced Workflows)

> Issue #698 · Final subissue of epic #694 · Consumes `HandoffContext` from #695, parallel to #696/#697 enforcement patterns.
>
> **Spec revision history**: v1 (82/100 codex) had 4 blockers — (1) outer catch scope in `slack-handler` wraps only `startWithContinuation` (not `initialize`) so Sites A/B/D would bypass it; (2) `transitionToMain` returns `false`, it does not throw, so Site C/D `try/catch` wraps are inert; (3) cleanup calls (`removeReaction`/`updateMessage`/`clearStatus`) before the throw can themselves reject and suppress `DispatchAbortError`; (4) the "⚠️ Workflow: default" status-message update contradicts safe-stop semantics. v2 addresses all four.

## Why

Epic #694 identified four structural gaps in z-controller session handoff. #695 built typed-metadata foundation. #696 shipped PR issue-link precondition. #697 shipped per-session auto-handoff budget. **#698 closes the last gap: dispatch failure drifting silently to `default` workflow.**

Spec (issue #698 §Goal):
> Handoff dispatch가 실패하면 default 세션으로 표류하지 않고 **명시적으로 stop + 유저에게 수동 재시도를 요청**한다. "phase2 직행 실패"가 "generic 세션 표류"로 귀결되지 않는다.

Current code has **two silent-drift sites** in `src/slack/pipeline/session-initializer.ts`:

1. **`dispatchWorkflow` catch (lines 785–813)**: classifier (`dispatchService.dispatch`) failure — LLM timeout, OAuth, network, malformed JSON — maps to `default` workflow with a cosmetic `⚠️ Workflow: default (dispatch failed after Xms)` update. Session continues, user gets generic default behavior, the z-handoff / skill-force intent is silently dropped.

2. **In-flight dispatch wait-timeout (lines 333–338)**: when a second message hits a session that still has an in-flight dispatch, we `Promise.race` against `DISPATCH_TIMEOUT_MS`. If that times out, we drift to `default` without surfacing the original dispatch failure.

Both sites lose the session's explicit workflow intent (if any) — `handoffContext` from a prior z-handoff, or an upstream `forceWorkflow` hint — and produce generic default behavior. Users see a `default` session where they expected their specific workflow (z-handoff follow-up, `$z <url>` entry, etc.).

#695's `HandoffAbortError` already safe-stops for z-handoff **parse** failures (missing sentinel, malformed, type mismatch). #698 generalizes the pattern to cover the **post-parse dispatch failure** cases left behind.

## What

1. **New error class**: `DispatchAbortError extends Error` (sibling of `HandoffAbortError` from #695). Carries: `reason`, `workflow` (the failed target), `sourceIssueUrl`, `parentEpicUrl`, `chainId` (all from `session.handoffContext` if available), `elapsedMs`, and a human-readable `detail` string.

2. **Pure helper module** `src/slack/dispatch-abort.ts` — exports `DispatchAbortError` class + `formatDispatchAbortMessage(error) → string`. Same pattern as `src/slack/handoff-budget.ts` (#697) and `src/hooks/pr-issue-guard.ts` (#696) — keeps slack-handler integration surface minimal.

3. **Enforcement at four sites** in `src/slack/pipeline/session-initializer.ts`:
   - **Site A** (`dispatchWorkflow` catch, line 785): when `session.handoffContext` is set OR when a `forcedWorkflowHint` (new optional parameter threaded through) is present → throw `DispatchAbortError` instead of drifting to `default`. When neither is present → keep existing default-drift behavior (backward compat per spec §Done "일반 dispatch 실패 경로는 기존과 동일 동작").
   - **Site B** (in-flight wait-timeout, line 333–338): when `session.handoffContext` is set → throw `DispatchAbortError`. Otherwise keep existing default-drift.
   - **Site C** (`runDispatch` non-z forceWorkflow branch, line 622–634): check `transitionToMain` return value. On `false` (session missing OR already transitioned — both treated as safe-stop for forceWorkflow paths per AD-4 race-loss clarification), raise `DispatchAbortError` with workflow context.
   - **Site D** (`initialize` forceWorkflow branch, line 304–320): same wrap + throw pattern.

4. **Consumer**: `src/slack-handler.ts` outer catch (lines ~555–640) adds a third arm (next to `HandoffAbortError` #695 and `HandoffBudgetExhaustedError` #697) for `DispatchAbortError`. Logs warn, posts structured Slack message via `formatDispatchAbortMessage`, and calls `terminateSession` (hard stop — dispatch failure is structural, not a soft ceiling like #697 budget).

5. **Documentation flip**: `src/local/skills/using-z/SKILL.md` Enforcement Status table row 5 ("Dispatch 실패 복구") from "default fallback 제거 일반화 (#698)" placeholder → "**구현 완료 (#698)**" with file references. Epic #694 Progress Log + checklist tick via Phase 5.E meta (plus epic closure since #698 is the final subissue).

## Success Signal

Mirrors issue #698 §Done:

| Acceptance case | Expected |
|---|---|
| `dispatchWorkflow` classifier fails + session has `handoffContext` | `DispatchAbortError` thrown; caught in slack-handler outer try/catch; postMessage with `sourceIssueUrl` + `chainId` + retry hint; session terminated |
| `dispatchWorkflow` classifier fails + session has NO `handoffContext` and no forced hint | Existing default drift unchanged (backward compat) — keeps `⚠️ Workflow: default (dispatch failed after Xms)` update |
| In-flight wait-timeout + session has `handoffContext` | `DispatchAbortError` thrown; safe-stop as above |
| In-flight wait-timeout + session has NO `handoffContext` | Existing default drift unchanged |
| `runDispatch` with non-z forceWorkflow + `transitionToMain` throws (synthetic defense-in-depth) | `DispatchAbortError` thrown with workflow context; safe-stop |
| `runDispatch` with forceWorkflow + `transitionToMain` succeeds | Normal entry (unchanged) |
| `initialize` with forceWorkflow + `transitionToMain` succeeds | Normal entry (unchanged) |
| z-handoff workflow + parse failure | `HandoffAbortError` (unchanged — #695 precedent) |
| z-handoff budget exhaustion | `HandoffBudgetExhaustedError` (unchanged — #697 precedent) |

## Architecture Decisions

### AD-1: `DispatchAbortError` as sibling, not subclass, of `HandoffAbortError`

**Why sibling, not subclass**:
- `HandoffAbortError` semantics: sentinel parse failure → terminate (#695's `HandoffAbortError` catch at `slack-handler.ts:564–594` calls `terminateSession` because a malformed handoff is structurally unrecoverable).
- `DispatchAbortError` semantics: dispatch-pipeline failure → terminate (same hard-stop, distinct reason).
- `HandoffBudgetExhaustedError` semantics: soft ceiling → session stays alive.

All three are distinct failure classes with distinct recovery semantics. Subclassing would imply `instanceof HandoffAbortError` matches both, breaking #695's terminate-session specificity logging. Separate classes keep catch arms clear.

### AD-2: Activation predicate — `session.handoffContext !== undefined` (primary); `forcedWorkflowHint` is test-seam only

**Why `handoffContext` is the primary predicate**:
- Spec literal: "forceWorkflow이 지정된 경우 default fallback 대신 safe-stop". But in current code, `dispatchWorkflow` classifier path only runs when `forceWorkflow` is absent (session-initializer.ts:321, :636) — the literal scenario is structurally unreachable today.
- Practical proxy: `session.handoffContext` was set by #695 at z-handoff entry — the session has DECLARED workflow intent. If its subsequent dispatch-pipeline step fails, default-drift would silently break that intent. This is the concrete drift that #698 must close.
- `resetSessionContext` clears `handoffContext` (session-registry.ts:1261), so false-positive risk is low: a session that legitimately transitioned away from a handoff context will not trigger safe-stop on a later classifier failure.

**Why `forcedWorkflowHint` is test-seam only**:
- Codex v1 review flagged this as YAGNI for satisfying current #698. Current callers of `dispatchWorkflow` do not pass forceWorkflow (the branch logic above ensures it).
- Retained as an optional parameter to make Site A testable without manipulating session state (tests inject `forcedWorkflowHint` to exercise the safe-stop branch). Not presented as a required production API.

**Predicate** (AD-2 canonical form):

```typescript
const session = this.deps.claudeHandler.getSession(channel, threadTs);
const shouldSafeStop = session?.handoffContext !== undefined || forcedWorkflowHint !== undefined;
```

`forcedWorkflowHint` remains in the predicate for test-seam support, but production dispatch paths never set it today.

**Alternatives rejected**:
- Always throw (never drift to default): breaks the generic Slack message flow; spec explicitly says "일반 dispatch 실패 경로는 기존과 동일 동작".
- Only check session workflow state: `session.workflow` is undefined during dispatch (pre-transitionToMain), so this predicate wouldn't fire correctly.

### AD-3: `forcedWorkflowHint` threaded through, not new public API

**Why**: Adding a parameter to `dispatchWorkflow` is an internal plumbing change. It's set by:
- `runDispatch` when `forceWorkflow` is present AND we're in a path that reaches `dispatchWorkflow` (a theoretical future path — current code never does this, but the wiring is consistent).
- `initialize` when `forceWorkflow` is present.

Tests set it directly to exercise the safe-stop branch without mocking session state.

### AD-4: `transitionToMain` returns boolean — check return value, don't wrap in try/catch

**Codex v1 fix**: `transitionToMain` returns `false` on missing or already-transitioned sessions (session-registry.ts:448); it does NOT throw. A plain `try/catch` wrap around it is inert.

**Correct pattern for Sites C/D (defense-in-depth for forceWorkflow paths)**:

```typescript
const ok = this.deps.claudeHandler.transitionToMain(channel, threadTs, forceWorkflow, title);
if (!ok) {
  const session = this.deps.claudeHandler.getSession(channel, threadTs);
  throw new DispatchAbortError(
    'transition-failed',
    'transitionToMain returned false (session missing or already transitioned)',
    forceWorkflow,
    undefined,
    session?.handoffContext,
  );
}
```

**Why this matters**: If the session was concurrently terminated or already has a workflow, the current forceWorkflow call silently does nothing (returns `false`) — the subsequent flow proceeds with undefined session state. Converting `false` → throw gives the outer catch a chance to surface the safe-stop.

**Semantic clarification (codex v2 P2)**: `transitionToMain` returns `false` in TWO distinct scenarios per `session-registry.ts:448–455`:
1. Session not found for (channel, threadTs).
2. Session already transitioned to MAIN state (losing a race to another dispatch).

Scenario 1 is clearly a structural failure — safe-stop is correct.

Scenario 2 is subtle: if another concurrent dispatch already won the transition, forcing a different workflow over it would be the actual violation. **The race-loss case is INTENTIONALLY safe-stopped** for forceWorkflow paths: the user asked for a specific workflow, the session is already committed to a different one, so we abort and surface the mismatch rather than silently ignoring the force request. This matches the spec's goal: "forceWorkflow이 지정된 경우 default fallback 대신 safe-stop" — losing a race IS a form of "not getting the forced workflow", even if no exception was thrown.

**Throw-wrapping still useful for synchronous exceptions**: if a future refactor makes `transitionToMain` async or throws on validation errors, the outer pipeline still needs to react. For current code, the boolean check is what matters.

**Revised Site C (runDispatch non-z forceWorkflow)**:

```typescript
if (forceWorkflow && this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
  this.logger.info('Forcing workflow during re-dispatch', { sessionKey, workflow: forceWorkflow });
  const ok = this.deps.claudeHandler.transitionToMain(
    channel,
    threadTs,
    forceWorkflow,
    forceWorkflow === 'onboarding' ? 'Onboarding' : 'Session Reset',
  );
  if (!ok) {
    const session = this.deps.claudeHandler.getSession(channel, threadTs);
    throw new DispatchAbortError(
      'transition-failed',
      'transitionToMain returned false for runDispatch forceWorkflow branch',
      forceWorkflow,
      undefined,
      session?.handoffContext,
    );
  }
  return;
}
```

**Revised Site D (initialize forceWorkflow)**: same pattern — check return, throw on `false`.

### AD-4.5: Cleanup robustness — best-effort cleanup cannot suppress the throw

**Codex v1 fix**: In `dispatchWorkflow` catch (line 785–813), cleanup calls in sequence:
- `await slackApi.removeReaction(channel, threadTs, 'mag')` (line 790)
- `await slackApi.updateMessage(channel, dispatchMessageTs, '⚠️ Workflow: default …')` (line 794) — **also contradicts safe-stop semantics (AD-5.1)**
- `await assistantStatusManager.clearStatus(channel, threadTs, { expectedEpoch })` (line 810)

If ANY of these reject (Slack API transient error, etc.), the rejection propagates up INSTEAD of `DispatchAbortError` — caller sees the wrong error. The safe-stop is masked.

**Pattern — best-effort cleanup with inner try/catch**:

```typescript
// Cleanup is best-effort; never let it mask the DispatchAbortError.
const bestEffort = async (label: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (cleanupErr) {
    this.logger.warn(`Dispatch-abort cleanup step failed: ${label}`, {
      channel,
      threadTs,
      error: (cleanupErr as Error).message,
    });
  }
};

// Inside the catch before the throw:
await bestEffort('removeReaction', () => this.deps.slackApi.removeReaction(channel, threadTs, 'mag'));
if (shouldSafeStop && dispatchMessageTs) {
  // AD-5.1: use safe-stop message, NOT 'Workflow: default' (would contradict the throw).
  await bestEffort('updateMessage', () =>
    this.deps.slackApi.updateMessage(channel, dispatchMessageTs!, `🚫 Dispatch 실패 — safe-stop (#698)`),
  );
}
if (shouldRunLegacyB4Path(this.deps.assistantStatusManager)) {
  await bestEffort('clearStatus', () =>
    this.deps.assistantStatusManager!.clearStatus(channel, threadTs, { expectedEpoch: dispatchEpoch }),
  );
}

if (shouldSafeStop) {
  throw new DispatchAbortError(...);
}
// default drift (unchanged) below
```

All three awaits now swallow errors with a `warn` log — the throw always surfaces unimpeded.

### AD-5.1: Safe-stop branch must NOT post "Workflow: default" message

**Codex v1 fix**: The current catch at line 793-798 updates the dispatch panel with `⚠️ Workflow: default _(dispatch failed after Xms)_`. If we throw `DispatchAbortError` afterward, the user sees BOTH the default-workflow message AND the safe-stop rejection message — contradictory UX.

**Fix**: In the safe-stop branch, replace the dispatch-panel update text with a safe-stop preview:

```typescript
if (shouldSafeStop && dispatchMessageTs) {
  await bestEffort('updateMessage', () =>
    this.deps.slackApi.updateMessage(
      channel,
      dispatchMessageTs!,
      `🚫 Dispatch 실패 — safe-stop (#698) _(${elapsed}ms)_`,
    ),
  );
}
// Default-drift branch keeps its existing message (unchanged):
// "⚠️ *Workflow:* `default` _(dispatch failed after Xms)_"
```

Two distinct text paths for two distinct outcomes. The full multi-line safe-stop message is posted by `slack-handler`'s outer catch via `formatDispatchAbortMessage`; this panel update is just the tl;dr on the in-place dispatch message.

### AD-5: Rejection message format

Same structure as #697 `formatBudgetExhaustedMessage` — postMessage surface, Korean + English mix for operator clarity:

```
🚫 Dispatch 실패 — safe-stop (host-enforced, #698)

세션이 특정 workflow로 진입하려 했지만 dispatch가 실패했습니다.
Default workflow로 드리프트하지 않고 명시적으로 중단합니다.

Workflow: `<target-workflow or 'classifier'>`
Reason: `<reason>` — <detail>
Elapsed: <ms>ms
Issue: <sourceIssueUrl or 'N/A'>
Epic: <parentEpicUrl or 'N/A'>
Chain: <chainId or 'N/A — direct session'>

원인: <human-readable cause from reason>
수동 재시도: `$z <issue-url>` (새 세션, 예산 리셋)
```

### AD-5.5: Widen `slack-handler` catch scope to include `initialize()` — with fallback variables and retry guard

**Codex v1 P0 fix**: The existing outer try/catch in `slack-handler.handleMessage` wraps `agentSession.startWithContinuation()` (line ~595) but NOT `sessionInitializer.initialize()` (line ~493). DispatchAbortError thrown from:
- Site A (`dispatchWorkflow` catch) — reachable from both `initialize()` line 343 AND from `runDispatch` line 637. Only the `runDispatch` path is currently inside the existing catch (via `onResetSession`).
- Site B (in-flight wait-timeout) — reachable ONLY from `initialize()` line 337.
- Site D (initialize forceWorkflow) — reachable ONLY from `initialize()` line 315.

Sites B and D would throw from `initialize()`, propagate up to `handleMessage`, and escape the existing catch entirely. They'd become uncaught exceptions — the handler crashes without posting the safe-stop message.

**Fix — widen the try scope AND pre-declare fallback variables** (codex v2 P1):

Current `handleMessage` derives `activeChannel` / `activeThreadTs` / `agentSession` from `initialize()`'s return value (`sessionResult`) AFTER the call succeeds. The existing generic catch uses these variables AND calls `agentSession.getRetryAfterMs()` for auto-retry. If `initialize()` throws, those names are undefined.

Restructure with outer-scope fallback declarations:

```typescript
// OUTER SCOPE — pre-declare so catch can use them even on initialize() throw.
// `event.channel` is always present; thread_ts may be undefined on root messages
// so fall back to event.ts (same pattern as session-initializer.ts:130).
let activeChannel: string = channel;  // already available from handleMessage locals
let activeThreadTs: string = originalThreadTs;  // `thread_ts || ts` computed earlier
let agentSession: V1QueryAdapter | undefined = undefined;

try {
  const sessionResult = await this.sessionInitializer.initialize(
    event, cwdResult.workingDirectory!, effectiveText, forceWorkflow,
  );
  if (sessionResult.halted) {
    await this.slackApi.removeReaction(channel, ts, 'eyes');
    return;
  }
  // Refine to migrated values if initialize re-threaded channel/thread
  // (existing derivation at slack-handler.ts:506-507).
  activeChannel = sessionResult.session.channelId || activeChannel;
  activeThreadTs =
    sessionResult.session.threadRootTs ?? sessionResult.session.threadTs ?? activeThreadTs;

  // ... intermediate synchronous setup ...
  agentSession = this.createAgentSession(sessionResult, wrappedSay, {...});
  // ... continuationHandler setup ...
  await agentSession.startWithContinuation(effectiveText || '', continuationHandler, processedFiles);
} catch (error) {
  if (error instanceof HandoffAbortError) { /* #695 */ }
  if (error instanceof HandoffBudgetExhaustedError) { /* #697 */ }
  if (error instanceof DispatchAbortError) { /* NEW #698 — uses activeChannel/activeThreadTs */ }

  // Existing auto-retry path — guard against agentSession being undefined
  // (initialize() threw before agentSession was assigned).
  if (!agentSession) {
    this.logger.warn('Error in initialize() before agentSession was created; skipping auto-retry', {
      channelId: activeChannel, threadTs: activeThreadTs, error: (error as Error).message,
    });
    return;
  }
  const retryAfterMs = agentSession.getRetryAfterMs();
  // ... existing retry scheduling ...
}
```

**Key constraints**:
1. `activeChannel` / `activeThreadTs` declared OUTSIDE try with defaults from `event.channel` / `event.thread_ts ?? event.ts` — so catch can always post to the right thread even on initialize() throw.
2. `agentSession` declared as `undefined` initially; assigned inside try after `createAgentSession`; catch checks presence before calling `.getRetryAfterMs()`.
3. The new DispatchAbortError arm doesn't depend on `agentSession` — it only uses `activeChannel` / `activeThreadTs` / error props / `this.claudeHandler`, all available.

**Safety review**: intermediate setup between `initialize` and `startWithContinuation` is all synchronous object construction — no cleanup would be needed if we threw. Widening is safe.

**Alternative considered**: add a dedicated try/catch around `initialize()` with a separate handler. Rejected — duplicates the catch-arm logic and produces two distinct `DispatchAbortError` handling sites. Single widened scope is simpler.

### AD-6: `terminateSession` (hard stop), not soft ceiling

Unlike `HandoffBudgetExhaustedError` (#697 — session stays alive for manual re-entry because budget is a soft ceiling), `DispatchAbortError` is a structural failure. The dispatch pipeline FAILED — the session is in an inconsistent state (classifier didn't return, session workflow is undetermined). Recovering from this in-place is dangerous; safer to terminate + let user re-dispatch via fresh `$z <url>`.

Matches `HandoffAbortError` (#695) semantics which also calls `terminateSession`.

### AD-7: Persistence — no changes

`DispatchAbortError` is thrown at dispatch-time and caught synchronously in the same request. It's not persisted anywhere. No `SerializedSession` changes needed.

### AD-8: Documentation flip — using-z Enforcement Status table

Row 5 ("Dispatch 실패 복구") flip:

```diff
-| Dispatch 실패 복구 | z handoff 경로는 safe-stop 구현 (#695 — `HandoffAbortError`) | default fallback 제거 일반화 (#698) |
+| Dispatch 실패 복구 | **구현 완료 (#698)** — `src/slack/dispatch-abort.ts` + `session-initializer`의 4개 drift site (classifier catch, in-flight wait-timeout, forceWorkflow transitionToMain × 2)가 `DispatchAbortError` throw로 전환; `session.handoffContext` 또는 `forcedWorkflowHint` 있을 때만 safe-stop, 일반 Slack 메시지 경로는 기존 default drift 유지; `slack-handler` 외부 catch에서 terminateSession + postMessage with handoff metadata | — |
```

With #698 flipped, all 5 rows in the Enforcement Status table show "구현 완료" — epic #694 is fully landed.

### AD-9: Test layering

| Layer | File | Purpose | New tests |
|---|---|---|---|
| L1 unit | `src/slack/dispatch-abort.test.ts` (new) | `DispatchAbortError` constructor + `formatDispatchAbortMessage` branch matrix (with/without handoffContext, with/without sourceIssueUrl, different reasons, elapsedMs undefined) | ~6 |
| L2 integration | `src/slack/pipeline/session-initializer-dispatch-safe-stop.test.ts` (new) | 8 tests covering all 4 sites + cleanup robustness: (a) classifier fail + handoffContext → throw, (b) classifier fail + no handoffContext → drift (unchanged), (c) classifier timeout → reason=classifier-timeout (distinct from classifier-failed), (d) in-flight wait-timeout + handoffContext → throw, (e) in-flight wait-timeout + no handoffContext → drift (unchanged), (f) runDispatch forceWorkflow + transitionToMain returns false → DispatchAbortError (reason=transition-failed), (g) initialize forceWorkflow + transitionToMain returns false → DispatchAbortError, (h) cleanup step failure in catch (removeReaction rejects) does NOT mask DispatchAbortError — warn logged, throw still propagates | ~8 |
| L2 integration | `src/slack-handler.test.ts` (extend) | 3 tests: (a) DispatchAbortError from `initialize()` (via widened catch scope — AD-5.5) → postMessage + terminateSession; (b) DispatchAbortError from `onResetSession` path → postMessage + terminateSession; (c) no auto-retry scheduled (getRetryAfterMs NOT called) — structural failure | ~3 |
| L2 doc | `src/slack/pipeline/session-initializer-handoff.test.ts` (extend) | Sanity: z-handoff session with handoffContext + classifier drift now throws DispatchAbortError (verifies AD-2 predicate fires on real handoff session state) | ~1 |

**Total**: ~18 new tests. Matches #697 density (18 tests).

**Critical tests explicitly called out by Codex v1**:
- `initialize()`-phase abort reaches handler + terminates (widened catch scope) — covered by `slack-handler.test.ts` test (a) above.
- Timeout maps to `classifier-timeout` (not `classifier-failed`) — covered by `session-initializer-dispatch-safe-stop.test.ts` test (c).
- Cleanup failure does not mask `DispatchAbortError` — covered by test (h).

### AD-10: Epic closure at Phase 5.E

Since #698 is the final subissue of epic #694, Phase 5.E will:
1. Update epic body — Progress Log entry for #698 + flip checklist `[ ] #698` → `[x] #698`.
2. Verify Epic Done gate: all 4 subissues closed + checklist fully `[x]`.
3. **Close epic #694** (all 4 rows of Enforcement Status table now "구현 완료").
4. Surface chain-directive's `feedback-to-protocol` item to user — ask whether to formalize "user-authorized auto-chain" case in `using-z` SKILL protocol rules.

## Out of Scope

- **Classifier retry with exponential backoff** — orthogonal concern; current behavior is single-shot with timeout. Retry policy is a separate UX decision.
- **`autoResumeSession` interaction** — when `slack-handler` outer catch rethrows, the retry path at `slack-handler.ts:630+` checks `getRetryAfterMs`. `DispatchAbortError` should NOT be retryable (structural failure) — we return from the catch explicitly without scheduling retry. Verified by T5 integration test.
- **Dispatch service self-recovery** — if the classifier can recover (e.g., retry on 429), that's inside `dispatchService.dispatch`. This work only covers the outer failure boundary.
- **Alternate dispatch paths** — `cron`, `auto-resume`, onboarding continuations use `skipDispatch` flag and don't hit the classifier. No change to those paths.
- **General Slack message classifier failures** — spec §Done explicitly preserves this behavior. Only sessions with `handoffContext` or explicit `forcedWorkflowHint` get safe-stop.

## File Manifest

**New (2)**:
- `src/slack/dispatch-abort.ts` — pure helper module (error class + message formatter, ~90 LOC)
- `src/slack/dispatch-abort.test.ts` — unit tests (~130 LOC)
- `src/slack/pipeline/session-initializer-dispatch-safe-stop.test.ts` — integration tests (~240 LOC)

**Modified (5)**:
- `src/slack/pipeline/session-initializer.ts` — 4 sites: `initialize` forceWorkflow return-check, `runDispatch` non-z forceWorkflow return-check, `dispatchWorkflow` catch predicate + best-effort cleanup + distinct safe-stop panel message, in-flight wait-timeout predicate; optional `forcedWorkflowHint` parameter on `dispatchWorkflow` (~90 LOC)
- `src/slack-handler.ts` — imports + `DispatchAbortError` catch arm (~40 LOC)
- `src/slack-handler.test.ts` — +2 integration tests (~80 LOC)
- `src/slack/pipeline/session-initializer-handoff.test.ts` — +1 regression test (~30 LOC)
- `src/local/skills/using-z/SKILL.md` — Enforcement Status row 5 flip (~2 lines)

Total: 3 new files, 5 modified files. ~660 lines net including tests. Fits "medium" tier per `using-epic-tasks`.

## Spec Changelog

- **v1** (2026-04-24): initial spec — 82/100 codex. Four blockers identified:
  - P0: outer catch in slack-handler doesn't wrap `initialize()` — Sites B/D (reachable only from initialize) would bypass the catch and become uncaught.
  - P1: `transitionToMain` returns boolean, doesn't throw — Site C/D try/catch wraps are inert.
  - P1: cleanup calls in dispatchWorkflow catch can reject and mask the throw.
  - P1: "Workflow: default" message update before safe-stop throw contradicts the safe-stop UX.
- **v2** (2026-04-24): full revision addressing all four blockers.
  - AD-4 rewritten: check `transitionToMain` return value (not try/catch) — throw DispatchAbortError on `false`.
  - NEW AD-4.5: best-effort cleanup pattern — inner try/catch on all three cleanup steps so they can't mask the main throw.
  - NEW AD-5.1: safe-stop branch uses distinct dispatch-panel message ("🚫 Dispatch 실패 — safe-stop"), preserving default-drift branch's existing message for backward compat.
  - NEW AD-5.5: widen slack-handler try scope to include `initialize()` call — Sites A/B/C/D now all caught by the outer DispatchAbortError arm.
  - AD-2 clarified: `handoffContext` is the primary predicate; `forcedWorkflowHint` is test-seam only (not required for production).
  - Test matrix expanded to 18 (up from 14) — added classifier-timeout mapping test, cleanup-failure-robustness test, initialize()-phase abort test.
- **v3** (2026-04-24): codex v2 re-review (93/100) addressed two P1/P2s.
  - AD-5.5 expanded: widened-catch needs OUTER-SCOPE fallback declarations (`activeChannel`, `activeThreadTs` default from `event.channel` / `event.thread_ts ?? event.ts`) and `agentSession` as `undefined` initially, with a guard in the generic catch path that skips auto-retry when `agentSession` is undefined (initialize() throw case).
  - AD-4 semantic clarification: `transitionToMain()` returning `false` has two distinct cases — "session not found" (structural failure) AND "already transitioned" (race loss). For forceWorkflow paths, BOTH are legitimately safe-stopped because user forced a specific workflow and the session either isn't available or is committed to a different workflow. Documented explicitly to avoid future confusion.
  - Stale v1 wording cleanup across spec/trace (doc drift only, no design changes).

## Out of scope additions (v2)

- **Refactoring `transitionToMain` to throw**: would be cleaner but affects many call sites outside this work. Out of scope for #698; the boolean-check pattern (AD-4) is sufficient here.
- **Classifier retry/backoff inside `dispatchService.dispatch`**: transient failures (5xx) could be retried internally by the service. Out of scope — this work only covers the outer failure boundary.

## Next Step

→ `trace.md` maps AD-1 through AD-10 to scenario set (S1 error class + formatter, S2 session-initializer 4 sites, S3 slack-handler catch, S4 SKILL flip, S5 epic closure).
