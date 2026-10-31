/**
 * E2 ③a — a task's chain and its notice intents in the registry (.prd/18 D5 · D6, §2.1).
 *
 *   S1 the chain's first turn start saves `openChain`; a hop keeps it.
 *   S2 a commit that does not end the chain (a completed `/compact` hop) keeps
 *      `openChain` and writes no intent; the chain's last commit clears it and
 *      writes the intent — in the same strict save as the outcome.
 *   S3 intent kind follows the outcome; a question's id carries its askId.
 *   S4 a task with no instruction thread (a dashboard task) gets no intents.
 *   S5 a failed commit restores the outcome, `openChain` and the intents.
 *   S6 an outcome held in memory keeps its intent in memory; a later save lands both.
 *   S7 restart: `working` or an open chain is `interrupted` (never "completed"),
 *      with one interrupted intent keyed by the chain, and the chain closed.
 *   S8 an intent id is written once.
 *   S9 load keeps only well-formed intents and a string `openChain`.
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
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-chain-settle-test-${process.pid}`),
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

type Saved = { taskId?: string; openChain?: unknown; notices?: Array<Record<string, unknown>>; lastTurnOutcome?: any };
const readSaved = (): Saved[] => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const savedTask = (taskId: string) => readSaved().find((r) => r.taskId === taskId)!;

function outcome(o: TaskTurnOutcomeRecord['outcome'], turnId = 't1', extra: Partial<TaskTurnOutcomeRecord> = {}) {
  const category = o === 'waiting' ? 'UIUserAskQuestion' : o === 'completed' ? 'WorkflowComplete' : 'Exception';
  return { turnId, outcome: o, category, at: 1_700_000_000_000, ...extra } as TaskTurnOutcomeRecord;
}

function originTask(reg: SessionRegistry) {
  return reg.createTask({ ...TASK_INPUT, originThread: ORIGIN });
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

describe('SessionRegistry — a task chain’s settle and notice intents (E2 ③a)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('S1 — the first turn start saves the open chain; a start with no chain leaves it as it is', () => {
    const reg = new SessionRegistry();
    const task = originTask(reg);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 't1', CHAIN);
    expect(task.openChain).toBe(CHAIN);
    expect(savedTask(task.taskId!).openChain).toBe(CHAIN);

    reg.beginTaskTurn(key, 't2');
    expect(task.openChain).toBe(CHAIN);
  });

  it('S1b — a turn start that is not saved does not open the chain', () => {
    const reg = new SessionRegistry();
    const task = originTask(reg);
    const restore = failNextWrite();
    try {
      expect(() => reg.beginTaskTurn(`task:${task.taskId}`, 't1', CHAIN)).toThrow(/disk full/);
    } finally {
      restore();
    }
    expect(task.openChain).toBeUndefined();
    expect(task.activityState).not.toBe('working');
  });

  it('S2 — a hop that does not end the chain keeps it open and writes no intent; the last commit closes it and writes the intent in the same save', () => {
    const reg = new SessionRegistry();
    const task = originTask(reg);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 't1', CHAIN);
    reg.commitTaskTurnOutcome(key, outcome('completed', 't1'), 'idle', { chainId: CHAIN, ends: false });
    expect(task.openChain).toBe(CHAIN);
    expect(task.notices ?? []).toEqual([]);
    expect(savedTask(task.taskId!).openChain).toBe(CHAIN);

    reg.beginTaskTurn(key, 't2', CHAIN);
    reg.commitTaskTurnOutcome(key, outcome('completed', 't2'), 'idle', { chainId: CHAIN, ends: true });
    expect(task.openChain).toBeUndefined();
    const saved = savedTask(task.taskId!);
    expect(saved.openChain).toBeUndefined();
    expect(saved.lastTurnOutcome.turnId).toBe('t2');
    expect(saved.notices).toEqual([
      expect.objectContaining({
        id: `${task.taskId}:${CHAIN}:result`,
        kind: 'result',
        chainId: CHAIN,
        turnId: 't2',
        outcome: 'completed',
      }),
    ]);
  });

  it('S3 — the intent kind follows the outcome; a question carries its askId', () => {
    const cases: Array<[TaskTurnOutcomeRecord['outcome'], string]> = [
      ['completed', 'result'],
      ['failed', 'failure'],
      ['cancelled', 'failure'],
      ['interrupted', 'interrupted'],
    ];
    for (const [o, kind] of cases) {
      const reg = new SessionRegistry();
      const task = originTask(reg);
      const key = `task:${task.taskId}`;
      reg.beginTaskTurn(key, 't1', CHAIN);
      reg.commitTaskTurnOutcome(key, outcome(o, 't1', { reason: 'why' }), 'idle', { chainId: CHAIN, ends: true });
      expect(task.notices).toEqual([
        expect.objectContaining({ id: `${task.taskId}:${CHAIN}:${kind}`, kind, outcome: o, reason: 'why' }),
      ]);
      reg.terminateSession(key);
    }

    const reg = new SessionRegistry();
    const task = originTask(reg);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 't1', CHAIN);
    task.actionPanel = { pendingQuestion: { askId: 'ask-7', question: 'Which?' } } as any;
    reg.commitTaskTurnOutcome(key, outcome('waiting', 't1'), 'waiting', { chainId: CHAIN, ends: true });
    expect(task.notices).toEqual([
      expect.objectContaining({ id: `${task.taskId}:${CHAIN}:question:ask-7`, kind: 'question', askId: 'ask-7' }),
    ]);
  });

  it('S3b — a settle may name its notice: a completed /compact hop with nothing re-run owes a failure, not a result', () => {
    const reg = new SessionRegistry();
    const task = originTask(reg);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 't1', CHAIN);
    reg.commitTaskTurnOutcome(key, outcome('completed', 't1', { reason: 'compacted' }), 'idle', {
      chainId: CHAIN,
      ends: true,
      notice: { kind: 'failure', reason: 'nothing re-run' },
    });
    expect(task.notices).toEqual([
      expect.objectContaining({
        id: `${task.taskId}:${CHAIN}:failure`,
        kind: 'failure',
        outcome: 'completed',
        reason: 'nothing re-run',
      }),
    ]);
  });

  it('S4 — a dashboard task (no instruction thread) tracks its chain but gets no intents', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 't1', CHAIN);
    expect(task.openChain).toBe(CHAIN);
    reg.commitTaskTurnOutcome(key, outcome('completed', 't1'), 'idle', { chainId: CHAIN, ends: true });
    expect(task.openChain).toBeUndefined();
    expect(task.notices).toBeUndefined();
  });

  it('S4b — a commit with no settle (an outcome before any start) neither closes a chain nor writes an intent', () => {
    const reg = new SessionRegistry();
    const task = originTask(reg);
    const key = `task:${task.taskId}`;
    reg.commitTaskTurnOutcome(key, outcome('failed', 't0'), 'idle');
    expect(task.notices).toBeUndefined();
  });

  it('S5 — a failed commit restores the outcome, the open chain and the intents, in memory and on disk', () => {
    const reg = new SessionRegistry();
    const task = originTask(reg);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 't1', CHAIN);
    const before = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const restore = failNextWrite();
    try {
      expect(() =>
        reg.commitTaskTurnOutcome(key, outcome('completed', 't1'), 'idle', { chainId: CHAIN, ends: true }),
      ).toThrow(/disk full/);
    } finally {
      restore();
    }
    expect(task.openChain).toBe(CHAIN);
    expect(task.notices ?? []).toEqual([]);
    expect(task.activityState).toBe('working');
    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).toBe(before);
  });

  it('S6 — an outcome held in memory keeps its intent in memory; the next successful save lands both', () => {
    const reg = new SessionRegistry();
    const task = originTask(reg);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 't1', CHAIN);
    reg.holdUnsavedTaskTurnOutcome(key, outcome('completed', 't1', { recordFailure: 'x' }), 'idle', {
      chainId: CHAIN,
      ends: true,
    });
    expect(task.notices).toHaveLength(1);
    expect(savedTask(task.taskId!).notices).toBeUndefined();
    expect(savedTask(task.taskId!).openChain).toBe(CHAIN);

    reg.saveSessions();
    expect(savedTask(task.taskId!).notices).toHaveLength(1);
    expect(savedTask(task.taskId!).openChain).toBeUndefined();
  });

  it('S7 — restart: a working task or an open chain is interrupted with one intent keyed by the chain, and the chain is closed', () => {
    const reg = new SessionRegistry();
    const task = originTask(reg);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 't1', CHAIN);
    // A completed `/compact` hop that does not end the chain — then the process dies.
    reg.commitTaskTurnOutcome(key, outcome('completed', 't1'), 'idle', { chainId: CHAIN, ends: false });

    const after = new SessionRegistry();
    expect(after.loadSessions()).toBe(1);
    const back = after.getSessionByTaskId(task.taskId!)!;
    expect(back.lastTurnOutcome?.outcome).toBe('interrupted');
    expect(back.openChain).toBeUndefined();
    expect(back.notices).toEqual([
      expect.objectContaining({ id: `${task.taskId}:${CHAIN}:interrupted`, kind: 'interrupted', chainId: CHAIN }),
    ]);

    // The reconciliation is saved after the load; a second load adds nothing.
    after.saveSessions();
    const third = new SessionRegistry();
    expect(third.loadSessions()).toBe(1);
    expect(third.getSessionByTaskId(task.taskId!)!.notices).toHaveLength(1);
  });

  it('S7b — restart while working: interrupted, keyed by the chain; a working task with no chain keys by its turn', () => {
    const reg = new SessionRegistry();
    const a = originTask(reg);
    reg.beginTaskTurn(`task:${a.taskId}`, 'ta', CHAIN);
    const b = reg.createTask({ ...TASK_INPUT, originThread: { ...ORIGIN, threadTs: '1700000001.000100' } });
    reg.beginTaskTurn(`task:${b.taskId}`, 'tb');

    const after = new SessionRegistry();
    expect(after.loadSessions()).toBe(2);
    expect(after.getSessionByTaskId(a.taskId!)!.notices).toEqual([
      expect.objectContaining({ id: `${a.taskId}:${CHAIN}:interrupted` }),
    ]);
    expect(after.getSessionByTaskId(b.taskId!)!.notices).toEqual([
      expect.objectContaining({ id: `${b.taskId}:tb:interrupted`, turnId: 'tb' }),
    ]);
  });

  it('S7c — restart reconciliation of a dashboard task closes its chain but writes no intent', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    reg.beginTaskTurn(`task:${task.taskId}`, 't1', CHAIN);
    const after = new SessionRegistry();
    after.loadSessions();
    const back = after.getSessionByTaskId(task.taskId!)!;
    expect(back.lastTurnOutcome?.outcome).toBe('interrupted');
    expect(back.openChain).toBeUndefined();
    expect(back.notices).toBeUndefined();
  });

  it('S7d — restart: a task saved waiting keeps its question even if a chain id is still on the record (grok #666 P1)', () => {
    const taskId = '77777777-7777-4777-8777-777777777777';
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        {
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
          activityState: 'waiting',
          originThread: ORIGIN,
          openChain: CHAIN,
          lastTurnOutcome: { turnId: 't1', outcome: 'waiting', category: 'UIUserAskQuestion', at: 1 },
        },
      ]),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);
    const back = reg.getSessionByTaskId(taskId)!;
    expect(back.activityState).toBe('waiting');
    expect(back.lastTurnOutcome?.outcome).toBe('waiting');
    expect(back.notices).toBeUndefined();
  });

  it('S8 — an intent id is written once', () => {
    const reg = new SessionRegistry();
    const task = originTask(reg);
    const key = `task:${task.taskId}`;
    reg.beginTaskTurn(key, 't1', CHAIN);
    reg.commitTaskTurnOutcome(key, outcome('completed', 't1'), 'idle', { chainId: CHAIN, ends: true });
    reg.beginTaskTurn(key, 't2', CHAIN);
    reg.commitTaskTurnOutcome(key, outcome('completed', 't2'), 'idle', { chainId: CHAIN, ends: true });
    expect(task.notices).toHaveLength(1);
  });

  it('S9 — load keeps only well-formed intents and a string open chain', () => {
    const taskId = '55555555-5555-4555-8555-555555555555';
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        {
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
          originThread: ORIGIN,
          openChain: 42,
          notices: [
            { id: `${taskId}:c:result`, kind: 'result', chainId: 'c', turnId: 't', outcome: 'completed', at: 1 },
            { id: '', kind: 'result', at: 1 },
            { id: 'x', kind: 'bogus', at: 1 },
            'not an object',
          ],
        },
      ]),
    );
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);
    const back = reg.getSessionByTaskId(taskId)!;
    expect(back.openChain).toBeUndefined();
    expect(back.notices).toEqual([
      { id: `${taskId}:c:result`, kind: 'result', chainId: 'c', turnId: 't', outcome: 'completed', at: 1 },
    ]);
  });
});
