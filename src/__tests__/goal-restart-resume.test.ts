/**
 * T1 — resume unfinished goals after a service restart.
 *
 * Verifies SlackHandler.resumeActiveGoals re-enters the goal loop for every
 * session that still has an active goal after reload, forces a stale
 * activityState to idle, and that notifyCrashRecovery does NOT also fire the
 * generic auto-resume for those sessions (no double resume).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(import('../env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DATA_DIR: '/tmp/soma-work-goal-restart-test' };
});

import { SlackHandler } from '../slack-handler';
import type { ConversationSession } from '../types';

function activeGoalSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    ownerId: 'U1',
    activityState: 'idle',
    goal: {
      goalId: 'g1',
      objective: 'finish the migration',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'U1',
      continuationCount: 0,
      maxContinuations: 10,
      lastAssistantTurnSummary: 'did some work',
    },
    ...overrides,
  } as unknown as ConversationSession;
}

function createHandler(sessions: Map<string, ConversationSession>) {
  const app = {
    client: { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.1' }) } },
    assistant: vi.fn(),
  } as any;
  const claudeHandler = {
    getAllSessions: vi.fn().mockReturnValue(sessions),
    getSessionByKey: vi.fn((k: string) => sessions.get(k)),
    getCrashRecoveredSessions: vi.fn().mockReturnValue([]),
    clearCrashRecoveredSessions: vi.fn(),
    saveSessions: vi.fn(),
  } as any;
  const handler = new SlackHandler(app, claudeHandler, {} as any);
  return { handler, claudeHandler };
}

describe('resumeActiveGoals (T1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('triggers the goal loop for each active-goal session', () => {
    const sessions = new Map<string, ConversationSession>([
      ['C1-T1', activeGoalSession()],
      ['C2-T2', activeGoalSession({ channelId: 'C2', threadTs: 'T2', goal: undefined })],
    ]);
    const { handler } = createHandler(sessions);
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);

    const resumed = handler.resumeActiveGoals();

    expect(resumed).toBe(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith('C1-T1');
  });

  it('forces a stale (working) activityState to idle so the idle-driver gate passes', () => {
    const stale = activeGoalSession({ activityState: 'working' });
    const sessions = new Map<string, ConversationSession>([['C1-T1', stale]]);
    const { handler } = createHandler(sessions);
    handler.setGoalTurnSettledHandler(vi.fn());

    handler.resumeActiveGoals();

    expect(stale.activityState).toBe('idle');
  });

  it('repairs a stranded queue (complete goal + non-empty queue) by promoting the next goal', () => {
    // Simulates the eval-complete crash window: disk persisted a completed goal
    // with the queued goal still pending. resumeActiveGoals must promote it.
    const completed = activeGoalSession();
    (completed.goal as any).status = 'complete';
    completed.goalQueue = [
      {
        goalId: 'g2',
        objective: 'next objective',
        status: 'queued',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'U1',
        continuationCount: 0,
        maxContinuations: 10,
      } as any,
    ];
    const sessions = new Map<string, ConversationSession>([['C1-T1', completed]]);
    const { handler } = createHandler(sessions);
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);

    const resumed = handler.resumeActiveGoals();

    // promoted to active + queue drained + loop re-triggered
    expect(completed.goal?.objective).toBe('next objective');
    expect(completed.goal?.status).toBe('active');
    expect(completed.goalQueue).toHaveLength(0);
    expect(completed.goalHistory?.[0].objective).toBe('finish the migration');
    expect(resumed).toBe(1);
    expect(settled).toHaveBeenCalledWith('C1-T1');
  });

  it('does nothing (no throw) when no goal loop is wired', () => {
    const sessions = new Map<string, ConversationSession>([['C1-T1', activeGoalSession()]]);
    const { handler } = createHandler(sessions);
    // no setGoalTurnSettledHandler
    expect(handler.resumeActiveGoals()).toBe(0);
  });

  it('notifyCrashRecovery skips generic auto-resume for active-goal sessions (no double resume)', async () => {
    const sessions = new Map<string, ConversationSession>([['C1-T1', activeGoalSession()]]);
    const { handler, claudeHandler } = createHandler(sessions);
    claudeHandler.getCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C1',
        threadTs: 'T1',
        ownerId: 'U1',
        activityState: 'working',
        shouldAutoResume: true,
        sessionKey: 'C1-T1',
      },
    ]);
    const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
    (handler as any).handleMessage = handleMessageSpy;

    await handler.notifyCrashRecovery();

    // generic auto-resume (handleMessage with the restart prompt) must NOT fire
    expect(handleMessageSpy).not.toHaveBeenCalled();
  });
});
