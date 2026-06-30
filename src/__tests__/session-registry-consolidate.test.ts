/**
 * Proves the session-end → memory-consolidation wiring: when a session
 * transitions to SLEEPING during cleanup, the registry fires the registered
 * `onSessionConsolidateHook` with the session owner. This is the hook that
 * `src/index.ts` wires to `consolidateUserMemory`, so the auto-update-on-
 * session-end behavior is verified at the registry boundary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-registry-consolidate-test-${process.pid}`),
  };
});

vi.mock('../env-paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
}));

import { SessionRegistry } from '../session-registry';

void os;
void path;

describe('SessionRegistry — session-end memory consolidation hook', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('fires the consolidate hook with the owner when a session goes to sleep', async () => {
    const reg = new SessionRegistry();
    const consolidate = vi.fn();
    reg.setOnSessionConsolidateHook(consolidate);

    const session = reg.createSession('U1', 'User', 'C1', '100.001');
    // Force the session well past the sleep threshold.
    session.lastActivity = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // maxAge=0 → any session is past expiry → transitions to SLEEPING.
    await reg.cleanupInactiveSessions(0);

    expect(session.state).toBe('SLEEPING');
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(consolidate).toHaveBeenCalledWith('U1');
  });

  it('does not throw if the consolidate hook throws', async () => {
    const reg = new SessionRegistry();
    reg.setOnSessionConsolidateHook(() => {
      throw new Error('boom');
    });
    const session = reg.createSession('U2', 'User', 'C2', '200.002');
    session.lastActivity = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await expect(reg.cleanupInactiveSessions(0)).resolves.toBeUndefined();
    expect(session.state).toBe('SLEEPING');
  });

  it('does nothing when no hook is registered', async () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U3', 'User', 'C3', '300.003');
    session.lastActivity = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await expect(reg.cleanupInactiveSessions(0)).resolves.toBeUndefined();
    expect(session.state).toBe('SLEEPING');
  });
});
