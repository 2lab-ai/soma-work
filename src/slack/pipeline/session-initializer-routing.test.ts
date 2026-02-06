import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn().mockReturnValue({
      userId: 'U123',
      defaultDirectory: '',
      bypassPermission: false,
      persona: 'default',
      defaultModel: 'claude-opus-4-6',
      lastUpdated: new Date().toISOString(),
    }),
  },
}));

vi.mock('../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv-123'),
  getConversationUrl: vi.fn().mockReturnValue('http://localhost:3000/conversations/conv-123'),
}));

vi.mock('../../channel-registry', () => ({
  checkRepoChannelMatch: vi.fn().mockReturnValue({
    correct: false,
    suggestedChannels: [{ id: 'C999', name: 'target' }],
  }),
  getChannel: vi.fn().mockReturnValue(null),
}));

vi.mock('../../dispatch-service', () => ({
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({
      workflow: 'pr-review',
      title: 'PR Review',
      links: {
        pr: {
          url: 'https://github.com/acme/repo/pull/1',
          type: 'pr',
          provider: 'github',
          label: 'PR #1',
        },
      },
    }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

import { SessionInitializer } from './session-initializer';

describe('SessionInitializer - channel routing advisory', () => {
  let sessionInitializer: SessionInitializer;
  let mockClaudeHandler: any;
  let mockSlackApi: any;
  let mockMessageValidator: any;
  let mockReactionManager: any;
  let mockContextWindowManager: any;
  let mockRequestCoordinator: any;
  let mockAssistantStatusManager: any;
  let sessionRef: any;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionRef = undefined;

    mockClaudeHandler = {
      getSessionKey: vi.fn().mockReturnValue('C123:thread123'),
      getSession: vi.fn().mockReturnValue(null),
      createSession: vi.fn().mockImplementation((_u: string, _n: string, channel: string, threadTs: string) => {
        sessionRef = {
          ownerId: 'U123',
          ownerName: 'Test User',
          userId: 'U123',
          channelId: channel,
          threadTs,
          isActive: true,
          lastActivity: new Date(),
          activityState: 'idle',
        };
        return sessionRef;
      }),
      isSleeping: vi.fn().mockReturnValue(false),
      wakeFromSleep: vi.fn(),
      needsDispatch: vi.fn().mockReturnValue(true),
      transitionToMain: vi.fn().mockImplementation((_c: string, _t: string, workflow: string, title?: string) => {
        if (sessionRef) {
          sessionRef.workflow = workflow;
          if (title) sessionRef.title = title;
        }
      }),
      setSessionLinks: vi.fn().mockImplementation((_c: string, _t: string, links: any) => {
        if (sessionRef) sessionRef.links = links;
      }),
      canInterrupt: vi.fn().mockReturnValue(false),
      updateInitiator: vi.fn(),
      terminateSession: vi.fn(),
    };

    mockSlackApi = {
      getUserName: vi.fn().mockResolvedValue('Test User'),
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg123' }),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph123' }),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };

    mockMessageValidator = {
      validateWorkingDirectory: vi.fn().mockReturnValue({
        valid: true,
        workingDirectory: '/test/dir',
      }),
    };

    mockReactionManager = {
      setOriginalMessage: vi.fn(),
      clearSessionLifecycleEmojis: vi.fn().mockResolvedValue(undefined),
      getCurrentReaction: vi.fn().mockReturnValue(null),
      cleanup: vi.fn(),
    };

    mockContextWindowManager = {
      setOriginalMessage: vi.fn().mockResolvedValue(undefined),
    };

    mockRequestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
      setController: vi.fn(),
      abortSession: vi.fn(),
    };

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

  it('posts routing advisory as a public message', async () => {
    const event = {
      user: 'U123',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Review PR https://github.com/acme/repo/pull/1',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    expect(mockSlackApi.postMessage).toHaveBeenCalled();
    const callWithBlocks = mockSlackApi.postMessage.mock.calls.find((call: any[]) => Array.isArray(call[2]?.blocks));
    expect(callWithBlocks).toBeDefined();
    expect(callWithBlocks[0]).toBe('C123');
    const blocks = callWithBlocks[2]?.blocks;
    const actionsBlock = blocks.find((block: any) => block.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(mockSlackApi.postEphemeral).not.toHaveBeenCalled();
  });
});
