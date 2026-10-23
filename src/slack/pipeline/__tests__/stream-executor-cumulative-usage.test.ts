/**
 * RED — per-turn usage must not re-count the SDK's running total.
 *
 * The SDK result's `modelUsage` is cumulative for the SDK session and a
 * resumed session continues from the totals its transcript saved (sdk.d.ts,
 * `SDKResultSuccess.modelUsage`). soma-work resumes the same SDK session id on
 * every turn, so `updateSessionUsage` adding each result straight into
 * `session.usage.total*`, the goal's spend, `modelTotals` and the
 * `token_usage` metrics re-counted every earlier turn — dev 2026-10-24,
 * conversation 4a22fff8: true running total $213.45, dashboard total $2,500+.
 *
 * Drives the REAL `execute()` over consecutive turns of one session.
 */

import { LOG_DETAIL } from '@soma/slack/output-flags';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentStreamFromSdk } from '../../../agent-runtime/claude-code/stream-runner';
import { buildWorkSessionKey } from '../../../session-identity';
// Imported through the src wrapper (not `@soma/slack/...`): the wrapper is what
// installs `setStreamExecutorProviders`, including `getMetricsEmitter`.
import { StreamExecutor } from '../stream-executor';

const emitted = vi.hoisted(() => ({ tokenUsage: [] as Array<{ userId: string; metadata: any }> }));

vi.mock('../../../metrics/event-emitter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../metrics/event-emitter')>();
  const fake = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'emitTokenUsage') {
          return async (userId: string, _userName: string, metadata: any) => {
            emitted.tokenUsage.push({ userId, metadata });
          };
        }
        return async () => undefined;
      },
    },
  );
  return { ...actual, getMetricsEmitter: () => fake };
});

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

const CHANNEL = 'C0AKY7W2UGZ';
const THREAD_TS = '1792391797.292769';

/** One SDK `result` frame carrying a cumulative per-model `modelUsage`. */
function resultFrame(
  modelUsage: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number; cost: number }>,
) {
  return {
    type: 'result',
    subtype: 'success',
    num_turns: 1,
    total_cost_usd: Object.values(modelUsage).reduce((a, m) => a + m.cost, 0),
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: Object.fromEntries(
      Object.entries(modelUsage).map(([model, m]) => [
        model,
        {
          inputTokens: m.input,
          outputTokens: m.output,
          cacheReadInputTokens: m.cacheRead,
          cacheCreationInputTokens: m.cacheCreate,
          costUSD: m.cost,
          webSearchRequests: 0,
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
        },
      ]),
    ),
  };
}

async function runTurn(session: any, frame: any, initSessionId?: string): Promise<void> {
  async function* stream() {
    // What `ClaudeHandler.streamQuery` does on the turn's `system`/`init`
    // frame: the SDK session id lands on the session BEFORE the result.
    if (initSessionId) session.sessionId = initSessionId;
    yield frame;
  }
  const executor = new StreamExecutor(createDeps(stream));
  await executor.execute({
    session,
    sessionKey: buildWorkSessionKey(CHANNEL, THREAD_TS),
    userName: 'tester',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: 'hello',
    channel: CHANNEL,
    threadTs: THREAD_TS,
    user: 'U_TEST',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    isUserInput: false,
  } as any);
}

function newSession(): any {
  return {
    sessionId: 'sdk-session-A',
    ownerId: 'U_TEST',
    ownerName: 'tester',
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    logVerbosity: LOG_DETAIL,
    terminated: false,
    model: 'claude-opus-5-5[1m]',
    goal: { goalId: 'g1', objective: 'ship it', status: 'active' },
  };
}

const OPUS = 'claude-opus-5-5[1m]';

