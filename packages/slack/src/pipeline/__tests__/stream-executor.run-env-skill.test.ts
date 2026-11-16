/**
 * #1304 — RUN_ENV_SKILL host-apply. The model-command server only checks the shape and echoes; the HOST hands the
 * request to its `handOffEnvironmentSkill` provider (src: SkillForceHandler, the typed path) as the TURN's user, in the
 * session's thread, once per tool result. Its outcome is recorded in the work log; nothing is posted from here (the
 * typed path posts what it posts, a rejection posts nothing).
 *
 * Harness: the minimal fake surface of stream-executor.user-actions.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_DETAIL } from '../../output-flags';
import { StreamExecutor, setStreamExecutorProviders } from '../stream-executor';

const handOffEnvironmentSkill = vi.fn(async (_req: any) => ({ status: 'started' as const, owner: 'env:acme-dev2' }));
const appendWorkLog = vi.fn();

/** Every fixture here carries one model-command result JSON block (a content array or its text item). */
const parseRun = (raw: any) => JSON.parse(typeof raw === 'string' ? raw : (raw.text ?? (raw.content ?? raw)[0].text));

setStreamExecutorProviders({
  parseModelCommandRunResponse: parseRun,
  handOffEnvironmentSkill,
  appendWorkLog,
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

function createDeps(streamFn: () => AsyncIterable<any>): any {
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
    text: 'QA 단계 진행',
    channel: 'C42',
    threadTs: 'thread42',
    user: 'U_TEST',
    isUserInput: true,
    say: vi.fn().mockResolvedValue({ ts: 'm' }),
  };
}

function stream(...events: any[]) {
  return () =>
    (async function* () {
      yield* events;
      yield { type: 'result', stopReason: 'end_turn' };
    })();
}

const RUN_TOOL = 'mcp__model-command__run';

function runEnvSkillResult(id: string): any {
  return {
    type: 'tool_result',
    toolCallId: id,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          type: 'model_command_result',
          commandId: 'RUN_ENV_SKILL',
          ok: true,
          payload: {
            status: 'submitted',
            skill: '$acme-dev2:qa-dev2',
            text: 'QA 1.4.0..1.4.2',
            request: '$acme-dev2:qa-dev2 QA 1.4.0..1.4.2',
            next: '…',
          },
        }),
      },
    ],
  };
}

function runToolResult(toolUseId: string, isError?: boolean): any {
  return {
    toolUseId,
    toolName: RUN_TOOL,
    result: runEnvSkillResult(toolUseId).content,
    ...(isError !== undefined ? { isError } : {}),
  };
}

function directContext(over: Record<string, unknown> = {}): any {
  return {
    channel: 'C42',
    threadTs: 'thread42',
    sessionKey: SESSION_KEY,
    turnUser: 'U_TURN',
    say: vi.fn().mockResolvedValue({ ts: 'm' }),
    workLog: vi.fn(),
    ...over,
  };
}

describe('StreamExecutor — RUN_ENV_SKILL host-apply (#1304)', () => {
  beforeEach(() => {
    handOffEnvironmentSkill.mockClear();
    handOffEnvironmentSkill.mockResolvedValue({ status: 'started', owner: 'env:acme-dev2' });
  });

  it("a turn's RUN_ENV_SKILL reaches the provider as that turn's user, in the session's thread", async () => {
    const session = createSession();
    const deps = createDeps(
      stream({ type: 'tool_call', toolCallId: 'tu-1', name: RUN_TOOL, input: {} }, runEnvSkillResult('tu-1')),
    );
    deps.toolEventProcessor.handleToolResult.mockImplementation(async (results: any[]) => {
      for (const r of results) r.toolName ??= RUN_TOOL;
    });
    const executor = new StreamExecutor(deps);
    // A cron fire injects as the job owner: the turn's user is the event's user, not a fixed session field.
    const params = { ...createParams(session, new AbortController()), user: 'U_CRON_OWNER' };

    await executor.execute(params);

    expect(handOffEnvironmentSkill).toHaveBeenCalledTimes(1);
    expect(handOffEnvironmentSkill.mock.calls[0][0]).toEqual({
      toolUseId: 'tu-1',
      skill: '$acme-dev2:qa-dev2',
      text: 'QA 1.4.0..1.4.2',
      user: 'U_CRON_OWNER',
      channel: 'C42',
      threadTs: 'thread42',
      sessionKey: SESSION_KEY,
    });
  });

  it('records the outcome in the work log and posts nothing itself', async () => {
    handOffEnvironmentSkill.mockResolvedValueOnce({ status: 'rejected', reason: 'not an environment user' } as any);
    const executor = new StreamExecutor(createDeps(stream()));
    const context = directContext();

    await (executor as any).handleModelCommandToolResults([runToolResult('tu-9')], createSession(), context);

    expect(handOffEnvironmentSkill).toHaveBeenCalledTimes(1);
    expect(context.say).not.toHaveBeenCalled();
    const logged = JSON.stringify(context.workLog.mock.calls);
    expect(logged).toContain('RUN_ENV_SKILL');
    expect(logged).toContain('rejected');
    expect(logged).toContain('not an environment user');
  });

  it('fails closed without a turn user: no hand-off', async () => {
    const executor = new StreamExecutor(createDeps(stream()));
    const context = directContext({ turnUser: undefined });

    await (executor as any).handleModelCommandToolResults([runToolResult('tu-2')], createSession(), context);

    expect(handOffEnvironmentSkill).not.toHaveBeenCalled();
    expect(JSON.stringify(context.workLog.mock.calls)).toContain('RUN_ENV_SKILL');
  });

  it('a wire-level error result is not run (the model was told the call failed)', async () => {
    const executor = new StreamExecutor(createDeps(stream()));
    const context = directContext();

    await (executor as any).handleModelCommandToolResults([runToolResult('tu-3', true)], createSession(), context);

    expect(handOffEnvironmentSkill).not.toHaveBeenCalled();
  });

  it('a provider that throws does not break the tool batch, and the failure is posted — never silent', async () => {
    handOffEnvironmentSkill.mockRejectedValueOnce(new Error('boom'));
    const executor = new StreamExecutor(createDeps(stream()));
    const context = directContext();

    await expect(
      (executor as any).handleModelCommandToolResults([runToolResult('tu-4')], createSession(), context),
    ).resolves.toMatchObject({ hasPendingChoice: false });
    expect(JSON.stringify(context.workLog.mock.calls)).toContain('boom');
    // The model was told `submitted` and promised a host turn the host can no longer send: the thread hears it.
    const posted = context.say.mock.calls.map((c: any[]) => c[0]?.text ?? '').join('\n');
    expect(posted).toContain('RUN_ENV_SKILL');
    expect(posted).toContain('boom');
  });

  it('a failed (ok:false) RUN_ENV_SKILL never reaches the provider', async () => {
    const executor = new StreamExecutor(createDeps(stream()));
    const context = directContext();
    const failed = {
      toolUseId: 'tu-5',
      toolName: RUN_TOOL,
      result: [
        {
          type: 'text',
          text: JSON.stringify({
            type: 'model_command_result',
            commandId: 'RUN_ENV_SKILL',
            ok: false,
            error: { code: 'CONTEXT_ERROR', message: 'No Slack thread for this turn' },
          }),
        },
      ],
    };

    await (executor as any).handleModelCommandToolResults([failed], createSession(), context);

    expect(handOffEnvironmentSkill).not.toHaveBeenCalled();
  });
});
