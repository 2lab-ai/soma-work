/**
 * A question answered while the asking turn is still streaming must not leave
 * the session in 'waiting'.
 *
 * Field incident (2026-10-22, dev): the model ran ASK_USER_QUESTION, which
 * flips the session to 'waiting' mid-turn. The dashboard answered it a second
 * later (the answer path clears the open-choice state). When the turn then
 * ended, the end-of-turn transition re-applied 'waiting' from "this turn asked
 * a question", although no question was open any more. The session sat in the
 * dashboard's NEEDS YOU column for ~47 minutes with no answer form —
 * "답변 창이 안보임".
 *
 * Drives the REAL `execute()` over a stream: tool_use → ASK_USER_QUESTION
 * tool_result → (answer lands) → result.
 */

import { LOG_DETAIL } from '@soma/slack/output-flags';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentStreamFromSdk } from '../../../agent-runtime/claude-code/stream-runner';
import { StreamExecutor } from '../stream-executor';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
    getUserEmail: vi.fn().mockReturnValue('user@example.com'),
    setUserEmail: vi.fn(),
    ensureUserExists: vi.fn(),
    setUserSlackDisplayName: vi.fn(),
    shouldRefreshSlackIdentity: vi.fn().mockReturnValue(false),
    getUserJiraAccountId: vi.fn(),
    getUserJiraName: vi.fn(),
    getUserBypassPermission: vi.fn().mockReturnValue(false),
    getUserDefaultLogVerbosity: vi.fn().mockReturnValue('detail'),
    getUserLogVerbosityFlags: vi.fn().mockReturnValue(0),
    getUserSettings: vi.fn().mockReturnValue(undefined),
    getUserPersona: vi.fn().mockReturnValue('default'),
    getUserDefaultModel: vi.fn().mockReturnValue('claude-fable-5[1m]'),
    setUserDefaultModel: vi.fn(),
    getUserDefaultEffort: vi.fn().mockReturnValue('high'),
    getUserShowThinking: vi.fn().mockReturnValue(true),
    getUserRating: vi.fn().mockReturnValue(5),
    setUserRating: vi.fn(),
    consumePendingRatingChange: vi.fn().mockReturnValue(null),
    setPendingRatingChange: vi.fn(),
  },
  coerceToAvailableModel: (raw: string) => raw,
}));

const CHANNEL = 'C42';
const THREAD_TS = 'thread42';

const askResult = JSON.stringify({
  type: 'model_command_result',
  commandId: 'ASK_USER_QUESTION',
  ok: true,
  payload: {
    question: {
      type: 'user_choices',
      title: 'E2E',
      questions: [
        { id: 'q1', question: 'Q1', choices: [{ id: '1', label: 'a' }], recommendedChoiceId: '1' },
        { id: 'q2', question: 'Q2', choices: [{ id: '1', label: 'b' }], recommendedChoiceId: '1' },
      ],
    },
  },
});

function createSession(): any {
  return {
    sessionId: 'sess_choice',
    ownerId: 'U_TEST',
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    logVerbosity: LOG_DETAIL,
    usage: {},
    terminated: false,
  };
}

function askingStream() {
  return async function* () {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool_ask', name: 'mcp__model-command__run', input: {} }],
      },
    };
    yield {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool_ask', content: askResult }] },
    };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
  };
}

/**
 * `answer` runs the moment the question is broadcast as open (the end of
 * renderAskUserQuestionFromCommand) — the earliest point a dashboard / Slack
 * answer can land — while the asking turn is still streaming. It does to the
 * session what every answer path does (ThreadPanel.clearPendingChoiceState /
 * ThreadSurface.clearChoice + the choice handler's pendingQuestion clear).
 */
