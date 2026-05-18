# CCT Redesign — Vertical Trace

> Source: https://github.com/2lab-ai/soma-work/issues/641
> This commit's PR scope: **M1-S1 ~ M1-S4** (marked Ready).
> M1-S5, M2, M3 scenarios are captured here for future PRs (marked Backlog).
>
> **Line numbers are indicative — confirm against current HEAD before editing.**

## Implementation Status

| # | Scenario | Tier | Status |
|---|----------|------|--------|
| M1-S1 | Background `UsageRefreshScheduler` (boot wiring) | small | **Ready** |
| M1-S2 | Card usage panel — 5h/7d/7d-sonnet progress bars | small | **Ready** |
| M1-S3 | Subscription tier badge on slot head | tiny | **Ready** |
| M1-S4 | Refresh usage button (card-level + per-slot) | small | **Ready** |
| M1-S5 | Usage detail modal | medium | Backlog |
| M2-S1 | Remove legacy `z_setting_cct_set_*` buttons | tiny | Backlog |
| M2-S2 | Active/Inactive slot split render | small | Backlog |
| M2-S3 | Per-slot overflow menu | small | Backlog |
| M2-S4 | authState color emoji prefix | tiny | Backlog |
| M2-S5 | Card header bar (active highlight + global actions) | small | Backlog |
| M3-S1 | Add wizard 3-way kind picker | medium | Backlog |
| M3-S2 | Attach OAuth modal ↔ Add unification | small | Backlog |
| M3-S3 | Detach OAuth confirmation modal | small | Backlog |
| M3-S4 | Rename label input + validation | small | Backlog |
| M3-S5 | api_key arm phase gate (blocked by #633) | tiny | Blocked |

## File Impact Map (PR#1 only)

| File | State | Used by |
| --- | --- | --- |
| `src/oauth/usage-scheduler.ts` | **NEW** | M1-S1 |
| `src/oauth/usage-scheduler.test.ts` | **NEW** | M1-S1 |
| `src/config.ts` | MOD | M1-S1 |
| `src/index.ts` | MOD | M1-S1 (start/stop wiring) |
| `src/slack/cct/views.ts` | MOD (append-only) | M1-S4 |
| `src/slack/cct/builder.ts` | MOD | M1-S2, M1-S3, M1-S4 |
| `src/slack/cct/builder.test.ts` | MOD | M1-S2/S3/S4 |
| `src/slack/cct/actions.ts` | MOD | M1-S4 |
| `src/slack/cct/actions.test.ts` | MOD | M1-S4 |
| `src/slack/commands/cct-handler.ts` | MOD | M1-S2 (share helper) |
| `src/token-manager.ts` | MOD | M1-S4 (`fetchAndStoreUsage(keyId, { force })`, `fetchUsageForAllAttached({ force })`) |
| `src/token-manager.test.ts` | MOD | M1-S4 |

---

## M1-S1 · Background `UsageRefreshScheduler` (size: small)

**Trigger**: `start()` at boot — `src/index.ts:88`.

**Callstack (normal flow)**:

```
src/index.ts:start()
  └─ tokenManager.init({ startReaper: true })                    [existing, :89]
  └─ runPreflightChecks()                                        [existing, :93 — may process.exit on fail]
  └─ startUsageRefreshScheduler(tokenManager, {                  [NEW, inserted AFTER preflight to avoid live interval on early exit]
        intervalMs:  config.usage.refreshIntervalMs,
        timeoutMs:   config.usage.fetchTimeoutMs,
        enabled:     config.usage.refreshEnabled,
      })
       └─ new UsageRefreshScheduler({ tm, intervalMs, timeoutMs, clock })
       └─ scheduler.start()
             └─ setInterval(tick, intervalMs)                    [Node timer]
                    └─ tick()
                         └─ tm.fetchUsageForAllAttached({ timeoutMs })   [existing token-manager.ts:1332]
                            // NOTE: scheduler MUST NOT pass force — invariant locked by test
                               └─ Promise.allSettled(
                                    attachedSlots.map(s =>
                                      tm.fetchAndStoreUsage(s.keyId)))   [existing :1213 — public, thin usageFetchInFlight wrapper]
                                    └─ usageFetchInFlight check (per-keyId dedupe at :1217-1222)
                                    └─ #doFetchAndStoreUsage(keyId)     [existing :1226 — real work]
                                          └─ nextUsageFetchAllowedAt gate (:1237-1239)
                                          └─ refresh access token if expired (:1242-1249)
                                          └─ fetchUsage(accessToken)     [src/oauth/usage.ts]
                                          └─ store.mutate(state[keyId].usage = …)
```

**Shutdown**:

```
src/index.ts cleanup() (starts ~:683)
  └─ scheduler.stop()           [NEW — inserted BEFORE tokenManager.stop() so no tick races a stopped TM]
  └─ tokenManager.stop()        [existing, :699]
```

**New module signatures** (`src/oauth/usage-scheduler.ts`):

```ts
export interface UsageSchedulerOpts {
  intervalMs: number;       // default 300_000 via config
  timeoutMs?: number;       // default 2_000, pass-through
  enabled?: boolean;        // default true
  clock?: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (h: ReturnType<typeof setInterval>) => void;
  };
}

export class UsageRefreshScheduler {
  constructor(tm: TokenManager, opts: UsageSchedulerOpts);
  start(): void;
  stop(): void;
  /** test hook — runs one tick synchronously (awaitable) */
  tickNow(): Promise<void>;
}

export function startUsageRefreshScheduler(
  tm: TokenManager,
  opts: UsageSchedulerOpts,
): UsageRefreshScheduler | null;  // null if !enabled
```

**Config additions** (`src/config.ts`):

```ts
usage: {
  refreshEnabled: process.env.USAGE_REFRESH_ENABLED !== '0',
  refreshIntervalMs: parsePositiveIntEnv('USAGE_REFRESH_INTERVAL_MS', 5 * 60_000, 30_000),
  fetchTimeoutMs: parsePositiveIntEnv('USAGE_FETCH_TIMEOUT_MS', 2_000),
}
```

**Why it works**:
- `fetchAndStoreUsage` already has ① per-keyId dedupe (`usageFetchInFlight`), ② `nextUsageFetchAllowedAt` gate inside `#doFetchAndStoreUsage`, ③ failure backoff ladder, ④ 401→refresh→retry. Scheduler only needs to **pump**.
- Both `CctSlotWithSetup` (optional `oauthAttachment`) and `CctSlotLegacyAttachmentOnly` (mandatory) are included by the existing `attachedSlots` filter.
- `api_key` slots are excluded by that filter — no-op on them.

**RED tests** (`src/oauth/usage-scheduler.test.ts`):
1. Fake-clock `setInterval` injection → first tick calls `tm.fetchUsageForAllAttached` exactly once.
2. `enabled: false` → `start()` returns null and no tick occurs.
3. After `stop()` further ticks do not call `tm.*`.
4. If tick throws, scheduler continues (next interval still fires).
5. **Invariant**: scheduler tick calls `tm.fetchUsageForAllAttached({ timeoutMs })` **without** `force: true` — spy on args. (Prevents DDoS regression.)

**Risks**:
- Interval tuning: 5-minute default is compromise between freshness and `nextUsageFetchAllowedAt=2min` cooldown. ENV-overridable.

---

## M1-S2 · Card Usage Panel (size: small)

**Trigger**: `cct` text command or `/z cct` card render.

**Callstack**:

```
cct-handler.execute() | z-topics:renderCctCard()
  └─ renderCctCard(args)                                          [cct-topic.ts:52]
       └─ buildCctCardBlocks({ slots, states, activeKeyId, … })    [builder.ts:199]
             └─ for slot of slots:
                  └─ buildSlotRow(slot, state, isActive, nowMs, userTz)  [builder.ts:89, mutated]
                       // ACTUAL SIGNATURE: (slot, state, isActive, nowMs, userTz='Asia/Seoul')
                       └─ section text: emoji + name + subscription badge
                       └─ context segments (authState, rateLimitedAt, cooldown, …) — unchanged
                       └─ **REMOVE** existing one-line `usage 5h X% 7d Y%`
                             at builder.ts:121-127 (`segments.push(`usage …`)`) — superseded below.
                       └─ usage block (only if slot is attached CCT and state.usage present):
                            new section or context block with 3 lines:
                            • formatUsageBar(state.usage.fiveHour?.utilization,        state.usage.fiveHour?.resets_at,        nowMs, '5h')
                            • formatUsageBar(state.usage.sevenDay?.utilization,        state.usage.sevenDay?.resets_at,        nowMs, '7d')
                            • formatUsageBar(state.usage.sevenDaySonnet?.utilization,  state.usage.sevenDaySonnet?.resets_at,  nowMs, '7d-sonnet')
                       └─ existing action row (Remove/Rename/Attach|Detach) — extended in M1-S4 with a `Refresh` button; no overflow yet (M2-S3 reserves)
```

**New helper** (`src/slack/cct/builder.ts`):

```ts
export function formatUsageBar(
  util: number | undefined,
  resetsAtIso: string | undefined,
  nowMs: number,
  label: '5h' | '7d' | '7d-sonnet',
): string;
// Examples:
//   formatUsageBar(0.82, '2026-04-21T08:00Z', now, '5h')
//     → '5h         ████████░░ 82% · resets in 2h 15m'
//   formatUsageBar(undefined, undefined, now, '7d')
//     → '7d         (no data)'
```

**Shared formatting** — `cct-handler.ts:renderUsageLines` is rewritten to call `formatUsageBar` so text and card never drift.

**Why it works**:
- `UsageSnapshot` already has `fiveHour`, `sevenDay`, `sevenDaySonnet` each with `{ utilization, resets_at }` (`src/cct-store/types.ts`).
- `buildSlotRow` is the single choke-point for per-slot rendering — touching only its internals keeps `buildCctCardBlocks` signature stable.

**Invariant**:
- `CCT_BLOCK_IDS` / `CCT_ACTION_IDS` unchanged.
- `buildCctCardBlocks({ slots, states, activeKeyId, … })` signature unchanged.

**RED tests** (`src/slack/cct/builder.test.ts`):
1. `formatUsageBar(0.82, iso, now, '5h')` matches `/^5h\s+█+░+\s+82% · resets in /`.
2. `formatUsageBar(undefined, undefined, now, '7d')` === `'7d         (no data)'`.
3. `buildSlotRow` snapshot includes three usage lines when `state.usage` is populated.
4. `buildSlotRow` omits usage block when `state.usage` is undefined.
5. `buildSlotRow` does **not** contain the old `'usage 5h X% 7d Y%'` single-line string.
6. Text `renderUsageLines` (`cct-handler.test.ts`) output matches the same helper.
7. **Update existing tests**: `cct-handler.test.ts` assertions of the form `• 5h: 80% (resets in …)` must be rewritten to match the new `formatUsageBar` progress-bar output. These are format changes, NOT regressions.

---

## M1-S3 · Subscription Tier Badge (size: tiny)

**Trigger**: card render (merged into M1-S2 callstack).

**Callstack**:

```
buildSlotRow(slot, …)
  └─ headLine: emoji + name + subscriptionBadge(slot)            [NEW]
       └─ if !isCctSlot(slot): return ''
       └─ const att = slot.source === 'setup'
                        ? slot.oauthAttachment
                        : slot.oauthAttachment;
       └─ if !att?.subscriptionType: return ''
       └─ return ` · ${formatSubType(att.subscriptionType)}`
```

**Helper** (`src/slack/cct/builder.ts`):

```ts
function subscriptionBadge(slot: AuthKey): string;

function formatSubType(raw: string | undefined): string;
//   'max_5x'  → 'Max 5x'
//   'max_20x' → 'Max 20x'
//   'pro'     → 'Pro'
//   undefined → ''
//   other     → raw (defensive passthrough)
```

**Data path**: `OAuthAttachment.subscriptionType` (`src/auth/auth-key.ts`) already populated at attach time; read-only here.

**RED tests**:
1. `subscriptionBadge({ kind:'cct', source:'setup', oauthAttachment:{ subscriptionType:'max_5x', … } })` === `' · Max 5x'`.
2. `subscriptionBadge(apiKeySlot)` === `''`.
3. `formatSubType('pro')` === `'Pro'`.

---

## M1-S4 · Refresh Usage Buttons (size: small)

**New action IDs** (`src/slack/cct/views.ts`, append-only):

```ts
CCT_ACTION_IDS.refresh_usage_all  = 'cct_refresh_usage_all';
CCT_ACTION_IDS.refresh_usage_slot = 'cct_refresh_usage_slot';
```

**Callstack — card-level `🔄 Refresh all`**:

```
Slack button
  └─ app.action(CCT_ACTION_IDS.refresh_usage_all, handler)        [actions.ts NEW]
       └─ ack()
       └─ requireAdmin(body)
       └─ tokenManager.fetchUsageForAllAttached({
            timeoutMs: 3000,
            force: true,                                           [NEW option]
          })
             └─ for each attached slot in parallel:
                  tm.fetchAndStoreUsage(keyId, { force: true })
                       └─ if !force && nextUsageFetchAllowedAt > now: return null  [gate]
                       └─ if force: bypass gate; 429 still → backoff via existing catch
       └─ postEphemeralCard(tm, client, body)                     [existing, actions.ts:~560]
```

**Callstack — per-slot overflow or inline button `Refresh`**:

```
Slack button (per-slot)
  └─ app.action(CCT_ACTION_IDS.refresh_usage_slot, handler)        [actions.ts NEW]
       └─ ack()
       └─ requireAdmin(body)
       └─ const keyId = body.actions[0].value   // slot.keyId
       └─ tokenManager.fetchAndStoreUsage(keyId, { force: true })
       └─ postEphemeralCard
```

**TM signature changes** (`src/token-manager.ts`):

Widen **both** the public wrapper and the private worker. The public method is a thin `usageFetchInFlight` dedupe wrapper (`:1213-1224`); the gate lives inside the private method at `:1237-1239`. Modifying only the public one is a no-op.

```ts
// Public (:1213) — widen signature, forward opts through dedupe wrapper
async fetchAndStoreUsage(
  keyId: string,
  opts: { force?: boolean } = {},
): Promise<UsageSnapshot | null> {
  // dedupe key must NOT include force — same keyId coalesces regardless of force,
  // because two concurrent fetches for the same keyId is wasteful either way.
  const existing = this.usageFetchInFlight.get(keyId);
  if (existing) return existing;
  const promise = this.#doFetchAndStoreUsage(keyId, opts).finally(() => {
    this.usageFetchInFlight.delete(keyId);
  });
  this.usageFetchInFlight.set(keyId, promise);
  return promise;
}

// Private (:1226) — widen signature, bypass gate when force
async #doFetchAndStoreUsage(
  keyId: string,
  opts: { force?: boolean } = {},
): Promise<UsageSnapshot | null> {
  const snap = await this.store.load();
  const slot = snap.registry.slots.find((s) => s.keyId === keyId);
  if (!slot || !hasOAuthAttachment(slot)) return null;
  const preAttachedAt = slot.oauthAttachment.attachedAt;
  const state = snap.state[keyId];
  const nowMs = Date.now();
  // MODIFIED: gate honored only when NOT force
  if (!opts.force && state?.nextUsageFetchAllowedAt) {
    const allowedMs = new Date(state.nextUsageFetchAllowedAt).getTime();
    if (Number.isFinite(allowedMs) && allowedMs > nowMs) return null;
  }
  // …rest unchanged
}

// Fan-out (:1332) — widen to forward force
async fetchUsageForAllAttached(
  opts?: { timeoutMs?: number; force?: boolean },
): Promise<Record<string, UsageSnapshot | null>> {
  // for each attached slot:
  //   results[keyId] = await this.fetchAndStoreUsage(keyId, { force: opts?.force })
  // timeoutMs handling unchanged.
}
```

**Why it works**:
- `force` bypasses **local throttle only**. Server-side 429 still flows through the existing `UsageFetchError` → `consecutiveUsageFailures++` → `nextUsageFetchAllowedAt = now + nextUsageBackoffMs(failures)` path.
- Existing `usageFetchInFlight` dedupe absorbs admin button-mashing (the OAuth-refresh dedupe `refreshInFlight` is a **different** map — don't confuse the two).
- Existing callers of `fetchAndStoreUsage(keyId)` stay valid because `opts` is optional with default `{}`.

**UI placement (minimal, M2 reserves the deeper redesign)**:
- `buildCctCardBlocks` action row: append a `🔄 Refresh all` button next to existing actions.
- `buildSlotRow` actions: append a small `Refresh` button (or include in existing overflow if present).
- **No change to existing action/block IDs.**

**RED tests**:
1. `src/slack/cct/actions.test.ts`: `refresh_usage_all` handler calls `tm.fetchUsageForAllAttached({ force: true, timeoutMs: … })` exactly once and then postEphemeralCard.
2. `src/slack/cct/actions.test.ts`: `refresh_usage_slot` handler calls `tm.fetchAndStoreUsage('cct1', { force: true })` exactly once.
3. `src/token-manager.test.ts`: `fetchAndStoreUsage(keyId, { force: true })` progresses past the gate even when `nextUsageFetchAllowedAt` is in the future.
4. `src/token-manager.test.ts`: `fetchUsageForAllAttached({ force: true })` forwards `force` to each `fetchAndStoreUsage`.
5. `src/token-manager.test.ts`: Existing callers `fetchAndStoreUsage(keyId)` (no opts) still respect the gate — regression guard.
6. `src/token-manager.test.ts`: `fetchAndStoreUsage(keyId, { force: true })` with server 429 still bumps `consecutiveUsageFailures` and sets `nextUsageFetchAllowedAt = now + nextUsageBackoffMs(…)`.
7. `src/token-manager.test.ts`: generation guard — if OAuth attachment is swapped between dedupe entry and persist, the write is dropped (existing `preAttachedAt` check must still hold with `force`).
8. `src/slack/cct/actions.test.ts`: Non-admin invocation → ack() only, no TM call (existing pattern).
9. `src/slack/cct/actions.test.ts`: card action row still contains existing Next/Add buttons plus the new `Refresh all` — length assertion.

**Risks**:
- Admin connection flapping → card refresh button storm. Mitigation: `usageFetchInFlight` dedupe already in place.

---

## Test Plan (PR#1 exit gate)

- `bun test src/oauth/usage-scheduler.test.ts` — 4 new tests all pass.
- `bun test src/slack/cct/builder.test.ts` — existing + 5 new tests pass.
- `bun test src/slack/cct/actions.test.ts` — existing + 3 new tests pass.
- `bun test src/token-manager.test.ts` — existing + 3 new tests pass.
- `bun test src/slack/commands/cct-handler.test.ts` — existing (renderUsageLines) still pass via shared helper.
- `bun lint && bun typecheck` — clean.
- Manual: boot dev bot → 5 minutes later check logs for one successful `fetchUsageForAllAttached` pass. `cct` card shows 3-line usage + subscription tier + refresh button.
