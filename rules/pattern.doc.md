# Documentation Cleanup Pattern

Root and `docs/` cleanup is not an indexing exercise. A valid cleanup must
reduce the visible surface area, preserve live execution context, and leave a
small routing map that future agents can trust.

## Handoff Summary

The 2026-05-18 docs cleanup handoff says the previous pass added useful
scaffolding (`docs/README.md`, `docs/archive/completed-work.md`, `docs/adr/`,
`docs/misc/research/`, `docs/misc/handoffs/`) but did not actually reduce root/docs
clutter enough.

The next cleanup pass must physically group or archive documented clutter, not
just add more indexes. Do this conservatively: moving an active spec is worse
than leaving an ambiguous directory in place.

## Root Rule

Root is for product, build, config, and agent entrypoints only.

Allowed top-level markdown files:

- `README.md`
- `README.ko.md`
- `CLAUDE.md`
- `AGENTS.md`

Do not add task notes, investigation notes, phase plans, handoffs, or research
documents at repo root. Route them into `docs/`.

Before moving any non-markdown root file, verify references with `rg`.
Historical-looking files such as old Slack app manifests may be moved to
`docs/archive/manifests/` only after references are checked. Runtime/setup
entrypoints such as scripts, Docker files, Makefile, config examples, and
health checks stay at root unless their callers are updated in the same change.

## Docs Top-Level Rule

`docs/` top level should contain evergreen documents and routing indexes only.
Everything else should be grouped by lifecycle and purpose.

Keep at top level only when the document is broadly current and repeatedly
referenced, such as:

- `docs/README.md`
- `docs/misc/reference/architecture.md`
- `docs/misc/reference/workflow.md`
- `docs/misc/reference/slack-block-kit.md`
- other current, cross-cutting operational docs

Route new or moved documents into these namespaces:

| Location | Use |
|---|---|
| `docs/current/spec/` | Evergreen product/system specs |
| `docs/<feature>/spec.md` + `docs/<feature>/trace.md` | Active or ambiguous feature work when not yet regrouped |
| `docs/current/plans/` | Active feature specs/traces when doing a larger regroup |
| `docs/archive/features/` | Completed, stale, or superseded feature specs/traces |
| `docs/misc/debugging/current/active/` | Current debug traces |
| `docs/archive/debugging/` | Completed or historical debug traces |
| `docs/archive/plans/` | Historical plans that must not be treated as active execution plans |
| `docs/misc/research/YYYY-MM-DD-topic.md` | External research or dated findings |
| `docs/adr/000N-title.md` | Durable repo-wide decisions |
| `docs/misc/handoffs/YYYY-MM-DD-topic.md` | Incomplete work handoff notes |

Do not create a new namespace just because one file does not fit neatly. Prefer
the existing map in `docs/README.md`.

## Archive Decision Rule

Never archive by filename, age, or vibes. Archive only with evidence.

A feature/debug/planning document is an archive candidate when at least one is
true:

- its `trace.md` has explicit `Done`, `Complete`, `Implemented`, or
  `구현 완료` evidence;
- its `spec.md` status is implemented and there is matching verification or
  trace evidence;
- it is explicitly superseded by a newer trace/spec;
- it is a historical phase plan that should not be used as an active plan.

If status is ambiguous, leave it active/reference and record the ambiguity in
the cleanup manifest instead of guessing.

## Move Manifest First

Before applying `git mv`, create a temporary manifest in the cleanup trace or
handoff:

```text
source path | destination path | reason | evidence line
```

Use one row per move. The evidence line must point to a local line, status
marker, link, or reference check result that explains why the move is safe.

Good first candidates to audit:

- feature directories with both `spec.md` and `trace.md`;
- old `docs/slack-ui-phase*.md` phase documents;
- historical plans under `docs/PLANS/`;
- root historical manifests after reference checks.

## Link And Index Updates

Every move must update the routing surface in the same change:

- update `docs/README.md` when a new namespace or important destination changes;
- update `docs/archive/completed-work.md` when a completed item becomes easier to find;
- update `README.md`, `README.ko.md`, and `CLAUDE.md` only when their linked
  entrypoints changed;
- search old paths with `rg -n "old/path/or/file" README.md README.ko.md CLAUDE.md docs`.

Do not leave stale links for a later pass.

## Verification

For documentation-only cleanup, verify the changed boundary:

```bash
git status --short
git diff --check
```

Run a local markdown link resolver over changed markdown files. At minimum,
changed root docs and moved/edited `docs/**/*.md` files must resolve local
links.

Repo-wide lint/test failures must not be claimed as introduced or fixed unless
you actually investigated them. If baseline `npm run lint` or `npm test`
failures already exist, report them as baseline and unrelated.

## Completion Criteria

Do not call a root/docs cleanup complete until all are true:

- root top-level clutter is removed or every remaining noisy item has a
  documented reason to stay;
- `docs/` top-level count is materially reduced or grouped by lifecycle;
- active docs, archived docs, ADRs, handoffs, and completed work are findable
  from `docs/README.md`;
- moved docs have updated links;
- `git status --short` contains only intended cleanup changes;
- `git diff --check` passes;
- local markdown links pass for changed markdown files;
- skipped lint/test failures are identified as baseline or out of scope.
