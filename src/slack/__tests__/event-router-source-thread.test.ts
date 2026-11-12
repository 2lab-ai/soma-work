import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeHandler } from '../../claude-handler';
import type { ConversationSession } from '../../types';
import type { ActionHandlers, MessageHandler } from '../actions';
import { EventRouter, type EventRouterDeps } from '../event-router';
import type { SessionUiManager } from '../session-manager';
import type { SlackApiHelper } from '../slack-api-helper';

vi.mock('../../channel-registry', () => ({
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
  findSessionsBySourceThread: vi.fn().mockReturnValue([]),
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
  activityState: 'working',
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
      links: { pr: { url: 'https://github.com/pr/1', type: 'pr', provider: 'github', label: 'PR #1' } },
    });
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.findSessionsBySourceThread.mockReturnValue([linkedSession]);

    const handler = getAppMentionHandler(mockApp);
    const mockSay = vi.fn();
    await handler({
      event: { user: 'U123', channel: 'C123', ts: '200.300', text: '<@B123> status?', thread_ts: '100.200' },
      say: mockSay,
    });

    expect(mockClaudeHandler.findSessionsBySourceThread).toHaveBeenCalledWith('C123', '100.200');
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

    expect(mockClaudeHandler.findSessionsBySourceThread).not.toHaveBeenCalled();
    expect(mockMessageHandler).toHaveBeenCalled();
  });

  it('should fall through to messageHandler when no linked session exists', async () => {
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.findSessionsBySourceThread.mockReturnValue([]);

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
    mockClaudeHandler.findSessionsBySourceThread.mockReturnValue([linkedSession]);
    mockSlackApi.getPermalink.mockRejectedValue(new Error('Slack API error'));

    const handler = getAppMentionHandler(mockApp);
    const mockSay = vi.fn().mockRejectedValue(new Error('say failed'));

    // Should not throw — error is caught internally
    await expect(
      handler({
        event: { user: 'U123', channel: 'C123', ts: '200.300', text: '<@B123> status?', thread_ts: '100.200' },
        say: mockSay,
      }),
    ).resolves.not.toThrow();
  });
});

/**
 * SSOT 2026-11-12 — a new instruction in a source thread is new work, not a status check. The sender is asked by
 * DM whether to run it as a new task (a new work thread, linked to the same source thread); the status card stays.
 */
describe('EventRouter — source thread re-mention with an instruction (new task offer)', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let mockClaudeHandler: ReturnType<typeof createMockClaudeHandler>;
  let mockApp: ReturnType<typeof createMockApp>;
  let mockMessageHandler: MessageHandler;
  let offerNewTask: any;
  let router: EventRouter;

  beforeEach(() => {
    mockSlackApi = createMockSlackApi();
    mockClaudeHandler = createMockClaudeHandler();
    mockApp = createMockApp();
    mockMessageHandler = vi.fn().mockResolvedValue(undefined) as unknown as MessageHandler;
    offerNewTask = vi.fn().mockResolvedValue(true);
    const deps: EventRouterDeps = {
      slackApi: mockSlackApi as unknown as SlackApiHelper,
      claudeHandler: mockClaudeHandler as unknown as ClaudeHandler,
      sessionManager: createMockSessionManager() as unknown as SessionUiManager,
      actionHandlers: createMockActionHandlers() as unknown as ActionHandlers,
      offerSourceThreadNewTask: offerNewTask,
    };
    router = new EventRouter(mockApp as any, deps, mockMessageHandler);
    router.setup();
  });

  afterEach(() => {
    router.cleanup();
  });

  const linked = (overrides: Partial<ConversationSession> = {}) =>
    createMockSession({
      channelId: 'C123',
      threadRootTs: '999.000',
      title: '로그인 장애 조사',
      activityState: 'idle',
      ...overrides,
    });

  it('asks the sender by DM whether to run the instruction as a new task, and says so in the thread', async () => {
    mockClaudeHandler.findSessionsBySourceThread.mockReturnValue([linked()]);
    const say = vi.fn();
    await getAppMentionHandler(mockApp)({
      event: { user: 'U_Z', channel: 'C123', ts: '200.300', text: '<@B123> $fix', thread_ts: '100.200' },
      say,
    });

    expect(offerNewTask).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', threadTs: '100.200', ts: '200.300', user: 'U_Z', text: '$fix' }),
    );
    // Never run in place: the instruction waits for the sender's answer.
    expect(mockMessageHandler).not.toHaveBeenCalled();
    const posted = say.mock.calls.map((c) => c[0].text).join('\n');
    expect(posted).toContain('로그인 장애 조사');
    expect(posted).toContain('<@U_Z>');
    expect(posted).toContain('DM');
  });

  it('a bare mention is a status check: the card only, no offer', async () => {
    mockClaudeHandler.findSessionsBySourceThread.mockReturnValue([linked()]);
    const say = vi.fn();
    await getAppMentionHandler(mockApp)({
      event: { user: 'U_Z', channel: 'C123', ts: '200.300', text: '<@B123>  ', thread_ts: '100.200' },
      say,
    });

    expect(offerNewTask).not.toHaveBeenCalled();
    expect(mockMessageHandler).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '100.200' }));
  });

  it('a source thread with several work threads lists every one of them', async () => {
    mockClaudeHandler.findSessionsBySourceThread.mockReturnValue([
      linked({ title: '첫 작업', threadRootTs: '901.000' }),
      linked({ title: '두번째 작업', threadRootTs: '902.000', activityState: 'working' }),
    ]);
    const say = vi.fn();
    await getAppMentionHandler(mockApp)({
      event: { user: 'U_Z', channel: 'C123', ts: '200.300', text: '<@B123> 상태?', thread_ts: '100.200' },
      say,
    });

    const posted = say.mock.calls.map((c) => c[0].text).join('\n');
    expect(posted).toContain('첫 작업');
    expect(posted).toContain('두번째 작업');
    expect(mockSlackApi.getPermalink).toHaveBeenCalledWith('C123', '901.000');
    expect(mockSlackApi.getPermalink).toHaveBeenCalledWith('C123', '902.000');
  });

  it('a DM that could not be sent leaves the card without the DM line', async () => {
    offerNewTask.mockResolvedValue(false);
    mockClaudeHandler.findSessionsBySourceThread.mockReturnValue([linked()]);
    const say = vi.fn();
    await getAppMentionHandler(mockApp)({
      event: { user: 'U_Z', channel: 'C123', ts: '200.300', text: '<@B123> $fix', thread_ts: '100.200' },
      say,
    });

    expect(offerNewTask).toHaveBeenCalled();
    const posted = say.mock.calls.map((c) => c[0].text).join('\n');
    expect(posted).toContain('로그인 장애 조사');
    expect(posted).not.toContain('DM으로');
  });
});

