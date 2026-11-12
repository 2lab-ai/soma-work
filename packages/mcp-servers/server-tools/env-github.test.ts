/**
 * env-access WU3 (#1211): an environment user's GitHub actions. Approve and merge happen only under the
 * environment's conditions, pinned to the head SHA the caller looked at.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  allowedRepo,
  approvalProblem,
  approve,
  type EnvGithubConfig,
  type Fetch,
  GithubError,
  headSha,
  merge,
  mergeProblem,
  type PrState,
  prNumber,
  prState,
} from './env-github.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const config: EnvGithubConfig = {
  token: 'tok-secret',
  repos: ['acme/app'],
  approveWhen: { authors: ['soma-bot[bot]'], bases: ['develop'], requiredChecksGreen: true },
  mergeWhen: { authors: ['soma-bot[bot]'], bases: ['develop', 'deploy/dev2'] },
};

function pr(over: Partial<PrState> = {}): PrState {
  return {
    repo: 'acme/app',
    number: 7,
    title: 't',
    state: 'open',
    draft: false,
    author: 'soma-bot[bot]',
    base: 'develop',
    headSha: SHA,
    checks: { total: 2, passed: 2, green: true, pending: [], failing: [] },
    ...over,
  };
}

/** Routes are `METHOD path`. */
function fakeFetch(routes: Record<string, unknown>, status = 200) {
  const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
  const fetch: Fetch = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization });
    const key = `${init.method} ${url.replace('https://api.github.com', '')}`;
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({ message: `no route ${key}` }) };
    return { ok: status < 400, status, json: async () => routes[key] };
  });
  return { fetch, calls };
}

const PULL = {
  title: 'T',
  state: 'open',
  draft: false,
  user: { login: 'soma-bot[bot]' },
  base: { ref: 'develop' },
  head: { sha: SHA },
};
const RUNS = `GET /repos/acme/app/commits/${SHA}/check-runs?per_page=100`;
const STATUS = `GET /repos/acme/app/commits/${SHA}/status?per_page=100`;
const GREEN_RUNS = { total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] };
const NO_STATUS = { state: 'pending', total_count: 0, statuses: [] };

