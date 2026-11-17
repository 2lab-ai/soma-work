/**
 * cf_api on several Cloudflare accounts per environment (`cloudflare.accounts`), each with its own token, and
 * `reach: "account"`: everything the account's token can do on that account — its `/accounts/<id>/…` paths, its
 * zones (proven to be its own), every zone part, multipart uploads (a Worker) and answers that are not JSON — except
 * the paths that would hand a model a credential to use outside server-tools (tokens, members, service tokens, …).
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

import type { CfFetch } from './env-cloudflare.js';
import { handleCfApi, handleList, loadConfig, resetConfigCache } from './server-tools-mcp-server.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-cf-accounts-'));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SECRETS = path.join(ROOT, 'secrets');
const AUDIT = path.join(ROOT, 'data', 'env-audit');
const DEV_TOKEN = 'cf-dev-account-token-41';
const HQ_TOKEN = 'cf-hq-account-token-77';
const DEV = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HQ = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LISTED_ZONE = '0123456789abcdef0123456789abcdef';
const DEV_ZONE = '11111111111111111111111111111111';
const HQ_ZONE = '22222222222222222222222222222222';
const API = 'https://api.cloudflare.com/client/v4';
const saved = { ...process.env };

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const accounts = (extra: Record<string, unknown> = {}) => ({
  accounts: {
    'iq-dev': {
      token: { $secret: 'cf-dev' },
      id: DEV,
      reach: 'account',
      write: true,
      zones: { 'dev.example': LISTED_ZONE },
    },
    'iq-hq': { token: { $secret: 'cf-hq' }, id: HQ, reach: 'account' },
    ...extra,
  },
});

function writeConfig(cloudflare: Record<string, unknown>, more: Record<string, unknown> = {}) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      'server-tools': {
        dev2: {
          envUser: 'env:acme-dev2',
          ssh: { host: 'dev2' },
          databases: { app: { type: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p' } },
          github: { token: { $secret: 'gh' }, repos: ['acme/app'] },
          web: { logins: { qa: { url: 'https://x.example/login', body: { pw: { $secret: 'gh' } } } } },
          cloudflare,
        },
        ...more,
      },
    }),
  );
  resetConfigCache();
  loadConfig();
}

beforeEach(() => {
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(SECRETS, 'cf-dev'), `${DEV_TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(SECRETS, 'cf-hq'), `${HQ_TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(SECRETS, 'gh'), 'gh-token\n', { mode: 0o600 });
  process.env.SOMA_CONFIG_FILE = CONFIG_FILE;
  process.env.SOMA_SECRETS_DIR = SECRETS;
  process.env.SOMA_AUDIT_DIR = AUDIT;
  process.env.SOMA_REQUESTER = 'U123';
  writeConfig(accounts());
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
});

interface Call {
  url: string;
  method: string;
  auth?: string;
  contentType?: string;
  body?: unknown;
}

/** Like a native fetch body, an answer can be read once: a second read throws. */
function once<T extends { json(): Promise<unknown>; text(): Promise<string> }>(res: T): T {
  let used = false;
  const guard =
    <R>(read: () => Promise<R>) =>
    async () => {
      if (used) throw new TypeError('Body is unusable: Body has already been read');
      used = true;
      return read();
    };
  return { ...res, json: guard(res.json), text: guard(res.text) };
}

/** A Cloudflare double: a zone answers with its account; anything else with `answer`. */
function cloudflare(
  answer: { status?: number; json?: unknown; text?: string } = {},
  zoneAccounts: Record<string, string> = { [DEV_ZONE]: DEV, [HQ_ZONE]: HQ, [LISTED_ZONE]: DEV },
) {
  const calls: Call[] = [];
  const fetch: CfFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      auth: init.headers.Authorization,
      contentType: init.headers['Content-Type'],
      body: init.body,
    });
    const zone = /\/zones\/([0-9a-f]{32})$/.exec(url)?.[1];
    if (init.method === 'GET' && zone && zoneAccounts[zone] && answer.json === undefined && answer.text === undefined) {
      const body = JSON.stringify({ success: true, result: { id: zone, account: { id: zoneAccounts[zone] } } });
      return once({ ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body });
    }
    const status = answer.status ?? 200;
    const raw = answer.text ?? JSON.stringify(answer.json ?? { success: true, result: [] });
    return once({ ok: status < 300, status, json: async () => JSON.parse(raw), text: async () => raw });
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
const text = (out: { content: { text: string }[] }) => JSON.parse(out.content[0].text);
const cf = (args: Record<string, unknown>, fetch: CfFetch) => handleCfApi({ server: 'dev2', ...args }, fetch);

