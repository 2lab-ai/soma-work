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

function makeHarness(
  goalOverrides: Partial<SessionGoal> = {},
  opts: { dmFails?: boolean; beforeDmResolves?: (goal: SessionGoal) => void } = {},
) {
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
  const broadcasts: Array<number | undefined> = [];

  const controller = new GoalLoopController({
    registry: {
      getSessionByKey: () => session,
      getActivityStateByKey: () => 'idle',
      saveSessions: vi.fn(),
      broadcastSessionUpdate: () => {
        broadcasts.push(goal.capDmPendingAt);
      },
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
      if (opts.dmFails) throw new Error('slack down');
      opts.beforeDmResolves?.(goal);
      return { channel: 'D-owner', ts: '1700000000.000100' };
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: 'claude-sonnet-4',
  } satisfies GoalLoopControllerDeps);

  return { controller, session, goal, dms, notices, broadcasts };
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

  it('does not re-DM when the round is already pending and its DM landed (dedup)', async () => {
    const h = makeHarness({
      capDmPendingAt: 12345,
      capDecisionId: 'round-1',
      capDmRef: { channel: 'D-owner', ts: '1.1' },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.dms).toHaveLength(0);
    // falls back to the in-thread pause notice
    expect(h.notices.some((n) => n.includes('paused'))).toBe(true);
  });

  it('the DM buttons carry the round id, and the DM location is kept so the dashboard can rewrite it (T1/T2)', async () => {
    const h = makeHarness();
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    const values = (h.dms[0].blocks as any[])
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements.map((e: any) => JSON.parse(e.value)));
    expect(h.goal.capDecisionId).toBeTruthy();
    for (const v of values) expect(v.decisionId).toBe(h.goal.capDecisionId);
    expect(h.goal.capDmRef).toEqual({ channel: 'D-owner', ts: '1700000000.000100' });
    // The dashboard card appears as soon as the decision opens.
    expect(h.broadcasts.some((at) => at !== undefined)).toBe(true);
    expect(h.notices.some((n) => n.includes('via DM and the dashboard'))).toBe(true);
  });

  it('a DM that cannot be sent still opens the decision — the dashboard card asks (T1)', async () => {
    const h = makeHarness({}, { dmFails: true });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.capDmPendingAt).toBeDefined();
    expect(h.goal.capDecisionId).toBeTruthy();
    expect(h.goal.capDmRef).toBeUndefined();
    expect(h.notices.some((n) => n.includes('on the dashboard'))).toBe(true);
  });

  it('a pending round whose DM never landed retries only the DM, in the same round', async () => {
    const h = makeHarness({ capDmPendingAt: 12345, capDecisionId: 'round-1' });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.dms).toHaveLength(1);
    expect(h.goal.capDecisionId).toBe('round-1');
    expect(h.goal.capDmPendingAt).toBe(12345);
    expect(h.goal.capDmRef).toEqual({ channel: 'D-owner', ts: '1700000000.000100' });
  });

  it("answered on the dashboard while the DM was in flight: the late DM is not kept as the round's DM", async () => {
    const h = makeHarness(
      {},
      {
        beforeDmResolves: (g) => {
          // The owner answered on the dashboard before chat.postMessage returned.
          g.capDmPendingAt = undefined;
          g.capDecisionId = undefined;
        },
      },
    );
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.capDmRef).toBeUndefined();
    expect(h.goal.capDmSync?.channel).toBe('D-owner');
  });
});
