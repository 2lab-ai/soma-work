/**
 * .prd/26 §3 · .prd/27 §4 — the collector over fake GitHub and fake checkouts; the store round trip; the scheduler.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubPullDetail, GitHubPullFile } from '../../link-metadata-fetcher';
import { applyPatchBudget, collectCodeChanges, createCodeChangesScheduler, fileSources, listView } from '../collector';
import { prFileOf, pullRefOf, sessionPrChanges } from '../pr-changes';
import { CodeChangesStore, isStoreKey } from '../store';
import { sanitizeCodeChangesSummary, summarizeCodeChanges } from '../summary';
import type { CheckoutChanges, CodeChangesDoc } from '../types';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
function store(): CodeChangesStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-'));
  roots.push(dir);
  return new CodeChangesStore(dir);
}

const START = Date.parse('2026-11-16T00:00:00Z');
function detail(n: number, over: Partial<GitHubPullDetail> = {}): GitHubPullDetail {
  return {
    html_url: `https://github.com/acme/web/pull/${n}`,
    number: n,
    title: `PR ${n}`,
    state: 'open',
    created_at: '2026-11-16T01:00:00Z',
    additions: 10,
    deletions: 2,
    changed_files: 1,
    head_ref: `feat/${n}`,
    head_sha: `${'a'.repeat(39)}${n % 10}`,
    ...over,
  };
}
const FILE: GitHubPullFile = {
  filename: 'src/a.ts',
  status: 'modified',
  additions: 10,
  deletions: 2,
  changes: 12,
  patch: '@@ -1 +1 @@\n-a\n+b',
};

function prDeps(details: Record<number, GitHubPullDetail | undefined>) {
  const fetchPullDetail = vi.fn(async (_o: string, _r: string, n: number) => details[n]);
  const fetchPullFiles = vi.fn(async () => ({ files: [FILE], truncated: false }));
  return { fetchPullDetail, fetchPullFiles, now: () => START + 7200_000 };
}

describe('pr-changes', () => {
  it('pullRefOf reads github pull URLs only', () => {
    expect(pullRefOf('https://github.com/Acme/Web/pull/12')).toMatchObject({
      owner: 'Acme',
      number: 12,
      id: 'acme/web#12',
    });
    expect(pullRefOf('https://github.com/acme/web/issues/12')).toBeUndefined();
  });

  it('prFileOf maps GitHub statuses; a missing patch with changes is truncated, without changes binary', () => {
    expect(prFileOf({ filename: 'x', status: 'removed', additions: 0, deletions: 3, patch: '@@' }).status).toBe(
      'deleted',
    );
    expect(prFileOf({ filename: 'x', status: 'modified', changes: 5000 })).toMatchObject({ patchTruncated: true });
    expect(prFileOf({ filename: 'x.png', status: 'added', changes: 0 })).toMatchObject({ binary: true });
    expect(prFileOf({ filename: 'b', previous_filename: 'a', status: 'renamed', changes: 0 })).toMatchObject({
      status: 'renamed',
      oldPath: 'a',
    });
  });

  it('A2 — a PR created before the session started is not the session’s; a merged one is merged', async () => {
    const deps = prDeps({
      1: detail(1, { state: 'closed', merged: true, merged_at: '2026-11-16T02:00:00Z' }),
      2: detail(2, { created_at: '2026-11-10T00:00:00Z' }),
    });
    const prs = await sessionPrChanges(
      [
        'https://github.com/acme/web/pull/1',
        'https://github.com/acme/web/pull/2',
        'https://github.com/acme/web/pull/1',
      ],
      START,
      [],
      deps,
    );
    expect(prs.map((p) => [p.number, p.state])).toEqual([[1, 'merged']]);
    expect(prs[0]).toMatchObject({ additions: 10, deletions: 2, mergedAt: Date.parse('2026-11-16T02:00:00Z') });
    expect(prs[0].files[0]).toMatchObject({ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' });
    expect(deps.fetchPullDetail).toHaveBeenCalledTimes(2);
  });

  it('a settled PR is read from the stored record; a failed query keeps the stored record', async () => {
    const deps = prDeps({ 3: undefined });
    const first = await sessionPrChanges(
      ['https://github.com/acme/web/pull/1'],
      START,
      [],
      prDeps({ 1: detail(1, { merged: true, merged_at: '2026-11-16T02:00:00Z' }) }),
    );
    const again = await sessionPrChanges(['https://github.com/acme/web/pull/1'], START, first, deps);
    expect(again).toEqual(first);
    expect(deps.fetchPullDetail).not.toHaveBeenCalled();
    const open = await sessionPrChanges(
      ['https://github.com/acme/web/pull/3'],
      START,
      [{ ...first[0], id: 'acme/web#3', number: 3, state: 'open' }],
      deps,
    );
    expect(open.map((p) => p.number)).toEqual([3]);
  });
});

function checkout(over: Partial<CheckoutChanges> = {}): CheckoutChanges {
  return {
    id: 'c1',
    repo: 'acme/web',
    dir: 'web',
    branch: 'feat/1',
    uncommitted: {
      files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-x\n+y' }],
      additions: 1,
      deletions: 1,
    },
    committed: { files: [], additions: 0, deletions: 0, commits: [] },
    ...over,
  };
}

describe('collectCodeChanges', () => {
  it('stores one document, summarises the four layers, reports new merges and new commits once', async () => {
    const s = store();
    const deps = {
      ...prDeps({ 1: detail(1, { merged: true, merged_at: '2026-11-16T02:00:00Z' }), 2: detail(2) }),
      store: s,
      listCheckoutDirs: async () => ({ dirs: ['/s/web', '/s/clean'] }),
      checkoutChanges: vi.fn(async ({ dir }: { dir: string }) =>
        dir === '/s/web'
          ? checkout()
          : checkout({ id: 'c2', dir: 'clean', uncommitted: { files: [], additions: 0, deletions: 0 } }),
      ),
      sessionCommits: vi.fn(async (dir: string, _since: number, skip: ReadonlySet<string>) =>
        dir === '/s/web' && !skip.has('f'.repeat(40))
          ? [{ sha: 'f'.repeat(40), at: START + 60_000, additions: 4, deletions: 1 }]
          : [],
      ),
    };
    const input = {
      conversationId: 'conv1',
      owner: { id: 'U1', name: 'zed' },
      sessionRoot: '/s',
      dirs: ['/s'],
      startedAt: START,
      prUrls: ['https://github.com/acme/web/pull/2', 'https://github.com/acme/web/pull/1'],
    };
    const r = await collectCodeChanges(input, deps);
    expect(r.doc.checkouts.map((c) => c.dir)).toEqual(['web']);
    expect(r.summary.layers).toEqual({
      uncommitted: { files: 1, additions: 1, deletions: 1 },
      committed: { files: 0, additions: 0, deletions: 0 },
      pr: { files: 1, additions: 10, deletions: 2 },
      merged: { files: 1, additions: 10, deletions: 2 },
    });
    expect(r.newMerges.map((p) => p.number)).toEqual([1]);
    expect(r.newCommits).toEqual([
      { sha: 'f'.repeat(40), at: START + 60_000, additions: 4, deletions: 1, repo: 'acme/web' },
    ]);
    expect(s.read('conv1')?.counted.commits).toEqual(['f'.repeat(40)]);

    const again = await collectCodeChanges(input, deps);
    expect(again.newMerges).toEqual([]);
    expect(again.newCommits).toEqual([]);
  });

  it('listView strips patches; fileSources lists every layer of one file in layer order', async () => {
    const doc: CodeChangesDoc = {
      version: 1,
      conversationId: 'c',
      owner: { id: 'U', name: 'u' },
      updatedAt: 1,
      checkouts: [checkout()],
      prs: [
        {
          id: 'acme/web#1',
          url: 'https://github.com/acme/web/pull/1',
          repo: 'acme/web',
          number: 1,
          state: 'merged',
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@' }],
          fetchedAt: 1,
        },
      ],
      counted: { commits: ['x'] },
    };
    const lv = listView(doc);
    expect(JSON.stringify(lv)).not.toContain('"patch"');
    expect(lv.counted.commits).toEqual([]);
    expect(doc.checkouts[0].uncommitted.files[0].patch).toBeDefined();
    expect(fileSources(doc, 'acme/web', 'src/a.ts').map((x) => [x.layer, x.label])).toEqual([
      ['uncommitted', 'web'],
      ['merged', '#1'],
    ]);
    expect(fileSources(doc, 'acme/other', 'src/a.ts')).toEqual([]);
  });

  it('applyPatchBudget drops the patches past the document budget and marks them', () => {
    const doc = { checkouts: [checkout()], prs: [] } as unknown as CodeChangesDoc;
    applyPatchBudget(doc, 4);
    expect(doc.checkouts[0].uncommitted.files[0]).toMatchObject({ patchTruncated: true });
    expect(doc.checkouts[0].uncommitted.files[0].patch).toBeUndefined();
  });
});

describe('store + summary', () => {
  it('round trip; an unsafe id is neither read nor written', () => {
    const s = store();
    const doc: CodeChangesDoc = {
      version: 1,
      conversationId: 'abc-1',
      owner: { id: 'U', name: 'u' },
      updatedAt: 5,
      checkouts: [],
      prs: [],
      counted: { commits: [] },
    };
    s.write(doc);
    expect(s.read('abc-1')).toEqual(doc);
    expect(s.list().map((x) => x.conversationId)).toEqual(['abc-1']);
    expect(isStoreKey('../x')).toBe(false);
    expect(s.read('../x')).toBeUndefined();
  });

  it('sanitizeCodeChangesSummary keeps a summary and drops anything malformed', () => {
    const doc: CodeChangesDoc = {
      version: 1,
      conversationId: 'c',
      owner: { id: 'U', name: 'u' },
      updatedAt: 9,
      checkouts: [checkout()],
      prs: [],
      counted: { commits: [] },
    };
    const sum = summarizeCodeChanges(doc);
    expect(sanitizeCodeChangesSummary(JSON.parse(JSON.stringify(sum)))).toEqual(sum);
    expect(sanitizeCodeChangesSummary({ updatedAt: 'x' })).toBeUndefined();
    expect(sanitizeCodeChangesSummary(null)).toBeUndefined();
    expect(
      sanitizeCodeChangesSummary({
        updatedAt: 1,
        repos: [{ repo: 7 }],
        prs: [{ url: 'u', repo: 'r', state: 'weird' }],
      }),
    ).toMatchObject({
      repos: [],
      prs: [],
    });
  });
});

describe('createCodeChangesScheduler', () => {
  it('one run per key at a time; a trigger while running runs once more after the interval; immediate skips the delay', async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const runs: string[] = [];
      let release!: () => void;
      const run = vi.fn(
        (key: string) =>
          new Promise<void>((r) => {
            runs.push(key);
            release = r;
          }),
      );
      const sch = createCodeChangesScheduler(run, { now: () => t, minIntervalMs: 1000, delayMs: 100 });
      const p1 = sch.trigger('k');
      await vi.advanceTimersByTimeAsync(99);
      expect(runs).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toEqual(['k']);
      const p2 = sch.trigger('k');
      sch.trigger('k');
      release();
      await p1;
      t = 500;
      await vi.advanceTimersByTimeAsync(400);
      expect(runs).toEqual(['k']);
      t = 1000;
      await vi.advanceTimersByTimeAsync(600);
      expect(runs).toEqual(['k', 'k']);
      release();
      await p2;
      t = 5000;
      const p3 = sch.trigger('k', { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toEqual(['k', 'k', 'k']);
      release();
      await p3;
    } finally {
      vi.useRealTimers();
    }
  });
});
