# local — soma-work harness plugin (CLAUDE.md)

`src/local-harness/` is a Claude Code plugin named **`local`**. soma-work bundles it and loads it by default
(`src/plugin/bundled.ts`, `src/plugin/defaults.ts`); the build copies it to `dist/local-harness`.
It is **not** in `.claude-plugin/marketplace.json` — nobody outside soma-work installs it.

## What goes here, what goes to zworkflow

- **Here**: a skill that needs the soma-work harness — the session task card through the model-command MCP
  (`GET_SESSION`, `UPDATE_SESSION`), the dashboard, the host's turn-end summary.
- **zworkflow (`src/local`)**: everything that works in plain Claude Code. It must not teach a harness call
  (`src/plugin/__tests__/harness-plugin.test.ts` fails on `GET_SESSION` / `UPDATE_SESSION` in a zworkflow `.md`).
- A harness skill wraps the portable one instead of copying it: `local:auto-es` runs `zworkflow:es`, then adds the
  harness rules.
- One name, one owner: a skill name here never repeats a zworkflow skill name (the `local:` key resolves both).

## Names

Docs write zworkflow skills as `local:<skill>` (an older alias — the skill locator and `$local:<skill>` look in
`src/local/skills` first, then here). In the Skill tool the plugins are `zworkflow:<skill>` and `local:<skill>`.

## ⚠️ Bump the version

Change anything under `src/local-harness/` → bump `.claude-plugin/plugin.json` `version` in the same commit
(patch: wording/fix · minor: a new skill or rule · major: a breaking change).
