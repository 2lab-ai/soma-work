import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks MUST be hoisted - define factories inline
vi.mock('../../user-settings-store', () => ({
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

vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn().mockReturnValue(false),
  getAdminUsers: vi.fn().mockReturnValue(new Set(['U_ADMIN1'])),
}));

vi.mock('../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv-123'),
  getConversationUrl: vi.fn().mockReturnValue('http://localhost:3000/conversations/conv-123'),
}));

vi.mock('../../channel-registry', () => ({
  checkRepoChannelMatch: vi.fn().mockReturnValue({ correct: true, suggestedChannels: [] }),
  getChannel: vi.fn().mockReturnValue(null),
  getAllChannels: vi.fn().mockReturnValue([]),
}));

vi.mock('../../dispatch-service', () => ({
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({ workflow: 'default', title: 'Test' }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

import { SessionInitializer } from './session-initializer';
import { userSettingsStore } from '../../user-settings-store';

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
    setActivityState: vi.fn(),
    canInterrupt: vi.fn().mockReturnValue(false),
    updateInitiator: vi.fn(),
    setSessionLinks: vi.fn(),
    terminateSession: vi.fn(),
  };

  mockSlackApi = {
    getUserName: vi.fn().mockResolvedValue('Test User'),
    postMessage: vi.fn().mockResolvedValue({ ts: 'msg123' }),
    getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p1739000000001000'),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
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
    requestCoordinator: mockRequestCoordinator,
    contextWindowManager: mockContextWindowManager,
    assistantStatusManager: mockAssistantStatusManager,
  } as any);
});

const ACCEPTED_USER_SETTINGS = {
  userId: 'U_EXISTING_USER',
  accepted: true,
  defaultDirectory: '/some/dir',
  bypassPermission: false,
  persona: 'default' as const,
  defaultModel: 'claude-sonnet-4-5-20250929',
  lastUpdated: '2024-01-01',
};

/**
 * Contract tests for Issue #64: mid-thread mention behavior
 * Trace: docs/mid-thread-initial-response/trace.md
 * Scenarios 1-3 (session-initializer scope)
 */

// ============================================================
// Scenario 1 — Mid-thread: 초기 메시지 유지 + 새 스레드 링크
// ============================================================
describe('Scenario 1: mid-thread mention — initial message retention', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  // Trace: S1, Sec 3b — deleteThreadBotMessages 미호출
  it('midThread_doesNotDeleteBotMessages: does not delete bot messages when thread_ts exists', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    expect(mockSlackApi.deleteThreadBotMessages).not.toHaveBeenCalled();
  });

  // Trace: S1, Sec 3b — rootResult.ts → permalink → postMessage
  it('midThread_includesNewThreadPermalink: initial message includes new thread permalink', async () => {
    const newThreadPermalink = 'https://workspace.slack.com/archives/C123/p1739000000001000';
    mockSlackApi.getPermalink.mockResolvedValue(newThreadPermalink);

    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    const originalThreadMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) => call[2]?.threadTs === '1711234567.000100'
    );

    const hasPermalinkMessage = originalThreadMessages.some(
      (call: any[]) => typeof call[1] === 'string' && call[1].includes(newThreadPermalink)
    );

    expect(hasPermalinkMessage).toBe(true);
  });

  // Trace: S1, Sec 3b — 📋 메시지 게시 확인
  it('midThread_retainsInitialMessage: posts retention message with intent summary', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    const originalThreadMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) => call[2]?.threadTs === '1711234567.000100'
    );

    const hasRetentionMessage = originalThreadMessages.some(
      (call: any[]) => typeof call[1] === 'string' && call[1].includes('📋')
    );

    expect(hasRetentionMessage).toBe(true);
  });

  // Trace: S1, Sec 5 — getPermalink null graceful degradation
  it('midThread_permalinkNull_gracefulDegradation: handles null permalink gracefully', async () => {
    mockSlackApi.getPermalink.mockResolvedValue(null);

    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await expect(
      sessionInitializer.initialize(event as any, '/test/dir')
    ).resolves.toBeDefined();

    expect(mockSlackApi.deleteThreadBotMessages).not.toHaveBeenCalled();
  });
});

// ============================================================
// Scenario 2 — Top-level: 기존 동작 유지
// ============================================================
describe('Scenario 2: top-level mention — existing behavior preserved', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  it('topLevel_deletesBotMessages: deletes bot messages when no thread_ts', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Hello!',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    expect(mockSlackApi.deleteThreadBotMessages).toHaveBeenCalledWith('C123', 'thread123');
  });

  it('topLevel_doesNotRetainInitialMessage: does not post permalink retention message', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Hello!',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    const retentionMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) =>
        call[2]?.threadTs === 'thread123' &&
        typeof call[1] === 'string' &&
        call[1].includes('📋')
    );

    expect(retentionMessages).toHaveLength(0);
  });
});

// ============================================================
// Scenario 3 — sourceThread 저장
// ============================================================
describe('Scenario 3: sourceThread storage on session', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  // Trace: S3, Sec 3b — mid-thread일 때 sourceThread 저장
  it('midThread_savesSourceThread: stores sourceThread on bot session for mid-thread mentions', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    const result = await sessionInitializer.initialize(event as any, '/test/dir');

    // The migrated bot session should have sourceThread set
    expect(result.session.sourceThread).toEqual({
      channel: 'C123',
      threadTs: '1711234567.000100',
    });
  });

  // Trace: S3, Sec 3b — top-level일 때 sourceThread 없음
  it('topLevel_noSourceThread: does not set sourceThread for top-level mentions', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Hello!',
    };

    const result = await sessionInitializer.initialize(event as any, '/test/dir');

    expect(result.session.sourceThread).toBeUndefined();
  });
});
