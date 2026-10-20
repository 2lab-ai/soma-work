/**
 * Spec 10 §3.3 — StreamExecutor binds the work log: every entry of a turn goes
 * to `streamExecutorProviders.appendWorkLog(conversationId, entry)`, stamped
 * with the turn id, at every verbosity. The executor's own entries are the
 * user instruction, compaction notices and turn errors; the processor's
 * (narration, tool, tool_result, final) arrive through `StreamContext.workLog`.
 * Spec 10 §3.2-3 end to end: at `minimal` the turn stream gets the final answer
 * only. Harness shape copied from `stream-executor.incident-output.test.ts`.
 */

import { Logger } from '@soma/common/logger';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { getVerbosityFlags, LOG_MINIMAL } from '../../output-flags';
import { AgentStreamProcessor, type StreamContext } from '../../stream-processor';
import type { WorkLogInput } from '../../work-log';
import {
  recordConversationWorkLog,
  resetWorkLogDropWarningsForTests,
  StreamExecutor,
  setStreamExecutorProviders,
  WORK_LOG_DROP_WARN_INTERVAL_MS,
} from '../stream-executor';

const appendWorkLog = vi.fn<(conversationId: string, entry: WorkLogInput) => void>();
const postCompactStartingIfNeeded = vi.fn().mockResolvedValue(undefined);
const postCompactCompleteIfNeeded = vi.fn().mockResolvedValue(undefined);
const checkAndSchedulePendingCompact = vi.fn().mockResolvedValue(false);

