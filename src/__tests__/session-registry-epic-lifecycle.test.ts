/**
 * E4 ⑦ — an epic tree's lifecycle on the registry (.prd/19 D10).
 *
 *   L1 the sweep: an epic not done (or with a child running or waiting) and its
 *      children sleep but are not archived; after done, the normal clock.
 *   L2 the load: the same, decided over the whole file (a child may come first).
 *   L3 `markClosedByParent`: saved strictly, put back on a failed save; it
 *      survives a restart, the archive and the card's source.
 *   L4 `recordEpicChildClosed`: a delivered `closed` event on the epic, saved
 *      strictly; no live epic, nothing.
 *   L5 the in-memory closing mark (fable #703 R1): an epic being closed takes no
 *      chain end; a child being closed records its end delivered; never saved.
 *   L6 `closedBy` ends with a new chain on the child, not with a hop of the
 *      chain being closed.
 *   L7 a close before a child's first hop keeps the mark through that hop.
 *   L8 a closing epic's dropped event logs at info, a gone one's at warn.
 *   L9 a closing epic takes no new plan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-life-test-${process.pid}`),
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

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const BASE = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };
const LONG_AGO = () => new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
const readSaved = (): Array<Record<string, any>> => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const archivedIds = () =>
  fs
    .readdirSync(path.join(TEST_DATA_DIR, 'archives'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'archives', f), 'utf8')).taskId);

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

const PLAN = { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] };
const DONE_PLAN = { ...PLAN, done: { by: 'epic', at: 1 } };
const asleep = { state: 'SLEEPING', sleepStartedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString() };

describe('SessionRegistry — an epic tree’s lifecycle (E4 ⑦)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  function sleepingTree(reg: SessionRegistry) {
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    reg.setEpicPlan(epic.taskId!, { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] }, 'epic');
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const plain = reg.createTask(BASE);
    for (const s of [epic, child, plain]) {
      s.state = 'SLEEPING';
      s.sleepStartedAt = LONG_AGO();
    }
    return { epic, child, plain };
  }

  it('L1 — the sweep keeps a tree not done; a done tree with no child at work follows the clock', async () => {
    const reg = new SessionRegistry();
    const { epic, child, plain } = sleepingTree(reg);
    await reg.cleanupInactiveSessions();
    expect(reg.getSessionByTaskId(epic.taskId!)).toBeDefined();
    expect(reg.getSessionByTaskId(child.taskId!)).toBeDefined();
    expect(reg.getSessionByTaskId(plain.taskId!)).toBeUndefined();

    // Done, but a child still waits: kept.
    reg.setEpicPlan(epic.taskId!, { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }], done: true }, 'owner');
    child.activityState = 'waiting';
    await reg.cleanupInactiveSessions();
    expect(reg.getSessionByTaskId(epic.taskId!)).toBeDefined();
    expect(reg.getSessionByTaskId(child.taskId!)).toBeDefined();

    // Done and nothing at work: the whole tree follows the normal clock.
    child.activityState = 'idle';
    await reg.cleanupInactiveSessions();
    expect(reg.getSessionByTaskId(epic.taskId!)).toBeUndefined();
    expect(reg.getSessionByTaskId(child.taskId!)).toBeUndefined();
  });

  it.each([
    ['terminated', (reg: SessionRegistry, epic: any) => void (epic.terminated = true)],
    [
      'being closed (the in-memory mark)',
      (reg: SessionRegistry, epic: any) => reg.markClosing(`task:${epic.taskId}`, true),
    ],
  ])('L1 — an epic %s no longer shelters its children', async (_name, close) => {
    const reg = new SessionRegistry();
    const { epic, child } = sleepingTree(reg);
    close(reg, epic);
    await reg.cleanupInactiveSessions();
    expect(reg.getSessionByTaskId(child.taskId!)).toBeUndefined();
  });

  const cancelled = (turnId: string) => ({ turnId, outcome: 'cancelled', category: 'Aborted', at: 9 }) as any;

  it('L5 — the closing mark: an epic being closed takes no chain end; a child being closed owes no wake; never saved', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    reg.setEpicPlan(epic.taskId!, { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] }, 'epic');
    const c1 = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const c2 = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const epicKey = `task:${epic.taskId}`;
    const k1 = `task:${c1.taskId}`;
    const k2 = `task:${c2.taskId}`;

    // The child being closed: its end is recorded, delivered.
    reg.markClosing(k1, true);
    reg.beginTaskTurn(k1, 't1', 'ch1');
    reg.commitTaskTurnOutcome(k1, cancelled('t1'), 'idle', { chainId: 'ch1', ends: true });
    expect(epic.epicEvents?.map((e) => [e.childTaskId, e.state])).toEqual([[c1.taskId, 'delivered']]);
    expect(readSaved().some((r) => 'closing' in r)).toBe(false);

    // The epic being closed: a child's end is dropped.
    reg.markClosing(epicKey, true);
    reg.beginTaskTurn(k2, 't2', 'ch2');
    reg.commitTaskTurnOutcome(k2, cancelled('t2'), 'idle', { chainId: 'ch2', ends: true });
    expect(epic.epicEvents).toHaveLength(1);
    expect(readSaved().some((r) => 'closing' in r)).toBe(false);

    // Cleared (the close did not go through): the epic takes events again.
    reg.markClosing(epicKey, false);
    expect(epic.closing).toBeUndefined();
    reg.beginTaskTurn(k2, 't3', 'ch3');
    reg.commitTaskTurnOutcome(k2, cancelled('t3'), 'idle', { chainId: 'ch3', ends: true });
    expect(epic.epicEvents?.find((e) => e.childTaskId === c2.taskId)?.state).toBe('pending');
  });

  it('L6 — a new chain on a child clears closedBy (put back on a failed save); a hop of the same chain keeps it', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const key = `task:${child.taskId}`;
    reg.beginTaskTurn(key, 't1', 'ch1');
    reg.markClosedByParent(key, 7);
    // A /compact hop of the chain being closed.
    reg.beginTaskTurn(key, 't2', 'ch1');
    expect(child.closedBy).toEqual({ by: 'parent', at: 7 });
    reg.commitTaskTurnOutcome(key, cancelled('t2'), 'idle', { chainId: 'ch1', ends: true });

    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.beginTaskTurn(key, 't3', 'ch2')).toThrow('ENOSPC');
    save.mockRestore();
    expect(child.closedBy).toEqual({ by: 'parent', at: 7 });

    reg.beginTaskTurn(key, 't3', 'ch2');
    expect(child.closedBy).toBeUndefined();
    expect(readSaved().find((r) => r.taskId === child.taskId)?.closedBy).toBeUndefined();
  });

  it('L7 — a close that lands before a child’s first hop keeps its mark through that hop (fable #703 R2 P3-1)', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const key = `task:${child.taskId}`;
    // An earlier chain ended before the close.
    reg.beginTaskTurn(key, 't0', 'ch0');
    reg.commitTaskTurnOutcome(key, { ...cancelled('t0'), outcome: 'finished', at: 5 }, 'idle', {
      chainId: 'ch0',
      ends: true,
    });
    // The close marks the child while its next chain's first hop is still being set up.
    reg.markClosedByParent(key, 7);
    reg.beginTaskTurn(key, 't1', 'ch1');
    expect(child.closedBy).toEqual({ by: 'parent', at: 7 });
    expect(readSaved().find((r) => r.taskId === child.taskId)?.closedBy).toEqual({ by: 'parent', at: 7 });
    // That chain is the one the close cancels; a chain after it starts unmarked.
    reg.commitTaskTurnOutcome(key, cancelled('t1'), 'idle', { chainId: 'ch1', ends: true });
    expect(child.closedBy).toEqual({ by: 'parent', at: 7 });
    reg.beginTaskTurn(key, 't2', 'ch2');
    expect(child.closedBy).toBeUndefined();
  });

  it('L8 — a closing epic’s dropped event is logged at info; a gone epic’s at warn (fable #703 R2 P3-2)', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const key = `task:${child.taskId}`;
    const info = vi.spyOn((reg as any).logger, 'info');
    const warn = vi.spyOn((reg as any).logger, 'warn');
    const dropped = (spy: typeof info) => spy.mock.calls.filter(([m]) => String(m).startsWith('Epic event dropped'));

    reg.markClosing(`task:${epic.taskId}`, true);
    reg.beginTaskTurn(key, 't1', 'ch1');
    reg.commitTaskTurnOutcome(key, cancelled('t1'), 'idle', { chainId: 'ch1', ends: true });
    expect(dropped(info).map(([m]) => m)).toEqual(['Epic event dropped — the epic is closing']);
    expect(dropped(warn)).toEqual([]);

    info.mockClear();
    epic.terminated = true;
    reg.beginTaskTurn(key, 't2', 'ch2');
    reg.commitTaskTurnOutcome(key, cancelled('t2'), 'idle', { chainId: 'ch2', ends: true });
    expect(dropped(warn).map(([m]) => m)).toEqual(['Epic event dropped — the epic is gone']);
    expect(dropped(info)).toEqual([]);
  });

  it('L9 — a closing epic takes no new plan; cleared, it does (fable #703 R2 P3-3)', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const epicKey = `task:${epic.taskId}`;
    reg.markClosing(epicKey, true);
    expect(() => reg.setEpicPlan(epic.taskId!, PLAN as any, 'owner')).toThrow('is not a live epic');
    expect(epic.plan).toBeUndefined();
    reg.markClosing(epicKey, false);
    expect(reg.setEpicPlan(epic.taskId!, PLAN as any, 'owner').nodes.map((n) => n.id)).toEqual(['login']);
  });

  it('L2 — the load keeps a tree not done (a child first in the file), and archives a done one', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord('child-1', { parentTaskId: 'epic-1', planNodeId: 'login', ...asleep }),
        slacklessRecord('epic-1', { kind: 'epic', childTaskIds: ['child-1'], plan: PLAN, ...asleep }),
        slacklessRecord('epic-2', { kind: 'epic', childTaskIds: ['child-2'], plan: DONE_PLAN, ...asleep }),
        slacklessRecord('child-2', { parentTaskId: 'epic-2', planNodeId: 'login', ...asleep }),
        // Done, but its child waits on its owner: kept.
        slacklessRecord('epic-3', { kind: 'epic', childTaskIds: ['child-3'], plan: DONE_PLAN, ...asleep }),
        slacklessRecord('child-3', {
          parentTaskId: 'epic-3',
          planNodeId: 'login',
          activityState: 'waiting',
          ...asleep,
        }),
        // Done, and its child died with the process (saved working): reconciled idle on this load,
        // so the tree follows the normal clock (grok #703 R1).
        slacklessRecord('epic-4', { kind: 'epic', childTaskIds: ['child-4'], plan: DONE_PLAN, ...asleep }),
        slacklessRecord('child-4', {
          parentTaskId: 'epic-4',
          planNodeId: 'login',
          activityState: 'working',
          ...asleep,
        }),
        slacklessRecord('plain-1', asleep),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    for (const id of ['epic-1', 'child-1', 'epic-3', 'child-3']) expect(reg.getSessionByTaskId(id), id).toBeDefined();
    for (const id of ['epic-2', 'child-2', 'epic-4', 'child-4', 'plain-1']) {
      expect(reg.getSessionByTaskId(id), id).toBeUndefined();
    }
    expect(archivedIds().sort()).toEqual(['child-2', 'child-4', 'epic-2', 'epic-4', 'plain-1']);
  });

  it('L3 — closedBy: parent is saved now, put back on a failed save, and carried through restart and archive', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const key = `task:${child.taskId}`;

    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.markClosedByParent(key, 7)).toThrow('ENOSPC');
    save.mockRestore();
    expect(child.closedBy).toBeUndefined();

    reg.markClosedByParent(key, 7);
    expect(child.closedBy).toEqual({ by: 'parent', at: 7 });
    expect(readSaved().find((r) => r.taskId === child.taskId)?.closedBy).toEqual({ by: 'parent', at: 7 });
    expect(() => reg.markClosedByParent(`task:${epic.taskId}`)).toThrow(/not a child/);

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(child.taskId!)?.closedBy).toEqual({ by: 'parent', at: 7 });

    after.terminateSession(key);
    const archived = fs
      .readdirSync(path.join(TEST_DATA_DIR, 'archives'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'archives', f), 'utf8')))
      .find((a) => a.taskId === child.taskId);
    expect(archived?.closedBy).toEqual({ by: 'parent', at: 7 });
  });

  it('L3 — a bad closedBy on load is dropped; an epic or ordinary task never carries one', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord('epic-1', { kind: 'epic', childTaskIds: ['c1', 'c2'], closedBy: { by: 'parent', at: 1 } }),
        slacklessRecord('c1', { parentTaskId: 'epic-1', planNodeId: 'login', closedBy: { by: 'owner', at: 1 } }),
        slacklessRecord('c2', { parentTaskId: 'epic-1', planNodeId: 'login', closedBy: { by: 'parent', at: 'x' } }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    for (const id of ['epic-1', 'c1', 'c2']) expect(reg.getSessionByTaskId(id)?.closedBy, id).toBeUndefined();
  });

  it('L4 — a child’s close is a delivered closed event on its epic, saved strictly; no live epic, nothing', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const key = `task:${child.taskId}`;

    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.recordEpicChildClosed(key, 9)).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.epicEvents).toBeUndefined();

    reg.recordEpicChildClosed(key, 9);
    const closed = {
      id: `${child.taskId}:closed`,
      childTaskId: child.taskId,
      planNodeId: 'login',
      outcome: 'closed',
      at: 9,
      state: 'delivered',
    };
    expect(epic.epicEvents).toEqual([closed]);
    expect(readSaved().find((r) => r.taskId === epic.taskId)?.epicEvents).toEqual([closed]);
    // Once: a second close of the same child adds nothing.
    reg.recordEpicChildClosed(key, 10);
    expect(epic.epicEvents).toHaveLength(1);

    epic.terminated = true;
    const other = reg.createTask(BASE);
    expect(() => reg.recordEpicChildClosed(`task:${other.taskId}`)).not.toThrow();
  });
});
