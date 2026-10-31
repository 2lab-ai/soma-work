/**
 * #598 ④b1 — a task turn's outcome on the session (design 598b v5 §8):
 * `lastTurnOutcome` survives a restart, a malformed one is dropped, and the
 * strict save the task runner commits through either lands on disk or throws
 * (it never logs and carries on like `persistAndBroadcast`).
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-turn-outcome-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const TASK_INPUT = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/repo', title: 'T' };
const OUTCOME = {
  turnId: 'turn-1',
  outcome: 'completed',
  category: 'WorkflowComplete',
  at: 1_793_000_000_000,
} as const;

describe('SessionRegistry — a task turn’s outcome (#598 ④b1)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('lastTurnOutcome is saved and comes back after a restart', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    task.lastTurnOutcome = { ...OUTCOME, reason: 'done' };
    reg.persistSessionStrict(`task:${task.taskId}`);

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSessionByTaskId(task.taskId!)?.lastTurnOutcome).toEqual({ ...OUTCOME, reason: 'done' });
  });

  it('a malformed lastTurnOutcome on disk is dropped, not trusted', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, unknown>>;
    saved[0].lastTurnOutcome = { turnId: 7, outcome: 'great', at: 'now' };
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(saved));

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSessionByTaskId(task.taskId!)?.lastTurnOutcome).toBeUndefined();
  });

  it('persistSessionStrict broadcasts only after the write lands', () => {
    const reg = new SessionRegistry();
    const broadcast = vi.fn();
    reg.setActivityStateChangeCallback(broadcast);
    const task = reg.createTask(TASK_INPUT);
    broadcast.mockClear();
    task.lastTurnOutcome = { ...OUTCOME };
    reg.persistSessionStrict(`task:${task.taskId}`);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).toContain('"lastTurnOutcome"');
  });

  it('persistSessionStrict throws on a failed write and does not broadcast', () => {
    const reg = new SessionRegistry();
    const broadcast = vi.fn();
    reg.setActivityStateChangeCallback(broadcast);
    const task = reg.createTask(TASK_INPUT);
    broadcast.mockClear();
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();
    try {
      expect(() => reg.persistSessionStrict(`task:${task.taskId}`)).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('persistSessionStrict refuses an unknown key', () => {
    const reg = new SessionRegistry();
    expect(() => reg.persistSessionStrict('task:22222222-2222-4222-8222-222222222222')).toThrow(/not found/);
  });
});
