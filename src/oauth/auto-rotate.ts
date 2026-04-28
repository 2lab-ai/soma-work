/**
 * Auto CCT rotation (#737) — runs after every OAuth refresh tick.
 *
 * Why this lives outside `TokenManager`:
 *   - The selection algorithm is a pure function over the persisted
 *     snapshot. Keeping it free of TokenManager state lets the scheduler
 *     test it without spinning up a CctStore + lockfile dance.
 *   - The side-effecting `evaluateAndMaybeRotate` is a thin orchestrator:
 *     load snapshot → pure pick → check leases → applyToken → notify.
 *     Each step is independently testable through injected dependencies.
 *
 * Policy (locked by issue #737, unit pinned to percent by #685/#781):
 *   - Eligibility: `kind === 'cct'` AND `!disableRotation` AND
 *     `state.authState === 'healthy'` AND not tombstoned AND not in
 *     cooldown AND usage snapshot present AND `usage.sevenDay` window
 *     present (sort key) AND `fiveHour.utilization ≤ fiveHourMax` AND
 *     `sevenDay.utilization ≤ sevenDayMax`.
 *   - Cold-token allowance (#781): a slot whose `/oauth/usage` response
 *     has no `fiveHour` window has, by definition, made zero requests in
 *     the last 5h, so it sits below any threshold. We treat the missing
 *     window as `fiveHourUtilization = 0` rather than rejecting the slot —
 *     otherwise a freshly-loaded token can never be auto-rotated onto.
 *   - Utilization unit: store SSOT is raw API percent (0..100) per #685.
 *     Thresholds are in the same unit; the env-var form (0..1) is
 *     converted at the `config.ts` boundary.
 *   - Selection: minimum `sevenDay.resetsAt` (= soonest to reset).
 *     Tie-break 1: lower `fiveHour.utilization`.
 *     Tie-break 2: keyId lexicographic (deterministic).
 *   - Active slot is ALWAYS in the candidate pool. If the winner equals
 *     active, no-op (no DB write, no notify). The user spec ("change to
 *     the most optimal CCT") explicitly admits the active slot already
 *     being optimal as a valid outcome.
 *   - Lease guard: if the active slot has any in-flight lease,
 *     `evaluateAndMaybeRotate` returns `{kind: 'skipped', reason: 'active-lease'}`.
 *     The next refresh tick (1h later by default) will retry. We do NOT
 *     drain leases — long-running streams legitimately hold leases for
 *     their full duration, and yanking the active slot mid-stream would
 *     surface as "wrong subscriptionType" billing weirdness.
 *
 * Anti-spec deliberate omissions:
 *   - No "rotate even if active is best" knob. The issue is explicit
 *     about no-op being the right behaviour when active wins.
 *   - No legacy-attachment-only special case. The eligibility filter
 *     reuses the same gates as `TokenManager.isEligible` for the dispatch
 *     path (authState/cooldown/tombstoned) — slots invisible to dispatch
 *     are also invisible to auto-rotation.
 */

import type { AuthKey } from '../auth/auth-key';
import { isCctSlot } from '../auth/auth-key';
import type { CctStoreSnapshot, SlotState, UsageSnapshot } from '../cct-store/types';

export interface RotationThresholds {
  /**
   * Inclusive upper bound on `usage.fiveHour.utilization`. Same unit as
   * the store SSOT — raw API percent (0..100) per #685. The
   * `AUTO_ROTATE_FIVEH_THRESHOLD` env var stays in its operator-facing
   * 0..1 form; conversion happens at the `config.ts` boundary.
   */
  fiveHourMax: number;
  /**
   * Inclusive upper bound on `usage.sevenDay.utilization`. Same percent
   * unit (0..100) as `fiveHourMax`. See note above re: env-var conversion.
   */
  sevenDayMax: number;
}

