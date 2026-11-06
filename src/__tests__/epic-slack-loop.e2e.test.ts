/**
 * #854 — the epic loop end to end on the Slack path: an epic and its children are Slack sessions.
 *
 * Real registry, epic tools (the `epic` server's own handlers), Slack epic host, tree gate and
 * waker, wired as index.ts does. Only the Slack pipeline is a fake: a message into a thread makes
 * its session (a new thread) or reaches the running one's queue, runs a turn, and at the chain's
 * end does what `drainFollowups`' listener does (a child reports its end; an epic may wake). The
 * epic's "model" is a fixed script: plan_write → spawn_child per node → end the turn → on each
 * wake child_status → accept the finished nodes → done.
 *
 *   L1 one epic, three nodes → three children, each in its own thread in the epic's channel →
 *      their ends wake the epic → all accepted → done; no refused start, no duplicate child.
 *   L2 the epic's word to a working child is queued in the child's thread (never refused as busy),
 *      runs right after the turn in flight, and the child reports one end for the whole chain.
 *   L3 a restart while ends wait: the tree, the plan and the pending events come back from disk,
 *      and the boot scan wakes the epic once.
 *   L4 (#1020) the owner's existing tasks are adopted: find_tasks finds them, a node per task, then
 *      adopt_child each — nothing runs in their threads; an adopted task's next chain end wakes the
 *      epic, which accepts its node; instruct_child reaches the other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-slack-loop-${process.pid}`),
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
import { isEpicDone } from '../task-turn/epic-plan';
import { type EpicExecutionContext, epicTools, setEpicHost } from '../task-turn/epic-server';
import { createSlackEpicHost, createSlackEpicWaker } from '../task-turn/epic-slack';
import { createEpicTreeGate } from '../task-turn/epic-tree-gate';
import type { ConversationSession } from '../types';

const OWNER = 'U1';
const CHANNEL = 'C1';
const EPIC_TS = '1700000000.000100';
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const parse = (r: any) => JSON.parse(r.content[0].text);

/** A Slack world: threads, their running turns and queues, and the epic's scripted model. */
function slackWorld(reg: SessionRegistry) {
  let ts = 1700000100;
  const turns: Array<{ key: string; text: string }> = [];
  const running = new Set<string>();
  const queues = new Map<string, string[]>();
  const watchers = new Map<string, () => void>();
  /** A child's turn waits on this while it is set (L2). */
  const holds = new Map<string, Promise<void>>();
  const keyOf = (s: ConversationSession) => reg.getSessionKey(s.channelId, s.threadTs);
  const epicSession = () => reg.getSessionByKey(reg.getSessionKey(CHANNEL, EPIC_TS)) as ConversationSession;
  const tools = () =>
    epicTools({ origin: 'slack', userId: OWNER, epicTaskId: epicSession().taskId } as unknown as EpicExecutionContext);

  async function epicModel(text: string) {
    const [planWrite, childStatus, spawn] = tools();
    if (!text.startsWith('Epic wake')) {
      const nodes = [
        { id: 'login', title: 'Fix login', kind: 'issue' },
        { id: 'docs', title: 'Docs', kind: 'issue' },
        { id: 'tests', title: 'Tests', kind: 'issue' },
      ];
      expect(parse(await planWrite.handler({ nodes } as any, {})).ok).toBe(true);
      for (const n of nodes) {
        const made = parse(await spawn.handler({ planNodeId: n.id, instruction: `${n.title} 해줘` } as any, {}));
        expect(made).toMatchObject({ ok: true, made: true, started: true });
      }
      return;
    }
    const tree = parse(await childStatus.handler({} as any, {}));
    const finished = new Set(tree.nodes.filter((n: any) => n.status === 'finished').map((n: any) => n.id));
    const nodes = tree.nodes.map((n: any) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      ...(finished.has(n.id) || n.accepted ? { accepted: true } : {}),
    }));
    expect(parse(await planWrite.handler({ nodes } as any, {})).ok).toBe(true);
  }

  /** One chain: the turn, then every queued message after it, then the chain-settled listener. */
  async function runChain(key: string, text: string) {
    running.add(key);
    let next: string | undefined = text;
    while (next !== undefined) {
      turns.push({ key, text: next });
      const s = reg.getSessionByKey(key) as ConversationSession;
      if (s.kind === 'epic') await epicModel(next);
      else await holds.get(key);
      next = queues.get(key)?.shift();
    }
    running.delete(key);
    const s = reg.getSessionByKey(key) as ConversationSession;
    if (s.parentTaskId) reg.recordSessionChainEnd(key, { outcome: 'completed' });
    if (s.kind === 'epic') waker.wake(key);
  }

  /** A message into a thread: a new thread makes its session; a busy one queues it. */
  async function deliver(key: string, text: string, accepted: () => void) {
    if (running.has(key)) {
      (queues.get(key) ?? queues.set(key, []).get(key))?.push(text);
      accepted();
      return;
    }
    accepted();
    await runChain(key, text);
  }

  const gate = createEpicTreeGate({
    getChildTasks: (id) => reg.getChildTasks(id),
    isRunning: (s) => running.has(keyOf(s)),
    treeCostUsd: () => 0,
    costLimitUsd: () => 50,
  });
  setEpicHost(
    createSlackEpicHost({
      getSessionByTaskId: (id) => reg.getSessionByTaskId(id),
      getChildTasks: (id) => reg.getChildTasks(id),
      getAllSessions: () => reg.getAllSessions(),
      adoptEpicChild: (epicId, childId, node) => reg.adoptEpicChild(epicId, childId, node),
      timezone: 'Asia/Seoul',
      setEpicPlan: (id, input, by) => reg.setEpicPlan(id, input, by),
      reserveEpicChild: (id, node) => reg.reserveEpicChild(id, node),
      unreserveEpicChild: (id, child) => reg.unreserveEpicChild(id, child),
      keyOf,
      postMessage: async () => ({ ts: `${++ts}.000000` }),
      handleMessage: async (event: any) => {
        const key = reg.getSessionKey(event.channel, event.thread_ts);
        if (!reg.getSessionByKey(key)) {
          reg.createSession(event.user, 'Owner', event.channel, event.thread_ts);
          if (event.epicChild) reg.bindEpicChild(key, event.epicChild);
        }
        await deliver(key, event.text, () => watchers.get(`${event.channel}:${event.ts}`)?.());
      },
      onTurnAccepted: (channel, t, cb) => {
        watchers.set(`${channel}:${t}`, cb);
        return () => watchers.delete(`${channel}:${t}`);
      },
      sendToThread: (key, text, opts) => deliver(key, text, opts.onAccepted),
      isRunning: (key) => running.has(key),
      readWorkLog: async () => ({ entries: [], hasMore: false }),
      gate,
      ensureDirectory: () => undefined,
      logger: { info: () => {}, warn: () => {} },
    }),
  );
  const waker = createSlackEpicWaker({
    getSession: (key) => reg.getSessionByKey(key),
    isBusy: (key) => running.has(key) || (queues.get(key)?.length ?? 0) > 0,
    gate,
    consume: (key, ids, by) => reg.consumeEpicWake(key, ids, by),
    release: (key, by) => reg.releaseEpicWake(key, by),
    send: (key, text, opts) => deliver(key, text, opts.onAccepted),
    logger: { info: () => {}, warn: () => {} },
  });
  reg.setEpicEventListener((key) => waker.wake(key));

  /** The dashboard's new task with the epic switch: a thread, made an epic, its first instruction. */
  async function startEpic(text = '로그인 전부 고쳐') {
    reg.createSession(OWNER, 'Owner', CHANNEL, EPIC_TS);
    reg.makeEpic(reg.getSessionKey(CHANNEL, EPIC_TS));
    await runChain(reg.getSessionKey(CHANNEL, EPIC_TS), text);
  }

  return { turns, running, queues, holds, epicSession, tools, startEpic, waker, runChain, keyOf };
}

