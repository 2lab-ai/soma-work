/**
 * Shared project memory over HTTP — the settings page "프로젝트 메모리" tab
 * (SSOT 2026-10-23 T4).
 *
 *   GET    /api/project-memory                         every project (stored + mapped by a channel), who may edit
 *   POST   /api/project-memory/entries                 { project, text, revision }          add (admin)
 *   PUT    /api/project-memory/entries/:index          { project, text, revision }          replace (admin)
 *   DELETE /api/project-memory/entries/:index          { project, revision }                delete (admin)
 *   DELETE /api/project-memory                         { project, revision }                clear (admin)
 *
 * Reading: any signed-in user. Writing: admins only — enforced here, on the
 * server, with the dashboard's admin gate (viewer token, or an ADMIN_USERS
 * member with `X-Admin-Mode: on`) plus CSRF. Hiding the edit controls for
 * everyone else is UX, not the access control.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../logger';
import {
  getProjectMemoryStore,
  normalizeProjectSlug,
  type ProjectMemoryEdit,
  type ProjectMemoryStore,
} from '../project-memory-store';

const logger = new Logger('ProjectMemoryRoutes');

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
/** Sends the 403 and returns false when the caller may not write. */
type AdminGate = (request: FastifyRequest, reply: FastifyReply) => boolean;

/** Repos the bot's channels map to (channel registry), with the channel names. */
export type ProjectRepoSource = () => Array<{ repo: string; channels: string[] }>;

let _repoSource: ProjectRepoSource = () => [];
let _storeOverride: ProjectMemoryStore | null = null;

export function setProjectRepoSource(fn: ProjectRepoSource): void {
  _repoSource = fn;
}

/** Tests only: use a store at a scratch path. */
export function setProjectMemoryStoreForTests(store: ProjectMemoryStore | null): void {
  _storeOverride = store;
}

function store(): ProjectMemoryStore {
  return _storeOverride ?? getProjectMemoryStore();
}

function authOf(request: FastifyRequest): { userId?: string; isAdmin?: boolean; mode?: string } {
  return (request as { authContext?: { userId?: string; isAdmin?: boolean; mode?: string } }).authContext ?? {};
}

function listProjects() {
  const byRepo = new Map<string, Set<string>>();
  for (const { repo, channels } of _repoSource()) {
    let slug: string;
    try {
      slug = normalizeProjectSlug(repo);
    } catch {
      continue;
    }
    const set = byRepo.get(slug) ?? new Set<string>();
    for (const c of channels) set.add(c);
    byRepo.set(slug, set);
  }
  const s = store();
  for (const p of s.list()) if (!byRepo.has(p.slug)) byRepo.set(p.slug, new Set());
  return [...byRepo.keys()].sort().map((slug) => ({ ...s.get(slug), channels: [...(byRepo.get(slug) ?? [])].sort() }));
}

export function registerProjectMemoryRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  csrfMiddleware: Middleware | undefined,
  requireAdminWrite: AdminGate,
): void {
  const read = { preHandler: [authMiddleware] };
  const write = { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] };

  server.get('/api/project-memory', read, async (request, reply) => {
    try {
      const auth = authOf(request);
      // emptyRevision: the revision of a project with no notes yet (starting a new one).
      reply.send({
        isAdmin: !!auth.isAdmin,
        projects: listProjects(),
        emptyRevision: store().get('new/project').revision,
      });
    } catch (error) {
      logger.error('Error reading project memory', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  function edit(
    request: FastifyRequest,
    reply: FastifyReply,
    build: (body: Record<string, unknown>) => ProjectMemoryEdit | string,
  ): void {
    if (!requireAdminWrite(request, reply)) return;
    const body = (request.body || {}) as Record<string, unknown>;
    if (typeof body.project !== 'string' || typeof body.revision !== 'string') {
      reply.status(400).send({ error: 'project and revision are required' });
      return;
    }
    const e = build(body);
    if (typeof e === 'string') {
      reply.status(400).send({ error: e });
      return;
    }
    let slug: string;
    try {
      slug = normalizeProjectSlug(body.project);
    } catch (error) {
      reply.status(400).send({ error: (error as Error).message });
      return;
    }
    const auth = authOf(request);
    const actor =
      auth.userId || (auth.mode === 'bearer_header' || auth.mode === 'bearer_cookie' ? 'viewer-token' : 'unknown');
    try {
      const r = store().edit(slug, body.revision, e, actor);
      if (!r.ok) {
        reply.status(r.reason === 'conflict' ? 409 : 400).send({ error: r.message, reason: r.reason });
        return;
      }
      reply.send({
        ok: true,
        project: { ...r.project, channels: listProjects().find((p) => p.slug === slug)?.channels ?? [] },
      });
    } catch (error) {
      logger.error('Error writing project memory', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  }

  const index = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);

  server.post('/api/project-memory/entries', write, async (request, reply) => {
    edit(request, reply, (b) => (typeof b.text === 'string' ? { kind: 'add', text: b.text } : 'text is required'));
  });

  server.put<{ Params: { index: string } }>('/api/project-memory/entries/:index', write, async (request, reply) => {
    const i = index(request.params.index);
    edit(request, reply, (b) =>
      i === null
        ? 'index must be a non-negative integer'
        : typeof b.text === 'string'
          ? { kind: 'replace', index: i, text: b.text }
          : 'text is required',
    );
  });

  server.delete<{ Params: { index: string } }>('/api/project-memory/entries/:index', write, async (request, reply) => {
    const i = index(request.params.index);
    edit(request, reply, () => (i === null ? 'index must be a non-negative integer' : { kind: 'remove', index: i }));
  });

  server.delete('/api/project-memory', write, async (request, reply) => {
    edit(request, reply, () => ({ kind: 'clear' }));
  });
}
