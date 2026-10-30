/**
 * A goal parked at its auto-continuation budget (10/10) must not block other
 * goals (SSOT 2026-10-30 T1: "10/10 일때 유저가 새로 채팅으로 지시하면 신규 goal이
 * 추가되는데 기존 골이 10/10으로 스턱됨 이거 픽스해줘").
 *
 * Before the fix a capped goal stayed `active` forever (it never completes on
 * its own) and the queue only advanced on completion/delete, so:
 *   - F2: a goal requested while the current goal sat at 10/10 was queued
 *     behind it and never started;
 *   - F1: a goal queued earlier never started once the current goal capped.
 *
 * The fix: the cap stamps `capReachedAt` ("the loop stopped this goal at its
 * budget and has not driven it since"). A parked goal yields — to a new goal
 * request (F2) or to a never-parked queued goal (F1) — and moves to the back
 * of the queue with the marker kept, so the loop can never rotate back to it
 * on its own (no unbounded autonomous turns).
 */

import { describe, expect, it, vi } from 'vitest';
import type { SyntheticMessageEvent } from '../../cron-scheduler';
import type { ConversationSession, SessionGoal } from '../../types';
import { GoalHandler } from '../commands/goal-handler';
import type { CommandContext, CommandDependencies } from '../commands/types';
import { decideGoalEvalOutcome } from '../goal-completion-evaluator';
import { resetGoalContinuationOnUserMessage } from '../goal-continuation';
import { GoalLoopController, type GoalLoopControllerDeps } from '../goal-loop-controller';
import { advanceGoalQueue, deleteCurrentGoal, enqueueOrActivateGoal, isGoalOutOfBudget } from '../session-goal';

const SESSION_KEY = 'C1:T1';
const CAPPED_AT = 1_790_000_000_000;

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-a',
    objective: 'ship feature A',
    status: 'active',
    createdAt: 100,
    updatedAt: 100,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 3,
    ...overrides,
  };
}

/** The current goal as the loop leaves it at the cap: active, 10/10, marker set. */
function parkedGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return makeGoal({ continuationCount: 10, capReachedAt: CAPPED_AT, capDmPendingAt: CAPPED_AT, ...overrides });
}

function makeSession(goal: SessionGoal | undefined, extra: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 'T1',
    model: 'claude-opus-4',
    systemPrompt: 'cached',
    goal,
    goalLastTurnText: 'did some work',
    ...extra,
  } as unknown as ConversationSession;
}

