/**
 * A dashboard task's follow-up queue on the registry (2026-11-03): saved with
 * the task, back after a restart — paused, since the chain each word waited
 * for did not survive it — malformed entries dropped, never on a Slack session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-task-followups-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';
import { TASK_FOLLOWUP_PAUSED_BY_RESTART, TASK_FOLLOWUP_UNCERTAIN_AFTER_RESTART } from '../task-turn/task-followups';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const BASE = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };
const savedOf = (taskId: string) =>
  (JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, any>>).find((r) => r.taskId === taskId);

describe('SessionRegistry — a task’s follow-up queue', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('is saved with the task and comes back paused after a restart', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(BASE);
    task.taskFollowups = [
      { id: 'tq-1', text: 'goal 설정해줘', authorId: 'U1', enqueuedAt: 10, epoch: 0, state: 'queued' },
      {
        id: 'tq-2',
        text: '그 다음',
        authorId: 'U2',
        enqueuedAt: 11,
        epoch: 3,
        state: 'paused',
        stateReason: '중지',
        approvedText: '그 다음',
      },
    ];
    reg.saveSessions();
    expect(savedOf(task.taskId!)?.taskFollowups).toHaveLength(2);

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(task.taskId!)?.taskFollowups).toEqual([
      {
        id: 'tq-1',
        text: 'goal 설정해줘',
        authorId: 'U1',
        enqueuedAt: 10,
        epoch: 1,
        state: 'paused',
        stateReason: TASK_FOLLOWUP_PAUSED_BY_RESTART,
      },
      {
        id: 'tq-2',
        text: '그 다음',
        authorId: 'U2',
        enqueuedAt: 11,
        epoch: 3,
        state: 'paused',
        stateReason: '중지',
        // The words a one-time approval covered stay covered across the restart.
        approvedText: '그 다음',
      },
    ]);
  });

  it('a word a restart caught in flight comes back paused, saying it may have gone out (review R2)', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(BASE);
    task.taskFollowups = [{ id: 'tq-s', text: '보내는 중', authorId: 'U1', enqueuedAt: 1, epoch: 4, state: 'sending' }];
    reg.saveSessions();
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(task.taskId!)?.taskFollowups).toEqual([
      {
        id: 'tq-s',
        text: '보내는 중',
        authorId: 'U1',
        enqueuedAt: 1,
        epoch: 5,
        state: 'paused',
        stateReason: TASK_FOLLOWUP_UNCERTAIN_AFTER_RESTART,
      },
    ]);
  });

  it('load drops malformed words, and an empty queue is none', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(BASE);
    reg.saveSessions();
    const records = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, any>>;
    const record = records.find((r) => r.taskId === task.taskId)!;
    record.taskFollowups = [
      { id: 'ok', text: 'go', authorId: 'U1', enqueuedAt: 1, epoch: 0, state: 'queued' },
      { id: 'ok', text: 'duplicate id', authorId: 'U1', enqueuedAt: 1, epoch: 0, state: 'queued' },
      { id: 'no-text', text: '   ', authorId: 'U1', enqueuedAt: 1, epoch: 0, state: 'queued' },
      { id: 'no-author', text: 'go', enqueuedAt: 1, epoch: 0, state: 'queued' },
      'not an object',
    ];
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(records));
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(task.taskId!)?.taskFollowups?.map((i) => i.id)).toEqual(['ok']);

    record.taskFollowups = [{ id: 'x' }];
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(records));
    const again = new SessionRegistry();
    again.loadSessions();
    expect(again.getSessionByTaskId(task.taskId!)?.taskFollowups).toBeUndefined();
  });

  it('a Slack session never saves one', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '1700000000.000100');
    (session as any).taskFollowups = [
      { id: 'tq', text: 'go', authorId: 'U1', enqueuedAt: 1, epoch: 0, state: 'queued' },
    ];
    reg.saveSessions();
    const records = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, any>>;
    expect(records.find((r) => r.channelId === 'C1')?.taskFollowups).toBeUndefined();
  });
});
