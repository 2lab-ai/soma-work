/**
 * Proves the sleep transition hands `warningMessageTs` to `onSleep` instead of
 * wiping it first.
 *
 * `SessionUiManager.handleSessionSleep` is written to EDIT the existing expiry
 * warning in place when `session.warningMessageTs` is set, and to post a fresh
 * message only when it is not. The registry cleared the field before invoking
 * the callback, so the edit branch could never run: every sleep transition
 * posted a second message and left the stale "만료 예정" warning behind. That is
 * the two-message shape users see in the channel.
 *
 * Clearing still has to happen — a stale ts must not survive into the next
 * warning cycle — but it belongs AFTER the callback has had its chance to use it.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-registry-sleep-warning-test-${process.pid}`),
  };
});

vi.mock('../env-paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
}));

import { SessionRegistry } from '../session-registry';

describe('SessionRegistry — warningMessageTs across the sleep transition', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('passes the live warning ts to onSleep, then clears it', async () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '400.001');
    session.lastActivity = new Date(Date.now() - 48 * 60 * 60 * 1000);
    session.warningMessageTs = 'WARN.1';

    let seenByCallback: string | undefined = 'NOT_CALLED';
    reg.setExpiryCallbacks({
      onWarning: async () => undefined,
      onSleep: async (s) => {
        seenByCallback = s.warningMessageTs;
      },
      onExpiry: async () => undefined,
    });

    await reg.cleanupInactiveSessions(0);

    expect(session.state).toBe('SLEEPING');
    // The callback must still be able to edit the warning it posted.
    expect(seenByCallback).toBe('WARN.1');
    // ...and the ts must not leak into the next lifecycle.
    expect(session.warningMessageTs).toBeUndefined();
  });
});
