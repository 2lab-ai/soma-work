/**
 * Spec 12 §2.2 (review round 2) — a subagent's tool calls and results reach
 * the executor with their attribution. What the main agent is doing (the
 * thread header's current tool, the Slack tool rows, the request's tool
 * stats) is the main agent's calls only — but the host's own work on a tool
 * result (model commands such as ASK_USER_QUESTION / UPDATE_SESSION, git
 * metrics) runs for every agent's results, as it did before attribution.
 *
 * Harness: the minimal fake surface of stream-executor.bg-tracker-fence.test.ts.
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

const SPAWN = {
  type: 'tool_call',
  toolCallId: 'toolu_agent',
  name: 'Agent',
  input: { description: 'x', subagent_type: 'Explore' },
};
const SUB_CMD = {
  type: 'tool_call',
  toolCallId: 'tu_sub_cmd',
  name: 'mcp__model-command__run',
  input: { commandId: 'ASK_USER_QUESTION', params: {} },
  parentToolUseId: 'toolu_agent',
};
const SUB_CMD_RESULT = {
  type: 'tool_result',
  toolCallId: 'tu_sub_cmd',
  content: [{ type: 'text', text: '{"ok":true}' }],
  parentToolUseId: 'toolu_agent',
};
const SUB_GREP = {
  type: 'tool_call',
  toolCallId: 'tu_sub_grep',
  name: 'Grep',
  input: { pattern: 'x' },
  parentToolUseId: 'toolu_agent',
};

describe('StreamExecutor — subagent tool calls and results (spec 12)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('the Slack tool surfaces see only the main agent; the subagent tool never becomes the current tool', async () => {
    const session = createSession();
    const deps = createDeps(
      stream(session, SPAWN, SUB_GREP, {
        type: 'tool_result',
        toolCallId: 'tu_sub_grep',
        content: [],
        parentToolUseId: 'toolu_agent',
      }),
    );
    await new StreamExecutor(deps).execute(createParams(session, new AbortController()));
    await settle();
    const used = deps.toolEventProcessor.handleToolUse.mock.calls.flatMap((c: any[]) => c[0].map((t: any) => t.name));
    expect(used).toEqual(['Agent']);
    const results = deps.toolEventProcessor.handleToolResult.mock.calls.flatMap((c: any[]) =>
      c[0].map((t: any) => t.toolUseId),
    );
    expect(results).not.toContain('tu_sub_grep');
    const tools = deps.threadPanel.setStatus.mock.calls.map((c: any[]) => c[2]?.activeTool).filter(Boolean);
    expect(tools).not.toContain('Grep');
  });

  it("a subagent's model-command result still reaches the host's model-command handling, named", async () => {
    const seen: any[] = [];
    vi.spyOn(StreamExecutor.prototype as any, 'handleModelCommandToolResults').mockImplementation(
      async (results: any) => {
        seen.push(...results);
        return { hasPendingChoice: false };
      },
    );
    const session = createSession();
    const deps = createDeps(stream(session, SPAWN, SUB_CMD, SUB_CMD_RESULT));
    await new StreamExecutor(deps).execute(createParams(session, new AbortController()));
    await settle();
    expect(seen).toContainEqual(
      expect.objectContaining({
        toolUseId: 'tu_sub_cmd',
        toolName: 'mcp__model-command__run',
        parentToolUseId: 'toolu_agent',
      }),
    );
  });
});
