/**
 * Public URL self-check (T1).
 *
 * Every Slack link the bot hands out (thread header `📋 작업 로그`, the
 * `dashboard` sign-in link, conversation links) is built on
 * CONVERSATION_VIEWER_URL. When that name's DNS points at somebody else's
 * server, every link is dead and nothing notices. The instance probes its own
 * public URL; when another server demonstrably answers there and the
 * operator's callback origin demonstrably reaches this instance, links move to
 * the callback origin until the public URL is fixed.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logError, logInfo, logWarn } = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../logger', () => ({
  Logger: class {
    info = logInfo;
    warn = logWarn;
    debug = vi.fn();
    error = logError;
  },
}));

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: '',
    instanceName: 'public-url-test',
    publicUrlFallback: true,
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: 604800,
    callbackBaseUrl: '',
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  DATA_DIR: path.join(os.tmpdir(), 'public-url-test-data'),
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

type PublicUrl = typeof import('../public-url');
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: http.Server[] = [];

/** A throwaway HTTP server on 127.0.0.1; resolves its origin. */
async function serve(handler: Handler): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** What the hosting provider answered for the dead public URL. */
const foreignNotFound: Handler = (_req, res) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', server: 'hosting-provider' });
  res.end('The deployment could not be found.\n\nDEPLOYMENT_NOT_FOUND\n');
};

/** A port nothing listens on right now. */
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

let pub: PublicUrl;

beforeEach(async () => {
  vi.resetModules();
  logError.mockClear();
  logInfo.mockClear();
  logWarn.mockClear();
  mockConfig.conversation.viewerUrl = '';
  mockConfig.conversation.publicUrlFallback = true;
  mockConfig.oauth.callbackBaseUrl = '';
  pub = await import('../public-url');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

/** This process answering as itself. */
function self(): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', [pub.INSTANCE_HEADER]: pub.getInstanceId() });
    res.end(JSON.stringify({ status: 'ok', service: 'conversation-viewer' }));
  };
}

describe('probeOrigin — who answers at an origin', () => {
  it('this instance (its own id in the header) → verified', async () => {
    const origin = await serve(self());
    expect((await pub.probeOrigin(origin)).result).toBe('verified');
  });

  it('a hosting provider 404 with no instance header → mismatch (the incident)', async () => {
    const origin = await serve(foreignNotFound);
    const probe = await pub.probeOrigin(origin);
    expect(probe.result).toBe('mismatch');
    expect(probe.detail).toContain('404');
  });

  it('another soma-work instance (a different id) → mismatch', async () => {
    const origin = await serve((_req, res) => {
      res.writeHead(200, { [pub.INSTANCE_HEADER]: 'someone-else' });
      res.end('{"status":"ok","service":"conversation-viewer"}');
    });
    expect((await pub.probeOrigin(origin)).result).toBe('mismatch');
  });

  it('our /health body without the header (a proxy dropped it) → inconclusive', async () => {
    const origin = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok","service":"conversation-viewer"}');
    });
    expect((await pub.probeOrigin(origin)).result).toBe('inconclusive');
  });

  it.each([401, 403, 407])('an access gate (%i) → inconclusive', async (status) => {
    const origin = await serve((_req, res) => {
      res.writeHead(status);
      res.end('sign in first');
    });
    expect((await pub.probeOrigin(origin)).result).toBe('inconclusive');
  });

  it.each([502, 503, 504])('a proxy whose upstream is down (%i) → inconclusive', async (status) => {
    const origin = await serve((_req, res) => {
      res.writeHead(status);
      res.end('bad gateway');
    });
    expect((await pub.probeOrigin(origin)).result).toBe('inconclusive');
  });

  it('a redirect to another host (an SSO front door) → inconclusive, not followed', async () => {
    let followed = false;
    const elsewhere = await serve((_req, res) => {
      followed = true;
      res.writeHead(200);
      res.end('login');
    });
    const origin = await serve((_req, res) => {
      res.writeHead(302, { location: `${elsewhere.replace('127.0.0.1', 'localhost')}/login` });
      res.end();
    });
    expect((await pub.probeOrigin(origin)).result).toBe('inconclusive');
    expect(followed).toBe(false);
  });

  it('a redirect that keeps the host and the /health path (an http → https style upgrade) is followed', async () => {
    const target = await serve(self());
    const targetPort = new URL(target).port;
    const origin = await serve((_req, res) => {
      res.writeHead(308, { location: `http://127.0.0.1:${targetPort}/health` });
      res.end();
    });
    expect((await pub.probeOrigin(origin)).result).toBe('verified');
  });

  it('a same-host redirect to another path (a sign-in page) → inconclusive, not followed', async () => {
    let followed = false;
    const origin = await serve((req, res) => {
      if (req.url === '/health') {
        res.writeHead(302, { location: '/sign-in?rd=%2Fhealth' });
        res.end();
        return;
      }
      followed = true;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<form>sign in</form>');
    });
    expect((await pub.probeOrigin(origin)).result).toBe('inconclusive');
    expect(followed).toBe(false);
  });

  it('a body cut off mid-read (connection reset) → inconclusive, not another server', async () => {
    const origin = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"status":"ok","serv');
      setTimeout(() => res.destroy(), 20);
    });
    expect((await pub.probeOrigin(origin)).result).toBe('inconclusive');
  });

  it('reads only a few KB of a foreign body, then hangs up (memory stays bounded)', async () => {
    let sent = 0;
    let closed = false;
    const origin = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      const chunk = Buffer.alloc(16 * 1024, 'x');
      const pump = () => {
        if (closed || sent >= 8 * 1024 * 1024) {
          res.end();
          return;
        }
        sent += chunk.length;
        if (res.write(chunk)) setImmediate(pump);
        else res.once('drain', pump);
      };
      res.on('close', () => {
        closed = true;
      });
      pump();
    });
    const probe = await pub.probeOrigin(origin);
    expect(probe.result).toBe('mismatch');
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(sent).toBeLessThan(2 * 1024 * 1024);
  });

  it('a name that does not resolve → inconclusive (split-horizon DNS may still serve users)', async () => {
    expect((await pub.probeOrigin('http://soma-public-url-test.invalid')).result).toBe('inconclusive');
  });

  it('no answer within the timeout → inconclusive', async () => {
    const origin = await serve(() => {
      /* never answers */
    });
    const probe = await pub.probeOrigin(origin, { timeoutMs: 200 });
    expect(probe.result).toBe('inconclusive');
  });
});