describe('T1 F2 — a new goal requested while the current goal is parked at 10/10', () => {
  it('starts the new goal now and moves the parked goal to the back of the queue (marker kept)', () => {
    const a = parkedGoal();
    const session = makeSession(a);

    const result = enqueueOrActivateGoal(session, 'ship feature B', 'U1');

    expect(result.activated).toBe(true);
    expect(session.goal?.objective).toBe('ship feature B');
    expect(session.goal?.status).toBe('active');
    expect(session.goal?.continuationCount).toBe(0);
    // A new objective invalidates any eval staged for the parked goal (M1).
    expect(session.goal?.epoch).toBeGreaterThan(3);
    expect(result.displaced?.goalId).toBe('goal-a');
    expect(session.goalQueue?.map((g) => g.goalId)).toEqual(['goal-a']);
    const moved = session.goalQueue?.[0];
    expect(moved?.status).toBe('queued');
    // Kept: the loop must never rotate back to it on its own.
    expect(moved?.capReachedAt).toBe(CAPPED_AT);
    // Its pending "keep going?" DM is moot once it is no longer current.
    expect(moved?.capDmPendingAt).toBeUndefined();
  });

  it('queues the parked goal BEHIND goals that were already waiting', () => {
    const session = makeSession(parkedGoal(), {
      goalQueue: [makeGoal({ goalId: 'goal-q', objective: 'waiting', status: 'queued', epoch: 0 })],
    });

    enqueueOrActivateGoal(session, 'ship feature B', 'U1');

    expect(session.goal?.objective).toBe('ship feature B');
    expect(session.goalQueue?.map((g) => g.goalId)).toEqual(['goal-q', 'goal-a']);
  });

  it('still queues behind a goal at 10/10 that the loop has not parked yet (its last turn is running)', () => {
    // The 10th continuation turn runs with count === max; only the cap
    // verdict parks the goal. A request in that window must not preempt it.
    const session = makeSession(makeGoal({ continuationCount: 10 }));

    const result = enqueueOrActivateGoal(session, 'ship feature B', 'U1');

    expect(result.activated).toBe(false);
    expect(session.goal?.goalId).toBe('goal-a');
    expect(session.goalQueue?.map((g) => g.objective)).toEqual(['ship feature B']);
  });

  it('a plain chat message resets the counter but keeps the goal parked, so a SET_GOAL in that turn starts at once', () => {
    const a = parkedGoal();
    const session = makeSession(a);

    resetGoalContinuationOnUserMessage(session);
    expect(a.continuationCount).toBe(0);
    expect(a.capReachedAt).toBe(CAPPED_AT);

    const result = enqueueOrActivateGoal(session, 'ship feature B', 'U1');
    expect(result.activated).toBe(true);
    expect(session.goal?.objective).toBe('ship feature B');
  });

  it('`goal <text>` starts the new goal (not "queued") and says where the parked goal went', async () => {
    const session = makeSession(parkedGoal());
    const postSystemMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    const deps = {
      claudeHandler: {
        getSession: vi.fn().mockReturnValue(session),
        getSessionKey: vi.fn().mockReturnValue(SESSION_KEY),
        saveSessions: vi.fn(),
      },
      slackApi: { postSystemMessage },
      userSettingsStore: { getUserGoalMaxContinuations: vi.fn().mockReturnValue(undefined) },
    } as unknown as CommandDependencies;
    const ctx = {
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      text: 'goal ship feature B',
      say: vi.fn(),
    } as unknown as CommandContext;

    const result = await new GoalHandler(deps).execute(ctx);

    expect(result.continueWithPrompt).toBe('ship feature B');
    expect(result.goalQueued).toBeUndefined();
    const notices = postSystemMessage.mock.calls.map((c) => String(c[1]));
    expect(notices.some((n) => n.includes('Goal set'))).toBe(true);
    expect(notices.some((n) => n.includes('Goal queued'))).toBe(false);
    expect(notices.some((n) => n.includes('ship feature A') && n.includes('back of the queue'))).toBe(true);
  });

  it('a refused opening turn puts the parked goal back exactly where it was', async () => {
    const a = parkedGoal();
    const session = makeSession(a);
    const deps = {
      claudeHandler: {
        getSession: vi.fn().mockReturnValue(session),
        getSessionKey: vi.fn().mockReturnValue(SESSION_KEY),
        saveSessions: vi.fn(),
      },
      slackApi: { postSystemMessage: vi.fn().mockResolvedValue({ ts: 'm' }) },
      userSettingsStore: { getUserGoalMaxContinuations: vi.fn().mockReturnValue(undefined) },
    } as unknown as CommandDependencies;
    const ctx = {
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      text: 'goal ship feature B',
      say: vi.fn(),
      admitOpening: () => ({ failed: 'fence closed' }),
    } as unknown as CommandContext;

    await new GoalHandler(deps).execute(ctx);

    expect(session.goal).toBe(a);
    expect(a.status).toBe('active');
    expect(a.capReachedAt).toBe(CAPPED_AT);
    expect(session.goalQueue ?? []).toHaveLength(0);
  });
});

describe('T1 — capReachedAt lifecycle', () => {
  const notDone = { completed: false, reason: 'gap', remaining: [] };

  it('the cap verdict stamps it once; a later continue verdict clears it', () => {
    const goal = makeGoal({ continuationCount: 10 });
    expect(decideGoalEvalOutcome(goal, notDone, 5_000).action).toBe('cap-paused');
    expect(goal.capReachedAt).toBe(5_000);
    expect(decideGoalEvalOutcome(goal, notDone, 6_000).action).toBe('cap-paused');
    expect(goal.capReachedAt).toBe(5_000);

    goal.continuationCount = 0; // a user weighed in
    expect(decideGoalEvalOutcome(goal, notDone, 7_000).action).toBe('continue');
    expect(goal.capReachedAt).toBeUndefined();
  });

  it('completion clears it', () => {
    const goal = parkedGoal();
    decideGoalEvalOutcome(goal, { completed: true, reason: 'done', remaining: [] });
    expect(goal.capReachedAt).toBeUndefined();
  });

  const promotions = [
    (s: ConversationSession) => advanceGoalQueue(s),
    (s: ConversationSession) => deleteCurrentGoal(s).promoted,
  ];

  it('promotion prefers a goal that was never parked, and starts it as a fresh run (both paths)', () => {
    for (const promote of promotions) {
      const session = makeSession(makeGoal({ status: 'complete' }), {
        goalQueue: [
          parkedGoal({ goalId: 'goal-p', status: 'queued', capDmPendingAt: undefined }),
          makeGoal({ goalId: 'goal-f', status: 'queued', continuationCount: 4, capDmPendingAt: 1 }),
        ],
      });
      const next = promote(session);
      expect(next?.goalId).toBe('goal-f');
      expect(next?.status).toBe('active');
      expect(next?.continuationCount).toBe(0);
      expect(next?.capDmPendingAt).toBeUndefined();
      expect(session.goalQueue?.map((g) => g.goalId)).toEqual(['goal-p']);
    }
  });

  it('a parked goal promoted back keeps its used-up budget and last verdict — no fresh budget without the owner (both paths)', () => {
    for (const promote of promotions) {
      const session = makeSession(makeGoal({ status: 'complete' }), {
        goalQueue: [
          parkedGoal({
            goalId: 'goal-p',
            status: 'queued',
            lastEvalReason: 'tests still red',
            lastAssistantTurnSummary: 'ran the suite',
          }),
        ],
      });
      const next = promote(session);
      expect(next?.goalId).toBe('goal-p');
      expect(next?.status).toBe('active');
      expect(next?.capReachedAt).toBe(CAPPED_AT);
      expect(next?.continuationCount).toBe(10);
      expect(next?.lastEvalReason).toBe('tests still red');
      expect(next?.lastAssistantTurnSummary).toBe('ran the suite');
      expect(isGoalOutOfBudget(next)).toBe(true);
      // A stale "keep going?" DM must not suppress the new one.
      expect(next?.capDmPendingAt).toBeUndefined();
      expect(decideGoalEvalOutcome(next as SessionGoal, notDone).action).toBe('cap-paused');
    }
  });

  it('a parked goal whose counter a real user message had reset comes back with that budget (the user weighed in)', () => {
    const session = makeSession(makeGoal({ status: 'complete' }), {
      goalQueue: [parkedGoal({ goalId: 'goal-p', status: 'queued', continuationCount: 0 })],
    });
    const next = advanceGoalQueue(session);
    expect(next?.continuationCount).toBe(0);
    expect(isGoalOutOfBudget(next)).toBe(false);
    expect(decideGoalEvalOutcome(next as SessionGoal, notDone).action).toBe('continue');
    expect(next?.capReachedAt).toBeUndefined();
  });
});

