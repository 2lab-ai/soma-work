/**
 * OAuth2 authentication for the dashboard.
 *
 * Supports Google and Microsoft OAuth2 flows:
 *   1. User clicks "Sign in with Google/Microsoft" on /login
 *   2. Redirect to provider → user grants consent → redirect back to /auth/{provider}/callback
 *   3. Exchange code for access token → fetch user email
 *   4. Match email against UserSettingsStore (Slack profile emails)
 *   5. Issue JWT → set HttpOnly cookie → redirect to /dashboard
 *
 * Routes:
 *   GET /login                          → Login page (Google/Microsoft buttons)
 *   GET /auth/google                    → Redirect to Google OAuth
 *   GET /auth/google/callback           → Google OAuth callback
 *   GET /auth/microsoft                 → Redirect to Microsoft OAuth
 *   GET /auth/microsoft/callback        → Microsoft OAuth callback
 *   GET /auth/logout                    → Clear cookie, redirect to /login
 *   GET /auth/me                        → Current user info (JSON)
 */

import * as crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as jwt from 'jsonwebtoken';
import { config } from '../config';
import { Logger } from '../logger';

const logger = new Logger('OAuth');

const COOKIE_NAME = 'soma_dash_token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2/authorize';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2/token';
const MS_USERINFO_URL = 'https://graph.microsoft.com/v1.0/me';

// ── Types ──

export type DashboardProvider = 'google' | 'microsoft' | 'slack';

export interface DashboardUser {
  slackUserId: string;
  email: string;
  name: string;
  provider: DashboardProvider;
}

export type AuthMode = 'oauth_jwt' | 'bearer_header' | 'bearer_cookie' | 'none';

export interface AuthContext {
  mode: AuthMode;
  userId?: string; // Slack user ID (normalized)
  email?: string;
  name?: string;
  isAdmin: boolean; // true for bearer_header and bearer_cookie
}

interface JwtPayload {
  sub: string; // Slack user ID
  email: string;
  name: string;
  provider: string;
  originalIat?: number;
  iat?: number;
  exp?: number;
  /**
   * For Slack SSO exchange tokens (type='sso_exchange') only. Enforces
   * single-use redemption via `_consumeSsoJti` so a leaked link cannot be
   * replayed even within its expiry window.
   */
  jti?: string;
  /**
   * Discriminator between one-shot SSO exchange tokens and session cookies.
   * Omitted for session cookies (backwards compatible with existing Google /
   * Microsoft OAuth tokens). `'sso_exchange'` marks a token that may ONLY
   * be redeemed by `GET /auth/sso` and never honored by `buildAuthContext`.
   */
  type?: 'sso_exchange';
}

/**
 * Short lifetime for Slack SSO exchange tokens (seconds). Deliberately
 * decoupled from `config.oauth.jwtExpiresIn` (the session cookie lifetime):
 * the Slack message containing the URL can be exfiltrated, so we give the
 * legitimate user a tight click window instead of giving any observer a
 * week-long login credential. 10 minutes is enough for most humans to tab
 * over to a browser; combined with single-use `jti` redemption, even a
 * copied URL is useless on the second click.
 */
export const SSO_EXCHANGE_EXPIRES_IN_SEC = 600;

/**
 * In-memory one-time-redemption store for SSO exchange `jti` values.
 * Map<jti, expiresAtSec>. Cleared opportunistically on each consume call
 * so entries don't accumulate past their (already short) TTL. Single
 * process — a clustered deployment would need Redis, but this server
 * is single-Fastify today.
 */
const _redeemedSsoJtis = new Map<string, number>();

function _consumeSsoJti(jti: string, expSec: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  // Opportunistic GC — removing entries past their own exp keeps the map
  // bounded by (requests-per-TTL-window) without a timer.
  for (const [k, expiresAt] of _redeemedSsoJtis) {
    if (expiresAt <= now) _redeemedSsoJtis.delete(k);
  }
  if (_redeemedSsoJtis.has(jti)) return false; // already redeemed
  _redeemedSsoJtis.set(jti, expSec);
  return true;
}

/**
 * Returns the configured viewer base URL host ("host:port" — no scheme).
 * Used by `_isSameOriginRequest` to compare against incoming `Origin`
 * / `Referer` headers. Falls back to the `Host` request header when
 * `config.conversation.viewerUrl` isn't set (dev mode) — in that case
 * any absolute URL whose authority matches the request's own `Host` is
 * accepted as same-origin.
 */
function _viewerOriginHost(request: FastifyRequest): string | null {
  const configured = config.conversation.viewerUrl;
  if (configured) {
    try {
      return new URL(configured).host;
    } catch {
      // fallthrough to Host header
    }
  }
  const hostHeader = request.headers.host;
  return typeof hostHeader === 'string' ? hostHeader : null;
}

