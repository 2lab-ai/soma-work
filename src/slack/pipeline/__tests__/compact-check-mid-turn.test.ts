/**
 * The auto-compact check must not wait for a turn to end (a dev deployment,
 * 2026-10-30).
 *
 * Automatic compaction has one authority — the harness threshold check — and
 * it ran only when a turn ended normally. A goal turn that started at 701k
 * crossed the 750k trigger at 05:04Z and kept working for 90 minutes; it was
 * then killed by a restart, so its end never came: no reading, no check, no
 * `/compact`. Each API call's usage already arrives as the turn runs
 * (`onLiveUsage`); the context it read must become the occupancy and be
 * checked at once.
 *
 * Runs the REAL `StreamExecutor.execute()`.
 *
 * ssot-task: T3
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
        persistAndBroadcast: vi.fn(),
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
    requestCoordinator: {
      removeController: vi.fn(),
      touchSession: vi.fn(),
      isRequestActive: vi.fn().mockReturnValue(false),
    },
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

function makeSession() {
  return {
    sessionId: 'sess_long_turn',
    ownerId: 'U_TEST',
    logVerbosity: LOG_DETAIL,
    terminated: false,
    model: 'claude-opus-5-5[1m]',
    usage: {
      contextWindow: 1_000_000,
      // The goal turn's starting point in the incident.
      currentInputTokens: 0,
      currentOutputTokens: 0,
      currentCacheReadTokens: 701_213,
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

const call = (id: string, cacheRead: number, sidechain = false) => ({
  type: 'assistant',
  ...(sidechain ? { parent_tool_use_id: 'toolu_sub' } : {}),
  message: {
    id,
    model: 'claude-opus-5-5',
    usage: {
      input_tokens: 2,
      output_tokens: 300,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 1_000,
    },
    content: [{ type: 'text', text: id }],
  },
});

async function runTurn(stream: () => AsyncIterable<any>, session = makeSession()) {
  const deps = createDeps(stream);
  deps.dispatchPendingUserMessage = vi.fn().mockResolvedValue(undefined);
  const executor = new StreamExecutor(deps);
  const abortController = new AbortController();
  const done = executor.execute({
    session,
    sessionKey: 'C1:t1',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController,
    processedFiles: [],
    text: 'continue',
    channel: 'C1',
    threadTs: 't1',
    user: 'U_TEST',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    isUserInput: false,
  } as any);
  return { session, deps, done, abortController };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auto-compact check runs as each call lands, not at turn end (T3)', () => {
  it('a call over the 750k trigger arms auto-compact while the turn is still running', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    async function* stream() {
      yield call('msg_1', 720_000);
      yield call('msg_2', 760_000);
      await held; // the turn keeps working — it has not ended
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        usage: {
          input_tokens: 4,
          output_tokens: 600,
          cache_read_input_tokens: 1_480_000,
          cache_creation_input_tokens: 2_000,
        },
      };
    }
    const { session, deps, done } = await runTurn(stream);

    await vi.waitFor(() => expect(session.autoCompactPending).toBe(true), { timeout: 3_000 });
    // Saved while the turn is still running — a restart now keeps the reading.
    expect(deps.claudeHandler.getSessionRegistry().persistAndBroadcast).toHaveBeenCalledWith('C1:t1');
    // The occupancy a save during the turn would persist is the call's, not the turn-start figure.
    expect(occupancyOf(session)).toBe(2 + 300 + 760_000 + 1_000);

    release();
    await done;
  });

  it('calls under the trigger leave auto-compact disarmed', async () => {
    async function* stream() {
      yield call('msg_1', 705_000);
      yield call('msg_2', 710_000);
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        usage: {
          input_tokens: 4,
          output_tokens: 600,
          cache_read_input_tokens: 1_415_000,
          cache_creation_input_tokens: 2_000,
        },
      };
    }
    const { session, done } = await runTurn(stream);
    await done;
    expect(session.autoCompactPending).not.toBe(true);
  });

  it('a subagent call reads its own context — it never arms the main session', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    async function* stream() {
      yield call('msg_1', 705_000);
      yield call('sub_1', 900_000, true);
      await held;
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        usage: {
          input_tokens: 4,
          output_tokens: 600,
          cache_read_input_tokens: 705_000,
          cache_creation_input_tokens: 1_000,
        },
      };
    }
    const { session, done } = await runTurn(stream);
    await new Promise((r) => setTimeout(r, 300));
    expect(session.autoCompactPending).not.toBe(true);
    expect(occupancyOf(session)).toBeLessThan(750_000);
    release();
    await done;
  });
});

/**
 * ssot-task: T3 — a turn cannot compact itself, and one turn alone can use up
 * the whole gap between the trigger and the hard limit (the incident's goal
 * turn grew 701k → 950k, +249k, against a 750k → 977k gap of 227k). Once the
 * threshold is crossed mid-turn, the turn stops at once and the work goes on
 * after a `/compact` — the same point the SDK's own auto-compact would act.
 */
