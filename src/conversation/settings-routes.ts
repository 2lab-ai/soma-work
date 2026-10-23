/**
 * Personal settings HTTP surface (SSOT 2026-10-23 T2).
 *
 *   GET   /api/settings        the signed-in user's settings (registry snapshot)
 *   PATCH /api/settings/:key   { value } — one setting; answers with the fresh row
 *
 * Self only: the user is `authContext.userId` (the Slack id in the OAuth JWT),
 * never a query or body field. A viewer-token request has no Slack user and is
 * refused. Every write passes auth + CSRF — registered once for the group so
 * a new write route cannot forget it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../logger';
import { SettingsError, type SettingsRegistry } from '../user-settings-registry';

const logger = new Logger('SettingsRoutes');

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

let _registry: SettingsRegistry | null = null;

/** Wire the production registry (`src/index.ts`) or a test double. */
export function setSettingsRegistry(registry: SettingsRegistry | null): void {
  _registry = registry;
}

/** The signed-in Slack user, or null after sending the refusal. */
export function requireSelfUser(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as { authContext?: { userId?: string } }).authContext?.userId;
  if (!userId) {
    reply.status(400).send({ error: 'Slack 계정으로 로그인한 사용자만 개인 설정과 기억을 볼 수 있습니다' });
    return null;
  }
  return userId;
}

export function registerSettingsRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  csrfMiddleware?: Middleware,
): void {
  const read = { preHandler: [authMiddleware] };
  const write = { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] };

  server.get('/api/settings', read, async (request, reply) => {
    const userId = requireSelfUser(request, reply);
    if (!userId) return;
    if (!_registry) {
      reply.status(503).send({ error: 'Settings are not available on this instance' });
      return;
    }
    reply.send(_registry.read(userId));
  });

  server.patch<{ Params: { key: string }; Body: { value?: unknown } }>(
    '/api/settings/:key',
    write,
    async (request, reply) => {
      const userId = requireSelfUser(request, reply);
      if (!userId) return;
      if (!_registry) {
        reply.status(503).send({ error: 'Settings are not available on this instance' });
        return;
      }
      const body = request.body || {};
      if (!('value' in body)) {
        reply.status(400).send({ error: 'value is required' });
        return;
      }
      try {
        const setting = await _registry.write(userId, request.params.key, body.value);
        reply.send({ ok: true, setting });
      } catch (error) {
        if (error instanceof SettingsError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        logger.error('Error writing a setting from the dashboard', { key: request.params.key, error });
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );
}
