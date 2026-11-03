/**
 * A dashboard task's follow-up queue (2026-11-03): an instruction sent while
 * the task's chain runs waits for its next step instead of the 409 the start
 * answered before ("a turn is already running on this task").
 *
 *   Q1 the dashboard's word (`queueWhileRunning`) to a running task is queued (202) — a host start still answers 409.
 *   Q2 every refusal a start makes still applies to a queued word (command, attachments, nobody, epic owner rule, closing).
 *   Q3 at the chain's end the oldest queued word starts as the next chain, as its writer — one per chain end, in order.
 *   Q4 a chain that did not end well (stopped, failed, interrupted) runs nothing: its queue pauses with the reason.
 *   Q5 a drained word the start refuses goes back to the head, paused with the refusal.
 *   Q6 the queue's controls: cancel, edit (the writer's), send now — idle starts it, running puts it first.
 *   Q7 the queue is bounded.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTaskTurnController, type TaskTurnControllerDeps } from '../task-turn-controller';
import type { RunTaskTurnInput, RunTaskTurnResult } from '../task-turn-runner';

const KEY = 'task:11111111-2222-4333-8444-555555555555';
const CTX = (userId = 'UOWNER') => ({ origin: 'task', userId, workingDirectory: '/work/UOWNER/t' }) as any;

const ended = (outcome: 'completed' | 'failed' | 'waiting' | 'interrupted' | 'cancelled', turnId = 't') =>
  ({
    turnId,
    outcome: {
      turnId,
      outcome,
      category:
        outcome === 'completed' ? 'WorkflowComplete' : outcome === 'waiting' ? 'UIUserAskQuestion' : 'Exception',
      at: 1,
    },
  }) as RunTaskTurnResult;

function fakeCoordinator() {
  const controllers = new Map<string, AbortController>();
  return {
    controllers,
    setController: vi.fn((k: string, ac: AbortController) => {
      controllers.set(k, ac);
    }),
    removeController: vi.fn((k: string, expected?: AbortController) => {
      if (expected && controllers.get(k) !== expected) return;
      controllers.delete(k);
    }),
    abortSession: (k: string, reason: string) => {
      const ac = controllers.get(k);
      if (!ac) return false;
      ac.abort(reason);
      return true;
    },
  };
}

/** A turn that starts and waits for `release()` before it ends with `result`. */
function held(result: RunTaskTurnResult = ended('completed')) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const step = async (input: RunTaskTurnInput) => {
    input.onStarted?.();
    await gate;
    return result;
  };
  return { step, release: () => release() };
}

type Step = RunTaskTurnResult | ((input: RunTaskTurnInput) => Promise<RunTaskTurnResult>);

function harness(over: Partial<TaskTurnControllerDeps> = {}, steps: Step[] = []) {
  const sessions = new Map<string, any>([
    [KEY, { slackless: true, ownerId: 'UOWNER', ownerName: 'Owner', taskId: 'a' }],
  ]);
  const inputs: RunTaskTurnInput[] = [];
  const queue = [...steps];
  const runTaskTurn = vi.fn(async (input: RunTaskTurnInput) => {
    inputs.push(input);
    const next = queue.shift() ?? ended('completed');
    if (typeof next === 'function') return next(input);
    input.onStarted?.();
    return next;
  });
  const coordinator = fakeCoordinator();
  const abandonTurn = vi.fn(async (_key: string, turnId: string, decided: any) => ({
    turnId,
    outcome: { ...decided, turnId, at: 1 },
  }));
  const changed = vi.fn();
  const buildExecutionContext = vi.fn((_s: any, actor?: string) => CTX(actor));
  const deps: TaskTurnControllerDeps = {
    runner: { runTaskTurn, abandonTurn },
    getSession: (k) => sessions.get(k),
    coordinator,
    buildExecutionContext,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onFollowupsChanged: changed,
    ...over,
  };
  const controller = createTaskTurnController(deps);
  const task = () => sessions.get(KEY);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { controller, sessions, inputs, runTaskTurn, coordinator, deps, changed, buildExecutionContext, task, settle };
}

const word = (text: string, actorUserId = 'UOWNER') => ({
  sessionKey: KEY,
  text,
  actorUserId,
  queueWhileRunning: true,
});

