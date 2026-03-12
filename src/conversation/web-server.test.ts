import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing web-server
const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: '',
  },
};

vi.mock('../config', () => ({
  config: mockConfig,
}));

vi.mock('../env-paths', () => ({
  IS_DEV: true,
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

      // Without token
      const noAuthResponse = await injectWebServer({
        method: 'GET',
        url: '/conversations',
      });
      expect(noAuthResponse.statusCode).toBe(401);

      // With token
      const authResponse = await injectWebServer({
        method: 'GET',
        url: '/conversations',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(authResponse.statusCode).toBe(200);
    });
  });
});
