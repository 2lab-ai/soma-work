---
name: pr-triage
description: "Survey open PRs in 2lab-ai/soma-work, classify by stale/CI/review state, auto-label, and recommend (never execute) destructive actions. Triggered by: pr-triage, pr 정리, stale pr, pr cleanup, triage prs, 오래된 pr 정리, 오래된 pr 정리해줘."
argument-hint: "[--dry-run]"
allowed-tools: Bash, Read, Grep, Glob
---

# pr-triage — Stale PR cleanup for soma-work

Survey open PRs, classify them, auto-label safe states (`stale` / `rotten` / `needs-rebase` / `needs-ci-fix`), and emit a Slack-friendly markdown report with **recommended** actions. Destructive actions (close / merge / rebase / comment) are **never** executed automatically — humans decide from the report.

## Scope (hard-coded)

- Repo: `2lab-ai/soma-work` only.
- Open PRs only. Issues are out of scope.

## Input

**Arguments:** `$ARGUMENTS`

| Flag | Default | Effect |
|------|---------|--------|
| `--dry-run` | off | Compute classification + report, but skip every label mutation. Use for first-time testing on a fresh repo. |

If you ever need to extend scope to another repo, **stop and ask the user** — do not edit this skill silently.

## Tier policy (stale / rotten thresholds)

Stale clock is the number of days since **last real activity**. *Rotten* is the next escalation tier; do not auto-close — only recommend.

| Category | Detection | Stale | Rotten |
|----------|-----------|-------|--------|
| **draft** | `isDraft=true` | 7d | 14d |
| **ready** (no approval, no changes-requested) | `isDraft=false`, `reviewDecision` ∈ {`REVIEW_REQUIRED`, null} | 14d | 30d |
| **approved** | `reviewDecision=APPROVED` AND `mergeable=MERGEABLE` AND latest CI run conclusion ∈ {`success`, null-but-no-required-checks} | 5d | 10d |
| **failing-CI** | latest CI run conclusion ∈ {`failure`, `cancelled`, `timed_out`} | 7d | 14d |

A PR can match multiple tiers (e.g. failing-CI + draft); use the **most-specific** tier in this priority order: `failing-CI` > `approved` > `draft` > `ready`.

## Activity timestamp (CRITICAL — do not use `updatedAt`)

`pr.updatedAt` from `gh pr list` is mutated by *any* PR-metadata change including label additions, milestone changes, reviewer assignments. Using it as the stale clock means **this skill resets the clock the moment it labels a PR** — self-defeating.

Compute `lastActivityAt` per PR as the maximum of:

1. `pr.headRefOid` commit date (`pushedAt`-equivalent) — `gh api repos/2lab-ai/soma-work/commits/<sha> --jq '.commit.committer.date'`. In practice fetch via the PR-list `commits(last:1)` GraphQL field below to avoid an extra round-trip per PR.
2. Latest **issue** comment timestamp (general PR conversation).
3. Latest **review** comment timestamp (line comments).
4. Latest **review submission** timestamp (Approve / Changes-requested / Comment review events).

Do not include label-change events, milestone changes, or assignee changes.

Time math: all timestamps are ISO-8601 UTC. Compute `ageDays = (now - lastActivityAt) / 86400000` in UTC; do not localize.

## Workflow

### 1. Parse arguments

Extract `--dry-run` flag from `$ARGUMENTS`. No positional args.

### 2. Ensure required labels exist (skip if `--dry-run`)

Required labels: `stale`, `rotten`, `needs-rebase`, `needs-ci-fix`, plus exemption labels `keep-open`, `pinned`.

```bash
EXISTING=$(gh label list --repo 2lab-ai/soma-work --limit 200 --json name --jq '[.[].name]')
for L in stale rotten needs-rebase needs-ci-fix keep-open pinned; do
  case "$EXISTING" in
    *"\"$L\""*) ;;
    *) gh label create "$L" --repo 2lab-ai/soma-work --color <see-table> --description "<see-table>" ;;
  esac
done
```

| Label | Color | Description |
|-------|-------|-------------|
| `stale` | `cccccc` | No activity beyond category threshold |
| `rotten` | `b60205` | No activity beyond rotten threshold — close candidate |
| `needs-rebase` | `fbca04` | `mergeStateStatus=BEHIND` — base branch advanced |
| `needs-ci-fix` | `e99695` | CI failing for >3 days |
| `keep-open` | `0e8a16` | Triage exemption — never mark stale |
| `pinned` | `5319e7` | Triage exemption (long-lived feature branches, RFCs) |

