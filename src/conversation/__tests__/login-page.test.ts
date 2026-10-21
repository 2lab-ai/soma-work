import * as fs from 'node:fs';
import * as path from 'node:path';
import * as jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The login page is also the account page: a browser that already holds a
// session sees who it is signed in as, and can continue, switch account or
// sign out. API token login is gone from the page and the server.

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: '',
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
vi.mock('../instance-registry', () => ({
  startHeartbeatLoop: vi.fn(() => setInterval(() => {}, 60_000)),
  removeHeartbeat: vi.fn().mockResolvedValue(undefined),
  readAllInstances: vi.fn().mockResolvedValue([]),
}));

const DAY = 86400;

function sessionCookie(
  claims: { sub: string; email: string; name: string; provider: string; originalIat?: number },
  secret = 'test-jwt-secret',
): string {
  const token = jwt.sign({ originalIat: Math.floor(Date.now() / 1000), ...claims }, secret, { expiresIn: 604800 });
  return `soma_dash_token=${encodeURIComponent(token)}`;
}

/** The page body without its <style> and <script> blocks — what a reader sees. */
function markup(body: string): string {
  return body.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script>[\s\S]*?<\/script>/g, '');
}

describe('login page', () => {
  let web: typeof import('../web-server');

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = '';
    mockConfig.oauth.google = { clientId: '', clientSecret: '' };
    mockConfig.oauth.microsoft = { clientId: '', clientSecret: '' };
    web = await import('../web-server');
  });

  afterEach(async () => {
    await web.stopWebServer();
  });

  async function getLogin(cookie?: string) {
    await web.startWebServer({ listen: false });
    return web.injectWebServer({ method: 'GET', url: '/login', headers: cookie ? { cookie } : {} });
  }

  describe('API token login is removed (T2)', () => {
    it('the page has no token form, token copy or token script', async () => {
      mockConfig.conversation.viewerToken = 'viewer-secret';
      mockConfig.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
      const res = await getLogin();
      expect(res.statusCode).toBe(200);
      for (const gone of ['token-input', 'token-form', 'loginWithToken', 'API token', 'Viewer token', '/auth/token']) {
        expect(res.body).not.toContain(gone);
      }
    });

    it('with no OAuth provider the page still points at Slack, not at a token', async () => {
      const res = await getLogin();
      expect(res.body).not.toContain('Use API token');
      expect(res.body).toContain('Slack 스레드에서 <code>dashboard</code>를 입력하면 로그인 링크를 받습니다');
    });

    it('POST /auth/token no longer exists', async () => {
      mockConfig.conversation.viewerToken = 'viewer-secret';
      await web.startWebServer({ listen: false });
      const res = await web.injectWebServer({
        method: 'POST',
        url: '/auth/token',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ token: 'viewer-secret' }),
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('signed-out browser', () => {
    it('shows the sign-in options and no account card', async () => {
      mockConfig.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
      const res = await getLogin();
      const html = markup(res.body);
      expect(html).toContain('Sign in with Google');
      expect(html).toContain('href="/auth/google"');
      expect(html).not.toContain('Signed in as');
      expect(html).not.toContain('href="/auth/logout"');
    });

    it('a cookie signed with another secret is not a session', async () => {
      mockConfig.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
      const res = await getLogin(
        sessionCookie({ sub: 'U_X', email: 'x@x.com', name: 'Mallory', provider: 'google' }, 'other-secret'),
      );
      expect(markup(res.body)).not.toContain('Signed in as');
      expect(res.body).not.toContain('Mallory');
    });
  });

  describe('signed-in browser (T1)', () => {
    it('shows the current Google account with continue, switch and sign out', async () => {
      mockConfig.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
      const res = await getLogin(
        sessionCookie({ sub: 'U_G', email: 'wrong@gmail.com', name: 'Wrong', provider: 'google' }),
      );
      const html = markup(res.body);
      expect(res.statusCode).toBe(200);
      expect(html).toContain('Signed in as');
      expect(html).toContain('Wrong');
      expect(html).toContain('wrong@gmail.com');
      expect(html).toContain('Google');
      expect(html).toContain('href="/dashboard/U_G"');
      expect(html).toContain('Use a different account');
      // Google's account chooser (prompt=select_account) is one click away.
      expect(html).toContain('href="/auth/google"');
      expect(html).toContain('href="/auth/logout"');
      expect(html).toContain('Sign out');
    });

    it('names the provider the session came from', async () => {
      mockConfig.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
      mockConfig.oauth.microsoft = { clientId: 'mid', clientSecret: 'msecret' };
      const ms = markup(
        (await getLogin(sessionCookie({ sub: 'U_M', email: 'm@corp.com', name: 'M', provider: 'microsoft' }))).body,
      );
      expect(ms).toContain('via Microsoft');
      await web.stopWebServer();
      const slack = markup(
        (await getLogin(sessionCookie({ sub: 'U_S', email: 's@x.com', name: 'S', provider: 'slack' }))).body,
      );
      expect(slack).toContain('via Slack');
    });

    it('the account card escapes the name and email', async () => {
      const res = await getLogin(
        sessionCookie({
          sub: 'U_E',
          email: '"><svg onload=1>@x.com',
          name: '<img src=x onerror=alert(1)>',
          provider: 'google',
        }),
      );
      expect(res.body).not.toContain('<img src=x');
      expect(res.body).not.toContain('<svg onload');
      expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('a session past its absolute lifetime is not shown (the dashboard would refuse it too)', async () => {
      mockConfig.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
      const now = Math.floor(Date.now() / 1000);
      const res = await getLogin(
        sessionCookie({
          sub: 'U_OLD',
          email: 'old@x.com',
          name: 'Old',
          provider: 'google',
          originalIat: now - 31 * DAY,
        }),
      );
      expect(markup(res.body)).not.toContain('Signed in as');
      expect(res.body).not.toContain('old@x.com');
    });

    it('a legacy viewer-token cookie shows as the admin session and can sign out', async () => {
      mockConfig.conversation.viewerToken = 'viewer-secret';
      const res = await getLogin(`soma_dash_token=${encodeURIComponent('bearer:viewer-secret')}`);
      const html = markup(res.body);
      expect(html).toContain('Signed in as');
      expect(html).toContain('Admin');
      expect(html).toContain('href="/dashboard"');
      expect(html).toContain('href="/auth/logout"');
    });

    it('the page is never cached — it carries the account name', async () => {
      const res = await getLogin(sessionCookie({ sub: 'U_G', email: 'g@x.com', name: 'G', provider: 'google' }));
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('sign out clears the session and returns to a signed-out login page', async () => {
      await web.startWebServer({ listen: false });
      const res = await web.injectWebServer({ method: 'GET', url: '/auth/logout' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login');
      expect(String(res.headers['set-cookie'])).toMatch(/soma_dash_token=;.*Max-Age=0/);
    });
  });
});

describe('dashboard account pill (T1 entry point)', () => {
  const DASHBOARD_TS = fs.readFileSync(path.join(__dirname, '..', 'dashboard.ts'), 'utf8');

  it('is a real link to the account page, not a hidden click-to-logout', () => {
    const pill = DASHBOARD_TS.match(/<a\s[^>]*id="user-pill"[^>]*>/)?.[0] ?? '';
    expect(pill).toContain('href="/login"');
    expect(DASHBOARD_TS).not.toContain('title="Click to logout"');
    expect(DASHBOARD_TS).not.toContain("location.href = '/auth/logout'");
  });
});
