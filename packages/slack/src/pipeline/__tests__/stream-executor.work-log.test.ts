/**
 * Spec 10 §3.3 — StreamExecutor binds the work log: every entry of a turn goes
 * to `streamExecutorProviders.appendWorkLog(conversationId, entry)`, stamped
 * with the turn id, at every verbosity. The executor's own entries are the
 * user instruction, compaction notices and turn errors; the processor's
 * (narration, tool, tool_result, final) arrive through `StreamContext.workLog`.
 * Spec 10 §3.2-3 end to end: at `minimal` the turn stream gets the final answer
 * only. Harness shape copied from `stream-executor.incident-output.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVerbosityFlags, LOG_MINIMAL } from '../../output-flags';
import { AgentStreamProcessor, type StreamContext } from '../../stream-processor';
import type { WorkLogInput } from '../../work-log';
import { StreamExecutor, setStreamExecutorProviders } from '../stream-executor';

const appendWorkLog = vi.fn<(conversationId: string, entry: WorkLogInput) => void>();
const postCompactStartingIfNeeded = vi.fn().mockResolvedValue(undefined);
const postCompactCompleteIfNeeded = vi.fn().mockResolvedValue(undefined);
const closeCompactStartingAtTurnEnd = vi.fn().mockResolvedValue(undefined);
const checkAndSchedulePendingCompact = vi.fn().mockResolvedValue(false);

setStreamExecutorProviders({
  appendWorkLog,
  checkAndSchedulePendingCompact,
  closeCompactStartingAtTurnEnd,
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

/** Let the fire-and-forget writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** White-box access to the executor's private seams these tests stub. */
interface ExecutorPrivates {
  handleError: (...args: unknown[]) => Promise<number | undefined>;
  handleModelCommandToolResults: (...args: unknown[]) => Promise<{ hasPendingChoice: boolean }>;
}

function privateOf(executor: StreamExecutor): ExecutorPrivates {
  return executor as unknown as ExecutorPrivates;
}

function spyOnHandleError(executor: StreamExecutor) {
  return vi.spyOn(privateOf(executor), 'handleError');
}

function loggedKinds(): string[] {
  return appendWorkLog.mock.calls.map(([, entry]) => entry.kind);
}

