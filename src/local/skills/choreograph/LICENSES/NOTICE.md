# Attribution

The `choreograph` skill is vendored from the `choreograph` skill published in
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
- A local note in the body: the hover-buildup gate guards only the decorative
  replay, never the action (keyboard users never hover).
- RECIPES.md, the `useAnimate` recipe's code: `onClick` runs the action
  (`onAction()`) before the gate; `play()` takes a factory so the old handles
  stop before the new `animate()` calls start (upstream passed an array, which
  starts them first).
- Body content is otherwise kept verbatim from upstream. Supporting files are copied verbatim apart from the local notes listed above.
- 2026-11-12: the frontmatter `description` was rewritten to say only when to use the skill (zworkflow `skill-description` rule). What the skill does stays in the body.
