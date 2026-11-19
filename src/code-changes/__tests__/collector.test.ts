/**
 * .prd/26 §3 · .prd/27 §4 — the collector over fake GitHub and fake checkouts; the store round trip; the scheduler.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubPullDetail, GitHubPullFile } from '../../link-metadata-fetcher';
import {
  applyPatchBudget,
  collectCodeChanges,
  createCodeChangesScheduler,
  fileSources,
  keepKnownPatches,
  keepLastRead,
  listView,
} from '../collector';
import { prFileOf, pullRefOf, sessionPrChanges } from '../pr-changes';
import { CodeChangesStore, isStoreKey, MAX_COUNTED_COMMITS } from '../store';
import { sanitizeCodeChangesSummary, summarizeCodeChanges } from '../summary';
import type { ChangedFile, CheckoutChanges, CodeChangesDoc } from '../types';

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
    // Each PR's detail once, and once more for #1 after its files (the head and base must have held).
    expect(deps.fetchPullDetail).toHaveBeenCalledTimes(3);
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

describe('pr-changes — a merged record from before .prd/29 is read once for its closing refs (G4)', () => {
  it('no closes stored: the detail is read again (files reused, not listed); the next collect reads nothing', async () => {
    const merged = detail(1, { merged: true, merged_at: '2026-11-16T02:00:00Z', base_sha: 'b'.repeat(40) });
    const first = await sessionPrChanges(['https://github.com/acme/web/pull/1'], START, [], prDeps({ 1: merged }));
    // As stored before .prd/29: no closing refs, no relation read time.
    const { closes: _c, relReadAt: _r, ...legacyRecord } = first[0];
    const legacy = [legacyRecord];
    const deps = prDeps({ 1: { ...merged, body: 'Closes #9' } });
    const again = await sessionPrChanges(['https://github.com/acme/web/pull/1'], START, legacy, deps);
    expect(deps.fetchPullDetail).toHaveBeenCalledTimes(1);
    expect(deps.fetchPullFiles).not.toHaveBeenCalled();
    expect(again[0]).toMatchObject({ state: 'merged', closes: ['https://github.com/acme/web/issues/9'] });
    expect(again[0].files).toEqual(legacyRecord.files);
    expect(typeof again[0].relReadAt).toBe('number');
    // Read once: the record has its closing refs now, so it is reused as is.
    const deps3 = prDeps({ 1: merged });
    const third = await sessionPrChanges(['https://github.com/acme/web/pull/1'], START, again, deps3);
    expect(deps3.fetchPullDetail).not.toHaveBeenCalled();
    expect(third).toEqual(again);
  });
});

describe('pr-changes — a failed files read is asked again (#1299 review)', () => {
  it('files failure → filesStale; the next collect with the same head asks again and clears it', async () => {
    const d = detail(4, { merged: true, merged_at: '2026-11-16T03:00:00Z' });
    const failing = { ...prDeps({ 4: d }), fetchPullFiles: vi.fn(async () => undefined) };
    const first = await sessionPrChanges(['https://github.com/acme/web/pull/4'], START, [], failing);
    expect(first[0]).toMatchObject({ state: 'merged', filesStale: true, files: [] });
    const ok = prDeps({ 4: d });
    const second = await sessionPrChanges(['https://github.com/acme/web/pull/4'], START, first, ok);
    expect(ok.fetchPullFiles).toHaveBeenCalledTimes(1);
    expect(second[0].filesStale).toBeUndefined();
    expect(second[0].files.map((f) => f.path)).toEqual(['src/a.ts']);
    // Settled and whole now: not asked again (the two detail reads were around the files read).
    const third = await sessionPrChanges(['https://github.com/acme/web/pull/4'], START, second, ok);
    expect(ok.fetchPullDetail).toHaveBeenCalledTimes(2);
    expect(third).toEqual(second);
  });

  it('a partial read (a later page failed) is stale too', async () => {
    const deps = {
      ...prDeps({ 5: detail(5) }),
      fetchPullFiles: vi.fn(async () => ({ files: [FILE], truncated: true, complete: false })),
    };
    const prs = await sessionPrChanges(['https://github.com/acme/web/pull/5'], START, [], deps);
    expect(prs[0]).toMatchObject({ filesStale: true, filesTruncated: true });
  });
});

describe('collectCodeChanges', () => {
  it('stores one document, summarises the four layers, reports new merges and new commits once', async () => {
    const s = store();
    const deps = {
      ...prDeps({ 1: detail(1, { merged: true, merged_at: '2026-11-16T02:00:00Z' }), 2: detail(2) }),
      store: s,
      listCheckoutDirs: async () => ({ dirs: ['/s/web', '/s/clean'] }),
      checkoutChanges: vi.fn(async ({ dir, commits }: { dir: string; commits?: { skip: ReadonlySet<string> } }) =>
        dir === '/s/web'
          ? {
              ...checkout(),
              sessionCommits: commits?.skip.has('f'.repeat(40))
                ? []
                : [{ sha: 'f'.repeat(40), at: START + 60_000, additions: 4, deletions: 1 }],
            }
          : checkout({ id: 'c2', dir: 'clean', uncommitted: { files: [], additions: 0, deletions: 0 } }),
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
    // Not counted until the metrics took them: a collect before that hands them on again.
    expect(s.read('conv1')?.counted.commits).toEqual([]);
    const unmarked = await collectCodeChanges(input, deps);
    expect(unmarked.newCommits).toHaveLength(1);
    expect(unmarked.newMerges.map((p) => p.number)).toEqual([1]);
    expect(r.doc.checkouts[0]).not.toHaveProperty('sessionCommits');
    expect(r.newMerges.map((p) => p.number)).toEqual([1]);
    s.markCounted('conv1', { commits: r.newCommits.map((c) => c.sha), merges: r.newMerges.map((p) => p.id) });
    expect(s.read('conv1')?.counted).toEqual({ commits: ['f'.repeat(40)], merges: ['acme/web#1'] });

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
      checkouts: [
        checkout({
          committed: {
            files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 0, patch: '@@ c' }],
            additions: 3,
            deletions: 0,
            commits: [],
          },
        }),
      ],
      prs: [
        {
          id: 'acme/web#2',
          url: 'https://github.com/acme/web/pull/2',
          repo: 'acme/web',
          number: 2,
          state: 'open',
          additions: 4,
          deletions: 0,
          changedFiles: 1,
          files: [{ path: 'src/a.ts', status: 'modified', additions: 4, deletions: 0, patch: '@@ p' }],
          fetchedAt: 1,
        },
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
    expect(fileSources(doc, 'acme/web', 'src/a.ts').map((x) => [x.layer, x.label, x.prNumber, x.file.patch])).toEqual([
      ['uncommitted', 'web', undefined, '@@ -1 +1 @@\n-x\n+y'],
      ['committed', 'web', undefined, '@@ c'],
      ['pr', '#2', 2, '@@ p'],
      ['merged', '#1', 1, '@@'],
    ]);
    expect(fileSources(doc, 'acme/other', 'src/a.ts')).toEqual([]);
  });

  it('applyPatchBudget keeps patches in layer order until the sum passes the budget; counts stay', () => {
    const f = (p: string) => ({
      path: p,
      status: 'modified' as const,
      additions: 2,
      deletions: 1,
      patch: 'x'.repeat(10),
    });
    const doc = {
      checkouts: [
        checkout({
          uncommitted: { files: [f('u1'), f('u2')], additions: 4, deletions: 2 },
          committed: { files: [f('c1')], additions: 2, deletions: 1, commits: [] },
        }),
      ],
      prs: [{ files: [f('p1')] }],
    } as unknown as CodeChangesDoc;
    applyPatchBudget(doc, 25);
    const all = [...doc.checkouts[0].uncommitted.files, ...doc.checkouts[0].committed.files, ...doc.prs[0].files];
    expect(all.map((x) => [x.path, !!x.patch, !!x.patchTruncated])).toEqual([
      ['u1', true, false],
      ['u2', true, false],
      ['c1', false, true],
      ['p1', false, true],
    ]);
    expect(all.every((x) => x.additions === 2 && x.deletions === 1)).toBe(true);
  });
});

describe('the counting start (#1301 review)', () => {
  it('is fixed at the first call and kept; commits before it are not read for the metrics', async () => {
    const s = store();
    expect(s.countingSince(() => 111)).toBe(111);
    expect(s.countingSince(() => 999)).toBe(111);
    const readCheckout = vi.fn(async () => checkout());
    await collectCodeChanges(
      {
        conversationId: 'c9',
        owner: { id: 'U', name: 'u' },
        dirs: ['/s'],
        startedAt: 50,
        commitsSince: 111,
        prUrls: [],
      },
      {
        ...prDeps({}),
        store: s,
        listCheckoutDirs: async () => ({ dirs: ['/s/web'] }),
        checkoutChanges: readCheckout,
      },
    );
    expect(readCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/s/web', commits: { since: 111, skip: expect.any(Set) } }),
    );
    // A session that started after the counting start: its own start bounds the commits.
    await collectCodeChanges(
      {
        conversationId: 'c10',
        owner: { id: 'U', name: 'u' },
        dirs: ['/s'],
        startedAt: 500,
        commitsSince: 111,
        prUrls: [],
      },
      { ...prDeps({}), store: s, listCheckoutDirs: async () => ({ dirs: ['/s/web'] }), checkoutChanges: readCheckout },
    );
    expect(readCheckout).toHaveBeenLastCalledWith(
      expect.objectContaining({ commits: { since: 500, skip: expect.any(Set) } }),
    );
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
    expect(isStoreKey('../x')).toBe(false);
    expect(s.read('../x')).toBeUndefined();
    s.write({ ...doc, conversationId: '../escape' });
    expect(fs.existsSync(path.join(s.baseDir, '..', 'escape.json'))).toBe(false);
    expect(s.read('abc-1')).toEqual(doc);
  });

  it('a damaged nested record sends the read to the backup instead of breaking every reader', () => {
    const s = store();
    const doc: CodeChangesDoc = {
      version: 1,
      conversationId: 'abc-2',
      owner: { id: 'U', name: 'u' },
      updatedAt: 5,
      checkouts: [],
      prs: [],
      counted: { commits: [] },
    };
    s.write(doc);
    s.write({ ...doc, updatedAt: 6 });
    fs.writeFileSync(path.join(s.baseDir, 'abc-2.json'), JSON.stringify({ ...doc, prs: [null] }));
    expect(s.read('abc-2')?.updatedAt).toBe(5);
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

describe('createCodeChangesScheduler — across sessions (#1299 review)', () => {
  it('at most `concurrency` runs; a failed run frees its slot; one key never runs twice at once', async () => {
    const started: string[] = [];
    const active = new Set<string>();
    let overlap = false;
    const releases: Record<string, (fail?: boolean) => void> = {};
    const run = (key: string) =>
      new Promise<void>((resolve, reject) => {
        if (active.has(key)) overlap = true;
        active.add(key);
        started.push(key);
        releases[key] = (fail) => {
          active.delete(key);
          fail ? reject(new Error('boom')) : resolve();
        };
      });
    const sch = createCodeChangesScheduler(run, { delayMs: 0, minIntervalMs: 0, concurrency: 2 });
    const tick = () => new Promise((r) => setTimeout(r, 5));
    sch.trigger('a');
    sch.trigger('b');
    sch.trigger('c');
    await tick();
    expect(started).toEqual(['a', 'b']);
    // While a and b hold the slots, a is triggered again and c waits: nothing more starts.
    sch.trigger('a');
    sch.trigger('c');
    await tick();
    expect(started).toEqual(['a', 'b']);
    releases.a(true);
    await tick();
    expect(started.slice(0, 3)).toEqual(['a', 'b', 'c']);
    releases.b();
    await tick();
    expect(started).toEqual(['a', 'b', 'c', 'a']);
    releases.c();
    releases.a();
    await sch.idle();
    expect(overlap).toBe(false);
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

describe('the fourth review round (#1299)', () => {
  it('PR files are read again when the base moved, or the budget dropped their patches; a fork head is kept', async () => {
    const url = 'https://github.com/acme/web/pull/6';
    const deps = prDeps({ 6: detail(6, { base_sha: 'b1', head_repo: 'Someone/Web' }) });
    const first = await sessionPrChanges([url], START, [], deps);
    expect(first[0]).toMatchObject({ baseSha: 'b1', headRepo: 'someone/web' });
    await sessionPrChanges([url], START, first, deps);
    expect(deps.fetchPullFiles).toHaveBeenCalledTimes(1);
    const moved = prDeps({ 6: detail(6, { base_sha: 'b2' }) });
    await sessionPrChanges([url], START, first, moved);
    expect(moved.fetchPullFiles).toHaveBeenCalledTimes(1);
    const cut = prDeps({ 6: detail(6, { base_sha: 'b1' }) });
    await sessionPrChanges([url], START, [{ ...first[0], patchesDropped: true }], cut);
    expect(cut.fetchPullFiles).toHaveBeenCalledTimes(1);
    // A settled PR whose patches were cut is read again too.
    const merged = prDeps({ 6: detail(6, { merged: true, base_sha: 'b1' }) });
    await sessionPrChanges([url], START, [{ ...first[0], state: 'merged', patchesDropped: true }], merged);
    expect(merged.fetchPullFiles).toHaveBeenCalledTimes(1);
    // Same repository: no headRepo.
    const own = await sessionPrChanges([url], START, [], prDeps({ 6: detail(6, { head_repo: 'acme/web' }) }));
    expect(own[0].headRepo).toBeUndefined();
  });

  it('applyPatchBudget marks a PR whose patches it dropped', () => {
    const big = 'x'.repeat(100);
    const pr = (id: string) => ({
      id,
      url: `https://github.com/acme/web/pull/${id}`,
      repo: 'acme/web',
      number: 1,
      state: 'open' as const,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      files: [{ path: 'a', status: 'modified' as const, additions: 1, deletions: 0, patch: big }],
      fetchedAt: 1,
    });
    const doc: CodeChangesDoc = {
      version: 1,
      conversationId: 'c',
      owner: { id: 'U', name: 'u' },
      updatedAt: 1,
      checkouts: [],
      prs: [pr('1'), pr('2')],
      counted: { commits: [] },
    };
    applyPatchBudget(doc, 150);
    expect(doc.prs[0].patchesDropped).toBeUndefined();
    expect(doc.prs[1]).toMatchObject({ patchesDropped: true, files: [{ patchTruncated: true }] });
  });

  it('keepLastRead: a layer that failed keeps the last read with the reason; a read thrown away keeps all of it', () => {
    const old = checkout({
      committed: {
        files: [{ path: 'c.ts', status: 'added', additions: 2, deletions: 0 }],
        additions: 2,
        deletions: 0,
        commits: [],
      },
    });
    const failed = checkout({
      uncommitted: { files: [], additions: 0, deletions: 0 },
      committed: { files: [], additions: 0, deletions: 0, commits: [], skipped: 'git-diff-failed' },
    });
    const kept = keepLastRead(failed, old);
    expect(kept.uncommitted.files).toEqual([]);
    expect(kept.committed).toMatchObject({ skipped: 'git-diff-failed', additions: 2, files: [{ path: 'c.ts' }] });
    const changed = checkout({
      repo: 'local:web',
      uncommitted: { files: [], additions: 0, deletions: 0, skipped: 'repo-changed-during-read' },
      committed: { files: [], additions: 0, deletions: 0, commits: [], skipped: 'repo-changed-during-read' },
    });
    const whole = keepLastRead(changed, old);
    expect(whole.repo).toBe('acme/web');
    expect(whole.uncommitted).toMatchObject({ skipped: 'repo-changed-during-read', additions: 1 });
    expect(whole.committed).toMatchObject({ skipped: 'repo-changed-during-read', additions: 2 });
    expect(keepLastRead(failed, undefined)).toBe(failed);
    const fine = checkout();
    expect(keepLastRead(fine, old)).toBe(fine);
  });

  it('a stored file whose patch is not text sends the read to the backup; markCounted adds and caps', () => {
    const s = store();
    const doc: CodeChangesDoc = {
      version: 1,
      conversationId: 'abc-3',
      owner: { id: 'U', name: 'u' },
      updatedAt: 5,
      checkouts: [checkout()],
      prs: [],
      counted: { commits: [] },
    };
    s.write(doc);
    s.write({ ...doc, updatedAt: 6 });
    const bad = {
      ...doc,
      updatedAt: 7,
      checkouts: [
        checkout({
          uncommitted: {
            files: [{ path: 'a', status: 'modified', additions: 1, deletions: 0, patch: 1 as unknown as string }],
            additions: 1,
            deletions: 0,
          },
        }),
      ],
    };
    fs.writeFileSync(path.join(s.baseDir, 'abc-3.json'), JSON.stringify(bad));
    expect(s.read('abc-3')?.updatedAt).toBe(5);
    s.markCounted('abc-3', { commits: ['a'.repeat(40)] });
    s.markCounted('abc-3', { commits: ['a'.repeat(40), 'b'.repeat(40)], merges: ['acme/web#1'] });
    expect(s.read('abc-3')?.counted).toEqual({ commits: ['a'.repeat(40), 'b'.repeat(40)], merges: ['acme/web#1'] });
    // Past the cap the oldest go first; the newest stay.
    const sha = (i: number) => i.toString(16).padStart(40, '0');
    s.markCounted('abc-3', { commits: Array.from({ length: 1500 }, (_, i) => sha(i)) });
    s.markCounted('abc-3', { commits: Array.from({ length: 1500 }, (_, i) => sha(1500 + i)) });
    const kept = s.read('abc-3')!.counted.commits;
    expect(kept).toHaveLength(MAX_COUNTED_COMMITS);
    expect(kept).not.toContain('a'.repeat(40));
    expect(kept).not.toContain(sha(999));
    expect(kept[kept.length - 1]).toBe(sha(2999));
  });

  it('a closed PR is asked again (it can be reopened); a merged one is not', async () => {
    const url = 'https://github.com/acme/web/pull/8';
    const closed = await sessionPrChanges([url], START, [], prDeps({ 8: detail(8, { state: 'closed' }) }));
    expect(closed[0].state).toBe('closed');
    const reopened = prDeps({ 8: detail(8, { state: 'open' }) });
    expect((await sessionPrChanges([url], START, closed, reopened))[0].state).toBe('open');
    expect(reopened.fetchPullDetail).toHaveBeenCalledTimes(1);
    const merged = await sessionPrChanges([url], START, [], prDeps({ 8: detail(8, { merged: true }) }));
    const again = prDeps({ 8: detail(8, { merged: true }) });
    await sessionPrChanges([url], START, merged, again);
    expect(again.fetchPullDetail).not.toHaveBeenCalled();
  });

  it('a config that could not be read this time keeps the last read whole; the summary says a committed layer was not read', () => {
    const old = checkout();
    const unread = checkout({
      repo: 'local:web',
      uncommitted: { files: [], additions: 0, deletions: 0, skipped: 'git-config-unreadable' },
      committed: { files: [], additions: 0, deletions: 0, commits: [], skipped: 'git-config-unreadable' },
    });
    const kept = keepLastRead(unread, old);
    expect(kept.repo).toBe('acme/web');
    expect(kept.uncommitted).toMatchObject({ skipped: 'git-config-unreadable', additions: 1 });
    // A refusal is not kept over: that checkout shows why it is not read.
    const refused = checkout({
      uncommitted: { files: [], additions: 0, deletions: 0, skipped: 'repo-config-runs-commands' },
      committed: { files: [], additions: 0, deletions: 0, commits: [], skipped: 'repo-config-runs-commands' },
    });
    expect(keepLastRead(refused, old)).toBe(refused);
    const doc: CodeChangesDoc = {
      version: 1,
      conversationId: 'c',
      owner: { id: 'U', name: 'u' },
      updatedAt: 1,
      checkouts: [
        checkout({ committed: { files: [], additions: 0, deletions: 0, commits: [], skipped: 'git-diff-failed' } }),
      ],
      prs: [],
      counted: { commits: [] },
    };
    expect(summarizeCodeChanges(doc).repos[0].skipped).toBe('git-diff-failed');
  });

  it('a moved PR head reads its files again', async () => {
    const url = 'https://github.com/acme/web/pull/9';
    const first = await sessionPrChanges([url], START, [], prDeps({ 9: detail(9, { head_sha: 'a'.repeat(40) }) }));
    const same = prDeps({ 9: detail(9, { head_sha: 'a'.repeat(40) }) });
    await sessionPrChanges([url], START, first, same);
    expect(same.fetchPullFiles).not.toHaveBeenCalled();
    const pushed = prDeps({ 9: detail(9, { head_sha: 'b'.repeat(40) }) });
    await sessionPrChanges([url], START, first, pushed);
    expect(pushed.fetchPullFiles).toHaveBeenCalledTimes(1);
  });

  it('patches are cut as each checkout arrives, not only once the document is whole', async () => {
    const s2 = store();
    const big = 'x'.repeat(4 * 1024 * 1024);
    const made: CheckoutChanges[] = [];
    const seenAtCall: Array<boolean | undefined> = [];
    const deps = {
      ...prDeps({}),
      store: s2,
      listCheckoutDirs: async () => ({ dirs: ['/s/a', '/s/b', '/s/c'] }),
      checkoutChanges: vi.fn(async ({ dir }: { dir: string }) => {
        // When the third checkout is read, the second's patch is already gone (the budget is 6 MiB).
        seenAtCall.push(made[1] ? made[1].uncommitted.files[0].patch === undefined : undefined);
        const c = checkout({
          id: dir,
          dir,
          uncommitted: {
            files: [{ path: 'f', status: 'modified', additions: 1, deletions: 0, patch: big }],
            additions: 1,
            deletions: 0,
          },
        });
        made.push(c);
        return c;
      }),
    };
    await collectCodeChanges({ conversationId: 'cut', owner: { id: 'U', name: 'u' }, dirs: ['/s'], prUrls: [] }, deps);
    expect(seenAtCall).toEqual([undefined, undefined, true]);
    expect(made[0].uncommitted.files[0].patch).toBe(big);
  });

  it('a moved PR head or base gives the new files, not the stored ones', async () => {
    const url = 'https://github.com/acme/web/pull/10';
    const first = await sessionPrChanges(
      [url],
      START,
      [],
      prDeps({ 10: detail(10, { head_sha: 'a'.repeat(40), base_sha: 'b1' }) }),
    );
    expect(first[0].files[0].patch).toContain('+b');
    const NEW: GitHubPullFile = { ...FILE, filename: 'src/new.ts', patch: '@@ -0,0 +1 @@\n+fresh' };
    for (const over of [
      { head_sha: 'c'.repeat(40), base_sha: 'b1' },
      { head_sha: 'a'.repeat(40), base_sha: 'b2' },
    ]) {
      const deps = {
        ...prDeps({ 10: detail(10, over) }),
        fetchPullFiles: vi.fn(async () => ({ files: [NEW], truncated: false })),
      };
      const next = await sessionPrChanges([url], START, first, deps);
      expect(next[0].files.map((f) => [f.path, f.patch])).toEqual([['src/new.ts', '@@ -0,0 +1 @@\n+fresh']]);
    }
  });

  it('a push between the detail and the files read marks the files stale (one revision, not two)', async () => {
    const url = 'https://github.com/acme/web/pull/11';
    const heads = ['a'.repeat(40), 'b'.repeat(40)];
    const deps = {
      ...prDeps({}),
      fetchPullDetail: vi.fn(async () => detail(11, { head_sha: heads.shift() ?? 'b'.repeat(40) })),
    };
    const prs = await sessionPrChanges([url], START, [], deps);
    expect(prs[0].filesStale).toBe(true);
  });

  it("an earlier checkout's committed patches never push out a later checkout's uncommitted one", async () => {
    const s3 = store();
    const big = 'y'.repeat(4 * 1024 * 1024);
    const one = (patchIn: 'uncommitted' | 'committed', id: string) =>
      checkout({
        id,
        dir: id,
        uncommitted: {
          files:
            patchIn === 'uncommitted'
              ? [{ path: 'u', status: 'modified', additions: 1, deletions: 0, patch: big }]
              : [],
          additions: 1,
          deletions: 0,
        },
        committed: {
          files:
            patchIn === 'committed' ? [{ path: 'c', status: 'modified', additions: 1, deletions: 0, patch: big }] : [],
          additions: 1,
          deletions: 0,
          commits: [],
        },
      });
    const r = await collectCodeChanges(
      { conversationId: 'order', owner: { id: 'U', name: 'u' }, dirs: ['/s'], prUrls: [] },
      {
        ...prDeps({}),
        store: s3,
        listCheckoutDirs: async () => ({ dirs: ['/s/a', '/s/b'] }),
        checkoutChanges: async ({ dir }: { dir: string }) =>
          dir === '/s/a' ? one('committed', 'a') : one('uncommitted', 'b'),
      },
    );
    const b = r.doc.checkouts.find((c) => c.id === 'b')!;
    const a = r.doc.checkouts.find((c) => c.id === 'a')!;
    expect(b.uncommitted.files[0].patch).toBe(big);
    expect(a.committed.files[0].patch).toBeUndefined();
  });
});

describe('a PR GitHub does not answer for (a private repository the host token cannot read)', () => {
  const url = (n: number, repo = 'acme/web') => `https://github.com/${repo}/pull/${n}`;
  const localPull = (n: number) => ({
    id: `acme/web#${n}`,
    url: url(n),
    repo: 'acme/web',
    number: n,
    state: 'merged' as const,
    additions: 3,
    deletions: 1,
    changedFiles: 1,
    files: [
      { path: `f${n}.ts`, status: 'modified' as const, additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
    ],
    mergedAt: START + n * 1000,
    source: 'local' as const,
  });
  const f = (path: string, patch?: string): ChangedFile => ({
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    ...(patch ? { patch } : { patchTruncated: true as const }),
  });
  const clean = (dir: string): CheckoutChanges => ({
    id: dir,
    repo: 'acme/web',
    dir,
    uncommitted: { files: [], additions: 0, deletions: 0 },
    committed: { files: [], additions: 0, deletions: 0, commits: [] },
  });

  it('is asked of the checkouts: found → a merged PR read there; not found anywhere → listed as unread', async () => {
    const s = store();
    const deps = prDeps({});
    const readCheckout = vi.fn(async (input: { dir: string; pulls?: Array<{ number: number; repo: string }> }) => ({
      ...clean(input.dir),
      // The first checkout has #5 merged; the second has #6. #9 is in neither.
      pulls: (input.pulls ?? [])
        .filter((a) => (input.dir === '/s/a' ? a.number === 5 : a.number === 6))
        .map((a) => localPull(a.number)),
    }));
    const input = {
      conversationId: 'c-local',
      owner: { id: 'U', name: 'u' },
      dirs: ['/s'],
      startedAt: START,
      prUrls: [url(5), url(6), url(9)],
    };
    const ctx = {
      ...deps,
      store: s,
      listCheckoutDirs: async () => ({ dirs: ['/s/a', '/s/b'] }),
      checkoutChanges: readCheckout as never,
    };
    const { doc, newMerges } = await collectCodeChanges(input, ctx);
    // What was found in the first checkout is not asked of the second.
    expect(readCheckout.mock.calls.map((c) => [c[0].dir, (c[0].pulls ?? []).map((a) => a.number)])).toEqual([
      ['/s/a', [5, 6, 9]],
      ['/s/b', [6, 9]],
    ]);
    expect(readCheckout.mock.calls[0][0].pulls?.[0]).toEqual({
      id: 'acme/web#5',
      url: url(5),
      repo: 'acme/web',
      number: 5,
    });
    // Newest merge first; stamped when collected.
    expect(doc.prs.map((p) => [p.number, p.source, p.fetchedAt])).toEqual([
      [6, 'local', START + 7200_000],
      [5, 'local', START + 7200_000],
    ]);
    expect(doc.unreadPrs).toEqual([{ url: url(9), repo: 'acme/web', number: 9 }]);
    expect(newMerges.map((p) => p.id)).toEqual(['acme/web#6', 'acme/web#5']);
    expect(summarizeCodeChanges(doc).layers.merged).toEqual({ files: 2, additions: 6, deletions: 2 });
    // The next collect reuses the two (merged: they do not change) without asking GitHub or the checkouts for them.
    deps.fetchPullDetail.mockClear();
    readCheckout.mockClear();
    const again = await collectCodeChanges(input, ctx);
    expect(deps.fetchPullDetail.mock.calls.map((c) => c[2])).toEqual([9]);
    expect(readCheckout.mock.calls.map((c) => (c[0].pulls ?? []).map((a) => a.number))).toEqual([[9], [9]]);
    expect(again.doc.prs.map((p) => p.number)).toEqual([6, 5]);
    expect(again.doc.unreadPrs).toEqual([{ url: url(9), repo: 'acme/web', number: 9 }]);
  });

  it('a local record whose patches the budget dropped is read there again and replaced; none unread → no list', async () => {
    const s = store();
    s.write({
      version: 1,
      conversationId: 'c-local2',
      owner: { id: 'U', name: 'u' },
      updatedAt: 1,
      checkouts: [],
      prs: [{ ...localPull(5), files: [], patchesDropped: true, fetchedAt: 1 }],
      counted: { commits: [] },
    });
    const readCheckout = vi.fn(async (input: { dir: string; pulls?: Array<{ number: number }> }) => ({
      ...clean(input.dir),
      pulls: (input.pulls ?? []).map((a) => localPull(a.number)),
    }));
    const { doc } = await collectCodeChanges(
      { conversationId: 'c-local2', owner: { id: 'U', name: 'u' }, dirs: ['/s'], startedAt: START, prUrls: [url(5)] },
      {
        ...prDeps({}),
        store: s,
        listCheckoutDirs: async () => ({ dirs: ['/s/a'] }),
        checkoutChanges: readCheckout as never,
      },
    );
    expect(doc.prs).toHaveLength(1);
    expect(doc.prs[0].files.map((f) => f.path)).toEqual(['f5.ts']);
    expect(doc.prs[0]).not.toHaveProperty('patchesDropped');
    expect(doc).not.toHaveProperty('unreadPrs');
  });

  it('a found PR’s patches are cut against the same PR budget as GitHub’s, as it is read', async () => {
    const s = store();
    const deps = {
      ...prDeps({ 1: detail(1) }),
      // 24 files of 250 KB (each under the 256 KB a patch keeps): GitHub's #1 takes nearly the whole 6 MiB.
      fetchPullFiles: vi.fn(async () => ({
        files: Array.from({ length: 24 }, (_, i) => ({
          ...FILE,
          filename: `g${i}.ts`,
          patch: `@@ -1 +1 @@\n+${'x'.repeat(250 * 1024)}`,
        })),
        truncated: false,
      })),
    };
    const dropped: boolean[] = [];
    const readCheckout = vi.fn(
      async (input: { dir: string; pulls?: Array<{ number: number }>; trimPulls?: (f: unknown[]) => boolean }) => {
        const pulls = (input.pulls ?? []).map((a) => {
          const p = {
            ...localPull(a.number),
            files: [{ ...localPull(a.number).files[0], patch: `@@ -1 +1 @@\n+${'y'.repeat(2 * 1024 * 1024)}` }],
          };
          dropped.push(!!input.trimPulls?.(p.files));
          return p;
        });
        return { ...clean(input.dir), pulls };
      },
    );
    await collectCodeChanges(
      {
        conversationId: 'c-local3',
        owner: { id: 'U', name: 'u' },
        dirs: ['/s'],
        startedAt: START,
        prUrls: [url(1), url(5)],
      },
      { ...deps, store: s, listCheckoutDirs: async () => ({ dirs: ['/s/a'] }), checkoutChanges: readCheckout as never },
    );
    // GitHub's #1 took nearly all of the 6 MiB: the local #5's 2 MiB patch does not fit.
    expect(dropped).toEqual([true]);
  });

  it('a checkout read thrown away (its git dirs changed meanwhile) gives back what its PRs charged to the budget', async () => {
    const s = store();
    let calls = 0;
    const readCheckout = vi.fn(
      async (input: { dir: string; pulls?: Array<{ number: number }>; trimPulls?: (f: unknown[]) => boolean }) => {
        calls++;
        const p = {
          ...localPull(5),
          files: [{ ...localPull(5).files[0], patch: `@@ -1 +1 @@\n+${'y'.repeat(4 * 1024 * 1024)}` }],
        };
        const dropped = !!input.trimPulls?.(p.files);
        // The first checkout's git dirs changed during the read: nothing of it is kept (checkoutChanges answers unread).
        if (calls === 1)
          return {
            ...clean(input.dir),
            uncommitted: { files: [], additions: 0, deletions: 0, skipped: 'repo-changed-during-read' },
          };
        return { ...clean(input.dir), pulls: [{ ...p, ...(dropped ? { patchesDropped: true as const } : {}) }] };
      },
    );
    const { doc } = await collectCodeChanges(
      { conversationId: 'c-local4', owner: { id: 'U', name: 'u' }, dirs: ['/s'], startedAt: START, prUrls: [url(5)] },
      {
        ...prDeps({}),
        store: s,
        listCheckoutDirs: async () => ({ dirs: ['/s/a', '/s/b'] }),
        checkoutChanges: readCheckout as never,
      },
    );
    // 4 MiB charged twice would not fit 6 MiB; given back once, the second read keeps its patch.
    expect(doc.prs[0].files[0].patch?.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(doc.prs[0]).not.toHaveProperty('patchesDropped');
  });

  it('keepKnownPatches: a partial local read keeps the last read’s patches for the files it missed (same head and base)', () => {
    const last = { ...localPull(5), headSha: 'h', baseSha: 'b', files: [f('a', '+a'), f('b')], fetchedAt: 1 };
    const next = {
      ...localPull(5),
      headSha: 'h',
      baseSha: 'b',
      files: [f('a'), f('b', '+b')],
      filesStale: true as const,
      fetchedAt: 2,
    };
    keepKnownPatches({ ...next, files: next.files.map((x) => ({ ...x })) }, last);
    const settled = { ...next, files: next.files.map((x) => ({ ...x })), failedPatches: ['a'] };
    keepKnownPatches(settled, last);
    expect(settled.files.map((x) => [x.path, x.patch, x.patchTruncated])).toEqual([
      ['a', '+a', undefined],
      ['b', '+b', undefined],
    ]);
    // The only file whose read failed got its patch from the last read: nothing to read again.
    expect(settled).not.toHaveProperty('filesStale');
    // One the last read did not have either: still to read again.
    const still = { ...next, files: [f('a'), f('b', '+b'), f('c')], failedPatches: ['a', 'c'] };
    keepKnownPatches(still, last);
    expect(still.filesStale).toBe(true);
    // Another head: nothing carried over.
    const moved = { ...next, headSha: 'h2', files: [f('a')], failedPatches: ['a'] };
    keepKnownPatches(moved, last);
    expect(moved.files[0].patch).toBeUndefined();
    expect(moved.filesStale).toBe(true);
  });

  it('a partial local read again, through the collector: the stored patch of the file it missed stays, and the PR settles', async () => {
    const s = store();
    s.write({
      version: 1,
      conversationId: 'c-local5',
      owner: { id: 'U', name: 'u' },
      updatedAt: 1,
      checkouts: [],
      prs: [
        {
          ...localPull(5),
          headSha: 'h',
          baseSha: 'b',
          files: [f('a.ts', '+a'), f('b.ts')],
          filesStale: true,
          fetchedAt: 1,
        },
      ],
      counted: { commits: [] },
    });
    const readCheckout = vi.fn(async (input: { dir: string; pulls?: Array<{ number: number }> }) => ({
      ...clean(input.dir),
      pulls: (input.pulls ?? []).map((a) => ({
        ...localPull(a.number),
        headSha: 'h',
        baseSha: 'b',
        files: [f('a.ts'), f('b.ts', '+b')],
        filesStale: true as const,
        failedPatches: ['a.ts'],
      })),
    }));
    const { doc } = await collectCodeChanges(
      { conversationId: 'c-local5', owner: { id: 'U', name: 'u' }, dirs: ['/s'], startedAt: START, prUrls: [url(5)] },
      {
        ...prDeps({}),
        store: s,
        listCheckoutDirs: async () => ({ dirs: ['/s/a'] }),
        checkoutChanges: readCheckout as never,
      },
    );
    expect(doc.prs[0].files.map((x) => [x.path, x.patch])).toEqual([
      ['a.ts', '+a'],
      ['b.ts', '+b'],
    ]);
    expect(doc.prs[0]).not.toHaveProperty('filesStale');
    expect(doc.prs[0]).not.toHaveProperty('failedPatches');
    expect(s.read('c-local5')?.prs[0].files.map((x) => x.patch)).toEqual(['+a', '+b']);
  });

  it('a PR one clone read only in part is asked of the next clone, which completes it', async () => {
    const s = store();
    const readCheckout = vi.fn(async (input: { dir: string; pulls?: Array<{ number: number }> }) => ({
      ...clean(input.dir),
      pulls: (input.pulls ?? []).map((a) =>
        input.dir === '/s/a'
          ? {
              ...localPull(a.number),
              headSha: 'h',
              baseSha: 'b',
              files: [f('a.ts', '+a'), f('b.ts')],
              filesStale: true as const,
              failedPatches: ['b.ts'],
            }
          : {
              ...localPull(a.number),
              headSha: 'h',
              baseSha: 'b',
              files: [f('a.ts'), f('b.ts', '+b')],
              filesStale: true as const,
              failedPatches: ['a.ts'],
            },
      ),
    }));
    const { doc } = await collectCodeChanges(
      { conversationId: 'c-local6', owner: { id: 'U', name: 'u' }, dirs: ['/s'], startedAt: START, prUrls: [url(5)] },
      {
        ...prDeps({}),
        store: s,
        listCheckoutDirs: async () => ({ dirs: ['/s/a', '/s/b'] }),
        checkoutChanges: readCheckout as never,
      },
    );
    expect(readCheckout.mock.calls.map((c) => [c[0].dir, (c[0].pulls ?? []).map((a) => a.number)])).toEqual([
      ['/s/a', [5]],
      ['/s/b', [5]],
    ]);
    expect(doc.prs[0].files.map((x) => [x.path, x.patch])).toEqual([
      ['a.ts', '+a'],
      ['b.ts', '+b'],
    ]);
    expect(doc.prs[0]).not.toHaveProperty('filesStale');
  });

  it('sessionPrChanges: unread lists only what neither GitHub nor a stored record gives', async () => {
    const unread: Array<{ number: number }> = [];
    const stored = { ...localPull(7), fetchedAt: 1, filesStale: undefined };
    const apiOld = { ...localPull(8), source: undefined, closes: [], fetchedAt: 1, state: 'open' as const };
    const out = await sessionPrChanges(
      [url(5), url(7), url(8), url(10, 'x/y')],
      START,
      [stored, apiOld],
      prDeps({}),
      undefined,
      unread as never,
    );
    expect(out.map((p) => p.number).sort()).toEqual([7, 8]);
    expect(unread.map((a) => a.number)).toEqual([5, 10]);
  });
});
