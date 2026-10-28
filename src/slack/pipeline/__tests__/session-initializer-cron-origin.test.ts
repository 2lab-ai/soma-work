import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks MUST be hoisted - define factories inline
vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn(),
    createPendingUser: vi.fn(),
    ensureUserExists: vi.fn().mockReturnValue({
      userId: 'U123',
      accepted: true,
      defaultDirectory: '',
      bypassPermission: false,
      persona: 'default',
      defaultModel: 'claude-sonnet-4-5-20250929',
      lastUpdated: new Date().toISOString(),
    }),
    getUserBypassPermission: vi.fn().mockReturnValue(false),
    setUserBypassPermission: vi.fn(),
    getUserPersona: vi.fn().mockReturnValue('default'),
    setUserPersona: vi.fn(),
    getUserDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-5-20250929'),
    setUserDefaultModel: vi.fn(),
    getUserJiraInfo: vi.fn().mockReturnValue(undefined),
    updateUserJiraInfo: vi.fn(),
    removeUserSettings: vi.fn(),
    listUsers: vi.fn().mockReturnValue([]),
    loadSlackJiraMapping: vi.fn(),
    getSlackJiraMapping: vi.fn().mockReturnValue({}),
    findJiraAccountBySlackId: vi.fn().mockReturnValue(undefined),
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.8'),
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
  AVAILABLE_MODELS: [
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-8[1m]',
    'claude-opus-4-7[1m]',
    'claude-opus-4-6[1m]',
  ],
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
  checkRepoChannelMatch: vi.fn().mockReturnValue({ correct: true, suggestedChannels: [] }),
  getChannel: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../dispatch-service', () => ({
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({ workflow: 'default', title: 'Test' }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

import { userSettingsStore } from '../../../user-settings-store';
// Import after mocks
import { SessionInitializer } from '../session-initializer';

// The dist session initializer loads ../thread-header-builder through Node's own
// require: the single instance production uses, but not the one vitest inlines
// for an `import` in this file. Configure the instance the code under test reads.
const { setThreadHeaderProviders } = createRequire(__filename)(
  '@soma/slack/thread-header-builder',
) as typeof import('@soma/slack/thread-header-builder');

describe('SessionInitializer — cron-origin title (T1/T2)', () => {
  let sessionInitializer: SessionInitializer;
  let mockClaudeHandler: any;
  let mockSlackApi: any;
  let mockMessageValidator: any;
  let mockReactionManager: any;
  let mockContextWindowManager: any;
  let mockRequestCoordinator: any;
  let mockAssistantStatusManager: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock ClaudeHandler
    mockClaudeHandler = {
      getSessionKey: vi.fn().mockReturnValue('C123:thread123'),
      getSession: vi.fn().mockReturnValue(null),
      createSession: vi.fn().mockReturnValue({
        sessionId: 'session-123',
        owner: 'U123',
        ownerName: 'Test User',
        channel: 'C123',
        threadTs: 'thread123',
        conversationId: undefined,
        isOnboarding: false,
        workflow: undefined,
      }),
      isSleeping: vi.fn().mockReturnValue(false),
      wakeFromSleep: vi.fn(),
      needsDispatch: vi.fn().mockReturnValue(true),
      // Issue #698: transitionToMain now returns boolean (`true`=success,
      // `false`=session missing or already transitioned). Default mock returns
      // `true` so existing forceWorkflow tests don't trigger DispatchAbortError.
      transitionToMain: vi.fn().mockReturnValue(true),
      setActivityState: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(false),
      updateInitiator: vi.fn(),
      setSessionLinks: vi.fn(),
      terminateSession: vi.fn(),
    };

    // Create mock SlackApi
    mockSlackApi = {
      getUserName: vi.fn().mockResolvedValue('Test User'),
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg123' }),
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p1739000000001000'),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
    };

    // Create mock MessageValidator
    mockMessageValidator = {
      validateWorkingDirectory: vi.fn().mockReturnValue({
        valid: true,
        workingDirectory: '/test/dir',
      }),
    };

    // Create mock ReactionManager
    mockReactionManager = {
      setOriginalMessage: vi.fn(),
      clearSessionLifecycleEmojis: vi.fn().mockResolvedValue(undefined),
      getCurrentReaction: vi.fn().mockReturnValue(null),
      cleanup: vi.fn(),
    };

    // Create mock ContextWindowManager
    mockContextWindowManager = {
      setOriginalMessage: vi.fn().mockResolvedValue(undefined),
    };

    // Create mock RequestCoordinator
    mockRequestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
      setController: vi.fn(),
      abortSession: vi.fn(),
      getLastActivityAt: vi.fn().mockReturnValue(undefined),
      touchSession: vi.fn(),
    };

    // Create mock AssistantStatusManager
    mockAssistantStatusManager = {
      setStatus: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      bumpEpoch: vi.fn().mockReturnValue(1),
      getToolStatusText: vi.fn().mockReturnValue('running...'),
      buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
      registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      isEnabled: vi.fn().mockReturnValue(true),
    };

    sessionInitializer = new SessionInitializer({
      claudeHandler: mockClaudeHandler,
      slackApi: mockSlackApi,
      messageValidator: mockMessageValidator,
      workingDirManager: { createSessionBaseDir: vi.fn().mockReturnValue(undefined) } as any,
      reactionManager: mockReactionManager,
      contextWindowManager: mockContextWindowManager,
      requestCoordinator: mockRequestCoordinator,
      assistantStatusManager: mockAssistantStatusManager,
    });
  });

  const accepted = {
    userId: 'U123',
    accepted: true,
    defaultDirectory: '/some/dir',
    bypassPermission: false,
    persona: 'default',
    defaultModel: 'claude-sonnet-4-5-20250929',
    lastUpdated: '2024-01-01',
  };

  function freshSession(): Record<string, unknown> {
    return { sessionId: undefined, ownerId: 'U123', ownerName: 'Test User', channelId: 'C123', threadTs: 'thread123' };
  }

  it('names a cron-created session after its job and marks the title provisional', async () => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(accepted as any);
    const session = freshSession();
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.createSession.mockReturnValue(session);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);

    await sessionInitializer.initialize(
      {
        user: 'U123',
        channel: 'C123',
        thread_ts: 'thread123',
        ts: '1792728682.000100',
        text: '[cron:nightly-qa] $full-deploy',
        synthetic: true,
        skipDispatch: true,
        cron: { jobId: 'job-1', jobName: 'nightly-qa' },
        routeContext: { skipAutoBotThread: true },
      } as any,
      '/test/dir',
    );

    expect(mockClaudeHandler.transitionToMain).toHaveBeenCalledWith('C123', 'thread123', 'default', 'nightly-qa');
    expect(session.cronJob).toEqual({ id: 'job-1', name: 'nightly-qa' });
    expect(session.titleProvisional).toBe(true);
  });

  it('keeps "Direct (skipDispatch)" and no cron stamp for a non-cron bypass', async () => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(accepted as any);
    const session = freshSession();
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.createSession.mockReturnValue(session);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);

    await sessionInitializer.initialize(
      {
        user: 'U123',
        channel: 'C123',
        thread_ts: 'thread123',
        ts: '1792728682.000200',
        text: 'resume',
        synthetic: true,
        skipDispatch: true,
      } as any,
      '/test/dir',
    );

    expect(mockClaudeHandler.transitionToMain).toHaveBeenCalledWith(
      'C123',
      'thread123',
      'default',
      'Direct (skipDispatch)',
    );
    expect(session.cronJob).toBeUndefined();
    expect(session.titleProvisional).toBeUndefined();
  });

  it("does not stamp a restored session stuck in INITIALIZING (someone else's thread)", async () => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(accepted as any);
    const session = { ...freshSession(), sessionId: 's-2', state: 'INITIALIZING' };
    mockClaudeHandler.getSession.mockReturnValue(session);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);

    await sessionInitializer.initialize(
      {
        user: 'U123',
        channel: 'C123',
        thread_ts: 'thread123',
        ts: '1792728682.000400',
        text: '[cron:nightly-qa] $full-deploy',
        synthetic: true,
        skipDispatch: true,
        cron: { jobId: 'job-1', jobName: 'nightly-qa' },
      } as any,
      '/test/dir',
    );

    expect(mockClaudeHandler.transitionToMain).toHaveBeenCalledWith(
      'C123',
      'thread123',
      'default',
      'Direct (skipDispatch)',
    );
    expect((session as any).cronJob).toBeUndefined();
    expect((session as any).titleProvisional).toBeUndefined();
  });

  it('does not stamp an existing (already dispatched) session a cron fire is injected into', async () => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(accepted as any);
    const session = { ...freshSession(), sessionId: 's-1', title: 'Human work', state: 'MAIN' };
    mockClaudeHandler.getSession.mockReturnValue(session);
    mockClaudeHandler.needsDispatch.mockReturnValue(false);

    await sessionInitializer.initialize(
      {
        user: 'U123',
        channel: 'C123',
        thread_ts: 'thread123',
        ts: '1792728682.000300',
        text: '[cron:nightly-qa] $full-deploy',
        synthetic: true,
        skipDispatch: true,
        cron: { jobId: 'job-1', jobName: 'nightly-qa' },
      } as any,
      '/test/dir',
    );

    expect(mockClaudeHandler.transitionToMain).not.toHaveBeenCalled();
    expect(session.title).toBe('Human work');
    expect((session as any).cronJob).toBeUndefined();
  });
});
