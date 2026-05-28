/**
 * Tests for the goal ralph-loop driver (`maybeScheduleGoalContinuation`).
 *
 * Maps to the Test Matrix scenarios in `goal-redo-prompt.md`:
 *   - #1  active + idle → continuation fires
 *   - #2  paused + idle → no fire
 *   - #3  complete + idle → no fire
 *   - #4  blocked + idle → no fire
 *   - #5  active turn already in flight → no fire
 *   - #6  cap reached → no fire + host notice
 *   - #7  chaining: after each turn ends idle, the next continuation fires
 *   - #8  user message arrives mid-continuation → counter reset
 *   - #15 `goal set` resets continuationCount / pendingEval / lastEvalReason
 *   - #17 two concurrent idle callbacks → exactly one injection (lock)
 *   - #18 eval in flight → no fire
 *
 * The driver is fully dependency-injected, so all scenarios run
 * synchronously without the Claude SDK or Slack bolt.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession, SessionGoal } from '../../types';
import {
  __resetGoalContinuationLockForTests,
  GOAL_CONTINUATION_TEXT_PREFIX,
  type GoalContinuationDeps,
  maybeScheduleGoalContinuation,
  resetGoalContinuationOnUserMessage,
} from '../goal-continuation';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    objective: 'finish migration',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U_OWNER',
    continuationCount: 0,
    maxContinuations: 10,
    consecutiveBlockedSignals: 0,
    evalAttemptCount: 0,
    ...overrides,
  };
}

function makeSession(goal: SessionGoal, channelId = 'C1', threadTs: string | undefined = 'T1'): ConversationSession {
  return {
    ownerId: 'U_OWNER',
    userId: 'U_OWNER',
    channelId,
    threadTs,
    isActive: true,
    lastActivity: new Date(),
    goal,
  } as ConversationSession;
}

function makeDeps(opts: {
  session?: ConversationSession;
  activityState?: string;
  injector?: ReturnType<typeof vi.fn>;
  postSystemMessage?: ReturnType<typeof vi.fn>;
}): {
  injector: ReturnType<typeof vi.fn>;
  postSystemMessage: ReturnType<typeof vi.fn>;
  deps: GoalContinuationDeps;
} {
  const injector = opts.injector ?? vi.fn(async () => {});
  const postSystemMessage = opts.postSystemMessage ?? vi.fn(async () => {});
  const deps: GoalContinuationDeps = {
    getSession: () => opts.session,
    getActivityState: () => opts.activityState ?? 'idle',
    saveSessions: vi.fn(),
    messageInjector: injector as unknown as GoalContinuationDeps['messageInjector'],
    postSystemMessage: postSystemMessage as unknown as GoalContinuationDeps['postSystemMessage'],
    now: () => 1_700_000_000_000,
  };
  return { injector, postSystemMessage, deps };
}

beforeEach(() => {
  __resetGoalContinuationLockForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybeScheduleGoalContinuation — six-guard fan-out', () => {
  it('1. active goal + idle session → continuation fires (counter increments, injector called once)', async () => {
    const goal = makeGoal();
    const session = makeSession(goal);
    const { injector, deps } = makeDeps({ session, activityState: 'idle' });

    const out = await maybeScheduleGoalContinuation('C1-T1', deps);

    expect(out).toEqual({ fired: true, reason: 'injected', continuationCount: 1 });
    expect(injector).toHaveBeenCalledTimes(1);
    const event = injector.mock.calls[0]?.[0] as {
      synthetic?: boolean;
      skipDispatch?: boolean;
      text: string;
    };
    expect(event.synthetic).toBe(true);
    expect(event.skipDispatch).toBe(true);
    expect(event.text.startsWith(GOAL_CONTINUATION_TEXT_PREFIX)).toBe(true);
    expect(event.text).toContain('finish migration');
    expect(goal.continuationCount).toBe(1);
    expect(goal.lastContinuationAt).toBe(1_700_000_000_000);
  });

  it('2. paused goal → no fire', async () => {
    const goal = makeGoal({ status: 'paused' });
    const { injector, deps } = makeDeps({ session: makeSession(goal) });
    const out = await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(out).toEqual({ fired: false, reason: 'goal-not-active' });
    expect(injector).not.toHaveBeenCalled();
  });

  it('3. complete goal → no fire', async () => {
    const goal = makeGoal({ status: 'complete' });
    const { injector, deps } = makeDeps({ session: makeSession(goal) });
    const out = await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(out).toEqual({ fired: false, reason: 'goal-not-active' });
    expect(injector).not.toHaveBeenCalled();
  });

  it('4. blocked goal → no fire (distinct reason from paused/complete)', async () => {
    const goal = makeGoal({ status: 'blocked' });
    const { injector, deps } = makeDeps({ session: makeSession(goal) });
    const out = await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(out).toEqual({ fired: false, reason: 'blocked' });
    expect(injector).not.toHaveBeenCalled();
  });

  it('5. session not idle (working/waiting) → no fire', async () => {
    const goal = makeGoal();
    const { injector, deps } = makeDeps({ session: makeSession(goal), activityState: 'working' });
    const out = await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(out).toEqual({ fired: false, reason: 'not-idle' });
    expect(injector).not.toHaveBeenCalled();
  });

  it('6. continuationCount reached cap → no fire + host notice posted', async () => {
    const goal = makeGoal({ continuationCount: 10, maxContinuations: 10 });
    const post = vi.fn(async () => {});
    const { injector, deps } = makeDeps({ session: makeSession(goal), postSystemMessage: post });
    const out = await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(out).toEqual({ fired: false, reason: 'cap-reached' });
    expect(injector).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const postCall = post.mock.calls[0] as unknown as [string, string | undefined, string];
    expect(postCall[2]).toMatch(/auto-continuation paused after 10/);
  });

  it('no session resolved → no fire', async () => {
    const { injector, deps } = makeDeps({ session: undefined });
    const out = await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(out).toEqual({ fired: false, reason: 'no-session' });
    expect(injector).not.toHaveBeenCalled();
  });

  it('no goal on session → no fire', async () => {
    const session = makeSession(makeGoal());
    session.goal = undefined;
    const { injector, deps } = makeDeps({ session });
    const out = await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(out).toEqual({ fired: false, reason: 'no-goal' });
    expect(injector).not.toHaveBeenCalled();
  });

  it('18. pendingEval set → no fire (eval cycle owns transitions)', async () => {
    const goal = makeGoal({ pendingEval: { requestedAt: 1, turnId: 'T1' } });
    const { injector, deps } = makeDeps({ session: makeSession(goal) });
    const out = await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(out).toEqual({ fired: false, reason: 'pending-eval' });
    expect(injector).not.toHaveBeenCalled();
  });
});

describe('maybeScheduleGoalContinuation — chaining + concurrency', () => {
  it('7. successive idle calls drive continuationCount up by 1 each time', async () => {
    const goal = makeGoal();
    const session = makeSession(goal);
    const { injector, deps } = makeDeps({ session });

    await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(goal.continuationCount).toBe(1);
    await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(goal.continuationCount).toBe(2);
    await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(goal.continuationCount).toBe(3);
    expect(injector).toHaveBeenCalledTimes(3);
  });

  it('17. two concurrent idle callbacks → exactly one injection (semaphore=1)', async () => {
    const goal = makeGoal();
    const session = makeSession(goal);
    // Stash each Promise's resolver so we can release them in
    // order without leaking timeouts. vi.fn re-runs the executor
    // per call, so each invocation gets its own resolver.
    const resolvers: Array<() => void> = [];
    const injector = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { deps } = makeDeps({ session, injector });

    const first = maybeScheduleGoalContinuation('C1-T1', deps);
    const second = maybeScheduleGoalContinuation('C1-T1', deps);

    // Second call hits the lock and returns synchronously.
    const secondResult = await second;
    expect(secondResult).toEqual({ fired: false, reason: 'lock-held' });
    expect(injector).toHaveBeenCalledTimes(1);

    // Release the first injection so the lock clears.
    resolvers[0]?.();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ fired: true });

    // After the in-flight injection resolves, the lock releases and
    // the next call can fire. We kick off the third call and resolve
    // its injector immediately to keep the test bounded.
    const thirdPromise = maybeScheduleGoalContinuation('C1-T1', deps);
    // Microtask flush so vi.fn runs the executor for the 3rd call.
    await Promise.resolve();
    resolvers[1]?.();
    const third = await thirdPromise;
    expect(third).toMatchObject({ fired: true });
    expect(injector).toHaveBeenCalledTimes(2);
  });

  it('injector failure releases the lock so subsequent idles can recover', async () => {
    const goal = makeGoal();
    const session = makeSession(goal);
    const injector = vi.fn().mockRejectedValueOnce(new Error('slack 503')).mockResolvedValueOnce(undefined);
    const { deps } = makeDeps({ session, injector });

    await expect(maybeScheduleGoalContinuation('C1-T1', deps)).rejects.toThrow('slack 503');
    // Lock must be released after the failed injection.
    const second = await maybeScheduleGoalContinuation('C1-T1', deps);
    expect(second).toMatchObject({ fired: true });
  });

  it('continuation prompt embeds lastEvalReason when present', async () => {
    const goal = makeGoal({ lastEvalReason: 'PR not merged; CI red.' });
    const session = makeSession(goal);
    const { injector, deps } = makeDeps({ session });
    await maybeScheduleGoalContinuation('C1-T1', deps);
    const event = injector.mock.calls[0]?.[0] as { text: string };
    expect(event.text).toContain('Previous evaluation gap');
    expect(event.text).toContain('PR not merged; CI red.');
  });
});

describe('resetGoalContinuationOnUserMessage', () => {
  it('8. zeros continuationCount + consecutiveBlockedSignals', () => {
    const goal = makeGoal({ continuationCount: 7, consecutiveBlockedSignals: 2 });
    const session = makeSession(goal);
    resetGoalContinuationOnUserMessage(session);
    expect(goal.continuationCount).toBe(0);
    expect(goal.consecutiveBlockedSignals).toBe(0);
  });

  it('does NOT clear pendingEval — that belongs to the eval cycle', () => {
    const goal = makeGoal({ pendingEval: { requestedAt: 1, turnId: 'T1' } });
    const session = makeSession(goal);
    resetGoalContinuationOnUserMessage(session);
    expect(goal.pendingEval).toEqual({ requestedAt: 1, turnId: 'T1' });
  });

  it('is a no-op when there is no goal', () => {
    const session = makeSession(makeGoal());
    session.goal = undefined;
    expect(() => resetGoalContinuationOnUserMessage(session)).not.toThrow();
  });
});
