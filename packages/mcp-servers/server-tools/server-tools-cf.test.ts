/**
 * env-access WU6 (#1214): server-tools `cf_api` — an environment's Cloudflare calls with its own scoped API token
 * (in the secret store), outside every model sandbox, only on its own zones. It replaces the broker's leases: the
 * token never leaves server-tools, and the approval is the environment's grant (or an admin).
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
import { handleCfApi, loadConfig, resetConfigCache } from './server-tools-mcp-server.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-cf-'));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SECRETS = path.join(ROOT, 'secrets');
const AUDIT = path.join(ROOT, 'data', 'env-audit');
const TOKEN = 'cf-scoped-token-5e9';
const ZONE = '0123456789abcdef0123456789abcdef';
const OTHER_ZONE = 'ffffffffffffffffffffffffffffffff';
const saved = { ...process.env };

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function writeConfig(cloudflare: Record<string, unknown>) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      'server-tools': {
        dev2: { envUser: 'env:acme-dev2', cloudflare },
        plain: { cloudflare: { token: 'cf-in-config', zones: { 'x.example': ZONE } } },
        nocf: { ssh: { host: 'x' } },
      },
    }),
  );
  resetConfigCache();
  loadConfig();
}

beforeEach(() => {
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(SECRETS, 'cf-dev2'), `${TOKEN}\n`, { mode: 0o600 });
  process.env.SOMA_CONFIG_FILE = CONFIG_FILE;
  process.env.SOMA_SECRETS_DIR = SECRETS;
  process.env.SOMA_AUDIT_DIR = AUDIT;
  process.env.SOMA_REQUESTER = 'U123';
  writeConfig({ token: { $secret: 'cf-dev2' }, zones: { 'dev2.example': ZONE }, write: true });
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
});

function cloudflare(answer: { status?: number; json?: unknown; throws?: boolean } = {}) {
  const calls: { url: string; method: string; auth?: string; body?: string }[] = [];
  const fetch: CfFetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body });
    if (answer.throws) throw new Error('socket hang up');
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.json ?? { success: true, result: [] } };
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

describe('cf_api', () => {
  it("reads one of the environment's zones with its token and returns the answer", async () => {
    const { fetch, calls } = cloudflare({ json: { success: true, result: [{ id: 'r1', name: 'a.dev2.example' }] } });
    const out = await handleCfApi(
      { server: 'dev2', method: 'GET', path: `/zones/${ZONE}/dns_records`, query: { name: 'a.dev2.example' } },
      fetch,
    );
    expect(calls).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records?name=a.dev2.example`,
        method: 'GET',
        auth: `Bearer ${TOKEN}`,
        body: undefined,
      },
    ]);
    expect(text(out)).toMatchObject({ status: 200, truncated: false, body: { result: [{ id: 'r1' }] } });
    expect(out.content[0].text).not.toContain(TOKEN);
    // A read is not written to the ledger.
    expect(ledger()).toEqual([]);
  });

  it('writes only when the environment allows writes, with the ledger before and after', async () => {
    const { fetch, calls } = cloudflare({ json: { success: true, result: { id: 'r2' } } });
    await handleCfApi(
      {
        server: 'dev2',
        method: 'POST',
        path: `/zones/${ZONE}/dns_records`,
        body: { type: 'A', name: 'b.dev2.example', content: '10.0.0.2' },
      },
      fetch,
    );
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ type: 'A', name: 'b.dev2.example', content: '10.0.0.2' }),
    });
    expect(ledger().map((r) => [r.phase, r.tool, r.action, r.requester, r.detail.zone])).toEqual([
      ['intent', 'cf_api', 'POST', 'U123', 'dev2.example'],
      ['done', 'cf_api', 'POST', 'U123', 'dev2.example'],
    ]);
    expect(JSON.stringify(ledger())).not.toContain(TOKEN);

    writeConfig({ token: { $secret: 'cf-dev2' }, zones: { 'dev2.example': ZONE } });
    const ro = cloudflare();
    await expect(
      handleCfApi({ server: 'dev2', method: 'DELETE', path: `/zones/${ZONE}/dns_records/r2` }, ro.fetch),
    ).rejects.toThrow(/reads only/);
    expect(ro.calls).toEqual([]);
  });

  // trinity R1 (fable): the zone itself is never written; only listed parts are reachable; the ledger says what
  // was sent; a 2xx that says it failed, or cannot be read, is not `done`.
  it('never writes the zone itself, reaches only listed parts, and records what was sent', async () => {
    const { fetch, calls } = cloudflare({ json: { success: true, result: {} } });
    await expect(handleCfApi({ server: 'dev2', method: 'DELETE', path: `/zones/${ZONE}` }, fetch)).rejects.toThrow(
      /zone itself/,
    );
    await expect(
      handleCfApi({ server: 'dev2', method: 'PATCH', path: `/zones/${ZONE}`, body: { paused: true } }, fetch),
    ).rejects.toThrow(/zone itself/);
    await expect(
      handleCfApi({ server: 'dev2', method: 'GET', path: `/zones/${ZONE}/logpush/jobs` }, fetch),
    ).rejects.toThrow(/not a part cf_api reaches/);
    expect(calls).toEqual([]);
    // The zone itself can be read; an operator can add a part.
    await handleCfApi({ server: 'dev2', method: 'GET', path: `/zones/${ZONE}` }, fetch);
    writeConfig({ token: { $secret: 'cf-dev2' }, zones: { 'dev2.example': ZONE }, write: true, parts: ['logpush'] });
    await handleCfApi({ server: 'dev2', method: 'GET', path: `/zones/${ZONE}/logpush/jobs` }, fetch);
    expect(calls).toHaveLength(2);

    const body = { type: 'A', name: 'c.dev2.example', content: '10.0.0.3' };
    await handleCfApi(
      { server: 'dev2', method: 'PUT', path: `/zones/${ZONE}/dns_records/r3`, query: { a: '1' }, body },
      fetch,
    );
    const intent = ledger().find((r) => r.phase === 'intent');
    expect(intent.detail).toMatchObject({ zone: 'dev2.example', path: `/zones/${ZONE}/dns_records/r3`, query: 'a=1' });
    expect(intent.detail.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records a 2xx that says it failed as failed, and an unreadable one as unknown', async () => {
    const said = cloudflare({ json: { success: false, errors: [{ code: 81057, message: 'record exists' }] } });
    await expect(
      handleCfApi({ server: 'dev2', method: 'POST', path: `/zones/${ZONE}/dns_records`, body: {} }, said.fetch),
    ).rejects.toThrow(/81057 record exists/);
    const unreadable: CfFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    });
    await expect(
      handleCfApi({ server: 'dev2', method: 'POST', path: `/zones/${ZONE}/dns_records`, body: {} }, unreadable),
    ).rejects.toThrow(/may have been made/);
    expect(ledger().map((r) => r.phase)).toEqual(['intent', 'failed', 'intent', 'unknown']);
    // trinity R1 (astra): a read whose body cannot be read is a failed read, never an empty answer.
    await expect(
      handleCfApi({ server: 'dev2', method: 'GET', path: `/zones/${ZONE}/dns_records` }, unreadable),
    ).rejects.toThrow(/unreadable/);
    // An empty 204 is an answer.
    const empty: CfFetch = async () => ({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error('no body');
      },
    });
    const out = await handleCfApi({ server: 'dev2', method: 'DELETE', path: `/zones/${ZONE}/dns_records/r1` }, empty);
    expect(JSON.parse(out.content[0].text)).toMatchObject({ status: 204, body: null });
  });

  it('says a write that got no answer may have been made', async () => {
    const { fetch } = cloudflare({ throws: true });
    await expect(
      handleCfApi({ server: 'dev2', method: 'DELETE', path: `/zones/${ZONE}/dns_records/r9` }, fetch),
    ).rejects.toThrow(/may have been made/);
    expect(ledger().map((r) => r.phase)).toEqual(['intent', 'unknown']);
  });

  it('refuses another zone, tokens, users and members, account paths, and unsafe paths, without calling', async () => {
    const { fetch, calls } = cloudflare();
    const refuse = (p: unknown, method = 'GET', extra: Record<string, unknown> = {}) =>
      handleCfApi({ server: 'dev2', method, path: p, ...extra }, fetch);
    await expect(refuse(`/zones/${OTHER_ZONE}/dns_records`)).rejects.toThrow(/not one of this environment's zones/);
    await expect(refuse('/user/tokens')).rejects.toThrow(/zones/);
    await expect(refuse('/accounts/abc/tokens')).rejects.toThrow(/zones/);
    await expect(refuse(`/zones/${ZONE}/access/apps/x/tokens`)).rejects.toThrow(/never reachable/);
    await expect(refuse(`/zones/${ZONE}/members`)).rejects.toThrow(/never reachable/);
    await expect(refuse(`/zones/${ZONE}/../x`)).rejects.toThrow(/path/);
    await expect(refuse(`/zones/${ZONE}/dns_records?name=x`)).rejects.toThrow(/path/);
    await expect(refuse(`/zones/${ZONE}/%2e%2e`)).rejects.toThrow(/path/);
    await expect(refuse(`zones/${ZONE}`)).rejects.toThrow(/path/);
    await expect(refuse(`/zones/${ZONE}/dns_records`, 'TRACE')).rejects.toThrow(/method/);
    await expect(refuse(`/zones/${ZONE}/dns_records`, 'GET', { body: { a: 1 } })).rejects.toThrow(/body/);
    await expect(refuse(`/zones/${ZONE}/dns_records`, 'GET', { query: { a: { b: 1 } } })).rejects.toThrow(/query/);
    await expect(handleCfApi({ server: 'nocf', method: 'GET', path: `/zones/${ZONE}` }, fetch)).rejects.toThrow(
      /no cloudflare/,
    );
    // A token written into config.json is not used: the section is left out.
    await expect(handleCfApi({ server: 'plain', method: 'GET', path: `/zones/${ZONE}` }, fetch)).rejects.toThrow(
      /no cloudflare/,
    );
    delete process.env.SOMA_REQUESTER;
    await expect(refuse(`/zones/${ZONE}/dns_records`, 'POST', { body: {} })).rejects.toThrow(/no requester/);
    expect(calls).toEqual([]);
  });

  it("says Cloudflare's status and errors on a refusal, never the token", async () => {
    const { fetch } = cloudflare({
      status: 403,
      json: { success: false, errors: [{ code: 10000, message: `Authentication error for ${TOKEN}` }] },
    });
    const err = await handleCfApi({ server: 'dev2', method: 'GET', path: `/zones/${ZONE}/settings` }, fetch).catch(
      (e: Error) => e,
    );
    expect(String(err)).toMatch(/answered 403: 10000 Authentication error/);
    expect(String(err)).not.toContain(TOKEN);
  });
});