### 3. Discover open PRs (single GraphQL roundtrip)

Prefer one GraphQL query that fetches everything needed; falling back to `gh pr list --json` is acceptable but costs more roundtrips.

```bash
# Requires gh ≥ 2.40 for --slurp. --paginate alone emits concatenated JSON
# (NDJSON-ish) which JSON.parse rejects on >1 page; --slurp wraps the pages
# into a real JSON array which classify-prs.ts auto-detects.
gh api graphql --paginate --slurp -F endCursor=null -f query='
  query($endCursor: String) {
    repository(owner: "2lab-ai", name: "soma-work") {
      pullRequests(states: OPEN, first: 100, after: $endCursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title isDraft mergeable mergeStateStatus
          baseRefName headRefName
          reviewDecision
          author { login ... on User { login } ... on Bot { login } }
          createdAt
          labels(first: 30) { nodes { name } }
          commits(last: 1) { nodes { commit { committedDate } } }
          comments(last: 1) { nodes { createdAt } }
          reviews(last: 1) { nodes { submittedAt } }
          latestReviews(last: 1) { nodes { submittedAt } }
        }
      }
    }
  }' > prs.json
```

Notes:
- `--paginate` requires the variable name to be exactly `$endCursor` and the query must expose `pageInfo { hasNextPage endCursor }`. Renaming either breaks pagination.
- If the local `gh` is older than 2.40 (no `--slurp`), pipe through `jq -s` instead: `gh api graphql --paginate -f query='...' | jq -s '.' > prs.json`.
- Cap total processed at 200 PRs; if the repo ever exceeds that, stop and emit a warning (do not silently truncate).
- `pr.updatedAt` is intentionally NOT requested — its mutation behavior is incompatible with the stale-clock contract (see classify-prs.ts §"Activity timestamp").

### 4. Per-PR enrich: CI status

`gh pr checks` is **forbidden** (the bot token lacks the GraphQL `statusCheckRollup` permission — confirmed in `zcheck/SKILL.md:22`). Use Actions API per PR:

```bash
gh run list --branch "<head>" --repo 2lab-ai/soma-work --limit 1 \
  --json status,conclusion,databaseId,createdAt -q '.[0]'
```

Possible outcomes:
- Empty array `[]` → **No CI yet**: brand-new PR, workflow disabled, or branch has never run. Treat as a separate category — do **not** classify as approved-green or failing.
- `status="completed", conclusion="success"` → green
- `status="in_progress" | "queued"` → in-flight
- `status="completed", conclusion ∈ {"failure","cancelled","timed_out","action_required"}` → red

Run these CI lookups in parallel (xargs `-P` or background jobs); cap concurrency at 8 to stay polite.

**Assemble the per-PR CI map.** The `classify-prs.ts` script expects a single JSON object keyed by PR number string (`{ "383": {...}, "417": {...} }`), not N separate files. After fanning out the per-PR CI lookups, fold them into one map:

```bash
mkdir -p .pr-triage-tmp
for n in $(jq -r '[.[].data.repository.pullRequests.nodes[].number] | .[]' prs.json); do
  head=$(jq -r --argjson n "$n" '[.[].data.repository.pullRequests.nodes[]] | map(select(.number==$n)) | .[0].headRefName' prs.json)
  gh run list --branch "$head" --repo 2lab-ai/soma-work --limit 1 \
    --json status,conclusion,databaseId,createdAt -q '.[0] // {}' \
    > ".pr-triage-tmp/ci-$n.json" &
  # Throttle to 8 concurrent backgrounds (works in bash 4+).
  while (( $(jobs -rp | wc -l) >= 8 )); do wait -n; done
done
wait
jq -s 'reduce range(0; length) as $i ({}; . + {(($n[$i] // ""))})' .pr-triage-tmp/ci-*.json > /dev/null  # placeholder; see below
# Simpler assembly using filenames:
jq -n 'reduce inputs as $r ({}; . + ({(input_filename | capture("ci-(?<n>[0-9]+)\\.json").n): $r}))' \
  .pr-triage-tmp/ci-*.json > ci-by-num.json
```

The `ci-by-num.json` shape is `{"<pr_number>": { status, conclusion, databaseId, createdAt }, ...}`. An empty per-PR object `{}` is treated by classify-prs.ts as "No CI yet"; do not omit the key entirely — keep the PR present with an empty value so the script can distinguish "queried, none found" from "not queried at all".

### 5. Classify each PR

