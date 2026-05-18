# Per-Session Auto-Handoff Budget (Host-Enforced)

> Issue #697 · Part of epic #694 · Consumes typed `HandoffContext` delivered by #695 (PR #703)
> Sibling of #696 (PR #706) — same epic, independent enforcement concern.
>
> **Spec revision history**: v1 (72/100 codex) had three blockers — (1) rejection path didn't actually stop the continuation loop (just returned from `onResetSession`; v1-query-adapter still called `continue()` next); (2) `onResetSession` fires for renew/onboarding continuations too, so a blanket budget check would consume budget for host-built flows; (3) `SerializedSession` is manually whitelisted (not auto-JSON-pass-through). v2 addresses all three.

## Why

Epic #694 identified four structural gaps in z-controller session handoff. #695 built the typed-metadata foundation; #696 shipped host-side PR issue-link precondition. #697 closes the **auto-recursion** gap:

> Continuation loop가 깊이 제한이 없어 자동 재귀가 **구조적으로** 가능

Currently, a single `ConversationSession` can emit an unbounded number of `CONTINUE_SESSION` commands across turns (if the model misbehaves or re-enters auto-handoff logic after state glitches). Without host enforcement, a bug in z-skill prompt drift or an adversarial model output can fan out into an infinite chain: S → S' → S'' → … with no ceiling.

The prompt-level contract in `using-z/SKILL.md` §Protocol Rules #3 asks the model to issue exactly one auto-handoff per session. But prompt discipline is not enforcement. **The host must count hops per session and refuse the second one.**

`HandoffContext.hopBudget` (seeded to 1 by `parseHandoff` at `somalib/model-commands/handoff-parser.ts:307-309`) is the #695 foundation for this work — but nothing in production consumes it today (`src/slack/pipeline/session-initializer.ts:614` logs it on entry; no path reads/decrements it downstream). Issue #697 is the consumer.

## What

