/**
 * Compaction occupancy — the SDK's `post_tokens` is the context SSOT after a
 * compact boundary (issue #196).
 *
 * Before this fix `compact_boundary.post_tokens` reached only
 * `session.compactPostTokens` / `lastKnownUsagePct`, which feed the
 * "Compaction completed" Slack text and nothing else. Every context surface
 * — `/context`, the thread header bar, the turn-completion footer, the context
 * emoji, and the auto-compact threshold decision — reads `session.usage`, so
 * all of them kept reporting the PRE-compact number.
 *
 * Worse than stale: `StreamProcessor` calls `onUsageUpdate` exactly ONCE per
 * turn, after the stream loop (`packages/slack/src/stream-processor.ts:765`).
 * For a `/compact` turn that single sample describes the SUMMARIZATION
 * REQUEST, which read the whole pre-compact transcript — so the boundary value
 * was actively overwritten with a pre-compact-sized number a moment after it
 * was learned.
 *
 * These tests run the REAL `StreamExecutor.execute()` over a stream that
 * carries a `compact_boundary`, and assert on `session.usage`.
 *
 * ssot-task: T2.1, T2.2
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentStreamFromSdk } from '../../../agent-runtime/claude-code/stream-runner';
// Imported through the src wrapper (not `@soma/slack/...`): the wrapper is what
// installs `setStreamExecutorProviders` — model registry, config, compact hooks.
import { StreamExecutor } from '../stream-executor';

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



/** Occupancy the context surfaces actually render. */
function occupancyOf(session: any): number {
  const u = session.usage;
  return (
    (u?.currentInputTokens ?? 0) +
    (u?.currentOutputTokens ?? 0) +
    (u?.currentCacheReadTokens ?? 0) +
    (u?.currentCacheCreateTokens ?? 0)
  );
}

/** The compaction request's own consumption — a pre-compact-sized number. */
const PRE_COMPACT_AGGREGATE = {
  input_tokens: 4_800,
  output_tokens: 5_000,
  cache_read_input_tokens: 640_000,
  cache_creation_input_tokens: 25_000,
};
const PRE_COMPACT_TOTAL = 674_800;
const POST_TOKENS = 30_000;

function createDeps(stream: () => AsyncIterable<any>) {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
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
    requestCoordinator: { removeController: vi.fn(), touchSession: vi.fn() },
    slackApi: {
      getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
      getClient: vi.fn().mockReturnValue({}),
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      postSystemMessage: vi.fn().mockResolvedValue(undefined),
    },
    assistantStatusManager: {
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      bumpEpoch: vi.fn().mockReturnValue(1),
      getToolStatusText: vi.fn().mockReturnValue('running...'),
      buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
      registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
    },
    threadPanel: undefined,
    dispatchPendingUserMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeSession() {
  return {
    sessionId: 'sess_compact',
    ownerId: 'U_TEST',
    logVerbosity: 'detail',
    terminated: false,
    model: 'claude-fable-5[1m]',
    usage: {
      contextWindow: 1_000_000,
      // Deliberately distinct from both POST_TOKENS and PRE_COMPACT_TOTAL so
      // "counter never updated" and "counter overwritten by the aggregate"
      // are distinguishable failures.
      currentInputTokens: 500_000,
      currentOutputTokens: 0,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreateTokens: 0,
      totalCostUsd: 0,
      lastUpdated: Date.now(),
    },
  } as any;
}

async function runCompactTurn(stream: () => AsyncIterable<any>) {
  const deps = createDeps(stream);
  const executor = new StreamExecutor(deps);
  const session = makeSession();
  const result = await executor.execute({
    session,
    sessionKey: 'C1:t1',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: '/compact',
    channel: 'C1',
    threadTs: 't1',
    user: 'U_TEST',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    isUserInput: false,
  } as any);
  return { session, result, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('compact boundary → session.usage occupancy (T2.1)', () => {
  it('adopts post_tokens as the live context occupancy', async () => {
    async function* stream() {
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: PRE_COMPACT_TOTAL, post_tokens: POST_TOKENS },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: PRE_COMPACT_AGGREGATE };
    }

    const { session } = await runCompactTurn(stream);

    // The whole point: the counter every surface reads now reports the
    // post-compact window, not the summarization request's own read.
    expect(occupancyOf(session)).toBe(POST_TOKENS);
    expect(session.compactPostTokens).toBe(POST_TOKENS);
  });

  it('leaves billing totals untouched — only occupancy is rewritten', async () => {
    async function* stream() {
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: PRE_COMPACT_TOTAL, post_tokens: POST_TOKENS },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: PRE_COMPACT_AGGREGATE };
    }

    const { session } = await runCompactTurn(stream);

    // `total*` is billing, not occupancy. The compaction request really did
    // cost these tokens, so they must still be accumulated.
    expect(session.usage.totalInputTokens).toBe(PRE_COMPACT_AGGREGATE.input_tokens);
    expect(session.usage.totalOutputTokens).toBe(PRE_COMPACT_AGGREGATE.output_tokens);
    expect(session.usage.totalCacheReadTokens).toBe(PRE_COMPACT_AGGREGATE.cache_read_input_tokens);
    expect(session.usage.totalCacheCreateTokens).toBe(PRE_COMPACT_AGGREGATE.cache_creation_input_tokens);
  });
});

describe("the turn's own usage sample cannot undo the boundary (T2.2)", () => {
  it('a pre-boundary assistant per-turn sample does not restore pre-compact occupancy', async () => {
    // `StreamProcessor` merges the LAST assistant message's per-turn usage
    // into the single end-of-turn sample. When that assistant message
    // preceded the boundary it describes the pre-compact context — adopting
    // it would silently reinstate the bug through the per-turn path rather
    // than the aggregate one.
    async function* stream() {
      yield {
        type: 'assistant',
        message: {
          model: 'claude-fable-5',
          usage: {
            input_tokens: 4_800,
            output_tokens: 5_000,
            cache_read_input_tokens: 640_000,
            cache_creation_input_tokens: 25_000,
          },
          content: [{ type: 'text', text: 'pre-boundary turn' }],
        },
      };
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: PRE_COMPACT_TOTAL, post_tokens: POST_TOKENS },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: PRE_COMPACT_AGGREGATE };
    }

    const { session } = await runCompactTurn(stream);

    expect(occupancyOf(session)).toBe(POST_TOKENS);
    expect(occupancyOf(session)).not.toBe(PRE_COMPACT_TOTAL);
  });

  it('releases the guard at turn end so the next turn tracks context again', async () => {
    async function* stream() {
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: PRE_COMPACT_TOTAL, post_tokens: POST_TOKENS },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: PRE_COMPACT_AGGREGATE };
    }

    const { session } = await runCompactTurn(stream);

    // A guard that leaked past the turn would freeze the context display for
    // the rest of the session — strictly worse than the bug it fixes.
    expect(session.postCompactOccupancyApplied).toBeFalsy();
  });
});

describe('no post_tokens → unchanged behaviour (T2.1)', () => {
  it('keeps the normal usage path when the SDK omits post_tokens', async () => {
    async function* stream() {
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: PRE_COMPACT_TOTAL },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: PRE_COMPACT_AGGREGATE };
    }

    const { session } = await runCompactTurn(stream);

    // Nothing authoritative arrived, so we must not invent a number — the
    // pre-existing (imperfect) accounting stands.
    expect(occupancyOf(session)).toBe(PRE_COMPACT_TOTAL);
    expect(occupancyOf(session)).not.toBe(500_000);
    expect(session.postCompactOccupancyApplied).toBeFalsy();
  });
});
