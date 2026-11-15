/**
 * .prd/26 §5 (#1297) — code-change metrics from the session's code changes: fixed ids, real times, once each.
 */
import { describe, expect, it, vi } from 'vitest';
import { MetricsEventEmitter } from '../../metrics/event-emitter';
import type { MetricsEvent } from '../../metrics/types';
import { addMergedPr, emitCodeMetrics, type MergeStats, mergeRecordOf } from '../metrics';
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

const STRICT = { ifAbsent: true, strict: true };
const WHO = { userId: 'U1', userName: 'z', sessionKey: 'k' };

describe('emitCodeMetrics', () => {
  it('rejects when a row was not written — a commit or a merge — so the caller hands them on again', async () => {
    const commit = { sha: 'd'.repeat(40), at: 5000, additions: 1, deletions: 0, repo: 'acme/web' };
    const failing = (bad: string) => ({
      emitGitHubEvent: vi.fn(async (type: string) => {
        if (type === bad) throw new Error('disk full');
      }),
    });
    await expect(
      emitCodeMetrics({ newMerges: [], newCommits: [commit] }, WHO, { emitter: failing('commit_created') }),
    ).rejects.toThrow('a code-change metric was not written');
    await expect(
      emitCodeMetrics({ newMerges: [PR], newCommits: [] }, WHO, { emitter: failing('merge_lines_added') }),
    ).rejects.toThrow('a code-change metric was not written');
    const { emitter } = sink();
    await expect(emitCodeMetrics({ newMerges: [PR], newCommits: [commit] }, WHO, { emitter })).resolves.toBeUndefined();
  });

  it('a merged PR: merge_lines_added with GitHub’s counts, on its merge day, id from its URL; then the card', async () => {
    const { calls, emitter } = sink();
    const recordMerge = vi.fn();
    await emitCodeMetrics({ newMerges: [PR], newCommits: [] }, WHO, { emitter, recordMerge });
    expect(calls).toEqual([
      {
        type: 'merge_lines_added',
        meta: { prNumber: 7, prUrl: PR.url, linesAdded: 120, linesDeleted: 8 },
        opts: { id: `merge_lines:${PR.url}`, timestamp: MERGED_AT, ...STRICT },
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

  it('the card record is written only after the merge row: a failed row leaves no record to block the retry', async () => {
    const recordMerge = vi.fn();
    const emitter = { emitGitHubEvent: vi.fn(async () => Promise.reject(new Error('disk full'))) };
    await expect(emitCodeMetrics({ newMerges: [PR], newCommits: [] }, WHO, { emitter, recordMerge })).rejects.toThrow();
    expect(recordMerge).not.toHaveBeenCalled();
  });

  it('a commit: commit_created and code_lines_added with its line counts, ids from the sha, at its reflog time', async () => {
    const { calls, emitter } = sink();
    const sha = 'a'.repeat(40);
    const delOnly = 'c'.repeat(40);
    const empty = 'b'.repeat(40);
    await emitCodeMetrics(
      {
        newMerges: [],
        newCommits: [
          { sha, at: 5000, additions: 10, deletions: 2, repo: 'acme/web' },
          { sha: delOnly, at: 5500, additions: 0, deletions: 2, repo: 'acme/web' },
          { sha: empty, at: 6000, additions: 0, deletions: 0, repo: 'acme/web' },
        ],
      },
      WHO,
      { emitter },
    );
    expect(calls.map((c) => [c.type, c.opts, c.meta.linesAdded, c.meta.linesDeleted])).toEqual([
      ['commit_created', { id: `commit:${sha}`, timestamp: 5000, ...STRICT }, 10, 2],
      ['code_lines_added', { id: `commit_lines:${sha}`, timestamp: 5000, ...STRICT }, 10, 2],
      ['commit_created', { id: `commit:${delOnly}`, timestamp: 5500, ...STRICT }, 0, 2],
      ['code_lines_added', { id: `commit_lines:${delOnly}`, timestamp: 5500, ...STRICT }, 0, 2],
      ['commit_created', { id: `commit:${empty}`, timestamp: 6000, ...STRICT }, 0, 0],
    ]);
  });

  it('an old parser record: merged before the counting start, it was that parser’s — merged after, it was a view', async () => {
    const before = sink();
    const recordBefore = vi.fn();
    await emitCodeMetrics({ newMerges: [PR], newCommits: [] }, WHO, {
      emitter: before.emitter,
      mergeRecord: () => 'legacy',
      recordMerge: recordBefore,
      countingSince: MERGED_AT + 1,
    });
    expect(before.calls).toEqual([]);
    // The card's record is still corrected to GitHub's counts.
    expect(recordBefore).toHaveBeenCalledTimes(1);
    const after = sink();
    await emitCodeMetrics({ newMerges: [PR], newCommits: [] }, WHO, {
      emitter: after.emitter,
      mergeRecord: () => 'legacy',
      recordMerge: vi.fn(),
      countingSince: MERGED_AT - 1,
    });
    expect(after.calls.map((c) => c.type)).toEqual(['merge_lines_added']);
  });

  it('a merge already on the card by URL is written again first-wins (a lost row comes back) and not re-recorded', async () => {
    const { calls, emitter } = sink();
    const recordMerge = vi.fn();
    await emitCodeMetrics({ newMerges: [PR], newCommits: [] }, WHO, { emitter, mergeRecord: () => 'url', recordMerge });
    expect(calls.map((c) => c.opts)).toEqual([{ id: `merge_lines:${PR.url}`, timestamp: MERGED_AT, ...STRICT }]);
    expect(recordMerge).not.toHaveBeenCalled();
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

describe('the metrics store — the day-file path keeps the first writer too (#1301 review)', () => {
  it('a spilled first-writer line is imported without replacing the row before it; mergeJsonl keeps the first', async () => {
    const { MetricsEventStore, mergeJsonl } = await import('../../metrics/event-store');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-metrics-day-'));
    try {
      const base = {
        eventType: 'merge_lines_added',
        sessionKey: 'k',
        metadata: { linesAdded: 1 },
        timestamp: MERGED_AT,
      };
      const first = JSON.stringify({ ...base, id: 'merge_lines:y', userId: 'U_CREATOR', userName: 'a' });
      const spilled = JSON.stringify({
        ...base,
        id: 'merge_lines:y',
        userId: 'U_OBSERVER',
        userName: 'b',
        ifAbsent: true,
      });
      fs.writeFileSync(path.join(dir, 'metrics-events-2026-11-16.jsonl'), `${first}\n${spilled}\n`);
      const store = new MetricsEventStore(dir);
      const rows = (await store.readRange('2026-11-01', '2026-11-30')).filter((e) => e.id === 'merge_lines:y');
      expect(rows.map((e) => e.userId)).toEqual(['U_CREATOR']);
      expect(rows[0]).not.toHaveProperty('ifAbsent');
      const merged = mergeJsonl(`${first}\n`, `${spilled}\n`).out;
      expect(merged).toContain('U_CREATOR');
      expect(merged).not.toContain('U_OBSERVER');
      expect(merged).not.toContain('ifAbsent');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strict: an event written nowhere rejects; without strict it is only logged', async () => {
    const { MetricsEventStore } = await import('../../metrics/event-store');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-metrics-none-'));
    try {
      // The metrics "folder" is a file: neither the database nor a day file can be written.
      const notADir = path.join(parent, 'metrics');
      fs.writeFileSync(notADir, 'x');
      const emitter = new MetricsEventEmitter(new MetricsEventStore(notADir));
      const opts = { id: 'commit:z', timestamp: MERGED_AT, ifAbsent: true };
      await expect(emitter.emitGitHubEvent('commit_created', 'U', 'u', 'k', {}, opts)).resolves.toBeUndefined();
      await expect(
        emitter.emitGitHubEvent('commit_created', 'U', 'u', 'k', {}, { ...opts, strict: true }),
      ).rejects.toThrow();
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
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
  it('by URL once; an old parser record (no URL) of the same number is replaced with GitHub’s counts', () => {
    const stats: MergeStats = {
      totalLinesAdded: 5,
      totalLinesDeleted: 1,
      mergedPRs: [{ prNumber: 3, linesAdded: 5, linesDeleted: 1, mergedAt: 1 }],
    };
    const pr = { prNumber: 7, prUrl: PR.url, linesAdded: 120, linesDeleted: 8, mergedAt: MERGED_AT };
    expect(mergeRecordOf(stats, pr)).toBeUndefined();
    expect(addMergedPr(stats, pr)).toBe(true);
    expect(mergeRecordOf(stats, pr)).toBe('url');
    expect(addMergedPr(stats, pr)).toBe(false);
    // #3's old record was a view of the open PR: the merge's counts replace it, the totals move by the difference.
    const three = { ...pr, prNumber: 3, prUrl: 'https://github.com/acme/web/pull/3', linesAdded: 9, linesDeleted: 4 };
    expect(mergeRecordOf(stats, three)).toBe('legacy');
    expect(addMergedPr(stats, three)).toBe(true);
    expect(stats).toMatchObject({ totalLinesAdded: 129, totalLinesDeleted: 12 });
    expect(stats.mergedPRs).toHaveLength(2);
    expect(mergeRecordOf(stats, three)).toBe('url');
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
    expect(mergeRecordOf(stats, web, urls)).toBeUndefined();
    expect(addMergedPr(stats, web, urls)).toBe(true);
    expect(addMergedPr(stats, api, urls)).toBe(true);
    expect(addMergedPr(stats, api, urls)).toBe(false);
    expect(stats.totalLinesAdded).toBe(8);
    // With one #7 on the session, the URL-less record is that PR, and is replaced by it.
    const solo: MergeStats = {
      totalLinesAdded: 5,
      totalLinesDeleted: 0,
      mergedPRs: [{ prNumber: 7, linesAdded: 5, linesDeleted: 0, mergedAt: 1 }],
    };
    expect(mergeRecordOf(solo, web, [web.prUrl])).toBe('legacy');
    expect(addMergedPr(solo, web, [web.prUrl])).toBe(true);
    expect(solo).toMatchObject({ totalLinesAdded: 1, mergedPRs: [{ prUrl: web.prUrl, linesAdded: 1 }] });
  });
});
