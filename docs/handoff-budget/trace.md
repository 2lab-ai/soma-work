# Trace — Per-Session Auto-Handoff Budget (v4)

Feature: Issue #697 · Part of epic #694 · Consumes typed `HandoffContext` from #695 (PR #703)

> **Revision history**: v1 targeted `onResetSession` with bare `return` (P0 — v1-query-adapter continuation loop kept running). v2 switched to `throw HandoffBudgetExhaustedError` caught at outer try/catch (same pattern as `HandoffAbortError` from #695), added `Continuation.origin` marker to distinguish model-emitted vs host-built continuations, corrected persistence plan to match manual `SerializedSession` whitelisting. v3 hardened the origin predicate to `!== 'host'` (malformed values fail closed), added the missing `stream-executor.test.ts` assertion update, and made the P0-fix regression proof explicit in T4.2. v4 is doc-consistency cleanup only — no design changes. See spec.md §Spec Changelog for full rationale.

## Scenarios (= Task List)

| # | Scenario | Tier | Files touched | Tests | Order |
|---|---|---|---|---|---|
| S1 | `handoff-budget.ts` pure module + error class + branch matrix | small | `src/slack/handoff-budget.ts` (new) | `src/slack/handoff-budget.test.ts` (new, ~9) | 1 |
| S2 | `ConversationSession.autoHandoffBudget` field + SessionRegistry whitelist + reset re-init | small | `src/types.ts`, `src/session-registry.ts` | extend `src/session-registry-handoff.test.ts` (+3) | 2 |
| S3 | `Continuation.origin` marker + stream-executor stamp sites | small | `somalib/model-commands/session-types.ts`, `src/slack/pipeline/stream-executor.ts` | covered by S4 integration | 3 |
| S4 | `slack-handler.onResetSession` budget guard + throw + outer catch | medium | `src/slack-handler.ts` | extend `src/slack-handler.test.ts` (+4) | 4 |
| S5 | Defense-in-depth: `using-z/SKILL.md` Enforcement Status table flip | tiny | `src/local/skills/using-z/SKILL.md` | doc-only | 5 |
| S6 | Session-initializer-handoff `#697` live-behavior pair | tiny | test only | +1 | 6 |
| S7 | Epic #694 Progress Log update (Phase 5.E meta, not code) | tiny | epic body via gh | doc-only | 7 |

Net: 2 new files + 10 modified files + 1 epic update. ~580 lines including tests. Fits "medium" tier.

---

## S1 — `handoff-budget.ts` Pure Module + Error Class + Branch Matrix

### Trigger

Spec AD-4: atomic check-AND-consume. AD-2: `HandoffBudgetExhaustedError` class. AD-7: `formatBudgetExhaustedMessage` helper.

Pure function + typed error = trivially unit-testable and keeps slack-handler integration surface minimal. Same pattern as `src/hooks/pr-issue-guard.ts` from #696.

### Callstack

`src/slack/handoff-budget.ts` (new file) — exports:

```typescript
import type { ConversationSession, HandoffContext } from '../types';
import type { WorkflowType } from '../../somalib/model-commands/session-types';

export const DEFAULT_AUTO_HANDOFF_BUDGET = 1;

export type BudgetRejectionReason = 'exhausted' | 'no-session';

export interface BudgetCheckResult {
  /** True when the hop is permitted (pre-check budget > 0 AND session present). */
  allowed: boolean;
  /** Budget value observed BEFORE the decrement (or rejection). */
  budgetBefore: number;
  /** Budget value AFTER the operation: allowed → budgetBefore-1; rejected → budgetBefore. */
  budgetAfter: number;
  /** When `allowed === false`, explains which branch. */
  reason?: BudgetRejectionReason;
}

/**
 * Check the auto-handoff budget on `session` and consume one hop if available.
 * Mutates `session.autoHandoffBudget` only on the allowed path.
 *
 * - `session === undefined` → fail CLOSED with reason `'no-session'` (invariant break at the onResetSession seam)
 * - `session.autoHandoffBudget ?? 1 <= 0` → fail with reason `'exhausted'`, no mutation
 * - otherwise → decrement, return `allowed: true`
 */
export function checkAndConsumeBudget(
  session: ConversationSession | undefined,
): BudgetCheckResult;

export interface BudgetRejectionContext {
  reason: BudgetRejectionReason;
  attemptedWorkflow: WorkflowType | undefined;
  handoffContext: HandoffContext | undefined;
  budgetBefore: number;
}

/** Format the user-facing Slack message. Branches on reason ('exhausted' vs 'no-session'). */
export function formatBudgetExhaustedMessage(ctx: BudgetRejectionContext): string;

/**
 * Thrown by `slack-handler.onResetSession` when `checkAndConsumeBudget` returns
 * `allowed: false`. Caught at the outer try/catch alongside HandoffAbortError
 * (slack-handler.ts:555-595) — posts the formatted Slack message, logs warn,
 * does NOT terminate the session (budget is soft-ceiling, session stays for
 * manual user re-entry).
 */
export class HandoffBudgetExhaustedError extends Error {
  public readonly name = 'HandoffBudgetExhaustedError';
  constructor(
    public readonly reason: BudgetRejectionReason,
    public readonly budgetBefore: number,
    public readonly attemptedWorkflow: WorkflowType | undefined,
    public readonly chainId: string | undefined,
  ) {
    super(`Auto-handoff budget exhausted (reason=${reason}, budget=${budgetBefore})`);
  }
}
```

### Algorithm details

**`checkAndConsumeBudget`** (spec AD-4):
```
if session === undefined:
  return { allowed: false, budgetBefore: 0, budgetAfter: 0, reason: 'no-session' }
before = session.autoHandoffBudget ?? DEFAULT_AUTO_HANDOFF_BUDGET
if before <= 0:
  return { allowed: false, budgetBefore: before, budgetAfter: before, reason: 'exhausted' }
session.autoHandoffBudget = before - 1
return { allowed: true, budgetBefore: before, budgetAfter: before - 1 }
```

**`formatBudgetExhaustedMessage`** (spec AD-7):
```
if reason === 'exhausted':
  workflow = attemptedWorkflow ?? 'default'
  chainId  = handoffContext?.chainId ?? 'N/A — direct session'
  return multi-line string with budget / workflow / chainId (see spec AD-7)
if reason === 'no-session':
  return invariant-break message (see spec AD-7)
```

### Contract Tests (RED)

File: `src/slack/handoff-budget.test.ts` (new). Vitest.

```typescript
describe('checkAndConsumeBudget', () => {
  it('T1.1 session undefined → allowed: false, reason: no-session (fails closed)');
  it('T1.2 session with autoHandoffBudget=undefined → allowed, decrement to 0');
  it('T1.3 session with autoHandoffBudget=1 → allowed, decrement to 0');
  it('T1.4 session with autoHandoffBudget=0 → rejected, reason: exhausted, no mutation');
  it('T1.5 session with autoHandoffBudget=-1 (defensive) → rejected, reason: exhausted, no mutation');
  it('T1.6 repeat call on budget=0 session returns rejected both times, no mutation');
});

describe('formatBudgetExhaustedMessage', () => {
  it('T1.7 reason=exhausted with handoffContext → includes workflow, chainId, budget count');
  it('T1.8 reason=exhausted without handoffContext → chainId shows "N/A — direct session"');
  it('T1.9 reason=no-session → invariant-break text, not the exhausted text');
});

describe('HandoffBudgetExhaustedError', () => {
  it('T1.10 carries reason/budgetBefore/attemptedWorkflow/chainId; name is stable; extends Error');
});
```

### File touches

- `src/slack/handoff-budget.ts` — NEW (~110 LOC)
- `src/slack/handoff-budget.test.ts` — NEW (~160 LOC)

### Acceptance

- All 10 RED tests written first and failing against a stub.
- Implementation turns all 10 GREEN.
- Session-mutation contracts (T1.4, T1.5, T1.6) explicitly verify no side-effects on rejection.

---

## S2 — `ConversationSession.autoHandoffBudget` Field + SessionRegistry Whitelist + Reset Re-init

### Trigger

Spec AD-1: field placement. AD-6: initialize at session creation. AD-5: re-init at `resetSessionContext`. AD-8: manual whitelist at three sites.

### Callstack

1. **`src/types.ts`** line ~186 — add field next to `handoffContext`:

   ```typescript
   /**
    * Host-enforced auto-handoff budget (issue #697, epic #694).
    *
    * Initialized to 1 at session creation. Decremented by 1 each time the
    * session emits a `CONTINUE_SESSION` (auto-handoff) via model-command. When
    * 0, the next emission is rejected by `slack-handler.onResetSession` —
    * throws `HandoffBudgetExhaustedError`, caught at the outer try/catch,
    * posts Slack message, leaves session alive for manual user re-entry.
    *
    * Re-assigned to 1 in `resetSessionContext` (same sessionKey becomes a new
    * logical session with independent budget per spec §Scope "독립 예산").
    *
    * `undefined` on deserialization from pre-#697 disk state is treated as 1
    * by `checkAndConsumeBudget` (`?? DEFAULT_AUTO_HANDOFF_BUDGET`).
    */
   autoHandoffBudget?: number;
   ```

2. **`src/session-registry.ts` — SerializedSession interface** (~line 86-149, where fields are enumerated): append

   ```typescript
   /** Host-enforced auto-handoff budget (issue #697). See ConversationSession. */
   autoHandoffBudget?: number;
   ```

3. **`src/session-registry.ts` — save path** (~line 1607-1669, inside `saveSessions()` object literal): append after `handoffContext`

   ```typescript
   handoffContext: session.handoffContext,
   // Host-enforced auto-handoff budget (#697)
   autoHandoffBudget: session.autoHandoffBudget,
   ```

4. **`src/session-registry.ts` — load path** (~line 1767-1877, inside `loadSessions()` object literal): append after `handoffContext`

   ```typescript
   handoffContext: serialized.handoffContext,
   // Host-enforced auto-handoff budget (#697). `?? 1` deferred to
   // `checkAndConsumeBudget` so pre-#697 disk state loads as undefined
   // and is handled defensively by the guard.
   autoHandoffBudget: serialized.autoHandoffBudget,
   ```

5. **`src/session-registry.ts` — `resetSessionContext`** (line 1251, right after `session.handoffContext = undefined`):

   ```typescript
   session.handoffContext = undefined;

   // Reset auto-handoff budget to fresh 1 (issue #697, epic #694).
   // After resetSessionContext, the same sessionKey is a new logical session;
   // it gets an independent budget per spec §Scope "체인 계승이 아닌 독립 예산".
   session.autoHandoffBudget = DEFAULT_AUTO_HANDOFF_BUDGET;
   ```

   Import `DEFAULT_AUTO_HANDOFF_BUDGET` from `./slack/handoff-budget`. (Alternative: hardcode `1` with a comment — avoids cross-module import of what is effectively a constant; decide in implementation, either is fine.)

6. **`src/session-registry.ts` — `getOrCreateSession`** (locate the single fresh-session constructor; `autoHandoffBudget: 1` to the initial object literal alongside other defaults). This covers all three spec §Success-Signal session-creation paths — they all materialize through this single constructor.

### Contract Tests (RED)

Extend `src/session-registry-handoff.test.ts`:

```typescript
describe('autoHandoffBudget persistence (#697)', () => {
  it('T2.1 fresh session from getOrCreateSession has autoHandoffBudget=1');
  it('T2.2 session with autoHandoffBudget=0 saves to disk with field=0; loads back as 0');
  it('T2.3 pre-#697 disk state (SerializedSession with no autoHandoffBudget) loads as undefined');
  it('T2.4 resetSessionContext re-assigns autoHandoffBudget=1 after prior decrement to 0');
});
```

### File touches

- `src/types.ts` — +1 field (+ ~15 LOC jsdoc)
- `src/session-registry.ts` — +1 SerializedSession field, +1 save mapping, +1 load mapping, +2 lines in resetSessionContext, +1 line in getOrCreateSession (~8 lines total)
- `src/session-registry-handoff.test.ts` — +4 tests (~75 LOC)

### Acceptance

- All 4 RED tests written first and failing.
- Implementation turns all 4 GREEN.
- Existing `src/session-registry-handoff.test.ts` tests stay green (no regression on #695 handoffContext behavior).

---

## S3 — `Continuation.origin` Marker + Stream-Executor Stamp Sites

### Trigger

Spec AD-3: distinguish model-emitted CONTINUE_SESSION (budget-consuming) from host-built renew/onboarding continuations (not budget-consuming). All three flow through `onResetSession` with `resetSession: true`.

### Callstack

1. **`somalib/model-commands/session-types.ts`** lines 94-99 — add `origin` field to `Continuation`:

   ```typescript
   export interface Continuation {
     prompt: string;
     resetSession?: boolean;
     dispatchText?: string;
     forceWorkflow?: WorkflowType;
     /**
      * Provenance of the continuation (issue #697, epic #694).
      * - `'model'`: emitted via CONTINUE_SESSION model-command (auto-handoff); budget-consuming.
      * - `'host'`: built programmatically by stream-executor (renew, onboarding); NOT budget-consuming.
      *
      * Optional for backward compat: legacy emitters pre-#697 may omit this
      * field; the budget guard treats undefined as `'model'` (conservative —
      * budget is consumed). External somalib consumers unaware of the field
      * worst-case false-consume once before their next reset restores budget=1.
      */
     origin?: 'model' | 'host';
   }
   ```

2. **`src/slack/pipeline/stream-executor.ts`** line ~2710-2719 — stamp model-emitted CONTINUE_SESSION with `origin: 'model'`:

   ```typescript
   if (parsed.commandId === 'CONTINUE_SESSION') {
     // Issue #697: mark model-emitted origin for auto-handoff budget enforcement.
     // Host-built continuations (renew/onboarding) set origin: 'host' at their
     // respective return sites below.
     continuation = { ...parsed.payload.continuation, origin: 'model' };
     this.logger.info('Captured CONTINUE_SESSION from model-command', {
       sessionKey: context.sessionKey,
       resetSession: continuation.resetSession === true,
       forceWorkflow: continuation.forceWorkflow,
       origin: 'model',
       dispatchTextPreview: continuation.dispatchText?.slice(0, 120),
     });
     continue;
   }
   ```

3. **`src/slack/pipeline/stream-executor.ts`** line ~3460-3464 — stamp renew continuation with `origin: 'host'`:

   ```typescript
   return {
     prompt: loadPrompt,
     resetSession: true,
     dispatchText: userMessage || undefined,
     origin: 'host', // issue #697: renew is host-built, does not consume budget
   };
   ```

4. **`src/slack/pipeline/stream-executor.ts`** line ~3635-3639 — stamp onboarding continuation with `origin: 'host'`:

   ```typescript
   return {
     prompt: result.user_message,
     resetSession: true,
     dispatchText: result.user_message,
     origin: 'host', // issue #697: onboarding is host-built, does not consume budget
   };
   ```

### Parameter transformation

```
stream-executor CONTINUE_SESSION capture
  └─ parsed.payload.continuation  (shape from model MCP payload; no origin field)
  → spread + inject origin: 'model'
  → continuation: Continuation (now with origin='model')

stream-executor renew builder
  → literal { ..., origin: 'host' }
  → Continuation (origin='host')

stream-executor onboarding builder
  → literal { ..., origin: 'host' }
  → Continuation (origin='host')

→ returned from stream-executor as part of StreamExecutorResult
→ threaded through turn-result-collector into AgentTurnResult
→ V1QueryAdapter.startWithContinuation sees continuation.origin
→ ContinuationHandler.onResetSession (slack-handler) inspects continuation.origin for S4 gate
```

### Contract Tests (RED)

Origin-marker behavior is validated indirectly through S4 integration tests (model-emitted consumes budget; renew/onboarding don't). No dedicated unit test for the stamp site — it's trivial assignment.

**BUT**: the existing stream-executor continuation-capture test at `src/slack/pipeline/stream-executor.test.ts:1474` uses exact-equality assertion on the captured continuation object. Adding `origin: 'model'` changes the shape and will break that test. Update required:

```typescript
// stream-executor.test.ts ~line 1474 (pre-#697):
expect(result.continuation).toEqual({ resetSession: true, prompt: '...' });

// Post-#697:
expect(result.continuation).toEqual({ resetSession: true, prompt: '...', origin: 'model' });
```

Similar updates for any renew/onboarding continuation assertions if they use exact equality.

### File touches

- `somalib/model-commands/session-types.ts` — +1 field (+ ~13 LOC jsdoc)
- `src/slack/pipeline/stream-executor.ts` — +3 stamp sites (~6 lines total)
- `src/slack/pipeline/stream-executor.test.ts` — update exact-equality continuation assertions to include `origin` (5-10 LOC across ~2-3 tests)

### Acceptance

- Type compiles across `somalib/` + `src/` consumers.
- `src/agent-session/turn-result-collector.ts` and downstream consumers see `origin` on `AgentTurnResult.continuation` (TypeScript-verified at build time).
- `stream-executor.test.ts` continuation-shape assertions updated; all tests green.
- S4 integration tests cover the combined end-to-end behavior (model→enforce; host→skip).

---

## S4 — `slack-handler.onResetSession` Budget Guard + Throw + Outer Catch

### Trigger

Spec AD-2: `onResetSession` throws `HandoffBudgetExhaustedError` on rejection. Spec AD-3/AD-13: gate on `continuation.origin !== 'host'` (model / undefined / malformed → enforce; `'host'` → skip). Spec AD-7: Slack rejection message via existing postMessage surface.

### Callstack

1. **`src/slack-handler.ts` imports** (top of file):

   ```typescript
   import {
     checkAndConsumeBudget,
     formatBudgetExhaustedMessage,
     HandoffBudgetExhaustedError,
     DEFAULT_AUTO_HANDOFF_BUDGET,
   } from './slack/handoff-budget';
   ```

2. **`src/slack-handler.ts` onResetSession** (replace lines 536-551):

   ```typescript
   onResetSession: async (continuation: any) => {
     // Issue #697 — host-enforced auto-handoff budget for model-emitted
     // CONTINUE_SESSION. Host-built continuations (renew/onboarding) are
     // stamped `origin: 'host'` at their stream-executor builders and skip
     // enforcement. Predicate is "anything NOT 'host' enforces" so malformed
     // values (e.g. 'MODEL', 'foo') fail closed instead of silently bypassing
     // (see spec AD-3, AD-13).
     if (continuation.origin !== undefined
         && continuation.origin !== 'model'
         && continuation.origin !== 'host') {
       this.logger.warn('Continuation.origin has unexpected value; treating as model-emitted', {
         channelId: activeChannel,
         threadTs: activeThreadTs,
         origin: continuation.origin,
       });
     }
     const enforce = continuation.origin !== 'host';
     if (enforce) {
       const currentSession = this.claudeHandler.getSession(activeChannel, activeThreadTs);
       const budget = checkAndConsumeBudget(currentSession);
       if (!budget.allowed) {
         throw new HandoffBudgetExhaustedError(
           budget.reason!,
           budget.budgetBefore,
           continuation.forceWorkflow,
           currentSession?.handoffContext?.chainId,
         );
       }
     }

     // Existing flow (unchanged from v1)
     this.claudeHandler.resetSessionContext(activeChannel, activeThreadTs);
     const dispatchText = continuation.dispatchText || continuation.prompt;
     const handoffPrompt = isZHandoffWorkflow(continuation.forceWorkflow)
       ? (continuation.prompt as string | undefined)
       : undefined;
     await this.sessionInitializer.runDispatch(
       activeChannel,
       activeThreadTs,
       dispatchText,
       continuation.forceWorkflow,
       handoffPrompt,
     );
   },
   ```

3. **`src/slack-handler.ts` outer catch** (insert after `HandoffAbortError` block, around line 594):

   ```typescript
   if (error instanceof HandoffBudgetExhaustedError) {
     this.logger.warn('Auto-handoff budget exhausted — CONTINUE_SESSION rejected', {
       channelId: activeChannel,
       threadTs: activeThreadTs,
       reason: error.reason,
       budgetBefore: error.budgetBefore,
       forceWorkflow: error.attemptedWorkflow,
       chainId: error.chainId,
     });
     try {
       await this.slackApi.postMessage(
         activeChannel,
         formatBudgetExhaustedMessage({
           reason: error.reason,
           attemptedWorkflow: error.attemptedWorkflow,
           handoffContext: this.claudeHandler.getSession(activeChannel, activeThreadTs)?.handoffContext,
           budgetBefore: error.budgetBefore,
         }),
         { threadTs: activeThreadTs },
       );
     } catch (postErr) {
       this.logger.error('Failed to post budget-exhausted message', {
         channelId: activeChannel,
         threadTs: activeThreadTs,
         error: (postErr as Error).message,
       });
     }
     // Do NOT call terminateSession — budget exhaustion is a soft ceiling;
     // session stays alive for manual user re-entry via $z or plain message.
     return;
   }
   ```

### Parameter transformation

```
continuation (from V1QueryAdapter)
  └─ origin: 'model' | 'host' | undefined
  └─ forceWorkflow: WorkflowType | undefined
  └─ prompt / dispatchText

currentSession (from claudeHandler.getSession)
  └─ autoHandoffBudget: number | undefined
  └─ handoffContext?: HandoffContext (chainId source for error)

origin === 'host':
  → skip guard; fall through to existing reset + dispatch

origin !== 'host' (i.e. 'model', undefined, or any malformed value):
  → (warn log if value is unexpected: not in {'model', 'host', undefined})
  → checkAndConsumeBudget(currentSession)
    ├─ allowed: true → mutation done; fall through to existing reset + dispatch
    └─ allowed: false → throw HandoffBudgetExhaustedError(reason, budgetBefore, forceWorkflow, chainId)

throw propagates → V1QueryAdapter.startWithContinuation → slack-handler try/catch
  → caught by new HandoffBudgetExhaustedError block
  → log warn, postMessage, return (no terminateSession)
```

### Contract Tests (RED)

Extend `src/slack-handler.test.ts`:

```typescript
describe('onResetSession budget enforcement (#697)', () => {
  it('T4.1 model-emitted (origin:model) budget=1 first hop → decrements to 0, proceeds with reset+dispatch');
  it(`T4.2 model-emitted (origin:model) budget=0 second hop → throws HandoffBudgetExhaustedError; caught; postMessage with exhausted-reason text;
       session NOT terminated; resetSessionContext NOT called; streamExecutor.execute called EXACTLY ONCE (proves the throw stops the v1-query-adapter continuation loop — spec AD-12 P0-fix regression proof)`);
  it('T4.3 host-built (origin:host) continuation → skips guard entirely; resets and dispatches even when session.autoHandoffBudget=0');
  it('T4.4 model-emitted but session gone (invariant break) → throws with reason: no-session; postMessage with invariant-break text; session NOT terminated; postMessage failure during this path is logged, does not crash the handler');
  it('T4.5 origin:"MODEL" (wrong case, adversarial) → predicate falls through to enforcement; budget consumed; warn log fired for unexpected value');
});
```

**T4.2 test construction (AD-12)**: mock `streamExecutor.execute` to return a turn result whose `continuation = { resetSession: true, prompt: 'next', origin: 'model' }` on the FIRST invocation. Pre-populate `session.autoHandoffBudget = 0`. Wire the adapter through the real `V1QueryAdapter.startWithContinuation` path. After the test function resolves, assert `streamExecutor.execute` call count === 1 (not 2), `resetSessionContext` call count === 0, `postMessage` call count === 1 with the exhausted-reason text. This proves the P0 fix: throw-from-`onResetSession` actually stops the loop instead of letting v1-query-adapter call `continue(prompt)` next.

### File touches

- `src/slack-handler.ts` — +4 imports, ~30 LOC in onResetSession, ~25 LOC in outer catch (~60 LOC total)
- `src/slack-handler.test.ts` — +5 tests (~140 LOC) — includes T4.2 continuation-loop-stop proof (AD-12) and T4.5 adversarial origin value

### Acceptance

- All 5 RED tests written first and failing.
- Implementation turns all 5 GREEN.
- Existing `slack-handler.test.ts` tests around HandoffAbortError and plain continuation flows stay green.
- T4.2 explicitly proves the P0 fix (streamExecutor.execute call count === 1 after throw — loop stopped, not another turn).
- Manual `$z <url>` flow unchanged: skill-force-handler triggers initial dispatch; the first CONTINUE_SESSION emission from phase2 will be `origin: 'model'` and correctly decrement the new session's budget from 1 to 0.

---

## S5 — `using-z/SKILL.md` Enforcement Status Table Flip

### Trigger

Spec AD-9: two rows in the Enforcement Status table (lines 154-161) have #697 placeholders that go stale post-merge. The SKILL's §Enforcement Status line 162 declares this table the "single source of truth" — keeping it accurate is a functional requirement.

### Callstack

`src/local/skills/using-z/SKILL.md` lines 154-161 — diff:

```diff
 | 항목 | 현재 강제 수단 | 목표 강제 수단 |
 |---|---|---|
 | Handoff #1 전 Issue URL 검증 | **구현 완료 (#696)** — `src/hooks/pr-issue-guard.ts` via in-process SDK PreToolUse hook (Bash + MCP) + prompt 계약 (defense-in-depth) | — |
 | 결정적 새 세션 진입 | **구현 완료 (#695)** — 전용 `WorkflowType` (`z-plan-to-work`, `z-epic-update`) + host sentinel 검증 + `session.handoffContext` typed persistence | — |
-| 세션당 handoff 예산 | `session.handoffContext.hopBudget=1` 필드 저장 (#695) | host-side 소비 로직 (#697) |
-| 1-hop 재귀 방지 | 문서 invariant (Rule #3 예산 고갈) | host-side `autoHandoffDepth` nonce (#697) |
+| 세션당 handoff 예산 | **구현 완료 (#697)** — `src/slack/handoff-budget.ts` + `slack-handler.onResetSession` 가드; `ConversationSession.autoHandoffBudget` 필드 (default 1, `resetSessionContext`에서 재초기화); 호스트-빌트 continuation (renew/onboarding)은 `Continuation.origin: 'host'` 마커로 제외 | — |
+| 1-hop 재귀 방지 | **구현 완료 (#697)** — 세션 예산 고갈 시 `HandoffBudgetExhaustedError` throw + slack-handler 외부 catch에서 safe-stop (`#695`의 `HandoffAbortError` 패턴과 동일, 단 session terminate는 하지 않음 — 수동 재입력 대기) | — |
 | Dispatch 실패 복구 | z handoff 경로는 safe-stop 구현 (#695 — `HandoffAbortError`) | default fallback 제거 일반화 (#698) |
```

### File touches

- `src/local/skills/using-z/SKILL.md` — 2 row edits (~4 lines touched)

### Acceptance

- Only 2 rows edited; no other content touched.
- #696 and #695 rows stay as their canonical status.
- Row 5 (#698 dispatch fallback) unchanged — still in-progress per epic.

---

## S6 — `session-initializer-handoff.test.ts` #697 Live-Behavior Pair

### Trigger

#695 left a placeholder describe block `'hopBudget initialization (#695 foundation for #697)'` at `src/slack/pipeline/session-initializer-handoff.test.ts:239-248`. #697 must pair it with a now-live test verifying the new session from a handoff has `autoHandoffBudget=1`.

### Callstack

Extend the existing describe block:

```typescript
describe('hopBudget initialization (#697 host-enforced live)', () => {
  // Existing #695 test: verifies session.handoffContext.hopBudget is seeded to 1
  // by parseHandoff. (No change to that test.)

  it('T6.1 handoff-dispatched new session has autoHandoffBudget=1 (independent fresh budget)', async () => {
    // Exercise runDispatch with a valid plan-to-work sentinel.
    // After dispatch returns, fetch the session and verify session.autoHandoffBudget === 1.
    // Note: runDispatch itself doesn't re-initialize autoHandoffBudget; the session's
    // existing budget (from getOrCreateSession default) carries through. This test
    // verifies the default is 1, independent of whether handoffContext.hopBudget happens
    // to match.
  });
});
```

### File touches

- `src/slack/pipeline/session-initializer-handoff.test.ts` — +1 test (~30 LOC)

### Acceptance

- New test green.
- Existing `#695 foundation for #697` test description adjusted to reflect the now-implemented contract (rename or add "(now consumed by #697)" suffix).

---

## S7 — Epic #694 Progress Log Update (Phase 5.E Meta)

### Trigger

Per z workflow Phase 5.E, after #697 merges, epic #694's Progress Log gets a new entry mirroring the #695 / #696 entries. NOT a code change — this happens via `gh issue edit` during Phase 5.E of the chain directive.

### Expected Progress Log entry

```markdown
- 2026-04-24T<merge-time>Z — #697 merged via PR #<pr-num>. Per-session auto-handoff
  budget (1 per session) host-enforced. `ConversationSession.autoHandoffBudget`
  field is the authoritative store (default 1; re-initialized on
  `resetSessionContext`; manually whitelisted at SerializedSession + save + load
  sites); `HandoffContext.hopBudget` from #695 remains as parser-seed info only.
  Enforcement chokepoint: `slack-handler.onResetSession` throws
  `HandoffBudgetExhaustedError` when budget exhausted; caught at outer try/catch
  alongside HandoffAbortError (#695 pattern). Host-built continuations
  (renew/onboarding) stamp `Continuation.origin: 'host'` at stream-executor
  builders and skip enforcement. Session stays alive on budget exhaustion
  (soft ceiling — manual user re-entry path). ~17 new tests across handoff-budget,
  slack-handler, session-registry-handoff, session-initializer-handoff — all green.
  Codex review v1 (72/100) flagged 3 blockers (rejection-via-return, renew/onboarding
  false-consume, SerializedSession whitelist); v2 addressed all three.
```

### Checklist update

```markdown
- [x] #697 — Per-session auto-handoff budget (1 per session, host-enforced) → PR #<pr-num> (merged 2026-04-24T<time>Z)
```

### File touches

None (issue body edit via gh CLI during Phase 5.E).

### Acceptance

- Epic #694 body shows the new Progress Log entry and checklist tick.
- Auto-chain directive advances to `current: #698`.

---

## Implementation Order

Strict topological order due to cross-scenario deps:

1. **S1** — pure module + error class (no deps; standalone testable)
2. **S2** — field + persistence whitelist + reset re-init (depends on S1 `DEFAULT_AUTO_HANDOFF_BUDGET` export)
3. **S3** — Continuation.origin + stream-executor stamp sites (depends on somalib type update; independent of S1/S2)
4. **S4** — slack-handler integration (depends on S1 imports + S2 field + S3 origin marker)
5. **S5** — using-z SKILL table flip (depends on S4 landing behavior; doc only)
6. **S6** — session-initializer-handoff test extension (depends on S2 field; independent of S3/S4)
7. **S7** — epic Progress Log (Phase 5.E meta; after PR merges)

S1 + S2 + S3 can be done in parallel commits (no cross-deps). S4 consolidates. S5 + S6 are documentation/test-only and land with S4 or separately. All unit/integration tests must be GREEN before PR opens.

## RED → GREEN Discipline

For each scenario S1–S4:
1. Write the failing contract test first (RED).
2. Implement minimal code to pass (GREEN).
3. Refactor while keeping tests green.
4. Run the full test suite to confirm no regression.

S5 is documentation-only (no RED/GREEN).
S6 is test-only (exercises S2-wired behavior).
S7 is meta (no code change).
