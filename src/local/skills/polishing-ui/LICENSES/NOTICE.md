# Sources

`polishing-ui` is written for this plugin (ISC, like the rest of soma-work). No upstream text or code is vendored.

## The detail pass (SKILL.md §3)

The ten steps restate what Haz (@diegohaz) shows and says in public:

- "Fixing a Claude-generated UI with obsessive attention to detail.", X, 2026-11-15 —
  https://x.com/diegohaz/status/2121696559955919147 — and his replies in that thread.
- "CSS 🤝🏽 Math — How to get even margins without ignoring line-height", X, 2026-01-17 —
  https://x.com/diegohaz/status/2012202785551327265 — the `--py` / `--px` recipe.

The step list was first written up as a skill page at
https://dosi.dev/diegohaz-fixing-claude-generated-ui/SKILL.md (2026-11-16), which this skill was asked to grow from.
Haz has not published his own rule set; his video has no narration, so every step says only what the video shows.

## The numbers (reference/apple-metrics.md, scripts/audit.mjs)

Facts read on 2026-11-16 from Apple's Human Interface Guidelines (accessibility, buttons, typography, dark-mode,
toolbars, split-views), apple.com's production stylesheets, W3C WCAG 2.2 and WebKit's `WKWebViewIOS.mm`. Each value
in `reference/apple-metrics.md` names its page or selector. Values no source states are listed there as such.

## Local changes

- 2026-11-16: first version (SKILL.md, reference/apple-metrics.md, scripts/audit.mjs).
