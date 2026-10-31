/**
 * E4 ⑤ — what a child owes its epic, recorded on the registry (.prd/19 D6).
 *
 *   V1 a child's chain end is one event on its epic, in the same strict save as
 *      the child's outcome; a failed save puts both back. No child text.
 *   V2 an outcome held in memory (every save failed) holds its event too; the
 *      next save carries both.
 *   V3 a `/compact` hop the chain re-runs after adds no event; a hop that ends
 *      the chain as a failure is a `failed` event.
 *   V4 restart: a child saved `working` before its epic in the file still gives
 *      its epic one `interrupted` event, saved; a second load adds none.
 *   V5 an approval request is a `needs-input` event of the child's open chain
 *      (no wake); its answer, or the chain's end, closes it; a failed save puts
 *      it back and does not throw.
 *   V6 a child whose epic is gone or closing: dropped and logged; the child's
 *      outcome still commits. An ordinary task records nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-events-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));
vi.mock('../conversation/storage', () => ({
  ConversationStorage: class {
    async buildThreadIndex() {
      return new Map();
    }
  },
}));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';
import type { EpicEvent, TaskTurnOutcomeRecord } from '../types';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const BASE = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };
const readSaved = (): Array<Record<string, any>> => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const savedOf = (taskId: string) => readSaved().find((r) => r.taskId === taskId);

const failed = (turnId: string, at = 2000): TaskTurnOutcomeRecord => ({
  turnId,
  outcome: 'failed',
  category: 'Exception',
  reason: 'Error: secret path /home/x leaked',
  at,
});

function family() {
  const reg = new SessionRegistry();
  const epic = reg.createTask({ ...BASE, kind: 'epic' });
  reg.setEpicPlan(epic.taskId!, { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] }, 'epic');
  const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
  const childKey = `task:${child.taskId}`;
  return { reg, epic, child, childKey };
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

describe('SessionRegistry — a child reports to its epic (E4 ⑤)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('V1 — a chain end is one event on the epic, in the same save; a failed save puts both back', () => {
    const { reg, epic, child, childKey } = family();
    reg.beginTaskTurn(childKey, 't1', 'chain-1');

    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.commitTaskTurnOutcome(childKey, failed('t1'), 'idle', { chainId: 'chain-1', ends: true })).toThrow(
      'ENOSPC',
    );
    save.mockRestore();
    expect(epic.epicEvents).toBeUndefined();
    expect(child.openChain).toBe('chain-1');
    expect(child.activityState).toBe('working');

    reg.commitTaskTurnOutcome(childKey, failed('t1'), 'idle', { chainId: 'chain-1', ends: true });
    const expected = {
      id: `${child.taskId}:chain-1`,
      childTaskId: child.taskId,
      planNodeId: 'login',
      outcome: 'failed',
      chainId: 'chain-1',
      turnId: 't1',
      at: 2000,
      state: 'pending',
    };
    expect(epic.epicEvents).toEqual([expected]);
    expect(savedOf(epic.taskId!)?.epicEvents).toEqual([expected]);
    expect(savedOf(child.taskId!)?.lastTurnOutcome).toMatchObject({ outcome: 'failed', turnId: 't1' });
    // The reason (a thrown message) is never carried to the epic.
    expect(JSON.stringify(epic.epicEvents)).not.toContain('secret');
  });

  it('V2 — a held outcome holds its event; the next save carries both', () => {
    const { reg, epic, child, childKey } = family();
    reg.beginTaskTurn(childKey, 't1', 'chain-1');
    reg.holdUnsavedTaskTurnOutcome(childKey, { ...failed('t1'), recordFailure: 'outcome not saved: EIO' }, 'idle', {
      chainId: 'chain-1',
      ends: true,
    });
    expect(epic.epicEvents).toHaveLength(1);
    expect(savedOf(epic.taskId!)?.epicEvents).toBeUndefined();
    expect(savedOf(child.taskId!)?.activityState).toBe('working');

    reg.saveSessions();
    expect(savedOf(epic.taskId!)?.epicEvents).toEqual([expect.objectContaining({ id: `${child.taskId}:chain-1` })]);
    expect(savedOf(child.taskId!)?.lastTurnOutcome).toMatchObject({ outcome: 'failed' });
  });

  it('V3 — a compact hop the chain re-runs after adds nothing; one ending it as a failure is failed', () => {
    const { reg, epic, child, childKey } = family();
    reg.beginTaskTurn(childKey, 't1', 'chain-1');
    const done: TaskTurnOutcomeRecord = { turnId: 't1', outcome: 'completed', category: 'WorkflowComplete', at: 3000 };
    reg.commitTaskTurnOutcome(childKey, done, 'idle', { chainId: 'chain-1', ends: false });
    expect(epic.epicEvents).toBeUndefined();

    reg.beginTaskTurn(childKey, 't2', 'chain-1');
    reg.commitTaskTurnOutcome(childKey, { ...done, turnId: 't2' }, 'idle', {
      chainId: 'chain-1',
      ends: true,
      notice: { kind: 'failure', reason: 'nothing to re-run after compact' },
    });
    expect(epic.epicEvents).toEqual([
      expect.objectContaining({ id: `${child.taskId}:chain-1`, outcome: 'failed', turnId: 't2' }),
    ]);

    // A completed chain is a completed event (its own id).
    reg.beginTaskTurn(childKey, 't3', 'chain-2');
    reg.commitTaskTurnOutcome(childKey, { ...done, turnId: 't3' }, 'idle', { chainId: 'chain-2', ends: true });
    expect(epic.epicEvents!.map((e) => `${e.chainId}:${e.outcome}`)).toEqual(['chain-1:failed', 'chain-2:completed']);
  });

  it('V4 — restart: a child before its epic in the file still gives one interrupted event; a second load adds none', () => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord('child-1', {
          parentTaskId: 'epic-1',
          planNodeId: 'login',
          activityState: 'working',
          activeTaskTurnId: 'turn-9',
          openChain: 'chain-9',
        }),
        slacklessRecord('epic-1', {
          kind: 'epic',
          childTaskIds: ['child-1'],
          plan: { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue', spawned: ['child-1'] }] },
        }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const events = reg.getSessionByTaskId('epic-1')!.epicEvents;
    expect(events).toEqual([
      expect.objectContaining({
        id: 'child-1:chain-9',
        childTaskId: 'child-1',
        planNodeId: 'login',
        outcome: 'interrupted',
        chainId: 'chain-9',
        turnId: 'turn-9',
        state: 'pending',
      }),
    ]);
    expect(savedOf('epic-1')?.epicEvents).toHaveLength(1);
    expect(reg.getSessionByTaskId('child-1')!.lastTurnOutcome).toMatchObject({ outcome: 'interrupted' });

    const again = new SessionRegistry();
    again.loadSessions();
    expect(again.getSessionByTaskId('epic-1')!.epicEvents).toHaveLength(1);
  });

  it('V4b — a lost turn with no chain is keyed by its turn; an ordinary task saved working adds nothing', () => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord('epic-1', { kind: 'epic', childTaskIds: ['child-1'] }),
        slacklessRecord('child-1', {
          parentTaskId: 'epic-1',
          planNodeId: 'login',
          activityState: 'working',
          activeTaskTurnId: 'turn-3',
        }),
        slacklessRecord('plain-1', { activityState: 'working', activeTaskTurnId: 'turn-4' }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const [event] = reg.getSessionByTaskId('epic-1')!.epicEvents!;
    expect(event).toMatchObject({ id: 'child-1:turn-3', outcome: 'interrupted', turnId: 'turn-3' });
    expect(event.chainId).toBeUndefined();
    expect(reg.getSessionByTaskId('epic-1')!.epicEvents).toHaveLength(1);
  });

  it('V5 — an approval is needs-input of the open chain; its answer or the chain end closes it; a failed save does not throw', () => {
    const { reg, epic, child, childKey } = family();
    reg.beginTaskTurn(childKey, 't1', 'chain-1');
    reg.recordEpicApproval({ type: 'requested', approvalId: 'ap-1', sessionKey: childKey, turnId: 't1' }, 4000);
    const asked: EpicEvent = {
      id: `${child.taskId}:ap-1`,
      childTaskId: child.taskId!,
      planNodeId: 'login',
      outcome: 'needs-input',
      approvalId: 'ap-1',
      chainId: 'chain-1',
      turnId: 't1',
      at: 4000,
      state: 'pending',
    };
    expect(epic.epicEvents).toEqual([asked]);
    expect(savedOf(epic.taskId!)?.epicEvents).toEqual([asked]);
    // A repeat of the same request is the same event.
    reg.recordEpicApproval({ type: 'requested', approvalId: 'ap-1', sessionKey: childKey }, 4500);
    expect(epic.epicEvents).toHaveLength(1);

    // Its answer closes that approval only.
    reg.recordEpicApproval({ type: 'requested', approvalId: 'ap-2', sessionKey: childKey }, 4800);
    reg.recordEpicApproval({ type: 'resolved', approvalId: 'ap-1', sessionKey: childKey }, 5000);
    expect(epic.epicEvents!.map((e) => e.resolvedAt)).toEqual([5000, undefined]);
    expect(savedOf(epic.taskId!)?.epicEvents[0].resolvedAt).toBe(5000);

    // The chain's end closes an approval still open — its own chain's only.
    epic.epicEvents = [
      ...epic.epicEvents!,
      { ...asked, id: `${child.taskId}:ap-old`, approvalId: 'ap-old', chainId: 'chain-0', at: 100 },
    ];
    reg.commitTaskTurnOutcome(childKey, failed('t1', 7000), 'idle', { chainId: 'chain-1', ends: true });
    const byId = (id: string) => epic.epicEvents!.find((e) => e.id === `${child.taskId}:${id}`)!;
    expect(byId('ap-2').resolvedAt).toBe(7000);
    expect(byId('ap-old').resolvedAt).toBeUndefined();
    expect(byId('ap-1').resolvedAt).toBe(5000);

    // A failed save puts the event back and does not throw (the approval goes on).
    const before = epic.epicEvents;
    const warn = vi.spyOn((reg as any).logger, 'warn');
    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.recordEpicApproval({ type: 'requested', approvalId: 'ap-3', sessionKey: childKey })).not.toThrow();
    save.mockRestore();
    expect(epic.epicEvents).toBe(before);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not saved'), expect.anything());
  });

  it('V6 — no live epic: dropped and logged, the outcome still commits; an ordinary task records nothing', () => {
    const { reg, epic, child, childKey } = family();
    const warn = vi.spyOn((reg as any).logger, 'warn');
    epic.terminated = true;
    reg.beginTaskTurn(childKey, 't1', 'chain-1');
    reg.commitTaskTurnOutcome(childKey, failed('t1'), 'idle', { chainId: 'chain-1', ends: true });
    expect(epic.epicEvents).toBeUndefined();
    expect(savedOf(child.taskId!)?.lastTurnOutcome).toMatchObject({ outcome: 'failed' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Epic event dropped'),
      expect.objectContaining({ childTaskId: child.taskId, parentTaskId: epic.taskId }),
    );
    reg.recordEpicApproval({ type: 'requested', approvalId: 'ap-1', sessionKey: childKey });
    expect(epic.epicEvents).toBeUndefined();

    warn.mockClear();
    const plain = reg.createTask(BASE);
    reg.beginTaskTurn(`task:${plain.taskId}`, 'p1', 'chain-p');
    reg.commitTaskTurnOutcome(`task:${plain.taskId}`, failed('p1'), 'idle', { chainId: 'chain-p', ends: true });
    reg.recordEpicApproval({ type: 'requested', approvalId: 'ap-p', sessionKey: `task:${plain.taskId}` });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Epic event'), expect.anything());
    expect(readSaved().every((r) => r.epicEvents === undefined || r.taskId === epic.taskId)).toBe(true);
  });
});
