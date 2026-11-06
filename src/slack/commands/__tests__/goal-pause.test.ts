/**
 * Pausing and resuming goals (SSOT 2026-11-06).
 *
 *   T1/T2 — pausing the current goal moves it aside: the next queued goal
 *           starts, or, with nothing queued, the goal work ends.
 *   T3–T5 — resuming a paused goal: with no goal running it becomes the current
 *           goal at once; with a goal running it goes right after that goal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTodoList } from '../../../session/task-ledger';
import type { ConversationSession } from '../../../types';
import { heldByWaitingGoals } from '../../goal-task-gate';
import {
  advanceGoalQueue,
  createActiveSessionGoal,
  enqueueOrActivateGoal,
  findGoalById,
  pauseCurrentGoal,
  restoreGoalState,
  resumePausedGoal,
  snapshotGoalState,
} from '../../session-goal';
import { GoalHandler } from '../goal-handler';
import type { CommandContext, CommandDependencies, GoalOpening } from '../types';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U123',
    channel: 'C123',
    threadTs: '171.001',
    text: 'goal',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U123',
    ownerName: 'Tester',
    userId: 'U123',
    channelId: 'C123',
    threadTs: '171.001',
    isActive: true,
    lastActivity: new Date(),
    state: 'MAIN',
    workflow: 'default',
    systemPrompt: 'cached prompt',
    ...overrides,
  } as ConversationSession;
}

function makeDeps(session?: ConversationSession): CommandDependencies {
  return {
    claudeHandler: {
      getSession: vi.fn().mockReturnValue(session),
      getSessionKey: vi.fn().mockReturnValue('C123:171.001'),
      saveSessions: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
    },
    slackApi: {
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    },
    userSettingsStore: {
      getUserGoalMaxContinuations: vi.fn().mockReturnValue(undefined),
    },
  } as unknown as CommandDependencies;
}

const lastNotice = (deps: CommandDependencies): string =>
  String((deps.slackApi.postSystemMessage as any).mock.calls.at(-1)?.[1] ?? '');

/** A session with goal A running and B, C queued behind it. */
function sessionWithQueue(): ConversationSession {
  const session = makeSession({ goal: createActiveSessionGoal('goal A', 'U123') });
  enqueueOrActivateGoal(session, 'goal B', 'U123');
  enqueueOrActivateGoal(session, 'goal C', 'U123');
  return session;
}

