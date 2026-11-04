import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession, SessionGoal } from '../../types';
import type { GoalEvalVerdict } from '../goal-completion-evaluator';
import { GoalLoopController } from '../goal-loop-controller';

/**
 * #917 — a goal session's follow-up question waits for the goal loop.
 *
 * While a goal is active the loop decides what happens after a turn: it continues the work (the agent acts), or it
 * asks (stall question, cap decision). Only when a run ended with neither — the goal completed, or the run had nothing
 * to do — may the host ask the follow-up question. The controller says so after every run: `onRunSettled(key,
 * { continued })`, `continued` true when that run injected a continuation.
 */

const KEY = 'C1:T1';

function harness(verdict: GoalEvalVerdict | undefined, goalOver: Partial<SessionGoal> = {}) {
  const goal: SessionGoal = {
    goalId: 'g1',
    objective: 'ship it',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 0,
    ...goalOver,
  } as SessionGoal;
  const session = {
    channelId: 'C1',
    threadTs: 'T1',
    model: 'm',
    goal,
    goalLastTurnText: 'did work',
  } as unknown as ConversationSession;
  const settled: Array<[string, { continued: boolean }]> = [];
  const controller = new GoalLoopController({
    registry: { getSessionByKey: () => session, getActivityStateByKey: () => 'idle', saveSessions: () => undefined },
    requestCoordinator: { isRequestActive: () => false },
    dispatcher: async () => JSON.stringify(verdict ?? { completed: false, reason: 'r', remaining: ['x'] }),
    injectContinuation: async () => undefined,
    postNotice: async () => undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: 'm',
    scheduleEvalRetry: () => undefined,
    onRunSettled: (key, info) => settled.push([key, info]),
  });
  return { controller, goal, settled };
}

describe('GoalLoopController.onRunSettled (#917)', () => {
  it('a run that continued the work says continued: true', async () => {
    const h = harness({ completed: false, reason: 'not yet', remaining: ['x'] });
    h.controller.onTurnSettled(KEY);
    await h.controller.settled(KEY);
    expect(h.settled).toEqual([[KEY, { continued: true }]]);
  });

  it('a run that completed the goal says continued: false — the host may ask the follow-up', async () => {
    const h = harness({ completed: true, reason: 'done', remaining: [] });
    h.controller.onTurnSettled(KEY);
    await h.controller.settled(KEY);
    expect(h.goal.status).toBe('complete');
    expect(h.settled).toEqual([[KEY, { continued: false }]]);
  });

  it('a run that had nothing to do (the loop did not run) says continued: false', async () => {
    const h = harness(undefined, { status: 'paused' as SessionGoal['status'] });
    h.controller.onTurnSettled(KEY);
    await h.controller.settled(KEY);
    expect(h.settled).toEqual([[KEY, { continued: false }]]);
  });
});
