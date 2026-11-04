/**
 * ssot-task: T1 · T2 · T4 — an Anthropic safeguards flag stops the work at
 * once and is shown as a safeguard error.
 *
 * Field log (dev, 2026-11-04T00:42Z): Claude Code returned the block as the
 * turn's text with a SUCCESSFUL result (`stopReason: end_turn`,
 * `isError: false`). Nothing threw, so the raw text posted as the answer and
 * the goal loop re-ran the blocked session. These tests pin the cure: the
 * text becomes a typed error, `handleError` halts the session (no retry), and
 * every surface says "세이프가드 에러".
 */
import { receiptIssuedAt } from 'somalib/model-commands/host-receipt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv_1'),
  recordAssistantTurn: vi.fn(),
  recordUserTurn: vi.fn(),
  captureUserMedia: vi.fn(async () => []),
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

import { getVerbosityFlags, LOG_DETAIL, LOG_MINIMAL, OutputFlag } from '@soma/slack/output-flags';
import type { Continuation } from '../../../types';
import { userSettingsStore } from '../../../user-settings-store';
import { type ExecuteResult, StreamExecutor } from '../stream-executor';

const SAFEGUARD_TEXT = `API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Opus 5.5 (1M context).

Try rephrasing the request in a new session or change your model.

Learn more: https://support.claude.com/en/articles/8106465

Details: \`[reasoning_extraction]\`

Request ID: req_011CggxYZxQ7TEBU95XW3X19

Message ID: msg_011CggxYckLHkHA9sUKftEWG`;

async function* safeguardAsContentStream() {
  yield { type: 'assistant', message: { content: [{ type: 'text', text: SAFEGUARD_TEXT }] } };
  yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
}

async function* safeguardThrownStream(): AsyncGenerator<any> {
  throw new Error(`Claude Code process exited with code 1\n${SAFEGUARD_TEXT}`);
}

