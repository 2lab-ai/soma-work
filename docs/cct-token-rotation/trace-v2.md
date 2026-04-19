# CCT Token Rotation — Trace v2 (AuthKey + schema v2)

> Status: **authoritative** for the AuthKey refactor (#575). Supersedes
> `trace.md`, which is retained for history as a snapshot of the
> pre-v2 store shape.
>
> This document traces the code path end-to-end after PR-A
> (AuthKey v2 foundation + schema v2 + docs). Implementation details
> that land in PR-B (spawn isolation, atomic `accessToken → secret`
> rename, 11 audit blocker fixes, api_key e2e, forbidden-pattern CI
> gate) are called out as *future work within #575* rather than
> silently conflated with the current state.

## 1. Glossary (schema v2 vocabulary)

| Term | Meaning |
|------|---------|
| `AuthKey` | 2-arm discriminated union persisted in the store. Either `ApiKeySlot` (a standalone long-lived API key) or `CctSlot` (a Claude Code Token, optionally bundled with an OAuth attachment). |
| `ApiKeySlot` | `{ kind: 'api_key', keyId, name, value, createdAt }` — opaque `sk-ant-api03-…` key, no OAuth semantics, no refresh, no usage endpoint. |
| `CctSlot` | `{ kind: 'cct', source, keyId, name, createdAt, oauthAttachment? }` — a seat-provisioned setup token or a legacy OAuth bundle, optionally decorated with an `OAuthAttachment`. |
| `CctSlotWithSetup` | `CctSlot` whose `source = 'setup'` — carries `setupToken` (the raw `sk-ant-oat01-…` acquired from a Max seat). |
| `CctSlotLegacyAttachmentOnly` | `CctSlot` whose `source = 'legacy-attachment'` — carries only `oauthAttachment` (migrated from v1 `oauth_credentials` slots). |
| `OAuthAttachment` | `{ accessToken, refreshToken, expiresAtMs, scopes, rateLimitTier?, subscriptionType?, acknowledgedConsumerTosRisk: true }` — refreshable credential bundle attached to a `CctSlot`. |
| `keyId` | Immutable per-slot identifier (ULID). v1 `slotId` renamed 1:1 to `keyId`. All state maps, lease owner tags, and usage cache keys are keyed by `keyId`. |
| `activeKeyId` | `registry.activeKeyId` — the `keyId` of the currently selected slot, or `undefined` if the pool is empty. v1 `activeSlotId` renamed. |
| `SlotAuthLease` | Unit of auth checkout returned by `ensureActiveSlotAuth(...)` — `{ keyId, kind: 'api_key' \| 'cct', accessToken, release(), heartbeat() }`. |

## 2. Persisted schema v2

```jsonc
{
  "version": 2,
  "revision": 17,
  "registry": {
    "activeKeyId": "01JC…",            // optional
    "slots": [
      { "kind": "api_key",  "keyId": "…", "name": "…", "value": "sk-ant-api03-…", "createdAt": "…" },
      { "kind": "cct", "source": "setup", "keyId": "…", "name": "…",
        "setupToken": "sk-ant-oat01-…", "createdAt": "…" },
      { "kind": "cct", "source": "legacy-attachment", "keyId": "…", "name": "…",
        "createdAt": "…",
        "oauthAttachment": {
          "accessToken": "…", "refreshToken": "…",
          "expiresAtMs": 1745000000000,
          "scopes": ["user:profile", "user:inference"],
          "rateLimitTier": "tier-1",
          "subscriptionType": "pro",
          "acknowledgedConsumerTosRisk": true
        } }
    ]
  },
  "state": {
    "<keyId>": {
      "authState": "healthy",              // healthy | rate-limited | quarantined | evicted
      "activeLeases": [ /* … */ ],
      "rateLimitedAt":   "2026-04-18T03:42:00Z",
      "rateLimitSource": "response_header",
      "nextUsageFetchAllowedAt": "…",
      "usageSnapshot":   { /* … */ }
    }
  }
}
```

### 2.1 Migration v1 → v2

The migrator (`src/cct-store/migrate-v2.ts`) is a pure function that
transforms a v1 snapshot into a v2 snapshot in-memory:

1. `registry.activeSlotId` → `registry.activeKeyId`.
2. For each `TokenSlot`:
   - `{ kind: 'setup_token', slotId, name, value, createdAt }`
     → `{ kind: 'cct', source: 'setup', keyId: slotId, name, setupToken: value, createdAt }`.
   - `{ kind: 'oauth_credentials', slotId, name, credentials, createdAt, acknowledgedConsumerTosRisk }`
     → `{ kind: 'cct', source: 'legacy-attachment', keyId: slotId, name, createdAt,
          oauthAttachment: { ...credentials, acknowledgedConsumerTosRisk: true } }`.
3. `state` keys (`slotId → SlotState`) are preserved 1:1 — the renamed
   `keyId` and the old v1 `slotId` are identical by construction.
4. `version` is bumped to `2`; `revision` is preserved so CAS chains
   survive the migration.

The migrator is idempotent: applying it to an already-v2 snapshot is a
no-op.

### 2.2 Write path (CAS)

`CctStore.persist(next, prevRevision)` rejects with a typed
`ConcurrentModificationError` when the on-disk revision advanced past
`prevRevision`. The store's internal `write()` bumps `revision` on
success, fsyncs the temp file + parent directory, and renames to the
canonical path (`~/.claude/cct-store.json` by default). A single
`cct-store.lock` serialises writes cross-process.

## 3. Reference path: `claude-code-sdk` query dispatch

The request-processing path that every Slack message eventually reaches
looks like this, from `ensureActiveSlotAuth` at the top down to the
spawned `claude` CLI child process:

```
user message ──► command handler ──► pipeline/stream-executor.ts
                                       │
                                       ▼
                             ensureActiveSlotAuth(tm, 'stream-executor:…')
                                       │
                                       ▼
                             tokenManager.acquireLease(…)
                                       │     │
                                       │     ├── picks healthy slot (round-robin / active)
                                       │     └── returns { leaseId, ownerTag, acquiredAt, expiresAt }
                                       ▼
                             tokenManager.getValidAccessToken(keyId)
                                       │
                                       ├── cct-without-attachment → setupToken as-is
                                       └── cct-with-attachment    → refresh if < 7h to expiry, else cached accessToken
                                       │
                                       ▼
                             SlotAuthLease { keyId, kind, accessToken, release, heartbeat }
                                       │
                                       ▼
                             buildQueryEnv(lease)   # src/auth/query-env-builder.ts
                                       │     returns { env: {...process.env, CLAUDE_CODE_OAUTH_TOKEN: lease.accessToken} }
                                       │     MUST NOT mutate process.env
                                       ▼
                             claude-code-sdk `query({ env })`
                                       │
                                       ▼
                             spawned `claude` CLI reads CLAUDE_CODE_OAUTH_TOKEN from its own env
                                       │
                                       ▼
                             lease.release()  # idempotent — always called in finally
```

Key invariants:

- `buildQueryEnv` is the **only** writer of the per-query env. It never
  touches `process.env`. That's the foundation for PR-B's per-slot
  `CLAUDE_CONFIG_DIR` isolation: each query gets an independent env
  snapshot.
- `lease.release()` is idempotent and always runs in `finally` —
  dropping a lease on the floor leaks an entry in `SlotState.activeLeases`
  until the next bootstrap sweep.
- `lease.heartbeat()` is optional. Long-running pipelines call it to
  extend lease TTL (default 60 s).

## 4. Bootstrap (cold start)

1. `TokenManager.bootstrap()` loads the raw JSON, detects `version`.
   - If `version === 1`, `migrateV1ToV2(raw)` is applied in-memory. The
     migrated snapshot is **not** written back until the next mutation
     (add / rename / remove / refresh) triggers a CAS write — that way
     a failed bootstrap can't corrupt a healthy v1 disk.
2. `TokenManager` seeds `state[keyId]` for any new `keyId` that isn't
   already present in the state map.
3. `SlotState.activeLeases` is swept: any lease whose `expiresAt` is in
   the past is dropped (stale-lease reaper).
4. If `activeKeyId` is unset but `slots.length > 0`, the manager picks
   the first healthy slot as the new active and persists it.
5. Environment-variable seeding (`CLAUDE_CODE_OAUTH_TOKEN_LIST`) is
   dispatched through the same `addSlot(...)` path as Slack-driven
   inserts — the legacy `AddSetupTokenInput` / `AddOAuthCredentialsInput`
   DTOs are mapped internally to the v2 AuthKey shape.

## 5. Lease lifecycle

```
acquireLease(ownerTag, ttlMs?)
   │
   ├── pick active slot (or round-robin next healthy)
   ├── mint leaseId = ulid()
   ├── append { leaseId, ownerTag, acquiredAt, expiresAt } to state[keyId].activeLeases
   ├── CAS-persist
   └── return { leaseId, ownerTag, acquiredAt, expiresAt }

heartbeatLease(leaseId)
   │
   ├── find lease in state map
   ├── expiresAt = now + ttl
   └── CAS-persist

releaseLease(leaseId)
   │
   ├── remove lease from state[keyId].activeLeases
   └── CAS-persist (best-effort; a dangling lease just expires on TTL)
```

The `SlotAuthLease` adaptor (`credentials-manager.ts`) wraps these three
primitives, guarantees `release()` is idempotent, and re-throws a typed
`NoHealthySlotError` when the pool is empty or all slots are quarantined.

## 6. OAuth refresh

`refreshClaudeCredentials(current)` in `src/oauth/refresher.ts` is the
sole refresh entry point:

- POSTs `CLAUDE_OAUTH_REFRESH_URL` with
  `{ grant_type: 'refresh_token', refresh_token, client_id }`.
- Returns the new `OAuthCredentials` (refresh-HTTP DTO in
  `oauth/refresher.ts` — **not** the persisted `OAuthAttachment` shape).
- On success, `TokenManager.applyRefreshedCredentials(keyId, credentials)`
  writes the returned bundle into `slot.oauthAttachment`, re-attaching
  the `acknowledgedConsumerTosRisk: true` literal so the invariant
  holds after round-trip.
- Non-200 status throws `OAuthRefreshError(status, body)` — the caller
  quarantines the slot and rotates.

The refresher is agnostic of the store; any caller holding an
`OAuthCredentials` snapshot can invoke it. The HTTP contract itself is
documented in `docs/cct-token-rotation/extraction/agent-island-oauth-extraction.md`.

## 7. Rate-limit handling

A slot enters `rateLimitedAt` when:

1. The `claude` CLI child emits a 429 with a parseable
   `anthropic-ratelimit-reset` header (`rateLimitSource: 'response_header'`),
   **or**
2. A tool-output line matches the error-string regex
   (`rateLimitSource: 'output_match'`).

The manager:

- Marks `state[keyId].authState = 'rate-limited'`.
- Picks the next healthy slot and persists a new `activeKeyId`.
- Queues a usage fetch for when the window resets (via the backoff
  ladder — 2, 5, 10, 15 min).

The Slack card pulls `formatRateLimitedAt(state.rateLimitedAt)` to
render `YYYY-MM-DD HH:mm KST / HH:mmZ (Nm ago)` plus the
`rateLimitSource` so operators can distinguish a genuine 429 from a
heuristic match.

## 8. What stays the same vs. trace-v1

- Command grammar (`/z cct`, `cct set <name>`, `cct next`, `cct usage`).
- The Block Kit card layout.
- The lockfile + CAS + fsync chain (only the payload shape changed).
- The env-vars contract to the spawned `claude` CLI —
  `CLAUDE_CODE_OAUTH_TOKEN` is still the one and only variable the CLI
  reads for credentials.

## 9. What is different vs. trace-v1

- `slotId` is now `keyId`; `activeSlotId` is now `activeKeyId`. The
  old names survive only in `LegacyV1*` types that the migrator reads.
- The v1 tagged union `setup_token | oauth_credentials` is replaced by
  the 2-arm AuthKey (`api_key | cct`) with an optional `oauthAttachment`
  on `cct` slots.
- `ApiKeySlot` is a new first-class slot kind — previously, API keys
  lived outside the slot pool entirely. PR-A does not wire the
  acquisition path; it only makes the shape representable.
- `OAuthCredentials` (the HTTP DTO) now lives in `oauth/refresher.ts`;
  `OAuthAttachment` (the persisted shape) lives in `auth/auth-key.ts`.
  They are **not** the same type: the attachment adds the literal
  `acknowledgedConsumerTosRisk: true` and drops the transient fields.
- `SlotAuthLease` is the new public lease shape. Legacy callers still
  reach it via `ensureValidCredentials()` for back-compat.

## 10. Future work (PR-B, within #575)

- **PR-B** — per-slot `CLAUDE_CONFIG_DIR` isolation via the new
  `runClaudeQuery` async-generator wrapper (`src/spawn/claude-spawn.ts`).
  Each query call receives its own `mkdtemp` directory with
  `.credentials.json` written atomically, avoiding any `process.env`
  mutation. PR-B also atomically renames `SlotAuthLease.accessToken`
  to a discriminant-appropriate name, wires the `api_key` kind through
  add/list/use/spawn, fixes the 11 audit blockers (A1–C6) each with a
  regression test, deletes `mirrorToEnv`, and installs a
  `grep`-zero CI gate proving no `process.env.CLAUDE_CODE_OAUTH_TOKEN =`
  or `process.env.ANTHROPIC_API_KEY =` writes remain in runtime code.

Further factoring of `src/oauth/**` into a separately packaged island
is out of scope for #575 and tracked elsewhere.
