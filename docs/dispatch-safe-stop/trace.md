# Trace — Safe-Stop on Dispatch Failure (v3)

Feature: Issue #698 · Final subissue of epic #694 · Consumes `HandoffContext` from #695, sibling pattern to #696/#697

> **Revision history**:
> - **v1** (82/100 codex): initial trace with 4 blocker issues.
> - **v2** (93/100 codex): fixed all 4 blockers — AD-4 transitionToMain-returns-boolean, AD-4.5 best-effort cleanup, AD-5.1 distinct safe-stop panel message, AD-5.5 widen slack-handler try scope to include initialize(). 18 tests.
> - **v3** (current target 95+): AD-5.5 expanded with outer-scope fallback variables + agentSession undefined guard (codex v2 P1); AD-4 race-loss semantic clarification (codex v2 P2); stale v1 wording cleanup.

## Scenarios (= Task List)

| # | Scenario | Tier | Files touched | Tests | Order |
|---|---|---|---|---|---|
| S1 | `dispatch-abort.ts` — `DispatchAbortError` class + `formatDispatchAbortMessage` helper | small | `src/slack/dispatch-abort.ts` (new) | `src/slack/dispatch-abort.test.ts` (new, ~6) | 1 |
| S2 | `session-initializer.ts` — 4 drift sites converted to `DispatchAbortError` throw (activation-gated by handoffContext/forcedWorkflowHint) | medium | `src/slack/pipeline/session-initializer.ts` | `src/slack/pipeline/session-initializer-dispatch-safe-stop.test.ts` (new, ~5) | 2 |
| S3 | `slack-handler.ts` — outer catch arm for `DispatchAbortError` (terminate + postMessage) | small | `src/slack-handler.ts` | extend `src/slack-handler.test.ts` (+2) | 3 |
| S4 | `session-initializer-handoff.test.ts` — regression test for z-handoff session + post-handoff classifier drift | tiny | test only | +1 | 4 |
| S5 | `using-z/SKILL.md` — Enforcement Status table row 5 flip | tiny | `src/local/skills/using-z/SKILL.md` | doc-only | 5 |
| S6 | Epic #694 Progress Log + checklist `[x]` for #698 + close epic (Phase 5.E meta, final subissue) | tiny | epic body via gh + `gh issue close` | doc-only | 6 |

Net: 3 new files + 4 modified files + 1 epic closure. ~660 LOC including tests. Fits "medium" tier.

---

## S1 — `dispatch-abort.ts` Pure Module + Error Class

### Trigger

Spec AD-1: `DispatchAbortError` sibling of `HandoffAbortError`. Spec AD-5: `formatDispatchAbortMessage` mirrors #697's formatter pattern.

### Callstack

`src/slack/dispatch-abort.ts` (new file) — exports:

```typescript
import type { WorkflowType } from 'somalib/model-commands/session-types';
import type { HandoffContext } from '../types';

export type DispatchAbortReason =
  | 'classifier-failed'      // dispatchService.dispatch threw
  | 'classifier-timeout'     // AbortController fired (DISPATCH_TIMEOUT_MS)
  | 'wait-timeout'           // in-flight dispatch wait exceeded DISPATCH_TIMEOUT_MS
  | 'transition-failed';     // forceWorkflow transitionToMain threw (defense-in-depth)

export interface DispatchAbortContext {
  reason: DispatchAbortReason;
  workflow: WorkflowType | undefined;   // target workflow (forceWorkflow or 'classifier')
  detail: string;                       // human-readable error message
  elapsedMs?: number;
  handoffContext: HandoffContext | undefined;  // from session.handoffContext (may be undefined)
}

/**
 * Thrown by session-initializer drift sites when the session has explicit
 * workflow intent (handoffContext set by #695, or forcedWorkflowHint passed)
 * and dispatch fails. Caught at slack-handler outer try/catch alongside
 * HandoffAbortError (#695) — posts formatted Slack message via
 * formatDispatchAbortMessage, logs warn, and calls terminateSession (hard stop;
 * dispatch failure is structural, not a soft ceiling like #697 budget).
 */
export class DispatchAbortError extends Error {
  public readonly name = 'DispatchAbortError';

  constructor(
    public readonly reason: DispatchAbortReason,
    public readonly detail: string,
    public readonly workflow: WorkflowType | undefined,
    public readonly elapsedMs: number | undefined,
    public readonly handoffContext: HandoffContext | undefined,
  ) {
    super(`Dispatch failed (reason=${reason}, workflow=${workflow ?? 'classifier'}): ${detail}`);
  }
}

/** Format the user-facing Slack message for a DispatchAbortError. */
export function formatDispatchAbortMessage(ctx: DispatchAbortContext): string;
```

