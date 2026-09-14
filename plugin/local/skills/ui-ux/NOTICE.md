# NOTICE — ui-ux skill

The core of this skill (SKILL.md design intelligence, `scripts/`, and `data/`) is
vendored from the **UI/UX Pro Max** skill:

- Project: UI/UX Pro Max — `https://github.com/nextlevelbuilder/ui-ux-pro-max-skill`
- Version vendored: **2.6.2**
- Author: NextLevelBuilder
- License: **MIT** (see `LICENSE`)
- Homepage: https://uupm.cc

## Local modifications (soma-work)

- Renamed the skill `ui-ux-pro-max` → **`ui-ux`** and adjusted script paths to
  resolve from `$CLAUDE_PLUGIN_ROOT/skills/ui-ux` (the bundled plugin layout).
- Added the **Named Design References** capability: `references/<name>/design.md`
  files + `references/index.json`, applied by name from the `ui-ux` skill and
  authored by the companion **`ui-ux-reference`** skill.
- Shipped a default reference: `references/il-capo-production/design.md`.

The upstream data set (84 UI styles, 161 color palettes, font pairings, UX
guidelines, chart types, per-stack guidance) is unmodified.