setStreamExecutorProviders({
  appendWorkLog,
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
    // Payloads, not just kinds.
    const turnId = appendWorkLog.mock.calls[0]?.[1].turnId;
    expect(appendWorkLog.mock.calls.map(([, entry]) => entry)).toEqual([
      { kind: 'instruction', text: INSTRUCTION, turnId, ts: expect.any(Number) },
      { kind: 'narration', text: NARRATION, turnId, ts: expect.any(Number) },
      { kind: 'tool', tool: 'Read', text: 'Read {"file_path":"/repo/config.ts"}', turnId, ts: expect.any(Number) },
      { kind: 'tool_result', tool: 'Read', ok: true, text: 'Read ok', turnId, ts: expect.any(Number) },
      { kind: 'final', text: FINAL, turnId, ts: expect.any(Number) },
    ]);

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

  // Compaction notices are conversation-level: compact-hooks records them
  // itself through `recordConversationWorkLog` (covered in
  // compact-hooks.minimal.test.ts). The executor records none — no duplicates —
  // and the compaction helpers still run.
  it.each([
    'minimal',
    'compact',
    'detail',
  ] as const)('%s: the executor records no compaction notice itself; the compaction helpers still run', async (level) => {
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

    await new StreamExecutor(deps).execute(createParams(createSession(getVerbosityFlags(level))));
    await settle();

    expect(appendWorkLog.mock.calls.filter(([, entry]) => entry.kind === 'notice')).toHaveLength(0);
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

// Spec 10 §3.2 — a failed model-command call is an internal tool error the
// model retries: at `minimal` it is this turn's work-log `error`, never a
// Slack post. Unit cases per branch live in src/slack/pipeline/__tests__/
// stream-executor.test.ts; this pins the binding end to end.
describe('StreamExecutor — a failed model-command call at minimal (spec 10 §3.2)', () => {
  const COMMAND_ERROR = 'UPDATE_SESSION requires operations or title';
  const ERROR_TEXT = `❌ MCP UPDATE_SESSION 실패: INVALID_ARGS — ${COMMAND_ERROR}`;

  function failedCommandTurn(): () => AsyncGenerator<unknown> {
    const body = {
      type: 'model_command_result',
      commandId: 'UPDATE_SESSION',
      ok: false,
      error: { code: 'INVALID_ARGS', message: COMMAND_ERROR },
    };
    return () =>
      (async function* () {
        yield {
          type: 'tool_call',
          toolCallId: 'tu_cmd',
          name: 'mcp__model-command__run',
          input: { commandId: 'UPDATE_SESSION', params: {} },
        };
        yield { type: 'tool_result', toolCallId: 'tu_cmd', content: [{ type: 'text', text: JSON.stringify(body) }] };
        yield { type: 'assistant_delta', text: FINAL };
        yield { type: 'result', stopReason: 'end_turn', finalText: FINAL };
      })();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // The harness default parser returns null; read the body the tool returned.
    setStreamExecutorProviders({
      parseModelCommandRunResponse: (raw: unknown) => {
        const text = Array.isArray(raw) ? (raw[0] as { text?: unknown } | undefined)?.text : undefined;
        return typeof text === 'string' ? JSON.parse(text) : null;
      },
    });
  });

  afterEach(() => {
    // `setStreamExecutorProviders` merges: put the harness default back explicitly.
    setStreamExecutorProviders({ parseModelCommandRunResponse: () => null });
    vi.restoreAllMocks();
  });

  it('minimal: the error is this turn’s work-log entry; the thread gets no MCP notice', async () => {
    const deps = createDeps(failedCommandTurn());
    // Production names the tool inside handleToolResult (tool-event-processor).
    deps.toolEventProcessor.handleToolResult.mockImplementation(async (results: Array<{ toolName?: string }>) => {
      for (const result of results) result.toolName = 'mcp__model-command__run';
    });
    const params = createParams(createSession(LOG_MINIMAL));

    const result = await new StreamExecutor(deps).execute(params);
    await settle();

    expect(result.success).toBe(true);
    const posted = params.say.mock.calls.map((call: Array<{ text?: string }>) => call[0]?.text ?? '');
    expect(posted.filter((text: string) => text.includes('MCP'))).toEqual([]);
    expect(deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => call[1])).toEqual([FINAL]);

    const turnId = appendWorkLog.mock.calls[0]?.[1].turnId;
    expect(loggedKinds()).toEqual(['instruction', 'tool', 'tool_result', 'error', 'final']);
    expect(appendWorkLog).toHaveBeenCalledWith('conv-1', {
      kind: 'error',
      text: ERROR_TEXT,
      turnId,
      ts: expect.any(Number),
    });
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

  for (const level of ['minimal', 'detail'] as const) {
    it(`${level}: a leak that arrives only as finalText is not posted and still reaches recovery`, async () => {
      const deps = createDeps(() =>
        (async function* () {
          yield { type: 'assistant_delta', text: LONG_NARRATION };
          yield { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} };
          yield { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] };
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
      const appended = deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => call[1]);
      expect(appended).not.toContain('Prompt is too long');
    });
  }

  // The leak predicates are short-text heuristics (an error string, not prose:
  // ≤160 chars for prompt-too-long). An answer that discusses the error runs
  // longer and is neither suppressed nor recovered — on the streamed path and
  // the finalText-only path alike.
  it('an answer that merely discusses the error (prose, > 160 chars) is posted and not recovered', async () => {
    const DISCUSSION =
      'When a request exceeds the context window, the SDK reports "Prompt is too long" as plain text instead of throwing, so the harness checks short turn texts for that phrase and runs a fallback compaction.';
    expect(DISCUSSION.length).toBeGreaterThan(160);
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: LONG_NARRATION };
        yield { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} };
        yield { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] };
        yield { type: 'result', stopReason: 'end_turn', finalText: DISCUSSION };
      })(),
    );
    const executor = new StreamExecutor(deps);
    const handleError = spyOnHandleError(executor).mockResolvedValue(undefined);

    await executor.execute(createParams(createSession(LOG_MINIMAL)));
    await settle();

    expect(handleError).not.toHaveBeenCalled();
    expect(deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => call[1])).toEqual([DISCUSSION]);
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
    const instruction = appendWorkLog.mock.calls.find(([, entry]) => entry.kind === 'instruction')?.[1];
    expect(instruction?.turnId).toBeTruthy();
    expect(appendWorkLog).toHaveBeenLastCalledWith('conv-1', {
      kind: 'notice',
      text: 'Context usage 160k tokens ≥ 160k',
      turnId: instruction?.turnId,
      ts: expect.any(Number),
    });
  });
});

