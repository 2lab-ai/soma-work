/**
 * Dashboard "New task" (SSOT 2026-10-23 T3) — battery inputs from both pools,
 * and the TTL cache the context provider reads them (and channel membership)
 * through.
 */
import { describe, expect, it, vi } from 'vitest';
import { computeModelBattery } from '../new-task';
import { cctSlotsToUsage, createTtlCache, llmuxAccountsToUsage } from '../new-task-usage';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const w = (utilization: number, resetsIn = 3600) => ({
  utilization,
  resets_at: NOW_S + resetsIn,
  resets_in_secs: resetsIn,
});

describe('llmuxAccountsToUsage', () => {
  const account = (over: Record<string, unknown> = {}) =>
    ({
      name: 'a',
      type: 'oauth',
      group: 'claude',
      status: 'ok',
      order: 1,
      five_hour: w(0.2),
      seven_day: w(0.5, 86_400),
      scoped_limits: [{ ...w(0.7, 86_400), scope_label: 'Opus' }],
      ...over,
    }) as any;

  it('maps 5h / 7d / model-scoped windows to remaining ratios with their resets', () => {
    const [view] = llmuxAccountsToUsage([account()], NOW_MS);
    expect(view.group).toBe('claude');
    expect(view.windows).toEqual([
      { label: '5h', remaining: 0.8, resetsAt: NOW_S + 3600 },
      { label: '7d', remaining: 0.5, resetsAt: NOW_S + 86_400 },
      { label: '7d-opus', remaining: expect.closeTo(0.3, 5), resetsAt: NOW_S + 86_400 },
    ]);
    expect(view.unavailable).toBe(false);
    // The opus window binds opus only.
    expect(computeModelBattery('claude-opus-5-5[1m]', [view]).level).toBeCloseTo(0.3);
    expect(computeModelBattery('claude-sonnet-4-6', [view]).level).toBeCloseTo(0.5);
  });

  it('leaves out blocked, auth-failed and API-key accounts; cooldown counts as unavailable', () => {
    const views = llmuxAccountsToUsage(
      [
        account({ name: 'blocked', blocked: 'manual' }),
        account({ name: 'failed', status: 'auth_failed' }),
        account({ name: 'key', type: 'apikey' }),
        account({ name: 'cool', status: 'cooldown' }),
      ],
      NOW_MS,
    );
    expect(views).toHaveLength(1);
    expect(views[0].unavailable).toBe(true);
  });

  it('a window without data stays unmeasured', () => {
    const [view] = llmuxAccountsToUsage([account({ five_hour: null, seven_day: null, scoped_limits: [] })], NOW_MS);
    expect(view.windows.every((x) => x.remaining === undefined)).toBe(true);
  });
});

describe('cctSlotsToUsage', () => {
  const slot = (over: Record<string, unknown> = {}) =>
    ({
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(NOW_MS).toISOString(),
        fiveHour: { utilization: 25, resetsAt: new Date(NOW_MS + 3_600_000).toISOString() },
        sevenDay: { utilization: 60, resetsAt: new Date(NOW_MS + 86_400_000).toISOString() },
        sevenDaySonnet: { utilization: 10, resetsAt: new Date(NOW_MS + 86_400_000).toISOString() },
      },
      ...over,
    }) as any;

  it('turns percent utilization into remaining ratios for the Claude pool', () => {
    const [view] = cctSlotsToUsage([slot()], NOW_MS);
    expect(view.group).toBe('claude');
    expect(view.windows).toEqual([
      { label: '5h', remaining: 0.75, resetsAt: NOW_S + 3600 },
      { label: '7d', remaining: 0.4, resetsAt: NOW_S + 86_400 },
      { label: '7d-sonnet', remaining: 0.9, resetsAt: NOW_S + 86_400 },
    ]);
  });

  it('skips tombstoned / unhealthy slots and marks a cooling slot unavailable', () => {
    const views = cctSlotsToUsage(
      [
        slot({ tombstoned: true }),
        slot({ authState: 'revoked' }),
        slot({ cooldownUntil: new Date(NOW_MS + 60_000).toISOString() }),
      ],
      NOW_MS,
    );
    expect(views).toHaveLength(1);
    expect(views[0].unavailable).toBe(true);
  });
});

describe('createTtlCache', () => {
  it('serves a cached value within the TTL, reloads after it, and on `fresh`', async () => {
    let now = 0;
    const load = vi.fn(async (k: string) => `${k}-${load.mock.calls.length}`);
    const cache = createTtlCache(load, 1000, () => now);
    expect(await cache.get('U1')).toBe('U1-1');
    expect(await cache.get('U1')).toBe('U1-1');
    expect(await cache.get('U1', { fresh: true })).toBe('U1-2');
    now = 2000;
    expect(await cache.get('U1')).toBe('U1-3');
  });

  it('does not cache a failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('slack down')).mockResolvedValueOnce('ok');
    const cache = createTtlCache(load, 1000);
    await expect(cache.get('U1')).rejects.toThrow('slack down');
    expect(await cache.get('U1')).toBe('ok');
  });
});
