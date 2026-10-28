# Attribution

The `impeccable` skill is vendored from [`pbakaus/impeccable`](https://github.com/pbakaus/impeccable)
by Paul Bakaus.

Upstream commit referenced: `3671d50f0ac9a662ce0615e85a256110c9cd720b` (2026-10-26),
skill version `4.7.1`, engine version `0.1.17`. The upstream repository is licensed under the
**Apache License 2.0** — a verbatim copy is kept at
[`impeccable-Apache-2.0.txt`](./impeccable-Apache-2.0.txt). The upstream third-party notice is kept
verbatim at [`upstream-NOTICE.md`](./upstream-NOTICE.md): `reference/ios.md` and
`reference/android.md` are distilled from ehmo's
[`ehmo/platform-design-skills`](https://github.com/ehmo/platform-design-skills) (MIT).

Source tree used: the upstream Claude Code build at `.claude/skills/impeccable/` (the harness-specific
rendering of `skill/SKILL.src.md` and `skill/reference/`).

## Local changes

- **Docs-only.** Shipped: `SKILL.md`, `reference/*.md` (including `reference/degraded/`). Not shipped:
  `scripts/` (the `impeccable` launcher that downloads and executes a release binary on first run,
  `live-browser*.js`, `modern-screenshot.umd.js`, `data/font-index*.json`) and the four upstream
  agents (`impeccable-asset-producer`, `-documenter`, `-finish-reviewer`, `-manual-edit-applier`).
  Reason: a multi-tenant Slack bot must not fetch and execute binaries at run time. The upstream
  "Launcher unavailable" path and `reference/degraded/*.md` cover the gap.
- `SKILL.md` frontmatter: added EN/KO trigger keywords and the `html` driver note to `description`,
  and an `allowed-tools` field (Read, Write, Edit, Glob, Grep — no Bash, since no engine ships). `version`, `user-invocable`, `argument-hint` and `license` are upstream.
- `SKILL.md` body: inserted a "soma-work local additions" section (runtime policy, unsupported
  commands, and the no-question `html` driver-mode adapter with a positive read list) above the
  upstream text, which follows under "Upstream skill (verbatim from pbakaus/impeccable)" unchanged.
- `reference/*.md`: byte-for-byte upstream.

Integration decision: trinity consensus (grok-elon · astra-zhuge · fable-zhuge, round 3/5,
2026-10-26) — standalone docs-only skill, selected by the `html` skill as `design=impeccable`.