describe('pauseCurrentGoal', () => {
  it('T1/T2: moves the current goal aside and starts the next queued goal', () => {
    const session = sessionWithQueue();
    const a = session.goal!;
    a.epoch = 7;
    a.continuationCount = 4;
    a.pendingEval = { requestedAt: 1, turnId: 't' };
    a.evalBackoffUntil = Date.now() + 60_000;
    a.activeMsUsed = 1234;

    const result = pauseCurrentGoal(session);

    expect(result.paused).toBe(a);
    expect(result.promoted?.objective).toBe('goal B');
    expect(session.goal?.objective).toBe('goal B');
    expect(session.goal?.status).toBe('active');
    expect((session.goal?.epoch ?? 0) > 8).toBe(true);
    expect(session.goalQueue?.map((g) => g.objective)).toEqual(['goal C']);
    expect(session.goalPaused).toEqual([a]);
    expect(a.status).toBe('paused');
    // An in-flight eval for A resolves into a discard; its lease and retry window go.
    expect(a.epoch).toBe(8);
    expect(a.pendingEval).toBeUndefined();
    expect(a.evalBackoffUntil).toBeUndefined();
    // A keeps what it spent — it is not a new goal.
    expect(a.activeMsUsed).toBe(1234);
    expect(a.continuationCount).toBe(4);
    // A paused goal is not a completed one.
    expect(session.goalHistory ?? []).toHaveLength(0);
    expect(session.systemPrompt).toBeUndefined();
  });

  it('T2: with nothing queued the goal work ends — no current goal is left', () => {
    const session = makeSession({ goal: createActiveSessionGoal('only goal', 'U123') });
    const only = session.goal!;

    const result = pauseCurrentGoal(session);

    expect(result.promoted).toBeUndefined();
    expect(session.goal).toBeUndefined();
    expect(session.goalPaused).toEqual([only]);
    expect(only.status).toBe('paused');
  });

  it('also takes a goal stopped as paused in the current slot (cap decision Cancel)', () => {
    const session = sessionWithQueue();
    session.goal!.status = 'paused';
    const result = pauseCurrentGoal(session);
    expect(result.promoted?.objective).toBe('goal B');
    expect(session.goalPaused).toHaveLength(1);
  });

  it('does nothing without a running or paused current goal', () => {
    const done = createActiveSessionGoal('done', 'U123');
    done.status = 'complete';
    const session = makeSession({ goal: done });
    expect(pauseCurrentGoal(session)).toEqual({});
    expect(session.goal).toBe(done);
    expect(pauseCurrentGoal(makeSession())).toEqual({});
  });

  it('the paused goal still owns the spend of a turn it started (findGoalById)', () => {
    const session = sessionWithQueue();
    const a = session.goal!;
    pauseCurrentGoal(session);
    expect(findGoalById(session, a.goalId)).toBe(a);
  });

  it('snapshot / restore puts the paused goals back exactly', () => {
    const session = sessionWithQueue();
    const a = session.goal!;
    const snapshot = snapshotGoalState(session);
    pauseCurrentGoal(session);
    restoreGoalState(session, snapshot);
    expect(session.goal).toBe(a);
    expect(a.status).toBe('active');
    expect(session.goalPaused).toBeUndefined();
    expect(session.goalQueue?.map((g) => g.objective)).toEqual(['goal B', 'goal C']);
  });
});

describe('resumePausedGoal', () => {
  it('T4: with no goal running, the resumed goal becomes the current goal at once', () => {
    const session = makeSession({ goal: createActiveSessionGoal('only goal', 'U123') });
    const only = session.goal!;
    only.continuationCount = 9;
    pauseCurrentGoal(session);
    const pausedEpoch = only.epoch ?? 0;

    const resumed = resumePausedGoal(session);

    expect(resumed).toEqual({ goal: only, placement: 'current' });
    expect(session.goal).toBe(only);
    expect(only.status).toBe('active');
    expect(only.continuationCount).toBe(0);
    expect((only.epoch ?? 0) > pausedEpoch).toBe(true);
    expect(session.goalPaused).toEqual([]);
  });

  it('T5: with a goal running, the resumed goal goes right after it (head of the queue)', () => {
    const session = sessionWithQueue();
    const a = session.goal!;
    pauseCurrentGoal(session); // B runs, C queued
    const b = session.goal!;
    const bEpoch = b.epoch;

    const resumed = resumePausedGoal(session, a.goalId);

    expect(resumed?.placement).toBe('next');
    expect(session.goal).toBe(b); // the running goal is not interrupted
    expect(b.epoch).toBe(bEpoch); // nor is its in-flight eval invalidated
    expect(session.goalQueue?.map((g) => g.objective)).toEqual(['goal A', 'goal C']);
    expect(a.status).toBe('queued');
    expect(session.goalPaused).toEqual([]);
  });

  it('a completed current goal is no running goal: the resumed goal becomes current', () => {
    const session = makeSession({ goal: createActiveSessionGoal('first', 'U123') });
    const first = session.goal!;
    pauseCurrentGoal(session);
    const done = createActiveSessionGoal('done', 'U123');
    done.status = 'complete';
    session.goal = done;
    session.goalHistory = [done];

    expect(resumePausedGoal(session)?.placement).toBe('current');
    expect(session.goal).toBe(first);
    expect(session.goalHistory).toEqual([done]);
  });

  it('without an id resumes the most recently paused goal', () => {
    const session = sessionWithQueue();
    pauseCurrentGoal(session); // A paused, B runs
    pauseCurrentGoal(session); // B paused, C runs
    pauseCurrentGoal(session); // C paused, nothing runs
    expect(session.goal).toBeUndefined();
    expect(resumePausedGoal(session)?.goal.objective).toBe('goal C');
    expect(session.goalPaused?.map((g) => g.objective)).toEqual(['goal A', 'goal B']);
  });

  it('a goal paused in the current slot can be resumed; another resumed instead joins the paused goals', () => {
    const session = makeSession({ goal: createActiveSessionGoal('slot', 'U123') });
    const slot = session.goal!;
    const shelf = createActiveSessionGoal('shelf', 'U123');
    shelf.status = 'paused';
    session.goalPaused = [shelf];
    slot.status = 'paused';

    expect(resumePausedGoal(session, shelf.goalId)?.placement).toBe('current');
    expect(session.goal).toBe(shelf);
    expect(session.goalPaused).toEqual([slot]);

    session.goal = undefined;
    expect(resumePausedGoal(session, slot.goalId)?.goal).toBe(slot);
  });

  it('without an id, a goal stopped in place more recently than the last one set aside wins (review P2)', () => {
    const session = makeSession({ goal: createActiveSessionGoal('slot', 'U123') });
    const slot = session.goal!;
    const shelf = createActiveSessionGoal('shelf', 'U123');
    shelf.status = 'paused';
    shelf.updatedAt = 100;
    session.goalPaused = [shelf];
    slot.status = 'paused'; // the cap question's Cancel, after the shelf goal was paused
    slot.updatedAt = 200;

    expect(resumePausedGoal(session)?.goal).toBe(slot);
    expect(session.goalPaused).toEqual([shelf]);
  });

  it('returns undefined for an unknown id and changes nothing', () => {
    const session = sessionWithQueue();
    pauseCurrentGoal(session);
    expect(resumePausedGoal(session, 'nope')).toBeUndefined();
    expect(session.goalPaused).toHaveLength(1);
  });
});