### Algorithm — `formatDispatchAbortMessage` (spec AD-5)

```
const workflow = ctx.workflow ?? 'classifier';
const sourceIssueUrl = ctx.handoffContext?.sourceIssueUrl ?? 'N/A';
const parentEpicUrl = ctx.handoffContext?.parentEpicUrl ?? 'N/A';
const chainId = ctx.handoffContext?.chainId ?? 'N/A — direct session';
const elapsed = ctx.elapsedMs !== undefined ? `${ctx.elapsedMs}ms` : 'unknown';
const cause = humanReadableCauseFor(ctx.reason);  // maps reason → Korean text

return [
  '🚫 Dispatch 실패 — safe-stop (host-enforced, #698)',
  '',
  '세션이 특정 workflow로 진입하려 했지만 dispatch가 실패했습니다.',
  'Default workflow로 드리프트하지 않고 명시적으로 중단합니다.',
  '',
  `Workflow: \`${workflow}\``,
  `Reason: \`${ctx.reason}\` — ${ctx.detail}`,
  `Elapsed: ${elapsed}`,
  `Issue: ${sourceIssueUrl}`,
  `Epic: ${parentEpicUrl}`,
  `Chain: ${chainId}`,
  '',
  `원인: ${cause}`,
  '수동 재시도: `$z <issue-url>` (새 세션, 예산 리셋)',
].join('\n');
```

### Contract Tests (RED)

File: `src/slack/dispatch-abort.test.ts` (new). Vitest.

```typescript
describe('DispatchAbortError', () => {
  it('T1.1 carries reason/detail/workflow/elapsedMs/handoffContext; name stable; extends Error');
  it('T1.2 message includes reason + workflow + detail');
});

