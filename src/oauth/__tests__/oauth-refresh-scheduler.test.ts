import { describe, expect, it, vi } from 'vitest';

// RED tests for the hourly OAuth token refresh scheduler (#653 M2).
// Module lives at src/oauth/oauth-refresh-scheduler.ts. Mirrors the
// UsageRefreshScheduler test pattern: injectable fake clock so the
// scheduler is deterministic under vi.fn timers without spinning
// real wall-clock time.

import {
  DEFAULT_OAUTH_REFRESH_INTERVAL_MS,
  DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
  OAuthRefreshScheduler,
  type OAuthRefreshSchedulerOpts,
  startOAuthRefreshScheduler,
} from '../oauth-refresh-scheduler';

type Tick = () => void;

function makeFakeClock(): {
  clock: NonNullable<OAuthRefreshSchedulerOpts['clock']>;
  fireTick: () => void;
  intervalMs: () => number | undefined;
} {
  let storedFn: Tick | null = null;
  let storedMs: number | undefined;
  const setIntervalFn = vi.fn((fn: Tick, ms: number) => {
    storedFn = fn;
    storedMs = ms;
    return { id: 'fake' } as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalFn = vi.fn(() => {
    storedFn = null;
  });
  const clock: NonNullable<OAuthRefreshSchedulerOpts['clock']> = {
    setInterval: setIntervalFn as unknown as NonNullable<OAuthRefreshSchedulerOpts['clock']>['setInterval'],
    clearInterval: clearIntervalFn as unknown as NonNullable<OAuthRefreshSchedulerOpts['clock']>['clearInterval'],
  };
  return {
    clock,
    fireTick: () => {
      if (storedFn) storedFn();
    },
    intervalMs: () => storedMs,
  };
}

function makeTm(overrides: Partial<Record<string, any>> = {}) {
  return {
    refreshAllAttachedOAuthTokens: vi.fn(async () => ({})),
    ...overrides,
  } as any;
}

describe('OAuthRefreshScheduler (#653 M2)', () => {
  it('DEFAULT_OAUTH_REFRESH_INTERVAL_MS is exactly 1 hour (user spec)', () => {
    // User explicitly called for "1 hour" cadence — lock the constant so
    // a future "I made it faster" commit can't silently drop to 5min
    // without a PR discussion.
    expect(DEFAULT_OAUTH_REFRESH_INTERVAL_MS).toBe(60 * 60 * 1_000);
  });

  it('first tick calls tm.refreshAllAttachedOAuthTokens once with the configured timeoutMs', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const s = new OAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      timeoutMs: 30_000,
      enabled: true,
      clock,
    });
    s.start();
    fireTick();
    await Promise.resolve();
    await Promise.resolve();
    expect(tm.refreshAllAttachedOAuthTokens).toHaveBeenCalledTimes(1);
    const args = tm.refreshAllAttachedOAuthTokens.mock.calls[0][0];
    expect(args.timeoutMs).toBe(30_000);
  });

  it('interval forwarded to setInterval matches the provided intervalMs', () => {
    const { clock, intervalMs } = makeFakeClock();
    const tm = makeTm();
    const s = new OAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      timeoutMs: 30_000,
      enabled: true,
      clock,
    });
    s.start();
    expect(intervalMs()).toBe(60 * 60_000);
  });

  it('enabled:false → factory returns null, never arms the interval, no tick', () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const scheduler = startOAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      timeoutMs: 30_000,
      enabled: false,
      clock,
    });
    expect(scheduler).toBeNull();
    expect(clock.setInterval).not.toHaveBeenCalled();
    fireTick();
    expect(tm.refreshAllAttachedOAuthTokens).not.toHaveBeenCalled();
  });

  it('after stop() further fake ticks do not call tm.*', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const s = new OAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      timeoutMs: 30_000,
      enabled: true,
      clock,
    });
    s.start();
    s.stop();
    fireTick();
    await Promise.resolve();
    expect(tm.refreshAllAttachedOAuthTokens).not.toHaveBeenCalled();
  });

  it('tick throwing does not stop the scheduler — next interval still calls tm.*', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm({
      refreshAllAttachedOAuthTokens: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({}),
    });
    const s = new OAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      timeoutMs: 30_000,
      enabled: true,
      clock,
    });
    s.start();
    fireTick();
    await new Promise((r) => setImmediate(r));
    fireTick();
    await new Promise((r) => setImmediate(r));
    expect(tm.refreshAllAttachedOAuthTokens).toHaveBeenCalledTimes(2);
  });

  it('re-entrancy: overlapping ticks still call tm.* (dedupe lives inside TM)', async () => {
    const { clock, fireTick } = makeFakeClock();
    let release!: () => void;
    const pending = new Promise<Record<string, 'ok' | 'error'>>((resolve) => {
      release = () => resolve({});
    });
    const tm = makeTm({
      refreshAllAttachedOAuthTokens: vi
        .fn()
        .mockImplementationOnce(() => pending)
        .mockResolvedValue({}),
    });
    const s = new OAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      timeoutMs: 30_000,
      enabled: true,
      clock,
    });
    s.start();
    fireTick();
    fireTick();
    fireTick();
    await Promise.resolve();
    await Promise.resolve();
    expect(tm.refreshAllAttachedOAuthTokens).toHaveBeenCalledTimes(3);
    release();
    await pending;
  });

  it('timeoutMs defaults to DEFAULT_OAUTH_REFRESH_TIMEOUT_MS when omitted', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const s = new OAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      enabled: true,
      clock,
    });
    s.start();
    fireTick();
    await Promise.resolve();
    await Promise.resolve();
    const args = tm.refreshAllAttachedOAuthTokens.mock.calls[0][0];
    expect(args.timeoutMs).toBe(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS);
  });

  it('INVARIANT: shutdown path stops OAuth scheduler BEFORE tokenManager (pump must not fire mid-teardown)', async () => {
    // Read the source of src/index.ts and lock the textual ordering.
    // Mirrors the usage-scheduler's own shutdown-order invariant test.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
    const schedIdx = source.indexOf('oauthRefreshScheduler.stop()');
    const tmIdx = source.indexOf('tokenManager.stop()');
    expect(schedIdx).toBeGreaterThan(-1);
    expect(tmIdx).toBeGreaterThan(-1);
    expect(schedIdx).toBeLessThan(tmIdx);
  });

  it('#737 onAfterTick fires after refresh fan-out resolves', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const order: string[] = [];
    tm.refreshAllAttachedOAuthTokens = vi.fn(async () => {
      order.push('refresh');
      return {};
    });
    const onAfter = vi.fn(async () => {
      order.push('after');
    });
    const s = new OAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      timeoutMs: 30_000,
      enabled: true,
      clock,
      onAfterTick: onAfter,
    });
    s.start();
    fireTick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onAfter).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['refresh', 'after']);
  });

  it('#737 onAfterTick still fires when the refresh fan-out throws', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm({
      refreshAllAttachedOAuthTokens: vi.fn().mockRejectedValueOnce(new Error('boom')),
    });
    const onAfter = vi.fn(async () => undefined);
    const s = new OAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      timeoutMs: 30_000,
      enabled: true,
      clock,
      onAfterTick: onAfter,
    });
    s.start();
    fireTick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  it('#737 onAfterTick throwing does not prevent the next tick from firing', async () => {
    const { clock, fireTick } = makeFakeClock();
    const tm = makeTm();
    const onAfter = vi.fn().mockRejectedValueOnce(new Error('hook boom')).mockResolvedValueOnce(undefined);
    const s = new OAuthRefreshScheduler(tm, {
      intervalMs: 60 * 60_000,
      timeoutMs: 30_000,
      enabled: true,
      clock,
      onAfterTick: onAfter,
    });
    s.start();
    fireTick();
    await new Promise((r) => setImmediate(r));
    fireTick();
    await new Promise((r) => setImmediate(r));
    expect(tm.refreshAllAttachedOAuthTokens).toHaveBeenCalledTimes(2);
    expect(onAfter).toHaveBeenCalledTimes(2);
  });

  it('INVARIANT: bootstrap wires startOAuthRefreshScheduler after startUsageRefreshScheduler', async () => {
    // Document-by-test the bootstrap order so a refactor that puts
    // the OAuth scheduler before usage (or drops it entirely) is caught.
    // The two schedulers are independent but sharing the order keeps the
    // timing-log output predictable for operators reading startup logs.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
    const usageIdx = source.indexOf('startUsageRefreshScheduler(tokenManager');
    const oauthIdx = source.indexOf('startOAuthRefreshScheduler(tokenManager');
    expect(usageIdx).toBeGreaterThan(-1);
    expect(oauthIdx).toBeGreaterThan(-1);
    expect(usageIdx).toBeLessThan(oauthIdx);
  });
});
