/**
 * User media API — the files a user attached to an instruction (SSOT
 * 2026-10-25), for the dashboard's turn tiles, card row, pinned row and viewer.
 *
 *   GET /api/dashboard/session/:conversationId/media
 *     → 200 { media: SessionMediaItem[] }   (every attachment of the user turns, oldest first)
 *   GET /api/dashboard/session/:conversationId/media/:mediaId/content[?download=1]
 *     → 200 the kept copy, or 206 for `Range: bytes=…`
 *     → 404 an id that is on no user turn, has no kept copy, or an unsafe id; 416 bad range
 *
 * The id is looked up in the conversation's user turns (the turn is the index,
 * user-media.ts); the bytes come from the store only once that turn was saved.
 *
 * Who may read — decided, not inherited by accident: any signed-in dashboard
 * user, the rule of the turns APIs (#716). An attachment is part of the user's
 * instruction, whose text `GET /api/dashboard/session/:id` already serves to
 * the same audience; the file adds no new reader.
 *
 * A user upload never runs. Unlike a model artifact (artifact-routes.ts, where
 * an html report may run scripts in an opaque origin), every document-like
 * upload — html, svg, markdown, text — is served with USER_MEDIA_CSP: sandboxed
 * with no scripts and nothing loaded, even when opened directly in a tab.
 * nosniff everywhere; the content type comes from the kind table, not from Slack.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../logger';
import { sendStoredFile } from './artifact-routes';
import { getConversation } from './recorder';
import { findSessionMedia, getUserMediaStore, listSessionMedia, type UserMediaStore } from './user-media';

const logger = new Logger('UserMediaRoutes');

/** No scripts, no plugins, nothing fetched, no frames, forms or base — a document to read, nothing more. */
export const USER_MEDIA_CSP =
  "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-src 'none'; form-action 'none'; base-uri 'none'";

export async function registerUserMediaRoutes(
  server: FastifyInstance,
  authMiddleware: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  storeOverride?: UserMediaStore,
): Promise<void> {
  const store = () => storeOverride ?? getUserMediaStore();

  server.get<{ Params: { conversationId: string } }>(
    '/api/dashboard/session/:conversationId/media',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        reply.header('Cache-Control', 'no-store');
        const record = await getConversation(request.params.conversationId);
        reply.send({ media: listSessionMedia(record) });
      } catch (error) {
        logger.error('Error listing user media', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.get<{ Params: { conversationId: string; mediaId: string }; Querystring: { download?: string } }>(
    '/api/dashboard/session/:conversationId/media/:mediaId/content',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const { conversationId, mediaId } = request.params;
        const record = await getConversation(conversationId);
        const item = findSessionMedia(record, mediaId);
        const file = item?.stored ? store().contentPath(conversationId, mediaId) : null;
        if (!item || !file) {
          reply.status(404).send({ error: 'not_found' });
          return;
        }
        reply.header('Cross-Origin-Resource-Policy', 'same-origin');
        return sendStoredFile(request, reply, file, item, { active: false, inertCsp: USER_MEDIA_CSP });
      } catch (error) {
        logger.error('Error serving user media', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );
}
