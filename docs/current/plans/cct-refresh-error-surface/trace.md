# Trace — CCT Refresh Error Surface

## Implementation Status

| # | Scenario | Tier | Status |
|---|----------|------|--------|
| 1 | SlotState diagnostic fields + detach/attach cleanup | small | Ready |
| 2 | classifyRefreshError helper with fixed safe-template table | small | Ready |
| 3 | refreshAccessToken — capture every failure under generation guard, clear on success | small | Ready |
| 4 | Builder — render refresh-error segment inside line2 (no new block) | small | Ready |
| 5 | refresh_usage_all — single ephemeral surface with banner block + card blocks; count deadline-omitted slots as timeout | small | Ready |
| 6 | Usage panel `fetchedAt` suffix + in-panel stale warning (same block) | small | Ready |
| 7 | Drop utilization dual-form — `utilToPctInt` / `isUtilizationFull` / `normalizeUtilizationToPercent` all become percent-only | small | Ready |
| 8 | Contract + snapshot tests | small | Ready |

Sum: ~8 scenarios, all small. One PR, ~150-200 LOC production + ~300 LOC tests. Matches Case A (issue 1 + PR 1).

## Scenario 1 — SlotState diagnostic fields + detach/attach cleanup

### Call stack (file:symbol)

- `src/cct-store/types.ts` → `SlotState` adds `lastRefreshAt?`, `lastRefreshFailedAt?`, `lastRefreshError?`, `consecutiveRefreshFailures?`.
- `src/token-manager.ts` → `#detachOAuthOnSetupSlot(snap, slot)` `delete`s all four on detach.
- `src/token-manager.ts` → `attachOAuth(keyId, creds, ack)` `delete`s all four on attach (belt-and-suspenders for an in-flight failure that wins the generation race just before re-attach).

### Contract

- `SlotState` round-trips with the new optional fields present.
- `SlotState` **without** the fields loads (backward compat).
- Detach leaves none of the four fields.
- Attach leaves none of the four fields even if present in the prior state.

### RED test

- `src/cct-store/__tests__/types-refresh-error-fields.test.ts` — round-trip identity.
- `src/token-manager.detach-oauth.test.ts` — seed fields + call `detachOAuth` + expect gone.
- `src/token-manager.attach-oauth-clears-diagnostics.test.ts` (new) — pre-seed `state[keyId]` with `lastRefreshError` then call `attachOAuth`, expect cleared.

## Scenario 2 — classifyRefreshError with fixed safe templates

### Call stack

- `src/token-manager.ts` → new `#classifyRefreshError(err)` (pure; private method since it only calls `err instanceof OAuthRefreshError`).

### Contract (table-driven — every stored/rendered message is a fixed ASCII string, never interpolates `err.message` or `OAuthRefreshError.body`)

| err | kind | status | message |
|---|---|---|---|
| `OAuthRefreshError` status 401 | `unauthorized` | 401 | `"Refresh rejected (401 invalid_grant)"` |
| status 403 | `revoked` | 403 | `"Refresh revoked (403)"` |
| status 429 | `rate_limited` | 429 | `"Refresh throttled (429)"` |
| status ∈ [500, 599] | `server` | `status` | `` `Refresh server error (${status})` `` |
| other `OAuthRefreshError` with numeric status | `unknown` | `status` | `` `Refresh failed (${status})` `` |
| `OAuthRefreshError` where `body === ''` AND message startsWith `"OAuth refresh response was not valid JSON"` or `"OAuth refresh response missing"` | `parse` | undefined | `"Refresh response malformed"` |
| `err.name === 'AbortError'` | `timeout` | undefined | `"Refresh timed out after 30s"` |
| `TypeError` + fetch network pattern, or code ∈ `{ECONNRESET, ENOTFOUND, EAI_AGAIN, ECONNREFUSED}` | `network` | undefined | `"Refresh network error"` |
| anything else | `unknown` | undefined | `"Refresh failed (unknown)"` |

### RED test

- `src/token-manager.classify-refresh-error.test.ts` — one row per bucket. Assert each branch produces only its template string; assert secret patterns (access token prefix, refresh token prefix) never appear even if an adversarial `err.message` contains them.

