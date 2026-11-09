# Attribution

The `break-ui` skill is vendored from the `break-ui` skill published in
[`emilkowalski/skills`](https://github.com/emilkowalski/skills) by Emil Kowalski.

Upstream commit referenced: `715c1807e08c497cfd1dc4feb450a2a3300ef2a9`
(2026-11-09). The upstream repository is licensed under the **MIT License**
(Copyright (c) 2026 Emil Kowalski) — a verbatim copy is kept at
[`emilkowalski-skills-MIT.txt`](./emilkowalski-skills-MIT.txt).

## Local changes

- Frontmatter extended with house-style trigger keywords (EN/KO), `version` and
  `license`; `allowed-tools` set to what the skill does (read-only skills get no
  Edit or Write).
- The description is rewritten short (about 150 characters: what it does, when,
  EN/KO triggers) to fit soma-work's per-turn skill-listing budget
  (`src/__tests__/prompt-budget.test.ts`); it names no upstream-only skill.
- An attribution paragraph under the title, with a note mapping upstream skill
  names in the body to the local ones.
- The greeting-only lines of the upstream "Initial Response" section are removed
  (soma-work runs skills inside a task, where a reply that waits for a question
  stalls the pipeline). The section's scope paragraph is kept, right under the
  attribution paragraph.
- Body content is otherwise kept verbatim from upstream. Supporting files are copied verbatim.
