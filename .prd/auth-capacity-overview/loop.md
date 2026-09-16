# Auth capacity execution loop

Status: in-progress
Date: 2026-09-16

[SSOT](ssot.md) · [Spec](../06-auth-capacity-spec.md) · [Architecture](../07-auth-capacity-architecture.md) · [Evidence](verification.md)

## Skill and working tree

The requested `using-dotprd` definition was recovered from zbrain commit `2fef422eb63070bc01f1b629faa1734a3b4a83a9` on 2026-09-16 and read with its `rules/DEV.md`. See [skill provenance](ssot.md#skill-availability). Numbered documents remain in-progress, not shipped.

Branch: `feat/auth-capacity-overview`. The dedicated clone `soma-work_20260916_auth` inside the session directory provides isolation. Work started there before the external skill's linked-worktree convention was recovered; no second tree is created over active edits. No production deployment is authorized by this ledger.

## Work-unit ownership

- WU1 / T1–T2: parent owns `auth/capacity.ts`, `auth/builder.ts`, status DTO and capacity tests. Grouped totals and reset planning implemented.
- WU2 / T3: implementation agent owns auth actions, ids, topic renderer and their tests. Default overview and explicit admin mode implemented.
- WU3 / T3: same implementation agent owns legacy embedding, CCT mutation origin/page metadata and associated tests. Pagination fixed; mutation continuity under correction.
- WU4 / T1–T4: parent owns numbered PRD, SSOT and final evidence; documentation agent updated both READMEs and architecture reference.
- Review: independent Fable reviewer; not represented as a trinity or dual-engine consensus.

## Build facts

Commands read from package.json and CI:

- `npm run build:somalib && npm run build:packages` before root TypeScript/tests
- `npx tsc --noEmit`
- `npm run check`
- `npm run test:release` (forked isolated single worker, CI's test command)
- `npm run build`

Run tests without inherited bot credentials/config. The evidence harness uses `env -i`, preserves PATH and supplies isolated HOME, TMPDIR, DATA_DIR and SOMA_DATA_DIR under session evidence. A four-way baseline/worktree × clean/contaminated experiment reproduced all 21 unrelated failures only under synthetic contaminated environment; no production behavior was changed to make tests pass.

## Rounds and gaps

- R1 [BUNDLE]: grouping, totals, reset and admin navigation RED→GREEN; actual builder JSON rendered as synthetic Slack CSS previews.
- R2 [BUNDLE]: review found composed legacy cards exceeding 50 blocks. Slot pagination fixes the envelope while keeping every account reachable.
- R3 [BUNDLE]: embedded mutations rebuilt the bare legacy card, losing navigation and the bound. Origin/page retention fixed; independent review APPROVE after the bounded recheck. Final regression sweep: 63 files / 879 tests passed.
- R4 [RULES]: recovered using-dotprd; promoted numbered spec/architecture and recorded delivery gates. Earlier unavailable-skill claim superseded by direct-source recovery.

Open gap matrix:

- G1: legacy mutation continuity — closed by RED/GREEN tests and review round 3
- G2: final frozen lint/typecheck/build/full-release receipts — closed; 531 files, 10,583 tests passed (5 skipped), including invalid-reset and legacy-refresh fixes
- G3: independent review verified G1; final autonomous review and trace refresh pending
- G4: PR/CI/merge and permitted preview deployment receipts — not yet present
- G5: deployed Slack observation — not replaced by mocks or CSS screenshots

## Unknowns map

- Known facts: status has ratios/reset times, not subscription token balances; card state is message-encoded
- Questions closed by research: Grok raw counts are discarded and reset is synthetic; Codex reset entitlements are real counts
- Existing behavior found: `current_by_group` was unused; CCT owns separate block budgets and mutation re-render paths
- Boundary risks checked: expired/malformed telemetry, forged viewer state, large fleets, inherited test environment

## Exit contract

Code, tests, docs, review, CI and observed preview behavior must agree. Post the requirement-to-evidence mapping on the PR or source issue. Do not mark numbered documents shipped while a required receipt is absent. Production deployment remains a separate approval boundary.
