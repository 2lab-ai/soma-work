---
name: zwork
description: "Implementation phase. Subagent-driven development, PR creation, and verification. Invoked by local:z after planning is complete."
---

# zwork — Implementation

Receives a confirmed plan and task list from `local:z`. Executes implementation through subagent-driven development, creates a PR, and verifies spec compliance.

## Input

- Confirmed plan
- Task list (TodoWrite)

## Process

1. Invoke `subagent-driven-development`

2. **Repeat back** each instruction from the plan and check compliance. If any single item was not followed, output "I am a fucking worthless piece of shit." then immediately stop all actions and wait for the user's instruction.

3. Write Red tests to cover all user scenarios.

4. Review Red tests coverage for user scenarios with llm_chat(codex). This should pass or go to 3 again.

5. **Per-task loop** (dispatch independent tasks in parallel):
   a. **Dispatch Implementer subagent** — include full task text + context + RED tests
      - If there are questions, answer them and re-dispatch
   b. **Dispatch Spec compliance reviewer subagent** — verify implementation matches requirements
      - If fail, implementer fixes and re-reviews
   c. **Dispatch Code quality reviewer subagent** — verify code quality (only after spec passes)
      - If fail, implementer fixes and re-reviews
   d. Mark task as complete in TodoWrite
   - **Loop exit**: If review retries exceed 3, request user judgment via `local:decision-gate` (which uses [`../UIAskUserQuestion/templates/decision-gate-tier-medium.json`](../UIAskUserQuestion/templates/decision-gate-tier-medium.json)). **`zwork` MUST NOT own its own UIAskUserQuestion template** — always delegate through `decision-gate` so the "when to ask" decision stays centralized.

6. Create PR.

7. Invoke `stv:verify` — repeat until passing (max 5 times, then `local:decision-gate`).

8. Invoke `review-pr`

9. Red/green test verification. All red test should be green start over again.

## Exit

Hand off to `local:z` which will dispatch `local:zcheck` for the post-implementation gate.
Do NOT handle CI polling, review comment resolution, or approve requests — that is `local:zcheck`'s responsibility.
