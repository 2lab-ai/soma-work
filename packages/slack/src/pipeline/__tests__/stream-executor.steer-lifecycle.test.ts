/**
 * The steering join key must be the SAME string on both sides.
 *
 * The host queues a follow-up under `sessionKey` and later asks "did the turn
 * consume it?"; the backend answers with `steer_lifecycle { uuid, phase }`. That
 * answer is only usable if (a) the handler keyed its steering registry by the
 * sessionKey the host uses — hence `sessionKey` as the 6th argument of
 * `streamAgentEvents` — and (b) the executor forwards each lifecycle frame to
 * the host hook stamped with that same key.
 *
 * Deps are the minimal fake surface `execute()` touches (same shape as
 * `src/slack/pipeline/__tests__/stream-executor.followup-epoch.test.ts`), driven
 * against the SOURCE class here rather than the built entry point.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_DETAIL } from '../../output-flags';
import { StreamExecutor, setStreamExecutorProviders } from '../stream-executor';

/**
 * The module ships inert defaults for every injected provider, but its
 * user-settings default is a narrower object than `execute()` calls (no
 * `shouldRefreshSlackIdentity`). Inject the stub the identity refresh path
 * needs; everything else stays on the inert defaults.
 */
setStreamExecutorProviders({
  userSettingsStore: {
    getUserSessionTheme: () => 'D',
    getUserEmail: () => 'user@example.com',
    setUserEmail: () => {},
    ensureUserExists: () => {},
    setUserSlackDisplayName: () => {},
    shouldRefreshSlackIdentity: () => false,
    getUserJiraAccountId: () => undefined,
    getUserJiraName: () => undefined,
    getUserBypassPermission: () => false,
    getUserDefaultLogVerbosity: () => 'detail',
    getUserLogVerbosityFlags: () => 0,
    getUserSettings: () => undefined,
    getUserPersona: () => 'default',
    getUserDefaultModel: () => 'claude-opus-4-6',
    setUserDefaultModel: () => {},
    getUserDefaultEffort: () => 'high',
    getUserShowThinking: () => true,
    getUserRating: () => 5,
    setUserRating: () => {},
    consumePendingRatingChange: () => null,
    setPendingRatingChange: () => {},
  } as any,
});

const SESSION_KEY = 'C42:thread42';

function createDeps(streamFn: () => AsyncIterable<any>, overrides: Record<string, unknown> = {}): any {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      streamAgentEvents: vi.fn().mockImplementation(streamFn),
      getSessionRegistry: vi.fn().mockReturnValue({
        beginTurn: vi.fn(),
        endTurn: vi.fn(),
        broadcastSessionUpdate: vi.fn(),
        getActivityState: vi.fn().mockReturnValue('idle'),
      }),
    },
    fileHandler: {
      formatFilePrompt: vi.fn().mockResolvedValue(''),
      cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
    },
    toolEventProcessor: {
      handleToolUse: vi.fn().mockResolvedValue(undefined),
      handleToolResult: vi.fn().mockResolvedValue(undefined),
      handleAgentTaskLifecycle: vi.fn(),
      setReactionManager: vi.fn(),
      setToolResultSink: vi.fn(),
      getLiveBackgroundWork: vi.fn().mockReturnValue({ count: 0, labels: [], signature: '' }),
      cleanup: vi.fn(),
    },
    statusReporter: {
      updateStatusDirect: vi.fn().mockResolvedValue(undefined),
      getStatusEmoji: vi.fn().mockReturnValue('thinking_face'),
      cleanup: vi.fn(),
    },
    reactionManager: {
      updateReaction: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    },
    contextWindowManager: {
      handlePromptTooLong: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
      calculateRemainingPercent: vi.fn().mockReturnValue(100),
      updateContextEmoji: vi.fn().mockResolvedValue(undefined),
    },
    toolTracker: {
      scheduleCleanup: vi.fn(),
      trackToolUse: vi.fn(),
      getToolName: vi.fn(),
      trackMcpCall: vi.fn(),
      getMcpCallId: vi.fn(),
      removeMcpCallId: vi.fn(),
      getActiveMcpCallIds: vi.fn().mockReturnValue([]),
    },
    todoDisplayManager: {
      cleanupSession: vi.fn(),
      cleanup: vi.fn(),
      handleTodoUpdate: vi.fn().mockResolvedValue(undefined),
      setRenderRequestCallback: vi.fn(),
      setPlanRenderCallback: vi.fn(),
    },
    actionHandlers: {},
    requestCoordinator: {
      removeController: vi.fn(),
      touchSession: vi.fn(),
    },
    slackApi: {
      getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
      getClient: vi.fn().mockReturnValue({}),
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    },
    turnNotifier: { notify: vi.fn().mockResolvedValue(undefined) },
    assistantStatusManager: {
      isEnabled: vi.fn().mockReturnValue(true),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      getToolStatusText: vi.fn().mockReturnValue('is reading files...'),
      bumpEpoch: vi.fn().mockReturnValue(7),
      buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
      registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      setTitle: vi.fn().mockResolvedValue(undefined),
    },
    threadPanel: {
      beginTurn: vi.fn().mockResolvedValue(undefined),
      endTurn: vi.fn().mockResolvedValue({ snapshotResolved: true }),
      failTurn: vi.fn().mockResolvedValue(undefined),
      isTurnSurfaceActive: vi.fn().mockReturnValue(true),
      appendText: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn().mockResolvedValue(undefined),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      attachChoice: vi.fn().mockResolvedValue(undefined),
      finalizeOnEndTurn: vi.fn().mockResolvedValue(undefined),
      renderTasks: vi.fn().mockResolvedValue(false),
      updateHeader: vi.fn().mockResolvedValue(undefined),
      clearChoice: vi.fn().mockResolvedValue(undefined),
      isCompletionMarkerActive: vi.fn().mockReturnValue(false),
    },
    ...overrides,
  };
}

