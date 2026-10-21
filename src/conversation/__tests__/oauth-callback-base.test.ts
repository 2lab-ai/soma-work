/**
 * Moving the dashboard to a new public URL must not break OAuth sign-in while
 * the provider console still lists only the old callback. With
 * SOMA_OAUTH_CALLBACK_BASE_URL set to the old (registered) origin, the provider
 * sends the browser back there, the canonical-origin redirect forwards the
 * callback — code and state intact — to the public URL, and the server
 * exchanges the code with the same registered redirect_uri.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: 'https://agent.example.com',
    viewerToken: '',
  },
  oauth: {
    google: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: 604800,
    callbackBaseUrl: '',
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

const OLD = 'https://old-host.example.net:33443';

describe('OAuth callback base URL', () => {
  let injectWebServer: any;
  let stopWebServer: any;

  beforeEach(async () => {
    vi.resetModules();
    const ws = await import('../web-server');
    injectWebServer = ws.injectWebServer;
    stopWebServer = ws.stopWebServer;
  });

  afterEach(async () => {
    await stopWebServer();
    mockConfig.oauth.callbackBaseUrl = '';
    vi.unstubAllGlobals();
  });

  const start = async () => {
    const { startWebServer } = await import('../web-server');
    await startWebServer({ listen: false });
    const res = await injectWebServer({ method: 'GET', url: '/auth/google', headers: { host: 'agent.example.com' } });
    expect(res.statusCode).toBe(302);
    return new URL(res.headers.location as string);
  };

  it('defaults to the public URL', async () => {
    const auth = await start();
    expect(auth.searchParams.get('redirect_uri')).toBe('https://agent.example.com/auth/google/callback');
  });

  it('uses SOMA_OAUTH_CALLBACK_BASE_URL for the provider redirect when set (trailing slash ignored)', async () => {
    mockConfig.oauth.callbackBaseUrl = `${OLD}/`;
    const auth = await start();
    expect(auth.searchParams.get('redirect_uri')).toBe(`${OLD}/auth/google/callback`);
  });

  it('the callback reaching the old host is forwarded to the public URL with code and state', async () => {
    mockConfig.oauth.callbackBaseUrl = OLD;
    const { startWebServer } = await import('../web-server');
    await startWebServer({ listen: false });
    const res = await injectWebServer({
      method: 'GET',
      url: '/auth/google/callback?code=abc&state=xyz',
      headers: { host: 'old-host.example.net:33443' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://agent.example.com/auth/google/callback?code=abc&state=xyz');
  });

  it('the code exchange sends the same registered redirect_uri', async () => {
    mockConfig.oauth.callbackBaseUrl = OLD;
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: unknown }) => {
        calls.push({ url: String(url), body: String(init?.body ?? '') });
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } as unknown as Response;
      }),
    );
    const auth = await start();
    const state = auth.searchParams.get('state') as string;
    const cookie = 'soma_oauth_state_google=' + encodeURIComponent(state);
    await injectWebServer({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: { host: 'agent.example.com', cookie },
    });
    const tokenCall = calls.find((c) => c.url.includes('oauth2.googleapis.com/token'));
    expect(tokenCall).toBeDefined();
    expect(new URLSearchParams(tokenCall?.body).get('redirect_uri')).toBe(`${OLD}/auth/google/callback`);
  });
});
