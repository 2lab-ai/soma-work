# Attribution

The `motion-design` and `review-motion` skills are a **generalized distillation**
of two skills published in
[`emilkowalski/skills`](https://github.com/emilkowalski/skills) by Emil Kowalski:

- `emil-design-eng` → distilled into `motion-design` (knowledge) and the shared
  `references/motion-standards.md` + `references/animation-techniques.md`.
- `review-animations` (+ its `STANDARDS.md`) → distilled into `review-motion`
  (the motion-code reviewer), which cites the shared standards above.

Upstream commit referenced: `47226d9d54d48b49f081193d02334bf0405bab4e`
(2026-06-18). Verified unchanged upstream as of
`f76beceb7d3fc8c43309cefad5a095a206103a4e` (2026-07).

## License status — upstream is now MIT-licensed

When these skills were first distilled, the upstream repository declared no
license, so the distillation deliberately rephrased and generalized the
underlying engineering principles (easing, duration, physicality,
interruptibility, performance, accessibility) and reproduced nothing verbatim
at scale, treating this NOTICE as attribution only and not a license grant.

Upstream has **since added an MIT License** (commit `622957c`, Copyright (c)
2026 Emil Kowalski), which now also covers the referenced material. A verbatim
copy is kept at
[`emilkowalski-skills-MIT.txt`](./emilkowalski-skills-MIT.txt). The distilled,
generalized form is kept regardless — it removes upstream-specific marketing
(the forced course-plug "Initial Response", paid-course links, and
personal-brand framing) that we do not want in a house skill. If the upstream
author requests changes to how this material is credited or used, treat that
request as authoritative.

## What was changed in generalization

- Removed the mandated marketing blurb and paid-course promotion.
- Removed personal-brand framing ("Emil Kowalski's philosophy", "my knowledge
  comes from…"); the skills now stand on the engineering principles themselves.
- Re-expressed standards framework-agnostically first; Radix / Base UI / Framer
  Motion / Sonner / Vercel references are kept only as **labeled examples**.
- Split the single large knowledge file into a lean `SKILL.md` plus distilled
  `references/`, matching the local `design` skill's vendoring precedent.

## Related vendored skills

The upstream repo's two later skills are vendored near-verbatim (MIT) as the
local `apple-design` and `animation-vocabulary` skills — see their own
`LICENSES/NOTICE.md` files.
