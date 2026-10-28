import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dashboard "New task" (SSOT 2026-10-23 T2/T4) — the session a dashboard task
 * opens in the chosen channel.
 *
 * The task's root message is posted by the bot into the channel; the event
 * that enters the pipeline is the requesting user's message ON that root
 * (`thread_ts === ts === rootTs`) with `skipAutoBotThread`. It must:
 *   - create the session in THAT thread (no second bot-owned header thread),
 *   - carry the per-task model AND effort chosen in the composer.
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

const ROOT_TS = '1792735000.000100';

function dashboardTaskEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    user: 'U_EXISTING_USER',
    channel: 'C123',
    thread_ts: ROOT_TS,
    ts: ROOT_TS,
    text: 'soma-work 개선해줘',
    modelOverride: 'claude-opus-5-5[1m]',
    effortOverride: 'high',
    autoGoalOverride: true,
    routeContext: { skipAutoBotThread: true },
    ...overrides,
  };
}

describe('dashboard task session (per-task overrides)', () => {
  beforeEach(() => {
    createdSession.threadTs = ROOT_TS;
  });

  it('creates the session on the task root with the chosen model', async () => {
    await sessionInitializer.initialize(dashboardTaskEvent() as any, '/test/dir');
    expect(mockClaudeHandler.createSession).toHaveBeenCalledWith(
      'U_EXISTING_USER',
      expect.anything(),
      'C123',
      ROOT_TS,
      'claude-opus-5-5[1m]',
    );
  });

  it('applies the chosen effort to the new session', async () => {
    await sessionInitializer.initialize(dashboardTaskEvent() as any, '/test/dir');
    expect(createdSession.effort).toBe('high');
  });

  it('applies the chosen effort to an existing idle session the task lands in', async () => {
    const existing = { ...createdSession, effort: 'low' };
    mockClaudeHandler.getSession.mockReturnValue(existing);
    await sessionInitializer.initialize(dashboardTaskEvent({ effortOverride: 'max' }) as any, '/test/dir');
    expect(existing.effort).toBe('max');
  });

  it('an invalid effort value is ignored (user default stays)', async () => {
    createdSession.effort = 'xhigh';
    await sessionInitializer.initialize(dashboardTaskEvent({ effortOverride: 'ludicrous' }) as any, '/test/dir');
    expect(createdSession.effort).toBe('xhigh');
  });

  it('no effort override leaves the session effort untouched', async () => {
    createdSession.effort = 'medium';
    await sessionInitializer.initialize(dashboardTaskEvent({ effortOverride: undefined }) as any, '/test/dir');
    expect(createdSession.effort).toBe('medium');
  });

  it('opens no second bot-owned header thread: the task root IS the thread', async () => {
    await sessionInitializer.initialize(dashboardTaskEvent() as any, '/test/dir');
    const rootPosts = mockSlackApi.postMessage.mock.calls.filter((call: any[]) => !call[2]?.threadTs);
    expect(rootPosts).toEqual([]);
  });
});
