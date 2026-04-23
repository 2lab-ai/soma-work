# CCT Slot Scheduling Strategy: Consume-Soonest-Expiring-First

> **DESIGN ONLY — NOT YET IMPLEMENTED.** This document reserves the
> scheduling approach for future work. See the PR that introduced this
> file (#668 follow-up) for the UI-level budget visualization (the
> "Soonest expiring 7d budget" footer on the CCT card). The actual
> slot-selection policy change described below has not landed — the
> current rotation still uses round-robin over the first eligible
> candidate. A later PR will swap in the scoring function.

## 1. Motivation

Every CCT slot carries a 7-day usage budget. When the budget resets, any
unused allocation is forfeited — Anthropic does not roll unused credits
forward. A fleet that rotates evenly across N slots wastes ~1/N of every
expiring slot's remaining budget, because the round-robin pacing doesn't
preferentially drain slots approaching their reset.

The card footer added in #668 follow-up surfaces this signal for
operators; this document proposes the selection-side change that closes
the loop automatically. The goal is zero operator intervention: the
daemon prefers slots whose budget is about to reset, so the budget is
consumed rather than forfeited.

## 2. Current Policy

`TokenManager.acquireLease` / `rotateToNext` / `rotateOnRateLimit` share
this shape (`src/token-manager.ts`):

```ts
// Prefer the current active slot if still eligible; otherwise pick the
// first eligible slot starting from the current index (round-robin).
```

Eligibility is a boolean filter — `!tombstoned && authState !== 'revoked'
&& authState !== 'refresh_failed' && cooldownUntil <= now && !disableRotation`.
Among the eligible candidates, the first one wins. There is no ranking
or scoring — selection is position-based.

This is simple and safe, but it's also the reason the footer exists:
operators watch it and manually `/cct set <name>` to push traffic
toward the soonest-expiring slot. That's an operational workaround for
a design gap.

## 3. Proposed Heuristic

Replace the "first eligible" tie-breaker with a score:

```
score(slot) = remaining_7d_ratio × urgency(ttl_7d)

urgency(ttl_ms) = clamp(1 - ttl_ms / SEVEN_DAYS_MS, 0, 1)

// High score = large remaining budget that will expire soon.
// Low score  = either small remaining budget (already spent) OR large
//              TTL (plenty of time to consume later).
```

Worked examples for intuition (budget normalized 0..1):

| slot | remaining_7d | ttl_7d  | urgency | score  |
| ---- | ------------ | ------- | ------- | ------ |
| A    | 0.90         | 6 days  | 0.14    | 0.129  |
| B    | 0.30         | 1 day   | 0.86    | 0.257  |
| C    | 0.70         | 1 day   | 0.86    | 0.600  |
| D    | 0.05         | 2 hours | 0.99    | 0.049  |

Here C wins: it has a lot of budget that's about to reset. D has
urgency but almost nothing left to consume. A has budget but plenty
of time. B is in the middle.

A fleet driven by this score naturally drains soon-to-reset budgets
first, then reaches for slots with more runway.

## 4. Tie-breakers

When two slots have scores within epsilon (e.g. both freshly reset
with identical budget), fall back to a deterministic ladder:

1. `rate_limit_tier` rank — consume higher-tier (cheaper-per-token)
   budgets first so lower-tier slots remain available for bursty
   workloads that need the higher ceiling:
   ```
   default_claude_max_20x > default_claude_max_5x >
   default_claude_pro    > default_claude_max     > unknown
   ```
2. `subscriptionType` rank — same ordering, used when
   `rate_limit_tier` is absent (legacy slots that predate the profile
   endpoint).
3. `keyId` lexicographic ascending — deterministic final tiebreak so
   two identical-looking slots behave the same across restarts.

The ladder is applied strictly — later rungs only break ties at the
earlier one.

## 5. Integration sketch

```ts
interface PickOpts {
  /** Require strictly better score than `nowActive` before rotating. */
  minDeltaScore?: number;
  /** Optional allowlist — used by rotateOnRateLimit to exclude `current`. */
  excludeKeyIds?: readonly string[];
}

function pickNextSlot(
  snap: StoreSnapshot,
  nowMs: number,
  opts?: PickOpts,
): string | null {
  const candidates = snap.registry.slots
    .filter((s) => s.kind !== 'api_key')
    .filter((s) => !opts?.excludeKeyIds?.includes(s.keyId))
    .filter((s) => isEligible(s, snap.state[s.keyId], nowMs));

  const scored = candidates.map((slot) => ({
    keyId: slot.keyId,
    score: computeScore(slot, snap.state[slot.keyId], nowMs),
    tieBreak: tieBreakVector(slot),
  }));

  scored.sort((a, b) => b.score - a.score || compareTieBreak(a, b));
  return scored[0]?.keyId ?? null;
}
```

Call-site unification:

- `acquireLease` — swap the existing `find(isEligible)` fallback with
  `pickNextSlot(snap, nowMs)`.
- `rotateToNext` — call `pickNextSlot(snap, nowMs, { excludeKeyIds: [currentActive] })`.
- `rotateOnRateLimit` — ditto, so rate-limit-driven rotation also
  prefers soon-to-reset budgets instead of the next index.

## 6. Edge cases

- **All slots ≥ 95% util** — score ≈ 0 for everyone. Fall through to the
  tie-breakers so picks stay deterministic rather than random-order.
- **All in cooldown** — `pickNextSlot` returns null. Callers already
  handle that (current behaviour: throw or no-op depending on path).
- **`disableRotation` operator-opt-out** — unchanged. The score is
  only computed over eligible candidates, which already excludes
  flagged slots (#668 follow-up, `isEligible`).
- **Single eligible slot** — score irrelevant; `pickNextSlot` returns
  that keyId.
- **Missing `sevenDay` usage** — treat as `urgency=0`, `remaining=1`
  (assume full budget, far from reset). Score is small → the slot is
  still pickable but deprioritized until usage lands. Matches the
  intent of "prefer signal-rich slots".

## 7. Test plan

- Unit tests on `computeScore`:
  - score monotonic in `remaining` at fixed TTL
  - score monotonic in `urgency` at fixed remaining
  - score = 0 when `remaining = 0` regardless of urgency
- Unit tests on `pickNextSlot`:
  - 2-slot case where B has higher score → B wins
  - tier tie-break fires when scores within 1e-6
  - `excludeKeyIds` prevents `rotateToNext` from picking current
  - empty candidates → null
- Regression tests against the existing rotation call sites:
  - `acquireLease` picks the best-score eligible slot
  - `rotateToNext` picks the best-score eligible slot NOT the current
  - `rotateOnRateLimit` picks best-score excluding the just-cooled slot

## 8. Rollout

Plan landing in a follow-up PR. Suggested sequence:

1. **Phase A** — land `pickNextSlot` + unit tests, unused.
2. **Phase B** — flip `acquireLease` to call `pickNextSlot`. Ship behind
   `CCT_SCHEDULER_V2=1` env gate; default-off for the first week so
   any regression against the round-robin assumption surfaces in
   staging traffic only.
3. **Phase C** — flip `rotateToNext` and `rotateOnRateLimit` under the
   same gate.
4. **Phase D** — default the gate on. Keep the `=0` escape hatch for
   one release cycle.
5. **Phase E** — remove the gate and the round-robin helper.

The card footer introduced in #668 follow-up stays as a human-readable
sanity check after the scheduler lands — it lets operators see at a
glance whether the scheduler is draining the right slots.
