/**
 * U8 — deletion-lifecycle observer seam.
 *
 * A session can be deleted from the registry by two paths: explicit
 * `terminateSession()` and the sleep-expiry branch of
 * `cleanupInactiveSessions()`. Both destroy the in-memory session (archive +
 * source-dir cleanup + Map delete), and anything the host keeps keyed by that
 * session (e.g. a persisted follow-up queue) is orphaned unless it is told
 * BEFORE the destruction — while the session object is still reachable.
 *
 * These tests pin the seam the host registers via `setBeforeSessionDelete`:
 * synchronous, fired before any destructive step on BOTH paths, fail-closed
 * (a throwing observer keeps the session alive rather than orphaning history),
 * and independent of the single `setExpiryCallbacks` slot already owned by the
 * EventRouter.
 *
 * Refusal is a THROW, not a `false` return: callers like
 * `slack/actions/channel-route-action-handler.ts` ignore the boolean and keep
 * routing, which would leave the retained session live behind a UI that says it
 * was closed. `false` keeps its single existing meaning — no such session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-registry-u8-delete-test-${process.pid}`),
  };
});

vi.mock('../env-paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
}));

import { buildLegacySessionKey } from '../session-identity';
import { SessionDeleteRefusedError, SessionRegistry } from '../session-registry';

void os;

// Source working dirs must live under /tmp/ to pass the registry's path guard.
const TEST_SOURCE_ROOT = `/tmp/soma-work-registry-u8-src-${process.pid}`;

const MAX_SLEEP_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function makeSourceDir(name: string): string {
  const dirPath = path.join(TEST_SOURCE_ROOT, name);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

describe('SessionRegistry — before-session-delete seam', () => {
  beforeEach(() => {
    for (const dir of [TEST_DATA_DIR, TEST_SOURCE_ROOT]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    for (const dir of [TEST_DATA_DIR, TEST_SOURCE_ROOT]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    }
  });

  it('fires the seam with the normalized key and the "terminated" reason', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('C1U', 'User', 'C1', '100.001');
    const key = reg.getSessionKey('C1', '100.001');
    const calls: Array<[string, string]> = [];

    reg.setBeforeSessionDelete((sessionKey, deleted, reason) => {
      expect(deleted).toBe(session);
      calls.push([sessionKey, reason]);
    });

    // Terminate through the LEGACY key form: the seam must observe the
    // normalized key the registry actually deletes.
    expect(reg.terminateSession(buildLegacySessionKey('C1', '100.001'))).toBe(true);

    expect(calls).toEqual([[key, 'terminated']]);
  });

  it('runs the seam before the Map delete and before source-dir cleanup', () => {
    const reg = new SessionRegistry();
    reg.createSession('C1U', 'User', 'C1', '100.002');
    const key = reg.getSessionKey('C1', '100.002');
    const sourceDir = makeSourceDir('terminate-ordering');
    expect(reg.addSourceWorkingDir('C1', '100.002', sourceDir)).toBe(true);

    let stateAtCall: { inMap: boolean; dirOnDisk: boolean; terminatedFlag: boolean } | undefined;
    reg.setBeforeSessionDelete((sessionKey, deleted) => {
      stateAtCall = {
        inMap: reg.getAllSessions().has(sessionKey),
        dirOnDisk: fs.existsSync(sourceDir),
        terminatedFlag: deleted.terminated === true,
      };
    });

    expect(reg.terminateSession(key)).toBe(true);

    expect(stateAtCall).toEqual({ inMap: true, dirOnDisk: true, terminatedFlag: false });
    expect(reg.getAllSessions().has(key)).toBe(false);
    expect(fs.existsSync(sourceDir)).toBe(false);
  });

  it('terminates exactly as before when no seam is registered', () => {
    const reg = new SessionRegistry();
    reg.createSession('C1U', 'User', 'C1', '100.003');
    const key = reg.getSessionKey('C1', '100.003');

    expect(reg.terminateSession(key)).toBe(true);
    expect(reg.getAllSessions().has(key)).toBe(false);
    expect(reg.terminateSession(key)).toBe(false);
  });

  it('throws SessionDeleteRefusedError and retains the session when the seam refuses', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('C1U', 'User', 'C1', '100.004');
    const key = reg.getSessionKey('C1', '100.004');
    const sourceDir = makeSourceDir('terminate-failclosed');
    expect(reg.addSourceWorkingDir('C1', '100.004', sourceDir)).toBe(true);

    const cause = new Error('queue persist failed');
    reg.setBeforeSessionDelete(() => {
      throw cause;
    });

    // A refusal must be impossible to ignore: callers that only check the
    // boolean (channel-route-action-handler) would otherwise route on as if
    // the session were gone while it is still live in the registry.
    let thrown: unknown;
    try {
      reg.terminateSession(key);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SessionDeleteRefusedError);
    const refusal = thrown as SessionDeleteRefusedError;
    expect(refusal.sessionKey).toBe(key);
    expect(refusal.reason).toBe('terminated');
    expect(refusal.cause).toBe(cause);

    expect(reg.getAllSessions().get(key)).toBe(session);
    expect(session.terminated).not.toBe(true);
    expect(fs.existsSync(sourceDir)).toBe(true);
  });

  it('returns false without throwing for an unknown session (absent ≠ refused)', () => {
    const reg = new SessionRegistry();
    const seam = vi.fn();
    reg.setBeforeSessionDelete(seam);

    expect(reg.terminateSession(reg.getSessionKey('C1', '999.999'))).toBe(false);
    expect(seam).not.toHaveBeenCalled();
  });

  it('fires the same seam with "sleep-expired" before deleting an expired sleeping session', async () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('C1U', 'User', 'C1', '100.005');
    const key = reg.getSessionKey('C1', '100.005');
    session.state = 'SLEEPING';
    session.sleepStartedAt = new Date(Date.now() - (MAX_SLEEP_DURATION_MS + 60_000));

    // The single expiry-callback slot stays owned by its existing consumer.
    const onExpiry = vi.fn(async () => {});
    reg.setExpiryCallbacks({
      onWarning: vi.fn(async () => undefined),
      onSleep: vi.fn(async () => {}),
      onExpiry,
    });

    const calls: Array<[string, string, boolean]> = [];
    reg.setBeforeSessionDelete((sessionKey, deleted, reason) => {
      expect(deleted).toBe(session);
      calls.push([sessionKey, reason, reg.getAllSessions().has(sessionKey)]);
    });

    await reg.cleanupInactiveSessions();

    expect(calls).toEqual([[key, 'sleep-expired', true]]);
    expect(onExpiry).toHaveBeenCalledTimes(1);
    expect(reg.getAllSessions().has(key)).toBe(false);
  });

  it('keeps sweeping when the seam refuses one expired session (refusal is per-session)', async () => {
    const reg = new SessionRegistry();
    const expired = (threadTs: string) => {
      const session = reg.createSession('C1U', 'User', 'C1', threadTs);
      session.state = 'SLEEPING';
      session.sleepStartedAt = new Date(Date.now() - (MAX_SLEEP_DURATION_MS + 60_000));
      return session;
    };

    const refused = expired('100.006');
    const refusedKey = reg.getSessionKey('C1', '100.006');
    const sourceDir = makeSourceDir('sleep-failclosed');
    expect(reg.addSourceWorkingDir('C1', '100.006', sourceDir)).toBe(true);

    expired('100.007');
    const deletableKey = reg.getSessionKey('C1', '100.007');

    reg.setBeforeSessionDelete((sessionKey) => {
      if (sessionKey === refusedKey) throw new Error('queue persist failed');
    });

    // The sweep must not abort on one refusal — it neither rejects nor skips
    // the sessions that follow the refused one.
    await expect(reg.cleanupInactiveSessions()).resolves.toBeUndefined();

    expect(reg.getAllSessions().get(refusedKey)).toBe(refused);
    expect(fs.existsSync(sourceDir)).toBe(true);
    expect(reg.getAllSessions().has(deletableKey)).toBe(false);
  });
});
