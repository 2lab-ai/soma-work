/**
 * #1031 ③ — the completion line's tool stats name the tools.
 *
 * Before: `🔧 unknown×9: 100.3s`. A main-agent tool result carries no tool name
 * (`ToolFormatter.extractToolResults` reads only `tool_name`, which the SDK does
 * not send), and `onToolResult` tallied the stats BEFORE
 * `toolEventProcessor.handleToolResult` filled the name from the tracker. The
 * executor saw the name at `onToolUse`; the tally uses that.
 *
 * Harness: same minimal fake surface as stream-executor.bg-tracker-fence.test.ts.
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

function toolCall(id: string, name: string): any {
  return { type: 'tool_call', toolCallId: id, name, input: {} };
}

function toolResult(id: string): any {
  return { type: 'tool_result', toolCallId: id, content: [{ type: 'text', text: 'ok' }] };
}

async function completionToolStats(deps: any): Promise<Record<string, { count: number }> | undefined> {
  // The notify rail is fire-and-forget off the snapshot resolve.
  for (let i = 0; i < 20 && deps.turnNotifier.notify.mock.calls.length === 0; i++) await settle();
  const evt = deps.turnNotifier.notify.mock.calls.at(-1)?.[0];
  return evt?.toolStats;
}

describe('StreamExecutor — completion tool stats carry the tool names (#1031 ③)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('tallies a nameless tool result under the name its tool call carried', async () => {
    const session = createSession();
    const deps = createDeps(
      stream(
        session,
        toolCall('tu-1', 'Bash'),
        toolResult('tu-1'),
        toolCall('tu-2', 'Read'),
        toolResult('tu-2'),
        toolCall('tu-3', 'Bash'),
        toolResult('tu-3'),
      ),
    );
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, new AbortController()));
    const stats = await completionToolStats(deps);

    expect(stats).toBeDefined();
    expect(Object.keys(stats ?? {})).not.toContain('unknown');
    expect(stats?.Bash?.count).toBe(2);
    expect(stats?.Read?.count).toBe(1);
  });

  it('keeps `unknown` only for a result whose call it never saw', async () => {
    const session = createSession();
    const deps = createDeps(stream(session, toolResult('tu-orphan')));
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, new AbortController()));
    const stats = await completionToolStats(deps);

    expect(stats?.unknown?.count).toBe(1);
  });
});
