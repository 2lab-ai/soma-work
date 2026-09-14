# soma-work plugin split — Spec

Status: **planned** — 2026-09-14. Nothing under `src/local` or `src/plugin` has moved yet; this
document fixes the target contract for the split, not the current layout.

## Problem

`src/local` ships as one Claude Code plugin (`zworkflow@soma-work`, plugin.json `1.5.0` on
`origin/main` `c0a3bac`) and is loaded by the bot as a bundled default (`src/plugin/defaults.ts`
`DEFAULT_PLUGINS`, `src/plugin/bundled.ts` `BUNDLED_PLUGINS = { zworkflow: __dirname/../local }`).
Inside it, two populations are mixed:

- units that only work inside the soma-work bot — they call soma model-commands
  (`mcp__model-command__run`), the bot's LLM proxy (`mcp__llm__chat`, llmux), Slack delivery
  (`mcp__slack-mcp__send_*`), or the bot's cron/github MCP servers;
- units that run anywhere — plain prompts and scripts with no MCP or daemon dependency.

The mix has a cost: the public marketplace entry advertises 46 skills of which most silently fail
outside the bot, the harness census on 2026-08-24 found the same skill names duplicated across
zbrain / stv / zworkflow, and every "move this skill out" discussion so far was decided by prose
and one grep, which the user rejected on 2026-08-24 ("잘 모르겠으면 local에 유지해야하는거야 …
디펜던시 그래프 그리고 단독으로 실행할수 있는 스킬과 … 에이전트를 쓰는 것만 core로").

## Goals

1. Two plugins in one repo, both bundled defaults of the bot:
   - `local` at `plugin/local` — the soma-bound population (today's `src/local`, minus what moves).
   - `core` at `plugin/core` — the population that runs without the bot.
2. Membership is decided by a machine, not by reading: a unit is `core` only if its transitive
   dependency closure (skill→skill, skill→agent, command→skill/agent) contains no MCP tool, no
   soma marker, no daemon/proprietary CLI, and no unit already judged `local`. Everything else,
   including every unresolved case, stays `local`. Judge = `zbrain/scripts/plugin-dep-census.py`
   + the closure pass recorded in `research/closure-verdict-2026-09-14.txt`.
3. The bot keeps loading both without a network fetch, exactly as it loads `src/local` today.
4. `stv@oh-my-claude` stops being a default once its surviving skills are rewritten into `core`.
5. zbrain's project-local skills that pass the same census move to `core`; zbrain then calls them
   through the `core:` namespace.

## Non-goals

- Rewriting the z-pipeline (`z`, `zcheck`, `ztrace`, `zwork`, `using-ssot`, …) to drop
  `model-command__run`. That family is `local` by identity.
- Rewriting the trinity / LLM-proxy family (`trinity`, `autoz`, `zexplore`, `llm-dispatch`,
  agents `oracle`/`orchestrator`/`explore`/`codex-fallback`/`gpt56-*`/`grok45-*`) to run without
  llmux or `mcp__llm__chat`.
- Keeping the old `zworkflow` plugin name alive. The name is retired; external installs of
  `zworkflow@soma-work` break and get a migration note, not a shim.
- Deleting `~/.claude/{skills,agents}` (the user does that by hand) or touching the
  `/opt/soma-work/dev` pin of `stv 0.3.2`.

## Acceptance

Each line is `run → expected observation`. All must hold on the branch before merge.

1. `ls plugin/local/.claude-plugin/plugin.json plugin/core/.claude-plugin/plugin.json` →
   both exist; `name` fields are exactly `local` and `core`; `src/local` no longer exists.
2. `python3 zbrain/scripts/plugin-dep-census.py plugin/core` + closure pass → zero units with
   a `direct:` or `propagated:` reason. The same command on `plugin/local` may report anything.
3. `npm test` → the plugin contract tests pass with the new layout: the successor of
   `src/plugin/__tests__/zworkflow-default.test.ts` asserts marketplace entries
   `{name: local, source: ./plugin/local}` and `{name: core, source: ./plugin/core}`, and
   `BUNDLED_PLUGINS` resolves both names to on-disk directories in source mode and in the
   `dist/` layout produced by `npm run build`.
4. `npm run build && ls dist/` → both plugin directories are present in the bundle; the
   `cp -r src/local dist/` fragment is gone from `package.json` `build`.
5. In a running bot, `/plugins` lists `local@soma-work` and `core@soma-work` with source
   `default`; one `local:z` turn and one `core:structurize` turn complete.
6. `grep -rn "zworkflow:" src plugin .claude-plugin` → no hits. In zbrain,
   `grep -rn "zworkflow:" .claude CLAUDE.md` → no hits after the namespace migration commit.
7. `cat src/plugin/defaults.ts` → `DEFAULT_PLUGINS` is
   `['superpowers@claude-plugins-official', 'local@soma-work', 'core@soma-work']`
   (with `stv@oh-my-claude` present until the stv workstream ships, absent after).

## Origin

User directive, 2026-08-24, verbatim in `plugin-split/ssot.md`. Harness census and plan v1–v3
served from the zbrain session "soma-work 리팩터"; the v3 plan is the ancestor of this folder.
