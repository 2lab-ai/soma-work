/**
 * Hook routes — Fastify plugin for Claude Code hook handlers.
 * Registered at /api/hooks/v1/ (no auth — localhost only).
 */

import type { FastifyInstance } from 'fastify';
import { Logger } from '../logger';
import { trackPostCall, trackPreCall } from './call-tracker';
import { hookState } from './hook-state';

const logger = new Logger('HookRoutes');

interface HookBody {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
}

export async function registerHookRoutes(server: FastifyInstance): Promise<void> {
  // Start periodic stale-entry cleanup
  hookState.startCleanupTimer();

  // ── Pre-tool-use ──
  server.post<{ Body: HookBody }>('/api/hooks/v1/pre_tool_use', async (request, reply) => {
    try {
      const body = request.body || {};

      // Observation only — this route never blocks a tool call. It records the
      // start of Task / MCP calls so the call log can time them.
      trackPreCall(body);

      reply.send({ action: 'pass' });
    } catch (error) {
      logger.error('pre_tool_use handler error', error);
      // Fail-open: don't block on internal errors. Use the same {action:'pass'}
      // shape as the success path so the proxy reads a consistent contract.
      reply.send({ action: 'pass' });
    }
  });

  // ── Post-tool-use ──
  server.post<{ Body: HookBody }>('/api/hooks/v1/post_tool_use', async (request, reply) => {
    try {
      const body = request.body || {};
      trackPostCall(body);
      reply.send({ status: 'ok' });
    } catch (error) {
      logger.error('post_tool_use handler error', error);
      reply.send({ status: 'ok' });
    }
  });

  // ── Cleanup ──
  server.post<{ Body: { session_id?: string } }>('/api/hooks/v1/cleanup', async (request, reply) => {
    try {
      const sessionId = request.body?.session_id;
      if (sessionId) {
        hookState.cleanupSession(sessionId);
        logger.info('Session cleaned up via hook', { sessionId });
      }
      reply.send({ status: 'ok' });
    } catch (error) {
      logger.error('cleanup handler error', error);
      reply.send({ status: 'ok' });
    }
  });

  logger.info('Hook routes registered at /api/hooks/v1/');
}

// Re-export for convenience
export { hookState } from './hook-state';
