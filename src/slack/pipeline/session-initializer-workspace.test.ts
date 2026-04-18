import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    reason: 'match',
  }),
  getChannel: vi.fn().mockReturnValue(null),
  getAllChannels: vi.fn().mockReturnValue([]),
}));

vi.mock('../../dispatch-service', () => ({
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({
      workflow: 'default',
      title: 'Test',
    }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

import { SessionInitializer } from './session-initializer';

describe('SessionInitializer — workspace wiring integration', () => {
  let sessionInitializer: SessionInitializer;
  let mockClaudeHandler: any;
  let mockCreateSessionBaseDir: ReturnType<typeof vi.fn>;
  let sessionRef: any;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionRef = undefined;

    mockCreateSessionBaseDir = vi.fn().mockReturnValue('/tmp/U123/session_1711111111111_0');

    mockClaudeHandler = {
      getSessionKey: vi.fn().mockReturnValue('C001:thread001'),
      getSession: vi.fn().mockReturnValue(null), // No existing session → new session
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
      transitionToMain: vi.fn(),
      setSessionLinks: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(false),
      updateInitiator: vi.fn(),
      terminateSession: vi.fn(),
      addSourceWorkingDir: vi.fn().mockReturnValue(true),
      setActivityState: vi.fn(),
    };

    const mockSlackApi = {
      getUserName: vi.fn().mockResolvedValue('Test User'),
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg123' }),
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C001/p1'),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph123' }),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
    };

    const mockReactionManager = {
      setOriginalMessage: vi.fn(),
      clearSessionLifecycleEmojis: vi.fn().mockResolvedValue(undefined),
      getCurrentReaction: vi.fn().mockReturnValue(null),
      cleanup: vi.fn(),
    };

    sessionInitializer = new SessionInitializer({
      claudeHandler: mockClaudeHandler,
      slackApi: mockSlackApi as any,
      messageValidator: {
        validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: '/tmp/U123' }),
      } as any,
      workingDirManager: { createSessionBaseDir: mockCreateSessionBaseDir } as any,
      reactionManager: mockReactionManager as any,
      contextWindowManager: { setOriginalMessage: vi.fn().mockResolvedValue(undefined) } as any,
      requestCoordinator: {
        isRequestActive: vi.fn().mockReturnValue(false),
        setController: vi.fn(),
        abortSession: vi.fn(),
      } as any,
      assistantStatusManager: {
        setStatus: vi.fn().mockResolvedValue(undefined),
        setTitle: vi.fn().mockResolvedValue(undefined),
      } as any,
    });
  });

  it('calls createSessionBaseDir with user slackId on new session', async () => {
    const event = {
      user: 'U123',
      channel: 'C001',
      thread_ts: undefined,
      ts: 'thread001',
      text: 'hello',
    };

    await sessionInitializer.initialize(event as any, '/tmp/U123');

    expect(mockCreateSessionBaseDir).toHaveBeenCalledWith('U123');
  });

  it('sets session.sessionWorkingDir to createSessionBaseDir result', async () => {
    const event = {
      user: 'U123',
      channel: 'C001',
      thread_ts: undefined,
      ts: 'thread001',
      text: 'hello',
    };

    await sessionInitializer.initialize(event as any, '/tmp/U123');

    expect(sessionRef.sessionWorkingDir).toBe('/tmp/U123/session_1711111111111_0');
  });

  it('registers session dir in sourceWorkingDirs for cleanup', async () => {
    const event = {
      user: 'U123',
      channel: 'C001',
      thread_ts: undefined,
      ts: 'thread001',
      text: 'hello',
    };

    await sessionInitializer.initialize(event as any, '/tmp/U123');

    expect(mockClaudeHandler.addSourceWorkingDir).toHaveBeenCalledWith(
      'C001',
      'thread001',
      '/tmp/U123/session_1711111111111_0',
    );
  });

  it('returns effectiveWorkingDir as session-unique path', async () => {
    const event = {
      user: 'U123',
      channel: 'C001',
      thread_ts: undefined,
      ts: 'thread001',
      text: 'hello',
    };

    const result = await sessionInitializer.initialize(event as any, '/tmp/U123');

    expect(result?.workingDirectory).toBe('/tmp/U123/session_1711111111111_0');
  });

  it('falls back to shared user dir when createSessionBaseDir returns undefined', async () => {
    mockCreateSessionBaseDir.mockReturnValue(undefined);

    const event = {
      user: 'U123',
      channel: 'C001',
      thread_ts: undefined,
      ts: 'thread001',
      text: 'hello',
    };

    const result = await sessionInitializer.initialize(event as any, '/tmp/U123');

    // Should fall back to the shared user dir, not session-unique
    expect(result?.workingDirectory).toBe('/tmp/U123');
    // Should NOT call addSourceWorkingDir since there's nothing to register
    expect(mockClaudeHandler.addSourceWorkingDir).not.toHaveBeenCalled();
  });

  it('does not call createSessionBaseDir for existing sessions', async () => {
    // Return an existing session
    mockClaudeHandler.getSession.mockReturnValue({
      ownerId: 'U123',
      ownerName: 'Test User',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      state: 'MAIN',
      sessionWorkingDir: '/tmp/U123/session_existing',
    });

    const event = {
      user: 'U123',
      channel: 'C001',
      thread_ts: 'thread001',
      ts: 'msg002',
      text: 'hello',
    };

    await sessionInitializer.initialize(event as any, '/tmp/U123');

    // createSessionBaseDir should NOT be called for existing sessions
    expect(mockCreateSessionBaseDir).not.toHaveBeenCalled();
  });

  // ===== Bug: CWD ENOENT after sleep (PR #362) =====

  it('recreates sessionWorkingDir when it has been deleted (e.g. OS /tmp cleanup after sleep)', async () => {
    const fs = await import('node:fs');
    // Use a path that definitely does NOT exist on disk
    const deletedDir = '/tmp/U123/session_DELETED_99999999_0000';
    // Ensure it really doesn't exist
    try {
      fs.rmSync(deletedDir, { recursive: true, force: true });
    } catch {}

    mockClaudeHandler.getSession.mockReturnValue({
      ownerId: 'U123',
      ownerName: 'Test User',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      state: 'MAIN',
      sessionWorkingDir: deletedDir,
    });

    const event = {
      user: 'U123',
      channel: 'C001',
      thread_ts: 'thread001',
      ts: 'msg002',
      text: 'hello after sleep',
    };

    const result = await sessionInitializer.initialize(event as any, '/tmp/U123');

    // The returned workingDirectory must exist on disk (to prevent spawn ENOENT)
    expect(fs.existsSync(result?.workingDirectory)).toBe(true);

    // Cleanup
    try {
      fs.rmSync(deletedDir, { recursive: true, force: true });
    } catch {}
  });

  it('falls back to user dir when sessionWorkingDir cannot be recreated', async () => {
    // Use an impossible path that cannot be created
    const impossibleDir = '/dev/null/impossible_session_dir';

    mockClaudeHandler.getSession.mockReturnValue({
      ownerId: 'U123',
      ownerName: 'Test User',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      state: 'MAIN',
      sessionWorkingDir: impossibleDir,
    });

    const event = {
      user: 'U123',
      channel: 'C001',
      thread_ts: 'thread001',
      ts: 'msg002',
      text: 'hello after sleep',
    };

    const result = await sessionInitializer.initialize(event as any, '/tmp/U123');

    // Should fall back to user dir, not use the impossible path
    expect(result?.workingDirectory).toBe('/tmp/U123');
  });
});
