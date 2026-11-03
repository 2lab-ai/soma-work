/**
 * E4 ② — a Slack epic's plan and events on the registry (.prd/19 D2 · D5 · D6, #854).
 *
 *   P1 `setEpicPlan` saves the checked plan strictly; it survives a restart.
 *   P2 a refused write (`EpicPlanError`) or a target that is no live epic
 *      changes nothing, in memory or on disk; a removed id is retired.
 *   P3 a failed save puts the previous plan back.
 *   P4 a child reserved for a node is recorded on that node (`spawned`) in the
 *      same save; that node can no longer be removed, even after the child is
 *      closed; a failed reservation, or one for a node the plan lacks, leaves
 *      the plan as it was.
 *   P5 `done` is refused while a child runs or waits.
 *   P6 load keeps a well-formed plan and events on an epic only.
 *   P7 archive and revive keep the plan and events.
 *   P8 an ordinary session and a child save no plan fields.
 *
 * #855 — the dashboard-task stack was removed: a child is reserved and bound
 * (no `createTask`), and the re-minted Slack-less child ids load renamed in
 * `spawned` (P9, P9b) are gone with it.
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
type Saved = Record<string, any>;
const readSaved = (): Saved[] => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const savedOf = (taskId: string) => readSaved().find((r) => r.taskId === taskId);
const failNextSave = (reg: SessionRegistry) =>
  vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
    throw new Error('ENOSPC');
  });

const EPIC_TS = '1700000000.000100';
const CHILD_TS = '1700000001.000100';
const PLAIN_TS = '1700000002.000100';

const TWO: PlanWriteInput = {
  nodes: [
    { id: 'login', title: 'Fix login', kind: 'issue' },
    { id: 'login-test', title: 'Test it', kind: 'sub', parent: 'login', body: 'e2e' },
  ],
};

/** A Slack session made an epic; its plan is written unless it is `null`. */
function epicIn(reg: SessionRegistry, plan: PlanWriteInput | null = TWO, ts = EPIC_TS) {
  const session = reg.createSession('U1', 'User', 'C1', ts);
  const key = reg.getSessionKey('C1', ts);
  reg.makeEpic(key);
  if (plan) reg.setEpicPlan(session.taskId as string, plan, 'epic');
  return { epic: session, key };
}

function childIn(reg: SessionRegistry, epicTaskId: string, planNodeId = 'login', ts = CHILD_TS) {
  const childId = reg.reserveEpicChild(epicTaskId, planNodeId);
  const child = reg.createSession('U1', 'User', 'C1', ts);
  const key = reg.getSessionKey('C1', ts);
  reg.bindEpicChild(key, { taskId: childId, parentTaskId: epicTaskId, planNodeId });
  return { child, key, childId };
}

