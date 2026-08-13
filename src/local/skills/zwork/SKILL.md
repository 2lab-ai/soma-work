---
name: zwork
description: "Implementation phase. Subagent-driven development, PR creation, and verification. Invoked by local:z after planning is complete."
---

# zwork — Implementation

Receives a confirmed plan and task list from `local:z`. Executes implementation through subagent-driven development, creates a PR, and verifies spec compliance.

## Input

- Confirmed plan
- Task list (TodoWrite)
- **Issue URL** — required for `using-epic-tasks` Case A / Case B (sub-issue of an epic)
- **Case A escape marker** — Case A escape 조건: `local:using-z` §Case A escape (3 conditions)를 단일 진실원으로 따른다 — 여기서 재정의하지 않는다 (tier / user demand / repo policy 게이트). Receiving sessions must re-verify against the `## Original Request Excerpt` and `## Repository Policy` fields in the `<z-handoff>` payload — do not trust the escape marker blindly.
- **Parent Epic URL** (optional) — present when this work is a sub-issue of an epic; carried forward for z phase5 Handoff #2

When invoked via session handoff from z phase1, the initial session prompt carries a `<z-handoff type="plan-to-work">` block (contract: `local:using-z` §Session Handoff Protocol → Handoff #1). z phase0 step 0.5 parses the block and injects the Task List into TodoWrite — zwork reads Issue URL / Parent Epic from session-level SSOT set by phase0. If neither Issue URL nor Case A escape marker is present, zwork must not proceed to PR creation (see step 5 below).

## Process

0. **SSOT restore (`local:using-ssot` Hook 3).** Read `## SSOT-LIST` and `## SSOT-TASK-TREE` from the `<z-handoff type="plan-to-work">` block (already parsed into session-level SSOT by z phase0 step 0.5). Emit a **one-line ack** at session start: `SSOT restored — N ssot-tasks, M still open` (no full re-render — phase0 already printed the tree on the producer side). Re-render the full tree only if the handoff parse failed or the user explicitly asks. Every subsequent RED test, every implementer dispatch, and the final PR body must trace back to one or more `ssot-task` IDs from this tree. If a drift instruction arrives mid-implementation, **do not mutate the tree locally** — bounce to the z controller (zreflect → Hook 2) and resume from the regenerated tree.

1. Write RED tests covering all user scenarios (tag each with the `ssot-task` IDs it covers). Run them and confirm they fail. **If RED tests were already authored upstream** (autoz Analysis/RED intake, carried via the Handoff #1 `## Analysis Artifact` / `## Analysis Summary` / `## RED Mapping` fields) — reuse and extend them; do not re-author from scratch. RED authorship has one owner: the session that ran the intake. Link the carried analysis artifact in the PR body.

2. Review RED-test coverage of the user scenarios via the `local:trinity` chain (trinity consensus → llm_chat(codex) → `codex-fallback` opus). If coverage is incomplete, extend the tests and re-review — loop until the review passes.

3. Split the confirmed plan into independent implementer briefs (one per `ssot-task` where possible), each carrying the full task text, its RED tests, and the shared context needed to work in isolation.

4. **Per-task loop** (dispatch independent briefs to parallel subagents via the Task/Agent tool):
   a. **Dispatch Implementer subagent** — include full task text + context + RED tests
      - If there are questions, answer them and re-dispatch
   b. **Dispatch Spec compliance reviewer subagent** — verify implementation matches requirements
      - If fail, implementer fixes and re-reviews
   c. **Dispatch Code quality reviewer subagent** — verify code quality (only after spec passes)
      - If fail, implementer fixes and re-reviews
   d. Mark task as complete in TodoWrite
   - **Loop exit**: If review retries exceed 3, request user judgment via `local:decision-gate` (which uses [`../UIAskUserQuestion/templates/decision-gate-tier-medium.json`](../UIAskUserQuestion/templates/decision-gate-tier-medium.json)). **`zwork` MUST NOT own its own UIAskUserQuestion template** — always delegate through `decision-gate` so the "when to ask" decision stays centralized.

5. Create PR.
   - **Precondition**: Issue URL must be present in session-level SSOT (Case A/B), **or** a validly qualified Case A escape marker must be set. Case A escape 조건: `local:using-z` §Case A escape (3 conditions)를 단일 진실원으로 따른다 — 여기서 재정의하지 않는다 (tier / user demand / repo policy 게이트, 재검증은 `## Original Request Excerpt` + `## Repository Policy` 대조). Missing or invalid → abort PR creation and return control to `local:z` phase1 with the reason. This prevents orphan PRs with no linked issue.
   - PR body MUST include `Closes #<issue>` for Case A/B, or an explicit `Case A escape (tier=tiny|small, no issue by policy)` note when the qualified escape marker is used. **Inline only** — body must be passed as inline content to `--body` (literal string or heredoc). Shell variable indirection (e.g. `--body "$VAR"`) is host-rejected because the static check cannot see the runtime value.
   - PR body MUST open with the `local:calldiff` call-flow report as its **first** section (`## Summary`), per `src/prompt/default.prompt` §On Pull Request Creation and `local:calldiff` §In a pull request body. Diff against the ref you pass to `--base`. The block is never omitted — the no-change / unavailable / no-source-files lines stand in for it. It never blocks PR creation.
   - PR body MUST include a `## SSOT-TASK-TREE coverage` section listing every `ssot-task` ID from the session tree with the artifact (commit / file / RED→GREEN) that satisfies it. **`ssot-task` layer only — `ssot-subtask` is volatile (`using-ssot` Invariant 4) and lives in commit messages, not in the PR body.**
   - *(Host-enforced via in-process SDK PreToolUse hook — `src/hooks/pr-issue-guard.ts` wired through `src/claude-handler.ts`. Bash `gh pr create` and MCP `mcp__github__create_pull_request` both covered. This prompt rule remains as defense-in-depth.)*

6. Invoke `stv:verify` — repeat until passing (max 5 times, then `local:decision-gate`).

7. Invoke `local:review-pr`

8. RED→GREEN verification: every RED test from step 1 must now pass. Any test still red → return to step 4 for the owning `ssot-task`.

## Exit

Hand off to `local:z` which will dispatch `local:zcheck` for the post-implementation gate.
Do NOT handle CI polling, review comment resolution, or approve requests — that is `local:zcheck`'s responsibility.
