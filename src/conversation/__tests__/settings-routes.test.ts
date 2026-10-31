import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SSOT 2026-10-23 T2 — `GET /api/settings` and `PATCH /api/settings/:key`.
 * Self only: the user is the signed-in Slack user (never a query or body
 * field); every write passes auth + CSRF, registered once for the route
 * group. The registry semantics are covered in `user-settings-registry.test.ts`;
 * here it is a double and the HTTP contract is pinned.
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

describe('settings routes (SSOT 2026-10-23 T2)', () => {
  let stopWebServer: any;
  let injectWebServer: any;
  let routes: any;
  let SettingsError: any;
  const registry = {
    read: vi.fn((userId: string) => ({ userId, isAdmin: userId === 'U_ADMIN', groups: [], settings: [] })),
    write: vi.fn(async (_userId: string, key: string, value: unknown) => ({ key, value })),
  };

  beforeEach(async () => {
    vi.resetModules();
    registry.read.mockClear();
    registry.write.mockClear();
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    routes = await import('../settings-routes');
    SettingsError = (await import('../../user-settings-registry')).SettingsError;
    await webServer.startWebServer({ listen: false });
    routes.setSettingsRegistry(registry);
  });

  afterEach(async () => {
    await stopWebServer();
  });

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string };
  }

  it('GET returns the signed-in user’s own settings', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/settings?userId=U_OTHER',
      headers: await signIn('U1'),
    });
    expect(res.statusCode).toBe(200);
    expect(registry.read).toHaveBeenCalledWith('U1');
    expect(JSON.parse(res.body)).toMatchObject({ userId: 'U1', isAdmin: false });
  });

  it('an unauthenticated request is 401; a viewer token without a Slack user is 400', async () => {
    expect((await injectWebServer({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/settings',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(registry.read).not.toHaveBeenCalled();
  });

  it('PATCH writes one key for the signed-in user and answers with the fresh row', async () => {
    const res = await injectWebServer({
      method: 'PATCH',
      url: '/api/settings/defaultEffort',
      headers: { ...(await signIn('U1')), 'content-type': 'application/json' },
      payload: { value: 'high', userId: 'U_OTHER' },
    });
    expect(res.statusCode).toBe(200);
    expect(registry.write).toHaveBeenCalledWith('U1', 'defaultEffort', 'high');
    expect(JSON.parse(res.body)).toEqual({ ok: true, setting: { key: 'defaultEffort', value: 'high' } });
  });

  it('PATCH without a CSRF token is refused before the registry runs', async () => {
    const { cookie } = await signIn('U1');
    const res = await injectWebServer({
      method: 'PATCH',
      url: '/api/settings/defaultEffort',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { value: 'high' },
    });
    expect(res.statusCode).toBe(403);
    expect(registry.write).not.toHaveBeenCalled();
  });

  it('PATCH without a value is 400; a registry refusal keeps its status and message', async () => {
    const auth = { ...(await signIn('U1')), 'content-type': 'application/json' };
    expect(
      (await injectWebServer({ method: 'PATCH', url: '/api/settings/rating', headers: auth, payload: {} })).statusCode,
    ).toBe(400);
    registry.write.mockRejectedValueOnce(new SettingsError(403, '관리자만 바꿀 수 있습니다.'));
    const res = await injectWebServer({
      method: 'PATCH',
      url: '/api/settings/sandbox',
      headers: auth,
      payload: { value: false },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: '관리자만 바꿀 수 있습니다.' });
  });

  it('a failing read answers a plain 500 without internal details', async () => {
    registry.read.mockImplementationOnce(() => {
      throw new Error('ENOENT /secret/path');
    });
    const res = await injectWebServer({ method: 'GET', url: '/api/settings', headers: await signIn('U1') });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('/secret/path');
  });

  it('GET /dashboard/settings serves the settings page, not the board of a user called "settings"', async () => {
    const res = await injectWebServer({ method: 'GET', url: '/dashboard/settings', headers: await signIn('U1') });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>soma-work 설정</title>');
    expect(res.body).toContain('id="pref-body"');
    const anon = await injectWebServer({ method: 'GET', url: '/dashboard/settings', headers: { accept: 'text/html' } });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe('/login');
  });

  it('the dashboard top bar links to the settings page', async () => {
    const res = await injectWebServer({ method: 'GET', url: '/dashboard', headers: await signIn('U1') });
    // D2 group 1: the top bar is @2lab.ai/ui <ui-app-bar>; its links are data (설정 → /dashboard/settings).
    expect(res.body).toContain('<ui-app-bar id="app-bar" lang="ko">');
    expect(res.body).toContain("{ id: 'settings', label: '설정', href: '/dashboard/settings', icon: 'gear' },");
  });

  it('503 when no registry is wired', async () => {
    routes.setSettingsRegistry(null);
    expect(
      (await injectWebServer({ method: 'GET', url: '/api/settings', headers: await signIn('U1') })).statusCode,
    ).toBe(503);
  });
});
