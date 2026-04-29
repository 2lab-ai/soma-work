# Sample 1 — phase-2 dispatch: zwork (single-area implementation)

**Purpose**: template for the orchestrator's per-task `Agent` dispatch when a sub-task touches a single stack with no upstream/downstream wire alignment. The variables in `<…>` are filled by the orchestrator from PLAN.md.

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
5. `git add` changed files + `git commit` (HEREDOC):

```
[<TICKET_KEY>] <SUB_KEY>: <one-line title>

<2–4 line behavior-level description — what changes, why, scope boundary.
No file paths / function names; that lives in the PR diff.>

Refs: #<SUB_NUM>, #<EPIC_NUM>

Co-Authored-By: Z <z@2lab.ai>
```

6. `git push -u origin <BRANCH_NAME>`
7. `gh pr create --repo <ORG>/<REPO> --base <BASE_BRANCH> --title "[<TICKET_KEY>] <SUB_KEY>: <one-line title>" --body-file <(cat <<'EOF'
## Summary
- <bullet 1 — behavior change>
- <bullet 2 — behavior change>
- <bullet 3 — invariants preserved>

## Refs
- Sub-issue: #<SUB_NUM>
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

## Hard rules
- Build / test failure → fix and retry. **Never** `--no-verify`, **never** skip hooks.
- Commit message must include `Refs: #<SUB_NUM>, #<EPIC_NUM>`.
- PR title format `[<TICKET_KEY>] <SUB_KEY>: …` (PR-guard checks the ticket key prefix).
- PR description must include `## Summary` and `## Test plan` (PR template).
- Do **not** commit comments narrating the epic / orchestrator reasoning.
- Bot token cannot `gh pr merge --admin` and cannot self-approve — do not try.
- Do not stop midway. Do not return without a PR URL.

## Final report (when done)
- PR URL.
- Files changed.
- Build result (warning delta vs. baseline).
- Test result (counts + names of new tests).
- Any blockers or decisions that need user input.
