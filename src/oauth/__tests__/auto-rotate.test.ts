import { describe, expect, it, vi } from 'vitest';
import type { AuthKey } from '../../auth/auth-key';
import type { CctStoreSnapshot, SlotState, UsageSnapshot } from '../../cct-store/types';
import {
  buildRotationDebug,
  evaluateAndMaybeRotate,
  type RotationApplyResult,
  type RotationDeps,
  type RotationThresholds,
  selectBestRotationCandidate,
  selectBestRotationCandidateWithMaxAge,
} from '../auto-rotate';

// Thresholds are in store-SSOT percent form (0..100, see #685/#781).
// `config.ts` converts the operator-facing 0..1 env vars at the boundary.
const T: RotationThresholds = { fiveHourMax: 80, sevenDayMax: 90 };

function cct(keyId: string, name: string, opts: Partial<AuthKey> = {}): AuthKey {
  return {
    kind: 'cct',
    source: 'setup',
    keyId,
    name,
    setupToken: `sk-ant-oat01-${keyId}`,
    createdAt: '2026-04-01T00:00:00Z',
    ...opts,
  } as AuthKey;
}

function apiKey(keyId: string, name: string): AuthKey {
  return {
    kind: 'api_key',
    keyId,
    name,
    value: `sk-ant-api03-${keyId}`,
    createdAt: '2026-04-01T00:00:00Z',
  };
}

function usage(
  fiveHour: number,
  sevenDay: number,
  sevenDayResetsAt: string,
  fetchedAt = '2026-04-27T03:00:00Z',
): UsageSnapshot {
  return {
    fetchedAt,
    fiveHour: { utilization: fiveHour, resetsAt: '2026-04-27T05:00:00Z' },
    sevenDay: { utilization: sevenDay, resetsAt: sevenDayResetsAt },
  };
}

function state(overrides: Partial<SlotState> = {}): SlotState {
  return {
    authState: 'healthy',
    activeLeases: [],
    ...overrides,
  };
}

function snap(slots: AuthKey[], states: Record<string, SlotState>, activeKeyId?: string): CctStoreSnapshot {
  return {
    version: 2,
    revision: 1,
    registry: { slots, ...(activeKeyId ? { activeKeyId } : {}) },
    state: states,
  };
}

const NOW = new Date('2026-04-27T03:00:00Z').getTime();

