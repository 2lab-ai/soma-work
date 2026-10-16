/**
 * Work log API (spec §3.3).
 *
 *   GET /api/dashboard/session/:conversationId/worklog?afterSeq=&limit=  → { entries: WorkLogEntry[] }
 *
 * Same auth and read scope as the session-turns API
 * (`GET /api/dashboard/session/:conversationId` in dashboard.ts): any
 * authenticated user may read (#716), unknown conversations are 404. Live
 * entries arrive over `/ws/dashboard` as `work_log` events.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../logger';
import { getConversation } from './recorder';
import { readWorkLog, WORK_LOG_DEFAULT_LIMIT } from './work-log';

const logger = new Logger('WorkLogRoutes');

function parseIntParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
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
      const { conversationId } = request.params;
      const record = await getConversation(conversationId);
      if (!record) {
        reply.status(404).send({ error: 'Conversation not found' });
        return;
      }

      const limitRaw = parseIntParam(request.query.limit);
      const limit =
        limitRaw === undefined ? WORK_LOG_DEFAULT_LIMIT : Math.max(1, Math.min(WORK_LOG_DEFAULT_LIMIT, limitRaw));
      const afterSeqRaw = parseIntParam(request.query.afterSeq);
      const afterSeq = afterSeqRaw !== undefined && afterSeqRaw > 0 ? afterSeqRaw : undefined;

      const entries = await readWorkLog(conversationId, { afterSeq, limit });
      reply.send({ entries });
    } catch (error) {
      logger.error('Error reading work log', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });
}