describe('Q1 — a word to a running task is queued, not refused', () => {
  it('the dashboard’s word while a chain runs answers 202 queued and is listed on the task', async () => {
    const turn = held();
    const h = harness({}, [turn.step]);
    const first = await h.controller.start(word('one'));
    expect(first.status).toBe(202);

    const r = await h.controller.start(word('goal 설정해줘', 'UOTHER'));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, queued: true });
    expect(typeof r.body.itemId).toBe('string');
    expect(h.task().taskFollowups).toEqual([
      expect.objectContaining({
        id: r.body.itemId,
        text: 'goal 설정해줘',
        authorId: 'UOTHER',
        state: 'queued',
        epoch: 0,
      }),
    ]);
    expect(h.changed).toHaveBeenCalledWith(KEY);
    // Nothing ran for it yet: one turn so far.
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
    turn.release();
    await first.done;
  });

  it('a host start (no queueWhileRunning) still answers 409 and queues nothing', async () => {
    const turn = held();
    const h = harness({}, [turn.step]);
    const first = await h.controller.start(word('one'));
    const r = await h.controller.start({ sessionKey: KEY, text: 'wake', actorUserId: 'UOWNER', initiator: 'host' });
    expect(r).toMatchObject({ status: 409, body: { error: 'a turn is already running on this task' } });
    expect(h.task().taskFollowups ?? []).toEqual([]);
    turn.release();
    await first.done;
  });

  it('an idle task’s word starts at once, as before (nothing queued)', async () => {
    const h = harness();
    const r = await h.controller.start(word('go'));
    expect(r.status).toBe(202);
    expect(r.body.queued).toBeUndefined();
    await r.done;
    expect(h.task().taskFollowups ?? []).toEqual([]);
  });
});

describe('Q2 — a queued word meets the refusals a start makes', () => {
  it.each([
    ['a slash command', { text: '/model opus' }, 400],
    ['a session command', { text: '%effort high' }, 400],
    ['attachments', { text: 'go', attachments: [{ name: 'a.png' }] }, 400],
    ['nobody signed in', { text: 'go', actorUserId: '' }, 403],
  ])('refuses %s while the chain runs', async (_name, extra, status) => {
    const turn = held();
    const h = harness({}, [turn.step]);
    const first = await h.controller.start(word('one'));
    const r = await h.controller.start({ ...word('x'), ...extra });
    expect(r.status).toBe(status);
    expect(h.task().taskFollowups ?? []).toEqual([]);
    turn.release();
    await first.done;
  });

  it('a task being closed queues nothing (409)', async () => {
    const turn = held();
    const h = harness({}, [turn.step]);
    const first = await h.controller.start(word('one'));
    h.task().closing = true;
    expect((await h.controller.start(word('two'))).status).toBe(409);
    expect(h.task().taskFollowups ?? []).toEqual([]);
    h.task().closing = undefined;
    turn.release();
    await first.done;
  });

  it('another user’s word to an epic is refused (403), as its start would be', async () => {
    const turn = held();
    const h = harness({}, [turn.step]);
    h.task().kind = 'epic';
    const first = await h.controller.start(word('one'));
    const r = await h.controller.start(word('two', 'UOTHER'));
    expect(r.status).toBe(403);
    expect(h.task().taskFollowups ?? []).toEqual([]);
    turn.release();
    await first.done;
  });
});

describe('Q3 — the chain’s end runs the next queued word', () => {
  it('runs the oldest queued word as its writer, one per chain end, in order', async () => {
    const one = held();
    const two = held();
    const h = harness({}, [one.step, two.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two', 'UOTHER'));
    await h.controller.start(word('three'));
    expect(h.task().taskFollowups.map((i: any) => i.text)).toEqual(['two', 'three']);

    one.release();
    await first.done;
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'two']);
    // As its writer (SSOT 2026-11-02: a turn runs as the user who instructed it).
    expect(h.buildExecutionContext).toHaveBeenLastCalledWith(h.task(), 'UOTHER');
    expect(h.inputs[1].executionContext.userId).toBe('UOTHER');
    expect(h.task().taskFollowups.map((i: any) => i.text)).toEqual(['three']);
    expect(h.controller.isRunning(KEY)).toBe(true);

    two.release();
    await h.settle();
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'two', 'three']);
    expect(h.task().taskFollowups ?? []).toEqual([]);
  });

  it('a chain that ended on a question (waiting) runs the next word too', async () => {
    const one = held(ended('waiting'));
    const h = harness({}, [one.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    one.release();
    await first.done;
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'two']);
  });

  it('the queued word starts before an epic’s wake (onChainEnd is told after the drain)', async () => {
    const one = held();
    const order: string[] = [];
    const h = harness(
      {
        onChainEnd: () => {
          order.push(`end:${h.controller.isRunning(KEY) ? 'busy' : 'idle'}`);
        },
      },
      [one.step],
    );
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    one.release();
    await first.done;
    await h.settle();
    // The first chain's end found the task already running the queued word (the drained chain's own end follows).
    expect(order[0]).toBe('end:busy');
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'two']);
  });

  it('a shutdown keeps the queue as it is and runs nothing', async () => {
    const one = held();
    const h = harness({}, [one.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    h.controller.stopAccepting();
    one.release();
    await first.done;
    await h.settle();
    expect(h.inputs).toHaveLength(1);
    expect(h.task().taskFollowups).toEqual([expect.objectContaining({ text: 'two', state: 'queued' })]);
  });
});

