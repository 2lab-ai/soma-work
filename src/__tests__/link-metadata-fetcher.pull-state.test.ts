/**
 * #928 — `fetchGitHubPullState`: one PR's card state for the session PR watch.
 *
 *   S1  GET /repos/{o}/{r}/pulls/{n}; maps merged / closed / draft / open; returns the ETag; primes the metadata cache
 *   S2  sends the last ETag as If-None-Match; a 304 is 'not-modified'
 *   S3  a failed or thrown request is undefined
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

import { fetchGitHubPullState, peekLinkMetadata } from '../link-metadata-fetcher';

const answer = (body: Record<string, unknown>, etag?: string) => ({
  ok: true,
  status: 200,
  headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? (etag ?? null) : null) },
  json: async () => body,
});

describe('fetchGitHubPullState (#928)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('S1 — maps the state, returns the ETag and primes the cache', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        answer(
          { html_url: 'https://github.com/a/b/pull/12', title: 'feat: x', state: 'closed', merged: true, draft: false },
          'W/"e1"',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchGitHubPullState('a', 'b', 12)).resolves.toEqual({ number: 12, status: 'merged', etag: 'W/"e1"' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/a/b/pulls/12');
    expect(fetchMock.mock.calls[0][1].headers['If-None-Match']).toBeUndefined();
    expect(peekLinkMetadata('https://github.com/a/b/pull/12')).toMatchObject({ status: 'merged', title: 'feat: x' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ state: 'closed', merged: false })));
    await expect(fetchGitHubPullState('a', 'b', 13)).resolves.toEqual({ number: 13, status: 'closed' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ state: 'open', draft: true })));
    await expect(fetchGitHubPullState('a', 'b', 14)).resolves.toEqual({ number: 14, status: 'draft' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ state: 'open', draft: false })));
    await expect(fetchGitHubPullState('a', 'b', 15)).resolves.toEqual({ number: 15, status: 'open' });
  });

  it('S2 — the ETag goes out as If-None-Match; a 304 is not-modified', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 304, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchGitHubPullState('a', 'b', 12, 'W/"e1"')).resolves.toBe('not-modified');
    expect(fetchMock.mock.calls[0][1].headers['If-None-Match']).toBe('W/"e1"');
  });

  it('S3 — a failed or thrown request is undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } }));
    await expect(fetchGitHubPullState('a', 'b', 12)).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(fetchGitHubPullState('a', 'b', 12)).resolves.toBeUndefined();
  });
});
