# Phase 1 unknowns map (explore-unknowns, autonomous mode)

> 2026-07-07 | Scope: session-goal lifecycle extraction from `src/session-registry.ts`

## Q1 — Known knowns (verified territory)

- Extraction surface is exactly 4 concerns: `creditActiveGoalMs` (L61-71),
  `migrateLegacyGoal` (L73-107 + doc comment L36-54), `migrateLegacyGoalArray`
  (L109-113), leg-owner stamping inline in `beginTurn` (L507-513).
- All call sites enumerated by grep: L504, L512-513, L520, L1980-82, L2125-28,
  L2134, L2183. No other file references these module-private functions.
- `src/__tests__/session-registry.test.ts` covers the behavior black-box only
  (imports `SessionRegistry` alone; `describe('migrateLegacyGoal on
  loadSessions')` L993, time-attribution suite L1072) — moving code cannot
  break test imports.
- Goal queue domain already lives in `packages/slack/src/session-goal.ts`;
  `src/slack/session-goal.ts` is a re-export shim. `findGoalById` accepts a
  structural `GoalQueueSession`, so the new module can pass a narrow view.

## Q2 — Known unknowns (closed before RED)

- Do registry tests reach module internals? → Closed by territory: only
  `SessionRegistry` is imported (L8 of the test file).
- Type identity: `src/types.SessionGoal` vs `@soma/slack.SessionGoalState` are
  duplicated shapes. → Closed: keep the module in `src/`, type against
  `src/types.SessionGoal`; structural compatibility with `findGoalById`
  already proven by the existing code compiling.
- Import cycle risk (`session-goal-lifecycle` ← `session-registry`)? → Closed:
  new module imports only `./session-goal` shim + `../types`; no path back to
  the registry.

## Q3 — Unknown knowns (landmines, from codex consult)

- `migrateLegacyGoal` returns **copies** (`{ ...goal }` rebinding);
  `creditActiveGoalMs` **mutates in place**. Preserve exactly — mixing the two
  styles breaks persistence or attribution silently.
- Serialized field names (`goal`, `goalQueue`, `goalHistory`,
  `activeLegGoalId`) must not change — pre-existing `sessions.json` files in
  prod must load identically.
- `stampActiveLegGoalOwner` must stamp `epoch ?? 0` (not `undefined`) when a
  goal is active — the turn-end evidence stash keys on the epoch to detect
  in-turn objective changes.

## Q4 — Unknown unknowns (conservative defaults)

- Hidden dynamic access to the function names: none plausible
  (module-private today); default = full `vitest run` + `tsc --noEmit` +
  `biome check` before PR, full CI after.
- Doc drift: CLAUDE.md architecture table does not enumerate these helpers —
  no doc update forced; plan folder carries the record.