describe('formatDispatchAbortMessage', () => {
  it('T1.3 reason=classifier-failed with handoffContext → includes sourceIssueUrl + chainId + parentEpicUrl');
  it('T1.4 reason=wait-timeout without handoffContext → Chain shows "N/A — direct session"; Issue shows "N/A"');
  it('T1.5 reason=transition-failed with workflow="deploy" → workflow label is "deploy" not "classifier"');
  it('T1.6 elapsedMs undefined → "Elapsed: unknown"');
});
```

### File touches

- `src/slack/dispatch-abort.ts` — NEW (~90 LOC)
- `src/slack/dispatch-abort.test.ts` — NEW (~130 LOC)

### Acceptance

All 6 RED tests written first, failing against stub. Implementation turns all GREEN.

---

## S2 — `session-initializer.ts` 4 Drift Sites → `DispatchAbortError` Throw

### Trigger

Spec AD-2: activation predicate `handoffContext present OR forcedWorkflowHint passed`. Spec AD-3: `forcedWorkflowHint` threaded through `dispatchWorkflow` as optional parameter.

### Callstack

1. **Site A — `dispatchWorkflow` catch (line 785–813)**: activation check + best-effort cleanup + distinct message for safe-stop branch (spec AD-4.5, AD-5.1).

   ```typescript
   private async dispatchWorkflow(
     channel: string,
     threadTs: string,
     text: string,
     sessionKey: string,
     forcedWorkflowHint?: WorkflowType, // NEW — issue #698, test-seam (AD-2)
   ): Promise<void> {
     // ... existing setup + classifier call ...
     } catch (error) {
       const elapsed = Date.now() - startTime;
       this.logger.error(`❌ Dispatch failed after ${elapsed}ms`, { error });

       // Issue #698 AD-2: activation check — safe-stop when session has
       // handoffContext (entered via #695) OR caller passed forcedWorkflowHint.
       // Otherwise preserve existing default-drift behavior per spec §Done.
       const session = this.deps.claudeHandler.getSession(channel, threadTs);
       const shouldSafeStop = session?.handoffContext !== undefined || forcedWorkflowHint !== undefined;

       // AD-4.5: best-effort cleanup — inner try/catch so a rejected Slack API
       // call can't mask the DispatchAbortError throw.
       const bestEffort = async (label: string, fn: () => Promise<unknown>) => {
         try { await fn(); } catch (cleanupErr) {
           this.logger.warn(`Dispatch-abort cleanup failed: ${label}`, {
             channel, threadTs, error: (cleanupErr as Error).message,
           });
         }
       };

       await bestEffort('removeReaction', () =>
         this.deps.slackApi.removeReaction(channel, threadTs, 'mag'));

       // AD-5.1: safe-stop branch uses distinct panel message.
       // Default-drift branch (below) keeps original "Workflow: default" text.
       if (dispatchMessageTs) {
         if (shouldSafeStop) {
           await bestEffort('updateMessage-safeStop', () =>
             this.deps.slackApi.updateMessage(
               channel, dispatchMessageTs!,
               `🚫 Dispatch 실패 — safe-stop (#698) _(${elapsed}ms)_`,
             ));
         } else {
           await bestEffort('updateMessage-default', () =>
             this.deps.slackApi.updateMessage(
               channel, dispatchMessageTs!,
               `⚠️ *Workflow:* \`default\` _(dispatch failed after ${elapsed}ms)_`,
             ));
         }
       }

       if (shouldSafeStop) {
         // Clear spinner before throw (best-effort — AD-4.5).
         if (shouldRunLegacyB4Path(this.deps.assistantStatusManager)) {
           await bestEffort('clearStatus-safeStop', () =>
             this.deps.assistantStatusManager!.clearStatus(channel, threadTs, {
               expectedEpoch: dispatchEpoch,
             }));
         }
         throw new DispatchAbortError(
           isAbortError(error) ? 'classifier-timeout' : 'classifier-failed',
           (error as Error).message,
           forcedWorkflowHint,
           elapsed,
           session?.handoffContext,
         );
       }

       // Default drift (UNCHANGED behavior per spec §Done)
       const fallbackTitle = MessageFormatter.generateSessionTitle(text);
       this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', fallbackTitle);
       await updateDispatchPanel('기본 워크플로우로 전환', 'idle');
       if (shouldRunLegacyB4Path(this.deps.assistantStatusManager)) {
         await this.deps.assistantStatusManager?.clearStatus(channel, threadTs, {
           expectedEpoch: dispatchEpoch,
         });
       }
     } finally {
       clearTimeout(timeoutId);
       dispatchInFlight.delete(sessionKey);
       resolveTracking!();
     }
   }
   ```

   **`finally` runs after throw** — clears `dispatchInFlight` and `timeoutId` even on DispatchAbortError path (JavaScript try/catch/finally guarantee).

2. **Site B — in-flight wait-timeout (line 333–338)**: augment with activation check.

   ```typescript
   } catch (err) {
     this.logger.warn('Timed out waiting for existing dispatch', { sessionKey, error: (err as Error).message });
     if (this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
       // Issue #698: safe-stop if session has handoffContext; otherwise drift.
       const session = this.deps.claudeHandler.getSession(channel, threadTs);
       if (session?.handoffContext !== undefined) {
         throw new DispatchAbortError(
           'wait-timeout',
           (err as Error).message,
           undefined,
           DISPATCH_TIMEOUT_MS,
           session.handoffContext,
         );
       }
       this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', 'New Session');
     }
   } finally {
     if (waitTimeoutId) clearTimeout(waitTimeoutId);
   }
   ```

3. **Site C — `runDispatch` non-z forceWorkflow branch (line 622–634)**: check `transitionToMain` return value (spec AD-4).

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
       // Issue #698: transitionToMain returns false if session is missing or
       // already transitioned — surface this as a safe-stop instead of silently
       // continuing with undefined workflow state.
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

4. **Site D — `initialize` forceWorkflow branch (line 304–320)**: same pattern.

   ```typescript
   if (forceWorkflow) {
     if (forceWorkflow === 'onboarding') {
       session.isOnboarding = true;
     } else {
       session.isOnboarding = false;
     }
     this.logger.info('Forcing session workflow from command', { sessionKey, workflow: forceWorkflow });
     const ok = this.deps.claudeHandler.transitionToMain(
       channel,
       threadTs,
       forceWorkflow,
       forceWorkflow === 'onboarding' ? 'Onboarding' : 'New Session',
     );
     if (!ok) {
       throw new DispatchAbortError(
         'transition-failed',
         'transitionToMain returned false for initialize forceWorkflow branch',
         forceWorkflow,
         undefined,
         session.handoffContext,
       );
     }
   }
   ```

### Parameter transformation

```
dispatchWorkflow(channel, threadTs, text, sessionKey, forcedWorkflowHint?)
  → classifier path (line 732 dispatchService.dispatch)
    ├─ success → transitionToMain(result.workflow)
    └─ failure (catch block)
       ├─ session.handoffContext set OR forcedWorkflowHint set
       │    → throw DispatchAbortError(reason, detail, forcedWorkflowHint, elapsed, handoffContext)
       └─ neither → transitionToMain(default)  [unchanged]

