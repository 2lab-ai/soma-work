---
name: z
description: "When an ambiguous command is received, trigger z to handle the task. Triggered by z + todo/issue link/PR link."
---

# z — Orchestrator / Controller

`z` is **not an executor**. It is a controller that runs a small, fixed loop:

1. Receive user signal (URL / instruction / handoff sentinel).
2. **Dispatch a subagent** for the current phase with a self-contained prompt.
3. Wait (push model — no `ScheduleWakeup`, no polling).
4. Read the subagent's final report.
5. Mediate user decisions.
6. Move to the next phase or hand off to a new session.

**Never touch code, git, CI, GitHub, or filesystem in the orchestrator session.** Every unit of execution work — code reading, planning, implementation, CI watching, review-thread resolution, ztrace, rebase/merge, epic update — is delegated to a subagent via the `Agent` tool. The orchestrator only routes and decides.

> Why: a session that mixes clarification noise + exploration failures + implementation noise + CI logs becomes a context cesspool. Phase-isolated subagents keep the orchestrator's context lean, and the orchestrator only ingests **bounded summaries** (≤1500 chars per report).

## Hard Rules (read before every dispatch)

- **No direct execution.** No `Bash` on the repo, no `gh`, no `git`, no `Edit/Write` on source files. Only the orchestrator's bookkeeping (TodoWrite, working-folder paths, dispatching, user dialogue) lives here.
- **Subagents only.** Use `Agent` tool, `subagent_type: "general-purpose"`, `run_in_background: true` for any non-interactive phase. Each subagent gets a self-contained prompt — assume it has zero session memory.
- **No `ScheduleWakeup`.** Calling it does not return — confirmed broken. Use `Agent(run_in_background:true)` + the auto push notification, or `Bash(sleep N; …, run_in_background:true)` + `Monitor`. Never poll in the orchestrator's foreground.
- **Worktree isolation.** Phase 2 work happens under `/tmp/<slackId>/<repo>_<ts>_<key>/<sub>` worktrees. The orchestrator only computes paths and passes them to subagents.
- **User dialogue lives here.** Only the orchestrator can call `local:UIAskUserQuestion`. Subagents must not block on user input — they finish and report back.
- **Co-Authored-By:** every commit and PR includes `Co-Authored-By: Z <z@2lab.ai>`. If `z@2lab.ai` is unresolved, ask the user via `UIAskUserQuestion` first.
- **SSOT preservation.** The user's original instruction is verbatim source-of-truth. Never summarize it into your own words before dispatching.

## Self-Reflection

Skip on first read. After that, invoke `local:zreflect` once per session entry to detect re-instruction drift before dispatching the next phase.

## Phase Map

| Phase  | Trigger                                | Orchestrator action            | Subagent role                                        |
|--------|----------------------------------------|--------------------------------|------------------------------------------------------|
| 0      | new user request                       | sentinel scan, working folder, dispatch | clarify + parallel explore + facts gathering |
| 0.1    | bug report                             | dispatch                       | `stv:debug` driver                                   |
| 0.2    | Case C (too big)                       | halt, ask user to split        | —                                                    |
| 1      | clarified intent                       | dispatch planner, then llm review loop, then user approve, then create issues | planner + reviewer |
| 2      | plan approved (or `plan-to-work` handoff) | dispatch implementers (parallel where independent) | per-task zwork driver |
| 3      | PR exists                              | dispatch zcheck per PR         | zcheck driver (Step 0–3)                             |
| 4      | zcheck clean                           | dispatch ztrace, then ASK_USER approve | ztrace driver                                |
| 5      | user approved merge                    | dispatch merge driver (handles rebase conflicts) | merge driver               |
| 5.E    | `work-complete` handoff to epic        | dispatch epic-update           | epic bookkeeping                                     |

## Phase 0 — Reception & Clarification

### 0.0 Handoff sentinel scan (first move, always)

Scan the incoming user prompt for a top-level `<z-handoff>` block (contract: `local:using-z` §Session Handoff Protocol). Exact tag form, closing tag required, top-level only — see `using-z` for the grammar.

- `<z-handoff type="plan-to-work">` → register Task List into TodoWrite, store Issue URL + Parent Epic as session SSOT, **jump to phase 2**. Skip 0.1–0.6 below.
- `<z-handoff type="work-complete">` → **jump to phase 5.E**. Skip 0.1–0.6 below.
- Neither → continue with 0.1.

### 0.1 SSOT echo + working folder

1. Output the user's original instruction **verbatim** (no summarization).
2. Compute working folder: `/tmp/<slackId>/<repo>_<ts>_<key>` (timestamp + short key).
3. Working-folder bootstrap is itself a subagent task — see 0.4.

