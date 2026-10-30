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
