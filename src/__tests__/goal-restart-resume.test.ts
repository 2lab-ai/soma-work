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

  it('resumes a Slack-less task’s goal too (SSOT 2026-11-03): tasks run turns, the loop starts its next one', () => {
    const sessions = new Map<string, ConversationSession>([
      [
        'task:t1',
        activeGoalSession({ channelId: '', threadTs: undefined, slackless: true } as Partial<ConversationSession>),
      ],
    ]);
    const { handler } = createHandler(sessions);
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);
    expect(handler.resumeActiveGoals()).toBe(1);
    expect(settled).toHaveBeenCalledWith('task:t1', expect.anything());
  });

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
    expect(settled).toHaveBeenCalledWith('C1-T1', { cause: 'kick' });
  });

  it('forces a stale (working) activityState to idle so the idle-driver gate passes', () => {
    const stale = activeGoalSession({ activityState: 'working' });
    const sessions = new Map<string, ConversationSession>([['C1-T1', stale]]);
    const { handler } = createHandler(sessions);
    handler.setGoalTurnSettledHandler(vi.fn());

    handler.resumeActiveGoals();

    expect(stale.activityState).toBe('idle');
  });

  /**
   * SSOT 2026-11-02 (T3). A goal session waiting on its user's answer is not a
   * stale turn: no turn has to run for the question to stay open. Forcing it
   * idle let the loop run ten continuations over the unanswered question until
   * the cap decision asked "keep going?" next to it (fable-m5max dev,
   * 1792795612.514029: asked 02:32Z, restart 04:12Z, cap 04:32Z).
   */
  it('keeps a session waiting on its question waiting — the goal goes on once the user answers', () => {
    const asking = activeGoalSession({
      activityState: 'waiting',
      actionPanel: {
        waitingForChoice: true,
        pendingQuestion: {
          type: 'user_choice',
          question: 'PR #402 머지할까요?',
          choices: [{ id: 'go', label: '진행' }],
        },
      },
    } as Partial<ConversationSession>);
    const sessions = new Map<string, ConversationSession>([['C1-T1', asking]]);
    const { handler } = createHandler(sessions);
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);

    expect(handler.resumeActiveGoals()).toBe(0);

    expect(settled).not.toHaveBeenCalled();
    expect(asking.activityState).toBe('waiting');
  });

  it('still forces a waiting state with no question left to idle', () => {
    const stale = activeGoalSession({ activityState: 'waiting', actionPanel: { waitingForChoice: false } } as any);
    const sessions = new Map<string, ConversationSession>([['C1-T1', stale]]);
    const { handler } = createHandler(sessions);
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);

    expect(handler.resumeActiveGoals()).toBe(1);

    expect(stale.activityState).toBe('idle');
    expect(settled).toHaveBeenCalledWith('C1-T1', { cause: 'kick' });
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
    expect(settled).toHaveBeenCalledWith('C1-T1', { cause: 'kick' });
  });

  it('does NOT advance past a paused current goal that has a queue (paused + queue is valid)', () => {
    const paused = activeGoalSession();
    (paused.goal as any).status = 'paused';
    paused.goalQueue = [
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
    const sessions = new Map<string, ConversationSession>([['C1-T1', paused]]);
    const { handler } = createHandler(sessions);
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);

    const resumed = handler.resumeActiveGoals();

    // paused goal untouched, queue intact, nothing resumed
    expect(paused.goal?.status).toBe('paused');
    expect(paused.goal?.objective).toBe('finish the migration');
    expect(paused.goalQueue).toHaveLength(1);
    expect(paused.goalHistory ?? []).toHaveLength(0);
    expect(resumed).toBe(0);
    expect(settled).not.toHaveBeenCalled();
  });

  it('does nothing (no throw) when no goal loop is wired', () => {
    const sessions = new Map<string, ConversationSession>([['C1-T1', activeGoalSession()]]);
    const { handler } = createHandler(sessions);
    // no setGoalTurnSettledHandler
    expect(handler.resumeActiveGoals()).toBe(0);
  });

  /**
   * 2026-11-02 restart incident. Before the "no output is no evidence" rule a
   * restart-interrupted turn was judged "the same failure" and the goal
   * stopped on a stall question (fable-m5max dev: 1793150219.639969 stalled at
   * 05:08:54Z, then every later restart held it as "waiting on its question").
   * A stall opened on no turn text is not a real stall: the restart ends it,
   * withdraws its question, and resumes the goal.
   */
  it('ends a stall that was judged on no turn text, withdraws its question, and resumes the goal', () => {
    const stalled = activeGoalSession({
      activityState: 'waiting',
      actionPanel: {
        waitingForChoice: true,
        pendingQuestion: { type: 'user_choices', hostTurnId: 'host:1', questions: [] },
        pendingChoice: { turnId: 'host:1', formIds: [] },
      },
    } as unknown as Partial<ConversationSession>);
    const goal = stalled.goal as NonNullable<ConversationSession['goal']>;
    goal.lastAssistantTurnSummary = '';
    goal.lastEvalReason = 'This turn again produced no assistant text';
    goal.stall = {
      stallId: 's1',
      stalledAt: 1,
      reason: 'This turn again produced no assistant text',
      actions: ['a', 'b', 'c'],
      confidence: 0.97,
      questionTurnId: 'host:1',
    };
    const sessions = new Map<string, ConversationSession>([['C1-T1', stalled]]);
    const { handler, claudeHandler } = createHandler(sessions);
    claudeHandler.getSessionRegistry = vi.fn(() => ({ getAllSessions: () => sessions }));
    const retract = vi.fn((_key: string, _turnId: string) => {
      // The real retraction frees the session synchronously, before any Slack call.
      stalled.actionPanel = { waitingForChoice: false } as any;
      stalled.activityState = 'idle';
      return Promise.resolve();
    });
    (handler as any).streamExecutor = { retractHostQuestion: retract };
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);

    expect(handler.resumeActiveGoals()).toBe(1);

    expect(stalled.goal?.stall).toBeUndefined();
    expect(retract).toHaveBeenCalledWith('C1-T1', 'host:1');
    expect(settled).toHaveBeenCalledWith('C1-T1', { cause: 'kick' });
    expect(claudeHandler.saveSessions).toHaveBeenCalled();
  });

  /**
   * 2026-11-02: "서비스 재시작하면 자동으로 진행중이던 작업 재시작되도록해줘". A turn the
   * restart cut short never finished, so it does not spend the continuation
   * budget. Without the refund, every deploy costs each running goal one turn,
   * and a goal cut on its 10th continuation (1793150219.639969, 05:08Z) resumes
   * straight into the cap question. "Cut by the restart" is the shutdown's own
   * record (`wasWorkingAtShutdown` → `shouldAutoResume`), read by crash
   * recovery before it clears the marker — not "the summary is empty".
   */
  function recovered(sessionKey: string, working: boolean) {
    return {
      channelId: 'C1',
      threadTs: 'T1',
      ownerId: 'U1',
      activityState: working ? 'working' : 'idle',
      shouldAutoResume: working,
      sessionKey,
    };
  }

  async function bootWith(sessions: Map<string, ConversationSession>, cut: ReturnType<typeof recovered>[]) {
    const { handler, claudeHandler } = createHandler(sessions);
    claudeHandler.getCrashRecoveredSessions.mockReturnValue(cut);
    (handler as any).handleMessage = vi.fn().mockResolvedValue(undefined);
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);
    await handler.notifyCrashRecovery();
    const resumed = handler.resumeActiveGoals();
    return { handler, claudeHandler, settled, resumed };
  }

  it('gives back the continuation of a goal turn the restart cut short', async () => {
    const cut = activeGoalSession({ activityState: 'working' });
    const goal = cut.goal as NonNullable<ConversationSession['goal']>;
    goal.continuationCount = 10;
    const { settled, resumed, claudeHandler } = await bootWith(new Map([['C1-T1', cut]]), [recovered('C1-T1', true)]);

    expect(resumed).toBe(1);
    expect(goal.continuationCount).toBe(9);
    expect(settled).toHaveBeenCalledWith('C1-T1', { cause: 'kick' });
    expect(claudeHandler.saveSessions).toHaveBeenCalled();
  });

  it('keeps the budget of a goal that was idle at shutdown — even with an empty summary', async () => {
    const idle = activeGoalSession();
    const goal = idle.goal as NonNullable<ConversationSession['goal']>;
    goal.continuationCount = 4;
    goal.lastAssistantTurnSummary = '';
    await bootWith(new Map([['C1-T1', idle]]), [recovered('C1-T1', false)]);

    expect(goal.continuationCount).toBe(4);
  });

  it('keeps the budget of a goal whose cap decision is open — the owner decides, not the restart', async () => {
    const capped = activeGoalSession({ activityState: 'working' });
    const goal = capped.goal as NonNullable<ConversationSession['goal']>;
    goal.continuationCount = 10;
    goal.capDmPendingAt = 5;
    goal.capDecisionId = 'd1';
    await bootWith(new Map([['C1-T1', capped]]), [recovered('C1-T1', true)]);

    expect(goal.continuationCount).toBe(10);
  });

  it('never takes the budget below zero (a user turn was cut — it spent nothing)', async () => {
    const userTurn = activeGoalSession({ activityState: 'working' });
    await bootWith(new Map([['C1-T1', userTurn]]), [recovered('C1-T1', true)]);

    expect(userTurn.goal?.continuationCount).toBe(0);
  });

  it('gives back once per restart — a second resume pass refunds nothing', async () => {
    const cut = activeGoalSession({ activityState: 'working' });
    const goal = cut.goal as NonNullable<ConversationSession['goal']>;
    goal.continuationCount = 6;
    const { handler } = await bootWith(new Map([['C1-T1', cut]]), [recovered('C1-T1', true)]);
    handler.resumeActiveGoals();

    expect(goal.continuationCount).toBe(5);
  });

  // #788 round 2 (grok): a failed crash-recovery notice must still clear the
  // shutdown marker, or the next boot would read the session as cut again and
  // refund a second time.
  it('a failed restart notice still clears the marker — the next boot refunds nothing', async () => {
    const cut = activeGoalSession({ activityState: 'working' }) as ConversationSession & {
      shutdownNotificationSent?: boolean;
      wasWorkingAtShutdown?: boolean;
    };
    cut.shutdownNotificationSent = true;
    cut.wasWorkingAtShutdown = true;
    const goal = cut.goal as NonNullable<ConversationSession['goal']>;
    goal.continuationCount = 6;
    const sessions = new Map<string, ConversationSession>([['C1-T1', cut]]);
    const { handler, claudeHandler } = createHandler(sessions);
    claudeHandler.getCrashRecoveredSessions.mockReturnValue([recovered('C1-T1', true)]);
    (handler as any).app.client.chat.postMessage = vi.fn().mockRejectedValue(new Error('ratelimited'));
    handler.setGoalTurnSettledHandler(vi.fn());

    await handler.notifyCrashRecovery();
    handler.resumeActiveGoals();

    expect(goal.continuationCount).toBe(5);
    expect(cut.wasWorkingAtShutdown).toBe(false);
    expect(cut.shutdownNotificationSent).toBe(false);
  });

  it('a false stall at 10/10 cut by the restart resumes with its continuation given back', async () => {
    const stalled = activeGoalSession({
      activityState: 'waiting',
      actionPanel: {
        waitingForChoice: true,
        pendingQuestion: { type: 'user_choices', hostTurnId: 'host:1', questions: [] },
        pendingChoice: { turnId: 'host:1', formIds: [] },
      },
    } as unknown as Partial<ConversationSession>);
    const goal = stalled.goal as NonNullable<ConversationSession['goal']>;
    goal.continuationCount = 10;
    goal.lastAssistantTurnSummary = '';
    goal.lastEvalReason = 'This turn again produced no assistant text';
    goal.stall = {
      stallId: 's1',
      stalledAt: 1,
      reason: 'This turn again produced no assistant text',
      actions: ['a', 'b', 'c'],
      confidence: 0.97,
      questionTurnId: 'host:1',
    };
    const sessions = new Map<string, ConversationSession>([['C1-T1', stalled]]);
    const { handler, claudeHandler } = createHandler(sessions);
    claudeHandler.getSessionRegistry = vi.fn(() => ({ getAllSessions: () => sessions }));
    (handler as any).streamExecutor = {
      retractHostQuestion: vi.fn(() => {
        stalled.actionPanel = { waitingForChoice: false } as any;
        stalled.activityState = 'idle';
        return Promise.resolve();
      }),
    };
    // The 10th continuation was the turn the restart cut.
    (handler as any).restartCutSessionKeys = new Set(['C1-T1']);
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);

    expect(handler.resumeActiveGoals()).toBe(1);

    expect(goal.stall).toBeUndefined();
    expect(goal.continuationCount).toBe(9);
    expect(settled).toHaveBeenCalledWith('C1-T1', { cause: 'kick' });
  });

  // #788 round 2 (astra): a goal a PREVIOUS deploy falsely stalled at 10/10 is
  // waiting, not working, at this shutdown — it is not in the cut record. Its
  // stall was judged on the turn an earlier restart cut, so ending that stall
  // gives the continuation back too, or it resumes straight into the cap.
  it('a false stall left by an earlier deploy at 10/10 resumes at 9/10', () => {
    const stalled = activeGoalSession({
      activityState: 'waiting',
      actionPanel: {
        waitingForChoice: true,
        pendingQuestion: { type: 'user_choices', hostTurnId: 'host:1', questions: [] },
        pendingChoice: { turnId: 'host:1', formIds: [] },
      },
    } as unknown as Partial<ConversationSession>);
    const goal = stalled.goal as NonNullable<ConversationSession['goal']>;
    goal.continuationCount = 10;
    goal.lastAssistantTurnSummary = '';
    goal.lastEvalReason = 'This turn again produced no assistant text';
    goal.stall = {
      stallId: 's1',
      stalledAt: 1,
      reason: 'This turn again produced no assistant text',
      actions: ['a', 'b', 'c'],
      confidence: 0.97,
      questionTurnId: 'host:1',
    };
    const sessions = new Map<string, ConversationSession>([['C1-T1', stalled]]);
    const { handler, claudeHandler } = createHandler(sessions);
    claudeHandler.getSessionRegistry = vi.fn(() => ({ getAllSessions: () => sessions }));
    (handler as any).streamExecutor = {
      retractHostQuestion: vi.fn(() => {
        stalled.actionPanel = { waitingForChoice: false } as any;
        stalled.activityState = 'idle';
        return Promise.resolve();
      }),
    };
    handler.setGoalTurnSettledHandler(vi.fn());

    expect(handler.resumeActiveGoals()).toBe(1);

    expect(goal.stall).toBeUndefined();
    expect(goal.continuationCount).toBe(9);
  });

  it('a false stall that was also cut gives back one continuation, not two', () => {
    const stalled = activeGoalSession({ activityState: 'working' });
    const goal = stalled.goal as NonNullable<ConversationSession['goal']>;
    goal.continuationCount = 10;
    goal.lastAssistantTurnSummary = '';
    goal.lastEvalReason = 'no output';
    goal.stall = { stallId: 's1', stalledAt: 1, reason: 'no output', actions: ['a', 'b', 'c'], confidence: 0.97 };
    const { handler } = createHandler(new Map([['C1-T1', stalled]]));
    (handler as any).restartCutSessionKeys = new Set(['C1-T1']);
    handler.setGoalTurnSettledHandler(vi.fn());

    handler.resumeActiveGoals();

    expect(goal.continuationCount).toBe(9);
  });

  it('keeps a real stall (judged on turn text) stopped on its question', () => {
    const stalled = activeGoalSession({
      activityState: 'waiting',
      actionPanel: {
        waitingForChoice: true,
        pendingQuestion: { type: 'user_choices', hostTurnId: 'host:1', questions: [] },
      },
    } as Partial<ConversationSession>);
    const goal = stalled.goal as NonNullable<ConversationSession['goal']>;
    goal.lastAssistantTurnSummary = 'Still waiting on you: dev has 0 epics.';
    goal.stall = {
      stallId: 's1',
      stalledAt: 1,
      reason: 'dev has 0 epics',
      actions: ['a', 'b', 'c'],
      confidence: 0.98,
      questionTurnId: 'host:1',
    };
    const sessions = new Map<string, ConversationSession>([['C1-T1', stalled]]);
    const { handler } = createHandler(sessions);
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);

    expect(handler.resumeActiveGoals()).toBe(0);

    expect(stalled.goal?.stall?.stallId).toBe('s1');
    expect(settled).not.toHaveBeenCalled();
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
