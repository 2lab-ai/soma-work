import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import * as jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logInfo, logWarn } = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

vi.mock('../../logger', () => ({
  Logger: class {
    info = logInfo;
    warn = logWarn;
    debug = vi.fn();
    error = vi.fn();
  },
}));

const mockConfig = {
  conversation: {
    viewerUrl: 'http://localhost:3000',
    viewerPort: 3000,
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));

describe('OAuth module', () => {
  let verifyDashboardToken: typeof import('../oauth').verifyDashboardToken;
  let getDashboardUser: typeof import('../oauth').getDashboardUser;
  let setOAuthUserLookup: typeof import('../oauth').setOAuthUserLookup;

  beforeEach(async () => {
    vi.resetModules();
    const oauth = await import('../oauth');
    verifyDashboardToken = oauth.verifyDashboardToken;
    getDashboardUser = oauth.getDashboardUser;
    setOAuthUserLookup = oauth.setOAuthUserLookup;
  });

  describe('verifyDashboardToken', () => {
    it('should verify a valid JWT', () => {
      const token = jwt.sign(
        { sub: 'U123', email: 'alice@test.com', name: 'Alice', provider: 'google' },
        'test-jwt-secret',
        { expiresIn: 3600 },
      );

      const user = verifyDashboardToken(token);
      expect(user).not.toBeNull();
      expect(user!.slackUserId).toBe('U123');
      expect(user!.email).toBe('alice@test.com');
      expect(user!.name).toBe('Alice');
      expect(user!.provider).toBe('google');
    });

    it('should return null for invalid JWT', () => {
      expect(verifyDashboardToken('invalid-token')).toBeNull();
    });

    it('should return null for expired JWT', () => {
      const token = jwt.sign(
        { sub: 'U123', email: 'alice@test.com', name: 'Alice', provider: 'google' },
        'test-jwt-secret',
        { expiresIn: -10 }, // already expired
      );

      expect(verifyDashboardToken(token)).toBeNull();
    });

    it('should return null for wrong secret', () => {
      const token = jwt.sign(
        { sub: 'U123', email: 'alice@test.com', name: 'Alice', provider: 'google' },
        'wrong-secret',
      );

      expect(verifyDashboardToken(token)).toBeNull();
    });
  });

  describe('getDashboardUser', () => {
    it('should extract user from cookie header', () => {
      const token = jwt.sign(
        { sub: 'U456', email: 'bob@test.com', name: 'Bob', provider: 'microsoft' },
        'test-jwt-secret',
        { expiresIn: 3600 },
      );

      const mockRequest = {
        headers: {
          cookie: `soma_dash_token=${encodeURIComponent(token)}; other=value`,
        },
      } as any;

      const user = getDashboardUser(mockRequest);
      expect(user).not.toBeNull();
      expect(user!.slackUserId).toBe('U456');
      expect(user!.provider).toBe('microsoft');
    });

    it('should return null when no cookie', () => {
      const mockRequest = { headers: {} } as any;
      expect(getDashboardUser(mockRequest)).toBeNull();
    });

    it('should return null when cookie has no soma_dash_token', () => {
      const mockRequest = { headers: { cookie: 'other=value' } } as any;
      expect(getDashboardUser(mockRequest)).toBeNull();
    });

    it('should return null when cookie has invalid JWT', () => {
      const mockRequest = {
        headers: { cookie: 'soma_dash_token=bad-jwt-token' },
      } as any;
      expect(getDashboardUser(mockRequest)).toBeNull();
    });
  });

  describe('setOAuthUserLookup', () => {
    it('should register and use lookup function', () => {
      // This tests the lookup registration — actual matching is done in index.ts
      // Just verify the function can be called without error
      setOAuthUserLookup((email: string) => {
        if (email === 'alice@test.com') return { kind: 'match', userId: 'U123', name: 'Alice' };
        return { kind: 'none' };
      });
      // No assertion needed — just verifying no throw
    });
  });

  describe('issueSlackToken (#704)', () => {
    it('is an exchange token — verifyDashboardToken REJECTS it', async () => {
      // Exchange tokens carry type='sso_exchange' and must not be usable
      // as session cookies directly. verifyDashboardToken returns null.
      const { issueSlackToken } = await import('../oauth');
      const token = issueSlackToken({
        slackUserId: 'U789',
        email: 'carol@slack.local',
        name: 'Carol',
      });
      expect(verifyDashboardToken(token)).toBeNull();
    });

    it('is decodable by verifySsoExchangeToken with jti+sub+provider', async () => {
      const oauth = await import('../oauth');
      const token = oauth.issueSlackToken({ slackUserId: 'U1', email: 'e@x', name: 'N' });
      const payload = oauth.verifySsoExchangeToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe('U1');
      expect(payload!.provider).toBe('slack');
      expect(payload!.type).toBe('sso_exchange');
      expect(payload!.jti).toMatch(/^[0-9a-f]{32}$/);
      expect(payload!.exp).toBeTypeOf('number');
    });

    it('has short TTL (~SSO_EXCHANGE_EXPIRES_IN_SEC seconds)', async () => {
      const oauth = await import('../oauth');
      const before = Math.floor(Date.now() / 1000);
      const token = oauth.issueSlackToken({ slackUserId: 'U1', email: 'e@x', name: 'N' });
      const payload = oauth.verifySsoExchangeToken(token)!;
      const ttl = payload.exp - before;
      // Allow a few seconds of slack either way for test-runner pauses.
      expect(ttl).toBeGreaterThan(oauth.SSO_EXCHANGE_EXPIRES_IN_SEC - 5);
      expect(ttl).toBeLessThanOrEqual(oauth.SSO_EXCHANGE_EXPIRES_IN_SEC + 1);
    });

    it('verifySsoExchangeToken rejects a session token (wrong type)', async () => {
      const oauth = await import('../oauth');
      // Manually sign a token WITHOUT type='sso_exchange' — mimics a
      // stolen session cookie being replayed as an SSO URL.
      const fakeSession = jwt.sign(
        { sub: 'U1', email: 'e@x', name: 'N', provider: 'slack', jti: 'abcd' },
        'test-jwt-secret',
        { expiresIn: 3600 },
      );
      expect(oauth.verifySsoExchangeToken(fakeSession)).toBeNull();
    });

    it('verifyDashboardToken rejects a token with type=sso_exchange', async () => {
      // Attacker tries to stuff an exchange token into the cookie jar,
      // bypassing /auth/sso. buildAuthContext calls verifyDashboardToken /
      // verifyDashboardTokenRaw — both must refuse.
      const oauth = await import('../oauth');
      const token = oauth.issueSlackToken({ slackUserId: 'U1', email: 'e@x', name: 'N' });
      expect(verifyDashboardToken(token)).toBeNull();
      expect(oauth.verifyDashboardTokenRaw(token)).toBeNull();
    });
  });

  // A Google or Microsoft login is only issued for an email that is verified
  // by Google and registered by exactly one Slack user (`/z email`).
  describe('OAuth callback email match', () => {
    let server: FastifyInstance | undefined;
    let oauthModule: typeof import('../oauth') | undefined;

    async function startServer(provider: 'google' | 'microsoft'): Promise<typeof import('../oauth')> {
      mockConfig.oauth[provider] = { clientId: 'cid', clientSecret: 'csecret' };
      const oauth = await import('../oauth');
      oauthModule = oauth;
      server = Fastify({ logger: false });
      await oauth.registerOAuthRoutes(server);
      return oauth;
    }

    function stubProviderFetch(userinfo: Record<string, unknown>): void {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => ({
          json: async () => (String(url).includes('token') ? { access_token: 'at' } : userinfo),
        })),
      );
    }

    function app(): FastifyInstance {
      if (!server) throw new Error('startServer() first');
      return server;
    }

    function callback(provider: 'google' | 'microsoft'): Promise<LightMyRequestResponse> {
      const state = `abc:${provider}`;
      return app().inject({
        method: 'GET',
        url: `/auth/${provider}/callback?code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: `soma_oauth_state_${provider}=${encodeURIComponent(state)}` },
      });
    }

    function sessionCookies(res: LightMyRequestResponse): string[] {
      const raw = res.headers['set-cookie'];
      const cookies = raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
      return cookies.filter((c) => c.startsWith('soma_dash_token=') && !c.startsWith('soma_dash_token=;'));
    }

    function issuedSession(res: LightMyRequestResponse): boolean {
      return sessionCookies(res).length > 0;
    }

    /** Slack user id (`sub`) of the session JWT the response set. */
    function sessionUserId(res: LightMyRequestResponse): string {
      const [cookie] = sessionCookies(res);
      if (!cookie) throw new Error('no session cookie');
      const token = decodeURIComponent(cookie.slice('soma_dash_token='.length).split(';')[0]);
      return (jwt.verify(token, 'test-jwt-secret') as jwt.JwtPayload).sub as string;
    }

    beforeEach(() => {
      logInfo.mockClear();
      logWarn.mockClear();
    });

    afterEach(async () => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      // Module state: a registered directory lookup must not leak into the next case.
      oauthModule?.setOAuthDirectoryLookup(null);
      oauthModule = undefined;
      await server?.close();
      server = undefined;
      mockConfig.oauth.google = { clientId: '', clientSecret: '' };
      mockConfig.oauth.microsoft = { clientId: '', clientSecret: '' };
    });

    it('Google: a verified email registered by one Slack user logs in', async () => {
      const oauth = await startServer('google');
      oauth.setOAuthUserLookup((email) =>
        email === 'alice@x.com' ? { kind: 'match', userId: 'U_A', name: 'Alice' } : { kind: 'none' },
      );
      stubProviderFetch({ email: 'Alice@x.com', name: 'Alice', verified_email: true });

      const res = await callback('google');
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/dashboard/U_A');
      expect(issuedSession(res)).toBe(true);
    });

    it.each([
      ['false', { verified_email: false }],
      ['missing', {}],
      ['the string "true"', { verified_email: 'true' }],
    ])('Google: verified_email %s → google_unverified, no session', async (_label, verified) => {
      const oauth = await startServer('google');
      oauth.setOAuthUserLookup(() => ({ kind: 'match', userId: 'U_A', name: 'Alice' }));
      const directory = vi.fn(async () => ({ userId: 'U_D', name: 'Dana' }));
      oauth.setOAuthDirectoryLookup(directory);
      stubProviderFetch({ email: 'alice@x.com', name: 'Alice', ...verified });

      const res = await callback('google');
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login?error=google_unverified');
      expect(issuedSession(res)).toBe(false);
      expect(logWarn).toHaveBeenCalledWith(expect.any(String), { email: 'alice@x.com' });
      // An unverified address proves nothing, so it never reaches the Slack directory either.
      expect(directory).not.toHaveBeenCalled();
    });

    it('Google: an email registered by several Slack users → ambiguous_email, no session', async () => {
      const oauth = await startServer('google');
      oauth.setOAuthUserLookup((email) =>
        email === 'shared@x.com' ? { kind: 'ambiguous', count: 2 } : { kind: 'none' },
      );
      stubProviderFetch({ email: 'shared@x.com', name: 'S', verified_email: true });

      const res = await callback('google');
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login?error=ambiguous_email');
      expect(issuedSession(res)).toBe(false);
      expect(logWarn).toHaveBeenCalledWith(expect.any(String), { email: 'shared@x.com', count: 2 });
    });

    it('Microsoft: an email registered by several Slack users → ambiguous_email, no session', async () => {
      const oauth = await startServer('microsoft');
      oauth.setOAuthUserLookup((email) =>
        email === 'shared@x.com' ? { kind: 'ambiguous', count: 3 } : { kind: 'none' },
      );
      stubProviderFetch({ mail: 'shared@x.com', displayName: 'S' });

      const res = await callback('microsoft');
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login?error=ambiguous_email');
      expect(issuedSession(res)).toBe(false);
      expect(logWarn).toHaveBeenCalledWith(expect.any(String), { email: 'shared@x.com', count: 3 });
    });

    it('Google: a verified email no Slack user registered still → no_match with the email', async () => {
      const oauth = await startServer('google');
      oauth.setOAuthUserLookup(() => ({ kind: 'none' }));
      stubProviderFetch({ email: 'nobody@x.com', name: 'N', verified_email: true });

      const res = await callback('google');
      expect(res.headers.location).toBe('/login?error=no_match&email=nobody%40x.com');
      expect(issuedSession(res)).toBe(false);
    });

    // `/z email` is a commit identity and often differs from the Slack account
    // email. When it does not match, a Google login falls back to the Slack
    // workspace directory (the account email Google just verified).
    describe('Google: Slack workspace email fallback', () => {
      it('no `/z email` match + the directory knows the email → logs in as that Slack user', async () => {
        const oauth = await startServer('google');
        oauth.setOAuthUserLookup(() => ({ kind: 'none' }));
        const directory = vi.fn(async (email: string) =>
          email === 'dana@x.com' ? { userId: 'U_D', name: 'Dana' } : null,
        );
        oauth.setOAuthDirectoryLookup(directory);
        stubProviderFetch({ email: 'Dana@X.com', name: 'Dana G', verified_email: true });

        const res = await callback('google');
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/dashboard/U_D');
        expect(issuedSession(res)).toBe(true);
        expect(sessionUserId(res)).toBe('U_D');
        expect(directory).toHaveBeenCalledTimes(1);
        expect(directory).toHaveBeenCalledWith('dana@x.com');
        expect(logInfo).toHaveBeenCalledWith('OAuth login: matched by Slack workspace email', {
          email: 'Dana@X.com',
          slackUserId: 'U_D',
        });
      });

      it('no `/z email` match + the directory does not know the email → no_match', async () => {
        const oauth = await startServer('google');
        oauth.setOAuthUserLookup(() => ({ kind: 'none' }));
        const directory = vi.fn(async () => null);
        oauth.setOAuthDirectoryLookup(directory);
        stubProviderFetch({ email: 'nobody@x.com', name: 'N', verified_email: true });

        const res = await callback('google');
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/login?error=no_match&email=nobody%40x.com');
        expect(issuedSession(res)).toBe(false);
        expect(directory).toHaveBeenCalledTimes(1);
        expect(logWarn).toHaveBeenCalledWith('OAuth login: no Slack user matched for email', {
          email: 'nobody@x.com',
        });
      });

      it('a directory that throws → no_match (302, not 500), warn carries only the message', async () => {
        const oauth = await startServer('google');
        oauth.setOAuthUserLookup(() => ({ kind: 'none' }));
        const failure = Object.assign(new Error('boom'), {
          data: { ok: false, error: 'boom', detail: 'payload-marker' },
        });
        oauth.setOAuthDirectoryLookup(async () => {
          throw failure;
        });
        stubProviderFetch({ email: 'nobody@x.com', name: 'N', verified_email: true });

        const res = await callback('google');
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/login?error=no_match&email=nobody%40x.com');
        expect(issuedSession(res)).toBe(false);
        expect(logWarn).toHaveBeenCalledWith('OAuth login: Slack workspace email lookup failed', {
          email: 'nobody@x.com',
          error: 'boom',
        });
        expect(JSON.stringify(logWarn.mock.calls)).not.toContain('payload-marker');
      });

      it('a directory that never answers → no_match once the timeout passes, not before', async () => {
        const oauth = await startServer('google');
        oauth.setOAuthUserLookup(() => ({ kind: 'none' }));
        oauth.setOAuthDirectoryLookup(() => new Promise(() => {}));
        stubProviderFetch({ email: 'nobody@x.com', name: 'N', verified_email: true });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        let settled = false;
        const pending = callback('google').then((res) => {
          settled = true;
          return res;
        });
        await vi.advanceTimersByTimeAsync(oauth.OAUTH_DIRECTORY_LOOKUP_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        const res = await pending;
        expect(oauth.OAUTH_DIRECTORY_LOOKUP_TIMEOUT_MS).toBe(5000);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/login?error=no_match&email=nobody%40x.com');
        expect(issuedSession(res)).toBe(false);
        expect(logWarn).toHaveBeenCalledWith('OAuth login: Slack workspace email lookup failed', {
          email: 'nobody@x.com',
          error: 'timeout',
        });
      });

      it('a directory that answers in time leaves no timer behind', async () => {
        const oauth = await startServer('google');
        oauth.setOAuthUserLookup(() => ({ kind: 'none' }));
        oauth.setOAuthDirectoryLookup(async () => ({ userId: 'U_D', name: 'Dana' }));
        stubProviderFetch({ email: 'dana@x.com', name: 'Dana', verified_email: true });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const res = await callback('google');
        expect(res.headers.location).toBe('/dashboard/U_D');
        expect(vi.getTimerCount()).toBe(0);
      });

      it('an ambiguous `/z email` → ambiguous_email, the directory is never asked', async () => {
        const oauth = await startServer('google');
        oauth.setOAuthUserLookup(() => ({ kind: 'ambiguous', count: 2 }));
        const directory = vi.fn(async () => ({ userId: 'U_D', name: 'Dana' }));
        oauth.setOAuthDirectoryLookup(directory);
        stubProviderFetch({ email: 'shared@x.com', name: 'S', verified_email: true });

        const res = await callback('google');
        expect(res.headers.location).toBe('/login?error=ambiguous_email');
        expect(issuedSession(res)).toBe(false);
        expect(directory).not.toHaveBeenCalled();
      });

      it('a `/z email` match wins, the directory is never asked', async () => {
        const oauth = await startServer('google');
        oauth.setOAuthUserLookup(() => ({ kind: 'match', userId: 'U_A', name: 'Alice' }));
        const directory = vi.fn(async () => ({ userId: 'U_D', name: 'Dana' }));
        oauth.setOAuthDirectoryLookup(directory);
        stubProviderFetch({ email: 'alice@x.com', name: 'Alice', verified_email: true });

        const res = await callback('google');
        expect(res.headers.location).toBe('/dashboard/U_A');
        expect(sessionUserId(res)).toBe('U_A');
        expect(directory).not.toHaveBeenCalled();
      });
    });

    it('Microsoft: no `/z email` match → no_match even with a directory registered (never asked)', async () => {
      const oauth = await startServer('microsoft');
      oauth.setOAuthUserLookup(() => ({ kind: 'none' }));
      const directory = vi.fn(async () => ({ userId: 'U_D', name: 'Dana' }));
      oauth.setOAuthDirectoryLookup(directory);
      stubProviderFetch({ mail: 'dana@x.com', displayName: 'Dana' });

      const res = await callback('microsoft');
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login?error=no_match&email=dana%40x.com');
      expect(issuedSession(res)).toBe(false);
      expect(directory).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith('OAuth login: no Slack user matched for email', { email: 'dana@x.com' });
    });

    it('login page explains google_unverified and ambiguous_email', async () => {
      await startServer('google');
      const res = await app().inject({ method: 'GET', url: '/login' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/'google_unverified': '[^']*not verified[^']*'/);
      expect(res.body).toMatch(/'ambiguous_email': '[^']*Several Slack users[^']*\/z email[^']*'/);
    });
  });

  // The production lookup (src/index.ts) feeds every Slack user's `/z email`
  // into this matcher; it must count matches instead of taking the first one.
  describe('matchSlackUsersByEmail', () => {
    it('reports a single case-insensitive match', async () => {
      const { matchSlackUsersByEmail } = await import('../oauth');
      const users = [
        { userId: 'U_A', email: 'Alice@X.com', slackName: 'Alice' },
        { userId: 'U_B', email: 'bob@x.com' },
      ];
      expect(matchSlackUsersByEmail(users, 'alice@x.com')).toEqual({ kind: 'match', userId: 'U_A', name: 'Alice' });
      expect(matchSlackUsersByEmail(users, 'bob@x.com')).toEqual({ kind: 'match', userId: 'U_B', name: 'U_B' });
    });

    it('reports ambiguity with the count when several Slack users registered the email', async () => {
      const { matchSlackUsersByEmail } = await import('../oauth');
      const users = [
        { userId: 'U_A', email: 'shared@x.com' },
        { userId: 'U_B', email: 'SHARED@x.com' },
        { userId: 'U_C', email: 'other@x.com' },
      ];
      expect(matchSlackUsersByEmail(users, 'shared@x.com')).toEqual({ kind: 'ambiguous', count: 2 });
    });

    it('reports none when no Slack user registered the email (cleared emails never match)', async () => {
      const { matchSlackUsersByEmail } = await import('../oauth');
      const users = [{ userId: 'U_A', email: '' }, { userId: 'U_B' }];
      expect(matchSlackUsersByEmail(users, 'alice@x.com')).toEqual({ kind: 'none' });
      expect(matchSlackUsersByEmail(users, '')).toEqual({ kind: 'none' });
    });
  });
});
