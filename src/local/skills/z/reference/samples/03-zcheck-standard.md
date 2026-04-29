# Sample 3 — phase-3 dispatch: zcheck (standard run)

**Purpose**: template for the orchestrator's `Agent` dispatch when running zcheck on a PR for the first time. The subagent runs Step 0–3 and reports back; **Step 4 (user approve dialogue) belongs to the orchestrator and is explicitly skipped here**.

**Subagent type**: `general-purpose`
**`run_in_background`**: `true`

---

You will run zcheck Step 0–3 on PR `<PR_URL>` end-to-end. **Do not stop midway. Do not hand back to the orchestrator before all steps complete.**

## Target
- PR: `<PR_URL>`
- Sub-issue: `<SUB_ISSUE_URL>` / Parent epic: `<EPIC_URL>`
- Worktree: `<ABSOLUTE_WORKTREE_PATH>`
- Branch: `<BRANCH_NAME>`
- Base: `<BASE_BRANCH>`

## Procedure

### Step 0: Update branch
1. `cd <ABSOLUTE_WORKTREE_PATH>`.
2. `git fetch origin <BASE_BRANCH> --quiet`.
3. `git rebase origin/<BASE_BRANCH>` — handle conflicts inline (preserve both intents; never drop the PR's changes).
4. If rebase produced changes: `git push --force-with-lease origin <BRANCH_NAME>` (raw `--force` is forbidden — it can clobber concurrent commits from another reviewer).
5. After force-push, re-read `gh pr view <NUM> --repo <ORG>/<REPO> --json reviewDecision,mergeable,state` — `dismiss_stale_reviews` may have voided the prior approval. Carry the post-rebase `reviewDecision` into the final report so the orchestrator can route back to phase 4 if needed.
6. **simplify**: `git diff origin/<BASE_BRANCH>... > "$TMPDIR/<SUB_KEY>-zcheck.diff"` and audit for reuse / quality / efficiency hard-blockers. Fix in this PR. Push narration / chore comments to a follow-up.

### Step 1: CI must pass

`gh pr checks` is forbidden — bot tokens lack the GraphQL `statusCheckRollup` permission. Use Actions API:

```bash
gh run list --branch <BRANCH_NAME> --repo <ORG>/<REPO> --limit 3 --json status,conclusion,databaseId -q '.[]'
```

- `in_progress` → `gh run watch <id> --repo <ORG>/<REPO> --exit-status`.
- `failure` → `gh run view <id> --log-failed` → fix → push → restart Step 1.
- `success` → continue.

### Step 2: Resolve PR review threads

```bash
gh api graphql -f query='query { repository(owner:"<ORG>",name:"<REPO>"){ pullRequest(number:<NUM>){ reviewThreads(first:30){ nodes { isResolved comments(first:3){ nodes { author{login} body }}}}}}}'
gh pr view <NUM> --repo <ORG>/<REPO> --json comments --jq '.comments[] | {author: .author.login, body: (.body[0:300])}'
```

- Unresolved threads → handle. Greptile / Codex P0 / P1 → fix → commit + push → **restart Step 1** (any code change re-triggers CI).
- Loop until 0 unresolved.
- Resolve threads via `resolveReviewThread` mutation.

### Step 3: ztrace

Trace the PR's changes by scenario. For each scenario, give the callstack and the invariants pinned by tests + code. Cover:

- Happy-path scenario(s).
- Pre-DB-mutation rejection paths (e.g. "no agent for role" → BadRequest before mutation).
- Post-mutation defensive paths (e.g. lifecycle-missing → 5xx with clear log).
- Logging-masking / secret-redaction scenarios when the PR touches sensitive data.

Each scenario: trigger → entry method → key calls → terminal state. ≤1500 chars total.

### Step 4 (skip)

The orchestrator owns the user-facing approve dialogue. Do **not** call `UIAskUserQuestion`. Do **not** stop and ask the user yourself. Just complete Step 0–3 and report.

## Final report
- Step 0: rebase outcome + simplify findings.
- Step 1: CI run id + final conclusion (`success`).
- Step 2: unresolved-thread count (must be 0); per-thread disposition (fix vs. reply-only).
- Step 3: per-scenario ztrace summary.
- `mergeable` / `state` / `reviewDecision` from `gh pr view`.
- Blockers (if any).

## Hard rules
- **Do not stop midway. Do not hand back early.**
- Worktree isolation — never modify the orchestrator's directory.
- Bot token: cannot `gh pr merge --admin`, cannot self-approve.
- Scope discipline: this PR's work only; out-of-scope follow-ups go in a separate sub-issue, not appended here.
