# Slack UI Phase 3 — B3 choice block single-writer

Scope: issue [#665](https://github.com/2lab-ai/soma-work/issues/665),
umbrella [#669](https://github.com/2lab-ai/soma-work/issues/669) (successor
of [#525](https://github.com/2lab-ai/soma-work/issues/525) plan v2). Phase 2
(PR #664) consolidated the **B2 plan block** into `TurnSurface.renderTasks`.
Phase 3 collapses the **B3 question/choice block** from a two-path write
(inline choice message + header embed state) into a single-writer Slack
message owned by `TurnSurface`, gated on `SOMA_UI_5BLOCK_PHASE>=3`.

## What Phase 3 changes

The 5-block per-turn UI:

| Block | Owner after P3 | Status in this PR |
|---|---|---|
| **B1** stream | `TurnSurface` (P1+P2) | unchanged |
| **B2** plan | `TurnSurface.renderTasks` (P2) | unchanged |
| **B3** choice / question | `TurnSurface.askUser` / `askUserForm` / `resolveChoice` / `resolveMultiChoice` | **migrated** |
| **B4** AI working indicator | `AssistantStatusManager` (legacy) | unchanged — P4 |
| **B5** `<작업 완료>` marker | `TurnNotifier` + `CompletionMessageTracker` (legacy) | unchanged — P5 |

Under PHASE>=3, B3 acquires:

- **one writer** (`TurnSurface`) per posted choice/form message
- **payload identity** (`turnId` embedded in Slack button `value` JSON + modal
  `private_metadata`), so click handlers can unambiguously route a click to
  the turn that originated it
- **session state** (`session.actionPanel.pendingChoice`) as the authoritative
  lifecycle record, persisted via `session-registry` and broadcast to the
  dashboard websocket on every transition

Message-ownership table (PHASE>=3):

| Slack message ts | Owner | Written by |
|---|---|---|
| `streamTs` (B1) | `TurnSurface` | `begin` / `appendText` / `end` / `fail` |
| `planTs` (B2) | `TurnSurface` | `renderTasks` |
| **`choiceTs` (B3 single)** | **`TurnSurface`** | **`askUser` / `resolveChoice`** |
| **`formIds[].messageTs` (B3 multi)** | **`TurnSurface`** | **`askUserForm` / `resolveMultiChoice`** |
| `headerTs` (combined header + panel) | `ThreadSurface` | `updatePanel` / `refreshAndRender` |

The header continues to render a **link section** pointing at the choice
message (`ActionPanelBuilder.buildChoiceLinkSection` via
`session.actionPanel.choiceMessageLink`). This is **not** the legacy "embed
the buttons into the header" path — that rendering never happened in the
current codebase — so no header-side change is needed.

The old `resolveChoiceSyncMessageTs(sessionKey, messageTs, completionTs)`
helper continues to exist for PHASE<3 callers. Under PHASE>=3 it is
effectively singleton (the three possible ts values collapse to one) and
is **not on the P3 code path** — the P3 resolve uses
`TurnSurface.resolveChoice` / `resolveMultiChoice` directly.

## Scope summary

In scope for P3:

- `ThreadPanel.askUser` / `askUserForm` — post question + write session state
  synchronously + trigger permalink warm (fire-and-forget)
- `ThreadPanel.resolveChoice` / `resolveMultiChoice` — in-place update posted
  message + clear pending record
- `TurnSurface.askUser` / `askUserForm` / `resolveChoice` / `resolveMultiChoice`
  — raw Slack writer methods; no state mutation
- `ThreadSurface.setChoiceMeta` — lightweight permalink/header sync (no
  `choiceBlocks` write)
- Click handlers (`choice-action-handler.ts`, `form-action-handler.ts`) —
  unified 3-way classifier (legacy / p3 / stale)
- Stream-executor — defensive prelude that supersedes any prior
  `pendingChoice` before a new ask; threads `turnId` into the render chain;
  pre-allocates formIds + registers in `PendingFormStore` with turnId
- `PendingFormStore` — new optional `turnId` field on `PendingChoiceFormData`

Out of scope for P3:

- Legacy 2-path removal (`attachChoice` / `clearChoice` / header link section
  all still exist for PHASE<3 and share the permalink/choiceMessageLink
  contract with P3)
- B2 / B4 / B5 changes
- Dashboard web-UI choice rendering internals (only the pending-question
  write contract is touched — dashboard consumes `pendingQuestion` as before)

## Rollout flag

```bash
# cumulative prefix: N enables P1..PN, everything > N stays legacy
# valid values: 0 (default) | 1 | 2 | 3 | 4 | 5
# any value outside [0..5] → warn + fallback to 0 (fail closed)
SOMA_UI_5BLOCK_PHASE=0
```

Parsed in `src/config.ts` as `config.ui.fiveBlockPhase`. Every new code path
reads this value **per call** (not cached), so a restart with a new value
takes effect immediately on the next turn.

### Rollout sequence

1. Merge this PR with `SOMA_UI_5BLOCK_PHASE=2` in dev (already set from P2).
   Prod stays PHASE<=2 → zero B3 behavior change.
2. **PHASE flip gate** — before flipping dev to `SOMA_UI_5BLOCK_PHASE=3`,
   run the `ui-test choice` + `ui-test choice multi` smoke on **iOS**,
   **Android**, and **desktop web**. Both the single-choice "1️⃣..4️⃣"
   button row and the multi-choice 6-questions-per-form chunking must
   render correctly AND click-resolve to "✅ 선택: …". If any client fails,
   **hold the flip**. Deploy gate, not merge gate.
3. Flip dev to `SOMA_UI_5BLOCK_PHASE=3`. Smoke matrix:
   - single choice → click → in-place update
   - multi choice, 6Q chunk×2 → partial answers → submit → all chunks
     update
   - stale click (fire a question, supersede with a new one, click the old
     → must show "⏱️ _이 질문은 더 이상 유효하지 않습니다._" and NOT dispatch)
   - restart with a live pending question → reload session → click still
     resolves (see §Restart semantics)
   - dashboard hero "일괄 추천 제출" still dispatches correctly
4. 1-week soak on dev → flip prod to `SOMA_UI_5BLOCK_PHASE=3`. Monitor:
   - ghost-click dispatches (expected: 0)
   - stranded `pendingChoice` on disk after resolve (expected: 0; resolve
     calls `persistAndBroadcast` after clear)
   - duplicate choice messages per turn (expected: 0 — single-writer)
5. If any red flag, flip back to `2`. See §Rollback caveat.

### Rollback caveat

Downgrading PHASE=3 → PHASE=2 while a P3-era choice message is still
open in Slack is **deterministic**:

- The button's `value` JSON carries `turnId`. Under PHASE<3 the click
  handler IGNORES that extra key and runs the legacy resolver path. No
  ghost-dispatch, no error.
- The hero multi-choice button's `value` shape is **unchanged** (`{formId,
  sessionKey, n, m}`), so the downgrade path also works for multi-choice.

Upgrading PHASE=2 → PHASE=3 with a pre-flip choice message still open:

- The button value has no `turnId`, and no `session.actionPanel.pendingChoice`
  was ever written for that message. The click handler's classifier returns
  `'legacy'` (truly pre-flip) and runs the legacy resolver path — which
  still works because `choiceMessageTs` / `choiceMessageLink` were written
  during the PHASE=2 post.

Both rollback directions are **covered by tests**. See
`choice-action-handler.test.ts` P3 classifier tests.

## Architecture

### Session state (authoritative)

A new optional field on `ActionPanelState` (`src/types.ts`):

```ts
pendingChoice?: {
  turnId: string;
  kind: 'single' | 'multi';
  choiceTs?: string;        // single: message ts; multi: primary (first form) ts
  formIds: string[];        // multi only; empty for single
  question: UserChoice | UserChoices;
  createdAt: number;
};
```

- **Written synchronously** after a successful Slack post, BEFORE any
  `await` for permalink resolution, so a live button click during the
  permalink warm-up still finds a matching pendingChoice (closes v6 P1
  race from codex review).
- **Cleared synchronously** on resolve (by `ThreadPanel.resolveChoice` /
  `resolveMultiChoice`) and on defensive prelude supersession.
- Co-mutated with `choiceMessageTs`, `choiceMessageLink`,
  `waitingForChoice`, and (existing) `pendingQuestion`. Every mutation is
  followed by `sessionRegistry.persistAndBroadcast(sessionKey)` so disk
  + dashboard websocket stay in sync.

`PendingFormStore` (`src/slack/actions/pending-form-store.ts`) gains a new
optional `turnId?: string` on `PendingChoiceFormData`. Populated at form
registration under PHASE>=3. Read by click handlers to classify
multi-choice clicks (the hero button value `{formId, sessionKey, n, m}`
has no turnId, so the only reliable turnId source for multi is the
formStore).

### Payload identity

Embedded in Slack button `value` JSON (additive trailing key):

| Surface | Shape | turnId location |
|---|---|---|
| single-choice button | `{sessionKey, choiceId, label, question, turnId?}` | in `value` |
| custom-input single button | `{sessionKey, question, type, turnId?}` | in `value` |
| custom-input modal | — | in `private_metadata` |
| multi-choice select option | per-option JSON | **not added** — lookup via `formId` → `pendingForm.turnId` |
| hero "일괄 추천 제출" button | `{formId, sessionKey, n, m}` **exact shape** | **not added** — lookup via `formId` → `pendingForm.turnId` |

The hero button shape is asserted byte-exact by
`choice-message-builder.test.ts:517-532` — adding `turnId` there would
break those tests and the downstream parser. Multi-choice identity lives
in the formStore instead.

`turnId` is **omitted** from the value JSON entirely (not `"turnId":null`)
when the builder is called without it. PHASE<2 payloads are byte-identical
to pre-P3 output.

### Click classifier (3-way)

Every click handler runs this gate before any state mutation:

```ts
classifyClick({ sessionKey, payloadTurnId?, messageTs?, formId? })
  -> 'legacy' | 'p3' | 'stale'
```

Matrix:

| PHASE | `payloadTurnId` | `pendingChoice` | Match | Branch |
|-------|-----------------|-----------------|-------|--------|
| <3    | any             | any             | —     | **legacy** |
| >=3   | absent          | absent          | —     | **legacy** (truly pre-flip) |
| >=3   | present         | absent          | —     | **stale** |
| >=3   | present         | present         | matches (turnId + ts/formId) | **p3** |
| >=3   | present         | present         | mismatches      | **stale** |
| >=3   | absent          | present         | —     | **stale** (defensive) |

- `'legacy'` — existing `resolveChoiceSyncMessageTs` + `Promise.all(updateMessage)`
  + `clearChoice` + `messageHandler` dispatch. Body unchanged from PHASE<3.
- `'p3'` — `ThreadPanel.resolveChoice` / `resolveMultiChoice` + common
  terminus (clear `pendingQuestion`, transition activityState, dispatch,
  `persistAndBroadcast`).
- `'stale'` — `slackApi.updateMessage(channel, ts, '⏱️ _이 질문은 더 이상
  유효하지 않습니다._', staleBlocks, [])`; **no dispatch**.

The legacy branch under PHASE<3 is **strictly the old code**. New keys in
the payload (`turnId`) are tolerated but ignored.

The stale branch is reached only under PHASE>=3. It never falls through to
legacy, because the legacy resolver unions the clicked ts with the current
`session.actionPanel.choiceMessageTs` — under P3 that could mean updating
the **live** pendingChoice message with a stale click's answer. Dedicated
stale handling keeps ghost/stale clicks from resurrecting through the
legacy sync path.

### Defensive supersede prelude

Before a new P3 ask, `stream-executor.supersedePriorPendingChoice` clears
any prior `pendingChoice` record:

- for `'multi'` kind: best-effort updates each prior chunk message to
  "⏱️ _새 질문으로 대체되었습니다._" AND removes the formStore entries
- clears `pendingChoice` / `choiceMessageTs` / `choiceMessageLink` /
  `waitingForChoice` on session.actionPanel
- `persistAndBroadcast(sessionKey)`

This protects against split-brain if a prior post succeeded but resolve
never fired (e.g. dashboard/dm ambiguity, lost websocket, restart gap).

### Partial-failure rollback

`ThreadPanel.askUserForm` posts chunks in a loop. If chunk `i` throws
after chunks `0..i-1` posted:

1. Every posted chunk gets a best-effort Slack-side rewrite to
   "⏱️ _폼 생성에 실패했습니다._".
2. If `pendingChoice` was written (after chunk 0 posted), it's **defensively
   cleared**.
3. `persistAndBroadcast` fires for the cleared state.
4. Stream-executor sees `{ok: false, reason: 'post-failed'}`, deletes every
   pre-allocated formId from `PendingFormStore`, and falls back to the
   legacy `sendCommandChoiceFallback` text rendering.

### Restart semantics

Both sides of the P3 state are persisted:

| State | Store | Persistence trigger |
|-------|-------|---------------------|
| `session.actionPanel.pendingChoice` | session-registry (`sessions.json`) | explicit `persistAndBroadcast` on every mutation |
| `session.actionPanel.pendingQuestion` | session-registry | same |
| `pendingForm.turnId` | `PendingFormStore` (`pending-forms.json`) | `setPendingForm` → `formStore.set()` → `saveForms()` |
| `pendingForm.messageTs` | `PendingFormStore` | same (fixed in this PR — was in-place mutation) |

`setActivityState('waiting')` by itself does **not** persist (it only
persists on transition to `'idle'`). The explicit `persistAndBroadcast`
calls in the P3 path close that gap for the pendingChoice / pendingQuestion
co-fields. The old PHASE<3 path had the same gap for `pendingQuestion`
alone; it's closed by this PR too (now `pendingQuestion` persists on every
write regardless of PHASE).

After a restart within the session TTL (24h), `pendingChoice` + the
matching `pendingForm` records are restored. The next click routes through
the P3 classifier and resolves normally.

## `pendingChoice` lifecycle

```
posted (askUser/askUserForm)
  → pendingChoice set + persistAndBroadcast
    → (user clicks matching) p3 resolve → pendingChoice cleared + persistAndBroadcast
    → (user clicks stale) stale marker, no state change
    → (new question supersedes) defensive prelude → pendingChoice cleared + persistAndBroadcast
    → (post-failure partial rollback) defensive clear → persistAndBroadcast
    → (24h TTL via session-registry GC) silently expires
```

Turn `end()` / `fail()` do **NOT** touch `pendingChoice`. The question may
legitimately outlive the turn that posted it (e.g. a user who steps away
for an hour then returns to answer). See codex review v2 P0.

## Tests

- `turn-surface.test.ts` — askUser / askUserForm posts + return ts;
  resolveChoice/resolveMultiChoice update; `message_not_found` swallowed;
  `end()` does not force-resolve pending choice; `askUserForm` per-chunk
  state tracking.
- `thread-surface.test.ts` — `setChoiceMeta` writes expected fields +
  triggers permalink warm; `clearChoice` extension clears `pendingChoice`.
- `thread-panel.test.ts` — askUser happy path + PHASE<3 sentinel + post-
  failed; askUserForm 2-chunk success; askUserForm partial-failure rollback
  (Slack rewrite + state clear + persistAndBroadcast); resolveChoice/
  resolveMultiChoice clear + persist; PHASE<3 returns false.
- `choice-action-handler.test.ts` — classifier matrix (6 rows), persist
  on pendingQuestion clear, dashboard routing.
- `form-action-handler.test.ts` — custom-input single + multi P3; modal
  `private_metadata.turnId`; stale handling.
- `stream-executor.test.ts` — PHASE=3 renderSingleChoice / renderMultiChoice
  wiring; defensive prelude; post-failed → sendCommandChoiceFallback;
  PHASE=0 byte-identical; `setPendingForm` persistence fix for messageTs
  back-fill.
- `choice-message-builder.test.ts` — additive turnId in single +
  custom-input values; hero shape UNCHANGED.
- `session-registry.test.ts` — `persistAndBroadcast` happy path + broadcast
  error swallow.

## References

- Plan v2 SSOT: [#525 plan v2](https://github.com/2lab-ai/soma-work/issues/525#issuecomment-4270157443)
- Epic: [#669](https://github.com/2lab-ai/soma-work/issues/669)
- Phase 0 harness: `docs/slack-ui-phase0.md`
- Phase 1 B1 streaming: `docs/slack-ui-phase1.md`
- Phase 2 B2 plan block: `docs/slack-ui-phase2.md`
- Upstream: [Slack Agents UI](https://docs.slack.dev/apis/assistant/)
