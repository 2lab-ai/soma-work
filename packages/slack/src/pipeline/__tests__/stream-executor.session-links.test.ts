/**
 * 세션 링크 자동 기록 (SSOT 2026-11-02 goal: "작업 카드에 디폴트로 표시해야 하는 중요한 것: 연결된 이슈(지라 혹은
 * 깃허브 이슈)들과 이슈 상태, 연결된 PR들과 머지 상태, 연결된 위키들") — one turn records every link it names, so the
 * task card shows them. Harness shape copied from `stream-executor.release-notes.test.ts`.
 *
 *   E1  the user's message: on the first turn its links join what the dispatch set ('if-empty'); on a follow-up the
 *       first of each kind becomes current ('first')
 *   E2  the reply: the links it names, current only where none is ('if-empty')
 *   E3  a `gh pr create`: the new PR, current ('always'); `gh pr view` and a listing record nothing
 *   E4  a host turn (not the user's words) records nothing from its text
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_DETAIL } from '../../output-flags';
import { StreamExecutor, setStreamExecutorProviders } from '../stream-executor';

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

const CHANNEL = 'C0INFRA0001';
const THREAD = '1757500000.000100';
const SESSION_KEY = `${CHANNEL}:${THREAD}`;

function createDeps(turnText: string): any {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      setSessionLinks: vi.fn(),
      noteSessionLinks: vi.fn().mockReturnValue(true),
      noteSessionLinksByKey: vi.fn().mockReturnValue(true),
      addSourceWorkingDir: vi.fn(),
      streamAgentEvents: vi.fn().mockImplementation(() =>
        (async function* () {
          for (const event of streamEvents(turnText)) yield event;
        })(),
      ),
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
      // As ToolEventProcessor does: a main-agent result is named from the tool tracker (here every call is Bash).
      handleToolResult: vi.fn().mockImplementation(async (results: Array<{ toolName?: string }>) => {
        for (const r of results) r.toolName = 'Bash';
      }),
      handleAgentTaskLifecycle: vi.fn(),
      setReactionManager: vi.fn(),
      setToolResultSink: vi.fn(),
      getLiveBackgroundWork: vi.fn().mockReturnValue({ count: 0, labels: [], signature: '' }),
      cleanup: vi.fn(),
    },
    statusReporter: {
      getStatusEmoji: vi.fn().mockReturnValue('thinking_face'),
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
      // The `channel_message` directive's only effect: a post to the channel ROOT.
      postMessage: vi.fn().mockResolvedValue({ ts: '1757500009.000100' }),
      getPermalink: vi.fn().mockResolvedValue('https://slack.test/p1757500009000100'),
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

function createSession(extra: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess_deploy',
    ownerId: 'U_DEPLOYER',
    title: 'card links',
    logVerbosity: LOG_DETAIL,
    usage: {},
    terminated: false,
    ...extra,
  };
}

function createParams(session: any): any {
  return {
    session,
    sessionKey: SESSION_KEY,
    userName: 'deployer',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text: USER_TEXT,
    channel: CHANNEL,
    threadTs: THREAD,
    user: 'U_DEPLOYER',
    isUserInput: true,
    say: vi.fn().mockResolvedValue({ ts: 'm' }),
  };
}

/** Let the fire-and-forget liveness writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const USER_TEXT =
  '이 이슈 해줘 https://2lab.atlassian.net/browse/PAY-12 — 참고 PR https://github.com/2lab-ai/soma-work/pull/700';
const REPLY = '설계 문서 https://2lab.atlassian.net/wiki/spaces/PAY/pages/123456/Payment+Form+Design 를 따랐습니다.';
const NEW_PR = 'https://github.com/2lab-ai/soma-work/pull/801';
let streamEvents: (turnText: string) => unknown[] = (turnText) => [
  { type: 'assistant_delta', text: turnText },
  { type: 'result', stopReason: 'end_turn', finalText: turnText },
];

describe('StreamExecutor — the links a turn names are recorded on its session', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('E1 · E2 · E3 — the first message (if-empty), the reply (if-empty), a created PR (always)', async () => {
    streamEvents = () => [
      { type: 'tool_call', toolCallId: 'tu1', name: 'Bash', input: { command: 'gh pr create --fill' } },
      {
        type: 'tool_result',
        toolCallId: 'tu1',
        name: 'Bash',
        content: [{ type: 'text', text: `Creating pull request for feat/x into main\n\n${NEW_PR}\n` }],
      },
      { type: 'tool_call', toolCallId: 'tu2', name: 'Bash', input: { command: 'gh pr list' } },
      {
        type: 'tool_result',
        toolCallId: 'tu2',
        name: 'Bash',
        content: [{ type: 'text', text: '#700 https://github.com/2lab-ai/soma-work/pull/700\nshowing 1 of 1' }],
      },
      { type: 'tool_call', toolCallId: 'tu3', name: 'Bash', input: { command: 'gh pr view 650 --json url -q .url' } },
      {
        type: 'tool_result',
        toolCallId: 'tu3',
        name: 'Bash',
        content: [{ type: 'text', text: 'https://github.com/2lab-ai/soma-work/pull/650' }],
      },
      { type: 'assistant_delta', text: REPLY },
      { type: 'result', stopReason: 'end_turn', finalText: REPLY },
    ];
    const deps = createDeps(REPLY);
    await new StreamExecutor(deps).execute(createParams(createSession()));
    await settle();

    const calls = deps.claudeHandler.noteSessionLinks.mock.calls.map((c: any[]) => [
      c[0],
      c[1],
      c[3],
      c[2].map((l: { url: string }) => l.url),
    ]);
    expect(calls).toContainEqual([
      CHANNEL,
      THREAD,
      'if-empty',
      ['https://2lab.atlassian.net/browse/PAY-12', 'https://github.com/2lab-ai/soma-work/pull/700'],
    ]);
    expect(calls).toContainEqual([CHANNEL, THREAD, 'always', [NEW_PR]]);
    expect(calls).toContainEqual([
      CHANNEL,
      THREAD,
      'if-empty',
      ['https://2lab.atlassian.net/wiki/spaces/PAY/pages/123456/Payment+Form+Design'],
    ]);
    // The listing named #700 and `gh pr view` printed #650, but neither created anything.
    expect(calls.filter((c: unknown[]) => c[2] === 'always')).toEqual([[CHANNEL, THREAD, 'always', [NEW_PR]]]);
  });

  it('E1 — a follow-up message: the first link of each kind becomes current', async () => {
    streamEvents = (t) => [
      { type: 'assistant_delta', text: t },
      { type: 'result', stopReason: 'end_turn', finalText: t },
    ];
    const deps = createDeps('네.');
    await new StreamExecutor(deps).execute(createParams(createSession({ initialInstruction: '처음 지시' })));
    await settle();
    const modes = deps.claudeHandler.noteSessionLinks.mock.calls.map((c: any[]) => c[3]);
    expect(modes).toEqual(['first']);
  });

  it('E4 — a host turn (a continuation, a resume) records nothing from its text', async () => {
    streamEvents = (t) => [
      { type: 'assistant_delta', text: t },
      { type: 'result', stopReason: 'end_turn', finalText: t },
    ];
    const deps = createDeps('끝.');
    await new StreamExecutor(deps).execute({ ...createParams(createSession()), isUserInput: false });
    await settle();
    expect(deps.claudeHandler.noteSessionLinks).not.toHaveBeenCalled();
  });
});
