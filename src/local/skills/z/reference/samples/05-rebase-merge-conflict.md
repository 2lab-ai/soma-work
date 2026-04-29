# Sample 5 — phase-5 dispatch: rebase + merge with conflicts

**Purpose**: template for the orchestrator's `Agent` dispatch when a sibling PR was just merged into the base, and the current PR's worktree may have rebase conflicts on shared files. The orchestrator does **not** resolve conflicts directly — this is fully delegated.

**Subagent type**: `general-purpose`
**`run_in_background`**: `true`

---

Sibling PR `<SIBLING_PR_URL>` was just merged into `<BASE_BRANCH>` at `<merge_sha>`. Rebase PR `<TARGET_PR_URL>` onto the new base, force-push, watch CI, and merge once green and approved.

## Work environment
- Worktree: `<ABSOLUTE_WORKTREE_PATH>`
- Branch: `<BRANCH_NAME>` @ `<current_head_sha>`
- Base: `<BASE_BRANCH>` (just gained `<merge_sha>`)
- ⚠ Both this PR and the sibling touch `<shared/file/path>` — sibling changed production code, this PR adds tests in the same module. Conflict expected.

## Procedure

1. `cd <ABSOLUTE_WORKTREE_PATH>`.
2. `git fetch origin <BASE_BRANCH> --quiet`.
3. `git rebase origin/<BASE_BRANCH>`.
   - **On conflict**:
     - `<shared/file/path>` conflict: place this PR's additions (e.g. new test cases inside `mod tests`) **on top of** the sibling's production changes. Both intents must be preserved. The sibling's code stays; this PR's tests get appended.
     - Other files: read both versions carefully, preserve both intents. Never drop sibling's code; never drop this PR's intent.
   - `git add` resolved files → `git rebase --continue`. Repeat until rebase finishes.
4. `git push --force-with-lease origin <BRANCH_NAME>` (raw `--force` is forbidden — it can clobber concurrent commits from another reviewer).
5. CI watch:
   ```bash
   gh run list --branch <BRANCH_NAME> --repo <ORG>/<REPO> --limit 1 --json status,conclusion,databaseId -q '.[]'
   gh run watch <id> --repo <ORG>/<REPO> --exit-status
   ```
6. CI fail → diagnose → fix → commit + push → restart CI watch.
7. **Pre-merge approval re-check**: `gh pr view <NUM> --repo <ORG>/<REPO> --json reviewDecision,mergeable,state`. If `dismiss_stale_reviews` is enabled, the rebase + force-push may have voided the prior approval. If `reviewDecision != APPROVED`, return a `blocker` with the regression — the orchestrator must route back to phase 4 for a fresh approve. Do **not** merge without `APPROVED`.
8. `reviewDecision == APPROVED` and CI green → `gh pr merge <NUM> --repo <ORG>/<REPO> --squash --delete-branch`.
9. `gh pr view <NUM> --json state,mergeCommit --jq '.'` — confirm `state=MERGED` and capture merge SHA.

## Final report — must use the merge-status discriminated shape (z/SKILL.md §5.2)

The orchestrator's §5.1.a controller branches on a discriminated `{ status: 'MERGED', mergeCommitSha } | { status: 'blocker', detail }` shape — the same shape §5.1's merge subagent uses. **Conform to it exactly** so §5.1.a can route the report identically.

### On success — `status: 'MERGED'`

Return:

- `status`: `MERGED`
- `mergeCommitSha`: the merge commit hash (from `gh pr view --json mergeCommit`).
- `details` (informational, free-form, must NOT cause the controller to re-dispatch the §5.1 merge driver — the conflict subagent has already merged the PR):
  - Rebase outcome (conflict files + how each was resolved).
  - CI run id + final conclusion.
  - Pre-merge `reviewDecision` (APPROVED at the time of merge).
  - `state=MERGED` confirmation.

### On unresolvable blocker — `status: 'blocker'`

Return:

- `status`: `blocker`
- `detail`: a short string identifying the blocker (e.g. `reviewDecision-regressed-after-force-push`, `unresolvable-conflict-on-shared-file`, `ci-fail-after-2-fix-cycles`, `signed-commit-required-no-key`).
- Diagnostic context (free-form): rebase log, CI failure tail, the `gh pr view --json` snapshot.

The orchestrator's §5.2 retry cap (max 2) means a second `blocker` from this subagent triggers `UIAskUserQuestion` escalation — do not loop indefinitely.

## Hard rules
- **Do not stop midway. Do not hand back early.**
- `--force-with-lease` only. Never raw `--force`.
- **Do not** try `gh pr merge --admin` — if the PR is already APPROVED, plain merge works.
- Worktree isolation — never modify the orchestrator's directory or unrelated worktrees.
- Preserve both PRs' intents on shared files. If you cannot, abort and return a `blocker` — do not silently drop changes.
- Bot-token reality: self-merge is fine when `reviewDecision == APPROVED`; without approve, surface the block to the orchestrator via `blocker` instead of fighting it.
- Subagent does **not** call `UIAskUserQuestion` / `decision-gate` UI. Blockers go in the final report.
