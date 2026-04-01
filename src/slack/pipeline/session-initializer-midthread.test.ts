import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
  AVAILABLE_MODELS: [
    'claude-opus-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
  ],
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

import { userSettingsStore } from '../../user-settings-store';
import { SessionInitializer } from './session-initializer';

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
    workingDirManager: { createSessionBaseDir: vi.fn().mockReturnValue(undefined) } as any,
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
  defaultModel: 'claude-sonnet-4-5-20250929' as const,
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

  // Trace (v2): S3, Sec 3b — deleteThreadBotMessages IS called for mid-thread (dispatch cleanup)
  it('midThread_deletesDispatchClutter: deletes bot messages for mid-thread mentions (v2)', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    expect(mockSlackApi.deleteThreadBotMessages).toHaveBeenCalledWith('C123', '1711234567.000100');
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
      (call: any[]) => call[2]?.threadTs === '1711234567.000100',
    );

    // Block Kit: permalink is in blocks (accessory button URL), not in fallback text
    const hasPermalinkMessage = originalThreadMessages.some((call: any[]) => {
      const blocksJson = JSON.stringify(call[2]?.blocks ?? []);
      return (
        blocksJson.includes(newThreadPermalink) || (typeof call[1] === 'string' && call[1].includes(newThreadPermalink))
      );
    });

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
      (call: any[]) => call[2]?.threadTs === '1711234567.000100',
    );

    const hasRetentionMessage = originalThreadMessages.some(
      (call: any[]) => typeof call[1] === 'string' && (call[1].includes('— 시작') || call[1].includes('📋')),
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

    await expect(sessionInitializer.initialize(event as any, '/test/dir')).resolves.toBeDefined();

    expect(mockSlackApi.deleteThreadBotMessages).toHaveBeenCalledWith('C123', '1711234567.000100');
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
        (call[1].includes('— 시작') || call[1].includes('📋')),
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

// ============================================================
// Issue #64 Fix v2 — Scenarios 3-5 (delete-then-retain ordering)
// Trace: docs/issue64-midthread-fix-v2/trace.md
// ============================================================

// ============================================================
// Scenario 3 (v2) — Mid-thread: delete-then-retain ordering
// ============================================================
describe('Scenario 3 (v2): mid-thread delete-then-retain ordering', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  // Trace: S3, Sec 3b — deleteThreadBotMessages ALWAYS called (even for mid-thread)
  it('midThread_alwaysCallsDelete: deleteThreadBotMessages called for mid-thread mentions', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // v2: deleteThreadBotMessages is NOW called for mid-thread (dispatch cleanup)
    expect(mockSlackApi.deleteThreadBotMessages).toHaveBeenCalledWith('C123', '1711234567.000100');
  });

  // Trace: S3, Sec 3b — delete THEN post ordering
  it('midThread_deletesBeforeRetention: delete happens before retention message', async () => {
    const callOrder: string[] = [];

    mockSlackApi.deleteThreadBotMessages.mockImplementation(async () => {
      callOrder.push('delete');
    });

    const originalPostMessage = mockSlackApi.postMessage;
    mockSlackApi.postMessage.mockImplementation(async (...args: any[]) => {
      const text = args[1];
      if (typeof text === 'string' && (text.includes('📋') || text.includes('— 시작'))) {
        callOrder.push('retention');
      }
      return { ts: 'msg123' };
    });

    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // Contract: delete MUST happen before retention post
    const deleteIdx = callOrder.indexOf('delete');
    const retentionIdx = callOrder.indexOf('retention');

    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(retentionIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(retentionIdx);
  });

  // Trace: S3, Sec 4 — retention message posted in original thread after delete
  it('midThread_retentionPostedAfterDelete: retention message survives deletion', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // deleteThreadBotMessages was called first
    expect(mockSlackApi.deleteThreadBotMessages).toHaveBeenCalled();

    // Retention message was posted to original thread
    const retentionMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) =>
        call[2]?.threadTs === '1711234567.000100' &&
        typeof call[1] === 'string' &&
        (call[1].includes('— 시작') || call[1].includes('📋')),
    );
    expect(retentionMessages).toHaveLength(1);
  });

  // Trace: S3, Sec 5 — null permalink graceful handling
  it('midThread_permalinkNull_graceful: posts retention without link when permalink is null', async () => {
    mockSlackApi.getPermalink.mockResolvedValue(null);

    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // Should still post retention (without permalink)
    const retentionMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) =>
        call[2]?.threadTs === '1711234567.000100' &&
        typeof call[1] === 'string' &&
        (call[1].includes('— 시작') || call[1].includes('📋')),
    );
    expect(retentionMessages).toHaveLength(1);

    // Block Kit: when permalink is null, no button accessory should be present
    const blocksJson = JSON.stringify(retentionMessages[0][2]?.blocks ?? []);
    expect(blocksJson).not.toContain('source_open_thread');
  });
});

// ============================================================
// Scenario 4 (v2) — Top-level: delete + redirect preserved
// ============================================================
describe('Scenario 4 (v2): top-level delete + redirect preserved', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  // Trace: S4, Sec 3b — delete + redirect
  it('topLevel_deletesAndRedirects: deletes bot messages and posts redirect', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Hello!',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // Delete is called
    expect(mockSlackApi.deleteThreadBotMessages).toHaveBeenCalledWith('C123', 'thread123');

    // Redirect message "🧵" is posted to original thread
    const redirectMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) => call[2]?.threadTs === 'thread123' && typeof call[1] === 'string' && call[1].includes('🧵'),
    );
    expect(redirectMessages.length).toBeGreaterThanOrEqual(1);
  });

  // Trace: S4, Sec 3b — no 📋 message for top-level
  it('topLevel_noRetentionMessage: does not post retention message', async () => {
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
        (call[1].includes('— 시작') || call[1].includes('📋')),
    );
    expect(retentionMessages).toHaveLength(0);
  });

  // Trace: S4, Sec 3a — sourceThread undefined
  it('topLevel_noSourceThread: sourceThread is not set', async () => {
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

// ============================================================
// Scenario 5 (v2) — Mid-thread: retention message has permalink
// ============================================================
describe('Scenario 5 (v2): mid-thread retention includes permalink', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  // Trace: S5, Sec 3b — permalink in retention message
  it('midThread_retentionIncludesPermalink: retention message contains new thread permalink', async () => {
    const permalink = 'https://workspace.slack.com/archives/C123/p1739000000001000';
    mockSlackApi.getPermalink.mockResolvedValue(permalink);

    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    const retentionMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) =>
        call[2]?.threadTs === '1711234567.000100' &&
        typeof call[1] === 'string' &&
        (call[1].includes('— 시작') || call[1].includes('📋')),
    );

    expect(retentionMessages).toHaveLength(1);
    // Block Kit: permalink is in blocks accessory button, not in fallback text
    const blocksJson = JSON.stringify(retentionMessages[0][2]?.blocks ?? []);
    expect(blocksJson).toContain(permalink);
  });
});
