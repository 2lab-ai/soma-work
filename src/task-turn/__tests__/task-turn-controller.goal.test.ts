/**
 * SSOT 2026-11-03 — the goal loop on a dashboard task, the controller's part:
 * the loop's next turn is a synthetic start (not user input — it cannot set a
 * goal or reset the goal's count), and a person's instruction or answer tells
 * the host so (it resets the count, as a Slack message does). Host starts
 * (an epic's spawn/instruct/wake, the goal loop) never do.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTaskTurnController, type TaskTurnControllerDeps } from '../task-turn-controller';
import type { RunTaskTurnInput, RunTaskTurnResult } from '../task-turn-runner';

const KEY = 'task:11111111-2222-4333-8444-555555555555';
const CTX = { origin: 'task', userId: 'UOWNER', workingDirectory: '/work/UOWNER/t' } as any;

const completed = (turnId = 't'): RunTaskTurnResult => ({
  turnId,
  outcome: { turnId, outcome: 'completed', category: 'WorkflowComplete', at: 1 },
});

function harness(over: Partial<TaskTurnControllerDeps> = {}, steps: RunTaskTurnResult[] = []) {
  const session: any = { slackless: true, ownerId: 'UOWNER', ownerName: 'Owner', taskId: 'a' };
  const inputs: RunTaskTurnInput[] = [];
  const queue = [...steps];
  const runTaskTurn = vi.fn(async (input: RunTaskTurnInput) => {
    inputs.push(input);
    input.onStarted?.();
    return queue.shift() ?? completed();
  });
  const controllers = new Map<string, AbortController>();
  const onUserInstruction = vi.fn();
  const deps: TaskTurnControllerDeps = {
    runner: {
      runTaskTurn,
      abandonTurn: vi.fn(async (_k: string, turnId: string, decided: any) => ({
        turnId,
        outcome: { ...decided, turnId, at: 1 },
      })),
    },
    getSession: (k) => (k === KEY ? session : undefined),
    coordinator: {
      setController: (k, ac) => {
        controllers.set(k, ac);
      },
      removeController: (k, expected) => {
        if (!expected || controllers.get(k) === expected) controllers.delete(k);
      },
    },
    buildExecutionContext: vi.fn(() => CTX),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onUserInstruction,
    ...over,
  };
  return { controller: createTaskTurnController(deps), session, inputs, onUserInstruction };
}

describe('TaskTurnController — goal loop turns (SSOT 2026-11-03)', () => {
  it('a goal continuation runs as a synthetic turn: isUserInput false, and the user hook is not told', async () => {
    const h = harness();
    const r = await h.controller.start({
      sessionKey: KEY,
      text: '[goal-continuation] keep going',
      actorUserId: 'UOWNER',
      initiator: 'host',
      goalContinuation: true,
    });
    expect(r.status).toBe(202);
    await r.done;
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0].params?.isUserInput).toBe(false);
    expect(h.onUserInstruction).not.toHaveBeenCalled();
  });

  it('a goal continuation’s /compact replay stays synthetic', async () => {
    const h = harness({}, [
      { turnId: 't1', nonTerminal: 'fallbackCompact' } as RunTaskTurnResult,
      completed('t2'),
      completed('t3'),
    ]);
    h.session.fallbackCompactPendingUserText = '[goal-continuation] keep going';
    const r = await h.controller.start({
      sessionKey: KEY,
      text: '[goal-continuation] keep going',
      actorUserId: 'UOWNER',
      initiator: 'host',
      goalContinuation: true,
    });
    await r.done;
    expect(h.inputs.map((i) => [i.text, i.params?.isUserInput])).toEqual([
      ['[goal-continuation] keep going', false],
      ['/compact', false],
      ['[goal-continuation] keep going', false],
    ]);
  });

  it('the owner’s instruction is user input and tells the host before the turn runs', async () => {
    const h = harness();
    const r = await h.controller.start({ sessionKey: KEY, text: 'set goal: ship it', actorUserId: 'UOWNER' });
    expect(r.status).toBe(202);
    await r.done;
    expect(h.inputs[0].params?.isUserInput).toBe(true);
    expect(h.onUserInstruction).toHaveBeenCalledTimes(1);
    expect(h.onUserInstruction).toHaveBeenCalledWith(KEY, h.session);
  });

  it('a host start (an epic waking or instructing a child) is not a person’s word', async () => {
    const h = harness();
    const r = await h.controller.start({
      sessionKey: KEY,
      text: 'do node 2',
      actorUserId: 'UOWNER',
      initiator: 'host',
    });
    await r.done;
    expect(h.onUserInstruction).not.toHaveBeenCalled();
    // A host turn: its text cannot pass the SET_GOAL gate (fable-zhuge #861 R1 P2).
    expect(h.inputs[0].params?.hostTurn).toBe(true);
  });

  it('the owner’s own word is no host turn', async () => {
    const h = harness();
    const r = await h.controller.start({ sessionKey: KEY, text: 'go', actorUserId: 'UOWNER' });
    await r.done;
    expect(h.inputs[0].params?.hostTurn).toBeUndefined();
  });

  it('the chain end tells how it ended: a healthy end carries its outcome, a Stop says stopped', async () => {
    const ends: Array<{ started: boolean; stopped?: boolean; outcome?: string }> = [];
    const h = harness({ onChainEnd: (_k, info) => ends.push(info) });
    const r = await h.controller.start({ sessionKey: KEY, text: 'go', actorUserId: 'UOWNER' });
    await r.done;
    expect(ends).toEqual([{ started: true, stopped: false, outcome: 'completed' }]);
  });

  it('a throwing user hook never blocks the start', async () => {
    const h = harness({
      onUserInstruction: () => {
        throw new Error('boom');
      },
    });
    const r = await h.controller.start({ sessionKey: KEY, text: 'go', actorUserId: 'UOWNER' });
    expect(r.status).toBe(202);
    await r.done;
  });
});
