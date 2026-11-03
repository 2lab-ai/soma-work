/**
 * #881 D1 — when the idle clock restarts, the "만료 예정" warning already posted in the thread named the old expiry.
 * The registry used to clear its state (`warningMessageTs`, `lastWarningSentAt`) and leave the message as it was.
 * Every reset now hands the posted message to `onWarningCleared`, which edits it — user activity, unstar, /new, and a
 * new ⚠️ follow-up. (Sleep is different: onSleep edits the same message into the sleep notice.)
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return { TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-warning-cleared-test-${process.pid}`) };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));

import { SessionRegistry } from '../session-registry';

describe('SessionRegistry — a cleared expiry warning is edited, not left behind (#881 D1)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  const setup = (ts: string) => {
    const reg = new SessionRegistry();
    const onWarningCleared = vi.fn().mockResolvedValue(undefined);
    reg.setExpiryCallbacks({
      onWarning: vi.fn().mockResolvedValue(undefined),
      onSleep: vi.fn().mockResolvedValue(undefined),
      onExpiry: vi.fn().mockResolvedValue(undefined),
      onWarningCleared,
    });
    const s = reg.createSession('U1', 'User', 'C1', ts);
    s.warningMessageTs = 'w-1';
    s.lastWarningSentAt = 12 * 3600_000;
    return { reg, s, onWarningCleared };
  };

  it('user activity', () => {
    const { reg, s, onWarningCleared } = setup('200.001');
    expect(reg.refreshSessionActivityByKey(reg.getSessionKey('C1', '200.001'))).toBe(true);
    expect(onWarningCleared).toHaveBeenCalledWith(s, 'w-1');
    expect(s.warningMessageTs).toBeUndefined();
    expect(s.lastWarningSentAt).toBeUndefined();
  });

  it('a thread reply — the activity the warning asks for (fable R1 P1)', () => {
    const { reg, s, onWarningCleared } = setup('200.006');
    reg.updateInitiator('C1', '200.006', 'U1', 'User');
    expect(onWarningCleared).toHaveBeenCalledWith(s, 'w-1');
    expect(s.warningMessageTs).toBeUndefined();
    expect(s.lastWarningSentAt).toBeUndefined();
  });

  it('the idle-check "keep" button: its own reply replaces that message, so no second edit races it (fable R1 P1)', () => {
    const { reg, s, onWarningCleared } = setup('200.007');
    expect(reg.refreshSessionActivityByKey(reg.getSessionKey('C1', '200.007'), { editWarning: false })).toBe(true);
    expect(onWarningCleared).not.toHaveBeenCalled();
    expect(s.warningMessageTs).toBeUndefined();
  });

  it('the es TL;DR keeps its issue time across a restart (fable · grok R1 P2)', () => {
    const { reg } = setup('200.008');
    const t = 1_793_700_000_000;
    reg.setExecutiveSummary('C1', '200.008', ['a', 'b', 'c'], `r_${t.toString(36)}_1_abcd1234`);
    const s = reg.getSession('C1', '200.008')!;
    s.sessionId = 'sess-8';
    reg.saveSessions();
    const again = new SessionRegistry();
    again.loadSessions();
    expect(again.getSession('C1', '200.008')?.executiveSummary?.issuedAt).toBe(t);
  });

  it('a new ⚠️ follow-up; the same reason again keeps the warning', () => {
    const { reg, s, onWarningCleared } = setup('200.002');
    reg.setExecutiveSummary('C1', '200.002', ['a', '⚠️ **PR #1 open**', 'b']);
    expect(onWarningCleared).toHaveBeenCalledWith(s, 'w-1');
    s.warningMessageTs = 'w-2';
    s.lastWarningSentAt = 600_000;
    reg.setExecutiveSummary('C1', '200.002', ['a2', '⚠️ **PR #1 open**', 'b2']);
    expect(onWarningCleared).toHaveBeenCalledTimes(1);
    expect(s.warningMessageTs).toBe('w-2');
  });

  it('/new', () => {
    const { reg, s, onWarningCleared } = setup('200.003');
    s.sessionId = 'sess-1';
    expect(reg.resetSessionContext('C1', '200.003')).toBe(true);
    expect(onWarningCleared).toHaveBeenCalledWith(s, 'w-1');
  });

  it('nothing posted, nothing to edit', () => {
    const { reg, s, onWarningCleared } = setup('200.004');
    s.warningMessageTs = undefined;
    reg.refreshSessionActivityByKey(reg.getSessionKey('C1', '200.004'));
    expect(onWarningCleared).not.toHaveBeenCalled();
  });

  it('a failing edit never breaks the reset', () => {
    const { reg, s, onWarningCleared } = setup('200.005');
    onWarningCleared.mockRejectedValueOnce(new Error('slack down'));
    expect(() => reg.refreshSessionActivityByKey(reg.getSessionKey('C1', '200.005'))).not.toThrow();
    expect(s.warningMessageTs).toBeUndefined();
  });
});
