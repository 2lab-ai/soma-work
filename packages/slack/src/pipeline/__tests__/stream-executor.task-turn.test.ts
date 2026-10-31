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
import { createDashboardTurnPanel } from '../../task-turn/dashboard-turn-panel';
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

/**
 * A channel/thread form of a registry call: like the real one, it throws for an
 * empty channel — so a missed site fails the task turn instead of passing
 * silently (#615 R1).
 */
function slackKeyed() {
  return vi.fn((channel: string) => {
    if (!channel) throw new Error('Invalid channelId (IDENTITY_EMPTY): ""');
  });
}

function taskDeps(stream: () => AsyncGenerator<unknown> = toolTurn()) {
  const deps = createDeps(stream);
  Object.assign(deps.claudeHandler, {
    setActivityState: slackKeyed(),
    clearSessionId: slackKeyed(),
    setSessionLinks: slackKeyed(),
    addSourceWorkingDir: slackKeyed(),
    addMergeStats: slackKeyed(),
    updateSessionTitle: slackKeyed(),
    fillPlaceholderSessionTitle: slackKeyed(),
    updateSessionResources: slackKeyed(),
    setActivityStateByKey: vi.fn(),
    clearSessionIdByKey: vi.fn(),
    setSessionLinksByKey: vi.fn(),
    addSourceWorkingDirByKey: vi.fn(),
    addMergeStatsByKey: vi.fn(),
  });
  // #598 ④b — a task turn writes through its own work-log writer, to the dashboard panel.
  deps.workLog = vi.fn(async () => {});
  deps.threadPanel = createDashboardTurnPanel({ persistAndBroadcast: vi.fn() });
  return deps;
}

const TASK_BINDING = { sessionKey: TASK_KEY, conversationId: 'conv-1', turnId: 'turn-task-1' };

function taskParams(extra: Record<string, unknown> = {}): any {
  const session = createSession(LOG_MINIMAL, { slackless: true, taskId: TASK_ID, channelId: '', ...extra });
  return {
    ...createParams(session),
    sessionKey: TASK_KEY,
    channel: '',
    threadTs: undefined,
    executionContext: TASK_CONTEXT,
    taskBinding: TASK_BINDING,
  };
}

describe('StreamExecutor — a Slack-less task turn, registry and runtime half (#598 ④a)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('the runtime gets the execution context and no Slack context', async () => {
    const deps = taskDeps();
    const result = await new StreamExecutor(deps).execute(taskParams());
    expect(result.success).toBe(true);
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
    // #598 ④b — the idle/waiting transition is the task runner's, after the outcome commit.
    expect(states.every((c: unknown[]) => c[0] === TASK_KEY && c[1] === 'working')).toBe(true);
  });

  it('a task turn whose session is not on its binding’s conversation is refused (#598 ④b — the runner creates it durably)', async () => {
    const deps = taskDeps();
    const params = taskParams({ conversationId: undefined });
    await expect(new StreamExecutor(deps).execute(params)).rejects.toThrow(/binding/);
    expect(createConversation).not.toHaveBeenCalled();
    expect(deps.claudeHandler.streamAgentEvents).not.toHaveBeenCalled();
  });

  it('a Slack session still uses its channel/thread forms (unchanged)', async () => {
    const deps = taskDeps();
    await new StreamExecutor(deps).execute(createParams(createSession(LOG_MINIMAL)));
    expect(deps.claudeHandler.setActivityState).toHaveBeenCalledWith(CHANNEL, THREAD, 'working');
    expect(deps.claudeHandler.setActivityStateByKey).not.toHaveBeenCalled();
    const args = deps.claudeHandler.streamAgentEvents.mock.calls[0] as unknown[];
    expect(args[4]).toBeDefined(); // the Slack context as before
  });

  it('session links, their title refresh and a source directory go by the task key', async () => {
    const bySlack = vi.fn();
    const byKey = vi.fn();
    setStreamExecutorProviders({
      scheduleLinkDerivedTitleRefresh: bySlack,
      scheduleLinkDerivedTitleRefreshByKey: byKey,
    });
    const deps = taskDeps(directiveTurn());
    try {
      await new StreamExecutor(deps).execute(taskParams());
    } finally {
      setStreamExecutorProviders({
        scheduleLinkDerivedTitleRefresh: () => {},
        scheduleLinkDerivedTitleRefreshByKey: () => {},
      });
    }
    expect(bySlack).not.toHaveBeenCalled();
    expect(byKey).toHaveBeenCalledWith(deps.claudeHandler, TASK_KEY, 'mid-conversation');
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

  it('a Slack-less session with no execution context is refused before anything runs (#615 R1)', async () => {
    const deps = taskDeps();
    const params = taskParams();
    params.executionContext = undefined;
    await expect(new StreamExecutor(deps).execute(params)).rejects.toThrow(/execution context/);
    expect(deps.claudeHandler.setActivityStateByKey).not.toHaveBeenCalled();
    expect(deps.claudeHandler.streamAgentEvents).not.toHaveBeenCalled();
  });

  it('an execution context alongside a Slack session is refused (#615 R1)', async () => {
    const deps = taskDeps();
    const params = { ...createParams(createSession(LOG_MINIMAL)), executionContext: TASK_CONTEXT };
    await expect(new StreamExecutor(deps).execute(params)).rejects.toThrow(/execution context/);
    expect(deps.claudeHandler.setActivityState).not.toHaveBeenCalled();
    expect(deps.claudeHandler.streamAgentEvents).not.toHaveBeenCalled();
  });

  it('a task turn does not ask Slack for a channel description (#615 R1)', async () => {
    const describeChannel = vi.fn(async () => '');
    setStreamExecutorProviders({ getChannelDescription: describeChannel });
    try {
      await new StreamExecutor(taskDeps()).execute(taskParams());
      expect(describeChannel).not.toHaveBeenCalled();
      await new StreamExecutor(taskDeps()).execute(createParams(createSession(LOG_MINIMAL)));
      expect(describeChannel).toHaveBeenCalledWith(expect.anything(), CHANNEL);
    } finally {
      setStreamExecutorProviders({ getChannelDescription: async () => '' });
    }
  });
});

