/**
 * E4 ⑦ — an epic tree's lifecycle on the registry (.prd/19 D10), on Slack sessions (#854/#855:
 * an epic and its children are Slack threads; the dashboard-task stack is gone).
 *
 *   L1 the sweep: an epic not done (or with a child running or waiting) and its
 *      children sleep but are not archived; after done, the normal clock. A terminated
 *      or closing epic no longer shelters its children.
 *   L2 the load: the same, decided over the whole file (a child may come first).
 *   L3 `markClosedByParent`: saved strictly, put back on a failed save; it
 *      survives a restart and the archive. A bad `closedBy` on load is dropped.
 *   L4 `recordEpicChildClosed`: a delivered `closed` event on the epic, saved
 *      strictly; no live epic, nothing.
 *   L5 the in-memory closing mark (fable #703 R1): an epic being closed takes no
 *      chain end; a child being closed records its end delivered; never saved.
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
const LONG_AGO = () => new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
const readSaved = (): Array<Record<string, any>> => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const archived = () =>
  fs
    .readdirSync(path.join(TEST_DATA_DIR, 'archives'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'archives', f), 'utf8')));

const PLAN = { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' as const }] };

let seq = 0;
const nextTs = () => `1700000${String(++seq).padStart(3, '0')}.000100`;

function epicIn(reg: SessionRegistry) {
  const ts = nextTs();
  const epic = reg.createSession('U1', 'User', 'C1', ts);
  const key = reg.getSessionKey('C1', ts);
  reg.makeEpic(key);
  reg.setEpicPlan(epic.taskId as string, PLAN, 'epic');
  return { epic, key };
}

function childIn(reg: SessionRegistry, epicTaskId: string) {
  const ts = nextTs();
  const childId = reg.reserveEpicChild(epicTaskId, 'login');
  const child = reg.createSession('U1', 'User', 'C1', ts);
  const key = reg.getSessionKey('C1', ts);
  reg.bindEpicChild(key, { taskId: childId, parentTaskId: epicTaskId, planNodeId: 'login' });
  return { child, key };
}

function plainIn(reg: SessionRegistry) {
  const ts = nextTs();
  const plain = reg.createSession('U1', 'User', 'C1', ts);
  return { plain, key: reg.getSessionKey('C1', ts) };
}

describe('SessionRegistry — an epic tree’s lifecycle on Slack sessions (E4 ⑦, #855)', () => {
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
    const { epic, key: epicKey } = epicIn(reg);
    const { child } = childIn(reg, epic.taskId as string);
    const { plain } = plainIn(reg);
    for (const s of [epic, child, plain]) {
      s.state = 'SLEEPING';
      s.sleepStartedAt = LONG_AGO();
    }
    return { epic, epicKey, child, plain };
  }

  it('L1 — the sweep keeps a tree not done; a done tree with no child at work follows the clock', async () => {
    const reg = new SessionRegistry();
    const { epic, child, plain } = sleepingTree(reg);
    await reg.cleanupInactiveSessions();
    expect(reg.getSessionByTaskId(epic.taskId as string)).toBeDefined();
    expect(reg.getSessionByTaskId(child.taskId as string)).toBeDefined();
    expect(reg.getSessionByTaskId(plain.taskId as string)).toBeUndefined();

    // Done, but a child still waits: kept.
    reg.setEpicPlan(epic.taskId as string, { ...PLAN, done: true }, 'owner');
    child.activityState = 'waiting';
    await reg.cleanupInactiveSessions();
    expect(reg.getSessionByTaskId(epic.taskId as string)).toBeDefined();
    expect(reg.getSessionByTaskId(child.taskId as string)).toBeDefined();

    // Done and nothing at work: the whole tree follows the normal clock.
    child.activityState = 'idle';
    await reg.cleanupInactiveSessions();
    expect(reg.getSessionByTaskId(epic.taskId as string)).toBeUndefined();
    expect(reg.getSessionByTaskId(child.taskId as string)).toBeUndefined();
  });

  it.each([
    ['terminated', (_reg: SessionRegistry, epic: any) => void (epic.terminated = true)],
    [
      'being closed (the in-memory mark)',
      (reg: SessionRegistry, _epic: any, key: string) => reg.markClosing(key, true),
    ],
  ])('L1 — an epic %s no longer shelters its children', async (_name, close) => {
    const reg = new SessionRegistry();
    const { epic, epicKey, child } = sleepingTree(reg);
    close(reg, epic, epicKey);
    await reg.cleanupInactiveSessions();
    expect(reg.getSessionByTaskId(child.taskId as string)).toBeUndefined();
  });

  it('L2 — the load keeps a tree not done (a child first in the file), and archives a done one', () => {
    const reg = new SessionRegistry();
    const open = epicIn(reg);
    const openChild = childIn(reg, open.epic.taskId as string);
    const done = epicIn(reg);
    const doneChild = childIn(reg, done.epic.taskId as string);
    reg.setEpicPlan(done.epic.taskId as string, { ...PLAN, done: true }, 'owner');
    reg.saveSessions();
    const asleep = { state: 'SLEEPING', sleepStartedAt: LONG_AGO().toISOString() };
    const records = readSaved().map((r): Record<string, any> => ({ ...r, ...asleep }));
    // A child first in the file: the tree is decided over the whole file.
    records.sort((a, b) => (a.parentTaskId ? -1 : 0) - (b.parentTaskId ? -1 : 0));
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(records));

    const after = new SessionRegistry();
    after.loadSessions();
    for (const s of [open.epic, openChild.child]) expect(after.getSessionByTaskId(s.taskId as string)).toBeDefined();
    for (const s of [done.epic, doneChild.child]) {
      expect(after.getSessionByTaskId(s.taskId as string)).toBeUndefined();
    }
    expect(
      archived()
        .map((a) => a.taskId)
        .sort(),
    ).toEqual([done.epic.taskId, doneChild.child.taskId].sort());
  });

  it('L3 — closedBy: parent is saved now, put back on a failed save, and carried through restart and archive', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    const { child, key } = childIn(reg, epic.taskId as string);

    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.markClosedByParent(key, 7)).toThrow('ENOSPC');
    save.mockRestore();
    expect(child.closedBy).toBeUndefined();

    reg.markClosedByParent(key, 7);
    expect(child.closedBy).toEqual({ by: 'parent', at: 7 });
    expect(readSaved().find((r) => r.taskId === child.taskId)?.closedBy).toEqual({ by: 'parent', at: 7 });
    expect(() => reg.markClosedByParent(epicKey)).toThrow(/not a child/);

    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(child.taskId as string)?.closedBy).toEqual({ by: 'parent', at: 7 });

    after.terminateSession(key);
    expect(archived().find((a) => a.taskId === child.taskId)?.closedBy).toEqual({ by: 'parent', at: 7 });
  });

  it('L3 — a bad closedBy on load is dropped; an epic never carries one', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const c1 = childIn(reg, epic.taskId as string);
    const c2 = childIn(reg, epic.taskId as string);
    reg.saveSessions();
    const records = readSaved().map((r) =>
      r.taskId === epic.taskId
        ? { ...r, closedBy: { by: 'parent', at: 1 } }
        : r.taskId === c1.child.taskId
          ? { ...r, closedBy: { by: 'owner', at: 1 } }
          : r.taskId === c2.child.taskId
            ? { ...r, closedBy: { by: 'parent', at: 'x' } }
            : r,
    );
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(records));
    const after = new SessionRegistry();
    after.loadSessions();
    for (const s of [epic, c1.child, c2.child]) {
      expect(after.getSessionByTaskId(s.taskId as string)?.closedBy, s.taskId).toBeUndefined();
    }
  });

  it('L4 — a child’s close is a delivered closed event on its epic, saved strictly; no live epic, nothing', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const { child, key } = childIn(reg, epic.taskId as string);

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
    const other = plainIn(reg);
    expect(() => reg.recordEpicChildClosed(other.key)).not.toThrow();
  });

  it('L5 — the closing mark: an epic being closed takes no chain end; a child being closed owes no wake; never saved', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    const c1 = childIn(reg, epic.taskId as string);
    const c2 = childIn(reg, epic.taskId as string);

    // The child being closed: its end is recorded, delivered.
    reg.markClosing(c1.key, true);
    reg.recordSessionChainEnd(c1.key, { outcome: 'cancelled', at: 1 });
    expect(epic.epicEvents?.map((e) => [e.childTaskId, e.state])).toEqual([[c1.child.taskId, 'delivered']]);
    expect(readSaved().some((r) => 'closing' in r)).toBe(false);

    // The epic being closed: a child's end is dropped.
    reg.markClosing(epicKey, true);
    reg.recordSessionChainEnd(c2.key, { outcome: 'cancelled', at: 2 });
    expect(epic.epicEvents).toHaveLength(1);
    expect(readSaved().some((r) => 'closing' in r)).toBe(false);

    // Cleared (the close did not go through): the epic takes events again.
    reg.markClosing(epicKey, false);
    expect(epic.closing).toBeUndefined();
    reg.recordSessionChainEnd(c2.key, { outcome: 'cancelled', at: 3 });
    expect(epic.epicEvents?.find((e) => e.childTaskId === c2.child.taskId)?.state).toBe('pending');
  });

  it('L8 — a closing epic’s dropped event is logged at info; a gone epic’s at warn (fable #703 R2 P3-2)', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    const { key } = childIn(reg, epic.taskId as string);
    const info = vi.spyOn((reg as any).logger, 'info');
    const warn = vi.spyOn((reg as any).logger, 'warn');
    const dropped = (spy: typeof info) => spy.mock.calls.filter(([m]) => String(m).startsWith('Epic event dropped'));

    reg.markClosing(epicKey, true);
    reg.recordSessionChainEnd(key, { outcome: 'cancelled', at: 1 });
    expect(dropped(info).map(([m]) => m)).toEqual(['Epic event dropped — the epic is closing']);
    expect(dropped(warn)).toEqual([]);

    info.mockClear();
    epic.terminated = true;
    reg.recordSessionChainEnd(key, { outcome: 'cancelled', at: 2 });
    expect(dropped(warn).map(([m]) => m)).toEqual(['Epic event dropped — the epic is gone']);
    expect(dropped(info)).toEqual([]);

    // Absent altogether (archived): gone, at warn — even if its last mark was closing (fable #709 R1 P3-5).
    warn.mockClear();
    epic.terminated = false;
    (reg as any).sessionsByTaskId.delete(epic.taskId);
    reg.recordSessionChainEnd(key, { outcome: 'cancelled', at: 3 });
    expect(dropped(warn).map(([m]) => m)).toEqual(['Epic event dropped — the epic is gone']);
    expect(dropped(info)).toEqual([]);
  });

  it('L9 — a closing epic takes no new plan; cleared, it does (fable #703 R2 P3-3)', () => {
    const reg = new SessionRegistry();
    const { epic, key: epicKey } = epicIn(reg);
    reg.markClosing(epicKey, true);
    expect(() => reg.setEpicPlan(epic.taskId as string, { nodes: [] } as any, 'owner')).toThrow('is not a live epic');
    reg.markClosing(epicKey, false);
    expect(reg.setEpicPlan(epic.taskId as string, PLAN, 'owner').nodes.map((n) => n.id)).toEqual(['login']);
  });
});
