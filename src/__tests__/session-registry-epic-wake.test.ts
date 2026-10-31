/**
 * E4 ⑥ — the registry's part in waking an epic (.prd/19 D7).
 *
 *   W1 a chain's first saved start consumes the events it was started for —
 *      `delivered` + `consumedBy = chainId` in that same strict save; a failed
 *      save leaves them pending.
 *   W2 restart: a consuming chain reconciled `interrupted` puts its events back
 *      to pending — a crash mid-turn, on its second (post-`/compact`) hop, and
 *      after a compact hop's commit before the re-run's start. Another chain's
 *      consumption stays.
 *   W3 the epic event listener hears the epic's key when a child's chain end
 *      is added (saved or held) — never for an approval or a dropped event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-wake-test-${process.pid}`),
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

const ev = (id: string, extra: Partial<EpicEvent> = {}): EpicEvent => ({
  id,
  childTaskId: 'c1',
  planNodeId: 'login',
  outcome: 'completed',
  at: 1,
  state: 'pending',
  ...extra,
});

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

describe('SessionRegistry — waking an epic (E4 ⑥)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('W1 — the first saved start consumes its events in the same save; a failed save leaves them pending', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const key = `task:${epic.taskId}`;
    epic.epicEvents = [ev('a'), ev('b'), ev('c', { state: 'delivered', consumedBy: 'chain-0' })];

    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.beginTaskTurn(key, 't1', 'chain-1', ['a', 'b'])).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.epicEvents.map((e) => e.state)).toEqual(['pending', 'pending', 'delivered']);
    expect(epic.activityState).not.toBe('working');

    // An event another chain already consumed stays that chain's, even if named again.
    reg.beginTaskTurn(key, 't1', 'chain-1', ['a', 'c']);
    expect(epic.epicEvents.map((e) => [e.id, e.state, e.consumedBy])).toEqual([
      ['a', 'delivered', 'chain-1'],
      ['b', 'pending', undefined],
      ['c', 'delivered', 'chain-0'],
    ]);
    expect(savedOf(epic.taskId!)?.epicEvents[0]).toMatchObject({ state: 'delivered', consumedBy: 'chain-1' });
    expect(savedOf(epic.taskId!)?.activityState).toBe('working');
  });

  it.each([
    ['a crash mid-turn (saved working)', { activityState: 'working', activeTaskTurnId: 'turn-2' }],
    ['a crash on the second hop, after /compact', { activityState: 'working', activeTaskTurnId: 'turn-hop2' }],
    ['a crash after a compact hop committed, before the re-run started', { activityState: 'idle' }],
  ])('W2 — restart after %s: the chain is interrupted and its events are pending again', (_name, extra) => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord('epic-1', {
          kind: 'epic',
          openChain: 'chain-w',
          epicEvents: [
            ev('a', { state: 'delivered', consumedBy: 'chain-w' }),
            ev('b', { state: 'delivered', consumedBy: 'chain-old' }),
          ],
          ...extra,
        }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const epic = reg.getSessionByTaskId('epic-1')!;
    expect(epic.lastTurnOutcome).toMatchObject({ outcome: 'interrupted' });
    expect(epic.epicEvents).toEqual([ev('a'), ev('b', { state: 'delivered', consumedBy: 'chain-old' })]);
    expect(savedOf('epic-1')?.epicEvents[0]).toEqual(ev('a'));
  });

  it('W2 — an ordinary task’s reconciliation touches no events; a waiting epic keeps its consumption', () => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord('epic-2', {
          kind: 'epic',
          activityState: 'waiting',
          openChain: 'chain-q',
          epicEvents: [ev('q', { state: 'delivered', consumedBy: 'chain-q' })],
        }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    expect(reg.getSessionByTaskId('epic-2')!.epicEvents![0]).toMatchObject({ state: 'delivered' });
  });

  it('W3 — the listener hears the epic on a chain end, saved or held; never on an approval or a dropped event', () => {
    const reg = new SessionRegistry();
    const heard: string[] = [];
    reg.setEpicEventListener((k) => heard.push(k));
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    reg.setEpicPlan(epic.taskId!, { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] }, 'epic');
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const childKey = `task:${child.taskId}`;
    const done = (turnId: string): TaskTurnOutcomeRecord => ({
      turnId,
      outcome: 'completed',
      category: 'WorkflowComplete',
      at: 5,
    });

    reg.beginTaskTurn(childKey, 't1', 'chain-1');
    reg.recordEpicApproval({ type: 'requested', approvalId: 'ap-1', sessionKey: childKey });
    expect(heard).toEqual([]);
    reg.commitTaskTurnOutcome(childKey, done('t1'), 'idle', { chainId: 'chain-1', ends: true });
    expect(heard).toEqual([`task:${epic.taskId}`]);

    reg.beginTaskTurn(childKey, 't2', 'chain-2');
    reg.holdUnsavedTaskTurnOutcome(childKey, done('t2'), 'idle', { chainId: 'chain-2', ends: true });
    expect(heard).toEqual([`task:${epic.taskId}`, `task:${epic.taskId}`]);

    // A failed save adds nothing and wakes no one; a compact hop wakes no one.
    reg.beginTaskTurn(childKey, 't3', 'chain-3');
    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.commitTaskTurnOutcome(childKey, done('t3'), 'idle', { chainId: 'chain-3', ends: true })).toThrow();
    save.mockRestore();
    reg.commitTaskTurnOutcome(childKey, done('t3'), 'idle', { chainId: 'chain-3', ends: false });
    expect(heard).toHaveLength(2);

    // A listener that throws changes nothing about the commit.
    reg.setEpicEventListener(() => {
      throw new Error('listener down');
    });
    reg.beginTaskTurn(childKey, 't4', 'chain-4');
    expect(() =>
      reg.commitTaskTurnOutcome(childKey, done('t4'), 'idle', { chainId: 'chain-4', ends: true }),
    ).not.toThrow();
    expect(savedOf(epic.taskId!)?.epicEvents.map((e: EpicEvent) => e.chainId)).toContain('chain-4');

    // No live epic: nothing to hear.
    reg.setEpicEventListener((k) => heard.push(k));
    epic.terminated = true;
    reg.beginTaskTurn(childKey, 't5', 'chain-5');
    reg.commitTaskTurnOutcome(childKey, done('t5'), 'idle', { chainId: 'chain-5', ends: true });
    expect(heard).toHaveLength(2);
  });
});
