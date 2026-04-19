# CCT Token Rotation — Vertical Traces

> **DEPRECATED (2026-04-19, PR-A #575).** This document describes the v1
> `TokenSlot` union (`setup_token | oauth_credentials` with a flat
> `slotId` / `activeSlotId`) which no longer exists in `src/`. It is
> retained **only** as a historical reference for the pre-AuthKey
> behaviour and for reviewers cross-walking the migrator.
>
> For the current authoritative spec see `spec.md`. For the end-to-end
> code path after the AuthKey v2 refactor see `trace-v2.md`. For the
> per-field migration mapping (v1 → v2) see `trace-v2.md §2.1`.
>
> Do not add new content here. New scenarios belong in `trace-v2.md`.

> Originally written: 2026-04-18 — Wave 5 of the slot-model overhaul (#569). Each
> scenario references the implementation files in `src/cct-store/*`,
> `src/oauth/*`, `src/slack/cct/*`, `src/slack/commands/cct-handler.ts`,
> and `src/token-manager.ts`.

Conventions:

- "tm" refers to the `TokenManager` singleton returned by
  `getTokenManager()` in `src/token-manager.ts`.
- "store" refers to the `CctStore` held by `tm.store`.
- Invariants are checked at the end of each scenario; they must hold on
  the persisted `cct-store.json` snapshot.

---

## Scenario 1 — Add `setup_token` slot via Block Kit

**Goal:** Operator adds a legacy setup token through the Slack card.

### Preconditions

- User is in `ADMIN_USERS`.
- `cct-store.json` exists (may have zero or more slots).
- A bound Bolt `App` has had `registerCctActions(app, tm)` called on it
  during startup.

### Flow

1. User runs `/z cct`. `CctHandler.execute` (in
   `src/slack/commands/cct-handler.ts`) calls `renderCctCard(…)` which
   calls `buildCctCardBlocks(…)`
   (`src/slack/cct/builder.ts`). Card includes an `Add` button with
   `action_id = CCT_ACTION_IDS.add`.
2. Click dispatches to the handler registered by
   `registerCctActions` → `app.action(CCT_ACTION_IDS.add, …)`
   (`src/slack/cct/actions.ts`). Handler acks within 3 s and calls
   `views.open` with `buildAddSlotModal('setup_token')`.
3. The modal has three input blocks:
   - `CCT_BLOCK_IDS.add_name` (plain_text_input, max 64 chars)
   - `CCT_BLOCK_IDS.add_kind` (radio, `dispatch_action: true`)
   - `CCT_BLOCK_IDS.add_setup_token_value` (plain_text_input)

   User types `name=cct4` and pastes `sk-ant-oat01-<chars>`; the kind
   radio stays on `setup_token`.
4. User clicks **Add**. Slack sends `view_submission`. The
   `app.view(CCT_VIEW_IDS.add, …)` handler in `actions.ts`:
   - Calls `validateAddSubmission(values)` — returns per-`block_id`
     error strings if name / value is empty or malformed.
   - On success, calls
     `tm.addSlot({ kind: 'setup_token', name, value })`.
5. `TokenManager.addSlot` constructs `SetupTokenSlot` with a new
   `slotId = ulid()`, pushes it into `snap.registry.slots` via
   `store.mutate`, creates
   `snap.state[slotId] = { authState: 'healthy', activeLeases: [] }`,
   assigns `snap.registry.activeSlotId` if the registry was empty, and
   mirrors the token to `process.env.CLAUDE_CODE_OAUTH_TOKEN`.

### Invariants verified

- `snap.revision` increments by exactly 1.
- `snap.registry.slots.find(s => s.slotId === newId).kind === 'setup_token'`.
- `snap.state[newId].authState === 'healthy'`.
- No `acknowledgedConsumerTosRisk` field on the slot (it is undefined /
  `false`).
- `process.env.CLAUDE_CODE_OAUTH_TOKEN` matches the pasted value if the
  new slot is active.

### Log / store side effects

- `addSlot: cct4 kind=setup_token slotId=<ulid>` (redacted).
- `cct-store.json` committed with the new slot + state.
- No network call is made — `setup_token` slots never hit
  `platform.claude.com`.

---

## Scenario 2 — Add `oauth_credentials` slot (ToS ack + scope check)

**Goal:** Operator pastes a full `claudeAiOauth` blob harvested from
`~/.claude/.credentials.json`.

### Preconditions

- User is admin.
- User has a valid `claudeAiOauth` blob with at least the `user:profile`
  scope.

### Flow

1. `/z cct` → click *Add* (same as Scenario 1 up through modal open).
2. User flips the kind radio to `oauth_credentials`. Because the radio
   input has `dispatch_action: true`, Slack sends a `block_actions`
   event on `CCT_ACTION_IDS.kind_radio`. The action handler calls
   `views.update` with `buildAddSlotModal('oauth_credentials')`. The
   modal re-renders with:
   - the same `CCT_BLOCK_IDS.add_name` input (value preserved — Slack
     honours stable block_id/action_id pairs),
   - the blob input (`CCT_BLOCK_IDS.add_oauth_credentials_blob`,
     multiline, `SLACK_PLAIN_TEXT_INPUT_MAX` char cap),
   - the ToS ack checkbox (`CCT_BLOCK_IDS.add_tos_ack`).
3. User pastes the JSON blob and checks the ToS box, clicks **Add**.
4. The `view_submission` handler:
   - Calls `validateAddSubmission(values)`. This calls
     `parseOAuthBlob(raw)` (`actions.ts`) which extracts
     `claudeAiOauth.{accessToken, refreshToken, expiresAt, scopes}` and
     returns an `OAuthCredentials` or `null`. On null → per-block_id
     error `"Could not parse claudeAiOauth JSON"`.
   - Calls `hasRequiredScopes(scopes)`
     (`src/oauth/scope-check.ts`). Missing `user:profile` →
     per-block_id error `"Missing required scope: user:profile"`.
   - Confirms the ToS checkbox is ticked → else error on
     `CCT_BLOCK_IDS.add_tos_ack`.
5. On success:
   `tm.addSlot({kind:'oauth_credentials', name, credentials, acknowledgedConsumerTosRisk:true})`.
   `TokenManager.addSlot` re-runs `hasRequiredScopes` as a
   belt-and-braces check and throws if it fails (caught by the handler
   which surfaces a `response_action:errors`).

### Invariants verified

- The stored slot has `kind: 'oauth_credentials'` and
  `acknowledgedConsumerTosRisk: true`.
- `credentials.scopes` includes `'user:profile'`.
- `state.authState === 'healthy'` on creation.
- `expiresAtMs` is an absolute epoch-ms, not a `Date`.

### Log / store side effects

- `addSlot: <name> kind=oauth_credentials slotId=<ulid>` (with secrets
  redacted by `redactAnthropicSecrets`).
- `cct-store.json` revision bumped; new slot present.

---

## Scenario 3 — Proactive refresh dedupe (10 concurrent callers)

**Goal:** Under load, only one HTTP POST to `platform.claude.com` is
issued even when 10 concurrent streams need a fresh access token.

### Preconditions

- A single `oauth_credentials` slot is active.
- The slot's `credentials.expiresAtMs - Date.now() < 7h` (inside the
  refresh buffer).
- No refresh is currently in flight.

### Flow

1. Ten `stream-executor` turns call `ensureActiveSlotAuth` concurrently
   (tick 0). This delegates to `tm.getValidAccessToken(activeSlotId)`.
2. `getValidAccessToken` sees `expiresAtMs - now < REFRESH_BUFFER_MS`
   and calls `this.refreshAccessToken(slot)`
   (`src/token-manager.ts`).
3. The first caller creates an async IIFE promise, stores it under
   `this.refreshInFlight.set(slotId, promise)`, and starts the HTTP
   POST via `refreshClaudeCredentials(current)`
   (`src/oauth/refresher.ts`).
4. Callers 2..10 hit
   `this.refreshInFlight.get(slotId)` and short-circuit to the same
   Promise — `refreshInFlight` is checked **before** the HTTP call.
5. `refreshClaudeCredentials` POSTs to
   `https://platform.claude.com/v1/oauth/token` with
   `{ grant_type: 'refresh_token', refresh_token, client_id: CLAUDE_OAUTH_CLIENT_ID }`.
6. On 2xx, the IIFE takes the store lock via
   `store.mutate(fn)`, overwrites `credentials`, sets
   `state.authState = 'healthy'`, commits (bumps revision). Finally
   `refreshInFlight.delete(slotId)` clears the dedupe entry.
7. All ten callers resolve with the same new `accessToken`.

### Invariants verified

- Exactly **one** network fetch to `platform.claude.com/v1/oauth/token`
  (assert via a mock-fetch spy in tests).
- `cct-store.json` revision increments by exactly 1.
- `credentials.expiresAtMs` is now > `Date.now() + 7h` for all ten
  callers (they see the same post-refresh snapshot).
- `refreshInFlight.size === 0` after all promises resolve.

### Log / store side effects

- One `refreshAccessToken: success` log line (with redacted slotId
  context).
- `cct-store.json` has a single new revision even though ten callers
  raced.

---

## Scenario 4 — Revoke → quarantine

**Goal:** A 403 on refresh moves the slot to `authState='revoked'` and
excludes it from future rotation.

### Preconditions

- An `oauth_credentials` slot `A` is active; its access token is near
  expiry.
- A second healthy slot `B` exists.

### Flow

1. Stream calls `tm.getValidAccessToken(A.slotId)`; inside the refresh
   buffer.
2. `refreshAccessToken(A)` calls
   `refreshClaudeCredentials(A.credentials)` which throws
   `OAuthRefreshError { status: 403, body: … }`.
3. The catch in `refreshAccessToken` inspects `err.status`:
   - `401` → `markAuthState(slotId, 'refresh_failed')`.
   - `403` → `markAuthState(slotId, 'revoked')`.
4. The error rethrows; the caller (usually `ensureActiveSlotAuth`)
   treats it as a rotation trigger and calls `tm.rotateOnRateLimit(…)`
   or `tm.rotateToNext()`.
5. `rotateToNext` walks slots starting at `A + 1`;
   `isEligible(snap.state[A.slotId], now)` returns false because
   `authState === 'revoked'`. `B` is picked.

### Invariants verified

- `snap.state[A.slotId].authState === 'revoked'`.
- `snap.registry.activeSlotId === B.slotId` post-rotation.
- `A` never re-enters the active pointer via `pickNextHealthy`
  (`isEligible` returns false for any state where
  `authState !== 'healthy'`).
- No further HTTP requests use `A`'s credentials.

### Log / store side effects

- `refreshAccessToken: failed 403` (redacted).
- `markAuthState: <A.slotId> → revoked` store mutation.
- `rotateOnRateLimit: oauth_refresh_403 source=manual rotated=B`.

---

## Scenario 5 — Remove active slot while busy

**Goal:** Operator removes the currently-active slot while in-flight
streams hold leases on it. Remove is deferred (tombstoned) until leases
drain.

### Preconditions

- Slot `A` is active and has two live leases from in-flight stream
  executions.
- Slot `B` is healthy and idle.

### Flow

1. Operator runs `/z cct` → clicks **Remove** on slot `A`.
2. `app.action(CCT_ACTION_IDS.remove, …)` opens
   `buildRemoveSlotModal(A, hasActiveLeases=true)` which surfaces a
   warning — *"Slot has active leases; the slot will be tombstoned and
   removed once in-flight requests drain."* `private_metadata` carries
   `A.slotId`.
3. Operator clicks **Remove**. `view_submission` handler calls
   `tm.removeSlot(slotId)`.
4. `TokenManager.removeSlot` runs under `store.mutate`:
   - Sees `state.activeLeases.length > 0` and `force=false`.
   - Sets `state.tombstoned = true`.
   - If `snap.registry.activeSlotId === A.slotId`, picks the next
     healthy slot (`B`) and sets it as active.
   - Returns `{ removed: false, pendingDrain: true }`.
5. `process.env.CLAUDE_CODE_OAUTH_TOKEN` is re-mirrored to `B`'s token.
6. The two in-flight turns complete and call `releaseLease(leaseId)` —
   `state.activeLeases.length` drops to 0.
7. The reaper timer (every 30 s) fires `reapExpiredLeases`, which also
   performs the second pass: any slot with
   `tombstoned && activeLeases.length === 0` is fully removed from
   `snap.registry.slots` and its state entry is deleted.

### Invariants verified

- At step 4: `snap.state[A.slotId].tombstoned === true`,
  `snap.registry.activeSlotId === B.slotId`, `A` is still in
  `snap.registry.slots`.
- Between steps 6 and 7: no new work is accepted on `A`
  (`isEligible` false due to tombstone).
- After step 7:
  `snap.registry.slots.find(s => s.slotId === A.slotId)` is
  `undefined`; `snap.state[A.slotId]` is `undefined`.
- `tm.removeSlot` is idempotent — re-running it on `A.slotId` post-reap
  returns `{ removed: false }`.

### Log / store side effects

- `removeSlot: A → tombstoned, pending drain (2 leases)`.
- Reaper pass logs `reapExpiredLeases: removed tombstoned slot A`.
- Two `cct-store.json` revisions: the tombstone commit and the reap
  commit.

---

## Scenario 6 — Usage 429 backoff ladder

**Goal:** `/api/oauth/usage` returns 429 repeatedly; the slot's
`nextUsageFetchAllowedAt` advances 2m → 5m → 10m → 15m.

### Preconditions

- An `oauth_credentials` slot with a valid access token.
- `state.nextUsageFetchAllowedAt` is either absent or in the past.

### Flow

1. Operator runs `/z cct usage`. `CctHandler.execute` routes to the
   `usage` branch
   (`src/slack/commands/cct-handler.ts::handleUsage`), which calls
   `tm.fetchAndStoreUsage(slotId)`.
2. `fetchAndStoreUsage` confirms kind is `oauth_credentials`, checks
   `nextUsageFetchAllowedAt > now` (false on first call), calls
   `getValidAccessToken` (no refresh needed), then `fetchUsage(token)`
   (`src/oauth/usage.ts`).
3. Server returns 429. `fetchUsage` throws
   `UsageFetchError { status: 429 }`. The manager catches and calls
   `applyUsageFailureBackoff(slotId)`:
   - Reads current remaining backoff (0 on first failure).
   - Calls `nextUsageBackoffMs(0)` → `2 * 60_000`.
   - Persists `state.nextUsageFetchAllowedAt = Date.now() + 2m`.
   - Returns `null` to the handler.
4. Handler renders
   `"Usage not available yet — next fetch in 2m. Try again later."`.
5. Operator retries immediately. `fetchAndStoreUsage` sees
   `nextUsageFetchAllowedAt > now` and returns null without any HTTP
   call.
6. Two minutes later, operator retries. Server returns 429 again.
   `applyUsageFailureBackoff` reads the previous remaining backoff and
   `nextUsageBackoffMs(prev)` walks the ladder to the next step (5m).
7. Subsequent 429s advance 5m → 10m → 15m (cap). 15m is the terminal
   step; further 429s keep `nextUsageFetchAllowedAt` at `now + 15m`.

### Invariants verified

- `state.nextUsageFetchAllowedAt` is strictly non-decreasing across
  successive 429 failures (until a 2xx resets it to `now + 2m` via the
  success path).
- The ladder is `[2m, 5m, 10m, 15m]` — see `BACKOFF_LADDER_MS` in
  `src/oauth/usage.ts`.
- `nextUsageBackoffMs(15m) === 15m` (capped, not throwing).
- No partial mutation: a 429 leaves `state.usage` untouched (it is only
  overwritten on a 2xx).

### Log / store side effects

- No `console.error` on 429 — `applyUsageFailureBackoff` logs at WARN
  only for non-classified errors.
- `cct-store.json` revision increments on each failure to persist the
  new `nextUsageFetchAllowedAt`.

---

## Scenario 7 — Response-header rate-limit detection

**Goal:** A successful response carrying
`anthropic-ratelimit-unified-5h-remaining: 0` triggers rotation with
`rateLimitSource = 'response_header'`.

### Preconditions

- Active slot `A` is mid-stream on a turn (a real Anthropic API
  response is being consumed by the stream-executor).
- A second healthy slot `B` exists.

### Flow

1. `stream-executor` reads the HTTP response headers via
   `parseRateLimitHeaders(response.headers)`
   (`src/oauth/header-parser.ts`). The parser returns an array of
   `RateLimitHint`:

   ```typescript
   {
     window: '5h' | '7d',
     remaining: number,
     limit?: number,
     resetAt?: string,
   }
   ```

2. `hintsIndicateExhausted(hints)` returns true when any
   `hint.remaining === 0`. Stream-executor calls:

   ```
   tm.rotateOnRateLimit(
     '5h-remaining=0',
     {
       source: 'response_header',
       rateLimitedAt: new Date().toISOString(),
       cooldownMinutes: 60,
     }
   );
   ```

3. `TokenManager.rotateOnRateLimit` runs under `store.mutate`:
   - Locates `snap.registry.activeSlotId === A.slotId`.
   - Reads current `state.rateLimitedAt`; if the previous window is
     still open (`cooldownUntil > now`), preserves the first timestamp;
     otherwise overwrites with `now`.
   - Sets `state.rateLimitSource = 'response_header'`.
   - Sets `state.cooldownUntil = now + 60min`.
   - Rotates to the next eligible slot (`B`), sets
     `snap.registry.activeSlotId = B.slotId`.
4. `mirrorToEnv(B)` overwrites `process.env.CLAUDE_CODE_OAUTH_TOKEN`.
5. The current turn re-issues its next HTTP request using `B`'s token.
6. `/z cct` now shows `A` with a context line including
   `rate-limited 2026-04-18 13:42 KST / 03:42Z (now) via response_header`
   (rendered by `formatRateLimitedAt` in `buildSlotRow`).

### Invariants verified

- `snap.state[A.slotId].rateLimitSource === 'response_header'`.
- `snap.state[A.slotId].rateLimitedAt` is a valid ISO 8601 UTC string.
- `snap.state[A.slotId].cooldownUntil > now`.
- `snap.registry.activeSlotId === B.slotId`.
- `A` cannot be re-picked by `rotateToNext` until `cooldownUntil` has
  passed (`isEligible` returns false while `cooldownUntil > now`).

### Log / store side effects

- `rotateOnRateLimit: 5h-remaining=0 source=response_header rotated=B`.
- `cct-store.json` revision incremented once with the combined mutation
  (timestamp + source + cooldown + active switch).
