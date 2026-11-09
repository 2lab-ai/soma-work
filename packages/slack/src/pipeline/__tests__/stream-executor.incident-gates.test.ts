/**
 * An incident turn is a machine asking a machine: the sender is the Eagle-eye
 * monitoring bot, which has no email, and nobody is there to name the session.
 * Two gates written for people must not apply to it.
 *
 * - The email fast-fail. Email exists for commit attribution (Co-Authored-By);
 *   an incident attempt has one read-only evidence tool and cannot commit. On
 *   2026-11-06 and 2026-11-09 every real Eagle incident (CHECK stage2 bo,
 *   CHECK stage2 front, EXT CRYPTO API, EXT NUPRO365) was accepted by the
 *   ingress and then died here, before the model was called.
 * - The session-title-pending notice. It asks the model to call UPDATE_SESSION,
 *   a tool the isolated incident runtime does not have, and it was prepended to
 *   the fixed host prompt the incident contract publishes byte for byte.
 *
 * Harness copied from `stream-executor.incident-output.test.ts`, with the email
 * the Eagle bot actually has: the empty sentinel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentRequest } from '../../incident-contract';
import { buildHostFailureResult, renderIncidentResult } from '../../incident-result';
import { LOG_DETAIL } from '../../output-flags';
import { AgentStreamProcessor, type StreamContext } from '../../stream-processor';
import { StreamExecutor, setStreamExecutorProviders } from '../stream-executor';

setStreamExecutorProviders({
  userSettingsStore: {
    getUserSessionTheme: () => 'D',
    // The Eagle bot's real settings row: Slack has no email for a bot user, so
    // the profile fetch stored the empty sentinel (2026-11-06 production).
    getUserEmail: () => '',
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

const CHANNEL = 'C0EAGLE123';
const THREAD = '1757500000.000100';
const SESSION_KEY = `${CHANNEL}:${THREAD}`;

const REQUEST: IncidentRequest = {
  version: 1,
  incident_id: 'HOST-projalpha-dev2-api-unreachable',
  lifecycle_id: 'LC-2026-09-11-0007',
  attempt_id: 'AT-2026-09-11-0007-1',
  channel_id: CHANNEL,
  parent_ts: THREAD,
  env: 'dev2',
  summary: 'projalpha-dev2-api is unreachable',
};

/**
 * The shape the incident runtime emits: human lines that echo a model summary,
 * then the one marker line.
 */
function hostOutputWithSummary(summary: string): string {
  const markerLine = renderIncidentResult({
    ...buildHostFailureResult(REQUEST, 'inconclusive', 'missing_marker'),
    summary,
  });
  return [
    `Eagle incident ${REQUEST.incident_id} · attempt ${REQUEST.attempt_id} — inconclusive`,
    `summary: ${summary}`,
    'proposal: none',
    markerLine,
  ].join('\n');
}

/** Here the summary is a `channel_message` directive. */
const DIRECTIVE = JSON.stringify({ type: 'channel_message', text: 'review-canary' });
const HOST_OUTPUT = hostOutputWithSummary(DIRECTIVE);

function createDeps(turnText: string = HOST_OUTPUT): any {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      setSessionLinks: vi.fn(),
      addSourceWorkingDir: vi.fn(),
      // The assistant message and the SDK result carry the same text, exactly as
      // `buildIncidentTerminalMessages` emits them.
      streamAgentEvents: vi.fn().mockImplementation(() =>
        (async function* () {
          yield { type: 'assistant_delta', text: turnText };
          yield { type: 'result', stopReason: 'end_turn', finalText: turnText };
        })(),
      ),
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
      getUserProfile: vi.fn().mockResolvedValue({ email: undefined, displayName: 'Eagle' }),
      getClient: vi.fn().mockReturnValue({}),
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      // The `channel_message` directive's only effect: a post to the channel ROOT.
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

function createSession(incidentRequest?: IncidentRequest, extra: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess_incident',
    ownerId: 'U_EAGLE',
    title: 'incident attempt',
    logVerbosity: LOG_DETAIL,
    usage: {},
    terminated: false,
    ...(incidentRequest ? { incidentRequest } : {}),
    ...extra,
  };
}

function createParams(session: any): any {
  return {
    session,
    sessionKey: SESSION_KEY,
    userName: 'eagle-eye',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: 'An Eagle-eye monitoring alert opened this thread and requested an incident report.',
    channel: CHANNEL,
    threadTs: THREAD,
    user: 'U_EAGLE',
    isUserInput: true,
    say: vi.fn().mockResolvedValue({ ts: 'm' }),
  };
}

/** Let the fire-and-forget liveness writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('StreamExecutor — gates written for people do not stop an incident turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs an incident turn whose sender has no email', async () => {
    const deps = createDeps();
    const params = createParams(createSession(REQUEST));

    const result = await new StreamExecutor(deps).execute(params);
    await settle();

    expect(deps.claudeHandler.streamAgentEvents).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    const exceptions = deps.turnNotifier.notify.mock.calls.filter((call: any[]) => call[0]?.category === 'Exception');
    expect(exceptions).toHaveLength(0);
  });

  it('control: an ordinary turn from a sender with no email is still blocked', async () => {
    const deps = createDeps('an ordinary answer');
    const params = createParams(createSession());

    const result = await new StreamExecutor(deps).execute(params);
    await settle();

    expect(result.success).toBe(false);
    expect(deps.claudeHandler.streamAgentEvents).not.toHaveBeenCalled();
    expect(deps.turnNotifier.notify).toHaveBeenCalledWith(expect.objectContaining({ category: 'Exception' }));
  });

  it('never prepends the session-title notice to an incident prompt', async () => {
    const deps = createDeps();
    // The title the ingress gives an incident session (`skipDispatch`) is a
    // host stand-in, so the ordinary rule would fire.
    const params = createParams(createSession(REQUEST, { title: 'Direct (skipDispatch)' }));

    await new StreamExecutor(deps).execute(params);
    await settle();

    expect(deps.claudeHandler.streamAgentEvents).toHaveBeenCalledTimes(1);
    const prompt: string = deps.claudeHandler.streamAgentEvents.mock.calls[0][0];
    expect(prompt).not.toContain('<session-title-pending>');
    expect(prompt).toContain('An Eagle-eye monitoring alert opened this thread');
    expect(params.session.titleNoticeCount ?? 0).toBe(0);
  });
});