describe('checkPublicUrl — which origin links use', () => {
  it('unchecked → links use the configured URL', () => {
    mockConfig.conversation.viewerUrl = 'https://agent.example.com';
    expect(pub.effectiveViewerUrl()).toBe('https://agent.example.com');
  });

  it('configured URL answered by another server + callback origin reaches us → links use the callback origin', async () => {
    mockConfig.conversation.viewerUrl = await serve(foreignNotFound);
    mockConfig.oauth.callbackBaseUrl = `${await serve(self())}/`;

    await pub.checkPublicUrl();

    expect(pub.effectiveViewerUrl()).toBe(mockConfig.oauth.callbackBaseUrl.replace(/\/+$/, ''));
    expect(pub.getPublicUrlStatus()).toBe('mismatch');
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0][0])).toContain(mockConfig.conversation.viewerUrl);
  });

  it('SOMA_PUBLIC_URL_FALLBACK off (the default): detected and logged, links stay on the configured URL', async () => {
    mockConfig.conversation.publicUrlFallback = false;
    mockConfig.conversation.viewerUrl = await serve(foreignNotFound);
    mockConfig.oauth.callbackBaseUrl = await serve(self());

    await pub.checkPublicUrl();

    expect(pub.getPublicUrlStatus()).toBe('mismatch');
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.conversation.viewerUrl);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0][0])).toContain('SOMA_PUBLIC_URL_FALLBACK');
  });

  it('configured URL answered by another server, no proven alternative → keeps the configured URL', async () => {
    mockConfig.conversation.viewerUrl = await serve(foreignNotFound);
    mockConfig.oauth.callbackBaseUrl = await serve(foreignNotFound);

    await pub.checkPublicUrl();

    expect(pub.effectiveViewerUrl()).toBe(mockConfig.conversation.viewerUrl);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('configured URL answered by another server, no callback origin configured → keeps the configured URL', async () => {
    mockConfig.conversation.viewerUrl = await serve(foreignNotFound);
    await pub.checkPublicUrl();
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.conversation.viewerUrl);
  });

  it('the public URL starts reaching us again → links go back to it', async () => {
    let fixed = false;
    mockConfig.conversation.viewerUrl = await serve((req, res) =>
      fixed ? self()(req, res) : foreignNotFound(req, res),
    );
    mockConfig.oauth.callbackBaseUrl = await serve(self());

    await pub.checkPublicUrl();
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.oauth.callbackBaseUrl);

    fixed = true;
    await pub.checkPublicUrl();
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.conversation.viewerUrl);
    expect(pub.getPublicUrlStatus()).toBe('verified');
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('reaches this instance again'));
  });

  it('an inconclusive callback probe keeps an established fallback', async () => {
    let callbackDown = false;
    mockConfig.conversation.viewerUrl = await serve(foreignNotFound);
    mockConfig.oauth.callbackBaseUrl = await serve((req, res) => {
      if (callbackDown) {
        res.writeHead(503);
        res.end('upstream down');
        return;
      }
      self()(req, res);
    });

    await pub.checkPublicUrl();
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.oauth.callbackBaseUrl);

    callbackDown = true;
    await pub.checkPublicUrl();
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.oauth.callbackBaseUrl);
  });

  it('a callback origin proven to be another server drops the fallback', async () => {
    let callbackForeign = false;
    mockConfig.conversation.viewerUrl = await serve(foreignNotFound);
    mockConfig.oauth.callbackBaseUrl = await serve((req, res) =>
      callbackForeign ? foreignNotFound(req, res) : self()(req, res),
    );

    await pub.checkPublicUrl();
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.oauth.callbackBaseUrl);

    callbackForeign = true;
    await pub.checkPublicUrl();
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.conversation.viewerUrl);
  });

  it('an inconclusive probe keeps the previous decision (no flapping)', async () => {
    let down = false;
    mockConfig.conversation.viewerUrl = await serve((req, res) => {
      if (down) {
        res.writeHead(503);
        res.end('{"status":"ok","service":"conversation-viewer"}');
        return;
      }
      foreignNotFound(req, res);
    });
    mockConfig.oauth.callbackBaseUrl = await serve(self());

    await pub.checkPublicUrl();
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.oauth.callbackBaseUrl);

    down = true;
    await pub.checkPublicUrl();
    expect(pub.effectiveViewerUrl()).toBe(mockConfig.oauth.callbackBaseUrl);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('no configured URL → nothing to check, no request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await pub.checkPublicUrl();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pub.effectiveViewerUrl()).toBe('');
  });
});

