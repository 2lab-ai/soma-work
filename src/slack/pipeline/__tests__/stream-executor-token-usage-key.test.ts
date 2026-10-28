/**
 * `token_usage` metrics carry the session-registry key.
 *
 * Every metrics event is keyed by the registry key (`buildWorkSessionKey`,
 * `work:<channel>:<thread>` since Step 4d) — `src/metrics/event-emitter.ts`
 * `sessionKeyFrom`. `token_usage` is emitted from the StreamExecutor's
 * usage-update path; this suite drives the REAL `execute()` over a stream
 * that ends with a `result` usage sample and checks the key that reaches
 * `emitTokenUsage`. The report aggregator still normalizes legacy keys on
 * read (`report-aggregator.ts`) for events written before the fix.
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

describe('token_usage metrics session key', () => {
  beforeEach(() => {
    emitted.tokenUsage.length = 0;
  });

  it('emits token_usage with the session-registry key, like every other metrics event', async () => {
    async function* stream() {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    }

    const sessionKey = buildWorkSessionKey(CHANNEL, THREAD_TS);
    const executor = new StreamExecutor(createDeps(stream));
    await executor.execute({
      session: {
        sessionId: 'sess_token_usage',
        ownerId: 'U_TEST',
        ownerName: 'tester',
        channelId: CHANNEL,
        threadTs: THREAD_TS,
        logVerbosity: LOG_DETAIL,
        terminated: false,
        model: 'claude-fable-5[1m]',
      },
      sessionKey,
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

    expect(emitted.tokenUsage.length).toBeGreaterThan(0);
    for (const { metadata } of emitted.tokenUsage) {
      expect(metadata.sessionKey).toBe(sessionKey);
    }
  });
});
