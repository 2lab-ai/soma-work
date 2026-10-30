/**
 * Task id contract (MVP-A0 #595) — the registry half.
 *
 *   T1 a session is found by its task id: the same object `getSession(channel,
 *      threadTs)` returns, which itself is unchanged.
 *   T2 the task id stays put across `/new` (resetSessionContext) and
 *      invalid-resume recovery (clearSessionId); the SDK `sessionId` does not.
 *      (Bot-thread migration: session-initializer-task-id-migration.test.ts.)
 *   T3 restart and revive keep the lookup right: the task id and its link to
 *      the conversation record (conversationId — the key of the work log,
 *      artifacts and user media) survive save/load, the startup conversationId
 *      backfill, and an archive revive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-task-id-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { getArchiveStore } from '../session-archive';
import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const DAY = 24 * 60 * 60 * 1000;

function freshDataDir(): void {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  // The archive store is a process singleton that creates its directory once;
  // recreate it after the wipe so terminate/sweep archives land on disk.
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
  __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
}

/** A session that passes the save filter (it has run an SDK turn). */
function ranSession(reg: SessionRegistry, channel: string, threadTs: string) {
  const session = reg.createSession('U1', 'User', channel, threadTs);
  session.sessionId = `sdk-${threadTs}`;
  session.state = 'MAIN';
  return session;
}

describe('SessionRegistry — task id lookup (T1)', () => {
  beforeEach(freshDataDir);
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('T1.1 — a new session has a task id, and the lookup returns the same object getSession does', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '100.001');

    expect(typeof session.taskId).toBe('string');
    expect(session.taskId).not.toBe('');
    expect(reg.getSessionByTaskId(session.taskId!)).toBe(session);
    // The Slack path is unchanged.
    expect(reg.getSession('C1', '100.001')).toBe(session);
    expect(reg.getSessionByKey(reg.getSessionKey('C1', '100.001'))).toBe(session);
  });

  it('T1.2 — every session gets its own task id, independent of channel/thread and of conversationId', () => {
    const reg = new SessionRegistry();
    const a = reg.createSession('U1', 'User', 'C1', '100.001');
    const b = reg.createSession('U1', 'User', 'C1', '100.002');
    const c = reg.createSession('U1', 'User', 'C2'); // channel-level session
    a.conversationId = 'conv-a';

    const ids = new Set([a.taskId, b.taskId, c.taskId]);
    expect(ids.size).toBe(3);
    expect(a.taskId).not.toBe(a.conversationId);
    expect(reg.getSessionByTaskId(b.taskId!)).toBe(b);
    expect(reg.getSessionByTaskId(c.taskId!)).toBe(c);
  });

  it('T1.3 — unknown ids miss; a terminated session is no longer found', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '100.001');
    const taskId = session.taskId!;

    expect(reg.getSessionByTaskId('no-such-task')).toBeUndefined();
    expect(reg.getSessionByTaskId('')).toBeUndefined();

    expect(reg.terminateSession(reg.getSessionKey('C1', '100.001'))).toBe(true);
    expect(reg.getSessionByTaskId(taskId)).toBeUndefined();
    expect(reg.getSession('C1', '100.001')).toBeUndefined();
  });

  it('T1.4 — a session ended by the sleep-expiry sweep is no longer found', async () => {
    const reg = new SessionRegistry();
    const session = ranSession(reg, 'C1', '100.001');
    session.state = 'SLEEPING';
    session.sleepStartedAt = new Date(Date.now() - 365 * DAY);
    const taskId = session.taskId!;

    await reg.cleanupInactiveSessions();

    expect(reg.getSession('C1', '100.001')).toBeUndefined();
    expect(reg.getSessionByTaskId(taskId)).toBeUndefined();
  });

  it('T1.5 — a session replaced under the same channel/thread key does not leave its task id behind', () => {
    const reg = new SessionRegistry();
    const first = reg.createSession('U1', 'User', 'C1', '100.001');
    const second = reg.createSession('U1', 'User', 'C1', '100.001');

    expect(reg.getSession('C1', '100.001')).toBe(second);
    expect(reg.getSessionByTaskId(second.taskId!)).toBe(second);
    expect(reg.getSessionByTaskId(first.taskId!)).toBeUndefined();
  });
});

