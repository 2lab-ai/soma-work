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

vi.mock('../../config', () => ({
  config: mockConfig,
}));

vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  DATA_DIR: '/tmp/test-data',
}));

vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));

/**
 * Canonical-origin redirect: once the viewer is served from an https origin
 * (reverse proxy), links minted earlier as `http://<host>:<port>/...` must
 * bounce to that origin — Secure auth cookies are never stored over plain
 * http, so login from an old link would otherwise fail silently.
 */
describe('ConversationWebServer canonical-origin redirect', () => {
  const CANONICAL = 'https://bot.example.ts.net:8443';
  const PROXY_HOST = 'bot.example.ts.net:8443';
  const OLD_HOST = 'old-host:33000';

  let started = false;

  async function start(viewerUrl: string) {
    mockConfig.conversation.viewerUrl = viewerUrl;
    const web = await import('../web-server');
    await web.startWebServer({ listen: false });
    started = true;
    return web;
  }

  beforeEach(() => {
    vi.resetModules();
    // No auth configured → every route answers without credentials, so the
    // status code reflects routing alone.
    mockConfig.conversation.viewerToken = '';
    mockConfig.oauth.jwtSecret = '';
  });

  afterEach(async () => {
    if (started) {
      const { stopWebServer } = await import('../web-server');
      await stopWebServer();
      started = false;
    }
    mockConfig.conversation.viewerUrl = '';
  });

  describe('when viewerUrl is https', () => {
    it('redirects an old-host GET to the canonical origin, keeping path and query', async () => {
      const web = await start(CANONICAL);

      const response = await web.injectWebServer({
        method: 'GET',
        url: '/dashboard/U123?session=abc%2Fdef&x=1',
        headers: { host: OLD_HOST },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(`${CANONICAL}/dashboard/U123?session=abc%2Fdef&x=1`);
    });

    it('redirects an old-host HEAD as well', async () => {
      const web = await start(CANONICAL);

      const response = await web.injectWebServer({
        method: 'HEAD',
        url: '/dashboard',
        headers: { host: OLD_HOST },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(`${CANONICAL}/dashboard`);
    });

    it('uses the viewerUrl origin even when viewerUrl has a trailing slash', async () => {
      const web = await start(`${CANONICAL}/`);

      const response = await web.injectWebServer({
        method: 'GET',
        url: '/conversations',
        headers: { host: OLD_HOST },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(`${CANONICAL}/conversations`);
    });

    it('passes a request arriving through the proxy (Host = viewerUrl host)', async () => {
      const web = await start(CANONICAL);

      const response = await web.injectWebServer({
        method: 'GET',
        url: '/api/conversations',
        headers: { host: PROXY_HOST, 'x-forwarded-host': PROXY_HOST, 'x-forwarded-proto': 'https' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
    });

    it('compares the proxy host case-insensitively', async () => {
      const web = await start(CANONICAL);

      const response = await web.injectWebServer({
        method: 'GET',
        url: '/api/conversations',
        headers: { host: 'BOT.Example.TS.net:8443' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('treats an explicit :443 and an omitted port as the same https host', async () => {
      const web = await start('https://bot.example.ts.net');

      for (const host of ['bot.example.ts.net', 'bot.example.ts.net:443']) {
        const response = await web.injectWebServer({
          method: 'GET',
          url: '/api/conversations',
          headers: { host },
        });
        expect(response.statusCode, host).toBe(200);
      }

      const wrongPort = await web.injectWebServer({
        method: 'GET',
        url: '/api/conversations',
        headers: { host: 'bot.example.ts.net:33000' },
      });
      expect(wrongPort.statusCode).toBe(302);
      expect(wrongPort.headers.location).toBe('https://bot.example.ts.net/api/conversations');
    });

    it.each([
      '127.0.0.1',
      '127.0.0.1:33000',
      'localhost',
      'localhost:3000',
      'LOCALHOST:3000',
      '[::1]',
      '[::1]:33000',
    ])('passes a loopback Host (%s)', async (host) => {
      const web = await start(CANONICAL);

      const response = await web.injectWebServer({
        method: 'GET',
        url: '/api/conversations',
        headers: { host },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
    });

    it('passes /health from any host', async () => {
      const web = await start(CANONICAL);

      const response = await web.injectWebServer({
        method: 'GET',
        url: '/health',
        headers: { host: OLD_HOST },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe('ok');
    });

    it('does not redirect a POST on the wrong origin (existing behaviour stays)', async () => {
      const web = await start(CANONICAL);

      const response = await web.injectWebServer({
        method: 'POST',
        url: '/api/conversations/missing/export',
        headers: { host: OLD_HOST, 'content-type': 'application/json' },
        payload: { turnIds: [] },
      });

      // Same answer as without the redirect: no such conversation.
      expect(response.statusCode).toBe(404);
      expect(response.headers.location).toBeUndefined();
    });

    it('does not redirect a WebSocket upgrade on the wrong origin', async () => {
      const web = await start(CANONICAL);

      // injectWS hands headers to the route as-is, so the key must be lowercase
      // for request.headers.host to see it.
      const ws = await web.injectWebServerWS('/ws/dashboard', { headers: { host: OLD_HOST } });
      ws.terminate();
    });
  });

  describe('when viewerUrl is not a usable https URL', () => {
    it.each([
      ['empty', ''],
      ['http', 'http://bot.example.ts.net:8080'],
      ['unparseable', 'https://'],
    ])('does not redirect an old-host GET (%s viewerUrl)', async (_label, viewerUrl) => {
      const web = await start(viewerUrl);

      const response = await web.injectWebServer({
        method: 'GET',
        url: '/api/conversations',
        headers: { host: OLD_HOST },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
    });
  });
});
