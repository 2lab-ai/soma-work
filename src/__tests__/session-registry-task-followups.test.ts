/**
 * A dashboard task's follow-up queue on the registry (2026-11-03): saved with
 * the task, back after a restart — still queued, so the boot sends it (owner
 * directive 2026-11-03: a word not processed before a restart is sent after it,
 * unless a person stopped the work) — malformed entries dropped, never on a
 * Slack session.
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
import {
  sanitizeTaskFollowups,
  TASK_FOLLOWUP_PAUSED_BEHIND_REFUSED,
  TASK_FOLLOWUP_PAUSED_BY_RESTART,
  TASK_FOLLOWUP_PAUSED_BY_STOP,
  TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END,
  TASK_FOLLOWUP_RESTART_RESEND_WINDOW_MS,
  TASK_FOLLOWUP_UNCERTAIN_AFTER_RESTART,
} from '../task-turn/task-followups';

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

  it('is saved with the task and comes back queued after a restart — a stopped word stays paused', () => {
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
        // Still waiting to be sent: the boot sends it (owner directive 2026-11-03).
        state: 'queued',
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

describe('sanitizeTaskFollowups — what a restart does to each word (owner directive 2026-11-03)', () => {
  const NOW = 1_800_000_000_000;
  const HOUR = 60 * 60 * 1000;
  const base = { text: 'go', authorId: 'U1', epoch: 2 };
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('a queued word stays queued — a state change: a new epoch, no reason', () => {
    expect(
      sanitizeTaskFollowups([{ ...base, id: 'q', enqueuedAt: NOW - 5 * HOUR, state: 'queued', stateReason: 'x' }], NOW),
    ).toEqual([{ ...base, id: 'q', enqueuedAt: NOW - 5 * HOUR, epoch: 3, state: 'queued' }]);
  });

  it('a word an earlier restart paused (before this rule) comes back queued while it is under 24 hours old', () => {
    expect(TASK_FOLLOWUP_RESTART_RESEND_WINDOW_MS).toBe(24 * HOUR);
    const legacy = { ...base, state: 'paused', stateReason: TASK_FOLLOWUP_PAUSED_BY_RESTART };
    expect(
      sanitizeTaskFollowups(
        [
          { ...legacy, id: 'fresh', enqueuedAt: NOW - 23 * HOUR },
          { ...legacy, id: 'edge', enqueuedAt: NOW - 24 * HOUR },
        ],
        NOW,
      ),
    ).toEqual([
      { ...base, id: 'fresh', enqueuedAt: NOW - 23 * HOUR, epoch: 3, state: 'queued' },
      { ...base, id: 'edge', enqueuedAt: NOW - 24 * HOUR, epoch: 3, state: 'queued' },
    ]);
  });

  it('a word an earlier restart paused more than 24 hours ago stays paused, as it was', () => {
    const old = {
      ...base,
      id: 'old',
      enqueuedAt: NOW - 24 * HOUR - 1,
      state: 'paused',
      stateReason: TASK_FOLLOWUP_PAUSED_BY_RESTART,
    };
    expect(sanitizeTaskFollowups([old], NOW)).toEqual([old]);
  });

  it.each([
    ['a Stop', TASK_FOLLOWUP_PAUSED_BY_STOP],
    ['an unhealthy end', TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END],
    ['a refused start ahead of it', TASK_FOLLOWUP_PAUSED_BEHIND_REFUSED],
    ['a refusal', 'one dashboard task runs at a time — wait for it to finish'],
  ])('a word paused by %s stays paused with its reason', (_name, reason) => {
    const paused = { ...base, id: 'p', enqueuedAt: NOW - HOUR, state: 'paused', stateReason: reason };
    expect(sanitizeTaskFollowups([paused], NOW)).toEqual([paused]);
  });

  it('a word caught in flight (sending) comes back paused, saying it may have gone out', () => {
    expect(sanitizeTaskFollowups([{ ...base, id: 's', enqueuedAt: NOW - HOUR, state: 'sending' }], NOW)).toEqual([
      {
        ...base,
        id: 's',
        enqueuedAt: NOW - HOUR,
        epoch: 3,
        state: 'paused',
        stateReason: TASK_FOLLOWUP_UNCERTAIN_AFTER_RESTART,
      },
    ]);
  });

  it('the registry load uses the clock: a legacy restart-paused word of an hour ago is queued again', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(BASE);
    task.taskFollowups = [
      {
        id: 'tq-l',
        text: '이어서',
        authorId: 'U1',
        enqueuedAt: Date.now() - HOUR,
        epoch: 1,
        state: 'paused',
        stateReason: TASK_FOLLOWUP_PAUSED_BY_RESTART,
      },
    ];
    reg.saveSessions();
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(task.taskId!)?.taskFollowups).toEqual([
      expect.objectContaining({ id: 'tq-l', state: 'queued', epoch: 2 }),
    ]);
    expect(after.getSessionByTaskId(task.taskId!)?.taskFollowups?.[0]).not.toHaveProperty('stateReason');
  });
});
