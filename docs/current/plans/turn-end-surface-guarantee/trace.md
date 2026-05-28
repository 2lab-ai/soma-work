# Turn-End Surface Guarantee — Vertical Trace

> STV Trace | Created: 2026-05-14
> Related: docs/turn-notification/trace.md, docs/archive/features/turn-summary-lifecycle/trace.md, docs/rich-turn-notification/trace.md
> Anthropic SDK doc: https://code.claude.com/docs/en/agent-sdk/streaming-output.md

## Invariant (revised 2026-05-28 after textual-ASK false-positive)

Every model-turn end MUST surface exactly one terminal Slack Block Kit card. **The user's binding definition of the four terminal categories**:

| User-defined meaning | `TurnCategory` | Card |
| :--- | :--- | :--- |
| 모델이 end_turn 발화로 종료 (정상 완료) | `WorkflowComplete` | 🟢 `작업 완료` |
| 모델이 ASK / pending choice로 유저 입력 필요 표시 | `UIUserAskQuestion` | 🟠 `유저 입력 대기` |
| **즉시** 발생한 모델 / 코드 에러 (SDK throw, max_turns, parse fail 등) | `Exception` | 🔴 `오류 발생` |
| idle-timeout fire — 모델이 end_turn / ASK를 보내지 않은 채 N 시간 침묵 | `Stalled` | ⚫ `응답 없음 — 코드 버그 의심` |

**Important**: `Stalled` is **NOT** an immediate error — it's a **code-bug signal**. A `Stalled` card means our pipeline failed to surface a terminal signal in time. Per user's invariant `"이렇게 타임아웃나는 경우를 모두 제거하라"`, each `Stalled` card observed in production must be turned into a follow-up task that removes the underlying code path. The timer is now an **observability tool**, not a fail-safe.

Degraded enrichment (no usage %, no token stats) is **not** a separate category — it is the same terminal state rendered with reduced fidelity. Codex P1 binding decision (session `e294db6b-b322-4ec5-aed4-e05cf9a07d0b`, 2026-05-14): "Degraded enrichment is not a fourth terminal state; it is a reduced-fidelity rendering of the same terminal state."

### Why `Stalled` was split out (2026-05-28)

PR #970 wired an in-process idle-timeout race for hung SDK iterators (C-1). Production observation (session `C0AKY7W2UGZ-1779941197.183069`): the assistant emitted text `"백그라운드 검색이 이제 완료됐다. 유저 응답 대기 중. 응답이 오면 선택된 그룹별로 코드 수정 → 커밋 → PR 푸시."` then went silent for 30 min while the user thought. Timer fired → 🔴 `Exception` card posted. The card was correct (no SDK activity) but the category was wrong (it's not an immediate error). User feedback (2026-05-28): `"녹색 - 모델에게 턴종료 메세지를 받고 완료 / 오렌지 - 모델에게 턴종료인데 유저 입력때문에 턴종료한경우 / 빨간색 - 기타 즉시 모델에서 혹은 코드에서 에러나 날 경우 ... 이렇게 타임아웃나는 경우를 모두 제거하라고"`. Resolution: split `Stalled` (⚫) out of `Exception` and document the timer as an investigation queue, not a fail-safe. Backlog item T4 — eliminate every code path that fires the timer.

## Guarantee boundary

This document proves the **pipeline always reaches the emit path** and logs a structured event for operator triage. It does **not** guarantee:

- Slack API acceptance (rate limit, channel permissions, `not_in_thread` etc) — the `SlackBlockKitChannel.send` catch logs but does not retry.
- `turnNotifier` being wired in production. This is a deployment precondition. Runs with `turnNotifier === undefined` (harness / tests / misconfigured DI) still resolve the snapshot so Phase-5 `TurnSurface.end` can emit B5.
- `1M-context-unavailable` errors. These trigger a transparent retry on the bare model — no user-facing terminal card by design (Issue #661). Not part of this guarantee.
- Foreign aborts. `coerceAbortReason` returns `undefined` for any `controller.abort()` call that did not go through `RequestCoordinator.abortSession(reason)` — those are treated as out-of-band cancellations, intentionally silent.

## Table of Contents

1. [S1 — SDK terminality (why a ResultMessage is unavoidable)](#s1)
2. [S2 — Success / Waiting rails (the `.then` chain)](#s2)
3. [S3 — Success / Waiting rails (the `.catch` rail = enrichment failure)](#s3)
4. [S4 — Error / Abort rail (`handleError`)](#s4)
5. [S5 — Intentional silences (audit map)](#s5)

---

## S1 — SDK terminality (why a `ResultMessage` is unavoidable) <a id="s1"></a>

### 1. Event entry
- Caller: `ClaudeHandler.streamQuery(...)` returns an async iterable from the Claude Agent SDK.
- Consumer: `StreamProcessor.process(iterable, ctx, signal)` in `src/slack/pipeline/stream-executor.ts:1188`.

### 2. SDK contract (cited)

> "Without partial messages enabled […], you receive all message types except `StreamEvent`. Common types include `SystemMessage` (session initialization), `AssistantMessage` (complete responses), `ResultMessage` (final result), and a compact boundary message indicating when conversation history was compacted."
> — https://code.claude.com/docs/en/agent-sdk/streaming-output.md, §Message flow

> "ResultMessage — final result"
> — same doc, §Build a streaming UI ("Agent finished all work")

### 3. Soma-work consumption

`StreamProcessor.process` runs a `for await (...)` loop. Three exit cases:

| Exit case | Outcome | Downstream rail |
| :--- | :--- | :--- |
| `ResultMessage{subtype:'success'}` with end_turn → loop ends naturally | `streamResult.endTurnInfo` populated, `streamResult.aborted=false` | S2 |
| `ResultMessage{subtype:'error_*'}` (max_turns, during_execution) | `streamResult.sdkResultError` populated, `hasSdkError=true` | S2 with `category='Exception'` |
| Iterator rejects (network error, process crash, SDK throw) | `await` throws → outer `catch (error)` at stream-executor.ts:1455 | S4 |
| `abortController.signal.aborted` while iterating | `streamResult.aborted=true`, outer code re-throws AbortError at line 1170 | S4 |

There is no fourth exit — the iterator either yields a terminal `ResultMessage`, rejects, or is aborted. **The SDK cannot return without producing one of these three outcomes**, which is what makes the soma-work post-stream code reachable on every turn.

### 4. Evidence

- `src/slack/pipeline/stream-executor.ts:1163-1198` — the `processor.process(...)` call, the `streamResult.aborted` throw, and the `endTurnInfo` propagation.
- `src/slack/stream-processor.ts` — the `for await` loop that emits the three exit cases.
- `src/__tests__/turn-notifier.test.ts` — `determineTurnCategory` invariants for the three categories.

---

## S2 — Success / Waiting rails (the `.then` chain) <a id="s2"></a>

### 1. Event entry
- Trigger: `processor.process(...)` resolves with a `streamResult` that has `aborted=false` (line 1188 in stream-executor.ts).
- Category computation: `src/slack/pipeline/stream-executor.ts:1372-1376`:
  ```ts
  const category = determineTurnCategory({
    hasPendingChoice,
    isError: hasSdkError,
  });
  ```
  Resolves to `UIUserAskQuestion` (pending choice), `Exception` (`hasSdkError`), or `WorkflowComplete` (default) — see `src/turn-notifier.ts:57`.

### 2. Enrich-then-notify chain

`stream-executor.ts:1380-1448` (post-fix layout):
```ts
enrichAndResolve()
  .then((evt) => {
    resolveSnapshot(evt);
    if (this.deps.turnNotifier) {
      try { this.deps.turnNotifier.notify(evt, buildCompletionNotifyOpts()); }
      catch (err) { this.logger.warn('TurnNotifier.notify threw', ...); }
    }
  })
  .catch((err) => this.handleEnrichmentFailure(err, fallbackArgs, resolveSnapshot));
```

### 3. Why this always emits

- `enrichAndResolve` is a fully `async` function. Any synchronous throw becomes a rejected promise → `.catch` rail → S3.
- The `if (this.deps.turnNotifier)` guard exists so test/harness runs do not panic; production wiring (see `src/index.ts` bootstrap) always populates this dependency.
- `resolveSnapshot(evt)` unblocks `TurnSurface.end`'s awaited snapshot path (Phase 5), which posts the B5 Block Kit card from `SlackBlockKitChannel.send`.
- `buildCompletionNotifyOpts()` excludes `slack-block-kit` at Phase 5 (avoid double-post) and returns `undefined` at Phase <5 (legacy path posts via `TurnNotifier.notify` itself).

### 4. Test coverage

- `src/slack/pipeline/__tests__/stream-executor.test.ts` `#720 (a)` — snapshot lands late, B5 still emits exactly once.
- `src/slack/pipeline/__tests__/stream-executor.test.ts` `#720 (c)` — turnNotifier undefined, snapshot still resolves so B5 emits.

---

## S3 — Success / Waiting rails (the `.catch` rail = enrichment failure) <a id="s3"></a>

### 1. Event entry
- Trigger: `enrichAndResolve` rejects. Causes include: `getTokenManager().fetchAndStoreUsage(keyId)` throwing without its inner `.catch`, `userSettingsStore.getUserPersona(...)` throwing on corrupted state, property reads on a partially-hydrated `session`, etc.

### 2. Pre-fix bug (history)

```ts
.catch((err) => {
  resolveSnapshot(undefined);     // ⚠️ Phase 5 B5 emit is skipped
  this.logger.warn('Turn completion enrichment failed', ...);
  // ⚠️ no notify call — Phase <5 also silent
});
```
Effect: the user saw their assistant text, **then no terminal card at all**. Indistinguishable from a hang.

### 3. Post-fix behaviour

`stream-executor.ts: handleEnrichmentFailure` (new method) does three things:

1. `this.logger.warn('Turn completion enrichment failed', {sessionKey, turnId, stage:'enrich', error})` — operator-grade structured log.
2. Build a fallback `TurnCompletionEvent` with the originally-computed `category`, `userId`, `channel`, `threadTs`, `sessionTitle`, `durationMs`, and `message: 'turn-completion enrichment failed'`. Rich fields (usage %, token stats, persona, model, effort, etc.) are intentionally absent — the optional-field model in `TurnCompletionEvent` already handles that.
3. `resolveSnapshot(fallback)` so Phase-5 `TurnSurface.end → B5` still emits AND `turnNotifier.notify(fallback, buildCompletionNotifyOpts())` so Phase-<5 / non-block-kit channels also fire.

### 4. Test coverage

- `src/slack/pipeline/__tests__/stream-executor.test.ts` `Abort handling > handleEnrichmentFailure: builds fallback event, resolves snapshot with it, and notifies turnNotifier`
- `src/slack/pipeline/__tests__/stream-executor.test.ts` `Abort handling > handleEnrichmentFailure: preserves the originally-computed category (UIUserAskQuestion)`
- `src/slack/pipeline/__tests__/stream-executor.test.ts` `Abort handling > handleEnrichmentFailure: tolerates missing turnNotifier (still resolves snapshot)`

All three failed pre-fix (`handleEnrichmentFailure is not a function`), pass post-fix.

---

## S4 — Error / Abort rail (`handleError`) <a id="s4"></a>

### 1. Event entry
- Outer `catch (error)` at `stream-executor.ts:1455` — every throw inside `processMessage` lands here.
- Includes the synthetic AbortError thrown at line 1170 when `streamResult.aborted` is true.

### 2. Abort-reason classification

`coerceAbortReason(abortController.signal.reason)` returns one of `'supersede' | 'user-stop' | 'session-close' | 'shutdown' | 'stall-timeout' | undefined`. Plumbed via `RequestCoordinator.abortSession(sessionKey, reason)` → `controller.abort(reason)` (PR #912).

### 3. Notification gate

```ts
const isAbort = requestAborted || this.isAbortLikeError(error);
const stallTimeoutAbort = isAbort && abortReason === 'stall-timeout';
const ghostSessionAbort = isAbort && abortReason === 'ghost-session';
const notifyWorthyAbort = stallTimeoutAbort || ghostSessionAbort;
const shouldNotifyException =
  !!this.deps.turnNotifier
  && (!isAbort || notifyWorthyAbort)
  && !this.isOneMContextUnavailableError(error);
```

| Path | `shouldNotifyException` | Reason |
| :--- | :--- | :--- |
| Real SDK error (network, ResultMessage error subtype, throw) | true | Not an abort. Always surface. |
| `supersede` abort (new message displaced stalled turn) | true | User is waiting for *some* terminal signal. PR #912. |
| `stall-timeout` abort — dispatcher heuristic (PR #924) OR auto-watchdog (this PR) | true | Same UX as supersede red card. |
| `ghost-session` abort — `onToolUse`/`onToolResult` saw `session.terminated` mid-stream (this PR) | true | Session died out-of-band; user has no other terminal signal. Trace: `exhaustive-paths.md` §B-1. |
| `user-stop` / `session-close` / `shutdown` abort | false | User already knows the turn ended. |
| `1M-context-unavailable` | false | Transparent retry on bare model (Issue #661). |
| Foreign abort (`signal.reason` not in known union) | false | Out-of-band; explicitly out of guarantee scope. |

### 4. Test coverage

- `src/slack/__tests__/request-coordinator.test.ts` — three tests cover `controller.signal.reason` plumbing (`supersede`, `user-stop`, default).
- `src/slack/pipeline/__tests__/stream-executor.test.ts` Abort handling — five tests cover the supersede notify, user-stop silent, session-close silent, "process aborted by user" cancellation, and the three handleEnrichmentFailure cases.

---

## S5 — Intentional silences (audit map) <a id="s5"></a>

These paths are silent **by design** and do not violate the invariant.

| Path | Why silent | Code reference |
| :--- | :--- | :--- |
| `user-stop` abort | Explicit user action (Stop button / dashboard stop / `!`). User already knows. | `action-panel-action-handler.ts:331`, `index.ts:409` |
| `session-close` abort | Session-close UI is itself terminal. | `action-panel-action-handler.ts:354`, `session-action-handler.ts:46` |
| `shutdown` abort | Process-wide shutdown is not user-relevant feedback. | `request-coordinator.ts: clearAll()` |
| `1M-context-unavailable` error | Auto-recoverable: silently retries on bare model. | `stream-executor.ts: isOneMContextUnavailableError + retryAfterMs` |
| Foreign abort (no reason) | Out-of-band cancellation — caller didn't go through `RequestCoordinator.abortSession`. Conservative quiet. | `stream-executor.ts: coerceAbortReason` |
| `turnNotifier === undefined` | Deployment precondition. Snapshot path still resolves at S3 fallback. | `stream-executor.ts: handleEnrichmentFailure` |

---

## SDK idle timeout (auto-abort) — Phase 2 wiring (replaces PR #926 watchdog)

The external `StreamStallWatchdog` (PR #926) is REMOVED. Its role —
auto-abort a turn whose SDK stream goes silent for too long so a 🔴
terminal card still surfaces — now lives INSIDE
`StreamProcessor.process` via a `Promise.race` around every
`iterator.next()` (see `raceNextStep` and the `onIdleTimeout` callback
wired in `stream-executor.ts`).

- Owner: `packages/slack/src/stream-processor.ts` (`StreamProcessor`,
  `readIdleTimeoutMs`, `DEFAULT_IDLE_TIMEOUT_MS`, `IDLE_TIMEOUT_ENV_VAR`).
- Default window: **2 hours** (`DEFAULT_IDLE_TIMEOUT_MS =
  2 * 60 * 60 * 1000`). Codex binding `46116ba1` Q1+Q2 — raised from
  30 min (PR #970) → 10 min (PR #926). Both previous defaults produced
  production false-positives: 10 min killed `user:dev`-class long deploys;
  30 min killed sessions where the assistant emitted textual "waiting
  for your response" without firing a formal ASK tool (SDK iterator
  was genuinely idle, turn was healthy, but the timer fired anyway).
  2 h covers lunch / thinking time while still bounding true hangs.
- Env override: `SOMA_STREAM_STALL_TIMEOUT_MS` — name kept from PR #926
  so operator config carries forward unchanged. Positive int → ms;
  `0` or non-positive → disable; invalid/non-finite → fall back to
  default.
- Wiring: `StreamProcessor` constructor takes
  `{ idleTimeoutMs }`; the per-iteration race resolves with
  `kind: 'idleTimeout'` after the window elapses, calls
  `callbacks.onIdleTimeout()`, and returns
  `{ success: true, aborted: true }`. `stream-executor.ts`'s
  `onIdleTimeout` wires `abortController.abort('stall-timeout' satisfies
  RequestAbortReason)` so the existing `handleError`
  `notifyWorthyAbort` gate surfaces the same Korean 🔴 card.
- Abort target: still the LOCAL `abortController` (codex `2a332a29`
  P4 carries over), NOT `requestCoordinator.abortSession`.
  First-reason-wins on `AbortController` continues to protect a
  healthy `supersede` from being overwritten by a late stall fire.
- `unref()` on the underlying timer so the safety-net cannot keep
  Node alive at shutdown — defense-in-depth retained from PR #926.
- Why moving INTO the consumption loop matters (codex `5e6ab801` Q1):
  the previous external watchdog called
  `abortController.abort('stall-timeout')` but the `for await` was
  still suspended in the hung `.next()`. If the SDK transport did
  not honor the abort signal, the loop never unblocked even though
  the controller was aborted. Racing each `.next()` from inside the
  loop sidesteps that — when the timer wins, we abandon the pending
  promise and return immediately.

Observed failure that motivated the original watchdog (kept here for
context, now handled by the in-process idle timeout): dev session
`C0ACK3US1D4-1778569028.139949` on 2026-05-14 — Turn 1 of PROJ-4311
completed cleanly at 07:09:51, Turn 2 started at 07:11:57, sent SDK
query, received tool_use events until 07:14:15, then the stream went
silent. No `Received result`, no `Completed processing`, no
enrichment-failed log. User screenshot at 08:23 KST showed
`Last Activity: 1h 9m ago` — turn permanently dead, no terminal
marker. PR #924's dispatcher heuristic doesn't help because the user
is waiting on the card before sending a new message.

## P0 holes plugged (turn-end surface guarantee Phase 1 — PR #969)

PR #969 plugged four P0 holes documented in `exhaustive-paths.md` §B/§C.
The 10-min stall watchdog (`stream-stall-watchdog.ts`) was kept in
PR #969 and is REMOVED in this Phase 2 PR (see preceding section for
the in-process idle-timeout replacement).

### B-1 — ghost-session self-abort tagged

`StreamCallbacks.onToolUse` and `onToolResult` previously emitted
`abortController.abort()` with NO reason when `session.terminated`
flipped mid-stream. `coerceAbortReason` mapped the resulting
DOMException to `undefined` → silent abort branch in `handleError` →
turn vanished without any card.

Fix: new `RequestAbortReason` value `'ghost-session'` (notify-worthy).
Both callback sites tag the abort explicitly. `handleError`'s gate
treats it like `'stall-timeout'` and surfaces a 🔴 card with message
`'세션이 종료되어 턴이 중단되었습니다.'`.

### B-3 — TurnNotifier zero-channels warn

`TurnNotifier.notify()` used to return silently when zero channels were
enabled (`active.length === 0`). Operators triaging missing cards had
no log breadcrumb. Fix: emit `logger.warn` with userId + category
before the early return. Observability-only — no behavior change for
healthy deployments.

### C-2 — TurnSurface.end snapshot timeout surfaced to caller

`TurnSurface.end()` returned `Promise<void>`, so a 3s B5 snapshot
timeout was indistinguishable from a normal completion. Caller
(`StreamExecutor`) couldn't post a fallback notify when the snapshot
missed — the turn ended with NO card.

Fix: `end()` now returns `Promise<TurnEndResult>` with a
`snapshotResolved: boolean` field. StreamExecutor's finally block
posts `turnNotifier.notify(fallbackArgs)` when the signal is `false`.
A once-guard (`terminalNotified` outer-scope flag) ensures the
late `enrichAndResolve().then` rail does NOT double-post if it
resolves after the fallback already fired.

### C-5 — cleanupTempFiles bounded + moved after endTurn

`cleanupTempFiles` was awaited at `~L1721-1722` (try-block, BEFORE
`finally`'s `endTurn`). A hung file handler blocked the terminal card.

Fix: new helper `cleanupWithTimeout` (`packages/slack/src/pipeline/
stream-executor-cleanup-helpers.ts`) wraps cleanup in a 3s race.
The success-rail call is moved into the finally block AFTER
`endTurn()` so even a permanent hang cannot block card emission.
The error-rail call in `handleError` is also wrapped.

## Decision log

- **2026-05-13 codex session `5c0429b8-108e-49ea-8074-5a4535378cfd`** (PR #912): Option 4 — Option 2 (supersede notify) shipped, Option 3 (stall watchdog) wired as `stall-timeout` reason for follow-up.
- **2026-05-14 codex session `e294db6b-b322-4ec5-aed4-e05cf9a07d0b`** (PR #923): degraded enrichment is not a fourth terminal state; reuse computed category, omit rich fields. `resolveSnapshot(fallback)` not `undefined` (else Phase-5 B5 path skips).
- **2026-05-14 codex session `2a332a29-23ae-4fda-933f-b33ebd365ddc`** (PR #926): default 10 min, `SOMA_STREAM_STALL_TIMEOUT_MS` override, `<= 0` disables, invalid falls back to default. Abort the LOCAL controller (not the coordinator) so a late fire cannot hit a newer turn. `unref()` the timer. Add the supersede-wins regression test (#3) alongside the basic fire and unit-watchdog tests.
- **2026-05-26 codex session `eeecfada-18b3-4fd6-9587-3dc2fa1baec8`** (this PR audit): exhaustive 10/6/6 path enumeration. Confirmed B-1/B-3/C-2/C-5 are real silent-fail holes the watchdog was papering over.
- **2026-05-26 codex session `7bc8a74d-ad7e-4170-8f7f-747c58a066bf`** (PR #969 plan, Phase 1): split Phase 1 (card-hole fixes, watchdog KEPT) from Phase 2 (watchdog removal + C-1 idle-timeout). Use `'ghost-session'` not `'session-close'` for the callback self-abort. C-2 fallback lives in StreamExecutor (not TurnSurface) because `turnNotifier` is not in `TurnSurfaceDeps`. C-5 test uses fake timers + endTurn-call assertion, not vitest test-level timeout.
- **2026-05-26 codex session `5e6ab801-3d1a-4651-a406-f0d6c994e7db`** (this PR — Phase 2): bindings — (Q1) wire idle timeout INSIDE `StreamProcessor.process` via per-`.next()` race; the external `StreamStallWatchdog` was cosmetically equivalent but sat outside the stuck `.next()` and couldn't unblock it when the SDK ignored abort. (Q2) raise default to **30 min** to stop killing legitimate long-running tools that the 10-min default hit. (Q4) reuse `'stall-timeout'` `RequestAbortReason` rather than coining `'sdk-idle-timeout'` — `handleError` already routes that reason to the Korean 🔴 card. (Q6) revert + replace in a single PR (PR #969 promised both). (Q7) keep `SOMA_STREAM_STALL_TIMEOUT_MS` env var name for operator backward-compat — only the implementation owner changes.
