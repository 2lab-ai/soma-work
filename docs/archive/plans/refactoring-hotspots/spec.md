# Refactoring hotspots — plan and execution (COMPLETE)

> Status: **complete** (2026-07-08). Four refactoring PRs merged; remaining
> strategic items converted to tracked issues (#1220 dashboard, #1221 ADR 0002
> Pass 2, #1222 choice-action-handler tests, #1223 CI deadcode enforcement).
> Token-manager extraction explicitly rejected — see "Closure" below.

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

## Drift (2026-07-07): Musk 5-step ordering is binding

Mid-run the user mandated the ordering principle for this plan (SSOT_2):

> 1. Question every requirement 2. Delete the part or process 3. Simplify or
> optimize 4. Accelerate cycle time 5. Automate — "The most common mistake of
> smart engineers is to optimize a thing that should not exist."

Consequence: deletion outranks code-motion. Splitting a live file is step 3;
it only happens after step 1-2 have removed what should not exist. Codex
consult `51b9ebc9` endorsed the reorder.

## Execution record

| Round | PR | What | Result |
|-------|----|------|--------|
| Phase 1 (pre-drift) | #1208 (merged) | session-goal lifecycle extraction from `session-registry.ts` | registry 2279→~2190 lines, 17 new tests |
| Delete round 1 | #1209 (merged) | knip-verified dead files: 4 legacy SRP shims, `@deprecated` `action-handlers.ts` compat, stray `permission-server-start.js`; barrels pruned to single-importer surface; contract-test shim mandate narrowed; stale `llm-runtime-adapter` plan archived | +33/−136, 6 files deleted |
| Delete round 2 | #1213 (merged) | knip-flagged unused exports: 1 dead function deleted (`getGitHubTokenForCLI`), 17 exports demoted to module-private across 12 files (each grep-verified zero external importers) | −33 net code, export surface −18 |

## Re-scoped backlog (Musk-ordered)

Step 2 (delete) — round 3 (#1219, merged):
- `src/slack/output-flags.ts` shim deleted; its 6 importers now import
  `@soma/slack/output-flags` directly; contract-test mandate entry removed.
- Demoted: `UsageLimitDispatchError`, `NATIVE_ONE_M_RE`,
  `SLACK_BLOCK_KIT_CHANNEL_NAME`, `recentEpisodicDates`, 3 user-skill modal
  callback IDs, `AUTOSKILL_ADD_MODAL_CALLBACK_ID`. Deleted: `MAX_GOAL_HISTORY`
  dupe in `src/types.ts` (single source now `@soma/slack/session-goal`),
  `rulesByIds`/`OAUTH_BLOB_WARN_THRESHOLD` dropped from re-export lists.
- Dynamic-consumption false positives (`import * as m` + `(m as any).fn` in
  `src/slack/session-manager.ts`) documented with `@public` JSDoc tags:
  `getConversationUrl`, `getStatusEmoji`, `extractJiraKey`,
  `fetchJiraTransitions`; `formatRateLimitSource` tagged (test-consumed).

Step 3 (simplify) — candidates from the ranked backlog, in order:
1. `dashboard.ts` (5218 lines): FIRST question which routes/templates are
   actually used (step 1-2), then characterization tests, then split.
2. `token-manager.ts` usage-fetch/lease-reaper extraction (preserve `CctStore`
   lock coordination).
3. ADR 0002 Pass 2 (needs own spec/trace; too large for one autonomous PR).
4. `choice-action-handler.ts`: tests before any split.

Step 5 (automate) — DONE in round 3: curated `knip.json` (workspace entries,
skill scripts ignored, bin files) + `npm run deadcode` (knip, files+exports),
currently exit 0. Wire into CI when the team wants it enforced; unused
exported *types* (182) remain report-only backlog.


## Closure (2026-07-08)

Executed: #1208 (goal-lifecycle extraction), #1209 (dead-file sweep),
#1213 (dead-export prune), #1219 (output-flags shim removal + `npm run
deadcode` automation, exit 0 on main).

Remaining simplify candidates dispositioned per the Musk step-1 test
(codex consult `bbe510c4`):

- `dashboard.ts` → #1220 (question routes → characterization tests →
  split; tests are a hard gate before any split).
- ADR 0002 Pass 2 → #1221 (own spec/trace; multi-PR program).
- `choice-action-handler.ts` → #1222 (characterization tests first;
  extraction only under feature pressure).
- CI deadcode enforcement → #1223 (team decision; gate already exit 0).
- **token-manager usage-fetch/lease-reaper extraction — REJECTED.**
  Pure code-motion on a working, well-tested subsystem with live
  `CctStore` lock coordination and no current feature pressure:
  "the most common mistake of smart engineers is to optimize a thing
  that should not exist." Revisit only when token-manager next needs
  feature work.
