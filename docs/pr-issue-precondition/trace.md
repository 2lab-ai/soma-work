# Trace — PR Issue-Link Precondition (Host-Side, v2.1)

Feature: Issue #696 · Part of epic #694 · Consumes typed `HandoffContext` from #695 (PR #703)

> **v2 revision**: v1 trace targeted the external Fastify hook proxy (wrong seam). v2 moves to the
> in-process SDK PreToolUse hook system in `claude-handler.ts:701-955`, eliminating the registry
> provider singleton and SDK-id reverse lookup. See spec.md §Spec Changelog for full revision rationale.

## Scenarios (= Task List)

| # | Scenario | Tier | Files touched | Tests | Order |
|---|---|---|---|---|---|
| S1 | `pr-issue-guard.ts` pure module + branch matrix | medium | `src/hooks/pr-issue-guard.ts` (new) | `src/hooks/pr-issue-guard.test.ts` (new, 19) | 1 |
| S2 | Wire two PreToolUse hooks (Bash + MCP) into `claude-handler.ts` | small | `src/claude-handler.ts` | extend `src/claude-handler.test.ts` (+3) | 2 |
| S3 | Defense-in-depth prompt prose flips | tiny | `src/local/skills/zwork/SKILL.md`, `src/local/skills/using-z/SKILL.md` | doc-only | 3 |

Net: 1 new module + 1 new test file + 4 modified files. ~250-350 lines including tests. Fits "medium" tier per `using-epic-tasks`.

---

## S1 — `pr-issue-guard.ts` Pure Module + Branch Matrix

### Trigger

Spec AD-2: pure guard function with explicit `handoffContext` argument. AD-3 / AD-4 / AD-6 / AD-6.5 / AD-7 / AD-8 define the full algorithm. The hook caller (S2) is responsible for resolving `session.handoffContext` BEFORE invoking the guard — the guard itself takes `handoffContext` as required input, eliminating the v1 silent-fail-open trap.

### Callstack

1. `src/hooks/pr-issue-guard.ts` (new file) — exports:
   ```typescript
   export interface PrIssueGuardInput {
     toolName: string;
     toolInput: Record<string, unknown> | undefined;
     handoffContext: HandoffContext;   // REQUIRED
   }

   export type GuardReason =
     | 'no-issue-no-escape'
     | 'missing-closes-issue'
     | 'wrong-issue-number'
     | 'missing-escape-marker'
     | 'malformed-source-issue-url'
     | 'unknown-tool-shape';

   export interface PrIssueGuardResult {
     blocked: boolean;
     reason?: GuardReason;
     message?: string;
   }

   export function handlePrIssuePrecondition(input: PrIssueGuardInput): PrIssueGuardResult;

   // Internal helpers (not exported; tested via the public function):
   //   isPrCreateBashCommand(cmd: string): boolean
   //   isPrCreateMcpTool(toolName: string): boolean
   //   extractIssueNumber(url: string): number | null
   //   extractBashBodyContent(cmd: string): string | null   // returns substring AFTER --body flag, or null
   //   bashContainsClosesIssue(cmd: string, n: number): boolean   // wraps extractBashBodyContent + regex
   //   bashContainsEscapeMarker(cmd: string): boolean
   //   mcpBodyContainsClosesIssue(body: string, n: number): boolean
   //   mcpBodyContainsEscapeMarker(body: string): boolean
   //   formatBlockMessage(reason: GuardReason, ctx: HandoffContext, toolName: string): string
   ```
   Imports:
   ```typescript
   import type { HandoffContext } from '../types';   // re-exported per #695 at types.ts:5,40,186
   ```

2. **Algorithm** (per spec AD-3/AD-4/AD-6/AD-6.5/AD-7/AD-8):

