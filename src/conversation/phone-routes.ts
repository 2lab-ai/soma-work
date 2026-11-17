/**
 * Phone call API for the dashboard (.prd/31-phone-calls-architecture.md §5).
 *
 *   GET /api/dashboard/session/:conversationId/phone-calls           → { calls: PhoneCallSummary[] }
 *   GET /api/dashboard/session/:conversationId/phone-calls/:callId   → { call: PhoneCallRecord }
 *   GET /api/dashboard/phone-calls/:callId                           → { call: PhoneCallRecord }  (calls with no conversation)
 *
 * Who may read: like the work log (work-log-routes.ts) — a call's transcript is a person's words. The
 * conversation's owner and admins read the conversation's calls; the call's requester (the environment owner for an
 * inbound call) and admins read a call by id. The private-task gate (`installPrivateTaskGate`) also guards the
 * `/api/dashboard/session/:conversationId/…` routes. Every answer is `no-store`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../logger';
import { isCallId, type PhoneCallRecord, type PhoneCallStore, summarizeCall } from '../phone/call-store';
import type { AuthContext } from './oauth';
import { getConversation } from './recorder';

const logger = new Logger('PhoneRoutes');

function authOf(request: FastifyRequest): AuthContext | undefined {
  return (request as FastifyRequest & { authContext?: AuthContext }).authContext;
}

/** Owner of the conversation, the call's requester, or an admin. */
export function canReadCall(
  auth: AuthContext | undefined,
  record: PhoneCallRecord,
  conversationOwner?: string,
): boolean {
  if (!auth) return false;
  if (auth.isAdmin) return true;
  if (!auth.userId) return false;
  return auth.userId === record.requester || (!!conversationOwner && auth.userId === conversationOwner);
}

export async function registerPhoneRoutes(
  server: FastifyInstance,
  authMiddleware: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  getStore: () => PhoneCallStore,
): Promise<void> {
  server.get<{ Params: { conversationId: string } }>(
    '/api/dashboard/session/:conversationId/phone-calls',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const { conversationId } = request.params;
        const conv = await getConversation(conversationId);
        if (!conv) return reply.status(404).send({ error: 'Conversation not found' });
        const auth = authOf(request);
        const calls = getStore()
          .list({ conversationId })
          .filter((c) => canReadCall(auth, c, conv.ownerId || undefined))
          .map(summarizeCall);
        return reply.send({ calls });
      } catch (error) {
        logger.error('Error listing phone calls', error);
        return reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.get<{ Params: { conversationId: string; callId: string } }>(
    '/api/dashboard/session/:conversationId/phone-calls/:callId',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const { conversationId, callId } = request.params;
        if (!isCallId(callId)) return reply.status(400).send({ error: 'bad_request' });
        const conv = await getConversation(conversationId);
        const record = getStore().get(callId);
        if (!conv || !record || record.conversationId !== conversationId)
          return reply.status(404).send({ error: 'not_found' });
        if (!canReadCall(authOf(request), record, conv.ownerId || undefined))
          return reply.status(403).send({ error: 'forbidden' });
        return reply.send({ call: record });
      } catch (error) {
        logger.error('Error reading phone call', error);
        return reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.get<{ Params: { callId: string } }>(
    '/api/dashboard/phone-calls/:callId',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const { callId } = request.params;
        if (!isCallId(callId)) return reply.status(400).send({ error: 'bad_request' });
        const record = getStore().get(callId);
        if (!record) return reply.status(404).send({ error: 'not_found' });
        let owner: string | undefined;
        if (record.conversationId) owner = (await getConversation(record.conversationId))?.ownerId || undefined;
        // A call in a conversation someone may not see answers 404, not 403: its existence is not theirs to know.
        if (!canReadCall(authOf(request), record, owner)) return reply.status(404).send({ error: 'not_found' });
        return reply.send({ call: record });
      } catch (error) {
        logger.error('Error reading phone call', error);
        return reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );
}
