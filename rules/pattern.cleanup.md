# Root And Docs Cleanup Pattern

Use this pattern when reducing repo-root clutter or reorganizing `docs/`.
Cleanup is valid only when it moves documents into clearer lifecycle locations
and preserves the evidence trail for future agents.

## Root Boundary

Keep repo root for product, build, config, and agent entrypoints only.

Allowed root markdown entrypoints:

- `README.md`
- `README.ko.md`
- `CLAUDE.md`
- `AGENTS.md`

Do not add task plans, feature specs, handoffs, research notes, phase docs, or
completion ledgers at root. Root child document directories are also disallowed:
long-lived specs belong in `docs/current/spec/`, incomplete handoffs in
`docs/misc/handoffs/`, and completed feature material in `docs/archive/features/`.

Before moving any non-markdown root file, verify its callers with `rg`. Runtime
or setup entrypoints stay at root unless all references and callers are updated
in the same change.

## Lifecycle Destinations

Route documents by lifecycle:

- `docs/current/spec/`: evergreen product or system specs.
- `docs/misc/handoffs/`: dated handoff notes for incomplete or in-progress cleanup.
- `docs/archive/features/`: completed, stale, or superseded feature specs and
  traces.
- `docs/archive/plans/`: historical plans that must not be reused as active
  execution plans.
- `docs/misc/research/`: dated external research and investigation notes.
- `docs/adr/`: repo-wide architecture and workflow decisions.

Leave ambiguous feature directories at `docs/<feature>/` until their trace,
ledger, and current references agree. Do not archive `cron-scheduler`,
`turn-summary-lifecycle`, `multi-agent`, or similarly current/ambiguous docs
without a fresh evidence pass.

## Evidence Gate

Archive only with explicit evidence. Acceptable evidence includes:

- `Done`
- `Complete`
- `Implemented`
- `구현 완료`
- `Verified At`
- a clear supersession note pointing to the replacement document

Do not archive by age, filename, apparent staleness, or directory count pressure.
If the evidence is weak, record the uncertainty in the handoff and leave the
path active.

## Manifest First

Before moving documents, write a manifest in the cleanup handoff or trace:

```text
source path | destination path | reason | evidence line
```

Each row must include a concrete evidence line or reference-check result. Keep
root retention decisions in the same handoff when a historical-looking file
stays at root because scripts or docs still reference it.

## Required Updates

After moves, update the routing surface in the same change:

- `docs/README.md` for important destinations and lifecycle namespaces.
- `docs/archive/completed-work.md` for completed or archived work.
- `docs/adr/README.md` when decision-heavy docs move.
- `README.md`, `README.ko.md`, `CLAUDE.md`, and code comments only when they
  reference moved paths.

Runtime behavior changes are out of scope for cleanup unless the user asks for
them directly.

## Verification

Run these checks before claiming cleanup is complete:

```bash
rg -n "old/path/or/file" README.md README.ko.md CLAUDE.md AGENTS.md docs rules src
```

For every moved path, the only acceptable old-path hit should be the move
manifest itself.

Run a local markdown link resolver over:

```text
README.md README.ko.md CLAUDE.md AGENTS.md $(find docs rules -name '*.md')
```

Then run:

```bash
git diff --check
git status --short
find docs -maxdepth 1 -mindepth 1 | wc -l
```

Report `bd ready` failures as a workspace constraint when they are caused by the
known read-only SQLite error.
