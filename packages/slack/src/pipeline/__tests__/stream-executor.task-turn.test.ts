/**
 * #598 ④a — a Slack-less task's turn through StreamExecutor, the registry and
 * runtime half: its registry calls go by its task key (a Slack key cannot be
 * built from an empty channel), it gets a conversation record, and the
 * execution context reaches the runtime with no Slack context. Output to Slack
 * is ④b; the entry point is ④c. Harness copied from
 * `stream-executor.work-log.test.ts`.
 */

import { Logger } from '@soma/common/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_MINIMAL } from '../../output-flags';
import type { WorkLogInput } from '../../work-log';
import { StreamExecutor, setStreamExecutorProviders } from '../stream-executor';

const appendWorkLog = vi.fn<(conversationId: string, entry: WorkLogInput) => void>();
const createConversation = vi.fn((_c: string, _t: string, _u: string, _n: string) => 'conv-task');
const postCompactStartingIfNeeded = vi.fn().mockResolvedValue(undefined);
const postCompactCompleteIfNeeded = vi.fn().mockResolvedValue(undefined);
const checkAndSchedulePendingCompact = vi.fn().mockResolvedValue(false);

setStreamExecutorProviders({
  appendWorkLog,
  createConversation,
  checkAndSchedulePendingCompact,
  postCompactStartingIfNeeded,
  postCompactCompleteIfNeeded,
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
    getUserDefaultLogVerbosity: () => 'minimal',
    getUserLogVerbosityFlags: () => LOG_MINIMAL,
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

const CHANNEL = 'C1';
const THREAD = '1757500000.000100';
const SESSION_KEY = `${CHANNEL}:${THREAD}`;
const INSTRUCTION = 'raise the request timeout';
const NARRATION = 'Let me read the config first.';
const FINAL = 'The timeout is 30s; I raised it to 60s.';

function toolTurn(): () => AsyncGenerator<unknown> {
  return () =>
    (async function* () {
      yield { type: 'assistant_delta', text: NARRATION };
      yield { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: { file_path: '/repo/config.ts' } };
      yield { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'timeout = 30' }] };
      yield { type: 'assistant_delta', text: FINAL };
      yield { type: 'result', stopReason: 'end_turn', finalText: FINAL };
    })();
}

function createDeps(stream: () => AsyncGenerator<unknown>): any {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      setSessionLinks: vi.fn(),
      addSourceWorkingDir: vi.fn(),
      streamAgentEvents: vi.fn().mockImplementation(stream),
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
      isRequestActive: vi.fn().mockReturnValue(false),
    },
    slackApi: {
      getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
      getClient: vi.fn().mockReturnValue({}),
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: '1757500009.000100' }),
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
  };
}

function createSession(logVerbosity: number, extra: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess_1',
    ownerId: 'U1',
    title: 'work log',
    conversationId: 'conv-1',
    logVerbosity,
    usage: {},
    terminated: false,
    ...extra,
  };
}

function createParams(session: any): any {
  return {
    session,
    sessionKey: SESSION_KEY,
    userName: 'user',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: INSTRUCTION,
    channel: CHANNEL,
    threadTs: THREAD,
    user: 'U1',
    isUserInput: true,
    say: vi.fn().mockResolvedValue({ ts: 'm' }),
  };
}

const TASK_ID = '11111111-2222-4333-8444-555555555555';
const TASK_KEY = `task:${TASK_ID}`;
const TASK_CONTEXT = Object.freeze({ origin: 'task', userId: 'U1', sessionKey: TASK_KEY, taskId: TASK_ID });

const ISSUE_URL = 'https://github.com/o/r/issues/1';
const SOURCE_DIR = '/tmp/U1/session_x/repo';

/** A turn whose final text carries the session-links and source-dir directives. */
function directiveTurn(): () => AsyncGenerator<unknown> {
  const text = [
    FINAL,
    '```json',
    JSON.stringify({ type: 'session_links', issue: ISSUE_URL }),
    '```',
    '```json',
    JSON.stringify({ type: 'source_working_dir', action: 'add', path: SOURCE_DIR }),
    '```',
  ].join('\n');
  return () =>
    (async function* () {
      yield { type: 'assistant_delta', text };
      yield { type: 'result', stopReason: 'end_turn', finalText: text };
    })();
}

/** A turn the SDK fails with an invalid-resume error: the executor drops the SDK session. */
function invalidResumeTurn(): () => AsyncGenerator<unknown> {
  return () =>
    // biome-ignore lint/correctness/useYield: it fails before its first event
    (async function* () {
      throw new Error('No conversation found with session ID: sess_1');
    })();
}