## Scenario 3 — refreshAccessToken: capture every failure, clear on success, generation-safe

### Call stack

- `src/token-manager.ts` → `refreshAccessToken(slot)` (L1440-1545).
- New private `markRefreshFailure(keyId, attachedAt, info)` (CAS-mutating, generation-guarded).
- Captured `preAttachedAt` (already present at L1447) threads into the catch.

### Contract

- Error path, generation matches at mutate time:
  - 401 → `authState === 'refresh_failed'`, `lastRefreshError.kind === 'unauthorized'`, counter +1.
  - 403 → `authState === 'revoked'`, `lastRefreshError.kind === 'revoked'`, counter +1.
  - 429 → `authState` stays `'healthy'`, `lastRefreshError.kind === 'rate_limited'`.
  - 500/502/503/504 → `authState` stays `'healthy'`, `lastRefreshError.kind === 'server'`.
  - network/timeout/parse → same pattern, respective `kind`.
- Error path, generation mismatch (slot removed / detached / re-attached): `markRefreshFailure` no-ops silently. No log noise, no orphan `state[keyId]`.
- Success path (inside existing generation-guarded mutate at L1482-1524): `authState = 'healthy'`, `lastRefreshAt = now`, `delete lastRefreshFailedAt`, `delete lastRefreshError`, `consecutiveRefreshFailures = 0`.
- Consecutive failures accumulate: `consecutiveRefreshFailures` increments each time; reset to 0 only on success.
- **No token material** in any persisted field — verified by adversarial tests that inject `sk-ant-...` substrings into raw error messages and assert absence in the stored message.

### RED test

- `src/token-manager.refresh-access-token.test.ts`:
  - `beforeEach` stubs `global.fetch`.
  - One test per failure `kind`.
  - Success-after-failure: inject 429 three times, then 200, assert counter=0 + clean fields.
  - Generation-mismatch: start refresh, call `detachOAuth` mid-flight, let refresh fail → assert `state[keyId]` is unchanged (no orphan revive).
  - Generation-mismatch after re-attach: start refresh on gen A, detach, attach gen B, let gen-A refresh fail → assert gen-B state is pristine.
  - Secret-redaction: craft `err.message = 'garbage sk-ant-oat01-ABCDEFGH garbage'`, assert stored `message` is the fixed template only.

## Scenario 4 — Builder refresh-error segment inside line2 (no new block)

### Call stack

- `src/slack/cct/builder.ts` → `buildSlotStatusLine(slot, state, isActive, nowMs, userTz)`.
- New module-local helper `formatRefreshErrorSegment(state, nowMs): string | null`.

### Contract

- `state?.lastRefreshError === undefined` → return `null`, no change.
- kind `'unauthorized' | 'revoked' | 'unknown'` → `:warning: Refresh failed: <message> (<ago>)`.
- kind `'rate_limited'` → `:hourglass: <message> (<ago>)`.
- kind `'network' | 'timeout'` → `:satellite_antenna: <message> (<ago>)`.
- kind `'server'` / `'parse'` → `:warning: <message> (<ago>)`.
- `consecutiveRefreshFailures >= 2` → append ` · ×N`.
- `<ago>` uses `formatUsageResetDelta(now - lastRefreshFailedAt)`.
- Segment is appended for both `healthy`-but-failing and `refresh_failed`/`revoked` authStates.
- **No new block.** The segment concatenates into `line2` of the existing section block (L542-546). Block count per attached slot stays at ≤ 4, same as today's budget.

### Edge cases

