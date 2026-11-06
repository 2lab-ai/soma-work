/**
 * #1020 — an epic adopts one of its owner's existing tasks as a child (`adoptEpicChild`).
 *
 *   AD1 the task keeps its own task id; it gets its epic and its plan node (indexed: the epic's
 *       lookup finds it), its id goes on the epic's `childTaskIds` and the node's `spawned` — one
 *       strict save.
 *   AD2 the relation survives a restart: the child keeps its parent and node, the epic finds it.
 *   AD3 its chain end reaches the epic (a pending event on the epic, as a spawned child's).
 *   AD4 the board shows it under its node.
 *   AD5 every refusal changes nothing: no live epic, the epic itself, no such node, no such task,
 *       no task id, an epic, a closed / closing / trashed task, already a child, another owner's,
 *       a node that has a live child, the epic's children used up (closed ones count).
 *   AD6 a failed save puts everything back and says so (`not-saved`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-adopt-test-${process.pid}`),
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
import { epicBoardView } from '../task-turn/epic-board';
import { EPIC_CHILD_MAX } from '../task-turn/epic-server';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const readSaved = (): Array<Record<string, any>> => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const EPIC_TS = '1700000000.000100';
const PLAN = {
  nodes: [
    { id: 'login', title: '로그인 고치기', kind: 'issue' as const },
    { id: 'docs', title: '문서', kind: 'issue' as const },
  ],
};

function epicIn(reg: SessionRegistry, owner = 'U1', ts = EPIC_TS) {
  const epic = reg.createSession(owner, 'User', 'C1', ts);
  const key = reg.getSessionKey('C1', ts);
  reg.makeEpic(key);
  reg.setEpicPlan(epic.taskId as string, PLAN, 'epic');
  return { epic, key, epicId: epic.taskId as string };
}

/** One of the owner's own tasks, in a thread of its own (any channel). */
function taskIn(reg: SessionRegistry, ts: string, owner = 'U1') {
  const task = reg.createSession(owner, 'User', 'C2', ts);
  return { task, key: reg.getSessionKey('C2', ts), taskId: task.taskId as string };
}

