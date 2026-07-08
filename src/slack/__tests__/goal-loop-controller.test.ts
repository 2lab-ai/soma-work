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
import {
  extractEvalRetryDelayMs,
  GOAL_EVAL_DISPATCH_MAX_RETRIES,
  GOAL_EVAL_RETRY_DEFAULT_DELAY_MS,
  GoalLoopController,
  type GoalLoopControllerDeps,
} from '../goal-loop-controller';

const SESSION_KEY = 'C1:T1';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-test',
    objective: 'ship the feature',
    status: 'active',
    createdAt: 100,
    updatedAt: 100,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: 10,
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
  scheduledRetries: Array<{ fn: () => void; delayMs: number }>;
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
  const scheduledRetries: Array<{ fn: () => void; delayMs: number }> = [];
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
    scheduleEvalRetry: (fn, delayMs) => {
      scheduledRetries.push({ fn, delayMs });
    },
  });

  return {
    controller,
    session,
    goal,
    injected,
    notices,
    scheduledRetries,
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

  it('completed=true WITH a queued goal → advances queue, archives, injects next goal (T2)', async () => {
    const h = makeHarness({ verdict: { completed: true, reason: 'all done', remaining: [] } });
    // queue a second goal behind the active one
    h.session.goalQueue = [makeGoal({ goalId: 'goal-2', objective: 'second objective', status: 'queued', epoch: 0 })];

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    // finished goal archived to history with the eval reason pinned
    expect(h.session.goalHistory).toHaveLength(1);
    expect(h.session.goalHistory?.[0].objective).toBe('ship the feature');
    expect(h.session.goalHistory?.[0].completionReason).toBe('all done');
    // next goal promoted to active and its continuation injected
    expect(h.session.goal?.objective).toBe('second objective');
    expect(h.session.goal?.status).toBe('active');
    expect(h.session.goalQueue).toHaveLength(0);
    expect(h.injected).toHaveLength(1);
    expect(h.notices.some((n) => n.includes('✅ Goal completed'))).toBe(true);
    expect(h.notices.some((n) => n.includes('Starting next queued goal'))).toBe(true);
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
    // M2: the injected event must carry the never-supersede marker so
    // session-initializer drops it (never aborts a live user turn).
    expect(h.injected[0].routeContext?.goalContinuation).toBe(true);
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

  it('M1: goal replaced (goalId changes) during eval → verdict discarded', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        h.goal.goalId = 'goal-replaced'; // a brand-new objective replaced the goal
        return JSON.stringify({ completed: false, reason: 'x', remaining: [] });
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.continuationCount).toBe(0);
    expect(h.injected).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
  });

  it('M3: hung eval is aborted by the timeout → retry scheduled, lease cleared', async () => {
    const h = makeHarness({
      dispatcher: () => new Promise<string>(() => {}), // never resolves
      evalTimeoutMs: 30,
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.status).toBe('active');
    expect(h.goal.pendingEval).toBeUndefined();
    expect(h.injected).toHaveLength(0);
    // A timeout is a transient dispatch failure — the loop now self-heals by
    // scheduling a re-eval instead of stopping on the manual notice.
    expect(h.goal.evalDispatchRetryCount).toBe(1);
    expect(h.scheduledRetries).toHaveLength(1);
    expect(h.scheduledRetries[0].delayMs).toBe(GOAL_EVAL_RETRY_DEFAULT_DELAY_MS);
    expect(h.notices.some((n) => n.includes('⏳ Goal completion evaluation hit a transient API error'))).toBe(true);
    expect(h.notices.some((n) => n.includes('⚠️ Goal completion evaluation failed'))).toBe(false);
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

  it('S9: an unchanged work summary short-circuits the eval but still drives a continuation', async () => {
    let dispatchCount = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatchCount += 1;
        return JSON.stringify({ completed: false, reason: 'missing tests', remaining: ['add tests'] });
      },
    });

    // First settle: real eval runs, records the summary hash + reason.
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    expect(h.goal.continuationCount).toBe(1);
    expect(h.goal.lastEvalSummaryHash).toBeDefined();

    // Second settle with the SAME goalLastTurnText: no new dispatch, but the
    // loop still advances (reuses the prior "not complete" verdict).
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1); // short-circuited — no second eval
    expect(h.goal.continuationCount).toBe(2);
    expect(h.injected).toHaveLength(2);
  });

  it('S9: a changed work summary does NOT short-circuit (re-evaluates)', async () => {
    let dispatchCount = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatchCount += 1;
        return JSON.stringify({ completed: false, reason: 'r', remaining: [] });
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);

    // New work produced → summary changes → real eval runs again.
    h.session.goalLastTurnText = 'did MORE work';
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(2);
  });
});

