import type { AddressInfo } from 'node:net';
import * as net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The server instance is module-private; record each one web-server creates so
// raw-socket tests can listen on it. The instance itself is the real Fastify.
const fastifyInstances: FastifyInstance[] = [];

vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>();
  const createFastify = actual.default as unknown as (...args: unknown[]) => FastifyInstance;
  const recording = (...args: unknown[]) => {
    const instance = createFastify(...args);
    fastifyInstances.push(instance);
    return instance;
  };
  return { ...actual, default: Object.assign(recording, actual.default) };
});

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

  /**
   * Listen on an ephemeral loopback port and send `request` as raw bytes, so
   * the request-target and headers reach Node's parser exactly as written.
   * `inject` cannot do this: light-my-request rebuilds the URL through WHATWG
   * parsing (`//x/y` and `/\x` lose their host part) and always sets Host.
   */
  async function sendRaw(request: string): Promise<{ status: number; headers: Record<string, string> }> {
    const instance = fastifyInstances[fastifyInstances.length - 1];
    if (!instance) throw new Error('no Fastify instance recorded');
    if (!instance.server.listening) await instance.listen({ port: 0, host: '127.0.0.1' });
    const { port } = instance.server.address() as AddressInfo;

    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let raw = '';
      socket.setEncoding('latin1');
      socket.setTimeout(5000, () => socket.destroy(new Error('raw request timed out')));
      socket.on('data', (chunk: string) => {
        raw += chunk;
      });
      socket.on('error', reject);
      socket.on('close', () => {
        const [statusLine = '', ...lines] = raw.split('\r\n\r\n')[0].split('\r\n');
        const headers: Record<string, string> = {};
        for (const line of lines) {
          const colon = line.indexOf(':');
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        resolve({ status: Number(statusLine.split(' ')[1]), headers });
      });
      socket.write(request);
    });
  }

  const rawGet = (target: string, host = OLD_HOST) =>
    `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;

  /** A redirect may only ever point at the configured origin. */
  function expectCanonicalLocation(location: string | undefined) {
    expect(location).toBeDefined();
    expect(new URL(location as string).origin).toBe(CANONICAL);
  }

  beforeEach(() => {
    vi.resetModules();
    fastifyInstances.length = 0;
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

  describe('adversarial inputs never redirect off the configured origin', () => {
    // Raw bytes: these request-targets do not survive inject's URL rebuild.
    it.each([
      ['protocol-relative', '//evil.example/path'],
      ['backslash', '/\\evil.example'],
      ['double backslash', '/\\\\evil.example'],
      ['backslash then slash', '/\\/evil.example'],
      ['encoded slashes', '/%2F%2Fevil.example'],
      ['userinfo-looking path', '/@evil.example'],
    ])('keeps the %s request-target on the configured origin (%s)', async (_label, target) => {
      await start(CANONICAL);

      const response = await sendRaw(rawGet(target));

      expect(response.status).toBe(302);
      expectCanonicalLocation(response.headers.location);
      expect(response.headers.location).toBe(`${CANONICAL}${target}`);
    });

    it.each([
      'evil.example',
      'evil.example:443',
      'bot.example.ts.net.evil.example',
    ])('redirects a foreign Host (%s) to the configured origin, not to that Host', async (host) => {
      const web = await start(CANONICAL);

      const response = await web.injectWebServer({ method: 'GET', url: '/dashboard', headers: { host } });

      expect(response.statusCode).toBe(302);
      expectCanonicalLocation(response.headers.location as string);
    });

    it('passes a mixed-case spelling of the real host without a redirect', async () => {
      const web = await start(CANONICAL);

      // Current behaviour: Host is compared case-insensitively, so this is the
      // proxy host and passes through.
      const response = await web.injectWebServer({
        method: 'GET',
        url: '/api/conversations',
        headers: { host: 'Bot.EXAMPLE.ts.NET:8443' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
    });

    it('redirects a trailing-dot spelling of the real host to the configured origin', async () => {
      const web = await start(CANONICAL);

      // Current behaviour: `bot.example.ts.net.` is not string-equal to the
      // viewerUrl host, so it is redirected — to the configured origin, whose
      // Host then matches and passes (no loop).
      const response = await web.injectWebServer({
        method: 'GET',
        url: '/dashboard?session=s1',
        headers: { host: 'bot.example.ts.net.:8443' },
      });

      expect(response.statusCode).toBe(302);
      expectCanonicalLocation(response.headers.location as string);
      expect(response.headers.location).toBe(`${CANONICAL}/dashboard?session=s1`);
    });

    it('does not redirect a request with no Host header (HTTP/1.0)', async () => {
      await start(CANONICAL);

      // HTTP/1.1 requires Host (Node answers 400 itself); HTTP/1.0 does not,
      // so this reaches the hook with request.headers.host undefined.
      const response = await sendRaw('GET /api/conversations HTTP/1.0\r\n\r\n');

      expect(response.status).toBe(200);
      expect(response.headers.location).toBeUndefined();
    });

    it('does not redirect an absolute-form request-target', async () => {
      await start(CANONICAL);

      // request.url is `http://evil.example/api/conversations` here; appending
      // it to the origin would not be a URL on that origin, so it is left alone
      // and the router serves the path part as it does today.
      const response = await sendRaw(rawGet('http://evil.example/api/conversations'));

      expect(response.headers.location).toBeUndefined();
      expect(response.status).toBe(200);
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
