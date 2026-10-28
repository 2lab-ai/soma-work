/**
 * End to end (SSOT 2026-10-23 T1–T5): a real cron fire through the real
 * pipeline into the real dashboard API. Real CronScheduler → real
 * SessionInitializer → real SessionRegistry (behind a ClaudeHandler-shaped
 * delegate: ClaudeHandler's session methods are one-line delegates to it) →
 * real dashboard routes. Only Slack I/O and the model are stubs.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
    // read by the real SessionRegistry.createSession
    getUserLogVerbosityFlags: vi.fn().mockReturnValue(undefined),
    getUserDefaultEffort: vi.fn().mockReturnValue(undefined),
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
  decodeSlackEntities: (text: string) => text,
  getDispatchService: vi.fn().mockReturnValue({
    dispatch: vi.fn().mockResolvedValue({ workflow: 'default', title: 'Test' }),
    getModel: vi.fn().mockReturnValue('test-model'),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));

import * as os from 'node:os';
import * as path from 'node:path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { CronScheduler } from '../../../cron-scheduler';
import { SessionRegistry } from '../../../session-registry';
import { userSettingsStore } from '../../../user-settings-store';
// Import after mocks
import { SessionInitializer } from '../session-initializer';

// The dist session initializer loads ../thread-header-builder through Node's own
// require: the single instance production uses, but not the one vitest inlines
// for an `import` in this file. Configure the instance the code under test reads.
const { setThreadHeaderProviders } = createRequire(__filename)(
  '@soma/slack/thread-header-builder',
) as typeof import('@soma/slack/thread-header-builder');

const JOB = 'dev2-qa-lane';
const ROOT_TS = '1792728682.496489';

describe('cron fire → session → dashboard, end to end', () => {
  const registry = new SessionRegistry();
  const storage = new CronStorage(path.join(os.tmpdir(), `cron-e2e-${process.pid}-${Date.now()}`, 'cron-jobs.json'));
  let inject: (req: { method: 'GET'; url: string }) => Promise<{ statusCode: number; body: string }>;
  let stop: () => Promise<void>;

  // ClaudeHandler's session methods delegate one-to-one to SessionRegistry.
  const claudeHandler = {
    getSessionKey: (c: string, t?: string) => registry.getSessionKey(c, t),
    getSession: (c: string, t?: string) => registry.getSession(c, t),
    createSession: (o: string, n: string, c: string, t?: string, m?: string) => registry.createSession(o, n, c, t, m),
    isSleeping: (c: string, t?: string) => registry.isSleeping(c, t),
    wakeFromSleep: (c: string, t?: string) => registry.wakeFromSleep(c, t),
    needsDispatch: (c: string, t?: string) => registry.needsDispatch(c, t),
    transitionToMain: (c: string, t: string | undefined, w: any, title?: string) =>
      registry.transitionToMain(c, t, w, title),
    addSourceWorkingDir: (c: string, t: string | undefined, d: string) => registry.addSourceWorkingDir(c, t, d),
    terminateSession: (k: string) => registry.terminateSession(k),
    updateInitiator: (c: string, t: string | undefined, id: string, name: string) =>
      registry.updateInitiator(c, t, id, name),
    canInterrupt: (c: string, t: string | undefined, u: string) => registry.canInterrupt(c, t, u),
    setActivityState: (c: string, t: string | undefined, s: any) => registry.setActivityState(c, t, s),
    setSessionLinks: vi.fn(),
  };

  beforeAll(async () => {
    vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
      userId: 'U123',
      accepted: true,
      defaultDirectory: '/some/dir',
      bypassPermission: false,
      persona: 'default',
      defaultModel: 'claude-sonnet-4-5-20250929',
      lastUpdated: '2024-01-01',
    } as any);
    const initializer = new SessionInitializer({
      claudeHandler: claudeHandler as any,
      slackApi: {
        getUserName: vi.fn().mockResolvedValue('Z'),
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg1' }),
        getPermalink: vi.fn().mockResolvedValue('https://example.slack.com/archives/C123/p1'),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
        updateMessage: vi.fn(),
        deleteMessage: vi.fn(),
        deleteThreadBotMessages: vi.fn(),
      } as any,
      messageValidator: {
        validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: '/tmp' }),
      } as any,
      workingDirManager: { createSessionBaseDir: vi.fn().mockReturnValue(undefined) } as any,
      reactionManager: {
        setOriginalMessage: vi.fn(),
        clearSessionLifecycleEmojis: vi.fn(),
        getCurrentReaction: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      contextWindowManager: { setOriginalMessage: vi.fn() } as any,
      requestCoordinator: {
        isRequestActive: vi.fn().mockReturnValue(false),
        setController: vi.fn(),
        abortSession: vi.fn(),
        getLastActivityAt: vi.fn(),
        touchSession: vi.fn(),
      } as any,
      assistantStatusManager: {
        setStatus: vi.fn(),
        setTitle: vi.fn(),
        clearStatus: vi.fn(),
        bumpEpoch: vi.fn().mockReturnValue(1),
        getToolStatusText: vi.fn(),
        buildBashStatus: vi.fn(),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
        isEnabled: vi.fn().mockReturnValue(true),
      } as any,
    });

    storage.addJob({
      name: JOB,
      expression: '* * * * *',
      prompt: '$full-deploy-dev2',
      owner: 'U123',
      channel: 'C123',
      threadTs: null,
    });
    const scheduler = new CronScheduler({
      storage,
      sessionRegistry: registry,
      // Production routes the synthetic event into the Slack pipeline, whose
      // first stage is SessionInitializer.initialize.
      messageInjector: async (event) => {
        await initializer.initialize(event as any, '/tmp');
      },
      threadCreator: async () => ROOT_TS,
    });
    await scheduler.tick();
    // The stubbed model never starts a turn; the SDK's first message gives the
    // session its id (the dashboard lists sessions that have one) and the turn
    // runs. Do what that first message does.
    const fired = registry.getSession('C123', ROOT_TS);
    if (fired) fired.sessionId = 'sdk-session-1';
    registry.setActivityState('C123', ROOT_TS, 'working');

    const dashboard = await import('../../../conversation/dashboard');
    dashboard.setDashboardSessionAccessor(() => registry.getAllSessions());
    dashboard.setDashboardCronSource({
      listJobs: () => storage.getAll(),
      listHistory: () => storage.getExecutionHistory(),
    });
    const ws = await import('../../../conversation/web-server');
    await ws.startWebServer({ listen: false });
    inject = (req) => ws.injectWebServer(req as any) as any;
    stop = () => ws.stopWebServer();
  });

  afterAll(async () => {
    await stop?.();
  });

  async function get(url: string) {
    const res = await inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }
  function cards(board: any): any[] {
    return ['working', 'waiting', 'idle', 'closed'].flatMap((c) => board[c] ?? []);
  }

  it('T1: the session the fire created is named after the job and filed under it', () => {
    const session = registry.getSession('C123', ROOT_TS);
    expect(session?.title).toBe(JOB);
    expect(session?.title).not.toBe('Direct (skipDispatch)');
    expect(session?.cronJob).toEqual({ id: storage.getAll()[0].id, name: JOB });
    expect(session?.titleProvisional).toBe(true);
  });

  it('T3/T4: the dashboard card carries the job (badge + lane) and the job-name title', async () => {
    const { board } = await get('/api/dashboard/sessions?userId=U123');
    const card = cards(board).find((c) => c.cronJob?.name === JOB);
    expect(card).toBeDefined();
    expect(card.title).toBe(JOB);
  });

  it("T5: the job's run history links the run to that card", async () => {
    const { board } = await get('/api/dashboard/sessions?userId=U123');
    const card = cards(board).find((c) => c.cronJob?.name === JOB);
    const { jobs } = await get('/api/dashboard/cron?userId=U123');
    const job = jobs.find((j: any) => j.name === JOB);
    expect(job.runs).toHaveLength(1);
    expect(job.runs[0]).toMatchObject({ status: 'success', executionPath: 'new_thread' });
    expect(job.runs[0].session.boardKey).toBe(card.key);
    expect(JSON.stringify(jobs)).not.toContain('$full-deploy-dev2');
  });

  it('T2: once the work has a name, it replaces the job name — and the card follows', async () => {
    registry.setSessionTitle('C123', ROOT_TS, 'QA pass: dev2 deploy');
    const session = registry.getSession('C123', ROOT_TS);
    expect(session?.title).toBe('QA pass: dev2 deploy');
    expect(session?.titleProvisional).toBeFalsy();
    expect(session?.cronJob?.name).toBe(JOB);
    const { board } = await get('/api/dashboard/sessions?userId=U123');
    const card = cards(board).find((c) => c.cronJob?.name === JOB);
    expect(card.title).toBe('QA pass: dev2 deploy');
  });
});