function createDeps(stream: () => AsyncIterable<any>) {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      streamQuery: vi.fn().mockImplementation(() => stream()),
      streamAgentEvents: vi.fn().mockImplementation(() => toAgentEvents(stream())),
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
      setReactionManager: vi.fn(),
      setToolResultSink: vi.fn(),
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
    threadPanel: {
      attachChoice: vi.fn().mockResolvedValue(undefined),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      isTurnSurfaceActive: vi.fn().mockReturnValue(false),
      isCompletionMarkerActive: vi.fn().mockReturnValue(false),
      beginTurn: vi.fn().mockResolvedValue(undefined),
      endTurn: vi.fn().mockResolvedValue(undefined),
      failTurn: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function createParams(say: ReturnType<typeof vi.fn>, session: any) {
  return {
    session,
    sessionKey: 'C777:thread777',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: 'do some work',
    channel: 'C777',
    threadTs: 'thread777',
    user: 'U_TEST',
    say,
  } as any;
}

function createSession(): any {
  return {
    sessionId: 'sess_sg',
    ownerId: 'U_TEST',
    logVerbosity: LOG_DETAIL,
    usage: {},
    terminated: false,
    // A recoverable error a moment ago left budget spent and context behind:
    // the halt must not leave either armed.
    errorRetryCount: 1,
    lastErrorContext: 'stale',
  };
}

function sayTexts(say: ReturnType<typeof vi.fn>): string[] {
  return say.mock.calls.map((c: any[]) => String(c[0]?.text ?? ''));
}

describe.each([
  ['delivered as the turn text (end_turn, isError=false)', safeguardAsContentStream],
  ['thrown by the SDK', safeguardThrownStream],
])('safeguards flag %s', (_label, stream) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('user@example.com');
  });

  it('T2 — stops at once: no auto-retry, retry budget and error context cleared', async () => {
    const deps = createDeps(stream);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const session = createSession();

    const result: ExecuteResult = await executor.execute(createParams(say, session));

    expect(result.retryAfterMs).toBeUndefined();
    expect(session.errorRetryCount).toBe(0);
    expect(session.lastErrorContext).toBeUndefined();
    expect(rotateOnRateLimitMock).not.toHaveBeenCalled();
  });

  it('T2 · T3 — locks the session: safeguardHalt carries the model, Details code and request id', async () => {
    const deps = createDeps(stream);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const session = createSession();

    await executor.execute(createParams(say, session));

    expect(session.safeguardHalt).toEqual(
      expect.objectContaining({
        model: 'Opus 5.5 (1M context)',
        detail: 'reasoning_extraction',
        requestId: 'req_011CggxYZxQ7TEBU95XW3X19',
      }),
    );
    expect(typeof session.safeguardHalt.atMs).toBe('number');
    // The SDK session is kept: an admin may retry on another model.
    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
  });

  it('T4 — labels it "세이프가드 에러" on the status, the thread notice and the turn card', async () => {
    const deps = createDeps(stream);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const session = createSession();

    await executor.execute(createParams(say, session));

    const phases = deps.threadPanel.setStatus.mock.calls.map((c: any[]) => c[2]?.agentPhase);
    expect(phases).toContain('세이프가드 에러');
    expect(phases).not.toContain('오류 발생');

    const texts = sayTexts(say);
    const notices = texts.filter((t) => t.includes('세이프가드 에러'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('관리자');
    expect(notices[0]).toContain('reasoning_extraction');
    expect(notices[0]).toContain('req_011CggxYZxQ7TEBU95XW3X19');
    // The raw API text is never posted as the answer, and no generic error post.
    expect(texts.some((t) => t.trimStart().startsWith('API Error:'))).toBe(false);
    expect(texts.some((t) => t.includes('오류 발생'))).toBe(false);

    expect(deps.turnNotifier.notify).toHaveBeenCalledTimes(1);
    expect(deps.turnNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Exception', errorKind: 'safeguard' }),
    );
  });

  it('T2 — the block is not recorded as the assistant answer', async () => {
    const deps = createDeps(stream);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(createParams(say, createSession()));

    const { recordAssistantTurn } = await import('../../../conversation');
    expect(vi.mocked(recordAssistantTurn)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('safeguards flagged'),
    );
  });
});

/**
 * Review gate (astra-zhuge P1 #1–#3, PR #906): detection stops the query at
 * once, survives an aborted exit, and also reads an SDK error result.
 */
describe('safeguards flag — stop at once, every exit (T2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('user@example.com');
  });

  // The block, then a stream that would never end on its own (background
  // agents keep the query open; the result is deferred).
  async function* safeguardThenHang(): AsyncGenerator<any> {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: SAFEGUARD_TEXT }] } };
    await new Promise(() => {});
  }

  async function* safeguardInErrorResult(): AsyncGenerator<any> {
    yield {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [SAFEGUARD_TEXT],
      total_cost_usd: 0,
      usage: {},
    };
  }

  it('stops the query as soon as the block is seen and halts — it does not wait for the stream to end', async () => {
    const deps = createDeps(safeguardThenHang);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const session = createSession();
    const params = createParams(say, session);

    const result = await Promise.race([
      executor.execute(params),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
    ]);

    expect(result).not.toBe('hung');
    expect(params.abortController.signal.aborted).toBe(true);
    expect(session.safeguardHalt?.detail).toBe('reasoning_extraction');
    expect((result as ExecuteResult).retryAfterMs).toBeUndefined();
  });

  it('halts when the block arrives only in an SDK error result (errors[])', async () => {
    const deps = createDeps(safeguardInErrorResult);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const session = createSession();

    await executor.execute(createParams(say, session));

    expect(session.safeguardHalt?.requestId).toBe('req_011CggxYZxQ7TEBU95XW3X19');
  });
});

describe('safeguards flag — the stopped stream is closed (review round 2, astra P1 #1)', () => {
  it("closes the generator so the query's cleanup runs (no leaked lease heartbeat)", async () => {
    let cleanedUp = false;
    async function* safeguardThenMore(): AsyncGenerator<any> {
      try {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: SAFEGUARD_TEXT }] } };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'more' }] } };
        await new Promise(() => {});
      } finally {
        cleanedUp = true;
      }
    }
    const deps = createDeps(safeguardThenMore);
    const executor = new StreamExecutor(deps);
    const session = createSession();

    await executor.execute(createParams(vi.fn().mockResolvedValue({ ts: 'msg_ts' }), session));

    expect(session.safeguardHalt).toBeDefined();
    expect(cleanedUp).toBe(true);
  });
});

