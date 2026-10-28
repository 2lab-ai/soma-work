/**
 * A deleted session must not re-enter the background-task tracker.
 *
 * Deleting a session drains its background-task tracking (the registry's
 * before-delete seam calls `clearBackgroundResume`). The SDK stream of that
 * session can still be running, though, and two callbacks used to add entries
 * after the drain:
 *
 *  - `onAgentTaskLifecycle` forwarded `task_started` with no `terminated` check;
 *  - `onToolResult` checked `terminated` only BEFORE awaiting the status write,
 *    so a delete during that await still let the spawn-ack add an entry.
 *
 * The orphaned entries never settle (the stream is aborted). A new session in
 * the same thread reuses the session key, sees "live" background work at turn
 * end, and re-enters the background-wait loop for tasks it never started.
 *
 * Harness: same minimal fake surface as stream-executor.steer-lifecycle.test.ts.
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
      getStatusEmoji: vi.fn().mockReturnValue('thinking_face'),
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

function stream(session: any, ...steps: Array<any | (() => void)>) {
  return () =>
    (async function* () {
      for (const step of steps) {
        if (typeof step === 'function') step();
        else yield step;
      }
      yield { type: 'result', stopReason: 'end_turn' };
    })();
}

const started = { type: 'agent_task_lifecycle', phase: 'started', taskId: 'bg-1', taskType: 'bash' };

describe('StreamExecutor — background tracker fence after session delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards task lifecycle while the session is live', async () => {
    const session = createSession();
    const deps = createDeps(stream(session, started));
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, new AbortController()));
    await settle();

    expect(deps.toolEventProcessor.handleAgentTaskLifecycle).toHaveBeenCalledTimes(1);
  });

  it('drops task lifecycle that arrives after the session was terminated', async () => {
    const session = createSession();
    const deps = createDeps(
      stream(session, { type: 'assistant_delta', text: 'working' }, () => (session.terminated = true), started),
    );
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, new AbortController()));
    await settle();

    expect(deps.toolEventProcessor.handleAgentTaskLifecycle).not.toHaveBeenCalled();
  });

  it('drops a tool result whose session was terminated during the status write', async () => {
    const session = createSession();
    const deps = createDeps(
      stream(
        session,
        {
          type: 'tool_call',
          toolCallId: 'tu-1',
          name: 'Bash',
          input: { command: 'sleep 100', run_in_background: true },
        },
        {
          type: 'tool_result',
          toolCallId: 'tu-1',
          content: [{ type: 'text', text: 'Command running in background with ID: bg-1' }],
        },
      ),
    );
    // The session is deleted while onToolResult awaits its status write.
    deps.threadPanel.setStatus.mockImplementation(async (_s: any, _k: string, patch: any) => {
      if (patch?.agentPhase === '결과 반영 중') session.terminated = true;
    });
    const abortController = new AbortController();
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, abortController));
    await settle();

    expect(deps.toolEventProcessor.handleToolResult).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(true);
  });

  it('drops a tool use whose session was terminated during the status write', async () => {
    const session = createSession();
    const deps = createDeps(
      stream(session, {
        type: 'tool_call',
        toolCallId: 'tu-1',
        name: 'Bash',
        input: { command: 'sleep 100', run_in_background: true },
      }),
    );
    deps.threadPanel.setStatus.mockImplementation(async (_s: any, _k: string, patch: any) => {
      if (patch?.agentPhase === '도구 실행 중') session.terminated = true;
    });
    const abortController = new AbortController();
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, abortController));
    await settle();

    expect(deps.toolEventProcessor.handleToolUse).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(true);
  });
});