/** The gateway pool-exhaustion rejection from the 2026-07-07 incident. */
const POOL_RATE_LIMIT_ERR =
  'API Error: Request rejected (429) · All 9 eligible accounts are rate-limited right now; retry in 3283s.';

describe('GoalLoopController — transient eval-dispatch failure retry', () => {
  it('rate-limit failure with a stashed advertised window → retry scheduled at that window', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        const err = new Error('one-shot dispatch aborted during pool rate-limit retry wait');
        (err as { poolRateLimitRetryMs?: number }).poolRateLimitRetryMs = 3283 * 1000;
        throw err;
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.pendingEval).toBeUndefined(); // lease cleared — loop not wedged
    expect(h.goal.evalDispatchRetryCount).toBe(1);
    expect(h.scheduledRetries).toHaveLength(1);
    expect(h.scheduledRetries[0].delayMs).toBe(3283 * 1000);
    expect(h.notices.some((n) => n.includes('⏳ Goal completion evaluation hit a transient API error'))).toBe(true);
    expect(h.notices.some((n) => n.includes('Run `goal done`'))).toBe(false);
  });

  it('rate-limit failure detected from the message text → parsed "retry in Ns" honored', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        throw new Error(POOL_RATE_LIMIT_ERR);
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.scheduledRetries).toHaveLength(1);
    expect(h.scheduledRetries[0].delayMs).toBe(3283 * 1000);
  });

  it('non-rate-limit transient failure → default backoff', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        throw new Error('API Error: 529 overloaded_error');
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.scheduledRetries).toHaveLength(1);
    expect(h.scheduledRetries[0].delayMs).toBe(GOAL_EVAL_RETRY_DEFAULT_DELAY_MS);
  });

  it('firing the scheduled retry re-runs the eval; success applies the verdict and resets the streak', async () => {
    let dispatchCount = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatchCount += 1;
        if (dispatchCount === 1) throw new Error(POOL_RATE_LIMIT_ERR);
        return JSON.stringify({ completed: false, reason: 'still missing tests', remaining: ['add tests'] });
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.goal.evalDispatchRetryCount).toBe(1);
    expect(h.scheduledRetries).toHaveLength(1);

    // The advertised window elapses → the scheduled retry fires.
    h.scheduledRetries[0].fn();
    await h.controller.settled(SESSION_KEY);

    expect(dispatchCount).toBe(2);
    expect(h.goal.evalDispatchRetryCount).toBeUndefined(); // streak closed by the successful dispatch
    expect(h.goal.continuationCount).toBe(1); // verdict applied → continuation injected
    expect(h.injected).toHaveLength(1);
  });

  it('queued duplicate settle during the backoff window does NOT re-dispatch (budget protected)', async () => {
    let dispatchCount = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatchCount += 1;
        if (dispatchCount === 1) throw new Error(POOL_RATE_LIMIT_ERR);
        return JSON.stringify({ completed: false, reason: 'r', remaining: [] });
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    expect(h.goal.evalBackoffUntil).toBeGreaterThan(Date.now());

    // A duplicate settle (e.g. queued behind the failing run) lands while the
    // advertised window is still open — the backoff gate must skip it instead
    // of hammering the same 429 and burning the retry budget.
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    expect(h.goal.evalDispatchRetryCount).toBe(1); // budget untouched
    expect(h.scheduledRetries).toHaveLength(1); // re-arm deduped — no timer stacking

    // The scheduled retry lifts the gate and dispatches.
    h.scheduledRetries[0].fn();
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(2);
    expect(h.goal.evalBackoffUntil).toBeUndefined();
  });

  it('a stale armed timer never suppresses (or unarms) a newer failure’s retry', async () => {
    let dispatchCount = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatchCount += 1;
        if (dispatchCount <= 2) throw new Error(POOL_RATE_LIMIT_ERR);
        return JSON.stringify({ completed: false, reason: 'r', remaining: [] });
      },
    });

    // Failure A arms timer A.
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.scheduledRetries).toHaveLength(1);

    // User message: epoch bumps, backoff lifted (resetGoalContinuationOnUserMessage semantics).
    h.goal.epoch = (h.goal.epoch ?? 0) + 1;
    h.goal.evalBackoffUntil = undefined;
    h.goal.evalDispatchRetryCount = undefined;

    // The user's turn settles → eval B runs and fails → must arm timer B even
    // though stale timer A is still pending.
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(2);
    expect(h.scheduledRetries).toHaveLength(2);

    // Stale timer A fires first: superseded → must not act NOR delete B's arm.
    h.scheduledRetries[0].fn();
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(2);
    expect(h.goal.evalBackoffUntil).toBeGreaterThan(Date.now()); // B's window intact

    // Timer B fires: lifts the gate and dispatches.
    h.scheduledRetries[1].fn();
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(3);
    expect(h.goal.evalBackoffUntil).toBeUndefined();
  });

  it('restart during the backoff window → the first settle re-arms a retry for the remaining window', async () => {
    // Simulate a restart: `evalBackoffUntil` persisted on the goal, but the
    // in-memory timer (and the armed-set) died with the old process.
    let dispatchCount = 0;
    const backoffUntil = Date.now() + 42_000;
    const h = makeHarness({
      dispatcher: async () => {
        dispatchCount += 1;
        return JSON.stringify({ completed: false, reason: 'r', remaining: [] });
      },
      goal: { evalDispatchRetryCount: 1, evalBackoffUntil: backoffUntil },
    });

    // Post-restart settle (resumeActiveGoals): gated — but must re-arm.
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(0);
    expect(h.scheduledRetries).toHaveLength(1);
    expect(h.scheduledRetries[0].delayMs).toBeGreaterThan(0);
    expect(h.scheduledRetries[0].delayMs).toBeLessThanOrEqual(42_000);

    // Window elapses → the re-armed retry lifts the gate and dispatches.
    h.scheduledRetries[0].fn();
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    expect(h.goal.evalBackoffUntil).toBeUndefined();
  });

  it('budget exhausted → terminal manual notice, streak reset for a fresh user nudge', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        throw new Error(POOL_RATE_LIMIT_ERR);
      },
      goal: { evalDispatchRetryCount: GOAL_EVAL_DISPATCH_MAX_RETRIES },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.scheduledRetries).toHaveLength(0);
    expect(h.notices.some((n) => n.includes('⚠️ Goal completion evaluation failed'))).toBe(true);
    // Reset so the NEXT user message starts a fresh retry budget.
    expect(h.goal.evalDispatchRetryCount).toBeUndefined();
  });

  it('epoch moved during the failed eval → no retry, no notice, but OUR lease is released', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        h.goal.epoch = (h.goal.epoch ?? 0) + 1; // user weighed in mid-eval
        throw new Error(POOL_RATE_LIMIT_ERR);
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.scheduledRetries).toHaveLength(0);
    expect(h.goal.evalDispatchRetryCount).toBeUndefined();
    // User intent wins — no notices at all (neither retry nor terminal).
    expect(h.notices).toHaveLength(0);
    // The stale lease we stamped must not wedge future driver runs.
    expect(h.goal.pendingEval).toBeUndefined();
  });

  it('user weighs in during the retry wait (epoch bump) → the scheduled retry no-ops at fire time', async () => {
    let dispatchCount = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatchCount += 1;
        throw new Error(POOL_RATE_LIMIT_ERR);
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    expect(h.scheduledRetries).toHaveLength(1);

    // A real user message lands while we wait for the advertised window.
    h.goal.epoch = (h.goal.epoch ?? 0) + 1;

    h.scheduledRetries[0].fn();
    await h.controller.settled(SESSION_KEY);

    // The retry deferred to the user's own turn-settled trigger — no stale eval.
    expect(dispatchCount).toBe(1);
    expect(h.scheduledRetries).toHaveLength(1);
  });

  it('retry fires against a goal that was cleared meanwhile → gate blocks, nothing happens', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        throw new Error(POOL_RATE_LIMIT_ERR);
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.scheduledRetries).toHaveLength(1);

    h.session.goal = undefined; // goal cleared while waiting for the window
    h.scheduledRetries[0].fn();
    await h.controller.settled(SESSION_KEY);

    expect(h.injected).toHaveLength(0);
    expect(h.scheduledRetries).toHaveLength(1); // no second retry scheduled
  });
});

describe('extractEvalRetryDelayMs', () => {
  it('prefers the stashed poolRateLimitRetryMs (bounded)', () => {
    const err = Object.assign(new Error('aborted during pool rate-limit retry wait'), {
      poolRateLimitRetryMs: 42_000,
    });
    expect(extractEvalRetryDelayMs(err)).toBe(42_000);
  });

  it('bounds an absurd stashed window to the shared 1-hour ceiling', () => {
    const err = Object.assign(new Error('x'), { poolRateLimitRetryMs: 999_999_000 });
    expect(extractEvalRetryDelayMs(err)).toBe(60 * 60 * 1000);
  });

  it('parses the advertised window from the incident message', () => {
    expect(extractEvalRetryDelayMs(new Error(POOL_RATE_LIMIT_ERR))).toBe(3283 * 1000);
  });

  it('falls back to the default for unrelated errors', () => {
    expect(extractEvalRetryDelayMs(new Error('goal completion eval timed out after 120000ms'))).toBe(
      GOAL_EVAL_RETRY_DEFAULT_DELAY_MS,
    );
    expect(extractEvalRetryDelayMs('string failure')).toBe(GOAL_EVAL_RETRY_DEFAULT_DELAY_MS);
  });
});