describe('safeguards — delegated agent and already-halted session (review round 3, astra P1 #2, #3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('user@example.com');
  });

  it("a delegated agent's text that is the block halts the session", async () => {
    async function* subagentBlocked(): AsyncGenerator<any> {
      yield {
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent_1',
        message: { content: [{ type: 'text', text: SAFEGUARD_TEXT }] },
      };
      await new Promise(() => {});
    }
    const deps = createDeps(subagentBlocked);
    const executor = new StreamExecutor(deps);
    const session = createSession();

    const result = await Promise.race([
      executor.execute(createParams(vi.fn().mockResolvedValue({ ts: 'msg_ts' }), session)),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
    ]);

    expect(result).not.toBe('hung');
    expect(session.safeguardHalt?.detail).toBe('reasoning_extraction');
  });

  it('a session already halted runs no query (dispatch-set halt, continuation, race)', async () => {
    const deps = createDeps(safeguardAsContentStream);
    const executor = new StreamExecutor(deps);
    const session = createSession();
    session.safeguardHalt = { atMs: 1, detail: 'reasoning_extraction' };

    const result = await executor.execute(createParams(vi.fn().mockResolvedValue({ ts: 'msg_ts' }), session));

    expect(deps.claudeHandler.streamAgentEvents).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.retryAfterMs).toBeUndefined();
  });

  // Review R5 (astra P1): an incident attempt is no exception — a halted thread
  // runs no further attempt until an admin unlocks it.
  it('a halted incident session runs no further attempt', async () => {
    const deps = createDeps(safeguardAsContentStream);
    const executor = new StreamExecutor(deps);
    const session = createSession();
    session.safeguardHalt = { atMs: 1, detail: 'reasoning_extraction' };
    (session as { incidentRequest?: unknown }).incidentRequest = { incident_id: 'INC-1', attempt_id: 'AT-2' };

    const result = await executor.execute(createParams(vi.fn().mockResolvedValue({ ts: 'msg_ts' }), session));

    expect(deps.claudeHandler.streamAgentEvents).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});

describe('safeguards — review round 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('user@example.com');
  });

  // grok-elon P1: the permission guardian's block halts the session from
  // outside this stream; the turn must end as the halt, never as a success.
  it('a halt set outside the stream while the turn runs ends the turn as the halt, labelled', async () => {
    const session = createSession();
    async function* guardianHalted(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Cleaning up the build folder.' }] } };
      session.safeguardHalt = { atMs: 5, detail: 'reasoning_extraction' }; // the policy hook locked it
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
    }
    const deps = createDeps(guardianHalted);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    const result = await executor.execute(createParams(say, session));

    expect(result.success).toBe(false);
    expect(result.retryAfterMs).toBeUndefined();
    const phases = deps.threadPanel.setStatus.mock.calls.map((c: any[]) => c[2]?.agentPhase);
    expect(phases).toContain('세이프가드 에러');
    expect(deps.turnNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Exception', errorKind: 'safeguard' }),
    );
  });

  // astra-zhuge P1: prose buffered before the block must not hide it.
  it('a block after buffered prose is still caught: the query stops and the raw block never posts', async () => {
    async function* proseThenBlock(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look at that file.' }] } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: SAFEGUARD_TEXT }] } };
      await new Promise(() => {}); // the result never comes
    }
    const deps = createDeps(proseThenBlock);
    const executor = new StreamExecutor(deps);
    const session = createSession();
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    const result = await Promise.race([
      executor.execute(createParams(say, session)),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
    ]);

    expect(result).not.toBe('hung');
    expect(session.safeguardHalt?.detail).toBe('reasoning_extraction');
    expect(sayTexts(say).some((t) => t.includes('safeguards flagged this message'))).toBe(false);
  });

  // astra-zhuge P2: the refused turn's controller must not outlive it.
  it('a refused turn on a halted session releases its controller and goes idle', async () => {
    const deps = createDeps(safeguardAsContentStream);
    const executor = new StreamExecutor(deps);
    const session = createSession();
    session.safeguardHalt = { atMs: 1 };
    const params = createParams(vi.fn().mockResolvedValue({ ts: 'msg_ts' }), session);

    await executor.execute(params);

    expect(deps.requestCoordinator.removeController).toHaveBeenCalledWith('C777:thread777', params.abortController);
  });

  // astra-zhuge P1: the post-turn summary is another Claude query.
  it('the summary timer runs no summary on a halted session', async () => {
    const deps = createDeps(safeguardAsContentStream);
    deps.summaryService = { execute: vi.fn().mockResolvedValue(null) };
    const executor = new StreamExecutor(deps);
    const session = createSession();
    session.safeguardHalt = { atMs: 1 };

    await (executor as any).onSummaryTimerFire(session, 'C777:thread777');

    expect(deps.summaryService.execute).not.toHaveBeenCalled();
  });
});

