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
  incident_id: 'HOST-gucci-dev2-api-unreachable',
  lifecycle_id: 'LC-2026-09-11-0007',
  attempt_id: 'AT-2026-09-11-0007-1',
  channel_id: CHANNEL,
  parent_ts: THREAD,
  env: 'dev2',
  summary: 'gucci-dev2-api is unreachable',
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

/**
 * After the stream ends, the executor reads the turn's collected text for
 * transport errors that arrived disguised as content (rate limits, a usage cap,
 * an overflow, a poisoned transcript) and converts each into a thrown error, so
 * `handleError` rotates the credential and/or schedules a retry.
 *
 * An incident turn's collected text is the host conclusion echoing the model's
 * summary, so a summary that merely QUOTES one of those phrases used to rotate a
 * credential and re-run an unattended attempt. Each case below must leave the
 * turn alone on an incident session — and, as the control, still trip the guard
 * on an ordinary session with the very same text.
 */
interface GuardedTurn {
  readonly shape: string;
  readonly turnText: string;
  /** What the guard costs on an ORDINARY session — the control pins it down. */
  readonly ordinary: { readonly rotates: boolean; readonly retries: boolean; readonly fallbackCompact: boolean };
}

const GUARDED_TURNS: readonly GuardedTurn[] = [
  {
    // A cap notice from `packages/common/src/rate-limit.ts` CAP_NOTICE_PATTERNS.
    shape: 'a usage-cap notice',
    turnText: hostOutputWithSummary('Claude usage limit reached on the build runner at 10:30Z'),
    ordinary: { rotates: true, retries: true, fallbackCompact: false },
  },
  {
    shape: 'a pool rate-limit rejection',
    turnText: hostOutputWithSummary(
      'Request rejected (429) · All 3 eligible accounts are rate-limited right now; retry in 5s',
    ),
    ordinary: { rotates: false, retries: true, fallbackCompact: false },
  },
  {
    shape: 'an empty-text-block 400',
    turnText: hostOutputWithSummary('API Error: 400 messages: text content blocks must be non-empty'),
    ordinary: { rotates: false, retries: false, fallbackCompact: false },
  },
  {
    // That guard only reads texts of at most 160 chars, and a host conclusion is
    // always longer, so the phrase is fed bare: this case proves the executor's
    // decision, not that the real conclusion could reach it.
    shape: 'a prompt-too-long phrase',
    turnText: 'Prompt is too long',
    ordinary: { rotates: false, retries: true, fallbackCompact: true },
  },
];

describe('StreamExecutor — an incident turn is never read as a disguised transport error', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runTurn(turnText: string, incidentRequest?: IncidentRequest) {
    const deps = createDeps(turnText);
    const executor = new StreamExecutor(deps);
    const handleError = vi.spyOn(executor as any, 'handleError');
    // Never touch real credentials, in either arm.
    const tryRotateToken = vi.spyOn(executor as any, 'tryRotateToken').mockResolvedValue(undefined);
    // A recent repair stamp keeps the empty-block guard off the transcript files.
    const session = createSession(incidentRequest, { transcriptRepairAttemptedAtMs: Date.now() });
    const result = await executor.execute(createParams(session));
    await settle();
    return { deps, result, handleError, tryRotateToken };
  }

  for (const { shape, turnText, ordinary } of GUARDED_TURNS) {
    it(`does not throw, rotate or schedule a retry for ${shape}`, async () => {
      const { result, handleError, tryRotateToken } = await runTurn(turnText, REQUEST);

      expect(handleError).not.toHaveBeenCalled();
      expect(tryRotateToken).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
      expect(result.fallbackCompact).toBeFalsy();
    });

    it(`control: an ordinary session still trips the guard for ${shape}`, async () => {
      const { result, handleError, tryRotateToken } = await runTurn(turnText);

      expect(handleError).toHaveBeenCalledTimes(1);
      expect(String((handleError.mock.calls[0][0] as Error).message)).toMatch(/surfaced as turn content/);
      expect(tryRotateToken.mock.calls.length > 0).toBe(ordinary.rotates);
      expect(result.retryAfterMs !== undefined).toBe(ordinary.retries);
      expect(Boolean(result.fallbackCompact)).toBe(ordinary.fallbackCompact);
    });
  }
});
