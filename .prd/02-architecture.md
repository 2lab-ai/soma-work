# soma-work plugin split — Architecture

Status: **planned** — 2026-09-14.

## Layout (target)

```text
soma-work/
  .claude-plugin/marketplace.json     plugins: [{name: local, source: ./plugin/local},
                                                {name: core,  source: ./plugin/core}]
  plugin/
    local/                            ← git mv src/local
      .claude-plugin/plugin.json      name: local   version: 2.0.0
      skills/  agents/  commands/  hooks/  prompts/
    core/                             ← new
      .claude-plugin/plugin.json      name: core    version: 2.0.0
      skills/  agents/  commands/  hooks/  prompts/
  src/plugin/bundled.ts               BUNDLED_PLUGINS = { local: <root>/plugin/local,
                                                          core:  <root>/plugin/core }
  src/plugin/defaults.ts              DEFAULT_PLUGINS += local@soma-work, core@soma-work
  package.json  build                 cp -r plugin dist/plugin-bundle   (name TBD, see §Bundle path)
```

Skill namespaces follow plugin names: `local:<skill>` and `core:<skill>`. Install references are
`local@soma-work` and `core@soma-work` (Claude Code's `<plugin>@<marketplace>` form; the
marketplace is the repo, so "zworkflow@local" in the user's shorthand maps to plugin `local`).

## Membership rule (the only classifier)

```text
seed(local)  = any unit whose files reference
               · a soma marker   (slack-mcp tools, soma-html-serve, /tmp/{slackId}, Block Kit,
                                   hook-proxy / soma service)
               · any MCP tool    (mcp__model-command__run, mcp__llm__chat, mcp__cron__*,
                                   mcp__github__*, context7, claude-as-mcp, …)
               · a daemon / proprietary CLI (llmux, codex exec, shadcn MCP)
local        = seed(local) ∪ { u | u → v (skill or agent edge) and v ∈ local }   (fixpoint)
core         = units − local
allowed ext  = gh, node, python3, curl, playwright, ffmpeg, tailwind CDN   (generic binaries)
```

Extractor: `zbrain/scripts/plugin-dep-census.py <plugin-root>` (edges from
`$CLAUDE_PLUGIN_ROOT/skills/X`, `../X/SKILL.md`, `` `X` skill ``, `local:X`/`zworkflow:X`,
agent-name word boundaries, `mcp__server__tool`, external binary patterns). The closure pass is
the 30-line Python in `research/closure-verdict-2026-09-14.txt` header; it becomes a repo test in
WU-3 so membership cannot drift back to prose.

## Bundle path

Today `bundled.ts` computes `path.join(__dirname, '..', 'local')`, which only works because
`src/local` sits beside `src/plugin` and the build copies it to `dist/local`. Moving to
`plugin/` at repo root breaks that arithmetic in both modes. Decision for WU-1: compute
`<root>` once (`path.resolve(__dirname, '..', '..')` in source and dist alike, since both are
one level below the root of their tree) and copy `plugin/` to `dist/plugin-bundle/` — the
name `dist/plugin` is taken by the compiled `src/plugin/*.ts`. The contract test asserts both
modes.

## Cross-plugin references

`local` units that reference moved `core` units (e.g. `zcheck → simplify`, `motion-design →
reviewer`, `/review-pr` callers) switch to the `core:` namespace. `core` never references
`local` — the closure rule makes that impossible by construction. `$CLAUDE_PLUGIN_ROOT`
relative paths never cross a plugin boundary; the census flags any that would.

## Hooks

- `hook-proxy.sh`, `call-tracker.sh`, `hooks.json` (PreToolUse/PostToolUse/Stop → soma HTTP
  proxy) stay in `local`.
- `stop-hook.sh` (Ralph Wiggum loop, plain bash) is clean by census but its wiring lives in the
  soma `hooks.json`; it stays in `local` unless `core` grows its own `hooks/hooks.json`, which is
  a separate, opt-in WU (T0 in `03-migration-verdict.md`).

## What the bot code touches

| File | Change |
|---|---|
| `src/plugin/bundled.ts` | root-relative path, two-entry map |
| `src/plugin/defaults.ts` | `zworkflow@soma-work` → `local@soma-work` + `core@soma-work` |
| `src/plugin/plugin-manager.ts` | any `zworkflow` literal → data-driven from `BUNDLED_PLUGINS` |
| `src/claude-handler.ts`, `src/auth/query-env-builder.ts`, `src/slack/commands/plugins-handler.ts` | name literals |
| `config.example.json` | example default list |
| `package.json` `build` | copy fragment |
| tests: `zworkflow-default.test.ts` (rename), `no-duplicate-plugin-assets.test.ts`, `skill-refs.test.ts`, `no-todo-guard.test.ts`, `config-loader.test.ts`, `config-parser.test.ts` | path + name pins |

## Review

Large spec → dual-engine review (opus + gpt-5.6-sol) on the WU-1+WU-2 PR before merge, per
zbrain `rules/DEV.md` §2. Sanitize Gate stays on as usual.
