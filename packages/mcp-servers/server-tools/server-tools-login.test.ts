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
    plain: { url: 'http://app.example.test/login', body: { pw: { $secret: 'dev2-player' } }, token: 'json:token' },
  });
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
});

function web(
  answer: { status?: number; json?: unknown; setCookie?: string[]; location?: string; during?: () => void } = {},
) {
  const calls: { url: string; method: string; body?: string; contentType?: string }[] = [];
  const fetch: LoginFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, contentType: init.headers['Content-Type'] });
    answer.during?.();
    const status = answer.status ?? 200;
    return {
      status,
      json: async () => answer.json ?? {},
      setCookies: () => answer.setCookie ?? [],
      location: () => answer.location ?? null,
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

  it('posts a form when the account says so, and takes the cookie of the redirect a successful form login answers', async () => {
    writeConfig({
      bo: {
        url: 'https://bo.example.test/login',
        format: 'form',
        body: { id: 'qa admin', pw: { $secret: 'dev2-player' }, remember: true },
        token: 'cookie:SESSION',
        successRedirect: '/home',
      },
    });
    const { fetch, calls } = web({ status: 302, setCookie: ['SESSION=f0rm; Path=/'], location: '/home/dashboard' });
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
      nested: {
        url: 'https://bo.example.test/login',
        format: 'form',
        body: { a: { b: 1 }, pw: { $secret: 'dev2-player' } },
        token: 'cookie:S',
      },
      odd: {
        url: 'https://bo.example.test/login',
        format: 'xml',
        body: { pw: { $secret: 'dev2-player' } },
        token: 'cookie:S',
      },
    });
    await expect(handleLogin({ server: 'dev2', account: 'nested' }, fetch)).rejects.toThrow(/form value a/);
    await expect(handleLogin({ server: 'dev2', account: 'odd' }, fetch)).rejects.toThrow(/format must be json or form/);
  });

  // trinity R1 (fable, astra): a refused form login can redirect back with an anonymous or deleted cookie.
  it('takes a redirect only to where the account says a successful login goes', async () => {
    const base = {
      url: 'https://bo.example.test/login',
      body: { pw: { $secret: 'dev2-player' } },
      token: 'cookie:SESSION',
    };
    writeConfig({ bo: { ...base, successRedirect: '/home' }, nogoal: base });
    const cookie = ['SESSION=anon; Path=/'];
    const refused = (account: string, location: string | undefined) =>
      handleLogin({ server: 'dev2', account }, web({ status: 302, setCookie: cookie, location }).fetch);
    await expect(refused('bo', '/login?error=1')).rejects.toThrow(/did not redirect to successRedirect/);
    await expect(refused('bo', 'https://elsewhere.example.test/home')).rejects.toThrow(/redirected to another host/);
    await expect(refused('bo', undefined)).rejects.toThrow(/redirected without a location/);
    await expect(refused('nogoal', '/home')).rejects.toThrow(/answered 302; set successRedirect/);
    expect(ledger().filter((r) => r.phase === 'done')).toEqual([]);
  });

  // trinity R2 (grok): `/` is the root page only, the login page never counts, and the location never shows.
  it('takes `/` as the root page only, never the login page under the goal, and never repeats the location', async () => {
    const cookie = ['SESSION=anon; Path=/'];
    writeConfig({
      root: {
        url: 'https://bo.example.test/login',
        body: { pw: { $secret: 'dev2-player' } },
        token: 'cookie:SESSION',
        successRedirect: '/',
      },
      app: {
        url: 'https://bo.example.test/app/login',
        body: { pw: { $secret: 'dev2-player' } },
        token: 'cookie:SESSION',
        successRedirect: '/app',
      },
    });
    const go = (account: string, location: string) =>
      handleLogin({ server: 'dev2', account }, web({ status: 302, setCookie: cookie, location }).fetch);
    await expect(go('root', '/login')).rejects.toThrow(/did not redirect to successRedirect/);
    await expect(go('app', '/app/login?error=1')).rejects.toThrow(/did not redirect to successRedirect/);
    const leak = await go('root', `/login/${PASSWORD}`).catch((e: Error) => e);
    expect(String(leak)).not.toContain(PASSWORD);
    expect(JSON.stringify(ledger())).not.toContain(PASSWORD);
    expect(JSON.parse((await go('root', '/')).content[0].text).token).toBe('anon');
    expect(JSON.parse((await go('app', '/app/home')).content[0].text).token).toBe('anon');
  });

  it('never hands out a cookie the answer deletes, and takes the last one it sets', async () => {
    const ask = (setCookie: string[]) => handleLogin({ server: 'dev2', account: 'admin' }, web({ setCookie }).fetch);
    await expect(ask(['SESSION=deleted; Path=/; Max-Age=0'])).rejects.toThrow(/no session token/);
    await expect(ask(['SESSION=old; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])).rejects.toThrow(/no session token/);
    await expect(ask(['SESSION=fresh; Path=/', 'SESSION=; Max-Age=0'])).rejects.toThrow(/no session token/);
    const out = await ask(['SESSION=deleted; Max-Age=0', 'SESSION=fresh; Path=/; Max-Age=600']);
    expect(JSON.parse(out.content[0].text).token).toBe('fresh');
  });

  // trinity R3 (fable): residuals — an array of logins, a 2xx where a redirect is expected, a login page at `/`.
  it('drops an array of logins, refuses a 2xx where a redirect is expected, and allows a login page at /', async () => {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': {
          dev2: {
            envUser: 'env:acme-dev2',
            web: { logins: [{ url: 'https://bo.example.test/login', body: { pw: 'hunter2' }, token: 'cookie:S' }] },
          },
        },
      }),
    );
    resetConfigCache();
    loadConfig();
    const none = web({ setCookie: ['S=1'] });
    await expect(handleLogin({ server: 'dev2', account: '0' }, none.fetch)).rejects.toThrow(
      /no (web logins|login named 0)/,
    );
    expect(none.calls).toEqual([]);

    writeConfig({
      bo: {
        url: 'https://bo.example.test/login',
        body: { pw: { $secret: 'dev2-player' } },
        token: 'cookie:S',
        successRedirect: '/home',
      },
      rootLogin: {
        url: 'https://bo.example.test/',
        body: { pw: { $secret: 'dev2-player' } },
        token: 'cookie:S',
        successRedirect: '/',
      },
    });
    await expect(handleLogin({ server: 'dev2', account: 'bo' }, web({ setCookie: ['S=anon'] }).fetch)).rejects.toThrow(
      /answered 200, not the redirect successRedirect expects/,
    );
    const ok = web({ status: 303, setCookie: ['S=live'], location: '/' });
    expect(
      JSON.parse((await handleLogin({ server: 'dev2', account: 'rootLogin' }, ok.fetch)).content[0].text).token,
    ).toBe('live');
  });

  // trinity R3 (astra): Max-Age wins over Expires; a secret nested in a JSON body counts.
  it('takes Max-Age over Expires, and keeps a login whose secret is nested in its JSON body', async () => {
    const live = web({ setCookie: ['SESSION=fresh; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT'] });
    expect(
      JSON.parse((await handleLogin({ server: 'dev2', account: 'admin' }, live.fetch)).content[0].text).token,
    ).toBe('fresh');
    const gone = web({ setCookie: ['SESSION=x; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT'] });
    await expect(handleLogin({ server: 'dev2', account: 'admin' }, gone.fetch)).rejects.toThrow(/no session token/);

    writeConfig({
      nested: {
        url: 'https://app.example.test/api/login',
        body: { credentials: { username: 'qa', password: { $secret: 'dev2-player' } } },
        token: 'json:token',
      },
    });
    const { fetch, calls } = web({ json: { token: 't-1' } });
    expect(JSON.parse((await handleLogin({ server: 'dev2', account: 'nested' }, fetch)).content[0].text).token).toBe(
      't-1',
    );
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ credentials: { username: 'qa', password: PASSWORD } });
  });

  // review-of-legends (3330a7a11): an unread body is released; a cookie login accepts a page.
  it('releases a body it does not read, and asks a cookie login for a page as well as JSON', async () => {
    const seen: { accept?: string }[] = [];
    let discarded = 0;
    const fetch: LoginFetch = async (_url, init) => {
      seen.push({ accept: init.headers.Accept });
      return {
        status: 200,
        json: async () => ({}),
        setCookies: () => ['SESSION=s1'],
        location: () => null,
        discard: () => {
          discarded++;
        },
      };
    };
    await handleLogin({ server: 'dev2', account: 'admin' }, fetch);
    expect(discarded).toBe(1);
    expect(seen[0].accept).toMatch(/^text\/html/);
    const refused: LoginFetch = async () => ({
      status: 401,
      json: async () => ({}),
      setCookies: () => [],
      location: () => null,
      discard: () => {
        discarded++;
      },
    });
    await expect(handleLogin({ server: 'dev2', account: 'player' }, refused)).rejects.toThrow(/answered 401/);
    expect(discarded).toBe(2);
    const read: LoginFetch = async (_url, init) => {
      seen.push({ accept: init.headers.Accept });
      return {
        status: 200,
        json: async () => ({ data: { accessToken: 't' } }),
        setCookies: () => [],
        location: () => null,
        discard: () => {
          discarded++;
        },
      };
    };
    await handleLogin({ server: 'dev2', account: 'player' }, read);
    expect(discarded).toBe(2);
    expect(seen[1].accept).toBe('application/json');
  });

  it('leaves out a login whose body names no secret: a password in config.json is not used', async () => {
    writeConfig({
      inline: { url: 'https://bo.example.test/login', body: { id: 'qa', pw: 'hunter2' }, token: 'cookie:S' },
    });
    const { fetch, calls } = web({ setCookie: ['S=1'] });
    await expect(handleLogin({ server: 'dev2', account: 'inline' }, fetch)).rejects.toThrow(/no login named inline/);
    expect(calls).toEqual([]);
  });

  // trinity R1 (fable): the ledger ordering, pinned.
  it('posts nothing when the intent cannot be written, and withholds the session when done cannot be', async () => {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.writeFileSync(AUDIT, 'not a directory');
    const first = web({ json: { data: { accessToken: 'tok-1' } } });
    await expect(handleLogin({ server: 'dev2', account: 'player' }, first.fetch)).rejects.toThrow(/not logged in/);
    expect(first.calls).toEqual([]);
    fs.rmSync(AUDIT, { force: true });

    const second = web({
      json: { data: { accessToken: 'tok-2' } },
      during: () => {
        fs.rmSync(AUDIT, { recursive: true, force: true });
        fs.writeFileSync(AUDIT, 'not a directory');
      },
    });
    const err = await handleLogin({ server: 'dev2', account: 'player' }, second.fetch).catch((e: Error) => e);
    expect(String(err)).toMatch(/the session was not handed out/);
    expect(String(err)).not.toContain('tok-2');
    expect(second.calls).toHaveLength(1);
    fs.rmSync(AUDIT, { force: true });
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
