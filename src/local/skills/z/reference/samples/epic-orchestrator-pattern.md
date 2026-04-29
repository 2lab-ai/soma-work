# Epic Orchestrator Pattern — Multi-Sub-Issue + Multi-PR

This is the reference pattern that `local:z` follows in its xlarge-tier mode (epic with multiple sub-issues, multiple PRs, dependency graph). The same controller discipline applies to smaller tiers — strip the multi-PR plumbing but keep the "controller dispatches subagents" rule.

## Trigger
A GitHub epic issue URL where the body already contains Sub-A/B/C decomposition + dependency graph, and the user says "process from start to finish" or equivalent.

## Your Role: Controller (NOT Executor)
- No direct code / git / CI work.
- All execution → subagent (`Agent`, `general-purpose`, `run_in_background:true`).
- This session = dispatch + monitor + user dialogue + decision processing.
- Avoid context blow-up: subagents return a final report only; details stay in their worktree.

## Tool Rules
- `Agent` (`run_in_background:true`) — subagent dispatch.
- Worktree isolation — `git worktree add -b <branch> ../<dir> <base>`.
- **`ScheduleWakeup` is forbidden.** It does not return.
- `gh` CLI — issue / PR / run / api graphql.
- `mcp__llm__chat` (gemini / codex) — plan review.
- `mcp__model-command__run` `ASK_USER_QUESTION` — user decision.

## phase 0 — Reception & Clarification
1. SSOT preserved: emit user instruction + epic body verbatim.
2. Fetch epic body (`gh issue view <num> --json body --jq .body`).
3. Working folder: `/tmp/<slackId>/<repo>_<ts>_<epicNum>` + `git clone --depth=1 -b <base>` for the base.
4. Resolve ambiguity — typically 3 decision points:
   - Split unit (sub-issue × N PR vs. grouped PR vs. single PR).
   - Scope end (code merge / dev2 canary / prod rollout).
   - Optional sub-task disposition (implement / follow-up / skip).
   Ask via `ASK_USER_QUESTION` with `payload.type: 'user_choice_group'` (one batch, multiple questions).
