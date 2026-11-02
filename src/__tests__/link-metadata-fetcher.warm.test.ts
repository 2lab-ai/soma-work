/**
 * The card's link states stay fresh without the board waiting (SSOT 2026-11-02, 작업 카드의 연결):
 *   W1  peekLinkMetadata reads the cache's last answer, whatever its age; nothing when never fetched
 *   W2  warmLinkMetadata fetches, in the background, the GitHub / Jira issues and PRs whose answer is missing or
 *       older than the cache's TTL — once per URL per TTL (a failed fetch is not retried at every board), and at
 *       most a few per call; wikis and other providers are never fetched
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

import { peekLinkMetadata, warmLinkMetadata } from '../link-metadata-fetcher';

const PR = { url: 'https://github.com/acme/app/pull/733', type: 'pr' as const, provider: 'github' as const };
const JIRA = { url: 'https://acme.atlassian.net/browse/PROJ-12', type: 'issue' as const, provider: 'jira' as const };
const WIKI = { url: 'https://acme.atlassian.net/wiki/x', type: 'doc' as const, provider: 'confluence' as const };
const LINEAR = { url: 'https://linear.app/a/issue/ENG-1', type: 'issue' as const, provider: 'linear' as const };

describe('peek and warm', () => {
  it('W1 · W2 — a missing answer is fetched once in the background, then peek reads it', async () => {
    const fetch = vi.fn(async () => ({ status: 'merged', title: 'feat: 결제 폼' }));
    expect(peekLinkMetadata(PR.url)).toBeUndefined();
    const t0 = 1_000_000;
    expect(warmLinkMetadata([PR, JIRA, WIKI, LINEAR], { now: t0, fetch })).toBe(2);
    expect(fetch.mock.calls.map((c) => (c as unknown as [{ url: string }])[0].url)).toEqual([PR.url, JIRA.url]);
    await new Promise((r) => setImmediate(r));
    expect(peekLinkMetadata(PR.url)).toEqual({ status: 'merged', title: 'feat: 결제 폼' });
    // Within the TTL nothing is fetched again — even when the first fetch failed or is still running.
    expect(warmLinkMetadata([PR, JIRA], { now: t0 + 60_000, fetch })).toBe(0);
    // After the TTL it is fetched again.
    expect(warmLinkMetadata([PR], { now: t0 + 5 * 60_000 + 1, fetch })).toBe(1);
  });

  it('W2 — at most a few per call; the rest wait for the next board', () => {
    const fetch = vi.fn(async () => ({}));
    const many = Array.from({ length: 20 }, (_, i) => ({ ...PR, url: `https://github.com/acme/app/pull/${1000 + i}` }));
    expect(warmLinkMetadata(many, { now: 5_000_000, fetch })).toBe(8);
    expect(warmLinkMetadata(many, { now: 5_000_001, fetch })).toBe(8);
    expect(fetch).toHaveBeenCalledTimes(16);
  });
});
