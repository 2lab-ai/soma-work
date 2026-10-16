/**
 * Work log API (spec §3.3).
 *
 *   GET /api/dashboard/session/:conversationId/worklog?afterSeq=&limit=
 *     → 200 { entries: WorkLogEntry[], hasMore: boolean }
 *
 *   - no afterSeq: the latest `limit` entries; hasMore = older entries exist.
 *   - afterSeq=N (N ≥ 0): the first `limit` entries with seq > N, for forward
 *     paging after a reconnect; hasMore = more follow, ask again with the last seq.
 *     seqs can have two kinds of gaps in what a live client saw:
 *       - landed but unpublished (the line reached disk, its append failed
 *         afterwards, so no `work_log` event was sent): this call returns
 *         those entries normally — backfill them here;
 *       - holes (seqs skipped on purpose: every server restart resumes at the
 *         durable reservation, a failed append that never landed, a
 *         quarantine, a backup recovery): no entry will ever carry them — do
 *         not wait for them.
 *   - limit: default 500, allowed 1..500.
 *   - Both params are decimal integers (`^\d+$`); anything else is
 *     400 { error: 'bad_request' } rather than a silent mode switch.
 *   - hasMore is also true when the read stopped at its byte budget.
 *
 * Who may read: the conversation's owner and admins — the same audience as the
 * `work_log` WS event. This is stricter than the turns APIs (world-readable per
 * #716) because the work log carries raw instructions and tool inputs/results.
 * Admin = `authContext.isAdmin` (viewer-token sessions, auth-disabled mode, and
 * OAuth users listed in ADMIN_USERS). A conversation with no recorded owner is
 * admin-only. Unknown conversation → 404, anyone else → 403 { error: 'forbidden' }.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../logger';
import type { AuthContext } from './oauth';
import { getConversation } from './recorder';
import { readWorkLog, WORK_LOG_DEFAULT_LIMIT } from './work-log';

const logger = new Logger('WorkLogRoutes');

const DECIMAL = /^\d+$/;

/** Absent → undefined; present must be a decimal safe integer within [min, max], else null. */
function parseStrictInt(raw: unknown, min: number, max: number): number | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !DECIMAL.test(raw)) return null; // also rejects repeated params (arrays)
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

function canReadWorkLog(auth: AuthContext | undefined, ownerId: string | undefined): boolean {
  if (!auth) return false;
  if (auth.isAdmin) return true;
  return !!ownerId && auth.userId === ownerId;
}

export async function registerWorkLogRoutes(
  server: FastifyInstance,
  authMiddleware: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): Promise<void> {
  server.get<{
    Params: { conversationId: string };
    Querystring: { afterSeq?: string; limit?: string };
  }>('/api/dashboard/session/:conversationId/worklog', { preHandler: [authMiddleware] }, async (request, reply) => {
    try {
      const limit = parseStrictInt(request.query.limit, 1, WORK_LOG_DEFAULT_LIMIT);
      const afterSeq = parseStrictInt(request.query.afterSeq, 0, Number.MAX_SAFE_INTEGER);
      if (limit === null || afterSeq === null) {
        reply.status(400).send({ error: 'bad_request' });
        return;
      }

      const { conversationId } = request.params;
      const record = await getConversation(conversationId);
      if (!record) {
        reply.status(404).send({ error: 'Conversation not found' });
        return;
      }
      const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext;
      if (!canReadWorkLog(auth, record.ownerId || undefined)) {
        reply.status(403).send({ error: 'forbidden' });
        return;
      }

      const { entries, hasMore } = await readWorkLog(conversationId, {
        afterSeq,
        limit: limit ?? WORK_LOG_DEFAULT_LIMIT,
      });
      reply.send({ entries, hasMore });
    } catch (error) {
      logger.error('Error reading work log', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });
}
