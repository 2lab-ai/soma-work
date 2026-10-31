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
vi.mock('../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));

/** The models the new-task context offers (#640 R1: a task's model is one of these, by nickname). */
const OFFERED = {
  models: [
    { nickname: 'opus', model: 'claude-opus-5-5[1m]', label: 'Opus' },
    { nickname: 'fable', model: 'claude-fable-1', label: 'Fable' },
  ],
  efforts: [],
  channels: [],
};

describe('Dashboard — new task as a Slack-less dashboard task (#600 ⑥)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let launcher: ReturnType<typeof vi.fn>;
  let folders: ReturnType<typeof vi.fn>;
  let slackProvider: { context: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    slackProvider = { context: vi.fn(async () => OFFERED), start: vi.fn() };
    dashboard.setDashboardNewTaskProvider(slackProvider);
    launcher = vi.fn(async () => ({ status: 200, body: { sessionKey: 'task:abc', status: 'running' } }));
    folders = vi.fn(() => [{ name: 'repo-a', mtimeMs: 2 }]);
    dashboard.setDashboardTaskLauncher({ launch: launcher, folders });
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

  it('starts a dashboard task for the signed-in user — no channel, nothing posted to Slack', async () => {
    const res = await post(await signIn(), task({ folder: 'repo-a', model: 'opus' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, sessionKey: 'task:abc', status: 'running' });
    expect(launcher).toHaveBeenCalledWith({
      ownerId: 'U_PLAIN',
      ownerName: 'Plain Name',
      prompt: 'Fix the flaky test',
      folder: 'repo-a',
      model: 'claude-opus-5-5[1m]', // the offered model the nickname names (#640 R1)
    });
    expect(slackProvider.start).not.toHaveBeenCalled();
  });

  // #640 R1 (fable P2): the model is one the dialog offers, named by nickname —
  // never an arbitrary id string from the body.
  it.each([
    ['a raw model id', 'claude-opus-5-5[1m]'],
    ['a model the dialog does not offer', 'haiku'],
  ])('400 for %s — nothing launched', async (_label, model) => {
    const res = await post(await signIn(), task({ model }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/model/);
    expect(launcher).not.toHaveBeenCalled();
  });

  it('no model: the task takes the default — the context is not needed', async () => {
    const res = await post(await signIn(), task());
    expect(res.statusCode).toBe(200);
    expect(launcher.mock.calls[0][0]).not.toHaveProperty('model');
    expect(slackProvider.context).not.toHaveBeenCalled();
  });

  // #640 R1: the task's owner is the signed-in user — admin mode and body fields do not retarget it.
  it('an admin in admin mode starts a task as themselves — a body owner is ignored', async () => {
    const admin = await signIn('U_ADMIN');
    const res = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: {
        cookie: admin.cookie,
        'x-csrf-token': admin.csrf,
        'content-type': 'application/json',
        'x-admin-mode': 'on',
      },
      payload: task({ ownerId: 'U_OTHER', userId: 'U_OTHER', owner: 'U_OTHER' }),
    });
    expect(res.statusCode).toBe(200);
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(launcher.mock.calls[0][0]).toMatchObject({ ownerId: 'U_ADMIN' });
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

  it('the new-task context offers the signed-in user’s task folders (names only)', async () => {
    slackProvider.context.mockResolvedValue({ models: [], efforts: [], channels: [] });
    const auth = await signIn();
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/new-task/context',
      headers: { cookie: auth.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).context.taskFolders).toEqual([{ name: 'repo-a' }]);
    expect(folders).toHaveBeenCalledWith('U_PLAIN');
  });

  // #640 R1: through the real launcher, a folder is a name in the signed-in user's own root —
  // a path, a parent step or another user's root is refused before anything is created.
  it.each([
    ['an absolute path', '/etc'],
    ['a parent step into another root', '../U_OTHER'],
    ['a nested path', 'repo-a/sub'],
  ])('the real launcher refuses %s as the folder (422), nothing created or started', async (_label, folder) => {
    const { createTaskLauncher } = await import('../../task-turn/task-launcher');
    const createTask = vi.fn(() => ({ taskId: 'never' }));
    const controller = { canStart: vi.fn(() => null), start: vi.fn() };
    const real = createTaskLauncher({
      controller: controller as never,
      createTask,
      createFreshDirectory: () => undefined,
    });
    dashboard.setDashboardTaskLauncher(real);
    const res = await post(await signIn(), task({ folder }));
    expect(res.statusCode).toBe(422);
    expect(createTask).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('501 when no task launcher is wired', async () => {
    dashboard.setDashboardTaskLauncher(null);
    expect((await post(await signIn(), task())).statusCode).toBe(501);
  });
});
