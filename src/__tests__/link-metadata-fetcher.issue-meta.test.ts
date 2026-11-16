/**
 * .prd/29 — `fetchGitHubIssueMeta`: one GitHub issue for the session issue tree, read from the raw API answer — its
 * title, state, and its parent (`parent_issue_url`, an API URL) as the parent's web URL.
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

import { fetchGitHubIssueMeta } from '../link-metadata-fetcher';

describe('fetchGitHubIssueMeta (.prd/29)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the title, state and parent of a sub-issue from GitHub’s answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        number: 7,
        title: 'collector',
        state: 'closed',
        parent_issue_url: 'https://api.github.com/repos/Acme/Web/issues/1',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchGitHubIssueMeta('acme', 'web', 7)).toEqual({
      title: 'collector',
      state: 'closed',
      parentUrl: 'https://github.com/Acme/Web/issues/1',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/web/issues/7');
  });

  it('no parent, a failed answer and a thrown request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ number: 7, state: 'open', parent_issue_url: null }) }),
    );
    expect(await fetchGitHubIssueMeta('acme', 'web', 7)).toEqual({ title: undefined, state: 'open' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchGitHubIssueMeta('acme', 'web', 7)).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect(await fetchGitHubIssueMeta('acme', 'web', 7)).toBeUndefined();
  });

  it('an answer without a known state is a failed read (it would clear the parent and mark the issue checked)', async () => {
    for (const body of [{ number: 7 }, { number: 7, state: 'weird' }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
      expect(await fetchGitHubIssueMeta('acme', 'web', 7)).toBeUndefined();
    }
  });
});
