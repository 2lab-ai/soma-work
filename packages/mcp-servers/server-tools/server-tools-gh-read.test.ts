/**
 * env-access WU5 (#1213): server-tools `gh_read` — the QA skills read GitHub with the environment's own token,
 * outside every model sandbox, only GET, only the environment's repositories and only the parts QA reads.
 * It replaces the broker's `gh_read` for them (the broker goes in WU6, #1214).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler() {}
    connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: Symbol('CallToolRequestSchema'),
  ListToolsRequestSchema: Symbol('ListToolsRequestSchema'),
}));
vi.mock('@soma/process-shared/stderr-logger.js', () => ({
  StderrLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

import type { Fetch } from './env-github.js';
import { handleGhRead, loadConfig, resetConfigCache } from './server-tools-mcp-server.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-gh-read-'));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SECRETS = path.join(ROOT, 'secrets');
const TOKEN = 'tok-from-store-7c1';
const saved = { ...process.env };

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(SECRETS, 'gh-env'), `${TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      'server-tools': {
        dev2: { envUser: 'env:acme-dev2', github: { token: { $secret: 'gh-env' }, repos: ['acme/app'] } },
        nogh: { ssh: { host: 'x' } },
      },
    }),
  );
  process.env.SOMA_CONFIG_FILE = CONFIG_FILE;
  process.env.SOMA_SECRETS_DIR = SECRETS;
  resetConfigCache();
  loadConfig();
});

afterEach(() => {
  process.env = { ...saved };
});

function github(answer: { status?: number; json?: unknown } = {}) {
  const calls: { url: string; method: string; auth?: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.json ?? {} };
  };
  return { fetch, calls };
}

const text = (out: { content: { text: string }[] }) => JSON.parse(out.content[0].text);

describe('gh_read', () => {
  it("GETs a path of the environment's repository with its token and returns the answer", async () => {
    const { fetch, calls } = github({ json: [{ sha: 'abc', commit: { message: 'fix' } }] });
    const out = await handleGhRead(
      { server: 'dev2', path: 'repos/acme/app/commits', query: { sha: 'deploy/dev2', per_page: 5 } },
      fetch,
    );
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/acme/app/commits?sha=deploy%2Fdev2&per_page=5',
        method: 'GET',
        auth: `Bearer ${TOKEN}`,
      },
    ]);
    expect(text(out)).toEqual({
      path: 'repos/acme/app/commits',
      status: 200,
      truncated: false,
      body: [{ sha: 'abc', commit: { message: 'fix' } }],
    });
    expect(out.content[0].text).not.toContain(TOKEN);
  });

  it('reads what QA reads: compare, pulls, issues, runs, jobs, check runs, statuses, branches, contents', async () => {
    const { fetch, calls } = github();
    for (const p of [
      'repos/acme/app',
      '/repos/acme/app/compare/abc...def',
      'repos/ACME/App/pulls/12/files',
      'repos/acme/app/issues/3/comments',
      'repos/acme/app/actions/runs/99/jobs',
      'repos/acme/app/actions/workflows/deploy.yml/runs',
      'repos/acme/app/commits/abc/check-runs',
      'repos/acme/app/commits/abc/status',
      'repos/acme/app/branches/deploy%2Fdev2',
      'repos/acme/app/contents/src/a.ts',
    ]) {
      await handleGhRead({ server: 'dev2', path: p }, fetch);
    }
    expect(calls).toHaveLength(10);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('refuses another repository, a part QA does not read, and a path that could leave the repository', async () => {
    const { fetch, calls } = github();
    const refuse = (p: unknown, query?: unknown) => handleGhRead({ server: 'dev2', path: p, query }, fetch);
    await expect(refuse('repos/acme/other/pulls')).rejects.toThrow(/not one of this environment's repositories/);
    await expect(refuse('repos/acme/app/actions/secrets')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/actions/variables')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/hooks')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/keys')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/environments/dev2/secrets')).rejects.toThrow(/not a part gh_read reads/);
    // trinity R1 (fable): settings under a part QA reads, and encoded dot segments.
    await expect(refuse('repos/acme/app/branches/main/protection')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/branches/main/protection/restrictions')).rejects.toThrow(
      /not a part gh_read reads/,
    );
    await expect(refuse('repos/acme/app/contents/..%2F..%2Fhooks')).rejects.toThrow(/path/);
    await expect(refuse('repos/acme/app/contents/a%2F%2E%2E%2Fb')).rejects.toThrow(/path/);
    await expect(refuse('repos/acme/app/contents/%E0%A4%A')).rejects.toThrow(/path/);
    await expect(refuse('repos/acme/app/contents/a%5Cb')).rejects.toThrow(/path/);
    // review-of-legends (999ec6829): issue routes that answer with another repository's issue are not read.
    await expect(refuse('repos/acme/app/issues/1/parent')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/issues/1/sub_issues')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/issues/1/timeline')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/pulls/1/requested_reviewers/x')).rejects.toThrow(/not a part gh_read reads/);
    // trinity R2 (fable): a compare across forks reads another repository; a branch path that decodes to protection.
    await expect(refuse('repos/acme/app/compare/main...other:branch')).rejects.toThrow(/another repository/);
    await expect(refuse('repos/acme/app/compare/main...other%3Arepo%3Abranch')).rejects.toThrow(/another repository/);
    await expect(refuse('repos/acme/app/branches/main%2Fprotection')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/pulls/../../../user')).rejects.toThrow(/path/);
    await expect(refuse('repos/acme/app/pulls?state=all')).rejects.toThrow(/path/);
    await expect(refuse('user/repos')).rejects.toThrow(/path/);
    await expect(refuse('https://api.github.com/repos/acme/app')).rejects.toThrow(/path/);
    await expect(refuse(42)).rejects.toThrow(/path/);
    await expect(refuse('repos/acme/app/pulls', { state: { nested: 1 } })).rejects.toThrow(/query/);
    await expect(handleGhRead({ server: 'nogh', path: 'repos/acme/app' }, fetch)).rejects.toThrow(/no github/);
    expect(calls).toEqual([]);
  });

  // review-of-legends (999ec6829): GitHub path characters QA meets, and a 204 that is an answer.
  it('reads paths with GitHub path characters, and takes a 204 as an empty answer', async () => {
    const { fetch, calls } = github();
    for (const p of [
      'repos/acme/app/contents/src/app/(auth)/page.tsx',
      'repos/acme/app/contents/src/hooks/use-x.ts',
      'repos/acme/app/compare/main...feature+1',
      'repos/acme/app/git/ref/heads/deploy/dev2',
    ]) {
      await handleGhRead({ server: 'dev2', path: p }, fetch);
    }
    expect(calls).toHaveLength(4);
    const merged: Fetch = async () => ({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error('no body');
      },
    });
    expect(text(await handleGhRead({ server: 'dev2', path: 'repos/acme/app/pulls/12/merge' }, merged))).toMatchObject({
      status: 204,
      body: null,
    });
  });

  // trinity R1 (grok): text in the repository can hold the token (an issue body, a committed file); never hand it on.
  it('never hands the token on: not in a body, not in a base64 file, not in an error', async () => {
    const file = Buffer.from(`GH_TOKEN=${TOKEN}\nother=1\n`).toString('base64');
    const { fetch } = github({
      json: { body: `leaked ${TOKEN} here`, files: [{ encoding: 'base64', content: file }] },
    });
    const out = await handleGhRead({ server: 'dev2', path: 'repos/acme/app/issues/1' }, fetch);
    expect(out.content[0].text).not.toContain(TOKEN);
    const answer = text(out);
    expect(answer.body.body).toBe('leaked [redacted] here');
    const decoded = Buffer.from(answer.body.files[0].content, 'base64').toString('utf8');
    expect(decoded).toBe('GH_TOKEN=[redacted]\nother=1\n');
    expect(decoded).not.toContain(TOKEN);

    const refused = github({ status: 422, json: { message: `bad ${TOKEN}` } });
    const err = await handleGhRead({ server: 'dev2', path: 'repos/acme/app/issues/1' }, refused.fetch).catch(
      (e: Error) => e,
    );
    expect(String(err)).toMatch(/answered 422/);
    expect(String(err)).not.toContain(TOKEN);
  });

  it("says GitHub's status and message on a refusal, and cuts a long answer", async () => {
    const refused = github({ status: 404, json: { message: 'Not Found' } });
    await expect(handleGhRead({ server: 'dev2', path: 'repos/acme/app/pulls/9' }, refused.fetch)).rejects.toThrow(
      /answered 404: Not Found/,
    );
    const big = github({ json: { body: 'x'.repeat(300_000) } });
    const out = text(await handleGhRead({ server: 'dev2', path: 'repos/acme/app/pulls/9' }, big.fetch));
    expect(out.truncated).toBe(true);
    expect(typeof out.body).toBe('string');
    expect(out.body.length).toBeLessThanOrEqual(200_000);
  });
});

// review-of-legends R5 (e2628bcae): a redirect is never followed, a ref may hold `/`, and `fields` keeps only what a
// read needs so a compare's file diffs never push the commits past the output cap.
describe('gh_read — redirects, slash refs, fields', () => {
  it('never follows a redirect: GitHub may move an issue to a repository the environment does not list', async () => {
    const inits: { redirect?: string }[] = [];
    const moved: Fetch = async (_url, init) => {
      inits.push(init as { redirect?: string });
      return { ok: false, status: 301, json: async () => ({ message: 'Moved Permanently' }) };
    };
    await expect(handleGhRead({ server: 'dev2', path: 'repos/acme/app/issues/7' }, moved)).rejects.toThrow(
      /answered 301 .*not followed/,
    );
    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe('manual');
  });

  it('reads refs that hold `/`: a compare and a branch of deploy/dev2, and still refuses the protection settings', async () => {
    const { fetch, calls } = github();
    for (const p of [
      'repos/acme/app/compare/develop...deploy/dev2',
      'repos/acme/app/compare/deploy/dev2...release/2026-11',
      'repos/acme/app/branches/deploy/dev2',
      'repos/acme/app/commits/deploy/dev2',
      'repos/acme/app/releases/tags/v1/rc',
    ]) {
      await handleGhRead({ server: 'dev2', path: p }, fetch);
    }
    expect(calls.map((c) => c.url.replace('https://api.github.com/', ''))).toEqual([
      'repos/acme/app/compare/develop...deploy/dev2',
      'repos/acme/app/compare/deploy/dev2...release/2026-11',
      'repos/acme/app/branches/deploy/dev2',
      'repos/acme/app/commits/deploy/dev2',
      'repos/acme/app/releases/tags/v1/rc',
    ]);
    const refuse = (p: string) => handleGhRead({ server: 'dev2', path: p }, fetch);
    await expect(refuse('repos/acme/app/branches/deploy/dev2/protection')).rejects.toThrow(/not a part gh_read reads/);
    // trinity R5 (fable): GitHub routes `protection` in any case.
    await expect(refuse('repos/acme/app/branches/main/Protection')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/branches/main/PROTECTION/required_status_checks')).rejects.toThrow(
      /not a part gh_read reads/,
    );
    await expect(refuse('repos/acme/app/branches/main%2FpRoTeCtIoN')).rejects.toThrow(/not a part gh_read reads/);
    await expect(refuse('repos/acme/app/compare/develop...other:deploy/dev2')).rejects.toThrow(/another repository/);
    await expect(refuse('repos/acme/app/compare/develop/../../../user')).rejects.toThrow(/path/);
    expect(calls).toHaveLength(5);
  });

  it('keeps only the named fields, before the output cap: a compare whose file diffs alone pass it', async () => {
    const commits = Array.from({ length: 3 }, (_, i) => ({
      sha: `s${i}`,
      parents: [{ sha: `p${i}` }],
      commit: { message: `m${i}`, author: { name: 'a' } },
    }));
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, patch: 'x'.repeat(2_000) }));
    const { fetch } = github({ json: { status: 'ahead', total_commits: 3, commits, files } });
    const whole = text(await handleGhRead({ server: 'dev2', path: 'repos/acme/app/compare/a...b' }, fetch));
    expect(whole.truncated).toBe(true);
    const out = text(
      await handleGhRead(
        {
          server: 'dev2',
          path: 'repos/acme/app/compare/a...b',
          fields: ['status', 'total_commits', 'commits[].sha', 'commits[].parents[].sha'],
        },
        fetch,
      ),
    );
    expect(out.truncated).toBe(false);
    expect(out.body).toEqual({
      status: 'ahead',
      total_commits: 3,
      commits: commits.map((c) => ({ sha: c.sha, parents: [{ sha: c.parents[0].sha }] })),
    });
  });

  it('projects a list answer with a leading [], keeps a whole value when a shorter path names it, and skips what is absent', async () => {
    const { fetch } = github({
      json: [
        { number: 1, title: 't1', head: { ref: 'a', sha: 'x' }, base: { ref: 'develop' } },
        { number: 2, title: 't2', head: { ref: 'b', sha: 'y' } },
      ],
    });
    const out = text(
      await handleGhRead(
        {
          server: 'dev2',
          path: 'repos/acme/app/pulls',
          fields: ['[].number', '[].head', '[].head.ref', '[].base.ref'],
        },
        fetch,
      ),
    );
    expect(out.body).toEqual([
      { number: 1, head: { ref: 'a', sha: 'x' }, base: { ref: 'develop' } },
      { number: 2, head: { ref: 'b', sha: 'y' } },
    ]);
  });

  it('scrubs the token before it projects: a base64 file named alone by fields is still scrubbed', async () => {
    const file = Buffer.from(`GH_TOKEN=${TOKEN}\n`).toString('base64');
    const { fetch } = github({ json: { encoding: 'base64', content: file, sha: 'z' } });
    const out = await handleGhRead(
      { server: 'dev2', path: 'repos/acme/app/contents/.env.example', fields: ['content'] },
      fetch,
    );
    expect(out.content[0].text).not.toContain(TOKEN);
    expect(Buffer.from(text(out).body.content, 'base64').toString('utf8')).toBe('GH_TOKEN=[redacted]\n');
  });

  it('refuses fields that are not a list of dotted names, before any request', async () => {
    const { fetch, calls } = github();
    const bad = (fields: unknown) => handleGhRead({ server: 'dev2', path: 'repos/acme/app/pulls', fields }, fetch);
    await expect(bad('sha')).rejects.toThrow(/fields/);
    await expect(bad([])).rejects.toThrow(/fields/);
    await expect(bad(['a..b'])).rejects.toThrow(/fields/);
    await expect(bad(['.sha'])).rejects.toThrow(/fields/);
    await expect(bad(['a[0]'])).rejects.toThrow(/fields/);
    await expect(bad([{ a: 1 }])).rejects.toThrow(/fields/);
    await expect(bad(Array.from({ length: 41 }, (_, i) => `f${i}`))).rejects.toThrow(/fields/);
    expect(calls).toEqual([]);
  });

  // review-of-legends R5 (tests): the handler's failure contract when GitHub gives no usable answer.
  it('fails with no answer on a transport error and on a 200 whose body cannot be read, never with a body or the token', async () => {
    const down: Fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(handleGhRead({ server: 'dev2', path: 'repos/acme/app/pulls/1' }, down)).rejects.toThrow(
      /GitHub GET \/repos\/acme\/app\/pulls\/1 got no answer \(TypeError\)/,
    );
    const garbled: Fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    await expect(handleGhRead({ server: 'dev2', path: 'repos/acme/app/pulls/1' }, garbled)).rejects.toThrow(
      /answered 200 with an unreadable body/,
    );
  });
});