interface Harness {
  controller: GoalLoopController;
  session: ConversationSession;
  injected: SyntheticMessageEvent[];
  notices: string[];
  dms: string[];
}

function makeHarness(session: ConversationSession, opts: { completed?: boolean; noticeFails?: boolean } = {}): Harness {
  const injected: SyntheticMessageEvent[] = [];
  const notices: string[] = [];
  const dms: string[] = [];
  const controller = new GoalLoopController({
    registry: {
      getSessionByKey: () => session,
      getActivityStateByKey: () => 'idle',
      saveSessions: vi.fn(),
    },
    requestCoordinator: { isRequestActive: () => false },
    dispatcher: async () =>
      JSON.stringify({ completed: opts.completed ?? false, reason: 'still going', remaining: ['do X'] }),
    injectContinuation: async (event) => {
      injected.push(event);
    },
    postNotice: async (_c, _t, text) => {
      if (opts.noticeFails) throw new Error('slack down');
      notices.push(text);
      return undefined;
    },
    postOwnerDm: async (_u, text) => {
      dms.push(text);
      return undefined;
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: 'claude-sonnet-4',
    now: () => CAPPED_AT,
  } satisfies GoalLoopControllerDeps);
  return { controller, session, injected, notices, dms };
}

describe('T1 F1 — the current goal reaches its cap while another goal is waiting', () => {
  it('yields to the waiting goal: B becomes current and gets a continuation, A goes to the back (no DM)', async () => {
    const a = makeGoal({ continuationCount: 10 });
    const b = makeGoal({ goalId: 'goal-b', objective: 'ship feature B', status: 'queued', epoch: 0 });
    const h = makeHarness(makeSession(a, { goalQueue: [b] }));

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.session.goal?.goalId).toBe('goal-b');
    expect(h.session.goal?.status).toBe('active');
    expect(h.session.goal?.epoch).toBeGreaterThan(a.epoch ?? 0);
    expect(h.session.goalQueue?.map((g) => g.goalId)).toEqual(['goal-a']);
    expect(a.status).toBe('queued');
    expect(a.capReachedAt).toBe(CAPPED_AT);
    // Not archived: a goal that ran out of budget is not a completed goal.
    expect(h.session.goalHistory ?? []).toHaveLength(0);
    expect(h.injected).toHaveLength(1);
    expect(h.dms).toHaveLength(0);
    expect(h.notices.some((n) => n.includes('ship feature B'))).toBe(true);
  });

  it('never rotates back to a goal that is itself parked — it stops and asks the owner instead', async () => {
    const b = makeGoal({ goalId: 'goal-b', objective: 'ship feature B', continuationCount: 10 });
    const parkedA = parkedGoal({ status: 'queued', capDmPendingAt: undefined });
    const h = makeHarness(makeSession(b, { goalQueue: [parkedA] }));

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.session.goal?.goalId).toBe('goal-b');
    expect(h.session.goal?.capReachedAt).toBe(CAPPED_AT);
    expect(h.session.goalQueue?.map((g) => g.goalId)).toEqual(['goal-a']);
    expect(h.injected).toHaveLength(0);
    expect(h.dms).toHaveLength(1);
  });

  it('yields to the first waiting goal that has not been parked, keeping the others in order', async () => {
    const b = makeGoal({ goalId: 'goal-b', objective: 'ship feature B', continuationCount: 10 });
    const parkedA = parkedGoal({ status: 'queued', capDmPendingAt: undefined });
    const c = makeGoal({ goalId: 'goal-c', objective: 'ship feature C', status: 'queued', epoch: 0 });
    const h = makeHarness(makeSession(b, { goalQueue: [parkedA, c] }));

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.session.goal?.goalId).toBe('goal-c');
    expect(h.session.goalQueue?.map((g) => g.goalId)).toEqual(['goal-a', 'goal-b']);
    expect(h.injected).toHaveLength(1);
  });
});

