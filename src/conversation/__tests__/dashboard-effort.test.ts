import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SSOT 2026-10-23 T1 — the dashboard changes a session's reasoning effort.
 *
 * Server half: `POST /api/dashboard/session/:key/effort` (owner / admin gate,
 * cross-instance 409, host handler wired in `src/index.ts`), and the page
 * carrying the effort menu. The effort semantics live in
 * `session/effort-switch.ts` (covered in `effort-switch.test.ts`); here the
 * handler is a double and the HTTP contract around it is pinned.
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
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));
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

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    model: 'claude-opus-5-5[1m]',
    effort: 'xhigh',
    activityState: 'idle',
    state: 'MAIN',
    lastActivity: new Date('2026-10-23T00:00:00Z'),
    ...overrides,
  };
}

describe('Dashboard — session effort switch (SSOT 2026-10-23 T1)', () => {
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    await webServer.startWebServer({ listen: false });
    dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', liveSession()]]));
  });

  afterEach(async () => {
    await stopWebServer();
  });

  async function post(payload: any, headers: Record<string, string> = AUTH_HEADER, key = 'C1:t1') {
    return injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/effort`,
      headers,
      payload,
    });
  }

  /** A signed-in Slack user: SSO cookie + CSRF token from /auth/me. */
  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string };
  }

  it('switches through the host handler and answers with its result', async () => {
    const result = { status: 'switched', effort: 'high', previous: 'xhigh', effective: 'high' };
    const handler = vi.fn().mockReturnValue(result);
    dashboard.setDashboardEffortHandler(handler);
    const res = await post({ effort: 'high' });
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledWith('C1:t1', 'high');
    expect(JSON.parse(res.body)).toEqual({ ok: true, result });
  });

  it.each([[{}], [{ effort: 5 }], [{ effort: '' }], [{ effort: 'x'.repeat(33) }]])('400 for %j', async (body) => {
    dashboard.setDashboardEffortHandler(vi.fn());
    expect((await post(body)).statusCode).toBe(400);
  });

  it('answers a refusal with its status and message', async () => {
    const { EffortSwitchError } = await import('../../session/effort-switch');
    dashboard.setDashboardEffortHandler(
      vi.fn(() => {
        throw new EffortSwitchError(409, '종료된 세션');
      }),
    );
    const res = await post({ effort: 'low' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: '종료된 세션' });
  });

  it('501 when no handler is wired', async () => {
    expect((await post({ effort: 'low' })).statusCode).toBe(501);
  });

  it('the owner may switch; another signed-in user may not (403); admin needs admin mode', async () => {
    const handler = vi.fn().mockReturnValue({ status: 'switched', effort: 'low', previous: 'xhigh', effective: 'low' });
    dashboard.setDashboardEffortHandler(handler);
    expect((await post({ effort: 'low' }, await signIn('U1'))).statusCode).toBe(200);
    expect((await post({ effort: 'low' }, await signIn('U2'))).statusCode).toBe(403);
    const admin = await signIn('U_ADMIN');
    expect((await post({ effort: 'low' }, admin)).statusCode).toBe(403);
    expect((await post({ effort: 'low' }, { ...admin, 'x-admin-mode': 'on' })).statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('a cookie user without a CSRF token is refused', async () => {
    dashboard.setDashboardEffortHandler(vi.fn());
    const { cookie } = await signIn('U1');
    expect((await post({ effort: 'low' }, { cookie })).statusCode).toBe(403);
  });

  it('the page carries the five effort levels in order', async () => {
    const res = await injectWebServer({ method: 'GET', url: '/dashboard', headers: AUTH_HEADER });
    const m = /const EFFORT_LEVELS = (\[.*?\]);\n/.exec(res.body);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
