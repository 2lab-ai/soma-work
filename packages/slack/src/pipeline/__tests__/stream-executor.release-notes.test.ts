/**
 * `release_notes` wiring: the executor hands every valid directive to the poster,
 * and consults the operator's routing (SOMA_RELEASE_NOTES_CHANNELS, injected as
 * `routeReleaseNotes`) ONLY in a deploy-workflow session — any other session
 * echoing the directive posts in its own channel, like `channel_message`.
 * Harness shape copied from `stream-executor.incident-output.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const CHANNEL = 'C0INFRA0001';
const THREAD = '1757500000.000100';
const SESSION_KEY = `${CHANNEL}:${THREAD}`;

function createDeps(turnText: string): any {
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
      getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
      getClient: vi.fn().mockReturnValue({}),
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      // The `channel_message` directive's only effect: a post to the channel ROOT.
      postMessage: vi.fn().mockResolvedValue({ ts: '1757500009.000100' }),
      getPermalink: vi.fn().mockResolvedValue('https://slack.test/p1757500009000100'),
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

function createSession(extra: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess_deploy',
    ownerId: 'U_DEPLOYER',
    title: 'App develop -> deploy/dev2',
    logVerbosity: LOG_DETAIL,
    usage: {},
    terminated: false,
    ...extra,
  };
}

function createParams(session: any): any {
  return {
    session,
    sessionKey: SESSION_KEY,
    userName: 'deployer',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: 'App develop -> dev2',
    channel: CHANNEL,
    threadTs: THREAD,
    user: 'U_DEPLOYER',
    isUserInput: true,
    say: vi.fn().mockResolvedValue({ ts: 'm' }),
  };
}

/** Let the fire-and-forget liveness writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const DEV2 = 'C0DEV2CHAN1';
const NOTES = JSON.stringify({
  type: 'release_notes',
  repo: 'acme/App',
  target: 'deploy/dev2',
  version: '0.2.58 (c8a026e)',
  tldr: ['one', 'two', 'three'],
  text: '# Release Notes (English)\n\n- one',
});

describe('StreamExecutor — release_notes directive', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('a deploy session routes the notes to the mapped channel: header at its root, notes in its thread, link here', async () => {
    const routeReleaseNotes = vi.fn().mockReturnValue({
      destination: { kind: 'channel', channel: DEV2 },
      unmapped: false,
      keys: [],
      nearMisses: [],
      invalid: [],
    });
    const deps = { ...createDeps(`Merged.\n${NOTES}`), routeReleaseNotes };

    await new StreamExecutor(deps).execute(createParams(createSession({ workflow: 'deploy' })));
    await settle();

    expect(routeReleaseNotes).toHaveBeenCalledWith('acme/App', 'deploy/dev2');
    const posts = deps.slackApi.postMessage.mock.calls;
    expect(posts[0][0]).toBe(DEV2);
    expect(posts[0][2].blocks[0].type).toBe('header');
    expect(posts[1][0]).toBe(DEV2);
    expect(posts[1][2].threadTs).toBe('1757500009.000100');
    expect(posts[2][0]).toBe(CHANNEL);
    expect(posts[2][2]).toEqual({ threadTs: THREAD });
    // The raw directive never reaches the thread.
    const said = deps.threadPanel.appendText.mock.calls.map((call: unknown[]) => String(call[1])).join('\n');
    expect(said).not.toContain('"release_notes"');
  });

  it('any other session ignores the routing and posts in its own channel', async () => {
    const routeReleaseNotes = vi.fn().mockReturnValue({
      destination: { kind: 'channel', channel: DEV2 },
      unmapped: false,
      keys: [],
      nearMisses: [],
      invalid: [],
    });
    const deps = { ...createDeps(`Merged.\n${NOTES}`), routeReleaseNotes };

    await new StreamExecutor(deps).execute(createParams(createSession({ workflow: 'default' })));
    await settle();

    expect(routeReleaseNotes).not.toHaveBeenCalled();
    const channels = deps.slackApi.postMessage.mock.calls.map((call: unknown[]) => call[0]);
    expect(channels).not.toContain(DEV2);
    expect(channels[0]).toBe(CHANNEL);
  });

  it('a host without routing wired posts in the session channel', async () => {
    const deps = createDeps(`Merged.\n${NOTES}`);

    const result = await new StreamExecutor(deps).execute(createParams(createSession({ workflow: 'deploy' })));
    await settle();

    expect(result.success).toBe(true);
    expect(deps.slackApi.postMessage.mock.calls[0][0]).toBe(CHANNEL);
    expect(deps.slackApi.postMessage.mock.calls[0][2].threadTs).toBeUndefined();
  });

  it('a poster failure never fails the turn', async () => {
    const deps = createDeps(`Merged.\n${NOTES}`);
    deps.slackApi.postMessage.mockRejectedValue(new Error('boom'));

    const result = await new StreamExecutor(deps).execute(createParams(createSession({ workflow: 'deploy' })));
    await settle();

    expect(result.success).toBe(true);
  });
});
