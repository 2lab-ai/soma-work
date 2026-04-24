# CCT Refresh Error Surface

## Problem

The `/cct` card in Slack shows OAuth-attached slots as `:large_green_circle: Healthy` + "OAuth refreshes in Xh Ym" even when the most recent OAuth refresh attempt failed. In the reported screenshot 5 of 6 slots show the healthy/cooldown badge with the refresh hint, but only one slot (`dev1`) renders a usage panel — the rest are silently stuck. Operators have no signal that refresh is broken.

Current code paths that enable the silent failure:

1. `src/token-manager.ts:1475-1481` — `refreshAccessToken` only reacts to `OAuthRefreshError` with `status === 401` (→ `refresh_failed`) or `status === 403` (→ `revoked`). All other failure modes — HTTP 429, 5xx, network errors, `AbortError` from the 30 s timeout, JSON parse failure, `OAuthRefreshError` with any other status — are re-thrown without touching persistent state. `authState` stays `'healthy'`.
2. `src/cct-store/types.ts:51-69` — `SlotState` has no field that records a refresh attempt. There is nowhere to persist "last refresh failed at T with reason X".
3. `src/token-manager.ts:1404-1410` — `refreshAllAttachedOAuthTokens` catches per-slot errors into `results[keyId] = 'error'` plus `logger.warn`. It returns the map, but the scheduler (hourly tick) and the `refresh_usage_all` action both throw away the per-slot detail.
4. `src/slack/cct/actions.ts:275-291` (`refresh_usage_all`) — only posts `REFRESH_BANNERS.allNull` when *every* slot failed. Partial failures are re-rendered as if successful.
5. `src/token-manager.ts:1562-1680` (`#doFetchAndStoreUsage`) — when the pre-usage refresh throws, `return null`; the operator only sees `usage` stop updating, with no badge or timestamp to explain why.

## Goal

Every OAuth refresh failure is persisted and surfaced on the `/cct` card for the affected slot, regardless of the HTTP status, network condition, or who triggered the refresh (scheduler, `Refresh All OAuth Tokens` button, implicit refresh from usage fetch, implicit refresh from token consumption). Transient errors must clear themselves on the next successful refresh.

Non-goals:
- Changing the refresh backoff / cadence.
- Splitting `authState` into more arms. The existing `'healthy' | 'refresh_failed' | 'revoked'` taxonomy stays; we only add **diagnostic fields alongside it**.
- Changing usage-panel semantics (`dev1`-only rendering is a *symptom* of the bug, not a separate bug — fixing the root refresh-error tracking lets the operator see why the others are empty).

## Design

### Store: new diagnostic fields on `SlotState`

Add to `SlotState` in `src/cct-store/types.ts`:

```ts
/** Epoch ms of the last refresh attempt that succeeded. Cleared on detach. */
lastRefreshAt?: number;
/** Epoch ms of the last refresh attempt that failed. Cleared on the next successful refresh. */
lastRefreshFailedAt?: number;
/** Diagnostic details for the last refresh failure. Cleared on the next successful refresh. */
lastRefreshError?: {
  /** HTTP status if the error came from the refresh endpoint, `undefined` for network/abort/parse failures. */
  status?: number;
  /** Short, UI-safe message. No tokens, no full bodies — see `shortenRefreshError` in token-manager.ts. */
  message: string;
  /** Epoch ms — duplicates `lastRefreshFailedAt` so the nested object is self-describing for logs. */
  at: number;
  /** Coarse bucket for UI styling + metric grouping. */
  kind: 'unauthorized' | 'revoked' | 'rate_limited' | 'server' | 'network' | 'timeout' | 'parse' | 'unknown';
};
/** Count of consecutive refresh failures; reset to 0 on success. Zero-valued when absent. */
consecutiveRefreshFailures?: number;
```

All fields are optional so v2 snapshots persisted before this PR stay loadable without migration — an absent field means "no signal yet".

Two persistence paths must clear all four new fields:

