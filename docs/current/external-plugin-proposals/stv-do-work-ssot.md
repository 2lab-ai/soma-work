# External Plugin Proposal — `stv:do-work` × `local:using-ssot`

Target: `oh-my-claude/stv` plugin (`skills/do-work/SKILL.md`). External marketplace — we cannot modify it from this repo. This file is the proposal we send upstream (PR or issue) so the same SSOT-TASK-TREE discipline applies when the host is `do-work` rather than `local:z`.

## Why

`do-work` is the closest sibling of `local:z` for STV-traced work: it selects unfinished `trace.md` scenarios, bundles them, runs `stv:work`, loops. Today, the inputs to that loop are trace scenarios and an ad-hoc TodoWrite mirror. There is no formal carrier for the **user's raw instruction(s)** that produced the trace in the first place, and no diff protocol when the user adds a drift instruction mid-loop.

`local:using-ssot` (in `2lab-ai/soma-work`) defines that carrier — SSOT, SSOT-LIST, SSOT-TASK-TREE (`ssot-task` + `ssot-subtask`) — plus four lifecycle hooks (intake / drift / handoff resume / completion report). The same shape maps cleanly onto `do-work`.

## Proposed changes to `oh-my-claude/stv` `skills/do-work/SKILL.md`

### Phase A (Task Selection) — add SSOT load

Before scanning `trace.md`:

1. Load the work item's SSOT-LIST + SSOT-TASK-TREE (carried in the session prompt or persisted alongside `docs/<feature>/trace.md` as `docs/<feature>/ssot.md`).
2. Output both on screen so the loop has the same SSOT visibility every iteration. `trace.md` scenarios should be cross-referenced to `ssot-task` IDs — a scenario in trace.md that has no `ssot-task` mapping is suspect (either the trace is over-scoped or a `ssot-task` is missing from the tree).
3. The Implementation Status table gains a `ssot-task` column.

### Phase B (STV Work Execution) — pass SSOT context to `stv:work`

Forward the SSOT-LIST + SSOT-TASK-TREE to `stv:work` so the implementer has user-language requirements, not just trace-language scenarios.

### Phase C (Context Check) — drift detection

If the user posts a new raw instruction during the loop:

1. Treat as drift per `local:using-ssot` Hook 2.
2. Append to SSOT-LIST.
3. Regenerate SSOT-TASK-TREE, diff at `ssot-task` granularity.
4. Re-scan `trace.md` for new/changed scenarios. Updated scenarios get appended to the work bundle, not the head of the loop — finish the current scenario before switching.
5. If the diff is `removed`-only and the loop has already completed the affected scenarios, surface to the user as a no-op + irreversibility note. Do not silently undo.

### Phase D (Loop Decision) — completion report

When the loop terminates (all `ssot-task` covered OR user input requested), produce the completion report per `local:using-ssot` Hook 4:

- SSOT verbatim
- SSOT-TASK-TREE final state
- Per-`ssot-task`: requirement / did / why-it-satisfies / trace scenario IDs

## Reference

- `src/local/skills/using-ssot/SKILL.md` in `2lab-ai/soma-work` — the canonical definition.
- `src/local/skills/autoz/SKILL.md` — the autonomous variant that uses all four hooks.
- `src/local/skills/z/SKILL.md` — the controller that runs Hook 1 in phase0 and Hook 4 in phase5.

## Action items (we own)

- [ ] Open issue against `oh-my-claude/oh-my-claude` referencing this file.
- [ ] If accepted upstream, drop this file once the upstream change ships.
- [ ] If declined, decide whether to ship a `local:do-work` thin wrapper in `soma-work` that wraps `stv:do-work` with the SSOT hooks added at the boundary.
