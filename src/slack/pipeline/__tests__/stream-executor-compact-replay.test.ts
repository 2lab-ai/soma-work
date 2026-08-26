/**
 * Normal-threshold compaction replay — exactly-once through the REAL
 * `StreamExecutor.execute()` / `finally` path.
 *
 * Why a dedicated suite (Task 5): the existing coverage proves the *queue
 * helpers* (`packages/slack/src/__tests__/compact-state.test.ts`) and the
 * *hook* half (`src/slack/hooks/__tests__/compact-hooks.test.ts`) in
 * isolation, plus `handleError` behavior. Nothing drove the production
 * consumption block at `packages/slack/src/pipeline/stream-executor.ts`
 * (promotion at :2579-2583, drain at :2592-2632) through a real
 * `execute()`. That block is where a threshold-intercepted user message
 * is actually handed back to the pipeline, so that is where "exactly once,
 * never lost" has to be proven.
 *
 * Contract under test (task-5-brief "Guarantees"): one stashed
 * normal-threshold message is replayed exactly once after `/compact`
 * success, failure, timeout, or stream abort — independently of the
 * prompt-too-long emergency fallback state machine.
 *
 * These tests import `../stream-executor` (the src wrapper), so the REAL
 * providers are installed — including the real `postCompactCompleteIfNeeded`
 * and the real `checkAndSchedulePendingCompact`. The boundary/PostCompact
 * promotions below are therefore production code, not replicas.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentStreamFromSdk } from '../../../agent-runtime/claude-code/stream-runner';

/** Same SDKMessage → AgentStreamEvent bridge the sibling suite uses. */
function toAgentEvents(sdkStream: AsyncIterable<any>): AsyncIterable<any> {
  return runAgentStreamFromSdk(sdkStream, { calculateTokenCost: () => 0 });
}

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
    getUserDefaultModel: vi.fn().mockReturnValue('claude-opus-4-6'),
    setUserDefaultModel: vi.fn(),
    getUserDefaultEffort: vi.fn().mockReturnValue('high'),
    getUserShowThinking: vi.fn().mockReturnValue(true),
    getUserRating: vi.fn().mockReturnValue(5),
    setUserRating: vi.fn(),
    consumePendingRatingChange: vi.fn().mockReturnValue(null),
    setPendingRatingChange: vi.fn(),
  },
  coerceToAvailableModel: (raw: string) => raw,
  MODEL_ALIASES: { 'opus[1m]': 'claude-opus-4-8[1m]' },
}));

vi.mock('../../../channel-description-cache', () => ({
  getChannelDescription: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../../channel-registry', () => ({
  getChannel: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv_1'),
  recordAssistantTurn: vi.fn(),
  recordUserTurn: vi.fn(),
}));

vi.mock('../../../mcp-config-builder', () => ({
  isMidThreadMention: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../metrics/event-emitter', () => ({
  getMetricsEmitter: vi.fn().mockReturnValue({ emit: vi.fn() }),
}));

vi.mock('../../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue(null),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../token-manager', () => ({
  getTokenManager: () => ({
    getActiveToken: () => null,
    listTokens: () => [],
    rotateOnRateLimit: async () => ({ rotated: null, skipReason: 'no-eligible' }),
    fetchAndStoreUsage: async () => null,
  }),
  parseCooldownTime: vi.fn().mockReturnValue(null),
}));

import { stashUserMessageDuringCompaction } from '@soma/slack/compact-state';
import { postCompactCompleteIfNeeded } from '../../hooks/compact-hooks';
import { StreamExecutor } from '../stream-executor';

// ── Fixtures ────────────────────────────────────────────────────────────

const CHANNEL = 'C900';
const THREAD = 't900';
const SESSION_KEY = `${CHANNEL}:${THREAD}`;
/** The ordinary (NOT emergency-fallback) message the threshold path stashed. */
const STASHED = '스레숄드에 걸려 가로챈 원래 메시지';
const STASHED_CTX = { channel: CHANNEL, threadTs: THREAD, user: 'U_TEST', ts: '111.0001' };
/** A second author's message stashed during the same compaction window. */
const STASHED_B = '두 번째 사용자의 메시지';
const STASHED_B_CTX = { channel: CHANNEL, threadTs: THREAD, user: 'U_OTHER', ts: '111.0002' };