function taskDeps(stream: () => AsyncGenerator<unknown> = toolTurn()) {
  const deps = createDeps(stream);
  Object.assign(deps.claudeHandler, {
    addMergeStats: vi.fn(),
    setActivityStateByKey: vi.fn(),
    clearSessionIdByKey: vi.fn(),
    setSessionLinksByKey: vi.fn(),
    addSourceWorkingDirByKey: vi.fn(),
    addMergeStatsByKey: vi.fn(),
  });
  return deps;
}

function taskParams(extra: Record<string, unknown> = {}): any {
  const session = createSession(LOG_MINIMAL, { slackless: true, taskId: TASK_ID, channelId: '', ...extra });
  return {
    ...createParams(session),
    sessionKey: TASK_KEY,
    channel: '',
    threadTs: undefined,
    executionContext: TASK_CONTEXT,
  };
}

describe('StreamExecutor — a Slack-less task turn, registry and runtime half (#598 ④a)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('the runtime gets the execution context and no Slack context', async () => {
    const deps = taskDeps();
    await new StreamExecutor(deps).execute(taskParams());
    const args = deps.claudeHandler.streamAgentEvents.mock.calls[0] as unknown[];
    expect(args[4]).toBeUndefined(); // slackContext
    expect(args[5]).toBe(TASK_KEY); // sessionKey
    expect(args[6]).toBe(TASK_CONTEXT); // executionContext
  });

  it('activity state goes by the task key — never through a channel/thread key', async () => {
    const deps = taskDeps();
    await new StreamExecutor(deps).execute(taskParams());
    expect(deps.claudeHandler.setActivityState).not.toHaveBeenCalled();
    const states = deps.claudeHandler.setActivityStateByKey.mock.calls.map((c: unknown[]) => c);
    expect(states[0]).toEqual([TASK_KEY, 'working']);
    expect(states.at(-1)?.[0]).toBe(TASK_KEY);
    expect(['idle', 'waiting']).toContain(states.at(-1)?.[1]);
  });

  it('a task with no conversation record gets one, so its turns are recorded', async () => {
    const deps = taskDeps();
    const params = taskParams({ conversationId: undefined });
    await new StreamExecutor(deps).execute(params);
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(params.session.conversationId).toBe('conv-task');
  });

  it('a Slack session still uses its channel/thread forms (unchanged)', async () => {
    const deps = taskDeps();
    await new StreamExecutor(deps).execute(createParams(createSession(LOG_MINIMAL)));
    expect(deps.claudeHandler.setActivityState).toHaveBeenCalledWith(CHANNEL, THREAD, 'working');
    expect(deps.claudeHandler.setActivityStateByKey).not.toHaveBeenCalled();
    const args = deps.claudeHandler.streamAgentEvents.mock.calls[0] as unknown[];
    expect(args[4]).toBeDefined(); // the Slack context as before
  });

  it('session links and a source directory go by the task key', async () => {
    const deps = taskDeps(directiveTurn());
    await new StreamExecutor(deps).execute(taskParams());
    expect(deps.claudeHandler.setSessionLinks).not.toHaveBeenCalled();
    expect(deps.claudeHandler.setSessionLinksByKey).toHaveBeenCalledWith(
      TASK_KEY,
      expect.objectContaining({ issue: expect.objectContaining({ url: ISSUE_URL }) }),
    );
    expect(deps.claudeHandler.addSourceWorkingDir).not.toHaveBeenCalled();
    expect(deps.claudeHandler.addSourceWorkingDirByKey).toHaveBeenCalledWith(TASK_KEY, SOURCE_DIR);
  });

  it('a merged PR is recorded on the task by its key', async () => {
    setStreamExecutorProviders({
      interceptToolResults: (_r: unknown, _o: unknown, _n: unknown, key: string, onMerge: (...a: unknown[]) => void) =>
        onMerge(key, 7, 10, 3),
    });
    try {
      const deps = taskDeps();
      await new StreamExecutor(deps).execute(taskParams());
      expect(deps.claudeHandler.addMergeStats).not.toHaveBeenCalled();
      expect(deps.claudeHandler.addMergeStatsByKey).toHaveBeenCalledWith(TASK_KEY, 7, 10, 3);
    } finally {
      setStreamExecutorProviders({ interceptToolResults: () => {} });
    }
  });

  it('an invalid resume drops the task’s SDK session by its key', async () => {
    const deps = taskDeps(invalidResumeTurn());
    await new StreamExecutor(deps).execute(taskParams());
    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(deps.claudeHandler.clearSessionIdByKey).toHaveBeenCalledWith(TASK_KEY);
    expect(deps.claudeHandler.setActivityState).not.toHaveBeenCalled();
  });
});
