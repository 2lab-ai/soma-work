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
      { url: `${GH}/pull/1`, repo: 'a/b', state: 'merged', title: 'base', headRef: 'feat/one', baseRef: 'main' },
      {
        url: `${GH}/pull/2`,
        repo: 'a/b',
        state: 'open',
        headRef: 'feat/two',
        baseRef: 'feat/one',
        closes: [`${GH}/issues/9`],
      },
      // A fork's head of the same name is not this repo's branch.
      { url: `${GH}/pull/3`, repo: 'a/b', state: 'open', headRef: 'feat/one', headRepo: 'fork/b', baseRef: 'main' },
      { url: `${GH}/pull/4`, repo: 'a/b', state: 'open', headRef: 'x', baseRef: 'feat/two' },
    ];
    expect(prTreeEntries(prs)).toEqual([
      { kind: 'pr', url: `${GH}/pull/1`, provider: 'github', title: 'base', status: 'merged' },
      {
        kind: 'pr',
        url: `${GH}/pull/2`,
        provider: 'github',
        status: 'open',
        rel: { closes: [`${GH}/issues/9`], base: `${GH}/pull/1` },
      },
      { kind: 'pr', url: `${GH}/pull/3`, provider: 'github', status: 'open' },
      { kind: 'pr', url: `${GH}/pull/4`, provider: 'github', status: 'open', rel: { base: `${GH}/pull/2` } },
    ]);
    // A closed PR is not a stack's base.
    const closed = prTreeEntries([
      { url: `${GH}/pull/1`, repo: 'a/b', state: 'closed', headRef: 'feat/one' },
      { url: `${GH}/pull/2`, repo: 'a/b', state: 'open', baseRef: 'feat/one' },
    ]);
    expect(closed[1]).not.toHaveProperty('rel');
  });

  it('an issue is read once: its title, state and GitHub parent (which joins too); a failed read is skipped', async () => {
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
      { kind: 'issue', url: `${GH}/issues/1`, provider: 'github' },
      {
        kind: 'issue',
        url: `${GH}/issues/7`,
        provider: 'github',
        title: 'seven',
        status: 'open',
        rel: { subOf: `${GH}/issues/1` },
        checkedAt: 50,
      },
      { kind: 'issue', url: `${GH}/issues/9`, provider: 'github', status: 'closed', checkedAt: 50 },
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