Canonical decision tree lives in `scripts/classify-prs.ts` (`classifyOne` + `pickAgeBucket` + `TIER_CATS` / `READY_MAP` / `CATEGORY_LABELS`). The TypeScript is the source of truth; this prose summary exists for human readers and stays at *summary* depth so the two cannot drift on details.

Summary of the decision flow (run in this order):

1. **Exemption first.** `keep-open` / `pinned` label → category `exempt`. Skip everything else.
2. **Tier selection** (most-specific wins): `failing-CI` (CI red) → `approved` (APPROVED + MERGEABLE + CI not red) → `draft` (`isDraft=true`) → `ready` (everything else; further split by `reviewDecision` into `awaiting-review` vs `changes-requested`).
3. **Age bucket** for that tier: `rotten` (≥ rotten threshold) > `stale` (≥ stale threshold) > `active`. Thresholds per tier are in §"Tier policy".
4. **Single-condition overrides** (only when the tier put the PR in `active`, never overriding stale/rotten — those are more informative): `mergeable=CONFLICTING` & age ≥ 3d → `conflicted`; `mergeStateStatus=BEHIND` → `behind-base`.
5. **Orthogonal label suggestions** (independent of category): always `needs-rebase` for BEHIND; `needs-ci-fix` for CI red ≥3d.
6. **No-CI-yet override**: CI run absent AND age > 3d AND tier ≠ `failing-CI` → `no-ci-yet`. Strip `stale`/`rotten` from recommended labels (a PR with no CI run is not safely classifiable).
7. **Idempotency filter**: drop any recommended label already present on the PR.
8. **Un-stale**: if the PR is no longer in a stale/rotten category but still carries those labels, recommend their removal. Same for `needs-rebase` / `needs-ci-fix` when the underlying condition has cleared.
9. **Stack-PR escalation** (§6): runs as a second pass after individual classification.

If you change any threshold, decision branch, or category name, update **both** `classify-prs.ts` and the report header strings (§8) in the same commit. The `CATEGORY_LABELS` export is the single shared mapping between machine names and report headings.

### 6. Stack-PR escalation

A PR is *stack-dependent* when `baseRefName` is **not** the default branch (`main`) AND a sibling open PR exists whose `headRefName == this.baseRefName`.

Stack rules:
- If the parent PR is **healthy or active**, suppress the child's stale/rotten classification → category **Stack Dependent**, no label mutation, no recommendation.
- If the parent PR is **stale or rotten itself**, surface the child in a new **Stack-Stuck** section with a link to the parent. Apply the child's normal labels too (parent stuckness should not protect children indefinitely — that is what hides MVC phase 1-7 chains today).
- If the parent PR is **closed/merged**, the child is no longer stack-dependent — re-classify normally.

Compute the parent map in one pass before classification: `{baseRefName: parentPRnumber}` keyed on heads of all open PRs.

### 7. Apply labels (idempotent, capped, parallel)

Skip when `--dry-run`.

For each PR with a target label:
- If the label is already present, skip.
- Otherwise `gh pr edit <num> --repo 2lab-ai/soma-work --add-label <label>`.

Counter-rule (un-stale): if a PR currently carries `stale` or `rotten` and *no longer* meets the threshold (i.e. fresh activity restored), remove the label (`--remove-label`). This is the only reason this skill removes labels.

**Cap mutations at 30 per run.** If the budget is hit, stop labeling and emit a warning at the report top so the user knows to re-run.

**Parallelize at -P 4.** `gh pr edit --add-label` is server-side idempotent and the bot token's write rate-limit is the binding constraint, not concurrency. At ~600ms per round-trip × 30 sequential = ~18s; -P 4 brings that under 5s. Use `xargs -P 4` or shell job-control. Count completed mutations against the cap (not dispatched) to keep the budget honest under partial failure.

Mutations are explicitly forbidden:
- Posting comments (no warn comment, no rotten notice).
- Closing PRs.
- Merging PRs.
- Pushing rebases.
- Creating workflow_dispatch runs.

### 8. Emit report

Format the report exactly as below. Keep it Slack-friendly: tables, no images, no nested lists deeper than 2.

````markdown
## PR Triage — 2lab-ai/soma-work
Generated <ISO timestamp> · <N_open> open PRs · <N_stale> stale · <N_rotten> rotten · <N_needs_action> need user action · <N_healthy> healthy
{op_budget_warning_if_any}

### 🔴 Rotten — close 추천 (<count>)
| # | Title | Tier | Age | Reason | Action |
|---|-------|------|-----|--------|--------|
| {n} | {title} | {tier} | {age}d | {one-line LLM-generated reason} | {recommended cmd or text} |

