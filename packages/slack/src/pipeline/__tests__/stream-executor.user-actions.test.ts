/**
 * User actions — every tool batch reaches the host's `captureUserActions` provider with the session's thread, so an
 * `instruct_user` result gets its own Slack card and dashboard section (not the question form).
 *
 * Harness: the minimal fake surface of stream-executor.tool-stats-names.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { LOG_DETAIL } from '../../output-flags';
import { StreamExecutor, setStreamExecutorProviders } from '../stream-executor';

/** The names as the provider saw them at the call (the result objects are mutable). */
const namesAtCall: Array<Array<[string, string | undefined]>> = [];
const captureUserActions = vi.fn(async (args: any) => {
  namesAtCall.push(args.toolResults.map((t: any) => [t.toolUseId, t.toolName]));
});

setStreamExecutorProviders({
  captureUserActions,
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

describe('StreamExecutor — user actions reach the host provider', () => {
  it('hands every tool batch, named, with the thread and a persist+broadcast hook', async () => {
    const session = createSession();
    const persistAndBroadcast = vi.fn();
    const deps = createDeps(
      stream(session, toolCall('tu-1', 'mcp__user-action__instruct_user'), toolResult('tu-1')),
      {},
    );
    deps.claudeHandler.getSessionRegistry.mockReturnValue({
      beginTurn: vi.fn(),
      endTurn: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
      getActivityState: vi.fn().mockReturnValue('idle'),
      persistAndBroadcast,
    });
    // The real processor names a result from its tool call (tool-event-processor.ts); the fake does the same.
    deps.toolEventProcessor.handleToolResult.mockImplementation(async (results: any[]) => {
      for (const r of results) r.toolName ??= 'mcp__user-action__instruct_user';
    });
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, new AbortController()));

    expect(captureUserActions).toHaveBeenCalledTimes(1);
    const args = (captureUserActions.mock.calls[0] as any[])[0];
    expect(namesAtCall[0]).toEqual([['tu-1', 'mcp__user-action__instruct_user']]);
    expect(args.session).toBe(session);
    expect([args.sessionKey, args.channel, args.threadTs]).toEqual([SESSION_KEY, 'C42', 'thread42']);
    expect(args.slackApi).toBe(deps.slackApi);
    args.persistAndBroadcast('k');
    expect(persistAndBroadcast).toHaveBeenCalledWith('k');
  });
});
