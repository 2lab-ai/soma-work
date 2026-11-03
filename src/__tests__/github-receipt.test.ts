/**
 * #832 review round 17 — GitHub is the receipt for a write the parser proposes (src/github-receipt.ts).
 *
 * The parser reads syntax; only GitHub knows whether the call wrote. A proposal reaches the card only when GitHub
 * says the object was created (merged, closed) inside the call's window — on GitHub's clock — and, for a create, the
 * call's own input names the PR's head branch or the issue's title.
 */

import type { GitHubEffect } from '@soma/slack/session-link-capture';
import { describe, expect, it } from 'vitest';
import { createGithubReceiptChecker, type GitHubReceiptObject, MAX_CHECKS } from '../github-receipt';

const T0 = Date.parse('2026-11-03T06:00:00Z');
const PR = 'https://github.com/a/b/pull/12';
const ISSUE = 'https://github.com/a/b/issues/30';
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const effect = (op: GitHubEffect['op'], url: string, toolUseId = 'tu1'): GitHubEffect => ({
  op,
  toolUseId,
  link: {
    url,
    type: url.includes('/pull/') ? 'pr' : 'issue',
    provider: 'github',
    label: url.includes('/pull/') ? 'PR #12' : 'Issue #30',
  } as GitHubEffect['link'],
});

function check(
  effects: GitHubEffect[],
  objects: Record<string, GitHubReceiptObject | undefined | 'throw'>,
  opts: { input?: string; started?: number; ended?: number; now?: number } = {},
) {
  const calls: string[] = [];
  const confirm = createGithubReceiptChecker({
    fetchObject: async (owner, repo, kind, number) => {
      const key = `${owner}/${repo} ${kind} ${number}`;
      calls.push(key);
      const o = objects[key];
      if (o === 'throw') throw new Error('network');
      return o;
    },
    now: () => opts.now ?? (opts.ended ?? T0 + 3_000) + 200,
  });
  return {
    calls,
    result: confirm({
      effects,
      startedAt: new Map([['tu1', opts.started ?? T0]]),
      inputs: new Map([
        ['tu1', opts.input ?? 'curl -X POST … -d \'{"title":"x","head":"feat/card-links","base":"main"}\''],
      ]),
      endedAt: opts.ended ?? T0 + 3_000,
    }),
  };
}

const short = (es: GitHubEffect[]) => es.map((e) => `${e.op} ${e.link.url}`);

