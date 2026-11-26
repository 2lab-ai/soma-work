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
import { GOAL_NO_NEW_EVAL_MARK } from '../../prompt/session-goal-block';
import type { ConversationSession, SessionGoal } from '../../types';
import type { GoalEvalVerdict } from '../goal-completion-evaluator';
import {
  extractEvalRetryDelayMs,
  GOAL_EVAL_DISPATCH_MAX_RETRIES,
  GOAL_EVAL_RETRY_DEFAULT_DELAY_MS,
  GOAL_SUMMARY_PERSIST_MAX,
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
  fallbackModel?: GoalLoopControllerDeps['fallbackModel'];
  evalModelOverride?: string;
  awaitingHostWork?: GoalLoopControllerDeps['awaitingHostWork'];
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
      saveSessions: () => {
        saves += 1;
      },
    },
    requestCoordinator: {
      isRequestActive: () => requestActive,
    },
    turnHeld: () => requestActive,
    dispatcher,
    injectContinuation: async (event) => {
      injected.push(event);
    },
    postNotice: async (_channel, _threadTs, text) => {
      notices.push(text);
      return undefined;
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: opts.fallbackModel ?? (() => ({ model: 'claude-sonnet-4' })),
    evalModelOverride: opts.evalModelOverride,
    evalTimeoutMs: opts.evalTimeoutMs,
    scheduleEvalRetry: (fn, delayMs) => {
      scheduledRetries.push({ fn, delayMs });
    },
    awaitingHostWork: opts.awaitingHostWork,
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

  // llmux tenant keys: the eval is made for the session's user — the current
  // initiator first, then the owner — so it is metered under their own key.
  it('passes the session initiator (else the owner) to the eval dispatcher as the tenant user', async () => {
    const seen: Array<string | undefined> = [];
    const dispatcher: GoalLoopControllerDeps['dispatcher'] = async (params) => {
      seen.push(params.tenantUserId);
      return JSON.stringify({ completed: true, reason: 'all done', remaining: [] });
    };

    const withInitiator = makeHarness({ dispatcher });
    Object.assign(withInitiator.session, { ownerId: 'U_OWNER', currentInitiatorId: 'U_DAN' });
    withInitiator.controller.onTurnSettled(SESSION_KEY);
    await withInitiator.controller.settled(SESSION_KEY);

    const ownerOnly = makeHarness({ dispatcher });
    Object.assign(ownerOnly.session, { ownerId: 'U_OWNER' });
    ownerOnly.controller.onTurnSettled(SESSION_KEY);
    await ownerOnly.controller.settled(SESSION_KEY);

    const noUser = makeHarness({ dispatcher });
    noUser.controller.onTurnSettled(SESSION_KEY);
    await noUser.controller.settled(SESSION_KEY);

    expect(seen).toEqual(['U_DAN', 'U_OWNER', undefined]);
  });

  // The eval matches the work model. A session with no model (legacy) runs the
  // fallback — the sonnet aux tier of the OWNER's default model in production
  // (index.ts) — asked for that owner; GOAL_EVAL_MODEL beats both.
  it('eval model: GOAL_EVAL_MODEL, else the session model, else fallbackModel(owner)', async () => {
    const models: string[] = [];
    const efforts: (string | undefined)[] = [];
    const dispatcher: GoalLoopControllerDeps['dispatcher'] = async (params) => {
      models.push(params.model);
      efforts.push(params.effort);
      return JSON.stringify({ completed: true, reason: 'all done', remaining: [] });
    };
    // The fallback aux tier can name its own effort (Grok: medium).
    const fallbackModel = vi.fn((owner: string | undefined) => ({
      model: `fallback-for-${owner}`,
      effort: 'medium' as const,
    }));

    const withModel = makeHarness({ dispatcher, fallbackModel });
    withModel.controller.onTurnSettled(SESSION_KEY);
    await withModel.controller.settled(SESSION_KEY);

    const noModel = makeHarness({ dispatcher, fallbackModel });
    Object.assign(noModel.session, { model: undefined, ownerId: 'U_OWNER', currentInitiatorId: 'U_DAN' });
    noModel.controller.onTurnSettled(SESSION_KEY);
    await noModel.controller.settled(SESSION_KEY);

    const override = makeHarness({ dispatcher, fallbackModel, evalModelOverride: 'cheap-eval' });
    Object.assign(override.session, { model: undefined, ownerId: 'U_OWNER' });
    override.controller.onTurnSettled(SESSION_KEY);
    await override.controller.settled(SESSION_KEY);

    expect(models).toEqual(['claude-opus-4', 'fallback-for-U_OWNER', 'cheap-eval']);
    // Only the fallback call takes the tier's effort; the others keep the session's.
    expect(efforts[1]).toBe('medium');
    expect(efforts[0]).toBe(efforts[2]);
    expect(fallbackModel).toHaveBeenCalledTimes(1);
    expect(fallbackModel).toHaveBeenCalledWith('U_OWNER');
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

  // 2026-11-26 (#1465): a goal added from the dashboard with files, promoted by the eval verdict — the loop starts
  // it itself (no opening turn), so its first continuation carries the files, once.
  it('a promoted goal with files: its first continuation carries them, once; a goal whose opening carried them does not', async () => {
    const file = {
      id: 'F1',
      name: 'shot.png',
      mimetype: 'image/png',
      filetype: 'png',
      url_private: 'https://files.slack.com/F1',
      url_private_download: 'https://files.slack.com/F1/download',
      size: 9,
    };
    const h = makeHarness({ verdict: { completed: true, reason: 'all done', remaining: [] } });
    h.session.goalQueue = [
      makeGoal({ goalId: 'goal-2', objective: 'with a file', status: 'queued', openingFiles: [file] }),
    ];

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.session.goal?.goalId).toBe('goal-2');
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0].files).toEqual([file]);
    expect(h.session.goal?.openingFilesSent).toBe(true);

    // Its next continuation (not done yet) carries no files again.
    const again = makeHarness({
      verdict: { completed: false, reason: 'more', remaining: ['x'] },
      goal: { openingFiles: [file], openingFilesSent: true },
    });
    again.controller.onTurnSettled(SESSION_KEY);
    await again.controller.settled(SESSION_KEY);
    expect(again.injected).toHaveLength(1);
    expect(again.injected[0].files).toBeUndefined();
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

  /**
   * #893 — the continuation names the goal and intent it spent one of, so a
   * drop at the busy slot gives back exactly that one; a queued goal's opening
   * spent nothing.
   */
  it('a continue verdict marks its continuation as spent for this goal and intent; a queued opening does not', async () => {
    const h = makeHarness({ verdict: { completed: false, reason: 'missing tests', remaining: ['add tests'] } });
    h.goal.epoch = 3;
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.injected[0].routeContext?.goalContinuationSpent).toEqual({ goalId: h.goal.goalId, epoch: 3 });

    const next = makeHarness({ verdict: { completed: true, reason: 'all done', remaining: [] } });
    next.session.goalQueue = [makeGoal({ goalId: 'goal-2', objective: 'second', status: 'queued', epoch: 0 })];
    next.controller.onTurnSettled(SESSION_KEY);
    await next.controller.settled(SESSION_KEY);
    expect(next.injected).toHaveLength(1);
    expect(next.injected[0].routeContext?.goalContinuationSpent).toBeUndefined();
  });

  it('a continuation held back because a turn started during the eval does not spend the budget (#893)', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        // A turn starts while the eval runs: the loop must not supersede it.
        h.setRequestActive(true);
        return JSON.stringify({ completed: false, reason: 'missing tests', remaining: ['add tests'] });
      },
      goal: { continuationCount: 4 },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.injected).toHaveLength(0);
    // That turn's own end drives the loop again — and spends one then.
    expect(h.goal.continuationCount).toBe(4);
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

  it('S9: below the cap the same summary is evaluated again (the stall check needs the evaluator)', async () => {
    let dispatchCount = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatchCount += 1;
        return JSON.stringify({ completed: false, reason: 'missing tests', remaining: ['add tests'] });
      },
    });

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    expect(h.goal.lastEvalSummaryHash).toBeDefined();

    // Same goalLastTurnText again: below the cap, a real eval runs.
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(2);
    expect(h.goal.continuationCount).toBe(2);
  });

  // .prd/39 D2 · A4 — at the cap the goal asks its owner (asking(cap)): neither a kick nor a later turn (a host turn
  // does not end the round) judges it again. Below the cap a new turn with the same output is still judged (goal-stall
  // "S9: the same text after a new turn below the cap runs the evaluator").
  it('S9: at the cap the question is open — a kick and a later turn judge nothing more', async () => {
    let dispatchCount = 0;
    const h = makeHarness({
      goal: { continuationCount: 10, maxContinuations: 10 },
      dispatcher: async () => {
        dispatchCount += 1;
        return JSON.stringify({ completed: false, reason: 'missing tests', remaining: ['add tests'] });
      },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    // A kick (no new turn ran): reused.
    h.controller.onTurnSettled(SESSION_KEY, { cause: 'kick' });
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    // A later turn while the owner is asked: the question is the one way on.
    h.controller.onTurnSettled(SESSION_KEY, { cause: 'turn' });
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    expect(h.injected).toHaveLength(0);
  });

  it('S9: a kick over text already judged says so — no new evaluation, no stale "eval-model verdict" notice (2026-11-03)', async () => {
    const h = makeHarness({ verdict: { completed: false, reason: 'missing tests', remaining: ['add tests'] } });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    // A fresh verdict keeps today's notice and today's continuation text.
    expect(h.notices).toEqual([
      '🔄 Goal not yet complete (eval-model verdict).\n*Reason:* missing tests\n*Remaining:*\n• add tests',
    ]);
    expect(h.injected[0].text).not.toContain(GOAL_NO_NEW_EVAL_MARK);

    h.controller.onTurnSettled(SESSION_KEY, { cause: 'kick' });
    await h.controller.settled(SESSION_KEY);
    expect(h.injected).toHaveLength(2);
    expect(h.injected[1].text).toContain(`${GOAL_NO_NEW_EVAL_MARK} nothing changed since the last evaluation`);
    expect(h.injected[1].text).toContain('missing tests');
    expect(h.notices[1]).toBe('🔄 Goal continues — no new evaluation (nothing changed since the last evaluation).');
    expect(h.notices[1]).not.toContain('eval-model verdict');
  });

  it('S9: after a restart the persisted (16k-bounded) summary still matches its hash — a kick does not re-judge it', async () => {
    let dispatchCount = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatchCount += 1;
        return JSON.stringify({ completed: false, reason: 'missing tests', remaining: ['add tests'] });
      },
    });
    const long = `${'evidence line\n'.repeat(1500)}tail`; // > 16k chars
    h.session.goalLastTurnText = long;
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
    // Restart: the in-memory text is gone; the goal keeps the bounded mirror.
    h.session.goalLastTurnText = undefined;
    h.goal.lastAssistantTurnSummary = long.slice(0, GOAL_SUMMARY_PERSIST_MAX);
    h.controller.onTurnSettled(SESSION_KEY, { cause: 'kick' });
    await h.controller.settled(SESSION_KEY);
    expect(dispatchCount).toBe(1);
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

/**
 * dev fleet (2026-10-22): a goal session sat in the dashboard's DONE column
 * for an hour while its completion check waited out a 429. Every loop step
 * runs while the session is idle, so no activity-state transition pushes it —
 * the controller itself must push the board, and leave the error line the
 * card shows next to "re-check at HH:MM".
 */
describe('GoalLoopController — dashboard visibility of loop steps', () => {
  function harness(dispatcher: GoalLoopControllerDeps['dispatcher']) {
    const goal = makeGoal();
    const session = makeSession(goal);
    const pushes: Array<{ pendingEval: boolean; backoffUntil?: number; reason?: string }> = [];
    const scheduledRetries: Array<{ fn: () => void; delayMs: number }> = [];
    let now = 1_000_000;
    const controller = new GoalLoopController({
      registry: {
        getSessionByKey: () => session,
        saveSessions: () => undefined,
        broadcastSessionUpdate: () => {
          pushes.push({
            pendingEval: goal.pendingEval !== undefined,
            backoffUntil: goal.evalBackoffUntil,
            reason: goal.evalRetryReason,
          });
        },
      },
      requestCoordinator: { isRequestActive: () => false },
      turnHeld: () => false,
      dispatcher,
      injectContinuation: async () => undefined,
      postNotice: async () => undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fallbackModel: () => ({ model: 'claude-sonnet-4' }),
      now: () => now,
      scheduleEvalRetry: (fn, delayMs) => {
        scheduledRetries.push({ fn, delayMs });
      },
    });
    return {
      controller,
      goal,
      pushes,
      scheduledRetries,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const rateLimited = () =>
    Object.assign(new Error('one-shot dispatch aborted during pool rate-limit retry wait\nstack noise'), {
      poolRateLimitRetryMs: 3_600_000,
    });

  it('pushes the board when the check starts and when a 429 arms the retry, with the error line', async () => {
    const h = harness(async () => {
      throw rateLimited();
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    // Eval started → pushed with the lease set (card: "Goal 완료 판정 중").
    expect(h.pushes.some((p) => p.pendingEval)).toBe(true);
    // Retry armed → pushed with the window and the first line of the error.
    const armed = h.pushes[h.pushes.length - 1];
    expect(armed?.pendingEval).toBe(false);
    expect(armed?.backoffUntil).toBe(1_000_000 + 3_600_000);
    expect(armed?.reason).toBe('one-shot dispatch aborted during pool rate-limit retry wait');
    expect(h.goal.evalRetryReason).toBe('one-shot dispatch aborted during pool rate-limit retry wait');
    expect(h.goal.evalDispatchRetryCount).toBe(1);
    // Never a push with neither a lease nor a window: that frame would fly
    // the card into DONE and back between "판정 중" and "재시도".
    expect(h.pushes.every((p) => p.pendingEval || p.backoffUntil !== undefined)).toBe(true);
  });

  it('an epoch bump (goal command) drops the window, so the next settle re-checks instead of waiting for nothing', async () => {
    const { bumpGoalEpoch } = await import('../goal-continuation');
    let fail = true;
    const dispatcher = vi.fn(async () => {
      if (fail) throw rateLimited();
      return JSON.stringify({ completed: false, reason: 'still missing', remaining: [] });
    });
    const h = harness(dispatcher);
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.goal.evalBackoffUntil).toBeDefined();

    bumpGoalEpoch(h.goal); // e.g. `goal max 20` while the retry waits
    expect(h.goal.evalBackoffUntil).toBeUndefined();
    expect(h.goal.evalRetryReason).toBeUndefined();

    // The armed retry no-ops (epoch moved) — but the gate is open again, so
    // the next settle actually re-checks.
    h.scheduledRetries[0].fn();
    fail = false;
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatcher).toHaveBeenCalledTimes(2);
    expect(h.goal.lastEvalReason).toBe('still missing');
  });

  it('the retry firing lifts the window and its error line, and pushes; a good verdict keeps them clear', async () => {
    let fail = true;
    const h = harness(async () => {
      if (fail) throw rateLimited();
      return JSON.stringify({ completed: false, reason: 'still missing the review', remaining: ['post review'] });
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.scheduledRetries).toHaveLength(1);

    fail = false;
    h.advance(3_600_000);
    const before = h.pushes.length;
    h.scheduledRetries[0].fn();
    await h.controller.settled(SESSION_KEY);

    expect(h.pushes.length).toBeGreaterThan(before);
    expect(h.pushes[before]).toEqual({ pendingEval: false, backoffUntil: undefined, reason: undefined });
    expect(h.goal.evalBackoffUntil).toBeUndefined();
    expect(h.goal.evalRetryReason).toBeUndefined();
    expect(h.goal.evalDispatchRetryCount).toBeUndefined();
  });

  it('a real user message clears the retry error line with the window', async () => {
    const { resetGoalContinuationOnUserMessage } = await import('../goal-continuation');
    const s = { goal: makeGoal({ evalBackoffUntil: 5, evalDispatchRetryCount: 1, evalRetryReason: 'x' }) };
    resetGoalContinuationOnUserMessage(s);
    expect(s.goal.evalBackoffUntil).toBeUndefined();
    expect(s.goal.evalRetryReason).toBeUndefined();
  });
});

/**
 * ssot-task: T2 — a session the safeguards stopped runs no goal eval and gets
 * no continuation. Field log (dev, 2026-11-04T00:42Z): the loop ran an opus
 * xhigh eval and injected another turn into the blocked session, which hit
 * the same safeguard again.
 */
describe('GoalLoopController — safeguard halt (T2)', () => {
  it('skips the eval and injects nothing while the session is halted', async () => {
    let dispatched = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatched += 1;
        return JSON.stringify({ completed: false, reason: 'not yet', remaining: ['do X'] });
      },
    });
    (h.session as any).safeguardHalt = { atMs: 1, detail: 'reasoning_extraction' };

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(dispatched).toBe(0);
    expect(h.injected).toHaveLength(0);
    expect(h.goal.status).toBe('active');
  });

  it('runs again once the halt is cleared (admin retry)', async () => {
    let dispatched = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatched += 1;
        return JSON.stringify({ completed: false, reason: 'not yet', remaining: ['do X'] });
      },
    });
    (h.session as any).safeguardHalt = { atMs: 1 };
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    (h.session as any).safeguardHalt = undefined;

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(dispatched).toBe(1);
  });
});