describe('selectBestRotationCandidate (#737)', () => {
  it('returns null when no slots exist', () => {
    expect(selectBestRotationCandidate(snap([], {}), NOW, T)).toBeNull();
  });

  it('returns null when only api_key slots exist', () => {
    const s = snap([apiKey('k1', 'k1')], { k1: state({ usage: usage(10, 20, '2026-04-30T00:00:00Z') }) });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('rejects slots with no usage data (cannot evaluate)', () => {
    const s = snap([cct('a', 'A')], { a: state() });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('rejects slots above the 5h threshold (>80)', () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(90, 50, '2026-04-30T00:00:00Z') }) });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('rejects slots above the 7d threshold (>90)', () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(50, 95, '2026-04-30T00:00:00Z') }) });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('accepts slots exactly at the threshold (inclusive bounds)', () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(80, 90, '2026-04-30T00:00:00Z') }) });
    const c = selectBestRotationCandidate(s, NOW, T);
    expect(c?.keyId).toBe('a');
  });

  it('rejects slots in active cooldown', () => {
    const s = snap([cct('a', 'A')], {
      a: state({
        cooldownUntil: '2026-04-27T04:00:00Z', // future
        usage: usage(10, 20, '2026-04-30T00:00:00Z'),
      }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('accepts slots whose cooldown has already expired', () => {
    const s = snap([cct('a', 'A')], {
      a: state({
        cooldownUntil: '2026-04-27T02:00:00Z', // past
        usage: usage(10, 20, '2026-04-30T00:00:00Z'),
      }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)?.keyId).toBe('a');
  });

  it('rejects slots with disableRotation=true', () => {
    const s = snap([cct('a', 'A', { disableRotation: true } as Partial<AuthKey>)], {
      a: state({ usage: usage(10, 20, '2026-04-30T00:00:00Z') }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('rejects tombstoned and unhealthy slots', () => {
    const s = snap([cct('a', 'A'), cct('b', 'B')], {
      a: state({ tombstoned: true, usage: usage(10, 20, '2026-04-30T00:00:00Z') }),
      b: state({ authState: 'refresh_failed', usage: usage(10, 20, '2026-04-30T00:00:00Z') }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('picks the slot with the soonest 7d resetsAt', () => {
    const s = snap([cct('a', 'A'), cct('b', 'B'), cct('c', 'C')], {
      a: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }),
      b: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }), // soonest
      c: state({ usage: usage(50, 50, '2026-04-30T00:00:00Z') }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)?.keyId).toBe('b');
  });

  it('tie-break 1: equal resetsAt → lower 5h utilisation wins', () => {
    const s = snap([cct('a', 'A'), cct('b', 'B')], {
      a: state({ usage: usage(60, 50, '2026-04-28T00:00:00Z') }),
      b: state({ usage: usage(30, 50, '2026-04-28T00:00:00Z') }), // lower 5h
    });
    expect(selectBestRotationCandidate(s, NOW, T)?.keyId).toBe('b');
  });

  it('tie-break 2: equal resetsAt + equal 5h → keyId lex order wins (deterministic)', () => {
    const s = snap([cct('z', 'Z'), cct('a', 'A')], {
      z: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }),
      a: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)?.keyId).toBe('a');
  });

  it('rejects slots with non-finite resetsAt', () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(10, 20, 'not-a-date') }) });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('candidate carries fetchedAtMs from usage.fetchedAt', () => {
    const s = snap([cct('a', 'A')], {
      a: state({ usage: usage(10, 20, '2026-04-30T00:00:00Z', '2026-04-27T02:50:00Z') }),
    });
    const c = selectBestRotationCandidate(s, NOW, T);
    expect(c?.fetchedAtMs).toBe(new Date('2026-04-27T02:50:00Z').getTime());
  });

  // ── #781 percent-form unit regression guards ──────────────────────────
  // Pin the store-SSOT percent contract that the engine, renderers, and
  // config boundary all share (#685 → #781). The pre-fix code interpreted
  // `usage.*.utilization` as a 0..1 fraction while the store wrote 0..100,
  // so every realistic percent (3..63) tripped the "> 0.8" comparator and
  // every slot got rejected as `over-five-hour-threshold` — auto-rotate
  // never produced a successful rotation in production. These three tests
  // lock the percent contract end-to-end on the pure selector.

  it('regression #781: realistic percent-form value (63) under threshold (80) → accepts (was the production failure case)', () => {
    // The exact production observation: `notify` at 63% with `fiveHourMax=80`
    // was being rejected as `over-five-hour-threshold` because the engine
    // compared 63 against the unconverted env value 0.8.
    const s = snap([cct('notify', 'notify')], {
      notify: state({ usage: usage(63, 33, '2026-04-30T00:00:00Z') }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)?.keyId).toBe('notify');
  });

  it('regression #781: percent-form value (85) above threshold (80) → rejects', () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(85, 50, '2026-04-30T00:00:00Z') }) });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('regression #781: cold-token (no fiveHour window) with valid sevenDay → accepts as fiveHourUtilization=0', () => {
    // Mirrors the production `ai` slot case from issue #781 — a slot that
    // has never had a 5h-window request returns no `fiveHour` window from
    // /oauth/usage. The pre-fix code rejected this as
    // `'no-five-hour-window'`; the new contract treats it as cold ⇒ 0%
    // ⇒ under any threshold ⇒ eligible.
    const cold: UsageSnapshot = {
      fetchedAt: '2026-04-27T03:00:00Z',
      // five_hour intentionally omitted
      sevenDay: { utilization: 5, resetsAt: '2026-04-30T00:00:00Z' },
    };
    const s = snap([cct('ai', 'ai')], { ai: state({ usage: cold }) });
    const c = selectBestRotationCandidate(s, NOW, T);
    expect(c?.keyId).toBe('ai');
    expect(c?.fiveHourUtilization).toBe(0);
  });
});

describe('selectBestRotationCandidateWithMaxAge (#737 P1)', () => {
  it('rejects candidate whose usage is older than usageMaxAgeMs', () => {
    // fetchedAt at NOW - 2h; usageMaxAgeMs = 1h → reject.
    const stale = '2026-04-27T01:00:00Z';
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(10, 20, '2026-04-30T00:00:00Z', stale) }) });
    expect(selectBestRotationCandidateWithMaxAge(s, NOW, T, 60 * 60_000)).toBeNull();
  });

  it('accepts candidate whose usage is fresher than usageMaxAgeMs', () => {
    // fetchedAt at NOW - 30min; usageMaxAgeMs = 1h → accept.
    const fresh = '2026-04-27T02:30:00Z';
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(10, 20, '2026-04-30T00:00:00Z', fresh) }) });
    expect(selectBestRotationCandidateWithMaxAge(s, NOW, T, 60 * 60_000)?.keyId).toBe('a');
  });

  it('Infinity disables the max-age filter (parity with selectBestRotationCandidate)', () => {
    const ancient = '2024-01-01T00:00:00Z';
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(10, 20, '2026-04-30T00:00:00Z', ancient) }) });
    expect(selectBestRotationCandidateWithMaxAge(s, NOW, T, Number.POSITIVE_INFINITY)?.keyId).toBe('a');
  });
});

