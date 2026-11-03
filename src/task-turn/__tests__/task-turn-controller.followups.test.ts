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
 *   Q8 after a restart, an idle task no chain will end for sends its oldest queued word (owner directive 2026-11-03).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TASK_FOLLOWUP_PAUSED_BEHIND_REFUSED,
  TASK_FOLLOWUP_PAUSED_BY_STOP,
  TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END,
} from '../task-followups';
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
      // No chain end is coming for the words behind it: they pause too (review R1, fable P2).
      expect.objectContaining({ text: 'three', state: 'paused', stateReason: TASK_FOLLOWUP_PAUSED_BEHIND_REFUSED }),
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

describe('R1 — the #767 approval backstop at the drain (review R1: astra P0, fable P1)', () => {
  const heldAnswer = {
    status: 202,
    body: { ok: true, pendingApproval: true, requestId: 'r1', message: '작업 소유자의 승인을 기다립니다' },
  };

  it('a one-time approved word, unedited, runs without asking again', async () => {
    const one = held();
    const holdQueued = vi.fn(() => Promise.resolve(heldAnswer));
    const h = harness({ holdQueued }, [one.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start({ ...word('approved words', 'UOTHER'), approvedOnce: true });
    one.release();
    await first.done;
    await h.settle();
    expect(holdQueued).not.toHaveBeenCalled();
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'approved words']);
  });

  it('a one-time approved word edited by its writer goes back to the owner — the next word runs', async () => {
    const one = held();
    // The owner may always instruct; UOTHER only through the one-time approval of the words the owner saw.
    const holdQueued = vi.fn((_k: string, _s: any, item: any) =>
      item.authorId === 'UOTHER' ? Promise.resolve(heldAnswer) : undefined,
    );
    const h = harness({ holdQueued }, [one.step]);
    const first = await h.controller.start(word('one'));
    const q = await h.controller.start({ ...word('approved words', 'UOTHER'), approvedOnce: true });
    await h.controller.start(word('owner next'));
    expect(
      await h.controller.actOnQueue({
        sessionKey: KEY,
        itemId: String(q.body.itemId),
        op: 'edit',
        epoch: 0,
        text: 'rm -rf everything',
        actorUserId: 'UOTHER',
      }),
    ).toMatchObject({ ok: true });
    one.release();
    await first.done;
    await h.settle();
    await h.settle();
    expect(holdQueued).toHaveBeenCalledWith(
      KEY,
      h.task(),
      expect.objectContaining({ text: 'rm -rf everything', authorId: 'UOTHER' }),
    );
    // Never run as UOTHER's unapproved words; it left the queue for the owner's approval.
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'owner next']);
    expect(h.task().taskFollowups ?? []).toEqual([]);
  });

  it('a word whose writer may no longer instruct on their own is held, not run', async () => {
    const one = held();
    const holdQueued = vi.fn((_k: string, _s: any, item: any) =>
      item.authorId === 'UOTHER' ? Promise.resolve(heldAnswer) : undefined,
    );
    const h = harness({ holdQueued }, [one.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('trusted once', 'UOTHER'));
    one.release();
    await first.done;
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['one']);
    expect(h.task().taskFollowups ?? []).toEqual([]);
  });

  it('an allowed writer is decided at once: the drained word still outranks the epic wake', async () => {
    const one = held();
    const order: string[] = [];
    const holdQueued = vi.fn(() => undefined);
    const h = harness(
      {
        holdQueued,
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
    expect(order[0]).toBe('end:busy');
  });

  it('a hold refused (too many waiting) puts the word back, paused with the reason', async () => {
    const one = held();
    const holdQueued = vi.fn(() =>
      Promise.resolve({ status: 429, body: { error: '승인을 기다리는 지시가 너무 많습니다' } }),
    );
    const h = harness({ holdQueued }, [one.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two', 'UOTHER'));
    one.release();
    await first.done;
    await h.settle();
    expect(h.task().taskFollowups).toEqual([
      expect.objectContaining({ text: 'two', state: 'paused', stateReason: '승인을 기다리는 지시가 너무 많습니다' }),
    ]);
  });

  it('send now on a word that must be approved says it waits for the owner', async () => {
    const one = held(ended('failed'));
    const holdQueued = vi.fn(() => Promise.resolve(heldAnswer));
    const h = harness({ holdQueued }, [one.step]);
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
    expect(r).toEqual({ ok: true, message: '작업 소유자의 승인을 기다립니다' });
    expect(h.inputs).toHaveLength(1);
    expect(h.task().taskFollowups ?? []).toEqual([]);
  });
});

describe('R1 — a chain’s end is judged by its own last hop (review R1: astra P1)', () => {
  it('a compaction that completed, then a re-run that threw: the queue pauses, nothing runs', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        h.task().fallbackCompactPendingUserText = 'original';
        return { turnId: 'a', outcome: null, nonTerminal: 'fallbackCompact' } as any;
      },
      async (input) => {
        h.task().fallbackCompactPendingUserText = null;
        input.onStarted?.();
        // Queued while the compaction runs.
        await h.controller.start(word('queued after original'));
        return ended('completed', 'c');
      },
      async (input) => {
        input.onStarted?.();
        throw new Error('execute failed');
      },
    ]);
    const r = await h.controller.start(word('original'));
    await r.done;
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['original', '/compact', 'original']);
    expect(h.task().taskFollowups).toEqual([
      expect.objectContaining({
        text: 'queued after original',
        state: 'paused',
        stateReason: TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END,
      }),
    ]);
  });
});

