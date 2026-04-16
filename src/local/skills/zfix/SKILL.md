---
name: zfix
description: "Gap analysis between issue spec and PR implementation. Finds missing wiring, dead code, untested paths. Fixes via local:z."
---

# zfix — Feature Spec vs Implementation Gap Analysis & Fix

Verifies that a PR (or set of PRs) fully implements the feature described in an issue.
Traces every scenario through the codebase at callstack depth.
Any gap found is documented, then fixed via `local:z` workflow.

## Trigger

- `$zfix {issue} {PR1} {PR2...}` — issue number/URL + PR numbers/URLs
- `$zfix #497` — issue only (find related PRs from issue body/comments)
- `$zfix #482 #488 #495` — issue + explicit PR list

## Process

### 1. INTAKE — Collect Spec & Implementation

1. **Read the issue**: title + body + all comments. Extract the user's actual intent — what behavior they expect to see working.
2. **Read PR(s)**: body + changed files + full diff. Understand what was actually implemented.
3. **List expected scenarios**: Every user-facing behavior the issue describes. Be exhaustive — include edge cases, error paths, and integration points.

### 2. TRACE — Callstack-Depth Scenario Verification

For each scenario, trace the full execution path through the code:

```
Scenario: "MANAGE_SKILL create"
  → Entry: LLM calls model-command MCP tool "run"
  → Gate 1: MCP tool schema (commandId enum) — ✅ or ❌
  → Gate 2: validator.ts (allowlist + params) — ✅ or ❌  
  → Gate 3: catalog.ts (handler) — ✅ or ❌
  → Gate 4: store wiring (registerXxxStore) — ✅ or ❌
  → Exit: disk write + response
```

**Checklist for new model commands** (common miss pattern):
- [ ] `somalib/model-commands/types.ts` — type added to `ModelCommandId` union
- [ ] `somalib/model-commands/catalog.ts` — handler + schema + descriptor
- [ ] `somalib/model-commands/validator.ts` — allowlist + params validation
- [ ] `mcp-servers/model-command/model-command-mcp-server.ts` — commandId enum
- [ ] Entry point wiring (src/index.ts + mcp-servers constructor)

**Checklist for new handlers/commands**:
- [ ] Handler registered in command-router.ts
- [ ] Test file exists
- [ ] Prompt injection (if needed) in prompt-builder.ts

Classify each scenario:
- ✅ **Works** — full path verified, no gaps
- ⚠️ **Partial** — path exists but missing validation/test/edge case
- ❌ **Blocked** — path is broken, code unreachable, or dead

### 3. GAP REPORT — Document Findings

Output a structured report:

```markdown
## Gap Analysis: {issue title}

### Scenarios Traced
| # | Scenario | Status | Gap |
|---|----------|--------|-----|
| 1 | MANAGE_SKILL create | ❌ | MCP enum + validator |
| 2 | $user:my-deploy invoke | ✅ | — |
| 3 | skills list command | ✅ | — |

### Gaps Found
| # | Severity | File | Description |
|---|----------|------|-------------|
| G1 | 🔴 Critical | validator.ts:86 | commandId not in allowlist |
| G2 | 🟡 Medium | skills-handler.test.ts | test file missing |

### Root Cause
[Why these gaps exist — usually: plan didn't include wiring steps]
```

If gaps found → create a GitHub issue with ztrace scenarios.

### 4. FIX — Implement via local:z

1. **Plan**: List exact file + line changes for each gap
2. **Implement**: Make the changes surgically
3. **Verify**: Run affected tests, tsc, biome
4. **Push**: Create PR via MCP or git CLI
5. **zcheck**: Full zcheck procedure before requesting approve
6. **Re-verify**: Run zfix again on the fix PR to confirm no recursive gaps

## Rules

- **Trace at callstack depth, not API surface.** "The function exists" is not verification. "The function is reachable from the entry point" is.
- **Every new ID/enum/registry must be added to ALL layers.** If you add a new commandId, check types → catalog → validator → MCP schema → entry points.
- **Missing tests are gaps.** New code without tests is incomplete implementation.
- **Don't optimize — fix.** The goal is making the feature work, not improving adjacent code.
- **Document the miss pattern.** After fixing, note what checklist item was missed so it's caught earlier next time.
