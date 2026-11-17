/**
 * cf_api deploy sources: a Worker's modules (`form.files[].source`) and static assets (`assets`) read from a GitHub
 * branch the account entry lists (`sources`), at one commit, with the server's GitHub token — so a deploy does not
 * have to carry megabytes in the tool call. Static assets go through Cloudflare's upload session inside the tool; the
 * session and completion tokens are never handed back.
 */

import { createHash } from 'node:crypto';
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-cf-sources-'));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SECRETS = path.join(ROOT, 'secrets');
const AUDIT = path.join(ROOT, 'data', 'env-audit');
const CF_TOKEN = 'cf-hq-token-81';
const GH_TOKEN = 'gh-env-token-27';
const HQ = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const CF = 'https://api.cloudflare.com/client/v4';
const GH = 'https://api.github.com';
const SCRIPT = `/accounts/${HQ}/workers/scripts/site`;
const saved = { ...process.env };

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function writeConfig(account: Record<string, unknown> = {}, server: Record<string, unknown> = {}) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      'server-tools': {
        dev2: {
          envUser: 'env:acme-dev2',
          ssh: { host: 'dev2' },
          github: { token: { $secret: 'gh' }, repos: ['acme/app'] },
          cloudflare: {
            accounts: {
              'iq-hq': {
                token: { $secret: 'cf-hq' },
                id: HQ,
                reach: 'account',
                write: true,
                sources: { 'acme/site': ['main'] },
                ...account,
              },
            },
          },
          ...server,
        },
      },
    }),
  );
  resetConfigCache();
  loadConfig();
}

