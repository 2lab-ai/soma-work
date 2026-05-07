# CCT Shared-Bucket Cooldown Propagation — Spec

> STV Spec | Created: 2026-04-30

## 1. Overview

### Proposal
- **Why**: Operators register multiple separate Claude Max OAuth subscriptions as CCT slots expecting N× quota, but Anthropic enforces a cross-account rate-limit bucket (almost certainly IP/machine-based) so all slots 429 in cascade with the same parsed reset wall-clock. Each cascade step burns a real `claude` CLI subprocess + 429 round-trip before being marked, then we rotate to the next slot which immediately repeats. With N=6 slots, the user pays N-1 wasted spawn/parse/error cycles before the rotation pool is exhausted.
- **What Changes**: When a rate-limit hits, after marking the active slot's `cooldownUntil`, we scan eligible-class sibling slots' existing cooldownUntil values. If at least one match within ±W ms is found (the *second* observation of the same wall-clock reset, **with both observations originating from a parsed wall-clock — not the 60-minute fallback — and from a direct-evidence source `'error_string' | 'response_header'`**), we propagate that cooldownUntil to all eligible OAuth-attached CCT siblings. The first 429 in any window is recorded normally — we never blind-propagate.
- **Capabilities**: New `RateLimitSource` arm `'inferred_shared'` distinguishes propagation marks from real 429s in logs and UI. The slack `/cct` card surfaces this as `via inferred shared bucket` so operators can tell apart "this slot itself was rate-limited" from "we inferred this slot is in the same bucket as a recently-limited slot".
- **Impact**: Additive type union extension (no schema migration). One new private helper in `TokenManager`. One UI label arm. One caller-side flag added by `stream-executor` (`knownReset: parsedCooldown !== null`) — keeps the trigger gated on real wall-clock evidence. Behavior change is *limited to the active 429 path* (`stream-executor` → `tryRotateToken` → `rotateOnRateLimit`) — passive header-driven `recordRateLimitHint` is untouched. `parseCooldownTime` is untouched. Existing tests must still pass; cascade-related flows now collapse two cycles instead of N.

The mechanism is the second-cascade-step heuristic with three guards:

1. **Trigger guard** — propagation only activates when the *current* call's source is direct-evidence (`'error_string' | 'response_header'`) AND `opts.knownReset === true` (the caller actually parsed a wall-clock, not the 60-minute fallback). Otherwise the helper is a no-op.
2. **Match guard** — the matched sibling must itself be in the eligible-set (CCT + `oauthAttachment` + not tombstoned + not `disableRotation`) AND its `rateLimitSource` must be direct-evidence (`'error_string' | 'response_header'`). Sibling sources `'manual'` and `'inferred_shared'` cannot anchor a match — they don't represent direct upstream signal.
3. **Window guard** — match radius ±W ms (default 90 000 = 90 s, env `CCT_SHARED_BUCKET_WINDOW_MS`). Wide enough to absorb minute-rounding from `parseCooldownTime`, narrow enough that two coincidental independent 429s 5+ minutes apart don't chain.

Together these guards eliminate the dominant false-positive vectors: (a) two independent saturations falling on the 60-minute default fallback within window, (b) cascading propagation through `'inferred_shared'` re-anchoring, (c) `'manual'` operator-set cooldowns being treated as direct evidence, (d) ineligible-set slots (api_key, no-attachment, tombstoned, disableRotation) participating as match anchors or propagation targets.

## 2. User Stories
- **Operator with 6 keys** — As an operator who registered 6 separate Claude Max accounts, when one slot saturates the upstream's cross-account bucket I want the remaining slots marked immediately so my next user message doesn't sit through 4 more 429s before getting a "no slots available" answer.
- **Operator inspecting `/cct`** — As an operator looking at the card, I want to distinguish "this slot itself 429d" from "this slot was inferred-cooled because a sibling 429d at the same wall-clock", so I know whether the cooldown is independent or shared.
- **Operator running independent keys** — As an operator whose keys are *not* in a shared bucket (e.g. across multiple machines), I want my isolated 429s to NOT propagate, so a one-off rate-limit on slot A doesn't take down B/C/D.

