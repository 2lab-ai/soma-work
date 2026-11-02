import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks MUST be hoisted - define factories inline
vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn(),
    createPendingUser: vi.fn(),
    ensureUserExists: vi.fn().mockReturnValue({
      userId: 'U123',
      accepted: true,
      defaultDirectory: '',
      bypassPermission: false,
      persona: 'default',
      defaultModel: 'claude-sonnet-4-5-20250929',
      lastUpdated: new Date().toISOString(),
    }),
    getUserBypassPermission: vi.fn().mockReturnValue(false),
    setUserBypassPermission: vi.fn(),
    getUserPersona: vi.fn().mockReturnValue('default'),
    setUserPersona: vi.fn(),
    getUserDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-5-20250929'),
    setUserDefaultModel: vi.fn(),
    getUserJiraInfo: vi.fn().mockReturnValue(undefined),
    updateUserJiraInfo: vi.fn(),
    removeUserSettings: vi.fn(),
    listUsers: vi.fn().mockReturnValue([]),
    loadSlackJiraMapping: vi.fn(),
    getSlackJiraMapping: vi.fn().mockReturnValue({}),
    findJiraAccountBySlackId: vi.fn().mockReturnValue(undefined),
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.8'),
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
  AVAILABLE_MODELS: [
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-8[1m]',
    'claude-opus-4-7[1m]',
    'claude-opus-4-6[1m]',
  ],
  DEFAULT_MODEL: 'claude-opus-4-8[1m]',
}));

vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn().mockReturnValue(false),
  getAdminUsers: vi.fn().mockReturnValue(new Set(['U_ADMIN1'])),
}));

vi.mock('../../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv-123'),
  getConversationUrl: vi.fn().mockReturnValue('http://localhost:3000/conversations/conv-123'),
}));

