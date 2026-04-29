# Sample 1 — phase-2 dispatch: zwork (single-area implementation)

**Purpose**: template for the orchestrator's per-task `Agent` dispatch when a sub-task touches a single stack with no upstream/downstream wire alignment. The variables in `<…>` are filled by the **planner subagent** (phase 1.2) and carried into the new session via `<z-handoff type="plan-to-work">` `## Per-Task Dispatch Payloads`. The orchestrator never reads `PLAN.md` — the handoff payload is the only carrier.

> **Carrier wrapping**: the body below (everything from "You will complete sub-task…" down to "Final report") is the planner-authored subagent prompt. When the planner emits the handoff block, this entire body is wrapped in a **4+-backtick** fenced code block (`` ```` … ```` ``) under `### <taskId>`. Four backticks (not three) because the body itself contains inner triple-backtick code blocks for the commit-message HEREDOC and the `gh pr create --body` heredoc — a 3-backtick outer fence would be terminated by the first inner block and the rest of the prompt would silently spill out. Once the new session unwraps the 4-tick fence, the prompt is passed verbatim to the implementer `Agent` dispatch with the inner 3-tick blocks intact.

**Subagent type**: `general-purpose`
**`run_in_background`**: `true`

---

You will complete sub-task `<SUB_KEY>` of epic `<EPIC_NUM>` end-to-end. Result = a merge-ready PR.

## Work environment
- **cwd (worktree)**: `<ABSOLUTE_WORKTREE_PATH>`
- **branch**: `<BRANCH_NAME>` (already branched from `<BASE_BRANCH>`)
- **base**: `<BASE_BRANCH>` (origin/`<ORG>`/`<REPO>`)

## Sub-issue
- URL: `<SUB_ISSUE_URL>`
- Parent epic: `<EPIC_URL>`

## Changes (exact)

### 1. `<file/path/A.ext>`
- `<func/symbol>` (`:<line range>`): `<remove / replace / add>` — `<intent in one sentence>`.
- Preserve `<symbol B>` — used by `<future sub-task>`.
- Notes on adjacent invariants the change must respect.

### 2. Tests
- Modify: `<existing test file>` — `<assertion to remove/update and why>`.
- Add (N cases):
  - `<TestName_1>` — `<what it pins>`.
  - `<TestName_2>` — `<what it pins>`.

## Procedure

1. `cd <ABSOLUTE_WORKTREE_PATH>`
2. Apply changes per §1 + §2.
3. Build: `<build command>` — must stay at-or-below the warning baseline.
4. Test: `<test command>` — all green.
5. `git add` changed files + `git commit` with the **HEREDOC literal** (Co-Author email must already be resolved by the orchestrator before dispatch — if `z@2lab.ai` is empty, abort and return a blocker):

```bash
git commit -m "$(cat <<'EOF'
[<TICKET_KEY>] <SUB_KEY>: <one-line title>

<2–4 line behavior-level description — what changes, why, scope boundary.
No file paths / function names; that lives in the PR diff.>

Closes #<SUB_NUM>
Refs: #<EPIC_NUM>

Co-Authored-By: Z <z@2lab.ai>
EOF
)"
```

6. `git push -u origin <BRANCH_NAME>`
7. PR creation — **inline `--body` literal heredoc only**. Never `--body-file`, never `--body "$VAR"` (host pre-tool guard rejects shell-variable indirection because the static check cannot see the runtime value):

```bash
gh pr create --repo <ORG>/<REPO> --base <BASE_BRANCH> \
  --title "[<TICKET_KEY>] <SUB_KEY>: <one-line title>" \
  --body "$(cat <<'EOF'
## Summary
- <bullet 1 — behavior change>
- <bullet 2 — behavior change>
- <bullet 3 — invariants preserved>

## Refs
- Closes #<SUB_NUM>
- Parent epic: #<EPIC_NUM>
- Dependency: <none / Group X subs>

## Test plan
- [x] <build command> green
- [x] <existing test file> updated assertions
- [x] new: `<TestName_1>`
- [x] new: `<TestName_2>`

## Risks / Rollback
- Rollback unit: revert this PR.
- Dependency PRs: <none / list>. Solo revert is <safe / requires X first>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Z <z@2lab.ai>
EOF
)"
```

> **Case A escape variant** (only when tier=tiny|small ∧ no implicit/explicit issue-first ask ∧ repo policy does not require an issue): replace `Closes #<SUB_NUM>` in both the commit message and PR body with the literal note `Case A escape (tier=tiny|small, no issue by policy)`. Do not omit the line — host PR-guard requires either form.

## Hard rules
- Build / test failure → fix and retry. **Never** `--no-verify`, **never** skip hooks.
- Commit message and PR body must include either `Closes #<SUB_NUM>` (Case A/B) or the literal Case A escape note. The host PR-issue-guard rejects PRs missing both.
- PR title format `[<TICKET_KEY>] <SUB_KEY>: …` (PR-guard checks the ticket-key prefix).
- PR description must include `## Summary` and `## Test plan` (PR template).
- Co-Author email is non-negotiable. The orchestrator confirms `z@2lab.ai` resolves before dispatch; if your prompt arrives without a confirmed email, return a `blocker` field instead of guessing.
- Do **not** commit comments narrating the epic / orchestrator reasoning.
- Bot token cannot `gh pr merge --admin` and cannot self-approve — do not try.
- Subagent does **not** call `UIAskUserQuestion` / `decision-gate` UI. On a real blocker, return a `blocker` field in the final report.
- Do not stop midway. Do not return without a PR URL.

## Final report (when done)
- PR URL.
- Files changed.
- Build result (warning delta vs. baseline).
- Test result (counts + names of new tests).
- Any blockers or decisions that need user input.
