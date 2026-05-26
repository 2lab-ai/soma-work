# Work Plan — Turn-End Surface Guarantee Phase 2 (followup of PR #969)

**Trigger**: `$autoz` on PR #969 followup
**Brief**: Revert PR #926 external `StreamStallWatchdog` + wire the C-1
idle-timeout INSIDE `StreamProcessor.process` (per-`.next()` race).
Phase 1 (PR #969) explicitly committed to this Phase 2 in its body.
**작성자**: Z + Zhuge, 2026-05-26
**Codex binding**: session `5e6ab801-3d1a-4651-a406-f0d6c994e7db`
**관련 문서**: [`exhaustive-paths.md`](./exhaustive-paths.md), [`work-plan-b-bundle.md`](./work-plan-b-bundle.md), [`trace.md`](./trace.md)

---

## 0. Scope decision (binding)

PR #969 ("Phase 1 of 2") body explicitly committed:

> **Phase 2** (next PR): revert #926 watchdog + wire C-1 idle-timeout.

Codex binding `5e6ab801` confirmed single PR (`Q6`): revert + replace
together so neither side ships without the other. Splitting would
either ship a regression (revert without replacement) or a no-op
addition (replacement next to redundant watchdog).

### In scope
- Delete `StreamStallWatchdog` class + provider shim + dedicated test
  + 2 wire-up regression tests in `stream-executor.test.ts`.
- Add `readIdleTimeoutMs()` + `DEFAULT_IDLE_TIMEOUT_MS` (30 min) +
  `IDLE_TIMEOUT_ENV_VAR = 'SOMA_STREAM_STALL_TIMEOUT_MS'` in
  `packages/slack/src/stream-processor.ts`.
- Add `idleTimeoutMs` constructor option + `onIdleTimeout` callback +
  `raceNextStep()` private method to `StreamProcessor`.
- Rewrite `StreamProcessor.process()` body: manual iterator + per-
  `.next()` `Promise.race` against idle timer and abort signal.
- Wire `stream-executor.ts`'s callbacks to feed `idleTimeoutMs:
  readIdleTimeoutMs()` and `onIdleTimeout: () => abortController
  .abort('stall-timeout' satisfies RequestAbortReason)`.
- Remove all watchdog exports/typesVersions/subpaths and contract
  test entries that pointed at the deleted module.
- Update `trace.md` and `exhaustive-paths.md` to reflect the
  in-process implementation.

### Out of scope (carry forward to next plan)
- B-2 unknown-reason lint rule (still in backlog).
- B-4 / B-5 / B-6, C-3 / C-4 / C-6 (P1+).
- `V1QueryAdapter.cancel/dispose` untagged abort audit.
- `includePartialMessages: true` SDK option — codex `5e6ab801` Q3:
  partials would NOT solve a silent pending `.next()` since they
  only flow when the SDK actually emits something. Tracked as
  optimization backlog, not a Phase 2 prerequisite.

---

## 1. File-level changes

### 1.1 `packages/slack/src/stream-processor.ts`
- Add `onIdleTimeout?: () => void` to `StreamCallbacks`.
- Add `StreamProcessorOptions { idleTimeoutMs?: number }`.
- Add `DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000` and
  `IDLE_TIMEOUT_ENV_VAR = 'SOMA_STREAM_STALL_TIMEOUT_MS'`.
- Add `readIdleTimeoutMs(env = process.env): number` — same operator
  contract as PR #926's `readStallTimeoutMs` (`0` disables;
  invalid/non-finite → default; positive → ms). Only the function
  name and the default change.
- Add `asyncIteratorOf<T>(stream)` module-level helper: adapt sync
  iterables (used by tests via `function*`) to the async-iterator
  protocol so `process()`'s explicit-iterator form works for both
  shapes.
- Constructor: `constructor(callbacks = {}, options: StreamProcessorOptions = {})`.
- Add private `raceNextStep(iterator, abortSignal)`: returns a
  discriminated union `{ kind: 'value' | 'done' | 'aborted' |
  'idleTimeoutMs' }`. Maps `next()` AbortError rejections to
  `kind: 'aborted'` so the outer loop returns `aborted: true`.
  Attaches a no-op `.catch` to the unused `nextPromise` after the
  race resolves to neutralize late rejections (defense-in-depth).
- Rewrite `process()` body to call `raceNextStep` per iteration.
  Handle `idleTimeoutMs` branch by invoking `onIdleTimeout()` (swallow
  throws), best-effort `iterator.return?.()`, and returning
  `aborted: true`.

### 1.2 `packages/slack/src/pipeline/stream-executor.ts`
- Remove `import { readStallTimeoutMs, StreamStallWatchdog } from './stream-stall-watchdog'`.
- Extend the existing `StreamProcessor`/`StreamCallbacks` import to
  add `readIdleTimeoutMs`.
- Replace the `new StreamStallWatchdog(...)` block (former L898-902)
  with `const idleTimeoutMs = readIdleTimeoutMs();` and an updated
  comment explaining where the idle timeout now lives.
- Replace `stallWatchdog.touch()` inside `onSdkActivity` with an
  explanatory comment (no-op — idle timer resets implicitly per
  `.next()` resolution).
- Add `onIdleTimeout` to `streamCallbacks`:
  `() => abortController.abort('stall-timeout' satisfies RequestAbortReason)`.
- Construct `new StreamProcessor(streamCallbacks, { idleTimeoutMs })`.
- Remove `stallWatchdog.arm()` before `processor.process(...)`.
- Remove `stallWatchdog.clear()` in the outer `finally`.

### 1.3 Deletions
- `packages/slack/src/pipeline/stream-stall-watchdog.ts`
- `src/slack/pipeline/stream-stall-watchdog.ts` (provider shim)
- `src/slack/pipeline/__tests__/stream-stall-watchdog.test.ts`

### 1.4 Export / contract cleanup
- `packages/slack/src/pipeline/index.ts`: drop the
  `{ DEFAULT_STALL_TIMEOUT_MS, readStallTimeoutMs, STALL_TIMEOUT_ENV_VAR,
  StreamStallWatchdog }` re-export.
- `packages/slack/src/index.ts`: drop the same re-export.
- `packages/slack/package.json`: drop `./pipeline/stream-stall-watchdog`
  from `exports` and from `typesVersions[*]`.
- `src/__tests__/packages-srp-phase2-slack-contract.test.ts`: drop
  `'./pipeline/stream-stall-watchdog': '...'` from the expected
  exports map and `'pipeline/stream-stall-watchdog'` from the
  `movedModules` array.
- `src/slack/pipeline/__tests__/stream-executor.test.ts`: drop the
  two `StreamStallWatchdog` import-and-wire-up regression tests.
  Replace with a single condensed `first-reason-wins` assertion
  using `AbortController` directly — the contract we depend on is
  about `AbortController` semantics, not about the deleted class.

### 1.5 New tests (RED → GREEN)
- `src/slack/__tests__/stream-processor-idle-timeout.test.ts`
  (11 tests):
  - `process()` fires `onIdleTimeout` and returns `aborted: true`
    when `iterator.next()` never resolves.
  - Each yielded message resets the idle timer.
  - `idleTimeoutMs <= 0` disables.
  - External abort while `.next()` is pending exits promptly
    without waiting for the idle timeout.
  - Normal completion clears the timer (no late `onIdleTimeout`).
  - `readIdleTimeoutMs` env reader: unset → default; empty → default;
    `0` → 0; negative → 0; non-finite → default; positive → parsed ms.

### 1.6 Docs
- `docs/current/plans/turn-end-surface-guarantee/trace.md`:
  - Replace the "Stall watchdog (auto-abort) — installed in the PR
    that adds this section" section with "SDK idle timeout
    (auto-abort) — Phase 2 wiring".
  - Delete the duplicate "Stall watchdog (auto-abort) — installed
    in PR #926 (KEPT this PR)" section.
  - Add Phase 2 codex decision entry.
- `docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md`:
  - Mark C-1 as **fixed in Phase 2**.
  - Update the §D summary row for C-1.
  - Update §E.10 (PR #926 revert checklist) to reference Phase 2
    completion and reference the in-process replacement.
- `docs/current/plans/turn-end-surface-guarantee/work-plan-phase2.md`
  (this file).

---

## 2. Implementation order

```
0. branch: fix/turn-end-surface-guarantee-phase2
1. RED test file: stream-processor-idle-timeout.test.ts (11 tests)
2. Confirm RED on the file.
3. Implement readIdleTimeoutMs + StreamProcessor constructor option
   + raceNextStep + process() rewrite + asyncIteratorOf helper.
4. Confirm GREEN on the new file AND no regression on the existing
   src/slack/__tests__/stream-processor.test.ts (38 tests).
5. Wire stream-executor.ts: import, remove watchdog block, add
   onIdleTimeout callback, pass {idleTimeoutMs} to StreamProcessor.
6. Delete watchdog files (mv to .trash, then git rm).
7. Remove exports / typesVersions / subpaths / contract test entries.
8. Rewrite the 2 watchdog wire-up tests in stream-executor.test.ts
   as the condensed first-reason-wins regression.
9. Rebuild @soma/slack, run impacted vitest files.
10. Update docs.
11. Full suite + tsc + biome check.
12. Commit, push, open PR.
```

---

## 3. Risks + mitigations

| 위험 | 완화 |
|---|---|
| Race-based loop breaks the existing 38 stream-processor tests (sync generators). | Added `asyncIteratorOf` shim that wraps sync iterators into async ones. Verified by re-running existing test file: 38/38 pass. |
| Late rejection of the abandoned `next()` becomes unhandled rejection. | Attached no-op `.catch` to `nextPromise` after the race resolves; mapped AbortError to `kind: 'aborted'` so the AbortError path is silently consumed. |
| `iterator.return()` after timeout throws and propagates. | Wrapped in try/catch; debug-log only. SDK transport is considered dead at that point. |
| Operators on `SOMA_STREAM_STALL_TIMEOUT_MS=0` lose protection — but they already opted in to that. | Behavior preserved; comment in `readIdleTimeoutMs` JSDoc. |
| 10-min users who explicitly set `SOMA_STREAM_STALL_TIMEOUT_MS=600000` keep that value. | Backward compat: env var name and parser unchanged; only the *default* moves from 10 → 30 min. |
| Phase 1 once-guard / B5 fallback / `endTurn` ordering changes. | Phase 2 only touches the watchdog wiring; Phase 1 fixes are untouched. Verified by running the impacted Phase 1 tests. |

---

## 4. Codex decision log

Single session `5e6ab801-3d1a-4651-a406-f0d6c994e7db`:

| Q | Decision | Rationale (condensed) |
|---|---|---|
| Q1 | Wire idle-timeout INSIDE `StreamProcessor.process` via per-`.next()` race. | External `StreamStallWatchdog` was cosmetically equivalent but sat OUTSIDE the stuck `.next()` — same `'stall-timeout'` abort signal it sent could not unblock a hung iterator if the SDK did not honor abort. |
| Q2 | Default 30 min; keep `SOMA_STREAM_STALL_TIMEOUT_MS`, `<=0` disables. | 10 min killed legitimate long-running tools (`user:dev`, big deploys); 30 min preserves the safety net. |
| Q3 | Do NOT set `includePartialMessages: true` as the fix. Track as backlog optimization. | Partials need the SDK to emit something; do not solve a silent pending `.next()`. |
| Q4 | Reuse `'stall-timeout'` `RequestAbortReason`. | `handleError` already routes that reason to the Korean 🔴 card; coining `'sdk-idle-timeout'` is needless union fanout. |
| Q5 | Tests: never-yielding stream, yield-then-hang reset semantics, `idleTimeoutMs<=0` disable, external abort exits promptly, normal-completion no-late-fire, env reader corners. | All covered in the new RED file. |
| Q6 | Single PR (revert + replace). | PR #969 promised both; splitting either ships a regression or a no-op add. |
| Q7 | Keep `SOMA_STREAM_STALL_TIMEOUT_MS` env var name. | Operators already use it; only the implementation owner changes. |