describe('input checks', () => {
  it('accepts only configured repositories, case-insensitively', () => {
    expect(allowedRepo(config, 'ACME/App')).toBe('acme/app');
    expect(() => allowedRepo(config, 'acme/other')).toThrow(/not one of this environment's repositories/);
    expect(() => allowedRepo(config, '../x')).toThrow(GithubError);
  });

  it('takes a PR number and a full head SHA only', () => {
    expect(prNumber(7)).toBe(7);
    expect(() => prNumber('7')).toThrow(GithubError);
    expect(headSha(SHA)).toBe(SHA);
    expect(() => headSha('abc123')).toThrow(/full 40-character/);
  });
});

describe('prState', () => {
  it('reads the PR and judges its checks: every run completed green and every status success', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /repos/acme/app/pulls/7': PULL,
      [RUNS]: {
        total_count: 3,
        check_runs: [
          { name: 'ci', status: 'completed', conclusion: 'success' },
          { name: 'lint', status: 'in_progress', conclusion: null },
          { name: 'e2e', status: 'completed', conclusion: 'failure' },
        ],
      },
      [STATUS]: { state: 'success', total_count: 1, statuses: [{ context: 'deploy', state: 'success' }] },
    });
    const state = await prState(fetch, config, 'acme/app', 7);
    expect(state).toMatchObject({ author: 'soma-bot[bot]', base: 'develop', headSha: SHA });
    expect(state.checks).toEqual({ total: 4, passed: 2, green: false, pending: ['lint'], failing: ['e2e'] });
    expect(calls.every((c) => c.auth === 'Bearer tok-secret')).toBe(true);
  });

  it('is green with green check runs and no statuses', async () => {
    const { fetch } = fakeFetch({ 'GET /repos/acme/app/pulls/7': PULL, [RUNS]: GREEN_RUNS, [STATUS]: NO_STATUS });
    expect((await prState(fetch, config, 'acme/app', 7)).checks).toEqual({
      total: 1,
      passed: 1,
      green: true,
      pending: [],
      failing: [],
    });
  });

  it('is not green when more check runs exist than one page holds', async () => {
    const { fetch } = fakeFetch({
      'GET /repos/acme/app/pulls/7': PULL,
      [RUNS]: { ...GREEN_RUNS, total_count: 101 },
      [STATUS]: NO_STATUS,
    });
    expect((await prState(fetch, config, 'acme/app', 7)).checks.green).toBe(false);
  });

  // trinity R1 (astra, fable): a failing status past the first page, or only in the combined state.
  it('is not green when more statuses exist than one page holds, or the combined status is not success', async () => {
    const paged = fakeFetch({
      'GET /repos/acme/app/pulls/7': PULL,
      [RUNS]: GREEN_RUNS,
      [STATUS]: { state: 'success', total_count: 101, statuses: [{ context: 'a', state: 'success' }] },
    });
    expect((await prState(paged.fetch, config, 'acme/app', 7)).checks.green).toBe(false);
    const combined = fakeFetch({
      'GET /repos/acme/app/pulls/7': PULL,
      [RUNS]: GREEN_RUNS,
      [STATUS]: { state: 'failure', total_count: 1, statuses: [{ context: 'a', state: 'success' }] },
    });
    expect((await prState(combined.fetch, config, 'acme/app', 7)).checks.failing).toContain('(combined status)');
  });

  // trinity R1 (fable): right after a push no check has reported yet — that is not green.
  it('is not green when no check has reported', async () => {
    const { fetch } = fakeFetch({
      'GET /repos/acme/app/pulls/7': PULL,
      [RUNS]: { total_count: 0, check_runs: [] },
      [STATUS]: NO_STATUS,
    });
    const state = await prState(fetch, config, 'acme/app', 7);
    expect(state.checks.green).toBe(false);
    expect(approvalProblem(config, state, SHA)).toMatch(/no check has reported/);
  });

  // trinity R2 (grok): skipped and neutral runs alone are not a pass — one success is the least.
  it('is not green when every check was skipped or neutral', async () => {
    const { fetch } = fakeFetch({
      'GET /repos/acme/app/pulls/7': PULL,
      [RUNS]: {
        total_count: 2,
        check_runs: [
          { name: 'a', status: 'completed', conclusion: 'skipped' },
          { name: 'b', status: 'completed', conclusion: 'neutral' },
        ],
      },
      [STATUS]: NO_STATUS,
    });
    const state = await prState(fetch, config, 'acme/app', 7);
    expect(state.checks.green).toBe(false);
    expect(approvalProblem(config, state, SHA)).toMatch(/no check has passed/);
  });

  it('turns a GitHub error into GithubError with its status, never the token', async () => {
    const { fetch } = fakeFetch({}, 404);
    await expect(prState(fetch, config, 'acme/app', 7)).rejects.toThrow(/answered 404/);
    await expect(prState(fetch, config, 'acme/app', 7)).rejects.not.toThrow(/tok-secret/);
  });
});

describe('approvalProblem', () => {
  it('approves an open bot PR into develop at the looked-at head with green checks', () => {
    expect(approvalProblem(config, pr(), SHA)).toBeUndefined();
  });

  it.each([
    ['no approveWhen', { ...config, approveWhen: undefined }, pr(), SHA, /does not approve/],
    ['closed', config, pr({ state: 'closed' }), SHA, /PR is closed/],
    ['draft', config, pr({ draft: true }), SHA, /draft/],
    ['head moved', config, pr({ headSha: OTHER }), SHA, /look again/],
    ['other author', config, pr({ author: 'someone' }), SHA, /author someone/],
    ['other base', config, pr({ base: 'main' }), SHA, /base main/],
    [
      'red checks',
      config,
      pr({ checks: { total: 1, passed: 0, green: false, pending: [], failing: ['ci'] } }),
      SHA,
      /not green: ci/,
    ],
    [
      'red checks, requiredChecksGreen unset',
      { ...config, approveWhen: { authors: ['soma-bot[bot]'], bases: ['develop'] } },
      pr({ checks: { total: 1, passed: 0, green: false, pending: ['ci'], failing: [] } }),
      SHA,
      /not finished: ci/,
    ],
  ])('refuses: %s', (_name, cfg, state, sha, reason) => {
    expect(approvalProblem(cfg as EnvGithubConfig, state, sha)).toMatch(reason);
  });

  it('approves with red checks only when the environment says requiredChecksGreen: false', () => {
    const lax = {
      ...config,
      approveWhen: { authors: ['soma-bot[bot]'], bases: ['develop'], requiredChecksGreen: false },
    };
    expect(
      approvalProblem(lax, pr({ checks: { total: 1, passed: 0, green: false, pending: [], failing: ['ci'] } }), SHA),
    ).toBeUndefined();
  });
});

