/**
 * env-access WU3b (#1211): server-tools `login` — log in to an environment's web app with the environment's own
 * account (its password in the secret store), outside every model sandbox, and hand back only the session.
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

import type { LoginFetch } from './env-login.js';
import { handleLogin, loadConfig, resetConfigCache } from './server-tools-mcp-server.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-login-'));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SECRETS = path.join(ROOT, 'secrets');
const AUDIT = path.join(ROOT, 'data', 'env-audit');
const PASSWORD = 'pw-from-store-9f2';
const saved = { ...process.env };

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function writeConfig(logins: Record<string, unknown>) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      'server-tools': {
        dev2: { envUser: 'env:acme-dev2', ssh: { host: 'dev2' }, web: { logins } },
        noweb: { ssh: { host: 'x' } },
      },
    }),
  );
  resetConfigCache();
  loadConfig();
}

beforeEach(() => {
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(SECRETS, 'dev2-player'), `${PASSWORD}\n`, { mode: 0o600 });
  process.env.SOMA_CONFIG_FILE = CONFIG_FILE;
  process.env.SOMA_SECRETS_DIR = SECRETS;
  process.env.SOMA_AUDIT_DIR = AUDIT;
  process.env.SOMA_REQUESTER = 'U123';
  writeConfig({
    player: {
      url: 'https://app.example.test/api/login',
      body: { username: 'qa-player', password: { $secret: 'dev2-player' } },
      token: 'json:data.accessToken',
    },
    admin: {
      url: 'https://bo.example.test/login',
      body: { id: 'qa-admin', pw: { $secret: 'dev2-player' } },
      token: 'cookie:SESSION',
    },
    plain: { url: 'http://app.example.test/login', body: {}, token: 'json:token' },
  });
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
});

function web(answer: { status?: number; json?: unknown; setCookie?: string[] } = {}) {
  const calls: { url: string; method: string; body?: string; contentType?: string }[] = [];
  const fetch: LoginFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, contentType: init.headers['Content-Type'] });
    const status = answer.status ?? 200;
    return {
      status,
      json: async () => answer.json ?? {},
      setCookies: () => answer.setCookie ?? [],
    };
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

describe('login', () => {
  it('posts the account from the secret store and returns only the session token from the JSON answer', async () => {
    const { fetch, calls } = web({ json: { data: { accessToken: 'tok-abc', expiresIn: 3600 } } });
    const out = await handleLogin({ server: 'dev2', account: 'player' }, fetch);
    const result = JSON.parse(out.content[0].text);
    expect(result).toEqual({ server: 'dev2', account: 'player', kind: 'bearer', token: 'tok-abc' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://app.example.test/api/login', method: 'POST' });
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ username: 'qa-player', password: PASSWORD });
    expect(out.content[0].text).not.toContain(PASSWORD);
    expect(ledger().map((r) => [r.phase, r.tool, r.action, r.requester, r.detail.account])).toEqual([
      ['intent', 'login', 'login', 'U123', 'player'],
      ['done', 'login', 'login', 'U123', 'player'],
    ]);
    expect(JSON.stringify(ledger())).not.toContain('tok-abc');
    expect(JSON.stringify(ledger())).not.toContain(PASSWORD);
  });

  it('takes the session from a cookie when the account says so', async () => {
    const { fetch } = web({ setCookie: ['OTHER=1; Path=/', 'SESSION=s3ss; Path=/; HttpOnly; Max-Age=600'] });
    const result = JSON.parse((await handleLogin({ server: 'dev2', account: 'admin' }, fetch)).content[0].text);
    expect(result).toEqual({ server: 'dev2', account: 'admin', kind: 'cookie', cookie: 'SESSION', token: 's3ss' });
  });

  it('posts a form when the account says so, and takes the cookie of a redirect that follows a form login', async () => {
    writeConfig({
      bo: {
        url: 'https://bo.example.test/login',
        format: 'form',
        body: { id: 'qa admin', pw: { $secret: 'dev2-player' }, remember: true },
        token: 'cookie:SESSION',
      },
    });
    const calls: { body?: string; contentType?: string }[] = [];
    const fetch: LoginFetch = async (_url, init) => {
      calls.push({ body: init.body, contentType: init.headers['Content-Type'] });
      return { status: 302, json: async () => ({}), setCookies: () => ['SESSION=f0rm; Path=/'] };
    };
    const result = JSON.parse((await handleLogin({ server: 'dev2', account: 'bo' }, fetch)).content[0].text);
    expect(result).toMatchObject({ kind: 'cookie', cookie: 'SESSION', token: 'f0rm' });
    expect(calls[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(calls[0].body ?? ''))).toEqual({
      id: 'qa admin',
      pw: PASSWORD,
      remember: 'true',
    });
  });

  it('refuses a redirect for a JSON token, a form value that is not a plain value, and an unknown format', async () => {
    const { fetch } = web({ status: 302, json: { data: { accessToken: 'tok' } } });
    await expect(handleLogin({ server: 'dev2', account: 'player' }, fetch)).rejects.toThrow(/answered 302/);
    writeConfig({
      nested: { url: 'https://bo.example.test/login', format: 'form', body: { a: { b: 1 } }, token: 'cookie:S' },
      odd: { url: 'https://bo.example.test/login', format: 'xml', body: {}, token: 'cookie:S' },
    });
    await expect(handleLogin({ server: 'dev2', account: 'nested' }, fetch)).rejects.toThrow(/form value a/);
    await expect(handleLogin({ server: 'dev2', account: 'odd' }, fetch)).rejects.toThrow(/format must be json or form/);
  });

  it('never shows the password: a refused login says only its status', async () => {
    const { fetch } = web({ status: 401, json: { message: `bad password ${PASSWORD}` } });
    const err = await handleLogin({ server: 'dev2', account: 'player' }, fetch).catch((e: Error) => e);
    expect(String(err)).toMatch(/answered 401/);
    expect(String(err)).not.toContain(PASSWORD);
    expect(ledger().map((r) => r.phase)).toEqual(['intent', 'failed']);
  });

  it('refuses an answer without the token where the account says it is', async () => {
    const { fetch } = web({ json: { data: {} } });
    await expect(handleLogin({ server: 'dev2', account: 'player' }, fetch)).rejects.toThrow(/no session token/);
  });

  it('refuses plain http, an unknown account, a server without logins, and a session with no requester', async () => {
    const { fetch, calls } = web();
    await expect(handleLogin({ server: 'dev2', account: 'plain' }, fetch)).rejects.toThrow(/https/);
    await expect(handleLogin({ server: 'dev2', account: 'nobody' }, fetch)).rejects.toThrow(/no login named nobody/);
    await expect(handleLogin({ server: 'noweb', account: 'player' }, fetch)).rejects.toThrow(/no web logins/);
    delete process.env.SOMA_REQUESTER;
    await expect(handleLogin({ server: 'dev2', account: 'player' }, fetch)).rejects.toThrow(/no requester/);
    expect(calls).toEqual([]);
  });
});