/**
 * Same-origin check for state-changing endpoints like
 * `POST /auth/sso/confirm` (#704). Login CSRF / session-fixation
 * protection: without this guard an attacker who holds a valid
 * exchange token can auto-submit a top-level form from any origin
 * and silently bind the victim's browser to the attacker's account
 * (Oracle review P1). `SameSite=Lax` only constrains *sending* cookies,
 * not *setting* them via Set-Cookie, so it does not defend this path.
 *
 * Policy: allow the request only when Origin (preferred) or Referer
 * resolves to the same host as `viewerUrl` (or the request's own
 * `Host`). A missing Origin AND missing Referer is refused — legitimate
 * browser form submits from the interstitial always include at least
 * one.
 */
function _isSameOriginRequest(request: FastifyRequest): boolean {
  const expectedHost = _viewerOriginHost(request);
  if (!expectedHost) return false;
  const origin = request.headers.origin;
  const referer = request.headers.referer;
  const candidate = typeof origin === 'string' ? origin : typeof referer === 'string' ? referer : null;
  if (!candidate) return false;
  try {
    return new URL(candidate).host === expectedHost;
  } catch {
    return false;
  }
}

/**
 * Report the "current session" holder of the request's cookie, if any.
 * Covers BOTH auth modes the server recognises:
 *   - OAuth JWT cookies (`soma_dash_token=<jwt>`)
 *   - Admin bearer cookies (`soma_dash_token=bearer:<viewerToken>`)
 *
 * Returns `{ kind: 'jwt', user }` for JWT sessions, `{ kind: 'bearer' }`
 * for admin, or `null` when the cookie is missing / garbage. The
 * session-fixation guard needs the bearer branch because
 * `getDashboardUser` alone would miss it — an admin who's already signed
 * in via `/auth/token` must NOT be silently downgraded to a Slack
 * identity by clicking a Slack `dashboard` link (Oracle re-review P1).
 */
function _getCurrentSession(request: FastifyRequest): { kind: 'jwt'; user: DashboardUser } | { kind: 'bearer' } | null {
  const cookieHeader = request.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const cookieVal = decodeURIComponent(match[1]);
  if (
    cookieVal.startsWith('bearer:') &&
    config.conversation.viewerToken &&
    cookieVal.slice(7) === config.conversation.viewerToken
  ) {
    return { kind: 'bearer' };
  }
  const user = verifyDashboardToken(cookieVal);
  return user ? { kind: 'jwt', user } : null;
}

// ── User lookup ──

type UserLookupFn = (email: string) => { userId: string; name: string } | null;
let _lookupByEmail: UserLookupFn | null = null;

/** Register the email→user lookup (called once at startup). */
export function setOAuthUserLookup(fn: UserLookupFn): void {
  _lookupByEmail = fn;
}

function lookupUser(email: string): { userId: string; name: string } | null {
  if (!_lookupByEmail) return null;
  return _lookupByEmail(email.toLowerCase());
}

// ── JWT helpers ──

let _ephemeralSecret: string | null = null;

export function getJwtSecret(): string {
  if (config.oauth.jwtSecret) return config.oauth.jwtSecret;
  if (config.conversation.viewerToken) return config.conversation.viewerToken;

  // When OAuth is configured but no explicit secret — generate ephemeral
  if (isOAuthConfigured('google') || isOAuthConfigured('microsoft')) {
    if (!_ephemeralSecret) {
      _ephemeralSecret = crypto.randomBytes(32).toString('hex');
      logger.warn('No DASHBOARD_JWT_SECRET configured — using ephemeral secret. Sessions will not survive restarts.');
    }
    return _ephemeralSecret;
  }

  // No auth configured at all — return empty (auth disabled)
  return '';
}

function issueToken(user: DashboardUser, originalIat?: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: user.slackUserId,
    email: user.email,
    name: user.name,
    provider: user.provider,
    originalIat: originalIat || now,
  };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: config.oauth.jwtExpiresIn });
}

/** Verify JWT from cookie. Returns null if invalid/expired. */
export function verifyDashboardToken(token: string): DashboardUser | null {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as JwtPayload;
    // Reject SSO exchange tokens — they must go through `GET /auth/sso`
    // and be redeemed (jti consumed) before they become a session.
    if (payload.type === 'sso_exchange') return null;
    return {
      slackUserId: payload.sub,
      email: payload.email,
      name: payload.name,
      provider: payload.provider as DashboardProvider,
    };
  } catch {
    return null;
  }
}