describe('R1 — no queued word is left with no chain end coming (review R1: grok P1, fable P2)', () => {
  it('a refused shutdown pauses the words its abort left queued', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        await new Promise<void>((resolve) =>
          (input.params as any).abortController.signal.addEventListener('abort', () => resolve()),
        );
        return { turnId: 't', outcome: null, nonTerminal: 'shutdown' } as any;
      },
    ]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    h.controller.stopAccepting();
    h.coordinator.abortSession(KEY, 'shutdown');
    await first.done;
    expect(h.task().taskFollowups).toEqual([expect.objectContaining({ text: 'two', state: 'queued' })]);
    h.controller.resumeAccepting();
    expect(h.task().taskFollowups).toEqual([
      expect.objectContaining({ text: 'two', state: 'paused', stateReason: TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END }),
    ]);
  });

  it('a start that throws puts the word back, paused — it is never lost', async () => {
    const one = held();
    const h = harness({}, [one.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    // The next start's controller registration throws (after admission).
    h.coordinator.setController.mockImplementationOnce(() => {
      throw new Error('coordinator down');
    });
    one.release();
    await first.done;
    await h.settle();
    expect(h.task().taskFollowups).toEqual([
      expect.objectContaining({ text: 'two', state: 'paused', stateReason: expect.stringMatching(/coordinator down/) }),
    ]);
  });
});

