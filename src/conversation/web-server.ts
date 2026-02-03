import Fastify, { FastifyInstance } from 'fastify';
import { Logger } from '../logger';
import { config } from '../config';
import { IS_DEV } from '../env-paths';
import { getConversation, listConversations, getTurnRawContent } from './recorder';
import { renderConversationListPage, renderConversationViewPage } from './viewer';
import { ConversationTurn } from './types';

const logger = new Logger('ConversationWebServer');

let server: FastifyInstance | null = null;
let activePort: number | null = null;

const DEFAULT_PORT_MAIN = 3000;
const DEFAULT_PORT_DEV = 33000;
const MAX_PORT_RETRIES = 10;

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
export async function startWebServer(): Promise<void> {
  if (server) {
    logger.warn('Web server already running');
    return;
  }

  server = Fastify({ logger: false });

  // ---- HTML Routes ----

  // Conversation list page
  server.get('/conversations', async (_request, reply) => {
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
  server.get<{ Params: { id: string } }>('/conversations/:id', async (request, reply) => {
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
  });

  // ---- JSON API Routes ----

  // List conversations (JSON)
  server.get('/api/conversations', async (_request, reply) => {
    try {
      const conversations = await listConversations();
      reply.send({ conversations });
    } catch (error) {
      logger.error('Error listing conversations API', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  // Get conversation detail (JSON)
  server.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
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
  });

  // Get raw content for a specific turn (lazy load)
  server.get<{ Params: { id: string; turnId: string } }>(
    '/api/conversations/:id/turns/:turnId/raw',
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
    }
  );

  // Export selected turns as markdown
  server.post<{ Params: { id: string }; Body: { turnIds: string[] } }>(
    '/api/conversations/:id/export',
    async (request, reply) => {
      try {
        const record = await getConversation(request.params.id);
        if (!record) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }

        const selectedIds = new Set(request.body.turnIds || []);
        const selectedTurns = selectedIds.size > 0
          ? record.turns.filter(t => selectedIds.has(t.id))
          : record.turns;

        const markdown = generateMarkdownExport(record.title, record.ownerName, selectedTurns);
        reply.type('text/markdown; charset=utf-8').send(markdown);
      } catch (error) {
        logger.error('Error exporting conversation', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // Health check
  server.get('/health', async (_request, reply) => {
    reply.send({ status: 'ok', service: 'conversation-viewer' });
  });

  // Root redirect
  server.get('/', async (_request, reply) => {
    reply.redirect('/conversations');
  });

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
    logger.info('Conversation web server stopped');
  }
}

/**
 * Generate markdown export from selected turns
 */
function generateMarkdownExport(
  title: string | undefined,
  ownerName: string,
  turns: ConversationTurn[]
): string {
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
