/**
 * E4 ⑥ — end to end: real registry + real controller, wired as index.ts does (the idle hook, the event listener, onChainEnd); a runner that uses the registry like the real one. An event that came while the epic worked wakes it once its chain has ended — the idle hook alone fires inside the epic’s own commit, before the chain is released (fable #702 R1 P0).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-wake-e2e-${process.pid}`),
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
import { createTaskTurnController } from '../task-turn/task-turn-controller';
import type { RunTaskTurnInput, RunTaskTurnResult } from '../task-turn/task-turn-runner';
import type { TaskTurnOutcomeRecord } from '../types';

const BASE = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('E4 ⑥ — the wake loop end to end (fable #702 R1 P0)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('an event that arrives while the epic works wakes it once its chain ends, and that start consumes it', async () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({ ...BASE, kind: 'epic' });
    const epicKey = `task:${epic.taskId}`;
    epic.conversationId = 'conv-epic';
    reg.setEpicPlan(epic.taskId!, { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] }, 'epic');
    const child = reg.createTask({ ...BASE, parentTaskId: epic.taskId, planNodeId: 'login' });
    const childKey = `task:${child.taskId}`;

    const inputs: RunTaskTurnInput[] = [];
    let n = 0;
    const runTaskTurn = vi.fn(async (input: RunTaskTurnInput): Promise<RunTaskTurnResult> => {
      inputs.push(input);
      const turnId = `t${++n}`;
      reg.beginTaskTurn(input.sessionKey, turnId, input.chain?.id, input.consume);
      input.onStarted?.();
      await flush();
      if (input.sessionKey === epicKey && n === 1) {
        // While the epic works, a child's chain ends: one pending event on the epic.
        reg.beginTaskTurn(childKey, 'c1', 'chain-c1');
        const done: TaskTurnOutcomeRecord = { turnId: 'c1', outcome: 'completed', category: 'WorkflowComplete', at: 5 };
        reg.commitTaskTurnOutcome(childKey, done, 'idle', { chainId: 'chain-c1', ends: true });
        await flush();
        expect(reg.getSessionByKey(epicKey)!.epicEvents!.filter((e) => e.state === 'pending')).toHaveLength(1);
      }
      const outcome: TaskTurnOutcomeRecord = { turnId, outcome: 'completed', category: 'WorkflowComplete', at: 9 };
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
      onChainEnd: (k) => waker.wake(k),
    });
    waker = createEpicWaker({ getSession: (k) => reg.getSessionByKey(k), controller, logger });
    reg.setOnIdleAfterDrainHook((k) => waker.wake(k));
    reg.setEpicEventListener((k) => waker.wake(k));

    const r = await controller.start({ sessionKey: epicKey, text: 'plan it', actorUserId: 'U1' });
    expect(r.status).toBe(202);
    await (r as any).done;
    for (let i = 0; i < 5; i++) await flush();

    const epicInputs = inputs.filter((i) => i.sessionKey === epicKey);
    expect(epicInputs.map((i) => i.text)).toEqual([
      'plan it',
      'Epic wake: 1 event — login:finished. Read details with child_status.',
    ]);
    expect(epicInputs[1].consume).toEqual([`${child.taskId}:chain-c1`]);
    expect(reg.getSessionByKey(epicKey)!.epicEvents!.filter((e) => e.state === 'pending')).toEqual([]);
  });
});
