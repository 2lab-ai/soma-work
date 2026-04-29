# Epic Orchestrator Pattern — Multi-Sub-Issue + Multi-PR

This is the reference pattern that `local:z` follows in its xlarge-tier mode (Case B — epic with multiple sub-issues, multiple PRs, dependency graph). The same controller discipline applies to smaller tiers — strip the multi-PR plumbing but keep the "controller dispatches subagents" rule.

> **Reading order:** read `local:z` SKILL.md and `local:using-z` SKILL.md first; this file shows the orchestration shape, not the contracts.

## Trigger
A GitHub epic issue URL where the body already contains Sub-A/B/C decomposition + dependency graph, and the user says "process from start to finish" or equivalent.

## Your Role: Controller (NOT executor)

The orchestrator session has the constrained tool surface defined in `z/SKILL.md` §Hard Rules:

- Allowed: `TodoWrite`, `Agent`, `UIAskUserQuestion`, `mcp__model-command__run` `CONTINUE_SESSION`, read-only `Read` of orchestrator-side notes.
- Allowed read-only state probe: `Bash` for `stat <path>`, `gh pr list`, `gh pr view --json …`, `gh issue view --json …`, `gh run list`, `gh api -X GET …`. **No mutating commands.**
- Forbidden: any mutating `gh` / `git`, `Edit` / `Write` against repo files, direct `mcp__llm__chat`, `ScheduleWakeup`, foreground sleep / polling.

Anything that touches code, the working tree, the remote, or GitHub state is a **subagent dispatch**, not an orchestrator action.

## phase 0 — Reception & Clarification

1. **SSOT preserved**: emit user instruction + epic body verbatim. (To pull the epic body, dispatch a small **epic-fetch subagent** that runs `gh issue view <num> --json body --jq .body` and returns the body text — the orchestrator does not run `gh` itself unless the call is read-only and minimal; a fetch subagent keeps the discipline uniform.)
2. **Bootstrap (Wave A — single subagent, blocking)**: dispatch a bootstrap subagent that creates `/tmp/<slackId>/<repo>_<ts>_<epicNum>` and `git clone --depth=1 -b <base>` the target repo into it. Returns: absolute repo path + base SHA + base branch name.
3. **Resolve ambiguity** (orchestrator-side dialogue) — typically 3 decision points:
   - Split unit (sub-issue × N PR vs. grouped PR vs. single PR).
   - Scope end (code merge / staging deploy / prod rollout).
   - Optional sub-task disposition (implement / follow-up / skip).
   Ask via `ASK_USER_QUESTION` with `payload.type: 'user_choice_group'` (one batch, multiple questions).
4. **Code-location validation (Wave B — parallel explore subagents, after Wave A returns)** — dispatch ≥3 explore subagents concurrently (`run_in_background: true`):
   - Area A specialist (the dominant stack of the change).
   - Area B specialist (the other stack).
   - Build / deploy / CI environment (workflows, branch protection, deploy targets, CODEOWNERS, required CI labels, signed-commit requirements).
   Each report ≤1500 chars compressed.
5. **Compile facts not in the issue body** — pre-existing DB columns, enum wire format, CI mandates, CODEOWNERS, branch-protection rules, signed-commit policies. The orchestrator's session never reads source files; the explore reports are the only source.

## phase 1 — Plan

1. **Dispatch the planner subagent** with: SSOT, tier from decision-gate, clarification answers, explore reports, working-folder absolute path. Planner writes `PLAN.md` in the working folder and returns a structured report containing `## Plan Summary`, `## Dependency Groups`, `## Per-Task Dispatch Payloads` (one per sub-task), `## Open Questions`. The orchestrator never reads `PLAN.md` itself — the report's structured fields are the only carrier.
2. **Dispatch a review subagent** that runs an LLM critic against `PLAN.md` and returns a score + P0/P1 list. (The orchestrator does not call `mcp__llm__chat` directly — wrapping it in a subagent keeps the critic's raw output out of the orchestrator's context.)
3. Score < 95 → dispatch a fix subagent with the P0/P1 list → re-review. Bound at 3 cycles; on cycle 4 escalate via `UIAskUserQuestion`.
4. `ASK_USER_QUESTION` (single user_choice) for plan approval. Options: Approve, Modify (capture delta, re-dispatch planner), Halt.

## phase 1.4 — Sub-issue creation + Epic Tracker

Dispatch an **issue-creation subagent** (background) that:

1. Writes each sub-issue body to a tmp file using the planner's per-task payload.
2. `gh issue create` for each (N implementation + 1 follow-up if applicable).
3. Creates / updates the epic tracker — Tracker section prefixed in the epic body with per-sub checkboxes + dependency-group markers.
4. Returns the sub-issue URLs and the epic URL.

## phase 1.7 — Handoff to phase 2

