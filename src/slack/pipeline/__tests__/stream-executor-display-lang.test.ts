/**
 * #772 — the execute path puts `<display-lang>` at the very bottom of the
 * session's first instruction (after the context block), never on an SDK
 * local slash command, and again after the user changes the language.
 * Mocks mirror stream-executor-turn-origin.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentStreamFromSdk } from '../../../agent-runtime/claude-code/stream-runner';

function toAgentEvents(sdkStream: AsyncIterable<any>): AsyncIterable<any> {
  return runAgentStreamFromSdk(sdkStream, { calculateTokenCost: () => 0 });
}

const { lang } = vi.hoisted(() => ({ lang: { value: 'ko' as 'ko' | 'en' } }));

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
    getUserDefaultModel: vi.fn().mockReturnValue('claude-opus-4-6'),
    setUserDefaultModel: vi.fn(),
    getUserDefaultEffort: vi.fn().mockReturnValue('high'),
    getUserShowThinking: vi.fn().mockReturnValue(true),
    getUserRating: vi.fn().mockReturnValue(5),
    setUserRating: vi.fn(),
    consumePendingRatingChange: vi.fn().mockReturnValue(null),
    setPendingRatingChange: vi.fn(),
    getUserDisplayLanguage: vi.fn(() => lang.value),
  },
  coerceToAvailableModel: (raw: string) => raw,
  MODEL_ALIASES: { 'opus[1m]': 'claude-opus-4-8[1m]' },
}));
vi.mock('../../../channel-description-cache', () => ({ getChannelDescription: vi.fn().mockResolvedValue('') }));
vi.mock('../../../channel-registry', () => ({ getChannel: vi.fn().mockReturnValue(undefined) }));
vi.mock('../../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv_1'),
  recordAssistantTurn: vi.fn(),
  recordUserTurn: vi.fn(),
  captureUserMedia: vi.fn(async () => []),
}));
vi.mock('../../../mcp-config-builder', () => ({ isMidThreadMention: vi.fn().mockReturnValue(false) }));
vi.mock('../../../metrics/event-emitter', () => ({ getMetricsEmitter: vi.fn().mockReturnValue({ emit: vi.fn() }) }));
vi.mock('../../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue(null),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));
vi.mock('../../../token-manager', () => ({
  getTokenManager: () => ({
    getActiveToken: vi.fn().mockReturnValue(null),
    listTokens: vi.fn().mockReturnValue([]),
    rotateOnRateLimit: vi.fn().mockResolvedValue({ rotated: null, skipReason: 'no-eligible' }),
    fetchAndStoreUsage: vi.fn().mockResolvedValue(null),
  }),
  parseCooldownTime: vi.fn().mockReturnValue(null),
}));

import { createRequire } from 'node:module';
import { LOG_DETAIL } from '@soma/slack/output-flags';
import { StreamExecutor } from '../stream-executor';

async function* okStream() {
  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
  yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
}

function createDeps() {
  return {
    claudeHandler: {
      setActivityState: vi.fn(),
      clearSessionId: vi.fn(),
      streamQuery: vi.fn().mockImplementation(() => okStream()),
      streamAgentEvents: vi.fn().mockImplementation(() => toAgentEvents(okStream())),
      getSessionRegistry: vi.fn().mockReturnValue({
        beginTurn: vi.fn(),
        endTurn: vi.fn(),
        broadcastSessionUpdate: vi.fn(),
        getActivityState: vi.fn().mockReturnValue('idle'),
      }),
    },
    fileHandler: { formatFilePrompt: vi.fn().mockResolvedValue(''), cleanupTempFiles: vi.fn(async () => {}) },
    toolEventProcessor: {
      handleToolUse: vi.fn().mockResolvedValue(undefined),
      handleToolResult: vi.fn().mockResolvedValue(undefined),
      setReactionManager: vi.fn(),
      setToolResultSink: vi.fn(),
      cleanup: vi.fn(),
    },
    statusReporter: { getStatusEmoji: vi.fn().mockReturnValue('thinking_face') },
    reactionManager: { updateReaction: vi.fn().mockResolvedValue(undefined), cleanup: vi.fn() },
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
    requestCoordinator: { removeController: vi.fn() },
    slackApi: {
      getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
      getClient: vi.fn().mockReturnValue({}),
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    },
    assistantStatusManager: {
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      getToolStatusText: vi.fn().mockReturnValue('running tool...'),
      bumpEpoch: vi.fn().mockReturnValue(1),
      buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
      registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
    },
    turnNotifier: { notify: vi.fn().mockResolvedValue(undefined) },
    threadPanel: undefined,
  } as any;
}

function params(session: Record<string, unknown>, text: string) {
  return {
    session,
    sessionKey: 'C777:thread777',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    text,
    channel: 'C777',
    threadTs: 'thread777',
    user: 'U_TEST',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    isUserInput: true,
  } as any;
}

async function promptOf(session: Record<string, unknown>, text: string): Promise<string> {
  const deps = createDeps();
  await new StreamExecutor(deps).execute(params(session, text));
  return deps.claudeHandler.streamAgentEvents.mock.calls[0][0];
}

describe('#772 — <display-lang> on the first instruction', () => {
  beforeEach(() => {
    lang.value = 'ko';
  });
  const newSession = () => ({
    sessionId: 'sess_lang',
    ownerId: 'U_TEST',
    logVerbosity: LOG_DETAIL,
    usage: {},
    terminated: false,
    conversationId: 'conv_lang',
  });

  it('the first instruction ends with the tag, after the context block', async () => {
    const prompt = await promptOf(newSession(), '대시보드 고쳐줘');
    expect(prompt.trimEnd().endsWith('<display-lang>ko</display-lang>')).toBe(true);
    expect(prompt.indexOf('</context>')).toBeLessThan(prompt.indexOf('<display-lang>'));
  });

  it('the next instruction in the same session has no tag', async () => {
    const session = newSession();
    await promptOf(session, '첫 지시');
    const second = await promptOf(session, '두 번째 지시');
    expect(second).not.toContain('<display-lang>');
  });

  it('after the user switches to en the next instruction carries the new language', async () => {
    const session = newSession();
    await promptOf(session, '첫 지시');
    lang.value = 'en';
    const next = await promptOf(session, 'second');
    expect(next.trimEnd().endsWith('<display-lang>en</display-lang>')).toBe(true);
  });

  it('an SDK local slash command stays exactly the command', async () => {
    const prompt = await promptOf(newSession(), '/compact');
    expect(prompt).toBe('/compact');
  });

  it('the whole turn runs in the user display language (its posts are translated for them)', async () => {
    // The executor is the built @soma/slack, which loads @soma/common through Node's require:
    // read the language from that same module instance.
    const { currentDisplayLang } = createRequire(__filename)('@soma/common/i18n');
    lang.value = 'en';
    const deps = createDeps();
    let seen = '';
    deps.claudeHandler.streamAgentEvents.mockImplementation(() => {
      seen = currentDisplayLang();
      return toAgentEvents(okStream());
    });
    await new StreamExecutor(deps).execute(params(newSession(), 'go'));
    expect(seen).toBe('en');
    expect(currentDisplayLang()).toBe('ko');
  });
});
