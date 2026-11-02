---
name: pr-triage
description: "Use when every open PR of a GitHub repo must end in exactly one of 4 buckets (ready-to-merge / needs-review / close+spec-issue / close-obsolete) with the action taken — evidence-based verdicts, parallel cluster investigation, bold close of rotted PRs, real problems preserved as issues. Triggers: 'pr-triage', 'PR 정리 분류', '열린 PR 트리아지'. Args — <REPO> (required; org/repo or a GitHub repo/pulls URL); [TRACKER] (optional; Jira base URL or github-issues, default github-issues — used only for issue linking and spec preservation). NOT for an approval-gated sweep of PRs, issues, branches and Jira together (chore)."
argument-hint: "<org/repo or repo-url> [tracker-base-url | github-issues]"
---

# pr-triage — Stale/Open PR triage for any repo

## Input
`pr-triage <REPO> [TRACKER]`
- `REPO` — required. `org/repo` or a full GitHub URL (`https://github.com/org/repo` or `.../pulls`). Normalize to `org/repo`.
- `TRACKER` — optional. Jira base URL (e.g. `https://acme.atlassian.net`) or `github-issues` (default). Used only for issue-linking + spec preservation. If a Jira base is given, link/refresh Jira issues instead of GitHub issues where applicable.
- If `REPO` is missing or ambiguous, ask once via `local:UIAskUserQuestion`. Otherwise run autonomously to completion — this is bulk janitorial work, not a per-PR approval loop.

## Goal
Every open PR ends in exactly ONE of 4 buckets, with an action taken. Be decisive; the owner wants rotted PRs boldly closed but real problems preserved as issues.

- ready-to-merge: add label `ready-to-merge`. Mergeable, low-risk, clearly correct, safe after light review.
- needs-review: add label `needs-review` (+context comment). Mergeable & valuable but non-trivial/risky, OR a still-valid fix that conflicts and must be re-cut on current main.
- close + spec issue: close PR; preserve spec as an issue. Code unmergeable/too stale, but the underlying problem is real & valuable.
- close (obsolete): close PR with evidence comment. Already fixed in main, superseded, or invalid.

## Hard rules
1. Evidence-based verdicts only. Every bucket call cites concrete evidence: file paths, commit SHAs, `git grep` results, the superseding PR/commit. No verdict without proof.
2. Detect already-fixed. A conflicting/old PR is often already solved in main a DIFFERENT way. Always check the current tree before deciding — same problem fixed differently = obsolete (close); problem still present = still valuable.
3. Don't duplicate issues. For close+spec, if a tracking issue already exists and is OPEN, do NOT create a duplicate — post a refreshed spec comment on it (why the PR died, how main diverged, what gap remains) and keep it open. Only create a NEW issue when none exists.
4. Bold but reversible. Closing a PR is reversible and preserves the branch; closing is the default for rotted code. Never delete branches; never close the underlying issue unless the direction is truly dead.
5. No `rm`. Use a working-folder trash + `mv` if cleanup is needed.
6. Attribution lines on anything you author follow the session's/repo's commit attribution rule.

## Pipeline

### 0. Preflight
Resolve REPO. Confirm `gh auth status`.

### 1. List + metadata
- `gh pr list --repo $REPO --state open --limit 1000 --json number,title,labels,isDraft,createdAt,headRefName,baseRefName --jq ...`. Do NOT use MCP list_pull_requests — it overflows context. Use gh + jq.
- If the list returns exactly 1000 PRs, stop and report that the repo has more open PRs than one listing returns. Do not triage a truncated list.
- Keep this list of PR numbers: step 6 reconciles against it.
- Per PR: `gh pr view <n> --repo $REPO --json number,mergeable,mergeStateStatus,additions,deletions,changedFiles,baseRefName,createdAt`.
- mergeable=UNKNOWN is lazy-computed; re-poll the UNKNOWN ones once and they resolve to MERGEABLE/CONFLICTING.
- Flag stacked PRs (base != default branch) — they form epic chains. Check base-branch existence via `gh api repos/$REPO/branches/<b>`.

### 2. Clone + history
- Always create a unique working folder using the current timestamp (e.g., `$WORKING_DIR/20260101_1532_projalpha_pr_triage`). Clone the source into that working folder.
  After cloning, you must output the following JSON directive to register the working folder with the session (automatically cleaned up when the session ends):
  `{"type": "source_working_dir", "action": "add", "path": "<absolute path of the created working folder>"}`
- `git log --merges --oneline -60`; note default branch. Ground truth for already-fixed.

### 3. Cluster + parallel investigate
Group PRs into ~5 clusters by shape; dispatch one general-purpose `Agent` (read-only) per cluster IN PARALLEL (single message, multiple Agent calls). Typical clusters: clean small fixes; docs/skills (does it already exist in tree?); conflicting fixes (KEY: already fixed differently?); each stacked epic chain = its own cluster (was the abstraction ever wired in? `git grep`).
Each agent gets the clone path, its PR list+titles, the 4-bucket defs, and returns per-PR `#<n> — BUCKET <x> — <reason>` + 2-3 evidence bullets + spec text for bucket-3. Agents only RECOMMEND; the controller decides and executes.
Stacked epic heuristic: if `git grep` for the PR's new abstractions returns zero source hits, the refactor was never integrated → bucket 3 (close chain, keep issues as living spec), or bucket 4 if main solved it another way.

### 4. Link issues
Find tracking issue via body closing-keywords, branch name, or title. If TRACKER is Jira, resolve `PROJ-\d+` keys (avoid false positives like UTF-8/SHA-256) and read via Jira MCP. Issue state (open/closed) decides bucket-3 handling (refresh vs create).

### 5. Execute
- Create labels `ready-to-merge`/`needs-review` if absent (`gh label create --color ... --force`).
- Bucket 1/2: `gh pr edit <n> --add-label`. For needs-review add a short comment (what to verify / what to re-cut). Cross-reference paired PRs.
- Bucket 4: `gh pr close <n> --comment "<evidence: superseding PR/commit + why obsolete>"`.
- Bucket 3: issue exists+open → `gh issue comment <iss>` refreshed spec, then `gh pr close <n> --comment` pointing to it. No issue → `gh issue create` (NOTE: no `--jq`; capture returned URL from stdout) with a 3-5 sentence spec, then close PR pointing to it.

### 6. Verify + report
- `gh pr list --repo $REPO --state open --limit 1000 --json number,labels`. If it returns exactly 1000 PRs, stop and report the listing as truncated; do not reconcile against it.
- Reconcile by PR number against the step-1 list, not only by counts. Every step-1 PR in bucket 1/2 is still open and carries its label. Every step-1 PR in bucket 3/4 is absent. A number that is not in the step-1 list was opened during the run: list it as not triaged. Then counts reconcile (opened = kept + closed).
- Final Slack-markdown report: per-bucket list, one-line reason each, new issue URLs, working-clone path. Lead with `N open → K kept, M closed`.

## Notes
- Uses the session's GitHub identity. If a write is refused (no permission, App not installed), stop and report; do not switch identity.
- MCP list_pull_requests overflows on large repos — always prefer `gh ... --json ... --jq`.
- Parallel agents doing only gh + git log/grep/show in one shared clone don't conflict.
