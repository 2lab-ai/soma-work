/**
 * Personal memory HTTP surface for the settings page "기억" tab (SSOT 2026-10-23 T3).
 *
 *   GET    /api/memory                          both L1 stores + page index + every episodic date
 *   POST   /api/memory/l1/:target               { text, revision }          add an entry
 *   PUT    /api/memory/l1/:target/:index        { text, revision }          replace entry (0-based)
 *   DELETE /api/memory/l1/:target/:index        { revision }                delete entry
 *   DELETE /api/memory/l1/:target               { revision }                clear the store
 *   GET    /api/memory/page?id=<page id>                                    full page + revision
 *   PUT    /api/memory/page                     { id, title, aliases, current, history, revision|null }
 *   DELETE /api/memory/page                     { id, revision }
 *   GET    /api/memory/episodic/:date                                       entries + revision
 *   POST   /api/memory/episodic                 { text }                    add a note (today)
 *   PUT    /api/memory/episodic/:date/:index    { content, revision }
 *   DELETE /api/memory/episodic/:date/:index    { revision }
 *
 * Self only (the signed-in Slack user), auth + CSRF on every write, every
 * edit conditional on the revision the page loaded (409 when another writer
 * — the agent, Slack — changed it meanwhile). Writes go through the host
 * stores, so the memory lock and prompt-cache invalidation apply.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HierarchicalMemoryFileStore, type PageLocator } from 'somalib/model-commands/hierarchical-memory-store';
import { MemoryLockTimeoutError } from 'somalib/model-commands/memory-lock';
import { hierarchicalMemoryStore } from '../hierarchical-memory';
import { Logger } from '../logger';
import {
  editMemoryAt,
  getPerEntryCap,
  loadMemoryWithRevision,
  type MemoryEdit,
  type MemoryTarget,
} from '../user-memory-store';
import { requireSelfUser } from './settings-routes';

const logger = new Logger('MemoryRoutes');

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const TARGETS: MemoryTarget[] = ['memory', 'user'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Entries and revision from one read (review P1): never a newer revision on older entries.
function l1View(userId: string, target: MemoryTarget) {
  return { ...loadMemoryWithRevision(userId, target), perEntryCap: getPerEntryCap(target) };
}

function parseTarget(raw: string, reply: FastifyReply): MemoryTarget | null {
  if ((TARGETS as string[]).includes(raw)) return raw as MemoryTarget;
  reply.status(400).send({ error: 'target must be memory or user' });
  return null;
}

function parseIndex(raw: string, reply: FastifyReply): number | null {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  reply.status(400).send({ error: 'index must be a non-negative integer' });
  return null;
}

function revisionOf(body: unknown): string | null | undefined {
  const r = (body as { revision?: unknown } | undefined)?.revision;
  if (r === null) return null;
  return typeof r === 'string' && r.length <= 64 ? r : undefined;
}

/** Map a store refusal / lock timeout to an HTTP answer. */
function fail(reply: FastifyReply, r: { reason: string; message: string }): void {
  const status = r.reason === 'conflict' ? 409 : r.reason === 'missing' ? 404 : 400;
  reply.status(status).send({ error: r.message, reason: r.reason });
}

async function guarded(reply: FastifyReply, what: string, fn: () => void): Promise<void> {
  try {
    fn();
  } catch (error) {
    if (error instanceof MemoryLockTimeoutError) {
      reply.status(503).send({ error: '메모리를 다른 작업이 쓰는 중입니다 — 잠시 뒤 다시 시도하세요' });
      return;
    }
    // Malformed page ids / dates / segments come from the request: a 400, not a 500.
    if (
      error instanceof Error &&
      /^(invalid memory page id|Invalid memory page type|Invalid episodic date|invalid `issue` segment|\S+ locator requires a safe)/.test(
        error.message,
      )
    ) {
      reply.status(400).send({ error: error.message });
      return;
    }
    logger.error(`Memory ${what} failed`, error);
    reply.status(500).send({ error: 'Internal Server Error' });
  }
}

