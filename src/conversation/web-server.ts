import type { IncomingHttpHeaders } from 'node:http';
import * as os from 'node:os';
import fastifyFormbody from '@fastify/formbody';
// Type-only: the plugin itself is registered by dashboard.ts via dynamic import.
import type { WebSocket } from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import * as jwt from 'jsonwebtoken';
import { isAdminUser } from '../admin-utils';
import { config } from '../config';
import { IS_DEV } from '../env-paths';
import { registerHookRoutes } from '../hooks';
import { Logger } from '../logger';
import { registerDashboardRoutes, setSelfInstanceEnv } from './dashboard';
import { removeHeartbeat, startHeartbeatLoop } from './instance-registry';
import { registerMemoryRoutes } from './memory-routes';
import {
  type AuthContext,
  exceedsAbsoluteSessionLifetime,
  getJwtSecret,
  hasOAuthStateCookie,
  loginReturnCookieFor,
  registerOAuthRoutes,
  validateCsrfToken,
  verifyDashboardTokenRaw,
} from './oauth';
import { registerProjectMemoryRoutes } from './project-memory-routes';
import {
  effectiveViewerUrl,
  getInstanceId,
  getPublicUrlStatus,
  INSTANCE_HEADER,
  isSecureViewerOrigin,
  startPublicUrlCheck,
  stopPublicUrlCheck,
} from './public-url';
import { getConversation, getTurnRawContent, listConversations } from './recorder';
import { registerSettingsRoutes } from './settings-routes';
import type { ConversationTurn } from './types';
import { renderConversationListPage, renderConversationViewPage } from './viewer';
import { registerWorkLogRoutes } from './work-log-routes';

const logger = new Logger('ConversationWebServer');

/**
 * Build AuthContext from request credentials.
 * Returns null if authentication fails entirely.
 * Auth precedence: bearer_header > oauth_jwt > bearer_cookie > none
 */
function buildAuthContext(request: FastifyRequest): AuthContext | null {
  const viewerToken = config.conversation.viewerToken;
  const hasOAuth = !!(config.oauth.google.clientId || config.oauth.microsoft.clientId || config.oauth.jwtSecret);

  // If no auth is configured at all, allow everyone
  if (!viewerToken && !hasOAuth) {
    return { mode: 'none', isAdmin: true };
  }

  // 1. Check Authorization header (Bearer token) — admin API access
  const authHeader = request.headers.authorization;
  if (authHeader && viewerToken) {
    const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (providedToken === viewerToken) {
      return { mode: 'bearer_header', isAdmin: true };
    }
  }

  // 2. Check JWT cookie (OAuth session)
  const cookieHeader = request.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/soma_dash_token=([^;]+)/);
  if (cookieMatch) {
    const cookieVal = decodeURIComponent(cookieMatch[1]);

    // 2a. Bearer-prefix cookie (token-based browser login)
    if (cookieVal.startsWith('bearer:') && viewerToken && cookieVal.slice(7) === viewerToken) {
      return { mode: 'bearer_cookie', isAdmin: true };
    }

    // 2b. JWT cookie (OAuth session)
    const payload = verifyDashboardTokenRaw(cookieVal);
    if (payload) {
      // Enforce absolute max lifetime — reject sessions that exceeded 4x expiry (min 30 days)
      if (exceedsAbsoluteSessionLifetime(payload)) {
        // Session exceeded absolute max — force re-login
        return null;
      }
      // OAuth-authenticated users inherit admin capability from
      // ADMIN_USERS env (#716). The dashboard further gates write
      // operations behind an explicit X-Admin-Mode: on header so the
      // admin's normal browsing stays in "safe mode" by default — but
      // the SERVER never trusts the header alone; it always re-checks
      // isAdminUser(sub) before allowing cross-user writes.
      return {
        mode: 'oauth_jwt',
        userId: payload.sub,
        email: payload.email,
        name: payload.name,
        isAdmin: isAdminUser(payload.sub),
      };
    }
  }

  // 3. If no viewer token configured but OAuth is, still reject
  if (!viewerToken && hasOAuth) return null;
  // If viewer token is set but nothing matched
  if (viewerToken) return null;

  return null;
}

const COOKIE_NAME = 'soma_dash_token';

/**
 * Check if JWT needs rotation and set refreshed cookie if so.
 * Rotation window: last 15% of configured expiry, capped at 24h.
 * Absolute max lifetime: 4x configured expiry, minimum 30 days.
 */
