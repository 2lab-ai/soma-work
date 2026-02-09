import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks MUST be hoisted - define factories inline
vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn(),
    ensureUserExists: vi.fn().mockReturnValue({
      userId: 'U123',
      defaultDirectory: '',
      bypassPermission: false,
      persona: 'default',
      defaultModel: 'claude-sonnet-4-5-20250929',
      lastUpdated: new Date().toISOString(),
    }),
    getUserDefaultDirectory: vi.fn().mockReturnValue(''),
    setUserDefaultDirectory: vi.fn(),
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
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.6'),
  },
  AVAILABLE_MODELS: ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001'],
  DEFAULT_MODEL: 'claude-opus-4-6',
}));

vi.mock('../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv-123'),
  getConversationUrl: vi.fn().mockReturnValue('http://localhost:3000/conversations/conv-123'),
}));

vi.mock('../../channel-registry', () => ({
  checkRepoChannelMatch: vi.fn().mockReturnValue({ correct: true, suggestedChannels: [] }),
  getChannel: vi.fn().mockReturnValue(null),
}));

vi.mock('../../dispatch-service', () => ({
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({ workflow: 'default', title: 'Test' }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

// Import after mocks
import { SessionInitializer } from './session-initializer';
import { userSettingsStore } from '../../user-settings-store';

describe('SessionInitializer - Onboarding Detection', () => {
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
      transitionToMain: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(false),
      updateInitiator: vi.fn(),
      setSessionLinks: vi.fn(),
      terminateSession: vi.fn(),
    };

    // Create mock SlackApi
    mockSlackApi = {
      getUserName: vi.fn().mockResolvedValue('Test User'),
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg123' }),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
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
    };

    // Create mock AssistantStatusManager
    mockAssistantStatusManager = {
      setStatus: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    };

    sessionInitializer = new SessionInitializer({
      claudeHandler: mockClaudeHandler,
      slackApi: mockSlackApi,
      messageValidator: mockMessageValidator,
      reactionManager: mockReactionManager,
      contextWindowManager: mockContextWindowManager,
      requestCoordinator: mockRequestCoordinator,
      assistantStatusManager: mockAssistantStatusManager,
    });
  });

  describe('first-time user detection', () => {
    it('should trigger onboarding for new user without settings', async () => {
      // Setup: No existing session, no user settings
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(null as any);
      mockClaudeHandler.getSession.mockReturnValue(null);

      const event = {
        user: 'U_NEW_USER',
        channel: 'C123',
        thread_ts: undefined,
        ts: 'thread123',
        text: 'Hello!',
      };

      await sessionInitializer.initialize(event as any, '/test/dir');

      // Verify: transitionToMain was called with 'onboarding'
      expect(mockClaudeHandler.transitionToMain).toHaveBeenCalledWith(
        'C123',
        'thread123',
        'onboarding',
        'Welcome!'
      );
    });

    it('should NOT trigger onboarding for user with existing settings', async () => {
      // Setup: User has settings
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U_EXISTING_USER',
        defaultDirectory: '/some/dir',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-sonnet-4-5-20250929',
        lastUpdated: '2024-01-01',
      });
      mockClaudeHandler.getSession.mockReturnValue(null);
      mockClaudeHandler.needsDispatch.mockReturnValue(true);

      const event = {
        user: 'U_EXISTING_USER',
        channel: 'C123',
        thread_ts: undefined,
        ts: 'thread123',
        text: 'Hello!',
      };

      await sessionInitializer.initialize(event as any, '/test/dir');

      // Verify: transitionToMain was NOT called with 'onboarding'
      const transitionCalls = mockClaudeHandler.transitionToMain.mock.calls;
      const onboardingCall = transitionCalls.find((call: any[]) => call[2] === 'onboarding');
      expect(onboardingCall).toBeUndefined();
    });

    it('should NOT trigger onboarding for existing session', async () => {
      // Setup: Existing session exists
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(null as any);
      mockClaudeHandler.getSession.mockReturnValue({
        sessionId: 'existing-session',
        owner: 'U123',
        ownerName: 'Test User',
        channel: 'C123',
        threadTs: 'thread123',
      });

      const event = {
        user: 'U_NEW_USER',
        channel: 'C123',
        thread_ts: 'thread123',
        ts: 'msg456',
        text: 'Follow up message',
      };

      await sessionInitializer.initialize(event as any, '/test/dir');

      // Verify: transitionToMain was NOT called with 'onboarding'
      const transitionCalls = mockClaudeHandler.transitionToMain.mock.calls;
      const onboardingCall = transitionCalls.find((call: any[]) => call[2] === 'onboarding');
      expect(onboardingCall).toBeUndefined();
    });

    it('should skip onboarding for user with Jira mapping (settings created by InputProcessor)', async () => {
      // Setup: User has settings with Jira info
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U_JIRA_USER',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-sonnet-4-5-20250929',
        lastUpdated: '2024-01-01',
        jiraAccountId: 'jira-12345',
        jiraName: 'Test Jira User',
      });
      mockClaudeHandler.getSession.mockReturnValue(null);
      mockClaudeHandler.needsDispatch.mockReturnValue(true);

      const event = {
        user: 'U_JIRA_USER',
        channel: 'C123',
        thread_ts: undefined,
        ts: 'thread123',
        text: 'https://jira.example.com/browse/TEST-123',
      };

      await sessionInitializer.initialize(event as any, '/test/dir');

      // Verify: transitionToMain was NOT called with 'onboarding'
      const transitionCalls = mockClaudeHandler.transitionToMain.mock.calls;
      const onboardingCall = transitionCalls.find((call: any[]) => call[2] === 'onboarding');
      expect(onboardingCall).toBeUndefined();
    });
  });

  describe('onboarding session state', () => {
    it('should set isOnboarding flag on session when onboarding is triggered', async () => {
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(null as any);
      mockClaudeHandler.getSession.mockReturnValue(null);

      // Capture the session object
      let capturedSession: any = null;
      mockClaudeHandler.createSession.mockImplementation(() => {
        capturedSession = {
          sessionId: 'session-123',
          owner: 'U_NEW',
          ownerName: 'New User',
          channel: 'C123',
          threadTs: 'thread123',
          isOnboarding: false,
        };
        return capturedSession;
      });

      const event = {
        user: 'U_NEW',
        channel: 'C123',
        thread_ts: undefined,
        ts: 'thread123',
        text: 'Hello!',
      };

      await sessionInitializer.initialize(event as any, '/test/dir');

      // Verify session.isOnboarding was set to true
      expect(capturedSession.isOnboarding).toBe(true);
    });
  });

  describe('bot thread header creation', () => {
    it('creates a new bot thread header for non-routable initiate message', async () => {
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U_EXISTING_USER',
        defaultDirectory: '/some/dir',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-sonnet-4-5-20250929',
        lastUpdated: '2024-01-01',
      } as any);
      mockClaudeHandler.getSession.mockReturnValue(null);
      mockClaudeHandler.needsDispatch.mockReturnValue(true);

      const event = {
        user: 'U_EXISTING_USER',
        channel: 'C123',
        thread_ts: undefined,
        ts: 'thread123',
        text: 'Hello!',
      };

      const result = await sessionInitializer.initialize(event as any, '/test/dir');

      const headerCall = mockSlackApi.postMessage.mock.calls.find((call: any[]) =>
        Array.isArray(call[2]?.attachments)
      );
      expect(headerCall).toBeDefined();
      expect(result.session.threadModel).toBe('bot-initiated');
      expect(result.session.threadRootTs).toBe('msg123');
    });
  });
});