/**
 * Every memory write a Slack surface (`memory …` commands, the `/z memory`
 * card and its modals) performs, mapped to the 기억 tab control that does the
 * same. Pinned by `memory-routes.slack-coverage.test.ts`: a new Slack memory
 * write without a dashboard counterpart fails CI.
 */
export const SLACK_MEMORY_COVERAGE: Readonly<Record<string, string>> = {
  addMemory: 'POST /api/memory/l1/:target — 개인 메모리 "추가"',
  replaceMemory: 'PUT /api/memory/l1/:target/:index — 항목 "수정"',
  replaceMemoryByIndex: 'PUT /api/memory/l1/:target/:index — 항목 "수정" (improve)',
  replaceAllMemory: 'PUT/DELETE /api/memory/l1/:target/:index — 항목별 수정·삭제 (improve all / bulk delete)',
  removeMemory: 'DELETE /api/memory/l1/:target/:index — 항목 "삭제"',
  removeMemoryByIndex: 'DELETE /api/memory/l1/:target/:index — 항목 "삭제"',
  clearMemory: 'DELETE /api/memory/l1/:target — "모두 지우기"',
  clearAllMemory: 'DELETE /api/memory/l1/:target — 두 저장소 각각 "모두 지우기"',
  addUserNote: 'POST /api/memory/episodic — 관찰 기록 "메모 추가"',
  appendEpisodic: 'POST /api/memory/episodic — 관찰 기록 "메모 추가"',
  removeUserPage: 'DELETE /api/memory/page — 지식 페이지 "페이지 삭제"',
  removePage: 'DELETE /api/memory/page — 지식 페이지 "페이지 삭제"',
  upsertPage:
    'PUT /api/memory/page — 지식 페이지 "저장" (title / aliases / Current / History); 양식에 담기지 않는 페이지는 PUT /api/memory/page/raw (원문)',
};

