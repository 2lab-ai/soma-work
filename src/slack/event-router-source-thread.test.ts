import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventRouter, EventRouterDeps } from './event-router';
import { SlackApiHelper } from './slack-api-helper';
import { SessionUiManager } from './session-manager';
import { ActionHandlers, MessageHandler } from './action-handlers';
import { ClaudeHandler } from '../claude-handler';
import { ConversationSession } from '../types';

vi.mock('../channel-registry', () => ({
  registerChannel: vi.fn().mockResolvedValue(null),
  unregisterChannel: vi.fn(),
}));

const createMockSlackApi = () => ({
  getBotUserId: vi.fn().mockResolvedValue('B123'),
  getChannelInfo: vi.fn().mockResolvedValue({ name: 'general' }),
  getClient: vi.fn().mockReturnValue({}),
  addReaction: vi.fn().mockResolvedValue(true),
  getPermalink: vi.fn().mockResolvedValue('https://slack.com/permalink'),
});

const createMockClaudeHandler = () => ({
  getSession: vi.fn().mockReturnValue(null),
  findSessionBySourceThread: vi.fn().mockReturnValue(undefined),
  setExpiryCallbacks: vi.fn(),
  cleanupInactiveSessions: vi.fn().mockResolvedValue(undefined),
});

const createMockSessionManager = () => ({
  handleSessionWarning: vi.fn().mockResolvedValue('123.456'),
  handleSessionSleep: vi.fn().mockResolvedValue(undefined),
  handleSessionExpiry: vi.fn().mockResolvedValue(undefined),
});

const createMockActionHandlers = () => ({
  registerHandlers: vi.fn(),
});

const createMockApp = () => ({
  message: vi.fn(),
  event: vi.fn(),
  command: vi.fn(),
});

const createMockSession = (overrides: Partial<ConversationSession> = {}): ConversationSession => ({
  ownerId: 'U123',
  ownerName: 'Test User',
  channelId: 'C123',
  threadTs: '111.222',
  sessionId: 'session-123',
  isActive: true,
  lastActivity: new Date(),
  userId: 'U123',
  title: 'Test Session',
  activityState: 'streaming',
  ...overrides,
});

/** Extract the app_mention handler registered on the mock app */
function getAppMentionHandler(mockApp: ReturnType<typeof createMockApp>) {
  const call = mockApp.event.mock.calls.find((c) => c[0] === 'app_mention');
  if (!call) throw new Error('app_mention handler not registered');
  return call[1];
}

describe('EventRouter — source thread re-mention', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let mockClaudeHandler: ReturnType<typeof createMockClaudeHandler>;
  let mockApp: ReturnType<typeof createMockApp>;
  let mockMessageHandler: MessageHandler;
  let router: EventRouter;

  beforeEach(() => {
    mockSlackApi = createMockSlackApi();
    mockClaudeHandler = createMockClaudeHandler();
    mockApp = createMockApp();
    mockMessageHandler = vi.fn().mockResolvedValue(undefined) as unknown as MessageHandler;

    const deps: EventRouterDeps = {
      slackApi: mockSlackApi as unknown as SlackApiHelper,
      claudeHandler: mockClaudeHandler as unknown as ClaudeHandler,
      sessionManager: createMockSessionManager() as unknown as SessionUiManager,
      actionHandlers: createMockActionHandlers() as unknown as ActionHandlers,
    };

    router = new EventRouter(mockApp as any, deps, mockMessageHandler);
    router.setup();
  });

  afterEach(() => {
    router.cleanup();
  });

  it('should respond with linked session status when re-mentioned in source thread', async () => {
    const linkedSession = createMockSession({
      channelId: 'C123',
      threadRootTs: '999.000',
      links: { pr: { url: 'https://github.com/pr/1', label: 'PR #1' } },
    });
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.findSessionBySourceThread.mockReturnValue(linkedSession);

    const handler = getAppMentionHandler(mockApp);
    const mockSay = vi.fn();
    await handler({
      event: { user: 'U123', channel: 'C123', ts: '200.300', text: '<@B123> status?', thread_ts: '100.200' },
      say: mockSay,
    });

    expect(mockClaudeHandler.findSessionBySourceThread).toHaveBeenCalledWith('C123', '100.200');
    expect(mockSay).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '100.200' }));
    expect(mockMessageHandler).not.toHaveBeenCalled();
  });

  it('should fall through to messageHandler when thread has its own direct session', async () => {
    mockClaudeHandler.getSession.mockReturnValue(createMockSession());

    const handler = getAppMentionHandler(mockApp);
    const mockSay = vi.fn();
    await handler({
      event: { user: 'U123', channel: 'C123', ts: '200.300', text: '<@B123> hello', thread_ts: '100.200' },
      say: mockSay,
    });

    expect(mockClaudeHandler.findSessionBySourceThread).not.toHaveBeenCalled();
    expect(mockMessageHandler).toHaveBeenCalled();
  });

  it('should fall through to messageHandler when no linked session exists', async () => {
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.findSessionBySourceThread.mockReturnValue(undefined);

    const handler = getAppMentionHandler(mockApp);
    const mockSay = vi.fn();
    await handler({
      event: { user: 'U123', channel: 'C123', ts: '200.300', text: '<@B123> hello', thread_ts: '100.200' },
      say: mockSay,
    });

    expect(mockMessageHandler).toHaveBeenCalled();
  });

  it('should catch errors in respondWithLinkedSessionStatus without crashing', async () => {
    const linkedSession = createMockSession();
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.findSessionBySourceThread.mockReturnValue(linkedSession);
    mockSlackApi.getPermalink.mockRejectedValue(new Error('Slack API error'));

    const handler = getAppMentionHandler(mockApp);
    const mockSay = vi.fn().mockRejectedValue(new Error('say failed'));

    // Should not throw — error is caught internally
    await expect(
      handler({
        event: { user: 'U123', channel: 'C123', ts: '200.300', text: '<@B123> status?', thread_ts: '100.200' },
        say: mockSay,
      })
    ).resolves.not.toThrow();
  });
});