describe('SessionRegistry.adoptEpicChild (#1020)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('AD1 — the task keeps its id, gets its epic and node, and is counted on the epic, in one save', () => {
    const reg = new SessionRegistry();
    const { epic, epicId } = epicIn(reg);
    const { task, taskId } = taskIn(reg, '1700000001.000100');
    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow');

    expect(reg.adoptEpicChild(epicId, taskId, 'login')).toEqual({ ok: true });

    expect(save).toHaveBeenCalledTimes(1);
    expect(task).toMatchObject({ taskId, parentTaskId: epicId, planNodeId: 'login' });
    expect(reg.getSessionByTaskId(taskId)).toBe(task);
    expect(reg.getChildTasks(epicId)).toEqual([task]);
    expect(epic.childTaskIds).toEqual([taskId]);
    expect(epic.plan?.nodes.find((n) => n.id === 'login')?.spawned).toEqual([taskId]);
    expect(epic.plan?.nodes.find((n) => n.id === 'docs')?.spawned).toBeUndefined();
    const saved = readSaved();
    expect(saved.find((r) => r.taskId === taskId)).toMatchObject({ parentTaskId: epicId, planNodeId: 'login' });
    expect(saved.find((r) => r.taskId === epicId)?.childTaskIds).toEqual([taskId]);
  });

  it('AD2 — the adopted child survives a restart: its parent and node, the epic’s lookup, its count', () => {
    const reg = new SessionRegistry();
    const { epicId } = epicIn(reg);
    const { taskId } = taskIn(reg, '1700000001.000100');
    expect(reg.adoptEpicChild(epicId, taskId, 'login')).toEqual({ ok: true });

    const after = new SessionRegistry();
    after.loadSessions();
    const child = after.getSessionByTaskId(taskId);
    expect(child).toMatchObject({ taskId, parentTaskId: epicId, planNodeId: 'login' });
    expect(after.getChildTasks(epicId).map((c) => c.taskId)).toEqual([taskId]);
    const epic = after.getSessionByTaskId(epicId);
    expect(epic?.childTaskIds).toEqual([taskId]);
    expect(epic?.plan?.nodes.find((n) => n.id === 'login')?.spawned).toEqual([taskId]);
  });

  it('AD3 — its chain end reaches the epic as a pending event', () => {
    const reg = new SessionRegistry();
    const { epic, epicId, key: epicKey } = epicIn(reg);
    const { key, taskId } = taskIn(reg, '1700000001.000100');
    reg.adoptEpicChild(epicId, taskId, 'login');
    const heard: string[] = [];
    reg.setEpicEventListener((k) => heard.push(k));
    reg.recordSessionChainEnd(key, { outcome: 'completed', at: 1000 });
    expect(epic.epicEvents).toEqual([
      expect.objectContaining({ childTaskId: taskId, planNodeId: 'login', outcome: 'completed', state: 'pending' }),
    ]);
    expect(heard).toEqual([epicKey]);
  });

  it('AD4 — the board shows the adopted child under its node', () => {
    const reg = new SessionRegistry();
    const { epic, epicId } = epicIn(reg);
    const { task, taskId } = taskIn(reg, '1700000001.000100');
    task.activityState = 'working';
    reg.adoptEpicChild(epicId, taskId, 'login');
    const view = epicBoardView(epic, reg.getChildTasks(epicId));
    expect(view.nodes.find((n) => n.id === 'login')).toMatchObject({ status: 'running', childTaskIds: [taskId] });
    expect(view.nodes.find((n) => n.id === 'docs')).toMatchObject({ status: 'none', childTaskIds: [] });
    expect(view.state).toBe('running');
  });

  describe('AD5 — every refusal changes nothing', () => {
    function world() {
      const reg = new SessionRegistry();
      const e = epicIn(reg);
      const t = taskIn(reg, '1700000001.000100');
      const unchanged = () => {
        expect(t.task.parentTaskId).toBeUndefined();
        expect(t.task.planNodeId).toBeUndefined();
        expect(e.epic.childTaskIds ?? []).toEqual([]);
        expect(e.epic.plan?.nodes.every((n) => !n.spawned)).toBe(true);
        expect(reg.getChildTasks(e.epicId)).toEqual([]);
      };
      return {
        reg,
        epic: e.epic,
        epicId: e.epicId,
        epicKey: e.key,
        task: t.task,
        taskId: t.taskId,
        key: t.key,
        unchanged,
      };
    }
    const refusal = (code: string) => ({ ok: false, code, error: expect.any(String) });

    it('no live epic: unknown, not an epic, closing, terminated', () => {
      const w = world();
      expect(w.reg.adoptEpicChild('nobody', w.taskId, 'login')).toEqual(refusal('not-an-epic'));
      const plain = taskIn(w.reg, '1700000002.000100');
      expect(w.reg.adoptEpicChild(plain.taskId, w.taskId, 'login')).toEqual(refusal('not-an-epic'));
      w.reg.markClosing(w.epicKey, true);
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'login')).toEqual(refusal('not-an-epic'));
      w.reg.markClosing(w.epicKey, false);
      w.epic.terminated = true;
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'login')).toEqual(refusal('not-an-epic'));
      w.epic.terminated = undefined;
      w.unchanged();
    });

    it('the epic itself, no such node, no such task', () => {
      const w = world();
      expect(w.reg.adoptEpicChild(w.epicId, w.epicId, 'login')).toEqual(refusal('self'));
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'nope')).toEqual(refusal('no-such-node'));
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'Bad Id')).toEqual(refusal('no-such-node'));
      expect(w.reg.adoptEpicChild(w.epicId, 'missing', 'login')).toEqual(refusal('no-such-task'));
      expect(w.reg.adoptEpicChild(w.epicId, '', 'login')).toEqual(refusal('no-such-task'));
      w.unchanged();
    });

    it('a task without a task id', () => {
      const w = world();
      // Every session the registry holds has one (create / load / revive mint it): a record that lost it is refused.
      w.task.taskId = undefined;
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'login')).toEqual(refusal('no-task-id'));
      w.task.taskId = w.taskId;
      w.unchanged();
    });

    it('an epic', () => {
      const w = world();
      const other = epicIn(w.reg, 'U1', '1700000009.000100');
      expect(w.reg.adoptEpicChild(w.epicId, other.epicId, 'login')).toEqual(refusal('is-epic'));
      expect(other.epic.parentTaskId).toBeUndefined();
      w.unchanged();
    });

    it('a closing, terminated or trashed task', () => {
      const w = world();
      w.reg.markClosing(w.key, true);
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'login')).toEqual(refusal('task-closed'));
      w.reg.markClosing(w.key, false);
      w.task.terminated = true;
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'login')).toEqual(refusal('task-closed'));
      w.task.terminated = undefined;
      w.reg.trashSession(w.key);
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'login')).toEqual(refusal('task-trashed'));
      w.unchanged();
    });

    it('already a child — of this epic or another', () => {
      const w = world();
      const other = epicIn(w.reg, 'U1', '1700000009.000100');
      const theirs = taskIn(w.reg, '1700000003.000100');
      expect(w.reg.adoptEpicChild(other.epicId, theirs.taskId, 'login')).toEqual({ ok: true });
      expect(w.reg.adoptEpicChild(w.epicId, theirs.taskId, 'docs')).toEqual(refusal('already-a-child'));
      expect(theirs.task.parentTaskId).toBe(other.epicId);
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'login')).toEqual({ ok: true });
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'docs')).toEqual(refusal('already-a-child'));
      expect(w.task.planNodeId).toBe('login');
      expect(w.epic.childTaskIds).toEqual([w.taskId]);
    });

    it('another owner’s task', () => {
      const w = world();
      const stranger = taskIn(w.reg, '1700000004.000100', 'U2');
      expect(w.reg.adoptEpicChild(w.epicId, stranger.taskId, 'login')).toEqual(refusal('other-owner'));
      expect(stranger.task.parentTaskId).toBeUndefined();
      w.unchanged();
    });

    it('a node that has a live child (one per node, as spawn_child)', () => {
      const w = world();
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'login')).toEqual({ ok: true });
      const second = taskIn(w.reg, '1700000005.000100');
      expect(w.reg.adoptEpicChild(w.epicId, second.taskId, 'login')).toEqual(refusal('node-taken'));
      expect(second.task.parentTaskId).toBeUndefined();
      expect(w.epic.childTaskIds).toEqual([w.taskId]);
      // Another node is free.
      expect(w.reg.adoptEpicChild(w.epicId, second.taskId, 'docs')).toEqual({ ok: true });
    });

    it(`the epic's ${EPIC_CHILD_MAX} children used up (closed ones count)`, () => {
      const w = world();
      w.epic.childTaskIds = Array.from({ length: EPIC_CHILD_MAX }, (_, i) => `gone${i}`);
      expect(w.reg.adoptEpicChild(w.epicId, w.taskId, 'login')).toEqual(refusal('too-many-children'));
      expect(w.task.parentTaskId).toBeUndefined();
      expect(w.epic.childTaskIds).toHaveLength(EPIC_CHILD_MAX);
    });
  });

  it('AD6 — a failed save puts everything back and says so', () => {
    const reg = new SessionRegistry();
    const { epic, epicId } = epicIn(reg);
    const { task, taskId } = taskIn(reg, '1700000001.000100');
    const planBefore = epic.plan;
    vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(reg.adoptEpicChild(epicId, taskId, 'login')).toEqual({
      ok: false,
      code: 'not-saved',
      error: expect.any(String),
    });
    expect(task.taskId).toBe(taskId);
    expect(task.parentTaskId).toBeUndefined();
    expect(task.planNodeId).toBeUndefined();
    expect(epic.childTaskIds).toBeUndefined();
    expect(epic.plan).toBe(planBefore);
    expect(reg.getChildTasks(epicId)).toEqual([]);
    expect(reg.getSessionByTaskId(taskId)).toBe(task);
    // Nothing is stuck: the next try goes through.
    expect(reg.adoptEpicChild(epicId, taskId, 'login')).toEqual({ ok: true });
    expect(reg.getChildTasks(epicId)).toEqual([task]);
  });
});
