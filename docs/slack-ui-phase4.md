# Slack UI Phase 4 — B4 native status spinner (Part 1/2: container)

Scope: issue [#666](https://github.com/2lab-ai/soma-work/issues/666), umbrella
[#669](https://github.com/2lab-ai/soma-work/issues/669). Phase 3 (PR #682)
collapsed B3 choice block into `TurnSurface`. Phase 4 activates Slack's
**native `assistant.threads.setStatus` spinner** and registers the Bolt
`Assistant` container so the Slack client surfaces the Assistant sidebar +
suggested prompts.

**This document covers Part 1/2 — container registration + kill switch**.
Part 2 (turn-surface PHASE>=4 wiring + legacy suppression + clamp helper)
lands in a follow-up PR tracked separately.

## What Phase 4 Part 1 changes

The 5-block per-turn UI:

| Block | Owner after P4 Part 1 | Status in this PR |
|---|---|---|
| **B1** stream | `TurnSurface` | unchanged |
| **B2** plan | `TurnSurface.renderTasks` | unchanged |
| **B3** choice / question | `TurnSurface.askUser` | unchanged |
| **B4** AI working indicator | **`AssistantStatusManager` (kill-switched OFF)** + Bolt Assistant container registered | **partial — Part 2 wires turn-surface convergence** |
| **B5** `<작업 완료>` marker | `TurnNotifier` + `CompletionMessageTracker` (legacy) | unchanged — P5 |

In Part 1 the **Bolt Assistant container** is registered so Slack begins
routing `assistant_thread_started` / `assistant_thread_context_changed` and
assistant-thread `message.im` events through Bolt's Assistant middleware
chain. On `threadStarted` we publish **4 placeholder suggested prompts**.
`userMessage` delegates to the existing DM pipeline (`SlackHandler.handleMessage`)
so an assistant-thread user is functionally indistinguishable from a DM user.
Native `setStatus` spinner stays off via the **kill switch**
`SOMA_UI_B4_NATIVE_STATUS` (default `false`) — Part 2 will flip it together
with the turn-surface single-writer wiring.

## Scope

### In scope (Part 1 — this PR)

- **Bolt Assistant container registration** at `SlackHandler` construction
  time (`src/slack-handler.ts`). `app.assistant(new Assistant({...}))` is
  invoked unconditionally so the Assistant sidebar becomes available as
  soon as the workspace is reinstalled with the updated manifest.
- **`threadStarted` → `setSuggestedPrompts`** with 4 placeholder prompts
  (see `SUGGESTED_PROMPTS_PLACEHOLDER` in
  `src/slack/assistant-container.ts`). `threadContextChanged` is intentionally
  not overridden — Bolt's default context store handles it.
- **`userMessage` → `handleMessage`** delegation so the legacy DM pipeline
  owns the conversation response in assistant threads. No UX regression
  compared to regular DMs.
- **`SOMA_UI_B4_NATIVE_STATUS` kill switch** (`config.ui.b4NativeStatusEnabled`).
  While the flag is `false`, `AssistantStatusManager` initializes with
  `enabled = false`, and every `setStatus` / `setTitle` / heartbeat call is a
  no-op. This guarantees Part 1 cannot activate the legacy tool-level
  spinner path in `stream-executor.ts` before Part 2 is wired.
- **Manifest updates**:
  - `settings.event_subscriptions.bot_events` gains
    `assistant_thread_started`, `assistant_thread_context_changed`.
    (Bolt does **not** auto-subscribe these events — they must be in the
    manifest. Confirmed against `@slack/bolt@4.7.0`
    [`Assistant.ts`](https://github.com/slackapi/bolt-js/blob/%40slack/bolt%404.7.0/src/Assistant.ts).)
  - `features.assistant_view` is added with `assistant_description` and 4
    `suggested_prompts` entries (schema per
    [Slack manifest reference](https://docs.slack.dev/reference/app-manifest/)).
  - `oauth_config.scopes.bot` already contains `assistant:write`; no scope
    change in this PR.
- **Rollback snapshot**: `slack-app-manifest.pre-666.json` captures the
  pre-edit manifest byte-for-byte. Apply it via the Slack app manifest
  page to revert without replaying git history.
- **Test mock boosts**: `src/slack-handler.test.ts` / `src/auto-resume.test.ts`
  now include `app.assistant: vi.fn()` in their `App` mocks so the
  unconditional `app.assistant(...)` call does not explode existing suites.

### Out of scope (deferred to Part 2)

- `TurnSurface.begin` / `TurnSurface.end` PHASE>=4 `setStatus` / `clearStatus`
  wiring (single-writer convergence)
- `ThreadSurface` chip no-op under PHASE>=4 (legacy suppression)
- `StreamExecutor` direct `setStatus` PHASE branch
- `getEffectiveFiveBlockPhase(statusManager)` clamp helper + the
  `soma_ui_5block_phase_clamped` metric
- `AssistantStatusManager.markDisabledIfScopeMissing(err)` public API
- `SOMA_UI_5BLOCK_PHASE=4` dev / prod flip
- `setSuggestedPrompts` content design

## Current / Part-1 / Part-2 behaviour matrix

| Stage | `SOMA_UI_B4_NATIVE_STATUS` | `setStatus` path | Spinner visible? |
|---|---|---|---|
| `main` today (container unregistered, scope may or may not be installed) | n/a | first `setStatus` fails → `enabled=false` forever (in most deployments) | **no** |
| **Part 1 merged, flag OFF (default)** | `false` | `AssistantStatusManager` initializes with `enabled=false` → every `setStatus` / `setTitle` is a no-op | **no (hard kill)** |
| Part 1 merged, flag ON (opt-in for smoke) | `true` | Legacy `stream-executor` tool-level `setStatus` path activates; first failure still globally disables | conditional on thread type |
| **Part 2 merged + `SOMA_UI_5BLOCK_PHASE>=4` + flag ON** | `true` | `TurnSurface.begin/end` owns spinner; `stream-executor` direct path no-ops; clamp fallback + metric active | yes, assistant threads primarily |

## Rollout sequence

1. PR open → CI green → codex ≥ 95 → `zcheck` passes.
2. Pre-merge verification: confirm `slack-app-manifest.pre-666.json` equals
   the live manifest (see [Rollback](#rollback)).
3. Merge PR 1.
4. **Dev workspace** (admin-operated):
   a. Open the Slack app manifest page.
   b. Save the current manifest as a backup (match against
      `slack-app-manifest.pre-666.json` for cross-check).
   c. Apply the new manifest from `slack-app-manifest.json` (includes
      `assistant_view` + two new `bot_events`).
   d. `Install App → Reinstall to Workspace` to accept the new event
      subscriptions and refresh scope grants.
5. Dev smoke (manual, ≤ 1 day):
   - Sidebar Assistant icon appears for the bot.
   - Starting an Assistant thread renders the 4 suggested prompts.
   - Sending "ping" in an Assistant thread returns the same Claude answer
     a regular DM would.
   - Sending "ping" in a regular DM still returns the legacy response
     unchanged (no regression).
   - No native spinner visible anywhere (kill switch still off).
6. **Prod workspace**: repeat step 4 + a brief smoke.
7. Follow-up Part 2 PR opens — adds wiring + flips
   `SOMA_UI_B4_NATIVE_STATUS=1` in dev → 1-week soak → prod flip.

## Rollback

### Forward compatibility
PR 1 default state leaves behaviour at PHASE<4 unchanged — the kill switch
prevents any new spinner activity, and the `Assistant` container's
`userMessage` handler short-circuits to the existing DM pipeline. No
PHASE<4 caller changes.

### Backward compatibility
1. `git revert` the merge commit (or the individual commits in this PR).
2. Re-apply `slack-app-manifest.pre-666.json` on the Slack app manifest
   page — it is a pre-edit snapshot, not a merge artifact, so it reverts
   cleanly.
3. `Install App → Reinstall to Workspace` to drop the new event
   subscriptions.
4. Existing behaviour restored.

`slack-app-manifest.prev.json` (unrelated legacy rollback for slash-command
changes) is **not** the correct snapshot for this PR — use
`slack-app-manifest.pre-666.json`.

## Architecture

### Bolt Assistant container lifecycle
- Constructed once in the `SlackHandler` constructor after `EventRouter`
  wiring: `app.assistant(createAssistantContainer({ logger, handleMessage }))`.
- `new Assistant({ threadStarted, userMessage })` validates synchronously;
  missing required handlers throws `AssistantInitializationError` at
  construction time. Both handlers are provided.
- Bolt registers the container middleware on the app's global chain; for
  non-assistant-thread events (regular DMs, channels, mentions) the
  middleware does not match and the existing `EventRouter` routes continue
  to run unchanged.

### `userMessage` → `handleMessage` delegation
A no-op `userMessage` would consume the event inside the Assistant
middleware chain (Bolt's `enrichAssistantArgs` strips `next`) and the user
would see no bot response in an Assistant thread. Delegating to the same
`handleMessage` the DM path uses keeps assistant-thread UX identical to
DM UX.

### Kill-switch rationale
The legacy tool-level spinner path in `src/slack/pipeline/stream-executor.ts`
(`:540`, `:611`) calls `AssistantStatusManager.setStatus` unconditionally
under `STATUS_SPINNER` verbosity (default behaviour for
`logVerbosity ?? LOG_DETAIL` sessions). Once the Assistant container is
registered and `assistant:write` is installed, those calls could begin
succeeding in assistant threads — a Part 2 behaviour surfacing in Part 1.
The kill switch collapses this by flipping `enabled=false` at
`AssistantStatusManager` construction so every `setStatus` call short-circuits.
Part 2 flips the env and replaces the legacy call sites with
`TurnSurface.begin/end` in a single diff.

### Scope-failure surface
If `setSuggestedPrompts` fails with `missing_scope`, `threadStarted`
catches it and logs a `warn`. Part 1 does **not** disable other status
paths in response — that clamp-on-scope-failure is the dedicated
`markDisabledIfScopeMissing` public API added in Part 2.

## Tests

- `src/slack/assistant-container.test.ts` (new, 8 cases)
  - `buildAssistantConfig` returns object with required handlers
  - `threadContextChanged` is absent (default context store)
  - `threadStarted` calls `setSuggestedPrompts` with exactly 4 placeholder
    prompts and the expected title
  - `threadStarted` swallows rejections and logs a warn
  - `userMessage` delegates to `deps.handleMessage`
  - `userMessage` propagates `handleMessage` rejections
  - `SUGGESTED_PROMPTS_PLACEHOLDER` invariants (length 4, non-empty fields)
  - `createAssistantContainer` returns an `instanceof Assistant`

- `src/slack/assistant-status-manager.test.ts` (extended)
  - New `describe('constructor — B4 native-status kill switch (#666)')`:
    - `config.ui.b4NativeStatusEnabled=false` → `isEnabled()===false`
    - `config.ui.b4NativeStatusEnabled=true` → `isEnabled()===true`
    - `setStatus` no-op under the kill switch (no API call)
  - All pre-existing describes keep working via a `vi.mock('../config', …)`
    that defaults `b4NativeStatusEnabled=true`.

- `src/slack/assistant-status-manager.heartbeat.test.ts`: same config mock
  added so the existing heartbeat scenarios continue to exercise the
  enabled path.

- `src/config.test.ts` (extended)
  - New `describe('parseBool (#666)')`: truthy / falsy / fallback /
    whitespace-tolerance cases covering the env parser powering
    `config.ui.b4NativeStatusEnabled`.

- `src/slack-handler.test.ts` (mock boosts + new describe)
  - Every `app = { client: {} }` mock now includes `assistant: vi.fn()`.
  - New `describe('SlackHandler — Bolt Assistant container registration (#666)')`
    asserts `app.assistant` is invoked exactly once with a Bolt `Assistant`
    instance.

- `src/auto-resume.test.ts`: `createTestHandler` adds `assistant: vi.fn()`
  to its `app` mock.

## References

- Issue: [#666 P4 — B4 native status spinner](https://github.com/2lab-ai/soma-work/issues/666)
- Follow-up (Part 2): [#689 PHASE>=4 wiring + clamp + legacy suppression](https://github.com/2lab-ai/soma-work/issues/689)
- Epic: [#669 한 턴 = 5 블록으로 수렴](https://github.com/2lab-ai/soma-work/issues/669)
- Bolt Assistant source (v4.7.0):
  [`src/Assistant.ts`](https://github.com/slackapi/bolt-js/blob/%40slack/bolt%404.7.0/src/Assistant.ts#L23-L28)
- Slack Agents API: https://docs.slack.dev/apis/assistant/
- Slack manifest reference: https://docs.slack.dev/reference/app-manifest/

---

## Part 2 — PHASE>=4 wiring + clamp helper + legacy suppression

Scope: issue [#689](https://github.com/2lab-ai/soma-work/issues/689). Builds
on Part 1 (container registration + kill switch). Part 2 **activates** B4:
`TurnSurface` becomes the single native-spinner writer and every legacy
`setStatus`/`clearStatus`/`setTitle` callsite is gated on effective PHASE<4.

### What Part 2 wires

| Surface | Behaviour at effective PHASE>=4 |
|---|---|
| `TurnSurface.begin` | `assistantStatusManager.setStatus(channel, threadTs, 'is thinking...')` |
| `TurnSurface.end` (any reason) | `assistantStatusManager.clearStatus(...)` |
| `TurnSurface.fail` | `assistantStatusManager.clearStatus(...)` (idempotent) |
| `ThreadSurface` chip (agent phase/tool) | `suppressAgentChip=true` → chip omitted |
| `StreamExecutor` direct `setStatus`/`clearStatus` (7 sites) | no-op via `legacySetStatus`/`legacyClearStatus` wrapper |
| `ToolEventProcessor.onToolUse` setStatus | no-op (inline gate) |
| `SessionInitializer` dispatch `setStatus` (`'is analyzing your request...'`) | no-op (inline gate) |
| `SessionInitializer` dispatch `setTitle` | no-op (inline gate) |

10 legacy B4 writer callsites total, all PHASE-gated.

### Graceful degradation — `getEffectiveFiveBlockPhase`

At **boot or first-use**, if scope/auth is still missing the Slack
`assistant.threads.setStatus` call will throw. The `catch` block in
`AssistantStatusManager.setStatus`/`heartbeatTick` now routes through
`markDisabledIfScopeMissing(err)`:

- **Permanent codes** (`missing_scope`, `not_allowed_token_type`,
  `invalid_auth`): flip `enabled=false` + clear heartbeats. Subsequent
  reads of `getEffectiveFiveBlockPhase(statusManager)` clamp to 3, which
  restores the `ThreadSurface` chip (Part 2's graceful fallback).
- **Per-thread** `not_allowed` (the caller's thread isn't an assistant
  thread): do NOT disable — same process may still serve other assistant
  threads. Current call is skipped via the wrapper; next call retries.
- **Transient** (`ratelimited`, network blip, `internal_error`): same as
  per-thread — skip + debug log, manager stays enabled.

Clamp fires the once-flag metric `soma_ui_5block_phase_clamped` (Logger
`warn` with structured payload `{from, to, reason}`) exactly once per
process. Aggregators can grep by the event name.

**Important**: clamp does NOT restore the *native* spinner — once
`enabled=false`, legacy `setStatus` is a no-op too. What clamp restores
is the `ThreadSurface` chip (`suppressAgentChip=false`). Users see inline
italic phase/tool text instead of the sidebar spinner.

### Updated behaviour matrix

| Stage | `SOMA_UI_B4_NATIVE_STATUS` | `SOMA_UI_5BLOCK_PHASE` | Spinner visible? | B4 writer |
|---|---|---|---|---|
| `main` today (Part 1 merged) | `false` (default) | any | no (kill switch) | — |
| Part 2 + flag ON + PHASE<4 | `true` | `0..3` | yes (legacy path) | `stream-executor` direct |
| Part 2 + flag ON + PHASE>=4 + scope OK | `true` | `>=4` | yes (native spinner) | `TurnSurface` (single) |
| Part 2 + flag ON + PHASE>=4 + scope missing at runtime | `true` | `>=4` | no (auto clamp to 3) | `ThreadSurface` chip (PHASE-3 style) — legacy also disabled |

### Rollout (Part 2)

1. PR #{PR_PART2} CI green + codex ≥ 95 + zcheck pass.
2. Merge (no manifest change — Part 1's reinstall is sufficient).
3. Dev env flip: `SOMA_UI_B4_NATIVE_STATUS=1` + `SOMA_UI_5BLOCK_PHASE=4`.
4. **Dev soak 1 week** (longer than other phases — native spinner UX
   variance can only be spotted across real workload diversity).
5. Prod flip — same env var pair.

### Rollback (Part 2)

Two independent dials:

1. **Unflip env**: `SOMA_UI_5BLOCK_PHASE=3` → TurnSurface B4 writes stop,
   chip returns via `suppressAgentChip=false`. No code revert needed.
2. **Full code revert**: `git revert` the Part 2 merge commit. Part 1
   container registration + kill switch stay intact.

### Architecture notes (Part 2)

- **DI chain**: `SlackHandler` constructs `AssistantStatusManager`
  **before** `ThreadPanel`, then passes the same instance through
  `ThreadPanelDeps.assistantStatusManager` → both `ThreadSurface` (chip
  suppression) and `TurnSurface` (B4 writer). All three receive the
  *same* instance so the clamp trigger fires uniformly.
- **`TurnState.ctx`** carries `channelId` + `threadTs?` — reused in
  `end()`/`fail()` for `clearStatus(...)` without extra state.
- **Tool-level text transitions** (e.g. "is calling jira…") remain in
  `ToolEventProcessor` / `StreamExecutor` legacy path for PHASE<4. A
  follow-up PR can lift these into `TurnSurface` if the UX requires it;
  Part 2 keeps scope tight.
- **Thread-type awareness** is intentionally not introduced. Gate is
  purely `effective PHASE >= 4`. The matcher discipline in
  `markDisabledIfScopeMissing` (excluding `not_allowed`) provides the
  mixed-traffic safety.

### Tests (Part 2 additions)

- `src/slack/pipeline/effective-phase.test.ts` (new, 5) — clamp + once-flag + reset
- `src/metrics/ui-metrics.test.ts` (new, 2) — payload shape + multi-emission
- `src/slack/assistant-status-manager.test.ts` (+8) — `markDisabledIfScopeMissing` 6 + transient-error non-clamp 2
- `src/slack/assistant-status-manager.heartbeat.test.ts` (+1) — heartbeat transient keeps enabled
- `src/slack/turn-surface.test.ts` (+5) — PHASE=4 begin/end/fail + PHASE=3 gate + clamp
- `src/slack/thread-surface.test.ts` (+3) — chip visible / suppressed / clamp restores
- `src/slack/action-panel-builder.test.ts` (+1) — `suppressAgentChip`
- `src/slack/tool-event-processor.test.ts` (+3) — PHASE<4 / PHASE>=4 / clamp
- `src/slack/pipeline/stream-executor.test.ts` (+5) — white-box legacy wrappers
- `src/slack/pipeline/session-initializer-phase4.test.ts` (new, 3) — gate contract

Total Part 2: **36 new tests**.
