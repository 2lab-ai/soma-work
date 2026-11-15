/**
 * .prd/26 §5 (#1297) — code-change metrics from the session's code changes: fixed ids, real times, once each.
 */
import { describe, expect, it, vi } from 'vitest';
import { MetricsEventEmitter } from '../../metrics/event-emitter';
import type { MetricsEvent } from '../../metrics/types';
import { addMergedPr, emitCodeMetrics, type MergeStats } from '../metrics';
import type { PrChanges } from '../types';

const MERGED_AT = Date.parse('2026-11-16T02:00:00Z');
const PR: PrChanges = {
  id: 'acme/web#7',
  url: 'https://github.com/acme/web/pull/7',
  repo: 'acme/web',
  number: 7,
  state: 'merged',
  additions: 120,
  deletions: 8,
  changedFiles: 3,
  mergedAt: MERGED_AT,
  files: [],
  fetchedAt: 1,
};

function sink() {
  const calls: Array<{ type: string; meta: Record<string, unknown>; opts?: { id?: string; timestamp?: number } }> = [];
  const emitter = {
    emitGitHubEvent: vi.fn(
      async (
        type: string,
        _u: string,
        _n: string,
        _k: string,
        meta: Record<string, unknown>,
        opts?: { id?: string; timestamp?: number },
      ) => {
        calls.push({ type, meta, opts });
      },
    ),
  };
  return { calls, emitter };
}

describe('emitCodeMetrics', () => {
  it('a merged PR: merge_lines_added with GitHub’s counts, on its merge day, id from its URL; the card total once', () => {
    const { calls, emitter } = sink();
    const recordMerge = vi.fn(() => true);
    emitCodeMetrics(
      { newMerges: [PR], newCommits: [] },
      { userId: 'U1', userName: 'z', sessionKey: 'k' },
      { emitter, recordMerge },
    );
    expect(calls).toEqual([
      {
        type: 'merge_lines_added',
        meta: { prNumber: 7, prUrl: PR.url, linesAdded: 120, linesDeleted: 8 },
        opts: { id: `merge_lines:${PR.url}`, timestamp: MERGED_AT, ifAbsent: true },
      },
    ]);
    expect(recordMerge).toHaveBeenCalledWith({
      prNumber: 7,
      prUrl: PR.url,
      linesAdded: 120,
      linesDeleted: 8,
      mergedAt: MERGED_AT,
    });
  });

  it('a commit: commit_created and code_lines_added with its line counts, ids from the sha, at its reflog time', () => {
    const { calls, emitter } = sink();
    const sha = 'a'.repeat(40);
    const delOnly = 'c'.repeat(40);
    const empty = 'b'.repeat(40);
    emitCodeMetrics(
      {
        newMerges: [],
        newCommits: [
          { sha, at: 5000, additions: 10, deletions: 2, repo: 'acme/web' },
          { sha: delOnly, at: 5500, additions: 0, deletions: 2, repo: 'acme/web' },
          { sha: empty, at: 6000, additions: 0, deletions: 0, repo: 'acme/web' },
        ],
      },
      { userId: 'U1', userName: 'z', sessionKey: 'k' },
      { emitter },
    );
    expect(calls.map((c) => [c.type, c.opts, c.meta.linesAdded, c.meta.linesDeleted])).toEqual([
      ['commit_created', { id: `commit:${sha}`, timestamp: 5000, ifAbsent: true }, 10, 2],
      ['code_lines_added', { id: `commit_lines:${sha}`, timestamp: 5000, ifAbsent: true }, 10, 2],
      ['commit_created', { id: `commit:${delOnly}`, timestamp: 5500, ifAbsent: true }, 0, 2],
      ['code_lines_added', { id: `commit_lines:${delOnly}`, timestamp: 5500, ifAbsent: true }, 0, 2],
      ['commit_created', { id: `commit:${empty}`, timestamp: 6000, ifAbsent: true }, 0, 0],
    ]);
  });

  it('a merge the session total already holds (the old parser recorded it, metric included) is not emitted again', () => {
    const { calls, emitter } = sink();
    emitCodeMetrics(
      { newMerges: [PR], newCommits: [] },
      { userId: 'U1', userName: 'z', sessionKey: 'k' },
      { emitter, recordMerge: () => false },
    );
    expect(calls).toEqual([]);
  });
});

