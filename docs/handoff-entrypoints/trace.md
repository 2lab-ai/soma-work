# Trace — Handoff Entrypoints + Typed Metadata Persistence

Feature: Issue #695 · Foundation subissue of epic #694

> NOTE: This trace was revised after codex 1차 review (38/100) flagged wrong runtime path,
> missing prompt plumbing, invented sentinel fields, and quadruple allowlist. All gaps addressed.

## Scenarios (= Task List)

| # | Scenario | Tier | Files touched | Tests | Order |
|---|---|---|---|---|---|
| S1 | Quadruple allowlist + new WorkflowType values | small | session-types.ts, validator.ts, dispatch-service.ts, action-panel-builder.ts | extend validator.test.ts + dispatch-service.test.ts + action-panel-builder.test.ts | 1 |
| S2 | HandoffContext types + parser + HandoffAbortError | medium | somalib/model-commands/session-types.ts, handoff-parser.ts (new) | handoff-parser.test.ts (new) | 2 |
| S3 | Session SSOT schema + serde + archive + saveSessions filter relaxation | small | src/types.ts, src/session-registry.ts | extend session-registry.test.ts | 3 |
| S4 | Two workflow prompt files | small | src/prompt/workflows/z-plan-to-work.prompt, z-epic-update.prompt | extend prompt-builder.test.ts | 4 |
| S5 | `runDispatch` prompt plumbing + enforcement | medium | src/slack/pipeline/session-initializer.ts | new session-initializer-handoff.test.ts | 5 |
| S6 | Validator CONTINUE_SESSION precondition | small | somalib/model-commands/validator.ts | extend validator.test.ts | 6 |
| S7 | slack-handler onResetSession plumbing + HandoffAbortError catch | medium | src/slack-handler.ts | extend slack-handler.test.ts | 7 |
| S8 | SKILL.md producer-side payload update | small | src/local/skills/using-z/SKILL.md | doc-only | 8 |
| S9 | E2E integration smoke test | small | — | new handoff-e2e.test.ts | 9 |

Net: ~9-10 src files, ~6 test files, ~400-500 lines.

---

## S1 — Quadruple Allowlist

### Trigger
Adding new `WorkflowType` requires synchronized edits across **four** locations. TypeScript `Record<WorkflowType, ...>` in ActionPanelBuilder forces exhaustiveness — missing entry = compile error.

### Callstack (verification targets)

1. `somalib/model-commands/session-types.ts:4-14` — type union
   - Before: 10 literals. After: add `| 'z-plan-to-work' | 'z-epic-update'` → 12.
2. `somalib/model-commands/validator.ts:24-35` — `WORKFLOW_TYPES: WorkflowType[]`
   - Add `'z-plan-to-work', 'z-epic-update'`.
3. `src/dispatch-service.ts:466-477` — `VALID_WORKFLOWS: ReadonlySet<string>`
   - Add both to the Set.