```
handlePrIssuePrecondition(input):
  // Tool detection
  1. let bodyContent: string | null
  2. if input.toolName === 'Bash':
       cmd = input.toolInput?.command
       if typeof cmd !== 'string' → { blocked: false }   // unknown shape, fail-open
       if !isPrCreateBashCommand(cmd) → { blocked: false }   // not a PR-create command
       bodyContent = extractBashBodyContent(cmd)
       if bodyContent === null:
         // No --body flag at all — block as if missing marker
         → { blocked: true, reason: <markerType per ctx>, message: format(...) }
     else if input.toolName === 'mcp__github__create_pull_request':
       body = input.toolInput?.body
       if typeof body !== 'string' → { blocked: true, reason: 'unknown-tool-shape', ... }
       bodyContent = body
     else:
       → { blocked: false }   // not a PR-creation tool

  ctx = input.handoffContext

  // AD-8 precedence
  3. if ctx.sourceIssueUrl !== null:
       issueNum = extractIssueNumber(ctx.sourceIssueUrl)
       if issueNum === null:
         → { blocked: true, reason: 'malformed-source-issue-url', message: format(...) }
       if !markerInBody(bodyContent, /\bcloses\s+#${issueNum}\b/i):
         // Distinguish wrong-issue-number vs missing entirely for clearer messages
         if /\bcloses\s+#\d+\b/i.test(bodyContent):
           → { blocked: true, reason: 'wrong-issue-number', message: format(...) }
         else:
           → { blocked: true, reason: 'missing-closes-issue', message: format(...) }
       → { blocked: false }   // sourceIssueUrl + Closes #N present → pass

  4. // sourceIssueUrl === null
     if ctx.escapeEligible === true:
       if !markerInBody(bodyContent, /Case A escape/):
         → { blocked: true, reason: 'missing-escape-marker', message: format(...) }
       → { blocked: false }   // escapeEligible + marker present → pass

  5. // sourceIssueUrl === null AND escapeEligible === false
     → { blocked: true, reason: 'no-issue-no-escape', message: format(...) }

----

extractBashBodyContent(cmd):
  // AD-6 (v2.1): TWO-STEP — anchor to `gh pr create` segment, THEN find --body inside it.
  // This defeats `echo "--body Closes #696" && gh pr create --body "x"` false-pass:
  // the first --body is in the echo string (before gh segment) and is correctly skipped.
  ghMatch = /\bgh\s+pr\s+create\b/.exec(cmd)
  if !ghMatch → null
  tail = cmd.slice(ghMatch.index + ghMatch[0].length)
  // Now locate first --body / -b / --body-file flag in the tail
  flagMatch = /(?:--body(?:-file)?|-b)(?:\s|=)/.exec(tail)
  if !flagMatch → null
  return tail.slice(flagMatch.index + flagMatch[0].length)
  // Note: returns the WHOLE remainder. Marker check uses regex which tolerates trailing
  // shell tokens. Robust against heredoc, $(), nested quotes — we don't try to find the
  // matching close quote (that requires a real shell tokenizer; out of scope per AD-6).

isPrCreateBashCommand(cmd):
  return /\bgh\s+pr\s+create\b/.test(cmd)

isPrCreateMcpTool(toolName):
  return toolName === 'mcp__github__create_pull_request'

extractIssueNumber(url):
  match = /\/issues\/(\d+)(?:[/?#]|$)/.exec(url)
  return match ? parseInt(match[1], 10) : null
```

### Contract tests (`src/hooks/pr-issue-guard.test.ts` — NEW, 19 tests)

Following `todo-guard.test.ts` style: small synchronous tests, fixture factory.

**Tool shape / non-targets (3)**:
| # | Test | Input | Expected |
|---|------|-------|----------|
| T1.1 | non-PR-create tool passes | toolName='Read' | blocked=false |
| T1.2 | Bash but non-PR command passes | command='git status' | blocked=false |
| T1.3 | mcp__github__list_issues passes | toolName='mcp__github__list_issues' | blocked=false |