5. Code-location validation — dispatch 3 explore subagents in parallel (`run_in_background:true`):
   - Area A specialist (e.g. C# admin).
   - Area B specialist (e.g. Rust agent).
   - Build / deploy / CI environment (workflows, branch protection, deploy targets).
   Each report ≤1500 chars compressed.
6. Compile facts not in the issue body — pre-existing DB columns, enum wire format, CI mandates, CODEOWNERS.

## phase 1 — Plan
1. Write `PLAN.md` (in working dir) — sections:
   - SSOT + user decisions.
   - Deliverables (sub-issue count, PR count, deploy scope).
   - Dependency graph → parallel groups (Group 1..N).
   - Explore findings — supplements / corrections to the issue body.
   - Per-sub draft body (location, change, tests, branch, PR title, deps).
   - Phase 2 dispatch flow (which group runs in parallel).
   - CI pass criteria.
   - Rollback unit.
   - Open questions / risks.
2. `mcp__llm__chat` (gemini or codex) review → score + P0/P1.
3. Score < 95 → fix P0/P1 → re-review (loop).
4. `ASK_USER_QUESTION` (single user_choice) for plan approval. Options:
   - Approve → create sub-issues on GitHub + dispatch Group 1.
   - Modify → capture delta, re-run planner.
   - Halt → stop.

## phase 1.4 — Sub-issue creation + Epic Tracker
1. Each sub-issue body → `/tmp/sub-X.md` (inline the PLAN.md sub section).
2. `gh issue create` for N+1 (N implementation + 1 follow-up).
3. Epic body update — Tracker section prefixed:
   - Per-sub checkbox + dependency group marker.
   - `gh issue edit <num> --body-file <merged>`.

## phase 2 — Implementation Dispatch (per group)

### Worktree isolation per group
- `cd <repo> && git checkout <base> && git pull origin <base> --ff-only`.
- `git worktree add -b <branch> ../sub-<letter> <base>` per sub.

### Subagent dispatch (1 agent per sub, `run_in_background:true`)
The prompt MUST contain:
- Worktree absolute path (cwd isolation).
- Branch name + base.
- Sub-issue URL + parent epic.
- Exact code change locations (file + line + intent).
- Test cases by name.
- Build / test / clippy commands.
- HEREDOC commit message + PR title + PR body templates.
- Loud "do not stop, do not hand back without finishing".
- "Do not embed narration comments (epic ref, sub id) in code".
- Bot-token limits (no `--admin`, no self-approve).

### Within-group parallel, across-group sequential
- Group 1 (entry, deps=0): dispatch all subs concurrently.
- Group N+1: dispatch only after Group N is merged (pull base → recreate worktrees).

## phase 3 — zcheck (per PR)

### Standard zcheck subagent (Step 0–3; Step 4 is the orchestrator's)
- Step 0: `cd worktree` → fetch → `git rebase origin/<base>` → resolve conflicts → force-push if changed → simplify (reuse / quality / efficiency hard-blockers; split narration to follow-up).
- Step 1: CI watch — `gh run list` → latest run id → `gh run watch <id> --exit-status`. Failed → `gh run view <id> --log-failed` → fix → push → restart.
- Step 2: review threads — `gh api graphql reviewThreads` + `gh pr view --json comments`. Greptile / codex P0/P1 → fix → push → restart Step 1. Resolve threads via `resolveReviewThread` mutation.
- Step 3: ztrace — per-scenario callstack (happy + edge) — invariants pinned by code + tests.
- Step 4 SKIP — orchestrator handles user dialogue.

### Core invariants
- Loop until 0 unresolved.
- No approve request while CI failing.
- Any code change → restart Step 1.

## phase 4 — User Approve

Per PR, `ASK_USER_QUESTION` (user_choice). Context:
- PR URL + sub-issue + parent epic.
- Step 0–3 results (✅ / ⚠ / ❌).
- Key ztrace scenario summary.
- Fixes applied (greptile / codex P0/P1 disposition).
- Next step (next group dispatch or epic close).

Options (4):
- 1: approved → merge + advance (RATE +1).
- 2: re-run ztrace (RATE −2).
- 3: zcheck from Step 1 (RATE −3).
- 4: halt / restart (RATE −5).

## phase 5 — Merge & Next Group

### On user "1":
- `gh pr merge <num> --squash --delete-branch` (no `--admin`).
- Capture merge commit SHA (epic Tracker update).
- Create next group's worktrees (pull base → `git worktree add`).
- Dispatch next group.

### Conflict handling:
- Rebase conflict → delegate to a separate subagent (rebase + force-push + CI watch + merge).
- Orchestrator does **not** resolve conflicts directly.

## phase 5.E — Epic Update (close gated by user)
1. Epic body Tracker update:
   - Merged subs: `[x]` + merge SHA.
   - Open PR subs: `[ ] PR #NNN OPEN`.
   - Progress section (X merged / Y open).
   - Dependency groups marked ✅ / 🟡.
2. Add epic comment — merge order, deliverable summary, next step.
3. Close only on explicit user instruction.

## Progress Display (after every user turn)

```
Group 1 [▓▓▓▓▓▓▓▓▓▓] ✅ MERGED  Sub-X <commit>
Group 2 [▓▓▓▓▓▓▓▓▓▓] ✅ MERGED
Group 3 [▓▓▓▓▓░░░░░] 🟡 zcheck running (subagent <id>)
Group 4 [░░░░░░░░░░] Pending dependency
```

## Wait Mechanism (Push)
- `Agent(run_in_background:true)` → out-of-process subagent → orchestrator turn ends.
- System pushes task-notification → new turn re-enters orchestrator.
- No `ScheduleWakeup` / `sleep` / polling.
- Progress estimation: `stat <output_file>` mtime + size (no `Read` — context pollution).
- External state: `gh pr/run list` for GitHub.

## Failure Modes & Recovery
- Subagent reports incomplete ("Proceeding to Step 1" then ends) → fresh subagent (or `SendMessage` continuation). Orchestrator does NOT finish the work itself.
- Build failure → subagent fix loop; no `--no-verify`, no hooks skip.
- Branch protection BLOCKED → user GitHub approve (no `--admin` workaround).
- Force-push dismissed reviews → confirm and re-request approve.

## Memory Rules (durable)
- `ScheduleWakeup` permanently banned.
- Per-PR zcheck / impl / CI fix → always subagent (orchestrator = controller only).
- Self-check phase + TodoWrite after every user turn.
- New mid-flight instructions = new PR candidates (4-signal: file area / rollback unit / reviewer / decision coverage).

## Deliverables (epic complete)
- N PRs merged (dependency-ordered, each PR independently revertible).
- DB schema migration count = 0 when pre-existing columns suffice.
- Follow-up sub-issue (out-of-scope items).
- Rollout docs (dev2 deploy + canary verification + rollback + prod feature-flag plan).
- Epic Tracker updated (commit SHAs).
- Session-memory rules added (apply to next epic).