describe('StreamExecutor — work log binding (spec 10 §3.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('minimal: the whole turn reaches the work log; the turn stream gets ONLY the final answer', async () => {
    const deps = createDeps(toolTurn());
    const params = createParams(createSession(LOG_MINIMAL));

    const result = await new StreamExecutor(deps).execute(params);
    await settle();

    expect(result.success).toBe(true);
    expect(loggedKinds()).toEqual(['instruction', 'narration', 'tool', 'tool_result', 'final']);
    for (const [conversationId, entry] of appendWorkLog.mock.calls) {
      expect(conversationId).toBe('conv-1');
      expect(entry.turnId).toBe(appendWorkLog.mock.calls[0]?.[1].turnId);
      expect(typeof entry.ts).toBe('number');
    }
    expect(appendWorkLog.mock.calls[0]?.[1]).toMatchObject({ kind: 'instruction', text: INSTRUCTION });
    expect(String(appendWorkLog.mock.calls[0]?.[1].turnId)).toContain(SESSION_KEY);

    const appended = deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => call[1]);
    expect(appended).toEqual([FINAL]);
  });

  it('compact: narration still streams, and the work log is the same', async () => {
    const deps = createDeps(toolTurn());

    await new StreamExecutor(deps).execute(createParams(createSession(getVerbosityFlags('compact'))));
    await settle();

    expect(deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => call[1])).toEqual([NARRATION, FINAL]);
    expect(loggedKinds()).toEqual(['instruction', 'narration', 'tool', 'tool_result', 'final']);
  });

  it('a session without a conversation writes no work log', async () => {
    const deps = createDeps(toolTurn());

    await new StreamExecutor(deps).execute(createParams(createSession(LOG_MINIMAL, { conversationId: undefined })));
    await settle();

    expect(appendWorkLog).not.toHaveBeenCalled();
  });

  it('a throwing appendWorkLog never breaks the turn', async () => {
    appendWorkLog.mockImplementation(() => {
      throw new Error('disk full');
    });
    const deps = createDeps(toolTurn());

    const result = await new StreamExecutor(deps).execute(createParams(createSession(LOG_MINIMAL)));
    await settle();
    appendWorkLog.mockReset();

    expect(result.success).toBe(true);
    expect(deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => call[1])).toEqual([FINAL]);
  });

  it('compaction start/complete become work-log notices; the compaction helpers still run', async () => {
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'status', status: 'compacting' };
        yield {
          type: 'compact_boundary',
          metadata: { raw: { trigger: 'auto', pre_tokens: 160000, post_tokens: 35000 } },
        };
        yield { type: 'status', status: 'compact_done' };
        yield { type: 'result', stopReason: 'end_turn', finalText: FINAL };
      })(),
    );

    await new StreamExecutor(deps).execute(createParams(createSession(LOG_MINIMAL)));
    await settle();

    const notices = appendWorkLog.mock.calls.map(([, entry]) => entry).filter((entry) => entry.kind === 'notice');
    expect(notices.map((entry) => entry.text)).toEqual([
      'Compaction starting',
      'Compaction completed · trigger=auto · 160000 → 35000 tokens',
    ]);
    // Epoch markers / pending re-dispatch live in these helpers: never skipped.
    expect(postCompactStartingIfNeeded).toHaveBeenCalledTimes(1);
    expect(postCompactCompleteIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('an SDK result error is logged as an error entry', async () => {
    const deps = createDeps(() =>
      (async function* () {
        yield {
          type: 'result',
          stopReason: 'end_turn',
          error: { subtype: 'error_max_turns', errors: ['hit the turn cap'] },
        };
      })(),
    );

    await new StreamExecutor(deps).execute(createParams(createSession(LOG_MINIMAL)));
    await settle();

    expect(appendWorkLog.mock.calls.map(([, entry]) => entry)).toContainEqual(
      expect.objectContaining({ kind: 'error', text: 'error_max_turns: hit the turn cap' }),
    );
  });

  it('a thrown turn error with no retry scheduled is logged as an error entry', async () => {
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: NARRATION };
        throw new Error('transport closed');
      })(),
    );
    const executor = new StreamExecutor(deps);
    const handleError = spyOnHandleError(executor).mockResolvedValue(undefined);

    await executor.execute(createParams(createSession(LOG_MINIMAL))).catch(() => undefined);
    await settle();

    expect(handleError).toHaveBeenCalledTimes(1);
    expect(appendWorkLog.mock.calls.map(([, entry]) => entry)).toContainEqual(
      expect.objectContaining({ kind: 'error', text: 'transport closed' }),
    );
  });

  it('a recoverable error (retry scheduled) is logged as a notice, not an error', async () => {
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: NARRATION };
        throw new Error('rate limited');
      })(),
    );
    const executor = new StreamExecutor(deps);
    spyOnHandleError(executor).mockResolvedValue(30_000);

    await executor.execute(createParams(createSession(LOG_MINIMAL))).catch(() => undefined);
    await settle();

    const entries = appendWorkLog.mock.calls.map(([, entry]) => entry);
    expect(entries.some((entry) => entry.kind === 'error')).toBe(false);
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'notice', text: 'retrying in 30s: rate limited' }));
  });

  // Same split as handleError's card decision: a quiet abort (the user already
  // knows the turn ended) is a notice; a card-worthy one is an error.
  it.each([
    ['user-stop', 'notice'],
    ['supersede', 'notice'],
    ['stall-timeout', 'error'],
    ['ghost-session', 'error'],
  ] as const)('an abort for %s is logged as %s', async (reason, kind) => {
    const controller = new AbortController();
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: NARRATION };
        controller.abort(reason);
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      })(),
    );
    const executor = new StreamExecutor(deps);
    spyOnHandleError(executor).mockResolvedValue(undefined);
    const params = { ...createParams(createSession(LOG_MINIMAL)), abortController: controller };

    await executor.execute(params).catch(() => undefined);
    await settle();

    const entries = appendWorkLog.mock.calls.map(([, entry]) => entry);
    expect(entries).toContainEqual(expect.objectContaining({ kind, text: `aborted (${reason})` }));
    expect(entries.filter((entry) => entry.kind === 'error' || entry.kind === 'notice')).toHaveLength(1);
  });

  it('a choice form posted by the host (ASK_USER_QUESTION) is visible to the processor', async () => {
    const deps = createDeps(toolTurn());
    let seen: (() => boolean) | undefined;
    const executor = new StreamExecutor(deps);
    const realProcess = AgentStreamProcessor.prototype.process;
    const spy = vi.spyOn(AgentStreamProcessor.prototype, 'process').mockImplementation(function (
      this: AgentStreamProcessor,
      stream,
      context: StreamContext,
      signal,
    ) {
      seen = context.hostChoicePosted;
      return realProcess.call(this, stream, context, signal);
    });
    vi.spyOn(privateOf(executor), 'handleModelCommandToolResults').mockResolvedValue({ hasPendingChoice: true });

    await executor.execute(createParams(createSession(LOG_MINIMAL)));
    await settle();
    spy.mockRestore();

    expect(seen).toBeTypeOf('function');
    expect(seen?.()).toBe(true);
  });
});