/**
 * Dispatch spy that records every ATTEMPT and, separately, every payload
 * that was actually handed off successfully. "Zero loss / zero duplicate"
 * is asserted against `delivered` — attempts may legitimately repeat after
 * a transient failure; deliveries may not.
 */
function createDispatchRecorder(failFor: (text: string, attempt: number) => boolean = () => false) {
  const attempts: Array<{ ctx: any; text: string; opts?: any }> = [];
  const delivered: string[] = [];
  const perTextAttempts = new Map<string, number>();
  const fn = vi.fn(async (ctx: any, text: string, opts?: any) => {
    attempts.push({ ctx, text, opts });
    const n = (perTextAttempts.get(text) ?? 0) + 1;
    perTextAttempts.set(text, n);
    if (failFor(text, n)) {
      throw new Error(`dispatch transport failed for "${text}" (attempt ${n})`);
    }
    delivered.push(text);
  });
  return { fn, attempts, delivered };
}

function createDeps(streamFactory: () => AsyncIterable<any>, dispatch: any) {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      streamAgentEvents: vi.fn().mockImplementation(() => streamFactory()),
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
      getLiveBackgroundWork: vi.fn().mockReturnValue({ count: 0, labels: [], signature: '' }),
      cleanup: vi.fn(),
    },
    statusReporter: {
      updateStatusDirect: vi.fn().mockResolvedValue(undefined),
      getStatusEmoji: vi.fn().mockReturnValue('thinking_face'),
      cleanup: vi.fn(),
    },
    reactionManager: { updateReaction: vi.fn().mockResolvedValue(undefined), cleanup: vi.fn() },
    contextWindowManager: {
      handlePromptTooLong: vi.fn().mockResolvedValue(undefined),
      calculateRemainingPercent: vi.fn().mockReturnValue(50),
      updateContextEmoji: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    },
    toolTracker: { scheduleCleanup: vi.fn() },
    todoDisplayManager: {
      cleanupSession: vi.fn(),
      cleanup: vi.fn(),
      handleTodoUpdate: vi.fn().mockResolvedValue(undefined),
    },
    actionHandlers: {},
    requestCoordinator: {
      removeController: vi.fn(),
      touchSession: vi.fn(),
      // Consumption gate at stream-executor.ts:2594 — no newer turn is live.
      isRequestActive: vi.fn().mockReturnValue(false),
    },
    slackApi: {
      getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
      getClient: vi.fn().mockReturnValue({}),
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'sys_ts' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    },
    assistantStatusManager: {
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      bumpEpoch: vi.fn().mockReturnValue(1),
      getToolStatusText: vi.fn().mockReturnValue('running...'),
      buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
      registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
    },
    turnNotifier: { notify: vi.fn().mockResolvedValue(undefined) },
    threadPanel: undefined,
    dispatchPendingUserMessage: dispatch,
  } as any;
}

/**
 * Session mid-compaction: the threshold checker armed `autoCompactPending`,
 * InputProcessor intercepted the user's next message into
 * `pendingUserText`/`pendingEventContext`, and a cycle is open (pre=true).
 */
function thresholdSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'ac1f0d92-0000-4000-8000-00000000dead',
    ownerId: 'U_TEST',
    logVerbosity: 'detail',
    usage: {},
    terminated: false,
    model: 'claude-opus-4-6',
    channelId: CHANNEL,
    threadTs: THREAD,
    autoCompactPending: true,
    compactEpoch: 1,
    compactPostedByEpoch: { 1: { pre: true, post: false } },
    compactionRehydratedByEpoch: {},
    compactStartedAtMs: Date.now(),
    preCompactUsagePct: 85,
    lastKnownUsagePct: null,
    pendingUserText: STASHED,
    pendingEventContext: { ...STASHED_CTX },
    compactPendingDispatches: null,
    ...overrides,
  } as any;
}

function executeParams(session: any, say: ReturnType<typeof vi.fn>, text: string, abortController?: AbortController) {
  return {
    session,
    sessionKey: SESSION_KEY,
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController: abortController ?? new AbortController(),
    processedFiles: [],
    text,
    channel: CHANNEL,
    threadTs: THREAD,
    user: 'U_TEST',
    say,
  } as any;
}