describe('mergeProblem', () => {
  it('merges a listed author into a listed base at the looked-at head with green checks', () => {
    expect(mergeProblem(config, pr({ base: 'deploy/dev2' }), SHA, 'merge')).toBeUndefined();
  });

  it.each([
    ['no mergeWhen', { ...config, mergeWhen: undefined }, pr(), 'merge', /does not merge/],
    // trinity R1 (fable): merge has an author condition too.
    ['other author', config, pr({ author: 'someone' }), 'merge', /author someone/],
    ['other base', config, pr({ base: 'main' }), 'merge', /base main/],
    ['method', config, pr(), 'squash', /squash is not allowed/],
    [
      'pending checks',
      config,
      pr({ checks: { total: 1, passed: 0, green: false, pending: ['ci'], failing: [] } }),
      'merge',
      /not finished: ci/,
    ],
    ['head moved', config, pr({ headSha: OTHER }), 'merge', /look again/],
  ])('refuses: %s', (_name, cfg, state, method, reason) => {
    expect(mergeProblem(cfg as EnvGithubConfig, state, SHA, method)).toMatch(reason);
  });
});

describe('approve and merge', () => {
  it('pins the review to the SHA and confirms the PR did not change meanwhile', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /repos/acme/app/pulls/7/reviews': { id: 11 },
      'GET /repos/acme/app/pulls/7': PULL,
    });
    await approve(fetch, config, 'acme/app', 7, SHA, 'develop', 'ok');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ event: 'APPROVE', commit_id: SHA, body: 'ok' });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
  });

  // trinity R1 (fable, astra): a push or a retarget between the look and the review.
  it.each([
    ['a push', { ...PULL, head: { sha: OTHER } }],
    ['a retarget', { ...PULL, base: { ref: 'main' } }],
  ])('dismisses its own approval when %s landed meanwhile', async (_name, after) => {
    const { fetch, calls } = fakeFetch({
      'POST /repos/acme/app/pulls/7/reviews': { id: 11 },
      'GET /repos/acme/app/pulls/7': after,
      'PUT /repos/acme/app/pulls/7/reviews/11/dismissals': { id: 11 },
    });
    await expect(approve(fetch, config, 'acme/app', 7, SHA, 'develop', 'ok')).rejects.toThrow(
      /changed while it was being approved.*dismissed/,
    );
    expect(calls.at(-1)?.method).toBe('PUT');
  });

  // trinity R2 (grok): when the PR cannot be read again, the approval is not left standing unannounced.
  it('dismisses its approval when the PR cannot be read again, and says so when that fails too', async () => {
    const dismissed = fakeFetch({
      'POST /repos/acme/app/pulls/7/reviews': { id: 11 },
      'PUT /repos/acme/app/pulls/7/reviews/11/dismissals': { id: 11 },
    });
    await expect(approve(dismissed.fetch, config, 'acme/app', 7, SHA, 'develop', 'ok')).rejects.toThrow(
      /could not be confirmed.*dismissed/,
    );
    const stands = fakeFetch({ 'POST /repos/acme/app/pulls/7/reviews': { id: 11 } });
    await expect(approve(stands.fetch, config, 'acme/app', 7, SHA, 'develop', 'ok')).rejects.toThrow(
      /could not be confirmed.*it still stands/,
    );
  });

  it('pins the merge to the SHA, after confirming head and base once more', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /repos/acme/app/pulls/7': PULL,
      'PUT /repos/acme/app/pulls/7/merge': { sha: 'c'.repeat(40), merged: true },
    });
    expect(await merge(fetch, config, 'acme/app', 7, SHA, 'develop', 'merge')).toBe('c'.repeat(40));
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ sha: SHA, merge_method: 'merge' });
  });

  it('does not merge a PR retargeted since the look', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /repos/acme/app/pulls/7': { ...PULL, base: { ref: 'main' } } });
    await expect(merge(fetch, config, 'acme/app', 7, SHA, 'develop', 'merge')).rejects.toThrow(/changed/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
