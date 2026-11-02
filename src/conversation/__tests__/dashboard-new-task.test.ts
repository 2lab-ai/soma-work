/**
 * Dashboard "New task" — the HTTP contract (SSOT 2026-10-23 T2).
 *
 *   GET  /api/dashboard/new-task/context  → what the composer offers this user
 *   POST /api/dashboard/new-task          → start the task as this user
 *
 * Only a signed-in Slack user can start a task, and it always runs as that
 * user (no impersonation through the body or admin mode). The submission is
 * validated against a FRESH context (channel membership re-checked right
 * before anything is posted), a retried request id launches once, and the
 * body limit admits phone photos / voice notes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

const CONTEXT = {
  models: [
    {
      nickname: 'opus[1m]',
      model: 'claude-opus-5-5[1m]',
      label: 'Opus 5.5 (1M)',
      battery: { level: 0.5, best: 0.5, windows: [], accounts: { measured: 1, total: 1, available: 1 } },
    },
  ],
  defaultModel: 'opus[1m]',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'xhigh',
  channels: [{ id: 'C_ALPHA', name: 'workspace-alpha', repos: ['2lab-ai/soma-work'] }],
  defaultChannelId: 'C_ALPHA',
  membershipUnknown: false,
  autogoalDefault: true,
  usage: { scope: 'shared-pool', source: 'llmux', fetchedAt: 1 },
  limits: { maxPromptChars: 12000, maxFiles: 10, maxFileBytes: 20971520, maxTotalBytes: 31457280 },
};

const LAUNCH = {
  channel: 'C_ALPHA',
  threadTs: '1792735000.000100',
  sessionKey: 'C_ALPHA:1792735000.000100',
  permalink: 'https://slack.example/p1',
  status: 'running',
};

describe('Dashboard — New task API', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let provider: { context: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    provider = {
      context: vi.fn(async () => structuredClone(CONTEXT)),
      start: vi.fn(async () => LAUNCH),
    };
    dashboard.setDashboardNewTaskProvider(provider);
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  async function signIn(slackUserId = 'U_PLAIN') {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: 'Plain' });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const setCookie = sso.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
    const me = await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } });
    return { cookie, csrf: JSON.parse(me.body).csrfToken as string };
  }

  function body(overrides: Record<string, unknown> = {}) {
    return {
      requestId: 'req-0123456789',
      prompt: 'soma-work 개선해줘',
      model: 'opus[1m]',
      effort: 'xhigh',
      channelId: 'C_ALPHA',
      autogoal: true,
      autoz: true,
      attachments: [],
      ...overrides,
    };
  }

  async function post(auth: { cookie: string; csrf: string }, payload: unknown, extra: Record<string, string> = {}) {
    return injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json', ...extra },
      payload,
    });
  }

  describe('GET /api/dashboard/new-task/context', () => {
    it('anonymous → 401', async () => {
      expect((await injectWebServer({ method: 'GET', url: '/api/dashboard/new-task/context' })).statusCode).toBe(401);
    });

    it('a viewer token without a Slack user cannot start tasks → 403', async () => {
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/new-task/context',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(403);
      expect(provider.context).not.toHaveBeenCalled();
    });

    it('a signed-in Slack user gets their composer context', async () => {
      const auth = await signIn();
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/new-task/context',
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).context).toEqual(CONTEXT);
      expect(provider.context).toHaveBeenCalledWith('U_PLAIN');
    });

    it('no provider wired → 501', async () => {
      dashboard.setDashboardNewTaskProvider(null);
      const auth = await signIn();
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/new-task/context',
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(501);
    });
  });

  describe('POST /api/dashboard/new-task', () => {
    it('requires the CSRF token', async () => {
      const auth = await signIn();
      const res = await post({ cookie: auth.cookie, csrf: 'nope' }, body());
      expect(res.statusCode).toBe(403);
      expect(provider.start).not.toHaveBeenCalled();
    });

    it('starts the task as the signed-in user, validated against a fresh context', async () => {
      const auth = await signIn();
      const res = await post(auth, body());
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, ...LAUNCH });
      expect(provider.context).toHaveBeenCalledWith('U_PLAIN', { fresh: true });
      expect(provider.start).toHaveBeenCalledTimes(1);
      const [userId, submission] = provider.start.mock.calls[0];
      expect(userId).toBe('U_PLAIN');
      expect(submission).toMatchObject({
        requestId: 'req-0123456789',
        prompt: 'soma-work 개선해줘',
        model: 'claude-opus-5-5[1m]',
        nickname: 'opus[1m]',
        effort: 'xhigh',
        channelId: 'C_ALPHA',
        autogoal: true,
        autoz: true,
        attachments: [],
      });
    });

    it('never runs as anyone else: a userId in the body and admin mode are ignored', async () => {
      const auth = await signIn();
      const res = await post(auth, { ...body(), userId: 'U_OTHER', ownerId: 'U_OTHER' }, { 'x-admin-mode': 'on' });
      expect(res.statusCode).toBe(200);
      expect(provider.start.mock.calls[0][0]).toBe('U_PLAIN');
    });

    it('a channel the fresh context does not offer → 400, nothing posted', async () => {
      const auth = await signIn();
      const res = await post(auth, body({ channelId: 'C_SECRET' }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/channel/i);
      expect(provider.start).not.toHaveBeenCalled();
    });

    it('a retried request id launches once and both answers carry the same thread', async () => {
      const auth = await signIn();
      const [a, b] = await Promise.all([post(auth, body()), post(auth, body())]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(JSON.parse(b.body).threadTs).toBe(LAUNCH.threadTs);
      expect(provider.start).toHaveBeenCalledTimes(1);
    });

    it('admits a multi-megabyte attachment (phone photo) in the JSON body', async () => {
      const auth = await signIn();
      const photo = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
      const res = await post(auth, body({ attachments: [{ name: 'photo.jpg', mimetype: 'image/jpeg', data: photo }] }));
      expect(res.statusCode).toBe(200);
      const submission = provider.start.mock.calls[0][1];
      expect(submission.attachments[0].data.length).toBe(3 * 1024 * 1024);
    });

    it('a launcher failure keeps its status and message', async () => {
      const { NewTaskError } = await import('../new-task-launcher');
      provider.start.mockRejectedValueOnce(new NewTaskError(502, '첨부 업로드 실패'));
      const auth = await signIn();
      const res = await post(auth, body());
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).error).toBe('첨부 업로드 실패');
    });

    // SSOT 2026-11-02 (dev, 04:20Z): the launch answered 'starting', the Slack rate limiter held the pipeline, and the
    // session existed 24 s later — but without an SDK sessionId until ~2 min later, so the board hid it and the
    // dashboard's 시작 중 card never met its card. A session launched here is on the board as soon as it exists.
    it('a session it launched is on the board as soon as it exists — before its SDK session id', async () => {
      const key = 'work:C_ALPHA:1792735000.000200';
      provider.start.mockResolvedValueOnce({ ...LAUNCH, sessionKey: key, status: 'starting' });
      const sessions = new Map<string, Record<string, unknown>>();
      dashboard.setDashboardSessionAccessor(() => sessions);
      const fresh = (threadTs: string) => ({
        channelId: 'C_ALPHA',
        threadTs,
        ownerId: 'U_PLAIN',
        ownerName: 'Plain',
        activityState: 'working',
        state: 'MAIN',
        lastActivity: new Date(),
        usage: {},
      });
      const auth = await signIn();
      const res = await post(auth, body({ requestId: 'req-launch-board-1' }));
      expect(res.statusCode).toBe(200);
      // The pipeline creates the session later, with no sessionId yet; an unrelated one like it stays hidden.
      sessions.set(key, fresh('1792735000.000200'));
      sessions.set('work:C_ALPHA:1792735000.000999', fresh('1792735000.000999'));
      const board = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
      expect(board.statusCode).toBe(200);
      const keys = Object.values(JSON.parse(board.body).board as Record<string, Array<{ key: string }>>)
        .flat()
        .map((c) => c.key);
      expect(keys.some((k) => k === key || k.endsWith(`::${key}`))).toBe(true);
      expect(keys.some((k) => k.endsWith('1792735000.000999'))).toBe(false);
    });

    it('a viewer token without a Slack user → 403', async () => {
      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/new-task',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: body(),
      });
      expect(res.statusCode).toBe(403);
      expect(provider.start).not.toHaveBeenCalled();
    });
  });
});
