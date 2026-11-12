# Attribution

The `improve-animations` skill is vendored from the `improve-animations` skill published in
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
- A "Plan location (local)" paragraph defines *the plan directory* (the
  repository's own; soma-work: `docs/current/plans/animations/`; else upstream's
  `plans/` or `animation-plans/`). Hard rule 1, phase 4, the README step, the
  `reconcile` row and PLAN-TEMPLATE.md say "the plan directory" instead of
  `plans/`.
- `allowed-tools` adds Edit (plans are edited and reconciled) and Agent
  (`execute` dispatches a subagent).
- AUDIT.md: a local note — the local `motion-design` standards win on exit
  `ease-in` and on 300–500ms large overlays.
- The `execute` row names `review-motion` as the review bar (upstream:
  `review-animations`, not vendored here).
- Body content is otherwise kept verbatim from upstream. Supporting files are copied verbatim apart from the local notes listed above.
- 2026-11-12: the frontmatter `description` was rewritten to say only when to use the skill (zworkflow `skill-description` rule). What the skill does stays in the body.
