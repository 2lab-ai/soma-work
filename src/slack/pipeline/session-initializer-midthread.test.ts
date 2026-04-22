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
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.7'),
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
  AVAILABLE_MODELS: [
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-7[1m]',
    'claude-opus-4-6[1m]',
  ],
  DEFAULT_MODEL: 'claude-opus-4-7',
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
    // Distinct ts per call tags the sender site so we can prove only
    // init-clutter (conversation link / dispatch status) is deleted — model replies
    // (which would have their own ts) must never be touched. See Issue #516.
    postMessage: vi.fn().mockImplementation(async (_channel: string, text: string) => {
      if (typeof text === 'string') {
        if (text.includes('대화 기록 보기')) return { ts: 'conv-link-ts' };
        if (text.includes('_Dispatching...')) return { ts: 'dispatch-ts' };
        if (text.includes('🧵')) return { ts: 'redirect-ts' };
      }
      return { ts: 'other-bot-ts' };
    }),
    getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p1739000000001000'),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    // deleteMessage replaces the old wholesale deleteThreadBotMessages: we now
    // only delete the exact ts we posted during init.
    deleteMessage: vi.fn().mockResolvedValue(undefined),
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
// Scenario 1 — Mid-thread: unified redirect UX (no more retention 📋)
// Fix: thread-originating mentions now get same redirect 🧵 as channel mentions.
// Previously, accidental thread mentions showed a confusing retention card.
// ============================================================
describe('Scenario 1: mid-thread mention — unified redirect UX', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  it('midThread_deletesDispatchClutter: deletes tracked init clutter for mid-thread mentions', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // New behavior: only tracked init-clutter ts is deleted individually,
    // never the wholesale "all bot messages in thread" delete (Issue #516).
    expect(mockSlackApi.deleteMessage).toHaveBeenCalledWith('C123', 'conv-link-ts');
    expect(mockSlackApi.deleteThreadBotMessages).not.toHaveBeenCalled();
  });

  it('midThread_postsRedirect: posts redirect 🧵 message (not retention 📋)', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    const sourceThreadMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) => call[2]?.threadTs === '1711234567.000100',
    );

    // Should have redirect 🧵, not retention 📋
    const hasRedirect = sourceThreadMessages.some(
      (call: any[]) => typeof call[1] === 'string' && call[1].includes('🧵'),
    );
    const hasRetention = sourceThreadMessages.some(
      (call: any[]) => typeof call[1] === 'string' && (call[1].includes('— 시작') || call[1].includes('📋')),
    );

    expect(hasRedirect).toBe(true);
    expect(hasRetention).toBe(false);
  });

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

    expect(mockSlackApi.deleteMessage).toHaveBeenCalledWith('C123', 'conv-link-ts');
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

  it('topLevel_deletesBotMessages: deletes tracked init clutter when no thread_ts', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Hello!',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    expect(mockSlackApi.deleteMessage).toHaveBeenCalledWith('C123', 'conv-link-ts');
    expect(mockSlackApi.deleteThreadBotMessages).not.toHaveBeenCalled();
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
// Scenario 3 (v2) — Mid-thread: delete-then-redirect ordering
// ============================================================
describe('Scenario 3 (v2): mid-thread delete-then-redirect ordering', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  it('midThread_alwaysCallsDelete: deleteMessage called for mid-thread mentions', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    expect(mockSlackApi.deleteMessage).toHaveBeenCalledWith('C123', 'conv-link-ts');
    expect(mockSlackApi.deleteThreadBotMessages).not.toHaveBeenCalled();
  });

  it('midThread_deletesBeforeRedirect: delete happens before redirect message', async () => {
    const callOrder: string[] = [];

    mockSlackApi.deleteMessage.mockImplementation(async () => {
      callOrder.push('delete');
    });

    mockSlackApi.postMessage.mockImplementation(async (...args: any[]) => {
      const text = args[1];
      if (typeof text === 'string') {
        if (text.includes('🧵')) {
          callOrder.push('redirect');
          return { ts: 'redirect-ts' };
        }
        if (text.includes('대화 기록 보기')) return { ts: 'conv-link-ts' };
        if (text.includes('_Dispatching...')) return { ts: 'dispatch-ts' };
      }
      return { ts: 'other-bot-ts' };
    });

    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // Contract: delete MUST happen before redirect post
    const deleteIdx = callOrder.indexOf('delete');
    const redirectIdx = callOrder.indexOf('redirect');

    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(redirectIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(redirectIdx);
  });

  it('midThread_redirectPostedAfterDelete: redirect message survives deletion', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    expect(mockSlackApi.deleteMessage).toHaveBeenCalled();
    // The redirect 🧵 ts must NOT be deleted — it was posted AFTER cleanup
    // and is not part of the tracked init-clutter set.
    expect(mockSlackApi.deleteMessage).not.toHaveBeenCalledWith('C123', 'redirect-ts');

    // Redirect 🧵 message posted to source thread (not retention 📋)
    const redirectMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) =>
        call[2]?.threadTs === '1711234567.000100' && typeof call[1] === 'string' && call[1].includes('🧵'),
    );
    expect(redirectMessages.length).toBeGreaterThanOrEqual(1);
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
  it('topLevel_deletesAndRedirects: deletes tracked init clutter and posts redirect', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Hello!',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // Delete is called for tracked init clutter only (Issue #516)
    expect(mockSlackApi.deleteMessage).toHaveBeenCalledWith('C123', 'conv-link-ts');
    expect(mockSlackApi.deleteThreadBotMessages).not.toHaveBeenCalled();

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
// Scenario 6 (Issue #516) — model replies survive mid-thread migration
// Fix: only tracked init clutter (conversation link / dispatch status) is
// deleted on migration; model replies that pre-exist in the source thread
// must NEVER be touched by cleanup.
// ============================================================
describe('Scenario 6 (#516): model replies preserved across mid-thread migration', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  it('midThread_doesNotDeletePreexistingModelReplies', async () => {
    // Pre-seed the session with a model-reply ts that must NOT be deleted.
    // (In production, model replies are posted during the prior turn and
    // never added to sourceThreadCleanupTs.)
    const sessionWithHistory: any = {
      sessionId: 'session-456',
      owner: 'U123',
      ownerName: 'Test User',
      channel: 'C123',
      threadTs: '1711234567.000100',
      conversationId: undefined,
      isOnboarding: false,
      workflow: undefined,
      sourceThreadCleanupTs: undefined,
    };
    mockClaudeHandler.createSession.mockReturnValue(sessionWithHistory);

    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // Only tracked init-clutter ts may be deleted.
    const deletedTs = mockSlackApi.deleteMessage.mock.calls.map((call: any[]) => call[1]);
    for (const ts of deletedTs) {
      // Allowed: conv-link-ts, dispatch-ts. Anything else is a regression.
      expect(['conv-link-ts', 'dispatch-ts']).toContain(ts);
    }

    // A pretend prior model-reply ts — proves we never do wholesale deletion.
    expect(mockSlackApi.deleteMessage).not.toHaveBeenCalledWith('C123', 'model-reply-ts-from-prior-turn');
    // And the old broad-sweep API must remain unused.
    expect(mockSlackApi.deleteThreadBotMessages).not.toHaveBeenCalled();
  });
});

// ============================================================
// Scenario 5 (v2) — Mid-thread: unified redirect (no retention)
// ============================================================
describe('Scenario 5 (v2): mid-thread unified redirect', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(ACCEPTED_USER_SETTINGS);
    mockClaudeHandler.getSession.mockReturnValue(null);
    mockClaudeHandler.needsDispatch.mockReturnValue(true);
  });

  it('midThread_noRetention: does not post retention 📋 card for thread-originating mentions', async () => {
    const event = {
      user: 'U_EXISTING_USER',
      channel: 'C123',
      thread_ts: '1711234567.000100',
      ts: '1711234599.000200',
      text: '@zhugeliang 여기 내용 정리해줘',
    };

    await sessionInitializer.initialize(event as any, '/test/dir');

    // No retention 📋 messages in source thread
    const retentionMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) =>
        call[2]?.threadTs === '1711234567.000100' &&
        typeof call[1] === 'string' &&
        (call[1].includes('— 시작') || call[1].includes('📋')),
    );
    expect(retentionMessages).toHaveLength(0);

    // Instead, redirect 🧵 is posted
    const redirectMessages = mockSlackApi.postMessage.mock.calls.filter(
      (call: any[]) =>
        call[2]?.threadTs === '1711234567.000100' && typeof call[1] === 'string' && call[1].includes('🧵'),
    );
    expect(redirectMessages.length).toBeGreaterThanOrEqual(1);
  });
});
