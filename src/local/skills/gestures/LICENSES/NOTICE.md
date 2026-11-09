# Attribution

The `gestures` skill is vendored from the `gestures` skill published in
[`emilkowalski/skills`](https://github.com/emilkowalski/skills) by Emil Kowalski.

Upstream commit referenced: `715c1807e08c497cfd1dc4feb450a2a3300ef2a9`
(2026-11-09). The upstream repository is licensed under the **MIT License**
(Copyright (c) 2026 Emil Kowalski) — a verbatim copy is kept at
[`emilkowalski-skills-MIT.txt`](./emilkowalski-skills-MIT.txt).

## Local changes

- Frontmatter extended with house-style trigger keywords (EN/KO), `version` and
  `license`; `allowed-tools` set to what the skill does (read-only skills get no
  Edit or Write).
- The description routes to skills that exist in soma-work (`motion-design`,
  `review-motion`) instead of upstream names that are not vendored here.
- An attribution paragraph under the title, with a note mapping upstream skill
  names in the body to the local ones. The note also says the default sheet here is
  the `@2lab.ai/ui` drawer (zero runtime dependencies), not Vaul.
- A local note under "First decision": in soma-work the default sheet is the
  `@2lab.ai/ui` drawer, not Vaul; `pick-ui-library` is not vendored.
- Body content is otherwise kept verbatim from upstream.
