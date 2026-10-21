import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spec §3.4-3: a browser bounced to /login keeps its /dashboard deep link in
// the `soma_next` cookie, and every successful login lands back on it.

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
// A real listen() starts the #814 heartbeat; keep it off the shared instance registry.
vi.mock('../instance-registry', () => ({
  startHeartbeatLoop: vi.fn(() => setInterval(() => {}, 60_000)),
  removeHeartbeat: vi.fn().mockResolvedValue(undefined),
  readAllInstances: vi.fn().mockResolvedValue([]),
}));

const DEEP_LINK = '/dashboard/U_SSO?session=C1%3A1712345.678';

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function nextCookie(value: string): string {
  return `soma_next=${encodeURIComponent(value)}`;
}

describe('login return (soma_next)', () => {
  let web: typeof import('../web-server');
  let oauth: typeof import('../oauth');

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = '';
    mockConfig.conversation.viewerUrl = '';
    mockConfig.oauth.google = { clientId: '', clientSecret: '' };
    mockConfig.oauth.microsoft = { clientId: '', clientSecret: '' };
    web = await import('../web-server');
    oauth = await import('../oauth');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await web.stopWebServer();
  });

  describe('isSafeLoginReturnPath', () => {
    it.each([
      '/dashboard/U1',
      '/dashboard/U1?session=C1%3A1712345.678',
      '/dashboard?user=U1',
      '/dashboard/',
      '/dashboard/U1.v2?session=a..b',
      '/dashboard/U1?next=../x',
      '/dashboard/U1#card=..',
      // The fragment never changes the path: this still resolves to /dashboard.
      '/dashboard#/../login',
    ])('accepts same-origin dashboard path %s', (value) => {
      expect(oauth.isSafeLoginReturnPath(value)).toBe(true);
    });

    it.each([
      'https://evil.example.com/dashboard',
      '//evil.example.com/dashboard',
      '/dashboard//evil.example.com',
      '/dashboard/\\evil.example.com',
      '/dashboardx',
      '/conversations',
      '/login',
      'dashboard/U1',
      '/dashboard/U1\r\nSet-Cookie: x=1',
      '/dashboard/U1 x',
      '/dashboard/한글',
      '',
      '/dashboard/../login',
      '/dashboard/./U1',
      '/dashboard/..',
      '/dashboard/.',
      '/dashboard/U1/..?session=x',
      '/dashboard/%2e%2e/login',
      '/dashboard/%2E%2E/login',
      '/dashboard/.%2e/login',
      '/dashboard/%2e/U1',
      '/dashboard/U1/%2e%2E',
      '/dashboard/..#x',
      '/dashboard/%2e%2e#x',
      '/dashboard/U1/.#frag',
    ])('rejects %j', (value) => {
      expect(oauth.isSafeLoginReturnPath(value)).toBe(false);
    });

    it('rejects an over-long path', () => {
      expect(oauth.isSafeLoginReturnPath(`/dashboard/${'a'.repeat(3000)}`)).toBe(false);
    });
  });

  describe('auth redirect stores the original path', () => {
    beforeEach(async () => {
      await web.startWebServer({ listen: false });
    });

    it('sets soma_next for a /dashboard deep link and still redirects to /login', async () => {
      const res = await web.injectWebServer({ method: 'GET', url: DEEP_LINK });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login');
      const cookie = setCookies(res).find((c) => c.startsWith('soma_next='));
      expect(cookie).toBeDefined();
      expect(cookie).toContain(nextCookie(DEEP_LINK));
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toMatch(/Max-Age=\d+/);
    });

    it('does not set soma_next for the bare /dashboard (SSO default is already better)', async () => {
      const res = await web.injectWebServer({ method: 'GET', url: '/dashboard' });
      expect(res.statusCode).toBe(302);
      expect(setCookies(res).some((c) => c.startsWith('soma_next='))).toBe(false);
    });

    it('does not set soma_next for non-dashboard pages', async () => {
      const res = await web.injectWebServer({ method: 'GET', url: '/conversations' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login');
      expect(setCookies(res)).toEqual([]);
    });

    it('does not set soma_next on API 401s', async () => {
      const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions' });
      expect(res.statusCode).toBe(401);
      expect(setCookies(res)).toEqual([]);
    });
  });

  describe('Slack SSO lands on soma_next', () => {
    beforeEach(async () => {
      await web.startWebServer({ listen: false });
    });

    it('redirects to the stored deep link and clears the cookie', async () => {
      const token = oauth.issueSlackToken({ slackUserId: 'U_SSO', email: 'sso@x', name: 'SSO' });
      const res = await web.injectWebServer({
        method: 'GET',
        url: `/auth/sso?token=${encodeURIComponent(token)}`,
        headers: { cookie: nextCookie(DEEP_LINK) },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(DEEP_LINK);
      const cookies = setCookies(res);
      expect(cookies.some((c) => c.startsWith('soma_dash_token='))).toBe(true);
      expect(cookies.find((c) => c.startsWith('soma_next='))).toMatch(/^soma_next=;.*Max-Age=0/);
    });

    it('ignores a forged external soma_next and lands on the default dashboard', async () => {
      const token = oauth.issueSlackToken({ slackUserId: 'U_SSO', email: 'sso@x', name: 'SSO' });
      for (const forged of [
        'https://evil.example.com/',
        '//evil.example.com',
        '/dashboard//evil.example.com',
        '/dashboard/../login',
        '/dashboard/%2e%2e/login',
        '/dashboard/..#x',
        '/dashboard/%2e%2e#x',
      ]) {
        const res = await web.injectWebServer({
          method: 'GET',
          url: `/auth/sso?token=${encodeURIComponent(oauth.issueSlackToken({ slackUserId: 'U_SSO', email: 'e', name: 'n' }))}`,
          headers: { cookie: nextCookie(forged) },
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/dashboard/U_SSO');
      }
      // Undecodable value is ignored too.
      const res = await web.injectWebServer({
        method: 'GET',
        url: `/auth/sso?token=${encodeURIComponent(token)}`,
        headers: { cookie: 'soma_next=%E0%A4%A' },
      });
      expect(res.headers.location).toBe('/dashboard/U_SSO');
    });

    it('keeps the current landing and emits no soma_next header when the cookie is absent', async () => {
      const token = oauth.issueSlackToken({ slackUserId: 'U_SSO', email: 'sso@x', name: 'SSO' });
      const res = await web.injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
      expect(res.headers.location).toBe('/dashboard/U_SSO');
      expect(setCookies(res).some((c) => c.startsWith('soma_next='))).toBe(false);
    });

    it('leaves soma_next untouched on a failed redemption so the next link still lands', async () => {
      const res = await web.injectWebServer({
        method: 'GET',
        url: '/auth/sso?token=not-a-jwt',
        headers: { cookie: nextCookie(DEEP_LINK) },
      });
      expect(res.headers.location).toBe('/login?error=sso_invalid');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('POST /auth/sso/confirm (session switch) also lands on the deep link', async () => {
      mockConfig.conversation.viewerUrl = 'http://localhost:3000';
      const exchange = oauth.issueSlackToken({ slackUserId: 'UC', email: 'c@x', name: 'Carol' });
      const res = await web.injectWebServer({
        method: 'POST',
        url: '/auth/sso/confirm',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://localhost:3000',
          cookie: nextCookie(DEEP_LINK),
        },
        payload: `token=${encodeURIComponent(exchange)}`,
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(DEEP_LINK);
      expect(setCookies(res).find((c) => c.startsWith('soma_next='))).toMatch(/Max-Age=0/);
    });
  });

  describe('OAuth and token logins land on soma_next', () => {
    function stubOAuthFetch(userinfo: Record<string, unknown>): void {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => ({
          json: async () => (String(url).includes('token') ? { access_token: 'at' } : userinfo),
        })),
      );
    }

    it('Google callback redirects to the deep link', async () => {
      mockConfig.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
      await web.startWebServer({ listen: false });
      oauth.setOAuthUserLookup((email) =>
        email === 'g@x.com' ? { kind: 'match', userId: 'U_G', name: 'G' } : { kind: 'none' },
      );
      stubOAuthFetch({ email: 'g@x.com', name: 'G', verified_email: true });

      const state = 'abc:google';
      const res = await web.injectWebServer({
        method: 'GET',
        url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: `soma_oauth_state_google=${encodeURIComponent(state)}; ${nextCookie(DEEP_LINK)}` },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(DEEP_LINK);
      expect(setCookies(res).find((c) => c.startsWith('soma_next='))).toMatch(/Max-Age=0/);
    });

    it('Microsoft callback redirects to the deep link', async () => {
      mockConfig.oauth.microsoft = { clientId: 'mid', clientSecret: 'msecret' };
      await web.startWebServer({ listen: false });
      oauth.setOAuthUserLookup((email) =>
        email === 'm@x.com' ? { kind: 'match', userId: 'U_M', name: 'M' } : { kind: 'none' },
      );
      stubOAuthFetch({ mail: 'm@x.com', displayName: 'M' });

      const state = 'abc:microsoft';
      const res = await web.injectWebServer({
        method: 'GET',
        url: `/auth/microsoft/callback?code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: `soma_oauth_state_microsoft=${encodeURIComponent(state)}; ${nextCookie(DEEP_LINK)}` },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(DEEP_LINK);
    });

    it('Google callback without soma_next keeps the per-user landing', async () => {
      mockConfig.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
      await web.startWebServer({ listen: false });
      oauth.setOAuthUserLookup(() => ({ kind: 'match', userId: 'U_G', name: 'G' }));
      stubOAuthFetch({ email: 'g@x.com', name: 'G', verified_email: true });

      const state = 'abc:google';
      const res = await web.injectWebServer({
        method: 'GET',
        url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: `soma_oauth_state_google=${encodeURIComponent(state)}` },
      });
      expect(res.headers.location).toBe('/dashboard/U_G');
    });
  });

  describe('login page', () => {
    it('always tells the user to type `dashboard` in Slack, even with no OAuth provider', async () => {
      await web.startWebServer({ listen: false });
      const res = await web.injectWebServer({ method: 'GET', url: '/login' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Slack 스레드에서 <code>dashboard</code>를 입력하면 로그인 링크를 받습니다');
    });

    it('shows the hint alongside an enabled provider', async () => {
      mockConfig.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
      await web.startWebServer({ listen: false });
      const res = await web.injectWebServer({ method: 'GET', url: '/login' });
      expect(res.body).toContain('Sign in with Google');
      expect(res.body).toContain('<code>dashboard</code>');
    });
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe('getDashboardSessionUrl', () => {
  let web: typeof import('../web-server');

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerHost = '127.0.0.1';
    mockConfig.conversation.viewerPort = await freePort();
    web = await import('../web-server');
  });

  afterEach(async () => {
    await web.stopWebServer();
    mockConfig.conversation.viewerUrl = '';
    mockConfig.conversation.viewerHost = '127.0.0.1';
    mockConfig.conversation.viewerPort = 0;
  });

  it('is undefined until the viewer is listening, then builds the encoded deep link', async () => {
    mockConfig.conversation.viewerUrl = 'https://soma.example.com/';
    expect(web.getDashboardSessionUrl('U123', 'C1:1712345.678')).toBeUndefined();
    // The conversation link is not gated (unchanged behavior).
    expect(web.getConversationUrl('c1')).toContain('/conversations/c1');

    await web.startWebServer();
    expect(web.getDashboardSessionUrl('U123', 'C1:1712345.678')).toBe(
      'https://soma.example.com/dashboard/U123?session=C1%3A1712345.678',
    );
    expect(web.getDashboardSessionUrl('U 1/x', 'k')).toBe('https://soma.example.com/dashboard/U%201%2Fx?session=k');
  });

  it('is undefined again after the viewer stops', async () => {
    await web.startWebServer();
    expect(web.getDashboardSessionUrl('U1', 'C1:t1')).toBeDefined();
    await web.stopWebServer();
    expect(web.getDashboardSessionUrl('U1', 'C1:t1')).toBeUndefined();
  });

  it('is undefined for an in-process (listen:false) server', async () => {
    mockConfig.conversation.viewerUrl = 'https://soma.example.com';
    await web.startWebServer({ listen: false });
    expect(web.getDashboardSessionUrl('U1', 'C1:t1')).toBeUndefined();
  });

  it('is undefined when the viewer failed to start', async () => {
    mockConfig.conversation.viewerUrl = 'https://soma.example.com';
    mockConfig.conversation.viewerHost = '192.0.2.1'; // TEST-NET-1: not on this host → EADDRNOTAVAIL
    await expect(web.startWebServer()).rejects.toThrow();
    expect(web.getDashboardSessionUrl('U1', 'C1:t1')).toBeUndefined();
  });

  it('falls back to the detected host when no viewer URL is configured', async () => {
    mockConfig.conversation.viewerUrl = '';
    await web.startWebServer();
    expect(web.getDashboardSessionUrl('U1', 'C1:t1')).toBe(`${web.getViewerBaseUrl()}/dashboard/U1?session=C1%3At1`);
    expect(web.getViewerBaseUrl()).toContain(`:${mockConfig.conversation.viewerPort}`);
  });

  it('returns undefined when owner or session key is missing', async () => {
    mockConfig.conversation.viewerUrl = 'https://soma.example.com';
    await web.startWebServer();
    expect(web.getDashboardSessionUrl('', 'C1:t1')).toBeUndefined();
    expect(web.getDashboardSessionUrl('U1', '')).toBeUndefined();
  });
});