describe('cf_api — several accounts', () => {
  it("calls the named account with that account's own token", async () => {
    const { fetch, calls } = cloudflare({ json: { success: true, result: [{ id: 'w1' }] } });
    await cf({ account: 'iq-hq', method: 'GET', path: `/accounts/${HQ}/workers/scripts` }, fetch);
    await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/d1/database` }, fetch);
    expect(calls.map((c) => [c.url, c.auth])).toEqual([
      [`${API}/accounts/${HQ}/workers/scripts`, `Bearer ${HQ_TOKEN}`],
      [`${API}/accounts/${DEV}/d1/database`, `Bearer ${DEV_TOKEN}`],
    ]);
  });

  it('needs the account named when there are several, and refuses one it does not have', async () => {
    const { fetch, calls } = cloudflare();
    await expect(cf({ method: 'GET', path: `/accounts/${HQ}` }, fetch)).rejects.toThrow(
      /name one of its cloudflare accounts: iq-dev, iq-hq/,
    );
    await expect(cf({ account: 'iq-stage', method: 'GET', path: `/accounts/${HQ}` }, fetch)).rejects.toThrow(
      /has no cloudflare account named iq-stage/,
    );
    expect(calls).toEqual([]);
    // One account: it is the default.
    writeConfig({ accounts: { 'iq-hq': { token: { $secret: 'cf-hq' }, id: HQ, reach: 'account' } } });
    await cf({ method: 'GET', path: `/accounts/${HQ}` }, fetch);
    expect(calls).toHaveLength(1);
  });

  it("refuses another account's paths through an account entry", async () => {
    const { fetch, calls } = cloudflare();
    await expect(
      cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${HQ}/workers/scripts` }, fetch),
    ).rejects.toThrow(/is not account iq-dev/);
    expect(calls).toEqual([]);
  });

  it('leaves out only the account whose secret does not resolve; the server and its other tools stay', async () => {
    writeConfig(accounts({ 'iq-stage': { token: { $secret: 'cf-missing' }, id: DEV, reach: 'account' } }));
    const config = loadConfig();
    expect(config.dev2.databases?.app).toBeDefined();
    expect(config.dev2.github).toBeDefined();
    const { fetch } = cloudflare();
    await cf({ account: 'iq-hq', method: 'GET', path: `/accounts/${HQ}` }, fetch);
    await expect(cf({ account: 'iq-stage', method: 'GET', path: `/accounts/${DEV}` }, fetch)).rejects.toThrow(
      /has no cloudflare account named iq-stage/,
    );
    // A token written into config.json leaves that account out.
    writeConfig(accounts({ 'iq-plain': { token: 'raw-token-in-config', id: DEV, reach: 'account' } }));
    await expect(cf({ account: 'iq-plain', method: 'GET', path: `/accounts/${DEV}` }, fetch)).rejects.toThrow(
      /has no cloudflare account named iq-plain/,
    );
  });

  it('refuses an account entry with reach "account" and no 32-hex id', async () => {
    writeConfig({ accounts: { bad: { token: { $secret: 'cf-hq' }, id: 'IQ-hq', reach: 'account' } } });
    const { fetch, calls } = cloudflare();
    await expect(cf({ method: 'GET', path: `/accounts/${HQ}` }, fetch)).rejects.toThrow(/32-hex id/);
    expect(calls).toEqual([]);
  });

  it('lists each server with its environment APIs: Cloudflare accounts, GitHub repos, web logins', () => {
    const out = JSON.parse(handleList().content[0].text);
    expect(out.servers[0]).toMatchObject({
      name: 'dev2',
      cloudflare: [
        { account: 'iq-dev', reach: 'account', write: true, id: DEV },
        { account: 'iq-hq', reach: 'account', write: false, id: HQ },
      ],
      github: ['acme/app'],
      logins: ['qa'],
    });
    expect(JSON.stringify(out)).not.toContain(DEV_TOKEN);
  });
});

