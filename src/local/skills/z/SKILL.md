---
name: z
description: "Work controller (phase 0–5): SSOT intake, planning, implementation dispatch, post-implementation gate, approve, and terminal report. Triggered by `z` + a plain instruction, todo, issue link, or PR link."
---

# z

z is a **controller**. It does not touch code directly — it only handles task decomposition, dispatching, review, and integration.

## Rules

- **ALWAYS** use `explore` agents to read code and `librarian` agents to read external documents.

## Self-Reflection

If this is NOT the first instruction in the session (the user re-instructed or corrected), invoke `local:zreflect` before anything else. First instruction → skip.

## Work Process

### phase0:

0. **Handoff detection (first)** — scan the incoming user prompt for a `<z-handoff>` sentinel (contract: `local:using-z` §Session Handoff Protocol):
   - **0.5** `<z-handoff type="plan-to-work">` present → this session was dispatched by a prior phase1. **Skip steps 1–5 below.** Parse the block: register Task List into TodoWrite, **restore SSOT-LIST + SSOT-TASK-TREE from the payload (`local:using-ssot` Hook 3)**, store Issue URL + Parent Epic as session-level SSOT for phase5, **restore `## Pipeline Mode`** (value `autoz` → suppress all interactive gates for the rest of the session per `local:autoz` Rule 4; missing → `interactive`), and restore the `## Analysis Artifact` / `## Analysis Summary` / `## RED Mapping` fields for zwork if present. Then jump to **phase2 (Implementation)**.
   - **0.6** `<z-handoff type="work-complete">` present → this session was dispatched by a prior phase5. **Skip steps 1–5 below.** Jump to **phase5.E (Epic Update branch)**.
   - Neither sentinel → proceed to step 1 normally (direct user request).

**Steps 1–4 below run `local:using-ssot` **Hook 1** (Initial intake) for the z controller. Read that skill for definitions of SSOT / SSOT-LIST / SSOT-TASK-TREE / ssot-task / ssot-subtask. Step 5 is z-specific dispatch.**

1. **Do NOT summarize the user instruction — it is the **SSOT**. Output the original instruction exactly as-is on screen immediately.** If the instruction is a bare link (issue / PR / external doc), fetch the target body and fold it into the SSOT so the SSOT is self-contained.
2. **Build SSOT-LIST** — for a fresh intake this is `[SSOT_1]`. Output it under `## SSOT-LIST (시간 순)` per the `using-ssot` output format.
3. **Build SSOT-TASK-TREE** — decompose the SSOT into atomic, self-contained `ssot-task` nodes with a dependency tree. Expand each `ssot-task` into `ssot-subtask` nodes. Every `ssot-task` must trace back to a SSOT excerpt; if it cannot, demote it to a `ssot-subtask` or drop it. Output the tree under `## SSOT-TASK-TREE`. Pause briefly so the user can interject before the dispatch step.
4. **Register the leaves in TodoWrite.** `ssot-task` with no `ssot-subtask` → one entry. `ssot-task` with `ssot-subtask` children → one entry per `ssot-subtask`. The TodoWrite mirror MUST be kept in sync with the tree from this point on.
5. **z-specific dispatch** — invoke `superpowers:dispatching-parallel-agents`. (Not part of Hook 1; this is z's downstream wiring.)

**Drift handling during phase0–phase5.** If a new raw user message arrives any time before terminal report, invoke `local:zreflect` (which now triggers `local:using-ssot` **Hook 2**): append to SSOT-LIST, regenerate SSOT-TASK-TREE, diff at `ssot-task` granularity (`ssot-subtask` is volatile by definition), output the diff + refreshed tree, patch TodoWrite, then resume from the new tree's incomplete leaves. Do not wipe + restart.

### phase0.1-(If BUG)

1. Invoke `stv:debug`

### phase1: Planning

1. **Repeat back** each instruction from `phase0` and check compliance. If any item was not followed, output a compliance-failure report (which item, what happened instead), stop all actions, and wait for the user's instruction.
2. Invoke `stv:new-task` and update the todo list with TodoWrite.
3. Always ask the user about any unclear points and get confirmation.
4. Get the plan reviewed via the `local:trinity` chain (trinity 3-engine consensus → `llm_chat codex` → `codex-fallback` opus). Pass = APPROVE with MUST-FIX none at whichever tier produced the verdict (trinity: unanimous). Not passed → update the plan from the feedback and resubmit — repeat until it passes. Record tier + verdict for the handoff payload (its legacy `Codex Review score` field carries `100` on a pass, or the numeric score if the reviewing tier returned one).
5. Output the full plan and get confirmation from the user via `local:UIAskUserQuestion`. Use the `../UIAskUserQuestion/templates/z-phase1-plan-approval.json`.
6. Update Tasks with TodoWrite with the confirmed plan.
7. **Handoff to phase2 via new session** (contract: `local:using-z` §Session Handoff Protocol → Handoff #1):
   - Verify Issue URL from `using-epic-tasks` Case A/B output. Case A escape 조건: `local:using-z` §Case A escape (3 conditions)를 단일 진실원으로 따른다 — 여기서 재정의하지 않는다 (tier / user demand / repo policy 조합을 결정하는 게이트). 조건 미충족 시 Issue URL 경로가 필수.
   - If neither Issue URL nor a validly qualified escape marker is available, **do not call CONTINUE_SESSION** — return to step 2 and fix the plan. This is the structural gate preventing issue-less PRs.
   - Call `mcp__model-command__run` with `CONTINUE_SESSION` per the Handoff #1 payload spec: carries Issue URL (or escape marker), Parent Epic (or `none`), Confirmed Plan, Task List, Codex Review score.
   - `resetSession: true`. The current session ends — phase2 runs in the **new session** (which enters via phase0 step 0.5).

### phase2: Implementation

1. **Repeat back** each instruction from `phase1` and check compliance. If any item was not followed, output a compliance-failure report (which item, what happened instead), stop all actions, and wait for the user's instruction.
2. Invoke `local:zwork`. zwork reads the Issue URL + Parent Epic from session SSOT (injected by phase0 step 0.5 if this session was handoff-dispatched).

### phase3: Post-Implementation Gate

Invoke `local:zcheck` with the implemented PR URL.

### phase4: Persuade & Request Approve

1. Invoke `local:ztrace`로 PR 변경사항이 이슈의 각 시나리오에서 어떻게 작동하는지 콜스택 수준으로 추적.
2. ztrace 결과를 유저에게 출력 — 각 시나리오별 트리거, 콜스택, "왜 작동하는가" 포함.
3. `local:UIAskUserQuestion`으로 Approve 요청. context에 ztrace 요약 + PR 링크 + 이슈 링크 포함. 

### phase5: After Work Completion

1. Output work history + provide issue/PR links
2. Invoke `local:es` and output to User. **`es` MUST consume the session's SSOT-LIST + final SSOT-TASK-TREE (`local:using-ssot` Hook 4)** — per-`ssot-task` accountability is now part of every es mode template.
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

### Turn-End Gate

Ending the turn is allowed in exactly two situations:

1. **Waiting on the user** — a clarification or approve question was asked via `UIAskUserQuestion` and the turn ends waiting for the decision.
2. **Work complete** — all of:
   - 0 P0/P1 issues from codex and subagent (opus) reviews
   - `stv:verify` shows 0 issues
   - the created PR has been merged

If neither holds: keep working. CI failures are fixed by you, not delegated — end with a `UIAskUserQuestion` only when resolution genuinely requires the user. Before any approve request, all review comments must be resolved and marked Resolved so the PR is mergeable the moment the user approves.
