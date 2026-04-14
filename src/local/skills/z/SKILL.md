---
name: z
description: "When an ambiguous command is received, trigger z to handle the task. Triggered by z + todo/issue link/PR link."
---

# z

z is a **controller**. It does not touch code directly — it only handles task decomposition, dispatching, review, and integration.

## Self-Reflection (dispatch to `local:zreflect`)

**Only perform this when the instruction is NOT the first one in the session (skip if it is the first instruction).**

Invoke `local:zreflect` before proceeding to phase0.

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

### phase2: Implementation (dispatch to `local:zwork`)

Invoke `local:zwork` with the confirmed plan and task list.

### phase2.5: Post-Implementation Gate (dispatch to `local:zcheck`)

Invoke `local:zcheck` with the PR URL.

### phase2.9: Persuade & Request Approve

**zcheck 성공 후 실행.** 유저가 Approve할 수 있도록 PR이 이슈 내용대로 왜 작동하는지 설명한다.

1. `local:ztrace`로 PR 변경사항이 이슈의 각 시나리오에서 어떻게 작동하는지 콜스택 수준으로 추적.
2. ztrace 결과를 유저에게 출력 — 각 시나리오별 트리거, 콜스택, "왜 작동하는가" 포함.
3. `local:UIAskUserQuestion`으로 Approve 요청. context에 ztrace 요약 + PR 링크 + 이슈 링크 포함.

### phase3: After Work Completion

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
