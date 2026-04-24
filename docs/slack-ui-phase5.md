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
- `TurnContext.buildCompletionEvent?: () => TurnCompletionEvent | undefined`
  — callback injected by `stream-executor` before `begin()`. Holds a plain-
  object snapshot assigned exactly once after async enrichment succeeds on
  the happy path.
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
- **Abort / 1M-context-fallback / supersede paths** — do not assign the
  snapshot. The closure returns `undefined` and TurnSurface does not emit
  B5, matching the legacy `TurnNotifier` behaviour where aborted turns
  never fire `WorkflowComplete`.

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
- **Option C — callback on `TurnContext`, closure owns the snapshot
  (chosen)**: `stream-executor` installs the closure before `begin()`.
  The closure closes over a mutable local. Success path assigns exactly
  ONCE after the async enrichment Promise resolves. `TurnSurface.end()`
  invokes the closure — gets the snapshot or `undefined`. Failure /
  abort / supersede paths never reach the single assignment, so the
  closure returns `undefined` and no B5 is emitted. The assignment and
  the read are totally ordered (both run on the event loop; the read
  runs inside `end()`'s `try` block which is awaited from
  `endTurn(...)` in the `finally` block of `execute()`, and the
  assignment runs from the fire-and-forget `enrichAndNotify()` chain
  started earlier in the same tick).

### Snapshot pattern — plain object, single assignment

The closure returns the SAME object reference stream-executor constructed
from enrichment (`finalEnrichedEvent`). This is a plain `TurnCompletionEvent`
literal — no live references to `session`, `turnCollector`, or any other
mutable state. If future refactors ever introduce a live reference, this
doc's invariant breaks; prefer cloning at assignment time rather than
loosening the invariant.

One assignment, one call site. `completionEventSnapshot = finalEnrichedEvent`
lives on the happy path just above `turnNotifier.notify(...)` in
`enrichAndNotify()`. The abort catch-block, the 1M-fallback branch, and
`handleError` do NOT assign.

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
3. **NEW — B5 send** — iff `reason === 'completed'` AND
   `isCompletionMarkerActive() === true` AND `buildCompletionEvent` AND
   `slackBlockKitChannel` are all truthy:
   `slackBlockKitChannel.send(evt)` where `evt = buildCompletionEvent()`
   is the plain-object snapshot. Throws swallowed so step 4 still runs.
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
  capability active; no emit on `fail()`; no emit when capability
  inactive; `buildCompletionEvent` closure invoked before `SlackBlockKitChannel.send`;
  send-throws are caught and `cleanupTurn` still runs.
- `src/slack/pipeline/stream-executor.test.ts` —
  - `buildCompletionNotifyOpts()` returns
    `{ excludeChannelNames: ['slack-block-kit'] }` when capability active,
    `undefined` otherwise (PHASE<5 / capability inactive / threadPanel
    missing).
  - `handleError` always calls `TurnNotifier.notify` with NO opts
    (Exception fan-out unchanged).

`completion-message-tracker.test.ts` intentionally unchanged — tracker
semantics untouched.

## References

- Issue: [#667 P5 — B5 완료 마커를 TurnSurface에 흡수](https://github.com/2lab-ai/soma-work/issues/667)
- Epic: [#669 한 턴 = 5 블록으로 수렴](https://github.com/2lab-ai/soma-work/issues/669)
- Prerequisite: [#700 PR — P4 Part 2: B4 native-spinner single writer](https://github.com/2lab-ai/soma-work/pull/700)
- Phase 4 doc: [docs/slack-ui-phase4.md](./slack-ui-phase4.md)
- Phase 3 doc: [docs/slack-ui-phase3.md](./slack-ui-phase3.md)
