# Attribution

The `motion-design` and `review-motion` skills are a **generalized distillation**
of two skills published in
[`emilkowalski/skills`](https://github.com/emilkowalski/skills) by Emil Kowalski:

- `emil-design-eng` → distilled into `motion-design` (knowledge) and the shared
  `references/motion-standards.md` + `references/animation-techniques.md`.
- `review-animations` (+ its `STANDARDS.md`) → distilled into `review-motion`
  (the motion-code reviewer), which cites the shared standards above.

Upstream commit referenced: `47226d9d54d48b49f081193d02334bf0405bab4e`
(2026-06-18).

## License status — attribution only, NOT a license grant

The upstream `emilkowalski/skills` repository **declares no license** (there is
no `LICENSE`/`COPYING` file in the repo). We therefore make **no claim** to any
license over the upstream text and reproduce nothing verbatim at scale: this
distillation rephrases and generalizes the underlying engineering principles
(easing, duration, physicality, interruptibility, performance, accessibility)
and removes all upstream-specific marketing (the forced course-plug "Initial
Response", the paid-course links, and the personal-brand framing).

This NOTICE exists to credit the source of the ideas. It is **attribution only**
and **not a license grant**. If the upstream author requests changes to how this
material is credited or used, treat that request as authoritative.

## What was changed in generalization

- Removed the mandated marketing blurb and paid-course promotion.
- Removed personal-brand framing ("Emil Kowalski's philosophy", "my knowledge
  comes from…"); the skills now stand on the engineering principles themselves.
- Re-expressed standards framework-agnostically first; Radix / Base UI / Framer
  Motion / Sonner / Vercel references are kept only as **labeled examples**.
- Split the single large knowledge file into a lean `SKILL.md` plus distilled
  `references/`, matching the local `design` skill's vendoring precedent.