describe('the running viewer follows the check (T1 end to end)', () => {
  let web: typeof import('../web-server');
  let instanceDir: string;
  const previousInstanceDir = process.env.SOMA_INSTANCE_DIR;

  beforeEach(async () => {
    instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-url-instances-'));
    process.env.SOMA_INSTANCE_DIR = instanceDir;
    mockConfig.conversation.viewerPort = await freePort();
    web = await import('../web-server');
    pub = await import('../public-url');
  });

  afterEach(async () => {
    await web.stopWebServer();
    if (previousInstanceDir === undefined) delete process.env.SOMA_INSTANCE_DIR;
    else process.env.SOMA_INSTANCE_DIR = previousInstanceDir;
    fs.rmSync(instanceDir, { recursive: true, force: true });
  });

  it('/health names this instance in the header and reports the check, never the id in the body', async () => {
    await web.startWebServer({ listen: false });
    const res = await web.injectWebServer({ method: 'GET', url: '/health' });
    expect(res.headers[pub.INSTANCE_HEADER]).toBe(pub.getInstanceId());
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', service: 'conversation-viewer', publicUrl: 'unchecked' });
  });

  it('a dead public URL: the 📋 link and the dashboard link move to the callback origin that reaches us', async () => {
    const own = `http://127.0.0.1:${mockConfig.conversation.viewerPort}`;
    mockConfig.conversation.viewerUrl = await serve(foreignNotFound);
    mockConfig.oauth.callbackBaseUrl = own;

    await web.startWebServer();
    expect(web.getDashboardSessionUrl('U1', 'k')).toBe(`${mockConfig.conversation.viewerUrl}/dashboard/U1?session=k`);

    await pub.checkPublicUrl();

    expect(web.getDashboardSessionUrl('U1', 'k')).toBe(`${own}/dashboard/U1?session=k`);
    expect(web.getViewerBaseUrl()).toBe(own);
    expect(web.getConversationUrl('c1')).toBe(`${own}/conversations/c1`);
  });

  it('an https callback origin takes over the redirect of old http links (Secure cookies need https)', async () => {
    const CALLBACK = 'https://old-host.example.net:33443';
    mockConfig.conversation.viewerUrl = 'https://agent.example.com';
    mockConfig.oauth.callbackBaseUrl = CALLBACK;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith(CALLBACK)
          ? new Response('{}', { status: 200, headers: { [pub.INSTANCE_HEADER]: pub.getInstanceId() } })
          : new Response('DEPLOYMENT_NOT_FOUND', { status: 404 }),
      ),
    );
    await web.startWebServer({ listen: false });

    // Before the check: the configured public URL is still the redirect target.
    const before = await web.injectWebServer({ method: 'GET', url: '/dashboard', headers: { host: 'lan-host:33000' } });
    expect(before.headers.location).toBe('https://agent.example.com/dashboard');

    await pub.checkPublicUrl();

    const old = await web.injectWebServer({
      method: 'GET',
      url: '/dashboard?x=1',
      headers: { host: 'lan-host:33000' },
    });
    expect(old.statusCode).toBe(302);
    expect(old.headers.location).toBe(`${CALLBACK}/dashboard?x=1`);
    const onCallback = await web.injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: { host: 'old-host.example.net:33443' },
    });
    expect(String(onCallback.headers.location ?? '')).not.toContain('agent.example.com');
    expect(onCallback.headers.location).not.toBe(`${CALLBACK}/dashboard`);
  });

  // The provider returns to SOMA_OAUTH_CALLBACK_BASE_URL — the same origin the
  // fallback uses — so the state cookie set when sign-in starts there is sent
  // back with the callback, and no canonical redirect moves it to another origin.
  it('Google sign-in started on the https fallback origin completes there (state cookie survives)', async () => {
    const CALLBACK = 'https://old-host.example.net:33443';
    const HOST = 'old-host.example.net:33443';
    mockConfig.conversation.viewerUrl = 'https://agent.example.com';
    mockConfig.oauth.callbackBaseUrl = CALLBACK;
    mockConfig.oauth.google = { clientId: 'cid', clientSecret: 'csecret' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith(CALLBACK)) {
          return new Response('{}', { status: 200, headers: { [pub.INSTANCE_HEADER]: pub.getInstanceId() } });
        }
        if (u.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
        if (u.includes('googleapis.com/oauth2')) {
          return Response.json({ email: 'dana@x.com', name: 'Dana', verified_email: true });
        }
        return new Response('DEPLOYMENT_NOT_FOUND', { status: 404 });
      }),
    );
    try {
      await web.startWebServer({ listen: false });
      const oauth = await import('../oauth');
      oauth.setOAuthUserLookup(() => ({ kind: 'match', userId: 'U_D', name: 'Dana' }));
      await pub.checkPublicUrl();
      expect(pub.effectiveViewerUrl()).toBe(CALLBACK);

      const start = await web.injectWebServer({ method: 'GET', url: '/auth/google', headers: { host: HOST } });
      expect(start.statusCode).toBe(302);
      const authorize = new URL(String(start.headers.location));
      expect(authorize.searchParams.get('redirect_uri')).toBe(`${CALLBACK}/auth/google/callback`);
      const state = authorize.searchParams.get('state') ?? '';
      const stateCookie = [start.headers['set-cookie']]
        .flat()
        .map(String)
        .find((c) => c.startsWith('soma_oauth_state_google='));
      expect(stateCookie).toContain('Secure');

      const back = await web.injectWebServer({
        method: 'GET',
        url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
        headers: { host: HOST, cookie: String(stateCookie).split(';')[0] },
      });
      expect(back.headers.location).toBe('/dashboard/U_D');
      expect([back.headers['set-cookie']].flat().join(';')).toContain('soma_dash_token=');
    } finally {
      mockConfig.oauth.google = { clientId: '', clientSecret: '' };
    }
  });

  // Sign-in started on the fallback origin; before the provider returns, the
  // public URL is fixed and links move back. The callback carries the state
  // cookie of the origin it started on, so it must finish there.
  it('a sign-in in flight when the public URL recovers still completes on the origin it started on', async () => {
    const CALLBACK = 'https://old-host.example.net:33443';
    const HOST = 'old-host.example.net:33443';
    let primaryFixed = false;
    mockConfig.conversation.viewerUrl = 'https://agent.example.com';
    mockConfig.oauth.callbackBaseUrl = CALLBACK;
    mockConfig.oauth.google = { clientId: 'cid', clientSecret: 'csecret' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        const ours = () => new Response('{}', { status: 200, headers: { [pub.INSTANCE_HEADER]: pub.getInstanceId() } });
        if (u.startsWith(CALLBACK)) return ours();
        if (u.startsWith('https://agent.example.com')) {
          return primaryFixed ? ours() : new Response('DEPLOYMENT_NOT_FOUND', { status: 404 });
        }
        if (u.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
        if (u.includes('googleapis.com/oauth2')) {
          return Response.json({ email: 'dana@x.com', name: 'Dana', verified_email: true });
        }
        return new Response('nope', { status: 404 });
      }),
    );
    try {
      await web.startWebServer({ listen: false });
      const oauth = await import('../oauth');
      oauth.setOAuthUserLookup(() => ({ kind: 'match', userId: 'U_D', name: 'Dana' }));
      await pub.checkPublicUrl();
      expect(pub.effectiveViewerUrl()).toBe(CALLBACK);

      const start = await web.injectWebServer({ method: 'GET', url: '/auth/google', headers: { host: HOST } });
      const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
      const stateCookie = [start.headers['set-cookie']]
        .flat()
        .map(String)
        .find((c) => c.startsWith('soma_oauth_state_google='));

      primaryFixed = true;
      await pub.checkPublicUrl();
      expect(pub.effectiveViewerUrl()).toBe('https://agent.example.com');

      const back = await web.injectWebServer({
        method: 'GET',
        url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
        headers: { host: HOST, cookie: String(stateCookie).split(';')[0] },
      });
      expect(back.headers.location).toBe('/dashboard/U_D');

      // Without the state cookie the callback still goes to the public URL (unchanged).
      const fresh = await web.injectWebServer({
        method: 'GET',
        url: '/auth/google/callback?code=c&state=x',
        headers: { host: HOST },
      });
      expect(fresh.headers.location).toBe('https://agent.example.com/auth/google/callback?code=c&state=x');
    } finally {
      mockConfig.oauth.google = { clientId: '', clientSecret: '' };
    }
  });

  describe('sign-in on the callback origin while the https public URL is dead', () => {
    const DEAD = 'https://agent.example.com';
    const CALLBACK = 'http://old-host.example.net:33443';

    beforeEach(async () => {
      mockConfig.conversation.viewerUrl = DEAD;
      mockConfig.oauth.callbackBaseUrl = CALLBACK;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).startsWith(CALLBACK)
            ? new Response('{}', { status: 200, headers: { [pub.INSTANCE_HEADER]: pub.getInstanceId() } })
            : new Response('DEPLOYMENT_NOT_FOUND', { status: 404 }),
        ),
      );
      await web.startWebServer({ listen: false });
      await pub.checkPublicUrl();
    });

    it('a browser on the callback origin is not bounced to the dead public URL', async () => {
      const res = await web.injectWebServer({
        method: 'GET',
        url: '/dashboard',
        headers: { host: 'old-host.example.net:33443' },
      });
      expect(String(res.headers.location ?? '')).not.toContain('agent.example.com');
    });

    it('the Slack sign-in confirm from the callback origin is same-origin, and its cookie fits http', async () => {
      const { issueSlackToken } = await import('../oauth');
      const exchange = issueSlackToken({ slackUserId: 'UC', email: 'c@x', name: 'Carol' });
      const res = await web.injectWebServer({
        method: 'POST',
        url: '/auth/sso/confirm',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: CALLBACK },
        payload: `token=${encodeURIComponent(exchange)}`,
      });
      expect(res.statusCode).toBe(303);
      const cookie = [res.headers['set-cookie']].flat().join(';');
      expect(cookie).toContain('soma_dash_token=');
      expect(cookie).not.toContain('Secure');
    });
  });
});