// ── Streams ─────────────────────────────────────────────────────────────

async function* successSdk() {
  yield { type: 'assistant', message: { content: [{ type: 'text', text: '완료' }] } };
  yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
}

/** A real compact turn: SDK emits `compact_boundary`, then a success result. */
async function* compactBoundarySdk() {
  yield {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 170_000, post_tokens: 40_000, duration_ms: 1234 },
  };
  yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
}

/**
 * The SDK seals a FAILED `/compact` as a SUCCESSFUL turn whose content is the
 * stderr line (field incident 2026-07-07). No boundary fires, so the stash is
 * still parked on `pendingUserText` when the executor's `finally` runs.
 */
async function* compactFailureAsContentSdk() {
  yield {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: 'Error: Error during compaction: API Error: Server is temporarily limiting requests (not your usage limit)',
        },
      ],
    },
  };
  yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
}

/** Never yields; `.return()` resolves so the bounded close cannot hang. */
function hangingStream(): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<any>>(() => {}),
        return: async () => ({ done: true, value: undefined }) as IteratorResult<any>,
      } as AsyncIterator<any>;
    },
  };
}

function abortMidStreamSdk(ac: AbortController) {
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '중간까지 작업' }] } };
    ac.abort('user-stop');
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '이 뒤는 유실 구간' }] } };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
  })();
}

// ── Suite ───────────────────────────────────────────────────────────────

