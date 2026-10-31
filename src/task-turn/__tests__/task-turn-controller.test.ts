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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, ...req });
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
    const r = await h.controller.start({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      text: text.replace('/tmp-like path first: ', ''),
    });
    expect(r.status).toBe(202);
    await r.done;
  });

  it('refuses a session that is not a Slack-less task', async () => {
    const h = harness();
    h.sessions.get(KEY).slackless = undefined;
    expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' })).status).toBe(409);
  });

  it('a task whose execution context cannot be built answers 409 with the reason', async () => {
    const h = harness({
      buildExecutionContext: () => {
        throw Object.assign(new Error('task has no absolute working directory'), {
          name: 'ExecutionContextMissingError',
        });
      },
    });
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    expect(r).toMatchObject({
      status: 409,
      body: { error: 'task cannot run: task has no absolute working directory' },
    });
    expect(h.runTaskTurn).not.toHaveBeenCalled();
  });

  it('after stopAccepting (shutdown) a start answers 503; resumeAccepting (a refused shutdown) re-opens it', async () => {
    const h = harness();
    h.controller.stopAccepting();
    expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' })).status).toBe(503);
    h.controller.resumeAccepting();
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
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
    const first = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'one' });
    expect(first.status).toBe(202);
    expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'two' })).status).toBe(409);
    expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY2, text: 'other' })).status).toBe(429);
    release();
    await first.done;
    expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY2, text: 'other' })).status).toBe(202);
  });

  it('the window bound refuses the 11th start in 10 minutes', async () => {
    let t = 0;
    const h = harness({ now: () => t });
    for (let i = 0; i < 10; i++) {
      const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: `n${i}` });
      expect(r.status).toBe(202);
      await r.done;
      t += 1000;
    }
    expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'n10' })).status).toBe(429);
    t += 10 * 60_000;
    expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'later' })).status).toBe(202);
  });

  it('a start answered 500 does not use up the owner’s start window (#634 R1)', async () => {
    let t = 0;
    const h = harness({ now: () => t, maxStartsPerWindow: 2 });
    for (let i = 0; i < 3; i++) {
      h.runTaskTurn.mockImplementationOnce(async () => {
        throw new Error('ENOSPC');
      });
      expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: `n${i}` })).status).toBe(500);
      t += 1000;
    }
    const ok = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'now it saves' });
    expect(ok.status).toBe(202);
    await ok.done;
  });

  it('the cap is released after a chain that throws after acceptance', async () => {
    const h = harness({}, [new Error('boom')]);
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    expect(r.status).toBe(202);
    await r.done;
    expect(h.deps.logger.error).toHaveBeenCalled();
    expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'again' })).status).toBe(202);
  });
});

