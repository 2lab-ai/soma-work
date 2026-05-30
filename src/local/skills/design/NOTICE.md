# Third-Party Attributions

This `design` skill is vendored from
[`alchaincyf/huashu-design`](https://github.com/alchaincyf/huashu-design) by
花叔 (Huasheng / `@AlchainHust`), distributed under the **MIT License**. The
upstream license text is preserved verbatim in [`LICENSE`](./LICENSE).

## What was vendored

- `SKILL.md` — frontmatter rewritten to soma-work skill conventions
  (`name: design`, `allowed-tools`, `version`, `license`); the agent-prompt body
  is kept verbatim from upstream.
- `references/*.md` — all 23 drill-down docs, unmodified.
- `scripts/*` — full export toolchain, unmodified.
- `assets/` — Starter Components (`*.jsx`), deck engine, showcases, SVGs, and the
  37 lightweight SFX clips under `assets/sfx/`, unmodified.

## What was NOT vendored (kept out on purpose)

- `assets/bgm-*.mp3` — 6 background-music tracks (~27 MB). Video-pipeline-only
  binaries; unused by soma-work's Slack `HTML → PNG` flow. Download from the
  upstream release if you run the MP4/BGM export pipeline.
- `README.md`, `README.zh.md`, `test-prompts.json`, `demos/` — upstream
  repo-marketing and demo artifacts, not needed by the skill at runtime.

No reference/script/asset text has been modified from upstream other than file
relocation and the `SKILL.md` frontmatter rewrite. Improvements should be sent
upstream first; we re-vendor on their releases.

## Consumed by `local:html`

`local:html` reads this skill's anti-AI-slop discipline and the 20-philosophy
style vocabulary in [`references/design-styles.md`](./references/design-styles.md)
before generating HTML. See that skill's `SKILL.md` Step 3.5.
