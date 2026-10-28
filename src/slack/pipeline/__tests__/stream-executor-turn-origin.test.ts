/**
 * Stream executor — who put a user turn there (dashboard SSOT 2026-10-27 T1).
 * Mocks mirror stream-executor-user-media.test.ts.
 *
 * A person's message records `origin.by = 'user'`; a host turn (synthetic event
 * or continuation, `isUserInput === false`) and the threshold auto-compact (the
 * user's event, its text swapped for `/compact`, the words parked on
 * `pendingUserText`) record `'system'`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentStreamFromSdk } from '../../../agent-runtime/claude-code/stream-runner';

// epic #1023 P4: the executor now consumes `claudeHandler.streamAgentEvents`
// (neutral AgentStreamEvents) instead of `streamQuery` (SDKMessage). These mocks
// still produce SDKMessage streams; wrap them through the real mapper so the
// executor receives the same events production does.
function toAgentEvents(sdkStream: AsyncIterable<any>): AsyncIterable<any> {
  return runAgentStreamFromSdk(sdkStream, { calculateTokenCost: () => 0 });
}

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
    getUserEmail: vi.fn().mockReturnValue(undefined),
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
    getUserDefaultModel: vi.fn().mockReturnValue('claude-opus-4-6'),
    setUserDefaultModel: vi.fn(),
    getUserDefaultEffort: vi.fn().mockReturnValue('high'),
    getUserShowThinking: vi.fn().mockReturnValue(true),
    getUserRating: vi.fn().mockReturnValue(5),
    setUserRating: vi.fn(),
    consumePendingRatingChange: vi.fn().mockReturnValue(null),
    setPendingRatingChange: vi.fn(),
  },
  // `coerceToAvailableModel` is a pure function — pass-through is sufficient
  // for tests that never exercise the AVAILABLE_MODELS allowlist guard.
  coerceToAvailableModel: (raw: string) => raw,
  // Auto fallback compact (prompt-too-long): the wrapper resolves the
  // configured alias (default `opus[1m]`) through MODEL_ALIASES before
  // handing it to packages/slack. Only the alias the default uses is needed.
  MODEL_ALIASES: { 'opus[1m]': 'claude-opus-4-8[1m]' },
}));

vi.mock('../../../channel-description-cache', () => ({
  getChannelDescription: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../../channel-registry', () => ({
  getChannel: vi.fn().mockReturnValue(undefined),
}));

// W3-B: claude-usage.ts was removed; usage fetching now goes through
// TokenManager.fetchAndStoreUsage() which is mocked via the token-manager
// module mock below.

const { order, ATTACHMENTS } = vi.hoisted(() => ({
  order: [] as string[],
  ATTACHMENTS: [
    { id: '01MEDIA', name: 'login.png', kind: 'image', mime: 'image/png', size: 4, stored: true, slackFileId: 'F1' },
  ],
}));
vi.mock('../../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv_1'),
  recordAssistantTurn: vi.fn(),
  recordUserTurn: vi.fn(() => {
    order.push('record');
  }),
  captureUserMedia: vi.fn(async () => {
    order.push('capture');
    return ATTACHMENTS;
  }),
}));

vi.mock('../../../mcp-config-builder', () => ({
  isMidThreadMention: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../metrics/event-emitter', () => ({
  getMetricsEmitter: vi.fn().mockReturnValue({
    emit: vi.fn(),
  }),
}));

vi.mock('../../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue(null),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));

// W3-B: token-manager now exposes `getTokenManager()` returning a
// TokenManager instance with slotId-keyed APIs. We stub only the subset
// that stream-executor actually calls.
//
// rotateOnRateLimit's contract returns `RotateOnRateLimitResult`
// (`{ rotated, skipReason? }`), so the mock must default to a discriminated
// no-op rather than a bare `null` — `tryRotateToken` reads `result.rotated`
// and would NPE on a null return.
const rotateOnRateLimitMock = vi.fn().mockResolvedValue({
  rotated: null,
  skipReason: 'no-eligible',
});
const fetchAndStoreUsageMock = vi.fn().mockResolvedValue(null);
const getActiveTokenMock = vi.fn().mockReturnValue(null);
const listTokensMock = vi.fn().mockReturnValue([]);

vi.mock('../../../token-manager', () => ({
  getTokenManager: () => ({
    getActiveToken: getActiveTokenMock,
    listTokens: listTokensMock,
    rotateOnRateLimit: rotateOnRateLimitMock,
    fetchAndStoreUsage: fetchAndStoreUsageMock,
  }),
  // Default to `null` (the production type signature is `Date | null`) so
  // the new `parsedCooldown !== null` check in tryRotateToken behaves the
  // same in tests as in production. Individual tests that need a parsed
  // cooldown override with `vi.mocked(parseCooldownTime).mockReturnValueOnce(...)`.
  parseCooldownTime: vi.fn().mockReturnValue(null),
}));

import { LOG_DETAIL } from '@soma/slack/output-flags';
import { recordUserTurn } from '../../../conversation';
import { StreamExecutor } from '../stream-executor';

describe('T1.1 — the recorded user turn says who put it there', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
  });

  async function* okStream() {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
  }

  function createDeps() {
    return {
      claudeHandler: {
        setActivityState: vi.fn(),
        clearSessionId: vi.fn(),
        streamQuery: vi.fn().mockImplementation(() => okStream()),
        streamAgentEvents: vi.fn().mockImplementation(() => toAgentEvents(okStream())),
        getSessionRegistry: vi.fn().mockReturnValue({
          beginTurn: vi.fn(),
          endTurn: vi.fn(),
          broadcastSessionUpdate: vi.fn(),
          getActivityState: vi.fn().mockReturnValue('idle'),
        }),
      },
      fileHandler: {
        formatFilePrompt: vi.fn().mockResolvedValue('Please analyze the uploaded files.'),
        cleanupTempFiles: vi.fn(async () => {
          order.push('cleanup');
        }),
      },
      toolEventProcessor: {
        handleToolUse: vi.fn().mockResolvedValue(undefined),
        handleToolResult: vi.fn().mockResolvedValue(undefined),
        setReactionManager: vi.fn(),
        setToolResultSink: vi.fn(),
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
      requestCoordinator: { removeController: vi.fn() },
      slackApi: {
        getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
        getClient: vi.fn().mockReturnValue({}),
        getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
        deleteMessage: vi.fn().mockResolvedValue(undefined),
      },
      assistantStatusManager: {
        setStatus: vi.fn().mockResolvedValue(undefined),
        clearStatus: vi.fn().mockResolvedValue(undefined),
        getToolStatusText: vi.fn().mockReturnValue('running tool...'),
        bumpEpoch: vi.fn().mockReturnValue(1),
        buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      },
      turnNotifier: { notify: vi.fn().mockResolvedValue(undefined) },
      threadPanel: undefined,
    } as any;
  }

  function params(text: string, extra: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
    return {
      session: {
        sessionId: 'sess_origin',
        ownerId: 'U_TEST',
        logVerbosity: LOG_DETAIL,
        usage: {},
        terminated: false,
        conversationId: 'conv_origin',
        ...session,
      },
      sessionKey: 'C777:thread777',
      userName: 'testuser',
      workingDirectory: '/tmp/test',
      abortController: new AbortController(),
      processedFiles: [],
      text,
      channel: 'C777',
      threadTs: 'thread777',
      user: 'U_TEST',
      say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
      ...extra,
    } as any;
  }
  const originOf = () => vi.mocked(recordUserTurn).mock.calls[0]?.[5];

  it('a person typed it → user', async () => {
    await new StreamExecutor(createDeps()).execute(params('대시보드 고쳐줘', { isUserInput: true }));
    expect(vi.mocked(recordUserTurn)).toHaveBeenCalledWith(
      'conv_origin',
      '대시보드 고쳐줘',
      'testuser',
      'U_TEST',
      undefined,
      { origin: { by: 'user' } },
    );
  });

  it('a synthetic / continuation turn (isUserInput false) → system', async () => {
    const text =
      '[goal-continuation] Continue working toward the active session goal (objective in <session-goal>). Auto-continuation 2/10.';
    await new StreamExecutor(createDeps()).execute(params(text, { isUserInput: false }));
    expect(originOf()).toEqual({ origin: { by: 'system' } });
  });

  it('a host turn replayed after a compaction (hostTurn, through the user-message path) → system', async () => {
    const text =
      '[goal-continuation] Continue working toward the active session goal (objective in <session-goal>). Auto-continuation 3/10.';
    await new StreamExecutor(createDeps()).execute(params(text, { isUserInput: true, hostTurn: true }));
    expect(originOf()).toEqual({ origin: { by: 'system' } });
  });

  it('the threshold auto-compact (user event, text swapped, words parked) → system', async () => {
    await new StreamExecutor(createDeps()).execute(
      params('/compact', { isUserInput: true }, { pendingUserText: '원래 보낸 메시지' }),
    );
    expect(vi.mocked(recordUserTurn).mock.calls[0]?.[1]).toBe('/compact');
    expect(originOf()).toEqual({ origin: { by: 'system' }, compact: true });
  });

  it('a /compact the user asked for (nothing parked) → user', async () => {
    await new StreamExecutor(createDeps()).execute(params('/compact', { isUserInput: true }));
    expect(originOf()).toEqual({ origin: { by: 'user' }, compact: true });
  });

  it('/compact with instructions runs as the SDK command → a compaction turn', async () => {
    await new StreamExecutor(createDeps()).execute(params('/compact 인증 쪽 위주로', { isUserInput: true }));
    expect(originOf()).toEqual({ origin: { by: 'user' }, compact: true });
  });

  it("a goal objective that starts with /compact (literalPrompt) is the user's words, not a compaction", async () => {
    await new StreamExecutor(createDeps()).execute(
      params('/compact 명령의 버그를 고쳐라', { isUserInput: true, literalPrompt: true }),
    );
    expect(originOf()).toEqual({ origin: { by: 'user' } });
  });
});
