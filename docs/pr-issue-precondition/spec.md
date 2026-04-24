# PR Issue-Link Precondition (Host-Side)

> Issue #696 · Part of epic #694 · Consumes typed `HandoffContext` delivered by #695 (PR #703)
>
> **Spec revision history**: v1 (initial, 71/100 codex score) chose the wrong seam — the external
> Fastify hook proxy. Codex flagged that `claude-handler.ts` already houses an **in-process SDK
> `PreToolUse` hook system** (lines 701-955) that has direct access to the live session and registry
> without HTTP plumbing or session-id reverse lookup. This v2 revision moves to that seam, hardens
> the body-marker check against title-substring adversarial inputs, adds MCP PR-creation coverage,
> replaces silent fail-open with structured logging, and expands the test matrix.

## Why

PR #703 (#695) added `session.handoffContext` to `ConversationSession` with three producer-authoritative fields — `sourceIssueUrl`, `escapeEligible`, `issueRequiredByUser` — but **nothing consumes them at PR creation time**. The contract is still prompt-only: zwork's SKILL.md asks the model to honor it, but if the model violates the rule, an orphan PR is still possible.

Two structural gaps:

1. **No host-side check before `gh pr create`.** The model invokes the GitHub API directly via the Bash tool. Once the HTTP call fires, the orphan PR exists; PostToolUse rejection is too late.
2. **Seeded metadata sits unused.** `escapeEligible=false` is the conservative default — yet today nothing validates the `(channel, threadTs)` session has a matching contract before the GitHub call goes out.

This subissue closes the gap at the cleanest available host seam: the **in-process SDK PreToolUse hook** that `ClaudeHandler` already wires for SSH-restriction, sensitive-path-restriction, abort-after-deny, and MCP-permission enforcement (`src/claude-handler.ts:701-955`).

## What

1. New pure guard module `src/hooks/pr-issue-guard.ts` exporting `handlePrIssuePrecondition(toolName, toolInput, handoffContext)` returning `{ blocked, reason?, message? }`.
2. Wire guard into `ClaudeHandler.buildOptions` `preToolUseHooks` array (`src/claude-handler.ts:701-955`) — same pattern as existing SSH/sensitive-path/MCP-permission hooks. The hook closure already has access to `slackContext`, `this.sessionRegistry`, and `slackContext.{channel,threadTs}` — no provider singleton or registry lookup helper needed.
3. Two matchers: `Bash` (for `gh pr create` shell invocation) and `mcp__github__create_pull_request` (for the MCP-tool path that also exists in the codebase).
4. Tests in two layers: pure guard branch matrix (~16 tests covering both Bash and MCP paths + adversarial cases), claude-handler integration (1 new test confirming the hook is registered + denies via SDK).
5. Defense-in-depth: flip prompt prose in `zwork/SKILL.md` and `using-z/SKILL.md` from "prompt-level contract" to "host-enforced via #696".

## Success Signal