export interface RotationCandidate {
  keyId: string;
  name: string;
  /** ISO string from `usage.sevenDay.resetsAt`. */
  sevenDayResetsAt: string;
  /** Epoch ms parsed from `sevenDayResetsAt` (for downstream comparison without re-parsing). */
  sevenDayResetsAtMs: number;
  /**
   * Raw API percent (0..100) per #685. `0` when the upstream `/oauth/usage`
   * response had no `fiveHour` window — the cold-token allowance from #781.
   */
  fiveHourUtilization: number;
  /** Raw API percent (0..100) per #685. */
  sevenDayUtilization: number;
  /** Epoch ms parsed from `usage.fetchedAt`. Undefined when fetchedAt is missing/invalid. */
  fetchedAtMs?: number;
}

/**
 * Reason an otherwise-CCT slot was rejected. Useful for debug logs.
 *
 * Note (#781): `'no-five-hour-window'` is no longer emitted — a slot
 * with a missing 5h window is now treated as `fiveHourUtilization = 0`
 * (cold-token allowance). The variant is omitted from the union so a
 * stray pattern-match catches the regression at compile time.
 */
export type RejectReason =
  | 'not-cct'
  | 'disable-rotation'
  | 'tombstoned'
  | 'auth-unhealthy'
  | 'cooldown'
  | 'no-usage'
  | 'no-seven-day-window'
  | 'over-five-hour-threshold'
  | 'over-seven-day-threshold'
  | 'invalid-resets-at'
  | 'usage-stale';

interface SlotEvaluation {
  slot: AuthKey;
  candidate?: RotationCandidate;
  reject?: RejectReason;
}

function evaluateSlot(
  slot: AuthKey,
  state: SlotState | undefined,
  nowMs: number,
  thresholds: RotationThresholds,
): SlotEvaluation {
  if (!isCctSlot(slot)) return { slot, reject: 'not-cct' };
  if (slot.disableRotation) return { slot, reject: 'disable-rotation' };

  const s = state;
  if (s?.tombstoned) return { slot, reject: 'tombstoned' };
  if (s && s.authState !== 'healthy') return { slot, reject: 'auth-unhealthy' };
  if (s?.cooldownUntil) {
    const untilMs = new Date(s.cooldownUntil).getTime();
    if (Number.isFinite(untilMs) && untilMs > nowMs) return { slot, reject: 'cooldown' };
  }

  const usage: UsageSnapshot | undefined = s?.usage;
  if (!usage) return { slot, reject: 'no-usage' };
  // 7d window is the sort key — must be present.
  // 5h window is optional (#781 cold-token allowance): a slot that has
  // never seen a 5h-window request has, by definition, zero 5h
  // utilization, so it sits below any threshold and remains eligible.
  if (!usage.sevenDay) return { slot, reject: 'no-seven-day-window' };

  const fiveHourUtilization = usage.fiveHour?.utilization ?? 0;
  if (fiveHourUtilization > thresholds.fiveHourMax) {
    return { slot, reject: 'over-five-hour-threshold' };
  }
  if (usage.sevenDay.utilization > thresholds.sevenDayMax) {
    return { slot, reject: 'over-seven-day-threshold' };
  }

  const resetsAtMs = new Date(usage.sevenDay.resetsAt).getTime();
  if (!Number.isFinite(resetsAtMs)) return { slot, reject: 'invalid-resets-at' };

  const fetchedAtMs = usage.fetchedAt ? new Date(usage.fetchedAt).getTime() : Number.NaN;
  return {
    slot,
    candidate: {
      keyId: slot.keyId,
      name: slot.name,
      sevenDayResetsAt: usage.sevenDay.resetsAt,
      sevenDayResetsAtMs: resetsAtMs,
      fiveHourUtilization,
      sevenDayUtilization: usage.sevenDay.utilization,
      ...(Number.isFinite(fetchedAtMs) ? { fetchedAtMs } : {}),
    },
  };
}