/**
 * Issue a single-use Slack SSO **exchange token** (issue #704).
 *
 * This is NOT a session cookie — it is a short-lived, single-use bearer
 * carried in a URL (`<viewerBase>/auth/sso?token=...`) that the user clicks
 * from Slack. `GET /auth/sso` verifies the exchange token, consumes the
 * `jti` so the link cannot be replayed, and issues a fresh session-cookie
 * JWT via the normal `issueToken` path.
 *
 * Why a separate token type instead of directly using a session JWT:
 *   1. The Slack message containing the URL can be exfiltrated (thread
 *      export, notification preview, screen-share). A 10-minute TTL
 *      bounds the replay window to something a human can reasonably
 *      act on, instead of the 7-day session cookie lifetime.
 *   2. `jti` one-time redemption means a copied link is useless after
 *      the first click, whether or not the TTL has elapsed.
 *   3. `type: 'sso_exchange'` is rejected by `buildAuthContext` so a
 *      stolen exchange token cannot be stuffed into a cookie jar to
 *      skip the redemption step.
 *
 * Trust model: the Slack event pipeline has already verified `slackUserId`
 * via Slack's signed request. `email` / `name` are informational only —
 * dashboard authorization keys on `sub` throughout.
 */
export function issueSlackToken(params: { slackUserId: string; email: string; name: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: params.slackUserId,
    email: params.email,
    name: params.name,
    provider: 'slack',
    type: 'sso_exchange',
    jti: crypto.randomBytes(16).toString('hex'),
    originalIat: now,
  };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: SSO_EXCHANGE_EXPIRES_IN_SEC });
}

/**
 * Verify a Slack SSO exchange token.
 *
 * Returns the full payload on success (including `jti` + `exp` needed by
 * the route handler to consume the single-use receipt). Returns null on
 * bad signature, expiry, OR when `type !== 'sso_exchange'` — the latter
 * blocks an attacker from passing a stolen session cookie as an SSO
 * exchange token.
 */
export function verifySsoExchangeToken(token: string): (JwtPayload & { jti: string; exp: number }) | null {
  try {
    const secret = getJwtSecret();
    if (!secret) return null;
    const payload = jwt.verify(token, secret) as JwtPayload;
    if (payload.type !== 'sso_exchange') return null;
    if (!payload.jti || !payload.exp) return null;
    return payload as JwtPayload & { jti: string; exp: number };
  } catch {
    return null;
  }
}

/** Verify JWT and return raw payload (for JWT rotation logic). */
export function verifyDashboardTokenRaw(token: string): (JwtPayload & { iat: number; exp: number }) | null {
  try {
    const secret = getJwtSecret();
    if (!secret) return null;
    const payload = jwt.verify(token, secret) as JwtPayload & { iat: number; exp: number };
    // Same exchange-token guard as verifyDashboardToken — keeps
    // buildAuthContext / maybeRotateJwt from treating an exchange token
    // as a session.
    if (payload.type === 'sso_exchange') return null;
    return payload;
  } catch {
    return null;
  }
}

/** Extract dashboard user from request cookie. */
export function getDashboardUser(request: FastifyRequest): DashboardUser | null {
  const cookieHeader = request.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return verifyDashboardToken(decodeURIComponent(match[1]));
}

// ── OAuth helpers ──

function getCallbackUrl(provider: 'google' | 'microsoft'): string {
  const base = config.conversation.viewerUrl || `http://localhost:${config.conversation.viewerPort || 3000}`;
  return `${base}/auth/${provider}/callback`;
}

function isOAuthConfigured(provider: 'google' | 'microsoft'): boolean {
  const cfg = config.oauth[provider];
  return !!(cfg.clientId && cfg.clientSecret);
}

async function exchangeGoogleCode(code: string): Promise<{ email: string; name: string } | null> {
  try {
    // Exchange code for tokens
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.oauth.google.clientId,
        client_secret: config.oauth.google.clientSecret,
        redirect_uri: getCallbackUrl('google'),
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = (await tokenRes.json()) as any;
    if (!tokenData.access_token) {
      logger.error('Google token exchange failed', tokenData);
      return null;
    }

    // Fetch user info
    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = (await userRes.json()) as any;
    if (!userInfo.email) {
      logger.error('Google userinfo missing email', userInfo);
      return null;
    }

    return { email: userInfo.email, name: userInfo.name || userInfo.email };
  } catch (error) {
    logger.error('Google OAuth exchange error', error);
    return null;
  }
}

async function exchangeMicrosoftCode(code: string): Promise<{ email: string; name: string } | null> {
  try {
    const tokenRes = await fetch(MS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.oauth.microsoft.clientId,
        client_secret: config.oauth.microsoft.clientSecret,
        redirect_uri: getCallbackUrl('microsoft'),
        grant_type: 'authorization_code',
        scope: 'openid email profile User.Read',
      }),
    });
    const tokenData = (await tokenRes.json()) as any;
    if (!tokenData.access_token) {
      logger.error('Microsoft token exchange failed', tokenData);
      return null;
    }

    const userRes = await fetch(MS_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = (await userRes.json()) as any;
    const email = userInfo.mail || userInfo.userPrincipalName;
    if (!email) {
      logger.error('Microsoft userinfo missing email', userInfo);
      return null;
    }

    return { email, name: userInfo.displayName || email };
  } catch (error) {
    logger.error('Microsoft OAuth exchange error', error);
    return null;
  }
}

