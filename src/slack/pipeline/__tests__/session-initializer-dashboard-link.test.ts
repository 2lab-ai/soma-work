import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Source-thread work-log link (spec 10-agent-inbox-board §3.4-2).
 *
 * A new session posts one link into the thread the user started. It used to be
 * `📝 대화 기록 보기` (conversation viewer); it is now `📋 작업 로그`, the
 * dashboard deep link for the same session, resolved through the one injected
 * provider (`setThreadHeaderProviders`, wired in src/index.ts). No URL means
 * the viewer is not listening — the conversation viewer is the same server —
 * so nothing is posted. The post stays init clutter: tracked in
 * sourceThreadCleanupTs and deleted when the session moves to a bot thread,
 * where the header carries the link instead.
 */

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn(),
    createPendingUser: vi.fn(),
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
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
  getAllChannels: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../dispatch-service', () => ({
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({ workflow: 'default', title: 'Test' }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

import { getVerbosityFlags } from '@soma/slack/output-flags';
import { userSettingsStore } from '../../../user-settings-store';
import { SessionInitializer } from '../session-initializer';

// The dist session initializer loads ../thread-header-builder through Node's own
// require: the single instance production uses, but not the one vitest inlines
// for an `import` in this file. Configure the instance the code under test reads.
const { setThreadHeaderProviders } = createRequire(__filename)(
  '@soma/slack/thread-header-builder',
) as typeof import('@soma/slack/thread-header-builder');

const SOURCE_THREAD = '1711234567.000100';
const SESSION_KEY = `work:C123:${SOURCE_THREAD}`;
const DASHBOARD_URL = `http://localhost:3000/dashboard/U_EXISTING_USER?session=${encodeURIComponent(SESSION_KEY)}`;
const DASHBOARD_LINK = `📋 <${DASHBOARD_URL}|작업 로그>`;
const getDashboardSessionUrl = vi.fn<(ownerId: string, sessionKey: string) => string | undefined>();

let sessionInitializer: SessionInitializer;
let mockClaudeHandler: any;
let mockSlackApi: any;
let createdSession: any;

function mentionEvent() {
  return {
    user: 'U_EXISTING_USER',
    channel: 'C123',
    thread_ts: SOURCE_THREAD,
    ts: '1711234599.000200',
    text: '@zhugeliang 여기 내용 정리해줘',
  };
}

function sourceThreadPosts(): string[] {
  return mockSlackApi.postMessage.mock.calls
    .filter((call: any[]) => call[2]?.threadTs === SOURCE_THREAD)
    .map((call: any[]) => call[1]);
}

afterEach(() => {
  setThreadHeaderProviders({ getDashboardSessionUrl: () => undefined });
});

beforeEach(() => {
  vi.clearAllMocks();
  getDashboardSessionUrl.mockImplementation(
    (ownerId, sessionKey) =>
      `http://localhost:3000/dashboard/${encodeURIComponent(ownerId)}?session=${encodeURIComponent(sessionKey)}`,
  );
  setThreadHeaderProviders({ getDashboardSessionUrl });
  vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({ userId: 'U_EXISTING_USER', accepted: true } as any);

  createdSession = {
    sessionId: 'session-123',
    ownerId: 'U_EXISTING_USER',
    ownerName: 'Test User',
    channelId: 'C123',
    threadTs: SOURCE_THREAD,
    conversationId: undefined,
    isOnboarding: false,
    workflow: undefined,
  };

  mockClaudeHandler = {
    getSessionKey: vi.fn((channel: string, threadTs: string) => `work:${channel}:${threadTs}`),
    getSession: vi.fn().mockReturnValue(null),
    createSession: vi.fn(() => createdSession),
    isSleeping: vi.fn().mockReturnValue(false),
    wakeFromSleep: vi.fn(),
    needsDispatch: vi.fn().mockReturnValue(true),
    transitionToMain: vi.fn().mockReturnValue(true),
    setActivityState: vi.fn(),
    canInterrupt: vi.fn().mockReturnValue(false),
    updateInitiator: vi.fn(),
    setSessionLinks: vi.fn(),
    terminateSession: vi.fn(),
  };

  mockSlackApi = {
    getUserName: vi.fn().mockResolvedValue('Test User'),
    postMessage: vi.fn().mockImplementation(async (_channel: string, text: string) => {
      if (typeof text === 'string') {
        if (text.includes('작업 로그')) return { ts: 'dash-link-ts' };
        if (text.includes('대화 기록 보기')) return { ts: 'conv-link-ts' };
        if (text.includes('_Dispatching...')) return { ts: 'dispatch-ts' };
      }
      return { ts: 'other-bot-ts' };
    }),
    getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p1711234567000100'),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
  };

  sessionInitializer = new SessionInitializer({
    claudeHandler: mockClaudeHandler,
    slackApi: mockSlackApi,
    messageValidator: {
      validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: '/test/dir' }),
    },
    workingDirManager: { createSessionBaseDir: vi.fn().mockReturnValue(undefined) } as any,
    reactionManager: {
      setOriginalMessage: vi.fn(),
      clearSessionLifecycleEmojis: vi.fn().mockResolvedValue(undefined),
      getCurrentReaction: vi.fn().mockReturnValue(null),
      cleanup: vi.fn(),
    },
    requestCoordinator: {
      isRequestActive: vi.fn().mockReturnValue(false),
      setController: vi.fn(),
      abortSession: vi.fn(),
      getLastActivityAt: vi.fn().mockReturnValue(undefined),
      touchSession: vi.fn(),
    },
    contextWindowManager: { setOriginalMessage: vi.fn().mockResolvedValue(undefined) },
    assistantStatusManager: {
      setStatus: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      bumpEpoch: vi.fn().mockReturnValue(1),
      isEnabled: vi.fn().mockReturnValue(true),
    },
  } as any);
});