describe('createGithubReceiptChecker — GitHub confirms what a call wrote', () => {
  it('R1 — a create GitHub dates inside the call, whose head branch the call names, is confirmed', async () => {
    const { result } = check([effect('create', PR)], {
      'a/b pr 12': { createdAt: iso(T0 + 1_000), headRef: 'feat/card-links', state: 'open' },
    });
    expect(short(await result)).toEqual([`create ${PR}`]);
  });

  it('R2 — an existing PR the call printed (created before the call) is not a create', async () => {
    const { result } = check([effect('create', PR)], {
      'a/b pr 12': { createdAt: iso(T0 - 3_600_000), headRef: 'feat/card-links', state: 'open' },
    });
    expect(await result).toEqual([]);
  });

  it('R3 — another session on the same App created PR #12 in the same seconds; this call names another branch', async () => {
    // astra-zhuge's attribution case: this call's create failed, then it printed #12's URL.
    const { result } = check(
      [effect('create', PR)],
      { 'a/b pr 12': { createdAt: iso(T0 + 1_000), headRef: 'other-session/branch', state: 'open' } },
      {
        input:
          'gh api -X POST repos/a/b/pulls -f head=feat/mine -f base=main || printf "%s\\n" https://github.com/a/b/pull/12',
      },
    );
    expect(await result).toEqual([]);
  });

  it('R4 — the window is on GitHub’s clock: the host 60 s ahead still confirms a create at start + 1 s', async () => {
    const skew = -60_000; // GitHub's clock is 60 s behind the host's.
    const ended = T0 + 3_000;
    const { result } = check(
      [effect('create', PR)],
      {
        'a/b pr 12': {
          createdAt: iso(T0 + 1_000 + skew),
          headRef: 'feat/card-links',
          serverNowMs: ended + 200 + skew,
        },
      },
      { ended, now: ended + 200 },
    );
    expect(short(await result)).toEqual([`create ${PR}`]);
    // …and a PR created 10 s before the call (on GitHub's clock) is not.
    const { result: before } = check(
      [effect('create', PR)],
      {
        'a/b pr 12': {
          createdAt: iso(T0 - 10_000 + skew),
          headRef: 'feat/card-links',
          serverNowMs: ended + 200 + skew,
        },
      },
      { ended, now: ended + 200 },
    );
    expect(await before).toEqual([]);
  });

  it('R5 — a merge GitHub dates inside the call is confirmed; an old merge is not', async () => {
    const { result } = check([effect('merge', PR)], {
      'a/b pr 12': { createdAt: iso(T0 - 86_400_000), mergedAt: iso(T0 + 2_000), state: 'closed' },
    });
    expect(short(await result)).toEqual([`merge ${PR}`]);
    const { result: old } = check([effect('merge', PR)], {
      'a/b pr 12': { createdAt: iso(T0 - 86_400_000), mergedAt: iso(T0 - 600_000), state: 'closed' },
    });
    expect(await old).toEqual([]);
  });

  it('R6 — a close: closed and not merged inside the call; a merged PR is never a close', async () => {
    const { result } = check([effect('close', ISSUE)], {
      'a/b issue 30': { createdAt: iso(T0 - 86_400_000), closedAt: iso(T0 + 1_000), state: 'closed', mergedAt: null },
    });
    expect(short(await result)).toEqual([`close ${ISSUE}`]);
    const { result: merged } = check([effect('close', PR)], {
      'a/b pr 12': { closedAt: iso(T0 + 1_000), mergedAt: iso(T0 + 1_000), state: 'closed' },
    });
    expect(await merged).toEqual([]);
    const { result: open } = check([effect('close', ISSUE)], {
      'a/b issue 30': { closedAt: null, state: 'open' },
    });
    expect(await open).toEqual([]);
  });

  it('R7 — an issue create is the call’s when its title survives the shell quoting in the input', async () => {
    const title = "fix(card-links): the task card's model as icons";
    const input = `jq -n '{title:"fix(card-links): the task card'"'"'s model as icons"}' | curl -s -X POST https://api.github.com/repos/a/b/issues -d @-`;
    const { result } = check(
      [effect('create', ISSUE)],
      { 'a/b issue 30': { createdAt: iso(T0 + 500), title, state: 'open' } },
      { input },
    );
    expect(short(await result)).toEqual([`create ${ISSUE}`]);
    const { result: other } = check(
      [effect('create', ISSUE)],
      { 'a/b issue 30': { createdAt: iso(T0 + 500), title: 'another session’s issue title', state: 'open' } },
      { input },
    );
    expect(await other).toEqual([]);
  });

  it('R8 — GitHub could not be asked (failure, a throw, a malformed date): nothing, and no throw', async () => {
    expect(await check([effect('create', PR)], { 'a/b pr 12': undefined }).result).toEqual([]);
    expect(await check([effect('create', PR)], { 'a/b pr 12': 'throw' }).result).toEqual([]);
    expect(
      await check([effect('create', PR)], { 'a/b pr 12': { createdAt: 'yesterday', headRef: 'feat/card-links' } })
        .result,
    ).toEqual([]);
    // An effect without its call, or with a URL that is not a PR or issue, is not asked about.
    const { calls, result } = check(
      [effect('create', PR, 'unknown-call'), effect('create', 'https://github.com/a/b/pull/12/files')],
      {},
    );
    expect(await result).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('R9 — at most MAX_CHECKS GETs per batch', async () => {
    const many = Array.from({ length: MAX_CHECKS + 5 }, (_, i) =>
      effect('merge', `https://github.com/a/b/pull/${i + 1}`),
    );
    const { calls, result } = check(many, {});
    await result;
    expect(calls.length).toBe(MAX_CHECKS);
  });
});