describe('the metrics store — first writer wins for fixed ids (#1301 review)', () => {
  it('a second session emitting the same merge does not move it to its owner; a plain upsert still replaces', async () => {
    const { MetricsEventStore } = await import('../../metrics/event-store');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-metrics-'));
    try {
      const store = new MetricsEventStore(dir);
      const emitter = new MetricsEventEmitter(store);
      const day = new Date(MERGED_AT).toISOString().slice(0, 10);
      await emitter.emitGitHubEvent(
        'merge_lines_added',
        'U_CREATOR',
        'a',
        'k1',
        { linesAdded: 120 },
        { id: 'merge_lines:x', timestamp: MERGED_AT, ifAbsent: true },
      );
      await emitter.emitGitHubEvent(
        'merge_lines_added',
        'U_OBSERVER',
        'b',
        'k2',
        { linesAdded: 120 },
        { id: 'merge_lines:x', timestamp: MERGED_AT, ifAbsent: true },
      );
      const rows = (await store.readRange('2026-11-01', '2026-11-30')).filter((e) => e.id === 'merge_lines:x');
      expect(rows.map((e) => e.userId)).toEqual(['U_CREATOR']);
      expect(day).toBe('2026-11-16');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MetricsEventEmitter.emitGitHubEvent — fixed id and time', () => {
  it('passes the id and timestamp through to the store (an upsert by id keeps one row)', async () => {
    const stored: MetricsEvent[] = [];
    const emitter = new MetricsEventEmitter({ append: async (e: MetricsEvent) => void stored.push(e) } as never);
    await emitter.emitGitHubEvent(
      'merge_lines_added',
      'U1',
      'z',
      'k',
      { linesAdded: 1 },
      { id: 'merge_lines:x', timestamp: 42 },
    );
    await emitter.emitGitHubEvent('merge_lines_added', 'U1', 'z', 'k', { linesAdded: 1 });
    expect(stored[0]).toMatchObject({ id: 'merge_lines:x', timestamp: 42 });
    expect(stored[1].id).not.toBe('merge_lines:x');
    expect(stored[1].timestamp).toBeGreaterThan(42);
  });
});

describe('addMergedPr — the card’s merge total, once per PR', () => {
  it('by URL; a record the old parser wrote (no URL) matches by number', () => {
    const stats: MergeStats = {
      totalLinesAdded: 5,
      totalLinesDeleted: 1,
      mergedPRs: [{ prNumber: 3, linesAdded: 5, linesDeleted: 1, mergedAt: 1 }],
    };
    const pr = { prNumber: 7, prUrl: PR.url, linesAdded: 120, linesDeleted: 8, mergedAt: MERGED_AT };
    expect(addMergedPr(stats, pr)).toBe(true);
    expect(addMergedPr(stats, pr)).toBe(false);
    expect(addMergedPr(stats, { ...pr, prNumber: 3, prUrl: 'https://github.com/acme/web/pull/3' })).toBe(false);
    expect(stats).toMatchObject({ totalLinesAdded: 125, totalLinesDeleted: 9 });
    expect(stats.mergedPRs).toHaveLength(2);
  });

  it('two repositories with the same PR number: both count; a legacy number record matches only when unambiguous', () => {
    const stats: MergeStats = {
      totalLinesAdded: 5,
      totalLinesDeleted: 0,
      mergedPRs: [{ prNumber: 7, linesAdded: 5, linesDeleted: 0, mergedAt: 1 }],
    };
    const web = {
      prNumber: 7,
      prUrl: 'https://github.com/acme/web/pull/7',
      linesAdded: 1,
      linesDeleted: 0,
      mergedAt: 2,
    };
    const api = {
      prNumber: 7,
      prUrl: 'https://github.com/acme/api/pull/7',
      linesAdded: 2,
      linesDeleted: 0,
      mergedAt: 3,
    };
    const urls = [web.prUrl, api.prUrl];
    expect(addMergedPr(stats, web, urls)).toBe(true);
    expect(addMergedPr(stats, api, urls)).toBe(true);
    expect(addMergedPr(stats, api, urls)).toBe(false);
    expect(stats.totalLinesAdded).toBe(8);
    // With one #7 on the session, the URL-less record is that PR.
    const solo: MergeStats = {
      totalLinesAdded: 5,
      totalLinesDeleted: 0,
      mergedPRs: [{ prNumber: 7, linesAdded: 5, linesDeleted: 0, mergedAt: 1 }],
    };
    expect(addMergedPr(solo, web, [web.prUrl])).toBe(false);
  });
});
