# Handoff Entrypoints + Typed Metadata Persistence

> Issue #695 · Part of epic #694 · Foundation subissue (#696/#697/#698 consume this metadata)

## Why

z 컨트롤러의 세션 핸드오프는 현재 prompt-level convention으로만 강제된다. `src/local/skills/using-z/SKILL.md` §Session Handoff Protocol은 payload 계약을 정의하지만, 두 가지 구조적 구멍이 남는다:

1. **Non-deterministic entry**. 현재 producer는 `forceWorkflow: "default"` 를 emit하고 (SKILL.md:76, :108), host는 `default.prompt` 분류기로 `$z` prefix를 best-effort 매칭한다. Prompt collision 시 오라우팅 가능.
2. **No typed state**. sentinel 본문이 prompt 텍스트로만 존재하고 host는 구조화된 `HandoffContext`를 보관하지 않는다. 이후 guard (#696/#697/#698)가 참조할 상태가 없다.

이 서브이슈는 그 두 구멍을 메운다: **결정적 진입 + typed persistence**.

## What

1. 신규 `WorkflowType` 2종 (`z-plan-to-work`, `z-epic-update`) 을 type union + validator 허용리스트 + dispatch 허용 Set + ActionPanel Record에 추가
2. `<z-handoff>` sentinel parser (host-level TypeScript) — 기존 SKILL.md 문법 그대로 파싱
3. `ConversationSession`에 `handoffContext?: HandoffContext` 필드 + JSON 왕복 serde
4. Handoff 전용 workflow 진입 시 host가 sentinel 존재/유효성 검증. 실패 시 safe-stop으로 **continuation loop 중단** + 유저에게 원인 전달
5. 두 신규 workflow 전용 prompt 파일 2개 (z skill의 올바른 phase로 진입 가이드)
6. **Producer 동기화**: `src/local/skills/using-z/SKILL.md` 의 Handoff #1/#2 payload 예제에서 `forceWorkflow: "default"` → `"z-plan-to-work"` / `"z-epic-update"` 로 업데이트. 모델이 새 workflow 타입을 emit하도록 유도

## Success Signal

- Handoff #1 payload (올바른 sentinel + `forceWorkflow: "z-plan-to-work"`) 로 시작된 세션이 phase0 clarify 재수행 없이 phase2 zwork로 진입
- Handoff #2 payload로 시작된 세션이 epic-update 경로로 진입
- `<z-handoff>` 빠진 채 `z-*` workflow 진입 시도 → host가 continuation loop를 중단시키고 safe-stop Slack 메시지 발송 + 세션 terminated 마크
- 기존 10개 WorkflowType 동작 불변 (backward compat)

## Architecture Decisions

### AD-1: Parser module location — `somalib/model-commands/handoff-parser.ts`
**Why**: CONTINUE_SESSION validator (`somalib/model-commands/validator.ts`) 와 `src/slack/pipeline/session-initializer.ts` 양쪽에서 파싱 필요. somalib은 src 의존성 없는 shared layer. 두 consumer가 import 가능.

### AD-2: HandoffContext type declared in `somalib/model-commands/session-types.ts`
**Why**: `WorkflowType` 이미 여기. `src/types.ts:3-32` 의 re-export 블록에서 `WorkflowType` 을 export함 — 같은 블록에 `HandoffContext`, `HandoffKind`, `HandoffTier`, `HandoffParseFailure`, `ParseResult` 추가. `src/` 하위 파일들이 `./types` 에서 import하는 기존 패턴 유지.

### AD-3: Field set extension (NOT grammar extension) — producer-authoritative typed fields

**Distinction**: Epic #694 Out of Scope says "`<z-handoff>` 문법 자체 확장". **문법 (grammar)** = opening/closing tag form, top-level placement rule, required core fields, duplicate handling, case sensitivity. These stay unchanged. **Field set** inside the block is *already* open-ended (e.g., `## Repository Policy`, `## Codex Review` are informational). Adding 3 new **optional** `##` headings for typed metadata is a field-set addition, not a grammar change.

Issue #695 Scope explicitly requires `tier`, `escapeEligible`, `issueRequiredByUser` as **distinct** typed fields reflecting producer-side validation state — not host-inferred. Deriving all 3 from a single "Case A escape" string collapses distinct validation axes (tier, user intent, validation passage) into one bit. Per subissue requirement: producer signals authoritatively, host records verbatim.

**3 new OPTIONAL sentinel fields** (plan-to-work only; work-complete doesn't need them):

| Field | Format | Purpose |
|---|---|---|
| `## Tier` | `tiny\|small\|medium\|large\|xlarge` | `using-epic-tasks` 판정 tier |
| `## Escape Eligible` | `true\|false` | Case A 3-condition 검증 통과 (producer side) |
| `## Issue Required By User` | `true\|false` | 유저 원 요청에 선행 이슈 요구 존재 여부 |

These are **optional** in the grammar (backward compat) — parser falls back to conservative defaults when absent:
- `tier` absent → `null` (unknown; consumers treat as non-authoritative)
- `escapeEligible` absent → `false` (safe default — deny escape; #696 will block PR creation)
- `issueRequiredByUser` absent → `true` (safe default — require issue)

**Derivation table** (host parser, pure function):

| HandoffContext field | Source |
|---|---|
| `handoffKind` | `<z-handoff type="...">` attribute 값 |
| `sourceIssueUrl` | `## Issue` (plan-to-work) / `## Completed Subissue` (work-complete). 값이 `"none"` 또는 `"none (...)"` 패턴이면 `null`; 그렇지 않으면 첫 URL-like 토큰 |
| `parentEpicUrl` | `## Parent Epic` 값. `"none"` → `null`. work-complete에서는 sentinel에 없으므로 `null` |
| `escapeEligible` | `## Escape Eligible` 값 (`true\|false`). 부재 시 `false` |
| `tier` | `## Tier` 값. 부재 시 `null` |
| `issueRequiredByUser` | `## Issue Required By User` 값. 부재 시 `true` |
| `chainId` | host `crypto.randomUUID()` 발급 (sentinel에 없음; 로그 추적용) |
| `hopBudget` | host `1` 초기화 (#697에서 소비) |

Producer (SKILL.md) payload template에 3 new fields 포함되도록 S8 에서 업데이트. 모든 신규 handoff는 3 fields emit — 기존 session (fallback defaults) 과 병행 지원.

### AD-4: Enforcement site — `SessionInitializer.runDispatch`, NOT `initialize()`
**Why**: 실제 CONTINUE_SESSION 재진입 경로는 `SlackHandler.handleMessage` → `continuationHandler.onResetSession` (`src/slack-handler.ts:530`) → `sessionInitializer.runDispatch(channel, threadTs, dispatchText, forceWorkflow)` (`:533`). `initialize()`는 새 Slack 메시지의 fresh session 진입 경로이고, 핸드오프는 **기존 세션의 reset 경로**로 들어옴.

### AD-5: Prompt plumbing — `runDispatch` 시그니처 확장
**Why**: 현재 `runDispatch(channel, threadTs, text, forceWorkflow)` 의 `text` 는 `continuation.dispatchText || continuation.prompt` 로 들어오지만 (`slack-handler.ts:532`), sentinel은 **`continuation.prompt` 본문**에 있고 `dispatchText`는 보통 `<ISSUE_URL>` 만. Parser는 full prompt를 봐야 함.

**Change**: `runDispatch` 시그니처에 선택 `handoffPrompt?: string` 추가 (또는 기존 `text` 의미를 "dispatch classification text" → 유지, 별도 `handoffPrompt` 추가). `slack-handler.ts:530` onResetSession은 `handoffPrompt = continuation.prompt` 를 추가 전달.

```typescript
async runDispatch(
  channel: string,
  threadTs: string,
  text: string,
  forceWorkflow?: WorkflowType,
  handoffPrompt?: string,  // NEW: full continuation prompt for sentinel parsing
): Promise<void>
```

Backward compat: 기존 호출자 (`cron-scheduler.test.ts` 등)는 파라미터 미지정 → 기존 동작 유지.

### AD-6: Safe-stop propagation — throw `HandoffAbortError` from `onResetSession`
**Why**: `onResetSession`이 `v1-query-adapter.ts:123`에서 await되고, 이후 line 139에서 `this.continue(decision.prompt)` 가 prompt를 모델에 전달한다. 단순히 return하면 continuation이 그대로 실행되어 handoff가 성공한 것처럼 보임.

**Change**: `somalib/model-commands/handoff-parser.ts`에서 export한 `HandoffAbortError` (sentinel 관련 에러 전용) 를 `onResetSession`이 throw. v1-query-adapter의 continuation loop가 await에서 rethrow → slack-handler.ts:544 try/catch가 잡음. slack-handler는 **HandoffAbortError 타입 체크** → auto-retry 경로 건너뛰고 → safe-stop 메시지 발송 + 세션 terminated 마크.

### AD-7: SKILL.md producer side update
**Why**: `src/local/skills/using-z/SKILL.md` line 76, 108 에서 현재 `forceWorkflow: "default"` emit. 호스트가 새 `z-*` workflow 인식하려면 **producer도 새 값을 emit** 해야 함. 안 그러면 새 workflow 코드 패스가 영원히 dead.

Changes (문서만):
- Line 76: `"forceWorkflow": "default"` → `"forceWorkflow": "z-plan-to-work"`
- Line 108: `"forceWorkflow": "default"` → `"forceWorkflow": "z-epic-update"`
- Line 149 Enforcement Status table row "결정적 새 세션 진입": "현재 강제 수단 / 목표 강제 수단" → "구현 완료 (#695)" 로 업데이트
- §Protocol Rules #5 (line 139): `forceWorkflow: "default"` 사용 규정을 → "`forceWorkflow: z-plan-to-work` or `z-epic-update` 사용" 로 대체

### AD-8: Quadruple allowlist (NOT triple)
새 `WorkflowType` 추가는 4개 위치 동기화 필요:
1. `somalib/model-commands/session-types.ts:4-14` — type union
2. `somalib/model-commands/validator.ts:24-35` — runtime `WORKFLOW_TYPES: WorkflowType[]`
3. `src/dispatch-service.ts:466-477` — `VALID_WORKFLOWS: ReadonlySet<string>`
4. `src/slack/action-panel-builder.ts:68-79` — `WORKFLOW_ACTIONS: Record<WorkflowType, PanelActionKey[]>` (TS `Record` 타입이므로 **exhaustive 강제 — 빠뜨리면 컴파일 에러**)

이 네 개 중 하나라도 빠지면 컴파일 에러(3, 4) 또는 runtime reject(2) 또는 silent coerce to default(3).

### AD-9: Baseline — 10 current WorkflowType values (not 9)
문서의 "기존 9개" 언급은 잘못. 현 union은 10개 (`onboarding`, `jira-executive-summary`, `jira-brainstorming`, `jira-planning`, `jira-create-pr`, `pr-review`, `pr-fix-and-update`, `pr-docs-confluence`, `deploy`, `default`). 추가 후 12개.

### AD-10: Workflow prompt content does NOT use `session.handoffContext.*`
**Why**: `GET_SESSION` 커맨드가 반환하는 `SessionResourceSnapshot` (`somalib/model-commands/session-types.ts:101`) 에는 `handoffContext` 미노출. 모델은 prompt에 직접 포함된 `<z-handoff>` 블록 본문을 보고 해석.

Workflow prompt는 단순히 "새 workflow 진입 당신은 handoff로 왔음, 원본 prompt의 `<z-handoff>` 블록을 SSOT 로 사용, phase0 스킵, 해당 phase로 직행" 가이드. HandoffContext는 **host-side guards (#696/#697/#698)** 가 읽는 용도.

### AD-11: SerializedSession backward compat
optional 필드 `handoffContext?: HandoffContext` 추가. 기존 세션 JSON 역직렬화 시 필드 부재 → `undefined` 허용. 신규 세션 save 시 present면 포함.

### AD-12: Relax `saveSessions` filter for sessions with pending handoffContext
**Why**: `resetSessionContext()` (`src/session-registry.ts:1231`) clears `sessionId` to `undefined`. `saveSessions()` (`:1596`) currently gates `if (session.sessionId)`, so persisting `handoffContext` **right after** reset in `runDispatch` (S5) is a **no-op** until the model produces the first response and a new `sessionId` is assigned.

**Fix**: relax the filter:
```typescript
if (session.sessionId || session.handoffContext) {
```
Sessions with pending handoff context get serialized too. Once the SDK assigns a new sessionId on first model turn, subsequent saves include both.

This matches issue #695 Done criteria ("블록이 typed metadata로 파싱되어 세션 상태에 저장되고, Sub 2/3/4 guard들이 prompt 재파싱 없이 이 metadata를 소비할 수 있다") — requires actual persistence, not best-effort.

Backward compat: existing sessions (no handoffContext, no sessionId) are still skipped — filter only becomes more permissive.

## Data Model

### `HandoffContext`

```typescript
export type HandoffKind = 'plan-to-work' | 'work-complete';
export type HandoffTier = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

export interface HandoffContext {
  handoffKind: HandoffKind;
  sourceIssueUrl: string | null;
  escapeEligible: boolean;
  tier: HandoffTier | null;
  issueRequiredByUser: boolean;
  parentEpicUrl: string | null;
  chainId: string;        // uuid
  hopBudget: number;      // initial 1
}
```

### `ParseResult`

```typescript
export type HandoffParseFailure =
  | 'no-sentinel'
  | 'duplicate-sentinel'
  | 'malformed-opening'
  | 'missing-closing'
  | 'unknown-type'
  | 'missing-required-field'
  | 'sentinel-not-top-level'
  | 'type-workflow-mismatch';

export type ParseResult =
  | { ok: true; context: HandoffContext }
  | { ok: false; reason: HandoffParseFailure; detail: string };
```

### Sentinel-to-workflow mapping (enforced)

```typescript
const SENTINEL_WORKFLOW_MAP = {
  'plan-to-work': 'z-plan-to-work',
  'work-complete': 'z-epic-update',
} as const;

export function expectedHandoffKind(
  forceWorkflow: 'z-plan-to-work' | 'z-epic-update',
): HandoffKind {
  return forceWorkflow === 'z-plan-to-work' ? 'plan-to-work' : 'work-complete';
}

export function extractSentinelType(text: string): HandoffKind | null;  // lightweight, regex only
```

Both validator (existence + strict type match) and `runDispatch` (full parse + type match) enforce the mapping. `forceWorkflow='z-epic-update'` + `<z-handoff type="plan-to-work">` → `type-workflow-mismatch` failure.

### `HandoffAbortError`

```typescript
export class HandoffAbortError extends Error {
  constructor(
    public readonly reason: HandoffParseFailure | 'host-policy',
    public readonly detail: string,
    public readonly forceWorkflow: 'z-plan-to-work' | 'z-epic-update',
  ) {
    super(`Handoff aborted: ${reason} — ${detail}`);
    this.name = 'HandoffAbortError';
  }
}
```

## Interfaces

### Parser public API (single source of truth)

```typescript
// Full parse — runDispatch uses this
export function parseHandoff(promptText: string): ParseResult;

// Lightweight existence check — returns true if a valid-looking sentinel is top-level
export function hasHandoffSentinel(promptText: string): boolean;

// Lightweight type extraction — returns 'plan-to-work' | 'work-complete' | null
// Validator uses this for sentinel-to-workflow mapping check without full parse
export function extractSentinelType(promptText: string): HandoffKind | null;

// Pure mapping helper
export function expectedHandoffKind(
  forceWorkflow: 'z-plan-to-work' | 'z-epic-update',
): HandoffKind;

// Error class thrown from runDispatch, caught in slack-handler.ts
export class HandoffAbortError extends Error {
  readonly reason: HandoffParseFailure | 'host-policy';
  readonly detail: string;
  readonly forceWorkflow: 'z-plan-to-work' | 'z-epic-update';
}
```

### SessionInitializer.runDispatch (extended)

```typescript
async runDispatch(
  channel: string,
  threadTs: string,
  text: string,
  forceWorkflow?: WorkflowType,
  handoffPrompt?: string,  // NEW
): Promise<void>
```

When `forceWorkflow` is `'z-plan-to-work'` or `'z-epic-update'`:
1. If `!handoffPrompt`, throw `HandoffAbortError('no-sentinel', 'handoff prompt not provided to runDispatch', forceWorkflow)`.
2. `const parsed = parseHandoff(handoffPrompt)`.
3. If `!parsed.ok`, throw `HandoffAbortError(parsed.reason, parsed.detail, forceWorkflow)`.
4. **Verify mapping**: `const expected = expectedHandoffKind(forceWorkflow); if (parsed.context.handoffKind !== expected) throw new HandoffAbortError('type-workflow-mismatch', \`expected type='\${expected}' but got '\${parsed.context.handoffKind}'\`, forceWorkflow)`.
5. Else: `session.handoffContext = parsed.context; claudeHandler.saveSessions(); transitionToMain(channel, threadTs, forceWorkflow, title)`.

### slack-handler.ts:530 onResetSession

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

### slack-handler.ts:544 try/catch (HandoffAbortError branch)

Add before existing retry-logic:
```typescript
} catch (error) {
  if (error instanceof HandoffAbortError) {
    await this.sendHandoffAbortMessage(activeChannel, activeThreadTs, error);
    this.claudeHandler.getSession(activeChannel, activeThreadTs)?.terminated = true;
    return;  // skip auto-retry
  }
  // ... existing recoverable-error retry logic
}
```

`sendHandoffAbortMessage` posts a Slack thread message:
```
❌ Handoff entrypoint 진입 실패
Workflow: {forceWorkflow}
원인: {reason} — {detail}
수동 재시도: $z <issue-url>
```

### Validator precondition (`somalib/model-commands/validator.ts:654-698`)

In `parseContinueSessionParams` after forceWorkflow validation (~line 687):
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

Two-layer defense:
- **Validator**: lightweight regex-based type extraction + exact match. Catches payload-level misuse before runtime.
- **runDispatch**: full parse + mapping check (redundant with validator, but defensive — validator is optional path depending on how producer submits the command).

Both use `invalidArgs(...)` / `HandoffAbortError` consistent with existing error pattern. No `ValidationError` class.

## Non-Goals

- `<z-handoff>` grammar 필드 추가 (epic Out of Scope)
- `hopBudget` 감소/소비 로직 (#697)
- Issue URL precondition at PR creation (#696)
- Dispatch failure safe-stop for non-handoff workflows (#698)
- Dispatch classifier (`src/prompt/dispatch.prompt`) 수정 — new workflows는 `CONTINUE_SESSION.forceWorkflow` 로만 진입, classifier 경로 경유 안함

## Risks

| Risk | Mitigation |
|---|---|
| Parser regex가 본문 내 quoted sentinel 오매칭 | strict top-level only: prompt의 첫 non-empty line 또는 `$z ...` 라인 직후만 sentinel 인정 (Rule 2) |
| 기존 세션 JSON에 handoffContext 필드 없어 deserialize 실패 | optional (`?`) — `undefined` 허용 |
| `cron-scheduler`가 `transitionToMain`을 직접 호출 (test file 25곳) — workflow union 변경 시 type error | 모두 `'default'` literal 사용; union 확장은 backward compat 보장 |
| SKILL.md 업데이트와 host 코드 배포 간 race | 같은 PR에 producer (SKILL.md) + consumer (code) 동시 포함. 분리 X |
| `onResetSession` throw가 auto-retry 경로로 흘러 재시도 loop | `HandoffAbortError` instance check로 분기 — 신규 error class |
| `ActionPanelBuilder.WORKFLOW_ACTIONS` 빠뜨리면 컴파일 에러 (TS Record 타입) | **그게 안전망** — 컴파일러가 강제 |
| `handoffContext` 가 archive store에 누락 (`archiveSerializedOnLoad` line 1663) | archive는 diagnostic 용도이므로 누락 허용. 필요 시 optional field copy 추가 (P1 nice-to-have) |

## Rollback Plan

Single PR, single revert. 모든 변경은 additive:
- 4개 allowlist 값 추가 (삭제 없음)
- 새 파일 추가 (parser, 2 prompts, test files)
- `runDispatch` 시그니처에 optional 파라미터 추가 (기존 호출자 변경 불필요)
- `slack-handler.ts` onResetSession에 파라미터 하나 추가 + try/catch 분기 하나 추가
- `SessionInitializer.runDispatch` 내부에 early-return 분기 추가
- `SerializedSession` optional 필드 추가
- `validator.ts` precondition 블록 하나 추가
- `saveSessions()` 필터 하나 relaxation (AD-12)
- SKILL.md 문서 업데이트 (payload 예제 2곳 + Protocol Rule #5 + Enforcement Status table + Handoff #1 template 3 optional fields + §Sentinel Grammar rule 4)

Revert 시 기존 10개 workflow 동작 영향 0. 기존 세션 JSON 영향 0 (새 필드는 optional).

## Codex Review Score Target: ≥95

Addressed gaps from 1차 (38/100) → 2차 (86/100) → 3차 round:
1차 → 2차:
- ✅ Real runtime path (`runDispatch` via `onResetSession`, not `initialize()`)
- ✅ Prompt plumbing (`handoffPrompt` param on `runDispatch`)
- ✅ Safe-stop propagation (`HandoffAbortError` + slack-handler catch)
- ✅ Producer side update (SKILL.md `forceWorkflow` lines + Enforcement Status table)
- ✅ Correct function names (`parseContinueSessionParams`, `invalidArgs`, `saveSessions/loadSessions`)
- ✅ Quadruple allowlist including `WORKFLOW_ACTIONS`
- ✅ Baseline corrected (10, not 9)
- ✅ Prompt doesn't reference non-existent `session.handoffContext.*` via GET_SESSION

2차 → 3차:
- ✅ AD-3 revised: producer-authoritative typed fields (3 new optional `##` headings). Not grammar extension (tag form unchanged) — field set extension aligned with issue #695 distinct-field requirement
- ✅ AD-12 added: `saveSessions` filter relaxation so handoffContext persists post-reset (was no-op before due to sessionId gate at `src/session-registry.ts:1596`)
- ✅ `z-epic-update.prompt`: removed hopBudget consumption / auto-chain language (out of scope for #695)
- ✅ E2E test uses public entry `validateModelCommandRunArgs` + full slack-handler integration (not internal `parseContinueSessionParams`)
- ✅ Slack API uses `{ threadTs: ... }` (per `src/slack/slack-api-helper.ts:14`), not `{ thread_ts: ... }`
- ✅ Parser failure taxonomy disambiguated: regex captures any type string → explicit unknown-type vs sentinel-not-top-level vs malformed-opening
- ✅ `claudeHandler.saveSessions()` confirmed available (`src/claude-handler.ts:414`)
