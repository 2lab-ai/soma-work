/**
 * E4 ⑩b (.prd/19 §5 ⑩) — the epic loop end to end, with a restart in the middle.
 *
 * Real registry, controller, waker and epic tools (the `epic` server's own handlers), wired as
 * index.ts does: onChainEnd for a chain that started, the event listener, the boot scan. A runner
 * that uses the registry like the real one; the epic's "model" is a fixed script that calls the
 * tools the skill's loop names (⑩a): plan_write → spawn_child → end the turn → child_status on
 * each wake → plan_write(accepted) / instruct_child → done.
 *
 *   X1 one epic, three nodes → three children → each end wakes the epic → all accepted → done.
 *   X2 a restart while two children run: relations, plan and events survive the load; the cut
 *      chains read interrupted, the boot scan wakes the epic once, it re-instructs them, and the
 *      loop still ends done.
 *   Both: no wrong start, no duplicate child, no missed wake, no wake consumed twice, and no epic
 *   turn starts with nothing to read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-loop-e2e-${process.pid}`),
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
import { epicTools, setEpicHost } from '../task-turn/epic-server';
import { createEpicWaker } from '../task-turn/epic-wake';
import { createTaskTurnController } from '../task-turn/task-turn-controller';
import type { RunTaskTurnInput, RunTaskTurnResult } from '../task-turn/task-turn-runner';
import type { TaskTurnOutcomeRecord } from '../types';

const OWNER = 'U1';
const BASE = { ownerId: OWNER, ownerName: 'User', workingDirectory: path.join(TEST_DATA_DIR, 'work', 'epic') };
const NODES = ['login', 'docs', 'api'];
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 20; i++) await flush();
};

type Tool = { name: string; handler: (args: any, extra: unknown) => Promise<{ content: Array<{ text: string }> }> };
const call = async (tools: readonly Tool[], name: string, args: Record<string, unknown> = {}) => {
  const t = tools.find((x) => x.name === name) as Tool;
  return JSON.parse((await t.handler(args, {})).content[0].text);
};

/**
 * One process: a registry, its controller and waker, the epic host. Children finish when their
 * turn runs unless `hold` says to keep them running (a turn that a restart will cut).
 */
