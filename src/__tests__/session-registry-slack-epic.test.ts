/**
 * #854 — an epic and its children are Slack sessions (one kind of work session).
 *
 *   SE1 a Slack session becomes an epic (`makeEpic`), saved strictly; the epic, its plan and
 *       its events come back after a restart.
 *   SE2 a child is reserved on the epic first (its id in `childTaskIds` and on the node's
 *       `spawned`, one strict save), then the new Slack session in its own thread is bound to
 *       it (`bindEpicChild`): the reserved id, the parent, the node — saved; the epic's lookup
 *       finds it, before and after a restart. A reservation no session took is taken back.
 *   SE3 a bind is refused when the epic did not reserve that id, or it is another owner's.
 *   SE4 a child's chain end (`recordSessionChainEnd`) is its last outcome and one pending
 *       event on its epic, in one strict save; the epic's listener hears the epic's own key.
 *   SE5 a wake consumes the events it was started for, and puts them back if it did not happen.
 *   SE6 the plan writer and the sleep exemption work on a Slack epic.
 *   SE7 load keeps a Slack session's relation (no longer a dashboard task's only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-slack-epic-test-${process.pid}`),
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
const readSaved = (): Array<Record<string, any>> => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const PLAN = { nodes: [{ id: 'login', title: '로그인 고치기', kind: 'issue' as const }] };

function epicIn(reg: SessionRegistry, owner = 'U1') {
  const session = reg.createSession(owner, 'User', 'C1', '1700000000.000100');
  const key = reg.getSessionKey('C1', '1700000000.000100');
  reg.makeEpic(key);
  reg.setEpicPlan(session.taskId as string, PLAN, 'epic');
  return { epic: session, key };
}

function childIn(reg: SessionRegistry, epicTaskId: string, ts = '1700000001.000100', owner = 'U1') {
  const childId = reg.reserveEpicChild(epicTaskId, 'login');
  const child = reg.createSession(owner, 'User', 'C1', ts);
  const key = reg.getSessionKey('C1', ts);
  reg.bindEpicChild(key, { taskId: childId, parentTaskId: epicTaskId, planNodeId: 'login' });
  return { child, key, childId };
}

describe('SessionRegistry — epics as Slack sessions (#854)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('SE1 — a Slack session becomes an epic, saved; it comes back after a restart', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    expect(epic.kind).toBe('epic');
    expect(readSaved().find((r) => r.taskId === epic.taskId)).toMatchObject({ kind: 'epic', channelId: 'C1' });
    const after = new SessionRegistry();
    after.loadSessions();
    const back = after.getSessionByTaskId(epic.taskId as string);
    expect(back?.kind).toBe('epic');
    expect(back?.plan?.nodes.map((n) => n.id)).toEqual(['login']);
    // Not a child, not a dashboard task, nothing to make twice.
    expect(() => reg.makeEpic('C9-0')).toThrow(/no session/);
  });

  it('SE2 — reserve then bind: the child carries the reserved id, its epic and node; the lookup survives a restart', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const childId = reg.reserveEpicChild(epic.taskId as string, 'login');
    expect(epic.childTaskIds).toEqual([childId]);
    expect(epic.plan?.nodes[0].spawned).toEqual([childId]);
    expect(readSaved().find((r) => r.taskId === epic.taskId)?.childTaskIds).toEqual([childId]);

    const child = reg.createSession('U1', 'User', 'C1', '1700000001.000100');
    const key = reg.getSessionKey('C1', '1700000001.000100');
    reg.bindEpicChild(key, { taskId: childId, parentTaskId: epic.taskId as string, planNodeId: 'login' });
    expect(child).toMatchObject({ taskId: childId, parentTaskId: epic.taskId, planNodeId: 'login' });
    expect(reg.getSessionByTaskId(childId)).toBe(child);
    expect(reg.getChildTasks(epic.taskId as string)).toEqual([child]);
    expect(readSaved().find((r) => r.taskId === childId)).toMatchObject({
      parentTaskId: epic.taskId,
      planNodeId: 'login',
    });

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getChildTasks(epic.taskId as string).map((c) => c.taskId)).toEqual([childId]);

    // A reservation no session took (its thread could not be made) is taken back.
    const ghost = reg.reserveEpicChild(epic.taskId as string, 'login');
    reg.unreserveEpicChild(epic.taskId as string, ghost);
    expect(epic.childTaskIds).toEqual([childId]);
    expect(epic.plan?.nodes[0].spawned).toEqual([childId]);
  });

  it('SE3 — a bind the epic did not reserve, or another owner’s, is refused and changes nothing', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const stranger = reg.createSession('U1', 'User', 'C1', '1700000002.000100');
    const strangerKey = reg.getSessionKey('C1', '1700000002.000100');
    const before = stranger.taskId;
    expect(() =>
      reg.bindEpicChild(strangerKey, {
        taskId: 'not-reserved',
        parentTaskId: epic.taskId as string,
        planNodeId: 'login',
      }),
    ).toThrow(/not reserved/);
    const reserved = reg.reserveEpicChild(epic.taskId as string, 'login');
    const other = reg.createSession('U2', 'Other', 'C1', '1700000003.000100');
    expect(() =>
      reg.bindEpicChild(reg.getSessionKey('C1', '1700000003.000100'), {
        taskId: reserved,
        parentTaskId: epic.taskId as string,
        planNodeId: 'login',
      }),
    ).toThrow(/owner/);
    expect(stranger.taskId).toBe(before);
    expect(other.parentTaskId).toBeUndefined();
    expect(reg.getChildTasks(epic.taskId as string)).toEqual([]);
  });

  it('SE4 — a child’s chain end is its last outcome and one pending event on its epic; the listener hears the epic key', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    const { child, key, childId } = childIn(reg, epic.taskId as string);
    const heard: string[] = [];
    reg.setEpicEventListener((k) => heard.push(k));
    reg.recordSessionChainEnd(key, { outcome: 'completed', at: 1000 });
    expect(child.lastTurnOutcome).toMatchObject({ outcome: 'completed', at: 1000 });
    expect(epic.epicEvents).toEqual([
      expect.objectContaining({ childTaskId: childId, planNodeId: 'login', outcome: 'completed', state: 'pending' }),
    ]);
    expect(readSaved().find((r) => r.taskId === epic.taskId)?.epicEvents).toHaveLength(1);
    expect(heard).toEqual([epicKey]);
    // A session that is no child records nothing on any epic.
    reg.recordSessionChainEnd(epicKey, { outcome: 'completed', at: 1001 });
    expect(epic.epicEvents).toHaveLength(1);
  });

  it('SE5 — a wake consumes its events, and a wake that did not happen puts them back', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    const { key } = childIn(reg, epic.taskId as string);
    reg.recordSessionChainEnd(key, { outcome: 'failed', at: 1000 });
    const ids = (epic.epicEvents ?? []).map((e) => e.id);
    reg.consumeEpicWake(epicKey, ids, 'wake:1');
    expect(epic.epicEvents?.every((e) => e.state === 'delivered' && e.consumedBy === 'wake:1')).toBe(true);
    reg.releaseEpicWake(epicKey, 'wake:1');
    expect(epic.epicEvents?.every((e) => e.state === 'pending')).toBe(true);
  });

  it('SE8 — a wake the restart cut is delivered again; one its chain finished is not (review #872)', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    const { key } = childIn(reg, epic.taskId as string);
    reg.recordSessionChainEnd(key, { outcome: 'completed', at: 1000 });
    reg.consumeEpicWake(
      epicKey,
      (epic.epicEvents ?? []).map((e) => e.id),
      'wake:1',
    );
    // The process dies after the wake was consumed, before its chain ended.
    const after = new SessionRegistry();
    after.loadSessions();
    const reloaded = after.getSessionByKey(epicKey);
    expect(reloaded?.epicEvents?.map((e) => [e.state, e.consumedBy])).toEqual([['pending', undefined]]);

    // A wake whose chain ended (the epic's chain-settled hook settles it) stays delivered.
    reg.settleEpicWakes(epicKey);
    expect(epic.epicEvents?.map((e) => [e.state, e.consumedBy])).toEqual([['delivered', undefined]]);
    const later = new SessionRegistry();
    later.loadSessions();
    expect(later.getSessionByKey(epicKey)?.epicEvents?.map((e) => e.state)).toEqual(['delivered']);
  });

  it('SE11 — a chain end settles the wakes that ran, never one still being sent (review #872 R2 grok)', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    const { key: a } = childIn(reg, epic.taskId as string);
    reg.recordSessionChainEnd(a, { outcome: 'completed', at: 1000 });
    reg.consumeEpicWake(
      epicKey,
      (epic.epicEvents ?? []).map((e) => e.id),
      'wake:1',
    );
    const { key: b } = childIn(reg, epic.taskId as string, '1700000002.000100');
    reg.recordSessionChainEnd(b, { outcome: 'failed', at: 2000 });
    const second = (epic.epicEvents ?? []).filter((e) => e.state === 'pending').map((e) => e.id);
    reg.consumeEpicWake(epicKey, second, 'wake:2');
    // The epic's chain ends while wake:2 is being sent (not taken yet): wake:1 is done, wake:2 is kept.
    reg.settleEpicWakes(epicKey, 'wake:2');
    expect((epic.epicEvents ?? []).map((e) => e.consumedBy)).toEqual([undefined, 'wake:2']);
    // The process dies before wake:2 is taken: the load delivers its event again.
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByKey(epicKey)?.epicEvents?.map((e) => e.state)).toEqual(['delivered', 'pending']);
  });

  describe('folders (review #872 astra R4/R5)', () => {
    const ROOT = `/tmp/soma-epic-folders-${process.pid}`;
    beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
    afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

    it('SE9 — closing an epic keeps its folder while a live child works inside it', () => {
      const reg = new SessionRegistry();
      const { epic, key: epicKey } = epicIn(reg);
      const { child } = childIn(reg, epic.taskId as string);
      const epicDir = path.join(ROOT, 'session_epic');
      const childDir = path.join(epicDir, 'feature');
      fs.mkdirSync(childDir, { recursive: true });
      fs.writeFileSync(path.join(childDir, 'uncommitted.txt'), 'work');
      epic.sessionWorkingDir = epicDir;
      expect(reg.addSourceWorkingDirByKey(epicKey, epicDir)).toBe(true);
      child.sessionWorkingDir = childDir;
      reg.terminateSession(epicKey);
      expect(fs.existsSync(path.join(childDir, 'uncommitted.txt'))).toBe(true);
    });

    it('SE10 — a child placed in its epic’s folder, revived and closed again, never deletes it', () => {
      const reg = new SessionRegistry();
      const { epic } = epicIn(reg);
      const { child, key } = childIn(reg, epic.taskId as string);
      const dir = path.join(ROOT, 'session_epic', 'feature');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'work');
      child.sessionWorkingDir = dir;
      const archived = { ...child, sessionKey: key, archivedAt: Date.now(), archiveReason: 'terminated' };
      reg.terminateSession(key);
      expect(reg.restoreArchivedSession(archived as any, dir).ok).toBe(true);
      expect(reg.getSessionByKey(key)?.sourceWorkingDirs ?? []).toEqual([]);
      reg.terminateSession(key);
      expect(fs.existsSync(path.join(dir, 'uncommitted.txt'))).toBe(true);
    });
  });

  it('SE6 — the plan writer and the sleep exemption treat a Slack epic as an epic', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    expect(epic.plan?.nodes).toHaveLength(1);
    const { child } = childIn(reg, epic.taskId as string);
    // Not done: neither the epic nor its child is archived while asleep.
    expect((reg as any).epicTreeExempt(epic)).toBe(true);
    expect((reg as any).epicTreeExempt(child)).toBe(true);
  });

  it('SE7 — the relation is kept on any record, not a dashboard task’s only', () => {
    expect(sanitizeEpicRelation({ parentTaskId: 'p1', planNodeId: 'node-a' })).toEqual({
      parentTaskId: 'p1',
      planNodeId: 'node-a',
    });
    expect(sanitizeEpicRelation({ kind: 'epic', childTaskIds: ['c1'] })).toEqual({
      kind: 'epic',
      childTaskIds: ['c1'],
    });
  });
});