/**
 * Pure: pick the best rotation candidate from the snapshot.
 *
 * Returns `null` when no slot meets the eligibility filter (the caller
 * should treat this as "nothing to do" and emit a debug log — it is
 * NOT a failure mode).
 *
 * Determinism: two snapshots with identical contents always return the
 * same `keyId`. The third tie-breaker (`keyId` lex order) exists so
 * multi-bot deployments don't oscillate between two equivalent slots.
 */
export function selectBestRotationCandidate(
  snap: CctStoreSnapshot,
  nowMs: number,
  thresholds: RotationThresholds,
): RotationCandidate | null {
  return selectBestRotationCandidateWithMaxAge(snap, nowMs, thresholds, Number.POSITIVE_INFINITY);
}

/**
 * Variant of {@link selectBestRotationCandidate} that also rejects
 * candidates whose `usage.fetchedAt` is older than `usageMaxAgeMs`. Used
 * by `evaluateAndMaybeRotate` to avoid rotating onto a slot whose 7d
 * window may have already reset upstream while the local poller was
 * stuck — the chosen `resetsAt` would be ahead-of-real-time, defeating
 * the "soonest reset" policy.
 *
 * Pass `Infinity` to disable the max-age filter (matches the legacy
 * behaviour of `selectBestRotationCandidate`).
 */
export function selectBestRotationCandidateWithMaxAge(
  snap: CctStoreSnapshot,
  nowMs: number,
  thresholds: RotationThresholds,
  usageMaxAgeMs: number,
): RotationCandidate | null {
  const candidates: RotationCandidate[] = [];
  for (const slot of snap.registry.slots) {
    const ev = evaluateSlot(slot, snap.state[slot.keyId], nowMs, thresholds);
    if (!ev.candidate) continue;
    if (
      Number.isFinite(usageMaxAgeMs) &&
      ev.candidate.fetchedAtMs !== undefined &&
      nowMs - ev.candidate.fetchedAtMs > usageMaxAgeMs
    ) {
      continue;
    }
    candidates.push(ev.candidate);
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.sevenDayResetsAtMs !== b.sevenDayResetsAtMs) {
      return a.sevenDayResetsAtMs - b.sevenDayResetsAtMs;
    }
    if (a.fiveHourUtilization !== b.fiveHourUtilization) {
      return a.fiveHourUtilization - b.fiveHourUtilization;
    }
    return a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0;
  });
  return candidates[0];
}

/** Per-slot eligibility breakdown. Used for `dryRun` notify and debug logs. */
export interface RotationDebug {
  evaluatedAt: string;
  thresholds: RotationThresholds;
  activeKeyId: string | undefined;
  candidates: RotationCandidate[];
  rejected: { keyId: string; name: string; reason: RejectReason }[];
}

export function buildRotationDebug(
  snap: CctStoreSnapshot,
  nowMs: number,
  thresholds: RotationThresholds,
  usageMaxAgeMs: number = Number.POSITIVE_INFINITY,
): RotationDebug {
  const candidates: RotationCandidate[] = [];
  const rejected: RotationDebug['rejected'] = [];
  for (const slot of snap.registry.slots) {
    const ev = evaluateSlot(slot, snap.state[slot.keyId], nowMs, thresholds);
    if (ev.candidate) {
      if (
        Number.isFinite(usageMaxAgeMs) &&
        ev.candidate.fetchedAtMs !== undefined &&
        nowMs - ev.candidate.fetchedAtMs > usageMaxAgeMs
      ) {
        rejected.push({ keyId: slot.keyId, name: slot.name, reason: 'usage-stale' });
        continue;
      }
      candidates.push(ev.candidate);
    } else if (ev.reject) {
      rejected.push({ keyId: slot.keyId, name: slot.name, reason: ev.reject });
    }
  }
  return {
    evaluatedAt: new Date(nowMs).toISOString(),
    thresholds,
    activeKeyId: snap.registry.activeKeyId,
    candidates,
    rejected,
  };
}

