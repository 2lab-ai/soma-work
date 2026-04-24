/**
 * SessionInitializer — #689 P4 Part 2/2 dispatch B4 gate (behavioural).
 *
 * Locks the gating behaviour of the dispatch flow's two native-spinner writers:
 *   - `assistantStatusManager.setStatus(channel, threadTs, 'is analyzing your request...')`
 *   - `assistantStatusManager.setTitle(channel, threadTs, <title>)`
 *
 * At effective PHASE>=4 (raw PHASE=4 + manager enabled) TurnSurface owns the
 * native B4 surface, so both calls MUST be suppressed. At PHASE<4 OR a clamped
 * PHASE=4 (manager disabled → fall back to PHASE=3 chip), both calls MUST fire.
 *
 * Drives the real `SessionInitializer.initialize()` → dispatch path with spied
 * mocks instead of mirroring the gate locally — a refactor that moves the gate
 * inside `AssistantStatusManager` (or anywhere else) cannot silently regress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn().mockReturnValue({
      userId: 'U123',
      accepted: true,
      defaultDirectory: '',
      bypassPermission: false,
      persona: 'default',
      defaultModel: 'claude-opus-4-7',
      lastUpdated: new Date().toISOString(),
    }),
    createPendingUser: vi.fn(),
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.7'),
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
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
  checkRepoChannelMatch: vi.fn().mockReturnValue({
    correct: true,
    suggestedChannels: [],
    reason: 'matched',
  }),
  getChannel: vi.fn().mockReturnValue({
    id: 'C123',
    name: 'workspace-soma-work',
    purpose: '',
    topic: '',
    repos: ['acme/repo'],
    joinedAt: Date.now(),
  }),
  getAllChannels: vi.fn().mockReturnValue([]),
  registerChannel: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../dispatch-service', () => ({
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({
      workflow: 'pr-review',
      title: 'PR Review',
      links: {},
    }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

import { config } from '../../config';
import { getDispatchService } from '../../dispatch-service';
import { __resetClampEmitted } from './effective-phase';
import { SessionInitializer } from './session-initializer';

describe('SessionInitializer — #689 dispatch B4 gate (behavioural)', () => {
  let sessionInitializer: SessionInitializer;
  let mockClaudeHandler: any;
  let mockSlackApi: any;
  let mockMessageValidator: any;
  let mockReactionManager: any;
  let mockContextWindowManager: any;
  let mockRequestCoordinator: any;
  let mockAssistantStatusManager: any;
  const originalPhase = config.ui.fiveBlockPhase;

  function buildEvent() {
    return {
      user: 'U123',
      channel: 'C123',
      thread_ts: undefined,
      ts: 'thread123',
      text: 'Review PR https://github.com/acme/repo/pull/1',
    };
  }

  function makeStatusManager(enabled: boolean) {
    return {
      isEnabled: vi.fn().mockReturnValue(enabled),
      setStatus: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      bumpEpoch: vi.fn().mockReturnValue(1),
      getToolStatusText: vi.fn().mockReturnValue('running...'),
      buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
      registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockClaudeHandler = {
      getSessionKey: vi.fn().mockReturnValue('C123:thread123'),
      getSession: vi.fn().mockReturnValue(null),
      createSession: vi.fn().mockReturnValue({
        ownerId: 'U123',
        ownerName: 'Test User',
        userId: 'U123',
        channelId: 'C123',
        threadTs: 'thread123',
        isActive: true,
        lastActivity: new Date(),
        activityState: 'idle',
      }),
      isSleeping: vi.fn().mockReturnValue(false),
      wakeFromSleep: vi.fn(),
      needsDispatch: vi.fn().mockReturnValue(true),
      transitionToMain: vi.fn(),
      setSessionLinks: vi.fn(),
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
  });

  afterEach(() => {
    config.ui.fiveBlockPhase = originalPhase;
    // Reset the module-level clamp-once flag so the disabled-mgr clamp test
    // doesn't leak the "already emitted" state into other tests.
    __resetClampEmitted();
  });

  function buildInitializer() {
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
  }

  it('PHASE=3 + enabled: setStatus + setTitle each fire once (legacy path)', async () => {
    config.ui.fiveBlockPhase = 3;
    mockAssistantStatusManager = makeStatusManager(true);
    buildInitializer();

    await sessionInitializer.initialize(buildEvent() as any, '/test/dir');

    expect(mockAssistantStatusManager.setStatus).toHaveBeenCalledTimes(1);
    expect(mockAssistantStatusManager.setStatus).toHaveBeenCalledWith(
      'C123',
      'thread123',
      'is analyzing your request...',
    );
    expect(mockAssistantStatusManager.setTitle).toHaveBeenCalledTimes(1);
    expect(mockAssistantStatusManager.setTitle).toHaveBeenCalledWith('C123', 'thread123', 'PR Review');
  });

  it('PHASE=4 + enabled: setStatus + setTitle are suppressed (TurnSurface owns)', async () => {
    config.ui.fiveBlockPhase = 4;
    mockAssistantStatusManager = makeStatusManager(true);
    buildInitializer();

    await sessionInitializer.initialize(buildEvent() as any, '/test/dir');

    expect(mockAssistantStatusManager.setStatus).not.toHaveBeenCalled();
    expect(mockAssistantStatusManager.setTitle).not.toHaveBeenCalled();
  });

  it('PHASE=4 + disabled (clamped to 3): setStatus + setTitle each fire once (graceful fallback)', async () => {
    config.ui.fiveBlockPhase = 4;
    mockAssistantStatusManager = makeStatusManager(false);
    buildInitializer();

    await sessionInitializer.initialize(buildEvent() as any, '/test/dir');

    expect(mockAssistantStatusManager.setStatus).toHaveBeenCalledTimes(1);
    expect(mockAssistantStatusManager.setTitle).toHaveBeenCalledTimes(1);
  });

  // #700 review P2 — behavioural coverage of the dispatch-error clearStatus
  // PHASE>=4 gate. Reject `dispatchService.dispatch` to drive the catch
  // branch at session-initializer.ts:743 and lock the expected behaviour on
  // both sides of the `shouldRunLegacyB4Path` gate. Protects against the
  // subtle regression where a refactor drops the gate and every PHASE>=4
  // dispatch failure silently nukes a just-set TurnSurface spinner.
  describe('dispatch-error clearStatus PHASE gate (#700 P2)', () => {
    it('PHASE=4 + enabled: dispatch rejection does NOT call clearStatus (TurnSurface owns)', async () => {
      config.ui.fiveBlockPhase = 4;
      mockAssistantStatusManager = makeStatusManager(true);
      // Force dispatch to fail so the catch branch runs.
      const service = vi.mocked(getDispatchService)();
      vi.mocked(service.dispatch).mockRejectedValueOnce(new Error('dispatch blew up'));
      buildInitializer();

      await sessionInitializer.initialize(buildEvent() as any, '/test/dir');

      expect(mockAssistantStatusManager.clearStatus).not.toHaveBeenCalled();
    });

    it('PHASE=3 + enabled: dispatch rejection calls clearStatus once with expectedEpoch', async () => {
      config.ui.fiveBlockPhase = 3;
      mockAssistantStatusManager = makeStatusManager(true);
      // bumpEpoch returns 1 (makeStatusManager default) so we assert the
      // same value gets forwarded as expectedEpoch — this is the #688
      // guarantee the dispatch flow relies on.
      const service = vi.mocked(getDispatchService)();
      vi.mocked(service.dispatch).mockRejectedValueOnce(new Error('dispatch blew up'));
      buildInitializer();

      await sessionInitializer.initialize(buildEvent() as any, '/test/dir');

      expect(mockAssistantStatusManager.clearStatus).toHaveBeenCalledTimes(1);
      expect(mockAssistantStatusManager.clearStatus).toHaveBeenCalledWith('C123', 'thread123', {
        expectedEpoch: 1,
      });
    });
  });

  // #700 round-3 review finding #7 — `runDispatch()` is the alternate entry
  // (after /new, /renew, z-handoff transitions). It routes to the same
  // `dispatchWorkflow` private method that `initialize()` does, so the
  // PHASE>=4 gate must hold here too. A new spinner write in
  // `runDispatch`'s force-workflow branch would slip past `initialize`
  // coverage — this test locks the dispatch-path entry separately.
  describe('runDispatch PHASE gate (#700 round-3 #7)', () => {
    beforeEach(() => {
      // needsDispatch is true + no forceWorkflow → runDispatch routes to
      // dispatchWorkflow (the gate lives there).
      mockClaudeHandler.needsDispatch.mockReturnValue(true);
    });

    it('PHASE=4 + enabled: runDispatch does NOT call setStatus or setTitle', async () => {
      config.ui.fiveBlockPhase = 4;
      mockAssistantStatusManager = makeStatusManager(true);
      buildInitializer();

      await sessionInitializer.runDispatch('C123', 'thread123', 'Review PR https://github.com/acme/repo/pull/1');

      expect(mockAssistantStatusManager.setStatus).not.toHaveBeenCalled();
      expect(mockAssistantStatusManager.setTitle).not.toHaveBeenCalled();
    });

    it('PHASE=3 + enabled: runDispatch fires setStatus + setTitle (legacy path)', async () => {
      config.ui.fiveBlockPhase = 3;
      mockAssistantStatusManager = makeStatusManager(true);
      buildInitializer();

      await sessionInitializer.runDispatch('C123', 'thread123', 'Review PR https://github.com/acme/repo/pull/1');

      expect(mockAssistantStatusManager.setStatus).toHaveBeenCalledTimes(1);
      expect(mockAssistantStatusManager.setStatus).toHaveBeenCalledWith(
        'C123',
        'thread123',
        'is analyzing your request...',
      );
      expect(mockAssistantStatusManager.setTitle).toHaveBeenCalledTimes(1);
    });
  });
});
