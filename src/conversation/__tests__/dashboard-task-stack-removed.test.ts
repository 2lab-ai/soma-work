import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #855 — the separate dashboard-task stack is gone: every task is a Slack thread.
 *
 *   D1 the task setters are gone (command, answer, queue, launcher, notice failures); the epic
 *      flag comes from its own small provider (`setDashboardEpicTasks`). The plan handler and the
 *      TodoWrite task accessor stay.
 *   D2 no route branches on a dashboard task: a session still carrying the old mark is sent like
 *      any other (its command reaches the Slack command handler, never a 501 "task handler").
 *   D3 the new-task context carries the epic flag only for an owner who turned it on, and the
 *      epic switch is refused (403) for anyone else — through the new flag provider.
 *   D4 the dashboard-task destination stays gone (410).
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

describe('Dashboard — the dashboard-task stack is removed (#855)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
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

  const json = (auth: { cookie: string; csrf: string }) => ({
    cookie: auth.cookie,
    'x-csrf-token': auth.csrf,
    'content-type': 'application/json',
  });

  it('D1 — the task setters are gone; the epic flag provider, the plan handler and the task accessor are there', () => {
    for (const gone of [
      'setDashboardTaskLauncher',
      'setDashboardTaskCommandHandler',
      'setDashboardTaskAnswerHandler',
      'setDashboardTaskQueueHandler',
      'setTaskNoticeFailureProvider',
    ]) {
      expect(dashboard[gone], gone).toBeUndefined();
    }
    expect(typeof dashboard.setDashboardEpicTasks).toBe('function');
    expect(typeof dashboard.setDashboardTaskPlanHandler).toBe('function');
    expect(typeof dashboard.setDashboardTaskAccessor).toBe('function');
  });

  it('D2 — a session still carrying the old mark is an ordinary session: its command goes to the Slack handler', async () => {
    const key = 'work:C1:500.001';
    const sessions = new Map<string, any>([
      [key, { ownerId: 'U_PLAIN', channelId: 'C1', threadTs: '500.001', sessionId: 's1', slackless: true }],
    ]);
    dashboard.setDashboardSessionAccessor(() => sessions);
    const sent: unknown[][] = [];
    dashboard.setDashboardCommandHandler(async (...args: unknown[]) => {
      sent.push(args);
    });
    const auth = await signIn('U_PLAIN');
    const res = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/command`,
      headers: json(auth),
      payload: { message: '계속해' },
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe(key);
    expect(sent[0][1]).toBe('계속해');
  });

  it('D3 — the epic flag rides the context for an owner who turned it on; the epic switch is 403 for anyone else', async () => {
    dashboard.setDashboardEpicTasks((userId: string) => userId === 'U_EPIC');
    const plain = await signIn('U_PLAIN');
    const ctxPlain = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/new-task/context',
      headers: { cookie: plain.cookie },
    });
    expect(ctxPlain.statusCode).toBe(200);
    expect(JSON.parse(ctxPlain.body).context.epicTasks).toBeUndefined();
    const epicOwner = await signIn('U_EPIC');
    const ctxEpic = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/new-task/context',
      headers: { cookie: epicOwner.cookie },
    });
    expect(JSON.parse(ctxEpic.body).context).toMatchObject({ epicTasks: true });

    const submission = {
      requestId: 'req-epic-0123456',
      prompt: '로그인 전부 고쳐',
      model: 'opus',
      effort: 'high',
      channelId: 'C1',
      autogoal: false,
      autoz: false,
      plan: false,
      epic: true,
      attachments: [],
    };
    const refused = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: json(plain),
      payload: submission,
    });
    expect(refused.statusCode).toBe(403);
    expect(slackProvider.start).not.toHaveBeenCalled();

    const launched = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: json(epicOwner),
      payload: { ...submission, requestId: 'req-epic-0123457' },
    });
    expect(launched.statusCode).toBe(200);
    expect(slackProvider.start).toHaveBeenCalledTimes(1);
    expect(slackProvider.start.mock.calls[0][1]).toMatchObject({ epic: true });
  });

  it('D4 — the dashboard-task destination stays gone (410)', async () => {
    const res = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: json(await signIn()),
      payload: { requestId: 'req-task-0123456', destination: 'task', prompt: 'x' },
    });
    expect(res.statusCode).toBe(410);
    expect(slackProvider.start).not.toHaveBeenCalled();
  });
});