function boot(reg: SessionRegistry, hold: (key: string, text: string) => Promise<void> | undefined = () => undefined) {
  const log: Array<{ key: string; text: string; consume?: readonly string[]; chain: string }> = [];
  const refusals: Array<{ tool: string; code: string }> = [];
  let n = 0;
  let fresh = 0;
  const epicBrain = async (taskId: string) => {
    const tools = epicTools({
      origin: 'task',
      taskId,
      kind: 'epic',
      userId: OWNER,
      workingDirectory: BASE.workingDirectory,
    } as any) as unknown as Tool[];
    const tree = await call(tools, 'child_status');
    if (!tree.nodes.length) {
      await call(tools, 'plan_write', {
        nodes: NODES.map((id) => ({ id, title: `Do ${id}`, kind: 'issue' })),
      });
      for (const id of NODES) {
        const r = await call(tools, 'spawn_child', { planNodeId: id, instruction: `do ${id}` });
        if (!r.ok) refusals.push({ tool: 'spawn_child', code: r.code });
      }
      return;
    }
    const childOf = (node: string) => tree.children.find((c: any) => c.planNodeId === node);
    const accept: string[] = [];
    for (const node of tree.nodes) {
      if (node.accepted) continue;
      if (node.status === 'finished') accept.push(node.id);
      if (node.status === 'interrupted') {
        const r = await call(tools, 'instruct_child', {
          childId: childOf(node.id).taskId,
          instruction: `continue ${node.id}`,
        });
        if (!r.ok) refusals.push({ tool: 'instruct_child', code: r.code });
      }
    }
    if (accept.length) {
      // plan_write replaces the tree: the whole tree, with accepted on the finished nodes.
      await call(tools, 'plan_write', {
        nodes: tree.nodes.map((nd: any) => ({
          id: nd.id,
          title: nd.title,
          kind: nd.kind,
          ...(accept.includes(nd.id) ? { accepted: true } : {}),
        })),
      });
    }
    const after = await call(tools, 'child_status');
    if (after.nodes.every((nd: any) => nd.accepted)) {
      const r = await call(tools, 'plan_write', {
        nodes: after.nodes.map((nd: any) => ({ id: nd.id, title: nd.title, kind: nd.kind })),
        done: true,
      });
      if (!r.ok) refusals.push({ tool: 'plan_write(done)', code: r.code });
    }
  };

  const runTaskTurn = vi.fn(async (input: RunTaskTurnInput): Promise<RunTaskTurnResult> => {
    const turnId = `t${++n}`;
    log.push({ key: input.sessionKey, text: input.text, consume: input.consume, chain: input.chain!.id });
    reg.beginTaskTurn(input.sessionKey, turnId, input.chain?.id, input.consume);
    input.onStarted?.();
    await flush();
    const s = reg.getSessionByKey(input.sessionKey)!;
    if (s.kind === 'epic') await epicBrain(s.taskId!);
    else await hold(input.sessionKey, input.text); // a child's turn runs until the test lets it end (or a restart cuts it)
    const outcome = {
      turnId,
      outcome: 'completed',
      category: 'WorkflowComplete',
      at: Date.now(),
    } as TaskTurnOutcomeRecord;
    reg.commitTaskTurnOutcome(input.sessionKey, outcome, 'idle', { chainId: input.chain!.id, ends: true });
    return { turnId, outcome };
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let waker!: ReturnType<typeof createEpicWaker>;
  const controller = createTaskTurnController({
    runner: { runTaskTurn, abandonTurn: vi.fn() as any },
    getSession: (k) => reg.getSessionByKey(k),
    coordinator: { setController: vi.fn(), removeController: vi.fn(), abortSession: vi.fn() } as any,
    buildExecutionContext: (s: any) => ({ origin: 'task', userId: s.ownerId, workingDirectory: '/w' }) as any,
    logger,
    treeCostUsd: () => 0,
    onChainEnd: (k, { started }) => {
      if (started) waker.wake(k);
    },
  });
  waker = createEpicWaker({ getSession: (k) => reg.getSessionByKey(k), controller, logger });
  reg.setEpicEventListener((k) => waker.wake(k));
  setEpicHost({
    getTask: (taskId) => reg.getSessionByTaskId(taskId),
    getChildTasks: (parentTaskId) => reg.getChildTasks(parentTaskId),
    setEpicPlan: (taskId, input, by) => reg.setEpicPlan(taskId, input, by),
    readChildFinal: async () => ({ text: 'done', clipped: false }),
    createTask: (input) => reg.createTask(input),
    // A fresh folder's name only (the fake runner never works in it): taskDirectoryFor checks the owner's /tmp root.
    createFreshDirectory: (ownerId) => `/tmp/${ownerId}/session_e2e_${process.pid}_${++fresh}`,
    ensureDirectory: () => undefined,
    controller,
  });
  return { controller, waker, log, refusals };
}

/** Child turns that end when the test says so: `release(text)` ends the turn started with that text. */
function gates() {
  const open = new Map<string, () => void>();
  const waiting = new Map<string, Promise<void>>();
  const gate = (text: string) => {
    let p = waiting.get(text);
    if (!p) {
      p = new Promise<void>((resolve) => open.set(text, resolve));
      waiting.set(text, p);
    }
    return p;
  };
  return {
    hold: (_key: string, text: string) => gate(text),
    release: async (text: string) => {
      gate(text);
      open.get(text)?.();
      await settle();
    },
  };
}

/** The invariants every run must keep, read from the registry's own records. */
function expectClean(
  reg: SessionRegistry,
  epicKey: string,
  log: Array<{ key: string; text: string; consume?: readonly string[] }>,
) {
  const epic = reg.getSessionByKey(epicKey)!;
  // No duplicate child: one child per node, made once.
  expect(epic.childTaskIds).toHaveLength(NODES.length);
  expect(reg.getChildTasks(epic.taskId!)).toHaveLength(NODES.length);
  for (const node of epic.plan!.nodes) expect(node.spawned ?? []).toHaveLength(1);
  // No missed wake: every chain end was consumed; nothing pends.
  const ends = (epic.epicEvents ?? []).filter((e) => e.outcome !== 'closed' && !e.approvalId);
  console.log(
    'DBG',
    JSON.stringify(ends),
    JSON.stringify(log.map((l) => [l.key.slice(5, 9), l.text.slice(0, 40), l.consume])),
    JSON.stringify(epic.plan),
  );
  expect(ends.filter((e) => e.state === 'pending')).toEqual([]);
  // No wake consumed twice: each consumed event names one chain, and a wake's events are its own.
  const wakes = log.filter((l) => l.key === epicKey && l.text.startsWith('Epic wake:'));
  const consumed = wakes.flatMap((w) => [...(w.consume ?? [])]);
  expect(new Set(consumed).size).toBe(consumed.length);
  // No epic turn with nothing to read.
  for (const w of wakes) expect((w.consume ?? []).length).toBeGreaterThan(0);
  // Done: every node accepted, the plan done.
  expect(epic.plan!.nodes.every((nd) => nd.accepted)).toBe(true);
  expect(epic.plan!.done).toBeDefined();
}

describe('E4 ⑩b — the epic loop end to end', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    fs.mkdirSync(BASE.workingDirectory, { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    setEpicHost(undefined);
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('X1 — three nodes, three children, each end wakes the epic once, all accepted, done', async () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const epicKey = `task:${epic.taskId}`;
    const g = gates();
    const p = boot(reg, g.hold);
    const r = await p.controller.start({ sessionKey: epicKey, text: 'build the three parts', actorUserId: OWNER });
    expect(r.status).toBe(202);
    await settle();
    // The planning turn ended: three children run, the epic is idle with nothing to read.
    expect(p.refusals).toEqual([]);
    expect(p.log.filter((l) => l.key !== epicKey).map((l) => l.text)).toEqual(NODES.map((id) => `do ${id}`));
    expect(p.log.filter((l) => l.key === epicKey)).toHaveLength(1);

    // Each child's end wakes the epic once, with that one event; the epic accepts its node.
    for (const [i, id] of NODES.entries()) {
      await g.release(`do ${id}`);
      const epicTurns = p.log.filter((l) => l.key === epicKey);
      expect(epicTurns).toHaveLength(2 + i);
      const wake = epicTurns[epicTurns.length - 1];
      expect(wake.text).toBe(`Epic wake: 1 event — ${id}:finished. Read details with child_status.`);
      expect(wake.consume).toHaveLength(1);
      expect(reg.getSessionByKey(epicKey)!.plan!.nodes.find((nd) => nd.id === id)!.accepted).toBeDefined();
    }
    expect(p.refusals).toEqual([]);
    expectClean(reg, epicKey, p.log);
  });

  it('X2 — a restart while two children run: everything survives, the cut chains wake the epic once, and it still ends done', async () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const epicKey = `task:${epic.taskId}`;
    // Before the restart: login ends; docs and api are still running when the process dies.
    const g1 = gates();
    const before = boot(reg, g1.hold);
    await before.controller.start({ sessionKey: epicKey, text: 'build the three parts', actorUserId: OWNER });
    await settle();
    await g1.release('do login');
    const childIds = [...(reg.getSessionByKey(epicKey)!.childTaskIds ?? [])];
    expect(childIds).toHaveLength(3);
    const loginNode = reg.getSessionByKey(epicKey)!.plan!.nodes.find((nd) => nd.id === 'login')!;
    expect(loginNode.accepted).toBeDefined();

    // The process dies here. A new one loads the file.
    const after = new SessionRegistry();
    after.loadSessions();
    const epicAfter = after.getSessionByKey(epicKey)!;
    expect(epicAfter.childTaskIds).toEqual(childIds);
    for (const id of childIds) expect(after.getSessionByTaskId(id)?.parentTaskId).toBe(epic.taskId);
    expect(epicAfter.plan!.nodes.map((nd) => nd.id)).toEqual(NODES);
    expect(epicAfter.plan!.nodes.find((nd) => nd.id === 'login')!.accepted).toBeDefined();
    // The cut chains are interrupted, and each is a pending event on the epic.
    const interrupted = (epicAfter.epicEvents ?? []).filter((e) => e.outcome === 'interrupted');
    expect(interrupted.map((e) => e.planNodeId).sort()).toEqual(['api', 'docs']);
    expect(interrupted.every((e) => e.state === 'pending')).toBe(true);

    const g2 = gates();
    const p = boot(after, g2.hold);
    // The boot scan (index.ts, after the web server starts): every live epic once.
    p.waker.wake(epicKey);
    await settle();
    const wakes = () => p.log.filter((l) => l.key === epicKey);
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0].text).toBe(
      'Epic wake: 2 events — docs:interrupted, api:interrupted. Read details with child_status.',
    );
    expect(wakes()[0].consume).toHaveLength(2);
    // The epic re-instructs the two cut children; each new end wakes it once more.
    expect(
      p.log
        .filter((l) => l.key !== epicKey)
        .map((l) => l.text)
        .sort(),
    ).toEqual(['continue api', 'continue docs']);
    await g2.release('continue docs');
    expect(wakes()).toHaveLength(2);
    await g2.release('continue api');
    expect(wakes()).toHaveLength(3);
    expect(p.refusals).toEqual([]);
    expectClean(after, epicKey, [...before.log, ...p.log]);
  });
});
