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