- Session with `handoffContext.sourceIssueUrl=null` AND `escapeEligible=false` → `gh pr create` denied via SDK `permissionDecision: 'deny'`, model sees `permissionDecisionReason` text and can self-correct.
- Session with `handoffContext.sourceIssueUrl="...issues/123"` + PR body containing `Closes #123` → passes.
- Session with `handoffContext.escapeEligible=true` + PR body containing `Case A escape` marker → passes.
- Session with `handoffContext.sourceIssueUrl="...issues/123"` + PR body MISSING `Closes #123` (or wrong number, or marker only in title) → blocked.
- Session with `handoffContext.escapeEligible=true` BUT `escapeEligible=false` AND attempt at escape path → blocked (acceptance criterion #2 from issue body).
- Session with NO `handoffContext` (legacy / non-z workflow) → passes (out of scope per #696; future work) **AND** logs a structured `info` event for visibility.
- Same protection applies to `mcp__github__create_pull_request` MCP calls.
- TodoGuard's behavior unchanged. All existing PreToolUse hooks unaffected.

## Architecture Decisions

### AD-1: Seam — in-process SDK `PreToolUse` hook in `ClaudeHandler` (NOT external Fastify route)

**Why this seam, NOT the Fastify hook proxy**:
- `claude-handler.ts:701-955` already builds an array `preToolUseHooks: Array<{matcher, hooks}>` and wires it into the SDK `query()` `options.hooks.PreToolUse` (`:951-955`). This array currently houses 4 guards: abort, SSH-restriction, sensitive-path-restriction (Bash + Read variants), MCP-permission. Adding a 5th matches established pattern.
- The hook closure has direct access to `this.sessionRegistry`, `this.logger`, and `slackContext.{channel, threadTs, user}` — no HTTP roundtrip, no SDK-session-id-to-Slack-thread reverse lookup, no provider singleton.
- The SDK contract `permissionDecision: 'deny'` + `permissionDecisionReason: '<actionable message>'` surfaces the message DIRECTLY to the model (verified against `@anthropic-ai/claude-agent-sdk@0.2.111`'s `PreToolUseHookSpecificOutput` type at `sdk.d.ts:1907` — this repo's locked version per `package-lock.json:47-50`. Field has existed since v0.2.85 per CHANGELOG). No `hook-proxy.sh` 403/stderr plumbing needed.

**v1 plan (rejected)**: external Fastify route at `src/hooks/index.ts:26-49`. That route exists for filesystem hooks loaded via `.claude/settings.json` → `hook-proxy.sh` HTTP — a different path, NOT what the SDK invokes for `query()` programmatic hooks. Mixing the two layers led to the v1 spec needing a `session-registry-provider.ts` singleton bridge that codex correctly identified as an unsafe silent-fail-open vector.

**Hook return shape** (verified against `sdk.d.ts` `PreToolUseHookSpecificOutput`):
```typescript
return {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: '<actionable structured message — see AD-7>',
  },
};
```

**Alternatives rejected**:
- SDK `canUseTool` callback: not currently wired in this codebase; would require new infra. The in-process hook achieves the same result with the existing pattern.
- PostToolUse rejection: too late, PR already created.

### AD-2: Guard is a pure function with explicit `handoffContext` argument (NOT injected lookup)

**Why pure-function over injected-lookup**:
- The hook closure already resolves `session.handoffContext` from `this.sessionRegistry.getSession(slackContext.channel, slackContext.threadTs)` — straightforward, no lookup-by-SDK-id needed.
- Pure function `(toolName, toolInput, handoffContext) → result` is trivially unit-testable and the reduced surface (no session indirection) avoids the v1 silent-fail-open trap.
- The hook itself decides whether to even call the guard: if `session?.handoffContext` is undefined → log info + skip (this preserves AD-4 activation predicate while keeping it OUTSIDE the pure guard).

```typescript
// src/hooks/pr-issue-guard.ts
export interface PrIssueGuardInput {
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  handoffContext: HandoffContext;   // REQUIRED — caller asserts it exists
}

export type GuardReason =
  | 'no-issue-no-escape'
  | 'missing-closes-issue'
  | 'wrong-issue-number'
  | 'missing-escape-marker'
  | 'malformed-source-issue-url'
  | 'unknown-tool-shape';   // defensive — toolInput missing fields

export interface PrIssueGuardResult {
  blocked: boolean;
  reason?: GuardReason;
  message?: string;   // formatted per AD-7; included only when blocked
}

export function handlePrIssuePrecondition(input: PrIssueGuardInput): PrIssueGuardResult;
```

### AD-3: Two tool matchers — Bash + MCP `create_pull_request`

**Why two matchers**:
- `Bash` covers the canonical zwork path: `gh pr create --body "..."`.
- `mcp__github__create_pull_request` is referenced in the codebase (`src/prompt/workflows/jira-create-pr.prompt:74`) and is a structurally cleaner PR-creation channel; not currently the dominant path but reachable in the future. Covering it now = single-PR completeness rather than a follow-up #696.5.

**Matcher granularity** in `claude-handler.ts`:
- Bash matcher: same pattern as existing SSH/sensitive-path hooks — `matcher: 'Bash'`.
- MCP matcher: same pattern as existing MCP-permission hook (`:921` `matcher: 'mcp__'`), but the guard inspects `toolName === 'mcp__github__create_pull_request'` to filter precisely (avoids interfering with other `mcp__*` tools).

The `pr-issue-guard.ts` module is the same for both — the hook callbacks only differ in their matcher string and how they extract the body content (see AD-6).

### AD-4: Activation predicate — only z-controlled handoff sessions, with structured logging

**Why scope to z-handoff sessions**: Issue #696 scope is "enforce the seeded metadata", NOT "extend coverage to all sessions". Sessions without `handoffContext` (legacy slack chat, non-z workflows, manual debugging) never had this contract. Blocking them would break user-facing flows.

**The fail-open paths** (with mandatory `info` log to make silent disable visible):

| Predicate | Outcome | Log |
|---|---|---|
| `session === undefined` (no session for channel/threadTs) | allow | `info` `'PR-issue guard skipped: no session'` with `{channel, threadTs}` |
| `session.handoffContext === undefined` (legacy/non-handoff) | allow | `info` `'PR-issue guard skipped: non-handoff session'` with `{channel, threadTs, ownerName}` |
| `toolInput` missing/non-object | allow + `warn` | `warn` `'PR-issue guard skipped: malformed toolInput'` |

**Codex's must-fix #2 addressed**: AD-8 in v1 had silent fail-open on lookup throws / provider-unset / etc. v2 eliminates the lookup entirely (no provider, no reverse-index) AND emits a structured log for every fail-open path so disable is observable.

### AD-5: Bash command match — anchored regex `\bgh\s+pr\s+create\b`

**Pattern**: `/\bgh\s+pr\s+create\b/`

Match anywhere in the command string because real-world PR-create commands are wrapped in heredocs / `&&` chains / shell substitutions. Word boundaries prevent `gh pr create-foo` / `xgh pr create` false matches. Case-sensitive (gh CLI is lowercase).

**Out of scope**: aliases / wrappers (`gh-pr-create`, custom shell scripts). Current zwork SKILL uses raw `gh pr create`; chasing fictional variants adds attack surface.

### AD-6: Body-aware marker check (NOT whole-command substring)

**Codex's must-fix #3 addressed**: v1 used whole-command `cmd.includes('Closes #N')` which false-passes:
- `gh pr create --title "Closes #696"` (marker in title, no body)
- `echo "Case A escape" && gh pr create --title x` (marker in unrelated command)
- `BODY="Closes #696"; gh pr create --body "$OTHER"` (marker in shell var assignment)

**v2.1 algorithm — "anchor to `gh pr create`, then marker must appear AFTER `--body` / `-b` flag"**:
```typescript
function extractBashBodyContent(cmd: string): string | null {
  // Step 1: anchor to the gh pr create segment so a stray --body in an unrelated
  // earlier command (e.g., `echo "--body Closes #696" && gh pr create --body "x"`)
  // doesn't false-pass.
  const ghMatch = /\bgh\s+pr\s+create\b/.exec(cmd);
  if (!ghMatch) return null;
  const tail = cmd.slice(ghMatch.index + ghMatch[0].length);
  // Step 2: locate first --body / -b / --body-file flag in the gh pr create segment
  const flagMatch = /(?:--body(?:-file)?|-b)(?:\s|=)/.exec(tail);
  if (!flagMatch) return null;
  return tail.slice(flagMatch.index + flagMatch[0].length);
}
```

This handles all four adversarial classes:
| Adversarial input | Decision | Reason |
|---|---|---|
| `gh pr create --title "Closes #696"` | block | no `--body` flag in gh segment |
| `echo "Closes #696" && gh pr create --title x` | block | no `--body` flag in gh segment |
| `BODY="Closes #696"; gh pr create --body "$OTHER"` | block | marker is BEFORE gh segment, body content is `"$OTHER"` (no marker) |
| `echo "--body Closes #696" && gh pr create --body "x"` | block | first `--body` in echo skipped by gh anchor; gh's `--body` content is `"x"` |
| `gh pr create --body "Closes #696"` | pass | marker after `--body` in gh segment |
| `gh pr create --body "$(cat <<'EOF'\nCloses #696\nEOF\n)"` | pass | marker after `--body` in gh segment (in heredoc body) |
| `gh pr create --title "x" --body "Case A escape"` | pass | marker after `--body` in gh segment |

**Known false-block class** (documented constraint, NOT blocking):
- `MSG='Closes #696'; gh pr create --body "$MSG"` — runtime body is valid but our static check sees `"$MSG"`, no literal marker → block. **Mitigation**: zwork SKILL is updated (S3 prose flip) to require inline `--body` content (heredoc or literal), not shell variable indirection. Producer-side discipline; host-side check stays simple.
- `--body-file foo.md` — same reason; not used by current zwork; deferred.

**Known soft edge** (acknowledged out of scope):
- `gh pr create --body "x" && do-something Closes #696` — marker after `--body` but in chained command after gh segment. Defeating this requires shell tokenization to find the matching close-quote of `--body` arg. Current zwork-generated commands never use this form; out of scope.

**Markers**:
- For `sourceIssueUrl` path: `new RegExp(\`\\bcloses\\s+#${issueNumber}\\b\`, 'i')` — case-insensitive, exact issue number.
- For `escapeEligible` path: `/Case A escape/` — case-sensitive (producer marker is fixed by zwork SKILL).

**Issue number extraction**: `/\/issues\/(\d+)(?:[/?#]|$)/` from `sourceIssueUrl`.

### AD-6.5: MCP `create_pull_request` body extraction

**Path**: `mcp__github__create_pull_request` MCP tool has structured input — `toolInput.body` is a string field, not a shell command. No regex needed.

```typescript
// Inside the guard, when toolName === 'mcp__github__create_pull_request':
const body = typeof input.toolInput?.body === 'string' ? input.toolInput.body : '';
const titleAndBody = body;   // marker check on body only — title is separate field, doesn't count
```

The marker check then runs against `body` directly (no `markerAppearsAfterBodyFlag` needed — body IS the body).

### AD-7: Block message format — actionable + structured

Single message includes:
- 🚫 violation header
- Tool name + reason code (matches `GuardReason` enum)
- Current `handoffContext` snapshot (4 fields)
- Concrete fix steps

Example for `no-issue-no-escape`:
```
🚫 PR creation blocked: handoff session lacks linked-issue evidence.

Tool: Bash (gh pr create)
Reason: no-issue-no-escape

handoffContext:
  sourceIssueUrl: null
  escapeEligible: false
  issueRequiredByUser: true
  chainId: 8f3a2c1e-...

Cause: this session was started via z handoff but has neither a source issue
URL nor a validated Case A escape eligible flag. Per `local:using-z` §Session
Handoff Protocol, PRs must close a linked issue.

Fix:
  1. If this work belongs to an issue, restart the workflow from `$z <issue_url>`.
  2. If this is genuinely tier=tiny|small with no policy requirement, the
     handoff producer must emit `## Escape Eligible: true` (3-condition validated)
     AND the PR body must include `Case A escape (tier=tiny|small, no issue by policy)`.
```

This text is set as `permissionDecisionReason` so the model sees it directly in its tool-result and can self-correct without re-asking the user.

### AD-8: Precedence — `sourceIssueUrl` wins over `escapeEligible`

**Why**: A handoff that has BOTH `sourceIssueUrl` set AND `escapeEligible=true` is a producer-side bug — the issue is the authoritative truth, escape is the fallback for "no issue available". Treating them as additive would let a malformed handoff bypass the issue-link check by also setting escape.

**Algorithm precedence** (mirrors v1 AD-6 but now explicit):
```
if ctx.sourceIssueUrl !== null:
  → require Closes #N matching extracted issue number, after --body flag
else if ctx.escapeEligible === true:
  → require "Case A escape" marker, after --body flag
else:
  → block with no-issue-no-escape
```

### AD-9: Wire ordering in `claude-handler.ts` — appending is safe

The new hook is appended to the existing `preToolUseHooks` array. SDK runs ALL matching hooks (no short-circuit) and applies a precedence lattice: **`deny > defer > ask > allow > undefined`**. A later `deny` wins over an earlier `allow`, and vice versa.

Verified against `@anthropic-ai/claude-agent-sdk@0.2.111` runtime (`cli.js:8208-8240` — see librarian audit). Pseudocode:
```js
let B; for await (let S of hooks) {
  if (S.permissionBehavior) switch (S.permissionBehavior) {
    case "deny":   B = "deny"; break;
    case "defer":  if (B !== "deny") B = "defer"; break;
    case "ask":    if (B !== "deny" && B !== "defer") B = "ask"; break;
    case "allow":  if (!B) B = "allow"; break;
  }
}
```

Order in the wired array (after this change):
1. Abort guard (`:707-724`)
2. SSH restriction (`:728-754`)
3. Sensitive-path Bash (`:783-801`), Read (`:794-801`)
4. Other existing hooks (`:803-907`)
5. **Bypass-mode Bash (`:865-907`)** — returns `'allow'` for non-dangerous commands. `gh pr create` is non-dangerous, so this WOULD return allow if it ran alone.
6. MCP permission (`:909-947`)
7. **NEW: PR-issue precondition (Bash)** — handoff sessions only, returns `deny` when violation.
8. **NEW: PR-issue precondition (MCP)** — handoff sessions only.

**Why appending is safe even with bypass-mode allow earlier**: Per the SDK precedence lattice, the new hook's `deny` overrides the bypass hook's `allow` regardless of order. Integration test T2.3 explicitly asserts this (bypass mode + handoff session + no-issue command → still denied).

### AD-10: Test layering

| Layer | File | Purpose | New tests |
|---|---|---|---|
| L1 | `src/hooks/pr-issue-guard.test.ts` | Pure-function branch matrix + adversarial inputs | ~19 |
| L2 | `src/claude-handler.ts` integration | Hook is registered + invokes guard + returns SDK shape + bypass-mode interaction | 3 (1 Bash, 1 MCP, 1 bypass-precedence) |

L1 covers the contract surface including codex's edge cases. L2 confirms the hook closure correctly resolves session + handoffContext + returns the right SDK shape.

### AD-11: Prompt prose flips (defense-in-depth — secondary deliverable)

Same as v1 AD-11. Four prompt locations get status flips:
- `src/local/skills/zwork/SKILL.md:41`
- `src/local/skills/using-z/SKILL.md:38, 65, 156, 162`

See trace S5 for exact diffs.

## Out of Scope

- Sessions without `handoffContext` (legacy slack chat, non-z workflows, manual debugging) — separate concern; would need different seeding mechanism. v2 logs every skip for observability.
- Hop budget enforcement — that's #697.
- Dispatch failure safe-stop generalization — that's #698.
- Wrapper / alias detection (`gh-pr-create`, custom shell scripts) — current zwork SKILL uses raw `gh pr create`.
- **Alternate PR-creation transports**: lower-level `gh api repos/.../pulls`, raw `curl` to GitHub REST/GraphQL, `git push --create-pr`, or any future PR-creation tool not matching `Bash gh pr create` / `mcp__github__create_pull_request`. Documented at `docs/how-to-use-git.md:37-53` as legitimate operator paths but NOT routed through zwork; threat model here is prompt drift, not adversarial transport evasion.
- Shell tokenization for adversarial chained commands like `gh pr create --body "x" && do-something Closes #N` — out of scope; defeating accidental violations not adversarial models.
- `--body-file` flag (file-backed body) — current zwork uses inline `--body`. Would require reading the file from the host, adding complexity.
- PR title validation (issue body says "PR body" only).
- Existing PR mutations (`gh pr edit`).
- External Fastify hook route — `src/hooks/index.ts` is filesystem-hook plumbing, not the SDK programmatic hook path. Untouched by this work.

## File Manifest

**New (1)**:
- `src/hooks/pr-issue-guard.ts` — pure guard module (~150 lines)

**Modified (3)**:
- `src/claude-handler.ts` — append two PR-issue hooks to `preToolUseHooks` array (~50 lines)
- `src/local/skills/zwork/SKILL.md` — defense-in-depth prose flip (1 location)
- `src/local/skills/using-z/SKILL.md` — defense-in-depth prose flips (4 locations)

**New tests (1) + extended (1)**:
- `src/hooks/pr-issue-guard.test.ts` — new (~19 unit tests)
- `src/claude-handler.test.ts` (or `src/claude-handler-hooks.test.ts`) — +3 integration tests (1 Bash, 1 MCP, 1 bypass-precedence)

Total: 1 new module, 1 new test file, 4 modified files. Net ~300-400 lines including tests. Fits "medium" tier per `using-epic-tasks`.

## Spec Changelog

- **v1** (2026-04-24): initial spec scoring 71/100 from codex review. Identified gaps:
  - AD-1 chose wrong seam (Fastify route — not the SDK programmatic hook path)
  - Marker check was whole-command substring (false-passes title-only / shell-var inputs)
  - Activation logic had silent fail-open paths (codex must-fix)
  - Missed MCP `create_pull_request` matcher
  - Missed `escapeEligible=false + escape attempt` test from issue acceptance
  - Missed mixed-metadata precedence (sourceIssueUrl + escapeEligible both set)
- **v2.1** (2026-04-24): codex re-review (86/100) addressed:
  - `extractBashBodyContent` now anchors to `gh pr create` segment FIRST, then locates `--body` within it (defeats `echo "--body Closes #696" && gh pr create --body "x"` false-pass).
  - Wire ordering AD-9: documented SDK precedence lattice (`deny > defer > ask > allow`) — appending after bypass hook is safe; deny wins.
  - SDK version corrected from 0.2.119 → 0.2.111 (matches `package-lock.json:47-50`); `permissionDecisionReason` confirmed present in 0.2.111 (`sdk.d.ts:1907`).
  - Variable-substitution false-block class documented in AD-6 + zwork SKILL prose flip enforces inline `--body` discipline.
  - Test matrix expanded to 19 unit + 3 integration (added: T1.17 `--body in echo before gh`, T1.18 MCP wrong-number, T1.19 MCP missing escape marker, T2.3 bypass-precedence).
- **v2** (2026-04-24): full rewrite addressing all 4 must-fixes.
  - Seam moved to in-process SDK PreToolUse hook in `claude-handler.ts:701-955`
  - Eliminated `session-registry-provider.ts` and `findSessionBySdkSessionId` (no longer needed)
  - Body-aware marker check: "marker must appear AFTER `--body` flag"
  - MCP `create_pull_request` matcher added (AD-3)
  - Structured logging for every fail-open path (AD-4)
  - Precedence rule explicit (AD-8)
  - Test matrix expanded to 16 unit + 2 integration; added adversarial cases + escape-attempt-with-flag-false + mixed-metadata precedence

## Next Step

→ `stv:trace` revised to map AD-1 through AD-11 to the new scenario set (S1 guard + S2 wire + S3 prompt flips). RED contract tests sketched per scenario.