describe('SessionRegistry — task id across a context reset (T2)', () => {
  beforeEach(freshDataDir);
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('T2.1 — /new (resetSessionContext) keeps the task id; the SDK sessionId is cleared and replaced', () => {
    const reg = new SessionRegistry();
    const session = ranSession(reg, 'C1', '200.001');
    session.conversationId = 'conv-200';
    const taskId = session.taskId!;
    const firstRun = session.sessionId;

    expect(reg.resetSessionContext('C1', '200.001')).toBe(true);

    expect(session.sessionId).toBeUndefined();
    expect(session.taskId).toBe(taskId);
    expect(session.conversationId).toBe('conv-200');
    expect(reg.getSessionByTaskId(taskId)).toBe(session);

    // The next SDK turn starts a new run session under the same task.
    session.sessionId = 'sdk-200-second-run';
    expect(session.sessionId).not.toBe(firstRun);
    expect(reg.getSessionByTaskId(taskId)).toBe(session);
  });

  it('T2.2 — invalid-resume recovery (clearSessionId) keeps the task id', () => {
    const reg = new SessionRegistry();
    const session = ranSession(reg, 'C1', '200.002');
    const taskId = session.taskId!;

    reg.clearSessionId('C1', '200.002');

    expect(session.sessionId).toBeUndefined();
    expect(session.taskId).toBe(taskId);
    expect(reg.getSessionByTaskId(taskId)).toBe(session);
  });

  it('T2.3 — an inherited task id moves to the new session; terminating the old one keeps the lookup', () => {
    const reg = new SessionRegistry();
    const original = ranSession(reg, 'C1', '200.003');
    const taskId = original.taskId!;

    const moved = reg.createSession('U1', 'User', 'C1', '200.004', undefined, { taskId });
    expect(moved.taskId).toBe(taskId);
    expect(reg.getSessionByTaskId(taskId)).toBe(moved);
    // At most one live session carries a task id.
    expect(original.taskId).toBeUndefined();

    reg.terminateSession(reg.getSessionKey('C1', '200.003'));
    expect(reg.getSessionByTaskId(taskId)).toBe(moved);
  });
});

