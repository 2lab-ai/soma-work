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
- **Case A escape marker** — allowed only when **all three** conditions hold: (a) `using-epic-tasks` classified the work as tier=`tiny`|`small`, (b) the original user request contained no explicit or implicit "issue first" demand, **and** (c) repository policy does not require a linked issue at this tier. Any missing → escape invalid, Issue URL path is mandatory. Receiving sessions must re-verify against the `## Original Request Excerpt` and `## Repository Policy` fields in the `<z-handoff>` payload — do not trust the escape marker blindly.
- **Parent Epic URL** (optional) — present when this work is a sub-issue of an epic; carried forward for z phase5 Handoff #2

When invoked via session handoff from z phase1, the initial session prompt carries a `<z-handoff type="plan-to-work">` block (contract: `local:using-z` §Session Handoff Protocol → Handoff #1). z phase0 step 0.5 parses the block and injects the Task List into TodoWrite — zwork reads Issue URL / Parent Epic from session-level SSOT set by phase0. If neither Issue URL nor Case A escape marker is present, zwork must not proceed to PR creation (see step 5 below).

## Process

1. Invoke `subagent-driven-development`

2. Write Red tests to cover all user scenarios.

3. Review Red tests coverage for user scenarios with llm_chat(codex). This should pass or go to 3 again.

4. **Per-task loop** (dispatch independent tasks in parallel):
   a. **Dispatch Implementer subagent** — include full task text + context + RED tests
      - If there are questions, answer them and re-dispatch
   b. **Dispatch Spec compliance reviewer subagent** — verify implementation matches requirements
      - If fail, implementer fixes and re-reviews
   c. **Dispatch Code quality reviewer subagent** — verify code quality (only after spec passes)
      - If fail, implementer fixes and re-reviews
   d. Mark task as complete in TodoWrite
   - **Loop exit (orchestrator-mode)**: when zwork is invoked as a phase-2 subagent by `local:z`, the implementer / reviewer subagents MUST NOT call `UIAskUserQuestion`, `mcp__model-command__run ASK_USER_QUESTION`, or `decision-gate` UI prompts directly. After 3 unresolvable review cycles, the subagent returns a structured `blocker` field in its final report to the z orchestrator, which then routes the user dialogue. Only when zwork is invoked **standalone** (not via z) may it call `local:decision-gate` directly, and even then the template must be [`../UIAskUserQuestion/templates/decision-gate-tier-medium.json`](../UIAskUserQuestion/templates/decision-gate-tier-medium.json). **`zwork` MUST NOT own its own UIAskUserQuestion template** — always delegate through `decision-gate` so the "when to ask" decision stays centralized.

5. Create PR.
   - **Precondition**: Issue URL must be present in session-level SSOT (Case A/B), **or** a validly qualified Case A escape marker must be set. The escape marker is valid only when **all three**: (a) tier=`tiny`|`small` per `using-epic-tasks`, (b) the original user request contained no "issue first" demand (re-verify against `## Original Request Excerpt` in the handoff payload), **and** (c) repository policy does not require a linked issue (re-verify against `## Repository Policy`). Missing or invalid → abort PR creation and return control to `local:z` phase1 with the reason. This prevents orphan PRs with no linked issue.
   - PR body MUST include `Closes #<issue>` for Case A/B, or an explicit `Case A escape (tier=tiny|small, no issue by policy)` note when the qualified escape marker is used. **Inline only** — body must be passed as inline content to `--body` (literal string or heredoc). Shell variable indirection (e.g. `--body "$VAR"`) is host-rejected because the static check cannot see the runtime value.
   - *(Host-enforced via in-process SDK PreToolUse hook — `src/hooks/pr-issue-guard.ts` wired through `src/claude-handler.ts`. Bash `gh pr create` and MCP `mcp__github__create_pull_request` both covered. This prompt rule remains as defense-in-depth.)*

6. Invoke `stv:verify` — repeat until passing (max 5 times). On the 6th cycle:
   - **standalone mode**: ask the user via `local:decision-gate`.
   - **orchestrator-mode** (invoked as a phase-2 implementer subagent by `local:z`): do **not** call `decision-gate` UI or `UIAskUserQuestion`. Return a structured `blocker` field in the final report — the z orchestrator owns the user dialogue and will route the question itself per `z/SKILL.md` §2.4.

7. Invoke `review-pr`

8. Red/green test verification. All red test should be green start over again.

## Exit

- **standalone mode**: hand off to `local:zcheck` for the post-implementation gate (zcheck owns Step 4 user approve in this mode).
- **orchestrator-mode**: return the final report (PR URL, files changed, build/test result, blocker if any) to the `local:z` orchestrator. **z phase 3 dispatches the post-impl-gate driver (zcheck Step 0–3 only) and z phase 4 owns the user approve dialogue** — not zcheck, not zwork. Do NOT handle CI polling, review comment resolution, or approve requests yourself in either mode.
