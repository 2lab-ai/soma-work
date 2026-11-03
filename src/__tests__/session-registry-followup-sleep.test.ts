/**
 * #846 item 5 — an unfinished own artifact (the ⚠️ follow-up) gets a full sleep period from when it was raised.
 *
 * The idle clock started at the last user input only, so a long autonomous run that ended with a ⚠️ TL;DR could
 * put the session to sleep minutes after the card moved to NEEDS YOU. The clock now starts at the latest of the
 * last input, an unstar, and the follow-up — bounded: one sleep period from the ⚠️ line, then the usual sleep.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-followup-sleep-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import {
  __resetSessionLifecyclePolicyForTests,
  countLifecycleTransitions,
  getSessionLifecyclePolicy,
  idleSinceMs,
  updateSessionLifecyclePolicy,
} from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const HOUR = 60 * 60 * 1000;

describe('idleSinceMs — the follow-up restarts the idle clock', () => {
  it('takes the latest of last input, unstar and follow-up', () => {
    const now = Date.now();
    const lastActivity = new Date(now - 30 * HOUR);
    expect(idleSinceMs({ lastActivity, followUp: { reason: 'PR #1 open', at: now - HOUR } })).toBe(now - HOUR);
    expect(
      idleSinceMs({ lastActivity, starClearedAt: now - 2 * HOUR, followUp: { reason: 'x', at: now - 5 * HOUR } }),
    ).toBe(now - 2 * HOUR);
    // An older follow-up does not pull the clock back.
    expect(idleSinceMs({ lastActivity, followUp: { reason: 'x', at: now - 40 * HOUR } })).toBe(lastActivity.getTime());
    // A malformed one is ignored.
    expect(idleSinceMs({ lastActivity, followUp: { reason: 'x', at: Number.NaN } })).toBe(lastActivity.getTime());
    expect(idleSinceMs({ lastActivity, followUp: undefined })).toBe(lastActivity.getTime());
  });
});

describe('SessionRegistry — a follow-up session sleeps one period after its ⚠️ line', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });

  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('the sweep keeps it awake inside the period after the follow-up', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'User', 'C1', '800.001');
    s.lastActivity = new Date(Date.now() - 5 * HOUR);
    s.followUp = { reason: 'PR #1 open — needs approval', at: Date.now() - HOUR };

    await reg.cleanupInactiveSessions();

    expect(s.state).not.toBe('SLEEPING');
  });

  it('the sweep sleeps it once the period after the follow-up has passed', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'User', 'C1', '800.002');
    s.lastActivity = new Date(Date.now() - 5 * HOUR);
    s.followUp = { reason: 'PR #1 open — needs approval', at: Date.now() - 3 * HOUR };

    await reg.cleanupInactiveSessions();

    expect(s.state).toBe('SLEEPING');
  });

  it('the restart loader uses the same clock', () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    const now = Date.now();
    const base = { ownerId: 'U1', userId: 'U1', channelId: 'C1', isActive: true, state: 'MAIN' };
    const saved = [
      {
        ...base,
        threadTs: '800.003',
        sessionId: 's-fresh-followup',
        lastActivity: new Date(now - 5 * HOUR).toISOString(),
        followUp: { reason: 'issue #2 open', at: now - HOUR },
      },
      {
        ...base,
        threadTs: '800.004',
        sessionId: 's-old-followup',
        lastActivity: new Date(now - 5 * HOUR).toISOString(),
        followUp: { reason: 'issue #3 open', at: now - 4 * HOUR },
      },
    ];
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), JSON.stringify(saved));
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(2);
    expect(reg.getSession('C1', '800.003')?.state).toBe('MAIN');
    expect(reg.getSession('C1', '800.004')?.state).toBe('SLEEPING');
  });

  it('the admin preview counts it the same way', () => {
    const now = Date.now();
    const from = { ...getSessionLifecyclePolicy(), sleepAfterMs: 24 * HOUR };
    const to = { ...from, sleepAfterMs: 2 * HOUR };
    const view = { state: 'MAIN', activityState: 'idle', lastActivity: new Date(now - 5 * HOUR) };
    expect(
      countLifecycleTransitions([{ ...view, followUp: { reason: 'x', at: now - HOUR } }], from, to, now).willSleep,
    ).toBe(0);
    expect(countLifecycleTransitions([{ ...view }], from, to, now).willSleep).toBe(1);
  });
});
