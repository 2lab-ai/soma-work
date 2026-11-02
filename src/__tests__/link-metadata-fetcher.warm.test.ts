/**
 * The card's link states stay fresh without the board waiting (SSOT 2026-11-02, 작업 카드의 연결):
 *   W1  peekLinkMetadata reads the cache's last answer, whatever its age; nothing when never fetched
 *   W2  warmLinkMetadata fetches, in the background, the GitHub / Jira issues and PRs whose answer is missing or
 *       older than the cache's TTL — once per URL per TTL (a failed fetch is not retried at every board), and at
 *       most a few per call; wikis and other providers are never fetched
 *   W3  bounded across every board: a few running at once and a budget per minute; a merged PR is never fetched
 *       again, other final states hourly
 *   W4  the cache keeps its last good answer: a refused (empty) answer does not erase it, and a background fetch
 *       that failed does not write the recorded state as fresh
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({ config: { github: { token: 'fake-token' } } }));
vi.mock('../github-auth', () => ({ getGitHubAppAuth: () => null }));
vi.mock('../logger', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
    debug() {}
  },
}));

import { fetchLinkMetadata, peekLinkMetadata, warmLinkMetadata } from '../link-metadata-fetcher';

const settle = () => new Promise((r) => setImmediate(r));

const PR = { url: 'https://github.com/acme/app/pull/733', type: 'pr' as const, provider: 'github' as const };
const JIRA = { url: 'https://acme.atlassian.net/browse/PROJ-12', type: 'issue' as const, provider: 'jira' as const };
const WIKI = { url: 'https://acme.atlassian.net/wiki/x', type: 'doc' as const, provider: 'confluence' as const };
const LINEAR = { url: 'https://linear.app/a/issue/ENG-1', type: 'issue' as const, provider: 'linear' as const };

describe('peek and warm', () => {
  it('W1 · W2 — a missing answer is fetched once in the background, then peek reads it', async () => {
    const fetch = vi.fn(async () => ({ status: 'open', title: 'feat: 결제 폼' }));
    expect(peekLinkMetadata(PR.url)).toBeUndefined();
    const t0 = 1_000_000;
    expect(warmLinkMetadata([PR, JIRA, WIKI, LINEAR], { now: t0, fetch })).toBe(2);
    expect(fetch.mock.calls.map((c) => (c as unknown as [{ url: string }])[0].url)).toEqual([PR.url, JIRA.url]);
    await new Promise((r) => setImmediate(r));
    expect(peekLinkMetadata(PR.url)).toEqual({ status: 'open', title: 'feat: 결제 폼' });
    // Within the TTL nothing is fetched again — even when the first fetch failed or is still running.
    expect(warmLinkMetadata([PR, JIRA], { now: t0 + 60_000, fetch })).toBe(0);
    // After the TTL it is fetched again.
    expect(warmLinkMetadata([PR], { now: t0 + 5 * 60_000 + 1, fetch })).toBe(1);
  });

  it('W2 · W3 — at most a few per call and a few at once; the rest wait for the next board', async () => {
    const fetch = vi.fn(async () => ({}));
    const many = Array.from({ length: 20 }, (_, i) => ({ ...PR, url: `https://github.com/acme/app/pull/${1000 + i}` }));
    expect(warmLinkMetadata(many, { now: 5_000_000, fetch })).toBe(8);
    // Eight are still running: another board starts none.
    expect(warmLinkMetadata(many, { now: 5_000_001, fetch })).toBe(0);
    await settle();
    expect(warmLinkMetadata(many, { now: 5_000_002, fetch })).toBe(8);
    expect(fetch).toHaveBeenCalledTimes(16);
  });

  it('W3 — a budget per minute across every board', async () => {
    const fetch = vi.fn(async () => ({}));
    const t0 = 9_000_000;
    let started = 0;
    for (let b = 0; b < 10; b++) {
      const batch = Array.from({ length: 8 }, (_, i) => ({
        ...PR,
        url: `https://github.com/acme/app/pull/${2000 + b * 8 + i}`,
      }));
      started += warmLinkMetadata(batch, { now: t0 + b, fetch });
      await settle();
    }
    expect(started).toBe(40);
    const next = [{ ...PR, url: 'https://github.com/acme/app/pull/2999' }];
    expect(warmLinkMetadata(next, { now: t0 + 60_000, fetch })).toBe(1);
  });

  it('W3 — a merged PR is never fetched again; a closed issue hourly', async () => {
    const merged = { ...PR, url: 'https://github.com/acme/app/pull/3001' };
    const closed = { ...JIRA, url: 'https://acme.atlassian.net/browse/PROJ-3002' };
    const t0 = 20_000_000;
    const first = vi.fn(async (l: { url: string }) => ({ status: l.url === merged.url ? 'merged' : 'Done' }));
    expect(warmLinkMetadata([merged, closed], { now: t0, fetch: first })).toBe(2);
    await settle();
    const again = vi.fn(async () => ({ status: 'open' }));
    expect(warmLinkMetadata([merged, closed], { now: t0 + 10 * 60_000, fetch: again })).toBe(0);
    expect(warmLinkMetadata([merged, closed], { now: t0 + 61 * 60_000, fetch: again })).toBe(1);
    expect(again.mock.calls.map((c) => (c as unknown as [{ url: string }])[0].url)).toEqual([closed.url]);
    expect(warmLinkMetadata([merged], { now: t0 + 100 * 24 * 60 * 60_000, fetch: again })).toBe(0);
  });

  it('W4 — a refused answer does not erase the last good one', async () => {
    const pr = { ...PR, url: 'https://github.com/acme/app/pull/4001', status: 'open' };
    await settle();
    expect(warmLinkMetadata([pr], { now: 1, fetch: async () => ({ status: 'merged', title: 'feat: x' }) })).toBe(1);
    await settle();
    // The cached answer is old; GitHub refuses (rate limit): the good answer stays.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );
    expect(await fetchLinkMetadata(pr as never)).toEqual({ title: 'feat: x', status: 'merged' });
    expect(peekLinkMetadata(pr.url)).toEqual({ title: 'feat: x', status: 'merged' });
    vi.unstubAllGlobals();
  });

  it('W4 — a background fetch that failed does not write the recorded state as fresh', async () => {
    const pr = { ...PR, url: 'https://github.com/acme/app/pull/4002', status: 'draft' };
    await settle();
    expect(warmLinkMetadata([pr], { now: 2, fetch: async () => ({ status: 'open' }) })).toBe(1);
    await settle();
    // The real fetcher (no injected fetch): the network fails, fetchLinkMetadata falls back to the recorded 'draft'.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    expect(warmLinkMetadata([pr])).toBe(1);
    await settle();
    await settle();
    expect(peekLinkMetadata(pr.url)?.status).toBe('open');
    vi.unstubAllGlobals();
  });
});