describe('StreamExecutor — cumulative SDK usage is counted once', () => {
  beforeEach(() => {
    emitted.tokenUsage.length = 0;
  });

  it('adds only the growth of the running total on each resumed turn', async () => {
    const session = newSession();

    await runTurn(
      session,
      resultFrame({ [OPUS]: { input: 1000, output: 100, cacheRead: 10_000, cacheCreate: 500, cost: 1 } }),
    );
    await runTurn(
      session,
      resultFrame({
        [OPUS]: { input: 1500, output: 160, cacheRead: 25_000, cacheCreate: 700, cost: 1.6 },
        astra: { input: 300, output: 20, cacheRead: 0, cacheCreate: 0, cost: 0.2 },
      }),
    );
    await runTurn(
      session,
      resultFrame({
        [OPUS]: { input: 1600, output: 170, cacheRead: 30_000, cacheCreate: 700, cost: 1.7 },
        astra: { input: 300, output: 20, cacheRead: 0, cacheCreate: 0, cost: 0.2 },
      }),
    );

    // Session totals equal the SDK's latest running total — not the sum of all three.
    expect(session.usage.totalCostUsd).toBeCloseTo(1.9);
    expect(session.usage.totalInputTokens).toBe(1900);
    expect(session.usage.totalOutputTokens).toBe(190);
    expect(session.usage.totalCacheReadTokens).toBe(30_000);
    expect(session.usage.totalCacheCreateTokens).toBe(700);
    // Per-model buckets (`/context`) match each model's own running total.
    expect(session.usage.modelTotals[OPUS].costUsd).toBeCloseTo(1.7);
    expect(session.usage.modelTotals.astra.costUsd).toBeCloseTo(0.2);
    // The goal is credited the same per-turn spend.
    expect(session.goal.costUsd).toBeCloseTo(1.9);
    expect(session.goal.tokensInput).toBe(1900);
    // Each token_usage event carries that turn's own spend.
    expect(emitted.tokenUsage.map((e) => Number(e.metadata.costUsd.toFixed(6)))).toEqual([1, 0.8, 0.1]);
  });

  it('keeps counting from the last running total after a restart drops the in-memory usage', async () => {
    const session = newSession();
    await runTurn(
      session,
      resultFrame({ [OPUS]: { input: 1000, output: 100, cacheRead: 0, cacheCreate: 0, cost: 1 } }),
    );

    // Restart: `session.usage` is runtime-only; the persisted fields survive.
    const restored = JSON.parse(JSON.stringify(session));
    restored.usage = undefined;

    await runTurn(
      restored,
      resultFrame({ [OPUS]: { input: 1200, output: 130, cacheRead: 0, cacheCreate: 0, cost: 1.25 } }),
    );

    expect(restored.usage.totalCostUsd).toBeCloseTo(0.25);
    expect(restored.goal.costUsd).toBeCloseTo(1.25);
  });

  it('after /new (sessionId cleared, new id assigned at init inside the turn) the first result counts in full', async () => {
    const session = newSession();
    await runTurn(
      session,
      resultFrame({ [OPUS]: { input: 10_000, output: 1000, cacheRead: 0, cacheCreate: 0, cost: 10 } }),
    );

    // `resetSessionContext` / `clearSessionId`: no SDK session to resume; the
    // baseline from the old SDK session is still on the session object.
    session.sessionId = undefined;
    session.usage = undefined;
    await runTurn(
      session,
      resultFrame({ [OPUS]: { input: 400, output: 40, cacheRead: 0, cacheCreate: 0, cost: 0.4 } }),
      'sdk-session-B',
    );

    expect(session.usage.totalCostUsd).toBeCloseTo(0.4);
    expect(session.usage.totalInputTokens).toBe(400);
    expect(emitted.tokenUsage.at(-1)?.metadata.costUsd).toBeCloseTo(0.4);
  });

  it('a new SDK session after a reset counts its first result in full', async () => {
    const session = newSession();
    await runTurn(
      session,
      resultFrame({ [OPUS]: { input: 1000, output: 100, cacheRead: 0, cacheCreate: 0, cost: 3 } }),
    );

    session.sessionId = 'sdk-session-B';
    session.usage = undefined;
    await runTurn(
      session,
      resultFrame({ [OPUS]: { input: 2000, output: 200, cacheRead: 0, cacheCreate: 0, cost: 4 } }),
    );

    expect(session.usage.totalCostUsd).toBeCloseTo(4);
  });
});
