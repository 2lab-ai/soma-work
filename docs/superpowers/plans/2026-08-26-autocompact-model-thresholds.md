# Autocompact Model Thresholds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make soma-work honor Claude Code-style token autocompact controls, fix 1M model reachability, update current model aliases, migrate user Opus defaults, and prove automatic compaction on dev.

**Architecture:** A single immutable model-profile resolver returns effective context window, SDK blocking limit, and harness autocompact threshold from a canonical model ID. Session-level `/autocompact` overrides model defaults; the existing percent command becomes a compatibility adapter into the same token slot. soma-work's turn-end checker is the sole automatic compaction authority: the Agent SDK's native autocompact is disabled for every supported profile, while the existing `/compact` interception/replay path is hardened to exact-once behavior across success, failure, timeout, and abort.

**Tech Stack:** TypeScript 5.9, Vitest, Claude Agent SDK 0.2.111, llmux 0.2.20, Slack Bolt.

**Spec:** `/private/tmp/claude-501/-Users-zhugehyuk-2lab-ai-zbrain/45dd6d88-2929-4f50-9985-351d4e5baca1/scratchpad/soma-autocompact-implementation-contract.md`

## Global Constraints

- Worktree: `/Users/zhugehyuk/2lab.ai/soma-work/.worktrees/feat-autocompact-model-thresholds` on `feat/autocompact-model-thresholds` from `origin/main`.
- Every production edit follows RED → observed failure → minimal GREEN.
- Explicit thresholds: `fable[1m]` and `opus[1m]` 750,000; `gpt-5.6-sol[1m]` and `sol[1m]` 600,000; bare `grok-4.6` 450,000. Reject fake `grok-4.6[1m]` with a visible suggestion.
- Add `claude-opus-5`, `claude-opus-5[1m]`, and `grok-4.6`.
- `opus` resolves to `claude-opus-5[1m]`; `fable` resolves to `claude-fable-5[1m]`.
- User Opus-family defaults migrate to `claude-opus-5[1m]`; active sessions remain unchanged.
- `gpt-5.6-sol[1m]` gets a 977,000 SDK blocking limit, not the bare model's 349,000.
- soma-work's harness checker is the sole automatic compaction authority: every supported profile disables SDK native autocompact; no profile injects `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
- A threshold must be ≤ `min(effective context window, effective SDK blocking limit) - compact headroom`; impossible inputs fail visibly.
- Normal threshold compaction must replay the stashed user message exactly once after success, failure, timeout, or abort.
- Profile windows are explicit soma-work product policy, not account-local SDK experiments; bare `claude-sonnet-4-6` remains 200k/177k unless a separate canonical 1M profile is declared.
- Update `README.md` and `README.ko.md` together.
- Do not commit, push, merge, or deploy until direct gate reruns and external review are green.

---

### Task 1: Canonical model profiles and alias normalization

**Files:**
- Create: `src/metrics/model-profile.ts`
- Modify: `src/metrics/model-registry.ts`
- Modify: `src/agent-runtime/claude-code/build-stream-options.ts`
- Test: `src/metrics/__tests__/model-profile.test.ts`
- Test: `src/agent-runtime/__tests__/build-stream-options.catalog.test.ts`
- Test: `src/agent-runtime/__tests__/build-stream-options.test.ts`
- Test: `src/__tests__/gpt-5-6.test.ts`

**Interfaces:**
- Produces: `resolveModelProfile(modelId: string): ModelProfile`, `resolveModelInputCompatibility(input: string): { modelId: string } | { rejectedReason: string; suggestedModel: string } | null`.
- `ModelProfile`: `{ modelId: string; contextWindow: number; sdkBlockingLimit: number; autoCompactTokens?: number; compactHeadroom: number }`.
- `ModelInputCompatibility`: accepted `{ modelId: string }` or rejected `{ rejectedReason: string; suggestedModel: string }`. There is no silent-normalization branch.

