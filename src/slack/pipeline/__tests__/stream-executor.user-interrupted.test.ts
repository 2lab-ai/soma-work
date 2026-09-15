/**
 * U6 / A11 — explicit user interrupt (`Send now`) propagation through the
 * real `StreamExecutor.execute()` abort rail.
 *
 * Contract (`.prd/slack-agent-ui/ssot.md` §3.3, `.prd/04-slack-agent-ui-spec.md` A11):
 *   - `Send now` interrupts the in-flight turn EXPLICITLY. The turn end must
 *     carry that fact literally (`user-interrupted`) — it must never be
 *     heuristically downgraded to a generic error or to the stall-timeout
 *     card, because the user already knows they pressed the button.
 *   - The partial output produced before the interrupt is PRESERVED (no
 *     failTurn, no delete) and marked with the literal tag.
 *   - The header phase says "사용자 요청으로 중단" — an interrupt, not an error.
 *
 * These tests drive the executor end-to-end (mock SDK stream → abort with the
 * tagged reason mid-stream → catch rail) rather than calling `handleError`
 * directly, because the regression this pins is the *propagation* from
 * `signal.reason` through `coerceAbortReason` into `threadPanel.endTurn`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentStreamFromSdk } from '../../../agent-runtime/claude-code/stream-runner';

// The executor consumes `claudeHandler.streamAgentEvents` (neutral
// AgentStreamEvents). These fixtures produce SDKMessage streams, so wrap them
// through the real mapper — same shape production sees.
function toAgentEvents(sdkStream: AsyncIterable<any>): AsyncIterable<any> {
  return runAgentStreamFromSdk(sdkStream, { calculateTokenCost: () => 0 });
}

import { LOG_DETAIL } from '@soma/slack/output-flags';
// Package import (rules/packaging.md): tests consume `@soma/slack/**` through
// the published entry points, never a deep `packages/slack/src/**` path.
// Freshness of that entry point is the central build's job — this file gates
// behaviour, not build state.
import { StreamExecutor, setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';

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

/** Partial assistant output emitted BEFORE the interrupt lands. */
const PARTIAL_TEXT = '조사 중간 결과입니다: 첫 번째 후보를 확인했고';

/**
 * Mock SDK stream that streams a partial answer, commits it to the surface
 * (the tool_use event closes the text render group → `appendText`), and only
 * THEN gets interrupted: the `Send now` handler aborts the in-flight
 * controller with the explicit reason and the SDK unwinds with an AbortError.
 * That ordering is what makes "partial output already on the surface" real —
 * text still buffered inside the stream processor at abort time never reached
 * Slack in the first place.
 */
function interruptedStream(abortController: AbortController, reason: string) {
  return async function* (): AsyncGenerator<any> {
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: PARTIAL_TEXT }] },
    };
    yield {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }] },
    };
    abortController.abort(reason);
    const err = new Error('Request was aborted');
    err.name = 'AbortError';
    throw err;
  };
}

function createDeps(streamFn: () => AsyncIterable<any>): any {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      streamQuery: vi.fn().mockImplementation(streamFn),
      streamAgentEvents: vi.fn().mockImplementation(() => toAgentEvents(streamFn())),
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
    },
    slackApi: {
      getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
      getClient: vi.fn().mockReturnValue({}),
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    },
    turnNotifier: {
      notify: vi.fn().mockResolvedValue(undefined),
    },
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
      // B1 stream active — partial text flows through appendText, which is
      // where the preserved output lives.
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

function createParams(abortController: AbortController, say: ReturnType<typeof vi.fn>): any {
  return {
    session: {
      sessionId: 'sess_u6',
      ownerId: 'U_TEST',
      title: 'U6 turn',
      logVerbosity: LOG_DETAIL,
      usage: {},
      terminated: false,
    },
    sessionKey: 'C42:thread42',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController,
    processedFiles: [],
    text: '원래 유저 요청',
    channel: 'C42',
    threadTs: 'thread42',
    user: 'U_TEST',
    isUserInput: true,
    say,
  };
}

/** Run execute() with a stream that aborts mid-way using `reason`. */
async function runAbortedTurn(reason: string) {
  const abortController = new AbortController();
  const deps = createDeps(() => interruptedStream(abortController, reason)());
  const executor = new StreamExecutor(deps);
  const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
  const result = await executor.execute(createParams(abortController, say));
  return { deps, say, result };
}

