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

  it('commitTaskTurnOutcome saves the outcome and the activity together — a waiting task is waiting after a restart (#626 R1)', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const key = `task:${task.taskId}`;
    reg.setActivityStateByKey(key, 'working');
    reg.commitTaskTurnOutcome(key, { ...OUTCOME, outcome: 'waiting', category: 'UIUserAskQuestion' }, 'waiting');

    const reader = new SessionRegistry();
    reader.loadSessions();
    const back = reader.getSessionByTaskId(task.taskId!);
    expect(back?.lastTurnOutcome).toMatchObject({ outcome: 'waiting', turnId: 'turn-1' });
    expect(back?.activityState).toBe('waiting');
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

  it('commit to idle: broadcasts and fires the idle hooks only after the write landed, with the new outcome visible', () => {
    const reg = new SessionRegistry();
    const broadcast = vi.fn();
    reg.setActivityStateChangeCallback(broadcast);
    const task = reg.createTask(TASK_INPUT);
    const key = `task:${task.taskId}`;
    reg.setActivityStateByKey(key, 'working');
    broadcast.mockClear();
    const seen: unknown[] = [];
    reg.setOnIdleAfterDrainHook((k) => seen.push(reg.getSessionByKey(k)?.lastTurnOutcome?.turnId));
    reg.commitTaskTurnOutcome(key, { ...OUTCOME }, 'idle');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['turn-1']);
    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).toContain('"lastTurnOutcome"');
  });

  it('a failed write restores both the outcome and the activity, broadcasts nothing, fires no idle hook, and throws', () => {
    const reg = new SessionRegistry();
    const broadcast = vi.fn();
    reg.setActivityStateChangeCallback(broadcast);
    const task = reg.createTask(TASK_INPUT);
    const key = `task:${task.taskId}`;
    reg.setActivityStateByKey(key, 'working');
    task.lastTurnOutcome = { ...OUTCOME, turnId: 'old' };
    broadcast.mockClear();
    const hook = vi.fn();
    reg.setOnIdleAfterDrainHook(hook);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();
    try {
      expect(() => reg.commitTaskTurnOutcome(key, { ...OUTCOME, turnId: 'new' }, 'idle')).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(task.lastTurnOutcome?.turnId).toBe('old');
    expect(task.activityState).toBe('working');
    expect(broadcast).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it('commitTaskTurnOutcome refuses an unknown key', () => {
    const reg = new SessionRegistry();
    expect(() =>
      reg.commitTaskTurnOutcome('task:22222222-2222-4222-8222-222222222222', { ...OUTCOME }, 'idle'),
    ).toThrow(/not found/);
  });
});
