/**
 * GoalActionHandler — interactive goal buttons (S1) + cap-decision DM (S3).
 *
 * Locks the codex-review guards:
 *   - Delete of the active goal auto-advances + kicks the loop (resumeGoalLoop).
 *   - Continue/Cancel DM bind to the ACTIVE goal with a PENDING decision only;
 *     a stale click (no capDmPendingAt, or a different/queued goal) is rejected
 *     without mutating state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession, SessionGoal } from '../../../types';
import { encodeGoalActionValue } from '../../goal-blocks';
import { GoalActionHandler } from '../goal-action-handler';

vi.mock('../../goal-loop-resume', () => ({
  resumeGoalLoop: vi.fn(),
  setGoalLoopResumeHandler: vi.fn(),
}));

import { resumeGoalLoop } from '../../goal-loop-resume';

const resumeGoalLoopMock = vi.mocked(resumeGoalLoop);

beforeEach(() => {
  resumeGoalLoopMock.mockClear();
});

const SESSION_KEY = 'C1:T1';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-1',
    objective: 'ship it',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U-owner',
    continuationCount: 10,
    maxContinuations: 10,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U-owner',
    channelId: 'C1',
    threadTs: 'T1',
    goal: makeGoal(),
    ...overrides,
  } as ConversationSession;
}

function makeHandler(session?: ConversationSession) {
  const saveSessions = vi.fn();
  const handler = new GoalActionHandler({
    slackApi: { postSystemMessage: vi.fn().mockResolvedValue({}) } as any,
    claudeHandler: {
      getSessionByKey: vi.fn().mockReturnValue(session),
      saveSessions,
    } as any,
  });
  return { handler, saveSessions };
}

function body(goalId: string, userId = 'U-owner') {
  return {
    user: { id: userId },
    actions: [{ value: encodeGoalActionValue({ sessionKey: SESSION_KEY, goalId, channel: 'C1', threadTs: 'T1' }) }],
  };
}

describe('GoalActionHandler — delete (S1)', () => {
  it('deleting the active goal with a queued goal auto-advances and kicks the loop', async () => {
    const session = makeSession({
      goal: makeGoal({ goalId: 'g-active' }),
      goalQueue: [makeGoal({ goalId: 'g-next', objective: 'next', status: 'queued' })],
    });
    const { handler } = makeHandler(session);
    const respond = vi.fn().mockResolvedValue(undefined);

    await handler.handleDelete(body('g-active'), respond);

    expect(session.goal?.objective).toBe('next');
    expect(resumeGoalLoopMock).toHaveBeenCalledWith(SESSION_KEY);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ replace_original: true }));
  });

  it('rejects a non-owner delete', async () => {
    const session = makeSession();
    const { handler, saveSessions } = makeHandler(session);
    const respond = vi.fn().mockResolvedValue(undefined);

    await handler.handleDelete(body('goal-1', 'U-other'), respond);

    expect(saveSessions).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('소유자') }));
  });
});

describe('GoalActionHandler — cap-decision DM guards (S3, codex #2)', () => {
  it('Continue resets the counter + resumes ONLY when a decision is pending', async () => {
    const session = makeSession({ goal: makeGoal({ capDmPendingAt: 123, continuationCount: 10 }) });
    const { handler } = makeHandler(session);
    const respond = vi.fn().mockResolvedValue(undefined);

    await handler.handleContinueDm(body('goal-1'), respond);

    expect(session.goal?.continuationCount).toBe(0);
    expect(session.goal?.capDmPendingAt).toBeUndefined();
    expect(resumeGoalLoopMock).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('Continue is a no-op stale click when capDmPendingAt is NOT set', async () => {
    const session = makeSession({ goal: makeGoal({ capDmPendingAt: undefined, continuationCount: 7 }) });
    const { handler, saveSessions } = makeHandler(session);
    const respond = vi.fn().mockResolvedValue(undefined);

    await handler.handleContinueDm(body('goal-1'), respond);

    expect(session.goal?.continuationCount).toBe(7); // untouched
    expect(resumeGoalLoopMock).not.toHaveBeenCalled();
    expect(saveSessions).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('유효하지 않은') }));
  });

  it('Cancel on a goalId that is no longer the active goal is a stale no-op', async () => {
    const session = makeSession({ goal: makeGoal({ goalId: 'g-current', capDmPendingAt: 123 }) });
    const { handler, saveSessions } = makeHandler(session);
    const respond = vi.fn().mockResolvedValue(undefined);

    await handler.handleCancelDm(body('g-OLD'), respond);

    expect(session.goal?.status).toBe('active'); // not paused
    expect(saveSessions).not.toHaveBeenCalled();
  });

  it('Cancel pauses the active goal when a decision is pending', async () => {
    const session = makeSession({ goal: makeGoal({ capDmPendingAt: 123 }) });
    const { handler } = makeHandler(session);
    const respond = vi.fn().mockResolvedValue(undefined);

    await handler.handleCancelDm(body('goal-1'), respond);

    expect(session.goal?.status).toBe('paused');
    expect(session.goal?.capDmPendingAt).toBeUndefined();
  });

  it('Continue does NOT resurrect a goal that has since completed (round-2 #1)', async () => {
    // `goal done` with no queue keeps a status=complete goal in session.goal,
    // and capDmPendingAt may still be set if it was never cleared — a stale
    // Continue click must NOT flip it back to active.
    const session = makeSession({ goal: makeGoal({ status: 'complete', capDmPendingAt: 123 }) });
    const { handler, saveSessions } = makeHandler(session);
    const respond = vi.fn().mockResolvedValue(undefined);

    await handler.handleContinueDm(body('goal-1'), respond);

    expect(session.goal?.status).toBe('complete'); // not resurrected
    expect(resumeGoalLoopMock).not.toHaveBeenCalled();
    expect(saveSessions).not.toHaveBeenCalled();
  });
});
