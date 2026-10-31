/**
 * #598 ④c — the task turn's caller (design 598c §1–§5 + v2): a dashboard
 * instruction on a Slack-less task is refused (D8, D9) or accepted once its
 * turn's start is saved; its chain runs in the background — re-entering a
 * fallback compaction within a dispatch budget, stoppable at any point through
 * one chain-level abort, never retried automatically.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTaskTurnController, type TaskTurnControllerDeps } from '../task-turn-controller';
import type { RunTaskTurnInput, RunTaskTurnResult } from '../task-turn-runner';

const KEY = 'task:11111111-2222-4333-8444-555555555555';
const KEY2 = 'task:22222222-2222-4333-8444-555555555555';
const CTX = { origin: 'task', userId: 'UOWNER', workingDirectory: '/work/UOWNER/t' } as any;

const completed = (turnId = 't'): RunTaskTurnResult => ({
  turnId,
  outcome: { turnId, outcome: 'completed', category: 'WorkflowComplete', at: 1 },
});

/** The coordinator's real contract: one controller per key, CAS removal, abort by key. */
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

type Step = RunTaskTurnResult | Error | ((input: RunTaskTurnInput) => Promise<RunTaskTurnResult>);

function harness(over: Partial<TaskTurnControllerDeps> = {}, steps: Step[] = []) {
  const sessions = new Map<string, any>([
    [KEY, { slackless: true, ownerId: 'UOWNER', ownerName: 'Owner', taskId: 'a' }],
    [KEY2, { slackless: true, ownerId: 'UOWNER', ownerName: 'Owner', taskId: 'b' }],
  ]);
  const inputs: RunTaskTurnInput[] = [];
  const queue = [...steps];
  const runTaskTurn = vi.fn(async (input: RunTaskTurnInput) => {
    inputs.push(input);
    const next = queue.shift() ?? completed();
    if (typeof next === 'function') return next(input);
    input.onStarted?.();
    if (next instanceof Error) throw next;
    return next;
  });
  const coordinator = fakeCoordinator();
  const abandonTurn = vi.fn(async (_key: string, turnId: string, decided: any) => ({
    turnId,
    outcome: { ...decided, turnId, at: 1 },
  }));
  const deps: TaskTurnControllerDeps = {
    runner: { runTaskTurn, abandonTurn },
    getSession: (k) => sessions.get(k),
    coordinator,
    buildExecutionContext: vi.fn(() => CTX),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  const controller = createTaskTurnController(deps);
  return { controller, sessions, inputs, runTaskTurn, abandonTurn, coordinator, deps };
}

describe('TaskTurnController — refusals (598c §1)', () => {
  it.each([
    ['attachments', { text: 'go', attachments: [{ name: 'a.png' }] }, 400, /attachments/],
    ['a slash command', { text: '/model opus' }, 400, /commands are not supported/],
    ['/compact with arguments', { text: '/compact focus on tests' }, 400, /commands are not supported/],
    [
      '/compact (no boundary signal to prove it on a task — #634 R1)',
      { text: '/compact' },
      400,
      /commands are not supported/,
    ],
    ['a session command', { text: '%effort high' }, 400, /commands are not supported/],
  ])('refuses %s before anything runs', async (_name, req, status, error) => {
    const h = harness();
    const r = await h.controller.start({ sessionKey: KEY, ...req });
    expect(r.status).toBe(status);
    expect(String(r.body.error)).toMatch(error);
    expect(h.runTaskTurn).not.toHaveBeenCalled();
  });

  it.each([
    ['/tmp-like path first: /work/x 파일 봐줘'],
    ['2/3를 계산해'],
    ['50% 진행'],
  ])('does not refuse an instruction that only starts like a command: %s', async (text) => {
    const h = harness();
    const r = await h.controller.start({ sessionKey: KEY, text: text.replace('/tmp-like path first: ', '') });
    expect(r.status).toBe(202);
    await r.done;
  });

  it('refuses a session that is not a Slack-less task', async () => {
    const h = harness();
    h.sessions.get(KEY).slackless = undefined;
    expect((await h.controller.start({ sessionKey: KEY, text: 'go' })).status).toBe(409);
  });

  it('a task whose execution context cannot be built answers 409 with the reason', async () => {
    const h = harness({
      buildExecutionContext: () => {
        throw Object.assign(new Error('task has no absolute working directory'), {
          name: 'ExecutionContextMissingError',
        });
      },
    });
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    expect(r).toMatchObject({
      status: 409,
      body: { error: 'task cannot run: task has no absolute working directory' },
    });
    expect(h.runTaskTurn).not.toHaveBeenCalled();
  });

  it('after stopAccepting (shutdown) a start answers 503; resumeAccepting (a refused shutdown) re-opens it', async () => {
    const h = harness();
    h.controller.stopAccepting();
    expect((await h.controller.start({ sessionKey: KEY, text: 'go' })).status).toBe(503);
    h.controller.resumeAccepting();
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    expect(r.status).toBe(202);
    await r.done;
  });
});

describe('TaskTurnController — D9 and the busy task (598c §2)', () => {
  it('a second instruction on a running task is 409; on another task of the same owner 429; both free after the chain', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        await gate;
        return completed();
      },
    ]);
    const first = await h.controller.start({ sessionKey: KEY, text: 'one' });
    expect(first.status).toBe(202);
    expect((await h.controller.start({ sessionKey: KEY, text: 'two' })).status).toBe(409);
    expect((await h.controller.start({ sessionKey: KEY2, text: 'other' })).status).toBe(429);
    release();
    await first.done;
    expect((await h.controller.start({ sessionKey: KEY2, text: 'other' })).status).toBe(202);
  });

  it('the window bound refuses the 11th start in 10 minutes', async () => {
    let t = 0;
    const h = harness({ now: () => t });
    for (let i = 0; i < 10; i++) {
      const r = await h.controller.start({ sessionKey: KEY, text: `n${i}` });
      expect(r.status).toBe(202);
      await r.done;
      t += 1000;
    }
    expect((await h.controller.start({ sessionKey: KEY, text: 'n10' })).status).toBe(429);
    t += 10 * 60_000;
    expect((await h.controller.start({ sessionKey: KEY, text: 'later' })).status).toBe(202);
  });

  it('a start answered 500 does not use up the owner’s start window (#634 R1)', async () => {
    let t = 0;
    const h = harness({ now: () => t, maxStartsPerWindow: 2 });
    for (let i = 0; i < 3; i++) {
      h.runTaskTurn.mockImplementationOnce(async () => {
        throw new Error('ENOSPC');
      });
      expect((await h.controller.start({ sessionKey: KEY, text: `n${i}` })).status).toBe(500);
      t += 1000;
    }
    const ok = await h.controller.start({ sessionKey: KEY, text: 'now it saves' });
    expect(ok.status).toBe(202);
    await ok.done;
  });

  it('the cap is released after a chain that throws after acceptance', async () => {
    const h = harness({}, [new Error('boom')]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    expect(r.status).toBe(202);
    await r.done;
    expect(h.deps.logger.error).toHaveBeenCalled();
    expect((await h.controller.start({ sessionKey: KEY, text: 'again' })).status).toBe(202);
  });
});

