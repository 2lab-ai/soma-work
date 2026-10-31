/**
 * E4 ① — the epic / child relation on Slack-less tasks (.prd/19 D1).
 *
 *   R1 an epic (`kind: 'epic'`) is created by the host and survives a restart.
 *   R2 a child (`parentTaskId` + `planNodeId`) is saved in the same strict save
 *      that appends its id to the parent's `childTaskIds`; the parent → child
 *      lookup is rebuilt on load.
 *   R3 refused before anything is saved: an epic with a parent, a child
 *      without a node, a missing / non-epic / other owner's parent, a bad node id.
 *   R4 a failed save removes the child AND its id from the parent (no ghost id).
 *   R5 load keeps only well-formed values, and only on Slack-less records; a
 *      child cannot be an epic; only an epic has children.
 *   R6 archive and revive keep the relation.
 *   R7 a task that is neither epic nor child saves exactly what it did before.
 *   R8 load re-mints a colliding id: the relation follows the new id, both ways.
 *   R9 a record archived on load keeps the relation.
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
const BASE = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };
type Saved = Record<string, any>;
const readSaved = (): Saved[] => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const savedOf = (taskId: string) => readSaved().find((r) => r.taskId === taskId);

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

describe('SessionRegistry — epic and child tasks (E4 ①)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('R1 — an epic is saved as such and survives a restart', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    expect(epic.kind).toBe('epic');
    expect(savedOf(epic.taskId!)).toMatchObject({ kind: 'epic' });
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(epic.taskId!)?.kind).toBe('epic');
  });

  it('R2 — a child is saved with its parent and node, in the same save that appends it to the parent; the lookup survives a restart', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const child = reg.createTask({
      ...BASE,
      workingDirectory: '/work/U1/c1',
      parentTaskId: epic.taskId,
      planNodeId: 'login-fix',
    });
    expect(child).toMatchObject({ parentTaskId: epic.taskId, planNodeId: 'login-fix' });
    expect(child.kind).toBeUndefined();
    expect(epic.childTaskIds).toEqual([child.taskId]);
    expect(savedOf(epic.taskId!)?.childTaskIds).toEqual([child.taskId]);
    expect(savedOf(child.taskId!)).toMatchObject({ parentTaskId: epic.taskId, planNodeId: 'login-fix' });
    expect(reg.getChildTasks(epic.taskId!)).toEqual([child]);

    const after = new SessionRegistry();
    after.loadSessions();
    const back = after.getChildTasks(epic.taskId!);
    expect(back.map((s) => s.taskId)).toEqual([child.taskId]);
    expect(after.getSessionByTaskId(epic.taskId!)?.childTaskIds).toEqual([child.taskId]);
  });

  it('R3 — refused before anything is saved', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const plain = reg.createTask({ ...BASE });
    const other = reg.createTask({ ...BASE, ownerId: 'U2', kind: 'epic' });
    const before = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['an epic cannot have a parent', { kind: 'epic', parentTaskId: epic.taskId, planNodeId: 'a' }],
      ['a child needs a node', { parentTaskId: epic.taskId }],
      ['a node needs a parent', { planNodeId: 'a' }],
      ['the parent must exist', { parentTaskId: '99999999-9999-4999-8999-999999999999', planNodeId: 'a' }],
      ['the parent must be an epic', { parentTaskId: plain.taskId, planNodeId: 'a' }],
      ["the parent must be the owner's", { parentTaskId: other.taskId, planNodeId: 'a' }],
      ['the node id is a short slug', { parentTaskId: epic.taskId, planNodeId: 'Has Spaces!' }],
      ['only epic is a kind', { kind: 'story' }],
    ];
    for (const [label, extra] of attempts) {
      expect(() => reg.createTask({ ...BASE, ...(extra as any) }), label).toThrow();
    }
    // A closing epic (flagged while its close is awaited) takes no new child.
    epic.terminated = true;
    expect(() => reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'a' })).toThrow(/not a live epic/);
    epic.terminated = undefined;
    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).toBe(before);
    expect(epic.childTaskIds ?? []).toEqual([]);
  });

  it('R4 — a failed save removes the child and its id from the parent', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'a' })).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.childTaskIds ?? []).toEqual([]);
    expect(reg.getChildTasks(epic.taskId!)).toEqual([]);
    expect([...reg.getAllSessions().values()].filter((s) => s.parentTaskId)).toEqual([]);
  });

  it('R5 — load keeps well-formed values on Slack-less records only; a child is never an epic; only an epic has children', () => {
    const epicId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    const badId = '33333333-3333-4333-8333-333333333333';
    const plainId = '44444444-4444-4444-8444-444444444444';
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord(epicId, { kind: 'epic', childTaskIds: [childId, childId, '', 7] }),
        // A child that also claims to be an epic: the kind is dropped.
        slacklessRecord(childId, { kind: 'epic', parentTaskId: epicId, planNodeId: 'node-a' }),
        // Malformed: unknown kind, empty parent, node without parent, children on a non-epic.
        slacklessRecord(badId, { kind: 'story', parentTaskId: '', planNodeId: 'x', childTaskIds: [epicId] }),
        // A Slack session never carries the relation.
        {
          key: 'work:C1:1.1',
          ownerId: 'U1',
          userId: 'U1',
          channelId: 'C1',
          threadTs: '1.1',
          taskId: plainId,
          isActive: true,
          lastActivity: new Date().toISOString(),
          state: 'MAIN',
          activityState: 'idle',
          kind: 'epic',
          parentTaskId: epicId,
          planNodeId: 'node-b',
        },
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const epic = reg.getSessionByTaskId(epicId)!;
    const child = reg.getSessionByTaskId(childId)!;
    const bad = reg.getSessionByTaskId(badId)!;
    const slack = reg.getSessionByTaskId(plainId)!;
    expect(epic.kind).toBe('epic');
    expect(epic.childTaskIds).toEqual([childId]);
    expect(child.kind).toBeUndefined();
    expect(child).toMatchObject({ parentTaskId: epicId, planNodeId: 'node-a' });
    expect(bad.kind).toBeUndefined();
    expect(bad.parentTaskId).toBeUndefined();
    expect(bad.planNodeId).toBeUndefined();
    expect(bad.childTaskIds).toBeUndefined();
    expect(slack.kind).toBeUndefined();
    expect(slack.parentTaskId).toBeUndefined();
    expect(reg.getChildTasks(epicId).map((s) => s.taskId)).toEqual([childId]);
  });

  it('R5b — the sanitizer itself: nothing on a Slack session; a node without a parent is dropped; a bad node drops the parent too', () => {
    const child = { parentTaskId: 'p1', planNodeId: 'node-a' };
    expect(sanitizeEpicRelation(child, false)).toEqual({});
    expect(sanitizeEpicRelation({ kind: 'epic', childTaskIds: ['c1'] }, false)).toEqual({});
    expect(sanitizeEpicRelation(child, true)).toEqual(child);
    expect(sanitizeEpicRelation({ planNodeId: 'node-a' }, true)).toEqual({});
    expect(sanitizeEpicRelation({ parentTaskId: 'p1', planNodeId: 'Bad Node' }, true)).toEqual({});
    expect(sanitizeEpicRelation({ kind: 'epic', planNodeId: 'node-a' }, true)).toEqual({ kind: 'epic' });
    // A task is not its own parent or child; a blank id is no id; a child has no children.
    expect(sanitizeEpicRelation({ taskId: 't1', parentTaskId: 't1', planNodeId: 'node-a' }, true)).toEqual({});
    expect(sanitizeEpicRelation({ parentTaskId: '   ', planNodeId: 'node-a' }, true)).toEqual({});
    expect(sanitizeEpicRelation({ taskId: 't1', kind: 'epic', childTaskIds: ['t1', ' ', 'c1'] }, true)).toEqual({
      kind: 'epic',
      childTaskIds: ['c1'],
    });
    expect(sanitizeEpicRelation({ ...child, childTaskIds: ['c9'] }, true)).toEqual(child);
  });

  it('R6 — archive and revive keep the relation', () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const child = reg.createTask({
      ...BASE,
      workingDirectory: '/work/U1/c1',
      parentTaskId: epic.taskId,
      planNodeId: 'a',
    });
    reg.terminateSession(`task:${child.taskId}`);
    const dir = path.join(TEST_DATA_DIR, 'archives');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!;
    const archived = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    expect(archived).toMatchObject({ parentTaskId: epic.taskId, planNodeId: 'a' });
    expect(reg.getChildTasks(epic.taskId!)).toEqual([]);
    // The parent still counts the closed child.
    expect(epic.childTaskIds).toEqual([child.taskId]);

    const outcome = reg.restoreArchivedSession(archived, '/work/U1/c1');
    expect(outcome).toMatchObject({ ok: true });
    const back = reg.getSessionByTaskId(child.taskId!)!;
    expect(back).toMatchObject({ parentTaskId: epic.taskId, planNodeId: 'a' });
    expect(reg.getChildTasks(epic.taskId!)).toEqual([back]);

    // The epic itself: archived and revived, it is still an epic with its list.
    reg.terminateSession(`task:${epic.taskId}`);
    const epicFile = fs
      .readdirSync(dir)
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .find((a) => a.taskId === epic.taskId);
    expect(epicFile).toMatchObject({ kind: 'epic', childTaskIds: [child.taskId] });
    expect(reg.restoreArchivedSession(epicFile, BASE.workingDirectory)).toMatchObject({ ok: true });
    const epicBack = reg.getSessionByTaskId(epic.taskId!)!;
    expect(epicBack).toMatchObject({ kind: 'epic', childTaskIds: [child.taskId] });
    expect(reg.getChildTasks(epicBack.taskId!)).toEqual([back]);
  });

  it('R8 — load re-mints an id a Slack session holds: the relation follows the new id, both ways', () => {
    const epicId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    const otherId = '33333333-3333-4333-8333-333333333333';
    const slack = (ts: string, taskId: string) => ({
      key: `work:C1:${ts}`,
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: ts,
      taskId,
      isActive: true,
      lastActivity: new Date().toISOString(),
      state: 'MAIN',
      activityState: 'idle',
    });
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        // Slack sessions earlier in the file hold the epic's and the first child's ids.
        slack('1.1', epicId),
        slack('2.2', childId),
        slacklessRecord(childId, { parentTaskId: epicId, planNodeId: 'node-a' }),
        slacklessRecord(epicId, { kind: 'epic', childTaskIds: [childId, otherId] }),
        slacklessRecord(otherId, { parentTaskId: epicId, planNodeId: 'node-b' }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const epic = [...reg.getAllSessions().values()].find((s) => s.kind === 'epic')!;
    const child = [...reg.getAllSessions().values()].find((s) => s.planNodeId === 'node-a')!;
    const other = reg.getSessionByTaskId(otherId)!;
    expect(epic.taskId).not.toBe(epicId);
    expect(child.taskId).not.toBe(childId);
    expect(child.parentTaskId).toBe(epic.taskId);
    expect(other.parentTaskId).toBe(epic.taskId);
    expect(epic.childTaskIds).toEqual([child.taskId, otherId]);
    expect(
      reg
        .getChildTasks(epic.taskId!)
        .map((s) => s.taskId)
        .sort(),
    ).toEqual([child.taskId, otherId].sort());
    expect(reg.getChildTasks(epicId)).toEqual([]);
    // The write-back saved it: the next restart finds the same links.
    expect(savedOf(epic.taskId!)?.childTaskIds).toEqual([child.taskId, otherId]);
    expect(savedOf(child.taskId!)?.parentTaskId).toBe(epic.taskId);
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(epic.taskId!)?.childTaskIds).toEqual([child.taskId, otherId]);
    expect(after.getChildTasks(epic.taskId!).length).toBe(2);
  });

  it('R9 — a record archived on load keeps the relation', () => {
    const epicId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    // Asleep with no sleep start: past the archive age, so load archives them.
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        slacklessRecord(epicId, { kind: 'epic', childTaskIds: [childId], state: 'SLEEPING' }),
        slacklessRecord(childId, { parentTaskId: epicId, planNodeId: 'node-a', state: 'SLEEPING' }),
      ]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    expect(reg.getSessionByTaskId(epicId)).toBeUndefined();
    const dir = path.join(TEST_DATA_DIR, 'archives');
    const archives = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(archives.find((a) => a.taskId === epicId)).toMatchObject({ kind: 'epic', childTaskIds: [childId] });
    expect(archives.find((a) => a.taskId === childId)).toMatchObject({ parentTaskId: epicId, planNodeId: 'node-a' });
  });

  it('R7 — a task that is neither an epic nor a child saves no relation fields', () => {
    const reg = new SessionRegistry();
    const plain = reg.createTask({ ...BASE });
    const saved = savedOf(plain.taskId!)!;
    for (const field of ['kind', 'parentTaskId', 'planNodeId', 'childTaskIds']) {
      expect(field in saved && saved[field] !== undefined, field).toBe(false);
    }
  });
});
