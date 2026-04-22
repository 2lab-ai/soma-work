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
  // Wrap set/clearInterval in vi.fn so tests can assert call-count directly
  // (e.g. `expect(clock.setInterval).not.toHaveBeenCalled()` when the
  // scheduler refuses to arm because `enabled: false`).
  const setIntervalFn = vi.fn((fn: Tick, ms: number) => {
    storedFn = fn;
    storedMs = ms;
    return { id: 'fake' } as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalFn = vi.fn(() => {
    cleared += 1;
    storedFn = null;
  });
  const clock: NonNullable<UsageSchedulerOpts['clock']> = {
    setInterval: setIntervalFn as unknown as NonNullable<UsageSchedulerOpts['clock']>['setInterval'],
    clearInterval: clearIntervalFn as unknown as NonNullable<UsageSchedulerOpts['clock']>['clearInterval'],
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
    // #644 review #6 — don't rely on a permissive `objectContaining` here:
    // assert the positive contract (timeoutMs is forwarded) AND the negative
    // contract (force is absent) at the first-tick boundary. The INVARIANT
    // test below re-asserts `not.toHaveProperty('force')` for documentation
    // weight; this one catches a regression at the most-run path.
    expect(args.timeoutMs).toBe(2_000);
    expect(args).not.toHaveProperty('force');
  });

  it('enabled:false → startUsageRefreshScheduler returns null, NEVER arms the interval, and no tick happens', () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const scheduler = startUsageRefreshScheduler(tm, {
      intervalMs: 5 * 60_000,
      timeoutMs: 2_000,
      enabled: false,
      clock,
    });
    expect(scheduler).toBeNull();
    // Stronger than checking the TM was never called: the scheduler must not
    // even arm the interval. A future refactor that returns null AFTER
    // calling clock.setInterval would leak a timer — this assertion catches
    // that at the boundary.
    expect(clock.setInterval).not.toHaveBeenCalled();
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

  it('INVARIANT: shutdown path stops scheduler BEFORE tokenManager (pump must not fire mid-teardown)', async () => {
    // The cleanup() function in src/index.ts is defined inline inside the
    // bootstrap IIFE and not exported — we cannot import and invoke it
    // directly without a prod-code refactor. Instead, we lock the ordering
    // by reading the source and asserting the textual pattern: the
    // `usageRefreshScheduler.stop()` call site MUST precede the
    // `tokenManager.stop()` call site inside cleanup. A refactor that
    // accidentally flips the order will be caught here.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
    const schedIdx = source.indexOf('usageRefreshScheduler.stop()');
    const tmIdx = source.indexOf('tokenManager.stop()');
    expect(schedIdx).toBeGreaterThan(-1);
    expect(tmIdx).toBeGreaterThan(-1);
    expect(schedIdx).toBeLessThan(tmIdx);
  });

  it('re-entrancy: overlapping ticks while a previous tick is pending still call tm.* (dedupe lives inside TM)', async () => {
    // Scheduler contract (see UsageRefreshScheduler docstring):
    //   "if a previous tick's async work has not yet resolved when the
    //    next interval fires, the scheduler simply kicks off another one
    //    — the TM already de-dupes per-keyId in-flight fetches via
    //    `usageFetchInFlight`."
    // Lock that behavior: the scheduler does NOT guard re-entry itself;
    // it pumps the TM on every tick and relies on the TM dedupe.
    const { clock, fireTick } = makeFakeClock();
    // Block the first fetch until we release it, so subsequent ticks
    // overlap in time.
    let release!: () => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = () => resolve({});
    });
    const tm = makeTm({
      fetchUsageForAllAttached: vi
        .fn()
        .mockImplementationOnce(() => pending)
        .mockResolvedValue({}),
    });
    const s = new UsageRefreshScheduler(tm, {
      intervalMs: 5 * 60_000,
      timeoutMs: 2_000,
      enabled: true,
      clock,
    });
    s.start();
    fireTick(); // tick 1 — will hang on `pending`
    fireTick(); // tick 2 — must not be suppressed
    fireTick(); // tick 3 — must not be suppressed
    await Promise.resolve();
    await Promise.resolve();
    // All three ticks reached the TM; dedupe is the TM's job, not the scheduler's.
    expect(tm.fetchUsageForAllAttached).toHaveBeenCalledTimes(3);
    release();
    await pending;
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
    // The args object MUST NOT carry `force` at all. Earlier the test also
    // accepted `force: false` as "defensive", but that's a footgun: a future
    // author reading the scheduler could read `force: false` as meaningful
    // and flip it to `force: true` to "fix" something. The scheduler contract
    // is simpler — never pass the key. A `force: true` would bypass every
    // slot's `nextUsageFetchAllowedAt` gate and hammer Anthropic.
    expect(args).not.toHaveProperty('force');
  });
});