describe('TaskTurnController — acceptance and the chain (598c §3–§5, v2)', () => {
  it('a turn whose start is not saved answers 500 and frees the task', async () => {
    const h = harness({}, [
      async () => {
        throw new Error('ENOSPC');
      },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    expect(r.status).toBe(500);
    expect(h.coordinator.controllers.size).toBe(0);
    expect((await h.controller.start({ sessionKey: KEY, text: 'go' })).status).toBe(202);
  });

  it('accepts once the start is saved, before the turn ends; the first hop is user input with the context', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        await gate;
        return completed();
      },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'do it' });
    expect(r.status).toBe(202);
    const input = h.inputs[0];
    expect(input).toMatchObject({ sessionKey: KEY, executionContext: CTX, text: 'do it' });
    expect(input.params).toMatchObject({ isUserInput: true, userName: 'Owner', workingDirectory: '/work/UOWNER/t' });
    expect(input.resumable).toEqual(['fallbackCompact', 'shutdown']);
    expect(input.notResumedReasons?.continuation).toBe('continuation not supported on a dashboard task yet');
    expect(h.coordinator.controllers.get(KEY)).toBeDefined();
    release();
    await r.done;
    expect(h.coordinator.controllers.has(KEY)).toBe(false);
  });

  it('the chain’s abort stays registered across hops: the executor’s CAS removal of a hop controller does not drop it', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        // The executor removes its own (hop) controller at its end.
        h.coordinator.removeController(KEY, input.params?.abortController as AbortController);
        expect(h.coordinator.controllers.has(KEY)).toBe(true);
        return completed();
      },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    await r.done;
  });

  it('Stop between hops (after a fallback hop, before /compact) ends the chain — no further hop', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        h.sessions.get(KEY).fallbackCompactPendingUserText = 'big';
        // Stop lands while the runner drains, after the executor's controller is gone.
        h.coordinator.abortSession(KEY, 'user-stop');
        return { turnId: 'a', outcome: null, nonTerminal: 'fallbackCompact' };
      },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'big' });
    await r.done;
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
    // The pending fallback turn is ended — cancelled — not left working on the 1M model (#634 R1).
    expect(h.abandonTurn).toHaveBeenCalledWith(KEY, 'a', expect.objectContaining({ outcome: 'cancelled' }));
  });

  it('a later hop whose start is not saved ends the pending fallback turn interrupted (#634 R1)', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        h.sessions.get(KEY).fallbackCompactPendingUserText = 'big';
        return { turnId: 'a', outcome: null, nonTerminal: 'fallbackCompact' };
      },
      async () => {
        throw new Error('ENOSPC');
      },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'big' });
    expect(r.status).toBe(202);
    await r.done;
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'a',
      expect.objectContaining({ outcome: 'interrupted', reason: 'turn start not saved: ENOSPC' }),
    );
  });

  it('a shutdown between hops leaves the pending turn for restart reconciliation (no abandon)', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        h.coordinator.abortSession(KEY, 'shutdown');
        return { turnId: 'a', outcome: null, nonTerminal: 'fallbackCompact' };
      },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'big' });
    await r.done;
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
    expect(h.abandonTurn).not.toHaveBeenCalled();
  });

  it('Stop during a hop aborts that hop’s controller with the stop reason', async () => {
    let seen: unknown;
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        const hop = input.params?.abortController as AbortController;
        h.coordinator.abortSession(KEY, 'user-stop');
        seen = hop.signal.aborted ? hop.signal.reason : undefined;
        return completed();
      },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    await r.done;
    expect(seen).toBe('user-stop');
  });

  it('close() aborts the chain with session-close and resolves after it ends', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reason: unknown;
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        const hop = input.params?.abortController as AbortController;
        hop.signal.addEventListener('abort', () => {
          reason = hop.signal.reason;
          release();
        });
        await gate;
        return completed();
      },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    await h.controller.close(KEY);
    expect(reason).toBe('session-close');
    await r.done;
  });

  it('a chain that committed an outcome before its start (conversation not created) does not put the question back', async () => {
    const h = harness({}, [
      {
        turnId: 'a',
        outcome: {
          turnId: 'a',
          outcome: 'failed',
          category: 'Exception',
          at: 1,
          reason: 'record: conversation not created',
        },
      },
    ]);
    h.runTaskTurn.mockImplementationOnce(async (input: RunTaskTurnInput) => {
      h.inputs.push(input);
      return { turnId: 'a', outcome: { turnId: 'a', outcome: 'failed', category: 'Exception', at: 1 } };
    });
    h.sessions.get(KEY).actionPanel = { waitingForChoice: true, pendingQuestion: { question: 'Q?' } };
    const r = await h.controller.start({ sessionKey: KEY, text: 'do X' });
    expect(r.status).toBe(500);
    expect(h.sessions.get(KEY).actionPanel.pendingQuestion).toBeUndefined();
  });

  it('a start that is not saved leaves the open question where it was (the 500 means nothing happened)', async () => {
    const h = harness({}, [
      async () => {
        throw new Error('ENOSPC');
      },
    ]);
    const question = { question: 'Q?', askId: 'ask-1' };
    h.sessions.get(KEY).actionPanel = { waitingForChoice: true, pendingQuestion: question };
    const r = await h.controller.start({ sessionKey: KEY, text: 'do X' });
    expect(r.status).toBe(500);
    const panel = h.sessions.get(KEY).actionPanel;
    expect(panel.waitingForChoice).toBe(true);
    expect(panel.pendingQuestion).toBe(question);
  });

  it('a new instruction supersedes an open question (as a new Slack message does)', async () => {
    const h = harness();
    h.sessions.get(KEY).actionPanel = { waitingForChoice: true, pendingQuestion: { question: 'Q?' } };
    const r = await h.controller.start({ sessionKey: KEY, text: 'never mind, do X' });
    await r.done;
    const panel = h.sessions.get(KEY).actionPanel;
    expect(panel.waitingForChoice).toBe(false);
    expect(panel.pendingQuestion).toBeUndefined();
  });

  it('a fallback compaction: /compact (a compact hop), then the stashed instruction — captured before /compact runs', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        h.sessions.get(KEY).fallbackCompactPendingUserText = 'the big instruction';
        return { turnId: 'a', outcome: null, nonTerminal: 'fallbackCompact' };
      },
      async (input) => {
        // The compaction boundary nulls the stash before this hop returns.
        h.sessions.get(KEY).fallbackCompactPendingUserText = null;
        input.onStarted?.();
        return completed('c');
      },
      completed('d'),
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'the big instruction' });
    await r.done;
    expect(h.inputs.map((i) => i.text)).toEqual(['the big instruction', '/compact', 'the big instruction']);
    expect(h.inputs[1]).toMatchObject({ compactHop: true });
    expect(h.inputs[1].params?.isUserInput).toBe(false);
    expect(h.inputs[2].params?.isUserInput).toBe(true);
  });

  it('the stashed instruction is not re-run when the compaction did not complete', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        h.sessions.get(KEY).fallbackCompactPendingUserText = 'big';
        return { turnId: 'a', outcome: null, nonTerminal: 'fallbackCompact' };
      },
      { turnId: 'b', outcome: { turnId: 'b', outcome: 'failed', category: 'Exception', at: 1 } },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'big' });
    await r.done;
    expect(h.inputs.map((i) => i.text)).toEqual(['big', '/compact']);
  });

  it('the dispatch budget covers every hop: at the last dispatch a fallback compaction is not resumed', async () => {
    const fallback =
      (id: string): Step =>
      async (input) => {
        input.onStarted?.();
        h.sessions.get(KEY).fallbackCompactPendingUserText = 'big';
        return { turnId: id, outcome: null, nonTerminal: 'fallbackCompact' };
      };
    const h = harness({ maxDispatches: 2 }, []);
    h.runTaskTurn.mockImplementationOnce(async (input) => {
      h.inputs.push(input);
      return (fallback('a') as any)(input);
    });
    h.runTaskTurn.mockImplementationOnce(async (input) => {
      h.inputs.push(input);
      input.onStarted?.();
      return completed('b');
    });
    const r = await h.controller.start({ sessionKey: KEY, text: 'big' });
    await r.done;
    // Dispatch 1: the instruction; dispatch 2 (last): /compact — no budget left to replay.
    expect(h.inputs.map((i) => i.text)).toEqual(['big', '/compact']);
    expect(h.inputs[1]).toMatchObject({
      resumable: ['shutdown'],
      notResumedReasons: expect.objectContaining({ fallbackCompact: 're-entry limit reached' }),
    });
  });

  it('a failed or interrupted outcome is never retried automatically (D10)', async () => {
    const h = harness({}, [
      { turnId: 'a', outcome: { turnId: 'a', outcome: 'interrupted', category: 'Stalled', at: 1, retryable: true } },
    ]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    await r.done;
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
  });

  it('a shutdown return ends the chain without another hop (restart reconciliation owns it)', async () => {
    const h = harness({}, [{ turnId: 'a', outcome: null, nonTerminal: 'shutdown' }]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    await r.done;
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
  });

  it('the execution context is rebuilt for every hop; a hop whose context fails ends the pending turn (#634 R1)', async () => {
    let builds = 0;
    const h = harness(
      {
        buildExecutionContext: () => {
          builds += 1;
          if (builds === 2) throw new Error('owner lost access');
          return CTX;
        },
      },
      [
        async (input) => {
          input.onStarted?.();
          h.sessions.get(KEY).fallbackCompactPendingUserText = 'big';
          return { turnId: 'a', outcome: null, nonTerminal: 'fallbackCompact' };
        },
      ],
    );
    const r = await h.controller.start({ sessionKey: KEY, text: 'big' });
    await r.done;
    expect(builds).toBe(2);
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'a',
      expect.objectContaining({ outcome: 'interrupted', reason: 'task cannot run: owner lost access' }),
    );
  });

  it('a refused shutdown (resumeAccepting) ends the turns a shutdown abort left working (#634 R1)', async () => {
    const h = harness({}, [{ turnId: 'a', outcome: null, nonTerminal: 'shutdown' }]);
    const r = await h.controller.start({ sessionKey: KEY, text: 'go' });
    await r.done;
    expect(h.abandonTurn).not.toHaveBeenCalled();
    h.controller.stopAccepting();
    h.controller.resumeAccepting();
    await Promise.resolve();
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'a',
      expect.objectContaining({ outcome: 'interrupted', reason: 'service shutdown was cancelled' }),
    );
  });
});
