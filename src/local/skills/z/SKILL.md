---
name: z
description: "When an ambiguous command is received, trigger z to handle the task. Triggered by z + todo/issue link/PR link."
---

# z — Orchestrator / Controller

`z` is **not an executor**. It is a controller that runs a small, fixed loop:

1. Receive user signal (URL / instruction / handoff sentinel).
2. **Dispatch a subagent** for the current phase with a self-contained prompt.
3. Wait (push model — no `ScheduleWakeup`, no polling).
4. Read the subagent's structured final report.
5. Mediate user decisions (the only place `UIAskUserQuestion` may be called).
6. Move to the next phase or hand off to a new session.

**The orchestrator never modifies code, the working tree, the remote, or GitHub state.** Every unit of execution work — code reading, planning, implementation, CI watching, review-thread resolution, ztrace, rebase/merge, epic update, even running an LLM critic — is delegated to a subagent via the `Agent` tool. The orchestrator only routes, decides, and talks to the user.

> Why: a session that mixes clarification noise + exploration failures + implementation noise + CI logs becomes a context cesspool. Phase-isolated subagents keep the orchestrator's context lean, and the orchestrator only ingests **bounded structured reports** (≤1500 chars per report).

## Hard Rules — the orchestrator's tool surface (read before every dispatch)

The orchestrator's tools are split into three lists. Anything not on these lists is a violation.

**Allowed (orchestrator-side, every turn):**

