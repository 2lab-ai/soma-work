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

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
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

export interface DashboardUser {
  slackUserId: string;
  email: string;
  name: string;
  provider: 'google' | 'microsoft';
}

interface JwtPayload {
  sub: string;       // Slack user ID
  email: string;
  name: string;
  provider: string;
  iat?: number;
  exp?: number;
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

function getJwtSecret(): string {
  return config.oauth.jwtSecret || config.conversation.viewerToken || 'soma-dashboard-default-secret';
}

function issueToken(user: DashboardUser): string {
  const payload: JwtPayload = {
    sub: user.slackUserId,
    email: user.email,
    name: user.name,
    provider: user.provider,
  };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: config.oauth.jwtExpiresIn });
}

/** Verify JWT from cookie. Returns null if invalid/expired. */
export function verifyDashboardToken(token: string): DashboardUser | null {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as JwtPayload;
    return {
      slackUserId: payload.sub,
      email: payload.email,
      name: payload.name,
      provider: payload.provider as 'google' | 'microsoft',
    };
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
    const tokenData = await tokenRes.json() as any;
    if (!tokenData.access_token) {
      logger.error('Google token exchange failed', tokenData);
      return null;
    }

    // Fetch user info
    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userRes.json() as any;
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
    const tokenData = await tokenRes.json() as any;
    if (!tokenData.access_token) {
      logger.error('Microsoft token exchange failed', tokenData);
      return null;
    }

    const userRes = await fetch(MS_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userRes.json() as any;
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
  reply.header(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  reply.redirect(redirectTo);
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
      const params = new URLSearchParams({
        client_id: config.oauth.google.clientId,
        redirect_uri: getCallbackUrl('google'),
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'online',
        prompt: 'select_account',
      });
      reply.redirect(`${GOOGLE_AUTH_URL}?${params}`);
    });

    server.get<{ Querystring: { code?: string; error?: string } }>(
      '/auth/google/callback',
      async (request, reply) => {
        if (request.query.error || !request.query.code) {
          reply.redirect('/login?error=google_denied');
          return;
        }

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
      }
    );
  }

  // ── Microsoft OAuth ──
  if (microsoftEnabled) {
    server.get('/auth/microsoft', async (_request, reply) => {
      const params = new URLSearchParams({
        client_id: config.oauth.microsoft.clientId,
        redirect_uri: getCallbackUrl('microsoft'),
        response_type: 'code',
        scope: 'openid email profile User.Read',
        response_mode: 'query',
        prompt: 'select_account',
      });
      reply.redirect(`${MS_AUTH_URL}?${params}`);
    });

    server.get<{ Querystring: { code?: string; error?: string } }>(
      '/auth/microsoft/callback',
      async (request, reply) => {
        if (request.query.error || !request.query.code) {
          reply.redirect('/login?error=microsoft_denied');
          return;
        }

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
        logger.info('OAuth login success', { provider: 'microsoft', email: userInfo.email, slackUserId: matched.userId });
        setCookieAndRedirect(reply, token, `/dashboard/${matched.userId}`);
      }
    );
  }

  // ── Logout ──
  server.get('/auth/logout', async (_request, reply) => {
    clearCookieAndRedirect(reply, '/login');
  });

  // ── /auth/me — current user (JSON) ──
  server.get('/auth/me', async (request, reply) => {
    const user = getDashboardUser(request);
    if (!user) {
      reply.status(401).send({ error: 'Not authenticated' });
      return;
    }
    reply.send({ user });
  });

  if (anyEnabled) {
    logger.info('OAuth routes registered', {
      google: googleEnabled,
      microsoft: microsoftEnabled,
    });
  }
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

  ${googleEnabled ? `
  <a href="/auth/google" class="btn btn-google">
    <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
    Sign in with Google
  </a>` : ''}

  ${microsoftEnabled ? `
  <a href="/auth/microsoft" class="btn btn-microsoft">
    <svg viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
    Sign in with Microsoft
  </a>` : ''}

  ${!googleEnabled && !microsoftEnabled ? `
  <p style="color:var(--text-muted);margin-bottom:16px">OAuth not configured. Use API token below.</p>
  ` : `<div class="divider">or use API token</div>`}

  <div class="token-form">
    <input type="password" id="token-input" placeholder="Viewer token..." />
    <button onclick="loginWithToken()">Go</button>
  </div>
</div>

<script>
// Show error from query params
const params = new URLSearchParams(location.search);
const err = params.get('error');
if (err) {
  const el = document.getElementById('error');
  const msgs = {
    'google_denied': 'Google sign-in was cancelled.',
    'google_failed': 'Google sign-in failed. Please try again.',
    'microsoft_denied': 'Microsoft sign-in was cancelled.',
    'microsoft_failed': 'Microsoft sign-in failed. Please try again.',
    'no_match': 'No matching Slack account found for ' + (params.get('email') || 'this email') + '. Contact your admin.',
  };
  el.innerHTML = '<div class="error-msg">' + (msgs[err] || 'Authentication error.') + '</div>';
}

function loginWithToken() {
  const token = document.getElementById('token-input').value.trim();
  if (!token) return;
  // Store token and redirect — dashboard JS will use it
  document.cookie = '${COOKIE_NAME}=' + encodeURIComponent('bearer:' + token) + '; path=/; max-age=604800';
  location.href = '/dashboard';
}
</script>
</body>
</html>`;
}