describe('source-thread work-log link', () => {
  it('posts the 📋 작업 로그 dashboard deep link for the session owner and key', async () => {
    await sessionInitializer.initialize(mentionEvent() as any, '/test/dir');

    expect(getDashboardSessionUrl).toHaveBeenCalledWith('U_EXISTING_USER', SESSION_KEY);
    const posts = sourceThreadPosts();
    expect(posts).toContain(DASHBOARD_LINK);
    expect(posts.some((text) => text.includes('대화 기록 보기'))).toBe(false);
  });

  it('keeps the link init clutter: deleted when the session moves to the bot thread', async () => {
    await sessionInitializer.initialize(mentionEvent() as any, '/test/dir');

    expect(mockSlackApi.deleteMessage).toHaveBeenCalledWith('C123', 'dash-link-ts');
    expect(mockSlackApi.deleteThreadBotMessages).not.toHaveBeenCalled();
  });

  it('posts the link at minimal log verbosity too', async () => {
    createdSession.logVerbosity = getVerbosityFlags('minimal');

    await sessionInitializer.initialize(mentionEvent() as any, '/test/dir');

    expect(sourceThreadPosts()).toContain(DASHBOARD_LINK);
  });

  it.each([
    ['returns undefined', () => undefined],
    [
      'throws',
      () => {
        throw new Error('viewer down');
      },
    ],
  ])('posts no link when the viewer is not listening (provider %s)', async (_label, impl) => {
    getDashboardSessionUrl.mockImplementation(impl);

    await sessionInitializer.initialize(mentionEvent() as any, '/test/dir');

    const posts = sourceThreadPosts();
    expect(posts.some((text) => text.includes('작업 로그'))).toBe(false);
    // No dead conversation-viewer link either — it is served by the same server.
    expect(posts.some((text) => text.includes('대화 기록 보기') || text.includes('/conversations/'))).toBe(false);
    expect(mockSlackApi.deleteMessage).not.toHaveBeenCalledWith('C123', 'dash-link-ts');
    expect(mockSlackApi.deleteMessage).not.toHaveBeenCalledWith('C123', 'conv-link-ts');
  });
});