function maybeRotateJwt(request: FastifyRequest, reply: FastifyReply): void {
  const cookieHeader = request.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/soma_dash_token=([^;]+)/);
  if (!cookieMatch) return;

  const cookieVal = decodeURIComponent(cookieMatch[1]);
  if (cookieVal.startsWith('bearer:')) return; // Not a JWT

  const payload = verifyDashboardTokenRaw(cookieVal);
  if (!payload || !payload.iat || !payload.exp) return;

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = config.oauth.jwtExpiresIn;
  const refreshWindow = Math.min(Math.floor(expiresIn * 0.15), 86400); // 15% of expiry, max 24h
  const originalIat = payload.originalIat || payload.iat;

  // Force re-login if absolute max exceeded
  if (exceedsAbsoluteSessionLifetime(payload)) return;

  // Rotate if within refresh window
  const timeUntilExpiry = payload.exp - now;
  if (timeUntilExpiry > 0 && timeUntilExpiry <= refreshWindow) {
    const secret = getJwtSecret();
    if (!secret) return;
    const newPayload = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      provider: (payload as any).provider,
      originalIat,
    };
    const newToken = jwt.sign(newPayload, secret, { expiresIn });
    const secure = isSecureViewerOrigin();
    reply.header(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(newToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expiresIn}${secure ? '; Secure' : ''}`,
    );
    logger.debug('JWT rotated', { userId: payload.sub });
  }
}

/**
 * Auth middleware — builds AuthContext, handles JWT rotation.
 * API requests get 401 JSON on failure.
 * Browser requests get redirected to /login.
 */
async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authContext = buildAuthContext(request);
  if (!authContext) {
    const isApi = request.url.startsWith('/api/') || (request.headers.accept || '').includes('application/json');
    if (isApi) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Valid Authorization header required',
      });
    } else {
      // Remember a dashboard deep link so the next login lands on it (spec §3.4-3).
      const nextCookie = request.method === 'GET' ? loginReturnCookieFor(request.url) : undefined;
      if (nextCookie) reply.header('Set-Cookie', nextCookie);
      reply.redirect('/login');
    }
    return;
  }

  // Attach auth context
  (request as any).authContext = authContext;

  // Backward compat: also attach dashboardUser for existing code
  if (authContext.mode === 'oauth_jwt' && authContext.userId) {
    (request as any).dashboardUser = {
      slackUserId: authContext.userId,
      userId: authContext.userId,
      email: authContext.email,
      name: authContext.name,
    };
  }

  // JWT rotation
  if (authContext.mode === 'oauth_jwt') {
    maybeRotateJwt(request, reply);
  }
}

/**
 * CSRF middleware — validates X-CSRF-Token header for cookie-authenticated POST requests.
 * Skips for bearer_header auth (API clients).
 */
async function csrfMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Only validate on state-mutating methods
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) return;

  const authContext = (request as any).authContext as AuthContext | undefined;
  if (!authContext) return; // Will be caught by authMiddleware

  // Skip CSRF for bearer_header (API clients with Authorization header)
  if (authContext.mode === 'bearer_header' || authContext.mode === 'none') return;

  const csrfHeader = (request.headers['x-csrf-token'] || '') as string;
  const cookieHeader = request.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/soma_dash_token=([^;]+)/);

  let isValid = false;
  if (authContext.mode === 'oauth_jwt' && authContext.userId) {
    const payload = cookieMatch ? verifyDashboardTokenRaw(decodeURIComponent(cookieMatch[1])) : null;
    isValid = validateCsrfToken(csrfHeader, authContext.userId, payload?.exp, false);
  } else if (authContext.mode === 'bearer_cookie') {
    isValid = validateCsrfToken(csrfHeader, undefined, undefined, true);
  }

  if (!isValid) {
    reply.status(403).send({ error: 'CSRF token validation failed' });
    return;
  }
}

/**
 * Resource loader middleware factory (formerly `authorizeResource`).
 *
 * #716 changed conversation/dashboard reads to be world-readable for any
 * authenticated user, so this middleware no longer enforces ownership.
 * It just loads the resource (404 on miss) and attaches it to the
 * request — write routes use `requireWriteAccess` separately.
 *
 * The `getOwnerId` parameter is still accepted (and unused) so call
 * sites do not have to be touched in the same change as the policy
 * update; a follow-up cleanup may drop it.
 */
function authorizeResource<T>(
  loadResource: (request: FastifyRequest) => Promise<T | null>,
  _getOwnerId: (resource: T) => string,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authContext = (request as any).authContext as AuthContext | undefined;
    if (!authContext) return; // authMiddleware handles this

    const resource = await loadResource(request);
    if (!resource) {
      reply.status(404).send({ error: 'Not found' });
      return;
    }

    // Attach loaded resource to avoid double-fetch
    (request as any).authorizedResource = resource;
  };
}

/**
 * Read-only check for an X-Admin-Mode header.
 *
 * The server uses this together with `authContext.isAdmin` to decide
 * whether an admin's *currently active* session is in admin mode. The
 * header alone is not sufficient — `authContext.isAdmin` is rebuilt on
 * every request from `isAdminUser(sub)` against ADMIN_USERS env, so
 * non-admins cannot opt into write privileges by injecting the header.
 */
function isAdminModeHeaderOn(request: FastifyRequest): boolean {
  const v = request.headers['x-admin-mode'];
  if (Array.isArray(v)) return v[0] === 'on';
  return v === 'on';
}

/**
 * Authorize a write operation against a per-user resource (#716 policy).
 *
 *   - bearer_header / bearer_cookie (admin viewer token): always allowed.
 *   - oauth_jwt user, owns the resource (`ownerId === userId`): allowed.
 *   - oauth_jwt user, admin (in ADMIN_USERS) AND `X-Admin-Mode: on`
 *     header set: allowed for any owner.
 *   - everything else: 403.
 *
 * Returns true when the request may proceed, false after sending the 403
 * response (caller must early-return).
 */
function requireWriteAccess(request: FastifyRequest, reply: FastifyReply, ownerId: string | undefined): boolean {
  const authContext = (request as any).authContext as AuthContext | undefined;
  if (!authContext) {
    // authMiddleware should have already handled this; defensive 401.
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  // Bearer admin (viewer token) bypasses — it's a global admin credential.
  if (authContext.mode === 'bearer_header' || authContext.mode === 'bearer_cookie') return true;
  // Owner of the resource.
  if (authContext.userId && ownerId && authContext.userId === ownerId) return true;
  // OAuth admin in admin mode.
  if (authContext.isAdmin && isAdminModeHeaderOn(request)) return true;
  reply.status(403).send({
    error: 'Forbidden — write access requires session ownership, or admin user with X-Admin-Mode: on header (#716)',
  });
  return false;
}

export { requireWriteAccess };

let server: FastifyInstance | null = null;
let activePort: number | null = null;
/** True only between a successful listen() and stop/failure — links handed to Slack must resolve. */
let listening = false;
let heartbeatHandle: NodeJS.Timeout | null = null;
let heartbeatPort: number | null = null;

const DEFAULT_PORT_MAIN = 3000;
const DEFAULT_PORT_DEV = 33000;
const MAX_PORT_RETRIES = 10;

type InjectRequest = InjectOptions | string;
type InjectResponse = LightMyRequestResponse;

interface StartWebServerOptions {
  listen?: boolean;
}

/**
 * Get the viewer port from config (default: 3000 for main, 33000 for dev)
 */
function getPort(): number {
  return config.conversation.viewerPort || (IS_DEV ? DEFAULT_PORT_DEV : DEFAULT_PORT_MAIN);
}

/**
 * Resolve the host label for URLs emitted by the server when no explicit
 * `CONVERSATION_VIEWER_URL` is configured.
 *
 * `localhost` is the wrong default for links shared outside the process —
 * Slack sends the URL to a user who opens it on another device on the LAN,
 * so the link must resolve to the *host*, not the viewer's own machine.
 *
 * Priority:
 *   1. `config.conversation.viewerHost` when it's an externally meaningful
 *      bind address (not `127.0.0.1` / `localhost` / `0.0.0.0` which are
 *      bind-only tokens, not reachable hostnames).
 *   2. `os.hostname()` — the OS-reported short hostname, resolvable on the
 *      local network via DNS/mDNS.
 *   3. `localhost` as a last resort (matches prior behaviour for single-box
 *      dev where hostname resolution isn't available).
 */
function _resolveViewerHost(): string {
  const bound = config.conversation.viewerHost;
  if (bound && bound !== '127.0.0.1' && bound !== '0.0.0.0' && bound !== 'localhost') {
    return bound;
  }
  const hn = os.hostname();
  if (hn && hn !== 'localhost') return hn;
  return 'localhost';
}

/**
 * Get the public base URL for conversation viewer.
 *
 * `config.conversation.viewerUrl` (env `CONVERSATION_VIEWER_URL`) wins —
 * an explicit URL is the operator's intent and may include a scheme,
 * port, or reverse-proxy hostname that host-detection cannot infer —
 * unless the public URL check proved another server answers there and the
 * OAuth callback origin reaches this one (`effectiveViewerUrl`, public-url.ts).
 * Only when it's unset do we fall back to the detected hostname so that
 * links shared via Slack (e.g. the `dashboard` SSO URL, `/conversations`
 * links) are reachable from other devices on the network — `localhost`
 * would route the recipient's browser back to their own machine and
 * fail.
 */
export function getViewerBaseUrl(): string {
  const configured = effectiveViewerUrl();
  if (configured) return configured;
  const port = activePort || getPort();
  return `http://${_resolveViewerHost()}:${port}`;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

interface HostPort {
  hostname: string;
  port: string;
}

/**
 * Split a Host value (`name`, `name:port`, `[v6]`, `[v6]:port`) into a
 * lowercased hostname and port. A bare IPv6 literal (`::1`) has no port.
 */
function splitHost(value: string): HostPort {
  const host = value.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return { hostname: host, port: '' };
    const rest = host.slice(end + 1);
    return { hostname: host.slice(1, end), port: rest.startsWith(':') ? rest.slice(1) : '' };
  }
  const colon = host.indexOf(':');
  if (colon === -1 || colon !== host.lastIndexOf(':')) return { hostname: host, port: '' };
  return { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

/** The https origin browsers are sent to, or null when `url` is not https. */
function httpsCanonical(url: string): { origin: string; hostname: string; port: string } | null {
  if (!url) return null;
  let canonical: URL;
  try {
    canonical = new URL(url);
  } catch {
    return null;
  }
  if (canonical.protocol !== 'https:') return null;
  // URL.host omits the default port, and so do browsers in the Host header.
  const target = splitHost(canonical.host);
  return { origin: canonical.origin, hostname: target.hostname, port: target.port || '443' };
}

/**
 * Redirect browsers that reach the viewer on a non-canonical origin to the
 * https public URL links are minted on (`effectiveViewerUrl`: `viewerUrl`, or
 * the proven callback origin while `viewerUrl` reaches another server).
 *
 * Once that URL is https every auth cookie carries `Secure` (oauth.ts), and
 * a browser on plain `http://<host>:<port>` — the shape of links minted before
 * `viewerUrl` was set — never stores it, so login from an old Slack link fails
 * silently. Only GET/HEAD are redirected; loopback Hosts (health checks,
 * in-process callers), `/health` and WebSocket upgrades are left alone, and
 * nothing is redirected while that URL is not a valid https URL. The target is
 * resolved per request, so it follows the public URL check.
 */
function registerCanonicalOriginRedirect(instance: FastifyInstance): void {
  instance.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;
    // Origin-form only; anything else is not a path we can append to origin.
    if (!request.url.startsWith('/')) return;
    if (request.url.split('?')[0] === '/health') return;
    const upgrade = request.headers.upgrade;
    if (typeof upgrade === 'string' && upgrade.toLowerCase().includes('websocket')) return;
    const hostHeader = request.headers.host;
    if (!hostHeader) return;
    const target = httpsCanonical(effectiveViewerUrl());
    if (!target) return;
    // A sign-in that started on this origin finishes here: its state cookie is
    // host-only, and the public URL may have changed while the user was away.
    const callback = /^\/auth\/(google|microsoft)\/callback$/.exec(request.url.split('?')[0]);
    if (callback && hasOAuthStateCookie(request, callback[1])) return;

    const { hostname, port } = splitHost(hostHeader);
    if (LOOPBACK_HOSTNAMES.has(hostname)) return;
    if (hostname === target.hostname && (port || '443') === target.port) return;

    // 302, not 301: viewerUrl is ops config that may be rolled back, and browsers cache a 301 past that.
    return reply.redirect(`${target.origin}${request.url}`, 302);
  });
  const configured = httpsCanonical(config.conversation.viewerUrl || '');
  if (configured) logger.info(`Canonical-origin redirect enabled: ${configured.origin}`);
}