function createSession(): any {
  return {
    sessionId: 'sess_steer',
    ownerId: 'U_TEST',
    title: 'steering turn',
    logVerbosity: LOG_DETAIL,
    usage: {},
    terminated: false,
  };
}

function createParams(session: any, abortController: AbortController): any {
  return {
    session,
    sessionKey: SESSION_KEY,
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController,
    processedFiles: [],
    text: '원래 요청',
    channel: 'C42',
    threadTs: 'thread42',
    user: 'U_TEST',
    isUserInput: true,
    say: vi.fn().mockResolvedValue({ ts: 'm' }),
  };
}

/** Let the fire-and-forget liveness writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function steerStream(...events: any[]) {
  return () =>
    (async function* () {
      for (const event of events) yield event;
      yield { type: 'result', stopReason: 'end_turn' };
    })();
}

describe('StreamExecutor — steering join key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes sessionKey as the 6th argument of streamAgentEvents', async () => {
    const deps = createDeps(steerStream({ type: 'assistant_delta', text: '진행' }));
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(createSession(), new AbortController()));
    await settle();

    expect(deps.claudeHandler.streamAgentEvents).toHaveBeenCalledTimes(1);
    const args = deps.claudeHandler.streamAgentEvents.mock.calls[0];
    // The handler keys its steering registry by this argument; a missing 6th
    // argument silently degrades to an unkeyed (unjoinable) registry.
    expect(args[5]).toBe(SESSION_KEY);
  });

  it('forwards each steer_lifecycle frame to the host hook with {sessionKey, uuid, phase}', async () => {
    const onSteerLifecycle = vi.fn();
    const deps = createDeps(
      steerStream(
        { type: 'steer_lifecycle', uuid: 'u-1', phase: 'started' },
        { type: 'assistant_delta', text: '반영했습니다' },
        { type: 'steer_lifecycle', uuid: 'u-2', phase: 'discarded' },
      ),
      { onSteerLifecycle },
    );
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(createSession(), new AbortController()));
    await settle();

    expect(onSteerLifecycle.mock.calls.map((c: any[]) => c[0])).toEqual([
      { sessionKey: SESSION_KEY, uuid: 'u-1', phase: 'started' },
      { sessionKey: SESSION_KEY, uuid: 'u-2', phase: 'discarded' },
    ]);
  });

  it('runs the turn normally when no hook is wired', async () => {
    const deps = createDeps(steerStream({ type: 'steer_lifecycle', uuid: 'u-1', phase: 'observed' }));
    const executor = new StreamExecutor(deps);

    const result = await executor.execute(createParams(createSession(), new AbortController()));
    await settle();

    expect(result.success).toBe(true);
  });

  // Steering bookkeeping lives in the host. If its hook throws, the user's turn
  // is still the user's turn — it must finish and render.
  it('a throwing hook does not fail the turn', async () => {
    const onSteerLifecycle = vi.fn(() => {
      throw new Error('host registry bug');
    });
    const deps = createDeps(
      steerStream(
        { type: 'steer_lifecycle', uuid: 'u-1', phase: 'completed' },
        {
          type: 'assistant_delta',
          text: '중단 없이 계속',
        },
      ),
      { onSteerLifecycle },
    );
    const executor = new StreamExecutor(deps);

    const result = await executor.execute(createParams(createSession(), new AbortController()));
    await settle();

    expect(onSteerLifecycle).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(deps.threadPanel.appendText.mock.calls.map((c: any[]) => c[1]).join('')).toContain('중단 없이 계속');
  });

  it('a rejecting async hook does not fail the turn', async () => {
    const onSteerLifecycle = vi.fn().mockRejectedValue(new Error('host registry bug'));
    const deps = createDeps(steerStream({ type: 'steer_lifecycle', uuid: 'u-1', phase: 'cancelled' }), {
      onSteerLifecycle,
    });
    const executor = new StreamExecutor(deps);

    const result = await executor.execute(createParams(createSession(), new AbortController()));
    await settle();

    expect(onSteerLifecycle).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