vi.mock('../../../channel-registry', () => ({
  checkRepoChannelMatch: vi.fn().mockReturnValue({ correct: true, suggestedChannels: [] }),
  getChannel: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../dispatch-service', () => ({
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({ workflow: 'deploy', title: 'Projalpha develop -> dev2' }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

import { userSettingsStore } from '../../../user-settings-store';
// Import after mocks
import { SessionInitializer } from '../session-initializer';

// The gate is passed in as a dependency, so the package build's service is fine here.
const { WorkQueueService, parseWorkQueuesConfig } = createRequire(__filename)(
  '@soma/slack/work-queue',
) as typeof import('@soma/slack/work-queue');

// The dist session initializer loads ../thread-header-builder through Node's own
// require: the single instance production uses, but not the one vitest inlines
// for an `import` in this file. Configure the instance the code under test reads.
const { setThreadHeaderProviders } = createRequire(__filename)(
  '@soma/slack/thread-header-builder',
) as typeof import('@soma/slack/thread-header-builder');

// ssot-task T1/T2 at the real entry point: the gate runs inside
// SessionInitializer right before handleConcurrency, so a blocked deploy never
// registers a turn and never reaches the model.
describe('SessionInitializer — work queue gate (#726)', () => {
  let sessions: Map<string, any>;
  let claudeHandler: any;
  let slackApi: any;
  let requestCoordinator: any;
  let probes: Map<string, any>;
  let initializer: SessionInitializer;
  let workQueue: InstanceType<typeof WorkQueueService>;

  const accepted = {
    userId: 'U123',
    accepted: true,
    defaultDirectory: '/some/dir',
    bypassPermission: false,
    persona: 'default',
    defaultModel: 'claude-sonnet-4-5-20250929',
    lastUpdated: '2024-01-01',
  };

  function makeSession(user: string, channel: string, threadTs: string, extra: Record<string, unknown> = {}) {
    const s = {
      sessionId: undefined,
      ownerId: user,
      ownerName: user,
      channelId: channel,
      threadTs,
      state: 'MAIN',
      ...extra,
    };
    sessions.set(`${channel}:${threadTs}`, s);
    return s;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(accepted as any);
    sessions = new Map();
    probes = new Map();
    let posted = 0;
    claudeHandler = {
      getSessionKey: vi.fn((c: string, t: string) => `${c}:${t}`),
      getSession: vi.fn((c: string, t: string) => sessions.get(`${c}:${t}`) ?? null),
      createSession: vi.fn((u: string, _n: string, c: string, t: string) =>
        makeSession(u, c, t, { state: 'INITIALIZING' }),
      ),
      isSleeping: vi.fn().mockReturnValue(false),
      wakeFromSleep: vi.fn(),
      needsDispatch: vi.fn((c: string, t: string) => sessions.get(`${c}:${t}`)?.state === 'INITIALIZING'),
      transitionToMain: vi.fn((c: string, t: string, workflow: string) => {
        const s = sessions.get(`${c}:${t}`);
        if (!s) return false;
        s.state = 'MAIN';
        s.workflow = workflow;
        return true;
      }),
      setActivityState: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(false),
      updateInitiator: vi.fn(),
      setSessionLinks: vi.fn(),
      terminateSession: vi.fn((key: string) => sessions.delete(key)),
      adoptTaskId: vi.fn().mockReturnValue(true),
      setBotThread: vi.fn(),
    };
    slackApi = {
      getUserName: vi.fn().mockResolvedValue('Test User'),
      postMessage: vi.fn(async () => ({ ts: `900.${++posted}` })),
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'sys' }),
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C1/p100'),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
    };
    requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
      setController: vi.fn(),
      abortSession: vi.fn(),
      getLastActivityAt: vi.fn().mockReturnValue(undefined),
      touchSession: vi.fn(),
    };
    workQueue = new WorkQueueService({
      slackApi,
      getQueues: () => parseWorkQueuesConfig(undefined).queues,
      probe: (key: string) => probes.get(key) ?? { exists: sessions.has(key), active: true, activity: 'working' },
    });
    initializer = new SessionInitializer({
      claudeHandler,
      slackApi,
      messageValidator: {
        validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: '/test/dir' }),
      } as any,
      workingDirManager: { createSessionBaseDir: vi.fn().mockReturnValue(undefined) } as any,
      reactionManager: {
        setOriginalMessage: vi.fn(),
        clearSessionLifecycleEmojis: vi.fn().mockResolvedValue(undefined),
        getCurrentReaction: vi.fn().mockReturnValue(null),
        cleanup: vi.fn(),
      } as any,
      contextWindowManager: { setOriginalMessage: vi.fn().mockResolvedValue(undefined) } as any,
      requestCoordinator,
      workQueue,
    } as any);
  });

  const event = (user: string, threadTs: string, text: string) =>
    ({ user, channel: 'C1', thread_ts: threadTs, ts: threadTs, text }) as any;

  it('runs the first dev2 deploy and halts the second before any turn is registered', async () => {
    makeSession('UA', 'C1', '100', { workflow: 'deploy', sessionId: 'sdk-a' });
    makeSession('UB', 'C1', '200', { workflow: 'deploy', sessionId: 'sdk-b' });

    const first = await initializer.initialize(event('UA', '100', 'Projalpha: develop -&gt; deploy/dev2'), '/test/dir');
    expect(first.halted).toBeFalsy();
    expect(requestCoordinator.setController).toHaveBeenCalledWith('C1:100', expect.anything());

    requestCoordinator.setController.mockClear();
    const second = await initializer.initialize(
      event('UB', '200', 'Projalpha: develop -&gt; deploy/dev2'),
      '/test/dir',
    );
    expect(second.halted).toBe(true);
    expect(requestCoordinator.setController).not.toHaveBeenCalled();
    const card = slackApi.postMessage.mock.calls.find((c: any[]) => String(c[1]).includes('이미 배포가 진행 중'));
    expect(card?.[0]).toBe('C1');
    expect(card?.[2]).toMatchObject({ threadTs: '200' });
  });

  it('lets a deploy to another target through while dev2 is busy', async () => {
    makeSession('UA', 'C1', '100', { workflow: 'deploy', sessionId: 'sdk-a' });
    makeSession('UB', 'C1', '200', { workflow: 'deploy', sessionId: 'sdk-b' });
    await initializer.initialize(event('UA', '100', 'Projalpha develop -> dev2'), '/test/dir');
    const other = await initializer.initialize(event('UB', '200', 'Projalpha develop -> dev3'), '/test/dir');
    expect(other.halted).toBeFalsy();
  });

  it('binds a migrated deploy session to the queue, so its arrow-less next turn is still gated', async () => {
    // Channel mention → bot-thread migration → the gate passes under the new key.
    const first = await initializer.initialize(event('UA', '400', 'Projalpha: develop -&gt; deploy/dev2'), '/test/dir');
    expect(first.halted).toBeFalsy();
    const botKey = first.sessionKey;
    expect(botKey).not.toBe('C1:400');
    expect(sessions.get(botKey)?.workQueueId).toBe('deploy-dev2');

    // A's turn ends (slot freed); B takes dev2.
    probes.set(botKey, { exists: true, active: false, activity: 'idle', workflow: 'deploy' });
    workQueue.onSessionDeleted(botKey);
    makeSession('UB', 'C1', '500', { workflow: 'deploy', sessionId: 'sdk-b' });
    expect(
      (await initializer.initialize(event('UB', '500', 'Projalpha develop -> dev2'), '/test/dir')).halted,
    ).toBeFalsy();

    // A answers the deploy confirmation in the bot thread: no arrow, still the dev2 queue.
    sessions.get(botKey).sessionId = 'sdk-a';
    const answer = await initializer.initialize(event('UA', botKey.split(':')[1], '응 진행해'), '/test/dir');
    expect(answer.halted).toBe(true);
  });

  it('gates a brand-new deploy session on its migrated bot thread', async () => {
    makeSession('UA', 'C1', '100', { workflow: 'deploy', sessionId: 'sdk-a' });
    await initializer.initialize(event('UA', '100', 'Projalpha develop -> dev2'), '/test/dir');

    requestCoordinator.setController.mockClear();
    const fresh = await initializer.initialize(event('UB', '300', 'Projalpha: develop -&gt; deploy/dev2'), '/test/dir');
    expect(fresh.halted).toBe(true);
    expect(fresh.sessionKey).not.toBe('C1:300');
    expect(requestCoordinator.setController).not.toHaveBeenCalled();
    const card = slackApi.postMessage.mock.calls.find((c: any[]) => String(c[1]).includes('이미 배포가 진행 중'));
    expect(card?.[2]?.threadTs).toBe(fresh.sessionKey.split(':')[1]);
  });
});