describe('safeguards — review round 7 (astra P1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('user@example.com');
  });

  it('a failed render of the prose before the block does not lose the block', async () => {
    async function* proseThenBlock(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look at that file.' }] } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: SAFEGUARD_TEXT }] } };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
    }
    const deps = createDeps(proseThenBlock);
    const executor = new StreamExecutor(deps);
    const session = createSession();
    // The first post (the prose) fails with an ordinary Slack error.
    const say = vi.fn().mockRejectedValueOnce(new Error('channel_not_found')).mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(createParams(say, session));

    expect(session.safeguardHalt?.detail).toBe('reasoning_extraction');
  });

  it('a foreground agent that ended on the block (the CLI wraps it) halts the session', async () => {
    async function* foregroundAgentBlocked(): AsyncGenerator<any> {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_fg_1',
              name: 'Agent',
              input: { description: 'look', prompt: 'look', run_in_background: false },
            },
          ],
        },
      };
      yield {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_fg_1',
              is_error: true,
              content: `Agent terminated early due to an API error: ${SAFEGUARD_TEXT}`,
            },
          ],
        },
      };
      await new Promise(() => {}); // the parent would go on
    }
    const deps = createDeps(foregroundAgentBlocked);
    const executor = new StreamExecutor(deps);
    const session = createSession();

    const result = await Promise.race([
      executor.execute(createParams(vi.fn().mockResolvedValue({ ts: 'msg_ts' }), session)),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
    ]);

    expect(result).not.toBe('hung');
    expect(session.safeguardHalt?.detail).toBe('reasoning_extraction');
  });

  it('the halt rail locks the LIVE session when the turn’s session was replaced, and stops its turn', async () => {
    const deps = createDeps(safeguardAsContentStream);
    const live = { replaced: true };
    const haltSafeguardByKey = vi.fn();
    deps.claudeHandler.getSessionRegistry.mockReturnValue({
      beginTurn: vi.fn(),
      endTurn: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
      getActivityState: vi.fn().mockReturnValue('idle'),
      getSessionByKey: vi.fn(() => live),
      haltSafeguardByKey,
    });
    deps.requestCoordinator.isRequestActive = vi.fn(() => true);
    deps.requestCoordinator.abortSession = vi.fn(() => true);
    const executor = new StreamExecutor(deps);
    const session = createSession();

    await executor.execute(createParams(vi.fn().mockResolvedValue({ ts: 'msg_ts' }), session));

    expect(haltSafeguardByKey).toHaveBeenCalledWith(
      'C777:thread777',
      expect.objectContaining({ detail: 'reasoning_extraction' }),
    );
    expect(deps.requestCoordinator.abortSession).toHaveBeenCalledWith('C777:thread777', 'safeguard');
  });
});

describe('safeguards — review round 8 (astra P1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('user@example.com');
  });

  it('a failed render of a buffered tool result before the block does not lose the block', async () => {
    async function* toolThenBlock(): AsyncGenerator<any> {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'ls' } }] },
      };
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash_1', content: 'a\nb' }] },
      };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: SAFEGUARD_TEXT }] } };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
    }
    const deps = createDeps(toolThenBlock);
    deps.toolEventProcessor.handleToolResult = vi.fn().mockRejectedValue(new Error('slack_render_failed'));
    const executor = new StreamExecutor(deps);
    const session = createSession();

    await executor.execute(createParams(vi.fn().mockResolvedValue({ ts: 'msg_ts' }), session));

    expect(session.safeguardHalt?.detail).toBe('reasoning_extraction');
  });
});
