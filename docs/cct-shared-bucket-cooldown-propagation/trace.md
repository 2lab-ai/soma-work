# CCT Shared-Bucket Cooldown Propagation — Vertical Trace

> STV Trace | Created: 2026-04-30
> Spec: docs/cct-shared-bucket-cooldown-propagation/spec.md

This feature has no HTTP surface. The "API Entry" rows describe the runtime function entry that callers reach; the rest of the 7-section format applies as written.

## Table of Contents
1. [Scenario 1 — First 429: only active slot marked](#scenario-1)
2. [Scenario 2 — Second 429 within window: propagate to siblings](#scenario-2)
3. [Scenario 3 — Second 429 outside window: no propagation](#scenario-3)
4. [Scenario 4 — Sibling already in future cooldown: no overwrite](#scenario-4)
5. [Scenario 5 — Ineligible siblings (api_key / no-attachment / tombstoned / disableRotation): skipped](#scenario-5)
6. [Scenario 6 — Window env override (`CCT_SHARED_BUCKET_WINDOW_MS`)](#scenario-6)
7. [Scenario 7 — UI label `via inferred shared bucket`](#scenario-7)
8. [Scenario 8 — Cascade end-to-end: exactly 2 calls before all marked](#scenario-8)
9. [Scenario 9 — `knownReset === false` (60-min fallback) does NOT trigger propagation](#scenario-9)
10. [Scenario 10 — Sibling source `'manual'` / `'inferred_shared'` cannot anchor a match](#scenario-10)
11. [Scenario 11 — `disableRotation: true` sibling skipped both as anchor and target](#scenario-11)
12. [Scenario 12 — `tryRotateToken` plumbs `knownReset` correctly](#scenario-12)

---

## Scenario 1 — First 429: only active slot marked

### 1. API Entry
- Runtime function: `TokenManager.rotateOnRateLimit(reason, opts)`
- Caller: `src/slack/pipeline/stream-executor.ts:2023 tryRotateToken`
- Auth: N/A (internal)

### 2. Input
- `reason: string` (e.g., `"stream-executor rate-limit on slot=ai2"`)
- `opts: { source: 'error_string', cooldownMinutes: number, knownReset: true }`
- Snapshot precondition: `snap.registry.activeKeyId = currentId`. **No sibling has a future `cooldownUntil`.**

### 3. Layer Flow
#### 3a. Entry — `rotateOnRateLimit` (`src/token-manager.ts:732`)
- `nowMs = Date.now()`, `nowIso = new Date(nowMs).toISOString()`
- `cooldownMs = (opts.cooldownMinutes ?? DEFAULT_COOLDOWN_MS/60000) * 60000`
- `cooldownUntilIso = new Date(nowMs + cooldownMs).toISOString()`
- `windowMs = resolveSharedBucketWindowMs(process.env.CCT_SHARED_BUCKET_WINDOW_MS)`

#### 3b. Mutate transaction (`store.mutate(snap => …)`)
- `currentId = snap.registry.activeKeyId`
- Mutate `snap.state[currentId]` exactly as today: `rateLimitedAt`, `rateLimitSource = 'error_string'`, `cooldownUntil = cooldownUntilIso`.
- **Trigger gate**: only call propagation helper when `opts.knownReset === true` AND `opts.source ∈ {'error_string', 'response_header'}`. Otherwise skip directly to rotation.
- **NEW**: when gate passes — call `propagateInferredSharedCooldownIfMatched(snap, anchorMs = nowMs + cooldownMs, nowIso, windowMs, currentId)`.
  - Inside helper, iterate `snap.registry.slots` (NOT raw `snap.state`):
    - Skip slot K if `K.kind === 'api_key'`.
    - Skip slot K if `K.kind === 'cct'` and `K.oauthAttachment === undefined`.
    - Skip slot K if `K.disableRotation === true`.
    - Skip slot K if `K.keyId === currentId`.
    - Resolve `stateK = snap.state[K.keyId]`. If absent (orphan), use synthesized default `{authState:'healthy', activeLeases:[]}` (mirrors existing rotateOnRateLimit pattern), but a propagation target with absent state is unusual — still allowed.
    - Skip slot K if `stateK.tombstoned === true`.
  - **Match-anchor scan** (subset of iteration above):
    - Candidate is K iff `stateK.cooldownUntil` exists, `existingMs = new Date(stateK.cooldownUntil).getTime()` finite AND `> nowMs` (future), AND `stateK.rateLimitSource ∈ {'error_string', 'response_header'}` AND `|existingMs - anchorMs| <= windowMs`.
    - If at least one K matches → `matched = true`.
  - **Pristine state in this scenario**: no sibling has any cooldownUntil → no candidate matches → `matched === false` → helper returns without mutation.
- Continue with existing rotation: pick next eligible slot via the existing for-loop.

#### 3c. Persist (`store.mutate` commit)
- CAS write: only `snap.state[currentId]` changed. No sibling touched.

Transformation arrows:
```
opts.cooldownMinutes → cooldownMs → cooldownUntilIso → snap.state[currentId].cooldownUntil
opts.source ('error_string') → snap.state[currentId].rateLimitSource
nowIso → snap.state[currentId].rateLimitedAt
```

### 4. Side Effects
- DB-equivalent (cct-store JSON file): UPDATE `state[currentId]` row only.
- Log: `rotateOnRateLimit: <reason> source=error_string rotated=<next|none>` (existing).

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| `snap.registry.activeKeyId` undefined | Existing early return — no mutation. |
| Existing throw inside mutate | CAS retry per `CctStore.mutate` semantics. |

### 6. Output
- Returns `{ keyId, name } | null` for the rotated-to slot (existing return shape, unchanged).

### 7. Observability
- Existing single info log line. No additional log emitted in this scenario (no propagation triggered).

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-1: first 429 in pristine state marks only active slot` | Happy Path |

---

## Scenario 2 — Second 429 within window: propagate to siblings

### 1. API Entry
- Runtime: `TokenManager.rotateOnRateLimit(reason, opts)`

### 2. Input
- Same shape as Scenario 1; `opts.knownReset === true`.
- Snapshot precondition: at least one sibling slot `M` (CCT + `oauthAttachment` + not tombstoned + not `disableRotation`) has `state[M].cooldownUntil = Y` where `|Y_ms - anchorMs| <= windowMs` AND `state[M].rateLimitSource ∈ {'error_string', 'response_header'}`.

### 3. Layer Flow
#### 3a. Entry
- Identical to Scenario 1 (compute `anchorMs`, `nowIso`, `windowMs`). Trigger gate passes (knownReset + direct-evidence source).

#### 3b. Mutate transaction
- Mark `state[currentId]` as in Scenario 1.
- `propagateInferredSharedCooldownIfMatched` finds match on sibling `M`.
- For each *other* slot `K` in `snap.registry.slots` (excluding `currentId`):
  - Skip if `K.kind === 'api_key'`.
  - Skip if `K.kind === 'cct'` and `K.oauthAttachment === undefined`.
  - Skip if `K.disableRotation === true`.
  - Resolve `stateK = snap.state[K.keyId] ?? <healthy default>`.
  - Skip if `stateK.tombstoned === true`.
  - Skip if `stateK.cooldownUntil` exists and `new Date(stateK.cooldownUntil).getTime() > nowMs` (already future-cooled — Scenario 4 rule).
  - Otherwise: `stateK.cooldownUntil = cooldownUntilIso`, `stateK.rateLimitedAt = nowIso`, `stateK.rateLimitSource = 'inferred_shared'`. Persist back to `snap.state[K.keyId]`.

Transformation arrows:
```
anchorMs (= currentId's new cooldownUntilMs) → matched against every state[*].cooldownUntilMs within ±windowMs
On match: cooldownUntilIso → snap.state[K].cooldownUntil
          nowIso          → snap.state[K].rateLimitedAt
          'inferred_shared' → snap.state[K].rateLimitSource
```

#### 3c. Persist
- CAS write: `currentId` row plus N propagated rows.

### 4. Side Effects
- UPDATE `state[currentId]` AND `state[K1..Kn]` rows.
- Log: existing `rotateOnRateLimit: …` line PLUS new line `rotateOnRateLimit inferred_shared: matchedSibling=<keyId> propagated=<count> windowMs=<W>`.

### 5. Error Paths
| Condition | Behavior |
|-----------|----------|
| `state[K]` is missing entirely (untouched slot) | Helper synthesizes `{ authState:'healthy', activeLeases:[] }` then writes — matches existing default-value pattern in `rotateOnRateLimit`. |
| Slot `K` has `authState !== 'healthy'` | Marked anyway. Already runtime-ineligible; no harm. (See spec §5.5.) |

### 6. Output
- Same return shape as Scenario 1 (`{ keyId, name } | null`). After propagation, the rotation loop typically returns `null` (no eligible siblings remain) — that's the desired observable: stop rotating into a known-bad bucket.

### 7. Observability
- New log line shows propagation occurred. Useful for ops to confirm the heuristic fired and to count its rate.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-2: second 429 within window propagates to all eligible siblings with source=inferred_shared` | Happy Path |
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-2: propagated rateLimitedAt equals nowIso (per-call)` | Contract |
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-2: rotation returns null when all siblings just propagated` | Side-Effect |

---

## Scenario 3 — Second 429 outside window: no propagation

### 1. API Entry
- Runtime: `TokenManager.rotateOnRateLimit(reason, opts)`

### 2. Input
- Sibling `M` exists with `state[M].cooldownUntil = Y` where `|Y_ms - anchorMs| > windowMs`.

### 3. Layer Flow
- Match scan finds no entry within window → `propagateInferredSharedCooldownIfMatched` returns without mutating siblings.

### 4. Side Effects
- UPDATE `state[currentId]` only (same as Scenario 1).

### 5. Error Paths
- N/A.

### 6. Output
- Same as Scenario 1.

### 7. Observability
- No propagation log line emitted.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-3: second 429 outside window does NOT propagate (independent buckets)` | Sad Path |

---

## Scenario 4 — Sibling already in future cooldown: no overwrite

### 1. Input
- Match found on sibling `M`. Sibling `K` has its own `state[K].cooldownUntil > nowMs`.

### 3. Layer Flow
- During iteration, `K` is skipped because `existingFutureK > nowMs`. `state[K]` is left untouched.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-4: sibling already in future cooldown is not overwritten by propagation` | Side-Effect |

---

## Scenario 5 — Ineligible siblings (api_key / no-attachment / tombstoned / disableRotation): skipped

### 1. Input
- Match found. Slots present: `K_apikey` (`kind==='api_key'`), `K_setupOnly` (`kind==='cct'`, no `oauthAttachment`), `K_tombstone` (`state.tombstoned===true`), `K_disabled` (`disableRotation===true`), `K_eligible` (cct + attachment + healthy + rotation enabled).

### 3. Layer Flow
- Helper iterates `snap.registry.slots` excluding `currentId`. Filters apply both during the match-anchor scan and the propagation loop:
  - `K_apikey` → skip on `kind === 'api_key'`.
  - `K_setupOnly` → skip on `oauthAttachment === undefined`.
  - `K_tombstone` → skip on `state.tombstoned`.
  - `K_disabled` → skip on `disableRotation === true`.
  - `K_eligible` → propagated.
- Crucially: even if `K_apikey` / `K_setupOnly` / `K_tombstone` / `K_disabled` happens to carry a future `cooldownUntil` matching the new value, they are NOT counted as match anchors. Match must come from a fully-eligible CCT sibling.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-5a: api_key, no-attachment, tombstoned, disableRotation siblings are skipped as propagation targets` | Sad Path |
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-5b: ineligible siblings cannot serve as match anchors even with cooldownUntil within window` | Sad Path |

---

## Scenario 6 — Window env override

### 1. Entry
- `process.env.CCT_SHARED_BUCKET_WINDOW_MS = "300000"` (or invalid).

### 3. Layer Flow
- `resolveSharedBucketWindowMs(envValue)`:
  - `parseInt(envValue, 10)` → `n`.
  - If `Number.isFinite(n) && n > 0` → `windowMs = n` (300_000).
  - Else log warning `'CCT_SHARED_BUCKET_WINDOW_MS invalid, falling back to 90000'`, `windowMs = 90_000`.
- Helper uses resolved `windowMs` when matching siblings.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-6a: env CCT_SHARED_BUCKET_WINDOW_MS=300000 widens the match window` | Contract |
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-6b: invalid env value falls back to default 90000 with warning logged` | Sad Path |

---

## Scenario 7 — UI label for `inferred_shared` source

### 1. API Entry
- Runtime: `buildRateLimitedSegment(state, userTz, nowMs)` (`src/slack/cct/builder.ts:540`).

### 2. Input
- `state.rateLimitedAt = "2026-04-30T03:48:00.000Z"`, `state.rateLimitSource = 'inferred_shared'`.

### 3. Layer Flow
- `formatRateLimitedAt` formats timestamp as today.
- Source label switch returns `' via inferred shared bucket'` for `'inferred_shared'`.
- Returns concatenated `rate-limited <ts> via inferred shared bucket`.

Transformation arrows:
```
state.rateLimitSource ('inferred_shared') → ' via inferred shared bucket'
```

### 4. Side Effects
- None (pure render).

### 6. Output
- String fragment placed on the slot's secondary diagnostic line in the `/cct` Slack card.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/slack/cct/__tests__/builder.test.ts` | `buildRateLimitedSegment > rateLimitSource label` | `AC-7: rateLimitSource='inferred_shared' renders 'via inferred shared bucket'` | Happy Path |

---

## Scenario 8 — Cascade end-to-end: exactly 2 calls before all marked

### 1. Setup
- 6 CCT-with-attachment slots (`A..F`), all healthy, no cooldown.
- Active = A.

### 3. Layer Flow (sequence)
1. CLI 429 #1 → `rotateOnRateLimit` for A:
   - `state[A]` marked. No sibling match (pristine). No propagation. Rotate to B.
2. CLI 429 #2 → `rotateOnRateLimit` for B:
   - `state[B]` marked. Match found against `state[A].cooldownUntil` (within window because Anthropic returned same wall-clock). Propagate to `C, D, E, F`. Rotate to next eligible → none → return `null`.
3. Subsequent calls (without `rotateOnRateLimit` re-entry from caller) — caller surfaces "no eligible slot, retry in <dur>" using the propagated cooldownUntil.

### 4. Side Effects
- After call #2: every slot `A..F` has `cooldownUntil` set. `A`/`B` source = `'error_string'`; `C..F` source = `'inferred_shared'`.

### 6. Output
- Call #1 returns `{ keyId: B.keyId, name: B.name }`.
- Call #2 returns `null` (no eligible after propagation).

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-9: 6-slot cascade collapses after 2 rotateOnRateLimit calls; remaining 4 marked inferred_shared` | Side-Effect |

---

## Scenario 9 — `knownReset === false` (60-min fallback) does NOT trigger propagation

### 1. Input
- `opts: { source: 'error_string', cooldownMinutes: 60, knownReset: false }`
- Snapshot precondition: a sibling has a future cooldownUntil within ±W ms whose own source ∈ direct-evidence.

### 3. Layer Flow
- `state[currentId]` marked normally (cooldownUntil = now + 60min).
- Trigger gate: `opts.knownReset === false` → propagation helper is NOT invoked. Mutate falls straight through to rotation.

### 4. Side Effects
- Only `state[currentId]` updated. No log line for inferred_shared. Sibling state unchanged.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-10: knownReset=false suppresses propagation even when a within-window match exists (prevents two coincidental 60m fallbacks chaining)` | Sad Path |

---

## Scenario 10 — Sibling source `'manual'` / `'inferred_shared'` cannot anchor a match

### 1. Input — Variant A (manual sibling)
- `opts.knownReset === true`.
- Sibling `M` has `state[M].cooldownUntil` within ±W ms of new value, but `state[M].rateLimitSource === 'manual'`.

### 1. Input — Variant B (inferred_shared sibling)
- Same as A but `state[M].rateLimitSource === 'inferred_shared'`.

### 3. Layer Flow
- Helper iteration reaches `M`.
- Match-anchor scan rejects `M` because its source is not in `{'error_string', 'response_header'}`.
- No other sibling matches → `matched === false` → no propagation.

### 4. Side Effects
- Only `state[currentId]` mutated. Sibling state unchanged.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-11a: sibling rateLimitSource='manual' cannot anchor a match` | Sad Path |
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-11b: sibling rateLimitSource='inferred_shared' cannot anchor a match (no chaining)` | Sad Path |

---

## Scenario 11 — `disableRotation: true` sibling skipped both as anchor and target

### 1. Input
- Slot `K_disabled` has `disableRotation: true`. Has `state[K_disabled].cooldownUntil` within window with source `error_string`.
- Slot `K_other` is fully eligible, no cooldownUntil.

### 3. Layer Flow
- Match-anchor scan iterates slots. `K_disabled` is filtered out before the source/window checks → does not anchor a match.
- Propagation loop iterates slots. `K_disabled` is filtered out → not assigned `inferred_shared` cooldown.
- `K_other` is not anchored against (because the only candidate was filtered out) → no propagation occurs.

### 4. Side Effects
- Only `state[currentId]` mutated. `K_disabled` and `K_other` unchanged.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/__tests__/token-manager.test.ts` | `rotateOnRateLimit > inferred-shared propagation` | `AC-5c: disableRotation sibling cannot anchor a match nor be a propagation target` | Sad Path |

---

## Scenario 12 — `tryRotateToken` plumbs `knownReset` correctly

### 1. API Entry
- Runtime: `StreamExecutor.tryRotateToken(error, activeSlotAtQueryStart)` (`src/slack/pipeline/stream-executor.ts:2023`).

### 2. Input — Variant A (parsed)
- `error.message` contains `"resets 7pm"` → `parseCooldownTime` returns a `Date`.

### 2. Input — Variant B (unparsed)
- `error.message` is opaque (just `"rate limit exceeded"`) → `parseCooldownTime` returns `null`.

### 3. Layer Flow
```
parsedCooldown = parseCooldownTime(errorText)
knownReset     = parsedCooldown !== null
cooldownMinutes = knownReset ? max(1, round((parsed - now) / 60_000)) : 60
rotateOnRateLimit(reason, { source: 'error_string', cooldownMinutes, knownReset })
```

Transformation arrows:
```
parseCooldownTime(errorText) → parsedCooldown : Date | null
parsedCooldown !== null      → knownReset : boolean
{ ..., knownReset }          → opts.knownReset (consumed by rotateOnRateLimit's trigger gate)
```

### 4. Side Effects
- Variant A: `rotateOnRateLimit` receives `knownReset: true` → propagation helper may run (depending on snapshot match state).
- Variant B: `rotateOnRateLimit` receives `knownReset: false` → propagation helper is short-circuited.

### Contract Tests (RED)
| File | describe | it | Category |
|------|----------|----|----------|
| `src/slack/pipeline/__tests__/stream-executor.test.ts` | `tryRotateToken > knownReset plumbing` | `AC-12a: parsed cooldown text → rotateOnRateLimit called with knownReset:true` | Contract |
| `src/slack/pipeline/__tests__/stream-executor.test.ts` | `tryRotateToken > knownReset plumbing` | `AC-12b: unparseable error → rotateOnRateLimit called with knownReset:false and cooldownMinutes:60` | Contract |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Combine all token-manager test cases under a single `describe('inferred-shared propagation')` block | tiny | Keeps the new contract co-located; mirrors the existing nested `describe` pattern (`describe('rotateOnRateLimit', () => {...})`). |
| Use snapshot fixture builder pattern already present in `token-manager.test.ts` | tiny | `tm` factory already exists per existing tests. No new infrastructure. |
| `formatRateLimitedAt` mock not needed — feed real timestamp + tz | tiny | Existing builder test fixtures use the same approach. |
| `resolveSharedBucketWindowMs` is module-private, tested via behavior (window override observed through propagation match outcome) rather than direct export | tiny | Don't widen public surface for a test affordance; observe via integration. |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. First 429 — only active marked | done | RED | Ready for stv:work |
| 2. Second 429 within window — propagate | done | RED | Ready for stv:work |
| 3. Second 429 outside window — no propagation | done | RED | Ready for stv:work |
| 4. Sibling already cooled — no overwrite | done | RED | Ready for stv:work |
| 5. Ineligible siblings (api_key/no-attachment/tombstoned/disableRotation) skipped — both as anchor and target | done | RED | Ready for stv:work |
| 6. Window env override | done | RED | Ready for stv:work |
| 7. UI label rendering | done | RED | Ready for stv:work |
| 8. Cascade end-to-end | done | RED | Ready for stv:work |
| 9. knownReset=false suppresses propagation | done | RED | Ready for stv:work |
| 10. Sibling source 'manual' / 'inferred_shared' cannot anchor | done | RED | Ready for stv:work |
| 11. disableRotation sibling end-to-end skip | done | RED | Ready for stv:work |
| 12. tryRotateToken plumbs knownReset correctly | done | RED | Ready for stv:work |

## Changelog
- 2026-04-30: Initial creation.

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work docs/cct-shared-bucket-cooldown-propagation/trace.md`.
