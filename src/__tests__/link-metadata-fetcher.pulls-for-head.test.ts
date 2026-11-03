/**
 * #833 — `fetchGitHubPullsForHead`: the PRs whose head is `owner:branch`, for the turn-end reconcile.
 *
 *   H1  asks `GET /repos/{o}/{r}/pulls?head={o}:{branch}&state=all` and returns the listed PRs; primes the metadata
 *       cache so the card's chip shows the state at once
 *   H2  a failed or malformed answer is undefined (nothing to cache), an empty list is []
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { fetchGitHubPullsForHead, peekLinkMetadata } from '../link-metadata-fetcher';

describe('fetchGitHubPullsForHead (#833)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('H1 — lists the PRs of a head and primes the cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          html_url: 'https://github.com/a/b/pull/12',
          number: 12,
          title: 'feat: x',
          state: 'closed',
          draft: false,
          merged_at: '2026-11-03T03:00:00Z',
          created_at: '2026-11-03T02:30:00Z',
          body: 'Closes #832',
          head: { sha: 'abc123' },
        },
        { nope: true },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const pulls = await fetchGitHubPullsForHead('a', 'b', 'feat/x');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/a/b/pulls?head=a%3Afeat%2Fx&state=all&sort=created&direction=desc&per_page=30',
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('token fake-token');
    expect(pulls).toEqual([
      {
        html_url: 'https://github.com/a/b/pull/12',
        number: 12,
        title: 'feat: x',
        state: 'closed',
        draft: false,
        merged_at: '2026-11-03T03:00:00Z',
        created_at: '2026-11-03T02:30:00Z',
        body: 'Closes #832',
        head_sha: 'abc123',
      },
    ]);
    expect(peekLinkMetadata('https://github.com/a/b/pull/12')).toEqual({ title: 'feat: x', status: 'merged' });
  });

  it('H2 — a failed or malformed answer is undefined; an empty list is []', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchGitHubPullsForHead('a', 'b', 'x')).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: 'x' }) }));
    expect(await fetchGitHubPullsForHead('a', 'b', 'x')).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect(await fetchGitHubPullsForHead('a', 'b', 'x')).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    expect(await fetchGitHubPullsForHead('a', 'b', 'x')).toEqual([]);
  });
});
