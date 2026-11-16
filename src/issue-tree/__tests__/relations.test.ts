/**
 * .prd/29 §4 — what GitHub says about how the session's issues and PRs relate, as issue-tree entries.
 */
import { describe, expect, it, vi } from 'vitest';
import { closingIssueUrls, issueWebUrl, prTreeEntries, refreshIssueEntries } from '../relations';

const GH = 'https://github.com/a/b';

describe('issue-tree relations', () => {
  it('closing refs: the issues a body closes, as URLs (other repos too), once each, at most five', () => {
    const body =
      'Closes #12\nfixes x/y#3, Resolves: #12\nCLOSED #4 #5 — refs #9 (no keyword)\nfix #6\nfixed #7\nresolve #8';
    expect(closingIssueUrls(body, 'a', 'b')).toEqual([
      `${GH}/issues/12`,
      'https://github.com/x/y/issues/3',
      `${GH}/issues/4`,
      `${GH}/issues/6`,
      `${GH}/issues/7`,
    ]);
    expect(closingIssueUrls(undefined, 'a', 'b')).toEqual([]);
    expect(closingIssueUrls(null, 'a', 'b')).toEqual([]);
  });

  it('PR entries: title and state, the issues each closes, and a stack — the base is another session PR’s head', () => {
    const prs = [
      {
        url: `${GH}/pull/1`,
        repo: 'a/b',
        state: 'merged',
        title: 'base',
        headRef: 'feat/one',
        baseRef: 'main',
        closes: [],
      },
      {
        url: `${GH}/pull/2`,
        repo: 'a/b',
        state: 'open',
        headRef: 'feat/two',
        baseRef: 'feat/one',
        closes: [`${GH}/issues/9`],
      },
      // A fork's head of the same name is not this repo's branch.
      {
        url: `${GH}/pull/3`,
        repo: 'a/b',
        state: 'open',
        headRef: 'feat/one',
        headRepo: 'fork/b',
        baseRef: 'main',
        closes: [],
      },
      { url: `${GH}/pull/4`, repo: 'a/b', state: 'open', headRef: 'x', baseRef: 'feat/two', closes: [] },
    ];
    // A read is the truth: no closing ref and no stack are said as such, so an older body's relations clear. Each entry
    // changes only a node still in the tree (a PR removed while the collect ran stays removed).
    expect(prTreeEntries(prs)).toEqual([
      {
        kind: 'pr',
        url: `${GH}/pull/1`,
        provider: 'github',
        title: 'base',
        status: 'merged',
        rel: { closes: [], base: null },
        onlyIfPresent: true,
      },
      {
        kind: 'pr',
        url: `${GH}/pull/2`,
        provider: 'github',
        status: 'open',
        rel: { closes: [`${GH}/issues/9`], base: `${GH}/pull/1` },
        onlyIfPresent: true,
      },
      {
        kind: 'pr',
        url: `${GH}/pull/3`,
        provider: 'github',
        status: 'open',
        rel: { closes: [], base: null },
        onlyIfPresent: true,
      },
      {
        kind: 'pr',
        url: `${GH}/pull/4`,
        provider: 'github',
        status: 'open',
        rel: { closes: [], base: `${GH}/pull/2` },
        onlyIfPresent: true,
      },
    ]);
    // A closed PR is not a stack's base.
    const closed = prTreeEntries([
      { url: `${GH}/pull/1`, repo: 'a/b', state: 'closed', headRef: 'feat/one', closes: [] },
      { url: `${GH}/pull/2`, repo: 'a/b', state: 'open', baseRef: 'feat/one', closes: [] },
    ]);
    expect(closed[1].rel).toEqual({ closes: [], base: null });
  });

  it('a stack base is this repo’s live PR: a fork’s branch of the same name is none; a reused branch takes the open PR', () => {
    // Only a fork has the head branch: no stack.
    const forkOnly = prTreeEntries([
      {
        url: `${GH}/pull/3`,
        repo: 'a/b',
        state: 'open',
        headRef: 'feat/one',
        headRepo: 'fork/b',
        baseRef: 'main',
        closes: [],
      },
      { url: `${GH}/pull/5`, repo: 'a/b', state: 'open', headRef: 'x', baseRef: 'feat/one', closes: [] },
    ]);
    expect(forkOnly[1].rel).toEqual({ closes: [], base: null });
    // The branch was merged once (#1) and opened again (#2): a PR based on it stacks on the live one.
    const reused = prTreeEntries([
      { url: `${GH}/pull/1`, repo: 'a/b', state: 'merged', headRef: 'feat/one', baseRef: 'main', closes: [] },
      { url: `${GH}/pull/2`, repo: 'a/b', state: 'open', headRef: 'feat/one', baseRef: 'main', closes: [] },
      { url: `${GH}/pull/3`, repo: 'a/b', state: 'open', headRef: 'x', baseRef: 'feat/one', closes: [] },
    ]);
    expect(reused[2].rel).toEqual({ closes: [], base: `${GH}/pull/2` });
  });

  it('a stored PR from before .prd/29 (no closes, no base branch) read neither: its entry leaves the relations alone', () => {
    // A merged PR's record is reused as is by the collect, so an upgrade meets these until it is read again.
    const [legacy] = prTreeEntries([{ url: `${GH}/pull/1`, repo: 'a/b', state: 'merged', headRef: 'feat/one' }]);
    expect(legacy).toEqual({
      kind: 'pr',
      url: `${GH}/pull/1`,
      provider: 'github',
      status: 'merged',
      rel: {},
      onlyIfPresent: true,
    });
  });

  it('one issue read that rejects is that issue’s failed read: the others in the batch are kept', async () => {
    const fetchIssue = vi.fn(async (_o: string, _r: string, n: number) => {
      if (n === 8) throw new Error('network');
      return { state: 'open' };
    });
    const out = await refreshIssueEntries([`${GH}/issues/7`, `${GH}/issues/8`, `${GH}/issues/9`], fetchIssue, 50);
    expect(out.map((e) => [e.url.split('/').pop(), e.checkedAt ?? null, e.triedAt ?? null])).toEqual([
      ['7', 50, null],
      ['8', null, 50],
      ['9', 50, null],
    ]);
  });

  it('PR entries carry when their read began, so an older read from the other reader does not replace them', () => {
    const [e] = prTreeEntries([{ url: `${GH}/pull/1`, repo: 'a/b', state: 'open', closes: [] }], 123);
    expect(e.relReadAt).toBe(123);
  });

  it('an issue URL with a query or a comment anchor is read; a URL that is no issue takes no read slot', async () => {
    const fetchIssue = vi.fn(async () => ({ state: 'open' }));
    const junk = Array.from({ length: 8 }, (_, i) => `https://github.com/a/b/pull/${i}`);
    const out = await refreshIssueEntries(
      [...junk, `${GH}/issues/7#issuecomment-123`, `${GH}/issues/8?x=1`],
      fetchIssue,
      50,
      2,
    );
    expect(fetchIssue.mock.calls).toEqual([
      ['a', 'b', 7],
      ['a', 'b', 8],
    ]);
    // Each entry keeps the URL the node has (its id is the same canonical one).
    expect(out.map((e) => e.url)).toEqual([`${GH}/issues/7#issuecomment-123`, `${GH}/issues/8?x=1`]);
  });

  it('an issue is read once: its title, state and GitHub parent (which joins while the issue is there); a failed read is stamped', async () => {
    const fetchIssue = vi.fn(async (_o: string, _r: string, n: number) =>
      n === 7
        ? { title: 'seven', state: 'open', parentUrl: `${GH}/issues/1` }
        : n === 8
          ? undefined
          : { state: 'closed' },
    );
    const out = await refreshIssueEntries(
      [`${GH}/issues/7`, `${GH}/issues/8`, `${GH}/issues/9`, 'https://x.atlassian.net/browse/K-1'],
      fetchIssue,
      50,
    );
    expect(out).toEqual([
      { kind: 'issue', url: `${GH}/issues/1`, provider: 'github', addedFor: `${GH}/issues/7`, readAt: 50 },
      {
        kind: 'issue',
        url: `${GH}/issues/7`,
        provider: 'github',
        title: 'seven',
        status: 'open',
        rel: { subOf: `${GH}/issues/1` },
        checkedAt: 50,
        onlyIfPresent: true,
      },
      { kind: 'issue', url: `${GH}/issues/8`, triedAt: 50, onlyIfPresent: true },
      {
        kind: 'issue',
        url: `${GH}/issues/9`,
        provider: 'github',
        status: 'closed',
        rel: { subOf: null },
        checkedAt: 50,
        onlyIfPresent: true,
      },
    ]);
    expect(fetchIssue).toHaveBeenCalledTimes(3);
    // At most `max` reads per pass.
    fetchIssue.mockClear();
    await refreshIssueEntries([`${GH}/issues/9`, `${GH}/issues/10`, `${GH}/issues/11`], fetchIssue, 1, 2);
    expect(fetchIssue).toHaveBeenCalledTimes(2);
  });

  it('the API URL of a parent issue is its web URL', () => {
    expect(issueWebUrl('https://api.github.com/repos/a/b/issues/7')).toBe(`${GH}/issues/7`);
    expect(issueWebUrl(null)).toBeUndefined();
    expect(issueWebUrl('https://example.com/x')).toBeUndefined();
  });
});
