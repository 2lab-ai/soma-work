# Turn-End Surface Guarantee — Vertical Trace

> STV Trace | Created: 2026-05-14
> Related: docs/turn-notification/trace.md, docs/turn-summary-lifecycle/trace.md, docs/rich-turn-notification/trace.md
> Anthropic SDK doc: https://code.claude.com/docs/en/agent-sdk/streaming-output.md

## Invariant

Every model-turn end MUST surface exactly one terminal Slack Block Kit card. The three terminal states the SDK can produce — and the soma-work category each maps to — are:

| SDK signal | soma-work `TurnCategory` | Card |
| :--- | :--- | :--- |
| `ResultMessage{subtype:'success'}` with end_turn, no pending user choice | `WorkflowComplete` | 🟢 `작업 완료` |
| Assistant turn ends with a pending user choice (UIAskUserQuestion / B3) | `UIUserAskQuestion` | 🟠 `유저 입력 대기` |
| `ResultMessage{subtype:'error_*'}` / SDK throw / supersede abort / stall-timeout abort | `Exception` | 🔴 `오류 발생` |

There is no fourth state. Degraded enrichment (no usage %, no token stats) is **not** a separate category — it is the same terminal state rendered with reduced fidelity. Codex P1 binding decision (session `e294db6b-b322-4ec5-aed4-e05cf9a07d0b`, 2026-05-14): "Degraded enrichment is not a fourth terminal state; it is a reduced-fidelity rendering of the same terminal state. Optional fields already model that."

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
const supersedeLikeAbort = isAbort && (abortReason === 'supersede' || abortReason === 'stall-timeout');
const shouldNotifyException =
  !!this.deps.turnNotifier
  && (!isAbort || supersedeLikeAbort)
  && !this.isOneMContextUnavailableError(error);
```

| Path | `shouldNotifyException` | Reason |
| :--- | :--- | :--- |
| Real SDK error (network, ResultMessage error subtype, throw) | true | Not an abort. Always surface. |
| `supersede` abort (new message displaced stalled turn) | true | User is waiting for *some* terminal signal. PR #912. |
| `stall-timeout` abort — dispatcher heuristic (PR #924) OR auto-watchdog (this PR) | true | Same UX as supersede red card. |
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

## Stall watchdog (auto-abort) — installed in the PR that adds this section

Codex Option 3 deferred from PR #912/#923 is now wired in `StreamExecutor.processMessage`:

- Helper: `src/slack/pipeline/stream-stall-watchdog.ts` exposes `StreamStallWatchdog` and `readStallTimeoutMs()`.
- Default window: 10 minutes (`DEFAULT_STALL_TIMEOUT_MS = 600_000`).
- Env override: `SOMA_STREAM_STALL_TIMEOUT_MS` (positive int → ms; `0` or non-positive → disable; invalid/non-finite → fall back to default).
- Wiring: `arm()` runs just before `processor.process(...)`, `touch()` runs from every `onSdkActivity` callback, `clear()` runs in the outer `finally`.
- Tool-pending suspension (follow-up to the original install): `onToolUse` calls `beginToolCall(id)` per emitted tool_use BEFORE any `await`, `onToolResult` calls `endToolCall(id)` per arriving tool_result BEFORE any `await`. While `pendingTools` is non-empty, the silence timer is suspended — the SDK is legitimately blocked waiting for tool_result, not hung. `touch()` is also a no-op while pending so a chatty mid-tool SDK event (system message, partial assistant delta) can't defeat the suspension. See the "stall-watchdog tool-pending fix" decision log entry below.
- Abort target: the LOCAL `abortController` for this turn (codex `2a332a29` P4), NOT `requestCoordinator.abortSession` — a stale watchdog firing after the turn moved on cannot abort a newer controller because the local controller is CAS-guarded via `removeController(sessionKey, controller)`.
- First-reason-wins: if `supersede` (or any other reason) already fired on the controller, the late `stall-timeout` call is a no-op (DOM `AbortController.abort` semantics). The S4 notify gate continues to see the original reason.
- `unref()` on the underlying timer so the watchdog can never keep Node alive at shutdown.

Observed failure that motivated the install: dev session `C0ACK3US1D4-1778569028.139949` on 2026-05-14 — Turn 1 of PTN-4311 completed cleanly at 07:09:51, Turn 2 started at 07:11:57, sent SDK query, received tool_use events until 07:14:15, then the stream went silent. No `Received result`, no `Completed processing`, no enrichment-failed log. User screenshot at 08:23 KST showed `Last Activity: 1h 9m ago` — turn permanently dead, no terminal marker. PR #924's dispatcher heuristic doesn't help because the user is waiting on the card before sending a new message.

## Decision log

- **2026-05-13 codex session `5c0429b8-108e-49ea-8074-5a4535378cfd`** (PR #912): Option 4 — Option 2 (supersede notify) shipped, Option 3 (stall watchdog) wired as `stall-timeout` reason for follow-up.
- **2026-05-14 codex session `e294db6b-b322-4ec5-aed4-e05cf9a07d0b`** (PR #923): degraded enrichment is not a fourth terminal state; reuse computed category, omit rich fields. `resolveSnapshot(fallback)` not `undefined` (else Phase-5 B5 path skips).
- **2026-05-14 codex session `2a332a29-23ae-4fda-933f-b33ebd365ddc`** (PR #926): default 10 min, `SOMA_STREAM_STALL_TIMEOUT_MS` override, `<= 0` disables, invalid falls back to default. Abort the LOCAL controller (not the coordinator) so a late fire cannot hit a newer turn. `unref()` the timer. Add the supersede-wins regression test (#3) alongside the basic fire and unit-watchdog tests.
- **2026-05-15 codex session `bb2f9f72-dc8f-49ba-917d-0496849890aa`** (stall-watchdog tool-pending fix): the SDK emits no events between `tool_use` and `tool_result`, so a single long-running MCP call (`mcp__llm__chat` with `timeoutMs: 600_000`, codex / gemini deep-research) tripped the watchdog at exactly the stall window even though work was healthy. Add `beginToolCall(id)` / `endToolCall(id)` to suspend the timer per pending tool. Track by `Set<string>` (not a counter) so a duplicate `tool_use` doesn't bump a phantom counter and a spurious `tool_result` doesn't underflow into "all done → re-arm". Trust per-tool timeouts (MCP `timeoutMs`, Bash watchdog, sub-agent budget) for tool-level hangs; the stall watchdog only guards SDK-level silence with nothing pending. Codex P3 corrections all applied — `touch()` no-op while pending, unmatched `endToolCall` no-op, batched begin/end exact, `clear()` while pending leaves no live timer.
