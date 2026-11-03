/**
 * E4 ① — the epic / child relation on Slack sessions (.prd/19 D1, #854).
 *
 *   R1 a Slack session made an epic (`makeEpic`) is saved as one and survives a
 *      restart; making it an epic again saves nothing.
 *   R2 children are reserved on the epic (`childTaskIds`, one strict save each),
 *      then bound to their own Slack sessions with their parent and node, saved;
 *      the parent → child lookup is rebuilt on load.
 *   R3 refused before anything is saved: a child or a closed session made an
 *      epic; a reservation on a missing / non-epic / closed / closing epic or for
 *      a node the plan lacks; a bind of a session that already has a place, with
 *      a bad node id, under no live epic, or of an id another session holds.
 *   R4 a failed save puts back what it changed: the epic mark, the reservation
 *      (no ghost id on the parent), the bind.
 *   R5 load keeps only well-formed values (on any record); a child cannot be an
 *      epic; only an epic has children.
 *   R6 archive and revive keep the relation.
 *   R7 a session that is neither epic nor child saves no relation fields.
 *   R9 a record archived on load keeps the relation.
 *
 * #855 — the dashboard-task stack was removed: `createTask`'s refusals and failed
 * save are now the reserve / bind ones above, and the re-minted Slack-less ids
 * whose relation load relinked (R8, R10) are gone with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-relation-test-${process.pid}`),
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
import { SessionRegistry, sanitizeEpicRelation } from '../session-registry';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
type Saved = Record<string, any>;
const readSaved = (): Saved[] => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const savedOf = (taskId: string) => readSaved().find((r) => r.taskId === taskId);
const archives = (): Saved[] => {
  const dir = path.join(TEST_DATA_DIR, 'archives');
  return fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
};
const failNextSave = (reg: SessionRegistry) =>
  vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
    throw new Error('ENOSPC');
  });

const EPIC_TS = '1700000000.000100';
const CHILD_TS = '1700000001.000100';
const PLAIN_TS = '1700000002.000100';
const PLAN = { nodes: [{ id: 'login', title: '로그인 고치기', kind: 'issue' as const }] };

function epicIn(reg: SessionRegistry, owner = 'U1') {
  const session = reg.createSession(owner, 'User', 'C1', EPIC_TS);
  const key = reg.getSessionKey('C1', EPIC_TS);
  reg.makeEpic(key);
  reg.setEpicPlan(session.taskId as string, PLAN, 'epic');
  return { epic: session, key };
}

function childIn(reg: SessionRegistry, epicTaskId: string, ts = CHILD_TS, owner = 'U1') {
  const childId = reg.reserveEpicChild(epicTaskId, 'login');
  const child = reg.createSession(owner, 'User', 'C1', ts);
  const key = reg.getSessionKey('C1', ts);
  reg.bindEpicChild(key, { taskId: childId, parentTaskId: epicTaskId, planNodeId: 'login' });
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

describe('SessionRegistry — epic and child Slack sessions (E4 ①)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('R1 — an epic is saved as such and survives a restart; making it an epic again saves nothing', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', EPIC_TS);
    const key = reg.getSessionKey('C1', EPIC_TS);
    expect(reg.makeEpic(key)).toBe(session);
    expect(session.kind).toBe('epic');
    expect(savedOf(session.taskId!)).toMatchObject({ kind: 'epic', channelId: 'C1', threadTs: EPIC_TS });

    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow');
    expect(reg.makeEpic(key)).toBe(session);
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(session.taskId!)?.kind).toBe('epic');
  });

  it('R2 — children are reserved on the epic, then bound with their parent and node, saved; the lookup survives a restart', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const first = childIn(reg, epic.taskId!);
    const second = childIn(reg, epic.taskId!, PLAIN_TS);
    for (const { child, childId } of [first, second]) {
      expect(child).toMatchObject({ taskId: childId, parentTaskId: epic.taskId, planNodeId: 'login' });
      expect(child.kind).toBeUndefined();
      expect(savedOf(childId)).toMatchObject({ parentTaskId: epic.taskId, planNodeId: 'login' });
      expect(savedOf(childId)?.kind).toBeUndefined();
    }
    expect(epic.childTaskIds).toEqual([first.childId, second.childId]);
    expect(savedOf(epic.taskId!)?.childTaskIds).toEqual([first.childId, second.childId]);
    expect(reg.getChildTasks(epic.taskId!)).toEqual([first.child, second.child]);

    const after = new SessionRegistry();
    after.loadSessions();
    const back = after.getChildTasks(epic.taskId!);
    expect(back.map((s) => s.taskId).sort()).toEqual([first.childId, second.childId].sort());
    expect(after.getSessionByTaskId(first.childId)).toBe(back.find((s) => s.taskId === first.childId));
    expect(after.getSessionByTaskId(epic.taskId!)?.childTaskIds).toEqual([first.childId, second.childId]);
  });

  it('R3 — refused before anything is saved', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    const { child, key: childKey, childId } = childIn(reg, epic.taskId!);
    // Reserved, not yet bound: a bind may take it.
    const spare = reg.reserveEpicChild(epic.taskId!, 'login');
    const plain = reg.createSession('U1', 'User', 'C1', PLAIN_TS);
    const plainKey = reg.getSessionKey('C1', PLAIN_TS);
    const before = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const epicPlan = epic.plan;
    const bind = (extra: Record<string, string> = {}) => ({
      taskId: spare,
      parentTaskId: epic.taskId!,
      planNodeId: 'login',
      ...extra,
    });

    // A child is never an epic (depth 1); nor is a closed session.
    expect(() => reg.makeEpic(childKey)).toThrow(/cannot be an epic/);
    plain.terminated = true;
    expect(() => reg.makeEpic(plainKey)).toThrow(/cannot be an epic/);
    plain.terminated = undefined;

    // A reservation needs a live epic and a node of its plan.
    for (const target of [plain.taskId!, childId, '99999999-9999-4999-8999-999999999999']) {
      expect(() => reg.reserveEpicChild(target, 'login'), target).toThrow(/not a live epic/);
    }
    expect(() => reg.reserveEpicChild(epic.taskId!, 'not-planned')).toThrow(/has no node not-planned/);

    const attempts: Array<[string, string, Record<string, string>, RegExp]> = [
      ['the session must exist', reg.getSessionKey('C9', '1.1'), {}, /no session/],
      ['an epic is no child', epicKey, {}, /already has its own place/],
      ['a child is bound once', childKey, {}, /already has its own place/],
      ['the node id is a short slug', plainKey, { planNodeId: 'Has Spaces!' }, /bad plan node id/],
      ['the parent must be a live epic', plainKey, { parentTaskId: plain.taskId! }, /not a live epic/],
      ['the id must not be another session’s', plainKey, { taskId: childId }, /held by another session/],
    ];
    for (const [label, key, extra, refusal] of attempts) {
      expect(() => reg.bindEpicChild(key, bind(extra)), label).toThrow(refusal);
    }

    // A closed epic, or one being closed (flagged while its close is awaited), takes no new child.
    epic.terminated = true;
    expect(() => reg.reserveEpicChild(epic.taskId!, 'login')).toThrow(/not a live epic/);
    expect(() => reg.bindEpicChild(plainKey, bind())).toThrow(/not a live epic/);
    epic.terminated = undefined;
    reg.markClosing(epicKey, true);
    expect(() => reg.reserveEpicChild(epic.taskId!, 'login')).toThrow(/not a live epic/);
    expect(() => reg.bindEpicChild(plainKey, bind())).toThrow(/not a live epic/);
    reg.markClosing(epicKey, false);

    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).toBe(before);
    expect(epic.plan).toBe(epicPlan);
    expect(epic.childTaskIds).toEqual([childId, spare]);
    expect(child.kind).toBeUndefined();
    expect([plain.kind, plain.parentTaskId, plain.planNodeId]).toEqual([undefined, undefined, undefined]);
    expect(reg.getChildTasks(epic.taskId!)).toEqual([child]);
    expect(reg.getSessionByTaskId(spare)).toBeUndefined();
  });

  it('R4 — a failed save puts back the epic mark, the reservation (no ghost id) and the bind', () => {
    const reg = new SessionRegistry();
    const epic = reg.createSession('U1', 'User', 'C1', EPIC_TS);
    const epicKey = reg.getSessionKey('C1', EPIC_TS);
    let save = failNextSave(reg);
    expect(() => reg.makeEpic(epicKey)).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.kind).toBeUndefined();

    reg.makeEpic(epicKey);
    reg.setEpicPlan(epic.taskId!, PLAN, 'epic');
    const plan = epic.plan;
    save = failNextSave(reg);
    expect(() => reg.reserveEpicChild(epic.taskId!, 'login')).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.childTaskIds).toBeUndefined();
    expect(epic.plan).toBe(plan);
    expect(savedOf(epic.taskId!)?.childTaskIds).toBeUndefined();

    const childId = reg.reserveEpicChild(epic.taskId!, 'login');
    const child = reg.createSession('U1', 'User', 'C1', CHILD_TS);
    const childKey = reg.getSessionKey('C1', CHILD_TS);
    const ownId = child.taskId!;
    const relation = { taskId: childId, parentTaskId: epic.taskId!, planNodeId: 'login' };
    save = failNextSave(reg);
    expect(() => reg.bindEpicChild(childKey, relation)).toThrow('ENOSPC');
    save.mockRestore();
    expect([child.taskId, child.parentTaskId, child.planNodeId]).toEqual([ownId, undefined, undefined]);
    expect(reg.getSessionByTaskId(ownId)).toBe(child);
    expect(reg.getSessionByTaskId(childId)).toBeUndefined();
    expect(reg.getChildTasks(epic.taskId!)).toEqual([]);
    expect([...reg.getAllSessions().values()].filter((s) => s.parentTaskId)).toEqual([]);

    // The reservation is still the epic's: the same bind goes through once the save does.
    reg.bindEpicChild(childKey, relation);
    expect(reg.getChildTasks(epic.taskId!)).toEqual([child]);
  });

  it('R5 — load keeps well-formed values on any record; a child is never an epic; only an epic has children', () => {
    const epicId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    const badId = '33333333-3333-4333-8333-333333333333';
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slackRecord('1.1', epicId, { kind: 'epic', childTaskIds: [childId, childId, '', 7] }),
        // A child that also claims to be an epic: the kind is dropped.
        slackRecord('2.2', childId, { kind: 'epic', parentTaskId: epicId, planNodeId: 'node-a' }),
        // Malformed: unknown kind, empty parent, node without parent, children on a non-epic.
        slackRecord('3.3', badId, { kind: 'story', parentTaskId: '', planNodeId: 'x', childTaskIds: [epicId] }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const epic = reg.getSessionByTaskId(epicId)!;
    const child = reg.getSessionByTaskId(childId)!;
    const bad = reg.getSessionByTaskId(badId)!;
    expect(epic.kind).toBe('epic');
    expect(epic.childTaskIds).toEqual([childId]);
    expect(child.kind).toBeUndefined();
    expect(child).toMatchObject({ parentTaskId: epicId, planNodeId: 'node-a' });
    expect(bad.kind).toBeUndefined();
    expect(bad.parentTaskId).toBeUndefined();
    expect(bad.planNodeId).toBeUndefined();
    expect(bad.childTaskIds).toBeUndefined();
    expect(reg.getChildTasks(epicId).map((s) => s.taskId)).toEqual([childId]);
  });

  it('R5b — the sanitizer itself: a node without a parent is dropped; a bad node drops the parent too', () => {
    const child = { parentTaskId: 'p1', planNodeId: 'node-a' };
    expect(sanitizeEpicRelation(child)).toEqual(child);
    expect(sanitizeEpicRelation({ planNodeId: 'node-a' })).toEqual({});
    expect(sanitizeEpicRelation({ parentTaskId: 'p1', planNodeId: 'Bad Node' })).toEqual({});
    expect(sanitizeEpicRelation({ kind: 'epic', planNodeId: 'node-a' })).toEqual({ kind: 'epic' });
    // A task is not its own parent or child; a blank id is no id; a child has no children.
    expect(sanitizeEpicRelation({ taskId: 't1', parentTaskId: 't1', planNodeId: 'node-a' })).toEqual({});
    expect(sanitizeEpicRelation({ parentTaskId: '   ', planNodeId: 'node-a' })).toEqual({});
    expect(sanitizeEpicRelation({ taskId: 't1', kind: 'epic', childTaskIds: ['t1', ' ', 'c1'] })).toEqual({
      kind: 'epic',
      childTaskIds: ['c1'],
    });
    expect(sanitizeEpicRelation({ ...child, childTaskIds: ['c9'] })).toEqual(child);
  });

  it('R6 — archive and revive keep the relation', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    const { key: childKey, childId } = childIn(reg, epic.taskId!);
    reg.terminateSession(childKey);
    const archived = archives().find((a) => a.taskId === childId)!;
    expect(archived).toMatchObject({
      channelId: 'C1',
      threadTs: CHILD_TS,
      parentTaskId: epic.taskId,
      planNodeId: 'login',
    });
    expect(reg.getChildTasks(epic.taskId!)).toEqual([]);
    // The parent still counts the closed child.
    expect(epic.childTaskIds).toEqual([childId]);

    expect(reg.restoreArchivedSession(archived as any, '/work/U1/c1')).toMatchObject({ ok: true });
    const back = reg.getSessionByTaskId(childId)!;
    expect(back).toMatchObject({ threadTs: CHILD_TS, parentTaskId: epic.taskId, planNodeId: 'login' });
    expect(reg.getSessionByKey(childKey)).toBe(back);
    expect(reg.getChildTasks(epic.taskId!)).toEqual([back]);

    // The epic itself: archived and revived, it is still an epic with its list.
    reg.terminateSession(epicKey);
    const epicFile = archives().find((a) => a.taskId === epic.taskId)!;
    expect(epicFile).toMatchObject({ kind: 'epic', childTaskIds: [childId] });
    expect(reg.restoreArchivedSession(epicFile as any, '/work/U1/session_1')).toMatchObject({ ok: true });
    const epicBack = reg.getSessionByTaskId(epic.taskId!)!;
    expect(epicBack).toMatchObject({ kind: 'epic', childTaskIds: [childId] });
    expect(reg.getChildTasks(epicBack.taskId!)).toEqual([back]);
  });

  it('R9 — a record archived on load keeps the relation', () => {
    const epicId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    // Asleep with no sleep start: past the archive age, so load archives them.
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        // Done (E4 ⑦): a tree not done is kept from the load-time archive.
        slackRecord('1.1', epicId, {
          kind: 'epic',
          childTaskIds: [childId],
          state: 'SLEEPING',
          plan: { nodes: [{ id: 'node-a', title: 'A', kind: 'issue' }], done: { by: 'epic', at: 1 } },
        }),
        slackRecord('2.2', childId, { parentTaskId: epicId, planNodeId: 'node-a', state: 'SLEEPING' }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    expect(reg.getSessionByTaskId(epicId)).toBeUndefined();
    expect(reg.getSessionByTaskId(childId)).toBeUndefined();
    expect(archives().find((a) => a.taskId === epicId)).toMatchObject({ kind: 'epic', childTaskIds: [childId] });
    expect(archives().find((a) => a.taskId === childId)).toMatchObject({ parentTaskId: epicId, planNodeId: 'node-a' });
  });

  it('R7 — a session that is neither an epic nor a child saves no relation fields', () => {
    const reg = new SessionRegistry();
    const plain = reg.createSession('U1', 'User', 'C1', PLAIN_TS);
    plain.sessionId = 'sdk-plain';
    reg.saveSessions();
    const saved = savedOf(plain.taskId!)!;
    expect(saved).toBeDefined();
    for (const field of ['kind', 'parentTaskId', 'planNodeId', 'childTaskIds']) {
      expect(field in saved && saved[field] !== undefined, field).toBe(false);
    }
  });
});
