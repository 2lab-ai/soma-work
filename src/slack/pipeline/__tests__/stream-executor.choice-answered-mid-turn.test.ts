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
 * tool_result → (answer lands) → result, and the real V1QueryAdapter →
 * TurnRunner end of turn on top of it.
 *
 * `../stream-executor` re-exports `@soma/slack`, which resolves to the BUILT
 * package (`packages/slack/dist`). Run `npm run build:packages` after editing
 * `packages/slack/src/pipeline/stream-executor.ts` — CI builds first.
 */

import { LOG_DETAIL } from '@soma/slack/output-flags';
import { ThreadSurface } from '@soma/slack/thread-surface';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentStreamFromSdk } from '../../../agent-runtime/claude-code/stream-runner';
import { TurnRunner } from '../../../agent-session/turn-runner';
import { V1QueryAdapter } from '../../../agent-session/v1-query-adapter';
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
function createDeps(
  session: any,
  streamFn: () => AsyncIterable<any>,
  answer?: () => void,
  answerOn: 'broadcast' | 'final-reaction' | 'final-status' = 'broadcast',
): any {
  let answered = false;
  let waitingStatusWrites = 0;
  const answerOnce = () => {
    if (answer && !answered) {
      answered = true;
      answer();
    }
  };
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
          if (
            answerOn === 'broadcast' &&
            session.actionPanel?.pendingQuestion &&
            session.actionPanel?.waitingForChoice
          ) {
            answerOnce();
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
    statusReporter: { getStatusEmoji: vi.fn().mockImplementation((status: string) => status) },
    reactionManager: {
      // 'waiting' is requested only by the end-of-turn reaction, right before
      // the activity transition — the last window an answer can land in.
      updateReaction: vi.fn().mockImplementation(async (_key: string, emoji: string) => {
        if (answerOn === 'final-reaction' && emoji === 'waiting') answerOnce();
      }),
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
        // The 2nd '입력 대기' status write is the end-of-turn one (the 1st is the
        // ask itself). An answer landing as it starts is the last race window.
        if (patch.agentPhase === '입력 대기' && ++waitingStatusWrites === 2 && answerOn === 'final-status')
          answerOnce();
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

function params(session: any, say = vi.fn().mockResolvedValue({ ts: 'msg_ts' })): any {
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
    say,
  };
}

const answerPath = (session: any) => () => {
  session.actionPanel.waitingForChoice = false;
  session.actionPanel.pendingChoice = undefined;
  session.actionPanel.pendingQuestion = undefined;
};

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

    const result = await new StreamExecutor(deps).execute(params(session));

    expect(states(deps)).toContain('waiting');
    expect(states(deps).at(-1)).toBe('waiting');
    expect(session.actionPanel?.waitingForChoice).toBe(true);
    expect(session.actionPanel?.pendingQuestion?.type).toBe('user_choices');
    expect(result.turnCollector?.getResult().hasPendingChoice).toBe(true);
  });

  it('T2 — a question answered before the turn ends leaves the session idle, not waiting', async () => {
    const session = createSession();
    const deps = createDeps(session, askingStream(), answerPath(session));

    const result = await new StreamExecutor(deps).execute(params(session));

    // It did wait mid-turn (the question was really open) …
    expect(states(deps)).toContain('waiting');
    // … but the turn ends on idle: nothing is left to answer.
    expect(states(deps).at(-1)).toBe('idle');
    expect(session.actionPanel?.waitingForChoice).toBe(false);
    expect(result.success).toBe(true);
    // The turn result the adapter hands to TurnRunner / the follow-up drain
    // agrees: no pending choice, so the runner does not restore
    // waitingForChoice and the drain is not held as "awaiting user choice".
    expect(result.turnCollector?.getResult().hasPendingChoice).toBe(false);
  });

  it('T2 — an answer landing during the end-of-turn status write is not re-opened', async () => {
    const session = createSession();
    const deps = createDeps(session, askingStream(), answerPath(session), 'final-status');

    const result = await new StreamExecutor(deps).execute(params(session));

    // The answer cleared the bit while the turn was writing its final status;
    // that write must not put it back, and the turn result must agree.
    expect(session.actionPanel?.waitingForChoice).toBe(false);
    expect(result.turnCollector?.getResult().hasPendingChoice).toBe(false);
  });

  it('T2 — an answer landing during the final reaction write still ends idle', async () => {
    const session = createSession();
    const deps = createDeps(session, askingStream(), answerPath(session), 'final-reaction');

    const result = await new StreamExecutor(deps).execute(params(session));

    expect(deps.reactionManager.updateReaction).toHaveBeenCalledWith(expect.anything(), 'waiting');
    expect(states(deps).at(-1)).toBe('idle');
    expect(session.actionPanel?.waitingForChoice).toBe(false);
    expect(result.turnCollector?.getResult().hasPendingChoice).toBe(false);
  });
});

