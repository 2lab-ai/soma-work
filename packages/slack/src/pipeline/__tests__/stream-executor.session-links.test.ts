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
 *   E5  a REST write (#832): a `curl -X POST …/pulls` is recorded as created ('always'), a merge updates the PR's state
 *       ('update'), a comment POST records nothing — every agent's calls, a subagent's included
 *   E6  turn end (#833): the host is asked to reconcile the session's PRs with GitHub — once, after the turn, with
 *       its key, session and working directory; a throwing reconciler never breaks the turn
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

  it('E5 — a REST create is current, a merge updates the state, a comment records nothing (#832)', async () => {
    const created = 'https://github.com/2lab-ai/soma-work/pull/823';
    streamEvents = () => [
      {
        type: 'tool_call',
        toolCallId: 'r1',
        name: 'Bash',
        input: {
          command:
            'jq -n --rawfile b body.md \'{title:"x",head:"fix/x",base:"main",body:$b}\' | curl -s -X POST -H "Authorization: Bearer $T" https://api.github.com/repos/2lab-ai/soma-work/pulls -d @- | jq \'{number,html_url}\'',
        },
      },
      {
        type: 'tool_result',
        toolCallId: 'r1',
        name: 'Bash',
        content: [{ type: 'text', text: `{\n  "number": 823,\n  "html_url": "${created}"\n}` }],
      },
      {
        type: 'tool_call',
        toolCallId: 'r2',
        name: 'Bash',
        input: {
          command:
            'curl -s -X POST https://api.github.com/repos/2lab-ai/soma-work/issues/823/comments -d @c.json | jq -r .html_url',
        },
      },
      {
        type: 'tool_result',
        toolCallId: 'r2',
        name: 'Bash',
        content: [{ type: 'text', text: `${created}#issuecomment-1` }],
      },
      // A subagent merges it: the host's own bookkeeping takes every agent's calls.
      {
        type: 'tool_call',
        toolCallId: 'r3',
        name: 'Bash',
        parentToolUseId: 'task1',
        input: { command: 'curl -s -X PUT https://api.github.com/repos/2lab-ai/soma-work/pulls/823/merge' },
      },
      {
        type: 'tool_result',
        toolCallId: 'r3',
        name: 'Bash',
        parentToolUseId: 'task1',
        content: [{ type: 'text', text: '{"sha":"abc","merged":true,"message":"Pull Request successfully merged"}' }],
      },
      { type: 'assistant_delta', text: '끝.' },
      { type: 'result', stopReason: 'end_turn', finalText: '끝.' },
    ];
    const deps = createDeps('끝.');
    await new StreamExecutor(deps).execute({ ...createParams(createSession()), isUserInput: false });
    await settle();
    const calls = deps.claudeHandler.noteSessionLinks.mock.calls.map((c: any[]) => [
      c[3],
      c[2].map((l: { url: string; status?: string }) => (l.status ? `${l.url} ${l.status}` : l.url)),
    ]);
    expect(calls).toEqual([
      ['always', [created]],
      ['update', [`${created} merged`]],
    ]);
  });
  it('E6 — only what GitHub confirms reaches the card, when it answers; a late answer for a replaced session is dropped (#832 r17)', async () => {
    const created = 'https://github.com/2lab-ai/soma-work/pull/823';
    streamEvents = () => [
      {
        type: 'tool_call',
        toolCallId: 'r1',
        name: 'Bash',
        input: {
          command:
            'jq -n \'{title:"x",head:"fix/x",base:"main"}\' | curl -s -X POST https://api.github.com/repos/2lab-ai/soma-work/pulls -d @- | jq \'{number,html_url}\'',
        },
      },
      {
        type: 'tool_result',
        toolCallId: 'r1',
        name: 'Bash',
        content: [{ type: 'text', text: `{\n  "number": 823,\n  "html_url": "${created}"\n}` }],
      },
      { type: 'assistant_delta', text: '끝.' },
      { type: 'result', stopReason: 'end_turn', finalText: '끝.' },
    ];
    let release: (v: ReadonlyArray<unknown>) => void = () => {};
    const asked: unknown[] = [];
    const intercepted: Array<[number, string[]]> = [];
    setStreamExecutorProviders({
      // Metrics: the batch's results at once, the PR effects when GitHub answers (fable-zhuge, round 18).
      interceptToolResults: (
        results: unknown[],
        _u: string,
        _n: string,
        _k: string,
        _cb: unknown,
        effects: Array<{ op: string }>,
      ) => {
        intercepted.push([results.length, (effects ?? []).map((e) => e.op)]);
      },
      confirmGithubEffects: (args) => {
        asked.push(args);
        return new Promise((resolve) => {
          release = resolve as typeof release;
        });
      },
    });
    try {
      // 1. GitHub confirms after the turn: recorded then, with the call's start and input.
      const deps = createDeps('끝.');
      const session = createSession();
      deps.claudeHandler.getSessionByKey = vi.fn().mockReturnValue(session);
      const turnStart = Date.now();
      await new StreamExecutor(deps).execute({ ...createParams(session), isUserInput: false });
      await settle();
      expect(deps.claudeHandler.noteSessionLinks).not.toHaveBeenCalled();
      expect(intercepted).toEqual([[1, []]]);
      const a = asked[0] as {
        effects: Array<{ op: string; toolUseId: string }>;
        startedAt: Map<string, number>;
        inputs: Map<string, string>;
      };
      expect(a.effects.map((e) => [e.op, e.toolUseId])).toEqual([['create', 'r1']]);
      // The lower bound is the turn's start, not when the host saw the call (fable-zhuge, round 18).
      expect(a.startedAt.get('r1')).toBeGreaterThanOrEqual(turnStart);
      expect(a.startedAt.get('r1')).toBeLessThanOrEqual(Date.now());
      expect(a.inputs.get('r1')).toContain('head:"fix/x"');
      release(a.effects);
      await settle();
      expect(intercepted).toEqual([
        [1, []],
        [0, ['create']],
      ]);
      expect(
        deps.claudeHandler.noteSessionLinks.mock.calls.map((c: any[]) => [c[3], c[2].map((l: any) => l.url)]),
      ).toEqual([['always', [created]]]);

      // 2. GitHub does not confirm it: nothing.
      const deps2 = createDeps('끝.');
      const session2 = createSession();
      deps2.claudeHandler.getSessionByKey = vi.fn().mockReturnValue(session2);
      await new StreamExecutor(deps2).execute({ ...createParams(session2), isUserInput: false });
      await settle();
      release([]);
      await settle();
      expect(deps2.claudeHandler.noteSessionLinks).not.toHaveBeenCalled();

      // 3. The session was replaced before GitHub answered: nothing lands on the new one.
      const deps3 = createDeps('끝.');
      const session3 = createSession();
      deps3.claudeHandler.getSessionByKey = vi.fn().mockReturnValue(createSession({ sessionId: 'sess_new' }));
      await new StreamExecutor(deps3).execute({ ...createParams(session3), isUserInput: false });
      await settle();
      release((asked[2] as { effects: ReadonlyArray<unknown> }).effects);
      await settle();
      expect(deps3.claudeHandler.noteSessionLinks).not.toHaveBeenCalled();
    } finally {
      setStreamExecutorProviders({ confirmGithubEffects: ({ effects }) => effects, interceptToolResults: () => {} });
    }
  });

  it('E7 — turn end asks the host to reconcile the session with GitHub; a throw never breaks the turn (#833)', async () => {
    streamEvents = (t) => [
      { type: 'assistant_delta', text: t },
      { type: 'result', stopReason: 'end_turn', finalText: t },
    ];
    const reconcileSessionPrs = vi.fn(() => {
      throw new Error('boom');
    });
    setStreamExecutorProviders({ reconcileSessionPrs });
    try {
      const deps = createDeps('끝.');
      const session = createSession();
      const result = await new StreamExecutor(deps).execute(createParams(session));
      await settle();
      expect(result.success).toBe(true);
      expect(reconcileSessionPrs).toHaveBeenCalledTimes(1);
      expect(reconcileSessionPrs).toHaveBeenCalledWith({
        sessionKey: SESSION_KEY,
        session,
        workingDirectory: '/tmp/test',
      });
      // A terminated session is not reconciled.
      reconcileSessionPrs.mockClear();
      await new StreamExecutor(createDeps('끝.')).execute(createParams(createSession({ terminated: true })));
      expect(reconcileSessionPrs).not.toHaveBeenCalled();
    } finally {
      setStreamExecutorProviders({ reconcileSessionPrs: () => {} });
    }
  });
});