describe('buildRotationDebug (#737)', () => {
  it('reports both candidates and rejection reasons in one pass', () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B'), apiKey('c', 'C')],
      {
        a: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }), // candidate
        b: state({ usage: usage(95, 50, '2026-04-28T00:00:00Z') }), // over 5h
      },
      'a',
    );
    const dbg = buildRotationDebug(s, NOW, T);
    expect(dbg.activeKeyId).toBe('a');
    expect(dbg.candidates).toHaveLength(1);
    expect(dbg.candidates[0].keyId).toBe('a');
    const rejectMap = Object.fromEntries(dbg.rejected.map((r) => [r.keyId, r.reason]));
    expect(rejectMap.b).toBe('over-five-hour-threshold');
    expect(rejectMap.c).toBe('not-cct');
  });

  it('reports usage-stale rejection when usageMaxAgeMs cuts a candidate', () => {
    const stale = '2026-04-27T01:00:00Z';
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z', stale) }) }, 'a');
    const dbg = buildRotationDebug(s, NOW, T, 60 * 60_000);
    expect(dbg.candidates).toHaveLength(0);
    expect(dbg.rejected[0]?.reason).toBe('usage-stale');
  });
});

describe('evaluateAndMaybeRotate (#737)', () => {
  /**
   * Test deps that simulate the production CAS commit primitive.
   * `applyTokenIfActiveMatches` mirrors `TokenManager.applyTokenIfActiveMatches`:
   *   - Verifies expectedFromKeyId matches current activeKeyId
   *   - Runs precondition against current state
   *   - On success, mutates the in-memory snapshot
   */
  function deps(initial: CctStoreSnapshot): RotationDeps & { applied: string[] } {
    let current = initial;
    const applied: string[] = [];
    return {
      loadSnapshot: async () => current,
      applyTokenIfActiveMatches: async (target, expected, precondition): Promise<RotationApplyResult> => {
        if (current.registry.activeKeyId !== expected) {
          return { rotated: false, reason: 'active-changed' };
        }
        const slot = current.registry.slots.find((s) => s.keyId === target);
        if (!slot) return { rotated: false, reason: 'unknown-key' };
        if (slot.kind === 'api_key') return { rotated: false, reason: 'api-key-not-selectable' };
        const targetState = current.state[target];
        const activeState = expected ? current.state[expected] : undefined;
        if (!precondition(current, slot, targetState, activeState)) {
          return { rotated: false, reason: 'precondition-failed' };
        }
        applied.push(target);
        current = { ...current, registry: { ...current.registry, activeKeyId: target } };
        return { rotated: true };
      },
      applied,
    };
  }

  it('rotates when winner differs from active', async () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }), // soonest
      },
      'a',
    );
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('rotated');
    if (r.kind === 'rotated') {
      expect(r.from?.keyId).toBe('a');
      expect(r.to.keyId).toBe('b');
    }
    expect(d.applied).toEqual(['b']);
  });

  it('no-ops when active is already the best candidate (no DB write, no notify intent)', async () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }), // soonest = active
        b: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }),
      },
      'a',
    );
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('noop');
    expect(d.applied).toEqual([]);
  });

  it('skipped when no candidate meets the eligibility filter', async () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(95, 95, '2026-04-28T00:00:00Z') }) }, 'a');
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toBe('no-candidate');
    expect(d.applied).toEqual([]);
  });

  it('skipped when active slot has any in-flight lease (lease guard)', async () => {
    const lease = {
      leaseId: 'lease-1',
      ownerTag: 'stream-executor:C123:1234567890.123',
      acquiredAt: '2026-04-27T02:55:00Z',
      expiresAt: '2026-04-27T03:10:00Z',
    };
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({
          activeLeases: [lease],
          usage: usage(50, 50, '2026-05-01T00:00:00Z'),
        }),
        b: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }),
      },
      'a',
    );
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toBe('active-lease');
    expect(d.applied).toEqual([]);
  });

  it('skipped when explicitly disabled', async () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }),
      },
      'a',
    );
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: false,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toBe('disabled');
    expect(d.applied).toEqual([]);
  });

  it('dry-run reports `would: rotate` without calling applyTokenIfActiveMatches', async () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }),
      },
      'a',
    );
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: true,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('dry-run');
    if (r.kind === 'dry-run') {
      expect(r.would).toBe('rotate');
      expect(r.to?.keyId).toBe('b');
    }
    expect(d.applied).toEqual([]);
  });

  it('dry-run reports `would: noop` when active is already best', async () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }) }, 'a');
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: true,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('dry-run');
    if (r.kind === 'dry-run') expect(r.would).toBe('noop');
  });

  it('candidate slot with own lease does NOT block rotation (only active leases matter)', async () => {
    const lease = {
      leaseId: 'old-lease',
      ownerTag: 'stream-executor:C123:1234567890.123',
      acquiredAt: '2026-04-27T02:55:00Z',
      expiresAt: '2026-04-27T03:10:00Z',
    };
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }), // active, no lease
        b: state({
          activeLeases: [lease], // candidate has lease — irrelevant
          usage: usage(50, 50, '2026-04-28T00:00:00Z'),
        }),
      },
      'a',
    );
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('rotated');
    expect(d.applied).toEqual(['b']);
  });

  it('handles snapshot with no activeKeyId (first-boot case): rotates to first eligible', async () => {
    const s = snap(
      [cct('a', 'A')],
      { a: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }) },
      // no activeKeyId
    );
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('rotated');
    if (r.kind === 'rotated') expect(r.from).toBeNull();
    expect(d.applied).toEqual(['a']);
  });

  it('uses Date.now() when `now` not provided (smoke test — does not throw)', async () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(50, 50, '2030-01-01T00:00:00Z') }) }, 'a');
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, { enabled: true, dryRun: false, thresholds: T });
    expect(r.kind).toBe('noop');
  });

  it('applyTokenIfActiveMatches errors propagate (caller — onAfterTick — wraps in try/catch)', async () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }),
      },
      'a',
    );
    const failingDeps: RotationDeps = {
      loadSnapshot: async () => s,
      applyTokenIfActiveMatches: vi.fn(async () => {
        throw new Error('CAS conflict');
      }),
    };
    await expect(
      evaluateAndMaybeRotate(failingDeps, { enabled: true, dryRun: false, thresholds: T, now: () => NOW }),
    ).rejects.toThrow('CAS conflict');
  });

  // ── #737 P0 race window — TOCTOU between snapshot read and applyToken commit ──

  it('TOCTOU: lease appears between snapshot read and CAS → race-precondition-failed', async () => {
    // Snapshot says active 'a' has 0 leases. By the time CAS runs, a new
    // lease has arrived. Production deps call the predicate against the
    // authoritative snapshot inside store.mutate — the test deps simulate
    // this by checking `activeState.activeLeases.length === 0` at commit
    // time on a mutated copy.
    const lease = {
      leaseId: 'race-lease',
      ownerTag: 'stream-executor:C999:9999999999.999',
      acquiredAt: '2026-04-27T03:00:00.500Z',
      expiresAt: '2026-04-27T03:15:00Z',
    };
    const observedSnapshot = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }), // 0 leases at read time
        b: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }),
      },
      'a',
    );
    const csaSnapshot: CctStoreSnapshot = {
      ...observedSnapshot,
      state: {
        ...observedSnapshot.state,
        a: { ...observedSnapshot.state.a, activeLeases: [lease] }, // lease appeared by commit time
      },
    };
    const applied: string[] = [];
    const racingDeps: RotationDeps = {
      loadSnapshot: async () => observedSnapshot,
      applyTokenIfActiveMatches: async (target, expected, precondition) => {
        if (csaSnapshot.registry.activeKeyId !== expected) return { rotated: false, reason: 'active-changed' };
        const slot = csaSnapshot.registry.slots.find((s) => s.keyId === target);
        if (!slot || slot.kind === 'api_key') return { rotated: false, reason: 'unknown-key' };
        const targetState = csaSnapshot.state[target];
        const activeState = expected ? csaSnapshot.state[expected] : undefined;
        if (!precondition(csaSnapshot, slot, targetState, activeState)) {
          return { rotated: false, reason: 'precondition-failed' };
        }
        applied.push(target);
        return { rotated: true };
      },
    };
    const r = await evaluateAndMaybeRotate(racingDeps, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toBe('race-precondition-failed');
    expect(applied).toEqual([]);
    // Use observedSnapshot to silence the unused-binding linter — test
    // relies on csaSnapshot mutation, observedSnapshot is the seed.
    void observedSnapshot;
    void csaSnapshot;
  });

  it('TOCTOU: active changed under us → race-active-changed', async () => {
    const observed = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }),
      },
      'a',
    );
    const racingDeps: RotationDeps = {
      loadSnapshot: async () => observed,
      applyTokenIfActiveMatches: async (_target, expected) => {
        // Simulate another writer that flipped active to 'c' between
        // snapshot read and CAS.
        if (expected !== 'c') return { rotated: false, reason: 'active-changed' };
        return { rotated: true };
      },
    };
    const r = await evaluateAndMaybeRotate(racingDeps, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toBe('race-active-changed');
  });

  it('TOCTOU: target slot lost eligibility (cooldown) between read and CAS → race-precondition-failed', async () => {
    // Snapshot says 'b' is eligible. Between read and CAS, 'b' gets put
    // into cooldown by a rate-limit handler. The predicate must catch this.
    const observed = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z') }),
      },
      'a',
    );
    const csaState: Record<string, SlotState> = {
      ...observed.state,
      b: { ...observed.state.b, cooldownUntil: '2026-04-27T04:00:00Z' }, // cooldown appeared
    };
    const csa: CctStoreSnapshot = { ...observed, state: csaState };
    const applied: string[] = [];
    const racingDeps: RotationDeps = {
      loadSnapshot: async () => observed,
      applyTokenIfActiveMatches: async (target, expected, precondition) => {
        const slot = csa.registry.slots.find((s) => s.keyId === target);
        if (!slot) return { rotated: false, reason: 'unknown-key' };
        const targetState = csa.state[target];
        const activeState = expected ? csa.state[expected] : undefined;
        if (!precondition(csa, slot, targetState, activeState)) {
          return { rotated: false, reason: 'precondition-failed' };
        }
        applied.push(target);
        return { rotated: true };
      },
    };
    const r = await evaluateAndMaybeRotate(racingDeps, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
    });
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toBe('race-precondition-failed');
    expect(applied).toEqual([]);
  });

  it('usageMaxAgeMs: stale candidate is rejected → skipped no-candidate', async () => {
    // Stale = 2h old. With usageMaxAgeMs=1h, the only slot drops out of
    // the candidate pool → no-candidate.
    const stale = '2026-04-27T01:00:00Z';
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z', stale) }) }, 'a');
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
      usageMaxAgeMs: 60 * 60_000,
    });
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toBe('no-candidate');
    expect(d.applied).toEqual([]);
  });

  it('usageMaxAgeMs: fresh candidate alongside stale → fresh wins', async () => {
    const stale = '2026-04-27T01:00:00Z';
    const fresh = '2026-04-27T02:55:00Z';
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(50, 50, '2026-04-28T00:00:00Z', stale) }), // stale, would have won
        b: state({ usage: usage(50, 50, '2026-04-29T00:00:00Z', fresh) }), // fresh, later resetsAt but only candidate
      },
      'a',
    );
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, {
      enabled: true,
      dryRun: false,
      thresholds: T,
      now: () => NOW,
      usageMaxAgeMs: 60 * 60_000,
    });
    expect(r.kind).toBe('rotated');
    if (r.kind === 'rotated') expect(r.to.keyId).toBe('b');
    expect(d.applied).toEqual(['b']);
  });
});
