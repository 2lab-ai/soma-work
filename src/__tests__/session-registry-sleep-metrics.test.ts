/**
 * The 24h sleep transition must emit `session_slept`.
 *
 * The daily/weekly report counts `sessionsSlept` from `session_slept` events,
 * but the only emitter call sat in `SessionRegistry.transitionToSleep`, which no
 * code path called (deleted as dead in the 2026-10 audit). The live sleep path
 * is the inactivity sweep in `cleanupInactiveSessions`, and it emitted nothing,
 * so the report always showed 0 slept sessions.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-registry-sleep-metrics-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { SessionRegistry } from '../session-registry';

describe('SessionRegistry — session_slept metric', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('emits session_slept once when the inactivity sweep puts a session to sleep', async () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '500.001');
    session.lastActivity = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await reg.cleanupInactiveSessions(0);
    await reg.cleanupInactiveSessions(0); // already sleeping: no second event

    expect(session.state).toBe('SLEEPING');
    expect(emitter.emitSessionSlept).toHaveBeenCalledTimes(1);
    expect(emitter.emitSessionSlept).toHaveBeenCalledWith(session);
  });

  it('does not emit session_slept for a session that is still active', async () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '500.002');

    await reg.cleanupInactiveSessions(24 * 60 * 60 * 1000);

    expect(emitter.emitSessionSlept).not.toHaveBeenCalled();
  });

  // Both deletion paths must mark the session object terminated: in-flight
  // stream callbacks hold the object and fence on that flag (ghost-session),
  // and the sleep-expiry path awaits onExpiry between drain and delete.
  it('sleep-expiry deletion marks the session terminated before notifying', async () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '500.004');
    session.state = 'SLEEPING';
    session.sleepStartedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let terminatedDuringExpiry: boolean | undefined;
    reg.setExpiryCallbacks({
      onWarning: async () => undefined,
      onSleep: async () => undefined,
      onExpiry: async (s) => {
        terminatedDuringExpiry = s.terminated;
      },
    });

    await reg.cleanupInactiveSessions(0);

    expect(reg.getSession('C1', '500.004')).toBeUndefined();
    expect(terminatedDuringExpiry).toBe(true);
    expect(session.terminated).toBe(true);
  });

  it('a failing metrics store does not break the sleep transition', async () => {
    emitter.emitSessionSlept.mockRejectedValueOnce(new Error('store down'));
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '500.003');
    session.lastActivity = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await expect(reg.cleanupInactiveSessions(0)).resolves.toBeUndefined();
    expect(session.state).toBe('SLEEPING');
  });
});
