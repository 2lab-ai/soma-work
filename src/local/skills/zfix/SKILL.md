---
name: zfix
description: "Verify-first variant of local:z. Use when implementation already exists but has gaps. Detects intent-vs-impl gaps via scenario trace, then dispatches to local:z pipeline."
---

# zfix — Gap-Driven z Execution

## What zfix Is (and Isn't)

**zfix is not a new workflow.** It is `local:z` with an added INTAKE step: scenario-trace the gap between user intent and existing implementation, emit a gap-spec issue, then hand off to the standard z pipeline.

- `$z {issue}` — no implementation exists yet.
- `$zfix {issue} {PR...}` — implementation exists but is broken / incomplete / unreachable / misaligned with intent.

Once the gap is detected and written as an issue, zfix is done. Planning, implementation, review, CI, approve — all of that stays in `local:z` / `local:zwork` / `local:zcheck`. If zfix re-implements any of those phases, it is wrong.

## Trigger

- User reports "it doesn't work" on a shipped PR.
- PR merged, but a scenario from the issue is not reachable end-to-end.
- Review finds dead code, unwired registry, missing entry-point hook.
- Explicit: `$zfix {issue-ref} {pr-ref...}` (PR list optional — infer from issue if omitted).

## Process

### Phase INTAKE — Gap Detection (zfix-specific)

1. **Read intent.** Issue title + body + all comments. Extract user-facing scenarios exhaustively — happy path, edge cases, error paths, integration points.
2. **Read implementation.** PR body + full diff. Assume nothing works. "Function exists" is not evidence.
3. **Trace each scenario via `local:ztrace`** — callstack depth, not API surface. For every scenario, list each gate the call must cross: entry → validation → dispatch → handler → side-effect → exit. Classify:
   - ✅ Works — full path verified
   - ⚠️ Partial — path exists but lacks validation / test / edge case
   - ❌ Blocked — path broken, code unreachable, or dead
4. **Emit gap spec via `stv:new-task`.** The new issue contains:
   - Scenario table with classifications
   - For each ❌/⚠️: the exact failing gate + root cause
   - The coverage dimension that was missed (see Meta-Principle below)

### Phase DISPATCH — Hand off to local:z

Input to `local:z` is the new gap-spec issue.

- Planning → `local:z` phase1
- Implementation → `local:zwork`
- Verification / CI / review resolution → `local:zcheck`
- Approve request → `local:zcheck`

zfix writes no code, runs no CI, resolves no review comments. It only detects the gap.

## Meta-Principle: End-to-End Trace Discipline

Gaps are not random. They cluster along **coverage dimensions** — places where a new concept must be registered in N layers but only lands in M < N. Scan for these during INTAKE, regardless of language or framework:

- **New enum / union member** → every `switch`, `if/else`, allowlist, schema enum, external tool descriptor must list it.
- **New registry / catalog entry** → every process that boots the app must register it (main, worker, separate MCP / sidecar processes, test harness).
- **New handler / command** → router + test + any LLM-facing prompt or schema.
- **New DI binding** → every site that constructs the container.
- **New entry-point argument / env var** → every launcher (CLI, docker, CI, dev script).

Missing any one of these makes the feature unreachable — the exact shape of "dead code that looks alive in review".

## Rules

- **Trace at callstack depth.** Reachability from the entry point is the only proof.
- **Do not build a parallel pipeline.** INTAKE only. Everything else is `local:z`.
- **Missing tests are gaps.** Untested reachable code is ⚠️ Partial.
- **Name the miss pattern.** After fixing, record which coverage dimension was missed — so the next feature does not repeat it.
- **If you are writing implementation details in zfix, stop.** Dispatch to `local:z`.
