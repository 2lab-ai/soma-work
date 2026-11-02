# {feature} — done (append-only)

Loop: ./loop.md · Each round close appends one block at the bottom; nothing above it ever changes (this skill's `scripts/loop-lint.py` C2 compares against git). Rows here are snapshots (Last Measured frozen at move time). A later pass is a `re-verified` line in a loop.md round section; a regression reopens as a new loop.md row with Source `regression:<ID>`.

<!-- One block per closed round, appended below. The first split of a legacy single-file driver is one block holding all its closed rows and its whole round log. -->

## R<n> — closed <ts>

- measured a✅ b🟡 c🔴 d🚪 e⚫ · result: <...> · closed rows: <IDs> · commit/PR: <...>

### Closed rows

| ID | Source | Universe Item | Observable Acceptance | AS-IS Evidence | Status | Gap | Dispatch | Verification Evidence | Last Measured |
|---|---|---|---|---|---|---|---|---|---|

### Round section (as it was in loop.md)

<the round's plan and log lines, unchanged>