The orchestrator emits `<z-handoff type="plan-to-work">` per `using-z` §Handoff #1 with the planner's structured outputs (`## Dependency Groups`, `## Per-Task Dispatch Payloads`) carried inline so the next session can dispatch without re-reading `PLAN.md`. `forceWorkflow: "z-plan-to-work"`. Current session ends.

## phase 2 — Implementation Dispatch (per group, in the new session)

The new session enters z phase 2 controller semantics (per `z-plan-to-work.prompt`). It dispatches implementer subagents — it does **not** become an implementer.

### Worktree isolation

The phase-2 controller dispatches a **bootstrap subagent (z phase 2.0)** as the first step of the new session. It creates the working folder, clones the repo at the resolved base, and creates the per-task worktrees for **every** task in `## Dependency Groups` up front (one worktree per task, not just for Group 1). This matches `z/SKILL.md` §2.0 — handoff sessions enter without a working folder, so a single bootstrap covers all groups before §2.1 repeat-back.

Between groups (after Group N's PRs merge in phase 5), the controller dispatches a small **base-refresh subagent** that pulls the new base into the existing worktrees so Group N+1's tasks rebase cleanly. It does not recreate the worktrees from scratch.

The orchestrator never runs `git` itself in either step.

### Implementer subagent dispatch (1 agent per sub, `run_in_background: true`)

The phase-2 controller passes each `## Per-Task Dispatch Payloads` entry verbatim to an `Agent(general-purpose, run_in_background:true)`. Each payload (authored by the planner in phase 1) contains:

- Worktree absolute path (cwd isolation).
- Branch name + base.
- Sub-issue URL + parent epic.
- Exact code change locations (file + line + intent).
- Test cases by name.
- Build / test / clippy commands.
- HEREDOC commit message + PR title + PR body templates.
- "Do not stop, do not hand back without finishing" line.
- "No narrative comments referencing the orchestrator / epic / reasoning chain — but `Closes #<SUB_NUM>` and `Refs: #<EPIC_NUM>` ARE required" rule.
- Bot-token limits (no `--admin`, no self-approve, no `--no-verify`, no signed-commit bypass).
- "No `UIAskUserQuestion` / `decision-gate` UI — return a `blocker` field on real blockers" rule.

### Within-group parallel, across-group sequential

- Group 1 (entry, deps=0): dispatch all subs concurrently in a single `Agent` call message.
- Group N+1: dispatched only after Group N's PRs are merged in phase 5 (controller dispatches a base-refresh subagent to pull the new base into the existing Group N+1 worktrees, then dispatches Group N+1's implementers).

## phase 3 — Post-Impl Gate (per PR)

