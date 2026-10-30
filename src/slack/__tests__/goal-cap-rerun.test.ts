/**
 * A goal at its auto-continuation budget (10/10) that is not complete must run
 * again when the user gives new input — it must not stay stuck behind a newly
 * added goal (SSOT 2026-10-30:
 *   1. "10/10 일때 유저가 새로 채팅으로 지시하면 신규 goal이 추가되는데 기존 골이 10/10으로 스턱됨 이거 픽스해줘"
 *   2. "정상적인 경우라면 goal이 10/10 되고 goal이 완료 안됐으면 마지막 골을 다시 실행해야하는거야").
 *
 * A plain chat message already resets the counter (`resetGoalContinuationOnUserMessage`)
 * and its turn end re-drives the loop. Adding a goal (`goal <text>`, dashboard
 * add) is consumed as a command — no turn, no reset — so the 10/10 goal stayed
 * stuck and the new goal waited behind it forever. Adding a goal is user input
 * too: the 10/10 goal gets its budget back and runs again; the new goal waits
 * in the queue and starts when the current goal completes.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SyntheticMessageEvent } from '../../cron-scheduler';
import type { ConversationSession, SessionGoal } from '../../types';
import { GoalHandler } from '../commands/goal-handler';
import type { CommandContext, CommandDependencies } from '../commands/types';
import { resetGoalContinuationOnUserMessage } from '../goal-continuation';
import { GoalLoopController, type GoalLoopControllerDeps } from '../goal-loop-controller';
import { enqueueOrActivateGoal } from '../session-goal';

const resumeGoalLoopMock = vi.hoisted(() => vi.fn());
vi.mock('../goal-loop-resume', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../goal-loop-resume')>()),
  resumeGoalLoop: resumeGoalLoopMock,
}));

const SESSION_KEY = 'C1:T1';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-a',
    objective: 'ship feature A',
    status: 'active',
    createdAt: 100,
    updatedAt: 100,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 3,
    ...overrides,
  };
}

/** The goal as the loop leaves it at its budget: active, 10/10, owner asked. */
function cappedGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return makeGoal({ continuationCount: 10, capDmPendingAt: 5_000, lastEvalReason: 'tests still red', ...overrides });
}

function makeSession(goal: SessionGoal | undefined, extra: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 'T1',
    model: 'claude-opus-4',
    systemPrompt: 'cached',
    goal,
    goalLastTurnText: 'did some work',
    ...extra,
  } as unknown as ConversationSession;
}

describe('SSOT 2026-10-30 — adding a goal while the current goal is at 10/10', () => {
  it('queues the new goal and gives the 10/10 goal its budget back (it runs again)', () => {
    const a = cappedGoal();
    const session = makeSession(a);

    const result = enqueueOrActivateGoal(session, 'ship feature B', 'U1');

    expect(result.activated).toBe(false);
    expect(session.goal).toBe(a);
    expect(a.status).toBe('active');
    expect(a.continuationCount).toBe(0);
    // The add answered the pending "keep going?" question.
    expect(a.capDmPendingAt).toBeUndefined();
    expect(result.resumedCurrent).toBe(a);
    expect(session.goalQueue?.map((g) => g.objective)).toEqual(['ship feature B']);
  });

  it('leaves a running goal under its budget untouched', () => {
    const a = makeGoal({ continuationCount: 3 });
    const session = makeSession(a);

    const result = enqueueOrActivateGoal(session, 'ship feature B', 'U1');

    expect(result.activated).toBe(false);
    expect(a.continuationCount).toBe(3);
    expect(result.resumedCurrent).toBeUndefined();
  });

  it("leaves a paused goal paused — pausing was the owner's explicit choice", () => {
    const a = cappedGoal({ status: 'paused' });
    const session = makeSession(a);

    const result = enqueueOrActivateGoal(session, 'ship feature B', 'U1');

    expect(result.activated).toBe(false);
    expect(a.status).toBe('paused');
    expect(a.continuationCount).toBe(10);
    expect(result.resumedCurrent).toBeUndefined();
  });

  it('`goal <text>`: the new goal is queued, the 10/10 goal is driven again, and the thread is told', async () => {
    resumeGoalLoopMock.mockClear();
    const a = cappedGoal();
    const session = makeSession(a);
    const postSystemMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    const deps = {
      claudeHandler: {
        getSession: vi.fn().mockReturnValue(session),
        getSessionKey: vi.fn().mockReturnValue(SESSION_KEY),
        saveSessions: vi.fn(),
      },
      slackApi: { postSystemMessage },
      userSettingsStore: { getUserGoalMaxContinuations: vi.fn().mockReturnValue(undefined) },
    } as unknown as CommandDependencies;
    const ctx = {
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      text: 'goal ship feature B',
      say: vi.fn(),
    } as unknown as CommandContext;

    const result = await new GoalHandler(deps).execute(ctx);

    expect(result.goalQueued).toBe(true);
    expect(session.goal).toBe(a);
    expect(a.continuationCount).toBe(0);
    expect(deps.claudeHandler.saveSessions).toHaveBeenCalled();
    expect(resumeGoalLoopMock).toHaveBeenCalledWith(SESSION_KEY);
    const notice = postSystemMessage.mock.calls.map((c) => String(c[1])).join('\n');
    expect(notice).toContain('Goal queued');
    expect(notice).toContain('ship feature A');
  });
});

describe('SSOT 2026-10-30 — the 10/10 goal runs again after user input', () => {
  function makeController(session: ConversationSession) {
    const injected: SyntheticMessageEvent[] = [];
    const controller = new GoalLoopController({
      registry: {
        getSessionByKey: () => session,
        getActivityStateByKey: () => 'idle',
        saveSessions: vi.fn(),
      },
      requestCoordinator: { isRequestActive: () => false },
      dispatcher: async () => JSON.stringify({ completed: false, reason: 'still going', remaining: ['do X'] }),
      injectContinuation: async (event) => {
        injected.push(event);
      },
      postNotice: async () => undefined,
      postOwnerDm: async () => undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fallbackModel: 'claude-sonnet-4',
    } satisfies GoalLoopControllerDeps);
    return { controller, injected };
  }

  it('after a goal is added at 10/10, the next loop run continues the 10/10 goal — not the new one', async () => {
    const a = cappedGoal();
    const session = makeSession(a);
    enqueueOrActivateGoal(session, 'ship feature B', 'U1');
    const { controller, injected } = makeController(session);

    controller.onTurnSettled(SESSION_KEY);
    await controller.settled(SESSION_KEY);

    expect(session.goal?.goalId).toBe('goal-a');
    expect(a.continuationCount).toBe(1);
    expect(injected).toHaveLength(1);
    expect(session.goalQueue?.map((g) => g.objective)).toEqual(['ship feature B']);
  });

  it('a plain chat message at 10/10 resets the budget, and its turn end continues the same goal', async () => {
    const a = cappedGoal();
    const session = makeSession(a);
    resetGoalContinuationOnUserMessage(session);
    const { controller, injected } = makeController(session);

    controller.onTurnSettled(SESSION_KEY);
    await controller.settled(SESSION_KEY);

    expect(session.goal?.goalId).toBe('goal-a');
    expect(a.continuationCount).toBe(1);
    expect(injected).toHaveLength(1);
  });
});