initialize(event, workingDirectory, effectiveText, forceWorkflow?)
  ├─ forceWorkflow set → transitionToMain (return-check → DispatchAbortError('transition-failed') on false)
  └─ forceWorkflow unset
     ├─ in-flight dispatch exists → wait
     │  ├─ success → classifier result handled by first dispatch
     │  └─ timeout → check session.handoffContext
     │     ├─ set → throw DispatchAbortError('wait-timeout')
     │     └─ unset → transitionToMain(default)  [unchanged]
     └─ no in-flight → dispatchWorkflow (no forcedWorkflowHint, since initialize !forceWorkflow branch)

runDispatch(channel, threadTs, text, forceWorkflow?, handoffPrompt?)
  ├─ z-handoff forceWorkflow → parse + transitionToMain or HandoffAbortError  [#695, unchanged]
  ├─ non-z forceWorkflow → transitionToMain (return-check → DispatchAbortError('transition-failed') on false)
  └─ no forceWorkflow → dispatchWorkflow (no forcedWorkflowHint in current code path)
```

### Contract Tests (RED)

File: `src/slack/pipeline/session-initializer-dispatch-safe-stop.test.ts` (new). 8 tests per spec AD-9.

```typescript
describe('dispatchWorkflow catch — #698 safe-stop', () => {
  it('T2.1 classifier throws + session.handoffContext set → DispatchAbortError thrown (reason=classifier-failed)');
  it('T2.2 classifier throws + session.handoffContext NOT set AND no hint → default drift (transitionToMain called with "default") — unchanged behavior');
  it('T2.3 classifier throws + forcedWorkflowHint=pr-review passed → DispatchAbortError thrown with workflow=pr-review (even without handoffContext)');
  it('T2.4 classifier AbortError (DISPATCH_TIMEOUT_MS fires) + handoffContext → DispatchAbortError with reason=classifier-timeout (distinct from classifier-failed)');
  it('T2.5 cleanup step rejects (slackApi.removeReaction throws) + handoffContext → DispatchAbortError still thrown (cleanup failure warn-logged, does NOT mask the main throw) — AD-4.5 robustness');
});

describe('in-flight wait-timeout — #698 safe-stop', () => {
  it('T2.6 existing dispatch never settles + session.handoffContext set → DispatchAbortError thrown (reason=wait-timeout)');
  it('T2.7 existing dispatch never settles + session.handoffContext NOT set → default drift (unchanged)');
});

describe('runDispatch / initialize forceWorkflow — AD-4 transition-failed', () => {
  it('T2.8 forceWorkflow="pr-review" + transitionToMain returns false → DispatchAbortError thrown (reason=transition-failed, workflow=pr-review)');
});
```

### File touches

- `src/slack/pipeline/session-initializer.ts` — 4 site modifications (~90 LOC)
- `src/slack/pipeline/session-initializer-dispatch-safe-stop.test.ts` — NEW (~320 LOC)

### Acceptance

All 8 RED tests written first, failing. Implementation turns all GREEN. Existing `session-initializer-handoff.test.ts` (#695) and `session-initializer-phase4.test.ts` tests remain green (no regression on forceWorkflow-success or handoff-parse-failure paths).

---

## S3 — `slack-handler.ts` Outer Catch Arm for `DispatchAbortError` + Widened Try Scope (AD-5.5)

### Trigger

Spec AD-5.5: widen try scope to include `initialize()` so Sites B/D (reachable only from `initialize()`) are inside the catch. Spec AD-6: hard-stop (terminate session) — sibling arm to `HandoffAbortError` (#695) and `HandoffBudgetExhaustedError` (#697).

### Callstack

1. **Imports** (top of file, near existing handoff-budget import):

   ```typescript
   import { DispatchAbortError, formatDispatchAbortMessage } from './slack/dispatch-abort';
   ```

2. **AD-5.5: Widen try scope**. Current code has `sessionInitializer.initialize()` call OUTSIDE the try/catch that wraps `startWithContinuation`. Move it inside:

   ```typescript
   // BEFORE (current):
   // const sessionResult = await this.sessionInitializer.initialize(...);  // NOT in try
   // ... intermediate setup ...
   // try {
   //   await agentSession.startWithContinuation(...);
   // } catch (error) {
   //   if (error instanceof HandoffAbortError) { ... }
   //   // auto-retry path
   // }

   // AFTER (#698):
   try {
     const sessionResult = await this.sessionInitializer.initialize(
       event, workingDirectory, effectiveText, forceWorkflow,
     );
     // ... intermediate synchronous setup (createAgentSession, continuationHandler) ...
     await agentSession.startWithContinuation(effectiveText || '', continuationHandler, processedFiles);
   } catch (error) {
     if (error instanceof HandoffAbortError) { /* #695 */ }
     if (error instanceof HandoffBudgetExhaustedError) { /* #697 */ }
     if (error instanceof DispatchAbortError) { /* NEW #698 */ }
     // existing auto-retry path (unchanged for other errors)
   }
   ```

   **Safety review**: intermediate setup between `initialize` and `startWithContinuation` is all synchronous object construction — no cleanup would be needed if we threw. Widening is safe.

3. **Outer catch arm for DispatchAbortError** (inside the try/catch in `handleMessage`, alongside existing `instanceof` arms):

   ```typescript
   if (error instanceof DispatchAbortError) {
     this.logger.warn('Dispatch aborted — safe-stop', {
       channelId: activeChannel,
       threadTs: activeThreadTs,
       reason: error.reason,
       workflow: error.workflow,
       detail: error.detail,
       elapsedMs: error.elapsedMs,
       chainId: error.handoffContext?.chainId,
     });
     try {
       await this.slackApi.postMessage(
         activeChannel,
         formatDispatchAbortMessage({
           reason: error.reason,
           workflow: error.workflow,
           detail: error.detail,
           elapsedMs: error.elapsedMs,
           handoffContext: error.handoffContext,
         }),
         { threadTs: activeThreadTs },
       );
     } catch (postErr) {
       this.logger.error('Failed to post dispatch-abort message', {
         channelId: activeChannel,
         threadTs: activeThreadTs,
         error: (postErr as Error).message,
       });
     }
     // Hard stop (same semantics as HandoffAbortError #695). Distinct from
     // HandoffBudgetExhaustedError (#697) which keeps session alive.
     const sessionKey = this.claudeHandler.getSessionKey(activeChannel, activeThreadTs);
     this.claudeHandler.terminateSession(sessionKey);
     return;
   }
   ```

   Placed AFTER the `HandoffAbortError` arm and BEFORE the auto-retry path, so `getRetryAfterMs` is never called for `DispatchAbortError` (structural failure, not recoverable).

### Contract Tests (RED)

Extend `src/slack-handler.test.ts` with 3 tests:

```typescript
describe('DispatchAbortError outer catch (#698)', () => {
  it('T3.1 DispatchAbortError from initialize() (widened catch scope, AD-5.5) → postMessage with safe-stop text + terminateSession called + NO auto-retry');
  it('T3.2 DispatchAbortError from onResetSession path (existing scope) → same safe-stop handling — message includes sourceIssueUrl/chainId from handoffContext; distinct from HandoffAbortError/HandoffBudgetExhaustedError message formats');
  it('T3.3 DispatchAbortError is NOT recoverable — getRetryAfterMs NOT called, auto-retry scheduler NOT invoked (structural failure)');
});
```

### File touches

- `src/slack-handler.ts` — +1 import, +catch arm, widened try scope to include `initialize()` (~60 LOC including try scope restructure)
- `src/slack-handler.test.ts` — +3 tests (~120 LOC)

### Acceptance

All 3 RED tests written first, failing. Implementation turns all GREEN. Existing `HandoffAbortError` and `HandoffBudgetExhaustedError` tests stay green. The widened try scope doesn't regress any existing non-dispatch flow.

---

## S4 — `session-initializer-handoff.test.ts` Regression Test

### Trigger

After #698 lands, a z-handoff session has `session.handoffContext` set. If classifier drift happens in this session (rare — post-handoff sessions are in MAIN state so needsDispatch=false — but possible via certain session-reset paths), it should now safe-stop rather than drift. This test confirms the interaction.

### Callstack

Extend existing handoff test file with:

```typescript
describe('post-handoff dispatch drift (#698 interaction)', () => {
  it('T4.1 session with handoffContext set + classifier throws → DispatchAbortError (safe-stop, not default drift)');
});
```

Test setup: manually set session.handoffContext (simulate prior handoff), then call `dispatchWorkflow` directly with a mocked throwing classifier. Assert `DispatchAbortError` thrown.

### File touches

- `src/slack/pipeline/session-initializer-handoff.test.ts` — +1 test (~30 LOC)

### Acceptance

New test green. Existing tests unchanged.

---

## S5 — `using-z/SKILL.md` Enforcement Status Table Row 5 Flip

### Trigger

Spec AD-8: single source of truth for epic #694 enforcement status. All 5 rows must show "구현 완료" after #698 lands.

### Callstack

`src/local/skills/using-z/SKILL.md` lines ~160 — diff:

```diff
 | 1-hop 재귀 방지 | **구현 완료 (#697)** — ... | — |
-| Dispatch 실패 복구 | z handoff 경로는 safe-stop 구현 (#695 — `HandoffAbortError`) | default fallback 제거 일반화 (#698) |
+| Dispatch 실패 복구 | **구현 완료 (#698)** — `src/slack/dispatch-abort.ts` + `session-initializer`의 4개 drift site (classifier catch, in-flight wait-timeout, forceWorkflow transitionToMain × 2)가 `DispatchAbortError` throw로 전환; `session.handoffContext` 또는 `forcedWorkflowHint` 있을 때만 safe-stop, 일반 Slack 메시지 경로는 기존 default drift 유지; `slack-handler` 외부 catch에서 terminateSession + postMessage with handoff metadata | — |
```

### File touches

- `src/local/skills/using-z/SKILL.md` — 1 row edit (~2 lines changed)

### Acceptance

Row 5 flipped; rows 1-4 unchanged. Single clean diff.

---

## S6 — Epic #694 Final Update (Phase 5.E Meta, Epic Closure)

### Trigger

Per z workflow Phase 5.E, after #698 merges, epic #694 gets:
1. Progress Log entry for #698
2. Checklist `[ ] #698` → `[x] #698`
3. **Epic closure** — all 4 subissues done, all 5 Enforcement Status rows "구현 완료"

Per chain-directive `epic-update-phase5.E-instruction`: "체크리스트가 모두 체크되면 에픽 자체를 닫는다. remaining: [] 이므로 추가 auto-chain 없음."

Chain-directive `feedback-to-protocol` item: after epic closure, surface to user the question "using-z 프로토콜에 '유저 명시 동의 기반 auto-chain' 케이스 추가 여부 검토".

### Expected Progress Log entry

```markdown
- 2026-04-24T<merge-time>Z — #698 merged via PR #<pr-num>. Safe-stop on dispatch failure
  landed; epic #694 structurally complete. `DispatchAbortError` (sibling of
  `HandoffAbortError` #695 and `HandoffBudgetExhaustedError` #697) now thrown at 4
  drift sites in `session-initializer.ts`: classifier catch, in-flight wait-timeout,
  and two `transitionToMain` defense-in-depth wraps (runDispatch + initialize
  forceWorkflow branches). Activation predicate: session has `handoffContext` (from
  #695) OR caller passed `forcedWorkflowHint` — preserves backward compat for plain
  Slack classifier failures (default drift unchanged). `slack-handler` outer catch
  adds 3rd arm (after #695/#697) calling `terminateSession` + postMessage with full
  handoff metadata (sourceIssueUrl/chainId/parentEpicUrl/reason/elapsed). 18 new tests.
  Defense-in-depth: `using-z/SKILL.md` Enforcement Status table row 5 (Dispatch 실패 복구)
  flipped to "구현 완료 (#698)" — all 5 rows now "구현 완료", epic closed.
```

### Epic closure actions

1. `mcp__github__update_issue` with body containing updated Progress Log + checklist.
2. `mcp__github__update_issue` with `state: 'closed'`.
3. Post-closure comment or user-facing message with `feedback-to-protocol` item.

### File touches

None (issue body edit + close via gh).

### Acceptance

- Epic #694 state = closed.
- Checklist all `[x]`.
- Progress Log has 4 entries (#695, #696, #697, #698).
- User prompted on `feedback-to-protocol` item.

---

## Implementation Order

Strict topological order due to cross-scenario deps:

1. **S1** — error class + formatter (standalone, no deps)
2. **S2** — session-initializer 4 sites (depends on S1 `DispatchAbortError` import)
3. **S3** — slack-handler catch (depends on S1 + S2)
4. **S4** — session-initializer-handoff test extension (depends on S2; independent of S3)
5. **S5** — SKILL.md flip (depends on S3 landing behavior; doc only)
6. **S6** — epic closure (after PR merges)

S1, S2, S4 can be drafted in parallel commits. S3 consolidates. S5 lands with S3. All tests GREEN before PR opens.

## RED → GREEN Discipline

For each scenario S1–S3:
1. Write the failing contract test first (RED).
2. Implement minimal code to pass (GREEN).
3. Refactor while keeping tests green.
4. Run the full test suite to confirm no regression.

S4 is regression-only (covers interaction, not new behavior).
S5 is doc-only.
S6 is meta (epic close via GitHub API).