/** Outcome of one `evaluateAndMaybeRotate` call. */
export type RotationOutcome =
  | { kind: 'rotated'; from: ActiveSummary | null; to: RotationCandidate; debug: RotationDebug }
  | { kind: 'noop'; reason: 'active-is-best' | 'active-not-set'; active: ActiveSummary | null; debug: RotationDebug }
  | {
      kind: 'skipped';
      reason: 'active-lease' | 'no-candidate' | 'disabled' | 'race-active-changed' | 'race-precondition-failed';
      debug: RotationDebug;
    }
  | {
      kind: 'dry-run';
      would: 'rotate' | 'noop' | 'skipped';
      from: ActiveSummary | null;
      to: RotationCandidate | null;
      debug: RotationDebug;
    };

export interface ActiveSummary {
  keyId: string;
  name: string;
  /** Active slot's own usage stats at decision time, if present. Useful for the notify body. */
  fiveHourUtilization?: number;
  sevenDayUtilization?: number;
  sevenDayResetsAt?: string;
}

function summariseActive(snap: CctStoreSnapshot): ActiveSummary | null {
  const id = snap.registry.activeKeyId;
  if (!id) return null;
  const slot = snap.registry.slots.find((s) => s.keyId === id);
  if (!slot) return null;
  const usage = snap.state[id]?.usage;
  return {
    keyId: id,
    name: slot.name,
    fiveHourUtilization: usage?.fiveHour?.utilization,
    sevenDayUtilization: usage?.sevenDay?.utilization,
    sevenDayResetsAt: usage?.sevenDay?.resetsAt,
  };
}

export interface EvaluateAndRotateOpts {
  thresholds: RotationThresholds;
  enabled: boolean;
  dryRun: boolean;
  /**
   * Reject any candidate whose `usage.fetchedAt` is older than this many
   * ms. Defaults to `Infinity` (no max-age) for callers that don't pass
   * an opinion. Production wiring sets `2 × USAGE_REFRESH_INTERVAL_MS`
   * so a stuck usage poller can't pin auto-rotation on a stale 7d window
   * that may have already reset upstream (#737 P1 follow-up to the
   * Linus-style review).
   */
  usageMaxAgeMs?: number;
  /** Defaults to `Date.now()`. Tests pass a fixed clock. */
  now?: () => number;
}

/**
 * Result of the transactional commit primitive that auto-rotation needs
 * from `TokenManager`. Mirrors `TokenManager.applyTokenIfActiveMatches`
 * exactly — kept as a separate type so the evaluator stays decoupled
 * from the TokenManager class shape (tests inject a fake).
 */
export type RotationApplyResult =
  | { rotated: true }
  | {
      rotated: false;
      reason: 'active-changed' | 'unknown-key' | 'api-key-not-selectable' | 'precondition-failed';
    };

export interface RotationDeps {
  /** Authoritative snapshot read. Wired to `tm.getSnapshot()` in production. */
  loadSnapshot: () => Promise<CctStoreSnapshot>;
  /**
   * Transactional commit. Inside `store.mutate`:
   *   1. Verify `snap.registry.activeKeyId === expectedFromKeyId` — else
   *      report `active-changed` (caller will re-evaluate next tick).
   *   2. Verify the target slot still exists and is selectable.
   *   3. Run `precondition(snap, target, targetState, activeState)` — if
   *      false, abort with `precondition-failed` (e.g. lease appeared on
   *      active between snapshot read and commit, or target dropped into
   *      cooldown).
   *   4. Flip `activeKeyId`.
   *
   * This is the bandage on the read/check/commit gap that the previous
   * naive `applyToken(keyId)` approach left wide open.
   */
  applyTokenIfActiveMatches: (
    targetKeyId: string,
    expectedFromKeyId: string | undefined,
    precondition: (
      snap: CctStoreSnapshot,
      target: AuthKey,
      targetState: SlotState | undefined,
      activeState: SlotState | undefined,
    ) => boolean,
  ) => Promise<RotationApplyResult>;
}