describe('T1 — legacy parked goals and goals returning from the queue', () => {
  it('B2: a goal whose owner was already asked "keep going?" does not yield on its own — the owner decides', async () => {
    // Capped before this change: owner DM pending, no marker yet, a fresh goal queued behind it.
    const a = makeGoal({ continuationCount: 10, capDmPendingAt: 1_000 });
    const b = makeGoal({ goalId: 'goal-b', objective: 'ship feature B', status: 'queued', epoch: 0 });
    const h = makeHarness(makeSession(a, { goalQueue: [b] }));

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.session.goal?.goalId).toBe('goal-a');
    expect(a.capReachedAt).toBe(CAPPED_AT); // now parked, so a new goal request displaces it (F2)
    expect(h.session.goalQueue?.map((g) => g.goalId)).toEqual(['goal-b']);
    expect(h.injected).toHaveLength(0);

    const result = enqueueOrActivateGoal(h.session, 'ship feature C', 'U1');
    expect(result.activated).toBe(true);
    expect(result.displaced?.goalId).toBe('goal-a');
  });

  it('A2: when the goal ahead completes and a parked goal comes back, it is not continued — the owner is asked', async () => {
    const b = makeGoal({ goalId: 'goal-b', objective: 'ship feature B' });
    const parkedA = parkedGoal({ status: 'queued', capDmPendingAt: undefined });
    const h = makeHarness(makeSession(b, { goalQueue: [parkedA] }), { completed: true });

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.session.goal?.goalId).toBe('goal-a');
    expect(h.session.goal?.status).toBe('active');
    expect(h.session.goal?.capReachedAt).toBe(CAPPED_AT);
    expect(h.session.goal?.continuationCount).toBe(10);
    expect(h.injected).toHaveLength(0);
    expect(h.dms).toHaveLength(1);
    expect(h.session.goal?.capDmPendingAt).toBe(CAPPED_AT);
    expect(h.notices.some((n) => n.includes('Starting next queued goal'))).toBe(false);

    // A restart re-runs the loop for the now-current parked goal: still no turn.
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.injected).toHaveLength(0);
  });

  it('`goal done` with only a goal that used its budget waiting: no opening turn, the thread is told how to continue it', async () => {
    const session = makeSession(makeGoal({ goalId: 'goal-b', objective: 'ship feature B' }), {
      goalQueue: [parkedGoal({ status: 'queued', capDmPendingAt: undefined })],
    });
    const postSystemMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    const deps = {
      claudeHandler: {
        getSession: vi.fn().mockReturnValue(session),
        getSessionKey: vi.fn().mockReturnValue(SESSION_KEY),
        saveSessions: vi.fn(),
      },
      slackApi: { postSystemMessage },
      userSettingsStore: { getUserGoalMaxContinuations: vi.fn().mockReturnValue(undefined) },
    } as unknown as CommandDependencies;
    const admitOpening = vi.fn();
    const ctx = {
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      text: 'goal done',
      say: vi.fn(),
      admitOpening,
    } as unknown as CommandContext;

    const result = await new GoalHandler(deps).execute(ctx);

    expect(session.goal?.goalId).toBe('goal-a');
    expect(session.goal?.continuationCount).toBe(10);
    expect(result.continueWithPrompt).toBeUndefined();
    expect(admitOpening).not.toHaveBeenCalled();
    const notices = postSystemMessage.mock.calls.map((c) => String(c[1]));
    expect(notices.some((n) => n.includes('Goal marked complete') && n.includes('already used'))).toBe(true);
  });

  it('a failed Slack notice does not stop the next goal from starting', async () => {
    const a = makeGoal({ continuationCount: 10 });
    const b = makeGoal({ goalId: 'goal-b', objective: 'ship feature B', status: 'queued', epoch: 0 });
    const h = makeHarness(makeSession(a, { goalQueue: [b] }), { noticeFails: true });

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.session.goal?.goalId).toBe('goal-b');
    expect(h.injected).toHaveLength(1);
  });
});
