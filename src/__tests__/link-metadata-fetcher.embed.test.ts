/**
 * #983 — the follow-up bar's modal: one GitHub issue or PR as the dashboard shows it (`fetchGitHubEmbed`).
 *
 *   E1  parseGitHubIssueUrl: only https://github.com/<owner>/<repo>/(issues|pull)/<n> — never another host, never a
 *       path that is not exactly that (the URL is never fetched; the API is called by its parts)
 *   E2  an issue: title, state, author, labels, body and the newest five comments, oldest first; the total count
 *   E3  a PR: merged / draft / open / closed from the pulls API
 *   E4  bodies are clipped; a failed request is undefined; a fresh answer is reused for a minute
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

import {
  fetchGitHubEmbed,
  fetchGitHubRepoVisibility,
  type GitHubEmbed,
  parseGitHubIssueUrl,
} from '../link-metadata-fetcher';

const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const comment = (i: number) => ({
  user: { login: `u${i}` },
  created_at: `2026-11-0${(i % 9) + 1}T00:00:00Z`,
  body: `c${i}`,
});

describe('E1 — parseGitHubIssueUrl', () => {
  it('takes an issue or a PR page on github.com, and nothing else', () => {
    expect(parseGitHubIssueUrl('https://github.com/2lab-ai/soma-work/issues/918')).toEqual({
      owner: '2lab-ai',
      repo: 'soma-work',
      kind: 'issue',
      number: 918,
    });
    expect(parseGitHubIssueUrl('https://github.com/a/b/pull/12/files')).toEqual({
      owner: 'a',
      repo: 'b',
      kind: 'pr',
      number: 12,
    });
    expect(parseGitHubIssueUrl('https://github.com/a/b/issues/7#issuecomment-1')?.number).toBe(7);
    for (const bad of [
      'http://github.com/a/b/issues/1',
      'https://github.com.evil.com/a/b/issues/1',
      'https://evil.com/github.com/a/b/issues/1',
      'https://api.github.com/repos/a/b/issues/1',
      'https://github.com/a/b/issues/x',
      'https://github.com/a/../issues/1',
      'https://user@github.com/a/b/issues/1',
      'https://github.com:8443/a/b/issues/1',
      'https://github.com/a/b/discussions/1',
      'not a url',
    ])
      expect(parseGitHubIssueUrl(bad)).toBeUndefined();
  });
});

describe('fetchGitHubEmbed (#983)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('E2 — an issue with its labels, body and the newest five comments, oldest first', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/repos/o/r/issues/918')
        return ok({
          title: 'Phone chrome follow-ups',
          state: 'open',
          user: { login: 'zhuge-liang-bot[bot]' },
          created_at: '2026-11-05T05:00:00Z',
          updated_at: '2026-11-05T06:00:00Z',
          labels: [{ name: 'P2' }, 'dashboard', { name: '' }],
          body: '## P2\n- keep the tab bar',
          comments: 7,
        });
      if (url === 'https://api.github.com/repos/o/r/issues/918/comments?per_page=100&page=1')
        return ok([1, 2, 3, 4, 5, 6, 7].map(comment));
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const e = await fetchGitHubEmbed({ owner: 'o', repo: 'r', kind: 'issue', number: 918 });
    expect(e).toEqual({
      kind: 'issue',
      title: 'Phone chrome follow-ups',
      state: 'open',
      author: 'zhuge-liang-bot[bot]',
      createdAt: '2026-11-05T05:00:00Z',
      updatedAt: '2026-11-05T06:00:00Z',
      labels: ['P2', 'dashboard'],
      body: '## P2\n- keep the tab bar',
      comments: [3, 4, 5, 6, 7].map((i) => ({ author: `u${i}`, createdAt: comment(i).created_at, body: `c${i}` })),
      commentsTotal: 7,
    });
    // Called by its parts with the token, never at the page URL.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.github.com/repos/o/r/issues/918',
      'https://api.github.com/repos/o/r/issues/918/comments?per_page=100&page=1',
    ]);
    expect((fetchMock.mock.calls[0] as any)[1].headers.Authorization).toBe('token fake-token');
  });

  it('E3 — a PR’s state from the pulls API: merged, draft, open, closed', async () => {
    const pr = (n: number, o: Record<string, unknown>) =>
      vi.fn(async (url: string) =>
        url.endsWith(`/pulls/${n}`)
          ? ok({ title: `PR ${n}`, user: { login: 'z' }, body: null, comments: 0, ...o })
          : ok([]),
      );
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [1, { state: 'closed', merged: true }, 'merged'],
      [2, { state: 'open', draft: true }, 'draft'],
      [3, { state: 'open' }, 'open'],
      [4, { state: 'closed', merged: false }, 'closed'],
    ];
    for (const [n, o, want] of cases) {
      const f = pr(n, o);
      vi.stubGlobal('fetch', f);
      const e = (await fetchGitHubEmbed({ owner: 'o', repo: 'pr-states', kind: 'pr', number: n })) as GitHubEmbed;
      expect(e?.state).toBe(want);
      expect(e?.kind).toBe('pr');
      expect(e?.body).toBe('');
      expect(f.mock.calls[0][0]).toBe(`https://api.github.com/repos/o/pr-states/pulls/${n}`);
    }
  });

  it('E4 — bodies clipped; a failure is undefined (and not kept); a fresh answer is reused', async () => {
    const big = 'x'.repeat(50_000);
    const f = vi.fn(async (url: string) =>
      url.includes('/comments')
        ? ok([{ user: { login: 'a' }, created_at: 't', body: big }])
        : ok({ title: 't', state: 'open', body: big, comments: 1 }),
    );
    vi.stubGlobal('fetch', f);
    const e = (await fetchGitHubEmbed({ owner: 'o', repo: 'clip', kind: 'issue', number: 1 })) as GitHubEmbed;
    expect(e!.body.length).toBeLessThanOrEqual(20_001);
    expect(e!.body.endsWith('…')).toBe(true);
    expect(e!.comments[0].body.length).toBeLessThanOrEqual(4_001);
    const calls = f.mock.calls.length;
    await fetchGitHubEmbed({ owner: 'o', repo: 'clip', kind: 'issue', number: 1 });
    expect(f.mock.calls.length).toBe(calls);

    const down = vi.fn(async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }));
    vi.stubGlobal('fetch', down);
    await expect(fetchGitHubEmbed({ owner: 'o', repo: 'down', kind: 'issue', number: 2 })).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    await expect(fetchGitHubEmbed({ owner: 'o', repo: 'down', kind: 'issue', number: 2 })).resolves.toBeUndefined();
  });
});

describe('review (PR #990) — comments that fail, repository visibility', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('E5 — a comments request that fails marks the embed commentsError and is not kept', async () => {
    const f = vi.fn(async (url: string) =>
      url.includes('/comments')
        ? { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }
        : ok({ title: 't', state: 'open', body: 'b', comments: 7 }),
    );
    vi.stubGlobal('fetch', f);
    const e = await fetchGitHubEmbed({ owner: 'o', repo: 'cfail', kind: 'issue', number: 3 });
    expect(e).toMatchObject({ body: 'b', comments: [], commentsTotal: 7, commentsError: true });
    const n = f.mock.calls.length;
    await fetchGitHubEmbed({ owner: 'o', repo: 'cfail', kind: 'issue', number: 3 });
    expect(f.mock.calls.length).toBeGreaterThan(n);
  });

  it('E6 — repository visibility: public, private, unknown on failure (not kept); kept when known', async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith('/repos/o/pub')
        ? ok({ private: false })
        : url.endsWith('/repos/o/priv')
          ? ok({ private: true })
          : { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) },
    );
    vi.stubGlobal('fetch', f);
    await expect(fetchGitHubRepoVisibility('o', 'pub')).resolves.toBe('public');
    await expect(fetchGitHubRepoVisibility('o', 'priv')).resolves.toBe('private');
    await expect(fetchGitHubRepoVisibility('o', 'gone')).resolves.toBeUndefined();
    const n = f.mock.calls.length;
    await fetchGitHubRepoVisibility('o', 'pub');
    await fetchGitHubRepoVisibility('o', 'gone');
    expect(f.mock.calls.length).toBe(n + 1);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    await expect(fetchGitHubRepoVisibility('o', 'net')).resolves.toBeUndefined();
  });
});

describe('review round 2 — anonymous reads (GitHub enforces visibility)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('E7 — anonymous: no Authorization header, its own cache; a 404 is not-found', async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith('/issues/404')
        ? { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }
        : ok({ title: 'pub', state: 'open', body: 'b', comments: 0 }),
    );
    vi.stubGlobal('fetch', f);
    const e = await fetchGitHubEmbed({ owner: 'o', repo: 'anon', kind: 'issue', number: 1 }, { anonymous: true });
    expect(e).toMatchObject({ title: 'pub' });
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBeUndefined();
    // The token read of the same issue is not served from the anonymous cache (nor the other way round).
    await fetchGitHubEmbed({ owner: 'o', repo: 'anon', kind: 'issue', number: 1 });
    expect((f.mock.calls[1] as any)[1].headers.Authorization).toBe('token fake-token');
    await expect(
      fetchGitHubEmbed({ owner: 'o', repo: 'anon', kind: 'issue', number: 404 }, { anonymous: true }),
    ).resolves.toBe('not-found');
  });
});