describe('Q4 — a chain that did not end well runs nothing and pauses the queue', () => {
  it.each([
    ['failed', ended('failed')],
    ['interrupted', ended('interrupted')],
  ])('%s: the words stay, paused with the reason', async (_name, result) => {
    const one = held(result);
    const h = harness({}, [one.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    one.release();
    await first.done;
    await h.settle();
    expect(h.inputs).toHaveLength(1);
    expect(h.task().taskFollowups).toEqual([
      expect.objectContaining({ text: 'two', state: 'paused', stateReason: expect.any(String), epoch: 1 }),
    ]);
  });

  it('a Stop pauses the queue — the stopped work is not followed by the next word', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        await new Promise<void>((resolve) =>
          (input.params as any).abortController.signal.addEventListener('abort', () => resolve()),
        );
        return ended('cancelled');
      },
    ]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    h.coordinator.abortSession(KEY, 'user-stop');
    await first.done;
    await h.settle();
    expect(h.inputs).toHaveLength(1);
    expect(h.task().taskFollowups).toEqual([expect.objectContaining({ text: 'two', state: 'paused' })]);
  });

  it('a paused word is not run by the next healthy chain end — only Send now runs it', async () => {
    const one = held(ended('failed'));
    const two = held();
    const h = harness({}, [one.step, two.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    one.release();
    await first.done;
    await h.settle();
    const again = await h.controller.start(word('three'));
    expect(again.status).toBe(202);
    expect(again.body.queued).toBeUndefined();
    two.release();
    await again.done;
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'three']);
    expect(h.task().taskFollowups).toEqual([expect.objectContaining({ text: 'two', state: 'paused' })]);
  });
});