beforeEach(() => {
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(SECRETS, 'cf-hq'), `${CF_TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(SECRETS, 'gh'), `${GH_TOKEN}\n`, { mode: 0o600 });
  process.env.SOMA_CONFIG_FILE = CONFIG_FILE;
  process.env.SOMA_SECRETS_DIR = SECRETS;
  process.env.SOMA_AUDIT_DIR = AUDIT;
  process.env.SOMA_REQUESTER = 'U123';
  writeConfig();
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
});

/** The repository at COMMIT: files by path. */
const REPO: Record<string, Buffer> = {
  'cloud/src/worker.mjs': Buffer.from('import { a } from "./a.mjs"; export default { fetch() { return a; } };'),
  'cloud/src/a.mjs': Buffer.from('export const a = new Response("ok");'),
  'static/index.html': Buffer.from('<!doctype html><title>x</title>'),
  'static/media/sound.mp3': Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01]),
};

interface Call {
  url: string;
  method: string;
  auth?: string;
  accept?: string;
  body?: unknown;
}

function world(
  opts: {
    buckets?: string[][] | 'all' | 'each';
    uploadStatus?: number;
    tree?: { path: string; mode: string; type: string; size?: number }[];
    truncated?: boolean;
    files?: Record<string, Buffer>;
    onSession?: () => void;
  } = {},
) {
  const calls: Call[] = [];
  const ok = (json: unknown, status = 200) => ({
    ok: status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  });
  const files = opts.files ?? REPO;
  const dirs = new Set(
    Object.keys(files).flatMap((p) =>
      p
        .split('/')
        .slice(0, -1)
        .map((_, i, a) => a.slice(0, i + 1).join('/')),
    ),
  );
  const tree = opts.tree ?? [
    ...[...dirs].map((p) => ({ path: p, mode: '040000', type: 'tree' })),
    ...Object.entries(files).map(([p, b]) => ({ path: p, mode: '100644', type: 'blob', size: b.length })),
  ];
  let uploads = 0;
  let total = 0;
  const fetch: CfFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      auth: init.headers.Authorization,
      accept: init.headers.Accept,
      body: init.body,
    });
    if (url === `${GH}/repos/acme/site/branches/main`) return ok({ name: 'main', commit: { sha: COMMIT } });
    if (url === `${GH}/repos/acme/site/git/trees/${COMMIT}?recursive=1`)
      return ok({ sha: COMMIT, tree, truncated: opts.truncated ?? false });
    const content = /^https:\/\/api\.github\.com\/repos\/acme\/site\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(url);
    if (content) {
      const p = decodeURIComponent(content[1]);
      if (init.headers.Accept === 'application/vnd.github.raw') {
        const bytes = files[p];
        if (!bytes) return ok({ message: `Not Found for ${GH_TOKEN}` }, 404);
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        };
      }
      return ok({ message: 'Not Found' }, 404);
    }
    if (url === `${CF}${SCRIPT}/assets-upload-session`) {
      opts.onSession?.();
      const manifest = JSON.parse(String(init.body)).manifest as Record<string, { hash: string }>;
      const hashes = Object.values(manifest).map((m) => m.hash);
      const buckets =
        opts.buckets === 'each'
          ? hashes.map((h) => [h])
          : opts.buckets === 'all' || opts.buckets === undefined
            ? [hashes]
            : opts.buckets;
      total = buckets.length;
      return ok({ success: true, result: { jwt: 'JWT-SESSION-1', buckets } });
    }
    if (url === `${CF}/accounts/${HQ}/workers/assets/upload?base64=true`) {
      uploads++;
      if (opts.uploadStatus && opts.uploadStatus >= 300) {
        return ok({ success: false, errors: [{ code: 1, message: 'boom JWT-SESSION-1' }] }, opts.uploadStatus);
      }
      // Only the last bucket's answer carries the completion token.
      return uploads === total
        ? ok({ success: true, result: { jwt: 'JWT-DONE-2' } }, 201)
        : ok({ success: true, result: {} }, 202);
    }
    if (url === `${CF}${SCRIPT}`) return ok({ success: true, result: { id: 'site' } });
    return ok({ success: false, errors: [{ code: 404, message: `unexpected ${url}` }] }, 404);
  };
  return { fetch, calls, uploads: () => uploads };
}

const ledger = () =>
  fs.existsSync(path.join(AUDIT, 'env-audit.jsonl'))
    ? fs
        .readFileSync(path.join(AUDIT, 'env-audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const metadata = JSON.stringify({ main_module: 'worker.mjs', compatibility_date: '2026-11-01' });
const modules = [
  { name: 'worker.mjs', filename: 'worker.mjs', type: 'application/javascript+module', source: 'cloud/src/worker.mjs' },
  { name: 'a.mjs', filename: 'a.mjs', type: 'application/javascript+module', source: 'cloud/src/a.mjs' },
];
const deploy = (fetch: CfFetch, extra: Record<string, unknown> = {}) =>
  handleCfApi(
    {
      server: 'dev2',
      account: 'iq-hq',
      method: 'PUT',
      path: SCRIPT,
      form: { repo: { repo: 'acme/site', ref: 'main' }, fields: { metadata }, files: modules },
      ...extra,
    },
    fetch,
  );
const hashOf = (bytes: Buffer, ext: string) =>
  createHash('sha256')
    .update(bytes.toString('base64') + ext)
    .digest('hex')
    .slice(0, 32);

describe('cf_api sources — Worker modules from a repository branch', () => {
  it('reads each module at one commit with the GitHub token and uploads it with the Cloudflare token', async () => {
    const { fetch, calls } = world();
    await deploy(fetch);
    const github = calls.filter((c) => c.url.startsWith(GH));
    expect(github.map((c) => c.url)).toEqual([
      `${GH}/repos/acme/site/branches/main`,
      `${GH}/repos/acme/site/contents/cloud/src/worker.mjs?ref=${COMMIT}`,
      `${GH}/repos/acme/site/contents/cloud/src/a.mjs?ref=${COMMIT}`,
    ]);
    expect(github.every((c) => c.auth === `Bearer ${GH_TOKEN}`)).toBe(true);
    const put = calls.find((c) => c.url === `${CF}${SCRIPT}`) as Call;
    expect(put.auth).toBe(`Bearer ${CF_TOKEN}`);
    const form = put.body as FormData;
    expect(await (form.get('worker.mjs') as File).text()).toBe(REPO['cloud/src/worker.mjs'].toString());
    expect(await (form.get('a.mjs') as File).text()).toBe(REPO['cloud/src/a.mjs'].toString());
    const intent = ledger().find((r) => r.phase === 'intent');
    expect(intent.detail.source).toEqual({ repo: 'acme/site', ref: 'main', commit: COMMIT });
    expect(JSON.stringify(ledger())).not.toContain(GH_TOKEN);
  });

  it('refuses a repository or branch the account does not list, a path out of the repository, and mixed content', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [
        { form: { repo: { repo: 'acme/other', ref: 'main' }, fields: { metadata }, files: modules } },
        /not a source of account iq-hq/,
      ],
      [
        { form: { repo: { repo: 'acme/site', ref: 'dev' }, fields: { metadata }, files: modules } },
        /dev is not a branch/,
      ],
      [
        {
          form: {
            repo: { repo: 'acme/site', ref: 'main' },
            fields: { metadata },
            files: [{ ...modules[0], source: '../secrets' }],
          },
        },
        /not a plain path/,
      ],
      [
        {
          form: {
            repo: { repo: 'acme/site', ref: 'main' },
            fields: { metadata },
            files: [{ ...modules[0], text: 'x' }],
          },
        },
        /source, text or base64/,
      ],
      [{ form: { fields: { metadata }, files: modules } }, /needs form.repo/],
    ];
    for (const [extra, error] of cases) {
      const { fetch, calls } = world();
      await expect(deploy(fetch, extra)).rejects.toThrow(error);
      expect(calls.filter((c) => c.url.startsWith(CF))).toEqual([]);
    }
    expect(ledger()).toEqual([]);
  });

  it('reads nothing from GitHub for a call it refuses anyway', async () => {
    for (const [extra, account] of [
      [{ method: 'GET' }, {}],
      [{ path: `/accounts/${HQ}/tokens` }, {}],
      [{}, { write: false }],
    ] as [Record<string, unknown>, Record<string, unknown>][]) {
      writeConfig(account);
      const { fetch, calls } = world();
      await expect(deploy(fetch, extra)).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  });

  it("needs the server's GitHub token, and never hands it back in an error", async () => {
    writeConfig({}, { github: undefined });
    const none = world();
    await expect(deploy(none.fetch)).rejects.toThrow(/no github section/);
    expect(none.calls).toEqual([]);
    writeConfig();
    const missing = world();
    const err = await deploy(missing.fetch, {
      form: {
        repo: { repo: 'acme/site', ref: 'main' },
        fields: { metadata },
        files: [{ ...modules[0], source: 'nope.mjs' }],
      },
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/answered 404/);
    expect(String(err)).not.toContain(GH_TOKEN);
    expect(missing.calls.filter((c) => c.url.startsWith(CF))).toEqual([]);
  });

  it("lists each account's sources", () => {
    const out = JSON.parse(handleList().content[0].text);
    expect(out.servers[0].cloudflare[0].sources).toEqual({ 'acme/site': ['main'] });
  });
});

describe('cf_api sources — static assets', () => {
  const assets = { dir: 'static', config: { html_handling: 'auto-trailing-slash' } };

  it('uploads a directory as static assets and attaches them to the script, never handing a token back', async () => {
    const { fetch, calls } = world();
    const out = await deploy(fetch, { assets });
    const session = calls.find((c) => c.url.endsWith('/assets-upload-session')) as Call;
    expect(session.auth).toBe(`Bearer ${CF_TOKEN}`);
    expect(JSON.parse(String(session.body)).manifest).toEqual({
      '/index.html': { hash: hashOf(REPO['static/index.html'], 'html'), size: REPO['static/index.html'].length },
      '/media/sound.mp3': { hash: hashOf(REPO['static/media/sound.mp3'], 'mp3'), size: 5 },
    });
    const upload = calls.find((c) => c.url.includes('/workers/assets/upload')) as Call;
    expect(upload.auth).toBe('Bearer JWT-SESSION-1');
    const part = (upload.body as FormData).get(hashOf(REPO['static/media/sound.mp3'], 'mp3')) as File;
    expect(part.type).toBe('audio/mpeg');
    expect(await part.text()).toBe(REPO['static/media/sound.mp3'].toString('base64'));
    const put = calls.find((c) => c.url === `${CF}${SCRIPT}`) as Call;
    expect(JSON.parse(String((put.body as FormData).get('metadata')))).toEqual({
      main_module: 'worker.mjs',
      compatibility_date: '2026-11-01',
      assets: { jwt: 'JWT-DONE-2', config: { html_handling: 'auto-trailing-slash' } },
    });
    // Assets are uploaded after the intent line and before the script.
    const order = calls.filter((c) => c.url.startsWith(CF)).map((c) => c.url.replace(CF, ''));
    expect(order).toEqual([
      `${SCRIPT}/assets-upload-session`,
      `/accounts/${HQ}/workers/assets/upload?base64=true`,
      SCRIPT,
    ]);
    expect(out.content[0].text).not.toMatch(/JWT-/);
    expect(JSON.stringify(ledger())).not.toMatch(/JWT-/);
    expect(ledger().find((r) => r.phase === 'intent').detail.assets).toMatchObject({ files: 2, bytes: 36 });
  });

  it('skips the upload when Cloudflare already has every file, and attaches with the session token', async () => {
    const { fetch, calls, uploads } = world({ buckets: [] });
    await deploy(fetch, { assets });
    expect(uploads()).toBe(0);
    const put = calls.find((c) => c.url === `${CF}${SCRIPT}`) as Call;
    expect(JSON.parse(String((put.body as FormData).get('metadata'))).assets.jwt).toBe('JWT-SESSION-1');
  });

  it('never sends the script when an upload fails, records it failed, and keeps the tokens out of the error', async () => {
    const { fetch, calls } = world({ uploadStatus: 500 });
    const err = await deploy(fetch, { assets }).catch((e: Error) => e);
    expect(String(err)).toMatch(/assets upload answered 500: .*the script was not sent/);
    expect(String(err)).not.toMatch(/JWT-SESSION-1/);
    expect(calls.some((c) => c.url === `${CF}${SCRIPT}`)).toBe(false);
    expect(ledger().map((r) => r.phase)).toEqual(['intent', 'failed']);
  });

  it('refuses assets with keep_assets or assets in the metadata, off a script upload, or from a symbolic link', async () => {
    for (const [extra, error] of [
      [
        {
          form: {
            repo: { repo: 'acme/site', ref: 'main' },
            fields: { metadata: '{"keep_assets":true}' },
            files: modules,
          },
        },
        /leave assets and keep_assets out/,
      ],
      [{ method: 'POST', path: `/accounts/${HQ}/d1/database` }, /assets go only with PUT/],
    ] as [Record<string, unknown>, RegExp][]) {
      const { fetch, calls } = world();
      await expect(deploy(fetch, { assets, ...extra })).rejects.toThrow(error);
      expect(calls).toEqual([]);
    }
    const linked = world({ tree: [{ path: 'static/link', mode: '120000', type: 'blob', size: 5 }] });
    await expect(deploy(linked.fetch, { assets })).rejects.toThrow(/static\/link is a symbolic link/);
    const sub = world({ tree: [{ path: 'static/vendor', mode: '160000', type: 'commit' }] });
    await expect(deploy(sub.fetch, { assets })).rejects.toThrow(/static\/vendor is a submodule/);
    expect(sub.calls.filter((c) => c.url.startsWith(CF))).toEqual([]);
    expect(linked.calls.filter((c) => c.url.startsWith(CF))).toEqual([]);
    expect(ledger()).toEqual([]);
  });
});

// review-of-legends R1 (d165d7e7): a truncated listing, branch-only resolution, the module budget while reading, an
// explicit assets ref, several buckets, and the intent before the first asset write.
describe('cf_api sources — review R1', () => {
  const assets = { dir: 'static' };

  it('refuses a tree GitHub truncated, so assets never deploy with files missing', async () => {
    const { fetch, calls } = world({ truncated: true });
    await expect(deploy(fetch, { assets })).rejects.toThrow(/could not list the whole tree/);
    expect(calls.filter((c) => c.url.startsWith(CF))).toEqual([]);
  });

  it('resolves a source only as a branch: a tag of the same name never stands in', async () => {
    writeConfig({ sources: { 'acme/site': ['v1'] } });
    const { fetch, calls } = world();
    await expect(
      deploy(fetch, { form: { repo: { repo: 'acme/site', ref: 'v1' }, fields: { metadata }, files: modules } }),
    ).rejects.toThrow(/branches\/v1 answered 404/);
    expect(calls.map((c) => c.url)).toEqual([`${GH}/repos/acme/site/branches/v1`]);
  });

  it('stops reading modules once the 10 MiB form budget is spent', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0x61);
    const { fetch, calls } = world({ files: { 'a.mjs': big, 'b.mjs': big } });
    const file = (n: string) => ({ name: n, filename: n, type: 'application/javascript+module', source: n });
    await expect(
      deploy(fetch, {
        form: { repo: { repo: 'acme/site', ref: 'main' }, fields: { metadata }, files: [file('a.mjs'), file('b.mjs')] },
      }),
    ).rejects.toThrow(/b\.mjs is larger than the \d+ bytes left for this call/);
    expect(calls.filter((c) => c.url.startsWith(CF))).toEqual([]);
  });

  it('checks an assets ref given without its repository instead of defaulting it', async () => {
    const { fetch, calls } = world();
    await expect(deploy(fetch, { assets: { ref: 'dev', dir: 'static' } })).rejects.toThrow(/a source is/);
    expect(calls).toEqual([]);
  });

  it('uploads bucket by bucket and attaches with the token from the last answer', async () => {
    const { fetch, calls, uploads } = world({ buckets: 'each' });
    await deploy(fetch, { assets });
    expect(uploads()).toBe(2);
    expect(
      calls.filter((c) => c.url.includes('/workers/assets/upload')).every((c) => c.auth === 'Bearer JWT-SESSION-1'),
    ).toBe(true);
    const put = calls.find((c) => c.url === `${CF}${SCRIPT}`) as Call;
    expect(JSON.parse(String((put.body as FormData).get('metadata'))).assets.jwt).toBe('JWT-DONE-2');
  });

  it('writes the intent line before the first asset is sent', async () => {
    let phases: string[] = [];
    const { fetch } = world({ onSession: () => (phases = ledger().map((r) => r.phase)) });
    await deploy(fetch, { assets });
    expect(phases).toEqual(['intent']);
  });
});
