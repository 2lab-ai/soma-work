/**
 * A per-turn-less usage sample larger than the context window is not an
 * occupancy reading (a dev deployment, 2026-10-30).
 *
 * A turn that ends with no assistant usage — `Prompt is too long`, a turn cut
 * off before its first call lands — leaves only the result's aggregate. That
 * aggregate sums every API call (and, on a resumed SDK session, can be the
 * session's whole running total). The executor adopted it as the current
 * occupancy, so the session logged `currentContext: 187891067` against a 1M
 * window: the dashboard showed `187.9M/1M` and the compact threshold announced
 * `Context usage 187891k tokens ≥ 750k`. One request can never hold more than
 * the window, so a sample above it says nothing about how full the window is —
 * the last real occupancy stands. Billing totals still take the spend.
 *
 * These tests run the REAL `StreamExecutor.execute()`.
 *
 * ssot-task: T2
 */

import { LOG_DETAIL } from '@soma/slack/output-flags';
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
      getStatusEmoji: vi.fn().mockReturnValue('thinking_face'),
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

function occupancyOf(session: any): number {
  const u = session.usage;
  return (
    (u?.currentInputTokens ?? 0) +
    (u?.currentOutputTokens ?? 0) +
    (u?.currentCacheReadTokens ?? 0) +
    (u?.currentCacheCreateTokens ?? 0)
  );
}

/** The incident's result aggregate (a dev deployment, 2026-10-30T06:35:42Z). */
const INCIDENT_AGGREGATE = {
  input_tokens: 3_868_187,
  output_tokens: 426_418,
  cache_read_input_tokens: 172_893_178,
  cache_creation_input_tokens: 10_703_284,
};
const WINDOW = 1_000_000;
const PRIOR_OCCUPANCY = 400_000;

function makeSession() {
  return {
    sessionId: 'sess_over_window',
    ownerId: 'U_TEST',
    logVerbosity: LOG_DETAIL,
    terminated: false,
    model: 'claude-fable-5[1m]',
    usage: {
      contextWindow: WINDOW,
      currentInputTokens: PRIOR_OCCUPANCY,
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

async function runTurn(stream: () => AsyncIterable<any>) {
  const deps = createDeps(stream);
  const executor = new StreamExecutor(deps);
  const session = makeSession();
  await executor.execute({
    session,
    sessionKey: 'C1:t1',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: 'hello',
    channel: 'C1',
    threadTs: 't1',
    user: 'U_TEST',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    isUserInput: false,
  } as any);
  return { session, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('aggregate usage sample above the context window (T2)', () => {
  it('does not become the occupancy — the last real reading stands (incident 187.9M/1M)', async () => {
    async function* stream() {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: INCIDENT_AGGREGATE };
    }

    const { session } = await runTurn(stream);

    expect(occupancyOf(session)).toBeLessThanOrEqual(WINDOW);
    expect(occupancyOf(session)).toBe(PRIOR_OCCUPANCY);
  });

  it('still bills the spend — only occupancy ignores the sample', async () => {
    async function* stream() {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: INCIDENT_AGGREGATE };
    }

    const { session } = await runTurn(stream);

    expect(session.usage.totalInputTokens).toBe(INCIDENT_AGGREGATE.input_tokens);
    expect(session.usage.totalOutputTokens).toBe(INCIDENT_AGGREGATE.output_tokens);
    expect(session.usage.totalCacheReadTokens).toBe(INCIDENT_AGGREGATE.cache_read_input_tokens);
    expect(session.usage.totalCacheCreateTokens).toBe(INCIDENT_AGGREGATE.cache_creation_input_tokens);
  });

  it('an aggregate sample within the window is still adopted (unchanged fallback)', async () => {
    const inWindow = {
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 600_000,
      cache_creation_input_tokens: 8_000,
    };
    async function* stream() {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: inWindow };
    }

    const { session } = await runTurn(stream);

    expect(occupancyOf(session)).toBe(620_000);
  });
});