**Bash sourceIssueUrl path (5)**:
| # | Test | Input | Expected |
|---|------|-------|----------|
| T1.4 | sourceIssueUrl + body has Closes #N → pass | `command='gh pr create --body "Closes #696"'`, sourceIssueUrl=...issues/696 | blocked=false |
| T1.5 | sourceIssueUrl + body in heredoc with Closes #N → pass | `command='gh pr create --body "$(cat <<EOF\\nCloses #696\\nEOF)"'`, sourceIssueUrl=...issues/696 | blocked=false |
| T1.6 | sourceIssueUrl + no body flag → block (missing-closes-issue) | `command='gh pr create --title x'`, sourceIssueUrl=...issues/696 | blocked=true, reason='missing-closes-issue' |
| T1.7 | sourceIssueUrl + body but no Closes → block | `command='gh pr create --body "fixes the thing"'`, sourceIssueUrl=...issues/696 | blocked=true, reason='missing-closes-issue' |
| T1.8 | sourceIssueUrl + body has WRONG issue # → block (wrong-issue-number) | `command='gh pr create --body "Closes #999"'`, sourceIssueUrl=...issues/696 | blocked=true, reason='wrong-issue-number' |

**Bash adversarial / codex-flagged (4)**:
| # | Test | Input | Expected |
|---|------|-------|----------|
| T1.9 | marker only in --title → block | `command='gh pr create --title "Closes #696" --body "x"'`, sourceIssueUrl=...issues/696 | blocked=true (--body content is `"x"`) |
| T1.10 | marker in unrelated chained command → block | `command='echo "Closes #696" && gh pr create --title x'`, sourceIssueUrl=...issues/696 | blocked=true (no `--body` flag in gh segment) |
| T1.11 | marker in shell var assignment, body uses different var → block | `command='BODY="Closes #696"; gh pr create --body "$OTHER"'`, sourceIssueUrl=...issues/696 | blocked=true (marker is BEFORE gh segment; "$OTHER" after --body has no Closes) |
| T1.17 | **--body in echo BEFORE gh segment → block** (codex v2.1 must-fix) | `command='echo "--body Closes #696" && gh pr create --body "x"'`, sourceIssueUrl=...issues/696 | blocked=true (gh-anchor skips the first --body in echo; gh's --body content is `"x"`) |

**Bash escapeEligible path (3)**:
| # | Test | Input | Expected |
|---|------|-------|----------|
| T1.12 | escapeEligible + body has Case A escape → pass | `command='gh pr create --body "Case A escape (tier=tiny, no issue by policy)"'`, escapeEligible=true | blocked=false |
| T1.13 | escapeEligible + body missing marker → block | `command='gh pr create --body "did stuff"'`, escapeEligible=true | blocked=true, reason='missing-escape-marker' |
| T1.14 | **escapeEligible=false + escape marker attempted → block** (issue-body acceptance #2) | `command='gh pr create --body "Case A escape (tier=tiny)"'`, sourceIssueUrl=null, escapeEligible=false | blocked=true, reason='no-issue-no-escape' (precedence: escape path NOT activated when escapeEligible=false, even with marker) |

**MCP path (3)**:
| # | Test | Input | Expected |
|---|------|-------|----------|
| T1.15 | MCP create_pull_request with Closes #N in body → pass | toolName='mcp__github__create_pull_request', toolInput.body='Closes #696', sourceIssueUrl=...issues/696 | blocked=false |
| T1.18 | MCP wrong issue number → block | toolName='mcp__github__create_pull_request', toolInput.body='Closes #999', sourceIssueUrl=...issues/696 | blocked=true, reason='wrong-issue-number' |
| T1.19 | MCP escapeEligible + missing escape marker → block | toolName='mcp__github__create_pull_request', toolInput.body='did stuff', sourceIssueUrl=null, escapeEligible=true | blocked=true, reason='missing-escape-marker' |

**Precedence (1)**:
| # | Test | Input | Expected |
|---|------|-------|----------|
| T1.16 | mixed metadata: sourceIssueUrl AND escapeEligible=true — issue path wins | `command='gh pr create --body "Case A escape"'`, sourceIssueUrl=...issues/696, escapeEligible=true | blocked=true, reason='missing-closes-issue' (precedence: issue path required even when escape also set) |

**Test fixture** (mirror `session-registry-handoff.test.ts:20-32`):
```typescript
function makeContext(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    handoffKind: 'plan-to-work',
    sourceIssueUrl: null,
    parentEpicUrl: null,
    escapeEligible: false,
    tier: null,
    issueRequiredByUser: true,
    chainId: 'test-chain-id',
    hopBudget: 1,
    ...overrides,
  };
}
```

### Done

- All 19 tests green.
- `tsc --noEmit` clean.
- No mutation of input or context (pure function).
- Block messages contain reason code + handoffContext snapshot + actionable fix steps (AD-7).

---

## S2 — Wire Two PreToolUse Hooks into `claude-handler.ts`

### Trigger

Spec AD-1 + AD-3 + AD-4: register the guard as two new entries in the existing `preToolUseHooks` array. Pattern mirrors SSH-restriction (`:728-754`), sensitive-path (`:783-801`), and MCP-permission (`:919-948`) hooks.

### Callstack

1. `src/claude-handler.ts:1-30` — add import:
   ```typescript
   import { handlePrIssuePrecondition } from './hooks/pr-issue-guard';
   ```

2. `src/claude-handler.ts:909-947` (after the existing MCP-permission hook block, before `:951` `if (preToolUseHooks.length > 0)`):
   ```typescript
   // ── PR-issue precondition (#696) ──
   // For sessions started via z handoff, require a linked issue (or validated escape)
   // before allowing PR creation. Activates only when session.handoffContext is set.
   const makePrIssueHook =
     (matcherKind: 'bash' | 'mcp') =>
     async (input: HookInput): Promise<HookJSONOutput> => {
       const session = this.sessionRegistry.getSession(slackContext.channel, slackContext.threadTs);
       if (!session) {
         this.logger.info('PR-issue guard skipped: no session', {
           channel: slackContext.channel,
           threadTs: slackContext.threadTs,
         });
         return { continue: true };
       }
       if (!session.handoffContext) {
         this.logger.info('PR-issue guard skipped: non-handoff session', {
           channel: slackContext.channel,
           threadTs: slackContext.threadTs,
           ownerName: session.ownerName,
         });
         return { continue: true };
       }
       const toolName = (input as { tool_name?: string }).tool_name || '';
       const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input;

       // MCP matcher fires for ALL mcp__* tools — filter to create_pull_request only
       if (matcherKind === 'mcp' && toolName !== 'mcp__github__create_pull_request') {
         return { continue: true };
       }

       const result = handlePrIssuePrecondition({
         toolName,
         toolInput,
         handoffContext: session.handoffContext,
       });

       if (result.blocked) {
         this.logger.warn('PR creation blocked by handoff precondition', {
           channel: slackContext.channel,
           threadTs: slackContext.threadTs,
           tool: toolName,
           reason: result.reason,
           chainId: session.handoffContext.chainId,
         });
         return {
           hookSpecificOutput: {
             hookEventName: 'PreToolUse',
             permissionDecision: 'deny',
             permissionDecisionReason: result.message,
           },
         };
       }
       return { continue: true };
     };

   preToolUseHooks.push(
     { matcher: 'Bash', hooks: [makePrIssueHook('bash')] },
     { matcher: 'mcp__', hooks: [makePrIssueHook('mcp')] },
   );
   ```

3. **Why two `push` entries vs one with `matcher: 'Bash|mcp__'`**: SDK matcher is a single string, not a regex alternation. Two entries match the existing pattern (e.g., `:783-801` registers separate Bash + Read entries).

### Contract tests (extend `src/claude-handler.test.ts` or new `src/claude-handler-pr-guard.test.ts`)

Mirror existing in-process hook tests.

| # | Test | Setup | Input | Expected |
|---|------|-------|-------|----------|
| T2.1 | Bash gh pr create with no-issue handoffContext denied + reason set | Session with `handoffContext={sourceIssueUrl:null, escapeEligible:false, ...}` | PreToolUse Bash, command='gh pr create --title x' | hook returns `permissionDecision='deny'`, `permissionDecisionReason` contains 'no-issue-no-escape' and chainId |
| T2.2 | MCP create_pull_request with no-issue handoffContext denied | Same handoffContext | PreToolUse mcp__github__create_pull_request, body='just stuff' | hook returns deny with reason |
| T2.3 | **bypass mode + no-issue handoff → still denied** (codex v2.1 must-fix) | `userBypass=true` (which installs bypass-mode Bash hook at `:865-907`) AND handoffContext as in T2.1 | PreToolUse Bash, command='gh pr create --title x' | Per SDK precedence (`deny > allow`), our hook's `deny` wins over bypass hook's `allow`. Final aggregated outcome = denied. |

Existing `claude-handler.test.ts` tests (SSH guard, sensitive path, MCP permission) must remain green. If `claude-handler.test.ts` does not exist or doesn't already exercise hook returns, the L2 tests can be added to a sibling test file (`src/claude-handler-hooks.test.ts`) — the implementer chooses based on existing structure (see `src/slack/__tests__/` and `src/agent-session/__tests__/` for similar test fixtures of `slackContext`-bearing functions).

### Done

- `tsc --noEmit` clean.
- All 3 new integration tests green (T2.1 Bash, T2.2 MCP, T2.3 bypass-precedence).
- All existing `claude-handler.ts` hook tests still green.
- Two `preToolUseHooks.push(...)` calls visible at the right insertion point.

---

## S3 — Defense-in-Depth Prompt Prose Flips

### Trigger

Spec AD-11: keep producer-side prompts honest. Once host enforcement ships, four prompt locations must reflect the new state.

### Changes (doc-only)

**`src/local/skills/zwork/SKILL.md:38-41`** (PR creation precondition + add inline-body discipline rule):

The existing line 38 about Issue URL precondition stays. Replace line 40 + 41:
- BEFORE (line 40): `   - PR body MUST include` `Closes #<issue>` `for Case A/B, or an explicit` `Case A escape (tier=tiny|small, no issue by policy)` `note when the qualified escape marker is used.`
- BEFORE (line 41): `   - *(Currently a prompt-level contract; host-side guard is tracked in the Handoff Enforcement epic — see` `local:using-z` `§Enforcement Status.)*`
- AFTER (line 40): `   - PR body MUST include` `Closes #<issue>` `for Case A/B, or an explicit` `Case A escape (tier=tiny|small, no issue by policy)` `note when the qualified escape marker is used. **Inline only** — body must be passed as inline content to` `--body` `(literal string or heredoc). Shell variable indirection (` `--body "$VAR"` `) is host-rejected because the static check cannot see the runtime value.`
- AFTER (line 41): `   - *(Host-enforced via in-process SDK PreToolUse hook —` `src/hooks/pr-issue-guard.ts` `wired through` `src/claude-handler.ts` `(#696). Bash` `gh pr create` `and MCP` `mcp__github__create_pull_request` `both covered. This prompt rule remains as defense-in-depth.)*`

**`src/local/skills/using-z/SKILL.md:38`**:
- BEFORE: `> **아래 규칙은 현재 prompt-level contract이며 host가 아직 강제하지 않는다.** 실제 host-side 강제는 §Enforcement Status 하단 에픽에서 구현 중. 이 섹션은 계약을 정의할 뿐이며, 위반 시 host가 막아주지 않는다 — 모델이 스스로 따라야 한다.`
- AFTER: `> **아래 규칙은 host-side와 prompt-side 양층 강제다.** Sentinel routing은 #695, PR-issue precondition은 #696으로 host가 강제 (in-process SDK PreToolUse hook). 나머지(예산/safe-stop)는 #697/#698 후속 — §Enforcement Status 참고.`

**`src/local/skills/using-z/SKILL.md:65`**:
- BEFORE: `이것이 "이슈 없이 PR" 우회 경로의 **구조적 차단선**. (현재는 prompt-level contract — host-side 강제는 §Enforcement Status 참고.)`
- AFTER: `이것이 "이슈 없이 PR" 우회 경로의 **구조적 차단선**. (Host-side 강제 = #696 —` `src/hooks/pr-issue-guard.ts` `via` `src/claude-handler.ts` `in-process PreToolUse hook. Prompt 계약은 defense-in-depth.)`

**`src/local/skills/using-z/SKILL.md:156`** (Enforcement Status table row):
- BEFORE: `| Handoff #1 전 Issue URL 검증 | prompt convention (모델 규율) |` `zwork` `/ PR 생성 경로 host-side guard (#696) |`
- AFTER: `| Handoff #1 전 Issue URL 검증 | **구현 완료 (#696)** —` `src/hooks/pr-issue-guard.ts` `via in-process SDK PreToolUse hook (Bash + MCP) + prompt 계약 (defense-in-depth) | — |`

**`src/local/skills/using-z/SKILL.md:162`**:
- BEFORE: `**이 스킬 문서는 핸드오프 계약을 정의한다. host-side 강제 코드는 에픽 #694 (Case B) 에서 구현 중** — #695 (결정적 진입 + typed metadata) 완료. PR precondition (#696), hop budget 소비 (#697), dispatch safe-stop 일반화 (#698) 후속 진행.`
- AFTER: `**이 스킬 문서는 핸드오프 계약을 정의한다. host-side 강제 코드는 에픽 #694 (Case B) 에서 구현 중** — #695 (결정적 진입 + typed metadata), #696 (PR precondition) 완료. Hop budget 소비 (#697), dispatch safe-stop 일반화 (#698) 후속 진행.`

### Verification (no tests — doc-only)

- `grep -n 'prompt-level contract' src/local/skills/zwork/SKILL.md src/local/skills/using-z/SKILL.md` returns 0 matches.
- `grep -n 'pr-issue-guard.ts' src/local/skills/zwork/SKILL.md src/local/skills/using-z/SKILL.md` returns ≥3 matches.
- `grep -n '구현 완료 (#696)' src/local/skills/using-z/SKILL.md` returns 1 match (Enforcement Status table).

---

## Wiring Checklist

(every file the implementer must touch — derived from v2 file manifest)

### Source files

| File | Lines | Change |
|---|---|---|
| `src/hooks/pr-issue-guard.ts` | new file (~150 lines) | Pure guard module per S1 algorithm |
| `src/claude-handler.ts` | new import `~:30` + 2 hook `push` calls inserted at `~:949` (after MCP-permission block, before `if (preToolUseHooks.length > 0)`) | Per S2 wiring |
| `src/local/skills/zwork/SKILL.md` | lines 40-41 | Defense-in-depth prose flip + inline-body rule (S3) |
| `src/local/skills/using-z/SKILL.md` | lines 38, 65, 156, 162 | Defense-in-depth prose flips (S3 — 4 locations) |

### Test files

| File | Status | New tests |
|---|---|---|
| `src/hooks/pr-issue-guard.test.ts` | NEW | 19 (S1 contract matrix) |
| `src/claude-handler.test.ts` (or `src/claude-handler-pr-guard.test.ts` if structurally cleaner) | EXTEND or NEW | +3 (S2 integration: Bash, MCP, bypass-precedence) |

Total new tests: 22.

### Pre-impl checks

- [x] Verified `claude-handler.ts:701-955` already wires PreToolUse hooks via SDK programmatic `options.hooks.PreToolUse` — this is the seam.
- [x] Confirmed `permissionDecisionReason` is the SDK field that surfaces blocking message to the model (verified against locked `@anthropic-ai/claude-agent-sdk@0.2.111` `PreToolUseHookSpecificOutput` at `sdk.d.ts:1907`).
- [x] Confirmed multi-hook precedence is `deny > defer > ask > allow > undefined` (verified against `cli.js:8208-8240` runtime). Appending after bypass hook is safe.
- [x] Confirmed `HandoffContext` is re-exported from `src/types.ts:5,40,186`. Guard imports via `./types` per repo convention.
- [x] Confirmed `slackContext`, `this.sessionRegistry`, `this.logger` are all in scope at the hook insertion point (lexical closure in `buildOptions`).
- [ ] `tsc --noEmit` baseline before any changes.
- [ ] Run existing `claude-handler.test.ts` to capture baseline pass count.

### Post-impl checks

- [ ] All 19 + 3 = 22 new tests green.
- [ ] All existing tests in `claude-handler.test.ts` still green (regression baseline).
- [ ] `tsc --noEmit` clean.
- [ ] `grep -n 'prompt-level contract' src/local/skills/{zwork,using-z}/SKILL.md` returns 0.
- [ ] `grep -n 'pr-issue-guard.ts' src/local/skills/{zwork,using-z}/SKILL.md` returns ≥3 matches.
- [ ] Manual smoke (post-merge to dev): trigger a no-issue handoff session attempting `gh pr create` → confirm SDK surfaces the actionable block message to the model (visible in tool-result), and the structured `warn` log appears.

---

## Auto-Decisions

(decided autonomously per Decision Gate — all ≤ small switching cost)

| Decision | Tier | Rationale |
|---|---|---|
| Test file naming `pr-issue-guard.test.ts` (not `.spec.ts`) | tiny | Existing convention — `todo-guard.test.ts`, `index.test.ts` |
| `extractBashBodyContent` returns whole remainder, not parsed value | small | Robust to heredoc/quoting; perfect parsing requires shell tokenizer (out of scope per AD-6) |
| `Closes #N` regex case-insensitive | tiny | Real PRs use `Closes #N`, `closes #N`, `CLOSES #N` interchangeably |
| `Case A escape` marker case-sensitive | tiny | Producer marker is fixed by zwork SKILL — case sensitivity narrows the match without restricting practical inputs |
| Distinguish `wrong-issue-number` vs `missing-closes-issue` reason codes | small | More actionable messages for the model — wrong number is a typo, missing entirely means structural omission |
| Two separate `preToolUseHooks.push` entries (Bash + mcp__) | tiny | SDK matcher is single string; mirrors existing pattern (`:783-801` Bash + Read split) |
| `info` log on fail-open paths (no-session, non-handoff) vs silent | small | Codex must-fix #2: silent fail-open hides enforcement disable; structured logs make it observable without noise |
| `warn` log on actual block | tiny | Operator visibility for the rare "host blocked PR creation" event |
| Skip wrapper / alias detection (`gh-pr-create`) | small | Out of scope per spec; current zwork uses raw `gh pr create` |
| Append (not prepend) hooks in `preToolUseHooks` array | tiny | Order doesn't matter (any deny short-circuits); appending preserves all existing semantics |

## Implementation Status

| Scenario | Trace | Tests (RED) | Status |
|---|---|---|---|
| S1. `pr-issue-guard.ts` pure module + branch matrix | done | RED (19) | Ready for stv:work |
| S2. Wire two PreToolUse hooks into `claude-handler.ts` | done | RED (3) | Ready for stv:work |
| S3. Defense-in-depth prompt prose flips | done | doc-only | Ready for stv:work |

## Changelog

- **v1** (2026-04-24): initial trace targeting external Fastify hook proxy. Codex review 71/100 flagged wrong seam, weak marker check, missing acceptance test, missed MCP path.
- **v2** (2026-04-24): full rewrite — moved seam to in-process SDK PreToolUse hook in `claude-handler.ts`; eliminated provider singleton + reverse-lookup helper; body-aware marker check ("AFTER `--body` flag"); added MCP `create_pull_request` matcher; added codex-flagged tests (escape marker without escapeEligible flag, mixed metadata precedence, marker-only-in-title); structured logging for fail-open paths.
- **v2.1** (2026-04-24): codex re-review (86/100) addressed:
  - `extractBashBodyContent` now anchors to `gh pr create` segment FIRST (defeats `echo "--body Closes #696" && gh pr create --body "x"`).
  - SDK precedence (`deny > allow`) documented + integration test T2.3 added.
  - SDK version corrected 0.2.119 → 0.2.111 (matches lockfile).
  - Variable-substitution false-block class documented in zwork SKILL prose flip (inline-body discipline).
  - Test matrix expanded: T1.17 (--body in echo before gh), T1.18 (MCP wrong-number), T1.19 (MCP missing escape marker), T2.3 (bypass-precedence).

## Next Step

→ `local:zwork` to implement S1-S3 in order. RED tests fail at start; GREEN after each scenario lands.
