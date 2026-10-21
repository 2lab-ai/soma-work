/**
 * The inactivity sweep and the restart loader read the admin-set lifecycle
 * policy (session-lifecycle-policy.ts) instead of fixed 24h / 7d constants.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-registry-lifecycle-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { __resetSessionLifecyclePolicyForTests, updateSessionLifecyclePolicy } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const HOUR = 60 * 60 * 1000;

function callbacks() {
  return {
    onWarning: vi.fn(async () => undefined),
    onSleep: vi.fn(async () => undefined),
    onExpiry: vi.fn(async () => undefined),
  };
}

describe('SessionRegistry — lifecycle policy', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });

  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('puts a session to sleep after the policy idle time, not a fixed 24h', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '600.001');
    session.lastActivity = new Date(Date.now() - 3 * HOUR);

    await reg.cleanupInactiveSessions();

    expect(session.state).toBe('SLEEPING');
  });

  it('keeps a session awake while it is inside the policy idle time', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 48 * HOUR });
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '600.002');
    session.lastActivity = new Date(Date.now() - 30 * HOUR);

    await reg.cleanupInactiveSessions();

    expect(session.state).not.toBe('SLEEPING');
  });

  it('archives a sleeping session after the policy sleep time, not a fixed 7 days', async () => {
    updateSessionLifecyclePolicy({ archiveAfterMs: HOUR });
    const reg = new SessionRegistry();
    const cb = callbacks();
    reg.setExpiryCallbacks(cb);
    const session = reg.createSession('U1', 'User', 'C1', '600.003');
    session.state = 'SLEEPING';
    session.sleepStartedAt = new Date(Date.now() - 2 * HOUR);

    await reg.cleanupInactiveSessions();

    expect(reg.getSession('C1', '600.003')).toBeUndefined();
    expect(cb.onExpiry).toHaveBeenCalledTimes(1);
  });

  it('skips expiry warnings that are not shorter than the idle time itself', async () => {
    // 2h idle limit: the 12h-remaining "is this done?" check would fire on the
    // first sweep after any activity, so it is skipped; 10 min still applies.
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    const reg = new SessionRegistry();
    const cb = callbacks();
    reg.setExpiryCallbacks(cb);
    const session = reg.createSession('U1', 'User', 'C1', '600.004');
    session.lastActivity = new Date(Date.now() - HOUR);

    await reg.cleanupInactiveSessions();
    expect(cb.onWarning).not.toHaveBeenCalled();

    session.lastActivity = new Date(Date.now() - (2 * HOUR - 5 * 60 * 1000));
    await reg.cleanupInactiveSessions();
    expect(cb.onWarning).toHaveBeenCalledTimes(1);
  });

  it("the restart loader takes the sweep's step: a stale active session sleeps from now, a sleeping one ends past the sleep time", () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR, archiveAfterMs: HOUR });
    const now = Date.now();
    const base = { ownerId: 'U1', userId: 'U1', channelId: 'C1', isActive: true };
    const saved = [
      // idle 40h — far past sleep + archive, but it never slept: it sleeps now, it is not ended.
      {
        ...base,
        threadTs: '700.001',
        sessionId: 's-stale',
        state: 'MAIN',
        lastActivity: new Date(now - 40 * HOUR).toISOString(),
        activityState: 'working',
      },
      // idle 2.5h: past the idle limit — loads asleep, never auto-resumed.
      {
        ...base,
        threadTs: '700.002',
        sessionId: 's-sleepy',
        state: 'MAIN',
        lastActivity: new Date(now - 2.5 * HOUR).toISOString(),
        activityState: 'working',
      },
      // asleep 2h >= 1h — archived.
      {
        ...base,
        threadTs: '700.003',
        sessionId: 's-slept-out',
        state: 'SLEEPING',
        lastActivity: new Date(now - 30 * HOUR).toISOString(),
        sleepStartedAt: new Date(now - 2 * HOUR).toISOString(),
      },
      // fresh — loads as it was.
      {
        ...base,
        threadTs: '700.004',
        sessionId: 's-fresh',
        state: 'MAIN',
        lastActivity: new Date(now - 30 * 60 * 1000).toISOString(),
      },
    ];
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), JSON.stringify(saved));

    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(3);
    expect(reg.getSession('C1', '700.003')).toBeUndefined();
    expect(reg.getSession('C1', '700.004')?.state).toBe('MAIN');
    for (const ts of ['700.001', '700.002']) {
      const s = reg.getSession('C1', ts);
      expect(s?.state).toBe('SLEEPING');
      expect(s?.activityState).toBe('idle');
      expect(s?.sleepStartedAt?.getTime()).toBeGreaterThanOrEqual(now);
    }
    expect(reg.getCrashRecoveredSessions().map((c) => c.threadTs)).toEqual([]);
  });

  it('an unreadable saved policy pauses the sweep and the loader instead of falling back to shorter defaults', async () => {
    const file = path.join(TEST_DATA_DIR, 'session-lifecycle.json');
    fs.writeFileSync(file, '{ broken');
    fs.writeFileSync(`${file}.bak`, '{ broken');
    __resetSessionLifecyclePolicyForTests(file);

    const reg = new SessionRegistry();
    const cb = callbacks();
    reg.setExpiryCallbacks(cb);
    const idle = reg.createSession('U1', 'User', 'C1', '800.001');
    idle.lastActivity = new Date(Date.now() - 400 * HOUR);
    const asleep = reg.createSession('U1', 'User', 'C1', '800.002');
    asleep.state = 'SLEEPING';
    asleep.sleepStartedAt = new Date(Date.now() - 400 * HOUR);

    await reg.cleanupInactiveSessions();

    expect(idle.state).not.toBe('SLEEPING');
    expect(reg.getSession('C1', '800.002')).toBeDefined();
    expect(cb.onSleep).not.toHaveBeenCalled();
    expect(cb.onExpiry).not.toHaveBeenCalled();

    fs.writeFileSync(
      path.join(TEST_DATA_DIR, 'sessions.json'),
      JSON.stringify([
        {
          ownerId: 'U1',
          userId: 'U1',
          channelId: 'C1',
          threadTs: '800.003',
          sessionId: 's',
          isActive: true,
          state: 'SLEEPING',
          lastActivity: new Date(Date.now() - 900 * HOUR).toISOString(),
          sleepStartedAt: new Date(Date.now() - 800 * HOUR).toISOString(),
        },
      ]),
    );
    expect(new SessionRegistry().loadSessions()).toBe(1);
  });
});