describe('TaskTurnController — acceptance and the chain (598c §3–§5, v2)', () => {
  it('a turn whose start is not saved answers 500 and frees the task', async () => {
    const h = harness({}, [
      async () => {
        throw new Error('ENOSPC');
      },
    ]);
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    expect(r.status).toBe(500);
    expect(h.coordinator.controllers.size).toBe(0);
    expect((await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' })).status).toBe(202);
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'do it' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'big' });
    await r.done;
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
    // The pending fallback turn is ended — cancelled — not left working on the 1M model (#634 R1).
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'a',
      expect.objectContaining({ outcome: 'cancelled' }),
      expect.any(String), // the chain it ends (E2 ③)
    );
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'big' });
    expect(r.status).toBe(202);
    await r.done;
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'a',
      expect.objectContaining({ outcome: 'interrupted', reason: 'turn start not saved: ENOSPC' }),
      expect.any(String), // the chain it ends (E2 ③)
    );
  });

  it('a shutdown between hops leaves the pending turn for restart reconciliation (no abandon)', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        // Production order: admission closes before clearAll's shutdown abort.
        h.controller.stopAccepting();
        h.coordinator.abortSession(KEY, 'shutdown');
        return { turnId: 'a', outcome: null, nonTerminal: 'fallbackCompact' };
      },
    ]);
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'big' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'do X' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'do X' });
    expect(r.status).toBe(500);
    const panel = h.sessions.get(KEY).actionPanel;
    expect(panel.waitingForChoice).toBe(true);
    expect(panel.pendingQuestion).toBe(question);
  });

  it('a new instruction supersedes an open question (as a new Slack message does)', async () => {
    const h = harness();
    h.sessions.get(KEY).actionPanel = { waitingForChoice: true, pendingQuestion: { question: 'Q?' } };
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'never mind, do X' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'the big instruction' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'big' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'big' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    await r.done;
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
  });

  it('a shutdown return ends the chain without another hop (restart reconciliation owns it)', async () => {
    const h = harness({}, [{ turnId: 'a', outcome: null, nonTerminal: 'shutdown' }]);
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
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
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'big' });
    await r.done;
    expect(builds).toBe(2);
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'a',
      expect.objectContaining({ outcome: 'interrupted', reason: 'task cannot run: owner lost access' }),
      expect.any(String), // the chain it ends (E2 ③)
    );
  });

  it('a refused shutdown (resumeAccepting) ends the turns a shutdown abort left working (#634 R1)', async () => {
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        h.controller.stopAccepting(); // shutdown began; clearAll aborted this turn
        return { turnId: 'a', outcome: null, nonTerminal: 'shutdown' };
      },
    ]);
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    await r.done;
    expect(h.abandonTurn).not.toHaveBeenCalled();
    h.controller.resumeAccepting();
    await Promise.resolve();
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'a',
      expect.objectContaining({ outcome: 'interrupted', reason: 'service shutdown was cancelled' }),
      h.runTaskTurn.mock.calls[0][0].chain?.id, // the chain it ends (E2 ③)
    );
  });

  it('a shutdown refused before the aborted turn finishes unwinding still ends that turn (production order, astra #634)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        await gate;
        return { turnId: 'a', outcome: null, nonTerminal: 'shutdown' };
      },
    ]);
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    // index.ts order: stopAccepting → clearAll (aborts) → refused → resumeAccepting, all before the turn unwinds.
    h.controller.stopAccepting();
    h.coordinator.abortSession(KEY, 'shutdown');
    h.controller.resumeAccepting();
    release();
    await r.done;
    expect(h.abandonTurn).toHaveBeenCalledWith(
      KEY,
      'a',
      expect.objectContaining({ outcome: 'interrupted', reason: 'service shutdown was cancelled' }),
      h.runTaskTurn.mock.calls[0][0].chain?.id, // the chain it ends (E2 ③)
    );
  });

  it('a Close that times out releases the owner’s slot — the closed task’s hung chain does not lock the owner out (astra #634)', async () => {
    const h = harness({ closeWaitMs: 5 }, [
      async (input) => {
        input.onStarted?.();
        return new Promise<RunTaskTurnResult>(() => {}); // never settles
      },
    ]);
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'hang' });
    expect(r.status).toBe(202);
    await h.controller.close(KEY);
    expect(h.controller.isRunning(KEY)).toBe(false);
    const next = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY2, text: 'other task' });
    expect(next.status).toBe(202);
  });

  it('Close waits for a refused shutdown’s ending of the stranded turn before the task is removed (astra #634 R2)', async () => {
    let releaseAbandon!: () => void;
    const abandonGate = new Promise<void>((r) => {
      releaseAbandon = r;
    });
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        h.controller.stopAccepting();
        return { turnId: 'a', outcome: null, nonTerminal: 'shutdown' };
      },
    ]);
    const order: string[] = [];
    h.abandonTurn.mockImplementationOnce(async (_k: string, turnId: string, decided: any) => {
      await abandonGate; // the outcome save is retrying
      order.push('abandoned');
      return { turnId, outcome: { ...decided, turnId, at: 1 } };
    });
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    await r.done;
    h.controller.resumeAccepting(); // the shutdown was refused: the stranded turn is being ended
    const closing = h.controller.close(KEY).then(() => order.push('closed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseAbandon();
    await closing;
    expect(order).toEqual(['abandoned', 'closed']);
  });
});

// #637 R2 (fable P3) — every start runs under the owner's identity, so the
// owner check lives in admission, shared by an instruction and an answer.
describe('TaskTurnController.start — only the task’s owner starts it (#637 R2)', () => {
  it('a start by anyone but the owner (or by nobody) is 403 and runs nothing', async () => {
    const h = harness();
    for (const actorUserId of ['U_OTHER', '']) {
      const r = await h.controller.start({ actorUserId, sessionKey: KEY, text: 'go' });
      expect(r).toMatchObject({ status: 403 });
    }
    expect(h.runTaskTurn).not.toHaveBeenCalled();
    const ok = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    expect(ok.status).toBe(202);
    await ok.done;
  });
});

