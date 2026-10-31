/**
 * #598 ④c — a task turn's start is saved, and a restart reconciles a task
 * found `working` (design 598c §6, 598b v5 §14.1): the turn the process lost
 * is recorded `interrupted`, never re-run (D10). A waiting task keeps its
 * question; Slack sessions keep their crash-recovery path.
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
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-task-turn-start-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const TASK_INPUT = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/repo', title: 'T' };

function failWrites<T>(fn: () => T): T {
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((() => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
}

describe('SessionRegistry — a task turn’s start and restart reconciliation (#598 ④c)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('beginTaskTurn saves working and the turn id, and broadcasts', () => {
    const reg = new SessionRegistry();
    const broadcast = vi.fn();
    reg.setActivityStateChangeCallback(broadcast);
    const task = reg.createTask(TASK_INPUT);
    const key = `task:${task.taskId}`;
    broadcast.mockClear();
    reg.beginTaskTurn(key, 'turn-A');
    expect(task.activityState).toBe('working');
    expect(task.activeTaskTurnId).toBe('turn-A');
    expect(broadcast).toHaveBeenCalledTimes(1);
    const disk = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, unknown>>;
    expect(disk[0]).toMatchObject({ activityState: 'working', activeTaskTurnId: 'turn-A' });
  });

  it('a failed start save restores the activity and the turn id, broadcasts nothing, and throws', () => {
    const reg = new SessionRegistry();
    const broadcast = vi.fn();
    reg.setActivityStateChangeCallback(broadcast);
    const task = reg.createTask(TASK_INPUT);
    const key = `task:${task.taskId}`;
    broadcast.mockClear();
    expect(() => failWrites(() => reg.beginTaskTurn(key, 'turn-A'))).toThrow(/ENOSPC/);
    expect(task.activityState ?? 'idle').toBe('idle');
    expect(task.activeTaskTurnId).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('beginTaskTurn refuses a Slack session and an unknown key', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'User', 'C1', '1700000000.000100');
    expect(() => reg.beginTaskTurn('work:C1:1700000000.000100', 't')).toThrow(/not a Slack-less task/);
    expect(() => reg.beginTaskTurn('task:22222222-2222-4222-8222-222222222222', 't')).toThrow(/not found/);
  });

  it('the commit clears the active turn id in the same write', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 'turn-A');
    reg.commitTaskTurnOutcome(
      key,
      { turnId: 'turn-A', outcome: 'completed', category: 'WorkflowComplete', at: 1 },
      'idle',
    );
    expect(task.activeTaskTurnId).toBeUndefined();
    const disk = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, unknown>>;
    expect(disk[0].activeTaskTurnId).toBeUndefined();
  });

  it('a task found working after a restart is recorded interrupted for the lost turn, set idle, and saved once', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    reg.beginTaskTurn(`task:${task.taskId}`, 'turn-lost');

    const reader = new SessionRegistry();
    reader.loadSessions();
    const back = reader.getSessionByTaskId(task.taskId!)!;
    expect(back.activityState).toBe('idle');
    expect(back.activeTaskTurnId).toBeUndefined();
    expect(back.lastTurnOutcome).toMatchObject({
      turnId: 'turn-lost',
      outcome: 'interrupted',
      category: 'Exception',
      reason: 'process ended before the outcome was recorded',
    });
    expect(reader.getCrashRecoveredSessions?.() ?? []).toEqual([]);

    // Saved: a second restart reads the same, it does not reconcile again.
    const again = new SessionRegistry();
    again.loadSessions();
    expect(again.getSessionByTaskId(task.taskId!)?.lastTurnOutcome).toMatchObject({
      turnId: 'turn-lost',
      outcome: 'interrupted',
    });
  });

  it('a working task saved without a turn id (older file) is still reconciled', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, unknown>>;
    saved[0].activityState = 'working';
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(saved));

    const reader = new SessionRegistry();
    reader.loadSessions();
    const back = reader.getSessionByTaskId(task.taskId!)!;
    expect(back.activityState).toBe('idle');
    expect(back.lastTurnOutcome?.outcome).toBe('interrupted');
    expect(back.lastTurnOutcome?.turnId).toMatch(/^restart:/);
  });

  it('a waiting task keeps its waiting state and its question after a restart', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 'turn-Q');
    reg.commitTaskTurnOutcome(
      key,
      { turnId: 'turn-Q', outcome: 'waiting', category: 'UIUserAskQuestion', at: 1, reason: 'Which?' },
      'waiting',
    );
    const reader = new SessionRegistry();
    reader.loadSessions();
    const back = reader.getSessionByTaskId(task.taskId!)!;
    expect(back.activityState).toBe('waiting');
    expect(back.lastTurnOutcome).toMatchObject({ turnId: 'turn-Q', outcome: 'waiting' });
  });

  it('holdUnsavedTaskTurnOutcome applies the outcome in memory only: broadcast and idle hooks run, the disk keeps working', () => {
    const reg = new SessionRegistry();
    const broadcast = vi.fn();
    reg.setActivityStateChangeCallback(broadcast);
    const task = reg.createTask(TASK_INPUT);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 'turn-H');
    broadcast.mockClear();
    const hook = vi.fn();
    reg.setOnIdleAfterDrainHook(hook);
    const writes = vi.spyOn(fs, 'writeFileSync');
    syncBuiltinESMExports();
    try {
      reg.holdUnsavedTaskTurnOutcome(
        key,
        {
          turnId: 'turn-H',
          outcome: 'completed',
          category: 'WorkflowComplete',
          at: 1,
          recordFailure: 'outcome not saved: x',
        },
        'idle',
      );
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
      syncBuiltinESMExports();
    }
    expect(task).toMatchObject({ activityState: 'idle', activeTaskTurnId: undefined });
    expect(task.lastTurnOutcome?.recordFailure).toBe('outcome not saved: x');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(key);
    const disk = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, unknown>>;
    expect(disk[0]).toMatchObject({ activityState: 'working', activeTaskTurnId: 'turn-H' });
  });
});
