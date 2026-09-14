# Migration verdict — which unit goes where

Status: **planned** — verdict computed 2026-09-14 on `origin/main` `c0a3bac`
(`research/dep-census-2026-09-14.json`, `research/closure-verdict-2026-09-14.txt`). Re-run before
every move; the verdict, not this table, is authoritative.

Population: 72 units = skills 46 · agents 16 · commands 6 · hooks 4.

## core — 17 units move in WU-2

| kind | unit | closure |
|---|---|---|
| skill | example, learn, release-notes, simplify, structurize, using-eli5, using-govuk, using-ha-thinking | no edges |
| agent | reviewer, comment-analyzer, pr-test-analyzer, silent-failure-hunter, strategist, type-design-analyzer, zkorean | no edges |
| agent | code-reviewer | → reviewer (core) |
| command | review-pr | → simplify, code-reviewer, reviewer (all core) + `gh` |

`stop-hook.sh` and `call-tracker.sh` pass the census but are excluded: their wiring is the soma
`hooks.json`. They are T0 below, not part of WU-2.

## local — 53 units stay, grouped by contaminating seed

| cluster | seed | direct | propagated |
|---|---|---|---|
| A · soma model-command | `mcp__model-command__run` | z, using-z, UIAskUserQuestion, using-user-skills, zkorean(skill), cron (+cron MCP) | zcheck, ztrace, zthink, ui-ux-reference, using-ssot, zfix |
| B · LLM proxy | `mcp__llm__chat`, llmux, codex CLI | trinity, autoz, llm-dispatch, zdeepresearch, zexplore, explore-unknowns, setup-ai-docs, setup-ai-workflow; agents codex-fallback, explore, oracle, orchestrator, gpt56-elon, gpt56-zhuge, grok45-elon; commands /explore /oracle /oracle-reviewer /orchestrator | zreflect |
| C · Slack / serve delivery | `mcp__slack-mcp__send_*`, soma-html-serve, slackId, Block Kit | html, diagram, architecture-diagram, block-kit-preview; hook-proxy.sh, hooks.json | — |
| D · shadcn MCP | shadcn/ui MCP | design, ui-ux | motion-design, review-motion, lottie, animation-vocabulary, apple-design |
| E · GitHub MCP | `mcp__github__*` | github-pr, zwork | es, decision-gate, calldiff, using-epic-tasks |
| F · other-plugin MCP | context7, claude-as-mcp | agent librarian, /librarian, agent orchestrator, /orchestrator | — |

## Promotion tranches — the only way out of `local`

A tranche is: cut the dependency → re-run the census → closure clean → its own PR. No cut, no
move. A tranche that cannot be cut ends as permanent `local`, which is a normal outcome.

| id | units | cut required |
|---|---|---|
| T0 | stop-hook.sh, call-tracker.sh | `core` gains its own `hooks/hooks.json` wiring only these two; event double-registration test |
| T1 | github-pr | replace the four `mcp__github__*` calls with `gh` equivalents |
| T2 | design, ui-ux, ui-ux-reference, motion-design, animation-vocabulary, apple-design, review-motion, lottie | shadcn MCP becomes an "if present" clause; `design`/`lottie` → `html` edges proven to be back-references or cut; `ui-ux-reference` → `UIAskUserQuestion` made optional |
| T3 | html, diagram, architecture-diagram | Slack delivery + soma serve steps become a conditional "if the delivery tool exists" contract; renderer (node/playwright) remains |
| fixed | clusters A, B, F; cron; using-user-skills; block-kit-preview; hook-proxy | not promotable — the dependency is the unit's identity |

## Inbound populations (same rule)

- **stv@oh-my-claude 0.5.0** (15 skills, no agents, no hooks): `spec`, `trace`, `clarify`,
  `verify`, `debug` are rewritten and enter `core` only if the rewrite passes the census;
  `using-terminal-charts`, `excalidraw-diagram-skill` move as-is if clean; `explore`, `think`,
  `work`, `do-work`, `new-task`, `plan-new-task`, `what-to-work`, `what-we-have-to-work` are merged
  into the z-family (which is `local`) or dropped. stv then leaves `DEFAULT_PLUGINS`.
- **zbrain `.claude/skills`** (48 skills, 9 agents): every candidate is run through the census
  individually; passing units are Sanitize-scanned, then ported to `core`. No pre-committed list
  — the census output is the list. Known-private families (zbrain-*, daybrief, playbook,
  dashboard, jira-*, slack-*, book, voice, …) are not even candidates.