/**
 * Review gate (astra-zhuge P1 #4, PR #906): the goal completion eval is its
 * own query. When the safeguards block IT, the work is stopped there — no
 * transient-failure retries, no continuation — and the session is locked.
 */
describe('GoalLoopController — safeguards block on the completion eval (T2)', () => {
  const BLOCK = `API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup).

Details: \`[reasoning_extraction]\`

Request ID: req_eval1`;

  it('locks the session instead of scheduling eval retries', async () => {
    const h = makeHarness({ dispatcher: async () => BLOCK });

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect((h.session as any).safeguardHalt).toEqual(
      expect.objectContaining({ detail: 'reasoning_extraction', requestId: 'req_eval1' }),
    );
    expect(h.scheduledRetries).toHaveLength(0);
    expect(h.injected).toHaveLength(0);
    expect(h.notices.some((n) => n.includes('세이프가드 에러'))).toBe(true);
    expect(h.goal.pendingEval).toBeUndefined();
  });

  it('also when the dispatcher throws the block', async () => {
    const h = makeHarness({
      dispatcher: async () => {
        throw new Error(`Claude Code process exited with code 1\n${BLOCK}`);
      },
    });

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect((h.session as any).safeguardHalt?.requestId).toBe('req_eval1');
    expect(h.scheduledRetries).toHaveLength(0);
  });
});