describe('cf_api — reach "account"', () => {
  it('reads and writes everything below the account, the write audited with its account', async () => {
    const { fetch, calls } = cloudflare({ json: { success: true, result: { uuid: 'd1-1' } } });
    await cf({ account: 'iq-dev', method: 'POST', path: `/accounts/${DEV}/d1/database`, body: { name: 'qa' } }, fetch);
    await cf(
      {
        account: 'iq-dev',
        method: 'PUT',
        path: `/accounts/${DEV}/workers/scripts/api/secrets`,
        body: { name: 'KEY', text: 'v', type: 'secret_text' },
      },
      fetch,
    );
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT']);
    expect(ledger().map((r) => [r.phase, r.action, r.detail.account, r.detail.path])).toEqual([
      ['intent', 'POST', 'iq-dev', `/accounts/${DEV}/d1/database`],
      ['done', 'POST', 'iq-dev', `/accounts/${DEV}/d1/database`],
      ['intent', 'PUT', 'iq-dev', `/accounts/${DEV}/workers/scripts/api/secrets`],
      ['done', 'PUT', 'iq-dev', `/accounts/${DEV}/workers/scripts/api/secrets`],
    ]);
  });

  it('writes only on an account whose entry allows writes', async () => {
    const { fetch, calls } = cloudflare();
    await expect(
      cf({ account: 'iq-hq', method: 'DELETE', path: `/accounts/${HQ}/workers/scripts/api` }, fetch),
    ).rejects.toThrow(/reads only/);
    expect(calls).toEqual([]);
  });

  it('reads the account, never the list of every account, and never writes the account itself', async () => {
    const { fetch, calls } = cloudflare();
    // review-of-legends R5: a page of every account the token sees may not even hold this one.
    await expect(cf({ account: 'iq-dev', method: 'GET', path: '/accounts' }, fetch)).rejects.toThrow(
      /account list is not reachable: read \/accounts\/a{32}/,
    );
    await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}` }, fetch);
    await expect(
      cf({ account: 'iq-dev', method: 'PUT', path: `/accounts/${DEV}`, body: { name: 'x' } }, fetch),
    ).rejects.toThrow(/account itself is never written/);
    await expect(cf({ account: 'iq-dev', method: 'POST', path: '/accounts', body: {} }, fetch)).rejects.toThrow(
      /account list is not reachable/,
    );
    expect(calls).toHaveLength(1);
  });

  it("lists the account's zones only, adding the account to the query", async () => {
    const { fetch, calls } = cloudflare();
    await cf({ account: 'iq-hq', method: 'GET', path: '/zones', query: { per_page: 50 } }, fetch);
    expect(calls[0].url).toBe(`${API}/zones?per_page=50&account.id=${HQ}&match=all`);
    await expect(
      cf({ account: 'iq-hq', method: 'GET', path: '/zones', query: { 'account.id': DEV } }, fetch),
    ).rejects.toThrow(/account.id must be bbbb/);
    // review: `match=any` would make the account one filter among alternatives.
    await expect(
      cf({ account: 'iq-hq', method: 'GET', path: '/zones', query: { match: 'any', status: 'active' } }, fetch),
    ).rejects.toThrow(/match must be all/);
    await expect(cf({ account: 'iq-dev', method: 'POST', path: '/zones', body: { name: 'x' } }, fetch)).rejects.toThrow(
      /zone itself is never written/,
    );
    expect(calls).toHaveLength(1);
    // A token that sees another account's zones: the answer keeps this account's.
    const mixed = cloudflare({
      json: {
        success: true,
        result: [
          { id: HQ_ZONE, account: { id: HQ } },
          { id: DEV_ZONE, account: { id: DEV } },
        ],
      },
    });
    const out = await cf({ account: 'iq-hq', method: 'GET', path: '/zones' }, mixed.fetch);
    expect(text(out).body.result).toEqual([{ id: HQ_ZONE, account: { id: HQ } }]);
  });

  it('reaches a zone it does not list once Cloudflare says the zone is this account’s, and remembers it', async () => {
    const { fetch, calls } = cloudflare();
    await cf({ account: 'iq-hq', method: 'GET', path: `/zones/${HQ_ZONE}/dns_records` }, fetch);
    await cf({ account: 'iq-hq', method: 'GET', path: `/zones/${HQ_ZONE}/settings` }, fetch);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/zones/${HQ_ZONE}`,
      `${API}/zones/${HQ_ZONE}/dns_records`,
      `${API}/zones/${HQ_ZONE}/settings`,
    ]);
    expect(calls.every((c) => c.auth === `Bearer ${HQ_TOKEN}`)).toBe(true);
  });

  it("refuses a zone of another account, after asking Cloudflare only for the zone's account", async () => {
    writeConfig(accounts({ 'iq-hq': { token: { $secret: 'cf-hq' }, id: HQ, reach: 'account', write: true } }));
    const { fetch, calls } = cloudflare();
    await expect(
      cf({ account: 'iq-hq', method: 'POST', path: `/zones/${DEV_ZONE}/dns_records`, body: {} }, fetch),
    ).rejects.toThrow(/is not a zone of account iq-hq/);
    expect(calls.map((c) => [c.method, c.url])).toEqual([['GET', `${API}/zones/${DEV_ZONE}`]]);
    expect(ledger()).toEqual([]);
  });

  it('reaches a listed zone without asking, its default parts, and a part the entry lists', async () => {
    const { fetch, calls } = cloudflare({ json: { success: true, result: [] } });
    await cf({ account: 'iq-dev', method: 'GET', path: `/zones/${LISTED_ZONE}/workers/routes` }, fetch);
    expect(calls.map((c) => c.url)).toEqual([`${API}/zones/${LISTED_ZONE}/workers/routes`]);
    // review: a zone part that can carry another system's credential stays opt-in under reach "account" too.
    for (const part of ['custom_hostnames', 'logpush', 'healthchecks', 'rulesets']) {
      await expect(
        cf({ account: 'iq-dev', method: 'GET', path: `/zones/${LISTED_ZONE}/${part}` }, fetch),
      ).rejects.toThrow(new RegExp(`${part} is not a part cf_api reaches`));
    }
    writeConfig(
      accounts({
        'iq-dev': {
          token: { $secret: 'cf-dev' },
          id: DEV,
          reach: 'account',
          parts: ['logpush'],
          zones: { 'dev.example': LISTED_ZONE },
        },
      }),
    );
    await cf({ account: 'iq-dev', method: 'GET', path: `/zones/${LISTED_ZONE}/logpush/jobs` }, fetch);
    expect(calls).toHaveLength(2);
    await expect(cf({ account: 'iq-dev', method: 'DELETE', path: `/zones/${LISTED_ZONE}` }, fetch)).rejects.toThrow(
      /zone itself is never written/,
    );
  });

  it('never reaches a path that hands out a credential or changes who is a member', async () => {
    const { fetch, calls } = cloudflare();
    for (const p of [
      `/accounts/${DEV}/tokens`,
      `/accounts/${DEV}/tokens/verify`,
      `/accounts/${DEV}/members`,
      `/accounts/${DEV}/access/service_tokens`,
      `/accounts/${DEV}/cfd_tunnel/t1/token`,
      `/accounts/${DEV}/r2/temp-access-credentials`,
      `/accounts/${DEV}/stream/keys`,
      `/accounts/${DEV}/images/v1/keys`,
      `/accounts/${DEV}/Tokens`,
      `/accounts/${DEV}/workers/scripts/api/tails`,
      `/accounts/${DEV}/workers/scripts/api/assets-upload-session`,
      `/accounts/${DEV}/pages/projects/site/upload-token`,
      `/zones/${LISTED_ZONE}/access/apps/x/tokens`,
    ]) {
      await expect(cf({ account: 'iq-dev', method: 'GET', path: p }, fetch)).rejects.toThrow(/never reachable/);
    }
    for (const p of ['/user/tokens', '/user', '/memberships', '/certificates', '/graphql']) {
      await expect(cf({ account: 'iq-dev', method: 'GET', path: p }, fetch)).rejects.toThrow(/path must be/);
    }
    expect(calls).toEqual([]);
    // A name that only contains such a word is not refused: a Worker named `token-refresher`, a KV key list.
    await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/workers/scripts/token-refresher` }, fetch);
    await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/storage/kv/namespaces/n1/keys` }, fetch);
    expect(calls).toHaveLength(2);
  });

  // review: an account part whose answer can carry another system's credential is opt-in, like a zone part.
  it('reaches the deploy parts of an account by default, and the rest only when the entry lists them', async () => {
    const { fetch, calls } = cloudflare();
    for (const part of ['workers', 'd1', 'storage', 'r2', 'pages', 'queues', 'hyperdrive', 'ai']) {
      await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/${part}` }, fetch);
    }
    expect(calls).toHaveLength(8);
    // Opt-in parts; the parts that issue credentials are never reachable at all.
    for (const p of [`/accounts/${DEV}/logpush/jobs`, `/accounts/${DEV}/load_balancers/monitors`]) {
      await expect(cf({ account: 'iq-dev', method: 'GET', path: p }, fetch)).rejects.toThrow(
        /is not an account part cf_api reaches/,
      );
    }
    for (const p of [
      `/accounts/${DEV}/secondary_dns/tsigs`,
      `/accounts/${DEV}/stream/live_inputs`,
      `/accounts/${DEV}/challenges/widgets`,
      `/accounts/${DEV}/calls/apps`,
      `/accounts/${DEV}/cfd_tunnel`,
      `/accounts/${DEV}/access/apps`,
    ]) {
      await expect(cf({ account: 'iq-dev', method: 'GET', path: p }, fetch)).rejects.toThrow(/never reachable/);
    }
    expect(calls).toHaveLength(8);
    const entry = { token: { $secret: 'cf-dev' }, id: DEV, reach: 'account', write: true };
    writeConfig(accounts({ 'iq-dev': { ...entry, parts: ['logpush'] } }));
    await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/logpush/jobs` }, fetch);
    // review-of-legends R5: no "every part" switch, and a part that issues credentials stays closed when listed.
    writeConfig(accounts({ 'iq-dev': { ...entry, parts: ['*', 'secondary_dns', 'challenges'] } }));
    for (const p of [`/accounts/${DEV}/secondary_dns/tsigs`, `/accounts/${DEV}/challenges/widgets`]) {
      await expect(cf({ account: 'iq-dev', method: 'GET', path: p }, fetch)).rejects.toThrow(/never reachable/);
    }
    await expect(cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/email` }, fetch)).rejects.toThrow(
      /is not an account part cf_api reaches/,
    );
    expect(calls).toHaveLength(9);
  });
});

describe('cf_api — uploads and answers that are not JSON', () => {
  const worker = {
    fields: { metadata: JSON.stringify({ main_module: 'worker.js', compatibility_date: '2026-11-01' }) },
    files: [
      { name: 'worker.js', filename: 'worker.js', type: 'application/javascript+module', text: 'export default {}' },
    ],
  };

  it('uploads a Worker as multipart form data, audited with a digest of what was sent', async () => {
    const { fetch, calls } = cloudflare({ json: { success: true, result: { id: 'api' } } });
    await cf({ account: 'iq-dev', method: 'PUT', path: `/accounts/${DEV}/workers/scripts/api`, form: worker }, fetch);
    const sent = calls[0];
    expect(sent.contentType).toBeUndefined();
    expect(sent.body).toBeInstanceOf(FormData);
    const form = sent.body as FormData;
    expect(form.get('metadata')).toBe(worker.fields.metadata);
    const file = form.get('worker.js') as File;
    expect(file.name).toBe('worker.js');
    expect(file.type).toBe('application/javascript+module');
    expect(await file.text()).toBe('export default {}');
    const intent = ledger().find((r) => r.phase === 'intent');
    expect(intent.detail.formSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger().map((r) => r.phase)).toEqual(['intent', 'done']);
  });

  it('takes a file as base64 too, and refuses a form with a body, on a read, or with bad parts', async () => {
    const { fetch, calls } = cloudflare({ json: { success: true, result: {} } });
    await cf(
      {
        account: 'iq-dev',
        method: 'PUT',
        path: `/accounts/${DEV}/workers/scripts/api`,
        form: { files: [{ name: 'a.wasm', filename: 'a.wasm', type: 'application/wasm', base64: 'AGFzbQ==' }] },
      },
      fetch,
    );
    const wasm = (calls[0].body as FormData).get('a.wasm') as File;
    expect(Buffer.from(await wasm.arrayBuffer()).toString('hex')).toBe('0061736d');
    const path_ = `/accounts/${DEV}/workers/scripts/api`;
    await expect(cf({ account: 'iq-dev', method: 'PUT', path: path_, form: worker, body: {} }, fetch)).rejects.toThrow(
      /either body or form/,
    );
    await expect(cf({ account: 'iq-dev', method: 'GET', path: path_, form: worker }, fetch)).rejects.toThrow(
      /only sent with POST, PUT or PATCH/,
    );
    // review: a module may sit in a folder (`chunks/x.js`), never above it.
    await cf(
      {
        account: 'iq-dev',
        method: 'PUT',
        path: path_,
        form: {
          files: [{ name: 'chunks/x.js', filename: 'chunks/x.js', type: 'application/javascript+module', text: '' }],
        },
      },
      fetch,
    );
    expect(((calls[1].body as FormData).get('chunks/x.js') as File).name).toBe('chunks/x.js');
    await expect(
      cf(
        { account: 'iq-dev', method: 'PUT', path: path_, form: { files: [{ name: 'a', filename: '../x', text: '' }] } },
        fetch,
      ),
    ).rejects.toThrow(/filename/);
    await expect(
      cf(
        {
          account: 'iq-dev',
          method: 'PUT',
          path: path_,
          form: { files: [{ name: 'a', filename: 'a', text: 'x', base64: 'eA==' }] },
        },
        fetch,
      ),
    ).rejects.toThrow(/text or base64/);
    expect(calls).toHaveLength(2);
  });

  it('returns a read whose answer is not JSON as text, without the token', async () => {
    const { fetch } = cloudflare({ text: `export default { fetch() { return "${HQ_TOKEN}" } }` });
    const out = await cf(
      { account: 'iq-hq', method: 'GET', path: `/accounts/${HQ}/workers/scripts/api/content/v2` },
      fetch,
    );
    expect(text(out)).toEqual({
      status: 200,
      truncated: false,
      body: 'export default { fetch() { return "[redacted]" } }',
    });
  });

  it('still takes a write whose answer is not JSON as unknown', async () => {
    const { fetch } = cloudflare({ text: 'ok' });
    await expect(
      cf({ account: 'iq-dev', method: 'DELETE', path: `/accounts/${DEV}/workers/scripts/api` }, fetch),
    ).rejects.toThrow(/may have been made/);
    expect(ledger().map((r) => r.phase)).toEqual(['intent', 'unknown']);
  });
});

// review-of-legends R3 (3c32dea3): tunnel creation answers with a connector credential, Workers AI names models with
// `@cf`, an empty read is an answer, base64 must be whole, the upload budget and digest, and the zone proof's failures.
describe('cf_api — review-of-legends R3', () => {
  const writable = { token: { $secret: 'cf-dev' }, id: DEV, reach: 'account', write: true };

  it('never reaches tunnels, even listed, and hides credential fields in any answer', async () => {
    writeConfig(accounts({ 'iq-dev': { ...writable, parts: ['cfd_tunnel', 'tunnels', 'warp_connector'] } }));
    const { fetch, calls } = cloudflare();
    for (const part of ['cfd_tunnel', 'tunnels', 'warp_connector']) {
      await expect(
        cf({ account: 'iq-dev', method: 'POST', path: `/accounts/${DEV}/${part}`, body: { name: 't' } }, fetch),
      ).rejects.toThrow(/never reachable/);
    }
    // review-of-legends R5: setting an existing tunnel's secret is closed too.
    await expect(
      cf(
        { account: 'iq-dev', method: 'PATCH', path: `/accounts/${DEV}/cfd_tunnel/t1`, body: { tunnel_secret: 'x' } },
        fetch,
      ),
    ).rejects.toThrow(/never reachable/);
    expect(calls).toEqual([]);
    expect(ledger()).toEqual([]);
    const answer = cloudflare({
      json: {
        success: true,
        result: [
          {
            id: 't1',
            name: 'edge',
            token: 'eyJhIjoi',
            credentials_file: { TunnelSecret: 's3cr3t' },
            config: { secret: 'w1', streamKey: 'k1', ok: 'kept' },
          },
        ],
      },
    });
    const out = await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/workers/scripts` }, answer.fetch);
    expect(text(out).body.result).toEqual([
      {
        id: 't1',
        name: 'edge',
        token: '[redacted]',
        credentials_file: '[redacted]',
        config: { secret: '[redacted]', streamKey: '[redacted]', ok: 'kept' },
      },
    ]);
  });

  it('runs a Workers AI model named with @cf', async () => {
    writeConfig(accounts({ 'iq-dev': writable }));
    const { fetch, calls } = cloudflare({ json: { success: true, result: { response: 'hi' } } });
    await cf(
      {
        account: 'iq-dev',
        method: 'POST',
        path: `/accounts/${DEV}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
        body: { prompt: 'hi' },
      },
      fetch,
    );
    expect(calls[0].url).toBe(`${API}/accounts/${DEV}/ai/run/@cf/meta/llama-3.1-8b-instruct`);
  });

  it('returns an empty successful read as empty text', async () => {
    const { fetch } = cloudflare({ text: '' });
    const out = await cf(
      { account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/storage/kv/namespaces/n1/values/empty` },
      fetch,
    );
    expect(text(out)).toEqual({ status: 200, truncated: false, body: '' });
  });

  it('refuses base64 that is not whole, before anything is sent', async () => {
    writeConfig(accounts({ 'iq-dev': writable }));
    const { fetch, calls } = cloudflare();
    for (const base64 of ['aGVsb', 'YWJjZ', 'YQ', 'YQ=', 'Y===']) {
      await expect(
        cf(
          {
            account: 'iq-dev',
            method: 'PUT',
            path: `/accounts/${DEV}/workers/scripts/api`,
            form: { files: [{ name: 'a', filename: 'a', base64 }] },
          },
          fetch,
        ),
      ).rejects.toThrow(/whole, padded base64/);
    }
    expect(calls).toEqual([]);
    expect(ledger()).toEqual([]);
  });

  it('keeps the upload budget of 50 parts and 10 MiB, checked before sending', async () => {
    writeConfig(accounts({ 'iq-dev': writable }));
    const { fetch, calls } = cloudflare({ json: { success: true, result: {} } });
    const put = (form: unknown) =>
      cf({ account: 'iq-dev', method: 'PUT', path: `/accounts/${DEV}/workers/scripts/api`, form }, fetch);
    const fields = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, 'x']));
    await put({ fields: fields(49), files: [{ name: 'a', filename: 'a', text: 'x' }] });
    await expect(put({ fields: fields(50), files: [{ name: 'a', filename: 'a', text: 'x' }] })).rejects.toThrow(
      /1 to 50 parts/,
    );
    const MiB10 = 10 * 1024 * 1024;
    // Exactly 10 MiB: 3 bytes per character for 가, the rest in one decoded base64 file.
    const korean = '가'.repeat(1000);
    const rest = MiB10 - 3000;
    await put({
      fields: { metadata: korean },
      files: [{ name: 'b', filename: 'b', base64: Buffer.alloc(rest).toString('base64') }],
    });
    await expect(
      put({
        fields: { metadata: korean },
        files: [{ name: 'b', filename: 'b', base64: Buffer.alloc(rest + 1).toString('base64') }],
      }),
    ).rejects.toThrow(/at most 10485760 bytes/);
    expect(calls).toHaveLength(2);
    expect(ledger().filter((r) => r.phase === 'intent')).toHaveLength(2);
  });

  it('records a digest that follows what is sent', async () => {
    writeConfig(accounts({ 'iq-dev': writable }));
    const { fetch } = cloudflare({ json: { success: true, result: {} } });
    const digest = async (metadata: string, content: string) => {
      await cf(
        {
          account: 'iq-dev',
          method: 'PUT',
          path: `/accounts/${DEV}/workers/scripts/api`,
          form: { fields: { metadata }, files: [{ name: 'w.js', filename: 'w.js', text: content }] },
        },
        fetch,
      );
      return ledger()
        .filter((r) => r.phase === 'intent')
        .at(-1).detail.formSha256;
    };
    const first = await digest('{"a":1}', 'export default 1');
    expect(await digest('{"a":1}', 'export default 1')).toBe(first);
    expect(await digest('{"a":1}', 'export default 2')).not.toBe(first);
    expect(await digest('{"a":2}', 'export default 1')).not.toBe(first);
  });

  it('says a zone could not be confirmed when the lookup fails, sends nothing, and asks again next time', async () => {
    writeConfig(accounts({ 'iq-hq': { token: { $secret: 'cf-hq' }, id: HQ, reach: 'account', write: true } }));
    const probes: string[] = [];
    const failing =
      (mode: 'status' | 'throw' | 'bad-json'): CfFetch =>
      async (url) => {
        probes.push(`${mode} ${url}`);
        if (mode === 'throw') throw new TypeError('fetch failed');
        if (mode === 'status') return { ok: false, status: 403, json: async () => ({}), text: async () => '{}' };
        return { ok: true, status: 200, json: async () => JSON.parse('{oops'), text: async () => '{oops' };
      };
    const write = (fetch: CfFetch) =>
      cf({ account: 'iq-hq', method: 'POST', path: `/zones/${HQ_ZONE}/dns_records`, body: {} }, fetch);
    await expect(write(failing('status'))).rejects.toThrow(/could not confirm .* \(Cloudflare answered 403\)/);
    await expect(write(failing('throw'))).rejects.toThrow(/could not confirm .* \(no answer: TypeError\)/);
    const bad = failing('bad-json');
    await expect(write(bad)).rejects.toThrow(/could not confirm .* could not be read/);
    await expect(write(bad)).rejects.toThrow(/could not confirm/);
    expect(probes).toHaveLength(4);
    expect(probes.every((p) => p.endsWith(`/zones/${HQ_ZONE}`))).toBe(true);
    expect(ledger()).toEqual([]);
  });

  it('proves a zone again for another account, even after one account proved it on the same fetch', async () => {
    writeConfig(accounts({ 'iq-hq': { token: { $secret: 'cf-hq' }, id: HQ, reach: 'account', write: true } }));
    const { fetch, calls } = cloudflare({}, { [DEV_ZONE]: DEV });
    await cf({ account: 'iq-dev', method: 'GET', path: `/zones/${DEV_ZONE}/dns_records` }, fetch);
    await expect(
      cf({ account: 'iq-hq', method: 'POST', path: `/zones/${DEV_ZONE}/dns_records`, body: {} }, fetch),
    ).rejects.toThrow(/is not a zone of account iq-hq/);
    expect(calls.map((c) => [c.url.replace(API, ''), c.auth])).toEqual([
      [`/zones/${DEV_ZONE}`, `Bearer ${DEV_TOKEN}`],
      [`/zones/${DEV_ZONE}/dns_records`, `Bearer ${DEV_TOKEN}`],
      [`/zones/${DEV_ZONE}`, `Bearer ${HQ_TOKEN}`],
    ]);
    expect(ledger()).toEqual([]);
  });
});

