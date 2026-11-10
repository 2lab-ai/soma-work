---
name: update-docs
description: >
  Keep soma-work documentation in sync with the code. Use this skill
  automatically whenever a task is being completed in this repo — before every
  commit/PR that changes code, structure, commands, workflows, personas,
  skills, config, or deployment. Also triggers on explicit requests like
  "update docs", "docs sync", "문서 업데이트". Checks README.md, README.ko.md,
  CLAUDE.md, AGENTS.md, and docs/ for drift against the actual code and fixes
  it in the same change.
---

# update-docs — documentation sync for soma-work

A task in this repo is complete only when code, tests, and docs agree. This
skill defines how to detect and fix documentation drift before a commit or PR.

## When to run

Run this skill at the end of every task, before the commit/PR:

- any change under `src/`, `packages/`, `somalib/`, `services/`, `infra/`,
  `scripts/`
- any change to commands, workflows, personas, skills, MCP servers, config
  keys, env vars, or deployment procedure
- any file move or directory restructure
- explicit user request ("update docs", "문서 업데이트")

If the change genuinely does not affect any doc surface, state
`docs: no impact` in the PR body. Skipping the check is not the same as
checking and finding no impact.

## Doc ownership map

| Surface | Owns | Update when |
|---|---|---|
| `README.md` | Front page: the demo film first (a poster, `assets/readme/en/demo-poster.png`, linking the v0.3 release's film in that language), under it two more posters (`usage-poster.png`, the real-use demo, and `llmux-poster.png`, soma-work × llmux) linking the same release's films, and the llmux intro film linked from step 2 of Run it (llmux v0.2.26 release), then what soma-work does in the order a new reader asks (ask in Slack → pick it up on the dashboard → keep going from the card → watch it work → start on the dashboard → step in → what comes back → run it), with real screenshots/GIFs of the English UI in `assets/readme/en/` (`README.ko.md`: the Korean UI, `assets/readme/ko/`) | The front-page story, quick start or a screenshot changes |
| `README.ko.md` | Korean mirror of README.md | Always together with README.md — the two files move as a pair |
| `docs/misc/guides/{features,commands,setup,contributing}.md` (+ `.ko.md` pairs) | Feature detail and architecture, the command reference, install/config/deploy/GitHub/troubleshooting, project structure/design/tests | Features, commands, architecture, setup or project structure change — each `.md` moves with its `.ko.md` |
| `CLAUDE.md` | Agent behavior rules, module layout, TDD/deploy rules, gotchas | Agent-relevant rules or layout change |
| `AGENTS.md` | Slack API guardrails, beads workflow | Slack payload constraints change |
| `docs/README.md` | Docs routing map | Any `docs/` directory add/move/remove |
| `docs/misc/reference/architecture.md` | Component wiring SSOT | Bootstrap wiring, subsystems, or request flow change |
| `docs/adr/` | Durable repo-wide decisions | Hard-to-reverse decision made |
| `docs/runbook/` | Operational procedures | Deploy/rollback/ops procedure changes |

Routing rules for new documents: `docs/README.md` and `rules/pattern.doc.md`.

## Drift check procedure

1. Identify what the change touched:

```bash
git diff --stat main...HEAD    # or the staged diff for uncommitted work
```

2. For each touched area, grep the doc surfaces for claims about it:

```bash
rg -n "<changed-module-or-command>" README.md README.ko.md docs/misc/guides CLAUDE.md AGENTS.md docs/README.md docs/misc/reference/architecture.md
```

3. Verify structural claims against reality. Known drift-prone claims:

```bash
ls src/persona/*.md                       # persona list
ls src/prompt/workflows/*.prompt          # workflow list
ls packages/                              # workspace packages
ls packages/mcp-servers/                  # internal MCP servers
ls src/local/skills/                      # local skills
```

4. Check moved/renamed paths are not referenced by old name:

```bash
rg -n "old/path" README.md README.ko.md CLAUDE.md docs/
```

5. Verify local markdown links in every changed doc resolve to existing files.

## Rules

- **No hardcoded counts.** Never write "N handlers", "N personas", "N
  workflows" in docs — counts always drift. Point to the directory as the
  source of truth instead.
- **README pair rule.** `README.md` and `README.ko.md` are updated together in
  the same commit. Never let one drift ahead of the other.
- **Same-PR rule.** Doc updates ship in the same PR as the code change, never
  in a "later" follow-up.
- **SSOT pointers over duplication.** When a fact lives in code
  (`whitelist.ts`, `VALID_WORKFLOWS`, directory listings), the doc links to it
  rather than copying the list.
- **Conservative moves.** Follow `rules/pattern.doc.md` for archiving or
  moving documents — evidence first, manifest first, links updated in the same
  change.

## Completion checklist

Before finishing the task, all must be true:

- every doc surface affected by the change is updated in this change
- `README.md` and `README.ko.md` are consistent with each other
- no stale paths: `rg` for old names returns nothing in doc surfaces
- local markdown links in changed docs resolve
- no new hardcoded counts introduced
- if nothing was affected, the PR body says `docs: no impact`