describe('GoalLoopController — safeguards block on an eval whose epoch moved (review round 2, astra P1 #5)', () => {
  it('still locks the session — the newer instruction would run on the same blocked session', async () => {
    let h: ReturnType<typeof makeHarness>;
    h = makeHarness({
      dispatcher: async () => {
        h.goal.epoch = (h.goal.epoch ?? 0) + 1; // a user message arrived during the eval
        throw new Error(
          "Claude Code process exited with code 1\nAPI Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup).\n\nDetails: `[reasoning_extraction]`\n\nRequest ID: req_r2",
        );
      },
    });

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect((h.session as any).safeguardHalt?.requestId).toBe('req_r2');
    expect(h.scheduledRetries).toHaveLength(0);
    expect(h.goal.pendingEval).toBeUndefined();
  });
});

describe('GoalLoopController — blocked eval stops a running turn (review round 3, astra P1 #1)', () => {
  it('aborts the turn the user started during the eval, with reason safeguard', async () => {
    let h: ReturnType<typeof makeHarness>;
    const abortSession = vi.fn().mockReturnValue(true);
    h = makeHarness({
      dispatcher: async () => {
        h.setRequestActive(true); // the user started a turn while the eval ran
        return "API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup).\n\nDetails: `[reasoning_extraction]`\n\nRequest ID: req_r3";
      },
    });
    (h.controller as any).deps.requestCoordinator.abortSession = abortSession;

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect((h.session as any).safeguardHalt?.requestId).toBe('req_r3');
    expect(abortSession).toHaveBeenCalledWith(SESSION_KEY, 'safeguard');
  });
});