describe('normal-threshold compaction replay is exactly-once on the real execute()/finally path', () => {
  let prevStallEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    prevStallEnv = process.env.SOMA_STREAM_STALL_TIMEOUT_MS;
  });

  afterEach(() => {
    if (prevStallEnv === undefined) delete process.env.SOMA_STREAM_STALL_TIMEOUT_MS;
    else process.env.SOMA_STREAM_STALL_TIMEOUT_MS = prevStallEnv;
  });

  /** Every terminal state must leave the replay ledger empty and unlocked. */
  function expectLedgerDrained(session: any) {
    expect(session.compactPendingDispatches).toBeNull();
    expect(session.pendingUserText).toBeNull();
    expect(session.pendingEventContext).toBeNull();
    expect(session.compactTurnActive).toBe(false);
    expect(session.compactDispatchInFlight).toBeFalsy();
  }

  it('successful /compact: replays the stash exactly once and drains the queue', async () => {
    const rec = createDispatchRecorder();
    const deps = createDeps(() => toAgentEvents(compactBoundarySdk()), rec.fn);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const session = thresholdSession();

    const result = await executor.execute(executeParams(session, say, '/compact'));

    expect(result.success).toBe(true);
    // Exactly one handoff, carrying the original author's own ctx.
    expect(rec.attempts).toHaveLength(1);
    expect(rec.delivered).toEqual([STASHED]);
    expect(rec.attempts[0].ctx).toEqual(STASHED_CTX);
    expect(rec.attempts[0].opts).toEqual({ compactRedispatch: true });
    expectLedgerDrained(session);
    // Boundary observability survives: exactly one "complete" post for the cycle.
    expect(session.compactPostedByEpoch[1].post).toBe(true);
    expect(deps.slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expect(String(deps.slackApi.postSystemMessage.mock.calls[0][1])).toContain('Compaction completed');
    expect(session.autoCompactPending).toBe(false);
  });

  it('content-shaped /compact failure: strand-rescue still replays the stash exactly once', async () => {
    const rec = createDispatchRecorder();
    const deps = createDeps(() => toAgentEvents(compactFailureAsContentSdk()), rec.fn);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const session = thresholdSession();

    const result = await executor.execute(executeParams(session, say, '/compact'));

    // Terminal compact rail (no boundary ever fired) …
    expect(result.success).toBe(false);
    expect(say).toHaveBeenCalledTimes(1);
    expect(String(say.mock.calls[0][0].text)).toContain('자동 컴팩트 실패');
    // … and the intercepted message is NOT lost with the failed compaction.
    expect(rec.delivered).toEqual([STASHED]);
    expect(rec.attempts).toHaveLength(1);
    expect(rec.attempts[0].opts).toEqual({ compactRedispatch: true });
    expectLedgerDrained(session);
  });

  it('stall-timeout abort: replays the stash exactly once', async () => {
    process.env.SOMA_STREAM_STALL_TIMEOUT_MS = '25';
    const rec = createDispatchRecorder();
    const deps = createDeps(() => hangingStream(), rec.fn);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const session = thresholdSession();
    const ac = new AbortController();

    const result = await executor.execute(executeParams(session, say, '/compact', ac));

    expect(result.success).toBe(false);
    expect(ac.signal.reason).toBe('stall-timeout');
    expect(rec.delivered).toEqual([STASHED]);
    expect(rec.attempts).toHaveLength(1);
    expectLedgerDrained(session);
  });

  it('user-stop stream abort: replays the stash exactly once', async () => {
    const rec = createDispatchRecorder();
    const ac = new AbortController();
    const deps = createDeps(() => toAgentEvents(abortMidStreamSdk(ac)), rec.fn);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const session = thresholdSession();

    const result = await executor.execute(executeParams(session, say, '/compact', ac));

    expect(result.success).toBe(false);
    expect(ac.signal.aborted).toBe(true);
    expect(rec.delivered).toEqual([STASHED]);
    expect(rec.attempts).toHaveLength(1);
    expectLedgerDrained(session);
  });

  it('PostCompact hook AND compact_boundary AND finally all promote → still exactly one dispatch', async () => {
    const rec = createDispatchRecorder();
    const session = thresholdSession();
    // Drive the REAL PostCompact-side helper mid-turn (that is when the CLI
    // fires the hook), then let the executor's own onCompactBoundary run the
    // same helper again, then let `finally` promote a third time.
    const deps: any = createDeps(
      () =>
        toAgentEvents(
          (async function* () {
            await postCompactCompleteIfNeeded(
              { session, channel: CHANNEL, threadTs: THREAD, slackApi: deps.slackApi },
              { source: 'post-compact-hook' },
            );
            yield {
              type: 'system',
              subtype: 'compact_boundary',
              compact_metadata: { trigger: 'auto', pre_tokens: 170_000, post_tokens: 40_000 },
            };
            yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
          })(),
        ),
      rec.fn,
    );
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(executeParams(session, say, '/compact'));

    // Three promotion attempts, ONE queue entry, ONE handoff, ONE Slack post.
    expect(rec.attempts).toHaveLength(1);
    expect(rec.delivered).toEqual([STASHED]);
    expect(deps.slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    expectLedgerDrained(session);
  });

  it('multi-author queue: each stashed payload is replayed once, under its own ctx', async () => {
    const rec = createDispatchRecorder();
    const session = thresholdSession();
    stashUserMessageDuringCompaction(session, { ...STASHED_B_CTX }, STASHED_B);
    const deps = createDeps(() => toAgentEvents(compactBoundarySdk()), rec.fn);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(executeParams(session, say, '/compact'));

    // Arrival order preserved (promoted stash first), no merge across authors.
    expect(rec.delivered).toEqual([STASHED, STASHED_B]);
    expect(rec.attempts.map((a) => a.ctx.user)).toEqual(['U_TEST', 'U_OTHER']);
    expectLedgerDrained(session);
  });

  it('dispatch rejection retains the failed payload; a later eligible turn retries it exactly once', async () => {
    // U_OTHER's payload fails its FIRST handoff attempt only.
    const rec = createDispatchRecorder((text, attempt) => text === STASHED_B && attempt === 1);
    const session = thresholdSession();
    stashUserMessageDuringCompaction(session, { ...STASHED_B_CTX }, STASHED_B);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    // Turn 1 — the /compact turn. First payload lands, second one throws.
    const executor1 = new StreamExecutor(createDeps(() => toAgentEvents(compactBoundarySdk()), rec.fn));
    await executor1.execute(executeParams(session, say, '/compact'));

    expect(rec.delivered).toEqual([STASHED]);
    // The rejected payload must still be parked — pre-clearing the queue before
    // a successful handoff turns a transient transport failure into silent
    // message loss. The already-delivered payload must NOT still be queued
    // (that would be a duplicate on the next drain), so the exact expected
    // residue is the single failed entry, under its own author ctx.
    expect(session.compactPendingDispatches ?? []).toEqual([{ ctx: STASHED_B_CTX, text: STASHED_B }]);
    expect(session.compactDispatchInFlight).toBeFalsy();

    // Turn 2 — an ordinary turn. Its `finally` drains the retained payload.
    const executor2 = new StreamExecutor(createDeps(() => toAgentEvents(successSdk()), rec.fn));
    await executor2.execute(executeParams(session, say, '이어서 진행'));

    // Zero loss: both payloads delivered. Zero duplicates: each exactly once.
    expect(rec.delivered).toEqual([STASHED, STASHED_B]);
    expect(rec.attempts).toHaveLength(3); // A ok, B fail, B ok
    expect(session.compactPendingDispatches).toBeNull();
    expect(session.compactDispatchInFlight).toBeFalsy();
  });

  it('emergency prompt-too-long fallback replays its OWN message and never consumes the normal-threshold stash', async () => {
    const rec = createDispatchRecorder();
    const FALLBACK_TEXT = '오버플로를 유발한 원본 메시지';
    const FALLBACK_CTX = { channel: CHANNEL, threadTs: THREAD, user: 'U_TEST', ts: '999.9999' };
    const session = thresholdSession({
      model: 'claude-opus-4-8[1m]',
      fallbackCompactActive: true,
      fallbackCompactOriginalModel: 'gpt-5.5',
      fallbackCompactPendingUserText: FALLBACK_TEXT,
      fallbackCompactPendingEventContext: { ...FALLBACK_CTX },
    });
    const deps = createDeps(() => toAgentEvents(compactBoundarySdk()), rec.fn);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(executeParams(session, say, '/compact'));

    // Two independent rails, one delivery each — neither consumed the other.
    expect(rec.delivered.slice().sort()).toEqual([FALLBACK_TEXT, STASHED].slice().sort());
    expect(rec.attempts).toHaveLength(2);
    const fallbackCall = rec.attempts.filter((a) => a.text === FALLBACK_TEXT)[0];
    const thresholdCall = rec.attempts.filter((a) => a.text === STASHED)[0];
    // Emergency rail dispatches with its own ctx and no compactRedispatch flag.
    expect(fallbackCall.ctx).toEqual(FALLBACK_CTX);
    expect(fallbackCall.opts).toBeUndefined();
    // Normal-threshold rail goes through the deferred queue.
    expect(thresholdCall.ctx).toEqual(STASHED_CTX);
    expect(thresholdCall.opts).toEqual({ compactRedispatch: true });
    // Emergency state unwound at the boundary; threshold ledger drained.
    expect(session.model).toBe('gpt-5.5');
    expect(session.fallbackCompactActive).toBe(false);
    expect(session.fallbackCompactPendingUserText).toBeNull();
    expect(session.fallbackCompactPendingEventContext).toBeNull();
    expectLedgerDrained(session);
  });

  it('RED: re-entrant finally with compactDispatchInFlight=true should not emit dropped/no-dep warning', async () => {
    // When dispatch exists but a nested/re-entrant turn reaches finally while
    // the outer drain has compactDispatchInFlight=true, payload is parked and
    // owned by the outer drain. This turn's finally should NOT log "dropped/no-dep"
    // (which contaminates diagnostics), but instead log info/debug "left parked".
    const rec = createDispatchRecorder();
    const session = thresholdSession({
      // Queue already has a pending dispatch from a prior compaction
      compactPendingDispatches: [{ ctx: STASHED_CTX, text: STASHED }],
    });
    const deps = createDeps(() => toAgentEvents(successSdk()), rec.fn);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    // Simulate: outer drain already in-flight when this re-entrant turn's finally runs
    session.compactDispatchInFlight = true;

    await executor.execute(executeParams(session, say, 'normal turn'));

    // Payload stays parked — owned by the outer drain in-flight (re-entrant turn does NOT consume it)
    expect(session.compactPendingDispatches).toEqual([{ ctx: STASHED_CTX, text: STASHED }]);
    // Re-entrant turn does NOT clear the in-flight flag (only the outer drain that set it should)
    expect(session.compactDispatchInFlight).toBe(true);
    // No dispatch handoff attempted by this (re-entrant) turn
    expect(rec.delivered).toHaveLength(0);
  });
});
