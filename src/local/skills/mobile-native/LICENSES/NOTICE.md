# Attribution

The `mobile-native` skill is vendored from the `mobile-native` skill published in
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
  names in the body to the local ones.
- The greeting-only lines of the upstream "Initial Response" section are removed
  (soma-work runs skills inside a task, where a reply that waits for a question
  stalls the pipeline). The section's scope paragraph is kept, right under the
  attribution paragraph.
- Local corrections: every axis-specific `touch-action` (the symptom table,
  the carousel and sheet examples, Never Ship) keeps `pinch-zoom` (the skill's
  own never-disable-zoom rule); iOS Safari's keyboard shrinks the
  visual viewport, not `dvh` — a bottom-pinned composer follows
  `window.visualViewport`.
- Body content is otherwise kept verbatim from upstream.