describe('GoalLoopController — blocked eval after a close/restore (review round 6, astra P1)', () => {
  const BLOCK =
    "API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup).\n\nDetails: `[reasoning_extraction]`\n\nRequest ID: req_r6";

  it('locks the LIVE session under the key, not the object the eval captured', async () => {
    let h: ReturnType<typeof makeHarness>;
    let live: any;
    h = makeHarness({
      dispatcher: async () => {
        // The owner closed the session and restored it: a new object under the key.
        live = { ...h.session, goal: { ...h.session.goal }, safeguardHalt: undefined };
        return BLOCK;
      },
    });
    (h.controller as any).deps.registry.getSessionByKey = () => live ?? h.session;

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(live.safeguardHalt?.requestId).toBe('req_r6');
  });

  it('hands the lock to the registry, which tombstones a thread with no live session', async () => {
    const haltSafeguardByKey = vi.fn();
    const h = makeHarness({ dispatcher: async () => BLOCK });
    (h.controller as any).deps.registry.haltSafeguardByKey = haltSafeguardByKey;

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(haltSafeguardByKey).toHaveBeenCalledWith(SESSION_KEY, expect.objectContaining({ requestId: 'req_r6' }));
  });
});

// SSOT 2026-11-19 (review of PR #1378, P2) — the dashboard's confirmed "pause the goal, then stop" can land while the
// loop is posting the notice that precedes a continuation (the eval said "continue", the turn already ended, so the
// stop has nothing to cut). The continuation must not go out for a goal that no longer drives.
describe('GoalLoopController — a pause that lands while the continuation notice posts', () => {
  function rig(verdict: GoalEvalVerdict, mutate: (session: ConversationSession) => void, queued?: SessionGoal) {
    const goal = makeGoal();
    const session = makeSession(goal);
    if (queued) (session as any).goalQueue = [queued];
    const injected: SyntheticMessageEvent[] = [];
    const notices: string[] = [];
    const controller = new GoalLoopController({
      registry: { getSessionByKey: () => session, saveSessions: () => {} },
      requestCoordinator: { isRequestActive: () => false },
      turnHeld: () => false,
      dispatcher: async () => JSON.stringify(verdict),
      injectContinuation: async (event) => {
        injected.push(event);
      },
      postNotice: async (_channel, _threadTs, text) => {
        notices.push(text);
        // The owner's confirm lands during the notice that precedes the continuation.
        if (text.startsWith('🔄') || text.startsWith('▶️')) mutate(session);
        return undefined;
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fallbackModel: () => ({ model: 'claude-sonnet-4' }),
    });
    return { controller, session, injected, notices };
  }
  const pauseInPlace = (session: ConversationSession) => {
    const g = session.goal as SessionGoal;
    g.status = 'paused';
    g.epoch = (g.epoch ?? 0) + 1;
  };

  it('control: nothing lands — the continuation goes out', async () => {
    const h = rig({ completed: false, reason: 'not yet', remaining: ['do X'] }, () => {});
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.injected).toHaveLength(1);
  });

  it('"continue": the goal paused meanwhile — no continuation', async () => {
    const h = rig({ completed: false, reason: 'not yet', remaining: ['do X'] }, pauseInPlace);
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.notices.some((n) => n.startsWith('🔄'))).toBe(true);
    expect(h.injected).toHaveLength(0);
  });

  it('"continue": the goal set aside meanwhile (no current goal) — no continuation', async () => {
    const h = rig({ completed: false, reason: 'not yet', remaining: ['do X'] }, (s) => {
      (s as any).goal = undefined;
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.injected).toHaveLength(0);
  });

  it('complete → the next queued goal starts: paused meanwhile — its first continuation does not go out', async () => {
    const next = makeGoal({ goalId: 'goal-next', objective: 'next one', status: 'queued' });
    const h = rig({ completed: true, reason: 'done', remaining: [] }, pauseInPlace, next);
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.session.goal?.goalId).toBe('goal-next');
    expect(h.injected).toHaveLength(0);
  });
});

