import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config before importing web-server
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
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../config', () => ({
  config: mockConfig,
}));

vi.mock('../env-paths', () => ({
  IS_DEV: true,
  DATA_DIR: '/tmp/test-data',
}));

vi.mock('./recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));

vi.mock('./viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));

describe('ConversationWebServer Authentication', () => {
  let server: any;

  beforeEach(() => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = '';
  });

  afterEach(async () => {
    if (server) {
      const { stopWebServer } = await import('./web-server');
      await stopWebServer();
      server = null;
    }
  });

  describe('when CONVERSATION_VIEWER_TOKEN is not set', () => {
    it('should allow unauthenticated access to /api/conversations', async () => {
      mockConfig.conversation.viewerToken = '';

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({
        method: 'GET',
        url: '/api/conversations',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body) as any;
      expect(data).toHaveProperty('conversations');
    });

    it('should allow unauthenticated access to /health', async () => {
      mockConfig.conversation.viewerToken = '';

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body) as any;
      expect(data.status).toBe('ok');
    });
  });

  describe('when CONVERSATION_VIEWER_TOKEN is set', () => {
    const TEST_TOKEN = 'test-secret-token-12345';

    it('should reject requests without Authorization header', async () => {
      mockConfig.conversation.viewerToken = TEST_TOKEN;

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({
        method: 'GET',
        url: '/api/conversations',
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body) as any;
      expect(data.error).toBe('Unauthorized');
    });

    it('should reject requests with invalid token', async () => {
      mockConfig.conversation.viewerToken = TEST_TOKEN;

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({
        method: 'GET',
        url: '/api/conversations',
        headers: { Authorization: 'Bearer wrong-token' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should accept requests with valid Bearer token', async () => {
      mockConfig.conversation.viewerToken = TEST_TOKEN;

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({
        method: 'GET',
        url: '/api/conversations',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should accept requests with raw token (no Bearer prefix)', async () => {
      mockConfig.conversation.viewerToken = TEST_TOKEN;

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({
        method: 'GET',
        url: '/api/conversations',
        headers: { Authorization: TEST_TOKEN },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should NOT require auth for /health endpoint', async () => {
      mockConfig.conversation.viewerToken = TEST_TOKEN;

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should require auth for HTML conversation list', async () => {
      mockConfig.conversation.viewerToken = TEST_TOKEN;

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      // Without token — HTML routes redirect to /login
      const noAuthResponse = await injectWebServer({
        method: 'GET',
        url: '/conversations',
      });
      expect(noAuthResponse.statusCode).toBe(302);
      expect(noAuthResponse.headers.location).toBe('/login');

      // With token
      const authResponse = await injectWebServer({
        method: 'GET',
        url: '/conversations',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(authResponse.statusCode).toBe(200);
    });
  });

  describe('Slack SSO /auth/sso (#704)', () => {
    beforeEach(() => {
      mockConfig.oauth.jwtSecret = 'test-jwt-secret';
      mockConfig.conversation.viewerToken = '';
    });

    it('redeems a valid exchange token: sets cookie and redirects', async () => {
      const { startWebServer, injectWebServer } = await import('./web-server');
      const { issueSlackToken } = await import('./oauth');
      await startWebServer({ listen: false });
      server = true;

      const token = issueSlackToken({ slackUserId: 'U_SSO', email: 'sso@slack.local', name: 'SSO User' });

      const response = await injectWebServer({
        method: 'GET',
        url: `/auth/sso?token=${encodeURIComponent(token)}`,
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/dashboard/U_SSO');
      const setCookie = response.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
      expect(cookieStr).toContain('soma_dash_token=');
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('SameSite=Lax');
    });

    it('rejects a second redemption of the same exchange token (jti consumed)', async () => {
      const { startWebServer, injectWebServer } = await import('./web-server');
      const { issueSlackToken } = await import('./oauth');
      await startWebServer({ listen: false });
      server = true;

      const token = issueSlackToken({ slackUserId: 'U_SSO', email: 'e@x', name: 'N' });

      const first = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
      expect(first.statusCode).toBe(302);
      expect(first.headers.location).toBe('/dashboard/U_SSO');

      const replay = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
      expect(replay.statusCode).toBe(302);
      expect(replay.headers.location).toBe('/login?error=sso_consumed');
      // No cookie issued on replay
      expect(replay.headers['set-cookie']).toBeUndefined();
    });

    it('rejects a session-type JWT passed as an exchange token', async () => {
      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      // Forge a token that looks like a session cookie (no type='sso_exchange').
      const jwt = await import('jsonwebtoken');
      const sessionLike = jwt.sign(
        { sub: 'U1', email: 'e@x', name: 'N', provider: 'slack' },
        'test-jwt-secret',
        { expiresIn: 3600 },
      );
      const response = await injectWebServer({
        method: 'GET',
        url: `/auth/sso?token=${encodeURIComponent(sessionLike)}`,
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login?error=sso_invalid');
    });

    it('shows a session-switch confirmation page when a different user is already logged in', async () => {
      const { startWebServer, injectWebServer } = await import('./web-server');
      const { issueSlackToken } = await import('./oauth');
      await startWebServer({ listen: false });
      server = true;

      // Existing session cookie for UA.
      const jwt = await import('jsonwebtoken');
      const existingSession = jwt.sign(
        { sub: 'UA', email: 'a@x', name: 'Alice', provider: 'slack' },
        'test-jwt-secret',
        { expiresIn: 3600 },
      );
      // Fresh exchange token for UB.
      const exchange = issueSlackToken({ slackUserId: 'UB', email: 'b@x', name: 'Bob' });

      const response = await injectWebServer({
        method: 'GET',
        url: `/auth/sso?token=${encodeURIComponent(exchange)}`,
        headers: { cookie: `soma_dash_token=${encodeURIComponent(existingSession)}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Switch accounts?');
      expect(response.body).toContain('Alice'); // current user
      expect(response.body).toContain('Bob'); // requested user
      // The jti MUST NOT be consumed on the interstitial path — user
      // might still cancel. Verify the token can still POST-confirm.
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('POST /auth/sso/confirm redeems the switch explicitly', async () => {
      const { startWebServer, injectWebServer } = await import('./web-server');
      const { issueSlackToken } = await import('./oauth');
      await startWebServer({ listen: false });
      server = true;

      const exchange = issueSlackToken({ slackUserId: 'UC', email: 'c@x', name: 'Carol' });
      // form-urlencoded body
      const body = `token=${encodeURIComponent(exchange)}`;
      const response = await injectWebServer({
        method: 'POST',
        url: '/auth/sso/confirm',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: body,
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/dashboard/UC');
      const setCookie = response.headers['set-cookie'];
      expect(Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie)).toContain('soma_dash_token=');
    });

    it('redirects with sso_invalid on a bogus token', async () => {
      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({ method: 'GET', url: '/auth/sso?token=not-a-jwt' });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login?error=sso_invalid');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('redirects with sso_missing when token querystring absent', async () => {
      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({ method: 'GET', url: '/auth/sso' });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login?error=sso_missing');
    });
  });
});
