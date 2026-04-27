import { describe, expect, it, vi } from 'vitest';
import type { AuthKey } from '../../auth/auth-key';
import type { CctStoreSnapshot, SlotState, UsageSnapshot } from '../../cct-store/types';
import {
  buildRotationDebug,
  evaluateAndMaybeRotate,
  type RotationDeps,
  type RotationThresholds,
  selectBestRotationCandidate,
} from '../auto-rotate';

const T: RotationThresholds = { fiveHourMax: 0.8, sevenDayMax: 0.9 };

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

function usage(fiveHour: number, sevenDay: number, sevenDayResetsAt: string): UsageSnapshot {
  return {
    fetchedAt: '2026-04-27T00:00:00Z',
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
    const s = snap([apiKey('k1', 'k1')], { k1: state({ usage: usage(0.1, 0.2, '2026-04-30T00:00:00Z') }) });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('rejects slots with no usage data (cannot evaluate)', () => {
    const s = snap([cct('a', 'A')], { a: state() });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('rejects slots above the 5h threshold (>0.8)', () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(0.9, 0.5, '2026-04-30T00:00:00Z') }) });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('rejects slots above the 7d threshold (>0.9)', () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(0.5, 0.95, '2026-04-30T00:00:00Z') }) });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('accepts slots exactly at the threshold (inclusive bounds)', () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(0.8, 0.9, '2026-04-30T00:00:00Z') }) });
    const c = selectBestRotationCandidate(s, NOW, T);
    expect(c?.keyId).toBe('a');
  });

  it('rejects slots in active cooldown', () => {
    const s = snap([cct('a', 'A')], {
      a: state({
        cooldownUntil: '2026-04-27T04:00:00Z', // future
        usage: usage(0.1, 0.2, '2026-04-30T00:00:00Z'),
      }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('accepts slots whose cooldown has already expired', () => {
    const s = snap([cct('a', 'A')], {
      a: state({
        cooldownUntil: '2026-04-27T02:00:00Z', // past
        usage: usage(0.1, 0.2, '2026-04-30T00:00:00Z'),
      }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)?.keyId).toBe('a');
  });

  it('rejects slots with disableRotation=true', () => {
    const s = snap([cct('a', 'A', { disableRotation: true } as Partial<AuthKey>)], {
      a: state({ usage: usage(0.1, 0.2, '2026-04-30T00:00:00Z') }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('rejects tombstoned and unhealthy slots', () => {
    const s = snap([cct('a', 'A'), cct('b', 'B')], {
      a: state({ tombstoned: true, usage: usage(0.1, 0.2, '2026-04-30T00:00:00Z') }),
      b: state({ authState: 'refresh_failed', usage: usage(0.1, 0.2, '2026-04-30T00:00:00Z') }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });

  it('picks the slot with the soonest 7d resetsAt', () => {
    const s = snap([cct('a', 'A'), cct('b', 'B'), cct('c', 'C')], {
      a: state({ usage: usage(0.5, 0.5, '2026-05-01T00:00:00Z') }),
      b: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }), // soonest
      c: state({ usage: usage(0.5, 0.5, '2026-04-30T00:00:00Z') }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)?.keyId).toBe('b');
  });

  it('tie-break 1: equal resetsAt → lower 5h utilisation wins', () => {
    const s = snap([cct('a', 'A'), cct('b', 'B')], {
      a: state({ usage: usage(0.6, 0.5, '2026-04-28T00:00:00Z') }),
      b: state({ usage: usage(0.3, 0.5, '2026-04-28T00:00:00Z') }), // lower 5h
    });
    expect(selectBestRotationCandidate(s, NOW, T)?.keyId).toBe('b');
  });

  it('tie-break 2: equal resetsAt + equal 5h → keyId lex order wins (deterministic)', () => {
    const s = snap([cct('z', 'Z'), cct('a', 'A')], {
      z: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }),
      a: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }),
    });
    expect(selectBestRotationCandidate(s, NOW, T)?.keyId).toBe('a');
  });

  it('rejects slots with non-finite resetsAt', () => {
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(0.1, 0.2, 'not-a-date') }) });
    expect(selectBestRotationCandidate(s, NOW, T)).toBeNull();
  });
});

describe('buildRotationDebug (#737)', () => {
  it('reports both candidates and rejection reasons in one pass', () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B'), apiKey('c', 'C')],
      {
        a: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }), // candidate
        b: state({ usage: usage(0.95, 0.5, '2026-04-28T00:00:00Z') }), // over 5h
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
});

describe('evaluateAndMaybeRotate (#737)', () => {
  function deps(initial: CctStoreSnapshot): RotationDeps & { applied: string[] } {
    let current = initial;
    const applied: string[] = [];
    return {
      loadSnapshot: async () => current,
      applyToken: async (keyId) => {
        applied.push(keyId);
        current = { ...current, registry: { ...current.registry, activeKeyId: keyId } };
      },
      applied,
    };
  }

  it('rotates when winner differs from active', async () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(0.5, 0.5, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }), // soonest
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
        a: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }), // soonest = active
        b: state({ usage: usage(0.5, 0.5, '2026-05-01T00:00:00Z') }),
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
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(0.95, 0.95, '2026-04-28T00:00:00Z') }) }, 'a');
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
          usage: usage(0.5, 0.5, '2026-05-01T00:00:00Z'),
        }),
        b: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }),
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
        a: state({ usage: usage(0.5, 0.5, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }),
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

  it('dry-run reports `would: rotate` without calling applyToken', async () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(0.5, 0.5, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }),
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
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }) }, 'a');
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
        a: state({ usage: usage(0.5, 0.5, '2026-05-01T00:00:00Z') }), // active, no lease
        b: state({
          activeLeases: [lease], // candidate has lease — irrelevant
          usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z'),
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
      { a: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }) },
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
    const s = snap([cct('a', 'A')], { a: state({ usage: usage(0.5, 0.5, '2030-01-01T00:00:00Z') }) }, 'a');
    const d = deps(s);
    const r = await evaluateAndMaybeRotate(d, { enabled: true, dryRun: false, thresholds: T });
    expect(r.kind).toBe('noop');
  });

  it('applyToken errors propagate (caller — onAfterTick — wraps in try/catch)', async () => {
    const s = snap(
      [cct('a', 'A'), cct('b', 'B')],
      {
        a: state({ usage: usage(0.5, 0.5, '2026-05-01T00:00:00Z') }),
        b: state({ usage: usage(0.5, 0.5, '2026-04-28T00:00:00Z') }),
      },
      'a',
    );
    const failingDeps: RotationDeps = {
      loadSnapshot: async () => s,
      applyToken: vi.fn(async () => {
        throw new Error('CAS conflict');
      }),
    };
    await expect(
      evaluateAndMaybeRotate(failingDeps, { enabled: true, dryRun: false, thresholds: T, now: () => NOW }),
    ).rejects.toThrow('CAS conflict');
  });
});