/**
 * SSOT 2026-11-19 — a session whose environment work waits in the host's queue or is in flight is waiting on the
 * host, not stuck: no eval runs (it would read the wait as no progress and stop the goal with a question to the
 * owner), nothing is injected. The run's result turn settles the session and drives the loop again.
 */
describe('GoalLoopController — environment work the host runs (env run queue)', () => {
  it('skips the eval and injects nothing while the session waits on queued or running environment work', async () => {
    let dispatched = 0;
    let waiting = true;
    const h = makeHarness({
      dispatcher: async () => {
        dispatched += 1;
        return JSON.stringify({ completed: false, reason: 'not yet', remaining: ['do X'] });
      },
      awaitingHostWork: () => waiting,
    });

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatched).toBe(0);
    expect(h.injected).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
    expect(h.goal.status).toBe('active');

    // The run ended: its result turn settles the session and the loop judges again.
    waiting = false;
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatched).toBe(1);
  });

  /** What a mid-turn auto-compact stop leaves on the session: no turn text, the compaction armed for the next input. */
  const cutByAutoCompact = (session: ConversationSession) => {
    session.goalLastTurnText = '';
    session.autoCompactPending = true;
    session.autoCompactStoppedAtMs = 1_000;
  };

  /**
   * Shared-host dev 2026-11-24 (`work:C0ACM4320MQ:1795377608.069389`): an auto-compact stop cut a goal turn while the
   * session's environment work ran. 05:41:02Z `Request was aborted` → 05:41:12Z `Goal driver fired` → `Goal loop run
   * skipped — the session waits on environment work the host runs`. The stop leaves a goal session's continuation to
   * this loop (`resumeAfterAutoCompactStop` returns for an active goal), so nothing ran for 2.5 hours, until the
   * 08:08Z restart kicked the loop. The wait is a choice a turn makes when it ends; a cut turn made no choice.
   */
  it('resumes a turn an auto-compact stop cut, even while the session waits on environment work', async () => {
    let dispatched = 0;
    const h = makeHarness({
      goal: { lastEvalReason: 'the QA run has not reported yet', lastEvalRemaining: ['read the QA result'] },
      dispatcher: async () => {
        dispatched += 1;
        return JSON.stringify({ completed: false, reason: 'not yet', remaining: ['do X'] });
      },
      awaitingHostWork: () => true,
    });
    cutByAutoCompact(h.session);

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    // No eval (nothing new to judge) — the previous gap is reused and the cut work resumes.
    expect(dispatched).toBe(0);
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0].text).toContain('the QA run has not reported yet');
    expect(h.notices).toEqual(['🔄 Goal continues — no new evaluation (the last turn was cut short).']);
  });

  it('a turn an auto-compact stop cut with no earlier gap is judged, not left waiting on the environment work', async () => {
    let dispatched = 0;
    const h = makeHarness({
      dispatcher: async () => {
        dispatched += 1;
        return JSON.stringify({ completed: false, reason: 'not yet', remaining: ['do X'] });
      },
      awaitingHostWork: () => true,
    });
    cutByAutoCompact(h.session);

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(dispatched).toBe(1);
    expect(h.injected).toHaveLength(1);
  });

  // `queue_enter` and RUN_ENV_SKILL tell the model to end its turn: a turn that hands the work off and ends with no
  // text still waits — resuming it would spend a turn per settle and could hand the same work off twice.
  it('a turn that ended silently on the wait (nothing cut it) still waits on the environment work', async () => {
    let dispatched = 0;
    const h = makeHarness({
      goal: { lastEvalReason: 'the QA run has not reported yet' },
      dispatcher: async () => {
        dispatched += 1;
        return JSON.stringify({ completed: false, reason: 'not yet', remaining: ['do X'] });
      },
      awaitingHostWork: () => true,
    });
    h.session.goalLastTurnText = '';

    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatched).toBe(0);
    expect(h.injected).toHaveLength(0);

    // Over the threshold at its end (armed by the turn-end check) but never stopped: still a wait.
    h.session.autoCompactPending = true;
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(dispatched).toBe(0);
    expect(h.injected).toHaveLength(0);
  });
});

