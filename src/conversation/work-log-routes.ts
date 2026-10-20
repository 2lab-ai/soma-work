/**
 * Work log API (spec §3.3).
 *
 *   GET /api/dashboard/session/:conversationId/worklog?afterSeq=&limit=
 *     → 200 { entries: WorkLogEntry[], hasMore: boolean }
 *   GET /api/dashboard/session/:conversationId/worklog/:seq/raw
 *     → 200 { seq, raw, rawBytes, rawTruncated } (Cache-Control: no-store)
 *
 * Raw: an entry with `rawBytes` has a stored raw — the full tool input/result
 * (or the uncut text) behind its one-line `text`, kept in `<id>.raw.jsonl`.
 * List entries never carry `raw` itself; the second route serves it for one
 * entry. `rawBytes` is the original's UTF-8 size; `rawTruncated: true` when the
 * stored copy was cut (256 KiB). `:seq` is a decimal integer ≥ 1 (else 400
 * bad_request); 404 when the entry or its raw is missing or unusable; 503
 * { error: 'unavailable' } when the log is damaged in a way the read's scan
 * budget cannot pass, so it can neither find nor rule out the entry. That
 * answer stays the same until the log is repaired: clients show "unavailable"
 * and do not retry automatically. Same authentication and read authorization
 * as the list. Every status, 401 and redirects included, carries no-store.
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
 *   - hasMore without afterSeq: older entries exist, or the read stopped at its
 *     byte budget (so there may be). With afterSeq: more than `limit` entries
 *     follow, or the read stopped at its budget before it could prove the page
 *     complete (the page may then be short or empty — ask again). It is false
 *     when the page is provably every entry after N, even if the read hit its
 *     budget on the way.
 *   - Quarantine trade-off: if nothing in the log's last 8 MB parses (external
 *     damage), the next seed — the first append after a server restart or
 *     after the conversation's writer state was evicted, and only when the
 *     reservation is read from its live copy — moves the whole log aside to
 *     `<id>.jsonl.corrupt-<ms>` and starts a fresh one; entries published
 *     before that are then no longer served here (they stay on disk for an
 *     operator).
 *
 * Who may read: the conversation's owner (its recorded `ownerId`) and admins.
 * This is stricter than the turns APIs (world-readable per #716) because the
 * work log carries raw instructions and tool inputs/results. Admin =
 * `authContext.isAdmin` (viewer-token sessions, auth-disabled mode, and OAuth
 * users listed in ADMIN_USERS). A conversation with no recorded owner is
 * admin-only. Unknown conversation → 404, anyone else → 403 { error: 'forbidden' }.
 *
 * Not quite the `work_log` WS audience: the WS resolves the owner from the LIVE
 * session for the conversation, so while no session is active its events go to
 * admins only — whereas this route still admits the recorded owner then.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../logger';
import type { AuthContext } from './oauth';
import { getConversation } from './recorder';
import { readWorkLog, readWorkLogRaw, WORK_LOG_DEFAULT_LIMIT } from './work-log';

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

  server.get<{
    Params: { conversationId: string; seq: string };
  }>(
    '/api/dashboard/session/:conversationId/worklog/:seq/raw',
    {
      // Every answer of this route is no-store: raw is tool input/output. onSend,
      // not onRequest: it also runs for replies sent before this route's own
      // hooks — the global canonical-origin redirect, the auth 401.
      onSend: async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        return payload;
      },
      preHandler: [authMiddleware],
    },
    async (request, reply) => {
      try {
        const seq = parseStrictInt(request.params.seq, 1, Number.MAX_SAFE_INTEGER);
        if (seq === null || seq === undefined) {
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

        const raw = await readWorkLogRaw(conversationId, seq);
        if (raw === 'budget') {
          // A damaged log the scan budget cannot pass: neither found nor ruled out.
          reply.status(503).send({ error: 'unavailable' });
          return;
        }
        if (!raw) {
          reply.status(404).send({ error: 'not_found' });
          return;
        }
        reply.send({ seq: raw.seq, raw: raw.raw, rawBytes: raw.rawBytes, rawTruncated: raw.rawTruncated });
      } catch (error) {
        logger.error('Error reading work log raw', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );
}