describe('a turn that crosses the trigger is stopped and continued after /compact (T3)', () => {
  function crossingStream(held: Promise<void>) {
    return async function* stream() {
      yield call('msg_1', 720_000);
      yield call('msg_2', 760_000);
      await held;
      yield call('msg_3', 800_000);
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        usage: {
          input_tokens: 6,
          output_tokens: 900,
          cache_read_input_tokens: 2_280_000,
          cache_creation_input_tokens: 3_000,
        },
      };
    };
  }

  it("stops the running turn quietly (reason auto-compact) — the hand-off is the dispatcher's, not this turn's", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { session, deps, done, abortController } = await runTurn(crossingStream(held));

    await vi.waitFor(() => expect(abortController.signal.aborted).toBe(true), { timeout: 3_000 });
    expect(abortController.signal.reason).toBe('auto-compact');
    release();
    await done;

    // Armed and saved; the work is resumed once the dispatch slot is closed
    // (slack-handler `resumeAfterAutoCompactStop`, see
    // `slack-handler.auto-compact-resume.test.ts`) — never from inside this turn.
    expect(session.autoCompactPending).toBe(true);
    expect(deps.dispatchPendingUserMessage).not.toHaveBeenCalled();
    // A quiet stop: the SDK session survives for the compaction to resume.
    expect(session.sessionId).toBe('sess_long_turn');
  });
});

describe('a stale stored occupancy does not arm the next turn (T3)', () => {
  it('a stored 950k with a 120k first call reads 120k and stays disarmed', async () => {
    const session = makeSession();
    session.usage.currentCacheReadTokens = 950_637;
    async function* stream() {
      yield call('msg_1', 118_000);
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        usage: {
          input_tokens: 2,
          output_tokens: 300,
          cache_read_input_tokens: 118_000,
          cache_creation_input_tokens: 1_000,
        },
      };
    }
    const { deps, done, abortController } = await runTurn(stream, session);
    await done;
    expect(abortController.signal.aborted).toBe(false);
    expect(session.autoCompactPending).not.toBe(true);
    expect(occupancyOf(session)).toBe(2 + 300 + 118_000 + 1_000);
    expect(deps.dispatchPendingUserMessage).not.toHaveBeenCalled();
  });
});

/**
 * ssot-task: T3 — livelock breaker. A turn that STARTED over the trigger (a
 * compaction left the context above a low user trigger, e.g. `/autocompact
 * 100k`) is armed but not stopped: stopping it would compact, replay, cross
 * again on the first call and stop again — paid compactions, no progress.
 */
describe('a turn that started over the trigger is armed, not stopped (T3)', () => {
  it('stored 760k at turn start, calls at 770k → armed, the turn runs on', async () => {
    const session = makeSession();
    session.usage.currentCacheReadTokens = 760_000;
    async function* stream() {
      yield call('msg_1', 768_000);
      yield call('msg_2', 772_000);
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        usage: {
          input_tokens: 4,
          output_tokens: 600,
          cache_read_input_tokens: 1_540_000,
          cache_creation_input_tokens: 2_000,
        },
      };
    }
    const { done, abortController } = await runTurn(stream, session);
    await done;
    expect(session.autoCompactPending).toBe(true);
    expect(abortController.signal.aborted).toBe(false);
  });
});
