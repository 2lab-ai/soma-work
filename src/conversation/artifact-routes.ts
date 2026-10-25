/**
 * Session artifacts API — what the dashboard's artifact strip, hover preview and
 * full-size viewer read.
 *
 *   GET /api/dashboard/session/:conversationId/artifacts
 *     → 200 { artifacts: SessionArtifact[] }   (oldest first; [] when none)
 *   GET /api/dashboard/session/:conversationId/artifacts/:artifactId/content[?download=1]
 *     → 200 the stored bytes, or 206 for a `Range: bytes=…` request (audio/video
 *       seeking needs it — Safari will not play <audio> without range support).
 *     → 404 unknown artifact or no stored copy; 416 unsatisfiable range.
 *
 * Who may read — an explicit policy, the same for the list, the content, the
 * card summary (`KanbanSession.artifacts`) and the live push: any signed-in
 * dashboard user, the rule of the turns APIs (#716). An artifact is something
 * the model already posted into the Slack thread (a file upload or its final
 * answer) — the same exposure as an assistant turn, whose raw text is already
 * readable there (`/api/conversations/:id/turns/:turnId/raw`). The work log
 * stays owner/admin-only: the backfill reads it server-side and publishes only
 * those two kinds of entry, never tool inputs or other results.
 *
 * Active content never runs with the dashboard's origin: html / svg / markdown /
 * text carry `Content-Security-Policy: sandbox …` without `allow-same-origin`,
 * so even opened directly in a tab they run in an opaque origin with no access
 * to the dashboard's cookies, storage or API. html may run scripts and nothing
 * more (see ACTIVE_CSP); the viewer's <iframe sandbox> repeats that, and the
 * hover preview's iframe drops scripts too. `nosniff` everywhere.
 */

import * as fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../logger';
import { backfillArtifactsFromWorkLog } from './artifact-capture';
import { type ArtifactStore, getArtifactStore, type SessionArtifact } from './artifacts';

const logger = new Logger('ArtifactRoutes');

/**
 * html: scripts run (charts, animations), nothing else — no popups, dialogs,
 * downloads, forms or navigation of the dashboard; no nested frames, no <base>.
 * The dashboard's own buttons do open-in-tab and download. Network fetches stay
 * open so a report can load its CDN fonts/scripts; the opaque origin means
 * they never carry the dashboard's cookies.
 */
const ACTIVE_CSP = "sandbox allow-scripts; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'";
/** svg / markdown / text opened as a document: no scripts at all. */
const INERT_CSP = "sandbox; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** What `sendStoredFile` needs to know about a stored file. */
export interface StoredFileMeta {
  name: string;
  mime: string;
  kind: string;
}

function contentTypeFor(a: StoredFileMeta): string {
  if (a.mime.startsWith('text/') || a.mime === 'application/json' || a.mime === 'application/xml') {
    return `${a.mime}; charset=utf-8`;
  }
  return a.mime;
}

function dispositionFor(a: StoredFileMeta, download: boolean): string {
  const ascii = a.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`;
}

/**
 * Serve one stored file: Content-Type from the stored MIME, nosniff,
 * Content-Disposition, Range (206 / 416) for audio and video seeking, and a
 * sandbox CSP on anything a browser would treat as a document.
 *
 * `active` is the caller's explicit decision — never derived here from the
 * file's kind — that an html file may run scripts (`ACTIVE_CSP`). Only the
 * model's own artifacts pass it; user uploads never do (`inertCsp`).
 */
export async function sendStoredFile(
  request: FastifyRequest<{ Querystring: { download?: string } }>,
  reply: FastifyReply,
  file: string,
  meta: StoredFileMeta,
  policy: { active: boolean; inertCsp?: string },
): Promise<FastifyReply | undefined> {
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    reply.status(404).send({ error: 'not_found' });
    return;
  }
  const active = policy.active && meta.kind === 'html';
  const document =
    meta.kind === 'html' || meta.kind === 'markdown' || meta.kind === 'text' || meta.mime === 'image/svg+xml';
  reply.header('Content-Type', contentTypeFor(meta));
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Disposition', dispositionFor(meta, request.query?.download === '1'));
  reply.header('Cache-Control', 'private, max-age=3600');
  reply.header('Accept-Ranges', 'bytes');
  if (document) reply.header('Content-Security-Policy', active ? ACTIVE_CSP : (policy.inertCsp ?? INERT_CSP));

  const range = parseRange(request.headers.range, size);
  if (range === null) {
    reply.header('Content-Range', `bytes */${size}`);
    reply.status(416).send();
    return;
  }
  if (range) {
    const [start, end] = range;
    reply.status(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', String(end - start + 1));
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header('Content-Length', String(size));
  return reply.send(fs.createReadStream(file));
}

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` → [start, end] inclusive; null = unsatisfiable; undefined = no/ignored range. */
export function parseRange(header: string | undefined, size: number): [number, number] | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined; // multi-range or junk: serve the whole body
  const [, s, e] = m;
  if (s === '' && e === '') return undefined;
  let start: number;
  let end: number;
  if (s === '') {
    const n = Number(e);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === '' ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return [start, end];
}

export async function registerArtifactRoutes(
  server: FastifyInstance,
  authMiddleware: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  storeOverride?: ArtifactStore,
): Promise<void> {
  const store = () => storeOverride ?? getArtifactStore();

  server.get<{ Params: { conversationId: string } }>(
    '/api/dashboard/session/:conversationId/artifacts',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        reply.header('Cache-Control', 'no-store');
        const { conversationId } = request.params;
        // Uploads made before live capture existed come from the work log, once.
        await backfillArtifactsFromWorkLog(conversationId, store());
        reply.send({ artifacts: store().list(conversationId) });
      } catch (error) {
        logger.error('Error listing artifacts', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.get<{ Params: { conversationId: string; artifactId: string }; Querystring: { download?: string } }>(
    '/api/dashboard/session/:conversationId/artifacts/:artifactId/content',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const { conversationId, artifactId } = request.params;
        const art = store().get(conversationId, artifactId);
        const file = art ? store().blobPath(conversationId, artifactId) : null;
        if (!art || !file) {
          reply.status(404).send({ error: 'not_found' });
          return;
        }
        // The model's own html report may run its scripts (opaque origin only).
        return sendStoredFile(request, reply, file, art, { active: true });
      } catch (error) {
        logger.error('Error serving artifact', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );
}
