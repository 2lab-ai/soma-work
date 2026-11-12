---
name: import-skills
description: "Use when skills from other agent repos should be vendored into this plugin: inventories candidates, drops name or capability collisions and out-of-scope ones, asks once which to import, then adds them under the plugin's vendoring contract in one PR. Triggers: 'import-skills', '스킬 가져오기'. Args — [<owner/repo|url>…] [--limit=N] [--all] [--dry-run = no clone, commit, push or PR]."
argument-hint: "[<owner/repo|url>…] [--limit=N] [--all] [--dry-run] [target=<owner/repo>[:<plugin root>]]"
---

# import-skills — vendor skills from other agent repos

Pulls candidate skills from other agents' skill repositories, diffs them against what the target plugin already has,
lets the user pick, and opens one PR that adds the picks under the target's vendoring contract.

## Input
- **Sources**: every GitHub URL or `owner/repo` slug in the request. None → the defaults:
  - `NousResearch/hermes-agent`, path `skills/`, 2-level layout (`skills/<category>/<skill>/SKILL.md`);
  - `openclaw/openclaw`, path `skills/`, 1-level layout (`skills/<skill>/SKILL.md`).
  Other sources: infer the layout — top-level entries that hold a `SKILL.md` are 1-level, otherwise recurse one level.
- **Target**: `target=<owner/repo>[:<plugin root>]`; default the repository that ships this plugin, `2lab-ai/soma-work`,
  plugin root `src/local`. Its vendoring contract is the `## 벤더링 규약` (vendoring) section of `<plugin root>/CLAUDE.md`.
- **Flags**: `--limit=N` caps the candidates shown (default 15). `--all` skips the relevance filter (the collision
  filters stay). `--dry-run` stops after the candidate table: no clone, branch, commit, push, PR or question.

## Phase 1 — Inventory the sources (cheap)
1. List skill directories with `gh api repos/<owner>/<repo>/contents/<path>`.
2. Per candidate, read only the `SKILL.md` frontmatter and first ~40 lines
   (`gh api repos/<o>/<r>/contents/<path>/<skill>/SKILL.md --jq .content | base64 -d | head -60`); no `SKILL.md` →
   `DESCRIPTION.md`, then `README.md`; none → skip with the reason.
3. Note the repository's license (`gh api repos/<o>/<r>/license --jq .license.spdx_id`; 404 = none).
4. Keep `{source, name, summary, triggers, license, html_url}` per candidate. Fetch no bodies yet.

## Phase 2 — Inventory what the target has
- The target plugin's skills: names and descriptions under `<plugin root>/skills/` (`gh api` contents, or the clone).
- Skills already visible in this session's skill list (other plugins, the user's own skills).

## Phase 3 — Diff and filter
1. **Name collision** with any existing skill (case-insensitive, ignoring `-`/`_`) → drop; list it as suppressed.
2. **Capability collision** — an existing skill covers the same trigger surface → drop; unsure → keep and flag the
   overlap.
3. **Relevance** (skipped by `--all`) — the target's scope is what its plugin README says it is for. Drop skills tied
   to consumer apps, smart-home, games or hardware that the scope does not cover. Keep agent meta-patterns (planning,
   debugging, research, review, skill authoring), developer tooling, and anything orthogonal to what exists.
4. **License** — no license or a non-permissive one (GPL, AGPL, custom) → keep, but mark it: it needs the user's
   explicit yes for that one skill.
5. Sort by novelty, then summary quality, then source authority; cap at `--limit`.
6. Show the candidate table: name · source · one-line summary · license · overlap note · recommendation.
   **`--dry-run` ends here.**

## Phase 4 — Ask once
One question with one choice per candidate (yes / no / skip) via `local:UIAskUserQuestion` (a choice group); where
there is no question tool, the table is the question and the user's reply is the answer. Recommend `yes` only for
strong novelty and relevance, `no` for an overlap, `skip` for the rest. Never import without an explicit yes.

## Phase 5 — Import and open one PR
1. A fresh working folder under the session's working directory; clone the target; one branch
   `import-skills/<YYYYMMDD>-<shortid>`.
2. Per approved skill, following the target's vendoring contract:
   - pin the source: `SHA=$(gh api repos/<o>/<r>/commits/HEAD --jq .sha)`; fetch every file at `?ref=$SHA`;
   - place it at `<plugin root>/skills/<name>/` — never over an existing directory;
   - frontmatter, `LICENSES/NOTICE.md` (source link, `$SHA` and date, license, `## Local changes`), the upstream license
     text, the contract test `__tests__/<name>-skill.test.ts`;
   - supporting files (`references/`, `scripts/`, `templates/`) only when they hold no platform-specific paths;
     note any you left out for the PR body.
3. Checks per file: the frontmatter parses; no home paths (`/Users/`, `/home/`), machine names or credentials; no
   harness calls; `SKILL.md` under ~50 KB (move bulk into `references/`).
4. The plugin version bump and, if the descriptions push the skills listing over it, the prompt budget — both in the
   same commit, as the contract says. Run the target's tests for the new files.
5. Commit and open the PR. Attribution lines follow the session's or the repository's commit rule. The PR body
   lists per skill: name · source permalink at `$SHA` · license · one-line reason · files left out.
6. Stop at the open PR. Never merge it.

## Guardrails
- Never import without the user's explicit yes; never overwrite an existing skill.
- Never auto-merge.
- A body that references credentials, machine-specific paths or a closed SDK is flagged to the user before import.
- A GitHub read refused (401/403): retry with the session's other GitHub route before reporting; never switch to a
  person's credentials.

## Output
1. The PR URL (`--dry-run`: the candidate table).
2. One line per imported skill: `name | source@SHA | license | reason`.
3. One line per dropped candidate with the reason: collision / out of scope / license / the user said no.
