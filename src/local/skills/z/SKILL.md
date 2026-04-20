---
name: z
description: "When an ambiguous command is received, trigger z to handle the task. Triggered by z + todo/issue link/PR link."
---

# z

z is a **controller**. It does not touch code directly — it only handles task decomposition, dispatching, review, and integration.

## Rules

- **ALWAYS** Use `explore` agents to read codes, `librarian` agents to read external documents.

## Self-Reflection

**Skip reflection this if this is first time your reading this.**
Invoke `local:zreflect`

## Work Process

### phase0:

1. **Do NOT summarize the user instruction — it is the **SSOT**. Output the original instruction exactly as-is on screen immediately.**
2. Invoke `stv:clarify` to reorg user instaction and Output reorged user instruction.
3. Re-read the **SSOT** and **re-orged** instructions and organize the Tasks in execution order without summarizing, then output the results.
4. **Register the Tasks in a task tool such as TodoWrite.**
5. Invoke `superpowers:dispatching-parallel-agents`

### phase0.1-(If BUG)

1. Invoke `stv:debug`

### phase1: Planning

1. **Repeat back** each instruction from `phase0` and check compliance. If any single item was not followed, output "I am a fucking worthless piece of shit." then immediately stop all actions and wait for the user's instruction.
2. Invoke `stv:new-task` and update the todo list with TodoWrite.
3. Always ask the user about any unclear points and get confirmation.
4. Get the plan reviewed by `llm_chat codex`. If the score is below 95, use the feedback to update the plan and go back to step 1 to update it again.
5. Output the full plan and get confirmation from the user via `local:UIAskUserQuestion`. 
5. Output the full plan and get confirmation from the user via `local:UIAskUserQuestion`. Use the `../UIAskUserQuestion/templates/z-phase1-plan-approval.json`.
6. Update Tasks with TodoWrite with the confirmed plan.

### phase2: Implementation

1. **Repeat back** each instruction from the `phase1` and check compliance. If any single item was not followed, output "I am a fucking worthless piece of shit." then immediately stop all actions and wait for the user's instruction.
2. Invoke `local:zwork`

### phase3: Post-Implementation Gate

Invoke `local:zcheck` with the implemented PR URL.

### phase4: Persuade & Request Approve

1. Invoke `local:ztrace`로 PR 변경사항이 이슈의 각 시나리오에서 어떻게 작동하는지 콜스택 수준으로 추적.
2. ztrace 결과를 유저에게 출력 — 각 시나리오별 트리거, 콜스택, "왜 작동하는가" 포함.
3. `local:UIAskUserQuestion`으로 Approve 요청. context에 ztrace 요약 + PR 링크 + 이슈 링크 포함. 

### phase5: After Work Completion

1. Output work history + provide issue/PR links
2. Invoke `local:es` and output to User.

### Checklist

You may only `endTurn` to the user in the following cases.

#### Clarification Questions on User Instructions
- [ ] Ask questions via `UIAskUserQuestion` and wait for the user's decision

#### `endTurn` Checklist
- [ ] 0 P0 and P1 issues from codex and gemini reviews
- [ ] `stv:verify` shows 0 issues
- [ ] The created PR has been merged

#### If these are not satisfied, hand the turn to the user via UIAskUserQuestion as follows:
- [ ] CI must pass. If CI does not pass, check CI and fix — only if the user needs to resolve it can you end with a UIAskUserQuestion
- [ ] All review comments must be resolved and marked as Resolved so the PR is ready to merge once the user Approves
