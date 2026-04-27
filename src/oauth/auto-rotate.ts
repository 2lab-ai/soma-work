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
 * Policy (locked by issue #737):
 *   - Eligibility: `kind === 'cct'` AND `!disableRotation` AND
 *     `state.authState === 'healthy'` AND not tombstoned AND not in
 *     cooldown AND usage snapshot present (both 5h + 7d windows) AND
 *     `fiveHour.utilization ≤ fiveHourMax` AND `sevenDay.utilization ≤ sevenDayMax`.
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
  /** 0..1, inclusive upper bound on `usage.fiveHour.utilization`. */
  fiveHourMax: number;
  /** 0..1, inclusive upper bound on `usage.sevenDay.utilization`. */
  sevenDayMax: number;
}

export interface RotationCandidate {
  keyId: string;
  name: string;
  /** ISO string from `usage.sevenDay.resetsAt`. */
  sevenDayResetsAt: string;
  /** Epoch ms parsed from `sevenDayResetsAt` (for downstream comparison without re-parsing). */
  sevenDayResetsAtMs: number;
  fiveHourUtilization: number;
  sevenDayUtilization: number;
}

/** Reason an otherwise-CCT slot was rejected. Useful for debug logs. */
export type RejectReason =
  | 'not-cct'
  | 'disable-rotation'
  | 'tombstoned'
  | 'auth-unhealthy'
  | 'cooldown'
  | 'no-usage'
  | 'no-five-hour-window'
  | 'no-seven-day-window'
  | 'over-five-hour-threshold'
  | 'over-seven-day-threshold'
  | 'invalid-resets-at';

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
  if (!usage.fiveHour) return { slot, reject: 'no-five-hour-window' };
  if (!usage.sevenDay) return { slot, reject: 'no-seven-day-window' };

  if (usage.fiveHour.utilization > thresholds.fiveHourMax) {
    return { slot, reject: 'over-five-hour-threshold' };
  }
  if (usage.sevenDay.utilization > thresholds.sevenDayMax) {
    return { slot, reject: 'over-seven-day-threshold' };
  }

  const resetsAtMs = new Date(usage.sevenDay.resetsAt).getTime();
  if (!Number.isFinite(resetsAtMs)) return { slot, reject: 'invalid-resets-at' };

  return {
    slot,
    candidate: {
      keyId: slot.keyId,
      name: slot.name,
      sevenDayResetsAt: usage.sevenDay.resetsAt,
      sevenDayResetsAtMs: resetsAtMs,
      fiveHourUtilization: usage.fiveHour.utilization,
      sevenDayUtilization: usage.sevenDay.utilization,
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
  const candidates: RotationCandidate[] = [];
  for (const slot of snap.registry.slots) {
    const ev = evaluateSlot(slot, snap.state[slot.keyId], nowMs, thresholds);
    if (ev.candidate) candidates.push(ev.candidate);
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
): RotationDebug {
  const candidates: RotationCandidate[] = [];
  const rejected: RotationDebug['rejected'] = [];
  for (const slot of snap.registry.slots) {
    const ev = evaluateSlot(slot, snap.state[slot.keyId], nowMs, thresholds);
    if (ev.candidate) {
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
  | { kind: 'skipped'; reason: 'active-lease' | 'no-candidate' | 'disabled'; debug: RotationDebug }
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
  /** Defaults to `Date.now()`. Tests pass a fixed clock. */
  now?: () => number;
}

export interface RotationDeps {
  /** Authoritative snapshot read. Wired to `tm.getSnapshot()` in production. */
  loadSnapshot: () => Promise<CctStoreSnapshot>;
  /** Apply the chosen slot. Wired to `tm.applyToken(keyId)` in production. */
  applyToken: (keyId: string) => Promise<void>;
}

/**
 * Run one auto-rotation evaluation cycle. Safe to call concurrently —
 * `applyToken` itself uses CAS, so a racing call simply re-reads the
 * snapshot and decides again.
 */
export async function evaluateAndMaybeRotate(
  deps: RotationDeps,
  opts: EvaluateAndRotateOpts,
): Promise<RotationOutcome> {
  const nowMs = (opts.now ?? Date.now)();
  const snap = await deps.loadSnapshot();
  const debug = buildRotationDebug(snap, nowMs, opts.thresholds);

  if (!opts.enabled) {
    return { kind: 'skipped', reason: 'disabled', debug };
  }

  const winner = selectBestRotationCandidate(snap, nowMs, opts.thresholds);
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

  // Lease guard: only the *current* active slot's leases block rotation.
  // Candidate slots may carry their own historical leases (from a prior
  // rotation) — those don't matter; `applyToken` doesn't drain leases on
  // the new slot, only flips the activeKeyId pointer.
  if (active) {
    const activeState = snap.state[active.keyId];
    if (activeState && activeState.activeLeases.length > 0) {
      return { kind: 'skipped', reason: 'active-lease', debug };
    }
  }

  await deps.applyToken(winner.keyId);
  return { kind: 'rotated', from: active, to: winner, debug };
}