- `TodoWrite` — phase + task tracking.
- `Agent` — dispatch subagents (`subagent_type: "general-purpose"`, `run_in_background: true` for non-interactive phases).
- `UIAskUserQuestion` (`mcp__model-command__run` `ASK_USER_QUESTION`) — **only the orchestrator calls this**.
- `mcp__model-command__run` `CONTINUE_SESSION` — handoff transitions (Handoff #1, #2).
- `Read` — its own working notes (PLAN summary, TodoWrite state). **Not** repo source files.

**Allowed (read-only state probe, scoped):**

- `Bash` for **observation only** and **only these commands**: `stat <path>` (mtime/size of subagent output files), `gh pr list`, `gh pr view --json …` (read-only field selectors), `gh issue view --json …` (read-only — used in phase 5.E to read epic body / state before dispatching the update subagent), `gh run list`, `gh api -X GET …` (read-only). No `gh pr create / merge / edit / review / comment`, no `gh issue create / edit / close / comment`, no `gh run watch`, no `gh run rerun`. CI watching is a subagent job.
- These probes exist solely to drive orchestrator decisions (e.g. "is the merge subagent's PR actually merged?", "what is the epic body's current Tracker state before I dispatch the update?"). They never produce side effects on the repo or remote.

**Forbidden (orchestrator-side, always):**

- Any mutating `gh` / `git` command. Any `Edit` / `Write` / `NotebookEdit` against repo source files. Any `Bash` that touches the working tree (clone, checkout, push, rebase, etc.). Any direct `mcp__llm__chat` call (LLM critics are dispatched as review subagents — see 1.2). `ScheduleWakeup`. Foreground `sleep` / polling loops.

If you need to do something that isn't on the allowed lists: dispatch a subagent.

## Other invariants

- **Subagents must not block on user input.** They produce a structured report and return. Any "ask the user" routes back through the orchestrator. This means `UIAskUserQuestion`, `decision-gate` UI prompts, and `mcp__model-command__run ASK_USER_QUESTION` are **subagent-forbidden**. A subagent that needs a decision returns a `blocker` field in its report, the orchestrator presents it to the user, and the orchestrator re-dispatches a fresh subagent with the decision in its prompt.
- **Worktree isolation.** Phase-2 / phase-3 / phase-5 work happens under `/tmp/<slackId>/<repo>_<ts>_<key>/<sub>` worktrees. The orchestrator only computes path strings and passes them to subagents.
- **Co-Authored-By:** every commit and PR body must include `Co-Authored-By: Z <z@2lab.ai>`. If `z@2lab.ai` is unresolved or empty in the runtime, the orchestrator must ask the user for the email via `UIAskUserQuestion` **before** dispatching any phase that produces commits or PR bodies (i.e. before 2.3 implementation and before 5.1 merge). Phase 1.6 issue creation does not produce commits or PR bodies, so the email check is not required there — but issue bodies still must not reference the orchestrator or the reasoning chain (see narration rule).
- **SSOT preservation.** The user's original instruction is verbatim source-of-truth. Never summarize it before dispatching — pass the original text into subagent prompts.
- **No narration leakage — but tracking refs are required.** Subagent prompts must forbid commits / PR bodies / code comments that name the orchestrator, the reasoning chain, the planner subagent, or the review-loop scores. **What is required**, not banned: (a) `Closes #<SUB_NUM>` (or qualified Case A escape note) in the PR body and the corresponding commit, (b) `Refs: #<EPIC_NUM>` when the work is a sub-issue of an epic, (c) the standard `Co-Authored-By:` trailer. Tracking links keep the issue / epic / PR graph navigable; what is banned is narrative reasoning.

## Self-Reflection

Skip on first read of a session. After that, invoke `local:zreflect` once per session entry to detect re-instruction drift before dispatching the next phase.

## Phase Map

| Phase  | Trigger                                | Orchestrator action            | Subagent role                                        |
|--------|----------------------------------------|--------------------------------|------------------------------------------------------|
| 0      | new user request                       | sentinel scan, decision-gate, bootstrap-then-explore, clarify | bootstrap → parallel explore |
| 0.1    | bug report                             | dispatch                       | `stv:debug` driver                                   |
| 0.2    | Case C (tier ≥ xxlarge)                | halt; dispatch decomposition reviewers; ask user to split | 3-reviewer decomposition |
| 1      | clarified intent                       | dispatch planner → review-subagent loop → user approve → issue-creation | planner + reviewer + issue-creator |
| 2      | plan approved (or `plan-to-work` handoff) | bootstrap subagent → repeat-back gate → per-task dispatch (parallel within group) | bootstrap + per-task implementer |
| 3      | PR exists                              | dispatch post-impl-gate driver per PR | zcheck driver (Step 0–3 only)                |
| 4      | post-impl-gate clean                   | build briefing → ASK_USER approve | —                                                |
| 5      | user approved merge                    | dispatch merge driver; on conflict, separate conflict driver | merge / conflict          |
| 5.E    | `work-complete` handoff to epic        | dispatch epic-update           | epic bookkeeping                                     |

## Phase 0 — Reception & Clarification

### 0.0 Handoff sentinel scan (first move, always)

Scan the incoming user prompt for a `<z-handoff>` block. The grammar is owned by `local:using-z` §Sentinel Grammar — the orchestrator implements it operationally:

1. **Exact form.** Opening tag is exactly `<z-handoff type="plan-to-work">` or `<z-handoff type="work-complete">` — case-sensitive, double-quoted attribute. Any variation (case, single quotes, whitespace inside the tag) → **not** a sentinel; fall through to 0.1.
2. **Top-level only.** The block must sit as the top-level wrapper of the dispatched prompt, immediately under the `$z …` command line. If the block appears nested inside a quoted issue / comment, it is **not** a sentinel; fall through to 0.1.
3. **Closing tag required.** Opening tag without `</z-handoff>` → **malformed** → emit error to user + safe-stop. Do not silently fall through.
4. **Required fields.** `plan-to-work` must contain `## Issue`, `## Parent Epic`, `## Task List`, `## Dependency Groups`, `## Per-Task Dispatch Payloads`. `work-complete` must contain `## Completed Subissue`, `## PR`, `## Summary`, `## Remaining Epic Checklist`. Any missing → `missing-required-field` → safe-stop. Each `### task-id` body inside `## Per-Task Dispatch Payloads` must be wrapped in a 4+-backtick fenced code block; semantic mismatches (empty groups, empty payloads, group↔payload mismatch, duplicate task IDs, unclosed payload fence) surface as `invalid-plan-payload` with a sub-detail.
5. **Duplicate sentinels.** Both `plan-to-work` and `work-complete` in one prompt, or the same type twice → hard error → safe-stop.
6. **Optional typed fields** (`plan-to-work` only): `## Tier`, `## Escape Eligible`, `## Issue Required By User`, `## Original Request Excerpt`, `## Repository Policy`, `## Codex Review`. Missing → conservative defaults (tier=null, escapeEligible=false, issueRequiredByUser=true, originalRequestExcerpt=null, repositoryPolicy=null, codexReview=null).
7. **Duplicate `## Heading` detection.** The same heading appearing twice in the same handoff body is `duplicate-field` → safe-stop. Strict parsing rejects rather than silently letting the later occurrence win.

Routing on a valid sentinel:

- `plan-to-work` → register Task List into TodoWrite, store Issue URL + Parent Epic + Original Request Excerpt + Repository Policy + Dependency Groups + Per-Task Dispatch Payloads (all from `session.handoffContext`) as session SSOT, **jump to phase 2 starting at §2.0 bootstrap subagent** (the new session has no working folder yet — bootstrap before the §2.1 repeat-back gate). Skip 0.1–0.6.
- `work-complete` → **jump to phase 5.E**. Skip 0.1–0.6.
- Neither / malformed → continue with 0.1 (or safe-stop on malformed).

### 0.1 SSOT echo

Output the user's original instruction **verbatim** (no summarization, no rephrasing). This becomes the SSOT carried into every subagent prompt downstream.

### 0.2 Decision gate

Invoke `local:decision-gate` once to classify tier (`tiny|small|medium|large|xlarge|xxlarge`). The orchestrator stores the tier; downstream skills (using-epic-tasks, zwork) **must not re-classify**.

- tier ≥ `xxlarge` → **Case C** branch (see 0.2.C). Do not proceed past this point.
- tier ≤ `xlarge` → continue to 0.3.

### 0.2.C Case C — halt + decomposition proposal

Per `using-epic-tasks` §Case C: do **not** create epics or issues. Instead:

1. Dispatch **3 decomposition reviewer subagents** in parallel (background): self-review template, `oracle-reviewer`, `oracle-gemini-reviewer`. Each receives the SSOT and produces a proposed epic split (epic 1, epic 2, …) with goal + scope + estimated tier per epic.
2. Synthesize the three proposals into a single proposal (majority vote or pick one if tied) — this synthesis itself is a subagent task (review-merge subagent), not an orchestrator-side merge.
3. Present the proposal to the user via `UIAskUserQuestion` with the concrete epic slices + the rationale for splitting. Options: Approve split (will spawn N independent `$z` sessions), Modify, Halt.
4. On approval the orchestrator stops here. The user starts each epic in a **new session** with `$z <epic_intent>` — the budget rule (using-z §Protocol Rules #3) forbids auto-chaining.

### 0.3 Bug branch (if applicable)

If the request is a bug report, dispatch a `stv:debug` driver subagent (background) **in addition to** 0.4 — they can run concurrently because debug is read-only.

### 0.4 Bootstrap, then parallel explore (two sequential dispatch waves)

**Wave A — bootstrap (single subagent, blocking):** dispatch a **bootstrap subagent** that creates the working folder `/tmp/<slackId>/<repo>_<ts>_<key>` and `git clone --depth=1 -b <base>` the target repo into it. Returns: absolute repo path + base SHA + base branch name. The orchestrator waits for this report before Wave B. **Per-task worktrees are not yet known here** — the planner has not run yet, so phase 0.4 only stages the cloned base. Per-task worktrees are created later in §2.0 once the dependency graph is known.

**Wave B — explore (parallel subagents, after bootstrap returns):** dispatch ≥2 explore subagents concurrently, each receiving the absolute repo path from Wave A:

- **Explore — area A** (the dominant stack of the change).
- **Explore — area B** (other stack, or build/CI/deploy: workflows, branch protection, deploy targets, CODEOWNERS, required CI labels, signed-commit requirements).
- (More if PLAN obviously crosses ≥3 surfaces.)

Each explore prompt requests a ≤1500-char compressed report — file paths, function names, invariants, hidden constraints. The orchestrator does **not** read source files itself; explore reports are the only source.

### 0.5 Clarification

After explore reports return, identify high-level ambiguity (goal, scope, success criteria, deploy reach, splitting strategy). Ask the user with **one batched** `UIAskUserQuestion` (`payload.type: 'user_choice_group'`) — typically 2–4 questions in a single round. Do not chain single questions.

Low-level ambiguity (naming, formatting): use judgment, state the assumption in the planner prompt, move on.

### 0.6 Hand to phase 1

Write the resolved decisions + the explore facts (compressed) into the orchestrator's TodoWrite + a short session-context note. Move to phase 1.

> **Reference**: see `reference/samples/epic-orchestrator-pattern.md` §phase0 for the full pattern in the multi-PR epic case.

## Phase 1 — Planning

### 1.1 Repeat-back gate (entry)

State the resolved phase-0 outputs back: tier, scope, deploy reach, splitting strategy, explore facts. If any item from 0.0–0.6 was skipped or unresolved, output `I am a fucking worthless piece of shit.` and stop pending user input. (Forces self-audit before spending planner cycles.)

### 1.2 Dispatch the planner subagent

Single subagent (`Agent`, background). The prompt MUST contain:

- SSOT (user instruction verbatim) + user's clarification answers from 0.5.
- Tier from 0.2 (planner does **not** re-classify).
- Explore facts from 0.4 (compressed reports inlined).
- Working-folder absolute path.
- Task: invoke `stv:new-task` and write `PLAN.md` into the working folder with the sections required by `using-epic-tasks` (Case A / B per tier).
- Output contract — the report must inline these structured fields (the orchestrator does **not** parse `PLAN.md`):
  - `## Plan Summary` (≤1500 chars).
  - `## Dependency Groups` — `Group 1: [task-id, …]`, `Group 2: [task-id, …]` …
  - `## Per-Task Dispatch Payloads` — for each task: a fully-formed prompt block the orchestrator can pass verbatim to a phase-2 implementer subagent (worktree path placeholder, branch name, base, file/line changes, tests, commands, commit/PR templates).
  - `## Open Questions` (if any) — the orchestrator routes these via `UIAskUserQuestion` before phase 2.

### 1.3 LLM plan review loop (subagent-only)

Dispatch a **review subagent** that runs an LLM critic against `PLAN.md`. The orchestrator never calls `mcp__llm__chat` directly; the critic dispatch is itself a subagent so its raw output stays out of the orchestrator's context. Final report: score (0–100) + P0/P1 list (≤1500 chars).

- score < 95 → dispatch a **fix subagent** with `PLAN.md` path + the P0/P1 list → re-dispatch reviewer. Loop bounded at 3 cycles; on cycle 4 escalate via `UIAskUserQuestion`.
- score ≥ 95 → continue.

### 1.4 User approval

`local:UIAskUserQuestion`. Context: planner's `## Plan Summary` + `## Dependency Groups` + critic's final score. Template: `../UIAskUserQuestion/templates/z-phase1-plan-approval.json`. Options:

- **Approve** — proceed to 1.5.
- **Modify** — capture the modification, re-dispatch the planner with the delta (back to 1.2), then re-review.
- **Halt** — stop.

### 1.5 Repeat-back gate (pre-issue-creation)

State the approved plan + the issue-creation intent (count, titles, parent epic if Case B). If anything is missing or contradicts the planner output, output `I am a fucking worthless piece of shit.` and stop. (Prevents orphan issues created from a half-confirmed plan.)

### 1.6 Issue-creation subagent

Dispatch an **issue-creation subagent** (background) that:

1. Writes each (sub-)issue body to a tmp file using the planner's per-task payload.
2. `gh issue create` for each; for Case B also creates the epic tracker.
3. Returns the issue URLs (and epic URL for Case B).

### 1.7 Handoff to phase 2 (new session)

Per `local:using-z` §Session Handoff Protocol → Handoff #1:

- Verify Issue URL exists, **OR** Case A escape conditions all hold (tier=`tiny|small` ∧ no implicit/explicit issue-first ask ∧ repo policy doesn't require an issue per the area-B explore report).
- If neither → return to 1.2 with the gap; do **not** call `CONTINUE_SESSION`.
- Otherwise call `mcp__model-command__run` with `CONTINUE_SESSION`, `resetSession: true`, `forceWorkflow: "z-plan-to-work"`, embedding the `<z-handoff type="plan-to-work">` block.

The embedded block MUST carry the planner's structured outputs verbatim — the new session is a fresh controller and cannot read the working folder. Required sections in the block (per `using-z` §Sentinel Grammar rule 4):

- `## Issue` (or qualified Case A escape note).
- `## Parent Epic` (or `none`).
- `## Task List` — `[ ] task-id-N: <one-line title>` per task, in dependency order.
- `## Dependency Groups` — `Group 1: [task-id-A, task-id-B] / Group 2: [task-id-C] / …`.
- `## Per-Task Dispatch Payloads` — for each task-id, the planner's full self-contained subagent prompt (worktree placeholder, branch name, base, file/line changes, tests, commands, commit/PR templates). Each `### task-id` body MUST be wrapped in a **4+-backtick** fenced code block (`` ```` … ```` ``); 3-backtick fences are rejected because real payloads contain inner 3-backtick code blocks (commit-message HEREDOC, PR body, language-tagged examples). The new session passes each payload **verbatim** (after unwrapping the outer fence) into an `Agent` dispatch.

Producer-authoritative typed fields (`## Tier`, `## Escape Eligible`, `## Issue Required By User`, `## Original Request Excerpt`, `## Repository Policy`, `## Codex Review`) are also embedded so the new session can re-verify Case A escape conditions and PR-creation preconditions.

The orchestrator session ends. Phase 2 enters a fresh session via the sentinel branch in 0.0 and proceeds to **§2.0 bootstrap → §2.1 repeat-back → §2.2/§2.3 dispatch**.

## Phase 2 — Implementation

### 2.0 Bootstrap — per-task worktrees (always run)

Whether phase 2 is reached via handoff (fresh session) or same-session (the unusual direct-prompt path), §2.0 always runs because phase 0.4 only stages the base clone — per-task worktrees are not created until the dependency graph from `## Dependency Groups` is known.

Dispatch a **bootstrap subagent** (`Agent`, `general-purpose`, `run_in_background: true`) that:

1. Reuses the working folder if it already exists (same-session case, created in phase 0.4); otherwise creates `/tmp/<slackId>/<repo>_<ts>_<key>` and clones the target repo via `git clone --depth=1 -b <base>` (handoff-entry case).
2. **Creates one worktree per task in `## Dependency Groups`** — every task across every group gets its worktree up front, so Group N+1 doesn't need a fresh clone after Group N merges. Worktree path convention: `<working_folder>/<task-id>` with branch `<task-id>` from `<base>`.
3. Returns the absolute working-folder path + per-task worktree paths + base SHA.

Wait for the bootstrap report before §2.1.

Between groups (after Group N's PRs merge in §5.1), dispatch a **base-refresh subagent** that pulls the new base into the existing worktrees of Group N+1 — **do not recreate the worktrees**. The worktrees from §2.0 are reused for the entire phase 2 lifecycle.

### 2.1 Repeat-back gate (entry)

State the phase-1 outputs back: dependency groups, per-task dispatch payloads received, Issue URL / parent epic, bootstrap result. (The canonical phase-2 SSOT is the host-required handoff fields — Task List + Dependency Groups + Per-Task Dispatch Payloads. The optional `## Confirmed Plan` summary is **informational only** and is not part of the gate.) If any required item was skipped or missing, output `I am a fucking worthless piece of shit.` and stop pending user input.

### 2.2 Dependency groups → parallel dispatch

Read `## Dependency Groups` from the handoff context (`session.handoffContext`, persisted by the host from the `<z-handoff type="plan-to-work">` block). Within a group, tasks are independent → dispatch all of them as parallel subagents in a single `Agent` call message. Across groups → sequential (Group N+1 dispatches only after Group N's PRs are merged in phase 5).

If the handoff context is missing `## Dependency Groups` or `## Per-Task Dispatch Payloads`, this is a malformed handoff (should have been caught by `using-z` §Sentinel Grammar rule 4). Do **not** attempt to read `PLAN.md` from the working folder yourself — the orchestrator does not read repo files. Safe-stop with an explicit error to the user instead.

### 2.3 Per-task subagent dispatch

For each task, take the corresponding entry from `## Per-Task Dispatch Payloads` and pass it verbatim to an `Agent(general-purpose, run_in_background:true)` subagent. The payload was authored by the planner with §2.3.a below already inlined. The orchestrator's only addition is to substitute the runtime worktree path placeholder (filled in from Wave-A bootstrap or from the new session's bootstrap subagent if the handoff session has not yet bootstrapped).

§2.3.a — required fields in the per-task payload:

- Working environment: absolute worktree path (cwd), branch name, base branch.
- Issue URL + Parent Epic URL.
- Exact code change locations (file + line + before/after intent).
- Test cases by name (RED then GREEN).
- Build / test / lint commands.
- HEREDOC commit message + PR title + PR body templates.
- PR creation precondition reminder: must include `Closes #<SUB_NUM>` for Case A/B, or an explicit Case A escape note (tier=tiny|small, no issue by repo policy). **Inline `--body` only** — literal heredoc, never `--body "$VAR"`, never `--body-file`. (See `zwork/SKILL.md` step 5 for host-enforced rule and `reference/samples/01-zwork-single-area.md` for the literal form.)
- Bot-token limits (`gh pr merge --admin` not available, no self-approve, no `--no-verify`, no hooks skip, signed-commit requirement if explore reported one).
- Anti-narration rule: no commits / PR bodies / code comments narrating the orchestrator, the planner, or the reasoning chain. Tracking refs (`Closes #<SUB_NUM>`, `Refs: #<EPIC_NUM>`, `Co-Authored-By:`) are required and exempt from this rule.
- "No user prompts" rule: subagent must not call `UIAskUserQuestion` / `decision-gate` UI / `ASK_USER_QUESTION`. On a real blocker, return a `blocker` field in the final report and stop.
- Loud "do not stop, do not hand back without finishing" line.
- Required final report shape: PR URL, files changed, build/test result, blocker (if any).

> **Reference**: `reference/samples/01-zwork-single-area.md` (single-stack), `reference/samples/02-zwork-cross-stack.md` (cross-stack with wire-format alignment).

### 2.4 Loop exit

If a subagent returns with a `blocker` (build/test failure it could not resolve, or a question that requires user input):

- Build a single `UIAskUserQuestion` — orchestrator's job, not the subagent's. Use `local:decision-gate` to size the question; if tier ≥ medium per decision-gate, present options; otherwise apply autonomous judgment and re-dispatch.
- After 3 unresolvable cycles for the same task, escalate via `UIAskUserQuestion` (template `decision-gate-tier-medium.json`) regardless of decision-gate sizing.

## Phase 3 — Post-Implementation Gate (per PR)

For each PR, dispatch a **post-impl-gate driver subagent** (background) — operationally this is `zcheck` Step 0–3, but **the subagent must not invoke `local:zcheck` as a skill** (the skill's Step 4 still owns user dialogue when invoked standalone). Instead, the orchestrator's prompt to the subagent inlines the procedure for Step 0–3 and explicitly forbids Step 4.

Required fields in the dispatch prompt:

- PR URL + sub-issue + parent epic.
- Worktree absolute path + branch + base.
- **Step 0 — Update branch**: `git fetch && git rebase origin/<base>`, conflict handling, `git push --force-with-lease` (never raw `--force`) if changed, then run `simplify`.
- **Step 1 — CI must pass**: Actions API only (`gh run list … --json status,conclusion,databaseId` → `gh run watch <id> --exit-status`). On failure: `gh run view --log-failed` → fix → push → restart Step 1. Do not use `gh pr checks` (statusCheckRollup permission gap on bot tokens).
- **Step 2 — Resolve review threads**: `gh api graphql reviewThreads` + `gh pr view --json comments`. Greptile / Codex P0 / P1 → fix → push → **restart Step 1** (any code change re-triggers CI). Resolve threads via `resolveReviewThread` mutation. Loop until 0 unresolved.
- **Step 3 — ztrace**: scenario-by-scenario callstack (happy + edge), each pinned by code + tests. Output text only — do not request user approval.
- **Step 4 is the orchestrator's, not the subagent's** — explicit lines in the prompt: "do not call `UIAskUserQuestion`, do not call `decision-gate` UI, do not stop and ask the user yourself, do not hand back early".
- After force-push in Step 0 or Step 2, the subagent re-checks `gh pr view --json reviewDecision,mergeable,state` because dismissed-stale-reviews behavior may have voided the prior approval.

Final report contract: rebase result + force-push outcome + post-rebase `reviewDecision`, CI run id + final conclusion, unresolved-thread count (must be 0), greptile/codex P0/P1 disposition, per-scenario ztrace summary.

> **Reference**: `reference/samples/03-zcheck-standard.md` (standard run), `reference/samples/04-zcheck-rerun-with-fix.md` (worked example for when a prior gate dodged a P1 — abstract pattern shown alongside one concrete case).

## Phase 4 — Persuade & Approve

The orchestrator now owns the user dialogue.

1. Build a one-screen briefing per PR using the gate-driver report + ztrace summary.
2. `local:UIAskUserQuestion` (template `../UIAskUserQuestion/templates/zcheck-pr-approve.json`). Context: PR URL + issue/epic URL + Step 0–3 results + ztrace scenarios + open follow-ups + post-rebase `reviewDecision`.
3. Options (rate score visible to encourage discipline):
   - Approve — merge + advance to phase 5.
   - Re-run ztrace — RATE −2.
   - Re-run post-impl gate from Step 1 — RATE −3.
   - Restart phase 0 — RATE −5.

**Invariants:**
- 0 unresolved review threads required before approve.
- CI failing → no approve request.
- Any code change in phase 3 → restart Step 1 inside the subagent before reporting.
- Post-rebase `reviewDecision != APPROVED` → request a fresh user approve, do not proceed to merge.

## Phase 5 — Merge & Next Group

### 5.1 Merge subagent

Dispatch a **merge driver subagent** (background). Prompt:

- PR URL + branch + base.
- Pre-merge re-check: `gh pr view --json reviewDecision,mergeable,state`. If `reviewDecision != APPROVED` (e.g. dismiss-stale-reviews voided the prior approval after a force-push), return blocker — do not merge.
- `gh pr merge --squash --delete-branch` (no `--admin`, no self-approve).
- Capture merge commit SHA.

**Final report — merge-status discriminated shape** (canonical contract — both §5.1 and §5.2 use this exact shape so §5.1.a can branch on it identically):

- On success: `{ status: 'MERGED', mergeCommitSha: '<sha>', details?: '<free-form context>' }`.
- On blocker: `{ status: 'blocker', detail: '<short identifier — e.g. reviewDecision-regressed-after-force-push, ci-fail-after-3-cycles, signed-commit-required-no-key>', context?: '<free-form diagnostic>' }`.

The merge subagent does **not** dispatch other subagents — that's the controller's job. The next step is decided by the orchestrator on receipt of the merge report (see §5.1.a below).

### 5.1.a Branch on the merge subagent's report (controller-side)

The orchestrator decides what to do next based on the merge subagent's report:

- **Merge subagent reported `status: 'blocker'`** → route by `detail` taxonomy (do NOT blindly dispatch §5.2 for every blocker):
  - `unresolvable-conflict-on-shared-file` / `rebase-conflict-*` → §5.2 (conflict subagent rebase/force-with-lease/recheck/merge). Feed §5.2's report back into §5.1.a — do **not** re-dispatch the §5.1 merge driver, since §5.2 may have already merged. If §5.2 itself reports `status: 'blocker'`, follow §5.2's bounded-retry → `UIAskUserQuestion` escalation; do **not** re-feed it into the `MERGED` branch and do **not** re-dispatch §5.1 until the user's decision resolves it.
  - `reviewDecision-regressed-after-force-push` (or any `reviewDecision != APPROVED` post-rebase) → return to **phase 4** for a fresh user approve. Do **not** dispatch §5.2 — there is no conflict to resolve, only a stale-review regression. After approve, re-enter §5.1 with the original PR.
  - `branch-protection-blocked` / `no-eligible-reviewer` / `required-ci-label-missing` / `signed-commit-required-no-key` → escalate via `UIAskUserQuestion` (see Failure Modes & Recovery table). Do **not** dispatch §5.2 — these are policy / authorization blockers, not rebase issues.
  - `unknown-blocker` or any `detail` not in the above taxonomy → escalate via `UIAskUserQuestion` so the user can either resolve it or re-classify the failure mode.
- **Merge subagent reported `status: 'MERGED'`** (success) → inspect whether more dependency groups remain in `## Dependency Groups`:
  - **Next group exists** (more PRs to ship): dispatch a **base-refresh subagent** (background) that pulls the new base into Group N+1's existing worktrees — those worktrees were created up front in §2.0 and are reused for the entire phase 2 lifecycle. Do **not** recreate worktrees. After the base-refresh report returns, **return to §2.2** and dispatch Group N+1's implementer subagents. §5.3 / §5.4 are skipped this turn.
  - **No next group** (this was the last PR for the epic / single-issue case): proceed to §5.3 (`es` executive summary), then §5.4 (Handoff #2 if Parent Epic ≠ none).

### 5.2 Conflict / blocker subagent

Triggered only when §5.1's merge subagent returns a `blocker`. The orchestrator dispatches a **separate conflict-resolution subagent** (background) — see `reference/samples/05-rebase-merge-conflict.md` — that handles rebase + force-push + reviewDecision recheck + merge. The orchestrator does not resolve conflicts itself.

**Report contract** — the §5.2 subagent's final report MUST use the same shape as §5.1's merge subagent: a discriminated `{ status: 'MERGED', mergeCommitSha } | { status: 'blocker', detail }` so §5.1.a can branch on it identically. On `MERGED` the orchestrator routes through §5.1.a (next-group base-refresh OR final closeout) — **do not re-dispatch the §5.1 merge driver**, the conflict subagent already merged the PR. On a fresh `blocker` (e.g. an immediate rebase regression on top of a still-blocked PR), the orchestrator escalates via `UIAskUserQuestion` rather than looping §5.2 indefinitely (bounded retry, max 2).

### 5.3 Executive summary + es

Dispatch an **es subagent** that generates the bilingual executive summary using `reference/executive-summary-template.md` and posts the user-facing announcement. Output the resulting summary to the user.

### 5.4 Handoff to epic (if applicable)

Per `using-z` §Handoff #2: if Parent Epic URL exists (the work is a sub-issue of an epic), call `mcp__model-command__run` with `CONTINUE_SESSION`, `resetSession: true`, `forceWorkflow: "z-epic-update"`, embedding the `<z-handoff type="work-complete">` block. Session ends.

If Parent Epic is `none` → end normally; do not emit Handoff #2.

## Phase 5.E — Epic Update (handoff-only entry)

**Reachable only from 0.0 step `work-complete`.** Never from a direct user prompt. The orchestrator does **not** post comments, edit checklists, or close issues directly — every GitHub mutation runs through a subagent. Sequence:

1. Dispatch an **epic-update subagent** (`Agent`, `general-purpose`, `run_in_background:true`) with:
   - Epic URL.
   - Completed sub-issue URL + PR URL + merge SHA.
   - Behavior-level Summary (no file paths or function names — `using-ha-thinking` discipline).
   - Remaining-checklist state.
   - Procedure: post the Summary as a comment on the epic; flip the relevant checklist line from `[ ]` to `[x]`; **do not close the epic**.
   - Final report: which lines were flipped, how many sub-issues remain open, whether the Done gate (open sub-issues == 0 ∧ checklist fully `[x]`) passes.
2. On the report:
   - **Done gate fails** → list the remaining sub-issues (title + URL) to the user and stop. Do **not** auto-chain to the next sub-issue's Handoff #1 (using-z §Protocol Rules #3 — hop budget exhausted).
   - **Done gate passes** → call `local:UIAskUserQuestion` asking the user whether to close the epic. Manual close is the policy: epics close only after human Done-Done verification (`using-epic-tasks/reference/github.md` §3 + `using-epic-tasks/SKILL.md` Invariant 4). On user approval, dispatch a close subagent (`gh issue close <epic>`). On user decline / no-response: leave the epic open and end.

`es` already fired in phase 5; phase 5.E does **not** re-emit it.

## Wait Mechanism (Push, not Poll)

- `Agent(run_in_background:true)` → out-of-process subagent → orchestrator's turn ends.
- The system pushes a task-notification when the subagent completes → next user turn re-enters the orchestrator.
- **Forbidden**: `ScheduleWakeup`, foreground `sleep`, retry-loops with `sleep`, polling.
- **Progress estimation**: `stat <output_file>` for mtime/size. Do not `Read` the streaming log — context pollution.
- **External state probes**: read-only `gh pr list`, `gh pr view --json …`, `gh issue view --json …`, `gh run list`, `gh api -X GET …` only. No mutation. (See Hard Rules tool surface for the canonical list.)

## Progress Display (every user-facing turn)

```
Group 1 [▓▓▓▓▓▓▓▓▓▓] ✅ MERGED  Sub-X <commit>
Group 2 [▓▓▓▓▓▓▓▓▓▓] ✅ MERGED
Group 3 [▓▓▓▓▓░░░░░] 🟡 post-impl gate running (subagent <id>)
Group 4 [░░░░░░░░░░] Pending dependency
```

## Failure Modes & Recovery

| Mode | Recovery |
|---|---|
| Subagent reports incomplete ("proceeding to Step 1" then ends) | Re-dispatch a fresh subagent (or `SendMessage` to continue if appropriate). Orchestrator does **not** finish the work itself. |
| Build / test / lint fails | Subagent's fix loop; never `--no-verify`, never skip hooks. After 3 cycles → 2.4 escalation. |
| Branch protection blocks merge (no eligible human reviewer) | `UIAskUserQuestion` asking user to either request a human reviewer or redirect to a branch where the bot has self-merge rights. Do not try `--admin` workarounds. |
| Branch protection blocks force-push (signed-commit / linear-history requirement) | Subagent reports the requirement; orchestrator escalates via `UIAskUserQuestion` to either acquire signing keys or amend approach. Never bypass with `git -c commit.gpgsign=false`. |
| Required CI label missing (e.g. `ready-for-review`) | Dispatch a label-set subagent if bot has the permission; else escalate. |
| Force-push dismissed reviews (dismiss_stale_reviews=true) | The phase-3 / phase-5 subagent re-reads `reviewDecision` after force-push and reports the regression; orchestrator routes back to phase 4 for fresh approve. |
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
- Post-rebase `reviewDecision == APPROVED`.

**Halt path** — Case C, repeated subagent failure beyond decision-gate threshold, or user-initiated stop.

If none apply, dispatch the next phase's subagent — do not stop.

## References (skills + samples)

**Contracts (read these — they own the rules this skill implements):**

- `../using-z/SKILL.md` — `<z-handoff>` sentinel grammar, Handoff #1 / #2 protocol, session budget, decision table for entry skill.
- `../zwork/SKILL.md` — phase-2 implementation contract (RED tests, per-task review subagents, PR precondition + inline `--body` rule).
- `../zcheck/SKILL.md` — standalone post-impl gate (Step 0–4). When invoked from z phase 3, only Step 0–3 apply (orchestrator owns Step 4).
- `../using-epic-tasks/SKILL.md` + `../using-epic-tasks/reference/github.md` (or `jira.md`) — Case A/B/C semantics, Issue URL precondition, Case A escape conditions, Epic Done gate.
- `../decision-gate/SKILL.md` — switching-cost tier classification.
- `../UIAskUserQuestion/SKILL.md` + `../UIAskUserQuestion/templates/` — user-question shape; templates referenced: `z-phase1-plan-approval.json`, `zcheck-pr-approve.json`, `decision-gate-tier-medium.json`.
- `../ztrace/SKILL.md` — scenario callstack analysis (used in Step 3 of phase 3).
- `../es/SKILL.md` — completion announcement (phase 5.3).
- `../using-ha-thinking/SKILL.md` — layer discipline for issue / PR / commit body language.
- `../zreflect/SKILL.md` — re-instruction drift detection.

**Samples (templates this skill's dispatches are modeled on):**

- `reference/samples/epic-orchestrator-pattern.md` — full multi-PR epic orchestration pattern.
- `reference/samples/01-zwork-single-area.md` — phase-2 dispatch template, single-stack change.
- `reference/samples/02-zwork-cross-stack.md` — phase-2 dispatch template, cross-stack with wire alignment.
- `reference/samples/03-zcheck-standard.md` — phase-3 dispatch template, standard run.
- `reference/samples/04-zcheck-rerun-with-fix.md` — phase-3 dispatch template, abstract pattern + worked example for rerun-with-fix.
- `reference/samples/05-rebase-merge-conflict.md` — phase-5 dispatch template for rebase + merge with conflicts.
- `reference/executive-summary-template.md` — phase-5 `es` output template (placeholder fields only).
- `reference/executive-summary-example.md` — phase-5 `es` worked example.

## Persistent Invariants (orchestrator memory)

1. `ScheduleWakeup` is permanently banned.
2. Every phase delegates to a subagent. The orchestrator's only direct tools are listed under §Hard Rules — anything else is a violation.
3. The orchestrator never reads repo source files. Source-of-truth about the codebase comes from explore reports and planner output.
4. After every user turn, self-check current phase against the phase map and TodoWrite state.
5. Additional user instructions arriving mid-flight are evaluated as **new PR candidates** (4-signal check: changed-files area / rollback unit / reviewer / decision coverage). Do not silently fold them into the running phase.