/**
 * A short "leak, then a real answer" turn: the turn recovered, so recovery
 * must not fire. `transportLeak` is clear, and the fallback guard text must
 * not be "leak\nanswer" (≤160 chars, contains the leak) — the processor's
 * `guardText` leaves suppressed segments out.
 */
describe('StreamExecutor — a leak followed by a real answer never triggers recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const LEAK = 'Prompt is too long';
  const ANSWER = 'Done: raised the timeout to 60s.';
  for (const shape of ['streamed answer', 'result-only answer'] as const) {
    for (const level of ['minimal', 'detail'] as const) {
      it(`${level}, ${shape}: the answer is posted and no recovery fires`, async () => {
        const deps = createDeps(() =>
          (async function* () {
            yield { type: 'assistant_delta', text: LEAK };
            yield { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} };
            yield { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] };
            if (shape === 'streamed answer') yield { type: 'assistant_delta', text: ANSWER };
            yield { type: 'result', stopReason: 'end_turn', finalText: ANSWER };
          })(),
        );
        const executor = new StreamExecutor(deps);
        const handleError = spyOnHandleError(executor).mockResolvedValue(undefined);

        const result = await executor.execute(createParams(createSession(getVerbosityFlags(level))));
        await settle();

        expect(handleError).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        const appended: string[] = deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => String(call[1]));
        expect(appended.filter((text) => text.startsWith(ANSWER))).toHaveLength(1);
        expect(appended.some((text) => text.includes(LEAK))).toBe(false);
      });
    }
  }
});

describe('StreamExecutor — a leak followed by a directive-only ending still recovers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const DIRECTIVE_ONLY = '```json\n{"type":"channel_message","text":"Release notes"}\n```';
  for (const shape of ['streamed', 'result-only'] as const) {
    for (const level of ['minimal', 'detail'] as const) {
      it(`${level}, ${shape} directive-only ending: recovery fires, the directive posts once, the leak never does`, async () => {
        const deps = createDeps(() =>
          (async function* () {
            yield { type: 'assistant_delta', text: NARRATION };
            yield { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} };
            yield { type: 'assistant_delta', text: 'Prompt is too long' };
            yield { type: 'tool_call', toolCallId: 'tu_2', name: 'Read', input: {} };
            if (shape === 'streamed') yield { type: 'assistant_delta', text: DIRECTIVE_ONLY };
            yield { type: 'result', stopReason: 'end_turn', finalText: DIRECTIVE_ONLY };
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
        expect(deps.slackApi.postMessage).toHaveBeenCalledTimes(1);
        const appended: string[] = deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => String(call[1]));
        expect(appended.some((text) => text.includes('Prompt is too long'))).toBe(false);
      });
    }
  }
});

describe('StreamExecutor — a result-only answer logs exactly one final', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'minimal',
    'detail',
  ] as const)('%s: narration → tool → result with a never-streamed answer', async (level) => {
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: NARRATION };
        yield { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} };
        yield { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] };
        yield { type: 'result', stopReason: 'end_turn', finalText: FINAL };
      })(),
    );

    await new StreamExecutor(deps).execute(createParams(createSession(getVerbosityFlags(level))));
    await settle();

    const turnId = appendWorkLog.mock.calls.find(([, entry]) => entry.kind === 'instruction')?.[1].turnId;
    const finals = appendWorkLog.mock.calls.map(([, entry]) => entry).filter((entry) => entry.kind === 'final');
    expect(finals).toEqual([{ kind: 'final', text: FINAL, turnId, ts: expect.any(Number) }]);
  });
});

describe('StreamExecutor — a final answer that reached Slack means no recovery (spec 10 §3.2-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'minimal',
    'detail',
  ] as const)('%s: A → tool → leak L → result(finalText = A): A posted once, no recovery', async (level) => {
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: FINAL };
        yield { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} };
        yield { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] };
        yield { type: 'assistant_delta', text: 'Prompt is too long' };
        yield { type: 'result', stopReason: 'end_turn', finalText: FINAL };
      })(),
    );
    const executor = new StreamExecutor(deps);
    const handleError = spyOnHandleError(executor).mockResolvedValue(undefined);

    const result = await executor.execute(createParams(createSession(getVerbosityFlags(level))));
    await settle();

    expect(handleError).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    const appended: string[] = deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => String(call[1]));
    expect(appended.filter((text) => text.startsWith(FINAL))).toHaveLength(1);
  });
});