### 🟡 Stale (<count>)
| # | Title | Tier | Age | Reason | Action |

### 🚧 Failing CI (<count>)
| # | Title | Run ID | Age red | Action |

### 🔧 Behind base (<count>)
| # | Title | base | Action |
| {n} | {title} | {base} | `gh pr update-branch {n}` |

### ⏳ Awaiting Review (active, <count>)
| # | Title | Age | Reviewer suggestions |

### ✅ Approved & Mergeable (<count>)
| # | Title | Approved at | Action |
| {n} | {title} | {date} | `gh pr merge {n} --squash` |

### 📦 Stack Dependent (parent healthy, <count>)
| # | Title | Parent | Parent state |

### ⚠️ Stack-Stuck (parent stale/rotten, <count>)
| # | Title | Parent | Parent age | Action |

### ❓ No CI yet (<count>)
| # | Title | Age | Action |
| {n} | {title} | {age}d | trigger workflow or close |

### 🛡 Exempt (keep-open / pinned, <count>)
| # | Title | Exempt label |

## Auto-labeled this run
- Added `stale`: #X, #Y, #Z (count)
- Added `rotten`: #A, #B
- Added `needs-rebase`: #C
- Added `needs-ci-fix`: #D
- Removed `stale` (un-stale): #E
- Skipped (already labeled): <count>

## Suggested manual actions (NOT executed)
**Close (rotten):** `gh pr close 383 --comment "Closing as rotten — 30d no review activity. Reopen when ready."`
**Ping reviewer (awaiting):** /cc @reviewer on #X, #Y
**Rebase (behind base):** `gh pr update-branch 813`
**Merge (approved):** `gh pr merge 815 --squash --delete-branch`

> Re-run with `--dry-run` to preview without labeling. Add `keep-open` to any PR that should be exempt.
````

Per-row "Reason" must be specific to that PR — leverage the LLM context. Examples:
- `Awaiting review for 32d, last push 2026-04-05, CI green — no reviewer assigned`
- `CI red for 9d (run #41827) — author @x last active 12d ago`
- `Approved by @y 8d ago, mergeable, but author hasn't merged`

Do not output a single canned message for all rows — that is the documented weakness of `actions/stale`.

### 9. (v2 placeholder — do not implement here) Batch action gate

A future version will accept `--act` to surface a `UIAskUserQuestion` batch confirmation (close N rotten · ping M · rebase K). The template stub at `../UIAskUserQuestion/templates/pr-triage-batch-action.json` exists for that future. **For v1 the flag is silently ignored**; emit a one-line note "batch action gate coming in v2" if it is passed, do not error.

## Error handling

| Failure | Behavior |
|---------|----------|
| `gh auth status` fails / no token | Stop. Tell user to run `gh auth login` or set `GITHUB_TOKEN`. |
| `gh label create` fails (permission) | Continue without that label; warn at report top; skip mutations that need it. |
| GraphQL rate limit hit | Stop classification, emit partial report with header `WARNING: rate limited at PR #N`. |
| `gh run list` returns 404 (workflow disabled) | Treat as **No CI yet**; do not classify as failing. |
| > 200 open PRs | Process first 200 sorted by oldest `updatedAt`; emit warning recommending a tighter exemption policy. |

## Invariants

- **NEVER auto-close, auto-merge, auto-comment, or auto-rebase.** Only labels mutate.
- **NEVER use `gh pr checks`** — bot token lacks GraphQL `statusCheckRollup`. Use `gh run list` instead.
- **NEVER use `pr.updatedAt` as the stale clock** — label/milestone/reviewer changes reset it. Use commit + comment + review timestamps.
- **NEVER touch issues** — open scope creep risk. PRs only.
- **Idempotent**: re-running with no new activity produces zero mutations.
- **Cap 30 mutations per run.** If hit, surface in the report header.
- **Exemption labels (`keep-open`, `pinned`) are absolute** — never override.
- **Stack-dependent PRs with healthy parent are protected** from rotten/stale labeling. Stack-Stuck (parent itself stale) bypasses that protection.

## Reference

- Prior art studied for tier policy: `actions/stale`, Kubernetes Prow `lifecycle/{stale,rotten,frozen}`, Rust `triagebot` (S-waiting state machine), Dependabot 30-day rebase cutoff.
- Issue: https://github.com/2lab-ai/soma-work/issues/825
- Sibling skill conventions: `src/local/skills/zcheck/SKILL.md` (CI lookup), `src/local/skills/github-pr/SKILL.md` (PR data extraction), `src/local/skills/release-notes/SKILL.md` (report layout).
