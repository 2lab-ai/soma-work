import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    // A user the bot has never seen: the acceptance gate applies.
    getUserSettings: vi.fn().mockReturnValue(undefined),
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
  checkRepoChannelMatch: vi.fn().mockReturnValue({
    correct: false,
    suggestedChannels: [{ id: 'C999', name: 'target' }],
    reason: 'mismatch',
  }),
  getChannel: vi.fn().mockReturnValue(null),
  getAllChannels: vi.fn().mockReturnValue([]),
  registerChannel: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../dispatch-service', () => ({
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

// The admins could not be asked (a store or Slack failure).
const notify = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('admin-requests.json unreadable');
  }),
);
vi.mock('../../new-user-decision', () => ({ notifyAdminsNewUser: notify }));

import * as channelRegistry from '../../../channel-registry';
import { SessionInitializer } from '../session-initializer';

// The dist session initializer loads ../thread-header-builder through Node's own
// require: the single instance production uses, but not the one vitest inlines
// for an `import` in this file. Configure the instance the code under test reads.
const { setThreadHeaderProviders } = createRequire(__filename)(
  '@soma/slack/thread-header-builder',
) as typeof import('@soma/slack/thread-header-builder');

/**
 * #622 — the new-user gate: whatever happens while the admins are asked, the
 * just-created session is closed, so the next message hits the gate again (a
 * session left behind would skip the new-session-only acceptance check).
 */
describe('SessionInitializer - new-user gate teardown', () => {
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
      getLastActivityAt: vi.fn().mockReturnValue(undefined),
      touchSession: vi.fn(),
    };

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

  it('the admins could not be asked: the session is still closed and the turn halts', async () => {
    const result = await sessionInitializer.initialize(
      { user: 'U123', channel: 'C123', thread_ts: undefined, ts: 'thread123', text: 'hello' } as any,
      '/test/dir',
    );
    expect(notify).toHaveBeenCalled();
    expect(mockClaudeHandler.terminateSession).toHaveBeenCalledWith('C123:thread123');
    expect((result as any).halted).toBe(true);
  });
});
