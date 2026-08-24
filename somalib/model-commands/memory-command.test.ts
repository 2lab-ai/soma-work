/**
 * Dispatch tests for the MEMORY model-command — proves the catalog routes each
 * op through a registered HierarchicalMemoryStore and returns typed payloads.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultSessionSnapshot, registerHierarchicalMemoryStore, runModelCommand } from './catalog';
import { HierarchicalMemoryFileStore } from './hierarchical-memory-store';
import type { ModelCommandContext, ModelCommandRunRequest } from './types';
import { validateModelCommandRunArgs } from './validator';

function ctx(user = 'U123'): ModelCommandContext {
  return { channel: 'C1', threadTs: '1.2', user, session: getDefaultSessionSnapshot() };
}

function run(params: Record<string, unknown>, context = ctx()) {
  return runModelCommand({ commandId: 'MEMORY', params } as ModelCommandRunRequest, context);
}

describe('MEMORY command dispatch', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cmd-'));
    registerHierarchicalMemoryStore(new HierarchicalMemoryFileStore(dataDir));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('page_upsert then page_get round-trips an agent page', () => {
    const up = run({ op: 'page_upsert', type: 'agent', slug: 'build', current: 'bun build', history: 'noted' });
    expect(up.ok).toBe(true);
    if (up.ok) {
      expect((up.payload as { ok: boolean; id: string }).ok).toBe(true);
      expect((up.payload as { id: string }).id).toBe('agent/build');
      expect((up.payload as { mutated?: unknown }).mutated).toEqual({ kind: 'memory', user: 'U123' });
    }

    const get = run({ op: 'page_get', type: 'agent', slug: 'build' });
    expect(get.ok).toBe(true);
    if (get.ok) {
      const payload = get.payload as { ok: boolean; page: string };
      expect(payload.ok).toBe(true);
      expect(payload.page).toContain('bun build');
    }
  });

  it('episodic_append and episodic_get', () => {
    const a = run({ op: 'episodic_append', content: 'observed a thing', date: '2026-06-30' });
    expect(a.ok).toBe(true);
    const g = run({ op: 'episodic_get', date: '2026-06-30' });
    expect(g.ok).toBe(true);
    if (g.ok) expect((g.payload as { episodic: string }).episodic).toContain('observed a thing');
  });

  it('search and index list pages', () => {
    run({ op: 'page_upsert', type: 'sites', slug: 'danawa', title: 'Danawa', current: 'price site' });
    const s = run({ op: 'search', query: 'danawa' });
    expect(s.ok).toBe(true);
    if (s.ok) expect((s.payload as { entries: Array<{ id: string }> }).entries[0].id).toBe('sites/danawa');

    const i = run({ op: 'index' });
    expect(i.ok).toBe(true);
    if (i.ok) expect((i.payload as { entries: unknown[] }).entries.length).toBe(1);
  });

  it('page_remove deletes a page', () => {
    run({ op: 'page_upsert', type: 'concepts', slug: 'c', current: 'x' });
    const r = run({ op: 'page_remove', type: 'concepts', slug: 'c' });
    expect(r.ok).toBe(true);
    const g = run({ op: 'page_get', type: 'concepts', slug: 'c' });
    if (g.ok) expect((g.payload as { ok: boolean }).ok).toBe(false);
  });

  it('errors without user context', () => {
    const res = run({ op: 'index' }, { channel: 'C1', threadTs: '1.2', session: getDefaultSessionSnapshot() });
    expect(res.ok).toBe(false);
  });

  it('errors on an unsafe locator', () => {
    const res = run({ op: 'page_upsert', type: 'agent', slug: '../escape', current: 'x' });
    expect(res.ok).toBe(false);
  });
});

/**
 * The prompt-injected MEMORY INDEX advertises canonical page ids (`agent/foo`,
 * `project/soma-work/1234`) and tells the model to "fetch with MEMORY
 * op=page_get" — but the command used to accept only a decomposed
 * type + slug/project/routine locator. Every natural call with the advertised
 * id failed with `INVALID_ARGS — type is required for page ops` (observed in
 * the dev deployment). The id form is now first-class.
 */
