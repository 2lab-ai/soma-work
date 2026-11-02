/**
 * #598 ④b1 — the task runner's commit (design 598b v5 §8, §9, §14.1): one
 * terminalizer per turn. Order: drain the turn's work-log receipts → decide
 * (question re-read at decision time) → current-turn fence → one strict
 * commit of the outcome and the end activity (`commitTaskTurnOutcome`, which
 * restores both and throws on failure; idle hooks run after the write).
 * A non-terminal return nobody will resume is committed as `interrupted`.
 */

import { TaskTurnRefusedError } from '@soma/slack/task-turn/task-turn-refused';
import { describe, expect, it, vi } from 'vitest';
import { createTaskTurnRunner, type TaskTurnRunnerDeps } from '../task-turn-runner';

const KEY = 'task:11111111-2222-4333-8444-555555555555';

function harness(over: Partial<TaskTurnRunnerDeps> = {}) {
  const session: any = { slackless: true, taskId: '11111111-2222-4333-8444-555555555555', ownerId: 'U1' };
  const events: string[] = [];
  const registry = {
    getSessionByKey: vi.fn((k: string) => (k === KEY ? session : undefined)),
    commitTaskTurnOutcome: vi.fn((_k: string, record: any, activity: string) => {
      session.lastTurnOutcome = record;
      session.activityState = activity;
      events.push(`commit:${record.outcome}:${activity}`);
    }),
    holdUnsavedTaskTurnOutcome: vi.fn((_k: string, record: any, activity: string) => {
      session.lastTurnOutcome = record;
      session.activityState = activity;
      events.push(`hold:${record.outcome}:${activity}`);
    }),
    beginTaskTurn: vi.fn((_k: string, turnId: string) => {
      session.activityState = 'working';
      session.activeTaskTurnId = turnId;
      events.push('begin');
    }),
  };
  const execute = vi.fn(
    async (_params: any) =>
      ({ success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } }) as any,
  );
  const deps: TaskTurnRunnerDeps = {
    registry,
    execute,
    createConversation: vi.fn(async () => 'conv-1'),
    receipts: { open: vi.fn(), drain: vi.fn(async () => undefined) },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    commitRetryDelaysMs: [0, 0, 0],
    ...over,
  };
  const runner = createTaskTurnRunner(deps);
  const input = { sessionKey: KEY, executionContext: { origin: 'task' } as any, text: 'do it' };
  return { session, registry, execute, deps, runner, input, events };
}

