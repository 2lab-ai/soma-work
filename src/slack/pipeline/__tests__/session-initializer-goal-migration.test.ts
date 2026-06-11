/**
 * Issue #1082 T1 — bot-thread migration must carry the session goal.
 *
 * `createBotInitiatedThread` copies a curated set of fields from the original
 * (channel-mention) session onto the freshly created bot-thread session. The
 * `goal` field was missing from that list, so a goal set before migration
 * silently vanished. The copy must be a CLONE (the original session is
 * terminated and could be mutated/GC'd independently), and the runtime-only
 * stash `goalLastTurnText` must NOT travel — it refers to a turn of the dead
 * thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn().mockReturnValue({
      userId: 'U123',
      accepted: true,
      defaultDirectory: '',
      bypassPermission: false,
      persona: 'default',
      defaultModel: 'claude-opus-4-7',
      lastUpdated: new Date().toISOString(),
    }),
    createPendingUser: vi.fn(),
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.7'),
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
  DEFAULT_MODEL: 'claude-opus-4-8[1m]',
}));

vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn().mockReturnValue(false),
  getAdminUsers: vi.fn().mockReturnValue(new Set(['U_ADMIN1'])),
}));

vi.mock('../../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv-123'),
  getConversationUrl: vi.fn().mockReturnValue('http://localhost:3000/conversations/conv-123'),
}));

vi.mock('../../../channel-registry', () => ({
  checkRepoChannelMatch: vi.fn().mockReturnValue({ correct: true, suggestedChannels: [], reason: 'matched' }),
  getChannel: vi.fn().mockReturnValue(null),
  getAllChannels: vi.fn().mockReturnValue([]),
  registerChannel: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../dispatch-service', () => ({
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({ workflow: 'default', title: 'Session' }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

import type { SessionGoal } from '../../../types';
import { SessionInitializer } from '../session-initializer';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    objective: 'finish the migration epic',
    status: 'active',
    createdAt: 1000,
    updatedAt: 2000,
    createdBy: 'U123',
    continuationCount: 3,
    maxContinuations: 10,
    epoch: 5,
    pendingEval: { requestedAt: 1500, turnId: 'turn-orig-1' },
    ...overrides,
  } as SessionGoal;
}

describe('SessionInitializer — bot-thread migration copies goal (#1082)', () => {
  let sessionInitializer: SessionInitializer;
  let mockClaudeHandler: any;
  let mockSlackApi: any;
  let botSession: any;

  beforeEach(() => {
    vi.clearAllMocks();
    botSession = undefined;

    mockClaudeHandler = {
      getSessionKey: vi.fn().mockImplementation((c: string, t: string) => `${c}:${t}`),
      getSession: vi.fn().mockReturnValue(null),
      createSession: vi.fn().mockImplementation((user: string, userName: string, channel: string, threadTs: string) => {
        botSession = {
          ownerId: user,
          ownerName: userName,
          userId: user,
          channelId: channel,
          threadTs,
          isActive: true,
          lastActivity: new Date(),
          activityState: 'idle',
        };
        return botSession;
      }),
      transitionToMain: vi.fn(),
      terminateSession: vi.fn(),
      saveSessions: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(false),
      updateInitiator: vi.fn(),
      isSleeping: vi.fn().mockReturnValue(false),
      wakeFromSleep: vi.fn(),
      needsDispatch: vi.fn().mockReturnValue(false),
      setSessionLinks: vi.fn(),
    };

    mockSlackApi = {
      getUserName: vi.fn().mockResolvedValue('Test User'),
      postMessage: vi.fn().mockResolvedValue({ ts: 'bot-root-ts' }),
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p1'),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph123' }),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockReturnValue({}),
    };

    sessionInitializer = new SessionInitializer({
      claudeHandler: mockClaudeHandler,
      slackApi: mockSlackApi,
      messageValidator: { validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true }) } as any,
      workingDirManager: { createSessionBaseDir: vi.fn().mockReturnValue(undefined) } as any,
      reactionManager: {
        setOriginalMessage: vi.fn(),
        clearSessionLifecycleEmojis: vi.fn().mockResolvedValue(undefined),
        getCurrentReaction: vi.fn().mockReturnValue(null),
        cleanup: vi.fn(),
      } as any,
      contextWindowManager: { setOriginalMessage: vi.fn().mockResolvedValue(undefined) } as any,
      requestCoordinator: {
        isRequestActive: vi.fn().mockReturnValue(false),
        setController: vi.fn(),
        abortSession: vi.fn(),
        getLastActivityAt: vi.fn().mockReturnValue(undefined),
        touchSession: vi.fn(),
      } as any,
      assistantStatusManager: {
        setStatus: vi.fn().mockResolvedValue(undefined),
        clearStatus: vi.fn().mockResolvedValue(undefined),
        bumpEpoch: vi.fn().mockReturnValue(1),
        isEnabled: vi.fn().mockReturnValue(true),
      } as any,
    });
  });

  function makeOriginalSession(overrides: Record<string, unknown> = {}): any {
    return {
      ownerId: 'U123',
      ownerName: 'Test User',
      userId: 'U123',
      channelId: 'C123',
      threadTs: 'orig-ts',
      isActive: true,
      lastActivity: new Date(),
      state: 'MAIN',
      workflow: 'default',
      title: 'Session',
      activityState: 'idle',
      ...overrides,
    };
  }

  async function migrate(originalSession: any): Promise<any> {
    return (sessionInitializer as any).createBotInitiatedThread(
      originalSession,
      'C123',
      'orig-ts',
      'U123',
      'Test User',
      '/test/dir',
      false,
    );
  }

  it('clones the goal onto the bot session (deep copy, not a shared reference)', async () => {
    const goal = makeGoal();
    const original = makeOriginalSession({ goal });

    await migrate(original);

    expect(botSession).toBeDefined();
    expect(botSession.goal).toEqual(goal);
    // CLONE, not reference — terminating/mutating the original session must
    // not bleed into the migrated session.
    expect(botSession.goal).not.toBe(goal);
    goal.objective = 'MUTATED AFTER MIGRATION';
    goal.continuationCount = 99;
    expect(botSession.goal.objective).toBe('finish the migration epic');
    expect(botSession.goal.continuationCount).toBe(3);
    // DEEP clone, not a shallow spread: mutating a NESTED object on the
    // original must not bleed through either.
    (goal.pendingEval as { turnId: string }).turnId = 'MUTATED-NESTED';
    expect(botSession.goal.pendingEval.turnId).toBe('turn-orig-1');
    expect(botSession.goal.pendingEval).not.toBe(goal.pendingEval);
  });

  it('does NOT carry the runtime stash goalLastTurnText across migration', async () => {
    const original = makeOriginalSession({
      goal: makeGoal(),
      goalLastTurnText: 'assistant text of the dead thread',
    });

    await migrate(original);

    expect(botSession.goal).toBeDefined();
    expect(botSession.goalLastTurnText).toBeUndefined();
  });

  it('leaves goal undefined when the original session has none', async () => {
    const original = makeOriginalSession();

    await migrate(original);

    expect(botSession).toBeDefined();
    expect(botSession.goal).toBeUndefined();
  });
});
