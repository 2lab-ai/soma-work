/**
 * E2 ② — a Slack-instructed task's input context is stored with the task
 * (.prd/18 D4): the channel's name, description, repos and wiki, snapshotted
 * at creation. It survives save, restart, archive and revive; a malformed one is
 * dropped on load; only a Slack-less task carries one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-task-input-ctx-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { Logger } from '../logger';
import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const INPUT = {
  channelName: 'soma-work',
  channelDescription: '<https://github.com/2lab-ai/soma-work>',
  repos: ['2lab-ai/soma-work'],
  confluenceUrl: 'https://wiki.example.com/x/PROJ',
};
const TASK_INPUT = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };

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

describe('SessionRegistry — a task’s input context (E2 ②)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('is saved with the task, comes back after a restart, and is a copy (a later change to the input does not leak in)', () => {
    const input = { ...INPUT, repos: [...INPUT.repos] };
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, inputContext: input });
    input.repos.push('evil/added-later');
    expect(task.inputContext).toEqual(INPUT);

    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    expect(saved[0].inputContext).toEqual(INPUT);

    const after = new SessionRegistry();
    expect(after.loadSessions()).toBe(1);
    expect(after.getSessionByTaskId(task.taskId!)?.inputContext).toEqual(INPUT);
  });

  it('a dashboard task has none', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    expect(task.inputContext).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))[0].inputContext).toBeUndefined();
  });

  it('a context with nothing usable is not stored, and the create says so', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const reg = new SessionRegistry();
      const task = reg.createTask({ ...TASK_INPUT, inputContext: { repos: [''], channelDescription: '' } as any });
      expect(task.inputContext).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/input context had no usable field/), expect.anything());
      warn.mockClear();
      reg.createTask(TASK_INPUT);
      expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/input context/), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('survives archive and revive', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, inputContext: INPUT });
    reg.terminateSession(`task:${task.taskId}`);
    const dir = path.join(TEST_DATA_DIR, 'archives');
    const archived = JSON.parse(
      fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))!), 'utf8'),
    );
    expect(archived.inputContext).toEqual(INPUT);
    expect(reg.restoreArchivedSession(archived, '/work/U1/session_1')).toMatchObject({ ok: true });
    expect(reg.getSessionByTaskId(task.taskId!)?.inputContext).toEqual(INPUT);
  });

  it('load keeps only well-formed string fields; a malformed context is dropped, the task still loads', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord('44444440-4444-4444-8444-444444444444', { inputContext: 'not an object' }),
        slacklessRecord('44444441-4444-4444-8444-444444444444', {
          inputContext: { repos: 'a/b', channelDescription: 7 },
        }),
        slacklessRecord('44444442-4444-4444-8444-444444444444', {
          inputContext: { channelDescription: 'ok', repos: ['a/b', 5, ''], confluenceUrl: '', extra: 'dropped' },
        }),
      ]),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(3);
    expect(reg.getSessionByTaskId('44444440-4444-4444-8444-444444444444')?.inputContext).toBeUndefined();
    expect(reg.getSessionByTaskId('44444441-4444-4444-8444-444444444444')?.inputContext).toBeUndefined();
    expect(reg.getSessionByTaskId('44444442-4444-4444-8444-444444444444')?.inputContext).toEqual({
      channelDescription: 'ok',
      repos: ['a/b'],
    });
  });

  it('a Slack session’s record never carries one', () => {
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
          inputContext: INPUT,
        },
      ]),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);
    expect(reg.getSession('C555', '1700000005.000100')?.inputContext).toBeUndefined();
  });
});
