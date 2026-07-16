---
name: explore-unknowns
description: "Map a task's unknowns as a four-quadrant walk before speccing or building — known knowns, known unknowns, unknown knowns, unknown unknowns — ending with a complete map in the user's hands. Use when a request is ambiguous or underspecified, the codebase or domain is unfamiliar, the user will 'know it when they see it', a reference implementation must be understood before porting, or a spec/autoz run needs its fog burned off first. Triggers: 'explore unknowns', 'explore-unknown', '탐구', '뭘 모르는지 모르겠다', before stv:spec interviews and autoz RED. Has an Autonomous Mode for no-question pipelines (autoz)."
---

# Explore Unknowns

The map is not the territory. The prompt, the plan, and the context window are
the map; the codebase, the domain, and the user's actual intent are the
territory. The gap between them is the unknowns — and an unknown found before
code is written costs minutes, while the same unknown found three PRs later
costs the three PRs.

This skill fills in a four-quadrant map of the task, one quadrant per stage.
The map is the deliverable; implementation is a different task that starts
only after the map is handed over.

Two moves apply at every stage:

- **Reacting beats imagining.** Never ask the user to describe what they want
  when you can hand them something concrete to react to — a rendered option,
  a clickable mock, a decisions table. Reacting extracts knowledge the user
  has but cannot articulate unprompted.
- **Every artifact assembles the reply.** End each artifact with the user's
  next message pre-drafted: steal/skip chips, resonate checkboxes, a
  decisions table, a copyable sharpened prompt — so their reaction becomes
  their next message with near-zero typing.

## The Quadrant Walk (interactive, default)

Five stages, walked in order, one at a time. **When you enter a stage, read
its reference file and follow it.** Name the current quadrant as you go — the
user should always know where they stand on the map — and finish the stage in
front of you before opening the next.

1. **[Known knowns](references/stage-1-known-knowns.md)** — scan the
   territory, then open with the settled ground.
2. **[Known unknowns](references/stage-2-known-unknowns.md)** — the questions
   you can name; resolve them one at a time.
3. **[Unknown knowns](references/stage-3-unknown-knowns.md)** — extract the
   taste and tacit context nobody has put into words.
4. **[Unknown unknowns](references/stage-4-unknown-unknowns.md)** — sweep the
   territory for landmines.
5. **[Hand over the map](references/stage-5-hand-over-the-map.md)** — the
   completed four-quadrant map, the walk's only done-condition.

When the user moves on to build, review, or merge what the walk mapped, read
[after the walk](references/after-the-walk.md) — the map lives on past
planning.

## Autonomous Mode (for no-question pipelines)

When invoked from a pipeline that forbids user questions (`local:autoz`, or
any run the user marked autonomous), run the same walk **without asking the
user anything** — no user questions, ever, in this mode. The four-quadrant
map is still the deliverable; only the sources change:

- **Stage 1 (known knowns)** — unchanged: parallel recon of the code the task
  touches; cite files.
- **Stage 2 (known unknowns)** — close every question **by the territory**
  (read the code/tests/docs/git history) or by a bounded external consult via
  the `local:trinity` chain (trinity consensus → `mcp__llm__chat` model codex
  → `codex-fallback` opus) when the territory is silent. A question
  neither can close is recorded OPEN with the conservative default you chose
  and why — a logged decision, not a question.
- **Stage 3 (unknown knowns)** — extract tacit context from the repo instead
  of the user: existing conventions, prior art, reverted attempts, the
  consumers the code reveals. Label inferences as inferences.
- **Stage 4 (unknown unknowns)** — unchanged: sweep every file the task will
  touch; landmine cards with evidence. High-risk findings escalate to the same
  trinity-chain consult, never to the user.
- **Stage 5** — the map is written into the run's artifact trail (spec
  folder, PR body, or handoff payload) instead of a conversation reply, so
  the user can audit it after the fact.

Autonomous mode never blocks: every OPEN item carries a conservative default
and its rationale, and the run proceeds on those defaults. The map makes the
gamble visible; it does not stop the pipeline.

## Rules

- Walk the quadrants in order, one stage at a time, naming the current
  quadrant. The walk ends with the map in the user's hands — no map, not
  done.
- Stages order the walk; they never embargo information. A finding that
  materially bears on a decision in flight is disclosed the moment you have
  it, then filed on the map under its quadrant — never held back for its
  stage's scheduled turn.
- Nothing closes off-screen. Any question or judgment call the map records as
  closed must have been shown to the user first (interactive mode) or logged
  with its evidence and rationale (autonomous mode) — including ones the
  territory answered.
- Claims about the territory cite real files actually read; invented data is
  labeled as such. A fabricated specific destroys the map's authority.
- HTML artifacts are self-contained single files: inline CSS/JS, no external
  requests, plausible fake data over lorem ipsum.
- Interactive mode: stop at every stage boundary that needs the user's
  reaction. Never barrel into implementation on unconfirmed guesses —
  implementing is a separate task that begins after the map is delivered.
- Autonomous mode: never ask; close by territory, codex consult, or a logged
  conservative default. The map is attached to the run's artifacts.

## Attribution

Adapted from [dzhng/skills](https://github.com/dzhng/skills)
`skills/engineering/explore-unknowns` (MIT License). The stage reference
files under [references/](references/) are vendored from that source; the
Autonomous Mode section is a soma-work addition for the autoz pipeline. See
[LICENSES/NOTICE.md](LICENSES/NOTICE.md).