// The real host path: V1QueryAdapter → StreamExecutor.execute() → the turn
// result → TurnRunner.finish() → surface.finalizeOnEndTurn. ThreadSurface's
// finalizeOnEndTurn writes `waitingForChoice: hasPendingChoice` from that turn
// result, so a stale `true` there would re-open the answered choice, and the
// host's classifyTurnOutcome would hold the follow-up drain as
// "awaiting user choice".
describe('adapter → runner end of turn after ASK_USER_QUESTION', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function runThroughAdapter(answered: boolean, duringEndTurn = false) {
    const session = createSession();
    const deps = createDeps(session, askingStream(), answered ? answerPath(session) : undefined);
    if (duringEndTurn) {
      deps.threadPanel.endTurn.mockImplementation(async () => {
        expect(session.actionPanel.waitingForChoice).toBe(true);
        answerPath(session)();
      });
    }
    const realSurface = new ThreadSurface({ requestCoordinator: {} } as any);
    vi.spyOn(realSurface as any, 'renderViaFlush').mockResolvedValue(undefined);
    const finalizeOnEndTurn = vi.fn().mockImplementation(realSurface.finalizeOnEndTurn.bind(realSurface));
    const surface = { setStatus: vi.fn().mockResolvedValue(undefined), finalizeOnEndTurn } as any;
    const adapter = new V1QueryAdapter({
      streamExecutor: new StreamExecutor(deps),
      executeParams: params(session),
      turnRunner: new TurnRunner({ threadSurface: surface, session, sessionKey: `${CHANNEL}:${THREAD_TS}` }),
    });
    const result = await adapter.startWithContinuation('hello', { shouldContinue: () => ({ continue: false }) });
    return { session, deps, result, finalizeOnEndTurn };
  }

  it('T2 — an answer landing during end-of-turn cleanup (endTurn) is not re-opened by the runner', async () => {
    const { session, result, finalizeOnEndTurn } = await runThroughAdapter(false, true);
    expect(session.actionPanel.pendingQuestion).toBeUndefined();
    expect(result.hasPendingChoice).toBe(false);
    expect(finalizeOnEndTurn.mock.lastCall?.[3]).toBe(false);
    expect(session.actionPanel.waitingForChoice).toBe(false);
  });

  it('control — unanswered: the runner keeps the choice open', async () => {
    const { session, result, finalizeOnEndTurn } = await runThroughAdapter(false);
    expect(result.hasPendingChoice).toBe(true);
    expect(finalizeOnEndTurn.mock.lastCall?.[3]).toBe(true);
    expect(session.actionPanel.waitingForChoice).toBe(true);
  });

  it('T2 — answered mid-turn: the runner does not re-open the answered choice', async () => {
    const { session, deps, result, finalizeOnEndTurn } = await runThroughAdapter(true);
    expect(result.hasPendingChoice).toBe(false);
    expect(finalizeOnEndTurn.mock.lastCall?.[3]).toBe(false);
    expect(session.actionPanel.waitingForChoice).toBe(false);
    expect(states(deps).at(-1)).toBe('idle');
  });
});

describe('end of turn after a text user_choice whose buttons failed to post', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // The model's final text carries a user_choice JSON. Posting the buttons
  // fails, so the processor falls back to a plain-text question and the
  // choice is never registered (no onChoiceCreated). The user still sees a
  // question to answer, so the session must stay waiting — the open-choice
  // bit is false here only because the turn start reset it.
  const choiceText = [
    'Pick one.',
    '```json',
    '{"type":"user_choice","question":"Which database?","choices":[{"id":"1","label":"PostgreSQL"},{"id":"2","label":"MySQL"}]}',
    '```',
  ].join('\n');

  async function* textChoiceStream() {
    yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {}, result: choiceText };
  }

  it('keeps the session waiting (the unregistered question is still unanswered)', async () => {
    const session = createSession();
    const deps = createDeps(session, textChoiceStream);
    const say = vi.fn().mockImplementation(async (msg: any) => {
      if (msg.attachments || msg.blocks) throw new Error('invalid_blocks');
      return { ts: 'msg_ts' };
    });

    const result = await new StreamExecutor(deps).execute(params(session, say));

    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Which database?') }));
    expect(deps.threadPanel.attachChoice).not.toHaveBeenCalled();
    expect(states(deps).at(-1)).toBe('waiting');
    expect(result.turnCollector?.getResult().hasPendingChoice).toBe(true);
  });
});