- **`#detachOAuthOnSetupSlot`** (token-manager.ts:1037-1053) — delete `lastRefreshAt`, `lastRefreshFailedAt`, `lastRefreshError`, `consecutiveRefreshFailures` alongside the existing `usage` cleanup.
- **`attachOAuth`** (token-manager.ts:1075-1126) — the current code only resets `authState = 'healthy'` (L1112-1113). It must also delete the four new fields so a detach → re-attach cycle does not inherit a prior generation's error. An in-flight failure write that loses the generation-guard race (see `markRefreshFailure` above) already no-ops, but clearing on attach is belt-and-suspenders: it covers writes that won the race to the OLD generation just before the new one landed.

### TokenManager: capture every refresh outcome

In `src/token-manager.ts`:

1. **`#classifyRefreshError(err: unknown): { kind, status?, message }`** — pure helper. `message` comes from a **fixed template table** keyed by `kind` — raw `OAuthRefreshError.body`, raw `err.message`, and any external string is **never** persisted or rendered.

   | err shape | kind | status | message template |
   |---|---|---|---|
   | `OAuthRefreshError`, 401 | `unauthorized` | 401 | `"Refresh rejected (401 invalid_grant)"` |
   | `OAuthRefreshError`, 403 | `revoked` | 403 | `"Refresh revoked (403)"` |
   | `OAuthRefreshError`, 429 | `rate_limited` | 429 | `"Refresh throttled (429)"` |
   | `OAuthRefreshError`, 500-599 | `server` | status | `"Refresh server error (${status})"` |
   | `OAuthRefreshError`, other 4xx/etc | `unknown` | status | `"Refresh failed (${status})"` |
   | `OAuthRefreshError` where `body === ''` AND message startsWith `"OAuth refresh response was not valid JSON"` or `"OAuth refresh response missing"` | `parse` | undefined | `"Refresh response malformed"` |
   | `AbortError` (refresher 30 s timeout) | `timeout` | undefined | `"Refresh timed out after 30s"` |
   | `TypeError` / `FetchError` / code `ECONNRESET`/`ENOTFOUND`/`EAI_AGAIN` | `network` | undefined | `"Refresh network error"` |
   | fallback | `unknown` | undefined | `"Refresh failed (unknown)"` |

   No path interpolates `err.message`, `OAuthRefreshError.body`, or a response body into the stored string. mrkdwn-unsafe chars are a non-issue because the table contains only static ASCII; the builder still escapes defensively.

