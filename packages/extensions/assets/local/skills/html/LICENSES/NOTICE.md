# Third-Party Attributions

The `templates/skills/<name>/SKILL.md` files in this skill are vendored from
[`nexu-io/html-anything`](https://github.com/nexu-io/html-anything), distributed
under the Apache License, Version 2.0. The upstream LICENSE text is preserved
verbatim in [`html-anything-Apache-2.0.txt`](./html-anything-Apache-2.0.txt).

## Vendored templates

- `data-report` — from `src/lib/templates/skills/data-report/SKILL.md`
- `meeting-notes` — from `src/lib/templates/skills/meeting-notes/SKILL.md`
- `resume-modern` — from `src/lib/templates/skills/resume-modern/SKILL.md`
- `deck-simple` — from `src/lib/templates/skills/deck-simple/SKILL.md`
- `eng-runbook` — from `src/lib/templates/skills/eng-runbook/SKILL.md`
- `saas-landing` — from `src/lib/templates/skills/saas-landing/SKILL.md`
- `social-x-post-card` — from `src/lib/templates/skills/social-x-post-card/SKILL.md`
- `doc-kami-parchment` — from `src/lib/templates/skills/doc-kami-parchment/SKILL.md`
  (further inherits from [`tw93/kami`](https://github.com/tw93/kami))

No template text in this skill has been modified from upstream other than
file relocation. Improvements should be sent upstream first; we re-vendor on
their releases.

## Design discipline lineage

The CJK-first font stack, 8 px baseline grid, contrast ≥ 4.5, and
must-use-real-data constraints encoded in `SKILL.md` originate from
[`alchaincyf/huashu-design`](https://github.com/alchaincyf/huashu-design)
(anti-AI-slop discipline) by way of html-anything.
