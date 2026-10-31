/**
 * E2 ① — the instruction thread a Slack-less task came from (`originThread`).
 *
 *   O1 a task created from a Slack instruction keeps the thread it came from, saved
 *      with the task's first strict save, and is found by that thread — while the
 *      Slack key of the thread still finds no session.
 *   O2 it survives a restart, and the lookup is rebuilt from the records on load.
 *   O3 one LIVE task per instruction thread: a second create on the same thread is
 *      refused before anything is saved.
 *   O4 an archived task is not found by its thread (live tasks only); its archive
 *      record keeps the thread, and the thread can start a new task.
 *   O5 a revived task gets its thread back — unless a live task holds it by then.
 *   O6 load keeps the first of two records claiming one thread, drops a malformed
 *      thread, and never indexes a thread on a Slack session's record.
 *   O7 the conversation-id backfill never touches a task by its instruction thread.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter, threadIndex } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-origin-thread-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
    threadIndex: new Map<string, string>(),
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));
vi.mock('../conversation/storage', () => ({
  ConversationStorage: class {
    async buildThreadIndex() {
      return threadIndex;
    }
  },
}));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { OriginThreadTakenError, SessionRegistry } from '../session-registry';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const ORIGIN = { channel: 'C123', threadTs: '1700000000.000100', messageTs: '1700000000.000100' };
const TASK_INPUT = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };

type SavedRecord = { key?: string; taskId?: string; originThread?: unknown };

function readSaved(): SavedRecord[] {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as SavedRecord[];
}

function slacklessRecord(taskId: string, extra: Record<string, unknown> = {}) {
  return {
    key: `task:${taskId}`,
    ownerId: 'U1',
    ownerName: 'User',
    userId: 'U1',
    channelId: '',
    slackless: true,
    taskId,
    isActive: true,
    lastActivity: new Date().toISOString(),
    workingDirectory: '/work/U1/session_1',
    state: 'MAIN',
    activityState: 'idle',
    ...extra,
  };
}

function closeAndReadArchive(reg: SessionRegistry, taskId: string) {
  reg.terminateSession(`task:${taskId}`);
  const dir = path.join(TEST_DATA_DIR, 'archives');
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!;
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

describe('SessionRegistry — a task’s instruction thread (E2 ①)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
    threadIndex.clear();
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('O1 — the thread is saved with the first strict save and finds the task; the thread’s Slack key still finds nothing', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });

    expect(task.originThread).toEqual(ORIGIN);
    // Still a Slack-less task: no Slack binding is invented from its thread.
    expect(task.slackless).toBe(true);
    expect(task.channelId).toBe('');
    expect(task.threadTs).toBeUndefined();
    expect(reg.getSession(ORIGIN.channel, ORIGIN.threadTs)).toBeUndefined();

    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)).toBe(task);
    expect(reg.getTaskByOriginThread(ORIGIN.channel, '1700000000.999999')).toBeUndefined();
    expect(reg.getTaskByOriginThread('C999', ORIGIN.threadTs)).toBeUndefined();

    // On disk before createTask returned.
    const saved = readSaved();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ key: `task:${task.taskId}`, originThread: ORIGIN });
  });

  it('O1b — a task with no instruction thread (a dashboard task) saves none and is found by none', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    expect(task.originThread).toBeUndefined();
    expect(readSaved()[0].originThread).toBeUndefined();
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)).toBeUndefined();
  });

  it('O1c — an instruction thread with an empty part is a caller bug: refused, nothing created', () => {
    const reg = new SessionRegistry();
    for (const bad of [
      { ...ORIGIN, channel: '' },
      { ...ORIGIN, threadTs: '' },
      { ...ORIGIN, messageTs: '' },
    ]) {
      expect(() => reg.createTask({ ...TASK_INPUT, originThread: bad })).toThrow(/originThread/);
    }
    expect([...reg.getAllSessions().keys()]).toEqual([]);
    expect(fs.existsSync(SESSIONS_FILE)).toBe(false);
  });

  it('O2 — after a restart the task keeps its thread and the lookup is rebuilt from the records', () => {
    const first = new SessionRegistry();
    const task = first.createTask({ ...TASK_INPUT, originThread: { ...ORIGIN, agent: 'helper' } });

    const after = new SessionRegistry();
    expect(after.loadSessions()).toBe(1);
    const back = after.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs);
    expect(back?.taskId).toBe(task.taskId);
    expect(back?.originThread).toEqual({ ...ORIGIN, agent: 'helper' });
    expect(after.getSession(ORIGIN.channel, ORIGIN.threadTs)).toBeUndefined();
  });

  it('O3 — a second live task on the same thread is refused before anything is saved', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    const before = fs.readFileSync(SESSIONS_FILE, 'utf8');

    let refused: unknown;
    try {
      reg.createTask({ ...TASK_INPUT, originThread: { ...ORIGIN, messageTs: '1700000000.000200' } });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(OriginThreadTakenError);
    // The entry (⑧) answers with the holder's card: the error names it.
    expect((refused as OriginThreadTakenError).holderTaskId).toBe(task.taskId);
    expect([...reg.getAllSessions().keys()]).toEqual([`task:${task.taskId}`]);
    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).toBe(before);
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)).toBe(task);

    // Another thread in the same channel is its own origin.
    const other = reg.createTask({ ...TASK_INPUT, originThread: { ...ORIGIN, threadTs: '1700000001.000100' } });
    expect(reg.getTaskByOriginThread(ORIGIN.channel, '1700000001.000100')).toBe(other);
  });

  it('O4 — an archived task is not found by its thread; the archive keeps the thread; the thread can start a new task', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    const archived = closeAndReadArchive(reg, task.taskId!);

    expect(archived.originThread).toEqual(ORIGIN);
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)).toBeUndefined();

    const next = reg.createTask({ ...TASK_INPUT, originThread: { ...ORIGIN, messageTs: '1700000000.000300' } });
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)).toBe(next);
  });

  it('O5 — a revived task gets its thread back', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    const archived = closeAndReadArchive(reg, task.taskId!);

    const outcome = reg.restoreArchivedSession(archived, '/work/U1/session_1');
    expect(outcome).toMatchObject({ ok: true, sessionKey: `task:${task.taskId}` });
    const back = reg.getSessionByKey(`task:${task.taskId}`)!;
    expect(back.originThread).toEqual(ORIGIN);
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)).toBe(back);
  });

  it('O5b — a revived task whose thread a live task now holds comes back without it; the live task keeps the thread', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    const archived = closeAndReadArchive(reg, task.taskId!);
    const holder = reg.createTask({ ...TASK_INPUT, originThread: { ...ORIGIN, messageTs: '1700000000.000300' } });

    const outcome = reg.restoreArchivedSession(archived, '/work/U1/session_1');
    expect(outcome).toMatchObject({ ok: true });
    const back = reg.getSessionByKey(`task:${task.taskId}`)!;
    expect(back.originThread).toBeUndefined();
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)).toBe(holder);

    // What is saved agrees with memory: the revived record carries no thread.
    const saved = readSaved().find((r) => r.taskId === task.taskId);
    expect(saved?.originThread).toBeUndefined();
  });

  it('O5c — loading the same records twice moves each thread to the new object (the old one gives it up first)', () => {
    const first = new SessionRegistry();
    const task = first.createTask({ ...TASK_INPUT, originThread: ORIGIN });

    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);
    const a = reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs);
    expect(reg.loadSessions()).toBe(1);
    const b = reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs);
    expect(b).toBeDefined();
    expect(b).not.toBe(a);
    expect(b).toBe(reg.getSessionByKey(`task:${task.taskId}`));
    expect(b?.originThread).toEqual(ORIGIN);
  });

  it('O5d — a task archived on load (asleep past the archive window) keeps its thread in the archive, and a revive gets it back', () => {
    const taskId = '66666666-6666-4666-8666-666666666666';
    const long = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord(taskId, { originThread: ORIGIN, state: 'SLEEPING', sleepStartedAt: long, lastActivity: long }),
      ]),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(0);
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)).toBeUndefined();

    const dir = path.join(TEST_DATA_DIR, 'archives');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!;
    const archived = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    expect(archived.originThread).toEqual(ORIGIN);
    expect(reg.restoreArchivedSession(archived, '/work/U1/session_1')).toMatchObject({ ok: true });
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)?.taskId).toBe(taskId);
  });

  it('O6 — load: the first record claiming a thread keeps it; the second keeps its task without the thread', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord('11111111-1111-4111-8111-111111111111', { originThread: ORIGIN }),
        slacklessRecord('22222222-2222-4222-8222-222222222222', {
          originThread: { ...ORIGIN, messageTs: '1700000000.000200' },
        }),
      ]),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(2);
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)?.taskId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    const second = reg.getSessionByTaskId('22222222-2222-4222-8222-222222222222');
    expect(second).toBeDefined();
    expect(second?.originThread).toBeUndefined();
  });

  it('O6b — load: a malformed thread is dropped and the task still loads', () => {
    const malformed = [
      'C123:1700000000.000100',
      { channel: 'C123' },
      { channel: 'C123', threadTs: 1700000000, messageTs: '1' },
      { channel: '', threadTs: '1', messageTs: '1' },
      { ...ORIGIN, agent: 42 },
    ];
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify(
        malformed.map((originThread, i) =>
          slacklessRecord(`3333333${i}-3333-4333-8333-333333333333`, { originThread }),
        ),
      ),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(malformed.length);
    for (let i = 0; i < malformed.length; i++) {
      expect(reg.getSessionByTaskId(`3333333${i}-3333-4333-8333-333333333333`)?.originThread).toBeUndefined();
    }
    expect(reg.getTaskByOriginThread('C123', '1700000000.000100')).toBeUndefined();
  });

  it('O6c — load: a Slack session’s record never carries or indexes an instruction thread', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        {
          key: 'C555-1700000005.000100',
          ownerId: 'U1',
          ownerName: 'User',
          userId: 'U1',
          channelId: 'C555',
          threadTs: '1700000005.000100',
          isActive: true,
          lastActivity: new Date().toISOString(),
          state: 'MAIN',
          activityState: 'idle',
          originThread: ORIGIN,
        },
      ]),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);
    expect(reg.getSession('C555', '1700000005.000100')?.originThread).toBeUndefined();
    expect(reg.getTaskByOriginThread(ORIGIN.channel, ORIGIN.threadTs)).toBeUndefined();
  });

  it('O7 — the conversation-id backfill never gives a task the conversation of its instruction thread', async () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    threadIndex.set(`${ORIGIN.channel}:${ORIGIN.threadTs}`, 'conv-of-the-slack-thread');

    await reg.backfillConversationIds();
    expect(task.conversationId).toBeUndefined();
  });
});
