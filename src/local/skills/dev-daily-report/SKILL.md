---
name: dev-daily-report
description: "Use when the last 24 hours of pull-request flow should be posted as an infographic: Review of Legends review times, PRs opened and merged, gate and deploy times, per repo and author. Triggers: 'dev-daily-report', '데일리 리포트', 'PR 리포트', '리뷰 리포트'."
---

# dev-daily-report — the last day of review, merge and deploy flow as one image each

In short: two scripts count, one script draws, you post. Every number comes from the scripts — you never compute, round or fill one in yourself.

- `rol` report: how long Review of Legends (RoL) takes per review, and from the first review to the merge — overall, per repository, per PR author.
- `github` report: PRs opened and merged, lead time (opened → merged), gate time (checks and statuses on the merged head), deploy time (merge → first successful deploy run that contains it) — overall, per repository, per author.

## Args (the caller says them, usually a cron prompt)

| Arg | Meaning | Default |
|---|---|---|
| `rol` | include the RoL report | off |
| `db=<path>` | RoL dashboard store (`dashboard.sqlite3`) | env `ROL_DASHBOARD_DB`, else the newest standard install path |
| `rol-repos=a/b,c/d` | limit the RoL report to these repositories | every repository reviewed in the window |
| `github repos=a/b,c/d` | include the GitHub report for these repositories | off |
| `deploy=<owner/name>=<workflow.yml>@<branch>` | deploy workflow to time (repeatable) | none: no deploy column |
| `label=<env>` | name of that deploy environment in the image | last part of the branch |
| `gate=<regex>` | count only checks/statuses whose name matches | all |
| `hours=<n>` · `tz=<zone>` | window length · display time zone | `24` · `Asia/Seoul` |

The window ends at the minute the scripts run and starts `hours` earlier.

## Steps

SK = this skill's base directory. W = a fresh folder in the session scratchpad. Each step is its own shell call; start each with `export SK=<absolute path> W=<absolute path>`.

1. **Collect.** Run every report the caller asked for, even if another one fails.
   - RoL: `python3 -B "$SK/scripts/collect_rol.py" --out "$W/rol.json"` plus `--db <path>` and one `--repo a/b` per `rol-repos` entry when given.
   - GitHub: `python3 -B "$SK/scripts/collect_github.py" --repo a/b [--repo c/d …] --out "$W/github.json"` plus `--deploy <spec>` per `deploy`, `--deploy-label <env>`, `--gate <regex>` when given.
   - Both take `--hours` and `--tz`. Exit 2 = that report failed; its last stderr line says why.
2. **Draw.** `python3 -B "$SK/scripts/render_report.py" --out-dir "$W"` with `--rol "$W/rol.json"` and/or `--github "$W/github.json"` for each report that collected. Writes `$W/rol.png` · `$W/github.png`; stdout = one summary block per report (Slack markdown).
   - Exit 3 = Pillow or a Hangul font is missing; the summary is still on stdout. Install Pillow into the scratchpad once and draw again: `PIP_CACHE_DIR="$W/pip" python3 -m pip install --target "$W/pydeps" pillow`, then the same draw command with `PYTHONPATH="$W/pydeps"` in front. A font: `--font <file with Hangul>`.
3. **Post** each PNG to this thread with `mcp__slack-mcp__send_media`: `initial_comment` = that report's summary block, `artifact_key` = `dev-daily-report-<rol|github>`, `alt_text` = the same summary. Without slack-mcp, print the PNG paths and the summaries.
4. **Failures are posted, never skipped.** A report that failed in step 1 gets one line in the thread: `⚠️ <report> 집계 실패: <last stderr line>`. A PNG that could not be drawn: post the summary text and the reason. One retry at most for a transient GitHub error; no loops.

## What the numbers mean

The images print these definitions in their footer.

- **Review time** — a RoL attempt's start to its first terminal state, attempts that started in the window and succeeded. Mean, median and p90.
- **Review start → merge** — PRs merged in the window: their first RoL attempt ever to the merge. PRs RoL never reviewed are counted apart.
- **Rounds** — RoL attempts per PR; for merged PRs, the attempts before the merge.
- **Lead time** — PR created → merged.
- **Gate time** — on the merged head commit, the first gate starting (check suite created, or the first commit status) to the last gate finishing. Per gate: its own start, queue included, to its end. Contexts named per base branch (`…/required/develop`) count as one gate.
- **Deploy time** — merge → finish of the first successful run of the deploy workflow on the deploy branch whose head contains the merge commit. Merged PRs no run contains yet are counted as pending with their age.
- PRs whose base is a deploy branch (`deploy/*`) are promotions, not work: left out of every count.

## Boundaries

- Read-only. The scripts write nothing to GitHub; the RoL store is copied before it is read, so the live database is never locked.
- Data access is the host's: `gh` must read the repositories (the bot's own GitHub identity), and the RoL store must be on this host. When either is missing, say which in the thread — do not borrow another identity.
- Post only to the session's own thread.

## Scheduling it

Cron expressions are evaluated in UTC: 09:00 KST is `0 0 * * *`. Example cron prompt:

```
$local:dev-daily-report rol github repos=acme/api,acme/web deploy=acme/api=deploy-dev.yml@deploy/dev label=dev — post both images to this thread.
```
