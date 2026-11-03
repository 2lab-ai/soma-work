/**
 * SSOT 2026-11-03 — the goal loop's three task seams (task-goal-loop.ts):
 * the chain end wakes the loop with the chain's last answer as evidence; the
 * next goal turn is a synthetic host start that never supersedes a running
 * turn and waits out the owner's busy slot (bounded); a person's instruction
 * resets the goal's continuation count.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SyntheticMessageEvent } from '../../cron-scheduler';
import type { ConversationSession, SessionGoal } from '../../types';
import { createTaskGoalLoop, type TaskGoalLoopDeps } from '../task-goal-loop';
import type { TaskCommandRequest, TaskCommandResponse } from '../task-turn-controller';

const KEY = 'task:11111111-2222-4333-8444-555555555555';

function goal(over: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'g1',
    objective: 'ship it',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'UOWNER',
    continuationCount: 3,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 4,
    ...over,
  };
}

function taskSession(g?: SessionGoal): ConversationSession {
  return {
    slackless: true,
    channelId: '',
    ownerId: 'UOWNER',
    conversationId: 'conv-1',
    lastTurnOutcome: { turnId: 'turn-9', outcome: 'completed', category: 'WorkflowComplete', at: 1 },
    ...(g ? { goal: g } : {}),
  } as unknown as ConversationSession;
}

const event = (text = '[goal-continuation] keep going'): SyntheticMessageEvent =>
  ({ user: 'UOWNER', channel: '', thread_ts: undefined, ts: '1', text, synthetic: true }) as SyntheticMessageEvent;

function harness(
  session: ConversationSession,
  responses: TaskCommandResponse[] = [],
  over: Partial<TaskGoalLoopDeps> = {},
) {
  const starts: TaskCommandRequest[] = [];
  const queue = [...responses];
  const settle = vi.fn();
  const saveSessions = vi.fn();
  const waits: number[] = [];
  const deps: TaskGoalLoopDeps = {
    getSession: (k) => (k === KEY ? session : undefined),
    start: vi.fn(async (request: TaskCommandRequest) => {
      starts.push(request);
      return queue.shift() ?? { status: 202, body: { ok: true } };
    }),
    readLastFinal: vi.fn(async () => 'the turn shipped PR #1'),
    saveSessions,
    isRunning: () => false,
    settle,
    logger: { info: vi.fn(), warn: vi.fn() },
    retryDelayMs: 5,
    maxRetries: 2,
    schedule: (fn, delayMs) => {
      waits.push(delayMs);
      fn();
    },
    ...over,
  };
  return { loop: createTaskGoalLoop(deps), starts, settle, saveSessions, waits, deps };
}

describe('task goal loop — the chain end wakes the loop', () => {
  it('stashes the chain’s last answer as the eval evidence, then settles the loop', async () => {
    const g = goal();
    const s = taskSession(g);
    const h = harness(s);
    await h.loop.onChainEnd(KEY, { started: true, outcome: 'completed' });
    expect(s.goalLastTurnText).toBe('the turn shipped PR #1');
    expect(g.lastAssistantTurnSummary).toBe('the turn shipped PR #1');
    expect(h.saveSessions).toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledWith(KEY);
  });

  it('does nothing for a chain that never started, a task with no active goal, or a Slack session', async () => {
    const paused = harness(taskSession(goal({ status: 'paused' })));
    await paused.loop.onChainEnd(KEY, { started: true, outcome: 'completed' });
    expect(paused.settle).not.toHaveBeenCalled();

    const none = harness(taskSession());
    await none.loop.onChainEnd(KEY, { started: true, outcome: 'completed' });
    expect(none.settle).not.toHaveBeenCalled();

    const notStarted = harness(taskSession(goal()));
    await notStarted.loop.onChainEnd(KEY, { started: false, outcome: 'completed' });
    expect(notStarted.settle).not.toHaveBeenCalled();

    const slack = taskSession(goal());
    (slack as { slackless?: boolean }).slackless = undefined;
    const h = harness(slack);
    await h.loop.onChainEnd(KEY, { started: true, outcome: 'completed' });
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('Stop, a failure or an interruption does not run the loop (Slack runs it only on a normal finish)', async () => {
    for (const info of [
      { started: true, stopped: true, outcome: 'cancelled' },
      { started: true, outcome: 'failed' },
      { started: true, outcome: 'interrupted' },
      { started: true },
    ]) {
      const h = harness(taskSession(goal()));
      await h.loop.onChainEnd(KEY, info);
      expect(h.settle).not.toHaveBeenCalled();
    }
  });

  // #861 R1 (astra-zhuge P1): a late evidence read speaks for its own turn only.
  it('a late read after the owner wrote (epoch moved) writes no evidence and wakes nothing', async () => {
    const g = goal();
    const s = taskSession(g);
    let release!: (t: string) => void;
    const h = harness(s, [], {
      readLastFinal: () =>
        new Promise<string>((r) => {
          release = r;
        }),
    });
    const ended = h.loop.onChainEnd(KEY, { started: true, outcome: 'completed' });
    g.epoch = 5; // the owner's next instruction
    s.goalLastTurnText = 'turn B — newer';
    release('turn A — stale');
    await ended;
    expect(s.goalLastTurnText).toBe('turn B — newer');
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('a late read after a newer turn ended (or was stopped) wakes nothing', async () => {
    const s = taskSession(goal());
    let release!: (t: string) => void;
    const h = harness(s, [], {
      readLastFinal: () =>
        new Promise<string>((r) => {
          release = r;
        }),
    });
    const ended = h.loop.onChainEnd(KEY, { started: true, outcome: 'completed' });
    s.lastTurnOutcome = { turnId: 'turn-10', outcome: 'cancelled', category: 'Exception', at: 2 };
    release('turn 9 text');
    await ended;
    expect(h.settle).not.toHaveBeenCalled();
    expect(s.goalLastTurnText).toBeUndefined();
  });

  it('a late read while a newer chain runs wakes nothing (that chain’s end will)', async () => {
    const s = taskSession(goal());
    const h = harness(s, [], { isRunning: () => true });
    await h.loop.onChainEnd(KEY, { started: true, outcome: 'completed' });
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('a goal changed under the turn gets no evidence from it, but the loop still runs', async () => {
    const g = goal();
    const s = taskSession(g);
    s.activeLegGoalId = 'g0';
    const h = harness(s);
    await h.loop.onChainEnd(KEY, { started: true, outcome: 'completed' });
    expect(s.goalLastTurnText).toBeUndefined();
    expect(h.settle).toHaveBeenCalledWith(KEY);
  });
});

describe('task goal loop — the next goal turn', () => {
  it('is a synthetic host start as the goal’s owner', async () => {
    const h = harness(taskSession(goal()));
    await h.loop.injectContinuation(event(), { sessionKey: KEY });
    expect(h.starts).toEqual([
      {
        sessionKey: KEY,
        text: '[goal-continuation] keep going',
        actorUserId: 'UOWNER',
        initiator: 'host',
        goalContinuation: true,
      },
    ]);
  });

  it('never supersedes: a task already running drops it (its own end runs the loop)', async () => {
    const h = harness(taskSession(goal()), [
      { status: 409, body: { error: 'a turn is already running on this task' } },
    ]);
    await expect(h.loop.injectContinuation(event(), { sessionKey: KEY })).resolves.toBeUndefined();
    expect(h.starts).toHaveLength(1);
  });

  it('waits out the owner’s busy dashboard slot, then starts', async () => {
    const h = harness(taskSession(goal()), [
      { status: 429, body: { error: 'one dashboard task runs at a time — wait for it to finish' } },
      { status: 202, body: { ok: true } },
    ]);
    await h.loop.injectContinuation(event(), { sessionKey: KEY });
    expect(h.starts).toHaveLength(2);
    expect(h.waits).toEqual([5]);
  });

  it('gives up after its retries with the refusal as the error (the loop posts it)', async () => {
    const busy = { status: 429, body: { error: 'one dashboard task runs at a time — wait for it to finish' } };
    const h = harness(taskSession(goal()), [busy, busy, busy]);
    await expect(h.loop.injectContinuation(event(), { sessionKey: KEY })).rejects.toThrow(/one dashboard task/);
    expect(h.starts).toHaveLength(3);
  });

  it('a refusal that waiting cannot fix fails at once', async () => {
    const h = harness(taskSession(goal()), [{ status: 503, body: { error: 'the service is shutting down' } }]);
    await expect(h.loop.injectContinuation(event(), { sessionKey: KEY })).rejects.toThrow(/shutting down/);
    expect(h.starts).toHaveLength(1);
  });

  it('drops a waiting continuation once the goal moved (the owner wrote, or paused it)', async () => {
    const g = goal();
    const s = taskSession(g);
    const h = harness(s, [{ status: 429, body: { error: 'one dashboard task runs at a time' } }], {
      schedule: (fn) => {
        g.epoch = 5; // a real user message bumped the epoch while it waited
        fn();
      },
    });
    await h.loop.injectContinuation(event(), { sessionKey: KEY });
    expect(h.starts).toHaveLength(1);
  });
});

describe('task goal loop — a person’s instruction', () => {
  it('resets the goal’s continuation count and bumps its epoch, then saves', () => {
    const g = goal({ continuationCount: 7, epoch: 2 });
    const s = taskSession(g);
    const h = harness(s);
    h.loop.onUserInstruction(KEY, s);
    expect(g.continuationCount).toBe(0);
    expect(g.epoch).toBe(3);
    expect(h.saveSessions).toHaveBeenCalled();
  });
});
