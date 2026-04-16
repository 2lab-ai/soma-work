import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn().mockReturnValue({
      userId: 'U123',
      accepted: true,
      defaultDirectory: '',
      bypassPermission: false,
      persona: 'default',
      defaultModel: 'claude-opus-4-6',
      lastUpdated: new Date().toISOString(),
    }),
    createPendingUser: vi.fn(),
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.6'),
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
  DEFAULT_MODEL: 'claude-opus-4-6',
}));

vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn().mockReturnValue(false),
  getAdminUsers: vi.fn().mockReturnValue(new Set(['U_ADMIN1'])),
}));

vi.mock('../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv-123'),
  getConversationUrl: vi.fn().mockReturnValue('http://localhost:3000/conversations/conv-123'),
}));

vi.mock('../../channel-registry', () => ({
  checkRepoChannelMatch: vi.fn().mockReturnValue({
    correct: false,
    suggestedChannels: [{ id: 'C999', name: 'target' }],
    reason: 'mismatch',
  }),
  getChannel: vi.fn().mockReturnValue(null),
  getAllChannels: vi.fn().mockReturnValue([]),
  registerChannel: vi.fn().mockResolvedValue(null),
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

import * as channelRegistry from '../../channel-registry';
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
  const mockCheckRepoChannelMatch = vi.mocked(channelRegistry.checkRepoChannelMatch);
  const mockGetAllChannels = vi.mocked(channelRegistry.getAllChannels);
  const mockGetChannel = vi.mocked(channelRegistry.getChannel);
  const mockRegisterChannel = vi.mocked(channelRegistry.registerChannel);
  const originalDefaultUpdateChannel = process.env.DEFAULT_UPDATE_CHANNEL;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionRef = undefined;
    delete process.env.DEFAULT_UPDATE_CHANNEL;
    mockCheckRepoChannelMatch.mockReturnValue({
      correct: false,
      suggestedChannels: [{ id: 'C999', name: 'target' }],
      reason: 'mismatch',
    } as any);
    mockGetAllChannels.mockReturnValue([]);

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
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p1739000000001000'),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph123' }),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockReturnValue({}),
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
      workingDirManager: { createSessionBaseDir: vi.fn().mockReturnValue(undefined) } as any,
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

  it('shows fallback advisory when repo channel mapping is missing', async () => {
    mockCheckRepoChannelMatch.mockReturnValue({
      correct: false,
      suggestedChannels: [],
      reason: 'no_mapping',
    } as any);

    const event = {
      user: 'U123',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Review PR https://github.com/acme/repo/pull/1',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    const callWithBlocks = mockSlackApi.postMessage.mock.calls.find((call: any[]) => Array.isArray(call[2]?.blocks));
    expect(callWithBlocks).toBeDefined();
    const blocks = callWithBlocks[2]?.blocks;
    const sectionBlock = blocks.find((block: any) => block.type === 'section');
    expect(sectionBlock.text.text).toContain('매핑된 채널을 찾지 못했습니다');
    const actionsBlock = blocks.find((block: any) => block.type === 'actions');
    const actionIds = actionsBlock.elements.map((el: any) => el.action_id);
    expect(actionIds).not.toContain('channel_route_move');
    expect(actionIds).toContain('channel_route_stop');
    expect(actionIds).toContain('channel_route_stay');
  });

  it('shows default-channel move option when DEFAULT_UPDATE_CHANNEL is configured', async () => {
    process.env.DEFAULT_UPDATE_CHANNEL = '#ai-reports';
    mockGetAllChannels.mockReturnValue([
      {
        id: 'C777',
        name: 'ai-reports',
        purpose: '',
        topic: '',
        repos: [],
        joinedAt: Date.now(),
      },
    ] as any);
    mockCheckRepoChannelMatch.mockReturnValue({
      correct: false,
      suggestedChannels: [],
      reason: 'no_mapping',
    } as any);

    const event = {
      user: 'U123',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Review PR https://github.com/acme/repo/pull/1',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    const callWithBlocks = mockSlackApi.postMessage.mock.calls.find((call: any[]) => Array.isArray(call[2]?.blocks));
    expect(callWithBlocks).toBeDefined();
    const blocks = callWithBlocks[2]?.blocks;
    const actionsBlock = blocks.find((block: any) => block.type === 'actions');
    const moveButton = actionsBlock.elements.find((el: any) => el.action_id === 'channel_route_move');
    expect(moveButton).toBeDefined();
    expect(moveButton.text.text).toBe('기본 채널로 이동');
    const sectionBlock = blocks.find((block: any) => block.type === 'section');
    expect(sectionBlock.text.text).toContain('<#C777>');
  });

  it('auto-creates a bot thread header even when channel metadata is missing', async () => {
    mockCheckRepoChannelMatch.mockReturnValue({
      correct: true,
      suggestedChannels: [],
      reason: 'matched',
    } as any);

    const event = {
      user: 'U123',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Review PR https://github.com/acme/repo/pull/1',
    };

    const result = await sessionInitializer.initialize(event as any, '/test/dir');

    const headerCall = mockSlackApi.postMessage.mock.calls.find(
      (call: any[]) => Array.isArray(call[2]?.blocks) && !Array.isArray(call[2]?.attachments),
    );
    expect(headerCall).toBeDefined();
    const migratedContextCall = mockSlackApi.postMessage.mock.calls.find(
      (call: any[]) => call[2]?.threadTs === 'msg123' && String(call[1] || '').includes('View conversation history'),
    );
    expect(migratedContextCall).toBeDefined();
    expect(String(migratedContextCall?.[1] || '')).toContain('PR #1');
    expect(result.session.threadModel).toBe('bot-initiated');
    expect(result.session.threadRootTs).toBe('msg123');
  });

  it('registers channel on-the-fly when not in registry before checking repo match', async () => {
    // Channel not in registry initially
    mockGetChannel.mockReturnValue(undefined);
    // After registerChannel, checkRepoChannelMatch returns correct
    mockRegisterChannel.mockResolvedValue({
      id: 'C123',
      name: 'workspace-soma-work',
      purpose: 'https://github.com/acme/repo',
      topic: '',
      repos: ['acme/repo'],
      joinedAt: Date.now(),
    });
    mockCheckRepoChannelMatch.mockReturnValue({
      correct: true,
      suggestedChannels: [],
      reason: 'matched',
    } as any);

    const event = {
      user: 'U123',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Review PR https://github.com/acme/repo/pull/1',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // registerChannel should have been called with the Slack client and channel ID
    expect(mockRegisterChannel).toHaveBeenCalledWith({}, 'C123');
    // Should NOT show no_mapping advisory (channel was registered successfully)
    const noMappingCall = mockSlackApi.postMessage.mock.calls.find((call: any[]) => {
      const blocks = call[2]?.blocks;
      if (!Array.isArray(blocks)) return false;
      return blocks.some((b: any) => b.type === 'section' && b.text?.text?.includes('매핑된 채널을 찾지 못했습니다'));
    });
    expect(noMappingCall).toBeUndefined();
  });

  it('threads sourceThreadCleanupTs into channel-route button value (Issue #516)', async () => {
    // Distinct ts per postMessage so we can identify the conversation-link ts.
    mockSlackApi.postMessage = vi.fn().mockImplementation(async (_c: string, text: string) => {
      if (typeof text === 'string') {
        if (text.includes('대화 기록 보기')) return { ts: 'conv-link-ts' };
        if (text.includes('_Dispatching...')) return { ts: 'dispatch-ts' };
      }
      return { ts: 'other-bot-ts' };
    });

    const event = {
      user: 'U123',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Review PR https://github.com/acme/repo/pull/1',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // Advisory post carries Move/Stop buttons with cleanupTs durably serialized.
    const advisoryCall = mockSlackApi.postMessage.mock.calls.find((call: any[]) => {
      const blocks = call[2]?.blocks;
      if (!Array.isArray(blocks)) return false;
      return blocks.some((b: any) => b.type === 'actions');
    });
    expect(advisoryCall).toBeDefined();
    const actionsBlock = advisoryCall![2].blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements.length).toBeGreaterThan(0);

    // Every button in the advisory must carry cleanupTs that includes the
    // conversation-link ts we tracked during init. This is the durability
    // contract: the handler fires after restart / session halt, and must
    // still be able to clean up init clutter without a session registry.
    for (const el of actionsBlock.elements as any[]) {
      const decoded = JSON.parse(el.value);
      expect(decoded.cleanupTs).toContain('conv-link-ts');
    }
  });

  it('falls through to no_mapping when registerChannel fails to find repo', async () => {
    // Channel not in registry
    mockGetChannel.mockReturnValue(undefined);
    // registerChannel succeeds but finds no repos
    mockRegisterChannel.mockResolvedValue({
      id: 'C123',
      name: 'general',
      purpose: '',
      topic: '',
      repos: [],
      joinedAt: Date.now(),
    });
    // Still no mapping after registration
    mockCheckRepoChannelMatch.mockReturnValue({
      correct: false,
      suggestedChannels: [],
      reason: 'no_mapping',
    } as any);

    const event = {
      user: 'U123',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Review PR https://github.com/acme/repo/pull/1',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    expect(mockRegisterChannel).toHaveBeenCalledWith({}, 'C123');
    // Should still show fallback advisory
    const noMappingCall = mockSlackApi.postMessage.mock.calls.find((call: any[]) => {
      const blocks = call[2]?.blocks;
      if (!Array.isArray(blocks)) return false;
      return blocks.some((b: any) => b.type === 'section' && b.text?.text?.includes('매핑된 채널을 찾지 못했습니다'));
    });
    expect(noMappingCall).toBeDefined();
  });

  afterEach(() => {
    if (originalDefaultUpdateChannel === undefined) {
      delete process.env.DEFAULT_UPDATE_CHANNEL;
      return;
    }
    process.env.DEFAULT_UPDATE_CHANNEL = originalDefaultUpdateChannel;
  });
});
