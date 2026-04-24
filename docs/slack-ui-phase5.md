# Slack UI Phase 5 — B5 completion marker absorbed into TurnSurface

Scope: issue [#667](https://github.com/2lab-ai/soma-work/issues/667), umbrella
[#669](https://github.com/2lab-ai/soma-work/issues/669). Phase 4 Part 2
([PR #700](https://github.com/2lab-ai/soma-work/pull/700)) collapsed the B4
native spinner onto `TurnSurface` as the single writer. Phase 5 completes the
5-block-per-turn convergence by making `TurnSurface` the single writer of the
**in-thread `WorkflowComplete` B5 marker** too.

`UIUserAskQuestion` and `Exception` categories intentionally stay on
`TurnNotifier`. P5 scope is the `WorkflowComplete` category only — narrowing
the absorption keeps the exception / question fan-out paths mechanically
unchanged and independently rollback-able.

## What Phase 5 changes

The 5-block per-turn UI:

| Block | Owner after P5 | Status in this PR |
|---|---|---|
| **B1** stream | `TurnSurface` | unchanged |
| **B2** plan | `TurnSurface.renderTasks` | unchanged |
| **B3** choice / question | `TurnSurface.askUser` | unchanged |
| **B4** native AI working spinner | `TurnSurface.begin/end/fail` | unchanged (P4 Part 2) |
| **B5** `<작업 완료>` in-thread marker | **`TurnSurface.end('completed')` (single writer at PHASE>=5 + capability active)** | **absorbed (this PR)** |

At effective PHASE>=5 + capability active, `TurnSurface.end('completed')`
emits the B5 marker through a shared `SlackBlockKitChannel` instance. The
legacy `TurnNotifier` fan-out for `WorkflowComplete` is filtered to exclude
`slack-block-kit` so exactly one B5 write lands per turn.

At PHASE<5 or capability inactive (dep not wired), behaviour is identical to
`main` today: `stream-executor` drives `TurnNotifier.notify(...)` and the
legacy `slack-block-kit` channel posts the in-thread marker.

## Scope

### In scope

- `TurnSurface.end('completed')` emits the B5 `WorkflowComplete` marker
  through an injected `SlackBlockKitChannel` when a capability closure
  reports active.
- `ThreadPanel.isCompletionMarkerActive()` capability SSOT:
  `config.ui.fiveBlockPhase >= 5 && slackBlockKitChannel !== undefined`.
- `TurnContext.buildCompletionEvent?: () => Promise<TurnCompletionEvent | undefined>`
  — closure injected by `stream-executor` before `begin()`. Returns the
  SAME per-turn `snapshotPromise` on every invocation. The Promise is
  resolved exactly once with the enriched event on the async success rail,
  or with `undefined` on the `.catch` rail. `TurnSurface.end` awaits it
  under a 3s timeout guard. See §"Race fix (#720)" below for the full
  rationale; the sync form used in PR #711 raced `stopStream` and
  silently dropped B5.
- `StreamExecutor.buildCompletionNotifyOpts()` helper — returns
  `{ excludeChannelNames: ['slack-block-kit'] }` iff the capability is
  active; otherwise `undefined`.
- `TurnNotifier.notify(event, opts?)` — new `excludeChannelNames?: string[]`
  filter. Applied BEFORE `isEnabled()` probes so filtered channels aren't
  needlessly asked.
- Shared `SlackBlockKitChannel` instance: `slack-handler.ts` constructs once
  and passes to BOTH `ThreadPanel` (for the B5 emit path via `TurnSurface`)
  and `TurnNotifier` (as a regular channel).
- Side-fix (`slack-block-kit-channel.ts`): post with a non-empty `text`
  fallback (`event.sessionTitle || event.category`). Empty `text` silently
  dropped messages on some clients and failed accessibility fallbacks.

### Out of scope (explicit)

- **`UIUserAskQuestion`** — stays on `TurnNotifier`. The category's value is
  the cross-surface fan-out (DM, webhook, telegram) and the in-thread write
  is acceptable as a duplicate alongside B3's `askUser` post.
- **`Exception`** — stays on `TurnNotifier` for all channels. `TurnSurface`
  never emits `Exception`, so there is no double-post risk. The
  `handleError` path in `stream-executor` is deliberately left unchanged —
  no `excludeChannelNames` is passed.
- **DM channel** (`SlackDmChannel`) — untouched, still fires via
  `TurnNotifier` fan-out for all categories.
- **Webhook channel** — untouched.
- **Telegram channel** — untouched.
- **`CompletionMessageTracker`** — `src/slack/completion-message-tracker.ts`
  is not modified. See Design decisions §"Why tracker is unchanged" below.
- **Abort / 1M-context-fallback / supersede paths** — never reach the
  `.then` / `.catch` rails, so `snapshotPromise` stays pending. The pending
  Promise is garbage-collected with `turnContext` when `execute()` returns.
  `TurnSurface.end` only awaits `buildCompletionEvent()` on
  `reason === 'completed'`, so pending is harmless on the abort paths —
  matching the legacy `TurnNotifier` behaviour where aborted turns never
  fire `WorkflowComplete`.

## Design decisions

### Callback ctx (Option C) over meta injection (Option B)

Alternatives considered:

- **Option A — wire turnNotifier into TurnSurface**: rejected. Would
  duplicate the fan-out logic inside `TurnSurface` and collide with the
  `excludeChannelNames` filter — the two writers would need to agree on
  the exclusion name through a back-channel.
- **Option B — stuff the final event into `TurnContext` as a field at
  `end()` time**: rejected. `TurnContext` is built by `stream-executor`
  BEFORE the streaming request starts. Mutating it after the fact from
  two branches (success / error) introduces ordering bugs (`end()` might
  fire before the mutation lands on the error path) and couples
  `TurnSurface` to `stream-executor`'s timing.
- **Option C — Promise-backed closure on `TurnContext` (chosen)**:
  `stream-executor` builds `snapshotPromise` + `resolveSnapshot` before
  `begin()`. The closure `() => snapshotPromise` returns the same Promise
  on every call. Success path resolves it with the enriched event on the
  `.then` rail; the `.catch` rail resolves with `undefined`. Failure /
  abort / supersede paths never reach either rail and the Promise stays
  pending until GC. `TurnSurface.end()` awaits under a 3s `Promise.race`
  safety net. The assignment and the read are now totally ordered via
  the Promise — `end()` cannot proceed past the await until one of the
  two rails fires (or the timeout triggers). This replaces the original
  sync-closure design that raced `stopStream`; see §"Race fix (#720)"
  below for the history.

### Snapshot pattern — Promise, resolved once

The closure returns the SAME Promise reference on every call. The Promise
is constructed once per `execute()` call alongside a matching
`resolveSnapshot` resolver. The resolver is called exactly once —
`resolveSnapshot(finalEnrichedEvent)` on the happy path, or
`resolveSnapshot(undefined)` on the `.catch` rail. Subsequent resolver
calls are silent no-ops per ECMA Promise semantics; the abort catch-block,
the 1M-fallback branch, and `handleError` do NOT call the resolver, so
those paths leave the Promise pending (harmless — `TurnSurface.end` only
awaits on `reason === 'completed'`).

`finalEnrichedEvent` is a plain `TurnCompletionEvent` literal with no live
references to `session`, `turnCollector`, or any other mutable state. If
future refactors ever introduce a live reference, this doc's invariant
breaks; prefer cloning at resolver time rather than loosening the
invariant.

**Explicit anti-pattern — no `finally` safety-net resolve.** Adding a
`finally → resolveSnapshot(undefined)` to the chain would race the
`.then` rail: if `finally` runs between the event creation and the
`.then` body, the snapshot would be locked to `undefined` before the
event could reach it. That is exactly the PR #711 shape the #720 fix
removes. The single safety net is the 3s `Promise.race` timeout inside
`TurnSurface.end`.

### Capability SSOT — `ThreadPanel.isCompletionMarkerActive()`

Both the emit gate (TurnSurface) and the exclusion gate (stream-executor)
read the SAME predicate. Split truths (e.g. TurnSurface checks `PHASE>=5`
but stream-executor forgets the channel-dep check) would have silently
introduced double-posts or zero-posts depending on which gate flipped
first.

`ThreadPanel.isCompletionMarkerActive()` aggregates:

```
config.ui.fiveBlockPhase >= 5 && slackBlockKitChannel !== undefined
```

`TurnSurface` receives a closure `isCompletionMarkerActive?: () => boolean`
in `TurnSurfaceDeps` so it does not need to import `ThreadPanel` back
(which would cycle: `ThreadPanel → TurnSurface → ThreadPanel`). The closure
is installed by `ThreadPanel`'s constructor: `() => this.isCompletionMarkerActive()`.
`stream-executor` consumes the same predicate via `this.deps.threadPanel?.
isCompletionMarkerActive() === true` in `buildCompletionNotifyOpts()`.

### Why tracker is unchanged

The original plan considered adding a per-turn cleanup step to
`CompletionMessageTracker`. That was wrong: the tracker's dedup key is
the message timestamp, which is assigned by Slack at post time. A
per-turn cleanup running in `end()`'s `finally` would delete the tracker
entry for the B5 message we JUST posted — defeating the dedup contract
on the next cross-channel emit (e.g. a webhook retry racing with the
Slack post).

The tracker entry's natural lifecycle (TTL-based sweep, or per-channel
flush) is correct. Phase 5 keeps it untouched. The `SlackBlockKitChannel.send`
path registers the completion message at the same call site regardless of
whether it's called via `TurnSurface.end` or `TurnNotifier.notify`, because
both paths share the SAME `SlackBlockKitChannel` instance (see §"Shared
channel instance" below).

### Shared channel instance

`slack-handler.ts` constructs `SlackBlockKitChannel` exactly once and
passes it to both:

- `ThreadPanel({ …, slackBlockKitChannel })` — threaded into `TurnSurface`
  for the B5 emit path.
- `TurnNotifier([ slackBlockKitChannel, new SlackDmChannel(...), … ])` —
  as one of the registered channels.

Why the same instance rather than two instances filtered by name:

- Object identity matters at runtime. Tracker / rate-limit / backoff state
  lives on the channel instance. Two instances would split that state and
  let a double-write slip through at PHASE<5 if someone ever flipped the
  filter in reverse or introduced a new call site that bypassed the
  filter.
- The `excludeChannelNames` filter matches on the `name` field (the string
  literal `'slack-block-kit'`). Matching is string-based, but the behavioural
  guarantee (one write == one side-effect) depends on sharing state.

## Behaviour matrix

| Stage | `SOMA_UI_5BLOCK_PHASE` | Capability | B5 writer |
|---|---|---|---|
| `main` today (P4 Part 2 merged) | `0..4` | `false` (PHASE<5) | `stream-executor` → `TurnNotifier` → `SlackBlockKitChannel.send` |
| P5 merged + PHASE=5 + capability active | `5` | `true` | **`TurnSurface.end('completed')` → `SlackBlockKitChannel.send` (single)** |
| P5 merged + PHASE=5 + capability inactive (`slackBlockKitChannel` dep missing) | `5` | `false` | `stream-executor` → `TurnNotifier` (legacy fallback) |
| P5 merged + PHASE<5 | `0..4` | `false` | `stream-executor` → `TurnNotifier` (unchanged) |

"Capability inactive" at PHASE=5 is the safety net — if DI wiring silently
drops the channel dep in some harness configuration, the marker still
posts via the legacy path instead of disappearing.

## Ordering in `end('completed')` finally

`TurnSurface.end('completed')` runs four steps in order inside the same
`try/finally` block:

1. **closeStream** — `chat.stopStream` on the B1 stream message.
   Idempotent. Throws swallowed into a warn log.
2. **B4 clearStatus** — `assistantStatusManager.clearStatus(channel,
   threadTs, { expectedEpoch })` at effective PHASE>=4 (unchanged from
   P4 Part 2). Throws swallowed so step 3 and 4 still run.
3. **B5 send** — iff `reason === 'completed'` AND
   `isCompletionMarkerActive() === true` AND `buildCompletionEvent` AND
   `slackBlockKitChannel` are all truthy:
   - `evt = await Promise.race([buildCompletionEvent(), 3s timeout])` —
     closes issue #720's race by waiting for the async enrichment
     snapshot instead of reading it synchronously (see §"Race fix
     (#720)" below for the full history).
   - If `evt` is defined: `void slackBlockKitChannel.send(evt).catch(warn)`
     — detached post so the Slack RTT doesn't extend `end()`'s hot path.
   - If `evt` is `undefined` (timeout or `.catch` rail): warn with
     `turnId`, no send. Explicit log so operators can distinguish a
     timeout from the "capability inactive" skip.
   - Both branches swallow throws so step 4 still runs.
4. **cleanupTurn** — remove `turnId` from `this.turns`, clear the
   `activeTurn` map entry if still pointing at this turnId, cancel any
   pending render-debouncer entry.

Visual ordering on Slack: B4 spinner clear lands before the B5 marker,
matching the legacy `TurnNotifier` path where the chip was cleared by
stream-executor BEFORE `enrichAndNotify()` resolved.

On the `fail()` path: B5 is deliberately NOT emitted. An errored turn
should not post `<작업 완료>`. The exception notification fan-out is
owned by `stream-executor.handleError` → `TurnNotifier.notify({ category:
'Exception', ... })` — unchanged.

## Rollout

1. PR open → CI green → codex ≥ 95 → `zcheck` passes.
2. Merge to `main` — default state is PHASE<5, behaviour identical to
   pre-P5 for all deployments.
3. Dev env flip: admin sets `SOMA_UI_5BLOCK_PHASE=5`.
4. **Dev soak 1 week** — longer than B1/B2/B3 because the B5 semantics
   are user-visible (the "작업 완료" footer) and any double/zero-post
   regression surfaces only across diverse real workflows.
5. Prod env flip: same var, same value.

No manifest change — P4 Part 1's reinstall is sufficient (`assistant:write`
already granted; `SlackBlockKitChannel.send` goes through `chat.postMessage`
which uses the same bot token).

## Rollback dials

Two independent mechanisms, in order of preference:

### 1. Unflip env (no code revert)

`SOMA_UI_5BLOCK_PHASE=4`. `ThreadPanel.isCompletionMarkerActive()` now
returns `false`. `TurnSurface.end('completed')` stops emitting B5.
`stream-executor.buildCompletionNotifyOpts()` returns `undefined` so
`TurnNotifier.notify(event)` is called with the pre-P5 single-arg
signature — `SlackBlockKitChannel` receives the completion event like
before. Recovery time: one deploy / pod restart.

### 2. Full code revert

`git revert` the merge commit. Restores the pre-P5 types
(`TurnNotifier.notify` without `opts`, `TurnSurfaceDeps` without
`slackBlockKitChannel`/`isCompletionMarkerActive`, `TurnContext` without
`buildCompletionEvent`). Use only if the env flip fails to stabilize the
system — e.g. a latent bug surfaces in the legacy `SlackBlockKitChannel`
path that P5's side-fix exposed.

## Architecture notes

- **DI chain**: `SlackHandler.initialize` constructs
  `slackBlockKitChannel = new SlackBlockKitChannel(slackApi,
  completionMessageTracker)` BEFORE `ThreadPanel`. Passes the same instance
  to `ThreadPanel` (via `ThreadPanelDeps.slackBlockKitChannel`) AND to
  `TurnNotifier` (as the first element of the channel array). The
  `TurnNotifier` element is what gets filtered out by `excludeChannelNames`;
  the `ThreadPanel` reference is what gets consumed by `TurnSurface.end`.
- **`TurnContext` carries the closure** — not the event itself. The
  closure is installed once per `execute()` call and is owned by
  `stream-executor`. `TurnSurface` has read-only access through the
  closure.
- **Capability closure (not a `ThreadPanel` reference)** on
  `TurnSurfaceDeps.isCompletionMarkerActive` avoids the
  `ThreadPanel → TurnSurface → ThreadPanel` import cycle. The closure is
  `() => this.isCompletionMarkerActive()` — binds `ThreadPanel`'s
  predicate lazily so a test that stubs `ThreadPanel.isCompletionMarkerActive`
  mid-test still sees the updated behaviour on the next `end()` call.
- **Exception path is pure pass-through** — `handleError` calls
  `TurnNotifier.notify(event)` with NO second argument. The
  `excludeChannelNames` option is a caller-opt-in.

## Tests

- `src/turn-notifier.test.ts` — `excludeChannelNames` option shape +
  filter-before-isEnabled ordering + empty-array no-op + undefined-opts
  backwards-compat.
- `src/notification-channels/slack-block-kit-channel.test.ts` —
  non-empty text fallback (side-fix).
- `src/slack/thread-panel.test.ts` —
  `isCompletionMarkerActive()` returns false at PHASE<5, at PHASE=5 with
  no `slackBlockKitChannel` dep, true at PHASE=5 with the dep.
- `src/slack-handler.test.ts` — `SlackBlockKitChannel` constructed once,
  same instance passed to both `ThreadPanel` and `TurnNotifier`.
- `src/slack/turn-surface.test.ts` — B5 emit on `end('completed')` at
  capability active (builder resolves with event); no emit on `fail()`;
  no emit when capability inactive; `buildCompletionEvent` Promise
  awaited before `SlackBlockKitChannel.send`; send-throws are caught and
  `cleanupTurn` still runs. See §"Race fix (#720)" for the additional
  `(d)` delayed-snapshot and `(e)` 3s-timeout regression cases.
- `src/slack/pipeline/stream-executor.test.ts` —
  - `buildCompletionNotifyOpts()` returns
    `{ excludeChannelNames: ['slack-block-kit'] }` when capability active,
    `undefined` otherwise (PHASE<5 / capability inactive / threadPanel
    missing).
  - `handleError` always calls `TurnNotifier.notify` with NO opts
    (Exception fan-out unchanged).
  - #720 regression triplet `(a)/(b)/(c)` locks in the Promise-snapshot
    wiring + decoupling from `turnNotifier` presence. See §"Race fix
    (#720)" → "Tests locking in the race fix" below.

`completion-message-tracker.test.ts` intentionally unchanged — tracker
semantics untouched.

## Race fix (#720) — Promise snapshot + awaited emit

[PR #711](https://github.com/2lab-ai/soma-work/pull/711) implemented the
P5 pattern described above with a **synchronous** `buildCompletionEvent`
accessor. That was wrong for the observed timing: under PHASE=5 with the
capability active, the live order is

```
stream-executor success path (all on the same tick):
  enrichAndNotify = async () => {
    await usageBeforePromise;       // HTTP (usually already resolved)
    await fetchAndStoreUsage(...);  // Anthropic usage HTTP, 100-500ms
    completionEventSnapshot = event;
    turnNotifier.notify(event, { excludeChannelNames:['slack-block-kit'] });
  };
  enrichAndNotify().catch(warn);    // FIRE-AND-FORGET

// meanwhile in the finally block, before enrichAndNotify resolves:
await threadPanel.endTurn(turnId, 'completed')
  → TurnSurface.end('completed')
    → await closeStream (Slack stopStream, 50-200ms — faster than usage HTTP)
    → const evt = state.ctx.buildCompletionEvent();   // sync read
    → (returns undefined — race lost)
    → if (evt) send();                                // silently skipped
```

`stopStream` reliably finished **before** the snapshot assignment, so the
sync read returned `undefined` and B5 was silently dropped on every
PHASE=5 run. The legacy `TurnNotifier` fan-out was **also** dropped because
stream-executor already excluded `slack-block-kit` from the fan-out —
double-write protection turned the race into a zero-write outcome. At
PHASE<5 the race is invisible because the capability closure returns
`false` and the legacy fan-out paints B5 normally.

### Fix shape

Three interlocking pieces:

1. **`TurnContext.buildCompletionEvent` is async.** The signature changes
   from `() => TurnCompletionEvent | undefined` to
   `() => Promise<TurnCompletionEvent | undefined>`. The closure returns
   the **same** `snapshotPromise` on every invocation — a Promise owned
   by `stream-executor`.
2. **`resolveSnapshot` fires exactly once.** `stream-executor` constructs
   `snapshotPromise` + `resolveSnapshot` before `begin()`. The post-stream
   chain has two exclusive rails:
   - `.then(evt)`: `resolveSnapshot(evt)` + *(if turnNotifier present)*
     `notify(evt, opts)`.
   - `.catch(err)`: `resolveSnapshot(undefined)` + warn.

   There is intentionally **no `finally` safety-net resolve** (codex P1-1):
   adding `finally → resolveSnapshot(undefined)` would race the `.then`
   rail and re-establish the exact bug — a `.then` that resolved with the
   event could be followed by a `finally` that re-resolves with
   `undefined`. Promise `resolve` calls after the first are no-ops, but
   the inverse order (finally before then) would lock in `undefined`. The
   abort / 1M-fallback / supersede paths simply never reach either rail;
   `snapshotPromise` stays pending, and GC collects it with `turnContext`
   when `execute()` returns. `TurnSurface.end` only awaits it on
   `reason === 'completed'`, so pending is harmless on the abort paths.
3. **Event construction is decoupled from `if (turnNotifier)` guard**
   (codex P1-2). Building `finalEnrichedEvent` now happens on the `enrich
   AndResolve()` rail unconditionally; the `turnNotifier.notify(...)` call
   lives inside an `if (this.deps.turnNotifier)` branch *after*
   `resolveSnapshot(evt)`. This ensures capability-active harness runs
   without a wired `turnNotifier` still produce a snapshot so
   `TurnSurface.end` emits B5 through `SlackBlockKitChannel.send`.
4. **`TurnSurface.end` awaits the snapshot with a bounded timeout.** The
   B5 emit block now does
   ```ts
   evt = await Promise.race([
     Promise.resolve(buildCompletionEvent()),
     new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
   ]);
   if (evt) send(evt); else logger.warn('B5 snapshot unavailable ...');
   ```
   The 3s timeout is the single safety net: it caps worst-case latency if
   the `.catch` rail itself fails to run (impossible in practice, but
   defence-in-depth is cheap here). The late-rejection of the loser is
   swallowed via `builderPromise.catch(() => {})` to prevent
   unhandled-rejection surfacing (codex P2).

### Sequence diagram (after #720)

```
stream-executor.execute() success path:
  snapshotPromise, resolveSnapshot := createSnapshot();
  turnContext.buildCompletionEvent = () => snapshotPromise;

  enrichAndResolve()
    ├─ ...await usage HTTP...
    ├─ build finalEnrichedEvent
    └─ return evt
     .then(evt ↦ resolveSnapshot(evt); if(turnNotifier) notify(evt, opts))
     .catch(err ↦ resolveSnapshot(undefined); warn)

  // later, in finally:
  threadPanel.endTurn('completed')
    → TurnSurface.end('completed')
      → await closeStream
      → await clearStatus
      → await Promise.race([snapshotPromise, 3s timeout])
         ├─ snapshot resolves first (happy path) → evt defined → send(evt)
         └─ timeout wins → evt = undefined → warn, no send
      → cleanupTurn
```

### Behaviour matrix (after #720)

| Path | snapshot Promise outcome | TurnSurface.end B5 |
|---|---|---|
| Success (`reason='completed'`, enrich resolves) | resolves with event | `send(evt)` — B5 posted |
| Enrichment rejects (usage HTTP throws, etc.) | resolves with `undefined` | no send, no warn from timeout (the stream-executor catch already logged "Turn notification failed") |
| Abort / 1M fallback / supersede (`reason='aborted'`) | pending forever (then GC'd) | guard skips the await entirely |
| Capability inactive at PHASE<5 / missing dep | Promise still resolves (we don't gate resolve on capability) | guard skips the await entirely |
| 3s timeout hit (defence-in-depth) | still pending | `undefined` + warn, legacy fan-out already drew B5 on non-excluded runs |

### Tests locking in the race fix

- `src/slack/turn-surface.test.ts`
  - *(d)* snapshot resolves 100ms AFTER `closeStream` completes →
    `end()` awaits → `SlackBlockKitChannel.send` called exactly once
    with the enriched event.
  - *(e)* snapshot never resolves → 3s timeout elapses (`vi.useFakeTimers`)
    → `send` not called, warn emitted carrying the turnId.
  - All 7 existing `buildCompletionEvent: () => ...` mocks wrapped as
    `() => Promise.resolve(...)` to satisfy the new async signature.
- `src/slack/pipeline/stream-executor.test.ts`
  - *(a)* `snapshotPromise` resolves **after** `TurnSurface.end` enters the
    snapshot await → B5 posted once.
  - *(b)* `resolveSnapshot(undefined)` (simulating enrich `.catch` rail)
    → `send` not called.
  - *(c)* **Decoupling lock-in**: `turnNotifier === undefined` +
    capability active → event still constructed, `resolveSnapshot` still
    fires, `SlackBlockKitChannel.send` still called once. Regression-
    guards against re-coupling event construction back inside
    `if (this.deps.turnNotifier)`.

### Rollback (additional, on top of §Rollback dials above)

- **Env dial still works**: `SOMA_UI_5BLOCK_PHASE=4` flips capability
  inactive → legacy fan-out redraws B5 via `TurnNotifier`.
- **Code revert**: `git revert` of the #720 PR restores the PR #711 sync
  shape. The race returns; use env dial instead if regression surfaces.

## References

- Issue: [#667 P5 — B5 완료 마커를 TurnSurface에 흡수](https://github.com/2lab-ai/soma-work/issues/667)
- Issue: [#720 P5 B5 race fix — Promise snapshot + await in TurnSurface.end](https://github.com/2lab-ai/soma-work/issues/720)
- Epic: [#669 한 턴 = 5 블록으로 수렴](https://github.com/2lab-ai/soma-work/issues/669)
- Prerequisite: [#700 PR — P4 Part 2: B4 native-spinner single writer](https://github.com/2lab-ai/soma-work/pull/700)
- Initial P5 implementation: [#711 PR](https://github.com/2lab-ai/soma-work/pull/711)
- Phase 4 doc: [docs/slack-ui-phase4.md](./slack-ui-phase4.md)
- Phase 3 doc: [docs/slack-ui-phase3.md](./slack-ui-phase3.md)