describe('MEMORY page ops accept the canonical page id', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-id-'));
    registerHierarchicalMemoryStore(new HierarchicalMemoryFileStore(dataDir));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const payloadOf = (res: ReturnType<typeof run>) => {
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    return res.payload as { ok: boolean; id?: string; page?: string; message?: string };
  };

  it('page_get resolves an agent page from `id` alone (no `type`)', () => {
    run({ op: 'page_upsert', type: 'agent', slug: 'build-system', current: 'bun build' });

    const payload = payloadOf(run({ op: 'page_get', id: 'agent/build-system' }));
    expect(payload.ok).toBe(true);
    expect(payload.id).toBe('agent/build-system');
    expect(payload.page).toContain('bun build');
  });

  // `path` is normalized to `id` in the validator, which every real call goes
  // through (MCP server: validate → run), so this one exercises both layers.
  it('page_get accepts `path` as an alias of `id` through the validated path', () => {
    run({ op: 'page_upsert', type: 'concepts', slug: 'ha-thinking', current: 'layered reasoning' });

    const validated = validateModelCommandRunArgs({
      commandId: 'MEMORY',
      params: { op: 'page_get', path: 'concepts/ha-thinking' },
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error('unreachable');

    const payload = payloadOf(runModelCommand(validated.request, ctx()));
    expect(payload.ok).toBe(true);
    expect(payload.page).toContain('layered reasoning');
  });

  it('page_upsert creates a project→issue page from `id`', () => {
    const up = payloadOf(run({ op: 'page_upsert', id: 'project/soma-work/1234', current: 'spec' }));
    expect(up.ok).toBe(true);
    expect(up.id).toBe('project/soma-work/1234');
    expect(payloadOf(run({ op: 'page_get', id: 'project/soma-work/1234' })).page).toContain('spec');
  });

  it('page_upsert creates a cron page from `id`', () => {
    const up = payloadOf(run({ op: 'page_upsert', id: 'cron/daily-standup', current: 'runs 09:00' }));
    expect(up.id).toBe('cron/daily-standup');
    expect(payloadOf(run({ op: 'page_get', id: 'cron/daily-standup' })).page).toContain('runs 09:00');
  });

  it('page_remove deletes a page addressed by `id`', () => {
    run({ op: 'page_upsert', id: 'sites/danawa', current: 'price site' });
    expect(payloadOf(run({ op: 'page_remove', id: 'sites/danawa' })).ok).toBe(true);
    expect(payloadOf(run({ op: 'page_get', id: 'sites/danawa' })).ok).toBe(false);
  });

  it('tolerates a slug that redundantly carries its own type prefix', () => {
    run({ op: 'page_upsert', type: 'agent', slug: 'build-system', current: 'bun build' });

    const payload = payloadOf(run({ op: 'page_get', type: 'agent', slug: 'agent/build-system' }));
    expect(payload.ok).toBe(true);
    expect(payload.id).toBe('agent/build-system');
  });

  it('infers the type from a slash-qualified slug when `type` is omitted', () => {
    run({ op: 'page_upsert', type: 'agent', slug: 'build-system', current: 'bun build' });

    const payload = payloadOf(run({ op: 'page_get', slug: 'agent/build-system' }));
    expect(payload.ok).toBe(true);
    expect(payload.id).toBe('agent/build-system');
  });

  it('explicit locator fields win over the id', () => {
    run({ op: 'page_upsert', type: 'agent', slug: 'explicit', current: 'from explicit slug' });

    const payload = payloadOf(run({ op: 'page_get', id: 'agent/other', type: 'agent', slug: 'explicit' }));
    expect(payload.id).toBe('agent/explicit');
  });

  it('names `id` in the error when no locator at all is given', () => {
    const res = run({ op: 'page_get' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('id');
  });

  it('rejects an id whose first segment is not a semantic page type', () => {
    const res = run({ op: 'page_get', id: 'bogus/thing' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/agent/);
  });

  it('rejects a path-traversing id', () => {
    const res = run({ op: 'page_upsert', id: 'agent/../../escape', current: 'x' });
    expect(res.ok).toBe(false);
  });
});