/**
 * Get the full URL for a specific conversation
 * @public — consumed dynamically via `import * as conversation` + `(conversation as any).getConversationUrl` in src/slack/session-manager.ts; knip cannot see that.
 */
export function getConversationUrl(conversationId: string): string {
  return `${getViewerBaseUrl()}/conversations/${conversationId}`;
}

/**
 * Deep link to one session's card on the owner's dashboard
 * (`/dashboard/<ownerId>?session=<sessionKey>`). Undefined unless the viewer is
 * actually listening — a Slack thread must not carry a dead link when the
 * viewer failed to start or has stopped — or when there is no owner or key.
 * @public — injected once in src/index.ts (`setThreadHeaderProviders`).
 */
export function getDashboardSessionUrl(ownerId: string, sessionKey: string): string | undefined {
  if (!listening || !ownerId || !sessionKey) return undefined;
  const base = getViewerBaseUrl().replace(/\/+$/, '');
  if (!base) return undefined;
  return `${base}/dashboard/${encodeURIComponent(ownerId)}?session=${encodeURIComponent(sessionKey)}`;
}

/**
 * Start the conversation viewer web server
 */
export async function startWebServer(options: StartWebServerOptions = {}): Promise<void> {
  if (server) {
    logger.warn('Web server already running');
    return;
  }

  server = Fastify({ logger: false });

  // Old `http://<host>:<port>` links → https viewerUrl, before any route runs.
  registerCanonicalOriginRedirect(server);

  // Required for HTML form POSTs (e.g. the SSO session-switch interstitial
  // at `POST /auth/sso/confirm`, #704). Fastify does not parse
  // application/x-www-form-urlencoded by default; without this plugin the
  // handler would receive an empty `request.body`.
  await server.register(fastifyFormbody);

  // ---- HTML Routes (require auth when token is configured) ----

  // Conversation list page
  server.get('/conversations', { preHandler: [authMiddleware] }, async (_request, reply) => {
    try {
      const conversations = await listConversations();
      const html = renderConversationListPage(conversations);
      reply.type('text/html; charset=utf-8').send(html);
    } catch (error) {
      logger.error('Error rendering conversation list', error);
      reply.status(500).send('Internal Server Error');
    }
  });

  // Conversation detail page
  server.get<{ Params: { id: string } }>(
    '/conversations/:id',
    {
      preHandler: [
        authMiddleware,
        authorizeResource(
          async (req: any) => getConversation(req.params.id),
          (conv: any) => conv.ownerId,
        ),
      ],
    },
    async (request, reply) => {
      try {
        const record = (request as any).authorizedResource || (await getConversation(request.params.id));
        if (!record) {
          reply.status(404).send('Conversation not found');
          return;
        }
        const html = renderConversationViewPage(record);
        reply.type('text/html; charset=utf-8').send(html);
      } catch (error) {
        logger.error('Error rendering conversation', error);
        reply.status(500).send('Internal Server Error');
      }
    },
  );

  // ---- JSON API Routes (require auth when token is configured) ----

  // List conversations (JSON)
  server.get('/api/conversations', { preHandler: [authMiddleware] }, async (_request, reply) => {
    try {
      const conversations = await listConversations();
      reply.send({ conversations });
    } catch (error) {
      logger.error('Error listing conversations API', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  // Get conversation detail (JSON)
  server.get<{ Params: { id: string } }>(
    '/api/conversations/:id',
    {
      preHandler: [
        authMiddleware,
        authorizeResource(
          async (req: any) => getConversation(req.params.id),
          (conv: any) => conv.ownerId,
        ),
      ],
    },
    async (request, reply) => {
      try {
        const record = (request as any).authorizedResource || (await getConversation(request.params.id));
        if (!record) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }

        // Return turns without rawContent (lazy load via separate endpoint)
        const turnsWithoutRaw = record.turns.map((t: ConversationTurn) => ({
          id: t.id,
          role: t.role,
          timestamp: t.timestamp,
          userName: t.userName,
          summaryTitle: t.summaryTitle,
          summaryBody: t.summaryBody,
          summarized: t.summarized,
          // Include rawContent only for user turns (they're short)
          rawContent: t.role === 'user' ? t.rawContent : undefined,
        }));

        reply.send({
          ...record,
          turns: turnsWithoutRaw,
        });
      } catch (error) {
        logger.error('Error getting conversation API', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Get raw content for a specific turn (lazy load)
  server.get<{ Params: { id: string; turnId: string } }>(
    '/api/conversations/:id/turns/:turnId/raw',
    {
      preHandler: [
        authMiddleware,
        authorizeResource(
          async (req: any) => getConversation(req.params.id),
          (conv: any) => conv.ownerId,
        ),
      ],
    },
    async (request, reply) => {
      try {
        const raw = await getTurnRawContent(request.params.id, request.params.turnId);
        if (raw === null) {
          reply.status(404).send({ error: 'Turn not found' });
          return;
        }
        reply.send({ raw });
      } catch (error) {
        logger.error('Error getting turn raw content', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Export selected turns as markdown
  server.post<{ Params: { id: string }; Body: { turnIds: string[] } }>(
    '/api/conversations/:id/export',
    {
      preHandler: [
        authMiddleware,
        csrfMiddleware,
        authorizeResource(
          async (req: any) => getConversation(req.params.id),
          (conv: any) => conv.ownerId,
        ),
      ],
    },
    async (request, reply) => {
      try {
        const record = (request as any).authorizedResource || (await getConversation(request.params.id));
        if (!record) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }

        const selectedIds = new Set(request.body.turnIds || []);
        const selectedTurns =
          selectedIds.size > 0 ? record.turns.filter((t: ConversationTurn) => selectedIds.has(t.id)) : record.turns;

        const markdown = generateMarkdownExport(record.title, record.ownerName, selectedTurns);
        reply.type('text/markdown; charset=utf-8').send(markdown);
      } catch (error) {
        logger.error('Error exporting conversation', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ---- OAuth Routes (public — no auth required) ----
  await registerOAuthRoutes(server);

  // ---- Dashboard Routes ----
  await registerDashboardRoutes(server, authMiddleware, csrfMiddleware);
  await registerWorkLogRoutes(server, authMiddleware);
  // Personal settings (SSOT 2026-10-23 T2) — self only, auth + CSRF on writes.
  registerSettingsRoutes(server, authMiddleware, csrfMiddleware);
  // Personal memory — the settings page "기억" tab (SSOT 2026-10-23 T3).
  registerMemoryRoutes(server, authMiddleware, csrfMiddleware);
  // Shared project memory — read: any signed-in user; write: admin (SSOT 2026-10-23 T4).
  registerProjectMemoryRoutes(server, authMiddleware, csrfMiddleware, (request, reply) =>
    requireWriteAccess(request, reply, undefined),
  );

  // Health check
  server.get('/health', async (_request, reply) => {
    // The id lets this instance recognise itself behind its public URL (public-url.ts).
    reply.header(INSTANCE_HEADER, getInstanceId());
    reply.send({ status: 'ok', service: 'conversation-viewer', publicUrl: getPublicUrlStatus() });
  });

  // Hook routes (no auth — localhost only)
  await registerHookRoutes(server);

  // Root redirect
  server.get('/', async (_request, reply) => {
    reply.redirect('/dashboard');
  });

  if (options.listen === false) {
    await server.ready();
    logger.info('Conversation viewer initialized without network listener');
    return;
  }

  // Start listening — bind to localhost by default for security
  // Retry with port+1 on EADDRINUSE
  const basePort = getPort();
  const host = config.conversation.viewerHost;
  for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
    const port = basePort + attempt;
    try {
      await server.listen({ port, host });
      activePort = port;
      listening = true;
      logger.info(`Conversation viewer started on ${host}:${port}`);
      logger.info(`View at: ${getViewerBaseUrl()}/conversations`);
      if (config.conversation.viewerToken) {
        logger.info('Authentication enabled (CONVERSATION_VIEWER_TOKEN set)');
      } else {
        logger.warn('Authentication disabled (CONVERSATION_VIEWER_TOKEN not set)');
      }

      // #814 Multi-instance discovery: write a heartbeat so other soma-work
      // instances on this host can find us. Resolve `instanceName` here
      // (after `activePort` is final) because the fallback shape is
      // `${hostname}:${port}` and the operator-supplied
      // `INSTANCE_NAME` (config.conversation.instanceName) wins. The host
      // label uses the same resolver as the viewer URL so siblings can
      // reach us — `127.0.0.1` is fine for same-machine aggregation.
      const resolvedInstanceName =
        config.conversation.instanceName?.trim() || `${os.hostname() || 'localhost'}:${port}`;
      const heartbeatHost = host && host !== '0.0.0.0' ? host : '127.0.0.1';
      // `startHeartbeatLoop` returns synchronously — it kicks off the
      // first write as a fire-and-forget promise (logged-and-eaten in
      // instance-registry on failure). No try/catch needed here; a
      // permanent fs problem surfaces as a per-tick warn from the loop
      // itself, and `setSelfInstanceEnv` runs unconditionally so the
      // dashboard handler can still serve the self board.
      heartbeatHandle = startHeartbeatLoop({
        port,
        instanceName: resolvedInstanceName,
        host: heartbeatHost,
        pid: process.pid,
      });
      heartbeatPort = port;
      // Hand the resolved env to the dashboard so the aggregator can stamp
      // self cards and the handler can fan out to siblings.
      setSelfInstanceEnv({ instanceName: resolvedInstanceName, port, host: heartbeatHost });

      // Confirm the public URL reaches this instance, now and periodically.
      startPublicUrlCheck();

      return;
    } catch (error) {
      listening = false;
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && attempt < MAX_PORT_RETRIES - 1) {
        logger.warn(`Port ${port} in use, trying ${port + 1}...`);
        continue;
      }
      logger.error('Failed to start conversation web server', error);
      throw error;
    }
  }
}

/**
 * Stop the web server
 */
export async function stopWebServer(): Promise<void> {
  // Stop handing out dashboard links before the listener goes away.
  listening = false;
  stopPublicUrlCheck();
  if (server) {
    // Flush hook state before closing
    try {
      const { hookState } = await import('../hooks');
      hookState.flushSync();
    } catch {
      // Hook module may not be loaded
    }
    // #814 Stop the heartbeat loop and remove our registry entry before
    // tearing down the server so siblings stop trying to fan out to us
    // mid-shutdown.
    if (heartbeatHandle) {
      clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
    if (heartbeatPort != null) {
      try {
        await removeHeartbeat(heartbeatPort);
      } catch (err) {
        logger.warn('Failed to remove heartbeat on shutdown', err);
      }
      heartbeatPort = null;
    }
    await server.close();
    server = null;
    activePort = null;
    logger.info('Conversation web server stopped');
  }
}

/**
 * Inject an in-process HTTP request (for tests and internal callers)
 */
export async function injectWebServer(request: InjectRequest): Promise<InjectResponse> {
  if (!server) {
    throw new Error('Conversation web server is not running');
  }

  return server.inject(request);
}

/**
 * Open an in-process WebSocket (for tests) through `@fastify/websocket`'s
 * `injectWS`, so upgrade requests run the same route + auth preHandler as a
 * real browser. `onInit` sees the socket before it opens — attach `message`
 * listeners there to catch the initial frames.
 */
export async function injectWebServerWS(
  path: string,
  upgradeContext: { headers?: IncomingHttpHeaders } = {},
  onInit?: (ws: WebSocket) => void,
): Promise<WebSocket> {
  if (!server) {
    throw new Error('Conversation web server is not running');
  }
  // Decorated only when dashboard.ts managed to register @fastify/websocket.
  if (typeof server.injectWS !== 'function') {
    throw new Error('WebSocket support is not registered');
  }
  return server.injectWS(path, upgradeContext, onInit ? { onInit } : {});
}

/**
 * Generate markdown export from selected turns
 */
function generateMarkdownExport(title: string | undefined, ownerName: string, turns: ConversationTurn[]): string {
  const lines: string[] = [];

  lines.push(`# ${title || 'Conversation'}`);
  lines.push(`> Owner: ${ownerName}`);
  lines.push(`> Exported: ${new Date().toISOString()}`);
  lines.push('');

  for (const turn of turns) {
    const time = new Date(turn.timestamp).toISOString();
    if (turn.role === 'user') {
      lines.push(`## 👤 ${turn.userName || 'User'} (${time})`);
      lines.push('');
      lines.push(turn.rawContent);
    } else {
      lines.push(`## 🤖 Assistant (${time})`);
      lines.push('');
      lines.push(turn.rawContent);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