describe('GoalHandler — goal pause / goal resume', () => {
  afterEach(() => vi.clearAllMocks());

  it('T1: `goal pause` starts the next queued goal (inside a dispatch slot: this turn)', async () => {
    const session = sessionWithQueue();
    const deps = makeDeps(session);

    const result = await new GoalHandler(deps).execute(makeCtx({ text: 'goal pause' }));

    expect(session.goal?.objective).toBe('goal B');
    expect(session.goalPaused?.map((g) => g.objective)).toEqual(['goal A']);
    expect(result).toEqual({ handled: true, continueWithPrompt: 'goal B', verbatimPrompt: true });
    expect(lastNotice(deps)).toContain('goal A');
    expect(lastNotice(deps)).toContain('goal B');
    expect(deps.claudeHandler.saveSessions).toHaveBeenCalled();
  });

  it('T1: `goal pause` outside a dispatch slot admits the next goal’s first turn', async () => {
    const session = sessionWithQueue();
    const deps = makeDeps(session);
    const openings: GoalOpening[] = [];

    const result = await new GoalHandler(deps).execute(
      makeCtx({ text: 'goal pause', admitOpening: (o) => (openings.push(o), 'queued') }),
    );

    expect(result).toEqual({ handled: true });
    expect(openings).toEqual([{ goalId: session.goal!.goalId, objective: 'goal B', cause: 'promoted' }]);
  });

  it('a refused first turn undoes the pause', async () => {
    const session = sessionWithQueue();
    const a = session.goal!;
    const deps = makeDeps(session);

    await new GoalHandler(deps).execute(makeCtx({ text: 'goal pause', admitOpening: () => ({ failed: 'busy' }) }));

    expect(session.goal).toBe(a);
    expect(a.status).toBe('active');
    expect(session.goalPaused ?? []).toHaveLength(0);
    expect(session.goalQueue?.map((g) => g.objective)).toEqual(['goal B', 'goal C']);
    expect(lastNotice(deps)).toContain('NOT paused');
  });

  it('a refused first turn never brings back a decision round whose question was already withdrawn (review P1)', async () => {
    const session = sessionWithQueue();
    const a = session.goal!;
    a.stall = { stallId: 's1', stalledAt: 1, reason: 'same failure', actions: ['x', 'y', 'z'], confidence: 0.9 };
    a.capDmPendingAt = 5;
    a.capDecisionId = 'd1';
    const deps = makeDeps(session);

    await new GoalHandler(deps).execute(makeCtx({ text: 'goal pause', admitOpening: () => ({ failed: 'busy' }) }));

    expect(session.goal).toBe(a);
    expect(a.status).toBe('active');
    // The pause is undone, but its question and DM were withdrawn on the way: no round is left
    // that no surface shows.
    expect(a.stall).toBeUndefined();
    expect(a.capDmPendingAt).toBeUndefined();
    expect(a.capDecisionId).toBeUndefined();
  });

  it('the paused goal keeps its open tasks as its own; resuming it gives them back to it (review P1)', async () => {
    const session = sessionWithQueue();
    session.taskLedger = applyTodoList(
      undefined,
      [
        { content: 'done one', status: 'completed' },
        { content: 'open one', status: 'in_progress' },
        { content: 'open two', status: 'pending' },
      ],
      1_000,
    );
    const deps = makeDeps(session);
    await new GoalHandler(deps).execute(makeCtx({ text: 'goal pause' }));
    expect(session.goalPaused?.[0].heldTaskIds).toEqual(['T2', 'T3']);
    expect(session.goalPaused?.[0].heldListAt).toBe(session.taskLedger.updatedAt);

    // Resumed behind the running goal it still waits: its tasks stay its own until it takes the slot.
    await new GoalHandler(deps).execute(makeCtx({ text: 'goal resume 1' }));
    expect(session.goalQueue?.[0].objective).toBe('goal A');
    expect(session.goalQueue?.[0].heldTaskIds).toEqual(['T2', 'T3']);
    expect([...heldByWaitingGoals(session)]).toEqual(['T2', 'T3']);

    // It takes the slot (the running goal completes): the tasks count for it again.
    session.goal!.status = 'complete';
    advanceGoalQueue(session);
    expect(session.goal?.objective).toBe('goal A');
    expect(session.goal?.heldTaskIds).toBeUndefined();
    expect(heldByWaitingGoals(session).size).toBe(0);
  });

  it('a task already held by a waiting goal is not held again by the next goal paused (review r2 P2)', () => {
    const session = sessionWithQueue(); // A runs, B and C wait
    session.taskLedger = { nextSeq: 5, tasks: [], current: ['T2', 'T3', 'T4'], updatedAt: 1_000 };
    const a = session.goal!;
    pauseCurrentGoal(session, { heldTaskIds: ['T2', 'T3'], heldListAt: 1_000 }); // A holds T2, T3; B runs
    const b = session.goal!;
    pauseCurrentGoal(session, { heldTaskIds: ['T2', 'T3', 'T4'], heldListAt: 1_000 }); // same list: B holds only T4
    expect(a.heldTaskIds).toEqual(['T2', 'T3']);
    expect(b.heldTaskIds).toEqual(['T4']);
    // A resumed while C runs waits next; when it takes the slot its own tasks hold it again.
    resumePausedGoal(session, a.goalId);
    session.goal!.status = 'complete';
    advanceGoalQueue(session);
    expect(session.goal).toBe(a);
    expect([...heldByWaitingGoals(session)]).toEqual(['T4']);
  });

  it('held tasks stop applying once the running goal writes its own task list (review r3 P1)', async () => {
    const session = sessionWithQueue();
    session.taskLedger = applyTodoList(undefined, [{ content: 'open one', status: 'pending' }], 1_000);
    await new GoalHandler(makeDeps(session)).execute(makeCtx({ text: 'goal pause' }));
    expect([...heldByWaitingGoals(session)]).toEqual(['T1']);
    session.taskLedger = applyTodoList(session.taskLedger, [{ content: 'open one!', status: 'pending' }], 2_000);
    expect(heldByWaitingGoals(session).size).toBe(0);
  });

  it('T2: `goal pause` with nothing queued ends the goal work and starts no turn', async () => {
    const session = makeSession({ goal: createActiveSessionGoal('only goal', 'U123') });
    const deps = makeDeps(session);

    const result = await new GoalHandler(deps).execute(makeCtx({ text: 'goal pause' }));

    expect(result).toEqual({ handled: true });
    expect(session.goal).toBeUndefined();
    expect(session.goalPaused?.[0].status).toBe('paused');
    expect(lastNotice(deps)).toContain('goal resume');
  });

  it('T4: `goal resume` with no goal running makes it the current goal and starts its turn', async () => {
    const session = makeSession({ goal: createActiveSessionGoal('only goal', 'U123') });
    pauseCurrentGoal(session);
    const deps = makeDeps(session);

    const result = await new GoalHandler(deps).execute(makeCtx({ text: 'goal resume' }));

    expect(session.goal?.objective).toBe('only goal');
    expect(session.goal?.status).toBe('active');
    expect(result).toEqual({ handled: true, continueWithPrompt: 'only goal', verbatimPrompt: true });
  });

  it('T4: outside a dispatch slot the resumed goal’s turn is admitted; a refusal keeps it paused', async () => {
    const session = makeSession({ goal: createActiveSessionGoal('only goal', 'U123') });
    const only = session.goal!;
    pauseCurrentGoal(session);
    const deps = makeDeps(session);
    const openings: GoalOpening[] = [];

    await new GoalHandler(deps).execute(
      makeCtx({ text: 'goal resume', admitOpening: (o) => (openings.push(o), 'started') }),
    );
    expect(openings).toEqual([{ goalId: only.goalId, objective: 'only goal', cause: 'resumed' }]);

    pauseCurrentGoal(session);
    await new GoalHandler(deps).execute(
      makeCtx({ text: 'goal resume', admitOpening: () => ({ failed: 'shutting down' }) }),
    );
    expect(session.goal).toBeUndefined();
    expect(session.goalPaused).toEqual([only]);
    expect(only.status).toBe('paused');
    expect(lastNotice(deps)).toContain('NOT resumed');
  });

  it('T5: `goal resume <n>` with a goal running queues it right after that goal, starting no turn', async () => {
    const session = sessionWithQueue();
    pauseCurrentGoal(session); // A paused, B runs, C queued
    const b = session.goal!;
    const bEpoch = b.epoch;
    const deps = makeDeps(session);
    const admitOpening = vi.fn();

    const result = await new GoalHandler(deps).execute(makeCtx({ text: 'goal resume 1', admitOpening }));

    expect(result).toEqual({ handled: true });
    expect(admitOpening).not.toHaveBeenCalled();
    expect(session.goal).toBe(b);
    expect(b.epoch).toBe(bEpoch);
    expect(session.goalQueue?.map((g) => g.objective)).toEqual(['goal A', 'goal C']);
    expect(lastNotice(deps)).toContain('goal A');
  });

  it('`goal resume <n>` out of range changes nothing', async () => {
    const session = sessionWithQueue();
    pauseCurrentGoal(session);
    const deps = makeDeps(session);
    await new GoalHandler(deps).execute(makeCtx({ text: 'goal resume 5' }));
    expect(session.goalPaused).toHaveLength(1);
    expect(lastNotice(deps)).toContain('1');
  });

  it('`goal clear` drops the paused goals too', async () => {
    const session = sessionWithQueue();
    pauseCurrentGoal(session);
    const deps = makeDeps(session);
    await new GoalHandler(deps).execute(makeCtx({ text: 'goal clear' }));
    expect(session.goal).toBeUndefined();
    expect(session.goalPaused).toEqual([]);
  });

  it('`goal` lists the paused goals with a resume button each', async () => {
    const session = sessionWithQueue();
    pauseCurrentGoal(session);
    const deps = makeDeps(session);
    await new GoalHandler(deps).execute(makeCtx({ text: 'goal' }));
    const opts = (deps.slackApi.postSystemMessage as any).mock.calls.at(-1)[2];
    const json = JSON.stringify(opts.blocks);
    expect(json).toContain('goal A');
    expect(json).toContain('goal_resume:');
    expect(json).toContain('goal_pause:');
  });
});