/** All endTurn reason tags observed on the panel façade, in call order. */
function endTurnReasons(deps: any): string[] {
  return deps.threadPanel.endTurn.mock.calls.map((c: any[]) => c[1]);
}

/** agentPhase values pushed through updateRuntimeStatus → threadPanel.setStatus. */
function agentPhases(deps: any): string[] {
  return deps.threadPanel.setStatus.mock.calls
    .map((c: any[]) => c[2]?.agentPhase)
    .filter((p: unknown): p is string => typeof p === 'string');
}

describe('U6/A11 — explicit user interrupt propagation (StreamExecutor.execute)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('tags the turn end literally `user-interrupted` (never downgraded to generic abort)', async () => {
    const { deps } = await runAbortedTurn('user-interrupted');

    const reasons = endTurnReasons(deps);
    expect(reasons).toContain('user-interrupted');
    // The catch rail must NOT fall back to the generic tag for this reason —
    // that is exactly the heuristic downgrade A11 forbids.
    expect(reasons).not.toContain('aborted');
    // Same turn the surface opened, so the marker lands on the original block.
    const openedTurnId = deps.threadPanel.beginTurn.mock.calls[0][0].turnId;
    expect(deps.threadPanel.endTurn.mock.calls[0][0]).toBe(openedTurnId);
    // The catch rail writes the marker FIRST; the finally rail still fires its
    // idempotent `'completed'` close afterwards (unchanged — the surface
    // no-ops it because the turn is already closed). Order matters: a
    // `'completed'` that landed first would overwrite the interrupt marker.
    expect(reasons).toEqual(['user-interrupted', 'completed']);
  });

  it('raises no Exception / Stalled card and never routes through failTurn', async () => {
    const { deps, say } = await runAbortedTurn('user-interrupted');

    expect(deps.turnNotifier.notify).not.toHaveBeenCalled();
    expect(deps.threadPanel.failTurn).not.toHaveBeenCalled();
    // No 🔴 / ⚫ fallback text either (the B-4 say() rail must stay closed).
    const terminalCards = say.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && (c[0].text.startsWith('🔴') || c[0].text.startsWith('⚫')),
    );
    expect(terminalCards).toHaveLength(0);
  });

  it('preserves the partial output produced before the interrupt', async () => {
    const { deps } = await runAbortedTurn('user-interrupted');

    const appended = deps.threadPanel.appendText.mock.calls.map((c: any[]) => c[1]).join('');
    expect(appended).toContain(PARTIAL_TEXT);
    // Nothing deletes or rewrites the emitted partial output.
    expect(deps.slackApi.deleteMessage).not.toHaveBeenCalled();
  });

  it('sets the header phase to the explicit interrupt wording, not an error phase', async () => {
    const { deps } = await runAbortedTurn('user-interrupted');

    const phases = agentPhases(deps);
    expect(phases).toContain('사용자 요청으로 중단');
    expect(phases).not.toContain('오류 발생');
    expect(phases).not.toContain('요청 취소됨');
  });

  // ---------------------------------------------------------------------
  // Neighbouring abort behaviour must be untouched.
  // ---------------------------------------------------------------------

  it('unchanged: `user-stop` still ends with the generic tag and the 요청 취소됨 phase', async () => {
    const { deps } = await runAbortedTurn('user-stop');

    expect(endTurnReasons(deps)).toContain('aborted');
    expect(endTurnReasons(deps)).not.toContain('user-interrupted');
    expect(agentPhases(deps)).toContain('요청 취소됨');
    expect(deps.turnNotifier.notify).not.toHaveBeenCalled();
  });

  it('unchanged: the stall heuristic is unrelated — `stall-timeout` still emits a Stalled card', async () => {
    const { deps } = await runAbortedTurn('stall-timeout');

    expect(endTurnReasons(deps)).toContain('aborted');
    expect(deps.turnNotifier.notify).toHaveBeenCalledTimes(1);
    expect(deps.turnNotifier.notify.mock.calls[0][0].category).toBe('Stalled');
  });

  it('unchanged: an unknown abort tag still surfaces the generic Exception card', async () => {
    const { deps } = await runAbortedTurn('totally-unknown-reason');

    expect(deps.turnNotifier.notify).toHaveBeenCalledTimes(1);
    const event = deps.turnNotifier.notify.mock.calls[0][0];
    expect(event.category).toBe('Exception');
    expect(event.message).toBe('턴이 알 수 없는 이유로 중단되었습니다.');
  });
});

