/**
 * An incident-owned session's turn output is published, never interpreted.
 *
 * The incident runtime replaces everything the model wrote with one host-authored
 * message (`src/incident/attempt-output.ts`), but that message still echoes model
 * strings — the validated `summary` and the proposal's action. The processor
 * reads ordinary assistant text for instructions: a `channel_message` JSON posts
 * to the channel ROOT, `session_links` rewrites session metadata, a choice JSON
 * renders buttons. None of that may fire on an incident turn.
 *
 * The processor-level property is proven in
 * `src/incident/__tests__/attempt-output.slack-boundary.test.ts`. This file proves
 * the wiring: that `StreamExecutor` actually tells the processor the turn is an
 * incident attempt when, and only when, the session owns an incident request.
 * Harness shape copied from `stream-executor.steer-lifecycle.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentRequest } from '../../incident-contract';
import { buildHostFailureResult, renderIncidentResult } from '../../incident-result';
import { LOG_DETAIL } from '../../output-flags';
import { StreamExecutor, setStreamExecutorProviders } from '../stream-executor';

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
 * then the one marker line. Here the summary is a `channel_message` directive.
 */
const DIRECTIVE = JSON.stringify({ type: 'channel_message', text: 'review-canary' });
const MARKER_LINE = renderIncidentResult({
  ...buildHostFailureResult(REQUEST, 'inconclusive', 'missing_marker'),
  summary: DIRECTIVE,
});
const HOST_OUTPUT = [
  `Eagle incident ${REQUEST.incident_id} · attempt ${REQUEST.attempt_id} — inconclusive`,
  `summary: ${DIRECTIVE}`,
  'proposal: none',
  MARKER_LINE,
].join('\n');

function createDeps(): any {
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
          yield { type: 'assistant_delta', text: HOST_OUTPUT };
          yield { type: 'result', stopReason: 'end_turn', finalText: HOST_OUTPUT };
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
    },
    slackApi: {
      getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
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

function createSession(incidentRequest?: IncidentRequest): any {
  return {
    sessionId: 'sess_incident',
    ownerId: 'U_EAGLE',
    title: 'incident attempt',
    logVerbosity: LOG_DETAIL,
    usage: {},
    terminated: false,
    ...(incidentRequest ? { incidentRequest } : {}),
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

describe('StreamExecutor — an incident turn publishes the host text and interprets none of it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('posts nothing to the channel root and publishes the conclusion exactly once', async () => {
    const deps = createDeps();
    const params = createParams(createSession(REQUEST));

    const result = await new StreamExecutor(deps).execute(params);
    await settle();

    expect(result.success).toBe(true);
    expect(deps.slackApi.postMessage).not.toHaveBeenCalled();
    expect(deps.claudeHandler.setSessionLinks).not.toHaveBeenCalled();
    expect(deps.claudeHandler.addSourceWorkingDir).not.toHaveBeenCalled();
    // One publication, carrying the host's text untouched.
    expect(deps.threadPanel.appendText.mock.calls.map((call: any[]) => call[1])).toEqual([HOST_OUTPUT]);
  });

  // Control: the same text on an ordinary session still drives the directive —
  // proves the test above is exercising the incident switch, not a dead path.
  it('control: an ordinary session still honors the directive', async () => {
    const deps = createDeps();
    const params = createParams(createSession());

    await new StreamExecutor(deps).execute(params);
    await settle();

    expect(deps.slackApi.postMessage).toHaveBeenCalledWith(CHANNEL, 'review-canary', {});
  });
});