1. **New session field**: `autoHandoffBudget?: number` on `ConversationSession` (`src/types.ts`). Default undefined → treated as 1 defensively by the guard. Set explicitly to 1 at session creation AND on `resetSessionContext`.
2. **Continuation origin marker**: `Continuation.origin: 'model' | 'host'` added to the somalib Continuation type (`somalib/model-commands/session-types.ts:94-99`). Stream-executor sets `origin: 'model'` when capturing a model-emitted `CONTINUE_SESSION` (`src/slack/pipeline/stream-executor.ts:2710-2719`). Renew-continuation builder (`stream-executor.ts:3460-3464`) and onboarding-continuation builder (`stream-executor.ts:3635-3639`) explicitly set `origin: 'host'`. The budget guard consumes budget whenever `origin !== 'host'` — model-emitted, undefined (legacy), and any malformed value all enforce. Only the canonical `'host'` value skips.
3. **Enforcement chokepoint**: `src/slack-handler.ts:530-553 onResetSession` — check + consume BEFORE `resetSessionContext`, and **throw a new `HandoffBudgetExhaustedError`** when the budget is exhausted. The throw propagates through `V1QueryAdapter.startWithContinuation()` (`src/agent-session/v1-query-adapter.ts:116-143`) and is caught at the existing try/catch at `slack-handler.ts:555-595` (same location as `HandoffAbortError`). `return` alone is insufficient — v1-query-adapter's continuation loop checks `shouldContinue` first and runs `continue(prompt)` unconditionally after `onResetSession` returns.
4. **Pure guard module**: `src/slack/handoff-budget.ts` exports `checkAndConsumeBudget(session) → BudgetCheckResult`, `formatBudgetExhaustedMessage(ctx) → string`, and the `HandoffBudgetExhaustedError` class. Kept separate from slack-handler for unit-testability (same pattern as `src/hooks/pr-issue-guard.ts` from #696).
5. **User-facing rejection**: when caught, the existing try/catch posts the structured message via `this.slackApi.postMessage(...)`. Do NOT call `terminateSession` — just decline the hop, keep the current session alive so the user can intervene manually. Distinct from `HandoffAbortError` (which terminates) — budget exhaustion is a soft ceiling, not a structural failure.
6. **Persistence**: `SerializedSession` is manually whitelisted at three sites. Update all three:
   - Type: `src/session-registry.ts:86-149` — add `autoHandoffBudget?: number` to the interface.
   - Save: `src/session-registry.ts:1600-1670` — map `autoHandoffBudget: session.autoHandoffBudget` inside the save object literal.
   - Load: `src/session-registry.ts:1767-1877` — map `autoHandoffBudget: serialized.autoHandoffBudget` in the deserialized session.
7. **Documentation flip**: `src/local/skills/using-z/SKILL.md:154-161` Enforcement Status table rows 3 (handoff budget) and 4 (1-hop recursion prevention) flip from "host-side consumption logic (#697)" / "host-side autoHandoffDepth nonce (#697)" placeholders to "**구현 완료 (#697)**" with file references.
8. **Tests** (vitest):
   - Pure-function branch matrix on `checkAndConsumeBudget`, message formatting, error class (~9 tests)
   - Integration: `slack-handler.test.ts` — model-emitted first/second hop, renew/onboarding pass-through, postMessage failure resilience (~4 tests)
   - Persistence round-trip: `session-registry-handoff.test.ts` (~3 tests)
   - Session-initializer-handoff extension to live #697 (~1 test)

## Success Signal

Mirrors issue #697 §Done:

| Acceptance case | Expected |
|---|---|
| Session S (model-emitted) with budget=1 emits first `CONTINUE_SESSION` | pass; decrement S.autoHandoffBudget 1→0; dispatch new session S' |
| Same session S with budget=0 emits second `CONTINUE_SESSION` | `HandoffBudgetExhaustedError` thrown; caught in outer try/catch; postMessage with budget/chainId/workflow; session stays alive |
| New session S' created via handoff (plan-to-work or work-complete) | S'.autoHandoffBudget = 1 (independent, not inherited) |
| Manual `$z <url>` user session | starts with autoHandoffBudget = 1 (set at session creation) |
| Direct Slack mention (non-handoff, non-`$z`) session | starts with autoHandoffBudget = 1 (spec: "직접 유저 세션 포함") |
| Renew continuation (`/renew`) — host-built with `origin: 'host'` | budget NOT consumed; reset + dispatch runs as today |
| Onboarding completion continuation — host-built with `origin: 'host'` | budget NOT consumed; reset + dispatch runs as today |
| Persistence: session with autoHandoffBudget=0 serialized then loaded | field preserved (not stripped by whitelist) |
| Pre-#697 disk state (no autoHandoffBudget in JSON) loaded | field = undefined → `checkAndConsumeBudget` treats as 1 |

## Architecture Decisions

### AD-1: New field on `ConversationSession`, NOT inside `HandoffContext`

**Why**: spec §Scope says "세션 생성 시 `hopBudget = 1` 초기화 (직접 유저 세션 포함)" — EVERY session must have a budget. But `session.handoffContext` is present ONLY on sessions entered via z-handoff dispatch (`SessionInitializer.runDispatch` z-* branch). Two structural problems if we used `handoffContext.hopBudget` as the authoritative store:

1. **Direct sessions have no handoffContext**. Forcing one contaminates the discriminator used by pr-issue-guard (#696) — that guard activates iff `session.handoffContext` is set, and its "legitimate z-handoff session" semantics would be weakened.
2. **handoffContext is cleared on `resetSessionContext`** (`session-registry.ts:1251`). The budget check must happen BEFORE reset — the data source must outlive the reset boundary, which `handoffContext` cannot.

**Decision**: `autoHandoffBudget?: number` directly on `ConversationSession`. `HandoffContext.hopBudget` (#695) becomes documented parser-seed info only — it appears in the handoff-entry log at `session-initializer.ts:614` for observability, but production enforcement is the new field. Codex's concern about drift between two near-duplicate fields is addressed by (a) this spec explicitly labeling `hopBudget` as "parser-seed / diagnostic", (b) no production read of `hopBudget` (verified empty in #695 investigation), (c) a doc comment on the type pointing to `autoHandoffBudget`.

**Alternatives rejected**: reuse `handoffContext.hopBudget` + synthesize minimal handoffContext on direct sessions → pollutes pr-issue-guard predicate. Widen pr-issue-guard to also check `handoffKind` → narrows HandoffContext semantic contract. Drop `HandoffContext.hopBudget` entirely → breaks #695 tests for no gain.

### AD-2: Throw `HandoffBudgetExhaustedError` from `onResetSession` (NOT return early)

**Codex P0 fix**: `V1QueryAdapter.startWithContinuation()` at `src/agent-session/v1-query-adapter.ts:116-140` runs:

```typescript
while (true) {
  const decision = handler.shouldContinue(lastResult);
  if (!decision.continue || !decision.prompt) break;

  const continuation = lastResult.continuation as any;
  if (continuation?.resetSession && handler.onResetSession) {
    await handler.onResetSession(continuation);   // ← v1 spec's `return` here does nothing
    // refreshSession + baseParams update
  }
  lastResult = await this.continue(decision.prompt);   // ← still runs
}
```

A bare `return` from `onResetSession` leaves `shouldContinue` unmodified (it already returned `continue: true` with prompt) and the `continue()` call proceeds against the same (non-reset) session — defeating the budget enforcement.

**The only off-ramps are**:
1. `shouldContinue` returns `continue: false` — but it runs BEFORE `onResetSession` (line 117 vs 123), so it can't see the budget decision made in `onResetSession`.
2. `throw` from `onResetSession` — propagates up through `startWithContinuation`, caught by the outer `try/catch` at `slack-handler.ts:555-595`.

**Decision**: new error class `HandoffBudgetExhaustedError extends Error`. Thrown inside `onResetSession` when `checkAndConsumeBudget` returns `allowed: false`. Catch block next to the existing `HandoffAbortError` catch at `slack-handler.ts:564-594` — posts structured message, logs warn, but does NOT call `terminateSession` (session stays alive for manual re-entry per spec).

```typescript
export class HandoffBudgetExhaustedError extends Error {
  constructor(
    public readonly budgetBefore: number,
    public readonly attemptedWorkflow: WorkflowType | undefined,
    public readonly chainId: string | undefined,
  ) {
    super(`Auto-handoff budget exhausted (budget=${budgetBefore})`);
    this.name = 'HandoffBudgetExhaustedError';
  }
}
```

**Alternatives rejected**:
- Check budget inside `shouldContinue` — `shouldContinue` is synchronous and doesn't have access to side-effects like session mutation + postMessage. Check-AND-consume semantics couple poorly to a bare predicate.
- Modify `ContinuationHandler` contract to allow `onResetSession` to return `{ abort: true }` — contract change affecting many consumers (renew/onboarding); throw is localized and idiomatic.
- Use `shouldContinue` to do the check AND `onResetSession` to do the consume — split state between two callbacks invites race/ordering bugs. One throw, one location.

### AD-3: `Continuation.origin: 'model' | 'host'` to distinguish enforcement scope

**Codex P1 fix**: `onResetSession` fires for three distinct continuation sources, all of which set `resetSession: true`:

| Source | Location | Purpose | Consumes budget? |
|---|---|---|---|
| Model-emitted CONTINUE_SESSION | `stream-executor.ts:2710-2719` | z-handoff auto-chain; model-driven re-dispatch | **YES** |
| Host-built renew continuation | `stream-executor.ts:3460-3464` | `/renew` command to reload saved context | NO |
| Host-built onboarding continuation | `stream-executor.ts:3635-3639` | End-of-onboarding user-task transition | NO |

A blanket budget check on `onResetSession` would consume budget for `/renew` and onboarding, breaking both flows. The forceWorkflow field is unreliable: model-emitted CONTINUE_SESSION may or may not set forceWorkflow; renew/onboarding never do.

**Decision**: explicit `origin` field on `Continuation`:

```typescript
// somalib/model-commands/session-types.ts
export interface Continuation {
  prompt: string;
  resetSession?: boolean;
  dispatchText?: string;
  forceWorkflow?: WorkflowType;
  /**
   * Whether the continuation was emitted by the model (via CONTINUE_SESSION
   * model-command) or built programmatically by the host (renew/onboarding).
   * Issue #697: auto-handoff budget is consumed only for `'model'` origin.
   * Default/absent → 'model' for backward compat (pre-#697 continuations
   * from the model-command channel didn't carry this field).
   */
  origin?: 'model' | 'host';
}
```

Stream-executor.ts:2711 captures CONTINUE_SESSION with `continuation = { ...parsed.payload.continuation, origin: 'model' }`. The two host builders explicitly set `origin: 'host'`. The budget guard gates on `origin !== 'host'` — see AD-13 for the full predicate matrix (model, undefined, malformed-value all enforce; only `'host'` skips).

**Backward compat AND adversarial-value safety**: the guard predicate is `origin !== 'host'` (NOT `origin === 'model' || origin === undefined`). This means:
- `origin === 'host'` → skip enforcement (renew/onboarding)
- `origin === 'model'` → enforce (canonical model-emitted)
- `origin === undefined` → enforce (legacy emitters pre-#697)
- `origin === 'MODEL'`, `'foo'`, or any other string → enforce (conservative — malformed values don't silently bypass)

A stray `warn` log fires when `origin` is neither `'model'` nor `'host'` nor undefined so operator visibility is preserved.

**Producer-authoritative `origin`** (P2 clarification): `origin` is host-stamped at stream-executor capture/build sites ONLY. It is NOT a field the model can supply via `CONTINUE_SESSION` MCP payload — the somalib validator/normalizer (`somalib/model-commands/validator.ts`, `somalib/model-commands/catalog.ts`) ignores/strips unknown fields from the payload shape, and stream-executor's spread `{ ...parsed.payload.continuation, origin: 'model' }` deliberately overwrites any value the model attempted to set. Documented in the type jsdoc and stamp-site comments.

**Alternatives rejected**:
- Infer origin from forceWorkflow presence → unreliable; model CONTINUE_SESSION can omit forceWorkflow.
- Infer from prompt content (renew prompt starts with `"Use 'local:load'"`) → brittle pattern matching; couples budget logic to prompt strings.
- Separate `onResetSessionFromModel` vs `onResetSessionFromHost` callbacks → big contract change for marginal gain.

### AD-4: Check-AND-consume is atomic; session-undefined fails CLOSED

**Codex P2 fix**: v1 trace fail-opened on undefined session (`checkAndConsumeBudget(undefined) → allowed: true, budgetBefore: 1`). Codex correctly flags: at this seam, missing session is a broken invariant, not a "fresh budget" case.

**Decision**:

```typescript
export function checkAndConsumeBudget(
  session: ConversationSession | undefined,
): BudgetCheckResult {
  if (session === undefined) {
    // Fail CLOSED: at the onResetSession seam, a missing session is an invariant
    // break (the collector collected a continuation for this channel/thread, so
    // a session must have existed). Reject the hop and surface the condition.
    return {
      allowed: false,
      budgetBefore: 0,
      budgetAfter: 0,
      reason: 'no-session',
    };
  }
  const before = session.autoHandoffBudget ?? DEFAULT_AUTO_HANDOFF_BUDGET;
  if (before <= 0) {
    return { allowed: false, budgetBefore: before, budgetAfter: before, reason: 'exhausted' };
  }
  session.autoHandoffBudget = before - 1;
  return { allowed: true, budgetBefore: before, budgetAfter: before - 1 };
}
```

Rejection `reason` field: `'exhausted' | 'no-session'`. Error class and message distinguish the two for diagnostics.

The mutation happens on the session object directly. Node's single-threaded event loop + the fact that `checkAndConsumeBudget` is synchronous with no awaits means no concurrent mutation can sneak between read and write (verified by codex P2 answer #3). Persistence to disk piggy-backs on the next `SessionRegistry.saveSessions` tick — either `resetSessionContext` (happy path) or explicitly by a test.

**Why `?? 1` for autoHandoffBudget undefined**: pre-#697 disk state lacks the field. Deserialized session's `autoHandoffBudget === undefined` is indistinguishable from a freshly created session with no prior hops. Treating as 1 means the first post-upgrade hop correctly decrements to 0.

### AD-5: Reset semantics — `resetSessionContext` re-assigns `autoHandoffBudget = 1`

**Why**: after a successful hop, the OLD session is reset (`state = 'INITIALIZING'`, `handoffContext = undefined`, etc.) — but the same `sessionKey` is reused. The reset creates a new logical session reusing the physical Map entry. That new logical session needs a fresh budget.

**Insertion point**: `src/session-registry.ts:1251` (right next to the existing `session.handoffContext = undefined` line):

```typescript
session.handoffContext = undefined;

// Reset auto-handoff budget to fresh 1 (issue #697, epic #694).
// After resetSessionContext, the same sessionKey becomes a new logical session;
// it gets independent budget per spec §Scope "체인 계승이 아닌 독립 예산".
session.autoHandoffBudget = DEFAULT_AUTO_HANDOFF_BUDGET;
```

**Verified safe against** (per codex P2 answer #4):
- `/renew` flow: reset is triggered by host-built continuation with `origin: 'host'`; budget guard skips enforcement; `resetSessionContext` still runs and re-assigns 1. ✓
- `/new`: same as renew — host-driven reset. ✓
- Onboarding → user task transition: `origin: 'host'`; reset runs; budget re-assigned to 1. ✓
- Ghost-session-fix flags: `terminated` is preserved on reset (not our concern); budget reset doesn't interact. ✓
- Compaction boundary: `compactionOccurred` is a separate flag; budget unaffected. ✓

### AD-6: Session creation path — initialize `autoHandoffBudget = 1`

**Investigation**: ConversationSession objects are created in two paths:
- **Fresh session**: via `SessionRegistry.getOrCreateSession` (or equivalent) when a new (channel, threadTs) pair arrives. The helper builds the initial object literal with default fields.
- **Deserialized session**: via `SessionRegistry.loadSessions` at `src/session-registry.ts:1767-1877`. Builds from `SerializedSession`.

**Decision**: add `autoHandoffBudget: DEFAULT_AUTO_HANDOFF_BUDGET` (i.e., 1) to the initial object literal in `getOrCreateSession` AND `autoHandoffBudget: serialized.autoHandoffBudget` in the load path (preserves exact disk value; defensive `?? 1` is in the guard, not here).

### AD-7: Rejection message includes budget + chainId + attempted workflow

Per spec §Scope: "거부 시 유저에게 현재 depth / budget / 어떤 체인이 시도됐는지 로그 전달".

**Message format** (Slack, same `postMessage` surface as HandoffAbortError — see `slack-handler.ts:572-587`):

```
🚫 자동 세션 핸드오프 예산 초과 (host-enforced, #697)

이 세션은 이미 1회의 자동 핸드오프를 사용했습니다.
두 번째 `CONTINUE_SESSION` 발행이 거부되었습니다 — 무한 루프 방지.

Budget: 0 / 1 (exhausted)
Attempted workflow: `<forceWorkflow or 'default'>`
Chain: `<handoffContext.chainId or 'N/A — direct session'>`

원인: z-controller 세션은 세션당 1회의 auto-handoff만 허용됩니다.
정상적으로 다음 단계로 넘어가려면 유저가 수동으로 새 세션을 시작해야 합니다.

수동 재시도: `$z <issue-url>` (새 세션, 독립 예산 1회)
```

For the `no-session` reason (AD-4), a different message points to the invariant break rather than the legitimate-exhaustion case:

```
🚫 자동 세션 핸드오프 거부 (host-enforced, #697) — session 상태 불일치

CONTINUE_SESSION이 캡처됐지만 해당 채널/스레드의 세션을 찾을 수 없습니다
(invariant break). dispatch 루프를 안전하게 중단합니다.

Attempted workflow: `<forceWorkflow or 'default'>`

원인: 이 경로는 정상적으로 발생하지 않아야 합니다 — host 로그를 확인하세요.

수동 재시도: `$z <issue-url>` (fresh 세션 시작)
```

**Logging**: `logger.warn('Auto-handoff budget exhausted', { channelId, threadTs, reason, budgetBefore, forceWorkflow, chainId })` for operator visibility. Mirrors the HandoffAbortError log at `slack-handler.ts:565-571`.

### AD-8: Persistence — manual whitelist, not auto-JSON

**Codex P1 fix**: v1 spec claimed "auto-handled by existing JSON serialize/deserialize paths". That was wrong — `SerializedSession` is a manually-enumerated interface with explicit field whitelisting at save/load.

**Three touch points** (all in `src/session-registry.ts`):

1. **Type (`SerializedSession` interface, line ~86-149)**:
   ```typescript
   interface SerializedSession {
     // ... existing fields ...
     handoffContext?: HandoffContext;
     /** Host-enforced auto-handoff budget (issue #697). */
     autoHandoffBudget?: number;
   }
   ```

2. **Save path (line ~1607-1669, inside `saveSessions()`)**: append to the object literal
   ```typescript
   sessionsArray.push({
     // ... existing fields ...
     handoffContext: session.handoffContext,
     autoHandoffBudget: session.autoHandoffBudget,
   });
   ```

3. **Load path (line ~1767-1877, inside `loadSessions()`)**: append to the deserialized object
   ```typescript
   const session: ConversationSession = {
     // ... existing fields ...
     handoffContext: serialized.handoffContext,
     autoHandoffBudget: serialized.autoHandoffBudget,
     // ... rest of runtime-only fields ...
   };
   ```

**AD-12 filter interaction** (`session-registry.ts:1615`): current filter is `session.sessionId || session.handoffContext`. `autoHandoffBudget=0` alone doesn't trigger persistence — the session still needs `sessionId` or `handoffContext` to be saved. This is correct: a session with only a decremented budget and no conversation history doesn't need disk persistence.

### AD-9: Documentation flip — using-z SKILL.md Enforcement Status table

`src/local/skills/using-z/SKILL.md:154-161` table has two rows with #697 placeholders that go stale on merge:

```diff
 | 항목 | 현재 강제 수단 | 목표 강제 수단 |
 |---|---|---|
 | Handoff #1 전 Issue URL 검증 | **구현 완료 (#696)** — ... | — |
 | 결정적 새 세션 진입 | **구현 완료 (#695)** — ... | — |
-| 세션당 handoff 예산 | `session.handoffContext.hopBudget=1` 필드 저장 (#695) | host-side 소비 로직 (#697) |
-| 1-hop 재귀 방지 | 문서 invariant (Rule #3 예산 고갈) | host-side `autoHandoffDepth` nonce (#697) |
+| 세션당 handoff 예산 | **구현 완료 (#697)** — `src/slack/handoff-budget.ts` + `slack-handler.onResetSession` 가드; `ConversationSession.autoHandoffBudget` 필드 (default 1, resetSessionContext에서 재초기화) | — |
+| 1-hop 재귀 방지 | **구현 완료 (#697)** — 세션 예산 고갈 시 `HandoffBudgetExhaustedError` throw + safe-stop (`#695`의 `HandoffAbortError` 패턴과 동일) | — |
 | Dispatch 실패 복구 | z handoff 경로는 safe-stop 구현 (#695 — `HandoffAbortError`) | default fallback 제거 일반화 (#698) |
```

This flip is required for the SKILL's "single source of truth" invariant per §Enforcement Status line 162. Epic #694 Progress Log is a separate, additive update.

### AD-10: chainId cross-hop propagation is OUT OF SCOPE

Each `parseHandoff` mints a fresh `chainId` (somalib/model-commands/handoff-parser.ts:308). The rejection message includes the current session's `chainId` for tracing WHICH session emitted WHICH rejection — that's observability, not enforcement. Cross-hop chain correlation (propagating chainId from old session → new session so multiple rejections in a chain share an ID) requires:
- `Continuation` shape extension: `parentChainId?: string`
- `parseHandoff` accepts optional `priorChainId` and uses it instead of minting
- `slack-handler.onResetSession` threads the old session's chainId into the next continuation

Deferred to a follow-up traceability ticket if/when needed. Codex confirmed: "Deferring cross-hop propagation is fine. It is observability, not enforcement."

### AD-11: Test layering

| Layer | File | Purpose | New tests |
|---|---|---|---|
| L1 unit | `src/slack/handoff-budget.test.ts` (new) | `checkAndConsumeBudget` branch matrix + `formatBudgetExhaustedMessage` + error class | ~9 |
| L2 integration | `src/slack-handler.test.ts` (extend) | Model-emitted first/second hop + renew/onboarding skip + postMessage failure resilience | ~4 |
| L2 persistence | `src/session-registry-handoff.test.ts` (extend) | Whitelist round-trip (save/load) + pre-#697 backfill + resetSessionContext re-init | ~3 |
| L2 integration | `src/slack/pipeline/session-initializer-handoff.test.ts` (extend) | New handoff-dispatched session has autoHandoffBudget=1 (live #697 pair for #695's placeholder block) | ~1 |

**Total**: ~17 new tests. Denser than v1 (~14) due to codex-driven coverage: renew/onboarding skip, postMessage failure, no-session fail-closed, whitelist persistence, origin marker verification.

### AD-12: Adapter-level coverage via a proper continuation-loop-stop test

Codex v2 review correctly flagged that the existing `HandoffAbortError` test at `slack-handler.test.ts:1281` does NOT traverse `onResetSession` — it makes `streamExecutor.execute` throw immediately, bypassing the continuation loop. It cannot serve as proof that `throw`-from-`onResetSession` stops the loop.

**Required test construction for T4.2** (the P0 fix's regression test):
1. First `execute()` turn returns a result with `continuation = { resetSession: true, prompt: 'next', origin: 'model' }`.
2. `shouldContinue` returns `{ continue: true, prompt: 'next' }`.
3. `onResetSession` is invoked with the continuation; at this moment the session's `autoHandoffBudget === 0`.
4. `checkAndConsumeBudget` returns `{ allowed: false, reason: 'exhausted' }`; `onResetSession` throws `HandoffBudgetExhaustedError`.
5. Throw propagates through `V1QueryAdapter.startWithContinuation` (caught in the outer try/catch).
6. Assertion: `streamExecutor.execute` was called **exactly once** (NOT twice — second call would prove the loop ran another turn). `postMessage` was called once with exhausted-reason text. `resetSessionContext` was NOT called. `terminateSession` was NOT called.

This makes T4.2 the empirical proof of the P0 fix. No separate `v1-query-adapter-continuation.test.ts` addition needed — the adapter's loop-exit-on-throw behavior is already covered by its own existing test suite; what we need is the END-TO-END assertion that our new error class correctly rides that mechanism. slack-handler.test.ts is the right layer.

### AD-13: Origin marker — backward compat and rollout

**Concern**: changing the `Continuation` type is a somalib change that consumers outside this repo may depend on (per the `Parent Repository: somalib/` convention). Making `origin` required would break existing emitters.

**Decision**: `origin?: 'model' | 'host'` — optional with documented default of `'model'`. All internal call sites set it explicitly (model capture → `'model'`, host builders → `'host'`). External consumers unaware of the new field → undefined → treated as `'model'` → budget is consumed. Worst-case false-consume on external CONTINUE_SESSION emitter is benign (that emitter's session still has budget=1 from creation).

## Out of Scope

- **`chainId` cross-hop propagation** — observability feature, not enforcement (AD-10).
- **Global chain-depth limit** — #697 bounds per-session hops (1 max). Cross-session chains can still grow; each hop consumes its session's budget legitimately. Chain-depth ceiling is a separate policy.
- **Dispatch failure safe-stop generalization** — #698 covers the fallback when `runDispatch` throws mid-hop.
- **Retroactive budget for in-flight sessions** — existing sessions at deploy time get `undefined` budget, treated as 1 on next read (fair).
- **Model-side feedback** — rejection is user-facing Slack only. The model that emitted CONTINUE_SESSION has already terminated its turn; no tool-result surface to echo the rejection back to.
- **Cross-process budget state** — single-process in-memory + disk persistence. Multi-instance sharing (Redis counter etc.) not applicable.
- **Per-workflow budget overrides** — all session types share the single `1` ceiling. No override semantics.
- **Adapter-level tests** — integration tests at slack-handler layer are sufficient (AD-12).

## File Manifest

**New (2)**:
- `src/slack/handoff-budget.ts` — pure helper module + `HandoffBudgetExhaustedError` class (~110 lines)
- `src/slack/handoff-budget.test.ts` — unit tests (~160 lines)

**Modified (9)**:
- `src/types.ts` — add `autoHandoffBudget?: number` to `ConversationSession` (+1 field + jsdoc)
- `somalib/model-commands/session-types.ts` — add `origin?: 'model' | 'host'` to `Continuation` (+jsdoc)
- `src/slack-handler.ts` — inject budget check + throw in `onResetSession`; catch `HandoffBudgetExhaustedError` in outer catch block; import statements (~50 lines)
- `src/slack/pipeline/stream-executor.ts` — stamp `origin: 'model'` at line ~2711; stamp `origin: 'host'` at renew (~3460) and onboarding (~3635) builders (~6 lines total)
- `src/slack/pipeline/stream-executor.test.ts` — update continuation-shape assertions that currently use exact equality (line ~1474 — now needs to expect `origin: 'model'`) (~5-10 lines)
- `src/session-registry.ts` — `SerializedSession` type + save path + load path + `resetSessionContext` re-init + `getOrCreateSession` initial (~10 lines across 5 locations)
- `src/local/skills/using-z/SKILL.md` — Enforcement Status table rows 3 + 4 flip (~4 lines)
- `src/slack-handler.test.ts` — +4 integration tests including the AD-12 T4.2 continuation-loop-stop proof (~140 lines)
- `src/slack/pipeline/session-initializer-handoff.test.ts` — +1 test (~30 lines)
- `src/session-registry-handoff.test.ts` — +3 persistence tests (~70 lines)

Total: 2 new files, 10 modified files. ~580 lines net including tests. Fits "medium" tier per `using-epic-tasks`.

## Spec Changelog

- **v1** (2026-04-24): initial — 72/100 codex. Three blockers identified:
  - P0: rejection via `return` doesn't stop v1-query-adapter continuation loop (must throw)
  - P1: `onResetSession` fires for renew/onboarding too — need origin discriminator
  - P1: `SerializedSession` is manually whitelisted, not auto-JSON
- **v2** (2026-04-24): full revision addressing all three blockers.
  - AD-2: throw `HandoffBudgetExhaustedError` from `onResetSession`; catch at slack-handler outer try/catch (same layer as HandoffAbortError)
  - AD-3: `Continuation.origin: 'model' | 'host'` marker; stamp at stream-executor capture + host builders; budget consumed only for `'model'`
  - AD-4: fail CLOSED on undefined session (invariant break, not fresh-budget case)
  - AD-8: explicit three-site manual whitelist update (interface + save + load)
  - AD-9: using-z SKILL Enforcement Status table flip (documentation SSOT)
  - Test matrix: +3 renew/onboarding/persistence cases → 17 total (up from 14)
- **v3** (2026-04-24): codex re-review (91/100) addressed three P1s.
  - AD-3 / AD-13: predicate hardened to `origin !== 'host'` (not `origin === 'model' || undefined`) so malformed values like `'MODEL'` / `'foo'` fail CLOSED into enforcement. Warn log on unexpected values.
  - File manifest: added `src/slack/pipeline/stream-executor.test.ts` — existing exact-equality continuation-shape assertion at ~line 1474 breaks when `origin: 'model'` is stamped; must be updated.
  - AD-12: rewrote from "existing HandoffAbortError test covers it" (incorrect — that test bypasses the continuation loop) to explicit T4.2 test construction proving `streamExecutor.execute` is called EXACTLY ONCE after the throw. Added T4.5 for adversarial `'MODEL'` origin.
  - AD-3/AD-13: clarified that `origin` is host-stamped only; model-supplied values in CONTINUE_SESSION payload are stripped by validator/catalog + overwritten by stream-executor spread.
  - Test total: 18 (up from 17 — added T4.5).
- **v4 doc-cleanup** (2026-04-24): codex v3 re-review (96/100, approved). P2 doc-drift fixes only, no design changes:
  - Spec §What item 2 + AD-3 summary paragraph: updated stale "origin === 'model'" wording to match the AD-13 authoritative rule.
  - Trace header/banner bumped v2→v4; revision count in intro updated.
  - Trace S4 acceptance test count 4→5; intro describe-text updated to "origin !== 'host'".
  - Spec changelog: added v3 + this v4 entry.

## Next Step

→ trace.md revised to map AD-1 through AD-13 to the new scenario set (S1 pure module + S2 field/serialization + S3 origin marker + S4 slack-handler wire + S5 prompt flip). RED contract tests sketched per scenario.