/**
 * .prd/39 D1 · D2 — the loop gate asks the turn occupancy, not the display word. A turn is held while its run is
 * preparing or running (the slot, the controller, the turn runtime's own report); the owner question is the action
 * panel's. `activityState` read from disk or written by the host does not open or close the gate.
 */
describe('GoalLoopController — the loop gate reads turnHeld and the owner question (.prd/39 D1 · D2)', () => {
  function rig(opts: { turnHeld?: boolean; activityState?: string; panel?: Record<string, unknown> } = {}) {
    const goal = makeGoal();
    const session = makeSession(goal);
    if (opts.panel) (session as any).actionPanel = opts.panel;
    const dispatched: string[] = [];
    const held: Array<[string, string]> = [];
    const controller = new GoalLoopController({
      registry: {
        getSessionByKey: () => session,
        // What the old gate read. The new gate does not — a stale value here proves nothing either way.
        getActivityStateByKey: () => opts.activityState ?? 'idle',
        saveSessions: () => {},
      } as any,
      requestCoordinator: { isRequestActive: () => false },
      turnHeld: () => opts.turnHeld === true,
      holdForTurn: (key: string, cause: string) => held.push([key, cause]),
      dispatcher: async (args: { userPrompt: string }) => {
        dispatched.push(args.userPrompt);
        return JSON.stringify({ completed: false, reason: 'not yet', remaining: ['x'] });
      },
      injectContinuation: async () => undefined,
      postNotice: async () => undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fallbackModel: () => ({ model: 'claude-sonnet-4' }),
    } as any);
    return { controller, dispatched, held, goal };
  }

  it('A1: a run holds the slot before its controller exists (preparing) — no judge; the drive waits for that turn', async () => {
    const r = rig({ turnHeld: true });
    r.controller.onTurnSettled(SESSION_KEY, { cause: 'kick' });
    await r.controller.settled(SESSION_KEY);
    expect(r.dispatched).toHaveLength(0);
    expect(r.held).toEqual([[SESSION_KEY, 'kick']]);
  });

  it('a stale working (loaded from disk, no run, no report) does not hold the gate', async () => {
    const r = rig({ turnHeld: false, activityState: 'working' });
    r.controller.onTurnSettled(SESSION_KEY);
    await r.controller.settled(SESSION_KEY);
    expect(r.dispatched).toHaveLength(1);
    expect(r.held).toEqual([]);
  });

  it('an open owner question holds the gate whatever the display word says', async () => {
    const r = rig({ turnHeld: false, activityState: 'idle', panel: { waitingForChoice: true } });
    r.controller.onTurnSettled(SESSION_KEY);
    await r.controller.settled(SESSION_KEY);
    expect(r.dispatched).toHaveLength(0);
    expect(r.held).toEqual([]);
  });
});

