/**
 * #598 ④b1 — the task runner's commit (design 598b v5 §8, §9, §14.1): one
 * terminalizer per turn. Order: drain the turn's work-log receipts → decide
 * (question re-read at decision time) → current-turn fence → write
 * `lastTurnOutcome` → strict save (rolled back on failure) → the only
 * idle/waiting transition.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTaskTurnRunner, type TaskTurnRunnerDeps } from '../task-turn-runner';

const KEY = 'task:11111111-2222-4333-8444-555555555555';

function harness(over: Partial<TaskTurnRunnerDeps> = {}) {
  const session: any = { slackless: true, taskId: '11111111-2222-4333-8444-555555555555', ownerId: 'U1' };
  const events: string[] = [];
  const registry = {
    getSessionByKey: vi.fn((k: string) => (k === KEY ? session : undefined)),
    persistSessionStrict: vi.fn(() => {
      events.push(`save:${session.lastTurnOutcome?.outcome}`);
    }),
    setActivityStateByKey: vi.fn((_k: string, state: string) => {
      events.push(`activity:${state}:${session.lastTurnOutcome?.outcome}`);
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
    ...over,
  };
  const runner = createTaskTurnRunner(deps);
  const input = { sessionKey: KEY, executionContext: { origin: 'task' } as any, text: 'do it' };
  return { session, registry, execute, deps, runner, input, events };
}

describe('createTaskTurnRunner (#598 ④b1)', () => {
  it('commits in order: outcome → strict save → idle; idle hooks see the new outcome', async () => {
    const h = harness();
    const r = await h.runner.runTaskTurn(h.input);
    expect(r.outcome?.outcome).toBe('completed');
    expect(h.events).toEqual(['activity:working:undefined', 'save:completed', 'activity:idle:completed']);
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
    expect(h.events[h.events.length - 1]).toBe('activity:waiting:waiting');
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
    const first = await h.runner.runTaskTurn(h.input);
    expect(first.outcome).toBeNull();
    expect(first.continuation).toEqual({ prompt: 'next' });
    expect(h.registry.persistSessionStrict).not.toHaveBeenCalled();
    expect(h.events).toEqual(['activity:working:undefined']);
    const second = await h.runner.runTaskTurn(h.input);
    expect(second.outcome).toMatchObject({ outcome: 'failed', reason: 'record: EIO' });
  });

  it('a strict-save failure restores the previous outcome, sends no idle, and reaches the caller', async () => {
    const h = harness();
    h.session.lastTurnOutcome = { turnId: 'old', outcome: 'completed', category: 'WorkflowComplete', at: 1 };
    h.registry.persistSessionStrict.mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    await expect(h.runner.runTaskTurn(h.input)).rejects.toThrow('ENOSPC');
    expect(h.session.lastTurnOutcome).toEqual({
      turnId: 'old',
      outcome: 'completed',
      category: 'WorkflowComplete',
      at: 1,
    });
    expect(h.events.filter((e) => e.startsWith('activity:idle'))).toEqual([]);
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
    expect(h.registry.persistSessionStrict).toHaveBeenCalledTimes(1);
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
    await h.runner.runTaskTurn(h.input);
    await h.runner.runTaskTurn(h.input);
    const last = await h.runner.runTaskTurn(h.input);
    expect(last.outcome).toMatchObject({ outcome: 'failed', reason: 'record: EIO-first' });
  });
});
