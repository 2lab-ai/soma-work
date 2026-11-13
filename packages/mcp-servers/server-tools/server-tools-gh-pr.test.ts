/**
 * env-access WU3 (#1211): server-tools `gh_pr` — an environment user's PR actions with the environment's own token,
 * read from the secret store, under the environment's conditions, audited.
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
import { handleGhPr, loadConfig, resetConfigCache } from './server-tools-mcp-server.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-gh-pr-'));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SECRETS = path.join(ROOT, 'secrets');
const AUDIT = path.join(ROOT, 'data', 'env-audit');
const SHA = 'a'.repeat(40);
const saved = { ...process.env };

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(SECRETS, 'gh-org-admin'), 'tok-from-store\n', { mode: 0o600 });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      'server-tools': {
        dev2: {
          envUser: 'env:acme-dev2',
          ssh: { host: 'dev2' },
          github: {
            token: { $secret: 'gh-org-admin' },
            repos: ['acme/app'],
            approveWhen: { authors: ['soma-bot[bot]'], bases: ['develop'], requiredChecksGreen: true },
            mergeWhen: { authors: ['soma-bot[bot]'], bases: ['develop'] },
            requiredChecks: ['ci'],
          },
        },
        nogh: { ssh: { host: 'x' } },
        // trinity R1 (fable): a token written into config.json is not used.
        plain: { ssh: { host: 'y' }, github: { token: 'tok-in-config', repos: ['acme/app'] } },
      },
    }),
  );
  process.env.SOMA_CONFIG_FILE = CONFIG_FILE;
  process.env.SOMA_SECRETS_DIR = SECRETS;
  process.env.SOMA_AUDIT_DIR = AUDIT;
  process.env.SOMA_REQUESTER = 'U123';
  resetConfigCache();
  loadConfig();
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
});

function github(prOver: Record<string, unknown> = {}, failWrite = false, onWrite?: () => void) {
  const calls: { method: string; url: string; auth: string; body?: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ method: init.method, url, auth: init.headers.Authorization, body: init.body });
    const p = url.replace('https://api.github.com', '');
    const json = (v: unknown, status = 200) => ({ ok: status < 400, status, json: async () => v });
    if (init.method === 'GET' && p === '/repos/acme/app/pulls/7') {
      return json({
        title: 'T',
        state: 'open',
        draft: false,
        user: { login: 'soma-bot[bot]' },
        base: { ref: 'develop' },
        head: { sha: SHA },
        ...prOver,
      });
    }
    if (p.includes('/check-runs'))
      return json({ total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
    if (p.includes('/status?')) return json({ state: 'pending', total_count: 0, statuses: [] });
    if (init.method === 'POST' || init.method === 'PUT') {
      onWrite?.();
      return failWrite ? json({ message: 'Review cannot be requested' }, 422) : json({ id: 11, sha: 'c'.repeat(40) });
    }
    return json({ message: 'nope' }, 404);
  };
  return { fetch, calls };
}

const ledger = () =>
  fs.existsSync(path.join(AUDIT, 'env-audit.jsonl'))
    ? fs
        .readFileSync(path.join(AUDIT, 'env-audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];

describe('gh_pr', () => {
  it('views a PR with the token from the secret store, and audits nothing', async () => {
    const { fetch, calls } = github();
    const out = await handleGhPr({ server: 'dev2', action: 'view', repo: 'acme/app', pr: 7 }, fetch);
    expect(JSON.parse(out.content[0].text)).toMatchObject({
      headSha: SHA,
      author: 'soma-bot[bot]',
      checks: { green: true },
    });
    expect(calls.every((c) => c.auth === 'Bearer tok-from-store')).toBe(true);
    expect(ledger()).toEqual([]);
  });

  it('approves under the conditions, pinned to the SHA, with intent and done in the ledger', async () => {
    const { fetch, calls } = github();
    const out = await handleGhPr({ server: 'dev2', action: 'approve', repo: 'acme/app', pr: 7, sha: SHA }, fetch);
    expect(out.content[0].text).toBe(`approved acme/app#7 at ${SHA}`);
    const review = calls.find((c) => c.method === 'POST');
    expect(JSON.parse(review?.body ?? '{}')).toMatchObject({ event: 'APPROVE', commit_id: SHA });
    expect(ledger().map((r) => [r.phase, r.envUser, r.requester, r.action, r.detail.pr])).toEqual([
      ['intent', 'env:acme-dev2', 'U123', 'approve', 7],
      ['done', 'env:acme-dev2', 'U123', 'approve', 7],
    ]);
  });

  it('refuses, writes nothing and calls no write API when a condition fails', async () => {
    const { fetch, calls } = github({ user: { login: 'someone' } });
    await expect(
      handleGhPr({ server: 'dev2', action: 'approve', repo: 'acme/app', pr: 7, sha: SHA }, fetch),
    ).rejects.toThrow(/not approved: author someone/);
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    expect(ledger()).toEqual([]);
  });

  it('refuses the write when the ledger cannot be written', async () => {
    delete process.env.SOMA_AUDIT_DIR;
    const { fetch, calls } = github();
    await expect(
      handleGhPr({ server: 'dev2', action: 'merge', repo: 'acme/app', pr: 7, sha: SHA }, fetch),
    ).rejects.toThrow(/audit ledger is not configured/);
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('records a failed write, and never shows the token', async () => {
    const { fetch } = github({}, true);
    const err = await handleGhPr({ server: 'dev2', action: 'merge', repo: 'acme/app', pr: 7, sha: SHA }, fetch).catch(
      (e: Error) => e,
    );
    expect(String(err)).toMatch(/answered 422/);
    expect(String(err)).not.toContain('tok-from-store');
    expect(ledger().map((r) => r.phase)).toEqual(['intent', 'failed']);
  });

  // review-of-legends R6 (tests): a redirect answer to an approve or a merge is not followed and is a failed write.
  it('does not follow a redirect on an approve or a merge, and records the write failed', async () => {
    for (const action of ['approve', 'merge'] as const) {
      fs.rmSync(path.join(AUDIT, 'env-audit.jsonl'), { force: true });
      const inits: { method: string; redirect?: string }[] = [];
      const base = github();
      const fetch: Fetch = async (url, init) => {
        inits.push({ method: init.method, redirect: (init as { redirect?: string }).redirect });
        if (init.method === 'POST' || init.method === 'PUT') {
          return { ok: false, status: 307, json: async () => ({ message: 'Temporary Redirect' }) };
        }
        return base.fetch(url, init);
      };
      const err = await handleGhPr({ server: 'dev2', action, repo: 'acme/app', pr: 7, sha: SHA }, fetch).catch(
        (e: Error) => e,
      );
      expect(String(err)).toMatch(/answered 307 \(moved\): not followed/);
      expect(inits.every((i) => i.redirect === 'manual')).toBe(true);
      expect(inits.filter((i) => i.method !== 'GET')).toHaveLength(1);
      expect(ledger().map((r) => r.phase)).toEqual(['intent', 'failed']);
    }
  });

  // trinity R2 (fable): a write whose outcome cannot be known is recorded as unknown, not as failed.
  it('records an unknown outcome when the connection drops and the PR cannot be read again', async () => {
    let reads = 0;
    const fetch: Fetch = async (url, init) => {
      const p = url.replace('https://api.github.com', '');
      const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
      if (init.method === 'PUT') throw new TypeError('fetch failed');
      if (p === '/repos/acme/app/pulls/7') {
        if (++reads > 2) throw new TypeError('fetch failed');
        return json({
          state: 'open',
          draft: false,
          user: { login: 'soma-bot[bot]' },
          base: { ref: 'develop' },
          head: { sha: SHA },
        });
      }
      if (p.includes('/check-runs'))
        return json({ total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
      return json({ state: 'pending', total_count: 0, statuses: [] });
    };
    await expect(
      handleGhPr({ server: 'dev2', action: 'merge', repo: 'acme/app', pr: 7, sha: SHA }, fetch),
    ).rejects.toThrow(/outcome is unknown.*check/);
    expect(ledger().map((r) => r.phase)).toEqual(['intent', 'unknown']);
  });

  it('refuses a requiredChecks that is not a list', async () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg['server-tools'].dev2.github.requiredChecks = 'ci';
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
    resetConfigCache();
    const { fetch } = github();
    await expect(handleGhPr({ server: 'dev2', action: 'view', repo: 'acme/app', pr: 7 }, fetch)).rejects.toThrow(
      /must be lists/,
    );
  });

  it('refuses conditions that are not lists', async () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg['server-tools'].dev2.github.approveWhen.authors = 'soma-bot[bot]';
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
    resetConfigCache();
    const { fetch, calls } = github();
    await expect(
      handleGhPr({ server: 'dev2', action: 'approve', repo: 'acme/app', pr: 7, sha: SHA }, fetch),
    ).rejects.toThrow(/approveWhen.authors must be a list/);
    expect(calls).toEqual([]);
  });

  // trinity R1 (fable): every write names the person it was made for.
  it('refuses a write when the session has no requester', async () => {
    delete process.env.SOMA_REQUESTER;
    const { fetch, calls } = github();
    await expect(
      handleGhPr({ server: 'dev2', action: 'approve', repo: 'acme/app', pr: 7, sha: SHA }, fetch),
    ).rejects.toThrow(/no requester/);
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    expect(ledger()).toEqual([]);
  });

  // trinity R1 (fable, astra): a write made on GitHub whose outcome the ledger could not take is reported as made.
  it('says the merge was made when only the outcome could not be recorded', async () => {
    const file = path.join(AUDIT, 'env-audit.jsonl');
    const { fetch } = github({}, false, () => {
      fs.rmSync(file);
      fs.symlinkSync(path.join(ROOT, 'elsewhere'), file);
    });
    await expect(
      handleGhPr({ server: 'dev2', action: 'merge', repo: 'acme/app', pr: 7, sha: SHA }, fetch),
    ).rejects.toThrow(/merged acme\/app#7 .*but the audit ledger could not record it.*do not retry/i);
  });

  it('refuses a repository the environment does not list, and a server without github', async () => {
    const { fetch } = github();
    await expect(handleGhPr({ server: 'dev2', action: 'view', repo: 'acme/other', pr: 7 }, fetch)).rejects.toThrow(
      /not one of this environment's repositories/,
    );
    await expect(handleGhPr({ server: 'nogh', action: 'view', repo: 'acme/app', pr: 7 }, fetch)).rejects.toThrow(
      /no github section/,
    );
    await expect(handleGhPr({ server: 'plain', action: 'view', repo: 'acme/app', pr: 7 }, fetch)).rejects.toThrow(
      /no github section/,
    );
  });
});