## 3. Acceptance Criteria
- [ ] **AC-1**: First 429 in a rotation cycle marks only the active slot. `state[other].cooldownUntil` remains unchanged for every other slot.
- [ ] **AC-2**: Second 429 whose new `cooldownUntil` is within ±W ms of *any* eligible sibling's existing future `cooldownUntil` (sibling source ∈ {`error_string`, `response_header`}) propagates the new `cooldownUntil` to every eligible OAuth-attached CCT sibling that is not already in a future cooldown. Propagated marks carry `rateLimitSource: 'inferred_shared'`, `rateLimitedAt: now`.
- [ ] **AC-3**: Second 429 whose new `cooldownUntil` is *outside* ±W ms of every sibling's existing cooldownUntil does NOT propagate (independent bucket).
- [ ] **AC-4**: Siblings already in a future cooldown are never overwritten by propagation.
- [ ] **AC-5**: `kind: 'api_key'` slots, `kind: 'cct'` slots without `oauthAttachment`, tombstoned slots, and slots with `disableRotation: true` are skipped by propagation **and excluded from the match-anchor scan**.
- [ ] **AC-6**: `process.env.CCT_SHARED_BUCKET_WINDOW_MS` overrides the default 90 000 ms window. Invalid (`NaN` / `≤0`) values fall back to default with a warning logged.
- [ ] **AC-7**: `/cct` card renders the new `'inferred_shared'` source as `via inferred shared bucket` in `buildRateLimitedSegment`.
- [ ] **AC-8**: Existing `token-manager`, `stream-executor`, `builder` test suites continue to pass without modification (additive only).
- [ ] **AC-9**: Cascade scenario test counts exactly two `rotateOnRateLimit` invocations before all healthy siblings are marked (not N).
- [ ] **AC-10**: Trigger requires `opts.knownReset === true` AND `opts.source ∈ {'error_string', 'response_header'}`. When `knownReset === false` (caller's `parseCooldownTime` returned `null`, fallback to 60-minute default), propagation is a no-op even if a within-window match exists. Prevents two independent fallback-60m cooldowns from chaining.
- [ ] **AC-11**: Sibling whose `rateLimitSource ∈ {'manual', 'inferred_shared'}` cannot anchor a match. Only direct-evidence siblings (`error_string` / `response_header`) qualify. Prevents `inferred_shared` from chaining itself.
- [ ] **AC-12**: stream-executor's `tryRotateToken` (`src/slack/pipeline/stream-executor.ts:2023`) passes `knownReset: parsedCooldown !== null` to `rotateOnRateLimit`. The default-60m branch (`!parsedCooldown`) sets `knownReset: false`.

## 4. Scope

### In-Scope
- Extend `RateLimitSource` union in `src/cct-store/types.ts` with `'inferred_shared'`.
- Extend `RotateOnRateLimitOptions` in `src/token-manager.ts` with `knownReset?: boolean` (default `false` when omitted — preserves backward compat for any non-stream-executor caller).
- Modify `TokenManager.rotateOnRateLimit` (`src/token-manager.ts:732`) to perform the match-and-propagate step inside the existing `store.mutate` transaction, gated by `knownReset && source ∈ {error_string, response_header}`.
- Add private helper `propagateInferredSharedCooldownIfMatched(snap, anchorCooldownUntilMs, nowIso, windowMs, currentId)` to keep the mutate body readable. The helper iterates `snap.registry.slots` (NOT raw `snap.state`) so the eligibility checks are slot-shape-aware.
- Resolve window from `process.env.CCT_SHARED_BUCKET_WINDOW_MS` once per call (parseInt, fallback 90 000 on NaN / ≤0). Module-private resolver.
- Modify `tryRotateToken` (`src/slack/pipeline/stream-executor.ts:2023`) to pass `knownReset: parsedCooldown !== null` alongside the existing `cooldownMinutes` arg.
- UI: extend `buildRateLimitedSegment` source-label switch (`src/slack/cct/builder.ts`) for `'inferred_shared'`.
- New unit tests in `src/__tests__/token-manager.test.ts` covering AC-1..AC-6, AC-9..AC-11.
- New stream-executor test in `src/slack/pipeline/__tests__/stream-executor.test.ts` covering AC-12 (the `knownReset` flag is plumbed correctly for both parsed and fallback paths).
- New UI test in `src/slack/cct/__tests__/builder.test.ts` covering AC-7.
- Brief docs note appended to `docs/cct/scheduling-strategy.md` summarizing the propagation rule.

### Out-of-Scope
- Auto-detecting organization grouping via `accountUuid` or email domain.
- Manual `slotGroup` config field on slot definitions.
- UX-only banner without behavior change.
- Disabling auto-rotate-on-429.
- Touching `recordRateLimitHint` (header-driven passive path).
- Touching `parseCooldownTime` (wall-clock parser is correct).
- `applyTokenIfActiveMatches` and the auto-rotate selection logic in `src/oauth/auto-rotate.ts` (read-only consumer of cooldown state — no change needed; cooled siblings simply become ineligible by the existing `isEligible` gate).

## 5. Architecture

### 5.1 Layer Structure (unchanged + new helper)
```
slack/pipeline/stream-executor.ts
  └─ tryRotateToken(error, activeSlotAtQueryStart)
       └─ parseCooldownTime(errorText)               // returns Date | null
       └─ knownReset = parsedCooldown !== null        // NEW flag
       └─ cooldownMinutes = knownReset ? round(...) : 60
       └─ TokenManager.rotateOnRateLimit(reason, {source:'error_string', cooldownMinutes, knownReset})
            └─ [MUTATE TXN]
                 ├─ snap.state[currentId].cooldownUntil = X
                 ├─ snap.state[currentId].rateLimitedAt = now
                 ├─ snap.state[currentId].rateLimitSource = 'error_string'
                 ├─ if (opts.knownReset && opts.source ∈ {error_string, response_header}):
                 │     NEW: propagateInferredSharedCooldownIfMatched(snap, Xms, nowIso, W, currentId)
                 │       └─ for each slot K in snap.registry.slots, K !== currentId:
                 │            ELIGIBLE_FILTER:
                 │              skip if K.kind === 'api_key'
                 │              skip if K.kind === 'cct' && K.oauthAttachment === undefined
                 │              skip if K.disableRotation === true
                 │              skip if state[K].tombstoned === true
                 │            MATCH_ANCHOR_SCAN:
                 │              candidate is K iff state[K].cooldownUntil exists,
                 │              its parsed ms is finite AND > nowMs (future),
                 │              AND state[K].rateLimitSource ∈ {error_string, response_header}
                 │              AND |parsed_ms - Xms| <= W
                 │              → if any K satisfies match → matched = true
                 │            (loop1 collects match)
                 │       └─ if matched:
                 │            for each slot K' in snap.registry.slots, K' !== currentId,
                 │            passing ELIGIBLE_FILTER, with NO future cooldownUntil:
                 │              snap.state[K'].cooldownUntil  = cooldownUntilIso
                 │              snap.state[K'].rateLimitedAt  = nowIso
                 │              snap.state[K'].rateLimitSource = 'inferred_shared'
                 └─ rotate activeKeyId to next eligible (now likely none → returns null)
```

The match-anchor scan and the propagation loop both walk `snap.registry.slots` (not raw `snap.state` keys) so orphan state rows (a known historical artifact when a slot is removed without state cleanup) cannot anchor or receive propagation.

The propagation step lives **inside** the same `store.mutate` callback as the original currentId mutation. This is critical: both the `currentId` mark and the propagation must be atomic relative to other transactions to preserve the existing CAS-safe semantics. If the mutate transaction is retried due to optimistic-lock conflict, the propagation re-evaluates against the fresh snapshot and naturally converges.

### 5.2 API Endpoints
None. This is a pure runtime behavior change. No new HTTP/Slack/IPC surface.

### 5.3 DB Schema
No schema change. The persisted shape in `data/cct-store.json` is unchanged — `rateLimitSource` is already a free-form string from the `RateLimitSource` union; adding `'inferred_shared'` is read-tolerant by existing parse code (no enum gate at read time).

For backward compat: a v2-format snapshot written by this PR can be read by an older soma-work binary that doesn't know `'inferred_shared'`. The older binary will still surface `state.cooldownUntil` correctly via the picker (`isEligible` doesn't switch on source). UI rendering on older binaries would fall through to a default Cooldown label — graceful degradation.

