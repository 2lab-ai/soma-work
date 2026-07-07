# Refactoring hotspots — plan and phase 1 execution

> Created: 2026-07-07 | Driver: autoz run (Slack goal: "soma-work 리팩토링 계획 세우고 리팩토링 진행해줘")
> Codex scope consult: session `0625f614-5770-414a-b64c-9d17091c80ef`

## Problem

`src/` has grown several files past the point where one file owns more than one
subsystem. Size + churn + test-coverage recon (2026-07-07, HEAD `dcdc992`):

| File | Lines | Importers | Tests | Churn (last 50 commits) |
|------|-------|-----------|-------|--------------------------|
| `src/conversation/dashboard.ts` | 5218 | 2 | 1 small file | low |
| `src/session-registry.ts` | 2279 | 16 | 5 files, strong | 4 |
| `src/token-manager.ts` | 2119 | 18 | 3 files, strong | low |
| `src/slack-handler.ts` | 1933 | 5 | strong | 4 |
| `src/slack/actions/choice-action-handler.ts` | 1382 | 0 | none | low |

## Ranked backlog

Value/risk ranking for behavior-preserving splits (codex-endorsed):

1. **session-registry goal-lifecycle extraction** — goal domain logic
   (legacy migration, per-goal time crediting, leg-owner stamping) is embedded
   in the registry while the rest of the goal domain lives in
   `@soma/slack/session-goal`. Strong black-box tests make this safe.
   → **Phase 1, executed by this plan.**
2. **dashboard.ts template extraction** — HTML rendering (~1.5k lines) is a
   mechanical seam, but test coverage is one small file. Needs
   characterization tests first. → Phase 2 candidate; do not split before
   adding route-level tests.
3. **token-manager usage-fetch + lease-reaper extraction** — internally
   modular already; extraction must preserve `CctStore` lock coordination.
   → Phase 3 candidate.
4. **ADR 0002 Pass 2** (port `claude-handler.ts` streaming to
   `agent-runtime`) — sanctioned architectural direction, but too large for a
   single autonomous PR. Needs its own spec/trace.
5. **choice-action-handler.ts** — zero importers but zero tests; write tests
   before any split.

Non-candidates: `slack-handler.ts` is the intended facade (CLAUDE.md); its
internals are already decomposed. `llm-runtime-adapter` plan is already
implemented (`packages/mcp-servers/llm/runtime/` exists) — that plan folder is
stale, not this one.

## Phase 1 — session-goal lifecycle extraction

### AS-IS

`src/session-registry.ts` (2279 lines) embeds goal-domain logic:

- `creditActiveGoalMs()` (L61-71) — per-goal active-time attribution
- `migrateLegacyGoal()` (L73-107) — load-time migration: `pendingEval` lease
  drop, retired `'blocked'` status coercion, `goalId` backfill, ralph-loop
  field backfill
- `migrateLegacyGoalArray()` (L109-113)
- leg-owner stamping inline in `beginTurn()` (L507-513)

Call sites: `beginTurn`/`endTurn` (L504/520), deserialize paths (L1980-82,
L2125-28), load-time orphan sweep (L2183).

The rest of the goal domain (queue ops, `findGoalById`, goal creation) already
lives in `packages/slack/src/session-goal.ts`. The registry should consume the
goal domain, not own parts of it.

### TO-BE

New module `src/slack/session-goal-lifecycle.ts` owning the four helpers,
typed against a narrow structural `GoalLifecycleSession` view (avoids the
`src/types.SessionGoal` vs `@soma/slack.SessionGoalState` duplication — the
module stays in `src/`, no cross-package type friction):

- `creditActiveGoalMs(session, elapsedMs)`
- `migrateLegacyGoal(goal)`
- `migrateLegacyGoalArray(arr)`
- `stampActiveLegGoalOwner(session)` — extracted from `beginTurn` inline block

`session-registry.ts` imports these; behavior byte-identical. Dedicated unit
tests pin the moved logic; existing 5 registry test files verify black-box
compatibility.

### Acceptance criteria (codex consult)

- `SessionRegistry` public API, exported types, persistence shape unchanged
- No serialized goal field renamed; migration semantics identical
- Dedicated tests for the extracted module (migration, crediting, stamping)
- Existing registry test files pass unchanged in intent
- `tsc --noEmit`, `biome check`, `vitest run` green
- No Slack payload/UI behavior change
- Extracted module imports no Slack/Claude/runtime concerns (goal domain only)
