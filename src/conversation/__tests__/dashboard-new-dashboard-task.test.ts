import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #600 ⑥ — `POST /api/dashboard/new-task` with `destination: 'task'` makes a
 * Slack-less dashboard task instead of posting into a channel: same sign-in,
 * CSRF and new-task gate (request-id idempotency, one launch in flight, the
 * window), no channel, no attachments, the folder named — never a path.
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

describe('Dashboard — new task as a Slack-less dashboard task (#600 ⑥)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let launcher: ReturnType<typeof vi.fn>;
  let slackProvider: { context: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    slackProvider = { context: vi.fn(), start: vi.fn() };
    dashboard.setDashboardNewTaskProvider(slackProvider);
    launcher = vi.fn(async () => ({ status: 200, body: { sessionKey: 'task:abc', status: 'running' } }));
    dashboard.setDashboardTaskLauncher(launcher);
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

  function post(auth: { cookie: string; csrf: string } | null, payload: unknown) {
    return injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: {
        ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf } : { Authorization: 'Bearer test-token' }),
        'content-type': 'application/json',
      },
      payload,
    });
  }

  const task = (over: Record<string, unknown> = {}) => ({
    requestId: 'req-task-0123456',
    destination: 'task',
    prompt: '  Fix the flaky test  ',
    ...over,
  });

  it('starts a dashboard task for the signed-in user — no channel, no Slack provider', async () => {
    const res = await post(await signIn(), task({ folder: 'repo-a', model: 'opus' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, sessionKey: 'task:abc', status: 'running' });
    expect(launcher).toHaveBeenCalledWith({
      ownerId: 'U_PLAIN',
      ownerName: 'Plain Name',
      prompt: 'Fix the flaky test',
      folder: 'repo-a',
      model: 'opus',
    });
    expect(slackProvider.context).not.toHaveBeenCalled();
    expect(slackProvider.start).not.toHaveBeenCalled();
  });

  it('the launcher’s refusal is the reply (nothing reported as started)', async () => {
    launcher.mockResolvedValueOnce({ status: 422, body: { error: 'no such folder' } });
    const res = await post(await signIn(), task({ folder: 'nope' }));
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({ error: 'no such folder' });
  });

  it.each([
    ['no prompt', { prompt: '   ' }],
    ['a prompt over the limit', { prompt: 'x'.repeat(12001) }],
    ['attachments', { attachments: [{ name: 'a.png', mimetype: 'image/png', data: 'AAAA' }] }],
    ['a folder that is not a string', { folder: 5 }],
    ['a model that is not a string', { model: ['opus'] }],
  ])('400 for %s — nothing launched', async (_label, over) => {
    const res = await post(await signIn(), task(over));
    expect(res.statusCode).toBe(400);
    expect(launcher).not.toHaveBeenCalled();
  });

  it('a viewer token without a Slack user cannot start one (403); anonymous is 401', async () => {
    expect((await post(null, task())).statusCode).toBe(403);
    const anon = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: { 'content-type': 'application/json' },
      payload: task(),
    });
    expect(anon.statusCode).toBe(401);
    expect(launcher).not.toHaveBeenCalled();
  });

  it('a retried request id returns the first launch’s result — one task, not two', async () => {
    const auth = await signIn();
    const a = await post(auth, task());
    const b = await post(auth, task());
    expect(JSON.parse(b.body)).toEqual(JSON.parse(a.body));
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('501 when no task launcher is wired', async () => {
    dashboard.setDashboardTaskLauncher(null);
    expect((await post(await signIn(), task())).statusCode).toBe(501);
  });
});
