/**
 * Code changes API (.prd/26, .prd/27 §6) — what a work session did to code, for the detail card's 변경점 tab.
 *
 *   GET /api/dashboard/session/:conversationId/changes[?refresh=1]
 *     → 200 { doc: CodeChangesDoc without patches | null, live: boolean }
 *       refresh=1: a live session of the conversation is collected first (waiting up to 20 s) — `live` says one was.
 *   GET /api/dashboard/session/:conversationId/changes/file?repo=<repo>&path=<path>
 *     → 200 { repo, path, updatedAt, sources: [{ layer, label, prUrl?, prNumber?, file }] } — every layer's patch of one
 *       file, and the collect it is from
 *     → 404 { error: 'not_found' } when no layer has it
 *
 * Who may read: the work log's rule (work-log-routes.ts) — the conversation's recorded owner and admins. The patches are
 * source code, and the board goes to every signed-in viewer. Unknown conversation → 404, anyone else → 403. Every
 * answer carries no-store.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fileSources, listView } from '../code-changes/collector';
import { getCodeChangesStore, isStoreKey } from '../code-changes/store';
import { Logger } from '../logger';
import type { AuthContext } from './oauth';
import { getConversation } from './recorder';

const logger = new Logger('CodeChangesRoutes');

type Refresher = (conversationId: string) => Promise<boolean>;
let refresher: Refresher | undefined;

/** The host's "collect this conversation's live session now" (index.ts). */
export function setCodeChangesRefresher(fn: Refresher | undefined): void {
  refresher = fn;
}

function canRead(auth: AuthContext | undefined, ownerId: string | undefined): boolean {
  if (!auth) return false;
  if (auth.isAdmin) return true;
  return !!ownerId && auth.userId === ownerId;
}

const MAX_PARAM = 2048;

export async function registerCodeChangesRoutes(
  server: FastifyInstance,
  authMiddleware: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): Promise<void> {
  const noStore = async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  };

  /** 404 / 403 answered here; the conversation id when the viewer may read it. */
  async function readable(request: FastifyRequest, reply: FastifyReply, conversationId: string): Promise<boolean> {
    if (!isStoreKey(conversationId)) {
      reply.status(404).send({ error: 'Conversation not found' });
      return false;
    }
    const record = await getConversation(conversationId);
    if (!record) {
      reply.status(404).send({ error: 'Conversation not found' });
      return false;
    }
    const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext;
    if (!canRead(auth, record.ownerId || undefined)) {
      reply.status(403).send({ error: 'forbidden' });
      return false;
    }
    return true;
  }

  server.get<{ Params: { conversationId: string }; Querystring: { refresh?: string } }>(
    '/api/dashboard/session/:conversationId/changes',
    { onSend: noStore, preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const { conversationId } = request.params;
        if (!(await readable(request, reply, conversationId))) return;
        let live = false;
        if (request.query.refresh === '1' && refresher) live = await refresher(conversationId).catch(() => false);
        const doc = getCodeChangesStore().read(conversationId);
        reply.send({ doc: doc ? listView(doc) : null, live });
      } catch (error) {
        logger.error('Error reading code changes', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.get<{ Params: { conversationId: string }; Querystring: { repo?: string; path?: string } }>(
    '/api/dashboard/session/:conversationId/changes/file',
    { onSend: noStore, preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const { repo, path } = request.query;
        if (
          typeof repo !== 'string' ||
          typeof path !== 'string' ||
          !repo ||
          !path ||
          repo.length > MAX_PARAM ||
          path.length > MAX_PARAM
        ) {
          reply.status(400).send({ error: 'bad_request' });
          return;
        }
        const { conversationId } = request.params;
        if (!(await readable(request, reply, conversationId))) return;
        const doc = getCodeChangesStore().read(conversationId);
        const sources = doc ? fileSources(doc, repo, path) : [];
        if (sources.length === 0) {
          reply.status(404).send({ error: 'not_found' });
          return;
        }
        // The collect these layers come from: the tab drops an answer of a collect other than the one it lists.
        reply.send({ repo, path, updatedAt: doc?.updatedAt, sources });
      } catch (error) {
        logger.error('Error reading a changed file', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );
}