describe('recordConversationWorkLog — the conversation-level path', () => {
  let warn: MockInstance<Logger['warn']>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkLogDropWarningsForTests();
    warn = vi.spyOn(Logger.prototype, 'warn');
  });

  afterEach(() => {
    warn?.mockRestore();
    appendWorkLog.mockReset();
    resetWorkLogDropWarningsForTests();
    vi.useRealTimers();
  });

  it('forwards to appendWorkLog with a timestamp and no turnId', () => {
    recordConversationWorkLog('conv-9', { kind: 'notice', text: 'Compaction starting' });

    expect(appendWorkLog).toHaveBeenCalledWith('conv-9', {
      kind: 'notice',
      text: 'Compaction starting',
      ts: expect.any(Number),
    });
  });

  it('keeps a caller-provided ts and turnId', () => {
    recordConversationWorkLog('conv-9', { kind: 'final', text: FINAL, turnId: 't-1', ts: 42 });

    expect(appendWorkLog).toHaveBeenCalledWith('conv-9', { kind: 'final', text: FINAL, turnId: 't-1', ts: 42 });
  });

  it('a throwing provider is ignored and logged at warn with conversationId, kind and sessionKey', () => {
    appendWorkLog.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(() =>
      recordConversationWorkLog('conv-9', { kind: 'notice', text: 'x' }, { sessionKey: SESSION_KEY }),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('appendWorkLog provider threw'), {
      conversationId: 'conv-9',
      kind: 'notice',
      sessionKey: SESSION_KEY,
      error: 'disk full',
    });
  });

  it('the turn path passes its sessionKey to that warning', async () => {
    // Only the final entry is dropped, so its warning is the first and only
    // one — independent of which entries the turn records before it.
    appendWorkLog.mockImplementation((_conversationId, entry) => {
      if (entry.kind === 'final') throw new Error('disk full');
    });

    await new StreamExecutor(createDeps(toolTurn())).execute(createParams(createSession(LOG_MINIMAL)));
    await settle();

    const dropped = warn.mock.calls.filter(([message]) => String(message).includes('appendWorkLog provider threw'));
    expect(dropped).toEqual([
      [
        expect.stringContaining('appendWorkLog provider threw'),
        { conversationId: 'conv-1', kind: 'final', sessionKey: SESSION_KEY, error: 'disk full' },
      ],
    ]);
  });
});

