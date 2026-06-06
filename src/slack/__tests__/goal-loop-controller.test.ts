/**
 * Tests for GoalLoopController — the owned goal auto-continuation loop.
 *
 * Covers the loop outcomes (complete / continue / cap) plus the two
 * correctness guards the controller adds over the old index.ts closure:
 *   - M1 epoch guard: a verdict whose intent epoch moved during the eval
 *     (a goal mutation OR an ordinary user message) is discarded — no
 *     mutate / notice / inject.
 *   - M3 bounded eval: a hung dispatch is aborted by the timeout and routed
 *     to the dispatch-failure path instead of wedging the loop.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SyntheticMessageEvent } from '../../cron-scheduler';
import type { ConversationSession, SessionGoal } from '../../types';
import type { GoalEvalVerdict } from '../goal-completion-evaluator';
import { GoalLoopController, type GoalLoopControllerDeps } from '../goal-loop-controller';

const SESSION_KEY = 'C1:T1';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    objective: 'ship the feature',
    status: 'active',
    createdAt: 100,
    updatedAt: 100,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: 10,
    consecutiveBlockedSignals: 0,
    evalAttemptCount: 0,
    epoch: 0,
    ...overrides,
  };
}

function makeSession(goal: SessionGoal): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    model: 'claude-opus-4',
    goal,
    goalLastTurnText: 'did some work',
  } as unknown as ConversationSession;
}

interface Harness {
  controller: GoalLoopController;
  session: ConversationSession;
  goal: SessionGoal;
  injected: SyntheticMessageEvent[];
  notices: string[];
  saveCount: () => number;
  setRequestActive: (v: boolean) => void;
}

function makeHarness(opts: {
  verdict?: GoalEvalVerdict;
  dispatcher?: GoalLoopControllerDeps['dispatcher'];
  goal?: Partial<SessionGoal>;
  evalTimeoutMs?: number;
  requestActive?: boolean;
}): Harness {
  const goal = makeGoal(opts.goal);
  const session = makeSession(goal);
  const injected: SyntheticMessageEvent[] = [];
  const notices: string[] = [];
  let saves = 0;
  let requestActive = opts.requestActive ?? false;

  const dispatcher: GoalLoopControllerDeps['dispatcher'] =
    opts.dispatcher ??
    (async () => JSON.stringify(opts.verdict ?? { completed: false, reason: 'not yet', remaining: ['do X'] }));

  const controller = new GoalLoopController({
    registry: {
      getSessionByKey: () => session,
      getActivityStateByKey: () => 'idle',
      saveSessions: () => {
        saves += 1;
      },
    },
    requestCoordinator: {
      isRequestActive: () => requestActive,
    },
    dispatcher,
    injectContinuation: async (event) => {
      injected.push(event);
    },
    postNotice: async (_channel, _threadTs, text) => {
      notices.push(text);
      return undefined;
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: 'claude-sonnet-4',
    evalTimeoutMs: opts.evalTimeoutMs,
  });

  return {
    controller,
    session,
    goal,
    injected,
    notices,
    saveCount: () => saves,
    setRequestActive: (v) => {
      requestActive = v;
    },
  };
}

describe('GoalLoopController', () => {
  it('completed=true → marks complete, posts ✅, injects nothing', async () => {
    const h = makeHarness({ verdict: { completed: true, reason: 'all done', remaining: [] } });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.status).toBe('complete');
    expect(h.goal.completedVia).toBe('eval-model');
    expect(h.goal.pendingEval).toBeUndefined();
    expect(h.injected).toHaveLength(0);
    expect(h.notices.some((n) => n.includes('✅ Goal completed'))).toBe(true);
  });

  it('completed=false under cap → bumps counter, posts 🔄, injects one continuation', async () => {
    const h = makeHarness({ verdict: { completed: false, reason: 'missing tests', remaining: ['add tests'] } });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.status).toBe('active');
    expect(h.goal.continuationCount).toBe(1);
    expect(h.goal.lastEvalReason).toBe('missing tests');
    expect(h.goal.pendingEval).toBeUndefined();
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0].text).toContain('[goal-continuation]');
    expect(h.notices.some((n) => n.includes('🔄 Goal not yet complete'))).toBe(true);
  });

  it('completed=false at cap → pauses, posts ⏹️, injects nothing', async () => {
    const h = makeHarness({
      verdict: { completed: false, reason: 'still going', remaining: [] },
      goal: { continuationCount: 10, maxContinuations: 10 },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.continuationCount).toBe(10);
    expect(h.injected).toHaveLength(0);
    expect(h.notices.some((n) => n.includes('⏹️ Goal auto-continuation paused'))).toBe(true);
  });

  it('M1: epoch bump during eval (user message / goal mutation) → verdict discarded', async () => {
    // The dispatcher mutates the goal epoch mid-eval to simulate a user
    // message landing while the eval is in flight.
    const h = makeHarness({
      dispatcher: async () => {
        // user weighed in: epoch advances
        h.goal.epoch = (h.goal.epoch ?? 0) + 1;
        return JSON.stringify({ completed: true, reason: 'looks done', remaining: [] });
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    // Verdict (even completed=true) must NOT apply.
    expect(h.goal.status).toBe('active');
    expect(h.goal.completedVia).toBeUndefined();
    expect(h.injected).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
    // Our stale lease was cleared so the loop isn't wedged.
    expect(h.goal.pendingEval).toBeUndefined();
  });

  it('M1: goal replaced (createdAt changes) during eval → verdict discarded', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        h.goal.createdAt = 999; // a brand-new objective replaced the goal
        return JSON.stringify({ completed: false, reason: 'x', remaining: [] });
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.continuationCount).toBe(0);
    expect(h.injected).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
  });

  it('M3: hung eval is aborted by the timeout → dispatch-failure notice, lease cleared', async () => {
    const h = makeHarness({
      dispatcher: () => new Promise<string>(() => {}), // never resolves
      evalTimeoutMs: 30,
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.status).toBe('active');
    expect(h.goal.pendingEval).toBeUndefined();
    expect(h.injected).toHaveLength(0);
    expect(h.notices.some((n) => n.includes('⚠️ Goal completion evaluation failed'))).toBe(true);
  });

  it('does not inject when a turn became active during the eval (never supersede)', async () => {
    const h = makeHarness({ verdict: { completed: false, reason: 'go', remaining: [] } });
    // A user turn starts while the eval runs.
    h.setRequestActive(true);
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    // Gate (requestActive) blocks the run entirely → no eval, no inject.
    expect(h.injected).toHaveLength(0);
  });

  it('serializes overlapping triggers — a second trigger does not start a parallel eval', async () => {
    let inFlight = 0;
    let maxParallel = 0;
    const h = makeHarness({
      dispatcher: async () => {
        inFlight += 1;
        maxParallel = Math.max(maxParallel, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return JSON.stringify({ completed: false, reason: 'r', remaining: [] });
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    // Second trigger is short-circuited by pendingEval, but never overlaps.
    expect(maxParallel).toBe(1);
  });
});
