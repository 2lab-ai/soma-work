/**
 * sol[1m] context miscalculation (2026-10-27) — the REAL StreamExecutor path.
 *
 * mapper → processor → `updateSessionUsage` → `session.usage.current*` →
 * turn-end `checkAndSchedulePendingCompact`. A `gpt-5.6-sol[1m]` turn of three
 * llmux calls at ~250k context each: the billing aggregate is ~750k (over the
 * 600k sol[1m] trigger), the real occupancy is the last call's ~250k.
 *
 *   • without partial frames (the pre-fix wire) the executor reads the
 *     aggregate and schedules a /compact the session does not need;
 *   • with the `stream_event` `message_delta` frames the fix requests, it
 *     reads the last call and schedules nothing — and billing still counts
 *     every call.
 *
 * ssot-task: T1 (root cause pinned), T3 (fix through the downstream path)
 */

import { LOG_DETAIL } from '@soma/slack/output-flags';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentStreamFromSdk } from '../../../agent-runtime/claude-code/stream-runner';
// Imported through the src wrapper: it installs `setStreamExecutorProviders`
// (model registry, compact threshold checker).
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

const ZERO = { input_tokens: 0, output_tokens: 0 };
const CALLS = [
  { id: 'resp_1', input: 1_000, cacheRead: 248_000, output: 300 },
  { id: 'resp_2', input: 1_200, cacheRead: 249_000, output: 300 },
  { id: 'resp_3', input: 1_400, cacheRead: 250_000, output: 100 },
] as const;
const LAST = CALLS[2];
const LAST_CALL_OCCUPANCY = LAST.input + LAST.cacheRead + LAST.output;
const AGGREGATE = {
  input: CALLS.reduce((s, c) => s + c.input, 0),
  cacheRead: CALLS.reduce((s, c) => s + c.cacheRead, 0),
  output: CALLS.reduce((s, c) => s + c.output, 0),
};

/** One sol[1m] turn as the pinned SDK streams it; `partials` = the fix's wire. */
function solTurn(partials: boolean) {
  return async function* () {
    for (const [i, c] of CALLS.entries()) {
      const content =
        i < CALLS.length - 1
          ? [{ type: 'tool_use', id: `call_${i}`, name: 'Bash', input: { command: 'true' } }]
          : [{ type: 'text', text: 'DONE' }];
      if (partials) {
        yield {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: c.id, model: 'gpt-5.6-sol', usage: ZERO } },
        };
      }
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: c.id, model: 'gpt-5.6-sol', usage: ZERO, content },
      };
      if (partials) {
        yield {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'message_delta',
            usage: {
              input_tokens: c.input,
              cache_read_input_tokens: c.cacheRead,
              cache_creation_input_tokens: 0,
              output_tokens: c.output,
            },
          },
        };
      }
      if (i < CALLS.length - 1) {
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `call_${i}`, content: '' }] } };
      }
    }
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'DONE',
      modelUsage: {
        'gpt-5.6-sol[1m]': {
          inputTokens: AGGREGATE.input,
          outputTokens: AGGREGATE.output,
          cacheReadInputTokens: AGGREGATE.cacheRead,
          cacheCreationInputTokens: 0,
          costUSD: 0,
          contextWindow: 1_000_000,
        },
      },
    };
  };
}

function makeSession() {
  return {
    // A fresh SDK session (no resume): its result's running total is this
    // turn's spend. A resumed session without a baseline would seed one and
    // count nothing (stream-executor `legacyResume`).
    sessionId: undefined,
    ownerId: 'U_TEST',
    logVerbosity: LOG_DETAIL,
    terminated: false,
    model: 'gpt-5.6-sol[1m]',
  } as any;
}

async function runTurn(stream: () => AsyncIterable<any>) {
  const executor = new StreamExecutor(createDeps(stream) as any);
  const session = makeSession();
  await executor.execute({
    session,
    sessionKey: 'C1:t1',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: 'run the tools',
    channel: 'C1',
    threadTs: 't1',
    user: 'U_TEST',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    isUserInput: true,
  } as any);
  // The turn-end threshold check is fire-and-forget; it sets the flag before
  // its first await, but let it settle.
  await new Promise((r) => setTimeout(r, 0));
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sol[1m] occupancy through the real executor', () => {
  it('pre-fix wire (no partial frames): the aggregate becomes the occupancy and a needless /compact is scheduled', async () => {
    const session = await runTurn(solTurn(false));
    expect(occupancyOf(session)).toBe(AGGREGATE.input + AGGREGATE.cacheRead + AGGREGATE.output);
    expect(session.autoCompactPending).toBe(true);
  });

  it('fixed wire: the last call is the occupancy, no /compact under 600k, billing still counts every call', async () => {
    const session = await runTurn(solTurn(true));
    expect(occupancyOf(session)).toBe(LAST_CALL_OCCUPANCY);
    expect(session.usage.contextWindow).toBe(1_000_000);
    expect(session.autoCompactPending).toBeFalsy();
    expect(session.usage.totalInputTokens).toBe(AGGREGATE.input);
    expect(session.usage.totalCacheReadTokens).toBe(AGGREGATE.cacheRead);
    expect(session.usage.totalOutputTokens).toBe(AGGREGATE.output);
  });
});