The phase-2 controller dispatches a **post-impl-gate driver subagent** per PR (background). The dispatch prompt inlines the procedure (do **not** invoke `local:zcheck` as a same-session skill — that skill's standalone Step 4 owns user dialogue, which conflicts with orchestrator-mode):

- Step 0: `cd worktree` → fetch → `git rebase origin/<base>` → resolve conflicts → `git push --force-with-lease` if changed (raw `--force` forbidden) → re-read `gh pr view --json reviewDecision,mergeable,state` (dismiss-stale-reviews regression check) → simplify (reuse / quality / efficiency hard-blockers; split narration to follow-up).
- Step 1: CI watch — `gh run list` → latest run id → `gh run watch <id> --exit-status`. Failed → `gh run view <id> --log-failed` → fix → push → restart Step 1.
- Step 2: review threads — `gh api graphql reviewThreads` + `gh pr view --json comments`. Greptile / Codex P0 / P1 → fix → push → restart Step 1. Resolve threads via `resolveReviewThread` mutation.
- Step 3: ztrace — per-scenario callstack (happy + edge) — invariants pinned by code + tests. **Output to report, do not call `UIAskUserQuestion`.**
- **Step 4 SKIP** — orchestrator handles user dialogue (phase 4 below).

### Core invariants

- Loop until 0 unresolved threads.
- No approve request while CI failing.
- Any code change → restart Step 1.
- Post-rebase `reviewDecision != APPROVED` → return blocker; orchestrator routes back to phase 4 for fresh approve.

## phase 4 — User Approve

**Orchestrator-side**, per PR. `ASK_USER_QUESTION` (user_choice). Context:

- PR URL + sub-issue + parent epic.
- Step 0–3 results (✅ / ⚠ / ❌).
- Key ztrace scenario summary.
- Fixes applied (greptile / codex P0/P1 disposition).
- Post-rebase `reviewDecision`.
- Next step (next group dispatch or epic close question).

Options (4):
- 1: approved → merge + advance (RATE +1).
- 2: re-run ztrace (RATE −2).
- 3: post-impl gate from Step 1 (RATE −3).
- 4: halt / restart (RATE −5).

## phase 5 — Merge & Next Group

### On user "1":

Dispatch a **merge driver subagent** (background) that:

- Pre-merge re-checks `gh pr view --json reviewDecision,mergeable,state`. If `reviewDecision != APPROVED` (e.g. dismiss-stale-reviews voided the prior approval after a force-push), returns a blocker — the orchestrator routes back to phase 4.
- `gh pr merge <num> --squash --delete-branch` (no `--admin`).
- Captures merge commit SHA (epic Tracker update).
- After merge, the controller dispatches a **base-refresh subagent** to pull the new base into the next group's existing worktrees (created up front by the bootstrap subagent).

The orchestrator then dispatches Group N+1's implementer subagents (back to phase 2).

### Conflict handling:

- Rebase conflict → dispatch a separate conflict-resolution subagent (rebase + force-with-lease + CI watch + reviewDecision recheck + merge). See `05-rebase-merge-conflict.md`.
- The conflict subagent's final report **must use the same merge-status discriminated shape** as the §5.1 merge subagent: `{ status: 'MERGED', mergeCommitSha } | { status: 'blocker', detail }`. The controller routes its report through §5.1.a exactly as it would the §5.1 merge subagent's — **do not re-dispatch §5.1's merge driver** when §5.2 already returns `MERGED`.
- Orchestrator does **not** resolve conflicts directly. Bounded retry: max 2 §5.2 dispatches per PR; a second `blocker` triggers `UIAskUserQuestion` escalation.

## phase 5.E — Epic Update (handoff-only entry; manual close)

Reachable only via `<z-handoff type="work-complete">` from a phase-5 work session. The orchestrator-side bookkeeping is via subagent only:

1. Dispatch an **epic-update subagent**:
   - Epic body Tracker update — merged subs `[x]` + merge SHA, open subs `[ ] PR #NNN OPEN`, progress section, dependency-group markers ✅ / 🟡.
   - Epic comment — merge order, deliverable summary, next step.
   - **Do not close the epic.**
   - Final report: lines flipped, open sub-issue count, Done gate (open == 0 ∧ checklist fully `[x]`) — pass / fail.
2. **Manual close policy** (`using-epic-tasks/reference/github.md` §3 + SKILL.md Invariant 4):
   - Done gate fails → list remaining sub-issues to user, stop.
   - Done gate passes → `UIAskUserQuestion` asking the user whether to close. On approval, dispatch a close subagent. Auto-close is forbidden — epics close only after human Done-Done verification.

## Progress Display (after every user turn)

```
Group 1 [▓▓▓▓▓▓▓▓▓▓] ✅ MERGED  Sub-X <commit>
Group 2 [▓▓▓▓▓▓▓▓▓▓] ✅ MERGED
Group 3 [▓▓▓▓▓░░░░░] 🟡 post-impl gate running (subagent <id>)
Group 4 [░░░░░░░░░░] Pending dependency
```

## Wait Mechanism (Push)

- `Agent(run_in_background:true)` → out-of-process subagent → orchestrator turn ends.
- System pushes task-notification → new turn re-enters orchestrator.
- No `ScheduleWakeup` / `sleep` / polling.
- Progress estimation: read-only `stat <output_file>` mtime + size (no `Read` of streaming logs — context pollution).
- External state: read-only `gh pr list / gh pr view --json … / gh issue view --json … / gh run list / gh api -X GET …` only.

## Failure Modes & Recovery

- Subagent reports incomplete ("Proceeding to Step 1" then ends) → fresh subagent (or `SendMessage` continuation). Orchestrator does NOT finish the work itself.
- Build / test / lint failure → subagent fix loop; no `--no-verify`, no hooks skip.
- Branch protection BLOCKED (no eligible reviewer / required CI label / signed-commits) → orchestrator routes via `UIAskUserQuestion`; do not try `--admin` or `-c commit.gpgsign=false` workarounds.
- Force-push dismissed reviews → phase-3 / phase-5 subagent re-reads `reviewDecision` after force-push and reports the regression; orchestrator routes back to phase 4 for fresh approve before merge.
- 401 / 403 token issue → try header swap (`Bearer` ↔ `token`), alternate env token, raw `curl`, alternate trigger path, then real fix. Escalate to user only after all five fail.

## Memory Rules (durable)

- `ScheduleWakeup` permanently banned.
- Per-PR post-impl gate / impl / CI fix / merge → always subagent (orchestrator = controller only).
- Self-check phase + TodoWrite after every user turn.
- New mid-flight instructions = new PR candidates (4-signal: file area / rollback unit / reviewer / decision coverage).

## Deliverables (epic complete)

- N PRs merged (dependency-ordered, each PR independently revertible).
- DB schema migration count = 0 when pre-existing columns suffice.
- Follow-up sub-issue (out-of-scope items).
- Rollout docs (deploy procedure + canary verification + rollback + prod feature-flag plan, per the deployment surface the area-B explore reported).
- Epic Tracker updated (commit SHAs).
- Session-memory rules added (apply to next epic).
