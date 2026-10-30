/**
 * Slack-less task (MVP-A0 #596) — the registry half.
 *
 *   T4 a task created with no Slack channel/thread and no SDK session is saved
 *      before `createTask` returns, comes back after a restart under the same
 *      task id (not quarantined for its missing channel), and sits beside the
 *      Slack sessions without changing them. (Board: dashboard-slackless-task.test.ts.)
 *   T5 a failed save fails the create: it throws, and nothing stays in memory
 *      or reaches the next save (no false success).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-slackless-task-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { __resetSessionLifecyclePolicyForTests, updateSessionLifecyclePolicy } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const HOUR = 60 * 60 * 1000;

type SavedRecord = { key?: string; taskId?: string; slackless?: boolean; channelId?: string; threadTs?: string };

function readSaved(): SavedRecord[] {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as SavedRecord[];
}

const TASK_INPUT = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/repo', title: 'Fix the build' };

describe('SessionRegistry — Slack-less task (T4)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('T4.1 — creates a task with no Slack channel/thread and no SDK session, already on disk when it returns', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);

    expect(typeof task.taskId).toBe('string');
    expect(task.taskId).not.toBe('');
    expect(task.slackless).toBe(true);
    // No Slack binding is invented: no channel, no thread.
    expect(task.channelId).toBe('');
    expect(task.threadTs).toBeUndefined();
    expect(task.sessionId).toBeUndefined();
    expect(task.ownerId).toBe('U1');
    expect(task.workingDirectory).toBe('/work/U1/repo');
    expect(task.title).toBe('Fix the build');

    // Addressed by its task id — and by its own key namespace, beside the Slack keys.
    expect(reg.getSessionByTaskId(task.taskId!)).toBe(task);
    expect(reg.getSessionByKey(`task:${task.taskId}`)).toBe(task);
    expect([...reg.getAllSessions().keys()]).toEqual([`task:${task.taskId}`]);

    // Saved before createTask returned — nothing else has saved since.
    const saved = readSaved();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ key: `task:${task.taskId}`, taskId: task.taskId, slackless: true });
  });

  it('T4.2 — after a restart the never-run task loads under the same task id, with its working directory', () => {
    const before = new SessionRegistry();
    const task = before.createTask(TASK_INPUT);
    const taskId = task.taskId!;

    const after = new SessionRegistry();
    expect(after.loadSessions()).toBe(1);

    const loaded = after.getSessionByTaskId(taskId);
    expect(loaded).toBeDefined();
    expect(loaded).toBe(after.getSessionByKey(`task:${taskId}`));
    expect(loaded).toMatchObject({
      taskId,
      slackless: true,
      channelId: '',
      ownerId: 'U1',
      workingDirectory: '/work/U1/repo',
      title: 'Fix the build',
    });
    expect(loaded!.threadTs).toBeUndefined();
    expect(loaded!.sessionId).toBeUndefined();
    // The id was not re-minted on load, so the file still names the same task.
    expect(readSaved().map((r) => r.taskId)).toEqual([taskId]);

    // And again: a second restart finds the same task.
    const third = new SessionRegistry();
    expect(third.loadSessions()).toBe(1);
    expect(third.getSessionByTaskId(taskId)?.workingDirectory).toBe('/work/U1/repo');
  });

  it('T4.3 — a saved Slack-less record is restored under its task key, not quarantined for its empty channel', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        {
          key: 'task:task-saved',
          ownerId: 'U1',
          ownerName: 'User',
          userId: 'U1',
          channelId: '',
          isActive: true,
          lastActivity: new Date().toISOString(),
          workingDirectory: '/work/U1/repo',
          state: 'INITIALIZING',
          activityState: 'idle',
          taskId: 'task-saved',
          slackless: true,
        },
      ]),
    );

    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);
    const loaded = reg.getSessionByTaskId('task-saved');
    expect(loaded).toBeDefined();
    expect(loaded).toBe(reg.getSessionByKey('task:task-saved'));
    expect(loaded!.slackless).toBe(true);
  });

  it('T4.4 — a record with an empty channel and NO Slack-less mark is still quarantined (the exception is explicit)', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        {
          key: '-direct',
          ownerId: 'U1',
          userId: 'U1',
          channelId: '',
          sessionId: 'sdk-corrupt',
          isActive: true,
          lastActivity: new Date().toISOString(),
          state: 'MAIN',
          taskId: 'task-corrupt',
        },
      ]),
    );

    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(0);
    expect(reg.getSessionByTaskId('task-corrupt')).toBeUndefined();
    expect(reg.getAllSessions().size).toBe(0);
  });

  it('T4.5 — Slack sessions are unchanged beside a task: same keys, same save filter, same round-trip', () => {
    const reg = new SessionRegistry();
    const slack = reg.createSession('U1', 'User', 'C1', '100.001');
    slack.sessionId = 'sdk-100';
    slack.state = 'MAIN';
    const neverRanSlack = reg.createSession('U1', 'User', 'C1', '100.002'); // no SDK turn yet
    const task = reg.createTask(TASK_INPUT);

    expect(reg.getSession('C1', '100.001')).toBe(slack);
    expect(reg.getSessionByKey('work:C1:100.001')).toBe(slack);
    expect(reg.getSessionByTaskId(task.taskId!)).toBe(task);
    expect(slack.slackless).toBeUndefined();

    reg.saveSessions();
    const saved = readSaved();
    // The Slack record keeps its legacy key field; the never-run Slack session is still not saved.
    expect(saved.map((r) => r.key).sort()).toEqual(['C1-100.001', `task:${task.taskId}`].sort());
    expect(saved.find((r) => r.key === 'C1-100.001')).not.toHaveProperty('slackless');
    expect(neverRanSlack.taskId).toBeDefined();

    const after = new SessionRegistry();
    expect(after.loadSessions()).toBe(2);
    const slackLoaded = after.getSession('C1', '100.001');
    expect(slackLoaded?.taskId).toBe(slack.taskId);
    expect(slackLoaded?.slackless).toBeUndefined();
    expect(after.getSessionByTaskId(slack.taskId!)).toBe(slackLoaded);
    expect(after.getSession('C1', '100.002')).toBeUndefined();
    expect(after.getSessionByTaskId(task.taskId!)?.slackless).toBe(true);
    expect([...after.getAllSessions().keys()].sort()).toEqual(['work:C1:100.001', `task:${task.taskId}`].sort());
  });

  it('T4.6 — the idle sweep sleeps an idle task without the Slack expiry notices (it has no thread)', async () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    const reg = new SessionRegistry();
    const cb = {
      onWarning: vi.fn(async () => undefined),
      onSleep: vi.fn(async () => undefined),
      onExpiry: vi.fn(async () => undefined),
    };
    reg.setExpiryCallbacks(cb);
    const task = reg.createTask(TASK_INPUT);

    // Inside the warning window: no Slack warning.
    task.lastActivity = new Date(Date.now() - (2 * HOUR - 5 * 60 * 1000));
    await reg.cleanupInactiveSessions();
    expect(cb.onWarning).not.toHaveBeenCalled();

    // Past the idle limit: it sleeps (and stays saved), no Slack sleep notice.
    task.lastActivity = new Date(Date.now() - 3 * HOUR);
    await reg.cleanupInactiveSessions();
    expect(task.state).toBe('SLEEPING');
    expect(cb.onSleep).not.toHaveBeenCalled();
    expect(readSaved().find((r) => r.taskId === task.taskId)).toBeDefined();
  });

  it('rejects a task with no owner or no working directory', () => {
    const reg = new SessionRegistry();
    expect(() => reg.createTask({ ...TASK_INPUT, ownerId: '' })).toThrow(/ownerId/);
    expect(() => reg.createTask({ ...TASK_INPUT, workingDirectory: '' })).toThrow(/workingDirectory/);
    expect(reg.getAllSessions().size).toBe(0);
  });
});

describe('SessionRegistry — Slack-less task save failure (T5)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('T5.1 — a failed save fails the create, and nothing stays in memory or reaches the next save', () => {
    const reg = new SessionRegistry();
    const slack = reg.createSession('U1', 'User', 'C1', '200.001');
    slack.sessionId = 'sdk-200';
    // sessions.json cannot be written: a directory sits at its path.
    fs.mkdirSync(SESSIONS_FILE);

    expect(() => reg.createTask(TASK_INPUT)).toThrow(/EISDIR/);

    // No false success: no task in memory, by key or by task id.
    expect([...reg.getAllSessions().keys()]).toEqual(['work:C1:200.001']);
    expect([...reg.getAllSessions().values()].some((s) => s.slackless)).toBe(false);
    expect(reg.getSessionByTaskId(slack.taskId!)).toBe(slack);

    // Once the disk is writable again, the next save carries only the Slack session.
    fs.rmSync(SESSIONS_FILE, { recursive: true });
    reg.saveSessions();
    const saved = readSaved();
    expect(saved).toHaveLength(1);
    expect(saved[0].key).toBe('C1-200.001');
  });

  it('T5.2 — the failure is not swallowed: the caller sees the write error', () => {
    const reg = new SessionRegistry();
    fs.mkdirSync(SESSIONS_FILE);
    let caught: unknown;
    try {
      reg.createTask(TASK_INPUT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe('EISDIR');
    expect(reg.getAllSessions().size).toBe(0);
  });
});

describe('SessionRegistry — Slack-less task review fixes (#612 R1)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  const slacklessRecord = (over: Record<string, unknown> = {}) => ({
    key: 'task:x',
    ownerId: 'U1',
    ownerName: 'User',
    userId: 'U1',
    channelId: '',
    taskId: '11111111-1111-4111-8111-111111111111',
    slackless: true,
    workingDirectory: '/work/U1/repo',
    isActive: true,
    lastActivity: new Date().toISOString(),
    state: 'MAIN',
    activityState: 'idle',
    ...over,
  });

  it('R1 — adoptTaskId refuses a Slack-less task: its key and its id never drift apart', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const id = task.taskId!;
    expect(reg.adoptTaskId(`task:${id}`, '22222222-2222-4222-8222-222222222222')).toBe(false);
    expect(task.taskId).toBe(id);
    expect(reg.getSessionByTaskId(id)).toBe(task);
    expect(reg.getSessionByKey(`task:${id}`)).toBe(task);
  });

  it('R2 — a Slack-less record with a separator in its task id, a channel, a thread or no task id is quarantined on load', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord({ taskId: 'a:b' }),
        slacklessRecord({ taskId: 'a/b' }),
        slacklessRecord({ taskId: '33333333-3333-4333-8333-333333333333', channelId: 'C1' }),
        slacklessRecord({ taskId: '44444444-4444-4444-8444-444444444444', threadTs: '1.1' }),
        slacklessRecord({ taskId: undefined }),
      ]),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(0);
    expect(reg.getAllSessions().size).toBe(0);
  });

  it('R3 — two Slack-less records with one task id in the same file: the second is quarantined, the first keeps its owner', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([slacklessRecord({ ownerId: 'U1' }), slacklessRecord({ ownerId: 'U2', ownerName: 'Other' })]),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);
    const task = reg.getSessionByTaskId('11111111-1111-4111-8111-111111111111');
    expect(task?.ownerId).toBe('U1');
    // A reload of the same registry is not a duplicate.
    reg.saveSessions();
    expect(reg.loadSessions()).toBe(1);
    expect(reg.getSessionByTaskId('11111111-1111-4111-8111-111111111111')).toBeDefined();
  });

  it('R4 — a Slack-less task is never queued for crash recovery (no Slack thread to resume or notify)', () => {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify([slacklessRecord({ activityState: 'working' })]));
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);
    expect(reg.getCrashRecoveredSessions()).toHaveLength(0);
  });

  it('R5 — an archived Slack-less task keeps its slackless mark', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    reg.terminateSession(`task:${task.taskId}`);
    const dir = path.join(TEST_DATA_DIR, 'archives');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const archived = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(archived.slackless).toBe(true);
    expect(archived.taskId).toBe(task.taskId);
  });

  function closeAndReadArchive(reg: SessionRegistry, taskId: string) {
    reg.terminateSession(`task:${taskId}`);
    const dir = path.join(TEST_DATA_DIR, 'archives');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!;
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  }

  it('R6 — restoring an archived Slack-less task brings it back under its task key, still Slack-less (#612 R2)', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const archived = closeAndReadArchive(reg, task.taskId!);
    expect(reg.getSessionByKey(`task:${task.taskId}`)).toBeUndefined();

    const outcome = reg.restoreArchivedSession(archived, '/work/U1/repo');
    expect(outcome).toMatchObject({ ok: true, sessionKey: `task:${task.taskId}` });
    const back = reg.getSessionByKey(`task:${task.taskId}`)!;
    expect(back.slackless).toBe(true); // the run guards (dashboard 409, goal resume skip) read this
    expect(back.taskId).toBe(task.taskId);
    expect(back.channelId).toBe('');
    expect(back.threadTs).toBeUndefined();
    expect(reg.getSessionByTaskId(task.taskId!)).toBe(back);
  });

  it('R6 — a Slack-less archive whose task id another live session holds is refused, not given a new id (#612 R2)', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const archived = closeAndReadArchive(reg, task.taskId!);
    const other = reg.createSession('U1', 'User', 'C9', '900.001');
    expect(reg.adoptTaskId(reg.getSessionKey('C9', '900.001'), task.taskId!)).toBe(true);

    const outcome = reg.restoreArchivedSession(archived, '/work/U1/repo');
    expect(outcome).toMatchObject({ ok: false, code: 'conflict' });
    expect(reg.getSessionByKey(`task:${task.taskId}`)).toBeUndefined();
    expect(reg.getSessionByTaskId(task.taskId!)).toBe(other);
  });

  it('R7 — a session whose key cannot be built is left out of the save; every other session is still saved (#612 R2)', () => {
    const reg = new SessionRegistry();
    const good = reg.createTask(TASK_INPUT);
    const bad = reg.createTask({ ...TASK_INPUT, title: 'bad' });
    bad.taskId = 'a:b'; // only a direct write can get here; createTask and the loader refuse it
    const slack = reg.createSession('U1', 'User', 'C1', '100.001');
    slack.sessionId = 'sdk-1';
    reg.saveSessions();
    const saved = readSaved();
    expect(saved.map((r) => r.key).sort()).toEqual([`task:${good.taskId}`, 'C1-100.001'].sort());
  });

  it('R6 — a malformed Slack-less archive (a channel, or a bad task id) is refused without throwing (#612 R2)', () => {
    const reg = new SessionRegistry();
    const base = {
      archivedAt: 1793600000000,
      archiveReason: 'sleep_expired',
      ownerId: 'U1',
      slackless: true as const,
      lastActivity: new Date().toISOString(),
    };
    const cases = [
      { ...base, sessionKey: 'task:t-1', taskId: 't-1', channelId: 'C1', threadTs: '1.1' },
      { ...base, sessionKey: 'task:a:b', taskId: 'a:b', channelId: '' },
      { ...base, sessionKey: 'task:', channelId: '' },
    ];
    for (const archived of cases) {
      const outcome = reg.restoreArchivedSession(archived as any, '/work/U1/repo');
      expect(outcome).toMatchObject({ ok: false, code: 'conflict' });
    }
    expect(reg.getAllSessions().size).toBe(0);
  });
});