describe('R2 — a word in flight stays on record until its handoff is confirmed (review R2: astra P0)', () => {
  it('while the owner’s approval is being asked, the saved queue still holds the word (sending); after, it is gone', async () => {
    const one = held();
    let answer!: (r: any) => void;
    const pending = new Promise<any>((r) => {
      answer = r;
    });
    const saved: any[][] = [];
    const h = harness(
      {
        holdQueued: (_k: string, _s: any, item: any) => (item.authorId === 'UOTHER' ? pending : undefined),
        onFollowupsChanged: () => saved.push(structuredClone(h.task().taskFollowups ?? [])),
      },
      [one.step],
    );
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two', 'UOTHER'));
    one.release();
    await first.done;
    await h.settle();
    // What a save now would write: the word, marked as being sent — a crash here loses nothing.
    expect(saved[saved.length - 1]).toEqual([expect.objectContaining({ text: 'two', state: 'sending' })]);
    expect(h.task().taskFollowups).toEqual([expect.objectContaining({ text: 'two', state: 'sending' })]);
    // Its controls wait until it is settled.
    const id = h.task().taskFollowups[0].id;
    expect(
      await h.controller.actOnQueue({
        sessionKey: KEY,
        itemId: id,
        op: 'cancel',
        epoch: h.task().taskFollowups[0].epoch,
        actorUserId: 'UOTHER',
      }),
    ).toMatchObject({ ok: false, status: 409 });
    answer({ status: 202, body: { ok: true, pendingApproval: true } });
    await h.settle();
    expect(saved[saved.length - 1]).toEqual([]);
    expect(h.inputs.map((i) => i.text)).toEqual(['one']);
  });

  it('a drained word stays on record (sending) until its turn’s start is saved, then leaves', async () => {
    const one = held();
    let begin!: () => void;
    const gate = new Promise<void>((r) => {
      begin = r;
    });
    const saved: any[][] = [];
    const h = harness({ onFollowupsChanged: () => saved.push(structuredClone(h.task().taskFollowups ?? [])) }, [
      one.step,
      async (input) => {
        await gate;
        input.onStarted?.();
        return ended('completed', 'b');
      },
    ]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    one.release();
    await first.done;
    await h.settle();
    expect(saved[saved.length - 1]).toEqual([expect.objectContaining({ text: 'two', state: 'sending' })]);
    begin();
    await h.settle();
    await h.settle();
    expect(saved[saved.length - 1]).toEqual([]);
  });
});

describe('Q8 — after a restart, an idle task sends its queued words (owner directive 2026-11-03)', () => {
  const restored = (id: string, text: string, authorId = 'UOWNER', state: 'queued' | 'paused' = 'queued') => ({
    id,
    text,
    authorId,
    enqueuedAt: 1,
    epoch: 1,
    state,
    ...(state === 'paused' ? { stateReason: TASK_FOLLOWUP_PAUSED_BY_STOP } : {}),
  });

  it('starts the oldest queued word as its writer; the rest follow at its chain’s healthy end; a stopped word stays', async () => {
    const h = harness();
    h.task().taskFollowups = [
      restored('p', 'stopped', 'UOWNER', 'paused'),
      restored('a', 'first', 'UOTHER'),
      restored('b', 'second'),
    ];
    expect(h.controller.runQueuedAfterRestart(KEY)).toBe('sent');
    await h.settle();
    await h.settle();
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['first', 'second']);
    expect(h.inputs[0].executionContext.userId).toBe('UOTHER');
    expect(h.task().taskFollowups).toEqual([expect.objectContaining({ id: 'p', state: 'paused' })]);
  });

  it('a running task sends nothing now — its chain’s end runs the word', async () => {
    const turn = held();
    const h = harness({}, [turn.step]);
    const first = await h.controller.start(word('one'));
    await h.controller.start(word('two'));
    expect(h.controller.runQueuedAfterRestart(KEY)).toBe('busy');
    expect(h.inputs).toHaveLength(1);
    expect(h.task().taskFollowups).toEqual([expect.objectContaining({ text: 'two', state: 'queued', epoch: 0 })]);
    turn.release();
    await first.done;
    await h.settle();
    expect(h.inputs.map((i) => i.text)).toEqual(['one', 'two']);
  });

  it.each([
    ['being closed', (t: any) => (t.closing = true)],
    ['terminated', (t: any) => (t.terminated = true)],
  ])('a task %s sends nothing and keeps its words', async (_name, mark) => {
    const h = harness();
    h.task().taskFollowups = [restored('a', 'first')];
    mark(h.task());
    expect(h.controller.runQueuedAfterRestart(KEY)).toBe('busy');
    await h.settle();
    expect(h.runTaskTurn).not.toHaveBeenCalled();
    expect(h.task().taskFollowups).toEqual([restored('a', 'first')]);
  });

  it('a service that is not accepting starts sends nothing', async () => {
    const h = harness();
    h.task().taskFollowups = [restored('a', 'first')];
    h.controller.stopAccepting();
    expect(h.controller.runQueuedAfterRestart(KEY)).toBe('busy');
    await h.settle();
    expect(h.runTaskTurn).not.toHaveBeenCalled();
  });

  it('nothing queued (only paused words), or no dashboard task: none', () => {
    const h = harness();
    h.task().taskFollowups = [restored('p', 'stopped', 'UOWNER', 'paused')];
    expect(h.controller.runQueuedAfterRestart(KEY)).toBe('none');
    expect(h.controller.runQueuedAfterRestart('task:missing')).toBe('none');
    h.sessions.set('slack', { ownerId: 'UOWNER', taskFollowups: [restored('a', 'first')] });
    expect(h.controller.runQueuedAfterRestart('slack')).toBe('none');
    expect(h.runTaskTurn).not.toHaveBeenCalled();
  });

  it('the owner’s slot is taken: nothing changes (try again later); the last try starts it, and its refusal pauses it with why', async () => {
    const turn = held();
    const h = harness({}, [turn.step]);
    const OTHER = 'task:99999999-2222-4333-8444-555555555555';
    h.sessions.set(OTHER, { slackless: true, ownerId: 'UOWNER', ownerName: 'Owner', taskId: 'b' });
    const busy = await h.controller.start({ sessionKey: OTHER, text: 'other work', actorUserId: 'UOWNER' });
    expect(busy.status).toBe(202);
    h.task().taskFollowups = [restored('a', 'first'), restored('b', 'second')];
    expect(h.controller.runQueuedAfterRestart(KEY)).toBe('slot-busy');
    expect(h.task().taskFollowups).toEqual([restored('a', 'first'), restored('b', 'second')]);
    expect(h.changed).not.toHaveBeenCalledWith(KEY);

    expect(h.controller.runQueuedAfterRestart(KEY, { lastTry: true })).toBe('sent');
    await h.settle();
    expect(h.task().taskFollowups).toEqual([
      expect.objectContaining({ id: 'a', state: 'paused', stateReason: expect.stringMatching(/one dashboard task/) }),
      expect.objectContaining({ id: 'b', state: 'paused', stateReason: TASK_FOLLOWUP_PAUSED_BEHIND_REFUSED }),
    ]);
    turn.release();
    await busy.done;
  });
});
