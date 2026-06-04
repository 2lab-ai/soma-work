/**
 * Tests for goal continuation helpers (`src/slack/goal-continuation.ts`).
 *
 * The auto-continuation loop itself is driven from the post-turn eval
 * handler (`index.ts`) and exercised end-to-end there; this module now
 * only owns the shared text prefix and the user-message reset, which is
 * what these tests cover.
 */

import { describe, expect, it } from 'vitest';
import type { SessionGoal } from '../../types';
import { GOAL_CONTINUATION_TEXT_PREFIX, resetGoalContinuationOnUserMessage } from '../goal-continuation';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  const now = Date.now();
  return {
    objective: 'ship the feature',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: 10,
    consecutiveBlockedSignals: 0,
    evalAttemptCount: 0,
    ...overrides,
  };
}

describe('GOAL_CONTINUATION_TEXT_PREFIX', () => {
  it('is the stable log/classifier marker', () => {
    expect(GOAL_CONTINUATION_TEXT_PREFIX).toBe('[goal-continuation]');
  });
});

describe('resetGoalContinuationOnUserMessage', () => {
  it('zeroes the cap + blocked counters on a real user message', () => {
    const session = { goal: makeGoal({ continuationCount: 7, consecutiveBlockedSignals: 2 }) };
    resetGoalContinuationOnUserMessage(session);
    expect(session.goal.continuationCount).toBe(0);
    expect(session.goal.consecutiveBlockedSignals).toBe(0);
  });

  it('does NOT clear an in-flight pendingEval', () => {
    const pendingEval = { requestedAt: 123, turnId: 't' };
    const session = { goal: makeGoal({ continuationCount: 3, pendingEval }) };
    resetGoalContinuationOnUserMessage(session);
    expect(session.goal.continuationCount).toBe(0);
    expect(session.goal.pendingEval).toBe(pendingEval);
  });

  it('is a no-op when no goal is set', () => {
    const session: { goal?: SessionGoal } = {};
    expect(() => resetGoalContinuationOnUserMessage(session)).not.toThrow();
    expect(session.goal).toBeUndefined();
  });
});
