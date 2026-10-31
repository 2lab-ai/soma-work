/**
 * E2 ⑤b — the registry's side of the notice deliverer (.prd/18 D6, D13).
 *
 *   N1 a task created from an instruction thread owes it its link, written in
 *      the task's first strict save; a dashboard task owes nothing.
 *   N2 a save that adds notices tells the listener, after the save — never an
 *      outcome held in memory (that waits for a save), never a failed save.
 *   N3 a listener that throws breaks neither the create nor the commit.
 *   N4 a settled notice leaves the live task record (the next save carries it).
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
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-task-notices-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';
import type { TaskTurnOutcomeRecord } from '../types';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const ORIGIN = { channel: 'C123', threadTs: '1700000000.000100', messageTs: '1700000000.000100' };
const TASK_INPUT = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };
const CHAIN = 'chain-aaaa';

const readSaved = (): Array<Record<string, any>> => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const savedTask = (taskId: string) => readSaved().find((r) => r.taskId === taskId)!;
const keyOf = (taskId: string) => `task:${taskId}`;

function done(turnId = 't1'): TaskTurnOutcomeRecord {
  return { turnId, outcome: 'completed', category: 'WorkflowComplete', at: 1_700_000_000_000 };
}

function failNextWrite(): () => void {
  const real = fs.renameSync;
  (fs as any).renameSync = () => {
    throw new Error('disk full');
  };
  syncBuiltinESMExports();
  return () => {
    (fs as any).renameSync = real;
    syncBuiltinESMExports();
  };
}

describe('SessionRegistry — the notice deliverer’s seams (E2 ⑤b)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('N1 — a task from an instruction thread owes it its link, in its first save; a dashboard task owes nothing', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    const link = { id: `${task.taskId}:create:link`, kind: 'link', at: expect.any(Number) };
    expect(task.notices).toEqual([link]);
    expect(savedTask(task.taskId!).notices).toEqual([link]);

    const plain = reg.createTask(TASK_INPUT);
    expect(plain.notices).toBeUndefined();
    expect(savedTask(plain.taskId!).notices).toBeUndefined();
  });

  it('N2 — the listener hears a save that added notices, after it — the create and the chain’s end', () => {
    const reg = new SessionRegistry();
    const heard: Array<{ key: string; notices: string[]; onDisk: string[] }> = [];
    reg.setTaskNoticeListener((session, key) => {
      heard.push({
        key,
        notices: (session.notices ?? []).map((n) => n.kind),
        onDisk: (savedTask(session.taskId!).notices ?? []).map((n: any) => n.kind),
      });
    });
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    const key = keyOf(task.taskId!);
    expect(heard).toEqual([{ key, notices: ['link'], onDisk: ['link'] }]);

    reg.beginTaskTurn(key, 't1', CHAIN);
    reg.commitTaskTurnOutcome(key, done(), 'idle', { chainId: CHAIN, ends: true });
    expect(heard[1]).toEqual({ key, notices: ['link', 'result'], onDisk: ['link', 'result'] });
  });

  it('N2 — …but not a hop that keeps the chain open, a dashboard task, a held outcome, or a failed save', () => {
    const reg = new SessionRegistry();
    const listener = vi.fn();
    const plain = reg.createTask(TASK_INPUT);
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    reg.setTaskNoticeListener(listener);
    const key = keyOf(task.taskId!);

    reg.beginTaskTurn(key, 't1', CHAIN);
    reg.commitTaskTurnOutcome(key, done(), 'idle', { chainId: CHAIN, ends: false });
    reg.beginTaskTurn(keyOf(plain.taskId!), 'p1', 'chain-p');
    reg.commitTaskTurnOutcome(keyOf(plain.taskId!), done('p1'), 'idle', { chainId: 'chain-p', ends: true });
    reg.beginTaskTurn(key, 't2', CHAIN);
    reg.holdUnsavedTaskTurnOutcome(key, done('t2'), 'idle', { chainId: CHAIN, ends: true });
    expect(listener).not.toHaveBeenCalled();

    const other = reg.createTask({ ...TASK_INPUT, originThread: { ...ORIGIN, threadTs: '1700000000.000200' } });
    listener.mockClear();
    const otherKey = keyOf(other.taskId!);
    reg.beginTaskTurn(otherKey, 'o1', 'chain-o');
    const restore = failNextWrite();
    try {
      expect(() =>
        reg.commitTaskTurnOutcome(otherKey, done('o1'), 'idle', { chainId: 'chain-o', ends: true }),
      ).toThrow();
    } finally {
      restore();
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('N3 — a listener that throws breaks neither the create nor the commit', () => {
    const reg = new SessionRegistry();
    reg.setTaskNoticeListener(() => {
      throw new Error('listener down');
    });
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    const key = keyOf(task.taskId!);
    reg.beginTaskTurn(key, 't1', CHAIN);
    expect(() => reg.commitTaskTurnOutcome(key, done(), 'idle', { chainId: CHAIN, ends: true })).not.toThrow();
    expect(savedTask(task.taskId!).lastTurnOutcome?.outcome).toBe('completed');
  });

  it('N4 — a settled notice leaves the live record; the next save carries that', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
    const key = keyOf(task.taskId!);
    reg.pruneTaskNotice(task.taskId!, `${task.taskId}:create:link`);
    expect(task.notices).toBeUndefined();
    // Not saved by itself: a crash before the next save re-registers it, and the ledger posts it once.
    expect(savedTask(task.taskId!).notices).toHaveLength(1);
    reg.beginTaskTurn(key, 't1', CHAIN);
    expect(savedTask(task.taskId!).notices).toBeUndefined();
    // An unknown task or notice is a no-op.
    expect(() => reg.pruneTaskNotice('nope', 'nope')).not.toThrow();
  });
});