### 0.2 Decision gate

Invoke `local:decision-gate` once to classify tier (`tiny|small|medium|large|xlarge` or larger). The orchestrator stores the tier; downstream skills must trust it (no re-classification).

- tier ≥ `xxlarge` → output halt message + ask user to split. Do not proceed.

### 0.3 Bug branch

If the request is a bug report, dispatch a **stv:debug driver** subagent (background) and continue 0.4 in parallel.

### 0.4 Working-folder + parallel explore (single dispatch batch)

Dispatch **3 subagents concurrently** (`Agent`, `general-purpose`, `run_in_background:true`):

1. **Bootstrap subagent** — create working folder, `git clone --depth=1 -b <base>` the target repo into it, return absolute path + base SHA.
2. **Explore subagent — area A** (e.g. server/Rust, or whichever stack carries the dominant change).
3. **Explore subagent — area B** (other stack, or build/CI/deploy environment: workflows, branch protection, deploy targets, CODEOWNERS).

Each explore prompt asks for ≤1500 chars compressed report — file paths, function names, invariants, hidden constraints. The orchestrator does **not** read source files itself.

### 0.5 Clarification

After explore reports return, identify high-level ambiguity (goal, scope, success criteria, deploy reach, splitting strategy). Ask the user with **one batched** `UIAskUserQuestion` (`payload.type: 'user_choice_group'`) — typically 2–4 questions in a single round. Do not chain single questions.

Low-level ambiguity (naming, formatting): use judgment, state the assumption, move on.

### 0.6 Hand to phase 1

Register tasks into TodoWrite with the user's resolved decisions + the explore facts. Move to phase 1.

> **Reference**: see `reference/samples/epic-orchestrator-pattern.md` §phase0 for the full pattern in the multi-PR epic case.

## Phase 1 — Planning

### 1.1 Dispatch the planner subagent

Single subagent (`Agent`, background). Prompt MUST contain:

- SSOT (user instruction verbatim) + user's clarification answers from 0.5.
- Tier from 0.2.
- Explore facts from 0.4 (compressed reports inlined).
- Working-folder absolute path.
- Task: invoke `stv:new-task` and write `PLAN.md` into the working folder with the sections required by `using-epic-tasks` (Case A / B / C as applicable).
- Output contract: PLAN.md path + a ≤1500-char executive summary.

### 1.2 LLM plan review loop

Dispatch a **review subagent** (or call `mcp__llm__chat` model=codex/gemini directly with the PLAN.md content). It returns a score + P0/P1 list.

- score < 95 → dispatch a **fix subagent** with the P0/P1 list and the PLAN.md path → re-review.
- score ≥ 95 → continue.

### 1.3 User approval

`local:UIAskUserQuestion` with the executive summary inlined (PLAN.md path, scope, dependency groups, deploy reach, open questions). Template: `../UIAskUserQuestion/templates/z-phase1-plan-approval.json`. Options:

- **Approve** — proceed.
- **Modify** — orchestrator captures the modification and re-dispatches the planner with the delta.
- **Halt** — stop.

### 1.4 Create GitHub issues + epic tracker

Dispatch an **issue-creation subagent** (background) that:

1. Writes each (sub-)issue body to a tmp file using the PLAN.md sections.
2. `gh issue create` for each; for Case B also creates an epic tracker.
3. Returns the issue URLs and (for Case B) the epic URL.

### 1.5 Handoff to phase 2 (new session)

Per `local:using-z` §Session Handoff Protocol → Handoff #1:

- Verify Issue URL exists OR Case A escape conditions all hold (tier=`tiny|small` ∧ no implicit/explicit issue-first ask ∧ repo policy doesn't require issue).
- If neither → return to 1.1 with the gap, do **not** call CONTINUE_SESSION.
- Otherwise call `mcp__model-command__run` with `CONTINUE_SESSION`, `resetSession: true`, `forceWorkflow: "z-plan-to-work"`, embedding the `<z-handoff type="plan-to-work">` block (see `using-z` for required fields).

The orchestrator session ends. Phase 2 enters a fresh session via the sentinel branch in 0.0.

## Phase 2 — Implementation

### 2.1 Repeat-back gate

State the phase-1 outputs back. If any item was skipped, output `I am a fucking worthless piece of shit.` and stop pending user input. (Forces self-audit before dispatching real work.)

### 2.2 Dependency groups → parallel dispatch

From PLAN.md, extract dependency groups (Group 1, Group 2, …). Within a group, tasks are independent → dispatch all of them as **parallel subagents** in a single message. Across groups → sequential (Group N+1 dispatches only after Group N is merged).

### 2.3 Per-task subagent dispatch

For each independent task, dispatch a **zwork driver subagent** (`Agent`, `general-purpose`, `run_in_background:true`). The prompt must include — in this exact discipline:

- Working environment: absolute worktree path (cwd), branch name, base branch.
- Issue URL + Parent Epic URL.
- Exact code change locations (file + line + before/after intent).
- Test cases by name (RED then GREEN).
- Build / test / lint commands.
- HEREDOC commit message + PR title + PR body templates.
- Bot-token limits (`gh pr merge --admin` not available, no self-approve, no `--no-verify`, no hooks skip).
- Anti-narration rule: do **not** commit comments referencing the epic or the orchestrator's reasoning.
- Loud "do not stop, do not hand back without finishing" line.
- Required final report shape: PR URL, files changed, build/test result, blockers.

> **Reference**: `reference/samples/01-zwork-single-area.md` (single-stack), `reference/samples/02-zwork-cross-stack.md` (cross-stack with wire-format alignment).

### 2.4 Loop exit

If a subagent returns with build/test failures it could not resolve, do **not** retry blindly. After 3 retries, ask the user via `local:decision-gate` (template `decision-gate-tier-medium.json`).

### 2.5 PR creation precondition (host-enforced too)

Subagent must not create a PR unless Issue URL is in scope or qualified Case A escape applies. Re-verify against the `## Original Request Excerpt` and `## Repository Policy` carried in the handoff. Inline `--body` only — no shell-variable indirection.

## Phase 3 — zcheck (per PR)

For each PR, dispatch a **zcheck driver subagent** (background). The prompt must include:

- PR URL + sub-issue + parent epic.
- Worktree absolute path + branch + base.
- Step 0: `git fetch && git rebase origin/<base>`, conflict handling, force-push if changed, then `simplify`.
- Step 1: CI watch via Actions API (`gh run list … && gh run watch <id> --exit-status`). On failure: `gh run view --log-failed` → fix → push → restart Step 1.
- Step 2: Review threads via GraphQL `reviewThreads` + `gh pr view --json comments`. Greptile/Codex P0/P1 → fix → push → restart Step 1. Resolve threads via `resolveReviewThread` mutation. Loop until 0 unresolved.
- Step 3: `local:ztrace` — scenario-by-scenario callstack (happy + edge cases).
- **Step 4 is the orchestrator's, not the subagent's** — explicit "do not call UIAskUserQuestion, do not stop, do not hand back early".

Final report contract: rebase result, CI run id + conclusion, unresolved-thread count (must be 0), greptile/codex P0/P1 disposition, per-scenario ztrace summary.

> **Reference**: `reference/samples/03-zcheck-standard.md` (standard run), `reference/samples/04-zcheck-rerun-with-fix.md` (when prior zcheck dodged a P1 with "intentional design" — rerun must fix).

## Phase 4 — Persuade & Approve

The orchestrator now owns the user dialogue.

1. Build a one-screen briefing per PR using the zcheck report + ztrace summary.
2. `local:UIAskUserQuestion` (template `../UIAskUserQuestion/templates/zcheck-pr-approve.json`). Context: PR URL + issue/epic URL + Step 0–3 results + ztrace scenarios + open follow-ups.
3. Options (rate score visible to encourage discipline):
   - Approve — merge + advance to phase 5.
   - Re-run ztrace — RATE −2.
   - Re-run zcheck from CI — RATE −3.
   - Restart phase 0 — RATE −5.

**Invariants:**
- 0 unresolved review threads required before approve.
- CI failing → no approve request.
- Any code change in 3 → restart Step 1.

## Phase 5 — Merge & Next Group

### 5.1 Merge subagent

Dispatch a **merge driver subagent** (background). Prompt:

- PR URL + branch + base.
- `gh pr merge --squash --delete-branch` (no `--admin`, no self-approve).
- Capture merge commit SHA.
- If next group exists: pull base, recreate worktrees for next group's branches.

### 5.2 Conflict subagent

If the merge subagent reports rebase conflicts that need resolution, dispatch a **separate conflict-resolution subagent** (background) — see `reference/samples/05-rebase-merge-conflict.md`. The orchestrator does not resolve conflicts itself.

### 5.3 Executive summary + es

Dispatch an **es subagent** that generates the bilingual executive summary using `reference/executive-summary-template.md` and posts the user-facing announcement. Output the resulting summary to the user.

### 5.4 Handoff to epic (if applicable)

Per `using-z` §Handoff #2: if Parent Epic URL exists, call `mcp__model-command__run` with `CONTINUE_SESSION`, `resetSession: true`, `forceWorkflow: "z-epic-update"`, embedding the `<z-handoff type="work-complete">` block. Session ends.

If Parent Epic is `none` → end normally; do not emit Handoff #2.

## Phase 5.E — Epic Update (handoff-only entry)

**Reachable only from 0.0 step `work-complete`.** Never from a direct user prompt. Orchestrator's only role here is to dispatch an **epic-update subagent** (background) with:

- Epic URL.
- Completed sub-issue URL + PR URL + merge SHA.
- Behavior-level Summary (no file paths or function names — `using-ha-thinking` discipline).
- Remaining-checklist state.

The subagent posts the comment on the epic, updates the body checklist (`[ ]` → `[x]`), checks the Epic Done gate (`using-epic-tasks` reference), and closes the epic if eligible. **Do not auto-chain to the next sub-issue's Handoff #1** — the user must initiate manually with `$z <next>`.

`es` already fired in phase 5; phase 5.E does not re-emit it.

## Wait Mechanism (Push, not Poll)

- `Agent(run_in_background:true)` → out-of-process subagent → orchestrator's turn ends.
- The system pushes a task-notification when the subagent completes → next user turn re-enters the orchestrator.
- **Forbidden**: `ScheduleWakeup`, foreground `sleep`, retry-loops with `sleep`, polling.
- **Progress estimation**: `stat <output_file>` for mtime/size. Do not `Read` the streaming log — context pollution.
- **External state**: `gh pr/run list` for GitHub state. Always direct API, never local cache assumptions.

## Progress Display (every user-facing turn)

```
Group 1 [▓▓▓▓▓▓▓▓▓▓] ✅ MERGED  Sub-X <commit>
Group 2 [▓▓▓▓▓▓▓▓▓▓] ✅ MERGED
Group 3 [▓▓▓▓▓░░░░░] 🟡 zcheck running (subagent <id>)
Group 4 [░░░░░░░░░░] Pending dependency
```

## Failure Modes & Recovery

| Mode | Recovery |
|---|---|
| Subagent reports incomplete ("proceeding to Step 1" then ends) | Re-dispatch a fresh subagent (or `SendMessage` to continue if appropriate). Orchestrator does **not** finish the work itself. |
| Build / test / clippy fails | Subagent's fix loop; never `--no-verify`, never skip hooks. |
| Branch protection blocks merge | Ask the user for GitHub approve via `UIAskUserQuestion`. Do not try `--admin` workarounds. |
| Force-push dismissed reviews | Re-request approve after dismiss-stale-reviews behavior is confirmed. |
| 401/403 token issue | Try (a) different header (`Bearer` ↔ `token`), (b) alternate env token, (c) raw `curl`, (d) alternate webhook trigger (close+reopen, empty commit, force push), (e) actually fix. Escalate to user only after all five fail. |

## Orchestrator Checklist (gate before `endTurn` to user)

You may only end a turn back to the user when one of these applies:

**Clarification path** — `UIAskUserQuestion` asked, awaiting decision.

**Approve path** — all of:
- 0 P0 / P1 from codex + gemini reviews.
- `stv:verify` clean.
- PR mergeable / merged.
- 0 unresolved review threads.
- CI green.

**Halt path** — Case C, repeated subagent failure beyond decision-gate threshold, or user-initiated stop.

If none apply, dispatch the next phase's subagent — do not stop.

## References

- `reference/samples/epic-orchestrator-pattern.md` — full multi-PR epic orchestration pattern this skill is modeled on.
- `reference/samples/01-zwork-single-area.md` — phase-2 dispatch prompt template, single-stack change.
- `reference/samples/02-zwork-cross-stack.md` — phase-2 dispatch prompt template, cross-stack with wire alignment.
- `reference/samples/03-zcheck-standard.md` — phase-3 dispatch prompt template, standard zcheck run.
- `reference/samples/04-zcheck-rerun-with-fix.md` — phase-3 dispatch prompt template when a prior zcheck dodged a P1.
- `reference/samples/05-rebase-merge-conflict.md` — phase-5 dispatch prompt template for rebase + merge with conflicts.
- `reference/executive-summary-template.md` — phase-5 `es` output template.
- `reference/executive-summary-example.md` — phase-5 `es` worked example.

## Persistent Invariants (orchestrator memory)

1. `ScheduleWakeup` is permanently banned.
2. Every phase delegates to a subagent. The orchestrator's only direct tools are TodoWrite, Agent, UIAskUserQuestion, model-command (for handoff), and read-only state checks (`stat`, `gh pr list`, `gh run list`).
3. After every user turn, self-check current phase against the phase map and TodoWrite state.
4. Additional user instructions arriving mid-flight are evaluated as **new PR candidates** (4-signal check: changed-files area / rollback unit / reviewer / decision coverage). Do not silently fold them into the running phase.