describe('Q5 — a drained word the start refuses goes back, paused', () => {
  it('the start window refuses it: back at the head, paused with the refusal', async () => {
    const one = held();
    const h = harness({ maxStartsPerWindow: 1 }, [one.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    await h.controller.start(word('three'));
    one.release();
    await first.done;
    await h.settle();
    expect(h.inputs).toHaveLength(1);
    expect(h.task().taskFollowups).toEqual([
      expect.objectContaining({ text: 'two', state: 'paused', stateReason: expect.stringMatching(/too many/) }),
      expect.objectContaining({ text: 'three', state: 'queued' }),
    ]);
  });
});

describe('Q6 — the queue’s controls', () => {
  async function queuedTwo() {
    const one = held();
    const h = harness({}, [one.step]);
    const first = await h.controller.start(word('one'));
    const q = await h.controller.start(word('two', 'UOTHER'));
    return { h, one, first, id: String(q.body.itemId) };
  }

  it('cancel: the writer (or a manager) takes it off; anyone else is refused', async () => {
    const { h, one, first, id } = await queuedTwo();
    expect(
      await h.controller.actOnQueue({ sessionKey: KEY, itemId: id, op: 'cancel', epoch: 0, actorUserId: 'UTHIRD' }),
    ).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await h.controller.actOnQueue({ sessionKey: KEY, itemId: id, op: 'cancel', epoch: 0, actorUserId: 'UOTHER' }),
    ).toMatchObject({
      ok: true,
    });
    expect(h.task().taskFollowups ?? []).toEqual([]);
    one.release();
    await first.done;
    await h.settle();
    expect(h.inputs).toHaveLength(1);
  });

  it('a manager cancels someone else’s word', async () => {
    const { h, one, first, id } = await queuedTwo();
    expect(
      await h.controller.actOnQueue({
        sessionKey: KEY,
        itemId: id,
        op: 'cancel',
        epoch: 0,
        actorUserId: 'UOWNER',
        manages: true,
      }),
    ).toMatchObject({ ok: true });
    expect(h.task().taskFollowups ?? []).toEqual([]);
    one.release();
    await first.done;
  });

  it('edit: the writer’s own words only; a command or a stale epoch is refused', async () => {
    const { h, one, first, id } = await queuedTwo();
    expect(
      await h.controller.actOnQueue({
        sessionKey: KEY,
        itemId: id,
        op: 'edit',
        epoch: 0,
        text: 'x',
        actorUserId: 'UOWNER',
        manages: true,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await h.controller.actOnQueue({
        sessionKey: KEY,
        itemId: id,
        op: 'edit',
        epoch: 0,
        text: '/model x',
        actorUserId: 'UOTHER',
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await h.controller.actOnQueue({
        sessionKey: KEY,
        itemId: id,
        op: 'edit',
        epoch: 0,
        text: '수정본',
        actorUserId: 'UOTHER',
      }),
    ).toMatchObject({ ok: true });
    expect(h.task().taskFollowups).toEqual([expect.objectContaining({ id, text: '수정본', epoch: 1 })]);
    expect(
      await h.controller.actOnQueue({
        sessionKey: KEY,
        itemId: id,
        op: 'edit',
        epoch: 0,
        text: 'old view',
        actorUserId: 'UOTHER',
      }),
    ).toMatchObject({ ok: false, status: 409 });
    one.release();
    await first.done;
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['one', '수정본']);
  });

  it('send now while the chain runs: the word goes first in line and is queued again', async () => {
    const one = held(ended('failed'));
    const two = held();
    const h = harness({}, [one.step, two.step]);
    const first = await h.controller.start(word('one'));
    const a = await h.controller.start(word('a'));
    await h.controller.start(word('b'));
    one.release();
    await first.done;
    await h.settle();
    // Both paused by the failed chain; a new word starts at once.
    const busy = await h.controller.start(word('c'));
    expect(busy.status).toBe(202);
    const r = await h.controller.actOnQueue({
      sessionKey: KEY,
      itemId: String(a.body.itemId),
      op: 'promote',
      epoch: 1,
      actorUserId: 'UOWNER',
    });
    expect(r).toMatchObject({ ok: true, message: expect.any(String) });
    expect(h.task().taskFollowups.map((i: any) => [i.text, i.state])).toEqual([
      ['a', 'queued'],
      ['b', 'paused'],
    ]);
    two.release();
    await busy.done;
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'c', 'a']);
  });

  it('send now on an idle task starts the word at once, as its writer', async () => {
    const one = held(ended('failed'));
    const h = harness({}, [one.step]);
    const first = await h.controller.start(word('one'));
    const q = await h.controller.start(word('two', 'UOTHER'));
    one.release();
    await first.done;
    await h.settle();
    const r = await h.controller.actOnQueue({
      sessionKey: KEY,
      itemId: String(q.body.itemId),
      op: 'promote',
      epoch: 1,
      actorUserId: 'UOWNER',
      manages: true,
    });
    expect(r).toMatchObject({ ok: true });
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'two']);
    expect(h.inputs[1].executionContext.userId).toBe('UOTHER');
    expect(h.task().taskFollowups ?? []).toEqual([]);
  });

  it('send now refused by the start leaves the word with the refusal', async () => {
    const one = held(ended('failed'));
    const h = harness({ maxStartsPerWindow: 1 }, [one.step]);
    const first = await h.controller.start(word('one'));
    const q = await h.controller.start(word('two'));
    one.release();
    await first.done;
    await h.settle();
    const r = await h.controller.actOnQueue({
      sessionKey: KEY,
      itemId: String(q.body.itemId),
      op: 'promote',
      epoch: 1,
      actorUserId: 'UOWNER',
    });
    expect(r).toMatchObject({ ok: false, status: 429 });
    expect(h.task().taskFollowups).toEqual([expect.objectContaining({ text: 'two', state: 'paused' })]);
  });

  it('send now by someone who neither wrote it nor manages the task is refused', async () => {
    const { h, one, first, id } = await queuedTwo();
    expect(
      await h.controller.actOnQueue({ sessionKey: KEY, itemId: id, op: 'promote', epoch: 0, actorUserId: 'UTHIRD' }),
    ).toMatchObject({ ok: false, status: 403 });
    one.release();
    await first.done;
  });

  it('an unknown note is 404', async () => {
    const { h, one, first } = await queuedTwo();
    expect(
      await h.controller.actOnQueue({
        sessionKey: KEY,
        itemId: 'nope',
        op: 'cancel',
        epoch: 0,
        actorUserId: 'UOWNER',
        manages: true,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    one.release();
    await first.done;
  });
});

describe('Q7 — the queue is bounded', () => {
  it('a full queue refuses the next word (429)', async () => {
    const one = held();
    const h = harness({ maxQueuedFollowups: 2 }, [one.step]);
    const first = await h.controller.start(word('one'));
    expect((await h.controller.start(word('a'))).status).toBe(202);
    expect((await h.controller.start(word('b'))).status).toBe(202);
    const r = await h.controller.start(word('c'));
    expect(r.status).toBe(429);
    expect(h.task().taskFollowups).toHaveLength(2);
    one.release();
    await first.done;
  });
});