/**
 * SSOT 2026-11-12 — a mention WITH files in a source thread is an instruction too. Slack sends it as a
 * `file_share` message (app_mention defers to it), so the same DM confirmation must guard that path as well;
 * before, it started a first mention directly, skipping the sender's answer.
 */
describe('EventRouter — source thread mention with files (file_share path)', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let mockClaudeHandler: ReturnType<typeof createMockClaudeHandler>;
  let mockApp: ReturnType<typeof createMockApp>;
  let mockMessageHandler: MessageHandler;
  let offerNewTask: any;
  let router: EventRouter;

  beforeEach(() => {
    mockSlackApi = createMockSlackApi();
    mockClaudeHandler = createMockClaudeHandler();
    mockApp = createMockApp();
    mockMessageHandler = vi.fn().mockResolvedValue(undefined) as unknown as MessageHandler;
    offerNewTask = vi.fn().mockResolvedValue(true);
    const deps: EventRouterDeps = {
      slackApi: mockSlackApi as unknown as SlackApiHelper,
      claudeHandler: mockClaudeHandler as unknown as ClaudeHandler,
      sessionManager: createMockSessionManager() as unknown as SessionUiManager,
      actionHandlers: createMockActionHandlers() as unknown as ActionHandlers,
      offerSourceThreadNewTask: offerNewTask,
    };
    router = new EventRouter(mockApp as any, deps, mockMessageHandler);
    router.setup();
    mockClaudeHandler.findSessionsBySourceThread.mockReturnValue([
      createMockSession({ channelId: 'C123', threadRootTs: '999.000', title: '앞 작업', activityState: 'idle' }),
    ]);
  });

  afterEach(() => {
    router.cleanup();
  });

  const messageHandler = () => mockApp.event.mock.calls.find((c) => c[0] === 'message')![1];
  const fileMention = (text: string) => ({
    user: 'U_Z',
    channel: 'C123',
    ts: '200.300',
    thread_ts: '100.200',
    text,
    subtype: 'file_share',
    files: [{ id: 'F1', name: 'log.txt', mimetype: 'text/plain' }],
  });

  it('asks the sender by DM instead of starting a task directly', async () => {
    const say = vi.fn();
    await messageHandler()({ event: fileMention('<@B123> 이 로그 봐줘'), say });

    expect(mockMessageHandler).not.toHaveBeenCalled();
    expect(offerNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        threadTs: '100.200',
        ts: '200.300',
        user: 'U_Z',
        text: '이 로그 봐줘',
        fileCount: 1,
      }),
    );
    const posted = say.mock.calls.map((c) => c[0].text).join('\n');
    expect(posted).toContain('앞 작업');
    expect(posted).toContain('DM');
  });

  it('a mention with only files is still an instruction: it is offered too', async () => {
    const say = vi.fn();
    await messageHandler()({ event: fileMention('<@B123>'), say });

    expect(mockMessageHandler).not.toHaveBeenCalled();
    expect(offerNewTask).toHaveBeenCalledWith(expect.objectContaining({ text: '', fileCount: 1 }));
  });

  it('a file mention in a thread with no linked work still starts a first mention as before', async () => {
    mockClaudeHandler.findSessionsBySourceThread.mockReturnValue([]);
    await messageHandler()({ event: fileMention('<@B123> 이 로그 봐줘'), say: vi.fn() });

    expect(offerNewTask).not.toHaveBeenCalled();
    expect(mockMessageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '이 로그 봐줘' }),
      expect.anything(),
    );
  });
});