/**
 * Predicate factory: re-validates the rotation decision against the
 * authoritative snapshot at commit time. Captures the threshold +
 * usageMaxAge config in a closure so the predicate body stays small.
 *
 * Two veto conditions:
 *   • Active slot has any in-flight lease (acquired between snapshot
 *     read and commit). Lease guard.
 *   • Target slot lost eligibility (tombstoned / cooldown / unhealthy /
 *     usage went over threshold). Avoids activating a known-bad slot.
 */
function makeRotationPrecondition(thresholds: RotationThresholds, usageMaxAgeMs: number, nowMs: number) {
  return (
    _snap: CctStoreSnapshot,
    target: AuthKey,
    targetState: SlotState | undefined,
    activeState: SlotState | undefined,
  ): boolean => {
    if (activeState && activeState.activeLeases.length > 0) return false;
    const ev = evaluateSlot(target, targetState, nowMs, thresholds);
    if (!ev.candidate) return false;
    if (ev.candidate.fetchedAtMs !== undefined && nowMs - ev.candidate.fetchedAtMs > usageMaxAgeMs) {
      return false;
    }
    return true;
  };
}

/**
 * Run one auto-rotation evaluation cycle. Concurrency is handled at two
 * levels: (a) the scheduler serialises `onAfterTick` invocations via an
 * in-flight mutex, and (b) the commit step uses CAS with a precondition
 * so a missed serialisation still cannot flip to a stale or no-longer-
 * eligible slot.
 */
export async function evaluateAndMaybeRotate(
  deps: RotationDeps,
  opts: EvaluateAndRotateOpts,
): Promise<RotationOutcome> {
  const nowMs = (opts.now ?? Date.now)();
  const usageMaxAgeMs = opts.usageMaxAgeMs ?? Number.POSITIVE_INFINITY;
  const snap = await deps.loadSnapshot();
  const debug = buildRotationDebug(snap, nowMs, opts.thresholds, usageMaxAgeMs);

  if (!opts.enabled) {
    return { kind: 'skipped', reason: 'disabled', debug };
  }

  const winner = selectBestRotationCandidateWithMaxAge(snap, nowMs, opts.thresholds, usageMaxAgeMs);
  const active = summariseActive(snap);

  if (opts.dryRun) {
    let would: 'rotate' | 'noop' | 'skipped';
    if (!winner) would = 'skipped';
    else if (active && active.keyId === winner.keyId) would = 'noop';
    else would = 'rotate';
    return { kind: 'dry-run', would, from: active, to: winner, debug };
  }

  if (!winner) {
    return { kind: 'skipped', reason: 'no-candidate', debug };
  }

  if (active && active.keyId === winner.keyId) {
    return { kind: 'noop', reason: 'active-is-best', active, debug };
  }

  // Lease guard pre-check on the snapshot — fast-path skip without paying
  // a CAS round-trip. The CAS predicate re-checks under lock.
  if (active) {
    const activeState = snap.state[active.keyId];
    if (activeState && activeState.activeLeases.length > 0) {
      return { kind: 'skipped', reason: 'active-lease', debug };
    }
  }

  const precondition = makeRotationPrecondition(opts.thresholds, usageMaxAgeMs, nowMs);
  const apply = await deps.applyTokenIfActiveMatches(winner.keyId, active?.keyId, precondition);
  if (apply.rotated) {
    return { kind: 'rotated', from: active, to: winner, debug };
  }
  if (apply.reason === 'active-changed') {
    return { kind: 'skipped', reason: 'race-active-changed', debug };
  }
  if (apply.reason === 'precondition-failed') {
    return { kind: 'skipped', reason: 'race-precondition-failed', debug };
  }
  // 'unknown-key' / 'api-key-not-selectable' — should be impossible given
  // we just selected this candidate from the same snapshot. Treat as a
  // race (slot deleted concurrently) and skip with the closest reason.
  return { kind: 'skipped', reason: 'race-precondition-failed', debug };
}
