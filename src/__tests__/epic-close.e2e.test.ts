/**
 * E4 ⑦ — closing an epic tree end to end: real registry + real controller + real
 * waker + real close handler, wired as index.ts does. A close never wakes the epic
 * it is closing (fable #703 R1 P1): the epic's own close cancels its running
 * children, and a child's close ends its chain — neither end may start a turn on
 * the epic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-close-e2e-${process.pid}`),
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
import { createEpicWaker } from '../task-turn/epic-wake';
import { createDashboardCloseHandler } from '../task-turn/task-close';
import { createTaskTurnController } from '../task-turn/task-turn-controller';
import type { RunTaskTurnInput, RunTaskTurnResult } from '../task-turn/task-turn-runner';
import type { TaskTurnOutcomeRecord } from '../types';

const BASE = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };
const flush = () => new Promise((r) => setTimeout(r, 0));

function rig() {
  const reg = new SessionRegistry();
  const epic = reg.createTask({ ...BASE, kind: 'epic' });
  const epicKey = `task:${epic.taskId}`;
  reg.setEpicPlan(
    epic.taskId!,
    {
      nodes: [
        { id: 'login', title: 'Fix login', kind: 'issue' },
        { id: 'docs', title: 'Docs', kind: 'issue' },
      ],
    },
    'epic',
  );
  const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
  const other = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'docs' });
  const inputs: RunTaskTurnInput[] = [];
  let n = 0;
  // A turn runs until it is aborted (a real one would be talking to the model).
  const runTaskTurn = vi.fn(async (input: RunTaskTurnInput): Promise<RunTaskTurnResult> => {
    inputs.push(input);
    const turnId = `t${++n}`;
    reg.beginTaskTurn(input.sessionKey, turnId, input.chain?.id, input.consume);
    input.onStarted?.();
    const signal = (input.params?.abortController as AbortController).signal;
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await flush();
    const outcome = { turnId, outcome: 'cancelled', category: 'Aborted', at: 9 } as unknown as TaskTurnOutcomeRecord;
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
  const close = createDashboardCloseHandler({
    getSession: (k) => reg.getSessionByKey(k),
    closeTask: async (k) => controller.close(k),
    terminate: (k) => reg.terminateSession(k),
    ledgerUnreadable: () => false,
    getChildTasks: (id) => reg.getChildTasks(id),
    isRunning: (k) => controller.isRunning(k),
    markClosedByParent: (k) => reg.markClosedByParent(k),
    recordChildClosed: (k) => reg.recordEpicChildClosed(k),
    markClosing: (k, c) => reg.markClosing(k, c),
    logger,
  });
  const start = async (key: string) => {
    const r = await controller.start({ sessionKey: key, text: 'go', actorUserId: 'U1', initiator: 'host' });
    expect(r.status).toBe(202);
    await flush();
    expect(controller.isRunning(key)).toBe(true);
  };
  const epicTurns = () => inputs.filter((i) => i.sessionKey === epicKey);
  return { reg, epic, epicKey, child, other, controller, close, start, epicTurns };
}

describe('E4 ⑦ — a close never wakes the epic it closes (fable #703 R1 P1)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('closing an idle, not-done epic cancels its running children and starts no turn on it', async () => {
    const t = rig();
    const childKey = `task:${t.child.taskId}`;
    const otherKey = `task:${t.other.taskId}`;
    await t.start(childKey);
    await t.start(otherKey);
    expect(t.reg.getSessionByKey(t.epicKey)!.activityState ?? 'idle').toBe('idle');

    await t.close(t.epicKey);
    for (let i = 0; i < 5; i++) await flush();

    expect(t.epicTurns()).toEqual([]);
    expect(t.reg.getSessionByKey(t.epicKey)).toBeUndefined();
    for (const key of [childKey, otherKey]) {
      expect(t.controller.isRunning(key)).toBe(false);
      const c = t.reg.getSessionByKey(key)!;
      expect(c.closedBy?.by).toBe('parent');
      expect(c.lastTurnOutcome?.outcome).toBe('cancelled');
    }
  });

  it('closing a running child records its close and starts no turn on its idle epic', async () => {
    const t = rig();
    const childKey = `task:${t.child.taskId}`;
    await t.start(childKey);

    await t.close(childKey);
    for (let i = 0; i < 5; i++) await flush();

    expect(t.epicTurns()).toEqual([]);
    const events = t.reg.getSessionByKey(t.epicKey)!.epicEvents ?? [];
    // The chain end the close caused owes no wake: it is delivered, like the closed event.
    expect(events.map((e) => [e.outcome, e.state])).toEqual(
      expect.arrayContaining([
        ['closed', 'delivered'],
        ['cancelled', 'delivered'],
      ]),
    );
    expect(events.filter((e) => e.state === 'pending')).toEqual([]);
    expect(events.some((e) => e.consumedBy)).toBe(false);
  });

  it('a close that fails clears the mark: the epic takes wakes and starts again', async () => {
    const t = rig();
    const close = createDashboardCloseHandler({
      getSession: (k) => t.reg.getSessionByKey(k),
      closeTask: async () => {
        throw new Error('boom');
      },
      terminate: () => undefined,
      ledgerUnreadable: () => false,
      getChildTasks: () => [],
      isRunning: () => false,
      markClosedByParent: () => undefined,
      recordChildClosed: () => undefined,
      markClosing: (k, c) => t.reg.markClosing(k, c),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await expect(close(t.epicKey)).rejects.toThrow('boom');
    expect(t.reg.getSessionByKey(t.epicKey)!.closing).toBeFalsy();
    await t.start(t.epicKey);
    expect(t.epicTurns()).toHaveLength(1);
  });
});