/**
 * .prd/39 D2 · A4 (X4) — the gate passes only the phases the loop drives: running and retrying. A goal asking its
 * owner (the cap question) is not judged or announced again on a kick or a restart pass; a round whose DM never
 * landed sends that same round's DM again, nothing else. A goal whose opening has not reached the model waits for it.
 */
describe('GoalLoopController — the gate reads the goal phase (.prd/39 D2, A4)', () => {
  function rig(goalOver: Partial<SessionGoal>) {
    const goal = makeGoal({ continuationCount: 10, maxContinuations: 10, lastEvalReason: '배포 남음', ...goalOver });
    const session = makeSession(goal);
    const dispatched: number[] = [];
    const notices: string[] = [];
    const dms: Array<{ text: string; decisionId?: string }> = [];
    const controller = new GoalLoopController({
      registry: { getSessionByKey: () => session, saveSessions: () => {} },
      requestCoordinator: { isRequestActive: () => false },
      turnHeld: () => false,
      dispatcher: async () => {
        dispatched.push(1);
        return JSON.stringify({ completed: false, reason: 'not yet', remaining: ['x'] });
      },
      injectContinuation: async () => undefined,
      postNotice: async (_c, _t, text) => {
        notices.push(text);
        return undefined;
      },
      postOwnerDm: async (_user, text, blocks) => {
        const raw = JSON.stringify(blocks);
        dms.push({ text, decisionId: /"decisionId":"([^"]+)"/.exec(raw.replace(/\\"/g, '"'))?.[1] });
        return { channel: 'D1', ts: '9.9' };
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fallbackModel: () => ({ model: 'claude-sonnet-4' }),
    });
    return { controller, goal, dispatched, notices, dms };
  }

  it('A4: a kick on a goal asking the cap question, its DM delivered — no judge, no notice, nothing sent', async () => {
    const r = rig({ capDmPendingAt: 5, capDecisionId: 'round-1', capDmRef: { channel: 'D1', ts: '1.1' } });
    r.controller.onTurnSettled(SESSION_KEY, { cause: 'kick' });
    await r.controller.settled(SESSION_KEY);
    expect(r.dispatched).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.dms).toEqual([]);
    expect(r.goal.evalAttemptCount ?? 0).toBe(0);
  });

  it('A4: a kick on a cap round whose DM never landed sends that round’s DM again — no judge, no notice', async () => {
    const r = rig({ capDmPendingAt: 5, capDecisionId: 'round-1' });
    r.controller.onTurnSettled(SESSION_KEY, { cause: 'kick' });
    await r.controller.settled(SESSION_KEY);
    expect(r.dispatched).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.dms).toHaveLength(1);
    expect(r.goal.capDecisionId).toBe('round-1');
    expect(r.goal.capDmRef).toEqual({ channel: 'D1', ts: '9.9' });
  });

  it('a goal whose opening has not reached the model is not judged', async () => {
    const r = rig({ openingPending: true, continuationCount: 0 });
    r.controller.onTurnSettled(SESSION_KEY, { cause: 'kick' });
    await r.controller.settled(SESSION_KEY);
    expect(r.dispatched).toEqual([]);
  });
});