4. `src/slack/action-panel-builder.ts:68-79` — `WORKFLOW_ACTIONS: Record<WorkflowType, PanelActionKey[]>`
   - Add `'z-plan-to-work': []` and `'z-epic-update': []` (no panel actions — handoff sessions don't expose buttons).

### Contract tests

- `validator.test.ts`: new `it('accepts forceWorkflow z-plan-to-work with valid sentinel')` — passes after S1 + S6 merge.
- `validator.test.ts`: new `it('rejects forceWorkflow z-plan-to-work without sentinel')`.
- `dispatch-service.test.ts`: extend existing workflow validation test or add — `validateWorkflow('z-plan-to-work')` returns literal (not coerced to `'default'`).
- `action-panel-builder.test.ts`: new `it('returns empty actions for z-plan-to-work workflow')`.

### Done
- `tsc --noEmit` passes (Record exhaustiveness confirmed).
- Tests green.

---

## S2 — HandoffContext Type + Parser + HandoffAbortError

### Callstack

1. `somalib/model-commands/session-types.ts` — append types (after WorkflowType block):
   - `HandoffKind`, `HandoffTier`, `HandoffContext`, `HandoffParseFailure`, `ParseResult`.
2. `somalib/model-commands/handoff-parser.ts` (new file) — exports:
   - `parseHandoff(promptText: string): ParseResult`
   - `hasHandoffSentinel(promptText: string): boolean`
   - `extractSentinelType(promptText: string): HandoffKind | null` — lightweight regex-based type attribute extraction (validator uses this)
   - `expectedHandoffKind(forceWorkflow: 'z-plan-to-work' | 'z-epic-update'): HandoffKind` — pure mapping function
   - `class HandoffAbortError extends Error` — carries reason (HandoffParseFailure | 'host-policy' | 'type-workflow-mismatch')

### Algorithm (parser)

```
parseHandoff(text):
  1. Quick sentinel existence check: if /<z-handoff/ not found anywhere → { ok: false, reason: 'no-sentinel' }
  2. Find first non-empty line (skip blank lines at top).
  3. If first non-empty line is "$z ..." command line (matches /^\$z\b/), advance to next non-empty line.
  4. That line MUST match /^<z-handoff\s+type="([^"]+)">\s*$/ — captures any type string.
     - Not matched (sentinel exists but not at top) → { ok: false, reason: 'sentinel-not-top-level' }
     - Malformed opening (e.g., missing quotes) → { ok: false, reason: 'malformed-opening' }
  5. Validate captured type ∈ {'plan-to-work', 'work-complete'}.
     - Unknown → { ok: false, reason: 'unknown-type', detail: captured value }
  6. Scan forward for /^<\/z-handoff>\s*$/.
     - Not found → { ok: false, reason: 'missing-closing' }
  7. Scan past the close for another /^<z-handoff/ — if found → { ok: false, reason: 'duplicate-sentinel' }.
  8. Parse inner body line-by-line: group "## Heading\n<value...>" into { heading: value }.
     - Multi-line values accepted (value continues until next "## " or end of block).
     - Heading names case-sensitive.
  9. Validate required fields per type:
     - plan-to-work: Issue, Parent Epic, Task List (Original Request Excerpt, Repository Policy, Confirmed Plan, Codex Review, Tier, Escape Eligible, Issue Required By User are optional/informational)
     - work-complete: Completed Subissue, PR, Summary, Remaining Epic Checklist
     - Missing required → { ok: false, reason: 'missing-required-field', detail: '<field name>' }
 10. Derive HandoffContext per AD-3 table:
     - handoffKind = captured type
     - sourceIssueUrl: plan-to-work → Issue value trimmed; if matches /^none\b/i → null; else first URL-like token.
       work-complete → Completed Subissue value, first URL-like token.
     - parentEpicUrl: plan-to-work Parent Epic value; if "none" → null; else URL. work-complete → null.
     - tier: if "## Tier" present and value ∈ HandoffTier set → value; else null.
     - escapeEligible: if "## Escape Eligible" present and value.toLowerCase() === 'true' → true; else false.
     - issueRequiredByUser: if "## Issue Required By User" present and value.toLowerCase() === 'false' → false; else true.
     - chainId: crypto.randomUUID()
     - hopBudget: 1
 11. Return { ok: true, context }

hasHandoffSentinel(text): lightweight check — returns true iff first non-empty content line (optionally after "$z ..." command line) starts with "<z-handoff type=". Used by validator as existence gate before full parse.
```

### Contract tests (`somalib/model-commands/handoff-parser.test.ts` — NEW)

Happy paths (5):
1. `plan-to-work` minimal (Issue URL + Parent Epic URL + Task List, no optional typed fields) → ok, handoffKind=plan-to-work, escapeEligible=false (default), tier=null (default), issueRequiredByUser=true (default)
2. `plan-to-work` Case A escape with all 3 typed fields explicitly set (`## Tier\ntiny`, `## Escape Eligible\ntrue`, `## Issue Required By User\nfalse`, `## Issue\nnone`, `## Parent Epic\nnone`) → ok, escapeEligible=true (from field), tier='tiny' (from field), issueRequiredByUser=false (from field), sourceIssueUrl=null, parentEpicUrl=null
3. `plan-to-work` Case B with typed fields (`## Tier\nmedium`, `## Escape Eligible\nfalse`, `## Issue Required By User\ntrue`, `## Issue\n<url>`) → ok, tier='medium', sourceIssueUrl=<url>
4. `work-complete` with all required → ok, handoffKind=work-complete, sourceIssueUrl=<subissue url>, parentEpicUrl=null
5. Prompt that starts with `$z phase2 <url>` line then sentinel → ok (top-level with $z prefix accepted)

Malformed (8):
1. No `<z-handoff` anywhere → `no-sentinel`
2. Opening present, no closing → `missing-closing`
3. Duplicate plan-to-work sentinels → `duplicate-sentinel`
4. Duplicate different types (plan-to-work + work-complete) → `duplicate-sentinel`
5. `<z-handoff type="foo">` at top → `unknown-type`, detail `foo`
6. plan-to-work missing `## Issue` → `missing-required-field`, detail `Issue`
7. Sentinel preceded by other content line (not `$z ...` prefix) → `sentinel-not-top-level`
8. `<z-handoff type=plan-to-work>` (missing quotes) → `malformed-opening`

Edge cases (6):
1. `hasHandoffSentinel` returns true for valid, false for empty/no-sentinel
2. Multi-line value: `## Task List\n- item 1\n- item 2\n  - sub\n## Issue\n<url>` — Task List captured as multi-line, Issue as separate field
3. chainId uniqueness — two parses produce different UUIDs
4. Optional field parsing — `## Tier\nunknown-value` → tier=null (not in HandoffTier set, falls back to default)
5. **hopBudget initial value**: parse output → `context.hopBudget === 1` (foundation; #697 consumes)
6. `extractSentinelType`: valid sentinel → returns 'plan-to-work' | 'work-complete'; no sentinel / not top-level → null; unknown type string → null (sanitizes to null to keep validator simple)

Mapping helper tests:
- `expectedHandoffKind('z-plan-to-work')` → `'plan-to-work'`
- `expectedHandoffKind('z-epic-update')` → `'work-complete'`

---

## S3 — Session SSOT Schema + Serde

### Callstack

1. `src/types.ts`:
   - **Re-export block (`:3-32`)**: add `HandoffContext, HandoffKind, HandoffTier, HandoffParseFailure, ParseResult` (follow existing repo pattern — `src/` consumers import from `'./types'`).
   - `ConversationSession` interface at `:139-348`: add `handoffContext?: HandoffContext`.
   - Local `import type { HandoffContext } from 'somalib/model-commands/session-types'` in the second import block at `:34-45`.
2. `src/session-registry.ts:68-142` `SerializedSession`: add `handoffContext?: HandoffContext`.
3. `src/session-registry.ts:1586-1657` `saveSessions()`:
   - **Relax filter** (AD-12): change `if (session.sessionId)` (`:1596`) → `if (session.sessionId || session.handoffContext)` so sessions with pending handoff context persist even before SDK assigns a new sessionId after reset.
   - **Update the adjacent inline comment at `:1595`** (`// Only save sessions with sessionId (meaning they have conversation history)`) → `// Save sessions with conversation history OR pending handoffContext (AD-12 — handoff reset path persistence)`
   - Add `handoffContext: session.handoffContext` to the object literal (optional field — present only if set).
4. `src/session-registry.ts` `loadSessions()` (starts ~1705): when constructing session from `serialized`, assign `handoffContext: serialized.handoffContext` (undefined-safe).
5. `src/session-registry.ts:1672-1695` `archiveSerializedOnLoad`: add `handoffContext: serialized.handoffContext` to the constructed archive session (diagnostic parity).

### Contract tests (extend `src/session-registry.test.ts`)

1. `handoffContext round-trip`: save session with context, reload, deep-equal.
2. `backward compat — session JSON without handoffContext field`: deserialize → session.handoffContext === undefined, no error thrown.
3. `archive preserves handoffContext`: archive session → retrieve → handoffContext present.
4. **NEW for AD-12**: `persists session with handoffContext but no sessionId` — after resetSessionContext simulation (sessionId=undefined) + setting handoffContext → saveSessions → reload → handoffContext present. Pre-fix: this would fail because saveSessions skips sessions without sessionId.
5. **Negative**: `skips empty session (no sessionId, no handoffContext)` — existing legacy behavior preserved.

---

## S4 — Workflow Prompt Files

### Callstack

1. `src/prompt/workflows/z-plan-to-work.prompt` (NEW)
2. `src/prompt/workflows/z-epic-update.prompt` (NEW)
3. `src/prompt-builder.ts:278-319` `loadWorkflowPrompt` — no change (literal filename lookup).

### Content — `z-plan-to-work.prompt`

```
{{include:./common.prompt}}

# z Skill — Handoff Entrypoint: plan-to-work

세션이 CONTINUE_SESSION (forceWorkflow=z-plan-to-work) 으로 시작됨.
Host가 이미 `<z-handoff type="plan-to-work">` sentinel 존재/유효성을 검증했고, typed HandoffContext를 세션 상태에 저장함.

## 당신이 해야 할 일
1. prompt 본문의 `<z-handoff type="plan-to-work">` 블록을 SSOT 로 사용 (host가 이미 검증했으므로 재검증 불필요)
2. `local:z` phase0 clarify/new-task/codex review **스킵** — 원본 세션에서 이미 완료됨
3. 블록의 `## Task List` 를 TodoWrite로 등록
4. 블록의 `## Issue` URL과 `## Parent Epic` URL을 세션 SSOT로 기록
5. `local:zwork` 직행 — phase2 implementation 시작

## 금지
- phase0 clarify 재실행
- decision-gate 재호출 (원 세션에서 이미 판정됨)
- 새 PR 계획 수립 (원 계획이 authoritative)
```

### Content — `z-epic-update.prompt`

```
{{include:./common.prompt}}

# z Skill — Handoff Entrypoint: epic-update

세션이 CONTINUE_SESSION (forceWorkflow=z-epic-update) 으로 시작됨.
Host가 이미 `<z-handoff type="work-complete">` sentinel 존재/유효성을 검증함.

## 당신이 해야 할 일
1. prompt 본문의 `<z-handoff type="work-complete">` 블록을 SSOT 로 사용
2. `local:z` phase0/1/2/3/4 **스킵** — 구현 세션이 PR 머지까지 완료한 결과를 에픽에 반영만 수행
3. `## PR` 과 `## Summary` 를 해당 에픽 이슈에 코멘트로 포스팅
4. 에픽 body의 Checklist 갱신: 완료된 서브이슈 `[ ]` → `[x]`
5. `## Remaining Epic Checklist` 확인:
   - 모든 서브이슈 완료 & `using-epic-tasks/reference/github.md` 의 Epic Done 게이트 통과 → 에픽 close
   - 미완료 있음 → 목록만 유저에게 출력, **자동으로 다음 Handoff #1 발행 금지** (using-z §Protocol Rules #3)

## 금지
- 에픽 스펙 재검토 / 재설계
- 완료되지 않은 서브이슈를 완료로 마크
- 자동 다음 서브이슈 Handoff #1 발행 (유저 수동 재시작만)

> Note: budget/hop counting enforcement is #697 scope. This prompt only guides the default (non-chain) behavior.
```

### Contract tests (extend `src/prompt-builder.test.ts`)

- `loadWorkflowPrompt('z-plan-to-work')` 호출 성공, 결과에 `common.prompt` 포함된 내용 반환.
- `loadWorkflowPrompt('z-epic-update')` 동일.
- 기존 테스트 (onboarding, pr-review 등) 미영향 회귀 확인.

---

## S5 — `runDispatch` Enforcement

### Callstack

1. `src/slack/pipeline/session-initializer.ts:549` `runDispatch` signature 확장:
   ```typescript
   async runDispatch(
     channel: string,
     threadTs: string,
     text: string,
     forceWorkflow?: WorkflowType,
     handoffPrompt?: string,  // NEW
   ): Promise<void>
   ```
2. 새 early-branch (기존 `forceWorkflow` 분기 **앞**):
   ```typescript
   if (forceWorkflow === 'z-plan-to-work' || forceWorkflow === 'z-epic-update') {
     if (!handoffPrompt) {
       throw new HandoffAbortError(
         'no-sentinel',
         'runDispatch received no handoffPrompt for forced z-* workflow',
         forceWorkflow,
       );
     }
     const parsed = parseHandoff(handoffPrompt);
     if (!parsed.ok) {
       throw new HandoffAbortError(parsed.reason, parsed.detail, forceWorkflow);
     }
     // Enforce sentinel-to-workflow mapping
     const expected = expectedHandoffKind(forceWorkflow);
     if (parsed.context.handoffKind !== expected) {
       throw new HandoffAbortError(
         'type-workflow-mismatch',
         `expected <z-handoff type="${expected}">, got type="${parsed.context.handoffKind}"`,
         forceWorkflow,
       );
     }
     const session = this.deps.claudeHandler.getSession(channel, threadTs);
     if (!session) {
       throw new HandoffAbortError(
         'host-policy',
         'session not found at handoff entry',
         forceWorkflow,
       );
     }
     session.handoffContext = parsed.context;
     this.deps.claudeHandler.saveSessions();  // confirmed at src/claude-handler.ts:414 — delegates to sessionRegistry.saveSessions()
     this.deps.claudeHandler.transitionToMain(channel, threadTs, forceWorkflow, 'Handoff Entry');
     return;
   }
   ```
3. `claudeHandler.saveSessions()` is already exposed (verified at `src/claude-handler.ts:414`). No dep-surface change needed.

### Contract tests (`src/slack/pipeline/session-initializer-handoff.test.ts` — NEW)

mock: `claudeHandler` (getSession, transitionToMain, saveSessions, needsDispatch), `slackApi`, etc. Follow pattern from `session-initializer-routing.test.ts`.

1. **Happy plan-to-work**: valid sentinel with type="plan-to-work" + forceWorkflow='z-plan-to-work' → `handoffContext` assigned with `hopBudget===1`, `transitionToMain('z-plan-to-work', ...)` called, no throw.
2. **Happy epic-update**: valid sentinel with type="work-complete" + forceWorkflow='z-epic-update' → analogous.
3. **Missing handoffPrompt**: forceWorkflow z-* + handoffPrompt=undefined → `HandoffAbortError` with reason `no-sentinel`.
4. **Malformed sentinel**: missing closing → `HandoffAbortError` with reason `missing-closing`.
5. **Type-workflow mismatch (plan-to-work sentinel + z-epic-update workflow)**: → `HandoffAbortError` with reason `type-workflow-mismatch`. Verify `transitionToMain` NOT called and `handoffContext` NOT assigned.
6. **Type-workflow mismatch (work-complete sentinel + z-plan-to-work workflow)**: mirror of #5.
7. **Session not found**: getSession returns undefined → `HandoffAbortError` reason `host-policy`.
8. **Backward compat — onboarding forceWorkflow**: takes existing branch at :551-562, no parse, no throw. Verify parser NOT called.
9. **Backward compat — no forceWorkflow**: dispatch classifier called (mock it), existing behavior.
10. **hopBudget initialization**: happy path assertion — after successful handoff, `session.handoffContext.hopBudget === 1` (foundation for #697).

---

## S6 — Validator Precondition

### Callstack

`somalib/model-commands/validator.ts:654-698` `parseContinueSessionParams`: after forceWorkflow validation (~after `:687`):
```typescript
if (forceWorkflow === 'z-plan-to-work' || forceWorkflow === 'z-epic-update') {
  const sentinelType = extractSentinelType(prompt);
  if (!sentinelType) {
    return invalidArgs(
      `CONTINUE_SESSION forceWorkflow '${forceWorkflow}' requires <z-handoff> sentinel in prompt`,
    );
  }
  const expected = expectedHandoffKind(forceWorkflow);
  if (sentinelType !== expected) {
    return invalidArgs(
      `CONTINUE_SESSION forceWorkflow '${forceWorkflow}' requires <z-handoff type="${expected}">, got type="${sentinelType}"`,
    );
  }
}
```

### Contract tests (extend `somalib/model-commands/validator.test.ts`)

1. `forceWorkflow: z-plan-to-work` + prompt with matching plan-to-work sentinel → ok.
2. `forceWorkflow: z-plan-to-work` + prompt without sentinel → invalidArgs (missing sentinel).
3. `forceWorkflow: z-epic-update` + prompt with matching work-complete sentinel → ok.
4. `forceWorkflow: z-plan-to-work` + prompt with `<z-handoff type="work-complete">` (mismatch) → invalidArgs (expected type).
5. `forceWorkflow: z-epic-update` + prompt with `<z-handoff type="plan-to-work">` (mismatch) → invalidArgs (expected type).
6. `forceWorkflow: default` + prompt without sentinel → ok (backward compat — unchanged).
7. `forceWorkflow: z-plan-to-work` + resetSession: false → existing resetSession validation wins (existing behavior preserved).

Two-layer defense: S6 = existence + type match via `extractSentinelType`, S5 = full parse + mapping check. S6 prevents bad payloads from reaching runtime.

---

## S7 — SlackHandler Plumbing + HandoffAbortError Catch

### Callstack

1. `src/slack-handler.ts:530-539` `onResetSession`: pass `handoffPrompt = continuation.prompt` when forceWorkflow is `z-*`:
   ```typescript
   onResetSession: async (continuation: any) => {
     this.claudeHandler.resetSessionContext(activeChannel, activeThreadTs);
     const dispatchText = continuation.dispatchText || continuation.prompt;
     const handoffPrompt =
       continuation.forceWorkflow === 'z-plan-to-work' ||
       continuation.forceWorkflow === 'z-epic-update'
         ? continuation.prompt
         : undefined;
     await this.sessionInitializer.runDispatch(
       activeChannel,
       activeThreadTs,
       dispatchText,
       continuation.forceWorkflow,
       handoffPrompt,
     );
   }
   ```

2. `src/slack-handler.ts:544-613` try/catch: add `HandoffAbortError` branch BEFORE recoverable-error retry:
   ```typescript
   } catch (error) {
     if (error instanceof HandoffAbortError) {
       this.logger.warn('Handoff aborted', {
         channel: activeChannel,
         threadTs: activeThreadTs,
         reason: error.reason,
         detail: error.detail,
         forceWorkflow: error.forceWorkflow,
       });
       await this.slackApi.postMessage(
         activeChannel,
         `❌ Handoff entrypoint 진입 실패\nWorkflow: \`${error.forceWorkflow}\`\n원인: ${error.reason} — ${error.detail}\n수동 재시도: \`$z <issue-url>\``,
         { threadTs: activeThreadTs },  // MessageOptions.threadTs (src/slack/slack-api-helper.ts:14)
       );
       const session = this.claudeHandler.getSession(activeChannel, activeThreadTs);
       if (session) {
         session.terminated = true;
         this.claudeHandler.saveSessions();  // src/claude-handler.ts:414
       }
       return;  // skip auto-retry
     }
     // ... existing recoverable-error retry logic at :546+
   }
   ```

3. `ConversationSession.terminated` — verify this field exists (grep for `terminated:` in types.ts). If missing, need to add (separate concern — likely already present based on `src/slack/__tests__/session-terminated-flag.test.ts` existence).

### Contract tests (extend `src/slack-handler.test.ts`)

1. onResetSession: forceWorkflow=z-plan-to-work → runDispatch called with handoffPrompt set to continuation.prompt.
2. onResetSession: forceWorkflow=default → runDispatch called with handoffPrompt=undefined.
3. HandoffAbortError thrown from runDispatch → postMessage called with Korean error + session.terminated=true + NO retry attempt.
4. Non-HandoffAbortError thrown → existing retry path still works (backward compat).

---

## S8 — SKILL.md Producer-Side Update

### Changes (doc-only, `src/local/skills/using-z/SKILL.md`)

1. Line 76: `"forceWorkflow": "default"` → `"forceWorkflow": "z-plan-to-work"`
2. Line 108: `"forceWorkflow": "default"` → `"forceWorkflow": "z-epic-update"`
3. Line 139 Protocol Rule #5: "`forceWorkflow: \"default\"` 사용" → "`forceWorkflow: \"z-plan-to-work\"` (Handoff #1) 또는 `\"z-epic-update\"` (Handoff #2) 사용"
4. Line 148-152 Enforcement Status table:
   - "결정적 새 세션 진입" 행의 "목표 강제 수단" → "**구현 완료 (#695)**: 전용 `WorkflowType` (`z-plan-to-work`, `z-epic-update`) + host sentinel 검증"
5. **Handoff #1 payload template (`:73`) 확장**: `<z-handoff type="plan-to-work">` 블록 안에 3 new OPTIONAL `##` headings 추가 (producer-authoritative typed fields per AD-3):
   ```
   ## Tier
   <tiny|small|medium|large|xlarge>
   ## Escape Eligible
   <true|false>
   ## Issue Required By User
   <true|false>
   ```
   기존 필드 (Issue, Parent Epic, Original Request Excerpt, Repository Policy, Confirmed Plan, Task List, Codex Review) 위에 삽입. 누락 시 host parser가 conservative defaults 사용 (backward compat).
6. §Sentinel Grammar (line 122-131) rule 4 "Required fields 검증" 업데이트:
   - plan-to-work: Issue, Parent Epic, Task List **필수**; Tier, Escape Eligible, Issue Required By User **권장 (optional)**; 나머지 기존대로
   - work-complete: 변경 없음

No tests — doc only. Verify by:
- `grep -n 'forceWorkflow.*default' src/local/skills/using-z/SKILL.md` returns 0 matches in handoff payload blocks.
- `grep -n '## Tier' src/local/skills/using-z/SKILL.md` returns match in Handoff #1 block.

---

## S9 — End-to-End Integration Smoke

### Trigger
Full flow: CONTINUE_SESSION payload → validator accept → slack-handler onResetSession → runDispatch → parse → persist → reload verifies HandoffContext.

### Contract test (`src/agent-session/__tests__/handoff-e2e.test.ts` — NEW)

Mock the Slack surface + real SessionRegistry + real validator + real parser. Use the **public validator entrypoint** `validateModelCommandRunArgs` from `somalib/model-commands/validator.ts:83` (exported). `parseContinueSessionParams` is private — call through public API:

```typescript
import { validateModelCommandRunArgs } from 'somalib/model-commands/validator';

// 1. Construct CONTINUE_SESSION envelope
const cmdArgs = {
  commandId: 'CONTINUE_SESSION',
  params: { prompt, resetSession: true, dispatchText, forceWorkflow: 'z-plan-to-work' },
};
const validationResult = validateModelCommandRunArgs(cmdArgs);
expect(validationResult.ok).toBe(true);

// 2. Simulate reset + runDispatch (mirrors slack-handler:530 flow)
sessionRegistry.resetSessionContext(channel, threadTs);
await sessionInitializer.runDispatch(
  channel, threadTs, dispatchText, 'z-plan-to-work', prompt,
);

// 3. Verify in-memory state
const session = sessionRegistry.getSession(channel, threadTs);
expect(session.handoffContext?.handoffKind).toBe('plan-to-work');
expect(session.handoffContext?.sourceIssueUrl).toBe('https://github.com/...');
expect(session.workflow).toBe('z-plan-to-work');
expect(session.state).toBe('MAIN');

// 4. Verify persistence (AD-12 filter relaxation)
sessionRegistry.saveSessions();
const registry2 = new SessionRegistry(…);
registry2.loadSessions();
const reloaded = registry2.getSession(channel, threadTs);
expect(reloaded.handoffContext).toEqual(session.handoffContext);
```

Negative branch (same test file):
- `forceWorkflow='z-plan-to-work'` with malformed sentinel → `runDispatch` throws `HandoffAbortError` with reason `missing-closing` (or appropriate). Verify session NOT transitioned, session state remains `INITIALIZING`.

---

## Entry Point Wiring Checklist (strict)

- [ ] S1: `session-types.ts:4` union +2 values
- [ ] S1: `validator.ts:24` `WORKFLOW_TYPES` +2 values
- [ ] S1: `dispatch-service.ts:466` `VALID_WORKFLOWS` +2 values
- [ ] S1: `action-panel-builder.ts:68` `WORKFLOW_ACTIONS` +2 keys (empty arrays)
- [ ] S2: `session-types.ts` exports `HandoffKind, HandoffTier, HandoffContext, HandoffParseFailure, ParseResult`
- [ ] S2: `handoff-parser.ts` exports `parseHandoff, hasHandoffSentinel, extractSentinelType, expectedHandoffKind, HandoffAbortError`
- [ ] S3: `src/types.ts` **re-export block (`:3-32`)** adds `HandoffContext, HandoffKind, HandoffTier, HandoffParseFailure, ParseResult` (repo pattern)
- [ ] S3: `src/types.ts` imports HandoffContext, `ConversationSession.handoffContext?` present
- [ ] S3: `SerializedSession.handoffContext?` present
- [ ] S3: **`saveSessions()` filter relaxed** to `session.sessionId || session.handoffContext` (AD-12)
- [ ] S3: `saveSessions()` includes handoffContext in literal
- [ ] S3: `loadSessions()` restores handoffContext
- [ ] S3: `archiveSerializedOnLoad` preserves handoffContext
- [ ] S4: `src/prompt/workflows/z-plan-to-work.prompt` exists, starts with `{{include:./common.prompt}}`
- [ ] S4: `src/prompt/workflows/z-epic-update.prompt` exists, starts with `{{include:./common.prompt}}`
- [ ] S5: `session-initializer.ts` imports parseHandoff + HandoffAbortError + expectedHandoffKind from somalib
- [ ] S5: `runDispatch` signature has `handoffPrompt?: string` last param
- [ ] S5: early branch inserted BEFORE existing forceWorkflow branch
- [ ] S5: **mapping check** (type-workflow-mismatch) present in early branch
- [ ] S5: `hopBudget===1` assertion in happy-path test
- [ ] S6: `validator.ts` imports extractSentinelType + expectedHandoffKind
- [ ] S6: precondition block inserted after forceWorkflow validation in parseContinueSessionParams
- [ ] S6: **mapping check** via `extractSentinelType` + `expectedHandoffKind` comparison
- [ ] S7: `slack-handler.ts:530` onResetSession passes handoffPrompt to runDispatch
- [ ] S7: `slack-handler.ts:544` try/catch has HandoffAbortError branch BEFORE retry logic
- [ ] S7: HandoffAbortError import present
- [ ] S8: SKILL.md line 76 updated (`"default"` → `"z-plan-to-work"`)
- [ ] S8: SKILL.md line 108 updated (`"default"` → `"z-epic-update"`)
- [ ] S8: SKILL.md line 139 Rule #5 updated
- [ ] S8: SKILL.md line 148-152 Enforcement Status table updated
- [ ] S8: SKILL.md Handoff #1 payload template adds 3 new OPTIONAL fields (`## Tier`, `## Escape Eligible`, `## Issue Required By User`)
- [ ] S8: SKILL.md §Sentinel Grammar rule 4 updated to document new optional fields
- [ ] S9: e2e smoke test green

---

## Dependency Order (strict)

```
S1 (allowlist) ──┐
                 ├──> S5 (runDispatch) ──┐
S2 (types+parser) ┤                      ├──> S7 (slack-handler)
                  ├──> S6 (validator)────┘           │
S3 (session serde)┘                                  ├──> S9 (e2e)
                                                     │
S4 (prompts) ─── independent ────────────────────────┤
                                                     │
S8 (SKILL.md) ─── doc-only, after code lands ────────┘
```

1. S1 (allowlist) + S2 (types/parser) first — no dependencies
2. S3 (session serde) parallel with S1/S2 (depends only on HandoffContext from S2)
3. S4 (prompts) independent
4. S5 (runDispatch) needs S1+S2+S3
5. S6 (validator) needs S1+S2
6. S7 (slack-handler) needs S5
7. S8 (SKILL.md) can land with code (same PR) — doc updates describe the new behavior
8. S9 (e2e) last — needs everything

## Codex Review Score Target: ≥95 (achieved: 4차 = 96/100)

Gaps addressed through 4 review rounds:
- ✅ AD-4 Real enforcement site = `runDispatch` (not `initialize()`)
- ✅ AD-5 Prompt plumbing via `handoffPrompt` param
- ✅ AD-6 Safe-stop via `HandoffAbortError` + slack-handler catch (avoids continuation loop completion)
- ✅ AD-3 Typed fields as producer-authoritative optional headings (not host-derived one-bit inference)
- ✅ AD-7 Producer update in SKILL.md (same PR) — payload examples + Protocol Rule + Enforcement Status + §Sentinel Grammar rule 4
- ✅ Correct function names: `parseContinueSessionParams`, `invalidArgs`, `saveSessions/loadSessions`
- ✅ AD-8 Quadruple allowlist including `WORKFLOW_ACTIONS`
- ✅ AD-9 Baseline = 10 (not 9)
- ✅ AD-10 Workflow prompts reference sentinel body, not GET_SESSION snapshot
- ✅ Test files follow existing `session-initializer-*.test.ts` split pattern
- ✅ AD-12 `saveSessions()` filter relaxation — persists handoffContext post-reset
- ✅ Sentinel-to-workflow mapping enforcement at both validator (via `extractSentinelType` + `expectedHandoffKind`) and `runDispatch` (via `parseHandoff` + mapping check)
- ✅ `hopBudget === 1` explicit test coverage
- ✅ `src/types.ts` re-export block pattern followed