/** A saved Slack session — a thread and an SDK session, so it loads and is saved again. */
function slackRecord(threadTs: string, taskId: string, extra: Record<string, unknown> = {}) {
  return {
    key: `C1-${threadTs}`,
    ownerId: 'U1',
    ownerName: 'User',
    userId: 'U1',
    channelId: 'C1',
    threadTs,
    sessionId: `sdk-${threadTs}`,
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

describe('SessionRegistry — a Slack epic’s plan and its events (E4 ②)', () => {
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
    const { epic } = epicIn(reg, null);
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

  it('P2 — a refused write and a target that is no live epic change nothing', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const { child } = childIn(reg, epic.taskId!, 'login');
    const plain = reg.createSession('U1', 'User', 'C1', PLAIN_TS);
    const first = epic.plan;
    const before = fs.readFileSync(SESSIONS_FILE, 'utf8');

    const bad: PlanWriteInput = { nodes: [{ id: 'orphan', title: 'x', kind: 'sub', parent: 'nope' }] };
    expect(() => reg.setEpicPlan(epic.taskId!, bad, 'epic')).toThrow(EpicPlanError);
    for (const target of [plain.taskId!, child.taskId!, '99999999-9999-4999-8999-999999999999']) {
      expect(() => reg.setEpicPlan(target, TWO, 'epic'), target).toThrow(/not a live epic/);
    }
    // A closed epic takes no new plan.
    epic.terminated = true;
    expect(() => reg.setEpicPlan(epic.taskId!, { nodes: [] }, 'epic')).toThrow(/not a live epic/);
    epic.terminated = undefined;
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
    const { epic } = epicIn(reg);
    const first = epic.plan;
    const save = failNextSave(reg);
    expect(() => reg.setEpicPlan(epic.taskId!, { nodes: [TWO.nodes[0]] }, 'epic')).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.plan).toBe(first);
    expect(savedOf(epic.taskId!)?.plan.nodes).toHaveLength(2);
  });

  it('P4 — a child is recorded on its node in the same save; that node cannot be removed, even after the child is closed', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);

    // A failed reservation leaves the node (and the parent's list) as they were.
    const planBefore = epic.plan;
    const save = failNextSave(reg);
    expect(() => reg.reserveEpicChild(epic.taskId!, 'login-test')).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.plan).toBe(planBefore);
    expect(epic.childTaskIds ?? []).toEqual([]);
    // A node the plan lacks takes no child.
    expect(() => reg.reserveEpicChild(epic.taskId!, 'not-planned')).toThrow(/has no node/);
    expect(epic.plan).toBe(planBefore);
    expect(epic.childTaskIds ?? []).toEqual([]);

    const { key: childKey, childId } = childIn(reg, epic.taskId!, 'login-test');
    const node = () => epic.plan!.nodes.find((n) => n.id === 'login-test')!;
    expect(node().spawned).toEqual([childId]);
    expect(savedOf(epic.taskId!)?.plan.nodes[1].spawned).toEqual([childId]);
    // The other node is untouched.
    expect(epic.plan!.nodes[0].spawned).toBeUndefined();
    expect(epic.childTaskIds).toEqual([childId]);

    // The writer cannot drop `spawned`: a rewrite keeps it.
    const kept = reg.setEpicPlan(epic.taskId!, TWO, 'epic');
    expect(kept.nodes[1].spawned).toEqual([childId]);

    // While the child lives, and after it is closed, its node stays.
    const dropSub: PlanWriteInput = { nodes: [TWO.nodes[0]] };
    expect(() => reg.setEpicPlan(epic.taskId!, dropSub, 'epic')).toThrow(
      expect.objectContaining({ code: 'node-has-children' }),
    );
    reg.terminateSession(childKey);
    expect(reg.getChildTasks(epic.taskId!)).toEqual([]);
    expect(() => reg.setEpicPlan(epic.taskId!, dropSub, 'epic')).toThrow(
      expect.objectContaining({ code: 'node-has-children' }),
    );
    expect(node().spawned).toEqual([childId]);
  });

  it('P5 — done is refused while a child runs or waits, accepted once none does', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const { child } = childIn(reg, epic.taskId!, 'login');
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
        slackRecord('1.1', epicId, { kind: 'epic', childTaskIds: [childId], plan, epicEvents: events }),
        slackRecord('2.2', childId, { parentTaskId: epicId, planNodeId: 'login', plan, epicEvents: events }),
        slackRecord('3.3', plainId, { plan, epicEvents: events }),
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
      // The orphan sub load dropped is retired (its id is never reused); a bad slug never was an id.
      retired: ['stray'],
    });
    expect(epic.epicEvents).toEqual([event('e1')]);
    for (const id of [childId, plainId]) {
      const s = reg.getSessionByTaskId(id)!;
      expect(s.plan, id).toBeUndefined();
      expect(s.epicEvents, id).toBeUndefined();
    }
    // What load kept is what the next save writes.
    reg.setEpicPlan(epicId, { nodes: [...TWO.nodes, { id: 'forged', title: 'x', kind: 'issue' }] }, 'epic');
    expect(savedOf(epicId)?.epicEvents).toEqual([event('e1')]);
    for (const id of [childId, plainId]) {
      expect(savedOf(id)?.plan, id).toBeUndefined();
      expect(savedOf(id)?.epicEvents, id).toBeUndefined();
    }
  });

  it('P7 — archive and revive keep the plan and events', () => {
    const reg = new SessionRegistry();
    const { epic, key } = epicIn(reg);
    const plan = epic.plan;
    epic.epicEvents = [event('e1') as any];
    reg.terminateSession(key);
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

  it('P8 — an ordinary session, a child and an epic with no plan yet save no plan fields', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const { child } = childIn(reg, epic.taskId!, 'login');
    const { epic: bare } = epicIn(reg, null, '1700000003.000100');
    const plain = reg.createSession('U1', 'User', 'C1', PLAIN_TS);
    plain.sessionId = 'sdk-plain';
    reg.saveSessions();
    for (const id of [plain.taskId!, child.taskId!, bare.taskId!]) {
      const saved = savedOf(id)!;
      expect(saved, id).toBeDefined();
      for (const field of ['plan', 'epicEvents']) {
        expect(field in saved && saved[field] !== undefined, `${id} ${field}`).toBe(false);
      }
    }
  });
});
