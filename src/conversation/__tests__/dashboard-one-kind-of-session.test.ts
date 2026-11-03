import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #854 — one kind of work session: every task the dashboard starts is a Slack thread.
 *
 *   N1 the dashboard-task destination is gone: an old client asking for one gets 410, and nothing
 *      is launched — neither a task nor a Slack thread.
 *   N2 the new-task context offers no task folders (no destination to pick); the epic flag still
 *      rides it, only for an owner who turned epics on.
 *   N3 the epic switch on a Slack task reaches the launch (`epic: true`, autogoal and autoz off),
 *      and is refused for an owner whose flag is off.
 */

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [] }),
}));
vi.mock('../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));

describe('Dashboard — one kind of work session (#854)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let launcher: ReturnType<typeof vi.fn>;
  let epicTasks: ReturnType<typeof vi.fn>;
  let slackProvider: { context: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
  const context = {
    models: [{ nickname: 'opus', model: 'claude-opus' }],
    efforts: ['high'],
    channels: [{ id: 'C1', name: 'dev' }],
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultChannelId: 'C1',
  };

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    slackProvider = {
      context: vi.fn(async () => context),
      start: vi.fn(async () => ({ channel: 'C1', threadTs: '1.0', sessionKey: 'C1-1.0', status: 'running' })),
    };
    dashboard.setDashboardNewTaskProvider(slackProvider);
    launcher = vi.fn();
    epicTasks = vi.fn((userId: string) => userId === 'U_EPIC');
    // #855 — the epic flag's own provider (the dashboard-task launcher is gone).
    dashboard.setDashboardEpicTasks(epicTasks);
    await webServer.startWebServer({ listen: false });
  }, 30_000);

  afterEach(async () => {
    await stopWebServer();
  });

  async function signIn(slackUserId = 'U_PLAIN') {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: 'Plain Name' });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const setCookie = sso.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
    const me = await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } });
    return { cookie, csrf: JSON.parse(me.body).csrfToken as string };
  }

  function post(auth: { cookie: string; csrf: string }, payload: unknown) {
    return injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' },
      payload,
    });
  }

  const slackTask = (over: Record<string, unknown> = {}) => ({
    requestId: 'req-slack-0123456',
    prompt: '로그인 전부 고쳐',
    model: 'opus',
    effort: 'high',
    channelId: 'C1',
    autogoal: true,
    autoz: true,
    plan: false,
    attachments: [],
    ...over,
  });

  it('N1 — a dashboard-task request is told the destination is gone (410); nothing is launched', async () => {
    const res = await post(await signIn(), { requestId: 'req-task-0123456', destination: 'task', prompt: 'x' });
    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.body).error).toMatch(/Slack 채널/);
    expect(launcher).not.toHaveBeenCalled();
    expect(slackProvider.start).not.toHaveBeenCalled();
  });

  it('N2 — the context offers no task folders; the epic flag only for an owner who turned it on', async () => {
    const plain = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/new-task/context',
      headers: { cookie: (await signIn()).cookie },
    });
    expect(JSON.parse(plain.body).context.taskFolders).toBeUndefined();
    expect(JSON.parse(plain.body).context.epicTasks).toBeUndefined();
    const epicOwner = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/new-task/context',
      headers: { cookie: (await signIn('U_EPIC')).cookie },
    });
    expect(JSON.parse(epicOwner.body).context).toMatchObject({ epicTasks: true });
    expect(JSON.parse(epicOwner.body).context.taskFolders).toBeUndefined();
  });

  it('N3 — the epic switch reaches the Slack launch (autogoal and autoz off); refused when the flag is off', async () => {
    const ok = await post(await signIn('U_EPIC'), slackTask({ epic: true }));
    expect(ok.statusCode).toBe(200);
    expect(slackProvider.start).toHaveBeenCalledWith(
      'U_EPIC',
      expect.objectContaining({ epic: true, autogoal: false, autoz: false, channelId: 'C1' }),
    );
    slackProvider.start.mockClear();
    const off = await post(await signIn(), slackTask({ epic: true, requestId: 'req-slack-0123457' }));
    expect(off.statusCode).toBe(403);
    expect(slackProvider.start).not.toHaveBeenCalled();
    const bad = await post(await signIn('U_EPIC'), slackTask({ epic: 'yes', requestId: 'req-slack-0123458' }));
    expect(bad.statusCode).toBe(400);
  });
});
