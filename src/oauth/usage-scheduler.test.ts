import { describe, expect, it, vi } from 'vitest';

// RED tests for the new boot-time usage refresher (#641 M1-S1).
// The module is created in src/oauth/usage-scheduler.ts and wired from
// src/index.ts + src/config.ts. Injectable clock allows deterministic
// fake-timer testing without Node's real setInterval.

import { startUsageRefreshScheduler, UsageRefreshScheduler, type UsageSchedulerOpts } from './usage-scheduler';

type Tick = () => void;

/**
 * Minimal fake clock for scheduler tests. Driver-owned — tests call
 * `fireTick()` to advance the scheduler one interval synchronously.
 */
function makeFakeClock(): {
  clock: NonNullable<UsageSchedulerOpts['clock']>;
  fireTick: () => void;
  cleared: number;
  intervalMs: () => number | undefined;
} {
  let storedFn: Tick | null = null;
  let storedMs: number | undefined;
  let cleared = 0;
  const clock: NonNullable<UsageSchedulerOpts['clock']> = {
    setInterval: (fn, ms) => {
      storedFn = fn;
      storedMs = ms;
      return { id: 'fake' } as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      cleared += 1;
      storedFn = null;
    },
  };
  return {
    clock,
    fireTick: () => {
      if (storedFn) storedFn();
    },
    get cleared() {
      return cleared;
    },
    intervalMs: () => storedMs,
  } as any;
}

function makeTm(overrides: Partial<Record<string, any>> = {}) {
  return {
    fetchUsageForAllAttached: vi.fn(async () => ({})),
    ...overrides,
  } as any;
}

describe('UsageRefreshScheduler (M1-S1)', () => {
  it('first tick calls tm.fetchUsageForAllAttached once with the configured timeoutMs', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const s = new UsageRefreshScheduler(tm, {
      intervalMs: 5 * 60_000,
      timeoutMs: 2_000,
      enabled: true,
      clock,
    });
    s.start();
    fireTick();
    // Drain microtasks so the tick's async fn resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(tm.fetchUsageForAllAttached).toHaveBeenCalledTimes(1);
    const args = tm.fetchUsageForAllAttached.mock.calls[0][0];
    expect(args).toEqual(expect.objectContaining({ timeoutMs: 2_000 }));
  });

  it('enabled:false → startUsageRefreshScheduler returns null and no tick happens', () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const scheduler = startUsageRefreshScheduler(tm, {
      intervalMs: 5 * 60_000,
      timeoutMs: 2_000,
      enabled: false,
      clock,
    });
    expect(scheduler).toBeNull();
    fireTick();
    expect(tm.fetchUsageForAllAttached).not.toHaveBeenCalled();
  });

  it('after stop() further fake ticks do not call tm.*', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const s = new UsageRefreshScheduler(tm, {
      intervalMs: 5 * 60_000,
      timeoutMs: 2_000,
      enabled: true,
      clock,
    });
    s.start();
    s.stop();
    // After stop, the fake clock has been told to clearInterval and the
    // stored tick reference is cleared — firing the driver is a no-op.
    fireTick();
    await Promise.resolve();
    expect(tm.fetchUsageForAllAttached).not.toHaveBeenCalled();
  });

  it('tick throwing does not stop the scheduler — next interval still calls tm.*', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm({
      // first call throws; second call resolves normally
      fetchUsageForAllAttached: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({}),
    });
    const s = new UsageRefreshScheduler(tm, {
      intervalMs: 5 * 60_000,
      timeoutMs: 2_000,
      enabled: true,
      clock,
    });
    s.start();
    fireTick();
    // Settle microtasks — the thrown rejection must be absorbed inside the scheduler.
    await new Promise((r) => setImmediate(r));
    // Second tick proceeds; scheduler keeps pumping.
    fireTick();
    await new Promise((r) => setImmediate(r));
    expect(tm.fetchUsageForAllAttached).toHaveBeenCalledTimes(2);
  });

  it('INVARIANT: scheduler tick never forwards force:true (Anthropic DDoS guard)', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const s = new UsageRefreshScheduler(tm, {
      intervalMs: 5 * 60_000,
      timeoutMs: 2_000,
      enabled: true,
      clock,
    });
    s.start();
    fireTick();
    await Promise.resolve();
    await Promise.resolve();
    const args = tm.fetchUsageForAllAttached.mock.calls[0][0];
    // The args object MUST NOT carry `force: true`. We accept either an
    // omission or an explicit `force: false` (defensive), but a scheduler
    // that passes force=true bypasses nextUsageFetchAllowedAt on every
    // attached slot and hammers Anthropic.
    expect(args?.force).not.toBe(true);
  });
});
