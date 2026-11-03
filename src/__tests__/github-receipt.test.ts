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

  it('R7 — an issue title the input names as a complete literal must be the issue’s; a quote-spliced one names nothing', async () => {
    const title = 'fix(card-links): a Notion chip is named by its title';
    const named = `jq -n '{title:"${title}"}' | curl -s -X POST https://api.github.com/repos/a/b/issues -d @-`;
    const { result } = check(
      [effect('create', ISSUE)],
      { 'a/b issue 30': { createdAt: iso(T0 + 500), title, state: 'open' } },
      { input: named },
    );
    expect(short(await result)).toEqual([`create ${ISSUE}`]);
    const { result: other } = check(
      [effect('create', ISSUE)],
      { 'a/b issue 30': { createdAt: iso(T0 + 500), title: 'another session’s issue title', state: 'open' } },
      { input: named },
    );
    expect(await other).toEqual([]);
    // The shell's `'"'"'` splice breaks the literal: it names nothing, and the window decides.
    const spliced = `jq -n '{title:"fix(card-links): the task card'"'"'s model as icons"}' | curl -s -X POST https://api.github.com/repos/a/b/issues -d @-`;
    const { result: s2 } = check(
      [effect('create', ISSUE)],
      {
        'a/b issue 30': {
          createdAt: iso(T0 + 500),
          title: "fix(card-links): the task card's model as icons",
          state: 'open',
        },
      },
      { input: spliced },
    );
    expect(short(await s2)).toEqual([`create ${ISSUE}`]);
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

  it('R10 — a call that names no head (`gh pr create --fill`, a body from a file) is taken on the window (fable-zhuge, round 18)', async () => {
    for (const input of [
      'gh pr create --fill',
      'gh pr create --title "feat: x" --body-file body.md --base main',
      'curl -s -X POST https://api.github.com/repos/a/b/pulls -d @pr.json | jq .html_url',
      // A head that is a variable names nothing.
      'node -e \'fetch(u, {method: "POST", body: JSON.stringify({title, head: branch, base: "main"})})\'',
    ]) {
      const { result } = check(
        [effect('create', PR)],
        { 'a/b pr 12': { createdAt: iso(T0 + 1_000), headRef: 'feat/x', state: 'open' } },
        { input },
      );
      expect(short(await result), input).toEqual([`create ${PR}`]);
    }
  });

  it('R11 — a named head confirms in every spelling: a quoted key, -f head=, --head, owner:branch', async () => {
    for (const input of [
      `jq -n '{title:"x",head:"feat/x",base:"main"}' | curl -s -X POST https://api.github.com/repos/a/b/pulls -d @-`,
      'gh api -X POST repos/a/b/pulls -f head=feat/x -f base=main',
      'gh pr create --head feat/x --fill',
      'gh pr create -H zhuge:feat/x --fill',
    ]) {
      const { result } = check(
        [effect('create', PR)],
        { 'a/b pr 12': { createdAt: iso(T0 + 1_000), headRef: 'feat/x', state: 'open' } },
        { input },
      );
      expect(short(await result), input).toEqual([`create ${PR}`]);
    }
  });

  it('R12 — an issue: a short title the input names, or no title in the input at all, is confirmed', async () => {
    const obj = { 'a/b issue 30': { createdAt: iso(T0 + 1_000), title: 'Bug', state: 'open' } };
    expect(
      short(await check([effect('create', ISSUE)], obj, { input: 'gh issue create -R a/b -t "Bug" -b x' }).result),
    ).toEqual([`create ${ISSUE}`]);
    expect(
      short(
        await check([effect('create', ISSUE)], obj, {
          input: 'curl -s -X POST https://api.github.com/repos/a/b/issues -d @issue.json',
        }).result,
      ),
    ).toEqual([`create ${ISSUE}`]);
    // …but a title the input names that is not the issue's: another session's issue.
    expect(
      await check([effect('create', ISSUE)], obj, { input: 'gh issue create -R a/b -t "Crash on start" -b x' }).result,
    ).toEqual([]);
  });

  it('R13 — a GitHub answer that never comes (a hung token or GET) confirms nothing, and the others still answer', async () => {
    const confirm = createGithubReceiptChecker({
      fetchObject: (_o, _r, _k, number) =>
        number === 12
          ? new Promise(() => {})
          : Promise.resolve({ createdAt: iso(T0 - 86_400_000), mergedAt: iso(T0 + 1_000), state: 'closed' }),
      now: () => T0 + 3_200,
      timeoutMs: 20,
    });
    const out = await confirm({
      effects: [effect('merge', PR), effect('merge', 'https://github.com/a/b/pull/13')],
      startedAt: new Map([['tu1', T0]]),
      inputs: new Map([['tu1', 'gh pr merge 12 && gh pr merge 13']]),
      endedAt: T0 + 3_000,
    });
    expect(short(out)).toEqual(['merge https://github.com/a/b/pull/13']);
  });

  it('R14 — a variable, a concatenation or a quoted flag word names nothing: the real create is kept (fable-zhuge, round 19)', async () => {
    const issue = { 'a/b issue 30': { createdAt: iso(T0 + 1_000), title: 'Crash on start', state: 'open' } };
    for (const input of [
      'gh issue create -R a/b --title "$T" --body-file b.md',
      'gh issue create -R a/b -t "fix: $WHAT" -b x',
      `jq -n '{title:"'"$T"'"}' | curl -s -X POST https://api.github.com/repos/a/b/issues -d @-`,
    ]) {
      expect(short(await check([effect('create', ISSUE)], issue, { input }).result), input).toEqual([
        `create ${ISSUE}`,
      ]);
    }
    const pr = { 'a/b pr 12': { createdAt: iso(T0 + 1_000), headRef: 'feat/x', state: 'open' } };
    for (const input of [
      'node -e \'fetch(u, {method: "POST", body: JSON.stringify({title: "t", head: "feat/" + process.env.BR, base: "main"})})\'',
      'node -e \'fetch(u, {method: "POST", body: JSON.stringify({head: "zhuge:" + b, base: "main"})})\'',
      'gh pr create -R a/b --title "x -H y" --fill',
    ]) {
      expect(short(await check([effect('create', PR)], pr, { input }).result), input).toEqual([`create ${PR}`]);
    }
    // A complete literal that differs still rejects: --head outside quotes, -f 'title=…'.
    expect(
      await check([effect('create', PR)], pr, { input: 'gh pr create -R a/b --head other/y --fill' }).result,
    ).toEqual([]);
    expect(
      await check([effect('create', ISSUE)], issue, { input: "gh api -X POST repos/a/b/issues -f 'title=Other bug'" })
        .result,
    ).toEqual([]);
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
