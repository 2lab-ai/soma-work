/**
 * A28 + U9 — what a turn stamps on its header writes.
 *
 * A28: `Send now` can start a NEW turn while the old one is still tearing
 * down. Every header write the old turn makes — including the ones that land
 * after teardown (error rail, cleanup panel render) — must carry the turn
 * generation CAPTURED AT DISPATCH, so the surface can drop it instead of
 * repainting the new turn. Reading the session's current generation at write
 * time would always match and gate nothing, which is why these tests mutate
 * `session.turnEpoch` mid-turn and still expect the captured value.
 *
 * U9: heartbeat (`onSdkActivity`) advances `lastSignalAt` only; real progress
 * (`onProgress`) advances both clocks. A bookkeeping-only stream must not be
 * able to claim "마지막 활동" moved.
 */

import { LOG_DETAIL } from '@soma/slack/output-flags';
// Package import (rules/packaging.md): tests consume `@soma/slack/**` through
// the published entry points, never a deep `packages/slack/src/**` path.
// Freshness of that entry point is the central build's job — this file gates
// behaviour, not build state.
import { StreamExecutor, setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The package module ships inert defaults for every injected provider except
 * the user-settings store (its default is the real one, which needs a DB).
 * Inject a stub on THIS module instance — the src wrapper's injection targets
 * the dist copy and would not reach the source class under test.
 */
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

/** Turn generation the host dispatched this run with. */
const DISPATCH_EPOCH = 4;
/** Generation the session moves to when `Send now` fires mid-turn. */
const SUPERSEDING_EPOCH = 9;

function createDeps(streamFn: () => AsyncIterable<any>): any {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      streamAgentEvents: vi.fn().mockImplementation(streamFn),
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
      getLiveBackgroundWork: vi.fn().mockReturnValue({ count: 0, labels: [], signature: '' }),
      cleanup: vi.fn(),
    },
    statusReporter: {
      updateStatusDirect: vi.fn().mockResolvedValue(undefined),
      getStatusEmoji: vi.fn().mockReturnValue('thinking_face'),
      cleanup: vi.fn(),
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

function createSession(): any {
  return {
    sessionId: 'sess_epoch',
    ownerId: 'U_TEST',
    title: 'A28 turn',
    logVerbosity: LOG_DETAIL,
    usage: {},
    terminated: false,
    // The generation the host dispatched with; `Send now` bumps it mid-turn.
    turnEpoch: DISPATCH_EPOCH,
  };
}

function createParams(session: any, abortController: AbortController, say: ReturnType<typeof vi.fn>): any {
  return {
    session,
    sessionKey: 'C42:thread42',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController,
    processedFiles: [],
    text: '원래 요청',
    channel: 'C42',
    threadTs: 'thread42',
    user: 'U_TEST',
    isUserInput: true,
    followupTurnEpoch: DISPATCH_EPOCH,
    say,
  };
}

/** Every `expectedTurnEpoch` the run stamped on status + panel writes. */
function stampedEpochs(deps: any): unknown[] {
  return [
    ...deps.threadPanel.setStatus.mock.calls.map((c: any[]) => c[3]?.expectedTurnEpoch),
    ...deps.threadPanel.updatePanel.mock.calls.map((c: any[]) => c[2]?.expectedTurnEpoch),
  ];
}

/** Status patches, in call order. */
function patches(deps: any): any[] {
  return deps.threadPanel.setStatus.mock.calls.map((c: any[]) => c[2]);
}

/** Let the fire-and-forget liveness writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('A28 — captured turn epoch on every turn-owned header write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stamps the DISPATCH epoch even after the session generation moves on mid-turn', async () => {
    const session = createSession();
    const deps = createDeps(() =>
      (async function* () {
        // `Send now` promotes a queued item: the session's generation advances
        // while this turn is still streaming.
        session.turnEpoch = SUPERSEDING_EPOCH;
        yield { type: 'assistant_delta', text: '작업 중' };
        yield { type: 'result', stopReason: 'end_turn' };
      })(),
    );
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(createParams(session, new AbortController(), say));
    await settle();

    const stamps = stampedEpochs(deps);
    expect(stamps.length).toBeGreaterThan(0);
    // Captured value only. A read of `session.turnEpoch` at write time would
    // produce SUPERSEDING_EPOCH and gate nothing.
    expect(stamps.every((e) => e === DISPATCH_EPOCH)).toBe(true);
    expect(stamps).not.toContain(SUPERSEDING_EPOCH);
    expect(stamps).not.toContain(undefined);
  });

  it('the LAST write of the turn (cleanup panel render) carries the token', async () => {
    const session = createSession();
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'result', stopReason: 'end_turn' };
      })(),
    );
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, new AbortController(), vi.fn().mockResolvedValue({ ts: 'm' })));
    await settle();

    const panelCalls = deps.threadPanel.updatePanel.mock.calls;
    expect(panelCalls.length).toBeGreaterThan(0);
    expect(panelCalls[panelCalls.length - 1][2]).toEqual({ expectedTurnEpoch: DISPATCH_EPOCH });
  });

  it('the error/abort rail stamps the token too (its writes are late by construction)', async () => {
    const session = createSession();
    const abortController = new AbortController();
    const deps = createDeps(() =>
      (async function* () {
        session.turnEpoch = SUPERSEDING_EPOCH;
        abortController.abort('user-interrupted');
        const err = new Error('Request was aborted');
        err.name = 'AbortError';
        throw err;
      })(),
    );
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, abortController, vi.fn().mockResolvedValue({ ts: 'm' })));
    await settle();

    const interruptWrite = deps.threadPanel.setStatus.mock.calls.find(
      (c: any[]) => c[2]?.agentPhase === '사용자 요청으로 중단',
    );
    expect(interruptWrite).toBeDefined();
    expect(interruptWrite[3]).toEqual({ expectedTurnEpoch: DISPATCH_EPOCH });
  });

  it('omitting followupTurnEpoch leaves writes ungated (legacy hosts unchanged)', async () => {
    const session = createSession();
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'result', stopReason: 'end_turn' };
      })(),
    );
    const executor = new StreamExecutor(deps);
    const params = createParams(session, new AbortController(), vi.fn().mockResolvedValue({ ts: 'm' }));
    params.followupTurnEpoch = undefined;

    await executor.execute(params);
    await settle();

    expect(stampedEpochs(deps).every((e) => e === undefined)).toBe(true);
  });
});

describe('U9 — heartbeat vs real progress in the header patches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a bookkeeping-only stream advances the signal clock but NOT the progress clock', async () => {
    const session = createSession();
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'usage', usage: {} };
        yield { type: 'status', status: 'working' };
        yield { type: 'result', stopReason: 'end_turn' };
      })(),
    );
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, new AbortController(), vi.fn().mockResolvedValue({ ts: 'm' })));
    await settle();

    const liveness = patches(deps).filter((p) => p?.lastSignalAt !== undefined);
    expect(liveness.length).toBeGreaterThan(0);
    // Nothing moved — the "마지막 활동" clock must stay untouched.
    expect(liveness.every((p) => p.lastProgressAt === undefined)).toBe(true);
    expect(deps.requestCoordinator.touchSession).toHaveBeenCalled();
  });

  it('a tool call advances BOTH clocks', async () => {
    const session = createSession();
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'tool_call', toolCallId: 't1', name: 'Read', input: {} };
        yield { type: 'result', stopReason: 'end_turn' };
      })(),
    );
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, new AbortController(), vi.fn().mockResolvedValue({ ts: 'm' })));
    await settle();

    const progress = patches(deps).filter((p) => p?.lastProgressAt !== undefined);
    expect(progress.length).toBeGreaterThan(0);
    // Progress is also a signal.
    expect(progress.every((p) => p.lastSignalAt === p.lastProgressAt)).toBe(true);
  });

  it('a liveness write never blanks the phase the turn is displaying', async () => {
    const session = createSession();
    session.actionPanel = { agentPhase: '생각 중', activeTool: 'Read' };
    const deps = createDeps(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: '진행 중' };
        yield { type: 'result', stopReason: 'end_turn' };
      })(),
    );
    const executor = new StreamExecutor(deps);

    await executor.execute(createParams(session, new AbortController(), vi.fn().mockResolvedValue({ ts: 'm' })));
    await settle();

    const liveness = patches(deps).filter((p) => p?.lastSignalAt !== undefined);
    expect(liveness.length).toBeGreaterThan(0);
    // ThreadSurface.setStatus assigns agentPhase from the patch unconditionally,
    // so a liveness patch that omitted it would erase the header line.
    expect(liveness.every((p) => typeof p.agentPhase === 'string' && p.agentPhase.length > 0)).toBe(true);
  });
});