describe('StreamExecutor — turn end closes an un-ended compaction "starting" message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the closer once at turn end with the session and thread', async () => {
    const deps = createDeps(toolTurn());
    const session = createSession(LOG_MINIMAL);

    await new StreamExecutor(deps).execute(createParams(session));
    await settle();

    expect(closeCompactStartingAtTurnEnd).toHaveBeenCalledTimes(1);
    expect(closeCompactStartingAtTurnEnd).toHaveBeenCalledWith(
      expect.objectContaining({ session, channel: CHANNEL, threadTs: THREAD, slackApi: deps.slackApi }),
    );
  });

  it('runs on the error path too', async () => {
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'status', status: 'compacting' };
        throw new Error('transport closed');
      })(),
    );
    const executor = new StreamExecutor(deps);
    spyOnHandleError(executor).mockResolvedValue(undefined);

    await executor.execute(createParams(createSession(getVerbosityFlags('compact')))).catch(() => undefined);
    await settle();

    expect(closeCompactStartingAtTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('is skipped when a newer turn is already active (its cycle is not ours to close)', async () => {
    const deps = createDeps(toolTurn());
    deps.requestCoordinator.isRequestActive.mockReturnValue(true);

    await new StreamExecutor(deps).execute(createParams(createSession(LOG_MINIMAL)));
    await settle();

    expect(closeCompactStartingAtTurnEnd).not.toHaveBeenCalled();
  });

  it('a throwing closer never breaks the turn', async () => {
    closeCompactStartingAtTurnEnd.mockRejectedValueOnce(new Error('slack down'));
    const deps = createDeps(toolTurn());

    const result = await new StreamExecutor(deps).execute(createParams(createSession(LOG_MINIMAL)));

    expect(result.success).toBe(true);
  });
});

describe('StreamExecutor — a leak after narration still reaches the recovery rail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const LONG_NARRATION =
    'I will start by reading the deployment configuration, then the three service manifests it references, and finally compare their timeout values against the load-balancer settings.';

  for (const level of ['minimal', 'compact'] as const) {
    it(`${level}: narration > 160 chars → tool → "Prompt is too long" ⇒ the prompt-too-long recovery fires`, async () => {
      const deps = createDeps(() =>
        (async function* () {
          yield { type: 'assistant_delta', text: LONG_NARRATION };
          yield { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} };
          yield { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] };
          yield { type: 'assistant_delta', text: 'Prompt is too long' };
          yield { type: 'result', stopReason: 'end_turn', finalText: 'Prompt is too long' };
        })(),
      );
      const executor = new StreamExecutor(deps);
      const handleError = spyOnHandleError(executor).mockResolvedValue(undefined);

      await executor.execute(createParams(createSession(getVerbosityFlags(level)))).catch(() => undefined);
      await settle();

      expect(handleError).toHaveBeenCalledTimes(1);
      expect(String((handleError.mock.calls[0]?.[0] as Error).message)).toBe(
        'Prompt is too long (surfaced as turn content): Prompt is too long',
      );
      // The leak itself never reached the thread.
      const appended = deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => call[1]);
      expect(appended).not.toContain('Prompt is too long');
    });
  }

  it('an ordinary turn whose collectedText merely discusses the error is not recovered', async () => {
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: LONG_NARRATION };
        yield { type: 'assistant_delta', text: 'When a prompt is too long the SDK says "Prompt is too long".' };
        yield {
          type: 'result',
          stopReason: 'end_turn',
          finalText: 'When a prompt is too long the SDK says "Prompt is too long".',
        };
      })(),
    );
    const executor = new StreamExecutor(deps);
    const handleError = spyOnHandleError(executor).mockResolvedValue(undefined);

    await executor.execute(createParams(createSession(LOG_MINIMAL)));
    await settle();

    expect(handleError).not.toHaveBeenCalled();
  });
});

describe('StreamExecutor — the threshold checker gets the turn work-log sink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes workLog bound to this conversation and turn', async () => {
    const deps = createDeps(toolTurn());

    await new StreamExecutor(deps).execute(createParams(createSession(LOG_MINIMAL)));
    await settle();

    expect(checkAndSchedulePendingCompact).toHaveBeenCalledTimes(1);
    const args = checkAndSchedulePendingCompact.mock.calls[0]?.[0] as { workLog: (entry: WorkLogInput) => void };
    args.workLog({ kind: 'notice', text: 'Context usage 160k tokens ≥ 160k' });
    expect(appendWorkLog).toHaveBeenLastCalledWith(
      'conv-1',
      expect.objectContaining({ kind: 'notice', text: 'Context usage 160k tokens ≥ 160k' }),
    );
  });
});