// ── Cookie helper ──

function setCookieAndRedirect(reply: FastifyReply, token: string, redirectTo: string): void {
  const maxAge = config.oauth.jwtExpiresIn;
  const secure = (config.conversation.viewerUrl || '').startsWith('https');
  reply.header(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
  );
  reply.redirect(redirectTo);
}

function clearCookieAndRedirect(reply: FastifyReply, redirectTo: string): void {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  reply.redirect(redirectTo);
}

// ── CSRF helpers ──

export function generateCsrfToken(userId: string, exp: number): string {
  const secret = getJwtSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(`${userId}:${exp}`).digest('hex').slice(0, 32);
}

export function generateCsrfTokenForAdmin(): string {
  const secret = getJwtSecret();
  const viewerToken = config.conversation.viewerToken;
  if (!secret || !viewerToken) return '';
  return crypto
    .createHmac('sha256', secret)
    .update(`csrf:admin:${viewerToken.slice(-8)}`)
    .digest('hex')
    .slice(0, 32);
}

export function validateCsrfToken(
  token: string,
  userId: string | undefined,
  exp: number | undefined,
  isAdmin: boolean,
): boolean {
  if (!token) return false;
  const expected =
    isAdmin && !userId ? generateCsrfTokenForAdmin() : userId && exp ? generateCsrfToken(userId, exp) : '';
  if (!expected) return false;
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

// ── OAuth state helpers ──

export function generateOAuthState(provider: string): string {
  return crypto.randomBytes(16).toString('hex') + ':' + provider;
}

function getOAuthStateCookieName(provider: string): string {
  return `soma_oauth_state_${provider}`;
}

export function setOAuthStateCookie(reply: any, provider: string, state: string): void {
  const secure = (config.conversation.viewerUrl || '').startsWith('https');
  const cookieName = getOAuthStateCookieName(provider);
  reply.header(
    'Set-Cookie',
    `${cookieName}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
  );
}

export function validateOAuthState(request: any, provider: string, stateParam: string | undefined): boolean {
  if (!stateParam) return false;
  const cookieName = getOAuthStateCookieName(provider);
  const cookieHeader = request.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) return false;
  const cookieState = decodeURIComponent(match[1]);
  return cookieState === stateParam && stateParam.endsWith(':' + provider);
}

export function clearOAuthStateCookie(reply: any, provider: string): void {
  const cookieName = getOAuthStateCookieName(provider);
  reply.header('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── Route registration ──

export async function registerOAuthRoutes(server: FastifyInstance): Promise<void> {
  const googleEnabled = isOAuthConfigured('google');
  const microsoftEnabled = isOAuthConfigured('microsoft');
  const anyEnabled = googleEnabled || microsoftEnabled;

  // ── Login page ──
  server.get('/login', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(renderLoginPage(googleEnabled, microsoftEnabled));
  });

  // ── Google OAuth ──
  if (googleEnabled) {
    server.get('/auth/google', async (_request, reply) => {
      const state = generateOAuthState('google');
      setOAuthStateCookie(reply, 'google', state);
      const params = new URLSearchParams({
        client_id: config.oauth.google.clientId,
        redirect_uri: getCallbackUrl('google'),
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'online',
        prompt: 'select_account',
        state,
      });
      reply.redirect(`${GOOGLE_AUTH_URL}?${params}`);
    });

    server.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
      '/auth/google/callback',
      async (request, reply) => {
        if (request.query.error || !request.query.code) {
          reply.redirect('/login?error=google_denied');
          return;
        }

        if (!validateOAuthState(request, 'google', request.query.state)) {
          reply.redirect('/login?error=state_mismatch');
          return;
        }
        clearOAuthStateCookie(reply, 'google');

        const userInfo = await exchangeGoogleCode(request.query.code);
        if (!userInfo) {
          reply.redirect('/login?error=google_failed');
          return;
        }

        const matched = lookupUser(userInfo.email);
        if (!matched) {
          logger.warn('OAuth login: no Slack user matched for email', { email: userInfo.email });
          reply.redirect('/login?error=no_match&email=' + encodeURIComponent(userInfo.email));
          return;
        }

        const dashUser: DashboardUser = {
          slackUserId: matched.userId,
          email: userInfo.email,
          name: matched.name || userInfo.name,
          provider: 'google',
        };
        const token = issueToken(dashUser);
        logger.info('OAuth login success', { provider: 'google', email: userInfo.email, slackUserId: matched.userId });
        setCookieAndRedirect(reply, token, `/dashboard/${matched.userId}`);
      },
    );
  }

  // ── Microsoft OAuth ──
  if (microsoftEnabled) {
    server.get('/auth/microsoft', async (_request, reply) => {
      const state = generateOAuthState('microsoft');
      setOAuthStateCookie(reply, 'microsoft', state);
      const params = new URLSearchParams({
        client_id: config.oauth.microsoft.clientId,
        redirect_uri: getCallbackUrl('microsoft'),
        response_type: 'code',
        scope: 'openid email profile User.Read',
        response_mode: 'query',
        prompt: 'select_account',
        state,
      });
      reply.redirect(`${MS_AUTH_URL}?${params}`);
    });

    server.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
      '/auth/microsoft/callback',
      async (request, reply) => {
        if (request.query.error || !request.query.code) {
          reply.redirect('/login?error=microsoft_denied');
          return;
        }

        if (!validateOAuthState(request, 'microsoft', request.query.state)) {
          reply.redirect('/login?error=state_mismatch');
          return;
        }
        clearOAuthStateCookie(reply, 'microsoft');

        const userInfo = await exchangeMicrosoftCode(request.query.code);
        if (!userInfo) {
          reply.redirect('/login?error=microsoft_failed');
          return;
        }

        const matched = lookupUser(userInfo.email);
        if (!matched) {
          logger.warn('OAuth login: no Slack user matched for email', { email: userInfo.email });
          reply.redirect('/login?error=no_match&email=' + encodeURIComponent(userInfo.email));
          return;
        }

        const dashUser: DashboardUser = {
          slackUserId: matched.userId,
          email: userInfo.email,
          name: matched.name || userInfo.name,
          provider: 'microsoft',
        };
        const token = issueToken(dashUser);
        logger.info('OAuth login success', {
          provider: 'microsoft',
          email: userInfo.email,
          slackUserId: matched.userId,
        });
        setCookieAndRedirect(reply, token, `/dashboard/${matched.userId}`);
      },
    );
  }

  // ── Logout ──
  server.get('/auth/logout', async (_request, reply) => {
    clearCookieAndRedirect(reply, '/login');
  });

  // ── Slack SSO (GET) — redeem a signed link from the `dashboard` Slack command ──
  //
  // The `dashboard` Slack command (see `slack/commands/dashboard-handler.ts`)
  // mints a short-lived exchange JWT via `issueSlackToken` and sends the
  // user a URL of the form `/auth/sso?token=<jwt>`. This handler verifies
  // the exchange token, consumes its `jti` (single-use), and issues a
  // fresh session-cookie JWT with the full lifetime.
  //
  // Security invariants (see #704 review):
  //   1. Exchange token is rejected if `type !== 'sso_exchange'` — stolen
  //      session cookies cannot be re-stamped through this route.
  //   2. Exchange token is single-use via `_consumeSsoJti` — a copied URL
  //      returns 302 /login?error=sso_consumed on the second click.
  //   3. Session-fixation guard: if the browser already has a *different*
  //      user's session cookie, we do NOT silently overwrite it. The
  //      interstitial page asks the user to explicitly confirm switching
  //      identities via a POST to `/auth/sso/confirm` (CSRF-token bound
  //      to the exchange token). Same-user exchange (e.g. opening the
  //      dashboard link while already logged in) is a no-op redirect.
  //   4. On any failure path, we do NOT emit `Set-Cookie` — no partial
  //      state leaks to the browser.
  //   5. The `?token=` querystring is stripped via a 303 redirect so the
  //      sensitive token never lingers in browser history after the first
  //      (successful or failed) click.
  server.get<{ Querystring: { token?: string } }>('/auth/sso', async (request, reply) => {
    const token = request.query.token;
    if (!token) {
      reply.redirect('/login?error=sso_missing');
      return;
    }
    const payload = verifySsoExchangeToken(token);
    if (!payload) {
      logger.warn('Slack SSO: exchange token verification failed');
      reply.redirect('/login?error=sso_invalid');
      return;
    }

    // Session-fixation guard (#704 P1). Detect an existing session BEFORE
    // consuming the jti — if we'd make the user re-confirm anyway, we
    // don't want the consume side-effect to have already fired on the
    // rejection path. The interstitial re-POSTs the original token,
    // and THAT path consumes the jti.
    //
    // Covers BOTH cookie modes (JWT + bearer:admin) via `_getCurrentSession`.
    // Oracle re-review caught that `getDashboardUser` alone missed bearer
    // admin sessions — an admin browser could be silently switched to a
    // Slack identity without the interstitial.
    const existing = _getCurrentSession(request);
    const existingMatchesRequest = existing?.kind === 'jwt' && existing.user.slackUserId === payload.sub;
    if (existing && !existingMatchesRequest) {
      logger.warn('Slack SSO: session switch requires confirmation', {
        currentKind: existing.kind,
        currentUser: existing.kind === 'jwt' ? existing.user.slackUserId : 'admin',
        requestedUser: payload.sub,
      });
      // `no-store` keeps the token out of browser back/forward cache —
      // combined with the 303 on the POST side, the exchange JWT never
      // lingers in the session-history stack.
      reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-store, no-cache, must-revalidate')
        .header('Pragma', 'no-cache')
        .send(renderSsoConfirmPage(token, existing, payload));
      return;
    }

    // Consume the single-use jti. If someone already redeemed this token
    // (attacker race, user double-click, forwarded link), block the
    // second attempt even though the JWT itself is still cryptographically
    // valid.
    if (!_consumeSsoJti(payload.jti, payload.exp)) {
      logger.warn('Slack SSO: exchange token already redeemed', { jti: payload.jti });
      reply.redirect('/login?error=sso_consumed');
      return;
    }

    // Issue a fresh session-cookie JWT (type undefined, full lifetime).
    // We deliberately do NOT reuse the exchange token as the cookie —
    // the exchange token is short-lived and has `type: 'sso_exchange'`
    // which `buildAuthContext` rejects, so using it directly would
    // immediately fail `/auth/me`.
    const sessionToken = issueToken({
      slackUserId: payload.sub,
      email: payload.email,
      name: payload.name,
      provider: 'slack',
    });
    logger.info('Slack SSO login success', { slackUserId: payload.sub });
    setCookieAndRedirect(reply, sessionToken, `/dashboard/${payload.sub}`);
  });

  // Confirmation POST for session switching. This runs AFTER the user
  // has clicked "Switch" on the interstitial rendered by `GET /auth/sso`
  // — i.e. the operation is explicit and deliberate. We re-verify the
  // exchange token from the hidden form field and consume the jti here
  // (not on the GET) so a drive-by GET doesn't burn the token just to
  // show a page the user will likely cancel.
  //
  // Same-origin enforcement (Oracle re-review P1): the exchange JWT
  // alone is NOT proof of user intent — an attacker who holds any
  // valid exchange token could auto-submit a cross-origin form POST
  // and silently bind the victim's browser to the attacker's session
  // (SameSite=Lax does not protect Set-Cookie, only cookie-send). We
  // reject any POST whose Origin/Referer doesn't match our viewer
  // host.
  server.post<{ Body: { token?: string } }>('/auth/sso/confirm', async (request, reply) => {
    if (!_isSameOriginRequest(request)) {
      logger.warn('Slack SSO confirm: rejected cross-origin POST', {
        origin: request.headers.origin ?? null,
        referer: request.headers.referer ?? null,
      });
      reply.status(403).send('Forbidden: cross-origin confirmation not allowed');
      return;
    }
    const token = request.body?.token;
    if (!token) {
      reply.status(400).send('Missing token');
      return;
    }
    const payload = verifySsoExchangeToken(token);
    if (!payload) {
      reply.redirect('/login?error=sso_invalid', 303);
      return;
    }
    if (!_consumeSsoJti(payload.jti, payload.exp)) {
      reply.redirect('/login?error=sso_consumed', 303);
      return;
    }
    const sessionToken = issueToken({
      slackUserId: payload.sub,
      email: payload.email,
      name: payload.name,
      provider: 'slack',
    });
    logger.info('Slack SSO login success via session switch', { slackUserId: payload.sub });
    // 303 after POST so the browser issues GET for the final dashboard
    // URL — standard POST-redirect-GET, also keeps the form resubmit
    // prompt out of the back button.
    const maxAge = config.oauth.jwtExpiresIn;
    const secure = (config.conversation.viewerUrl || '').startsWith('https');
    reply.header(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
    );
    reply.redirect(`/dashboard/${payload.sub}`, 303);
  });

  // ── Token login (server-side) — replaces client-side cookie write ──
  server.post<{ Body: { token: string } }>('/auth/token', async (request, reply) => {
    const { token: providedToken } = request.body || {};
    const viewerToken = config.conversation.viewerToken;
    if (!providedToken || !viewerToken || providedToken !== viewerToken) {
      reply.status(401).send({ error: 'Invalid token' });
      return;
    }
    logger.info('Token login success');
    const maxAge = config.oauth.jwtExpiresIn;
    const secure = (config.conversation.viewerUrl || '').startsWith('https');
    reply.header(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent('bearer:' + providedToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
    );
    reply.send({ ok: true, redirect: '/dashboard' });
  });

  // ── /auth/me — current user (JSON) + CSRF token ──
  server.get('/auth/me', async (request, reply) => {
    const user = getDashboardUser(request);
    if (!user) {
      // For bearer_cookie users, return admin context with CSRF
      const cookieHeader = request.headers.cookie || '';
      const cookieMatch = cookieHeader.match(/soma_dash_token=([^;]+)/);
      if (cookieMatch) {
        const cookieVal = decodeURIComponent(cookieMatch[1]);
        if (
          cookieVal.startsWith('bearer:') &&
          config.conversation.viewerToken &&
          cookieVal.slice(7) === config.conversation.viewerToken
        ) {
          reply.send({ user: null, isAdmin: true, csrfToken: generateCsrfTokenForAdmin() });
          return;
        }
      }
      reply.status(401).send({ error: 'Not authenticated' });
      return;
    }
    // For OAuth JWT users, derive CSRF token from JWT claims
    const cookieHeader = request.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/soma_dash_token=([^;]+)/);
    let csrfToken = '';
    if (cookieMatch) {
      const payload = verifyDashboardTokenRaw(decodeURIComponent(cookieMatch[1]));
      if (payload?.sub && payload?.exp) {
        csrfToken = generateCsrfToken(payload.sub, payload.exp);
      }
    }
    reply.send({ user, csrfToken });
  });

  if (anyEnabled) {
    logger.info('OAuth routes registered', {
      google: googleEnabled,
      microsoft: microsoftEnabled,
    });
  }
}

// ── SSO session-switch interstitial ──

/**
 * HTML escape helper for the SSO confirm page. Output is inserted into
 * an HTML document, so `<`, `>`, `&`, `"`, `'` must be neutralised.
 * `user.name` and `user.email` ultimately flow from Slack users.info /
 * OAuth userinfo which is mostly trusted, but rendering unescaped would
 * still expose every OAuth provider's display-name field as a potential
 * XSS vector — not worth the risk.
 */
function _htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the session-switch confirmation page served by `GET /auth/sso`
 * when the browser already has a session for a different user. The user
 * must click "Continue as <name>" to POST to `/auth/sso/confirm`, which
 * consumes the jti and swaps the cookie. Clicking "Cancel" keeps the
 * existing session — no token is consumed, so a fresh `dashboard` call
 * is NOT required.
 *
 * The hidden `token` field carries the original exchange JWT verbatim.
 * Since the token itself is signed+expiring+single-use, we don't need a
 * separate CSRF token on this form — an attacker who could forge this
 * POST already has the exchange token, in which case the victim was
 * going to be impersonated anyway via the GET path.
 */
function renderSsoConfirmPage(
  token: string,
  current: { kind: 'jwt'; user: DashboardUser } | { kind: 'bearer' },
  requested: { sub: string; name: string; email: string },
): string {
  const currentName = _htmlEscape(
    current.kind === 'jwt' ? current.user.name || current.user.slackUserId : 'Admin (API token)',
  );
  const currentEmail = _htmlEscape(current.kind === 'jwt' ? current.user.email || '' : '');
  const requestedName = _htmlEscape(requested.name || requested.sub);
  const requestedEmail = _htmlEscape(requested.email || '');
  const tokenEsc = _htmlEscape(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>soma-work — Confirm session switch</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --text-muted: #8b949e; --accent: #58a6ff; --red: #f85149; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 32px; width: 420px; }
.card h1 { font-size: 1.2em; margin-bottom: 12px; }
.card p { color: var(--text-muted); font-size: 0.9em; margin-bottom: 16px; line-height: 1.5; }
.who { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; font-size: 0.85em; }
.who b { color: var(--text); }
.who.current { border-left: 3px solid var(--text-muted); }
.who.requested { border-left: 3px solid var(--accent); }
.actions { display: flex; gap: 10px; margin-top: 20px; }
button, .btn-cancel { flex: 1; padding: 10px; border-radius: 8px; font-size: 0.95em; cursor: pointer; text-align: center; text-decoration: none; display: inline-block; border: 1px solid var(--border); }
.btn-confirm { background: var(--accent); color: #000; border: none; font-weight: 600; }
.btn-cancel { background: var(--surface); color: var(--text); }
.btn-cancel:hover { border-color: var(--red); color: var(--red); }
</style>
</head>
<body>
<form class="card" method="POST" action="/auth/sso/confirm">
  <h1>Switch accounts?</h1>
  <p>You are about to replace your current dashboard session. This will log you out of the account below.</p>
  <div class="who current"><b>Currently signed in:</b> ${currentName}${currentEmail ? ` &lt;${currentEmail}&gt;` : ''}</div>
  <div class="who requested"><b>New session:</b> ${requestedName}${requestedEmail ? ` &lt;${requestedEmail}&gt;` : ''}</div>
  <input type="hidden" name="token" value="${tokenEsc}" />
  <div class="actions">
    <a class="btn-cancel" href="/dashboard">Cancel</a>
    <button type="submit" class="btn-confirm">Continue as ${requestedName}</button>
  </div>
</form>
</body>
</html>`;
}

// ── Login page HTML ──

function renderLoginPage(googleEnabled: boolean, microsoftEnabled: boolean): string {
  const params = new URLSearchParams(typeof globalThis !== 'undefined' ? '' : '');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>soma-work — Sign In</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --text-muted: #8b949e; --accent: #58a6ff; --red: #f85149; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; min-height: 100vh; }
.login-box { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 40px; width: 380px; text-align: center; }
.login-box h1 { font-size: 1.4em; margin-bottom: 8px; }
.login-box p { color: var(--text-muted); font-size: 0.85em; margin-bottom: 24px; }
.btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.95em; cursor: pointer; text-decoration: none; margin-bottom: 12px; transition: all 0.2s; }
.btn:hover { border-color: var(--accent); background: rgba(88,166,255,0.1); }
.btn-google { background: #fff; color: #333; }
.btn-google:hover { background: #f5f5f5; }
.btn-microsoft { background: #2b2b2b; color: #fff; }
.btn-microsoft:hover { background: #3b3b3b; }
.btn svg { width: 20px; height: 20px; }
.error-msg { background: rgba(248,81,73,0.15); border: 1px solid var(--red); color: var(--red); padding: 10px; border-radius: 6px; margin-bottom: 16px; font-size: 0.85em; }
.divider { color: var(--text-muted); font-size: 0.8em; margin: 16px 0; }
.token-form { display: flex; gap: 8px; }
.token-form input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: var(--text); font-size: 0.85em; }
.token-form button { background: var(--accent); color: #000; border: none; border-radius: 6px; padding: 8px 16px; font-size: 0.85em; cursor: pointer; font-weight: 600; }
</style>
</head>
<body>
<div class="login-box">
  <h1>⚡ soma-work</h1>
  <p>Sign in to access your personal dashboard</p>

  <div id="error"></div>

  ${
    googleEnabled
      ? `
  <a href="/auth/google" class="btn btn-google">
    <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
    Sign in with Google
  </a>`
      : ''
  }

  ${
    microsoftEnabled
      ? `
  <a href="/auth/microsoft" class="btn btn-microsoft">
    <svg viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
    Sign in with Microsoft
  </a>`
      : ''
  }

  ${
    !googleEnabled && !microsoftEnabled
      ? `
  <p style="color:var(--text-muted);margin-bottom:16px">OAuth not configured. Use API token below.</p>
  `
      : `<div class="divider">or use API token</div>`
  }

  <div class="token-form">
    <input type="password" id="token-input" placeholder="Viewer token..." />
    <button onclick="loginWithToken()">Go</button>
  </div>
</div>

<script>
// Show error from query params
// Render error text as a text node so any attacker-controlled URL
// parameter (e.g. ?error=no_match&email=<img onerror=...>) is neutered —
// innerHTML on user-controlled data is reflected XSS (Oracle re-review,
// pre-existing). The wrapper div is created imperatively.
function _showError(msg) {
  const el = document.getElementById('error');
  if (!el) return;
  const wrap = document.createElement('div');
  wrap.className = 'error-msg';
  wrap.textContent = msg;
  el.replaceChildren(wrap);
}
const params = new URLSearchParams(location.search);
const err = params.get('error');
if (err) {
  const emailParam = params.get('email') || 'this email';
  const msgs = {
    'google_denied': 'Google sign-in was cancelled.',
    'google_failed': 'Google sign-in failed. Please try again.',
    'microsoft_denied': 'Microsoft sign-in was cancelled.',
    'microsoft_failed': 'Microsoft sign-in failed. Please try again.',
    // emailParam is inserted as text only via _showError — do NOT switch
    // this branch back to innerHTML.
    'no_match': 'No matching Slack account found for ' + emailParam + '. Contact your admin.',
    'state_mismatch': 'Authentication state mismatch. Please try again.',
    'sso_missing': 'Slack SSO link is missing a token. Request a new dashboard link in Slack.',
    'sso_invalid': 'Slack SSO link expired or is invalid. Request a new dashboard link in Slack.',
    'sso_consumed': 'Slack SSO link was already used. Request a new dashboard link in Slack.',
  };
  _showError(msgs[err] || 'Authentication error.');
}

function loginWithToken() {
  const token = document.getElementById('token-input').value.trim();
  if (!token) return;
  fetch('/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }).then(r => r.json()).then(data => {
    if (data.ok) location.href = data.redirect || '/dashboard';
    else _showError('Invalid token.');
  }).catch(() => {
    _showError('Login failed.');
  });
}
</script>
</body>
</html>`;
}
