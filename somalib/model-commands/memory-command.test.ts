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
