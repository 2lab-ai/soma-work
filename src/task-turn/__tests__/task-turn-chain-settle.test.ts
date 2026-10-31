/**
 * E2 ③b — a task turn's chain from the controller to the registry (.prd/18 D5 · D6, §2.1).
 *
 * The controller gives every hop of one chain the same chain id and says, per
 * hop, whether a `completed` outcome continues the chain (a `/compact` hop with
 * an instruction to re-run and budget left). The runner opens the chain at the
 * turn start, and settles each commit: the chain ends unless a completed hop
 * continues it; a completed `/compact` hop with nothing to re-run is a failure
 * notice ("압축 뒤 재실행 못 함"), never a result. An outcome committed before
 * any start owes nothing; an abandoned or stranded turn ends its chain.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTaskTurnController, type TaskTurnControllerDeps } from '../task-turn-controller';
import {
  createTaskTurnRunner,
  type RunTaskTurnInput,
  type RunTaskTurnResult,
  type TaskTurnRunnerDeps,
} from '../task-turn-runner';

const KEY = 'task:11111111-2222-4333-8444-555555555555';
const CTX = { origin: 'task', userId: 'UOWNER', workingDirectory: '/work/UOWNER/t' } as any;

// ── runner ──

function runnerHarness(over: Partial<TaskTurnRunnerDeps> = {}) {
  const session: any = { slackless: true, taskId: '11111111-2222-4333-8444-555555555555', ownerId: 'U1' };
  const registry = {
    getSessionByKey: vi.fn(() => session),
    commitTaskTurnOutcome: vi.fn(),
    holdUnsavedTaskTurnOutcome: vi.fn(),
    beginTaskTurn: vi.fn((_k: string, turnId: string) => {
      session.activeTaskTurnId = turnId;
    }),
  };
  const deps: TaskTurnRunnerDeps = {
    registry,
    execute: vi.fn(
      async () => ({ success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } }) as any,
    ),
    createConversation: vi.fn(async () => 'conv-1'),
    receipts: { open: vi.fn(), drain: vi.fn(async () => undefined) },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    commitRetryDelaysMs: [0, 0, 0],
    ...over,
  };
  const runner = createTaskTurnRunner(deps);
  const input = { sessionKey: KEY, executionContext: CTX, text: 'do it' };
  return { session, registry, deps, runner, input };
}

describe('task turn runner — chain settle (E2 ③b)', () => {
  it('opens the chain at the turn start and ends it with the outcome', async () => {
    const h = runnerHarness();
    await h.runner.runTaskTurn({ ...h.input, chain: { id: 'c1', continuesIfCompleted: false } });
    expect(h.registry.beginTaskTurn).toHaveBeenCalledWith(KEY, expect.any(String), 'c1');
    expect(h.registry.commitTaskTurnOutcome).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ outcome: 'completed' }),
      'idle',
      { chainId: 'c1', ends: true },
    );
  });

  it('a completed hop the chain continues after keeps it open', async () => {
    const h = runnerHarness();
    await h.runner.runTaskTurn({ ...h.input, chain: { id: 'c1', continuesIfCompleted: true } });
    expect(h.registry.commitTaskTurnOutcome.mock.calls[0][3]).toEqual({ chainId: 'c1', ends: false });
  });

  it('a hop that would continue but did not complete ends the chain', async () => {
    const h = runnerHarness({
      execute: vi.fn(async () => {
        throw new Error('model crashed');
      }),
    });
    await expect(h.runner.runTaskTurn({ ...h.input, chain: { id: 'c1', continuesIfCompleted: true } })).rejects.toThrow(
      /model crashed/,
    );
    const [, record, , settle] = h.registry.commitTaskTurnOutcome.mock.calls[0];
    expect(record.outcome).toBe('failed');
    expect(settle).toEqual({ chainId: 'c1', ends: true });
  });

  it('a completed hop flagged as a failure end ("nothing to re-run") ends the chain with a failure notice', async () => {
    const h = runnerHarness();
    await h.runner.runTaskTurn({
      ...h.input,
      chain: { id: 'c1', continuesIfCompleted: false, completedFailsWith: 'compacted, nothing re-run' },
    });
    expect(h.registry.commitTaskTurnOutcome.mock.calls[0][3]).toEqual({
      chainId: 'c1',
      ends: true,
      notice: { kind: 'failure', reason: 'compacted, nothing re-run' },
    });
  });

  it('a conversation not created ends the chain before its start: the thread notice and the epic event (E4 ⑤, D6 b)', async () => {
    const h = runnerHarness({
      createConversation: vi.fn(async () => {
        throw new Error('ENOSPC');
      }),
    });
    await h.runner.runTaskTurn({ ...h.input, chain: { id: 'c1', continuesIfCompleted: false } });
    expect(h.registry.beginTaskTurn).not.toHaveBeenCalled();
    expect(h.registry.commitTaskTurnOutcome).toHaveBeenCalledTimes(1);
    expect(h.registry.commitTaskTurnOutcome.mock.calls[0][1]).toMatchObject({ outcome: 'failed' });
    expect(h.registry.commitTaskTurnOutcome.mock.calls[0][3]).toEqual({ chainId: 'c1', ends: true });
  });

  it('an outcome held in memory carries the same settle', async () => {
    const h = runnerHarness();
    h.registry.commitTaskTurnOutcome.mockImplementation(() => {
      throw new Error('disk full');
    });
    await h.runner.runTaskTurn({ ...h.input, chain: { id: 'c1', continuesIfCompleted: false } });
    expect(h.registry.holdUnsavedTaskTurnOutcome.mock.calls[0][3]).toEqual({ chainId: 'c1', ends: true });
  });

  it('a turn with no chain (an old caller) settles nothing', async () => {
    const h = runnerHarness();
    await h.runner.runTaskTurn(h.input);
    expect(h.registry.beginTaskTurn).toHaveBeenCalledWith(KEY, expect.any(String), undefined);
    expect(h.registry.commitTaskTurnOutcome.mock.calls[0][3]).toBeUndefined();
  });

  it('abandoning a turn ends its chain', async () => {
    const h = runnerHarness({
      execute: vi.fn(
        async () => ({ success: false, messageCount: 0, terminal: { exit: 'abort', abortReason: 'supersede' } }) as any,
      ),
    });
    const r = await h.runner.runTaskTurn({
      ...h.input,
      chain: { id: 'c1', continuesIfCompleted: false },
    });
    expect(r.outcome).toBeNull();
    await h.runner.abandonTurn(KEY, r.turnId, { outcome: 'interrupted', category: 'Exception', reason: 'x' }, 'c1');
    expect(h.registry.commitTaskTurnOutcome.mock.calls.slice(-1)[0]?.[3]).toEqual({ chainId: 'c1', ends: true });
  });
});

// ── controller ──

const completed = (turnId = 't'): RunTaskTurnResult => ({
  turnId,
  outcome: { turnId, outcome: 'completed', category: 'WorkflowComplete', at: 1 },
});
const fallbackCompact = (turnId = 'tc'): RunTaskTurnResult => ({
  turnId,
  outcome: null,
  nonTerminal: 'fallbackCompact',
});

function controllerHarness(
  steps: Array<RunTaskTurnResult | ((i: RunTaskTurnInput) => Promise<RunTaskTurnResult>)>,
  session: any = {},
) {
  const s = { slackless: true, ownerId: 'UOWNER', ownerName: 'Owner', taskId: 'a', ...session };
  const inputs: RunTaskTurnInput[] = [];
  const queue = [...steps];
  const runTaskTurn = vi.fn(async (input: RunTaskTurnInput) => {
    inputs.push(input);
    const next = queue.shift() ?? completed();
    // A function step decides for itself whether its start was saved.
    if (typeof next === 'function') return next(input);
    input.onStarted?.();
    return next;
  });
  const abandonTurn = vi.fn(async (_k: string, turnId: string, decided: any) => ({
    turnId,
    outcome: { ...decided, turnId, at: 1 },
  }));
  const controllers = new Map<string, AbortController>();
  const deps: TaskTurnControllerDeps = {
    runner: { runTaskTurn, abandonTurn },
    getSession: () => s,
    coordinator: {
      setController: (k: string, ac: AbortController) => void controllers.set(k, ac),
      removeController: (k: string) => void controllers.delete(k),
    } as any,
    buildExecutionContext: vi.fn(() => CTX),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { controller: createTaskTurnController(deps), inputs, abandonTurn, session: s, controllers, deps };
}

async function startAndSettle(h: ReturnType<typeof controllerHarness>) {
  const r = await h.controller.start({ sessionKey: KEY, text: 'do the thing', actorUserId: 'UOWNER' } as any);
  expect(r.status).toBe(202);
  await (r as any).done;
}

describe('task turn controller — one chain id per chain, and when a completed hop continues (E2 ③b)', () => {
  it('a one-hop chain: one chain id, a completed outcome ends it', async () => {
    const h = controllerHarness([completed()]);
    await startAndSettle(h);
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0].chain).toEqual({ id: expect.any(String), continuesIfCompleted: false });
  });

  it('a fallback compaction chain: every hop carries the same id; only the /compact hop with a stash continues', async () => {
    const h = controllerHarness([fallbackCompact(), completed('tcompact'), completed('treplay')], {
      fallbackCompactPendingUserText: 'the original instruction',
    });
    await startAndSettle(h);
    expect(h.inputs).toHaveLength(3);
    const ids = new Set(h.inputs.map((i) => i.chain?.id));
    expect(ids.size).toBe(1);
    expect(h.inputs[0].chain?.continuesIfCompleted).toBe(false);
    expect(h.inputs[1].compactHop).toBe(true);
    expect(h.inputs[1].chain?.continuesIfCompleted).toBe(true);
    expect(h.inputs[1].chain?.completedFailsWith).toBeUndefined();
    expect(h.inputs[2].chain?.continuesIfCompleted).toBe(false);
  });

  it('a /compact hop with nothing to re-run: a completed outcome is a failure end, not a result', async () => {
    const h = controllerHarness([fallbackCompact(), completed('tcompact')]);
    await startAndSettle(h);
    expect(h.inputs).toHaveLength(2);
    expect(h.inputs[1].chain).toEqual({
      id: h.inputs[0].chain?.id,
      continuesIfCompleted: false,
      completedFailsWith: expect.stringMatching(/re-run|재실행/),
    });
  });

  it('two chains get two ids', async () => {
    const h = controllerHarness([completed(), completed()]);
    await startAndSettle(h);
    await startAndSettle(h);
    expect(h.inputs[0].chain?.id).not.toBe(h.inputs[1].chain?.id);
  });

  it('a completed /compact hop the chain continues past, whose re-run cannot start, is ended interrupted with the chain id (fable #666 P1)', async () => {
    const h = controllerHarness(
      [
        fallbackCompact(),
        completed('tcompact'),
        async () => {
          throw new Error('start not saved');
        },
      ],
      { fallbackCompactPendingUserText: 'the original instruction' },
    );
    const r = await h.controller.start({ sessionKey: KEY, text: 'go', actorUserId: 'UOWNER' } as any);
    await (r as any).done;
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'tcompact',
      expect.objectContaining({ outcome: 'interrupted' }),
      h.inputs[0].chain?.id,
    );
  });

  it('…and when the re-run’s execution context cannot be built, the same', async () => {
    let calls = 0;
    const failing = controllerHarness([fallbackCompact(), completed('tcompact')], {
      fallbackCompactPendingUserText: 'the original instruction',
    });
    // The same controller, with a context builder that fails for the re-run:
    // built once by start, again for the /compact hop, a third time for the re-run.
    const ctxFail = vi.fn(() => {
      calls++;
      if (calls >= 3) throw new Error('owner lost access');
      return CTX;
    });
    const controller = createTaskTurnController({
      ...(failing as any).deps,
      buildExecutionContext: ctxFail,
    });
    const r = await controller.start({ sessionKey: KEY, text: 'go', actorUserId: 'UOWNER' } as any);
    await (r as any).done;
    expect(failing.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'tcompact',
      expect.objectContaining({ outcome: 'interrupted' }),
      failing.inputs[0].chain?.id,
    );
  });

  it('an empty stash is nothing to re-run: the /compact hop ends the chain as a failure (fable #666 P2)', async () => {
    const h = controllerHarness([fallbackCompact(), completed('tcompact')], { fallbackCompactPendingUserText: '' });
    await startAndSettle(h);
    expect(h.inputs).toHaveLength(2);
    expect(h.inputs[1].chain).toEqual({
      id: h.inputs[0].chain?.id,
      continuesIfCompleted: false,
      completedFailsWith: expect.any(String),
    });
  });

  it('a pending turn the chain abandons is ended with the chain id', async () => {
    const h = controllerHarness([
      fallbackCompact(),
      async () => {
        throw new Error('start not saved');
      },
    ]);
    // The second hop never starts: its start throws before onStarted.
    const runTaskTurn = h.controller as any;
    void runTaskTurn;
    const r = await h.controller.start({ sessionKey: KEY, text: 'go', actorUserId: 'UOWNER' } as any);
    await (r as any).done;
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'tc',
      expect.objectContaining({ outcome: 'interrupted' }),
      h.inputs[0].chain?.id,
    );
  });
});