describe('StreamExecutor — a Slack-less task turn writes to the dashboard (#598 ④b1)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('work-log entries go through the turn’s writer, bound to its binding — never the process-wide provider', async () => {
    const deps = taskDeps();
    await new StreamExecutor(deps).execute(taskParams());
    const kinds = deps.workLog.mock.calls.map((c: any[]) => c[1].kind);
    expect(kinds).toEqual(expect.arrayContaining(['instruction', 'tool', 'tool_result', 'final']));
    for (const c of deps.workLog.mock.calls) {
      expect(c[0]).toBe(TASK_BINDING);
      // One id for the turn's work log, its question and its committed outcome (#626 R1).
      expect(c[1].turnId).toBe(TASK_BINDING.turnId);
    }
    expect(appendWorkLog).not.toHaveBeenCalled();
  });

  it('a task turn with a follow-up turn epoch is refused before the model runs (#626 R1)', async () => {
    const deps = taskDeps();
    await expect(new StreamExecutor(deps).execute({ ...taskParams(), followupTurnEpoch: 3 })).rejects.toThrow(
      /follow-up turn epoch/,
    );
    expect(deps.claudeHandler.streamAgentEvents).not.toHaveBeenCalled();
  });

  it.each([
    ['stall-timeout', /응답 없음/],
    ['ghost-session', /세션이 종료/],
  ] as const)('an abort for %s carries its explanation as the reason — posted nowhere (#626 R1)', async (reason, text) => {
    const controller = new AbortController();
    const stalled = () =>
      (async function* () {
        yield { type: 'assistant_delta', text: 'working' };
        controller.abort(reason);
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      })();
    const deps = taskDeps(stalled);
    const params = { ...taskParams(), abortController: controller };
    const result = await new StreamExecutor(deps).execute(params);
    expect(result.terminal).toMatchObject({ exit: 'error', abortReason: reason, thrownError: false });
    expect(result.terminal?.reasonText).toMatch(text);
    expect(params.say).not.toHaveBeenCalled();
  });

  it('a caller-supplied say is never called on a task turn', async () => {
    const deps = taskDeps();
    const params = taskParams();
    await new StreamExecutor(deps).execute(params);
    expect(params.say).not.toHaveBeenCalled();
  });

  it('any say fallback goes to the task say (a work-log notice), never the caller say', async () => {
    const deps = taskDeps();
    // A panel that declines text forces the processor onto its say fallback.
    deps.threadPanel = { ...deps.threadPanel, appendText: vi.fn(async () => false) };
    const params = taskParams();
    await new StreamExecutor(deps).execute(params);
    expect(params.say).not.toHaveBeenCalled();
    const notices = deps.workLog.mock.calls.filter((c: any[]) => c[1].kind === 'notice').map((c: any[]) => c[1].text);
    expect(notices.join('\n')).toContain(FINAL);
  });

  it('no Slack identity, email gate or bot id on a task turn', async () => {
    setStreamExecutorProviders({
      userSettingsStore: {
        getUserSessionTheme: () => 'D',
        getUserEmail: () => undefined,
        setUserEmail: () => {},
        ensureUserExists: () => {},
        setUserSlackDisplayName: () => {},
        shouldRefreshSlackIdentity: () => true,
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
    try {
      const deps = taskDeps();
      const result = await new StreamExecutor(deps).execute(taskParams());
      expect(result.success).toBe(true);
      expect(deps.slackApi.getUserProfile).not.toHaveBeenCalled();
      expect(deps.slackApi.getBotUserId).not.toHaveBeenCalled();
      expect(deps.claudeHandler.streamAgentEvents).toHaveBeenCalledTimes(1);
    } finally {
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
    }
  });

  it('a success return carries terminal signals; a Slack turn carries none', async () => {
    const result = await new StreamExecutor(taskDeps()).execute(taskParams());
    expect(result.terminal).toMatchObject({ exit: 'success', hasSdkError: false, endTurnInfoPresent: true });
    expect(typeof result.terminal?.choiceStillOpen).toBe('function');
    const slack = await new StreamExecutor(taskDeps()).execute(createParams(createSession(LOG_MINIMAL)));
    expect(slack.terminal).toBeUndefined();
  });

  it('a thrown error returns error signals with the would-be posted text as the reason, and posts nothing', async () => {
    const deps = taskDeps(invalidResumeTurn());
    const params = taskParams();
    const result = await new StreamExecutor(deps).execute(params);
    expect(result.terminal).toMatchObject({ exit: 'error', thrownError: true, abortLike: false });
    expect(typeof result.terminal?.reasonText).toBe('string');
    expect(params.say).not.toHaveBeenCalled();
    const errors = deps.workLog.mock.calls.filter((c: any[]) => c[1].kind === 'error');
    expect(errors).toHaveLength(1);
  });

  it('a stream that ends without a result reports it (no endTurnInfo)', async () => {
    const noResult = () =>
      (async function* () {
        yield { type: 'assistant_delta', text: 'partial' };
      })();
    const result = await new StreamExecutor(taskDeps(noResult)).execute(taskParams());
    expect(result.terminal).toMatchObject({ exit: 'success', endTurnInfoPresent: false });
  });

  it('a text-JSON question is registered once, structured, with a host id — no Slack rendering path', async () => {
    const question = {
      type: 'user_choice',
      question: 'Which DB?',
      choices: [
        { id: 'a', label: 'pg' },
        { id: 'b', label: 'my' },
      ],
    };
    const text = ['Before I continue:', '```json', JSON.stringify(question), '```'].join('\n');
    const askTurn = () =>
      (async function* () {
        yield { type: 'assistant_delta', text };
        yield { type: 'result', stopReason: 'end_turn', finalText: text };
      })();
    const deps = taskDeps(askTurn);
    const params = taskParams();
    const result = await new StreamExecutor(deps).execute(params);
    const pq = params.session.actionPanel?.pendingQuestion;
    expect(pq).toMatchObject({ question: 'Which DB?', turnId: expect.any(String) });
    expect(typeof pq.askId).toBe('string');
    expect(params.session.actionPanel.waitingForChoice).toBe(true);
    expect(result.terminal?.choiceStillOpen?.()).toBe(true);
    // The waiting outcome's reason is the question (#626 R1).
    expect(result.terminal?.questionTitle).toBe('Which DB?');
    // The preface is recorded once — in the turn's final entry — not again as narration (#626 R1).
    const texts = (kind: string) =>
      deps.workLog.mock.calls.filter((c: any[]) => c[1].kind === kind).map((c: any[]) => String(c[1].text));
    expect(texts('final').join(' ')).toContain('Before I continue');
    expect(texts('narration').join(' ')).not.toContain('Before I continue');
    expect(params.say).not.toHaveBeenCalled();
  });
});

describe('StreamExecutor — ④b2 R1 review (#629)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('a turn with no SDK session id still schedules its tool cleanup, keyed by the session (no leaked tool mappings)', async () => {
    const deps = taskDeps();
    const params = taskParams();
    params.session.sessionId = undefined;
    await new StreamExecutor(deps).execute(params);
    expect(deps.toolTracker.scheduleCleanup).toHaveBeenCalledWith(expect.any(Number), expect.any(Function), TASK_KEY);
  });

  it('a task turn does not drive the Slack context emoji, even at the most verbose setting', async () => {
    const usageTurn = () =>
      (async function* () {
        yield {
          type: 'usage',
          usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        };
        yield { type: 'result', stopReason: 'end_turn', finalText: 'ok' };
      })();
    const deps = taskDeps(usageTurn);
    const params = taskParams({ logVerbosity: 0x7fffffff });
    await new StreamExecutor(deps).execute(params);
    expect(deps.contextWindowManager.updateContextEmoji).not.toHaveBeenCalled();
  });
});