// #600 ⑥ — the new-task launcher asks before it creates anything: the same
// owner-level admission a start would meet (shutdown, the owner's running
// task, the start window), with no side effect.
describe('TaskTurnController.canStart — a dry run of admission (#600 ⑥)', () => {
  it('null while the owner may start; the start’s own refusal otherwise — and it counts nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({ maxStartsPerWindow: 2 } as never, [
      async (input) => {
        input.onStarted?.();
        await gate;
        return completed('first');
      },
    ]);
    expect(h.controller.canStart('UOWNER')).toBeNull();
    expect(h.controller.canStart('UOWNER')).toBeNull(); // no window entry taken
    const first = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    expect(first.status).toBe(202);
    expect(h.controller.canStart('UOWNER')).toMatchObject({ status: 429 });
    expect(h.controller.canStart('U_SOMEONE_ELSE')).toBeNull();
    release();
    await first.done;
    expect(h.controller.canStart('UOWNER')).toBeNull();
    h.controller.stopAccepting();
    expect(h.controller.canStart('UOWNER')).toMatchObject({ status: 503 });
  });

  // #640 R1 (fable, astra): a first instruction the start would refuse as a
  // command is refused before a task exists — never a card that cannot start.
  it.each([
    ['/compact'],
    ['/model opus'],
    ['%model'],
    ['/zworkflow:using-ssot'], // a plugin's namespaced command (#640 R2)
    ['/plugin:skill do it'],
  ])('refuses a command-shaped first instruction (%s) with the start’s own 400', (text) => {
    const h = harness();
    expect(h.controller.canStart('UOWNER', text)).toEqual({
      status: 400,
      body: { error: 'commands are not supported on a dashboard task yet — send an instruction' },
    });
  });

  it('refuses with the window’s own 429 once the owner’s starts fill it, before anything is made', async () => {
    const h = harness({ maxStartsPerWindow: 1 } as never, [
      async (input) => {
        input.onStarted?.();
        return completed('only');
      },
    ]);
    const first = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' });
    expect(first.status).toBe(202);
    await first.done;
    expect(h.controller.canStart('UOWNER', 'again')).toEqual({
      status: 429,
      body: { error: 'too many dashboard task starts — try again shortly' },
    });
  });

  it('lets an instruction that only mentions a path or a slash through', () => {
    const h = harness();
    expect(h.controller.canStart('UOWNER', 'clean /tmp/build and explain 2/3 of it')).toBeNull();
    expect(h.controller.canStart('UOWNER', '  fix the flaky test')).toBeNull();
  });
});

