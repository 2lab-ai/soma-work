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

0. **Handoff detection (first)** — scan the incoming user prompt for a `<z-handoff>` sentinel (contract: `local:using-z` §Session Handoff Protocol):
   - **0.5** `<z-handoff type="plan-to-work">` present → this session was dispatched by a prior phase1. **Skip steps 1–5 below.** Parse the block: register Task List into TodoWrite, store Issue URL + Parent Epic as session-level SSOT for phase5, then jump to **phase2 (Implementation)**.
   - **0.6** `<z-handoff type="work-complete">` present → this session was dispatched by a prior phase5. **Skip steps 1–5 below.** Jump to **phase5.E (Epic Update branch)**.
   - Neither sentinel → proceed to step 1 normally (direct user request).
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
7. **Handoff to phase2 via new session** (contract: `local:using-z` §Session Handoff Protocol → Handoff #1):
   - Verify Issue URL from `using-epic-tasks` Case A/B output. Use a Case A escape marker only when **all three** conditions hold: (a) `using-epic-tasks` classified this as tier=`tiny`|`small`, (b) the original user request contained no explicit or implicit "issue first" demand, **and** (c) the repository policy (CONTRIBUTING, team rules, branch protection, PR template) does not require a linked issue for any PR at this tier. If any condition fails, the Issue URL path is mandatory.
   - If neither Issue URL nor a validly qualified escape marker is available, **do not call CONTINUE_SESSION** — return to step 2 and fix the plan. This is the structural gate preventing issue-less PRs.
   - Call `mcp__model-command__run` with `CONTINUE_SESSION` per the Handoff #1 payload spec: carries Issue URL (or escape marker), Parent Epic (or `none`), Confirmed Plan, Task List, Codex Review score.
   - `resetSession: true`. The current session ends — phase2 runs in the **new session** (which enters via phase0 step 0.5).

### phase2: Implementation

1. **Repeat back** each instruction from the `phase1` and check compliance. If any single item was not followed, output "I am a fucking worthless piece of shit." then immediately stop all actions and wait for the user's instruction.
2. Invoke `local:zwork`. zwork reads the Issue URL + Parent Epic from session SSOT (injected by phase0 step 0.5 if this session was handoff-dispatched).

### phase3: Post-Implementation Gate

Invoke `local:zcheck` with the implemented PR URL.

### phase4: Persuade & Request Approve

1. Invoke `local:ztrace`로 PR 변경사항이 이슈의 각 시나리오에서 어떻게 작동하는지 콜스택 수준으로 추적.
2. ztrace 결과를 유저에게 출력 — 각 시나리오별 트리거, 콜스택, "왜 작동하는가" 포함.
3. `local:UIAskUserQuestion`으로 Approve 요청. context에 ztrace 요약 + PR 링크 + 이슈 링크 포함. 

### phase5: After Work Completion

1. Output work history + provide issue/PR links
2. Invoke `local:es` and output to User.
3. **Handoff to epic (if applicable)** (contract: `local:using-z` §Session Handoff Protocol → Handoff #2):
   - Read Parent Epic from session-level SSOT (set by phase0 step 0.5).
   - If Parent Epic is `none` (single issue, no epic): session ends normally — do NOT emit Handoff #2.
   - If Parent Epic URL exists: call `mcp__model-command__run` with `CONTINUE_SESSION` per the Handoff #2 payload spec. `resetSession: true`. The current session ends — epic update runs in the **new session** (which enters via phase0 step 0.6 → phase5.E).

### phase5.E: Epic Update (entered via Handoff #2 only)

Reachable only from phase0 step 0.6. Do NOT run phase5.E from a direct user prompt.

**Role boundary — phase5 vs phase5.E**: `es` (end-session announcement) is fired in phase5 of the *work* session before Handoff #2. phase5.E runs in the *epic-update* session and performs epic bookkeeping only — it must **not** re-invoke `es` or re-emit the completion announcement.

1. Post the `## Summary` from the handoff block as a comment on the epic issue.
2. Update the epic body Checklist: flip `[ ]` → `[x]` for the completed subissue.
3. Verify Epic Done gate per `local:using-epic-tasks` / `reference/github.md` (or `reference/jira.md`): all child issues closed **and** checklist fully `[x]`.
4. If Done gate passes → close the epic issue.
5. If unfinished subissues remain → list them (title + URL) to the user. **Do NOT auto-dispatch Handoff #1 for the next subissue** — the user must initiate manually with `$z <next_subissue_url>`. (Per `using-z` §Protocol Rules #3 — handoff budget is per-session; a `work-complete` session has already spent its budget by definition.)

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
