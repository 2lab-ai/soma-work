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
- Epic: [#669 한 턴 = 5 블록으로 수렴](https://github.com/2lab-ai/soma-work/issues/669)
- Bolt Assistant source (v4.7.0):
  [`src/Assistant.ts`](https://github.com/slackapi/bolt-js/blob/%40slack/bolt%404.7.0/src/Assistant.ts#L23-L28)
- Slack Agents API: https://docs.slack.dev/apis/assistant/
- Slack manifest reference: https://docs.slack.dev/reference/app-manifest/