// review-of-legends R4 (47058fe8): bearer URLs, a leftover top-level token beside named accounts, module-name
// segments, and an answer body that cannot be read.
describe('cf_api — review-of-legends R4', () => {
  const writable = { token: { $secret: 'cf-dev' }, id: DEV, reach: 'account', write: true };

  it('never reaches an endpoint that hands out a bearer URL, and hides bearer URLs in answers', async () => {
    writeConfig(accounts({ 'iq-dev': { ...writable, parts: ['stream'] } }));
    const { fetch, calls } = cloudflare();
    for (const [method, p] of [
      ['POST', `/accounts/${DEV}/images/v2/direct_upload`],
      ['POST', `/accounts/${DEV}/images/v1/direct_upload`],
      ['POST', `/accounts/${DEV}/stream/direct_upload`],
      ['GET', `/accounts/${DEV}/pages/projects/site/deploy_hooks`],
      ['POST', `/accounts/${DEV}/pages/webhooks/deploy_hooks/h1`],
      ['POST', `/accounts/${DEV}/workers/scripts/api/edge-preview`],
    ] as const) {
      await expect(
        cf({ account: 'iq-dev', method, path: p, ...(method === 'POST' ? { body: {} } : {}) }, fetch),
      ).rejects.toThrow(/never reachable/);
    }
    expect(calls).toEqual([]);
    expect(ledger()).toEqual([]);
    const answer = cloudflare({
      json: {
        success: true,
        result: { signed_url: 'https://x/dump?sig=1', upload_url: 'https://y', uploadURL: 'z', at: 1 },
      },
    });
    const out = await cf(
      { account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/d1/database/d1/export` },
      answer.fetch,
    );
    expect(text(out).body.result).toEqual({
      signed_url: '[redacted]',
      upload_url: '[redacted]',
      uploadURL: '[redacted]',
      at: 1,
    });
  });

  it('ignores fields beside accounts, so a leftover top-level token never drops the server', async () => {
    writeConfig({ token: { $secret: 'cf-missing' }, zones: { 'x.example': LISTED_ZONE }, ...accounts() });
    const config = loadConfig();
    expect(config.dev2).toBeDefined();
    expect(config.dev2.databases?.app).toBeDefined();
    expect(Object.keys(config.dev2.cloudflare ?? {})).toEqual(['accounts']);
    const { fetch } = cloudflare();
    await cf({ account: 'iq-hq', method: 'GET', path: `/accounts/${HQ}/workers/scripts` }, fetch);
  });

  it('refuses a module name with an empty, . or .. segment, as name or filename', async () => {
    writeConfig(accounts({ 'iq-dev': writable }));
    const { fetch, calls } = cloudflare();
    for (const bad of ['chunks/../x.js', 'chunks/./x.js', 'chunks//x.js', 'chunks/x.js/']) {
      for (const file of [
        { name: bad, filename: 'x.js', text: '' },
        { name: 'x.js', filename: bad, text: '' },
      ]) {
        await expect(
          cf(
            { account: 'iq-dev', method: 'PUT', path: `/accounts/${DEV}/workers/scripts/api`, form: { files: [file] } },
            fetch,
          ),
        ).rejects.toThrow(/name/);
      }
    }
    expect(calls).toEqual([]);
    expect(ledger()).toEqual([]);
  });

  it('fails a read whose body cannot be read, and records a write like that as unknown', async () => {
    writeConfig(accounts({ 'iq-dev': writable }));
    const broken: CfFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('stream reset');
      },
      text: async () => {
        throw new Error('stream reset');
      },
    });
    await expect(
      cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/workers/scripts` }, broken),
    ).rejects.toThrow(/unreadable body/);
    await expect(
      cf({ account: 'iq-dev', method: 'DELETE', path: `/accounts/${DEV}/workers/scripts/api` }, broken),
    ).rejects.toThrow(/may have been made/);
    expect(ledger().map((r) => r.phase)).toEqual(['intent', 'unknown']);
  });
});