export function registerMemoryRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  csrfMiddleware?: Middleware,
): void {
  const read = { preHandler: [authMiddleware] };
  const write = { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] };

  server.get('/api/memory', read, async (request, reply) => {
    const userId = requireSelfUser(request, reply);
    if (!userId) return;
    await guarded(reply, 'read', () => {
      const index = hierarchicalMemoryStore.readIndex(userId);
      reply.send({
        l1: { memory: l1View(userId, 'memory'), user: l1View(userId, 'user') },
        pages: index.entries,
        episodicDates: hierarchicalMemoryStore.listEpisodicDates(userId),
      });
    });
  });

  // ── L1: 에이전트 노트 (memory) / 사용자 프로필 (user) ──

  function l1Edit(request: FastifyRequest, reply: FastifyReply, target: MemoryTarget, edit: MemoryEdit): void {
    const userId = requireSelfUser(request, reply);
    if (!userId) return;
    const revision = revisionOf(request.body);
    if (typeof revision !== 'string') {
      reply.status(400).send({ error: 'revision is required (the revision the page loaded)' });
      return;
    }
    const r = editMemoryAt(userId, target, revision, edit);
    if (!r.ok) {
      fail(reply, r);
      return;
    }
    reply.send({ ok: true, l1: { ...r.block, perEntryCap: getPerEntryCap(target), revision: r.revision } });
  }

  server.post<{ Params: { target: string }; Body: { text?: unknown; revision?: unknown; restore?: unknown } }>(
    '/api/memory/l1/:target',
    write,
    async (request, reply) => {
      const target = parseTarget(request.params.target, reply);
      if (!target) return;
      const text = request.body?.text;
      if (typeof text !== 'string' || !text.trim()) {
        reply.status(400).send({ error: 'text is required' });
        return;
      }
      // `restore: true` is the tab's undo of a delete: it takes back the exact note, which
      // may be longer than a new note may be (Slack saves up to the total limit).
      const kind = request.body?.restore === true ? 'restore' : 'add';
      await guarded(reply, 'l1 add', () => l1Edit(request, reply, target, { kind, text }));
    },
  );

  server.put<{ Params: { target: string; index: string }; Body: { text?: unknown; revision?: unknown } }>(
    '/api/memory/l1/:target/:index',
    write,
    async (request, reply) => {
      const target = parseTarget(request.params.target, reply);
      if (!target) return;
      const index = parseIndex(request.params.index, reply);
      if (index === null) return;
      const text = request.body?.text;
      if (typeof text !== 'string' || !text.trim()) {
        reply.status(400).send({ error: 'text is required — to remove an entry use DELETE' });
        return;
      }
      await guarded(reply, 'l1 replace', () => l1Edit(request, reply, target, { kind: 'replace', index, text }));
    },
  );

  server.delete<{ Params: { target: string; index: string }; Body: { revision?: unknown } }>(
    '/api/memory/l1/:target/:index',
    write,
    async (request, reply) => {
      const target = parseTarget(request.params.target, reply);
      if (!target) return;
      const index = parseIndex(request.params.index, reply);
      if (index === null) return;
      await guarded(reply, 'l1 remove', () => l1Edit(request, reply, target, { kind: 'remove', index }));
    },
  );

  server.delete<{ Params: { target: string }; Body: { revision?: unknown } }>(
    '/api/memory/l1/:target',
    write,
    async (request, reply) => {
      const target = parseTarget(request.params.target, reply);
      if (!target) return;
      await guarded(reply, 'l1 clear', () => l1Edit(request, reply, target, { kind: 'clear' }));
    },
  );

  // ── Knowledge pages ──

  server.get<{ Querystring: { id?: string } }>('/api/memory/page', read, async (request, reply) => {
    const userId = requireSelfUser(request, reply);
    if (!userId) return;
    const id = request.query.id;
    if (typeof id !== 'string' || !id) {
      reply.status(400).send({ error: 'id is required' });
      return;
    }
    await guarded(reply, 'page read', () => {
      const found = hierarchicalMemoryStore.getPageWithRevision(userId, parseLocator(id));
      if (!found) {
        reply.status(404).send({ error: `${id} 페이지가 없습니다` });
        return;
      }
      reply.send(found);
    });
  });

  server.put<{
    Body: {
      id?: unknown;
      title?: unknown;
      aliases?: unknown;
      current?: unknown;
      history?: unknown;
      revision?: unknown;
    };
  }>('/api/memory/page', write, async (request, reply) => {
    const userId = requireSelfUser(request, reply);
    if (!userId) return;
    const b = request.body || {};
    const revision = revisionOf(b);
    if (typeof b.id !== 'string' || revision === undefined) {
      reply.status(400).send({ error: 'id and revision (null to create) are required' });
      return;
    }
    if (
      !Array.isArray(b.aliases) ||
      !Array.isArray(b.history) ||
      typeof b.title !== 'string' ||
      typeof b.current !== 'string'
    ) {
      reply.status(400).send({ error: 'title, current (strings) and aliases, history (arrays) are required' });
      return;
    }
    const id = b.id;
    await guarded(reply, 'page write', () => {
      const locator = parseLocator(id);
      const r = hierarchicalMemoryStore.writePage(
        userId,
        locator,
        {
          title: b.title as string,
          aliases: b.aliases as string[],
          current: b.current as string,
          history: b.history as string[],
        },
        revision,
      );
      if (!r.ok) return fail(reply, r);
      // The page as written: parsed from the same bytes the returned revision hashes.
      const written = hierarchicalMemoryStore.getPageWithRevision(userId, locator);
      reply.send({ ok: true, ...(written ?? { page: null, revision: r.revision }) });
    });
  });

  // Raw markdown — a page the form cannot hold losslessly (review R3), or anyone who wants the file as it is.
  server.put<{ Body: { id?: unknown; raw?: unknown; revision?: unknown } }>(
    '/api/memory/page/raw',
    write,
    async (request, reply) => {
      const userId = requireSelfUser(request, reply);
      if (!userId) return;
      const b = request.body || {};
      if (typeof b.id !== 'string' || typeof b.raw !== 'string' || typeof b.revision !== 'string') {
        reply.status(400).send({ error: 'id, raw and revision are required' });
        return;
      }
      const { id, raw, revision } = b as { id: string; raw: string; revision: string };
      await guarded(reply, 'page raw write', () => {
        const locator = parseLocator(id);
        const r = hierarchicalMemoryStore.writePageRaw(userId, locator, raw, revision);
        if (!r.ok) return fail(reply, r);
        const written = hierarchicalMemoryStore.getPageWithRevision(userId, locator);
        reply.send({ ok: true, ...(written ?? { page: null, revision: r.revision }) });
      });
    },
  );

  server.delete<{ Body: { id?: unknown; revision?: unknown } }>('/api/memory/page', write, async (request, reply) => {
    const userId = requireSelfUser(request, reply);
    if (!userId) return;
    const b = request.body || {};
    const revision = revisionOf(b);
    if (typeof b.id !== 'string' || typeof revision !== 'string') {
      reply.status(400).send({ error: 'id and revision are required' });
      return;
    }
    const id = b.id;
    await guarded(reply, 'page delete', () => {
      const r = hierarchicalMemoryStore.removePageAt(userId, parseLocator(id), revision);
      if (!r.ok) return fail(reply, r);
      reply.send({ ok: true });
    });
  });

  // ── Episodic ──

  server.get<{ Params: { date: string } }>('/api/memory/episodic/:date', read, async (request, reply) => {
    const userId = requireSelfUser(request, reply);
    if (!userId) return;
    if (!DAY_RE.test(request.params.date)) {
      reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
      return;
    }
    await guarded(reply, 'episodic read', () =>
      reply.send(hierarchicalMemoryStore.readEpisodicDay(userId, request.params.date)),
    );
  });

  server.post<{ Body: { text?: unknown } }>('/api/memory/episodic', write, async (request, reply) => {
    const userId = requireSelfUser(request, reply);
    if (!userId) return;
    const text = request.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 20_000) {
      reply.status(400).send({ error: 'text is required (up to 20,000 characters)' });
      return;
    }
    await guarded(reply, 'episodic add', () => {
      const r = hierarchicalMemoryStore.appendEpisodic(userId, text);
      if (!r.ok) {
        reply.status(400).send({ error: r.message });
        return;
      }
      const day = r.relPath.replace(/^.*\//, '').replace(/\.md$/, '');
      reply.send({ ok: true, day: hierarchicalMemoryStore.readEpisodicDay(userId, day) });
    });
  });

  server.put<{ Params: { date: string; index: string }; Body: { content?: unknown; revision?: unknown } }>(
    '/api/memory/episodic/:date/:index',
    write,
    async (request, reply) => {
      const userId = requireSelfUser(request, reply);
      if (!userId) return;
      const index = parseIndex(request.params.index, reply);
      if (index === null) return;
      const revision = revisionOf(request.body);
      const content = request.body?.content;
      if (typeof revision !== 'string' || typeof content !== 'string' || content.length > 20_000) {
        reply.status(400).send({ error: 'content and revision are required' });
        return;
      }
      await guarded(reply, 'episodic edit', () => {
        const r = hierarchicalMemoryStore.editEpisodicEntry(userId, request.params.date, index, content, revision);
        if (!r.ok) return fail(reply, r);
        reply.send({ ok: true, day: hierarchicalMemoryStore.readEpisodicDay(userId, request.params.date) });
      });
    },
  );

  server.delete<{ Params: { date: string; index: string }; Body: { revision?: unknown } }>(
    '/api/memory/episodic/:date/:index',
    write,
    async (request, reply) => {
      const userId = requireSelfUser(request, reply);
      if (!userId) return;
      const index = parseIndex(request.params.index, reply);
      if (index === null) return;
      const revision = revisionOf(request.body);
      if (typeof revision !== 'string') {
        reply.status(400).send({ error: 'revision is required' });
        return;
      }
      await guarded(reply, 'episodic delete', () => {
        const r = hierarchicalMemoryStore.editEpisodicEntry(userId, request.params.date, index, null, revision);
        if (!r.ok) return fail(reply, r);
        reply.send({ ok: true, day: hierarchicalMemoryStore.readEpisodicDay(userId, request.params.date) });
      });
    },
  );
}

/** A page id (`agent/foo`, `project/p/123`, …) → locator; throws on a malformed id (→ 400). */
function parseLocator(id: string): PageLocator {
  return HierarchicalMemoryFileStore.parseId(id);
}