// ---------------------------------------------------------------------------
// A11 end-to-end: text that arrived with NO group boundary after it (no tool
// call, no result) used to be dropped — both abort exits return from inside
// the processor loop, skipping the post-loop flush. The rescue must land on
// the turn's own stream, and it must land BEFORE the interrupt marker closes
// the turn: a marker written first would seal the surface and the rescued
// text would have nowhere to go.
// ---------------------------------------------------------------------------
describe('U6/A11 — rescue ordering for a bare text delta + interrupt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flushes the partial text to the turn stream BEFORE the user-interrupted marker', async () => {
    const abortController = new AbortController();
    // Text, then the interrupt — no tool boundary in between.
    const deps = createDeps(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: PARTIAL_TEXT }] },
        };
        abortController.abort('user-interrupted');
        const err = new Error('Request was aborted');
        err.name = 'AbortError';
        throw err;
      })(),
    );

    // Single ordered log across both surface calls.
    const order: string[] = [];
    deps.threadPanel.appendText = vi.fn(async (_turnId: string, text: string) => {
      order.push(`append:${text}`);
      return true;
    });
    const endTurn = deps.threadPanel.endTurn;
    deps.threadPanel.endTurn = vi.fn(async (turnId: string, reason: string) => {
      order.push(`end:${reason}`);
      return endTurn(turnId, reason);
    });

    const executor = new StreamExecutor(deps);
    await executor.execute(createParams(abortController, vi.fn().mockResolvedValue({ ts: 'm' })));

    const appendIdx = order.findIndex((e) => e.startsWith('append:'));
    const markerIdx = order.indexOf('end:user-interrupted');
    expect(appendIdx).toBeGreaterThanOrEqual(0);
    expect(order[appendIdx]).toContain(PARTIAL_TEXT);
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(appendIdx).toBeLessThan(markerIdx);
  });
});

// ---------------------------------------------------------------------------
// A11 — a rescue that could NOT be delivered is still a loss of the user's
// answer. The processor retries it once and then reports it; the executor must
// say so on the surface the user is already looking at (the interrupt header),
// not bury it in a log line and not open a new message on a turn that just
// ended.
// ---------------------------------------------------------------------------
describe('U6/A11 — degraded notice when the interrupt rescue is lost', () => {
  const DEGRADED_NOTE = '중단 시점의 일부 출력을 전송하지 못했습니다';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Bare text delta + interrupt, with `appendText` wired by the caller. */
  async function runRescue(appendText: ReturnType<typeof vi.fn>) {
    const abortController = new AbortController();
    const deps = createDeps(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: PARTIAL_TEXT }] },
        };
        abortController.abort('user-interrupted');
        const err = new Error('Request was aborted');
        err.name = 'AbortError';
        throw err;
      })(),
    );
    deps.threadPanel.appendText = appendText;
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const executor = new StreamExecutor(deps);
    await executor.execute(createParams(abortController, say));
    return { deps, say };
  }

  it('names the lost partial output in the interrupt header (no new message)', async () => {
    const { deps, say } = await runRescue(vi.fn().mockRejectedValue(new Error('slack down')));

    const phases = agentPhases(deps);
    // Still an interrupt, not an error — the note rides the SAME header write.
    expect(phases.some((p) => p.includes('사용자 요청으로 중단'))).toBe(true);
    expect(phases.some((p) => p.includes(DEGRADED_NOTE))).toBe(true);
    expect(phases).not.toContain('오류 발생');
    // The notice must not become a separate post on the thread.
    const posted = say.mock.calls.filter((c: any[]) => String(c[0]?.text ?? '').includes(DEGRADED_NOTE));
    expect(posted).toHaveLength(0);
  });

  it('leaves the interrupt header clean when the rescue was delivered', async () => {
    const { deps } = await runRescue(vi.fn().mockResolvedValue(true));

    const phases = agentPhases(deps);
    expect(phases).toContain('사용자 요청으로 중단');
    expect(phases.some((p) => p.includes(DEGRADED_NOTE))).toBe(false);
  });
});