/**
 * .prd/39 A5 · D15 — a change committed while a judge is in flight (`goal max 20`): the commit moves the epoch and
 * enqueues one kick. The judge in flight sees the moved epoch and discards its verdict; the kick behind it judges
 * once more — exactly once. Nobody else re-judges on the discard (one owner).
 */
describe('GoalLoopController — a commit during a judge re-judges exactly once (A5)', () => {
  it('discards the verdict of the moved epoch and judges once more behind the kick', async () => {
    const goal = makeGoal({ continuationCount: 3, maxContinuations: 10 });
    const session = makeSession(goal);
    const releases: Array<() => void> = [];
    let dispatched = 0;
    const injected: unknown[] = [];
    const controller = new GoalLoopController({
      registry: { getSessionByKey: () => session, saveSessions: () => {} },
      requestCoordinator: { isRequestActive: () => false },
      turnHeld: () => false,
      dispatcher: () => {
        dispatched += 1;
        return new Promise<string>((resolve) =>
          releases.push(() => resolve(JSON.stringify({ completed: false, reason: 'not yet', remaining: ['x'] }))),
        );
      },
      injectContinuation: async (event) => {
        injected.push(event);
      },
      postNotice: async () => undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fallbackModel: () => ({ model: 'claude-sonnet-4' }),
    });

    controller.onTurnSettled(SESSION_KEY);
    await vi.waitFor(() => expect(dispatched).toBe(1));
    // `goal max 20` commits: the epoch moves, one kick is enqueued.
    goal.maxContinuations = 20;
    goal.epoch = (goal.epoch ?? 0) + 1;
    controller.onTurnSettled(SESSION_KEY, { cause: 'kick' });
    releases[0]();
    await vi.waitFor(() => expect(dispatched).toBe(2));
    releases[1]();
    await controller.settled(SESSION_KEY);

    expect(dispatched).toBe(2);
    expect(injected).toHaveLength(1);
  });
});