2. **`markRefreshFailure(keyId, attachedAt, info): Promise<void>`** — persists under the same CAS pattern as `markAuthState` with a strict attachment-generation guard:
   - Captured `attachedAt` is the fingerprint the caller observed at refresh start (same value `refreshAccessToken` already captures as `preAttachedAt`).
   - Inside `store.mutate`: find the slot; if the slot no longer exists, is not a CCT, has no `oauthAttachment`, or `oauthAttachment.attachedAt !== attachedAt` → **drop the write silently** (no log noise — an orphan write would resurrect `state[keyId]` for a removed slot, or leak a prior generation's error onto a fresh attach).
   - When the guard passes: `lastRefreshFailedAt = now`, `lastRefreshError = { ...info, at: now }`, `consecutiveRefreshFailures = (prev ?? 0) + 1`.
   - For `kind === 'unauthorized'` set `authState = 'refresh_failed'`; for `'revoked'` set `authState = 'revoked'`. All other kinds leave `authState` untouched.
   - Calls `this.refreshCache()` so the card sees the update on the next render.

3. **`markRefreshSuccess(keyId): Promise<void>`** — persisted inside the existing success `store.mutate` block:
   - `lastRefreshAt = now`, delete `lastRefreshFailedAt`, delete `lastRefreshError`, `consecutiveRefreshFailures = 0`.
   - `authState = 'healthy'` (unchanged from today's line 1522, just consolidated).

4. **`refreshAccessToken` (1440-1545)** — widen the error handling, passing the captured `preAttachedAt` fingerprint:
   ```
   try { next = await refreshClaudeCredentials(...); }
   catch (err) {
     await markRefreshFailure(keyId, preAttachedAt, classifyRefreshError(err));
     throw err;
   }
   ```
   The existing `markAuthState` calls for 401/403 are absorbed into `markRefreshFailure`. The success `store.mutate` block (L1482-1524) also sets `lastRefreshAt = now` + clears `lastRefreshFailedAt` / `lastRefreshError` / `consecutiveRefreshFailures` — inlined inside the existing generation-guarded mutate so persistence is atomic and attachment-generation-safe.

5. **`refreshAllAttachedOAuthTokens` (1384-1433)** — no behaviour change beyond reading `markRefreshFailure`-stored state; the per-slot `results` map stays `'ok' | 'error'` for call sites that don't need detail, but callers that want detail can read it from `getSnapshot()`.

### Slack UI: show the error on the card

In `src/slack/cct/builder.ts`:

1. **`authStateBadge`** stays as today (`'healthy' | 'refresh_failed' | 'revoked'` → badge). No change.
2. **`buildSlotStatusLine` (457-492)** — for OAuth-attached slots, after the badge + refresh-hint segments, append one **refresh-error segment** when `state?.lastRefreshError` is present:
   - Primary text: `:warning: Refresh failed: <message>`.
   - Suffix: ` (<Nd|Nh|Nm> ago)` computed from `now - lastRefreshFailedAt`.
   - If `state.consecutiveRefreshFailures >= 2` append ` · ×N` so streaks are visible.
   - Kind styling: `'rate_limited'` uses `:hourglass:` instead of `:warning:`; `'network' | 'timeout'` use `:satellite_antenna:`; everything else stays `:warning:`.
   - The segment is only emitted for `authState === 'healthy'` cases **and** for `'refresh_failed' | 'revoked'` cases — in the broken-auth case it replaces the empty right-hand side the card had before (no refresh hint because OAuth is dead, but now there is at least one line explaining why).
3. **`buildSlotRow`** — no structural change; the extra line lives inside `line2`.

### Refresh button feedback

In `src/slack/cct/actions.ts`:

1. Split **`REFRESH_BANNERS`**:
   - `allNull` (kept; rewritten to reference the per-row errors).
   - `partialFailure(failures: Array<{ name, kind, status? }>)` — builder returning a banner header string: `":warning: *Refresh All OAuth Tokens — N of M failed:* ai2 (429), ai3 (network)..."`. Uses `kind`/`status` codes **only** — never `lastRefreshError.message` freeform. Truncates to 5 names with `… (+N more)`.

2. In `refresh_usage_all`:
   - Capture `startingKeyIds = snap.registry.slots.filter(hasOAuthAttachment).map(keyId)` **before** the refresh call.
   - After `tokenManager.refreshAllAttachedOAuthTokens(...)`, reload snapshot as `snap2`.
   - Classify every starting keyId:
     - `results[keyId] === 'ok'` → ok.
     - `results[keyId] === 'error'` → failure with reason from `snap2.state[keyId].lastRefreshError.kind` (fallback `'unknown'`).
     - `results` missing the keyId entirely:
       - If `snap2` still shows the slot attached (CCT with `oauthAttachment`) → classify as `timeout` (hit the fan-out deadline before settle).
       - If `snap2` shows the slot removed or detached (no attachment) → **omit from failure accounting**; the slot was torn down concurrently and is no longer a relevant failure.
   - If all-ok → unchanged (post ephemeral card).
   - If all-failed → existing `REFRESH_BANNERS.allNull` ephemeral (still a single message).
   - If mixed → **single ephemeral surface**: one message whose blocks = `[banner_section, ...cardBlocks]`. The banner is a `section` block at index 0, card blocks follow. No two-post sequence — eliminates the ordering race on two separate `chat.postEphemeral` calls.

3. Extend `postEphemeralCard` (or add `postEphemeralCardWithBanner(client, body, bannerBlock)`) so the mixed-path gets one transport call. The helper sets both `blocks` and a top-level `text` (`'⚠️ CCT refresh — partial failure'`) as the Slack fallback, matching the existing ephemeral helpers. On transport failure, fall back to a single `postEphemeralFailure` with just the banner — never leave the user with nothing.

### Scheduler

No change to `OAuthRefreshScheduler.tickNow`. Verified call chain: `OAuthRefreshScheduler.tickNow()` → `TokenManager.refreshAllAttachedOAuthTokens()` → `forceRefreshOAuth(keyId)` → `#refreshTokenOnly(keyId)` → `refreshAccessToken(slot)`. The hourly tick does **not** bypass the planned catch; the new `markRefreshFailure` call inside `refreshAccessToken` populates the new fields on every scheduled tick automatically.

### utilization dual-form is the wrong abstraction — drop it

Three sibling helpers each claim to "normalize 0..1 fraction or 0..100 percent" with **different boundaries**:

- `src/slack/cct/builder.ts:94` `utilToPctInt` — split at `util <= 1` (buggy: `1 → 100`).
- `src/slack/cct/builder.ts:336` `isUtilizationFull` — split at `util > 1.5` (buggy at `util === 1`: falls into fraction-form branch, evaluates `1 >= 1` → Full).
- `src/slack/pipeline/stream-executor.ts:180` `normalizeUtilizationToPercent` — split at `raw <= 1.5` (buggy: `1 → 100`, same as utilToPctInt).

Any dual-form split has an irreducible ambiguity at the overlap: `util = 1` literally means both "1%" (percent form) and "100%" (fraction form 1.0). No boundary resolves that — moving it only relocates the bug. The file-local comments already state the SSOT: `"Anthropic's '/api/oauth/usage' endpoint passes through raw integer percent"` (`src/slack/cct/builder.ts:325-339`, `#684` regression note). With that contract, the fraction form exists **only in legacy test inputs**, not in production.

**Spec — drop the dual-form; normalize once.**

All three helpers become direct percent handlers:

```ts
// src/slack/cct/builder.ts
function utilToPctInt(util: number | undefined): number {
  if (util === undefined || !Number.isFinite(util)) return 0;
  return Math.max(0, Math.min(100, Math.round(util)));
}

function isUtilizationFull(util: number | undefined): boolean {
  if (util === undefined || !Number.isFinite(util)) return false;
  return util >= 100;
}

// src/slack/pipeline/stream-executor.ts
function normalizeUtilizationToPercent(raw: number | undefined): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;
}
```

Legacy tests that pass fractional values (`0.82`, `0.1`, `0.5`, `0.95`) are migrated to percent-form inputs (`82`, `10`, `50`, `95`). Every test migration matches what the real API sends, so the test suite finally reflects production.

**Acceptance criteria (additional).**

- `utilToPctInt(1) === 1` (not `100`).
- `utilToPctInt(50) === 50`.
- `utilToPctInt(100) === 100`.
- `utilToPctInt(105) === 100` (clamp).
- `utilToPctInt(-5) === 0` (clamp).
- `isUtilizationFull(1) === false`.
- `isUtilizationFull(99.99)` → rounds; spec: `>= 100` is strict, so 99.99 is false. If the server ever sends 99.5 we want the bar at 100% (`Math.round` does that) but no Cooldown yet — this matches user intent that cooldown == "full".
- `isUtilizationFull(100) === true`.
- `normalizeUtilizationToPercent(1) === 1`.
- `normalizeUtilizationToPercent(100) === 100`.
- Rendering `{ sevenDay: { utilization: 1, resetsAt: <future> } }` produces `7d ░░░░░░░░░░ 1%` and `:large_green_circle: Healthy`.
- Every `formatUsageBar` / `isUtilizationFull` / `normalizeUtilizationToPercent` test is migrated from fraction form to percent form; no dual-form test remains.

### Usage-fetch path

No direct change to `fetchAndStoreUsage`.

### Usage staleness surface (second-order bug)

Field evidence shows a related silent-failure pattern: some slots render an empty usage panel while others render bars. Root-caused via ztrace:

1. `src/token-manager.ts:1575-1680` — `#doFetchAndStoreUsage` only writes `state.usage` on success and never clears it on failure. A slot whose refresh has been failing for hours/days keeps a stale `UsageSnapshot` indefinitely (or never gets one written in the first place, hence the empty panel). Once refresh finally succeeds, the card jumps straight to the current value with no visual hint that the previous reading was stale.
2. `src/slack/cct/builder.ts:277-301` — `buildUsagePanelBlock` renders `utilization` + `resetsAt` but never surfaces `usage.fetchedAt`, so the operator cannot distinguish a snapshot from 30 seconds ago vs. one from two days ago.
3. The usage endpoint is per-token (not account-wide — confirmed by field screenshots where sibling slots on the same email domain show distinct `seven_day.utilization` values). Staleness of any one slot's snapshot is therefore a real problem, not an artefact of shared-bucket convergence.

**Spec addition: render `fetchedAt` on the usage panel.**

In `src/slack/cct/builder.ts` → `buildUsagePanelBlock`:

- Append a compact `fetched Nm ago` / `Nh ago` / `Nd ago` suffix to the **final row** of the panel. One suffix per panel (not per row) — the snapshot is atomic, all three windows share the same `fetchedAt`.
- When `now - fetchedAt > 10 * 60_000` (10 min), prepend a `:warning:` glyph to the suffix.
- When `state.lastRefreshError` is present **and** `state.usage` exists, prepend a single in-panel warning line **inside the same context block's mrkdwn text**. Concretely the block's text becomes `⚠️ _Usage is stale — last refresh failed <ago>._\n\`\`\`\n<existing rows>\n\`\`\``. The block count per slot stays at **1** for the usage panel (same as today) — no new block, no change to the 50-block budget math in `buildCctCardBlocks` (L647) or the overflow trimming logic that targets `cct_usage_panel:*` block ids (L503).
- When `state.usage` is absent entirely *and* `state.lastRefreshError` is present, the already-planned error segment in `buildSlotStatusLine` is enough; no extra panel is emitted.

Block-budget invariant: the usage panel remains exactly 1 block per attached slot. The refresh-error segment lives inside `line2` of the slot's existing section block (scenario 4), not a new block. Total block count per attached rich slot stays ≤ 4, matching the existing budget comment at `builder.ts:510-514`.

**Why not more clever invalidation.**

Deleting `state.usage` on every refresh failure would churn the UI (every 429 blip wipes the last-known value, which is often more useful than nothing). `fetchedAt` + stale warning is the minimum-surprise fix: the previous reading stays visible, but the operator sees how old it is.

**Acceptance criteria (additional).**

- Usage panel always shows `fetched Nm ago` / `fetched Nh ago` / `fetched Nd ago` (not a raw ISO timestamp).
- `fetchedAt` older than 10 minutes adds `:warning:`.
- When `state.lastRefreshError` is present alongside `state.usage`, a dim "Usage is stale — last refresh failed `<ago>`" in-panel warning line is rendered inside the same context block's mrkdwn text, above the code-fenced usage rows.
- Removing the attachment (`#detachOAuthOnSetupSlot`) clears `usage` as today, so no stale surface survives a detach.

### Wiring audit

- `SlotState` is persisted by the existing `store.mutate` CAS paths. No schema version bump required.
- `#detachOAuthOnSetupSlot` clears the four new fields alongside existing usage fields.
- `attachOAuth` clears the four new fields so re-attach starts from a clean slate.
- `markAuthState` (1017-1023) stays as today; `markRefreshFailure` writes `authState` only for `unauthorized`/`revoked` kinds.
- **Generation guard on failure writes:** `markRefreshFailure` takes the caller-captured `attachedAt` and refuses to persist if the slot was removed, detached, or re-attached since refresh start. This prevents (a) orphan `state[keyId]` resurrection after remove, and (b) leaking an old generation's failure onto a fresh attach. The success-write path is already generation-guarded at L1498-1501 — this aligns the failure-write path with the same rule.
- Verified scheduler chain: `OAuthRefreshScheduler.tickNow()` → `refreshAllAttachedOAuthTokens()` → `forceRefreshOAuth()` → `#refreshTokenOnly()` → `refreshAccessToken()`. Every hourly tick flows through the new catch.

## Risks

1. **Field creep on `SlotState`** — we add 4 new optional fields. Mitigation: migration-safe via optional typing; every path that deletes `usage` already touches `SlotState`, so `#detachOAuthOnSetupSlot` is the only place that needs a companion change.
2. **Message exposure** — the safety model is "fixed template table only". `classifyRefreshError` returns strings from a static ASCII table keyed on `kind` + (optionally) numeric `status`; `OAuthRefreshError.body`, `err.message`, and any external text are never persisted or rendered. The builder still applies mrkdwn escaping defensively. Contract test injects adversarial token-pattern substrings into `err.message` and asserts they never appear in the stored field or the ephemeral banner.
3. **UI-budget overflow** — adding a segment to `line2` does not add new blocks; the existing 50-block cap is unaffected.
4. **Stale error persistence** — if a slot goes healthy but the server forgets to clear fields, the card keeps showing the stale warning forever. Mitigation: success path always deletes the failure fields (enforced by a contract test).
5. **Race: `markRefreshFailure` for a detached slot** — if a detach lands before `markRefreshFailure` persists, we resurrect no attachment (we only write into `snap.state[keyId]`; the attachment itself is untouched). `#detachOAuthOnSetupSlot` clears these fields, so a subsequent detach would wipe them. Acceptable.

## Acceptance criteria

- All of 401, 403, 429, 500, 502, network timeout, and network error produce a persisted `lastRefreshError` with the correct `kind`.
- 401 sets `authState = 'refresh_failed'`; 403 sets `authState = 'revoked'`. Other kinds leave `authState === 'healthy'`.
- The next successful refresh clears `lastRefreshError`, `lastRefreshFailedAt`, and zeroes `consecutiveRefreshFailures`.
- **Detach** clears all four new fields.
- **Attach** clears all four new fields (belt-and-suspenders against an in-flight failure write that wins the generation race just before re-attach).
- `markRefreshFailure` silently drops the write when the slot is removed, detached, or re-attached since refresh start.
- `/cct` card renders `:warning: Refresh failed: ... (2m ago) · ×3` on a slot whose last refresh failed three times; the healthy badge is replaced by `:black_circle: Unavailable` for 401/403, otherwise the green badge remains but the failure line is present.
- `Refresh All OAuth Tokens` click with 2 of 3 slots failing posts a single ephemeral message whose first block is the partial-failure banner and whose remaining blocks are the updated card. Names the 2 failed slots with reason codes only.
- Slots missing from `results` classify as `timeout` when the slot is still attached in the reloaded snapshot, and are omitted when the slot was concurrently torn down.
- No regression in the "all-failed" banner (`REFRESH_BANNERS.allNull`) or in the existing ephemeral-card post on all-ok.
- **15 attached slots with refresh-error segment + stale-usage warning all rendered stays ≤ 50 blocks** — verified by an explicit overflow test.
- `lastRefreshError.message` is always one of the fixed templates from the `classifyRefreshError` table. Adversarial inputs injecting `sk-ant-oat01-...` or other token patterns into raw error messages never appear in the stored field or in the rendered banner.
- Existing tests stay green; new tests cover `#classifyRefreshError`, `refreshAccessToken` error paths with generation-mismatch drops, `builder.ts` error-segment formatting, staleness warning rendering, `refresh_usage_all` banner assembly + timeout inference + secret redaction, `utilToPctInt` / `isUtilizationFull` / `normalizeUtilizationToPercent` boundary tables + cross-function invariants.