- `authState === 'healthy'` + `lastRefreshError` → green badge + `OAuth refreshes in ...` + failure segment. Access token from last success is still valid until expiry; the hint stays.
- `authState === 'refresh_failed' | 'revoked'` → `:black_circle: Unavailable` + failure segment (today's code suppresses the refresh hint for non-healthy — kept).

### RED test

- `src/slack/cct/__tests__/builder-refresh-error.test.ts`:
  - One test per `kind` — assert emoji + message + `(Nm ago)` suffix.
  - Streak test: `consecutiveRefreshFailures = 3` → ` · ×3`.
  - Healthy + lastRefreshError: green badge AND failure segment AND refresh hint all present.
  - `refresh_failed` + lastRefreshError: `:black_circle: Unavailable` AND failure segment; refresh hint absent.
  - Block count: render a slot with the segment, count total blocks = 3 (section + actions + usage panel) or 4 (divider) — same as today.

## Scenario 5 — refresh_usage_all: single ephemeral surface, accurate accounting

### Call stack

- `src/slack/cct/actions.ts` → `app.action(CCT_ACTION_IDS.refresh_usage_all, ...)`.
- New `REFRESH_BANNERS.partialFailure(failures)` builder.
- New or extended `postEphemeralCardWithBanner(client, body, bannerBlock)` — single `chat.postEphemeral` call whose blocks = `[bannerBlock, ...cardBlocks]`.

### Contract

1. Capture `startingKeyIds` before calling `refreshAllAttachedOAuthTokens`.
2. Classify every starting keyId against returned `results` **and** reloaded `snap2`:
   - `results[keyId] === 'ok'` → ok.
   - `results[keyId] === 'error'` → failure; reason = `snap2.state[keyId].lastRefreshError?.kind ?? 'unknown'`.
   - keyId **missing from `results`**:
     - `snap2` slot still attached (CCT + `oauthAttachment`) → failure with `kind: 'timeout'` (fan-out deadline before settle).
     - `snap2` slot removed or detached → omit from failure accounting (concurrent teardown; not a user-facing failure).
3. All-ok → `postEphemeralCard` (unchanged).
4. All-failed → existing `REFRESH_BANNERS.allNull` ephemeral (single message, unchanged).
5. Mixed → `postEphemeralCardWithBanner(...)` — one ephemeral message, blocks = `[partialFailureBannerSection, ...cardBlocks]`. No two-post ordering race.
6. `partialFailure` banner uses `kind`/`status` codes ONLY (e.g., `ai2 (429), ai3 (network), notify (timeout)`). Names truncated to 5 with ` … (+N more)`.

### RED test

- Extend `src/slack/cct/__tests__/actions-refresh-usage-all.test.ts`:
  - Scenario A: all ok → postEphemeralCard.
  - Scenario B: all error → `allNull` banner.
  - Scenario C: 2 ok, 2 error → single `postEphemeralCardWithBanner`, banner names the 2 failed slots with reason codes.
  - Scenario D: 3 attached, `results` has only 2 (one timed out) → banner counts the missing one as `timeout`; 2 failed total (one explicit error + one inferred timeout).
  - Scenario E: adversarial — `lastRefreshError.message` contains a fake secret → banner does NOT render the message; only the kind code.

## Scenario 6 — Usage panel fetchedAt suffix + in-panel stale warning

### Call stack

- `src/slack/cct/builder.ts` → `buildUsagePanelBlock(usage, nowMs, keyId, state)`.
  - New `state` parameter so the block can see `state.lastRefreshError` without re-traversing.

### Contract

- Panel trailing suffix on the **final row** (5h/7d/7d-sonnet — whichever is last): `fetched <ago>` where `<ago>` uses `formatUsageResetDelta(now - Date.parse(usage.fetchedAt))`.
- If `now - Date.parse(usage.fetchedAt) > 10 * 60_000` → prepend `:warning:` to the suffix.
- If `state.lastRefreshError && state.usage` → prepend an **in-panel** warning line inside the same context block's mrkdwn text. The block's text becomes `⚠️ _Usage is stale — last refresh failed <ago>._\n\`\`\`\n<usage rows>\n\`\`\`` — no new block.
- If `state.lastRefreshError && !state.usage` → nothing; scenario 4 is sufficient.
- Block count per slot stays at **1** for the panel (no separate stale context block).
- `usage.fetchedAt` is already ISO UTC (`src/cct-store/types.ts:45`); parse with `Date.parse`, guard `Number.isFinite(...)`.

### RED test

- `src/slack/cct/__tests__/builder-usage-panel-staleness.test.ts`:
  - A: `fetchedAt = now - 2 * 60_000` → suffix `fetched 2m ago`, no `:warning:`.
  - B: `fetchedAt = now - 2 * 86_400_000` → `:warning: fetched 2d ago`.
  - C: B + `lastRefreshError` → same suffix + stale warning inside the same block.
  - D: usage absent + lastRefreshError → no usage panel at all.
  - Block-count invariant: count blocks emitted per attached slot is ≤ 4 in all above cases.

## Scenario 7 — Drop utilization dual-form

### Call stack

- `src/slack/cct/builder.ts:93-98` → `utilToPctInt(util)`.
- `src/slack/cct/builder.ts:336-340` → `isUtilizationFull(util)`.
- `src/slack/pipeline/stream-executor.ts:180-185` → `normalizeUtilizationToPercent(raw)`.

### Contract — percent-only, no boundary branch

```ts
// builder.ts
function utilToPctInt(util: number | undefined): number {
  if (util === undefined || !Number.isFinite(util)) return 0;
  return Math.max(0, Math.min(100, Math.round(util)));
}
function isUtilizationFull(util: number | undefined): boolean {
  if (util === undefined || !Number.isFinite(util)) return false;
  return util >= 100;
}

// stream-executor.ts
function normalizeUtilizationToPercent(raw: number | undefined): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;
}
```

| Input | Before (utilToPctInt) | After | Before (normalize) | After |
|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 0 |
| 1 | **100** ❌ | **1** | **100** ❌ | **1** |
| 1.5 | 2 | 2 | **100** | 1.5 |
| 2 | 2 | 2 | 2 | 2 |
| 50 | 50 | 50 | 50 | 50 |
| 99 | 99 | 99 | 99 | 99 |
| 99.99 | 100 | 100 | 100 | 100 |
| 100 | 100 | 100 | 100 | 100 |
| 105 | 100 (clamp) | 100 | 100 | 100 |
| -5 | 0 (clamp) | 0 | 0 | 0 |

### RED test

- Extend `src/slack/cct/builder.test.ts`:
  - `utilToPctInt` boundary table (all values above).
  - `isUtilizationFull` boundary: 1 → false, 99 → false, 99.99 → false, 100 → true, 150 → true.
  - Cross-function invariant: `isUtilizationFull(v) === (utilToPctInt(v) === 100)` for all integer values 0..150.
  - `formatUsageBar(1, future_iso, now, '7d')` includes `" 1% "` (not `" 100% "`).
- Migrate existing `formatUsageBar(0.82, ...)` tests to `formatUsageBar(82, ...)` — production never sent fraction form.
- New `src/slack/pipeline/stream-executor-utilization.test.ts`: percent-only mapping, same table.

## Scenario 8 — Contract + snapshot tests (rollup)

1. `types-refresh-error-fields.test.ts` — round-trip.
2. `token-manager.detach-oauth.test.ts` — detach clears the four new fields + existing usage fields.
3. `token-manager.attach-oauth-clears-diagnostics.test.ts` — attach clears pre-seeded diagnostics.
4. `token-manager.classify-refresh-error.test.ts` — table-driven, secret redaction test.
5. `token-manager.refresh-access-token.test.ts` — per-kind persistence + clear-on-success + consecutive counter + generation-mismatch drops + secret redaction.
6. `slack/cct/__tests__/builder-refresh-error.test.ts` — UI segment per kind + `×N` + block-count invariant.
7. `slack/cct/__tests__/builder-usage-panel-staleness.test.ts` — `fetched <ago>` suffix, `:warning:` threshold, in-panel stale warning, block-count invariant.
8. `slack/cct/__tests__/actions-refresh-usage-all.test.ts` — single-surface mixed banner + timeout-inference + secret-redaction.
9. Extend `slack/cct/builder.test.ts` — `utilToPctInt` / `isUtilizationFull` boundary tables + cross-function invariant, migrate legacy fraction-form fixtures to percent-form.
10. `slack/pipeline/stream-executor-utilization.test.ts` — percent-only mapping.

All run under `bun test`.

## Open points

- CLI/metrics surface for `lastRefreshError` → explicit follow-up, out of scope.
- Mirror `lastUsageError` diagnostic → explicit follow-up, out of scope.
- 50-block-cap stress: add a new test file `src/slack/cct/__tests__/builder-card-block-budget.test.ts` asserting `N = 15 attached slots, all with refresh-error segment + stale-usage warning → total blocks ≤ 50`. The stale warning is in-panel (same block) and the error segment lives inside `line2` (same block), so the existing budget comment at `builder.ts:510-514` still holds.