describe('SessionRegistry — task id across restart and revive (T3)', () => {
  beforeEach(freshDataDir);
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('T3.1 — save → load keeps the task id, its lookup and its conversationId link', () => {
    const before = new SessionRegistry();
    const session = ranSession(before, 'C1', '300.001');
    session.conversationId = 'conv-300';
    const taskId = session.taskId!;
    before.saveSessions();

    const after = new SessionRegistry();
    expect(after.loadSessions()).toBe(1);

    const loaded = after.getSessionByTaskId(taskId);
    expect(loaded).toBeDefined();
    expect(loaded).toBe(after.getSession('C1', '300.001'));
    expect(loaded!.conversationId).toBe('conv-300');

    // Loading the same file again replaces the session under its key and keeps the id.
    after.loadSessions();
    expect(after.getSessionByTaskId(taskId)).toBe(after.getSession('C1', '300.001'));
    expect(after.getSessionByTaskId(taskId)).not.toBe(loaded);
  });

  it('T3.2 — a session saved before task ids existed gets one on load, kept across the next restart', async () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        {
          key: 'C1-300.002',
          ownerId: 'U1',
          ownerName: 'User',
          userId: 'U1',
          channelId: 'C1',
          threadTs: '300.002',
          sessionId: 'sdk-legacy',
          isActive: true,
          lastActivity: new Date().toISOString(),
          state: 'MAIN',
          activityState: 'idle',
          // no taskId, no conversationId — written by an older build
        },
      ]),
    );
    // The conversation record the startup backfill links back to the session.
    const conversationsDir = path.join(TEST_DATA_DIR, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(conversationsDir, 'conv-legacy.json'),
      JSON.stringify({
        id: 'conv-legacy',
        channelId: 'C1',
        threadTs: '300.002',
        ownerId: 'U1',
        ownerName: 'User',
        createdAt: 1,
        updatedAt: 1,
        turns: [],
      }),
    );

    const first = new SessionRegistry();
    expect(first.loadSessions()).toBe(1);
    const session = first.getSession('C1', '300.002')!;
    const taskId = session.taskId!;
    expect(typeof taskId).toBe('string');
    expect(first.getSessionByTaskId(taskId)).toBe(session);

    expect(await first.backfillConversationIds()).toBe(1);
    expect(session.conversationId).toBe('conv-legacy');
    expect(first.getSessionByTaskId(taskId)).toBe(session);

    // The minted id is on disk, so the next restart finds the same task.
    const second = new SessionRegistry();
    second.loadSessions();
    const again = second.getSessionByTaskId(taskId);
    expect(again).toBe(second.getSession('C1', '300.002'));
    expect(again!.conversationId).toBe('conv-legacy');
  });

  it('T3.3 — two saved sessions claiming one task id: the second gets a fresh one', () => {
    const base = {
      ownerId: 'U1',
      ownerName: 'User',
      userId: 'U1',
      channelId: 'C1',
      isActive: true,
      lastActivity: new Date().toISOString(),
      state: 'MAIN',
      activityState: 'idle',
      taskId: 'task-dup',
    };
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        { ...base, key: 'C1-300.003', threadTs: '300.003', sessionId: 'sdk-a' },
        { ...base, key: 'C1-300.004', threadTs: '300.004', sessionId: 'sdk-b' },
      ]),
    );

    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(2);
    const a = reg.getSession('C1', '300.003')!;
    const b = reg.getSession('C1', '300.004')!;

    expect(a.taskId).toBe('task-dup');
    expect(reg.getSessionByTaskId('task-dup')).toBe(a);
    expect(b.taskId).not.toBe('task-dup');
    expect(reg.getSessionByTaskId(b.taskId!)).toBe(b);
  });

  it('T3.4 — an archive revive brings the task id (and its conversationId) back', () => {
    const reg = new SessionRegistry();
    const session = ranSession(reg, 'C1', '300.005');
    session.conversationId = 'conv-305';
    session.sessionWorkingDir = '/tmp/U1/session_1793000000000_ab12cd34';
    const taskId = session.taskId!;
    const key = reg.getSessionKey('C1', '300.005');

    reg.terminateSession(key);
    expect(reg.getSessionByTaskId(taskId)).toBeUndefined();

    const archived = getArchiveStore()
      .listRecent(DAY)
      .find((a) => a.sessionKey === key);
    expect(archived?.taskId).toBe(taskId);

    expect(reg.restoreArchivedSession(archived!, session.sessionWorkingDir)).toMatchObject({ ok: true });
    const revived = reg.getSessionByTaskId(taskId);
    expect(revived).toBe(reg.getSession('C1', '300.005'));
    expect(revived!.conversationId).toBe('conv-305');
  });

  it('T3.5 — a revive whose task id is already live gets a fresh id instead of stealing it', () => {
    const reg = new SessionRegistry();
    const live = ranSession(reg, 'C1', '300.006');
    const taskId = live.taskId!;

    const outcome = reg.restoreArchivedSession(
      {
        archivedAt: 1793600000000,
        archiveReason: 'sleep_expired',
        sessionKey: 'work:C1:300.007',
        sessionId: 'sdk-old',
        taskId,
        ownerId: 'U1',
        channelId: 'C1',
        threadTs: '300.007',
        lastActivity: new Date().toISOString(),
      },
      '/tmp/U1/session_1793000000000_ab12cd35',
    );

    expect(outcome).toMatchObject({ ok: true });
    expect(reg.getSessionByTaskId(taskId)).toBe(live);
    const revived = reg.getSession('C1', '300.007')!;
    expect(revived.taskId).not.toBe(taskId);
    expect(reg.getSessionByTaskId(revived.taskId!)).toBe(revived);
  });
});