### 5.4 Integration Points
- **stream-executor `tryRotateToken`** — caller; today passes `{source: 'error_string', cooldownMinutes}`. **This PR adds `knownReset: parsedCooldown !== null`** so the propagation gate can distinguish parsed wall-clock from the 60-minute fallback. No other behavior change in this caller.
- **auto-rotate `evaluateAndMaybeRotate`** — read-only consumer; cooled siblings are ineligible via existing `isEligible(slot, state, now)` which already checks `state.cooldownUntil > now`.
- **slack/cct builder `buildRateLimitedSegment`** — UI label switch extended for `'inferred_shared'` → `via inferred shared bucket`. `computeUsageCooldown` `source: 'manual'` arm covers rendering of the bare `Cooldown <dur>` badge for inferred-shared cooled slots, since their `usage.sevenDay` / `usage.fiveHour` are not at 100% (the badge is utilization-driven; the rate-limited line is source-driven).
- **logger** — `rotateOnRateLimit` already emits a single info log per call. Add a separate info log when propagation triggers, naming the matched sibling and the count of propagated targets.

### 5.5 Failure Modes
| Scenario | Expected behavior |
|----------|-------------------|
| Window env var malformed | Log warning, fall back to default 90 000 ms. Spec test covers this. |
| Caller's `parseCooldownTime` returned `null` (60-min fallback) | `knownReset === false` ⇒ trigger guard rejects propagation. Two coincidental 60m fallbacks within window cannot chain. |
| Sibling cooldownUntil is in the past (stale) | Excluded from match-anchor scan — `cooldownUntilMs > nowMs` is the sibling-recency gate. |
| Sibling source is `'manual'` (operator-set) | Excluded from match-anchor scan — only direct-evidence sources (`error_string` / `response_header`) anchor. |
| Sibling source is `'inferred_shared'` (already propagated) | Excluded from match-anchor scan — prevents inferred chains from re-propagating. |
| Sibling has cooldownUntil but no rateLimitedAt | Still propagation-target eligible (`cooldownUntil` is the SSOT for "is in cooldown"); but as a match anchor the source check still applies. |
| New cooldown is in the past after cooldownMinutes=1 floor | Same as today — `state.cooldownUntil = nowMs + cooldownMs`, rounded; propagation operates on the same `Xms`. |
| Slot has `authState='refresh_failed'`/`'revoked'` | Already excluded from runtime picker. Marked by propagation for diagnostic clarity (cheap, harmless — slot was ineligible already). |
| Tombstoned sibling | Skipped both as match anchor and as propagation target. |
| `disableRotation: true` sibling | Skipped both as match anchor and as propagation target (operator opt-out preserved end-to-end). |
| `api_key` sibling | Skipped both as match anchor and as propagation target (different rate-limit bucket — Anthropic commercial API quota). |
| CCT slot without `oauthAttachment` (setup-only) | Skipped — same bucket signal does not apply to a slot that hasn't authenticated to OAuth. |
| Orphan state row (no matching slot in registry) | Untouched — iteration walks `registry.slots` not state keys. |