describe('createTaskTurnRunner (#598 ④b1)', () => {
  it('commits once: working, then outcome + idle in one strict commit', async () => {
    const h = harness();
    const r = await h.runner.runTaskTurn(h.input);
    expect(r.outcome?.outcome).toBe('completed');
    expect(h.events).toEqual(['begin', 'commit:completed:idle']);
    expect(h.session.lastTurnOutcome).toMatchObject({ outcome: 'completed', category: 'WorkflowComplete' });
    expect(typeof h.session.lastTurnOutcome.turnId).toBe('string');
  });

  it('creates the task’s conversation durably before the first turn, and binds the turn to it', async () => {
    const h = harness();
    await h.runner.runTaskTurn(h.input);
    expect(h.session.conversationId).toBe('conv-1');
    const params = h.execute.mock.calls[0][0];
    expect(params.taskBinding).toMatchObject({ sessionKey: KEY, conversationId: 'conv-1' });
    expect(params.executionContext).toBe(h.input.executionContext);
    expect(h.deps.receipts.open).toHaveBeenCalledWith(params.taskBinding);
  });

  it('a conversation that cannot be created fails the turn before the model runs', async () => {
    const h = harness({
      createConversation: vi.fn(async () => {
        throw new Error('ENOSPC');
      }),
    });
    const r = await h.runner.runTaskTurn(h.input);
    expect(h.execute).not.toHaveBeenCalled();
    expect(r.outcome).toMatchObject({ outcome: 'failed', reason: 'record: conversation not created' });
    expect(h.session.lastTurnOutcome?.outcome).toBe('failed');
  });

  it('a waiting turn ends in waiting', async () => {
    const h = harness({
      execute: vi.fn(
        async () =>
          ({
            success: true,
            messageCount: 1,
            terminal: { exit: 'success', endTurnInfoPresent: true, choiceStillOpen: () => true },
          }) as any,
      ),
    });
    await h.runner.runTaskTurn(h.input);
    expect(h.events[h.events.length - 1]).toBe('commit:waiting:waiting');
  });

  it('the question is re-read after the receipt drain — an answer during the drain completes the turn', async () => {
    let open = true;
    const h = harness({
      execute: vi.fn(
        async () =>
          ({
            success: true,
            messageCount: 1,
            terminal: { exit: 'success', endTurnInfoPresent: true, choiceStillOpen: () => open },
          }) as any,
      ),
      receipts: {
        open: vi.fn(),
        drain: vi.fn(async () => {
          open = false;
          return undefined;
        }),
      },
    });
    const r = await h.runner.runTaskTurn(h.input);
    expect(r.outcome?.outcome).toBe('completed');
  });

  it('a failed receipt turns completed into failed (record: …)', async () => {
    const h = harness({ receipts: { open: vi.fn(), drain: vi.fn(async () => 'ENOSPC') } });
    const r = await h.runner.runTaskTurn(h.input);
    expect(r.outcome).toMatchObject({ outcome: 'failed', reason: 'record: ENOSPC' });
  });

  it('a non-terminal return commits nothing, stays working, and carries its recording failure to the next terminal commit', async () => {
    const results = [
      { success: true, messageCount: 1, continuation: { prompt: 'next' } },
      { success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } },
    ];
    const drains = ['EIO', undefined];
    const h = harness({
      execute: vi.fn(async () => results.shift() as any),
      receipts: { open: vi.fn(), drain: vi.fn(async () => drains.shift()) },
    });
    const first = await h.runner.runTaskTurn({ ...h.input, resumable: ['continuation'] });
    expect(first.outcome).toBeNull();
    expect(first.nonTerminal).toBe('continuation');
    expect(first.continuation).toEqual({ prompt: 'next' });
    expect(h.registry.commitTaskTurnOutcome).not.toHaveBeenCalled();
    expect(h.events).toEqual(['begin']);
    const second = await h.runner.runTaskTurn({ ...h.input, resumable: ['continuation'] });
    expect(second.outcome).toMatchObject({ outcome: 'failed', reason: 'record: EIO' });
  });

  it('a commit that keeps failing is retried (persistence only), then held in memory as unsaved — never re-run', async () => {
    const h = harness();
    h.registry.commitTaskTurnOutcome.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    const r = await h.runner.runTaskTurn(h.input);
    expect(h.registry.commitTaskTurnOutcome).toHaveBeenCalledTimes(4); // first try + 3 retries
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({
      unsaved: true,
      outcome: { outcome: 'completed', recordFailure: 'outcome not saved: ENOSPC' },
    });
    // No chain on this input: nothing to settle (E2 ③).
    expect(h.registry.holdUnsavedTaskTurnOutcome).toHaveBeenCalledWith(KEY, r.outcome, 'idle', undefined);
    expect(h.deps.logger.error).toHaveBeenCalled();
  });

  it('a commit that fails once and then lands is committed normally', async () => {
    const h = harness();
    h.registry.commitTaskTurnOutcome.mockImplementationOnce(() => {
      throw new Error('EAGAIN');
    });
    const r = await h.runner.runTaskTurn(h.input);
    expect(r.unsaved).toBeUndefined();
    expect(h.events).toEqual(['begin', 'commit:completed:idle']);
    expect(h.registry.holdUnsavedTaskTurnOutcome).not.toHaveBeenCalled();
  });

  it('an older turn’s late commit is fenced out — it never writes the outcome or moves activity', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let call = 0;
    const h = harness({
      execute: vi.fn(async () => {
        call += 1;
        if (call === 1) await gate;
        return { success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } } as any;
      }),
    });
    const first = h.runner.runTaskTurn(h.input);
    await Promise.resolve();
    const second = await h.runner.runTaskTurn(h.input); // a newer turn starts and finishes
    releaseFirst();
    const firstResult = await first;
    expect(second.outcome?.outcome).toBe('completed');
    expect(firstResult.fenced).toBe(true);
    expect(h.session.lastTurnOutcome.turnId).toBe(second.turnId);
    expect(h.registry.commitTaskTurnOutcome).toHaveBeenCalledTimes(1);
  });

  it('a session that is not a Slack-less task is refused', async () => {
    const h = harness();
    h.session.slackless = undefined;
    await expect(h.runner.runTaskTurn(h.input)).rejects.toThrow(/not a Slack-less task/);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('two failing non-terminal returns: the first recording failure is the one reported (#626 R1)', async () => {
    const results = [
      { success: true, messageCount: 1, continuation: { prompt: 'a' } },
      { success: true, messageCount: 1, continuation: { prompt: 'b' } },
      { success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } },
    ];
    const drains = ['EIO-first', 'EIO-second', undefined];
    const h = harness({
      execute: vi.fn(async () => results.shift() as any),
      receipts: { open: vi.fn(), drain: vi.fn(async () => drains.shift()) },
    });
    const resumes = { ...h.input, resumable: ['continuation'] as const };
    await h.runner.runTaskTurn(resumes);
    await h.runner.runTaskTurn(resumes);
    const last = await h.runner.runTaskTurn(resumes);
    expect(last.outcome).toMatchObject({ outcome: 'failed', reason: 'record: EIO-first' });
  });

  it('a continuation with no re-entry wired is committed as interrupted — never left working (#626 R1, §9)', async () => {
    const h = harness({
      execute: vi.fn(async () => ({ success: true, messageCount: 1, continuation: { prompt: 'next' } }) as any),
      receipts: { open: vi.fn(), drain: vi.fn(async () => 'EIO') },
    });
    const r = await h.runner.runTaskTurn(h.input);
    expect(r.outcome).toMatchObject({ outcome: 'interrupted', reason: 're-entry not wired', recordFailure: 'EIO' });
    expect(h.events).toEqual(['begin', 'commit:interrupted:idle']);
  });

  it('a fallback compaction is a non-terminal return the caller re-enters with /compact (#626 R1)', async () => {
    const terminal = { exit: 'success', endTurnInfoPresent: false, fallbackCompact: true };
    const wired = harness({
      execute: vi.fn(async () => ({ success: true, messageCount: 1, terminal }) as any),
    });
    const r = await wired.runner.runTaskTurn({ ...wired.input, resumable: ['fallbackCompact'] });
    expect(r).toMatchObject({ outcome: null, nonTerminal: 'fallbackCompact' });
    expect(wired.registry.commitTaskTurnOutcome).not.toHaveBeenCalled();

    const unwired = harness({ execute: vi.fn(async () => ({ success: true, messageCount: 1, terminal }) as any) });
    const u = await unwired.runner.runTaskTurn(unwired.input);
    expect(u.outcome).toMatchObject({ outcome: 'interrupted', reason: 're-entry not wired' });
  });

  it('a no-terminal abort (supersede) commits nothing and names why', async () => {
    const h = harness({
      execute: vi.fn(
        async () => ({ success: false, messageCount: 0, terminal: { exit: 'abort', abortReason: 'supersede' } }) as any,
      ),
    });
    const r = await h.runner.runTaskTurn(h.input);
    expect(r).toMatchObject({ outcome: null, nonTerminal: 'supersede' });
    expect(h.registry.commitTaskTurnOutcome).not.toHaveBeenCalled();
  });

  it('a return with neither terminal signals nor a continuation is committed as interrupted', async () => {
    const h = harness({ execute: vi.fn(async () => ({ success: true, messageCount: 1 }) as any) });
    const r = await h.runner.runTaskTurn(h.input);
    expect(r.outcome).toMatchObject({ outcome: 'interrupted', reason: 'turn ended without an outcome' });
  });

  it('two concurrent first turns create one conversation (#626 R1)', async () => {
    let release!: (id: string) => void;
    const createConversation = vi.fn(
      () =>
        new Promise<string>((r) => {
          release = r;
        }),
    );
    const h = harness({ createConversation });
    const a = h.runner.runTaskTurn(h.input);
    const b = h.runner.runTaskTurn(h.input);
    await Promise.resolve();
    release('conv-once');
    await Promise.all([a, b]);
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(h.session.conversationId).toBe('conv-once');
    for (const call of h.execute.mock.calls) expect(call[0].taskBinding.conversationId).toBe('conv-once');
  });

  describe('④c — the caller says what it resumes; the start is saved; a refused turn ends', () => {
    it('the turn start is saved (beginTaskTurn with the turn id) before the model runs', async () => {
      const h = harness();
      const order: string[] = [];
      h.registry.beginTaskTurn.mockImplementation((_k: string, id: string) => {
        order.push(`begin:${id}`);
      });
      h.execute.mockImplementation(async (params: any) => {
        order.push(`execute:${params.taskBinding.turnId}`);
        return { success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } } as any;
      });
      const r = await h.runner.runTaskTurn(h.input);
      expect(order).toEqual([`begin:${r.turnId}`, `execute:${r.turnId}`]);
    });

    it('a start that cannot be saved runs nothing and reaches the caller', async () => {
      const h = harness();
      h.registry.beginTaskTurn.mockImplementation(() => {
        throw new Error('ENOSPC');
      });
      await expect(h.runner.runTaskTurn(h.input)).rejects.toThrow('ENOSPC');
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.deps.receipts.open).not.toHaveBeenCalled();
    });

    it('a non-terminal kind the caller does not resume is committed interrupted with the caller’s reason', async () => {
      const h = harness({
        execute: vi.fn(
          async () =>
            ({ success: false, messageCount: 0, terminal: { exit: 'error', abortReason: 'supersede' } }) as any,
        ),
      });
      const r = await h.runner.runTaskTurn({
        ...h.input,
        resumable: ['fallbackCompact'],
        notResumedReasons: { supersede: 'superseded by another run' },
      });
      expect(r.outcome).toMatchObject({ outcome: 'interrupted', reason: 'superseded by another run' });
    });

    it('with no resumable list, a supersede stays non-terminal (④b1 behaviour) and a continuation is not wired', async () => {
      const sup = harness({
        execute: vi.fn(
          async () =>
            ({ success: false, messageCount: 0, terminal: { exit: 'error', abortReason: 'supersede' } }) as any,
        ),
      });
      expect(await sup.runner.runTaskTurn(sup.input)).toMatchObject({ outcome: null, nonTerminal: 'supersede' });
      const cont = harness({
        execute: vi.fn(async () => ({ success: true, messageCount: 1, continuation: { prompt: 'x' } }) as any),
      });
      expect((await cont.runner.runTaskTurn(cont.input)).outcome).toMatchObject({ reason: 're-entry not wired' });
    });

    it('an unresumed fallback compaction disarms the session — the next turn is not a compact turn on the 1M model', async () => {
      const h = harness({
        execute: vi.fn(async () => {
          Object.assign(h.session, {
            model: 'opus[1m]',
            fallbackCompactActive: true,
            fallbackCompactOriginalModel: 'sonnet',
            fallbackCompactPendingUserText: 'do it',
            fallbackCompactPendingEventContext: { channel: '', user: 'U1', ts: '1' },
          });
          return { success: false, messageCount: 0, terminal: { exit: 'error', fallbackCompact: true } } as any;
        }),
      });
      const r = await h.runner.runTaskTurn(h.input);
      expect(r.outcome).toMatchObject({ outcome: 'interrupted', reason: 're-entry not wired' });
      expect(h.session).toMatchObject({
        model: 'sonnet',
        fallbackCompactActive: false,
        fallbackCompactOriginalModel: null,
        fallbackCompactPendingUserText: null,
        fallbackCompactPendingEventContext: null,
      });
    });

    it('a refused turn (TaskTurnRefusedError) is committed failed with its code, then rethrown', async () => {
      const refused = new TaskTurnRefusedError('followup-epoch', 'refused: epoch');
      const h = harness({
        execute: vi.fn(async () => {
          throw refused;
        }),
      });
      await expect(h.runner.runTaskTurn(h.input)).rejects.toBe(refused);
      expect(h.deps.receipts.drain).toHaveBeenCalled();
      expect(h.session.lastTurnOutcome).toMatchObject({
        outcome: 'failed',
        category: 'Exception',
        reason: 'refused: followup-epoch',
      });
      expect(h.events).toEqual(['begin', 'commit:failed:idle']);
    });

    it('any other throw out of execute is committed failed too — the task never stays working', async () => {
      const h = harness({
        execute: vi.fn(async () => {
          throw new Error('boom');
        }),
      });
      await expect(h.runner.runTaskTurn(h.input)).rejects.toThrow('boom');
      expect(h.session.lastTurnOutcome).toMatchObject({ outcome: 'failed', reason: 'turn threw: boom' });
    });
  });

  describe('④c v2 — compaction proof, start signal, fenced non-terminal', () => {
    it('onStarted fires after the start is saved and before the model runs; never when the start fails', async () => {
      const order: string[] = [];
      const h = harness();
      h.registry.beginTaskTurn.mockImplementation(() => {
        order.push('begin');
      });
      h.execute.mockImplementation(async () => {
        order.push('execute');
        return { success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } } as any;
      });
      await h.runner.runTaskTurn({ ...h.input, onStarted: () => order.push('started') });
      expect(order).toEqual(['begin', 'started', 'execute']);

      const f = harness();
      f.registry.beginTaskTurn.mockImplementation(() => {
        throw new Error('ENOSPC');
      });
      const started = vi.fn();
      await expect(f.runner.runTaskTurn({ ...f.input, onStarted: started })).rejects.toThrow('ENOSPC');
      expect(started).not.toHaveBeenCalled();
    });

    it('a compact hop that "completed" with the fallback still armed did not compact: failed, and the session is disarmed', async () => {
      const h = harness();
      Object.assign(h.session, {
        model: 'opus[1m]',
        fallbackCompactActive: true,
        fallbackCompactOriginalModel: 'sonnet',
      });
      const r = await h.runner.runTaskTurn({ ...h.input, text: '/compact', compactHop: true });
      expect(r.outcome).toMatchObject({
        outcome: 'failed',
        category: 'Exception',
        reason: 'compaction did not complete',
      });
      expect(h.session).toMatchObject({ model: 'sonnet', fallbackCompactActive: false });
    });

    it('a compact hop whose boundary disarmed the session stays completed', async () => {
      const h = harness();
      h.execute.mockImplementation(async () => {
        Object.assign(h.session, { fallbackCompactActive: false });
        return { success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } } as any;
      });
      Object.assign(h.session, { fallbackCompactActive: true, fallbackCompactOriginalModel: 'sonnet' });
      const r = await h.runner.runTaskTurn({ ...h.input, text: '/compact', compactHop: true });
      expect(r.outcome?.outcome).toBe('completed');
    });

    it('an old turn’s non-terminal return after a newer turn started is fenced — no hop, no carried failure', async () => {
      let releaseFirst!: () => void;
      const gate = new Promise<void>((r) => {
        releaseFirst = r;
      });
      let call = 0;
      let oldTurnId = '';
      const h = harness({
        execute: vi.fn(async (params: any) => {
          call += 1;
          if (call === 1) {
            oldTurnId = params.taskBinding.turnId;
            await gate;
            return { success: false, messageCount: 0, terminal: { exit: 'error', fallbackCompact: true } } as any;
          }
          return { success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } } as any;
        }),
        // Only the old turn's work log failed to record.
        receipts: { open: vi.fn(), drain: vi.fn(async (b: any) => (b.turnId === oldTurnId ? 'EIO-old' : undefined)) },
      });
      const first = h.runner.runTaskTurn({ ...h.input, resumable: ['fallbackCompact'] });
      await Promise.resolve();
      await Promise.resolve();
      const second = await h.runner.runTaskTurn(h.input);
      releaseFirst();
      const old = await first;
      expect(old).toMatchObject({ outcome: null, fenced: true });
      expect(old.nonTerminal).toBeUndefined();
      expect(second.outcome?.outcome).toBe('completed');
      const third = await h.runner.runTaskTurn(h.input);
      expect(third.outcome?.recordFailure).toBeUndefined();
    });
  });

  describe('#634 R1 — abandoning a pending non-terminal turn', () => {
    it('abandonTurn disarms an armed fallback and commits the turn with the caller’s outcome and the carried failure', async () => {
      const h = harness({
        execute: vi.fn(async () => {
          Object.assign(h.session, {
            model: 'opus[1m]',
            fallbackCompactActive: true,
            fallbackCompactOriginalModel: 'sonnet',
          });
          return { success: false, messageCount: 0, terminal: { exit: 'error', fallbackCompact: true } } as any;
        }),
        receipts: { open: vi.fn(), drain: vi.fn(async () => 'EIO') },
      });
      const first = await h.runner.runTaskTurn({ ...h.input, resumable: ['fallbackCompact'] });
      expect(first.nonTerminal).toBe('fallbackCompact');
      const r = await h.runner.abandonTurn(KEY, first.turnId, {
        outcome: 'cancelled',
        category: 'Exception',
        reason: 'stopped by user',
      });
      expect(r.outcome).toMatchObject({ outcome: 'cancelled', reason: 'stopped by user', recordFailure: 'EIO' });
      expect(h.session).toMatchObject({ model: 'sonnet', fallbackCompactActive: false });
      expect(h.events[h.events.length - 1]).toBe('commit:cancelled:idle');
    });

    it('a later turn whose start was not saved does not take the fence — the earlier pending turn can still be abandoned', async () => {
      const h = harness({
        execute: vi.fn(
          async () => ({ success: false, messageCount: 0, terminal: { exit: 'error', fallbackCompact: true } }) as any,
        ),
      });
      const first = await h.runner.runTaskTurn({ ...h.input, resumable: ['fallbackCompact'] });
      h.registry.beginTaskTurn.mockImplementationOnce(() => {
        throw new Error('ENOSPC');
      });
      await expect(h.runner.runTaskTurn(h.input)).rejects.toThrow('ENOSPC');
      const r = await h.runner.abandonTurn(KEY, first.turnId, {
        outcome: 'interrupted',
        category: 'Exception',
        reason: 'turn start not saved',
      });
      expect(r.fenced).toBeUndefined();
      expect(r.outcome).toMatchObject({ outcome: 'interrupted', reason: 'turn start not saved' });
    });

    it('abandoning a turn that a newer turn replaced is fenced', async () => {
      const h = harness({
        execute: vi.fn(
          async () => ({ success: false, messageCount: 0, terminal: { exit: 'error', fallbackCompact: true } }) as any,
        ),
      });
      const first = await h.runner.runTaskTurn({ ...h.input, resumable: ['fallbackCompact'] });
      h.execute.mockImplementationOnce(
        async () =>
          ({ success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } }) as any,
      );
      await h.runner.runTaskTurn(h.input);
      const r = await h.runner.abandonTurn(KEY, first.turnId, { outcome: 'cancelled', category: 'Exception' });
      expect(r).toMatchObject({ outcome: null, fenced: true });
    });
  });

  describe('#626 R2 astra / #634 — a fenced turn touches nothing; the first recording failure wins', () => {
    const terminalOk = { success: true, messageCount: 1, terminal: { exit: 'success', endTurnInfoPresent: true } };

    it('carried + a failing terminal drain: the carried (first) failure is reported', async () => {
      const results = [{ success: true, messageCount: 1, continuation: { prompt: 'a' } }, terminalOk];
      const drains = ['EIO-first', 'EIO-second'];
      const h = harness({
        execute: vi.fn(async () => results.shift() as any),
        receipts: { open: vi.fn(), drain: vi.fn(async () => drains.shift()) },
      });
      await h.runner.runTaskTurn({ ...h.input, resumable: ['continuation'] });
      const last = await h.runner.runTaskTurn(h.input);
      expect(last.outcome).toMatchObject({ outcome: 'failed', reason: 'record: EIO-first' });
    });

    it('an older turn released after a newer one took the task neither consumes its carried failure nor disarms its fallback', async () => {
      let releaseOld!: () => void;
      const gate = new Promise<void>((r) => {
        releaseOld = r;
      });
      let call = 0;
      const h = harness({
        execute: vi.fn(async () => {
          call += 1;
          if (call === 1) {
            await gate;
            return terminalOk as any; // the old compact hop "completes" late
          }
          // The newer turn overflows: fallback armed, its recording failed.
          Object.assign(h.session, {
            model: 'opus[1m]',
            fallbackCompactActive: true,
            fallbackCompactOriginalModel: 'sonnet',
          });
          return { success: false, messageCount: 0, terminal: { exit: 'error', fallbackCompact: true } } as any;
        }),
      });
      const old = h.runner.runTaskTurn({ ...h.input, text: '/compact', compactHop: true });
      await Promise.resolve();
      await Promise.resolve();
      const newer = await h.runner.runTaskTurn({ ...h.input, resumable: ['fallbackCompact'] });
      expect(newer.nonTerminal).toBe('fallbackCompact');
      releaseOld();
      const oldResult = await old;
      expect(oldResult).toMatchObject({ outcome: null, fenced: true });
      // The newer turn's armed fallback is untouched by the old compact hop.
      expect(h.session).toMatchObject({ fallbackCompactActive: true, model: 'opus[1m]' });
    });

    it('a throw out of execute keeps the carried failure of an earlier hop', async () => {
      const h = harness();
      h.execute
        .mockImplementationOnce(async () => ({ success: true, messageCount: 1, continuation: { prompt: 'a' } }) as any)
        .mockImplementationOnce(async () => {
          throw new Error('boom');
        });
      h.deps.receipts.drain = vi.fn().mockResolvedValueOnce('EIO-hop1').mockResolvedValueOnce(undefined);
      const runner2 = (await import('../task-turn-runner')).createTaskTurnRunner(h.deps);
      await runner2.runTaskTurn({ ...h.input, resumable: ['continuation'] });
      await expect(runner2.runTaskTurn(h.input)).rejects.toThrow('boom');
      expect(h.session.lastTurnOutcome).toMatchObject({
        outcome: 'failed',
        reason: 'turn threw: boom',
        recordFailure: 'EIO-hop1',
      });
    });
  });

  it('a compact hop that throws disarms the fallback before committing failed (astra #634)', async () => {
    const h = harness({
      execute: vi.fn(async () => {
        throw new Error('compact crashed');
      }),
    });
    Object.assign(h.session, {
      model: 'opus[1m]',
      fallbackCompactActive: true,
      fallbackCompactOriginalModel: 'sonnet',
      fallbackCompactPendingUserText: 'original instruction',
    });
    await expect(h.runner.runTaskTurn({ ...h.input, text: '/compact', compactHop: true })).rejects.toThrow(
      'compact crashed',
    );
    expect(h.session).toMatchObject({
      model: 'sonnet',
      fallbackCompactActive: false,
      fallbackCompactPendingUserText: null,
    });
    expect(h.session.lastTurnOutcome?.outcome).toBe('failed');
  });
});