describe('TaskTurnController.answer — a dashboard answer to a task’s question (#599 ⑤)', () => {
  const QUESTION = {
    type: 'user_choice',
    question: 'Which DB?',
    choices: [
      { id: 'pg', label: 'Postgres' },
      { id: 'my', label: 'MySQL' },
    ],
    askId: 'ask-1',
    turnId: 't-ask',
  };
  const waiting = (h: ReturnType<typeof harness>, key = KEY) => {
    const s = h.sessions.get(key);
    s.activityState = 'waiting';
    s.actionPanel = { waitingForChoice: true, pendingQuestion: { ...QUESTION } };
    return s;
  };

  it('runs the answer as the next instruction — the Slack text, user input — and clears the question', async () => {
    const h = harness();
    waiting(h);
    const r = await h.controller.answer({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      askId: 'ask-1',
      answer: { kind: 'single', choiceId: 'pg' },
    });
    expect(r.status).toBe(202);
    await r.done;
    expect(h.inputs[0]).toMatchObject({ text: 'pg' });
    expect(h.inputs[0].params?.isUserInput).toBe(true);
    expect(h.sessions.get(KEY).actionPanel.pendingQuestion).toBeUndefined();
  });

  it('an answer for another question (stale askId) is 409 and changes nothing', async () => {
    const h = harness();
    waiting(h);
    const r = await h.controller.answer({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      askId: 'ask-0',
      answer: { kind: 'single', choiceId: 'pg' },
    });
    expect(r).toMatchObject({ status: 409, body: { error: 'the question has changed — reload' } });
    expect(h.runTaskTurn).not.toHaveBeenCalled();
    expect(h.sessions.get(KEY).actionPanel.pendingQuestion.askId).toBe('ask-1');
  });

  it('a task that is not waiting takes no answer', async () => {
    const h = harness();
    const s = waiting(h);
    s.activityState = 'idle';
    expect(
      (
        await h.controller.answer({
          actorUserId: 'UOWNER',
          sessionKey: KEY,
          askId: 'ask-1',
          answer: { kind: 'single', choiceId: 'pg' },
        })
      ).status,
    ).toBe(409);
    expect(h.runTaskTurn).not.toHaveBeenCalled();
  });

  it('a choice that was not offered is 422 and the question stays', async () => {
    const h = harness();
    waiting(h);
    const r = await h.controller.answer({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      askId: 'ask-1',
      answer: { kind: 'single', choiceId: 'oracle' },
    });
    expect(r.status).toBe(422);
    expect(h.runTaskTurn).not.toHaveBeenCalled();
    expect(h.sessions.get(KEY).actionPanel).toMatchObject({
      waitingForChoice: true,
      pendingQuestion: { askId: 'ask-1' },
    });
  });

  it('one answer only: a concurrent second answer to the same question is refused', async () => {
    const h = harness();
    waiting(h);
    const a = h.controller.answer({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      askId: 'ask-1',
      answer: { kind: 'single', choiceId: 'pg' },
    });
    const b = h.controller.answer({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      askId: 'ask-1',
      answer: { kind: 'single', choiceId: 'my' },
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status].sort()).toEqual([202, 409]);
    await ra.done;
    await rb.done;
    expect(h.runTaskTurn).toHaveBeenCalledTimes(1);
  });

  // #637 R1 (astra P1) — the answer runs under the owner's identity: the route
  // checks the signed-in owner, and the controller refuses anyone else again.
  it('an answer from anyone but the task’s owner is 403 and changes nothing', async () => {
    const h = harness();
    waiting(h);
    for (const actorUserId of ['U_OTHER', '']) {
      const r = await h.controller.answer({
        actorUserId,
        sessionKey: KEY,
        askId: 'ask-1',
        answer: { kind: 'single', choiceId: 'pg' },
      });
      expect(r).toMatchObject({ status: 403 });
    }
    expect(h.runTaskTurn).not.toHaveBeenCalled();
    expect(h.sessions.get(KEY).actionPanel.pendingQuestion.askId).toBe('ask-1');
  });

  // #637 R1 (fable P3) — an answer is not a command: a form whose question
  // starts with `%` is answered. One that would start with `/` is refused with
  // its reason (the SDK reads a leading `/word` as a command) and stays open.
  it('an answer starting with % runs; one that would start with /word is 422 with its reason and the question stays', async () => {
    const h = harness();
    const s = waiting(h);
    s.actionPanel.pendingQuestion = {
      type: 'user_choices',
      questions: [{ id: 'q1', question: '%CPU threshold?', choices: [{ id: '80', label: '80%' }] }],
      askId: 'ask-1',
    };
    const ok = await h.controller.answer({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      askId: 'ask-1',
      answer: { kind: 'multi', selections: { q1: { choiceId: '80', label: '80%' } } },
    });
    expect(ok.status).toBe(202);
    await ok.done;
    expect(h.inputs[0]).toMatchObject({ text: '%CPU threshold?: 80. 80%' });

    const h2 = harness();
    const s2 = waiting(h2);
    s2.actionPanel.pendingQuestion = { ...QUESTION, choices: [{ id: '/compact', label: 'compact' }] };
    const refused = await h2.controller.answer({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      askId: 'ask-1',
      answer: { kind: 'single', choiceId: '/compact' },
    });
    expect(refused.status).toBe(422);
    expect(String(refused.body.error)).toMatch(/would be read as a command — rephrase it as a free-form instruction/);
    expect(h2.runTaskTurn).not.toHaveBeenCalled();
    expect(h2.sessions.get(KEY).actionPanel.pendingQuestion.askId).toBe('ask-1');
  });

  it('an answer refused at admission (the owner’s other task runs) keeps the question, and can be sent again later', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({}, [
      async (input) => {
        input.onStarted?.();
        await gate;
        return completed('other');
      },
    ]);
    const other = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY2, text: 'other work' });
    waiting(h);
    const refused = await h.controller.answer({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      askId: 'ask-1',
      answer: { kind: 'single', choiceId: 'pg' },
    });
    expect(refused.status).toBe(429);
    expect(h.sessions.get(KEY).actionPanel).toMatchObject({
      waitingForChoice: true,
      pendingQuestion: { askId: 'ask-1' },
    });
    release();
    await other.done;
    const again = await h.controller.answer({
      actorUserId: 'UOWNER',
      sessionKey: KEY,
      askId: 'ask-1',
      answer: { kind: 'single', choiceId: 'pg' },
    });
    expect(again.status).toBe(202);
    await again.done;
  });
});