- [ ] Write literal-table tests covering:
  - `claude-fable-5[1m]` → 1,000,000 / 977,000 / 750,000.
  - `claude-opus-5[1m]` → 1,000,000 / 977,000 / 750,000.
  - `claude-opus-5` → 200,000, no 750k default.
  - `gpt-5.6-sol[1m]` → 1,000,000 / 977,000 / 600,000.
  - `gpt-5.6-sol` → 372,000 / 349,000 / 340,000.
  - `grok-4.6` → 500,000 / 477,000 / 450,000.
  - compatibility input `grok-4.6[1m]` is rejected with a visible `use grok-4.6` suggestion.
- [ ] Run the new profile tests and existing gpt/build-options tests; capture failures caused by the missing module and current 349k gpt-1M branch.
- [ ] Implement the exact-ID policy overlay and catalog fallback; make `resolveContextWindow` and `resolveAutoCompactTokens` delegate to it.
- [ ] Replace the regex blocking-limit chain in `build-stream-options.ts` with the immutable profile result. Fill `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=<profile.sdkBlockingLimit>` for every resolved profile only when the operator value is unset; inject `DISABLE_AUTO_COMPACT=1`; never inject `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; remove the per-model override-needed classifier.
- [ ] Rerun targeted tests and ensure all pass.

### Task 2: Model additions, aliases, and idempotent Opus migration

**Files:**
- Modify: `src/user-settings-store.ts`
- Modify: `src/__tests__/user-settings-store.test.ts`
- Modify: `src/__tests__/fable-5.test.ts`
- Create: `src/__tests__/opus-5.test.ts`
- Modify: `src/__tests__/gpt-5-6.test.ts`
- Modify: `src/deploy/__tests__/main-env-bootstrap.test.ts` if bootstrap has an independent model coercion path.
- Modify/Test: `src/metrics/model-registry.ts` pricing spec for `claude-opus-5`; llmux `src/pricing.rs:103-105` maps it to the Opus tier, so soma must not fall through to Sonnet/default pricing.
- Modify/Test: `src/slack/z/topics/model-topic.ts` and `src/slack/z/topics/__tests__/model-topic.test.ts` for persistent model-set rejection text.
- Modify/Test: `src/slack/commands/session-command-handler.ts` and `src/slack/commands/__tests__/session-command-handler.test.ts` for session-only rejection text.

**Interfaces:**
- Consumes: `resolveModelInputCompatibility` from Task 1. User settings resolution must preserve rejection detail for both persistent and session-only model-set surfaces; a `string | null` result alone cannot render `rejectedReason`/`suggestedModel`.
- Produces: current aliases and `migrateOpusDefaultModel(model: string): string`.

- [ ] Replace stale exact-set tests with the explicit requested set; add behavior tests for `fable`, `fable[1m]`, `opus`, `opus[1m]`, `sol[1m]`, bare `grok-4.6`, and visible rejection of `grok-4.6[1m]`.
- [ ] Add disk-backed migration tests with users whose defaults are Opus 4.5/4.6/4.7/4.8 bare and `[1m]`, one already on Opus 5, and non-Opus controls. Assert only default model fields change, second store load is byte-semantically unchanged, and no sessions file is touched.
- [ ] Run the model/store tests and capture expected failures against current aliases and migration behavior.
- [ ] Add `claude-opus-5`, `claude-opus-5[1m]`, `gpt-5.6-sol[1m]`, `grok-4.6`; point aliases per the global contract; remove the fable catalog rejection because the live llmux probe proves literal `[1m]` is safe and necessary for the Claude Code 1M denominator. Apply `resolveModelInputCompatibility` before static/catalog resolution and render visible `use grok-4.6` rejection on both model-set surfaces; never refresh, normalize, persist, or send fake `grok-*[1m]`.
- [ ] Implement Opus-family default migration inside settings load before generic coercion; write settings only when values changed.
- [ ] Rerun all model/store/bootstrap tests.

### Task 3: Session token override and `/autocompact` command

**Files:**
- Create: `src/session/autocompact-policy.ts`
- Modify: `src/types.ts`
- Modify: `src/session-registry.ts`
- Modify: `packages/slack/src/command-parser.ts`
- Create: `src/slack/commands/autocompact-handler.ts`
- Modify: `src/slack/commands/command-router.ts`
- Test: `src/session/__tests__/autocompact-policy.test.ts`
- Test: `src/__tests__/session-registry.test.ts`
- Test: `src/slack/commands/__tests__/autocompact-handler.test.ts`
- Test: `packages/slack/src/__tests__/command-parser.test.ts` or the existing command-parser suite.

**Interfaces:**
- Produces: `parseAutoCompactTokens(raw: string): number | null`, `resolveEffectiveAutoCompact(session, userId, store): EffectiveAutoCompact`, and session field `autoCompactTokens?: number | null`.
- `EffectiveAutoCompact`: `{ tokens: number; source: 'session' | 'model' | 'legacy-percent'; contextWindow: number }`.

- [ ] Write parser tests for `800k`, `800K`, `0.8M`, `800000`, bare `800` shorthand, `reset`, and malformed/out-of-range inputs.
- [ ] Write policy tests proving session override > model default > converted legacy percent; model switches recalculate only without an override; reject thresholds above `min(contextWindow, sdkBlockingLimit) - compactHeadroom`.
- [ ] Write handler tests for status, set, reset, no active session, safe-limit failure, and visible `grok-4.6[1m]` rejection with `use grok-4.6`; add non-overlap regressions showing `/compact` and `/compact-threshold` handlers do not consume `/autocompact`.
- [ ] Write session persistence tests showing `autoCompactTokens` survives restart. Assert active session `model` values are loaded verbatim (after availability coercion only) and are not changed by the user-default Opus migration.
- [ ] Run all new tests and capture missing-command/missing-policy failures.
- [ ] Implement parser, policy, handler, router registration, session serialization/load, and help/status text. Set/reset must call `claudeHandler.saveSessions()` immediately, and save eligibility must include a pre-first-turn override with no SDK `sessionId`.
- [ ] Rerun targeted tests.

### Task 4: Threshold checker and legacy percent compatibility

**Files:**
- Modify: `src/session/compact-threshold-checker.ts`
- Modify: `src/session/__tests__/compact-threshold-checker.test.ts`
- Modify: `src/slack/commands/compact-threshold-handler.ts`
- Modify: `src/slack/commands/__tests__/compact-threshold-handler.test.ts`
- Modify: `src/user-settings-store.ts`
- Modify: `src/__tests__/user-settings-store.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveAutoCompact` from Task 3.
- Produces: one token threshold path; `/compact-threshold <pct>` converts percent against the current model and writes `session.autoCompactTokens` with a deprecation notice.

- [ ] Rewrite threshold-checker tests to assert exact token defaults and session override precedence for all requested models.
- [ ] Add compatibility-handler tests showing `compact-threshold 80` on a 1M model writes 800,000 tokens to the active session and reports the conversion; no independent persistent percentage is created.
- [ ] Add migration tests for existing `compactThreshold` fields: convert once when an active model/context is available or leave a clearly documented compatibility read, then remove the stored field after successful conversion.
- [ ] Run tests and capture failures under the current user-global percent implementation.
- [ ] Implement the unified token path and compatibility adapter; add a structured `thresholdSource`, `usedTokens`, `thresholdTokens`, `model`, and `contextWindow` info log on every schedule decision. The checker must use `min(contextWindow, sdkBlockingLimit) - compactHeadroom` for validation and preserve the existing one-shot post-compact suppression.
- [ ] Rerun threshold and handler tests.

### Task 5: Harden harness compaction replay and preserve boundary observability

**Files:**
- Modify: `src/session/compact-threshold-checker.ts`
- Modify: `src/session/__tests__/compact-threshold-checker.test.ts`
- Modify: `packages/slack/src/pipeline/stream-executor.ts`
- Modify: `packages/slack/src/pipeline/input-processor.ts`
- Modify: `src/slack/hooks/compact-hooks.ts`
- Modify: `src/types.ts`
- Modify: related compact-state/input-processor/stream-executor tests.

**Interfaces:**
- Preserves: `checkAndSchedulePendingCompact`, `autoCompactPending`, threshold-triggered `pendingUserText` interception, manual `/compact`, prompt-too-long emergency fallback state, SDK `status=compacting`, `compact_boundary`, metrics/counts, compaction-context rehydration, and Slack start/complete messages.
- Guarantees: one stashed normal-threshold message is replayed exactly once after success, failure, timeout, or stream abort, independently of the emergency fallback state machine.

- [ ] Write/adjust tests proving `status=compacting` and `compact_boundary trigger=auto` still produce one start/complete cycle after the harness schedules `/compact`.
- [ ] Write RED tests proving ordinary threshold-triggered messages are stashed and redispatched exactly once after `/compact` success, failure, timeout, and stream abort; assert zero loss and zero duplicate dispatches.
- [ ] Write/retain tests proving prompt-too-long emergency fallback preserves/retries its original message exactly once and does not consume normal-threshold stash state.
- [ ] Run focused tests; capture the RED failure in the current cleanup/replay path.
- [ ] Apply the minimal state transition/cleanup fix. Keep turn-end scheduling, next-message `/compact` interception, and deferred replay; do not introduce SDK-native autocompact.
- [ ] Rerun compact hooks, input processing, stream executor, threshold checker, and emergency fallback tests.

### Task 6: Documentation sync and complete project gates

**Files:**
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `docs/misc/reference/architecture.md` only if model-profile wiring changes the documented component graph.
- Modify: command/help documentation owned by code or docs.

- [ ] Document `/autocompact [threshold|reset]`, accepted units, session scope, precedence, model defaults, and the deprecated `/compact-threshold` adapter in both README files.
- [ ] Run stale-reference searches for old Opus/Fable alias claims and update contradictions.
- [ ] Run `npm run check`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run targeted tests, then `npx vitest run`.
- [ ] Run `npm run build`.
- [ ] Preserve raw outputs in the session scratchpad for the receipt.

### Task 7: External review, PR, merge, dev deploy, and live proof

**Files:**
- Create receipt HTML in session scratchpad after validation.
- No product file changes unless review or live QA exposes a defect; loop back to the relevant task with a RED test.

- [ ] Run external code review on the branch diff; resolve every confirmed finding with TDD and rerun gates.
- [ ] Commit conventional changes with `Co-Authored-By: Zhuge <noreply@anthropic.com>` only if current repository convention requires the Claude trailer; otherwise use the harness-required `Co-Authored-By: Claude <noreply@anthropic.com>`.
- [ ] Push the feature branch, open the PR, wait for CI green, and merge.
- [ ] Push/merge `main → deploy/dev` per `CLAUDE.md` and watch all dev targets.
- [ ] Post-deploy, verify deployed files and runtime version.
- [ ] Run live model smoke probes for literal fable/opus/sol `[1m]` and bare grok 4.6.
- [ ] Force an autocompact crossing on a disposable dev session using a low safe session override; capture structured schedule log, input interception, raw `/compact`, compact boundary, and original-message exact-once redispatch. Restore/reset the override afterward.
- [ ] Confirm live `user-settings.json` keeps the existing user at `claude-opus-5[1m]` and non-Opus users unchanged; compare a pre-deploy backup.
- [ ] Write one HTML receipt: AS-IS → root causes with `file:line` → fixes → raw gate/live outputs → acceptance matrix → QA commands. Publish or serve it using the repository's existing report path.
