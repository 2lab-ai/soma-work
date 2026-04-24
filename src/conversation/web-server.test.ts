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
    it('should set soma_dash_token cookie and redirect to user dashboard for valid token', async () => {
      mockConfig.oauth.jwtSecret = 'test-jwt-secret';
      mockConfig.conversation.viewerToken = '';

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const jwt = await import('jsonwebtoken');
      const token = jwt.sign(
        { sub: 'U_SSO', email: 'sso@slack.local', name: 'SSO User', provider: 'slack' },
        'test-jwt-secret',
        { expiresIn: 3600 },
      );

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
      // Reset for next tests in this file
      mockConfig.oauth.jwtSecret = '';
    });

    it('should redirect to /login?error=sso_invalid for a bogus token', async () => {
      mockConfig.oauth.jwtSecret = 'test-jwt-secret';
      mockConfig.conversation.viewerToken = '';

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({
        method: 'GET',
        url: '/auth/sso?token=not-a-jwt',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login?error=sso_invalid');
      // No cookie leaked on failure
      expect(response.headers['set-cookie']).toBeUndefined();
      mockConfig.oauth.jwtSecret = '';
    });

    it('should redirect to /login?error=sso_missing when token querystring absent', async () => {
      mockConfig.oauth.jwtSecret = 'test-jwt-secret';
      mockConfig.conversation.viewerToken = '';

      const { startWebServer, injectWebServer } = await import('./web-server');
      await startWebServer({ listen: false });
      server = true;

      const response = await injectWebServer({
        method: 'GET',
        url: '/auth/sso',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login?error=sso_missing');
      mockConfig.oauth.jwtSecret = '';
    });
  });
});
