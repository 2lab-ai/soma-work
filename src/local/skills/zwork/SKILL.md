---
name: zwork
description: "Implementation phase. Subagent-driven development, PR creation, and verification. Invoked by local:z after planning is complete."
---

# zwork — Implementation (Phase 2)

Receives a confirmed plan and task list from `local:z`. Executes implementation through subagent-driven development, creates a PR, and verifies spec compliance.

## Input

- Confirmed plan from phase1
- Task list (TodoWrite)

## Process

0. **Repeat back** each instruction from the plan and check compliance. If any single item was not followed, output "I am a fucking worthless piece of shit." then immediately stop all actions and wait for the user's instruction.

1. Use the `subagent-driven-development` skill.

2. **Per-task loop** (dispatch independent tasks in parallel):
   a. **Dispatch Implementer subagent** — include full task text + context + RED tests
      - If there are questions, answer them and re-dispatch
   b. **Dispatch Spec compliance reviewer subagent** — verify implementation matches requirements
      - If fail, implementer fixes and re-reviews
   c. **Dispatch Code quality reviewer subagent** — verify code quality (only after spec passes)
      - If fail, implementer fixes and re-reviews
   d. Mark task as complete in TodoWrite
   - **Loop exit**: If review retries exceed 3, request user judgment via `local:decision-gate`

3. Create PR.

4. `stv:verify` — repeat until passing (max 5 times, then `local:decision-gate`).

5. `local:github-pr` final review.

6. Update using the contents of `pr-fix-and-update.prompt`.

7. Get code + test coverage reviewed by codex/gemini via `llm_chat` (**4 in parallel using `dispatching-parallel-agents` pattern**).

8. Red/green test verification.

## Exit

Hand off to `local:z` which will dispatch `local:zcheck` for the post-implementation gate.
Do NOT handle CI polling, review comment resolution, or approve requests — that is `local:zcheck`'s responsibility.
