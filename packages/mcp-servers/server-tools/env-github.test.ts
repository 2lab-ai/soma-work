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
  mergeBases: ['develop', 'deploy/dev2'],
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
    checks: { total: 2, green: true, pending: [], failing: [] },
    ...over,
  };
}

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
      'GET /repos/acme/app/pulls/7': {
        title: 'T',
        state: 'open',
        draft: false,
        user: { login: 'soma-bot[bot]' },
        base: { ref: 'develop' },
        head: { sha: SHA },
      },
      [`GET /repos/acme/app/commits/${SHA}/check-runs?per_page=100`]: {
        total_count: 3,
        check_runs: [
          { name: 'ci', status: 'completed', conclusion: 'success' },
          { name: 'lint', status: 'in_progress', conclusion: null },
          { name: 'e2e', status: 'completed', conclusion: 'failure' },
        ],
      },
      [`GET /repos/acme/app/commits/${SHA}/status`]: { statuses: [{ context: 'deploy', state: 'success' }] },
    });
    const state = await prState(fetch, config, 'acme/app', 7);
    expect(state).toMatchObject({ author: 'soma-bot[bot]', base: 'develop', headSha: SHA });
    expect(state.checks).toEqual({ total: 4, green: false, pending: ['lint'], failing: ['e2e'] });
    expect(calls.every((c) => c.auth === 'Bearer tok-secret')).toBe(true);
  });

  it('is not green when more check runs exist than one page holds', async () => {
    const { fetch } = fakeFetch({
      'GET /repos/acme/app/pulls/7': { state: 'open', user: {}, base: {}, head: { sha: SHA } },
      [`GET /repos/acme/app/commits/${SHA}/check-runs?per_page=100`]: { total_count: 101, check_runs: [] },
      [`GET /repos/acme/app/commits/${SHA}/status`]: { statuses: [] },
    });
    expect((await prState(fetch, config, 'acme/app', 7)).checks.green).toBe(false);
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
      pr({ checks: { total: 1, green: false, pending: [], failing: ['ci'] } }),
      SHA,
      /not green: ci/,
    ],
    [
      'red checks, requiredChecksGreen unset',
      { ...config, approveWhen: { authors: ['soma-bot[bot]'], bases: ['develop'] } },
      pr({ checks: { total: 1, green: false, pending: ['ci'], failing: [] } }),
      SHA,
      /not finished: ci/,
    ],
  ])('refuses: %s', (_name, cfg, state, sha, reason) => {
    expect(approvalProblem(cfg as EnvGithubConfig, state, sha)).toMatch(reason);
  });
});

it('approves with red checks only when the environment says requiredChecksGreen: false', () => {
  const lax = {
    ...config,
    approveWhen: { authors: ['soma-bot[bot]'], bases: ['develop'], requiredChecksGreen: false },
  };
  expect(
    approvalProblem(lax, pr({ checks: { total: 1, green: false, pending: [], failing: ['ci'] } }), SHA),
  ).toBeUndefined();
});

describe('mergeProblem', () => {
  it('merges into a listed base at the looked-at head with green checks', () => {
    expect(mergeProblem(config, pr({ base: 'deploy/dev2' }), SHA, 'merge')).toBeUndefined();
  });

  it.each([
    ['no mergeBases', { ...config, mergeBases: undefined }, pr(), 'merge', /does not merge/],
    ['other base', config, pr({ base: 'main' }), 'merge', /base main/],
    ['method', config, pr(), 'squash', /squash is not allowed/],
    [
      'pending checks',
      config,
      pr({ checks: { total: 1, green: false, pending: ['ci'], failing: [] } }),
      'merge',
      /not finished: ci/,
    ],
    ['head moved', config, pr({ headSha: OTHER }), 'merge', /look again/],
  ])('refuses: %s', (_name, cfg, state, method, reason) => {
    expect(mergeProblem(cfg as EnvGithubConfig, state, SHA, method)).toMatch(reason);
  });
});

describe('approve and merge', () => {
  it('pins the review to the SHA', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /repos/acme/app/pulls/7/reviews': { id: 1 } });
    await approve(fetch, config, 'acme/app', 7, SHA, 'ok');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ event: 'APPROVE', commit_id: SHA, body: 'ok' });
  });

  it('pins the merge to the SHA', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /repos/acme/app/pulls/7/merge': { sha: 'c'.repeat(40), merged: true } });
    expect(await merge(fetch, config, 'acme/app', 7, SHA, 'merge')).toBe('c'.repeat(40));
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ sha: SHA, merge_method: 'merge' });
  });
});
