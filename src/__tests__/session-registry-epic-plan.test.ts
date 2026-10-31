/**
 * E4 ② — an epic's plan and events on the registry (.prd/19 D2 · D5 · D6).
 *
 *   P1 `setEpicPlan` saves the checked plan strictly; it survives a restart.
 *   P2 a refused write (`EpicPlanError`) or a non-epic target changes nothing,
 *      in memory or on disk.
 *   P3 a failed save puts the previous plan back.
 *   P4 a child made for a node is recorded on that node (`spawned`) in the
 *      same save that creates it; that node can no longer be removed, even
 *      after the child is gone; a failed create leaves the node as it was.
 *   P5 `done` is refused while a child runs or waits.
 *   P6 load keeps a well-formed plan and events on an epic only.
 *   P7 archive and revive keep the plan and events.
 *   P8 an ordinary task saves no plan fields.
 *   P9 a child whose id load re-mints is renamed in its node's `spawned` too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-plan-test-${process.pid}`),
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
import { EpicPlanError, type PlanWriteInput } from '../task-turn/epic-plan';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const BASE = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };
type Saved = Record<string, any>;
const readSaved = (): Saved[] => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const savedOf = (taskId: string) => readSaved().find((r) => r.taskId === taskId);

const TWO: PlanWriteInput = {
  nodes: [
    { id: 'login', title: 'Fix login', kind: 'issue' },
    { id: 'login-test', title: 'Test it', kind: 'sub', parent: 'login', body: 'e2e' },
  ],
};

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

const event = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  childTaskId: 'c1',
  planNodeId: 'login',
  outcome: 'completed',
  at: 1000,
  state: 'pending',
  ...extra,
});

describe('SessionRegistry — an epic plan and its events (E4 ②)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('P1 — setEpicPlan saves the checked plan; a verdict and the plan survive a restart', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const plan = reg.setEpicPlan(epic.taskId!, TWO, 'epic');
    expect(plan.nodes.map((n) => n.id)).toEqual(['login', 'login-test']);
    expect(epic.plan).toEqual(plan);
    expect(savedOf(epic.taskId!)?.plan).toEqual(plan);

    // A second write sets a verdict; the stored verdict names who set it.
    const accepted = reg.setEpicPlan(
      epic.taskId!,
      { nodes: [{ ...TWO.nodes[0], accepted: true }, TWO.nodes[1]] },
      'owner',
    );
    expect(accepted.nodes[0].accepted).toMatchObject({ by: 'owner' });

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(epic.taskId!)?.plan).toEqual(accepted);
  });

  it('P2 — a refused write and a non-epic target change nothing', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const plain = reg.createTask({ ...BASE });
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const first = reg.setEpicPlan(epic.taskId!, TWO, 'epic');
    const before = fs.readFileSync(SESSIONS_FILE, 'utf8');

    const bad: PlanWriteInput = { nodes: [{ id: 'orphan', title: 'x', kind: 'sub', parent: 'nope' }] };
    expect(() => reg.setEpicPlan(epic.taskId!, bad, 'epic')).toThrow(EpicPlanError);
    for (const target of [plain.taskId!, child.taskId!, '99999999-9999-4999-8999-999999999999']) {
      expect(() => reg.setEpicPlan(target, TWO, 'epic'), target).toThrow(/not a live epic/);
    }
    expect(epic.plan).toBe(first);
    expect(plain.plan).toBeUndefined();
    expect(child.plan).toBeUndefined();
    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).toBe(before);

    // A removed id is retired: bringing it back is refused, and nothing changes.
    const dropped = reg.setEpicPlan(epic.taskId!, { nodes: [TWO.nodes[0]] }, 'epic');
    expect(dropped.retired).toEqual(['login-test']);
    const beforeReuse = fs.readFileSync(SESSIONS_FILE, 'utf8');
    expect(() => reg.setEpicPlan(epic.taskId!, TWO, 'epic')).toThrow(expect.objectContaining({ code: 'id-reused' }));
    expect(epic.plan).toBe(dropped);
    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).toBe(beforeReuse);
  });

  it('P3 — a failed save puts the previous plan back', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const first = reg.setEpicPlan(epic.taskId!, TWO, 'epic');
    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.setEpicPlan(epic.taskId!, { nodes: [TWO.nodes[0]] }, 'epic')).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.plan).toBe(first);
  });

  it('P4 — a child is recorded on its node in the same save; that node cannot be removed, even after the child is gone', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    reg.setEpicPlan(epic.taskId!, TWO, 'epic');

    // A failed create leaves the node (and the parent's list) as they were.
    const planBefore = epic.plan;
    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login-test' })).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.plan).toBe(planBefore);
    expect(epic.childTaskIds ?? []).toEqual([]);

    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login-test' });
    const node = () => epic.plan!.nodes.find((n) => n.id === 'login-test')!;
    expect(node().spawned).toEqual([child.taskId]);
    expect(savedOf(epic.taskId!)?.plan.nodes[1].spawned).toEqual([child.taskId]);
    // The other node is untouched; a child for a node the plan lacks touches no node.
    expect(epic.plan!.nodes[0].spawned).toBeUndefined();
    const stray = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'not-planned' });
    expect(epic.plan!.nodes.flatMap((n) => n.spawned ?? [])).toEqual([child.taskId]);
    expect(epic.childTaskIds).toEqual([child.taskId, stray.taskId]);

    // The writer cannot drop or forge `spawned`: a rewrite keeps it.
    const kept = reg.setEpicPlan(epic.taskId!, TWO, 'epic');
    expect(kept.nodes[1].spawned).toEqual([child.taskId]);

    // While the child lives, and after it is closed, its node stays.
    const dropSub: PlanWriteInput = { nodes: [TWO.nodes[0]] };
    expect(() => reg.setEpicPlan(epic.taskId!, dropSub, 'epic')).toThrow(
      expect.objectContaining({ code: 'node-has-children' }),
    );
    reg.terminateSession(`task:${child.taskId}`);
    expect(() => reg.setEpicPlan(epic.taskId!, dropSub, 'epic')).toThrow(
      expect.objectContaining({ code: 'node-has-children' }),
    );
    expect(node().spawned).toEqual([child.taskId]);
  });

  it('P5 — done is refused while a child runs or waits, accepted once none does', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    reg.setEpicPlan(epic.taskId!, TWO, 'epic');
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    for (const state of ['working', 'waiting'] as const) {
      child.activityState = state;
      expect(() => reg.setEpicPlan(epic.taskId!, { ...TWO, done: true }, 'epic'), state).toThrow(
        expect.objectContaining({ code: 'children-running' }),
      );
      expect(epic.plan!.done).toBeUndefined();
    }
    child.activityState = 'idle';
    const done = reg.setEpicPlan(epic.taskId!, { ...TWO, done: true }, 'owner');
    expect(done.done).toMatchObject({ by: 'owner' });
    expect(savedOf(epic.taskId!)?.plan.done).toMatchObject({ by: 'owner' });
  });

  it('P6 — load keeps a well-formed plan and events on an epic only', () => {
    const epicId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    const plainId = '44444444-4444-4444-8444-444444444444';
    const slackId = '55555555-5555-4555-8555-555555555555';
    const plan = {
      nodes: [
        {
          id: 'login',
          title: 'Fix login',
          kind: 'issue',
          accepted: { by: 'epic', at: 5 },
          spawned: [childId, childId],
        },
        { id: 'login-test', title: 'Test', kind: 'sub', parent: 'login' },
        { id: 'Bad Id', title: 'x', kind: 'issue' },
        { id: 'stray', title: 'x', kind: 'sub', parent: 'gone' },
        { id: 'forged', title: 'x', kind: 'issue', accepted: { by: 'child', at: 5 } },
      ],
      done: { by: 'someone', at: 1 },
    };
    const events = [event('e1'), event('e1'), event('e2', { outcome: 'exploded' }), event('e3', { state: 'x' })];
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord(epicId, { kind: 'epic', childTaskIds: [childId], plan, epicEvents: events }),
        slacklessRecord(childId, { parentTaskId: epicId, planNodeId: 'login', plan, epicEvents: events }),
        slacklessRecord(plainId, { plan, epicEvents: events }),
        {
          key: 'work:C1:1.1',
          ownerId: 'U1',
          userId: 'U1',
          channelId: 'C1',
          threadTs: '1.1',
          taskId: slackId,
          isActive: true,
          lastActivity: new Date().toISOString(),
          state: 'MAIN',
          activityState: 'idle',
          kind: 'epic',
          plan,
          epicEvents: events,
        },
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const epic = reg.getSessionByTaskId(epicId)!;
    expect(epic.plan).toEqual({
      nodes: [
        { id: 'login', title: 'Fix login', kind: 'issue', accepted: { by: 'epic', at: 5 }, spawned: [childId] },
        { id: 'login-test', title: 'Test', kind: 'sub', parent: 'login' },
        { id: 'forged', title: 'x', kind: 'issue' },
      ],
    });
    expect(epic.epicEvents).toEqual([event('e1')]);
    for (const id of [childId, plainId, slackId]) {
      const s = reg.getSessionByTaskId(id)!;
      expect(s.plan, id).toBeUndefined();
      expect(s.epicEvents, id).toBeUndefined();
    }
    // What load kept is what the next save writes.
    reg.setEpicPlan(epicId, { nodes: [...TWO.nodes, { id: 'forged', title: 'x', kind: 'issue' }] }, 'epic');
    expect(savedOf(epicId)?.epicEvents).toEqual([event('e1')]);
    expect(savedOf(childId)?.plan).toBeUndefined();
  });

  it('P7 — archive and revive keep the plan and events', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const plan = reg.setEpicPlan(epic.taskId!, TWO, 'epic');
    epic.epicEvents = [event('e1') as any];
    reg.terminateSession(`task:${epic.taskId}`);
    const dir = path.join(TEST_DATA_DIR, 'archives');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!;
    const archived = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    expect(archived.plan).toEqual(plan);
    expect(archived.epicEvents).toEqual([event('e1')]);

    expect(reg.restoreArchivedSession(archived, '/work/U1/session_1')).toMatchObject({ ok: true });
    const back = reg.getSessionByTaskId(epic.taskId!)!;
    expect(back.plan).toEqual(plan);
    expect(back.epicEvents).toEqual([event('e1')]);
  });

  it("P9 — a child whose id load re-mints is renamed in its node's spawned list too", () => {
    const epicId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    const plan = { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue', spawned: [childId] }] };
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        // A Slack session earlier in the file holds the child's id.
        {
          key: 'work:C1:1.1',
          ownerId: 'U1',
          userId: 'U1',
          channelId: 'C1',
          threadTs: '1.1',
          taskId: childId,
          isActive: true,
          lastActivity: new Date().toISOString(),
          state: 'MAIN',
          activityState: 'idle',
        },
        slacklessRecord(epicId, { kind: 'epic', childTaskIds: [childId], plan }),
        slacklessRecord(childId, { parentTaskId: epicId, planNodeId: 'login' }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const child = [...reg.getAllSessions().values()].find((s) => s.planNodeId === 'login')!;
    expect(child.taskId).not.toBe(childId);
    const epic = reg.getSessionByTaskId(epicId)!;
    expect(epic.plan!.nodes[0].spawned).toEqual([child.taskId]);
    expect(savedOf(epicId)?.plan.nodes[0].spawned).toEqual([child.taskId]);
  });

  it('P8 — an ordinary task and a child save no plan fields', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const plain = reg.createTask({ ...BASE });
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'a' });
    for (const id of [plain.taskId!, child.taskId!, epic.taskId!]) {
      const saved = savedOf(id)!;
      for (const field of ['plan', 'epicEvents']) {
        expect(field in saved && saved[field] !== undefined, `${id} ${field}`).toBe(false);
      }
    }
  });
});