// review-of-legends R5 (53af8a86): parts that issue credentials stay closed when listed, the TURN api_token, isolation
// between named zone-scoped accounts, and a KV value that looks like a failed envelope.
describe('cf_api — review-of-legends R5', () => {
  const writable = { token: { $secret: 'cf-dev' }, id: DEV, reach: 'account', write: true };

  it('never reaches a part that issues credentials, even when the entry lists it', async () => {
    const parts = ['calls', 'access', 'gateway', 'devices', 'mtls_certificates', 'magic', 'iam', 'stream'];
    writeConfig(accounts({ 'iq-dev': { ...writable, parts } }));
    const { fetch, calls } = cloudflare();
    for (const p of [
      `/accounts/${DEV}/calls/turn_keys`,
      `/accounts/${DEV}/calls/apps`,
      `/accounts/${DEV}/access/apps`,
      `/accounts/${DEV}/gateway/rules`,
      `/accounts/${DEV}/devices/policy`,
      `/accounts/${DEV}/mtls_certificates`,
      `/accounts/${DEV}/magic/ipsec_tunnels`,
      `/accounts/${DEV}/iam/user_groups`,
      `/accounts/${DEV}/stream/live_inputs`,
    ]) {
      await expect(cf({ account: 'iq-dev', method: 'POST', path: p, body: {} }, fetch)).rejects.toThrow(
        /never reachable/,
      );
    }
    expect(calls).toEqual([]);
    expect(ledger()).toEqual([]);
  });

  it('hides an api_token field in any answer', async () => {
    const { fetch } = cloudflare({ json: { success: true, result: { uid: 'k1', api_token: 'tk', name: 'n' } } });
    const out = await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/ai-gateway/gateways` }, fetch);
    expect(text(out).body.result).toEqual({ uid: 'k1', api_token: '[redacted]', name: 'n' });
  });

  it("keeps named zone-scoped accounts apart: one never reaches the other's zones", async () => {
    writeConfig({
      accounts: {
        a: { token: { $secret: 'cf-dev' }, zones: { 'a.example': DEV_ZONE }, write: true },
        b: { token: { $secret: 'cf-hq' }, zones: { 'b.example': HQ_ZONE }, write: true },
      },
    });
    const { fetch, calls } = cloudflare({ json: { success: true, result: {} } });
    await cf({ account: 'a', method: 'POST', path: `/zones/${DEV_ZONE}/dns_records`, body: {} }, fetch);
    await expect(
      cf({ account: 'a', method: 'POST', path: `/zones/${HQ_ZONE}/dns_records`, body: {} }, fetch),
    ).rejects.toThrow(/not one of this environment's zones/);
    await expect(cf({ account: 'b', method: 'GET', path: `/accounts/${HQ}` }, fetch)).rejects.toThrow(
      /path must be \/zones/,
    );
    expect(calls.map((c) => [c.url.replace(API, ''), c.auth])).toEqual([
      [`/zones/${DEV_ZONE}/dns_records`, `Bearer ${DEV_TOKEN}`],
    ]);
    expect(ledger().map((r) => [r.phase, r.detail.account])).toEqual([
      ['intent', 'a'],
      ['done', 'a'],
    ]);
  });

  it('hands back a KV value that is JSON with success: false as the value it is', async () => {
    const value = { success: false, errors: ['app-level'], n: 1 };
    const { fetch } = cloudflare({ json: value });
    const out = await cf(
      { account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/storage/kv/namespaces/n1/values/k` },
      fetch,
    );
    expect(text(out)).toEqual({ status: 200, truncated: false, body: value });
  });
});

