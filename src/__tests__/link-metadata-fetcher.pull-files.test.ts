/**
 * .prd/27 §4 (#1299 review) — `fetchGitHubPullFiles` / `fetchGitHubPullDetail` over the HTTP transport: a later page
 * that fails keeps the pages read and says the read is not complete; the detail carries the head's repository and the
 * base commit.
 *
 *   F1  page 2 answers an HTTP error → page 1's files, truncated, complete: false
 *   F2  page 2 throws (timeout, network) → the same
 *   F3  page 1 fails → undefined; a short page ends a complete read; `max` reached → truncated but complete
 *   F4  detail: head_repo and base_sha
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

import { fetchGitHubPullDetail, fetchGitHubPullFiles } from '../link-metadata-fetcher';

const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const fail = (status: number) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}) });
const page = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ filename: `f${from + i}.ts`, status: 'modified', additions: 1, changes: 1 }));

describe('fetchGitHubPullFiles — partial pages (#1299 review)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('F1 — page 2 answers an HTTP error: page 1 kept, truncated, not complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(ok(page(0, 100)))
        .mockResolvedValueOnce(fail(502)),
    );
    const r = await fetchGitHubPullFiles('a', 'b', 7, 300);
    expect(r).toMatchObject({ truncated: true, complete: false });
    expect(r!.files).toHaveLength(100);
  });

  it('F2 — page 2 throws: the same', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(ok(page(0, 100)))
        .mockRejectedValueOnce(new Error('The operation timed out')),
    );
    const r = await fetchGitHubPullFiles('a', 'b', 7, 300);
    expect(r).toMatchObject({ truncated: true, complete: false });
    expect(r!.files.map((f) => f.filename).slice(0, 2)).toEqual(['f0.ts', 'f1.ts']);
  });

  it('F3 — page 1 fails: undefined; a short page ends a whole read; max reached is a cut, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fail(404)));
    expect(await fetchGitHubPullFiles('a', 'b', 7, 300)).toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(ok(page(0, 100)))
        .mockResolvedValueOnce(ok(page(100, 3))),
    );
    expect(await fetchGitHubPullFiles('a', 'b', 7, 300)).toMatchObject({ truncated: false, complete: true });
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(page(0, 100)));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchGitHubPullFiles('a', 'b', 7, 100)).toMatchObject({ truncated: true, complete: true });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/a/b/pulls/7/files?per_page=100&page=1');
  });

  it("F4 — the detail carries the head's repository and the base commit", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          html_url: 'https://github.com/org/p/pull/9',
          number: 9,
          state: 'open',
          head: { ref: 'feat/z', sha: 'h1', repo: { full_name: 'Contributor/p' } },
          base: { sha: 'b1' },
        }),
      ),
    );
    expect(await fetchGitHubPullDetail('org', 'p', 9)).toMatchObject({
      head_ref: 'feat/z',
      head_sha: 'h1',
      head_repo: 'Contributor/p',
      base_sha: 'b1',
    });
  });
});
