/**
 * Task star + revive (SSOT 2026-10-30) — the registry half.
 *
 *   T1 a session can be starred; the star survives a restart.
 *   T3 a starred session is never put to sleep or archived (sweep, restart
 *      loader, lifecycle-change preview), and gets no expiry warning.
 *   T4 a sleeping session wakes on revive; an archived one is restored into
 *      the registry with its SDK session and working directory, so the next
 *      message continues the same conversation.
 *   T5 starring a sleeping session wakes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-star-revive-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import type { ArchivedSession } from '../session-archive';
import {
  __resetSessionLifecyclePolicyForTests,
  countLifecycleTransitions,
  DEFAULT_SESSION_LIFECYCLE_POLICY,
  updateSessionLifecyclePolicy,
} from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function callbacks() {
  return {
    onWarning: vi.fn(async () => undefined),
    onSleep: vi.fn(async () => undefined),
    onExpiry: vi.fn(async () => undefined),
  };
}

function archived(overrides: Partial<ArchivedSession> = {}): ArchivedSession {
  return {
    archivedAt: 1793600000000,
    archiveReason: 'sleep_expired',
    sessionKey: 'work:C1:800.001',
    sessionId: '7f3c2a10-0000-4000-8000-000000000001',
    conversationId: 'conv-1',
    ownerId: 'U1',
    ownerName: 'User',
    channelId: 'C1',
    threadTs: '800.001',
    title: 'Long task',
    model: 'claude-opus-5-5[1m]',
    workflow: 'default',
    lastActivity: new Date(Date.now() - 10 * DAY).toISOString(),
    finalState: 'SLEEPING',
    summaryTitle: 'Long task summary',
    sessionWorkingDir: '/tmp/U1/session_1793000000000_ab12cd34',
    ...overrides,
  };
}

describe('SessionRegistry — task star (T1, T3, T5)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });

  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('T3.1 — the sweep never puts a starred session to sleep and sends it no expiry warning', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    const reg = new SessionRegistry();
    const cb = callbacks();
    reg.setExpiryCallbacks(cb);
    const session = reg.createSession('U1', 'User', 'C1', '600.001');
    session.sessionId = 's-1';
    session.state = 'MAIN';
    expect(reg.setStarred(reg.getSessionKey('C1', '600.001'), true)).toMatchObject({ ok: true, starred: true });

    session.lastActivity = new Date(Date.now() - 40 * DAY);
    await reg.cleanupInactiveSessions();
    expect(session.state).toBe('MAIN');
    expect(cb.onSleep).not.toHaveBeenCalled();

    // Inside the warning window too: a starred session never hears "만료 예정".
    session.lastActivity = new Date(Date.now() - (2 * HOUR - 5 * 60 * 1000));
    await reg.cleanupInactiveSessions();
    expect(cb.onWarning).not.toHaveBeenCalled();
  });

  it('T3.1 — a starred session that is somehow asleep is never archived by the sweep', async () => {
    updateSessionLifecyclePolicy({ archiveAfterMs: HOUR });
    const reg = new SessionRegistry();
    const cb = callbacks();
    reg.setExpiryCallbacks(cb);
    const session = reg.createSession('U1', 'User', 'C1', '600.002');
    session.sessionId = 's-2';
    session.state = 'SLEEPING';
    session.sleepStartedAt = new Date(Date.now() - 30 * DAY);
    session.starred = true;

    await reg.cleanupInactiveSessions();

    expect(reg.getSession('C1', '600.002')).toBe(session);
    expect(cb.onExpiry).not.toHaveBeenCalled();
  });

  it('T3 race — a star that lands while the sweep awaits onSleep leaves the session awake, in memory and on disk', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '600.009');
    session.sessionId = 's-race';
    session.state = 'MAIN';
    session.lastActivity = new Date(Date.now() - 3 * HOUR);
    const key = reg.getSessionKey('C1', '600.009');
    const cb = callbacks();
    // The Slack sleep notice is awaited; the owner presses ☆ Star meanwhile.
    cb.onSleep.mockImplementation(async () => {
      expect(reg.setStarred(key, true)).toMatchObject({ ok: true, starred: true, revived: true });
    });
    reg.setExpiryCallbacks(cb);

    await reg.cleanupInactiveSessions();

    expect(session.state).toBe('MAIN');
    expect(session.starred).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), 'utf-8')) as Array<{
      threadTs: string;
      state: string;
      starred?: boolean;
    }>;
    expect(onDisk.find((r) => r.threadTs === '600.009')).toMatchObject({ state: 'MAIN', starred: true });
    // And the next sweep leaves it alone.
    session.lastActivity = new Date(Date.now() - 40 * DAY);
    await reg.cleanupInactiveSessions();
    expect(session.state).toBe('MAIN');
  });

  it('T5 — starring a sleeping session wakes it', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '600.003');
    session.sessionId = 's-3';
    session.state = 'SLEEPING';
    session.sleepStartedAt = new Date(Date.now() - 2 * DAY);

    const out = reg.setStarred(reg.getSessionKey('C1', '600.003'), true);

    expect(out).toMatchObject({ ok: true, starred: true, revived: true });
    expect(session.state).toBe('MAIN');
    expect(session.sleepStartedAt).toBeUndefined();
    expect(session.starred).toBe(true);
  });

  it('T1.1 / T3.2 — the star survives a restart, and the loader neither sleeps nor archives a starred session', () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR, archiveAfterMs: HOUR });
    const reg = new SessionRegistry();
    const stale = reg.createSession('U1', 'User', 'C1', '700.001');
    stale.sessionId = 's-stale';
    stale.state = 'MAIN';
    stale.lastActivity = new Date(Date.now() - 40 * DAY);
    stale.starred = true;
    const asleep = reg.createSession('U1', 'User', 'C1', '700.002');
    asleep.sessionId = 's-asleep';
    asleep.state = 'SLEEPING';
    asleep.sleepStartedAt = new Date(Date.now() - 30 * DAY);
    asleep.starred = true;
    reg.saveSessions();

    const onDisk = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), 'utf-8')) as Array<{
      threadTs: string;
      starred?: boolean;
    }>;
    expect(onDisk.find((r) => r.threadTs === '700.001')?.starred).toBe(true);

    const next = new SessionRegistry();
    expect(next.loadSessions()).toBe(2);
    expect(next.getSession('C1', '700.001')?.state).toBe('MAIN');
    expect(next.getSession('C1', '700.001')?.starred).toBe(true);
    expect(next.getSession('C1', '700.002')).toBeDefined();
    expect(next.getSession('C1', '700.002')?.starred).toBe(true);
  });

  it('T1.1 — a starred session is saved even without an SDK session', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'User', 'C1', '700.003');
    s.state = 'MAIN';
    s.starred = true;
    reg.saveSessions();
    const onDisk = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), 'utf-8')) as Array<{
      threadTs: string;
    }>;
    expect(onDisk.map((r) => r.threadTs)).toContain('700.003');
  });

  it('T3 — unstarring gives a fresh grace period: the next sweep does not sleep it, and a restart keeps the grace', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '700.004');
    session.sessionId = 's-grace';
    session.state = 'MAIN';
    const lastActivity = new Date(Date.now() - 30 * DAY);
    session.lastActivity = lastActivity;
    session.starred = true;
    session.warningMessageTs = '111.222';
    session.lastWarningSentAt = 10 * 60 * 1000;

    expect(reg.setStarred(reg.getSessionKey('C1', '700.004'), false)).toMatchObject({ ok: true, starred: false });
    await reg.cleanupInactiveSessions();

    expect(session.state).toBe('MAIN');
    // The grace is its own clock: the last instruction's time is untouched.
    expect(session.lastActivity).toEqual(lastActivity);
    expect(session.warningMessageTs).toBeUndefined();
    expect(session.lastWarningSentAt).toBeUndefined();

    const next = new SessionRegistry();
    next.loadSessions();
    expect(next.getSession('C1', '700.004')?.state).toBe('MAIN');
  });

  it('refuses to star a session that is being ended (terminated object)', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '700.005');
    session.sessionId = 's-term';
    session.terminated = true;
    expect(reg.setStarred(reg.getSessionKey('C1', '700.005'), true)).toMatchObject({ ok: false, code: 'terminated' });
    expect(session.starred).toBeUndefined();
    expect(reg.setStarred('work:C9:nope', true)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses to star a trashed session (hidden vs pinned exclude each other)', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '700.006');
    session.sessionId = 's-trashed';
    session.trashed = true;
    expect(reg.setStarred(reg.getSessionKey('C1', '700.006'), true)).toMatchObject({ ok: false, code: 'conflict' });
    expect(session.starred).toBeUndefined();
  });

  it('T3.3 — the lifecycle-change preview never counts a starred session', () => {
    const now = Date.now();
    const from = { ...DEFAULT_SESSION_LIFECYCLE_POLICY };
    const to = { ...from, sleepAfterMs: HOUR, archiveAfterMs: HOUR };
    const counts = countLifecycleTransitions(
      [
        { state: 'MAIN', lastActivity: new Date(now - 3 * HOUR), starred: true },
        {
          state: 'SLEEPING',
          lastActivity: new Date(now - 3 * DAY),
          sleepStartedAt: new Date(now - 2 * HOUR),
          starred: true,
        },
        { state: 'MAIN', lastActivity: new Date(now - 3 * HOUR) },
      ],
      from,
      to,
      now,
    );
    expect(counts).toEqual({ willSleep: 1, willArchive: 0 });
  });
});

describe('SessionRegistry — revive (T4)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });

  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('T4.1 — revive wakes a sleeping session; an awake one is left as it is', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '810.001');
    session.sessionId = 's-sleep';
    session.state = 'SLEEPING';
    session.sleepStartedAt = new Date(Date.now() - DAY);
    const key = reg.getSessionKey('C1', '810.001');

    expect(reg.reviveSession(key)).toMatchObject({ ok: true, sessionKey: key, revived: true });
    expect(session.state).toBe('MAIN');
    expect(reg.reviveSession(key)).toMatchObject({ ok: true, sessionKey: key, revived: false });
    expect(reg.reviveSession('work:C9:nope')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('T4.2 — an archived session comes back with its SDK session, conversation and working directory', () => {
    const reg = new SessionRegistry();
    const out = reg.restoreArchivedSession(archived(), '/tmp/U1/session_1793000000000_ab12cd34');

    const key = reg.getSessionKey('C1', '800.001');
    expect(out).toMatchObject({ ok: true, sessionKey: key, revived: true });
    const s = reg.getSession('C1', '800.001');
    expect(s).toBeDefined();
    expect(s?.sessionId).toBe('7f3c2a10-0000-4000-8000-000000000001');
    expect(s?.conversationId).toBe('conv-1');
    expect(s?.sessionWorkingDir).toBe('/tmp/U1/session_1793000000000_ab12cd34');
    expect(s?.sourceWorkingDirs).toContain('/tmp/U1/session_1793000000000_ab12cd34');
    expect(s?.state).toBe('MAIN');
    expect(s?.activityState).toBe('idle');
    expect(s?.ownerId).toBe('U1');
    expect(s?.summaryTitle).toBe('Long task summary');
    expect(Date.now() - (s?.lastActivity.getTime() ?? 0)).toBeLessThan(5000);

    // Persisted at once: a restart right after the revive keeps it.
    const next = new SessionRegistry();
    next.loadSessions();
    expect(next.getSession('C1', '800.001')?.sessionId).toBe('7f3c2a10-0000-4000-8000-000000000001');
  });

  it('T4.2 — an incident-owned archive comes back still restricted', () => {
    const reg = new SessionRegistry();
    const incidentRequest = { incident_id: 'INC-1', attempt_id: 'A-1' } as any;
    reg.restoreArchivedSession(archived({ incidentRequest }), '/tmp/U1/session_1793000000000_ab12cd34');
    expect(reg.getSession('C1', '800.001')?.incidentRequest).toEqual(incidentRequest);
  });

  it('T4.2 — the same conversation already live in the thread: no second copy, its key is returned', () => {
    const reg = new SessionRegistry();
    const live = reg.createSession('U1', 'User', 'C1', '800.001');
    live.sessionId = '7f3c2a10-0000-4000-8000-000000000001';
    live.state = 'SLEEPING';
    const out = reg.restoreArchivedSession(archived(), '/tmp/U1/session_1793000000000_ab12cd34');
    expect(out).toMatchObject({ ok: true, sessionKey: reg.getSessionKey('C1', '800.001') });
    expect(reg.getSession('C1', '800.001')).toBe(live);
    expect(live.state).toBe('MAIN');
  });

  it('T4.2 — a different live session in the thread is a conflict, never replaced', () => {
    const reg = new SessionRegistry();
    const other = reg.createSession('U1', 'User', 'C1', '800.001');
    other.sessionId = 'another-sdk-session';
    other.conversationId = 'conv-other';
    const out = reg.restoreArchivedSession(archived(), '/tmp/U1/session_1793000000000_ab12cd34');
    expect(out).toMatchObject({ ok: false, code: 'conflict' });
    expect(reg.getSession('C1', '800.001')).toBe(other);
  });

  it("T4.2 — another owner's live session in the thread is forbidden", () => {
    const reg = new SessionRegistry();
    const other = reg.createSession('U2', 'Other', 'C1', '800.001');
    other.sessionId = '7f3c2a10-0000-4000-8000-000000000001';
    expect(reg.restoreArchivedSession(archived(), '/tmp/U1/session_1793000000000_ab12cd34')).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('T4.2 — a terminated object still in the map refuses the restore', () => {
    const reg = new SessionRegistry();
    const dying = reg.createSession('U1', 'User', 'C1', '800.001');
    dying.sessionId = '7f3c2a10-0000-4000-8000-000000000001';
    dying.terminated = true;
    expect(reg.restoreArchivedSession(archived(), '/tmp/U1/session_1793000000000_ab12cd34')).toMatchObject({
      ok: false,
      code: 'terminated',
    });
  });
});