## 6. Non-Functional Requirements
- **Performance**: Propagation is O(n_slots) inside a single `store.mutate`. n_slots is bounded by config (typically ≤16). Each iteration is field reads + 3 field writes. Negligible vs the lock acquisition cost already paid by `mutate`.
- **Concurrency**: Existing CAS retry semantics in `CctStore.mutate` carry over. If a competing transaction lands between snapshot read and persist, the mutate is retried with a fresh snapshot — propagation is recomputed deterministically against the fresh state.
- **Observability**: New log line `rotateOnRateLimit: inferred_shared propagation matched=<sibling-keyId> propagated=<count> windowMs=<W>`. Lets ops see propagation events in production logs without enabling debug.
- **Configurability**: Single env var `CCT_SHARED_BUCKET_WINDOW_MS`. Default 90 000 ms is conservative — wall-clock `parseCooldownTime` rounds to the minute, so two cascade hits within the same minute boundary will be ≤ 60 000 ms apart at the source; 90 000 ms gives a 30 s slack for network jitter and clock skew.
- **Security**: No new external surface; no PII handling; no token exposure. Logs name keyIds (already an opaque ULID, not a token).

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Place propagation inside the same `store.mutate` callback | small | Existing CAS pattern; alternative (separate mutate) would race with the currentId write. |
| Default window W = 90 000 ms | small | parseCooldownTime rounds to minute → max 60 s skew; +30 s for jitter. Easy to tune via env. |
| Trigger on second observation (existing sibling cooldownUntil match) rather than first | small | Required to avoid blind fan-out false-positives on isolated rate-limits — directly responsive to user's "don't break independent keys" constraint. |
| Skip api_key + no-attachment + tombstoned + disableRotation siblings (both as match anchor and as propagation target) | small | Mirrors existing `isEligible` exclusions; keeps propagation set aligned with runtime selection set. Operator-opt-out (`disableRotation`) must remain authoritative end-to-end. |
| Match-anchor source must be `'error_string' \| 'response_header'` | small | Direct upstream evidence only. `'manual'` is operator-set bookkeeping; `'inferred_shared'` is already propagated. Prevents a single inference from chaining across the whole pool. |
| Trigger gate: `opts.knownReset === true` AND source ∈ direct-evidence set | small | Two coincidental 60-minute fallback cooldowns must NOT chain into a phantom "shared bucket". `knownReset` is `parsedCooldown !== null` at the caller. |
| Iterate `snap.registry.slots` (not raw `snap.state` keys) | small | Slot-shape-aware filtering requires the slot record. Also incidentally shields against orphan state rows. |
| New `RateLimitSource` arm `'inferred_shared'` rather than overloading `'error_string'` | small | Preserves debugging: in `data/cct-store.json` we can still tell which marks were direct vs inferred. UI distinction useful for operator trust. |
| UI label `via inferred shared bucket` on the rate-limited line; the badge label remains `Cooldown <dur>` (source='manual' arm in `computeUsageCooldown`) since utilization is not at 100% | small | Keeps the badge utilization-driven (its existing invariant) and surfaces the inference signal where it belongs (the rate-limited diagnostic line). |
| Window env override parses with `parseInt(_, 10)`, falls back to default on NaN or ≤0 | small | Existing pattern in the codebase; avoid letting bad config silently set a 0 ms window. |

All listed decisions have switching cost ≤ small (≤ 20 lines or following an existing pattern). Per Decision Gate: autonomous decision + record. No user ask required.

## 8. Open Questions
None remaining for the spec phase. Implementation phase will need to choose:
- Exact log message format for the propagation event (matches the existing `rotateOnRateLimit` log style — small switching cost, autonomous).
- Whether to emit a metric counter (`rotateOnRateLimit_inferred_shared_count`). Punted to follow-up if the codebase exposes a metrics pipe; otherwise log-only is fine.

## 9. Spec Changelog
- 2026-04-30: Initial creation.

## 10. Next Step
→ Proceed with vertical trace via `stv:trace docs/cct-shared-bucket-cooldown-propagation/spec.md`.
