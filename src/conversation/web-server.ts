import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { config } from '../config';
import { IS_DEV } from '../env-paths';
import { Logger } from '../logger';
import { registerDashboardRoutes } from './dashboard';
import { getDashboardUser, registerOAuthRoutes } from './oauth';
import { getConversation, getTurnRawContent, listConversations } from './recorder';
import type { ConversationTurn } from './types';
import { renderConversationListPage, renderConversationViewPage } from './viewer';

const logger = new Logger('ConversationWebServer');

/**
 * Validate authentication from:
 * 1. Authorization header (Bearer token) — for API clients
 * 2. JWT cookie — for browser sessions (OAuth or token-based login)
 * 3. Cookie with "bearer:" prefix — for token-based browser login
 */
function validateAuthToken(request: FastifyRequest): boolean {
  const token = config.conversation.viewerToken;

  // If no token is configured and no OAuth is configured, auth is disabled (allow all)
  if (!token && !config.oauth.google.clientId && !config.oauth.microsoft.clientId && !config.oauth.jwtSecret) {
    return true;
  }

  // 1. Check Authorization header (Bearer token)
  const authHeader = request.headers.authorization;
  if (authHeader && token) {
    const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (providedToken === token) return true;
  }

  // 2. Check JWT cookie (OAuth session)
  const dashUser = getDashboardUser(request);
  if (dashUser) return true;

  // 3. Check cookie with bearer: prefix (token-based browser login)
  const cookieHeader = request.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/soma_dash_token=([^;]+)/);
  if (cookieMatch) {
    const cookieVal = decodeURIComponent(cookieMatch[1]);
    if (cookieVal.startsWith('bearer:') && token && cookieVal.slice(7) === token) {
      return true;
    }
  }

  // If no auth configured at all, allow
  if (!token) return true;

  return false;
}

/**
 * Auth middleware - applied to routes that require authentication.
 * API requests (Accept: application/json or /api/ paths) get 401 JSON.
 * Browser requests get redirected to /login.
 */
async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!validateAuthToken(request)) {
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
  // Attach OAuth user info to request for downstream use
  const dashUser = getDashboardUser(request);
  if (dashUser) {
    (request as any).dashboardUser = dashUser;
  }
}

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
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const record = await getConversation(request.params.id);
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
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const record = await getConversation(request.params.id);
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
    { preHandler: [authMiddleware] },
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
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const record = await getConversation(request.params.id);
        if (!record) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }

        const selectedIds = new Set(request.body.turnIds || []);
        const selectedTurns = selectedIds.size > 0 ? record.turns.filter((t) => selectedIds.has(t.id)) : record.turns;

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
  await registerDashboardRoutes(server, authMiddleware);

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
    } catch (error: any) {
      if (error.code === 'EADDRINUSE' && attempt < MAX_PORT_RETRIES - 1) {
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
