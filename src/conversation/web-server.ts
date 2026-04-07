import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import * as jwt from 'jsonwebtoken';
import { config } from '../config';
import { IS_DEV } from '../env-paths';
import { Logger } from '../logger';
import { registerDashboardRoutes } from './dashboard';
import {
  type AuthContext,
  generateCsrfToken,
  generateCsrfTokenForAdmin,
  getDashboardUser,
  getJwtSecret,
  registerOAuthRoutes,
  validateCsrfToken,
  verifyDashboardTokenRaw,
} from './oauth';
import { getConversation, getTurnRawContent, listConversations } from './recorder';
import type { ConversationTurn } from './types';
import { renderConversationListPage, renderConversationViewPage } from './viewer';

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
      const originalIat = (payload as any).originalIat || payload.iat;
      const expiresIn = config.oauth.jwtExpiresIn;
      const absoluteMax = Math.max(expiresIn * 4, 30 * 86400);
      const now = Math.floor(Date.now() / 1000);
      if (now - originalIat > absoluteMax) {
        // Session exceeded absolute max — force re-login
        return null;
      }
      return {
        mode: 'oauth_jwt',
        userId: payload.sub,
        email: payload.email,
        name: payload.name,
        isAdmin: false,
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
  const absoluteMax = Math.max(expiresIn * 4, 30 * 86400); // 4x expiry, min 30 days
  const originalIat = (payload as any).originalIat || payload.iat;

  // Force re-login if absolute max exceeded
  if (now - originalIat > absoluteMax) return;

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
    const secure = (config.conversation.viewerUrl || '').startsWith('https');
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
 * Resource authorization middleware factory.
 * Loads a resource, checks ownership, attaches to request.
 */
function authorizeResource<T>(
  loadResource: (request: FastifyRequest) => Promise<T | null>,
  getOwnerId: (resource: T) => string,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authContext = (request as any).authContext as AuthContext | undefined;
    if (!authContext) return; // authMiddleware handles this

    // Admin bypass
    if (authContext.isAdmin) return;

    const resource = await loadResource(request);
    if (!resource) {
      reply.status(404).send({ error: 'Not found' });
      return;
    }

    if (!authContext.userId || getOwnerId(resource) !== authContext.userId) {
      reply.status(403).send({ error: 'Forbidden — you can only access your own resources' });
      return;
    }

    // Attach loaded resource to avoid double-fetch
    (request as any).authorizedResource = resource;
  };
}

export { authMiddleware, authorizeResource, csrfMiddleware };

let server: FastifyInstance | null = null;
let activePort: number | null = null;

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
 * Get the public base URL for conversation viewer
 */
export function getViewerBaseUrl(): string {
  return config.conversation.viewerUrl || `http://localhost:${activePort || getPort()}`;
}

/**
 * Get the full URL for a specific conversation
 */
export function getConversationUrl(conversationId: string): string {
  return `${getViewerBaseUrl()}/conversations/${conversationId}`;
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

  // Health check
  server.get('/health', async (_request, reply) => {
    reply.send({ status: 'ok', service: 'conversation-viewer' });
  });

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
      logger.info(`Conversation viewer started on ${host}:${port}`);
      logger.info(`View at: ${getViewerBaseUrl()}/conversations`);
      if (config.conversation.viewerToken) {
        logger.info('Authentication enabled (CONVERSATION_VIEWER_TOKEN set)');
      } else {
        logger.warn('Authentication disabled (CONVERSATION_VIEWER_TOKEN not set)');
      }
      return;
    } catch (error) {
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
  if (server) {
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