function createDeps(session: any, streamFn: () => AsyncIterable<any>, answer?: () => void): any {
  let answered = false;
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      getSessionByKey: vi.fn().mockReturnValue(session),
      streamAgentEvents: vi
        .fn()
        .mockImplementation(() => runAgentStreamFromSdk(streamFn(), { calculateTokenCost: () => 0 })),
      getSessionRegistry: vi.fn().mockReturnValue({
        beginTurn: vi.fn(),
        endTurn: vi.fn(),
        broadcastSessionUpdate: vi.fn(),
        persistAndBroadcast: vi.fn().mockImplementation(() => {
          if (answer && !answered && session.actionPanel?.pendingQuestion && session.actionPanel?.waitingForChoice) {
            answered = true;
            answer();
          }
        }),
        getActivityState: vi.fn().mockReturnValue('idle'),
      }),
    },
    fileHandler: {
      formatFilePrompt: vi.fn().mockResolvedValue(''),
      cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
    },
    toolEventProcessor: {
      handleToolUse: vi.fn().mockResolvedValue(undefined),
      // Same as ToolEventProcessor.handleToolResult: names each result from the
      // tool tracker, which is how the executor recognizes a model command.
      handleToolResult: vi.fn().mockImplementation(async (results: any[]) => {
        for (const r of results) if (r.toolUseId === 'tool_ask') r.toolName = 'mcp__model-command__run';
      }),
      setReactionManager: vi.fn(),
      setToolResultSink: vi.fn(),
      getLiveBackgroundWork: vi.fn().mockReturnValue({ count: 0, labels: [], signature: '' }),
      cleanup: vi.fn(),
    },
    statusReporter: { getStatusEmoji: vi.fn().mockReturnValue('thinking_face') },
    reactionManager: { updateReaction: vi.fn().mockResolvedValue(undefined), cleanup: vi.fn() },
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
    actionHandlers: {
      setPendingForm: vi.fn(),
      getPendingForm: vi.fn(),
      deletePendingForm: vi.fn(),
      invalidateOldForms: vi.fn().mockResolvedValue(undefined),
    },
    requestCoordinator: { removeController: vi.fn() },
    slackApi: {
      getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
      getClient: vi.fn().mockReturnValue({}),
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      getPermalink: vi.fn().mockResolvedValue('https://slack.example/p1'),
    },
    assistantStatusManager: {
      isEnabled: vi.fn().mockReturnValue(true),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      getToolStatusText: vi.fn().mockReturnValue('is running...'),
      bumpEpoch: vi.fn().mockReturnValue(42),
      buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
      registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
    },
    threadPanel: {
      beginTurn: vi.fn().mockResolvedValue(undefined),
      endTurn: vi.fn().mockResolvedValue(undefined),
      failTurn: vi.fn().mockResolvedValue(undefined),
      isTurnSurfaceActive: vi.fn().mockReturnValue(false),
      appendText: vi.fn().mockResolvedValue(true),
      // Same field write as ThreadSurface.setStatus: the open-choice bit lives
      // on session.actionPanel.waitingForChoice.
      setStatus: vi.fn().mockImplementation(async (session: any, _key: string, patch: any) => {
        session.actionPanel = session.actionPanel ?? {};
        if (typeof patch.waitingForChoice === 'boolean') session.actionPanel.waitingForChoice = patch.waitingForChoice;
        if (patch.agentPhase !== undefined) session.actionPanel.agentPhase = patch.agentPhase;
      }),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      attachChoice: vi.fn().mockResolvedValue(undefined),
      // Same P3 state write as ThreadPanel.askUserForm after the first chunk posts.
      askUserForm: vi
        .fn()
        .mockImplementation(
          async (turnId: string, _chunks: any[], formIds: string[], question: any, _a: any, s: any) => {
            s.actionPanel = s.actionPanel ?? {};
            s.actionPanel.pendingChoice = {
              turnId,
              kind: 'multi',
              choiceTs: 'form_ts',
              formIds: [...formIds],
              question,
            };
            s.actionPanel.choiceMessageTs = 'form_ts';
            s.actionPanel.waitingForChoice = true;
            return { ok: true, primaryTs: 'form_ts', allTs: ['form_ts'], formIds };
          },
        ),
      finalizeOnEndTurn: vi.fn().mockResolvedValue(undefined),
      renderTasks: vi.fn().mockResolvedValue(false),
      updateHeader: vi.fn().mockResolvedValue(undefined),
      clearChoice: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function params(session: any): any {
  return {
    session,
    sessionKey: `${CHANNEL}:${THREAD_TS}`,
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: 'hello',
    channel: CHANNEL,
    threadTs: THREAD_TS,
    user: 'U_TEST',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
  };
}

const states = (deps: any) =>
  deps.claudeHandler.setActivityState.mock.calls
    .filter((c: any[]) => c[0] === CHANNEL && c[1] === THREAD_TS)
    .map((c: any[]) => c[2]);

describe('end of turn after ASK_USER_QUESTION', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('control — an unanswered question keeps the session waiting', async () => {
    const session = createSession();
    const deps = createDeps(session, askingStream());

    await new StreamExecutor(deps).execute(params(session));

    expect(states(deps)).toContain('waiting');
    expect(states(deps).at(-1)).toBe('waiting');
    expect(session.actionPanel?.waitingForChoice).toBe(true);
    expect(session.actionPanel?.pendingQuestion?.type).toBe('user_choices');
  });

  it('T2 — a question answered before the turn ends leaves the session idle, not waiting', async () => {
    const session = createSession();
    const deps = createDeps(session, askingStream(), () => {
      session.actionPanel.waitingForChoice = false;
      session.actionPanel.pendingChoice = undefined;
      session.actionPanel.pendingQuestion = undefined;
    });

    const result = await new StreamExecutor(deps).execute(params(session));

    // It did wait mid-turn (the question was really open) …
    expect(states(deps)).toContain('waiting');
    // … but the turn ends on idle: nothing is left to answer.
    expect(states(deps).at(-1)).toBe('idle');
    expect(session.actionPanel?.waitingForChoice).toBe(false);
    expect(result.success).toBe(true);
  });
});