describe('the epic loop on the Slack path (#854)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    setEpicHost(undefined);
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('L1 — three nodes, three children in their own threads, their ends wake the epic, all accepted, done', async () => {
    const reg = new SessionRegistry();
    const w = slackWorld(reg);
    await w.startEpic();
    await settle();
    const epic = w.epicSession();
    const children = reg.getChildTasks(epic.taskId as string);
    expect(children.map((c) => c.planNodeId).sort()).toEqual(['docs', 'login', 'tests']);
    // Each child is its own Slack thread in the epic's channel, its epic owner's.
    for (const c of children) {
      expect(c.channelId).toBe(CHANNEL);
      expect(c.threadTs).not.toBe(EPIC_TS);
      expect(c.ownerId).toBe(OWNER);
    }
    expect(new Set(children.map((c) => c.threadTs)).size).toBe(3);
    expect(isEpicDone(epic.plan)).toBe(true);
    // Every end was delivered; the epic woke with them (one wake or more, never a turn with nothing to read).
    expect(epic.epicEvents?.every((e) => e.state === 'delivered')).toBe(true);
    const epicKey = reg.getSessionKey(CHANNEL, EPIC_TS);
    const wakes = w.turns.filter((t) => t.key === epicKey && t.text.startsWith('Epic wake'));
    expect(wakes.length).toBeGreaterThan(0);
    expect(epic.childTaskIds).toHaveLength(3);
  });

  it('L2 — the epic’s word to a working child is queued in its thread, runs after the turn in flight, one end reported', async () => {
    const reg = new SessionRegistry();
    const w = slackWorld(reg);
    // The first child's turn waits until released.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const origDeliver = w.holds;
    reg.createSession(OWNER, 'Owner', CHANNEL, EPIC_TS);
    reg.makeEpic(reg.getSessionKey(CHANNEL, EPIC_TS));
    const epic = w.epicSession();
    const [planWrite, , spawn, instruct] = w.tools();
    await planWrite.handler({ nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] } as any, {});
    // Hold every child turn: the hold is looked up by key when the turn runs.
    const realGet = origDeliver.get.bind(origDeliver);
    origDeliver.get = (() => held) as any;
    const made = parse(await spawn.handler({ planNodeId: 'login', instruction: '로그인 고쳐' } as any, {}));
    expect(made).toMatchObject({ ok: true, made: true, started: true });
    const child = reg.getSessionByTaskId(made.childId) as ConversationSession;
    const childKey = w.keyOf(child);
    expect(w.running.has(childKey)).toBe(true);

    const queued = parse(await instruct.handler({ childId: made.childId, instruction: '테스트도 추가해' } as any, {}));
    expect(queued).toEqual({ ok: true, childId: made.childId, started: false, queued: true });
    expect(w.queues.get(childKey)).toEqual(['테스트도 추가해']);

    origDeliver.get = realGet as any;
    release();
    await settle();
    expect(w.turns.filter((t) => t.key === childKey).map((t) => t.text)).toEqual(['로그인 고쳐', '테스트도 추가해']);
    // One chain, one end on the epic.
    expect(epic.epicEvents?.filter((e) => e.childTaskId === made.childId)).toHaveLength(1);
  });

  it('L3 — a restart while ends wait: the tree, plan and pending events come back; the boot scan wakes the epic once', async () => {
    const reg = new SessionRegistry();
    const w = slackWorld(reg);
    reg.createSession(OWNER, 'Owner', CHANNEL, EPIC_TS);
    const epicKey = reg.getSessionKey(CHANNEL, EPIC_TS);
    reg.makeEpic(epicKey);
    const epic = w.epicSession();
    const [planWrite, , spawn] = w.tools();
    await planWrite.handler({ nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] } as any, {});
    // The epic is busy: the child's end waits for it.
    w.running.add(epicKey);
    const made = parse(await spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {}));
    await settle();
    expect(epic.epicEvents?.map((e) => e.state)).toEqual(['pending']);
    // A restart: everything a fresh process reads is on disk.
    const after = new SessionRegistry();
    after.loadSessions();
    const back = after.getSessionByKey(epicKey) as ConversationSession;
    expect(back.kind).toBe('epic');
    expect(back.plan?.nodes.map((n) => n.id)).toEqual(['login']);
    expect(back.epicEvents?.map((e) => e.state)).toEqual(['pending']);
    expect(after.getChildTasks(back.taskId as string).map((c) => c.taskId)).toEqual([made.childId]);
    // The boot scan (index.ts): a live Slack epic with pending ends wakes once.
    setEpicHost(undefined);
    const w2 = slackWorld(after);
    for (const [key, s] of after.getAllSessions()) if (s.kind === 'epic' && !s.parentTaskId) w2.waker.wake(key);
    await settle();
    expect(w2.turns.filter((t) => t.key === epicKey && t.text.startsWith('Epic wake'))).toHaveLength(1);
    expect(isEpicDone((after.getSessionByKey(epicKey) as ConversationSession).plan)).toBe(true);
  });

  it('L4 — the owner’s existing tasks are adopted: found, a node each, adopted; their ends wake the epic', async () => {
    const reg = new SessionRegistry();
    const w = slackWorld(reg);
    // The owner's tasks of today, in a channel of their own, and someone else's.
    const pay = reg.createSession(OWNER, 'Owner', 'C9', '1700000500.000100');
    pay.title = '결제 버그 고치기';
    const docs = reg.createSession(OWNER, 'Owner', 'C9', '1700000501.000100');
    docs.title = '결제 문서 정리';
    reg.createSession('U2', 'Other', 'C9', '1700000502.000100').title = '결제 남의 일';
    reg.createSession(OWNER, 'Owner', CHANNEL, EPIC_TS);
    const epicKey = reg.getSessionKey(CHANNEL, EPIC_TS);
    reg.makeEpic(epicKey);
    const epic = w.epicSession();
    const [planWrite, childStatus, , instruct, findTasks, adoptChild] = w.tools();

    const found = parse(await findTasks.handler({ query: '결제', day: 'today' } as any, {}));
    expect(found.ok).toBe(true);
    expect(found.room).toBe(7);
    expect(found.tasks.map((t: any) => t.taskId).sort()).toEqual([pay.taskId, docs.taskId].sort());
    expect(found.tasks.every((t: any) => t.adoptable)).toBe(true);

    const nodes = found.tasks.map((t: any, i: number) => ({ id: `task-${i + 1}`, title: t.title, kind: 'issue' }));
    expect(parse(await planWrite.handler({ nodes } as any, {})).ok).toBe(true);
    for (const [i, t] of found.tasks.entries()) {
      const adopted = parse(await adoptChild.handler({ taskId: t.taskId, planNodeId: `task-${i + 1}` } as any, {}));
      expect(adopted).toMatchObject({ ok: true, adopted: true, childId: t.taskId });
    }
    // Adopting starts nothing: no turn in their threads, their ids kept.
    const payKey = w.keyOf(pay);
    const docsKey = w.keyOf(docs);
    expect(w.turns.filter((t) => t.key === payKey || t.key === docsKey)).toEqual([]);
    expect(
      reg
        .getChildTasks(epic.taskId as string)
        .map((c) => c.taskId)
        .sort(),
    ).toEqual([pay.taskId, docs.taskId].sort());
    expect(parse(await childStatus.handler({} as any, {})).children).toHaveLength(2);
    // Found again: they are this epic's now.
    const again = parse(await findTasks.handler({ query: '결제' } as any, {}));
    expect(again.room).toBe(5);
    expect(again.tasks.filter((t: any) => t.adoptable)).toEqual([]);
    expect(new Set(again.tasks.map((t: any) => t.reason))).toEqual(new Set(['already a child of this epic']));

    // The owner keeps working in the pay thread: its chain end wakes the epic, which accepts its node.
    await w.runChain(payKey, '계속해');
    await settle();
    const payNode = epic.plan?.nodes.find((n) => n.title === '결제 버그 고치기');
    expect(payNode?.accepted).toBeDefined();
    expect(w.turns.some((t) => t.key === epicKey && t.text.startsWith('Epic wake'))).toBe(true);

    // The epic gives the other its first word from the epic.
    const sent = parse(await instruct.handler({ childId: docs.taskId, instruction: '문서도 고쳐' } as any, {}));
    expect(sent).toMatchObject({ ok: true, childId: docs.taskId, started: true });
    await settle();
    expect(w.turns.filter((t) => t.key === docsKey).map((t) => t.text)).toEqual(['문서도 고쳐']);
  });
});