describe('recordConversationWorkLog — dropped-entry warnings are throttled process-wide', () => {
  const INTERVAL = WORK_LOG_DROP_WARN_INTERVAL_MS;
  let warn: MockInstance<Logger['warn']>;
  const drops = () => warn.mock.calls.filter(([message]) => String(message).includes('appendWorkLog provider threw'));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetWorkLogDropWarningsForTests();
    warn = vi.spyOn(Logger.prototype, 'warn');
    appendWorkLog.mockImplementation(() => {
      throw new Error('store down');
    });
  });

  afterEach(() => {
    warn?.mockRestore();
    appendWorkLog.mockReset();
    resetWorkLogDropWarningsForTests();
    vi.useRealTimers();
  });

  it('across conversations: one immediate warn, none within the interval, then one summary with the suppressed count — every write is still attempted', () => {
    recordConversationWorkLog('conv-a', { kind: 'notice', text: 'first' }, { sessionKey: 'C1:a' });
    expect(drops()).toEqual([
      [
        expect.stringContaining('appendWorkLog provider threw'),
        { conversationId: 'conv-a', kind: 'notice', sessionKey: 'C1:a', error: 'store down' },
      ],
    ]);

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_000);
      recordConversationWorkLog(`conv-${i}`, { kind: 'tool', text: `t${i}` });
    }
    vi.advanceTimersByTime(1_000);
    recordConversationWorkLog('conv-z', { kind: 'final', text: FINAL }, { sessionKey: 'C9:z' });

    expect(appendWorkLog).toHaveBeenCalledTimes(7);
    expect(drops()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(INTERVAL - 6_000 - 1);
    expect(drops()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(drops()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(drops()[1]).toEqual([
      expect.stringContaining('appendWorkLog provider threw'),
      { suppressed: 6, conversationId: 'conv-z', kind: 'final', sessionKey: 'C9:z', error: 'store down' },
    ]);

    // Nothing more was dropped: no further summary.
    vi.advanceTimersByTime(10 * INTERVAL);
    expect(drops()).toHaveLength(2);
  });

  it('a sustained outage warns at most once per interval and every drop is counted', () => {
    const seconds = 5 * 60;
    for (let s = 0; s < seconds; s++) {
      recordConversationWorkLog(`conv-${s % 7}`, { kind: 'narration', text: `n${s}` });
      vi.advanceTimersByTime(1_000);
    }
    vi.advanceTimersByTime(INTERVAL);

    expect(appendWorkLog).toHaveBeenCalledTimes(seconds);
    const warned = drops();
    // One immediate warn, then one summary per elapsed interval.
    expect(warned).toHaveLength(Math.ceil((seconds * 1_000) / INTERVAL) + 1);
    const summarized = warned
      .slice(1)
      .reduce((sum, [, fields]) => sum + (fields as { suppressed: number }).suppressed, 0);
    expect(1 + summarized).toBe(seconds);
  });

  it('a drop after the interval whose summary timer has not run yet joins that summary, and no second one follows', () => {
    recordConversationWorkLog('conv-a', { kind: 'notice', text: 'x' });
    vi.advanceTimersByTime(1_000);
    recordConversationWorkLog('conv-b', { kind: 'tool', text: 'y' });
    expect(vi.getTimerCount()).toBe(1);
    // The clock passes the interval without the pending timer firing.
    vi.setSystemTime(Date.now() + INTERVAL);
    recordConversationWorkLog('conv-c', { kind: 'final', text: FINAL }, { sessionKey: 'C3:c' });

    expect(drops()).toHaveLength(2);
    // The synchronous flush cancelled the pending timer.
    expect(vi.getTimerCount()).toBe(0);
    expect(drops()[1]).toEqual([
      expect.anything(),
      { suppressed: 2, conversationId: 'conv-c', kind: 'final', sessionKey: 'C3:c', error: 'store down' },
    ]);
    vi.advanceTimersByTime(10 * INTERVAL);
    expect(drops()).toHaveLength(2);
  });

  it('after a quiet interval the next failure warns immediately again', () => {
    recordConversationWorkLog('conv-a', { kind: 'notice', text: 'x' });
    vi.advanceTimersByTime(INTERVAL);
    recordConversationWorkLog('conv-b', { kind: 'error', text: 'y' }, { sessionKey: 'C2:b' });

    expect(drops()).toEqual([
      [expect.anything(), { conversationId: 'conv-a', kind: 'notice', error: 'store down' }],
      [expect.anything(), { conversationId: 'conv-b', kind: 'error', sessionKey: 'C2:b', error: 'store down' }],
    ]);
  });

  it('the reset seam cancels a pending summary', () => {
    recordConversationWorkLog('conv-a', { kind: 'notice', text: 'x' });
    recordConversationWorkLog('conv-b', { kind: 'tool', text: 'y' });
    expect(vi.getTimerCount()).toBe(1);

    resetWorkLogDropWarningsForTests();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * INTERVAL);
    expect(drops()).toHaveLength(1);
  });

  it('the summary timer is unref-ed (hasRef() === false): reporting never keeps the process alive', () => {
    // A real Node timer, so `hasRef()` is the runtime's own answer.
    vi.useRealTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      recordConversationWorkLog('conv-a', { kind: 'notice', text: 'x' });
      recordConversationWorkLog('conv-b', { kind: 'tool', text: 'y' });

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
    } finally {
      setTimeoutSpy.mockRestore();
      resetWorkLogDropWarningsForTests();
    }
  });
});
