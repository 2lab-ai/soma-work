/**
 * S3 — when the auto-continuation budget is exhausted, the loop must NOT
 * silently stop. It DMs the goal owner a "keep going?" decision with
 * Continue/Cancel buttons (exactly once per cap event), instead of only the
 * in-thread pause notice.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession, SessionGoal } from '../../types';
import { GoalLoopController, type GoalLoopControllerDeps } from '../goal-loop-controller';

const SESSION_KEY = 'C1:T1';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-cap',
    objective: 'ship the feature',
    status: 'active',
    createdAt: 100,
    updatedAt: 100,
    createdBy: 'U-owner',
    continuationCount: 10,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 0,
    ...overrides,
  };
}

function makeHarness(goalOverrides: Partial<SessionGoal> = {}) {
  const goal = makeGoal(goalOverrides);
  const session = {
    channelId: 'C1',
    threadTs: 'T1',
    model: 'claude-opus-4',
    goal,
    goalLastTurnText: 'did some work',
  } as unknown as ConversationSession;

  const dms: Array<{ userId: string; text: string; blocks: unknown[] }> = [];
  const notices: string[] = [];

  const controller = new GoalLoopController({
    registry: {
      getSessionByKey: () => session,
      getActivityStateByKey: () => 'idle',
      saveSessions: vi.fn(),
    },
    requestCoordinator: { isRequestActive: () => false },
    dispatcher: async () => JSON.stringify({ completed: false, reason: 'still going', remaining: ['do X'] }),
    injectContinuation: async () => undefined,
    postNotice: async (_c, _t, text) => {
      notices.push(text);
      return undefined;
    },
    postOwnerDm: async (userId, text, blocks) => {
      dms.push({ userId, text, blocks });
      return undefined;
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: 'claude-sonnet-4',
  } satisfies GoalLoopControllerDeps);

  return { controller, session, goal, dms, notices };
}

describe('GoalLoopController — cap-reached owner DM (S3)', () => {
  it('DMs the goal owner Continue/Cancel buttons instead of silently pausing', async () => {
    const h = makeHarness();
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.dms).toHaveLength(1);
    expect(h.dms[0].userId).toBe('U-owner');
    const ids = (h.dms[0].blocks as any[])
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements.map((e: any) => e.action_id));
    expect(ids).toContain('goal_continue_dm');
    expect(ids).toContain('goal_cancel_dm');
    // dedup guard stamped
    expect(h.goal.capDmPendingAt).toBeDefined();
  });

  it('does not re-DM when a cap decision is already pending (dedup)', async () => {
    const h = makeHarness({ capDmPendingAt: 12345 });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.dms).toHaveLength(0);
    // falls back to the in-thread pause notice
    expect(h.notices.some((n) => n.includes('paused'))).toBe(true);
  });
});
