# Attribution

The `choreograph` skill is vendored from the `choreograph` skill published in
[`emilkowalski/skills`](https://github.com/emilkowalski/skills) by Emil Kowalski.

Upstream commit referenced: `715c1807e08c497cfd1dc4feb450a2a3300ef2a9`
(2026-11-09). The upstream repository is licensed under the **MIT License**
(Copyright (c) 2026 Emil Kowalski) — a verbatim copy is kept at
[`emilkowalski-skills-MIT.txt`](./emilkowalski-skills-MIT.txt).

## Local changes

- Frontmatter extended with house-style trigger keywords (EN/KO),
  `allowed-tools`, `version`, and `license` fields.
- Added the attribution paragraph under the title.
- Removed the upstream "Initial Response" section (a greeting-only first reply):
  soma-work runs skills inside a task, where a reply that waits for a question
  stalls the pipeline.
- Body content is otherwise kept verbatim from upstream. Its supporting file `RECIPES.md` is copied verbatim.