// review-of-legends R6 (f92c8d17): binary answers, Pub/Sub broker credentials, the text cap, service tokens below
// an opened zone part.
describe('cf_api — review-of-legends R6', () => {
  const bytesAnswer =
    (bytes: Uint8Array): CfFetch =>
    async () => {
      let used = false;
      const read = async () => {
        if (used) throw new TypeError('Body is unusable');
        used = true;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      };
      return {
        ok: true,
        status: 200,
        arrayBuffer: read,
        json: async () => JSON.parse(Buffer.from(await read()).toString()),
        text: async () => Buffer.from(await read()).toString(),
      };
    };
  const kv = `/accounts/${DEV}/storage/kv/namespaces/n1/values/k`;

  it('hands back an answer that is not UTF-8 as base64, and UTF-8 bytes as text', async () => {
    const out = await cf(
      { account: 'iq-dev', method: 'GET', path: kv },
      bytesAnswer(new Uint8Array([0xff, 0xfe, 0x00])),
    );
    expect(text(out)).toEqual({ status: 200, truncated: false, body: '//4A', encoding: 'base64' });
    const utf8 = await cf(
      { account: 'iq-dev', method: 'GET', path: kv },
      bytesAnswer(Buffer.from('가나 value', 'utf8')),
    );
    expect(text(utf8)).toEqual({ status: 200, truncated: false, body: '가나 value' });
    const json = await cf({ account: 'iq-dev', method: 'GET', path: kv }, bytesAnswer(Buffer.from('{"a":1}', 'utf8')));
    expect(text(json).body).toEqual({ a: 1 });
  });

  it('cuts a long text answer at 200,000 characters and says so', async () => {
    const { fetch } = cloudflare({ text: 'x'.repeat(200_001) });
    const out = text(await cf({ account: 'iq-dev', method: 'GET', path: kv }, fetch));
    expect(out.truncated).toBe(true);
    expect(out.body).toHaveLength(200_000);
  });

  it('never reaches Pub/Sub, even listed', async () => {
    writeConfig(accounts({ 'iq-dev': { token: { $secret: 'cf-dev' }, id: DEV, reach: 'account', parts: ['pubsub'] } }));
    const { fetch, calls } = cloudflare();
    await expect(
      cf(
        { account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/pubsub/namespaces/n/brokers/b/credentials` },
        fetch,
      ),
    ).rejects.toThrow(/never reachable/);
    expect(calls).toEqual([]);
  });

  it('never reaches service tokens below a zone part the entry opened', async () => {
    writeConfig(
      accounts({
        'iq-dev': {
          token: { $secret: 'cf-dev' },
          id: DEV,
          reach: 'account',
          parts: ['access'],
          zones: { d: LISTED_ZONE },
        },
      }),
    );
    const { fetch, calls } = cloudflare();
    await cf({ account: 'iq-dev', method: 'GET', path: `/zones/${LISTED_ZONE}/access/apps` }, fetch);
    await expect(
      cf({ account: 'iq-dev', method: 'GET', path: `/zones/${LISTED_ZONE}/access/service_tokens` }, fetch),
    ).rejects.toThrow(/never reachable/);
    expect(calls).toHaveLength(1);
  });
});

// review-of-legends R7 (a3823c95): the token inside a binary answer, the binary cap, shared and retried zone proofs.
describe('cf_api — review-of-legends R7', () => {
  const bytesFetch =
    (bytes: Buffer): CfFetch =>
    async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      json: async () => ({}),
    });
  const kv = `/accounts/${DEV}/storage/kv/namespaces/n1/values/k`;

  it('scrubs the token from a binary answer before encoding it', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(DEV_TOKEN), Buffer.from([0xfe])]);
    const out = text(await cf({ account: 'iq-dev', method: 'GET', path: kv }, bytesFetch(bytes)));
    expect(out.encoding).toBe('base64');
    const decoded = Buffer.from(out.body, 'base64');
    expect(decoded.includes(Buffer.from(DEV_TOKEN))).toBe(false);
    expect(decoded).toEqual(Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from('[redacted]'), Buffer.from([0xfe])]));
  });

  it('cuts a binary answer before encoding, within 200,000 characters of base64', async () => {
    const bytes = Buffer.alloc(300_000, 0xff);
    const out = text(await cf({ account: 'iq-dev', method: 'GET', path: kv }, bytesFetch(bytes)));
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(200_000);
    expect(Buffer.from(out.body, 'base64')).toHaveLength(150_000);
  });

  it('shares one proof between concurrent calls, and asks again after a refusal', async () => {
    writeConfig(accounts({ 'iq-hq': { token: { $secret: 'cf-hq' }, id: HQ, reach: 'account', write: true } }));
    const { fetch, calls } = cloudflare({}, { [HQ_ZONE]: HQ, [DEV_ZONE]: DEV });
    await Promise.all([
      cf({ account: 'iq-hq', method: 'GET', path: `/zones/${HQ_ZONE}/dns_records` }, fetch),
      cf({ account: 'iq-hq', method: 'GET', path: `/zones/${HQ_ZONE}/settings` }, fetch),
    ]);
    expect(calls.filter((c) => c.url === `${API}/zones/${HQ_ZONE}`)).toHaveLength(1);
    // A zone Cloudflare said is another account's is asked again next time, never taken as proven.
    for (let i = 0; i < 2; i++) {
      await expect(
        cf({ account: 'iq-hq', method: 'POST', path: `/zones/${DEV_ZONE}/dns_records`, body: {} }, fetch),
      ).rejects.toThrow(/is not a zone of account iq-hq/);
    }
    expect(calls.filter((c) => c.url === `${API}/zones/${DEV_ZONE}`)).toHaveLength(2);
    expect(ledger()).toEqual([]);
  });
});

// review-of-legends R8 (9143ff1a): a huge answer is read only so far, deep JSON, credential aliases anywhere, a proof
// still pending when a second call arrives, and Analytics Engine out of the defaults.
describe('cf_api — review-of-legends R8', () => {
  const kv = `/accounts/${DEV}/storage/kv/namespaces/n1/values/k`;

  it('reads a huge answer only up to 8 MiB, then stops and says it was cut', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    const fetch: CfFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
    });
    const out = text(
      await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/r2/buckets/b/objects/big` }, fetch),
    );
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(out.truncated).toBe(true);
    expect(out.body).toHaveLength(200_000);
  });

  it('marks a cut answer truncated even when what is handed back is short', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 10, 0xff);
    const fetch: CfFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(big));
          controller.close();
        },
      }),
    });
    const out = text(await cf({ account: 'iq-dev', method: 'GET', path: kv }, fetch));
    expect(out).toMatchObject({ truncated: true, encoding: 'base64' });
  });

  it('hides JSON nested deeper than it walks, and credential fields under any parent', async () => {
    let deep: Record<string, unknown> = { secret: 's' };
    for (let i = 0; i < 70; i++) deep = { d: deep };
    const { fetch } = cloudflare({
      json: { success: true, result: { deep, list: [{ meta: { Token: 't' } }, { API_TOKEN: 'a' }] } },
    });
    const out = text(await cf({ account: 'iq-dev', method: 'GET', path: `/accounts/${DEV}/workers/scripts` }, fetch));
    expect(JSON.stringify(out.body)).not.toMatch(/"s"|"t"|"a"/);
    expect(JSON.stringify(out.body)).toContain('[redacted: nested too deep]');
    expect(out.body.result.list).toEqual([{ meta: { Token: '[redacted]' } }, { API_TOKEN: '[redacted]' }]);
  });

  it('lets a second call wait on the proof still pending, and asks Cloudflare once', async () => {
    writeConfig(accounts({ 'iq-hq': { token: { $secret: 'cf-hq' }, id: HQ, reach: 'account' } }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const urls: string[] = [];
    const fetch: CfFetch = async (url) => {
      urls.push(url.replace(API, ''));
      if (url.endsWith(`/zones/${HQ_ZONE}`)) {
        await gate;
        const body = JSON.stringify({ success: true, result: { account: { id: HQ } } });
        return { ok: true, status: 200, json: async () => JSON.parse(body) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, result: [] }) };
    };
    const first = cf({ account: 'iq-hq', method: 'GET', path: `/zones/${HQ_ZONE}/dns_records` }, fetch);
    const second = cf({ account: 'iq-hq', method: 'GET', path: `/zones/${HQ_ZONE}/settings` }, fetch);
    await new Promise((r) => setTimeout(r, 10));
    expect(urls).toEqual([`/zones/${HQ_ZONE}`]);
    release();
    await Promise.all([first, second]);
    expect(urls.filter((u) => u === `/zones/${HQ_ZONE}`)).toHaveLength(1);
    expect(urls).toHaveLength(3);
  });

  it('leaves Analytics Engine out of the default parts (its SQL takes a raw text body)', async () => {
    const { fetch, calls } = cloudflare();
    await expect(
      cf({ account: 'iq-dev', method: 'POST', path: `/accounts/${DEV}/analytics_engine/sql`, body: {} }, fetch),
    ).rejects.toThrow(/is not an account part cf_api reaches/);
    expect(calls).toEqual([]);
  });
});
