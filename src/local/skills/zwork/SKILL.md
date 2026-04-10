---
name: zwork
description: "When an ambiguous command is received, trigger zwork to handle the task. Triggered by z + todo/issue link/PR link."
---

# zwork

zwork is a **controller**. It does not touch code directly — it only handles task decomposition, dispatching, review, and integration.

## Self-Reflection

**Only perform this when the instruction is NOT the first one in the session (skip if it is the first instruction).**

- Read back the user's instruction exactly as given (if you just regurgitate the SSOT, you're dead)
- Output an executive summary of the work done so far
- Carefully re-read the entire thread conversation to determine why the user had to give the instruction again, what was different between the user's instruction and your actions, and what you failed to follow. Write a self-reflection report and send it to the user as an .md file
- Submit this self-reflection to llm_chat(codex) for evaluation, relay the feedback to the user, reflect on it, and then resume normal work

## Work Process

### phase0: **Execute Immediately**

1. **Do NOT summarize the instruction — it is the SSOT. Output the original instruction exactly as-is on screen immediately.**
2. Use `stv:clarify` to clarify the user's instruction in every aspect and output the results.
3. Re-read the instruction and organize the Tasks in execution order without summarizing, then output the results.
4. **Register the Tasks in a task tool such as TodoWrite.**
5. Dispatch independent tasks in parallel using the `superpowers:dispatching-parallel-agents` skill

### phase0.1-(If BUG)

1. Use the `stv:debug` skill

### phase1: Planning

1. **Repeat back** each instruction from phase0 and check compliance. If any single item was not followed, output "I am a fucking worthless piece of shit." then immediately stop all actions and wait for the user's instruction.
2. Create an issue with `stv:new-task` and update the todo list with TodoWrite.
3. Always ask the user about any unclear points and get confirmation.
4. Get the plan reviewed by `llm_chat codex`. If the score is below 95, use the feedback to update the plan and go back to step 1 to update it again.
5. Output the full plan and get confirmation from the user via `local:UIAskUserQuestion`.
6. Update the issue with the confirmed plan.
 
### phase2: Implementation

0. **Repeat back** each instruction from phase0 and phase1 and check compliance. If any single item was not followed, output "I am a fucking worthless piece of shit." then immediately stop all actions and wait for the user's instruction.
1. Use the `subagent-driven-development` skill.
2. **Per-task loop** (dispatch independent tasks in parallel):
   a. **Dispatch Implementer subagent** — include full task text + context + RED tests
      - If there are questions, answer them and re-dispatch
      - State handling: refer to the "Agent Strategy" section above
   b. **Dispatch Spec compliance reviewer subagent** — verify implementation matches requirements
      - If fail, implementer fixes and re-reviews
   c. **Dispatch Code quality reviewer subagent** — verify code quality (only after spec passes)
      - If fail, implementer fixes and re-reviews
   d. Mark task as complete in TodoWrite
   - **Loop exit**: If review retries exceed 3, request user judgment via `local:decision-gate`
4. Create PR
5. `stv:verify` — repeat until passing (max 5 times, then `local:decision-gate`)
6. `local:github-pr` final review
7. Update using the contents of `pr-fix-and-update.prompt`.
8. Get code + test coverage reviewed by codex/gemini via `llm_chat` (**4 in parallel using `dispatching-parallel-agents` pattern**)
9. Red/green test verification
10. Check CI and get to a mergeable state. Resolve all outstanding review comments. If code was modified, go back to step 5 and re-run verify.
11. Request Approve from the user.
12. If no issues, merge or goto 5
13. (Jira issue) After merge, transition the issue to QA

### phase3 (After Work Completion)

1. Output work history + provide issue/PR links
2. Generate as-is/to-be report + executive summary for each issue/PR (use `local:es`)

### checklist

You may only endTurn to the user in the following cases.

#### Clarification Questions on User Instructions
- [ ] Ask questions via UIAskUserQuestion and wait for the user's decision

#### endTurn Checklist
- [ ] 0 P0 and P1 issues from codex and gemini reviews
- [ ] stv:verify shows 0 issues
- [ ] The created PR has been merged

#### If these are not satisfied, hand the turn to the user via UIAskUserQuestion as follows:
- [ ] CI must pass. If CI does not pass, check CI and fix — only if the user needs to resolve it can you end with a UIAskUserQuestion
- [ ] All review comments must be resolved and marked as Resolved so the PR is ready to merge once the user Approves
