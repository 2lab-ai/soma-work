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

  // #865 — `goal …` is the host's goal command on a task, never the model's text.
  describe('a person’s `goal …` (#865)', () => {
    const goalHarness = (steps: RunTaskTurnResult[] = []) => {
      const ran: Array<{ text: string; actor: string }> = [];
      const goalCommands = {
        matches: (text: string) => /^\/?goal(\s|$)/i.test(text.trim()),
        run: vi.fn(async (request: { text: string; actorUserId: string }) => {
          ran.push({ text: request.text, actor: request.actorUserId });
          return { status: 200, body: { ok: true, goalCommand: true, message: 'done' } };
        }),
        opensGoal: vi.fn((text: string) => !/^\/?goal\s*(clear|pause|resume|done|max.*|auto.*)?$/i.test(text.trim())),
        openingDropped: vi.fn(),
      };
      const h = harness({ goalCommands }, steps);
      return { ...h, ran, goalCommands };
    };
    /** A controller whose first turn holds the task until `release()`; later turns end at once. */
    const blocking = (h: ReturnType<typeof goalHarness>) => {
      let release!: () => void;
      const inputs: RunTaskTurnInput[] = [];
      let calls = 0;
      const controller = createTaskTurnController({
        runner: {
          runTaskTurn: vi.fn(async (input: RunTaskTurnInput) => {
            inputs.push(input);
            input.onStarted?.();
            if (calls++ === 0) {
              await new Promise<void>((r) => {
                release = r;
              });
            }
            return completed(`t${calls}`);
          }),
          abandonTurn: vi.fn(),
        },
        getSession: (k) => (k === KEY ? h.session : undefined),
        coordinator: { setController: () => {}, removeController: () => {} },
        buildExecutionContext: () => CTX,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        goalCommands: h.goalCommands,
      });
      return { controller, inputs, release: () => release() };
    };

    it('runs as the goal command: no turn, nothing to the model, the user hook not told', async () => {
      const h = goalHarness();
      const r = await h.controller.start({ sessionKey: KEY, text: '  goal clear ', actorUserId: 'UOWNER' });
      expect(r).toEqual({ status: 200, body: { ok: true, goalCommand: true, message: 'done' } });
      expect(h.ran).toEqual([{ text: 'goal clear', actor: 'UOWNER' }]);
      expect(h.inputs).toHaveLength(0);
      expect(h.onUserInstruction).not.toHaveBeenCalled();
    });

    it('`/goal …` is the goal command, not a refused slash command', async () => {
      const h = goalHarness();
      const r = await h.controller.start({ sessionKey: KEY, text: '/goal pause', actorUserId: 'UOWNER' });
      expect(r.status).toBe(200);
      expect(h.ran).toHaveLength(1);
    });

    it('applies at once while a turn runs — not queued behind it', async () => {
      let release!: () => void;
      const h = goalHarness();
      const blocking = createTaskTurnController({
        runner: {
          runTaskTurn: vi.fn(async (input: RunTaskTurnInput) => {
            input.onStarted?.();
            await new Promise<void>((r) => {
              release = r;
            });
            return completed();
          }),
          abandonTurn: vi.fn(),
        },
        getSession: (k) => (k === KEY ? h.session : undefined),
        coordinator: { setController: () => {}, removeController: () => {} },
        buildExecutionContext: () => CTX,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        goalCommands: h.goalCommands,
      });
      const first = await blocking.start({ sessionKey: KEY, text: 'work', actorUserId: 'UOWNER' });
      expect(first.status).toBe(202);
      const r = await blocking.start({
        sessionKey: KEY,
        text: 'goal pause',
        actorUserId: 'UOWNER',
        queueWhileRunning: true,
      });
      expect(r.status).toBe(200);
      expect(h.ran).toEqual([{ text: 'goal pause', actor: 'UOWNER' }]);
      expect(h.session.taskFollowups ?? []).toHaveLength(0);
      release();
      await first.done;
    });

    it('the sender is admitted first: signed out or another user on an epic tree is refused before it runs', async () => {
      const h = goalHarness();
      const signedOut = await h.controller.start({ sessionKey: KEY, text: 'goal clear', actorUserId: '' });
      expect(signedOut.status).toBe(403);
      h.session.kind = 'epic';
      const stranger = await h.controller.start({ sessionKey: KEY, text: 'goal clear', actorUserId: 'USTRANGER' });
      expect(stranger.status).toBe(403);
      expect(h.ran).toHaveLength(0);
    });

    it('a goal’s opening, a goal continuation and a host start are turns, never goal commands', async () => {
      const h = goalHarness();
      h.session.goal = { goalId: 'g1', status: 'active', openingPending: true };
      for (const extra of [
        { goalOpeningId: 'g1' },
        { goalContinuation: true, initiator: 'host' as const },
        { initiator: 'host' as const },
      ]) {
        const r = await h.controller.start({ sessionKey: KEY, text: 'goal ship it', actorUserId: 'UOWNER', ...extra });
        expect(r.status).toBe(202);
        await r.done;
      }
      expect(h.ran).toHaveLength(0);
      expect(h.inputs.map((i) => i.text)).toEqual(['goal ship it', 'goal ship it', 'goal ship it']);
    });

    it('a goal’s opening queued behind a running turn keeps its goal id, and drains as the opening', async () => {
      const h = goalHarness();
      h.session.goal = { goalId: 'g1', status: 'active', openingPending: true };
      const b = blocking(h);
      const first = await b.controller.start({ sessionKey: KEY, text: 'work', actorUserId: 'UOWNER' });
      const opening = await b.controller.start({
        sessionKey: KEY,
        text: 'goal of the goal',
        actorUserId: 'UOWNER',
        queueWhileRunning: true,
        goalOpeningId: 'g1',
      });
      expect(opening.body).toMatchObject({ queued: true });
      expect(h.session.taskFollowups).toMatchObject([{ text: 'goal of the goal', goalOpeningId: 'g1' }]);
      b.release();
      await first.done;
      await vi.waitFor(() => expect(b.inputs).toHaveLength(2));
      expect(b.inputs[1].text).toBe('goal of the goal');
      expect(h.ran).toHaveLength(0);
    });

    // astra-zhuge #876 R1 P1 — `goal clear` while the opening waited: the objective must not run.
    it('a queued opening whose goal moved on is skipped at the drain; the next word runs', async () => {
      const h = goalHarness();
      h.session.goal = { goalId: 'g1', status: 'active', openingPending: true };
      const b = blocking(h);
      const first = await b.controller.start({ sessionKey: KEY, text: 'work', actorUserId: 'UOWNER' });
      await b.controller.start({
        sessionKey: KEY,
        text: 'the old objective',
        actorUserId: 'UOWNER',
        queueWhileRunning: true,
        goalOpeningId: 'g1',
      });
      await b.controller.start({ sessionKey: KEY, text: 'next word', actorUserId: 'UOWNER', queueWhileRunning: true });
      h.session.goal = undefined; // `goal clear` meanwhile
      b.release();
      await first.done;
      await vi.waitFor(() => expect(b.inputs).toHaveLength(2));
      expect(b.inputs.map((i) => i.text)).toEqual(['work', 'next word']);
      expect(h.goalCommands.openingDropped).toHaveBeenCalledWith(KEY, h.session, 'g1', 'stale');
      expect(h.session.taskFollowups ?? []).toHaveLength(0);
    });

    it('cancelling a queued opening tells the goal commands (its goal pauses, first turn owed)', async () => {
      const h = goalHarness();
      h.session.goal = { goalId: 'g1', status: 'active', openingPending: true };
      const b = blocking(h);
      const first = await b.controller.start({ sessionKey: KEY, text: 'work', actorUserId: 'UOWNER' });
      await b.controller.start({
        sessionKey: KEY,
        text: 'objective',
        actorUserId: 'UOWNER',
        queueWhileRunning: true,
        goalOpeningId: 'g1',
      });
      const item = h.session.taskFollowups[0];
      const res = await b.controller.actOnQueue({
        sessionKey: KEY,
        itemId: item.id,
        epoch: item.epoch,
        op: 'cancel',
        actorUserId: 'UOWNER',
      });
      expect(res.ok).toBe(true);
      expect(h.goalCommands.openingDropped).toHaveBeenCalledWith(KEY, h.session, 'g1', 'cancelled');
      b.release();
      await first.done;
    });

    // astra-zhuge #876 R1 P1 — a goal command in the queue (saved before #865) is answered, not refused.
    it('a goal command found in the queue is answered at the drain — never paused as a refusal; the next word runs', async () => {
      const h = goalHarness();
      const b = blocking(h);
      const first = await b.controller.start({ sessionKey: KEY, text: 'work', actorUserId: 'UOWNER' });
      h.session.taskFollowups = [
        { id: 'tq-old', text: 'goal clear', authorId: 'UOWNER', enqueuedAt: 1, epoch: 0, state: 'queued' },
        { id: 'tq-next', text: 'next word', authorId: 'UOWNER', enqueuedAt: 2, epoch: 0, state: 'queued' },
      ];
      b.release();
      await first.done;
      await vi.waitFor(() => expect(b.inputs).toHaveLength(2));
      expect(h.ran).toEqual([{ text: 'goal clear', actor: 'UOWNER' }]);
      expect(b.inputs[1].text).toBe('next word');
      // Both left the queue: the answered command and the word that became the turn (never paused).
      await vi.waitFor(() => expect(h.session.taskFollowups ?? []).toHaveLength(0));
    });

    // #876 R2 — the opening starts only while its goal's first turn is owed, by whatever path.
    it('a goal’s opening starts only while owed: it clears the debt when its chain starts; a stale one is refused (409)', async () => {
      const h = goalHarness();
      h.session.goal = { goalId: 'g1', status: 'active', openingPending: true };
      const r = await h.controller.start({
        sessionKey: KEY,
        text: 'ship it',
        actorUserId: 'UOWNER',
        goalOpeningId: 'g1',
      });
      expect(r.status).toBe(202);
      await r.done;
      expect(h.session.goal.openingPending).toBeUndefined();
      // The same opening again (an approval released after the goal opened, cleared or moved on): refused.
      const again = await h.controller.start({
        sessionKey: KEY,
        text: 'ship it',
        actorUserId: 'UOWNER',
        goalOpeningId: 'g1',
      });
      expect(again.status).toBe(409);
      h.session.goal = undefined;
      const cleared = await h.controller.start({
        sessionKey: KEY,
        text: 'ship it',
        actorUserId: 'UOWNER',
        goalOpeningId: 'g1',
      });
      expect(cleared.status).toBe(409);
      expect(h.inputs).toHaveLength(1);
    });

    it('a goal’s opening is not a new word to its goal: the user hook is not told (grok P2)', async () => {
      const h = goalHarness();
      h.session.goal = { goalId: 'g1', status: 'active', openingPending: true };
      const r = await h.controller.start({
        sessionKey: KEY,
        text: 'ship it',
        actorUserId: 'UOWNER',
        goalOpeningId: 'g1',
      });
      await r.done;
      expect(h.onUserInstruction).not.toHaveBeenCalled();
      expect(h.inputs[0].params?.isUserInput).toBe(true);
    });

    it('a goal’s queued first turn is not edited (fable P2): 409', async () => {
      const h = goalHarness();
      h.session.goal = { goalId: 'g1', status: 'active', openingPending: true };
      const b = blocking(h);
      const first = await b.controller.start({ sessionKey: KEY, text: 'work', actorUserId: 'UOWNER' });
      await b.controller.start({
        sessionKey: KEY,
        text: 'objective',
        actorUserId: 'UOWNER',
        queueWhileRunning: true,
        goalOpeningId: 'g1',
      });
      const item = h.session.taskFollowups[0];
      const res = await b.controller.actOnQueue({
        sessionKey: KEY,
        itemId: item.id,
        epoch: item.epoch,
        op: 'edit',
        text: 'something else',
        actorUserId: 'UOWNER',
      });
      expect(res).toMatchObject({ ok: false, status: 409 });
      b.release();
      await first.done;
    });

    it('a new task may start with `goal <objective>`, not with a goal command that has no goal to act on (fable P2)', () => {
      const h = goalHarness();
      expect(h.controller.canStart('UOWNER', 'goal ship it')).toBeNull();
      expect(h.controller.canStart('UOWNER', '/goal ship it')).toBeNull();
      for (const text of ['goal clear', 'goal', 'goal pause', 'goal max 5']) {
        expect(h.controller.canStart('UOWNER', text)?.status).toBe(400);
      }
    });

    it('a queued word cannot be edited into a goal command (it applies at once — send it)', async () => {
      const h = goalHarness();
      const b = blocking(h);
      const first = await b.controller.start({ sessionKey: KEY, text: 'work', actorUserId: 'UOWNER' });
      await b.controller.start({ sessionKey: KEY, text: 'later', actorUserId: 'UOWNER', queueWhileRunning: true });
      const item = h.session.taskFollowups[0];
      const res = await b.controller.actOnQueue({
        sessionKey: KEY,
        itemId: item.id,
        epoch: item.epoch,
        op: 'edit',
        text: 'goal clear',
        actorUserId: 'UOWNER',
      });
      expect(res).toMatchObject({ ok: false, status: 400 });
      b.release();
      await first.done;
    });
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
