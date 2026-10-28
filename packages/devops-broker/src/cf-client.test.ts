import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAKE_TOKEN_VALUE_PREFIX,
  type FakeCloudflare,
  type FakeReply,
  startFakeCloudflare,
} from './__fixtures__/fake-cloudflare.js';
import {
  CF_LEASE_TOKENS_FILE,
  CF_LEASES_FILE,
  CfLeaseError,
  type CfLeaseStoreData,
  type CfLeaseTokenData,
  type CloudflareLeases,
  createCloudflareLeases,
  initialCfLeaseStore,
  initialCfLeaseTokens,
  LEASE_TOKEN_PREFIX,
  type LeaseScope,
  type LeaseView,
} from './cf-client.js';
import { Ledger } from './ledger.js';
import { parsePolicy } from './policy.js';
import { StateStore } from './state.js';

const ACCOUNT = '00000000000000000000000000000001';
const ZONE_A = '0000000000000000000000000000000a';
const ZONE_B = '0000000000000000000000000000000b';
const ZONE_STAGE = '0000000000000000000000000000000e';
const ZONE_OUTSIDE = '0000000000000000000000000000000c';
const PG_DNS_READ = '000000000000000000000000000000d1';
const PG_DNS_EDIT = '000000000000000000000000000000d2';
const PG_ACCOUNT_READ = '000000000000000000000000000000d3';
const FORGE_KEY = 'fake-forge-key-00000000000000000001';
const APPROVAL = 'approval-0001';
const LEASE_1 = '11111111111111111111111111111111';
const LEASE_2 = '22222222222222222222222222222222';
const LEASE_3 = '33333333333333333333333333333333';
const T0 = Date.parse('2026-10-26T12:00:00.789Z');
const HOUR = 3600;

const policy = parsePolicy({
  admins: ['U000ADMIN'],
  gh: { org: 'example-org', accounts: { member: { login: 'alice', class: 'member' } } },
  cloudflare: {
    dev2: {
      accountId: ACCOUNT,
      zones: { 'example.com': ZONE_A, 'example.net': ZONE_B },
      permissionGroups: { read: [PG_DNS_READ, PG_ACCOUNT_READ], edit: [PG_DNS_READ, PG_DNS_EDIT] },
      maxTtl: '71h',
    },
    // Same account as dev2: the sweeper must list it once.
    stage: {
      accountId: ACCOUNT,
      zones: { 'example.org': ZONE_STAGE },
      permissionGroups: { read: [PG_DNS_READ], edit: [PG_DNS_EDIT] },
      maxTtl: '2h',
    },
  },
});

/** Fails the next `failNext` updates before touching disk, as a full disk or EIO would. */
class FlakyStore<T> extends StateStore<T> {
  failNext = 0;

  override update<R>(fn: (draft: T) => R | Promise<R>): Promise<R> {
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error('EIO simulated'));
    }
    return super.update(fn);
  }
}

/** A ledger whose cf-api rows fail, as a full disk would. */
class CfApiFailingLedger extends Ledger {
  override append(row: { event: string } & Record<string, unknown>): Promise<void> {
    if (row.event === 'cf-api') return Promise.reject(new Error('ENOSPC simulated'));
    return super.append(row);
  }
}

interface Harness {
  dir: string;
  fake: FakeCloudflare;
  leases: CloudflareLeases;
  store: FlakyStore<CfLeaseStoreData>;
  tokenStore: StateStore<CfLeaseTokenData>;
  leasesFile: string;
  tokensFile: string;
  ledgerFile: string;
  clock: { now: number };
  revokeFailures: { lease: LeaseView; error: string }[];
  forgeReads: string[];
  /** Every message of every CfLeaseError a test saw. */
  messages: string[];
  restart(): Promise<CloudflareLeases>;
}

let h: Harness;

async function setup(opts: { blockTokensFile?: boolean; failCfApiRows?: boolean } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-cf-'));
  const clock = { now: T0 };
  const fake = await startFakeCloudflare({
    now: () => clock.now,
    accountId: ACCOUNT,
    forgeKey: FORGE_KEY,
    zones: { [ZONE_A]: 'example.com', [ZONE_B]: 'example.net', [ZONE_STAGE]: 'example.org' },
    permissionGroups: {
      [PG_DNS_READ]: 'DNS Read',
      [PG_DNS_EDIT]: 'DNS Write',
      [PG_ACCOUNT_READ]: 'Account Settings Read',
    },
  });
  const leasesFile = path.join(dir, 'state', CF_LEASES_FILE);
  const tokensFile = path.join(dir, 'state', CF_LEASE_TOKENS_FILE);
  const ledgerFile = path.join(dir, 'state', 'ledger.jsonl');
  if (opts.blockTokensFile) {
    // A directory where the file should be: every atomic write (rename) fails.
    fs.mkdirSync(tokensFile, { recursive: true });
    fs.writeFileSync(path.join(tokensFile, 'occupant'), 'x');
  }
  const revokeFailures: Harness['revokeFailures'] = [];
  const forgeReads: string[] = [];
  const harness = {
    dir,
    fake,
    leasesFile,
    tokensFile,
    ledgerFile,
    clock,
    revokeFailures,
    forgeReads,
    messages: [] as string[],
  } as Harness;
  async function build(): Promise<CloudflareLeases> {
    const store = new FlakyStore<CfLeaseStoreData>(leasesFile, initialCfLeaseStore());
    const tokenStore = new StateStore<CfLeaseTokenData>(tokensFile, initialCfLeaseTokens());
    await store.load();
    if (!opts.blockTokensFile) await tokenStore.load();
    harness.store = store;
    harness.tokenStore = tokenStore;
    return createCloudflareLeases({
      policy,
      readForgeKey: (env) => {
        forgeReads.push(env);
        return FORGE_KEY;
      },
      store,
      tokenStore,
      ledger: opts.failCfApiRows ? new CfApiFailingLedger(ledgerFile) : new Ledger(ledgerFile),
      now: () => clock.now,
      apiBase: fake.apiBase,
      onRevokeFailed: (lease, error) => revokeFailures.push({ lease, error }),
    });
  }
  harness.leases = await build();
  harness.restart = async () => {
    harness.leases = await build();
    return harness.leases;
  };
  return harness;
}

beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.fake.close();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

function scope(over: Partial<LeaseScope> = {}): LeaseScope {
  return { env: 'dev2', access: 'edit', permissionGroupIds: [PG_DNS_EDIT], zoneIds: [ZONE_A], ...over };
}

function mint(leaseId = LEASE_1, over: Partial<LeaseScope> = {}, ttlSeconds = HOUR): Promise<LeaseView> {
  return h.leases.mint({ leaseId, scope: scope(over), ttlSeconds, approvalId: APPROVAL });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CfLeaseError);
    h.messages.push((err as Error).message);
    return (err as CfLeaseError).code;
  }
  throw new Error('expected a CfLeaseError');
}

function ledgerRows(): Record<string, unknown>[] {
  if (!fs.existsSync(h.ledgerFile)) return [];
  return fs
    .readFileSync(h.ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function leaseOnDisk(leaseId: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(h.leasesFile)) return undefined;
  return (JSON.parse(fs.readFileSync(h.leasesFile, 'utf8')) as CfLeaseStoreData).leases[leaseId] as unknown as
    | Record<string, unknown>
    | undefined;
}

function tokensOnDisk(): Record<string, string> {
  if (!fs.existsSync(h.tokensFile)) return {};
  return (JSON.parse(fs.readFileSync(h.tokensFile, 'utf8')) as CfLeaseTokenData).values;
}

function requestsTo(method: string, re: RegExp) {
  return h.fake.requests.filter((r) => r.method === method && re.test(r.path));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mint', () => {
  it('creates the child token with the exact body, persists minting first, and returns an active view', async () => {
    let leaseStateAtPost: unknown;
    h.fake.hook = (req, next) => {
      if (req.method === 'POST' && req.path.endsWith('/tokens')) leaseStateAtPost = leaseOnDisk(LEASE_1)?.state;
      return next();
    };
    const view = await mint(LEASE_1, { zoneIds: [ZONE_A, ZONE_B], permissionGroupIds: [PG_DNS_READ, PG_DNS_EDIT] });
    expect(leaseStateAtPost).toBe('minting');
    expect(view).toEqual({
      leaseId: LEASE_1,
      env: 'dev2',
      access: 'edit',
      zones: [ZONE_A, ZONE_B],
      expiresAt: '2026-10-26T13:00:00Z',
      state: 'active',
    });
    const posts = requestsTo('POST', /^\/accounts\/0+1\/tokens$/);
    expect(posts).toHaveLength(1);
    expect(posts[0].auth).toBe(FORGE_KEY);
    expect(posts[0].body).toEqual({
      name: `soma-lease-${LEASE_1}`,
      policies: [
        {
          effect: 'allow',
          resources: {
            [`com.cloudflare.api.account.zone.${ZONE_A}`]: '*',
            [`com.cloudflare.api.account.zone.${ZONE_B}`]: '*',
          },
          permission_groups: [{ id: PG_DNS_READ }, { id: PG_DNS_EDIT }],
        },
      ],
      not_before: '2026-10-26T12:00:00Z',
      expires_on: '2026-10-26T13:00:00Z',
    });
    const token = [...h.fake.tokens.values()][0];
    expect(leaseOnDisk(LEASE_1)).toMatchObject({
      leaseId: LEASE_1,
      env: 'dev2',
      access: 'edit',
      permissionGroupIds: [PG_DNS_READ, PG_DNS_EDIT],
      zoneIds: [ZONE_A, ZONE_B],
      approvalId: APPROVAL,
      tokenName: `soma-lease-${LEASE_1}`,
      tokenId: token.id,
      state: 'active',
      createdAt: '2026-10-26T12:00:00Z',
      notBefore: '2026-10-26T12:00:00Z',
      expiresAt: '2026-10-26T13:00:00Z',
    });
    expect(tokensOnDisk()).toEqual({ [LEASE_1]: token.value });
    expect(fs.statSync(h.tokensFile).mode & 0o777).toBe(0o600);
    const minted = ledgerRows().filter((row) => row.event === 'cf-lease-minted');
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      leaseId: LEASE_1,
      env: 'dev2',
      scope: { access: 'edit', permissionGroupIds: [PG_DNS_READ, PG_DNS_EDIT], zoneIds: [ZONE_A, ZONE_B] },
      expiresAt: '2026-10-26T13:00:00Z',
    });
    expect(h.forgeReads).toContain('dev2');
  });

  it('scopes an account-level lease to the account resource', async () => {
    await mint(LEASE_1, { access: 'read', permissionGroupIds: [PG_ACCOUNT_READ], zoneIds: [] }, 90 * 60);
    const [post] = requestsTo('POST', /\/tokens$/);
    expect(post.body).toMatchObject({
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
          permission_groups: [{ id: PG_ACCOUNT_READ }],
        },
      ],
      expires_on: '2026-10-26T13:30:00Z',
    });
  });

  const refusedMints: [string, Partial<LeaseScope>, number, string][] = [
    ['ttl 72h (past the 71h ceiling)', {}, 72 * HOUR, 'policy-denied'],
    ["ttl 3h (past this env's 2h maxTtl)", { env: 'stage', zoneIds: [ZONE_STAGE] }, 3 * HOUR, 'policy-denied'],
    ['ttl under a minute', {}, 59, 'bad-request'],
    ['fractional ttl', {}, 120.5, 'bad-request'],
    ['unknown env', { env: 'prod' }, HOUR, 'unknown-env'],
    ['prototype key as env', { env: 'constructor' }, HOUR, 'unknown-env'],
    ['zone outside the policy', { zoneIds: [ZONE_OUTSIDE] }, HOUR, 'lease-out-of-scope'],
    ["another env's zone", { zoneIds: [ZONE_STAGE] }, HOUR, 'lease-out-of-scope'],
    ['edit group on a read lease', { access: 'read', permissionGroupIds: [PG_DNS_EDIT] }, HOUR, 'lease-out-of-scope'],
    ['no permission groups', { permissionGroupIds: [] }, HOUR, 'bad-request'],
    ['duplicate zone', { zoneIds: [ZONE_A, ZONE_A] }, HOUR, 'bad-request'],
  ];
  it.each(refusedMints)('refuses %s before any request or state write', async (_name, over, ttl, code) => {
    expect(await refusal(mint(LEASE_1, over, ttl))).toBe(code);
    expect(h.fake.requests).toHaveLength(0);
    expect(leaseOnDisk(LEASE_1)).toBeUndefined();
    expect(h.leases.list()).toEqual([]);
  });

  it('refuses a malformed or reused lease id', async () => {
    expect(await refusal(mint('not-a-lease-id'))).toBe('bad-request');
    await mint(LEASE_1);
    expect(await refusal(mint(LEASE_1))).toBe('bad-request');
    expect(requestsTo('POST', /\/tokens$/)).toHaveLength(1);
  });

  it('marks mint_failed and throws upstream-error when Cloudflare refuses', async () => {
    h.fake.hook = (req) =>
      req.method === 'POST'
        ? { status: 400, body: { success: false, errors: [{ code: 1001, message: 'quota reached' }], result: null } }
        : undefined;
    expect(await refusal(mint())).toBe('upstream-error');
    expect(leaseOnDisk(LEASE_1)).toMatchObject({ state: 'mint_failed' });
    expect(String(leaseOnDisk(LEASE_1)?.lastError)).toContain('400');
    expect(ledgerRows().map((row) => row.event)).toContain('cf-lease-mint-failed');
    expect(h.leases.list()[0].state).toBe('mint_failed');
  });
});

describe('call', () => {
  it('relays an in-scope call with the lease key and ledgers it without the body', async () => {
    await mint();
    const result = await h.leases.call(
      LEASE_1,
      { method: 'POST', path: `/zones/${ZONE_A}/dns_records`, body: { type: 'TXT', name: 'probe', content: 'x' } },
      { sessionKey: 'C000/171.000' },
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, result: { type: 'TXT', name: 'probe' } });
    const listed = await h.leases.call(
      LEASE_1,
      { method: 'GET', path: `/zones/${ZONE_A}/dns_records`, query: { type: 'TXT', per_page: '5' } },
      { sessionKey: 'C000/171.000' },
    );
    expect((listed.body as { result: unknown[] }).result).toHaveLength(1);
    const [post, get] = h.fake.requests.filter((r) => r.path.startsWith('/zones'));
    const token = [...h.fake.tokens.values()][0];
    expect(post.auth).toBe(token.value);
    expect(get.query).toEqual({ type: 'TXT', per_page: '5' });
    const rows = ledgerRows().filter((row) => row.event === 'cf-api');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      leaseId: LEASE_1,
      method: 'POST',
      path: `/zones/${ZONE_A}/dns_records`,
      status: 200,
      sessionKey: 'C000/171.000',
    });
    expect(JSON.stringify(rows)).not.toContain('probe');
  });

  it('refuses a zone outside the lease without contacting Cloudflare', async () => {
    await mint();
    const before = h.fake.requests.length;
    for (const zone of [ZONE_B, ZONE_OUTSIDE]) {
      expect(
        await refusal(
          h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${zone}/dns_records` }, { sessionKey: 's' }),
        ),
      ).toBe('lease-out-of-scope');
    }
    expect(await refusal(h.leases.call(LEASE_1, { method: 'POST', path: '/zones' }, { sessionKey: 's' }))).toBe(
      'lease-out-of-scope',
    );
    expect(
      await refusal(
        h.leases.call(LEASE_1, { method: 'GET', path: `/accounts/${ACCOUNT}/workers` }, { sessionKey: 's' }),
      ),
    ).toBe('lease-out-of-scope');
    expect(h.fake.requests.length).toBe(before);
    expect(ledgerRows().filter((row) => row.event === 'cf-api-refused')).toHaveLength(4);
    // GET /zones is allowed for a zone lease: Cloudflare filters it to the lease's zones.
    const zones = await h.leases.call(LEASE_1, { method: 'GET', path: '/zones' }, { sessionKey: 's' });
    expect(zones.body).toMatchObject({ result: [{ id: ZONE_A }] });
  });

  it('allows only GET on a read lease', async () => {
    await mint(LEASE_1, { access: 'read', permissionGroupIds: [PG_DNS_READ] });
    const before = h.fake.requests.length;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(
        await refusal(
          h.leases.call(
            LEASE_1,
            { method, path: `/zones/${ZONE_A}/dns_records`, body: undefined },
            { sessionKey: 's' },
          ),
        ),
      ).toBe('lease-out-of-scope');
    }
    expect(h.fake.requests.length).toBe(before);
    const ok = await h.leases.call(
      LEASE_1,
      { method: 'GET', path: `/zones/${ZONE_A}/dns_records` },
      { sessionKey: 's' },
    );
    expect(ok.status).toBe(200);
  });

  it('keeps an account-level lease inside its account', async () => {
    await mint(LEASE_1, { access: 'read', permissionGroupIds: [PG_ACCOUNT_READ], zoneIds: [] });
    const ok = await h.leases.call(
      LEASE_1,
      { method: 'GET', path: `/accounts/${ACCOUNT}/workers/scripts` },
      { sessionKey: 's' },
    );
    expect(ok.status).toBe(200);
    const before = h.fake.requests.length;
    for (const p of [`/accounts/${'0'.repeat(31)}9/workers/scripts`, `/zones/${ZONE_A}/dns_records`, '/zones']) {
      expect(await refusal(h.leases.call(LEASE_1, { method: 'GET', path: p }, { sessionKey: 's' }))).toBe(
        'lease-out-of-scope',
      );
    }
    expect(h.fake.requests.length).toBe(before);
  });

  it('always refuses token, user, and membership paths', async () => {
    await mint(LEASE_1, { zoneIds: [] });
    await mint(LEASE_2, { zoneIds: [ZONE_A] });
    const before = h.fake.requests.length;
    const paths = [
      `/accounts/${ACCOUNT}/tokens`,
      `/accounts/${ACCOUNT}/tokens/verify`,
      `/accounts/${ACCOUNT}/tokens/permission_groups`,
      `/accounts/${ACCOUNT}/Tokens`,
      `/accounts/${ACCOUNT}/members`,
      `/accounts/${ACCOUNT}/access/service_tokens`,
      `/accounts/${ACCOUNT}/api_tokens`,
      '/accounts',
      '/user/tokens',
      '/user',
      '/users',
      '/memberships',
    ];
    for (const leaseId of [LEASE_1, LEASE_2]) {
      for (const p of paths) {
        expect(await refusal(h.leases.call(leaseId, { method: 'GET', path: p }, { sessionKey: 's' }))).toBe(
          'policy-denied',
        );
      }
    }
    expect(h.fake.requests.length).toBe(before);
  });

  it.each([
    `/zones/${ZONE_A}/../${ZONE_B}/dns_records`,
    `/zones/${ZONE_A}/dns_records/..`,
    `/zones/${ZONE_A}%2F..%2F${ZONE_B}/dns_records`,
    `/zones/${ZONE_A}/dns_records?type=A`,
    `/zones/${ZONE_A}/dns_records#x`,
    `/zones//${ZONE_A}/dns_records`,
    `/zones/${ZONE_A}\\dns_records`,
    `/zones/${ZONE_A}/dns records`,
    `/zones/${ZONE_A}/dns_records\n`,
    `/zones/${ZONE_A}/./dns_records`,
    `/zones/${ZONE_A}/dns_records/`,
    `zones/${ZONE_A}/dns_records`,
    '/',
    '',
  ])('refuses the malformed path %j', async (p) => {
    await mint();
    const before = h.fake.requests.length;
    expect(await refusal(h.leases.call(LEASE_1, { method: 'GET', path: p }, { sessionKey: 's' }))).toBe('bad-request');
    expect(h.fake.requests.length).toBe(before);
  });

  it('refuses prototype keys in the query and bodies on GET or past 256 KB', async () => {
    await mint();
    const before = h.fake.requests.length;
    const dns = `/zones/${ZONE_A}/dns_records`;
    for (const query of [JSON.parse('{"__proto__":"x"}'), { constructor: 'x' }, { 'a b': 'x' }, { a: 'x\ny' }]) {
      expect(await refusal(h.leases.call(LEASE_1, { method: 'GET', path: dns, query }, { sessionKey: 's' }))).toBe(
        'bad-request',
      );
    }
    expect(
      await refusal(h.leases.call(LEASE_1, { method: 'GET', path: dns, body: { a: 1 } }, { sessionKey: 's' })),
    ).toBe('bad-request');
    expect(
      await refusal(h.leases.call(LEASE_1, { method: 'DELETE', path: dns, body: { a: 1 } }, { sessionKey: 's' })),
    ).toBe('bad-request');
    const big = { content: 'x'.repeat(256 * 1024) };
    expect(await refusal(h.leases.call(LEASE_1, { method: 'POST', path: dns, body: big }, { sessionKey: 's' }))).toBe(
      'bad-request',
    );
    expect(h.fake.requests.length).toBe(before);
  });

  it('caps the response at 1 MB and scrubs the lease key and the forge key', async () => {
    await mint();
    const token = [...h.fake.tokens.values()][0];
    h.fake.hook = (req): FakeReply | undefined => {
      if (req.path.endsWith('/echo')) {
        return { status: 200, body: { success: true, result: { seen: req.auth, forge: FORGE_KEY } } };
      }
      // The lease key straddles the 1 MB cut: its first 10 characters are the last ones kept.
      if (req.path.endsWith('/big')) return { status: 200, body: `${'y'.repeat(1024 * 1024 - 10)}${token.value}zzz` };
      return undefined;
    };
    const echo = await h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/echo` }, { sessionKey: 's' });
    expect(echo.truncated).toBe(false);
    expect(echo.body).toEqual({ success: true, result: { seen: '<redacted>', forge: '<redacted>' } });
    const big = await h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/big` }, { sessionKey: 's' });
    expect(big.truncated).toBe(true);
    expect(typeof big.body).toBe('string');
    expect((big.body as string).length).toBeLessThanOrEqual(1024 * 1024 + '<redacted>'.length);
    expect(big.body as string).not.toContain(token.value.slice(0, 10));
    expect((big.body as string).endsWith('<redacted>')).toBe(true);
  });

  it('scrubs a base64-encoded lease key from the response', async () => {
    await mint();
    const token = [...h.fake.tokens.values()][0];
    const whole = Buffer.from(token.value).toString('base64');
    const embedded = Buffer.from(`user:${token.value}:x`).toString('base64');
    h.fake.hook = (req): FakeReply | undefined =>
      req.path.endsWith('/encoded') ? { status: 200, body: { success: true, result: { whole, embedded } } } : undefined;
    const res = await h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/encoded` }, { sessionKey: 's' });
    const result = (res.body as { result: { whole: string; embedded: string } }).result;
    expect(result.whole).toBe('<redacted>');
    expect(result.embedded).toContain('<redacted>');
    expect(Buffer.from(result.embedded, 'base64').toString('latin1')).not.toContain(token.value);
    expect(JSON.stringify(res.body)).not.toContain(whole.replace(/=+$/, ''));
  });

  it('revokes an expired lease and answers lease-expired', async () => {
    await mint();
    h.clock.now = T0 + HOUR * 1000;
    expect(
      await refusal(
        h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/dns_records` }, { sessionKey: 's' }),
      ),
    ).toBe('lease-expired');
    expect(h.fake.requests.filter((r) => r.path.startsWith('/zones'))).toHaveLength(0);
    expect(h.fake.tokens.size).toBe(0);
    expect(leaseOnDisk(LEASE_1)).toMatchObject({ state: 'revoked', revokedAt: '2026-10-26T13:00:00Z' });
    expect(tokensOnDisk()).toEqual({});
    expect(
      await refusal(
        h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/dns_records` }, { sessionKey: 's' }),
      ),
    ).toBe('lease-expired');
  });

  it('answers lease-not-found for an unknown lease', async () => {
    expect(await refusal(h.leases.call(LEASE_3, { method: 'GET', path: '/zones' }, { sessionKey: 's' }))).toBe(
      'lease-not-found',
    );
    expect(await refusal(h.leases.call('__proto__', { method: 'GET', path: '/zones' }, { sessionKey: 's' }))).toBe(
      'lease-not-found',
    );
  });

  it('does not let a failed cf-api ledger row change an outcome that already happened', async () => {
    await h.fake.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
    h = await setup({ failCfApiRows: true });
    await mint();
    const dns = `/zones/${ZONE_A}/dns_records`;
    const posted = await h.leases.call(
      LEASE_1,
      { method: 'POST', path: dns, body: { type: 'TXT', name: 'probe', content: 'x' } },
      { sessionKey: 's' },
    );
    expect(posted.status).toBe(200);
    h.fake.hook = (req) => (req.path === dns ? { status: 0, body: null, drop: true } : undefined);
    expect(
      await refusal(h.leases.call(LEASE_1, { method: 'PATCH', path: dns, body: { a: 1 } }, { sessionKey: 's' })),
    ).toBe('result-unknown');
    expect(await refusal(h.leases.call(LEASE_1, { method: 'GET', path: dns }, { sessionKey: 's' }))).toBe(
      'upstream-error',
    );
    expect(requestsTo('POST', /dns_records$/)).toHaveLength(1);
    expect(ledgerRows().filter((row) => row.event === 'cf-api')).toHaveLength(0);
    expect(ledgerRows().some((row) => row.event === 'cf-lease-minted')).toBe(true);
  });

  it('scrubs keys inside parsed JSON strings and object keys, and in non-JSON text', async () => {
    await mint();
    const token = [...h.fake.tokens.values()][0];
    const escaped = [...token.value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    let slashed = '';
    for (let i = 0; i < 256 && !slashed.includes('/'); i++) {
      slashed = Buffer.concat([Buffer.from([i]), Buffer.from(token.value)]).toString('base64');
    }
    expect(slashed).toContain('/');
    const raw =
      `{"success":true,"result":{"u":"${escaped}","b":"${slashed.replace(/\//g, '\\/')}",` +
      `"${escaped}":1,"__proto__":{"polluted":1}}}`;
    h.fake.hook = (req): FakeReply | undefined => {
      if (req.path.endsWith('/escaped')) return { status: 200, body: raw };
      if (req.path.endsWith('/plain')) return { status: 200, body: `key=${token.value}` };
      return undefined;
    };
    const res = await h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/escaped` }, { sessionKey: 's' });
    expect(JSON.stringify(res.body)).not.toContain(token.value);
    const result = (res.body as { result: Record<string, unknown> }).result;
    expect(result.u).toBe('<redacted>');
    expect(Buffer.from(String(result.b), 'base64').toString('latin1')).not.toContain(token.value);
    expect(Object.keys(result)).toEqual(['u', 'b', '<redacted>', '__proto__']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as { polluted?: unknown }).polluted).toBeUndefined();
    const plain = await h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/plain` }, { sessionKey: 's' });
    expect(plain.body).toBe('key=<redacted>');
  });

  it('falls back to text scrubbing for JSON nested too deeply to walk', async () => {
    await mint();
    const token = [...h.fake.tokens.values()][0];
    const deep = `${'['.repeat(200_000)}"${token.value}"${']'.repeat(200_000)}`;
    h.fake.hook = (req): FakeReply | undefined =>
      req.path.endsWith('/deep') ? { status: 200, body: deep } : undefined;
    const res = await h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/deep` }, { sessionKey: 's' });
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('string');
    expect(res.body as string).not.toContain(token.value);
    expect(res.body as string).toContain('<redacted>');
  });

  it('keeps working after a restart from the 0600 key file', async () => {
    await mint();
    const leases = await h.restart();
    const result = await leases.call(
      LEASE_1,
      { method: 'GET', path: `/zones/${ZONE_A}/dns_records` },
      { sessionKey: 's' },
    );
    expect(result.status).toBe(200);
  });
});

describe('revoke', () => {
  it('deletes with the forge key and confirms with a GET 404, never the lease verify', async () => {
    await mint();
    const token = [...h.fake.tokens.values()][0];
    const view = await h.leases.revoke(LEASE_1, 'requested');
    expect(view.state).toBe('revoked');
    const tokenPath = `/accounts/${ACCOUNT}/tokens/${token.id}`;
    const del = requestsTo('DELETE', /./);
    const get = requestsTo('GET', new RegExp(`^${tokenPath}$`));
    expect(del.map((r) => [r.path, r.auth])).toEqual([[tokenPath, FORGE_KEY]]);
    expect(get.map((r) => r.auth)).toEqual([FORGE_KEY]);
    expect(h.fake.requests.some((r) => r.path.includes('verify') || r.auth === token.value)).toBe(false);
    expect(tokensOnDisk()).toEqual({});
    expect(ledgerRows().find((row) => row.event === 'cf-lease-revoked')).toMatchObject({
      leaseId: LEASE_1,
      reason: 'requested',
    });
    expect(
      await refusal(
        h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/dns_records` }, { sessionKey: 's' }),
      ),
    ).toBe('lease-expired');
    expect((await h.leases.revoke(LEASE_1, 'again')).state).toBe('revoked');
    expect(requestsTo('DELETE', /./)).toHaveLength(1);
  });

  it('marks revoke_failed and notifies once when the key still exists after DELETE', async () => {
    await mint();
    h.fake.hook = (req) =>
      req.method === 'DELETE' ? { status: 200, body: { success: true, result: { id: 'x' } } } : undefined;
    const view = await h.leases.revoke(LEASE_1, 'requested');
    expect(view.state).toBe('revoke_failed');
    expect(leaseOnDisk(LEASE_1)?.lastError).toMatch(/still exists/);
    expect(h.revokeFailures).toHaveLength(1);
    expect(h.revokeFailures[0].lease).toMatchObject({ leaseId: LEASE_1, state: 'revoke_failed' });
    expect(ledgerRows().filter((row) => row.event === 'cf-lease-revoke-failed')).toHaveLength(1);
    // The next attempt fails again: ledgered, but the admin is not paged a second time.
    expect((await h.leases.revoke(LEASE_1, 'retry')).state).toBe('revoke_failed');
    expect(h.revokeFailures).toHaveLength(1);
    expect(ledgerRows().filter((row) => row.event === 'cf-lease-revoke-failed')).toHaveLength(2);
  });

  it('marks revoke_failed when DELETE answers 500', async () => {
    await mint();
    h.fake.hook = (req) =>
      req.method === 'DELETE'
        ? { status: 500, body: { success: false, errors: [{ code: 10000, message: 'boom' }] } }
        : undefined;
    const view = await h.leases.revoke(LEASE_1, 'requested');
    expect(view.state).toBe('revoke_failed');
    expect(String(leaseOnDisk(LEASE_1)?.lastError)).toContain('500');
    expect(h.revokeFailures).toHaveLength(1);
    expect(h.fake.tokens.size).toBe(1);
  });

  it('runs one revoke at a time per lease', async () => {
    await mint();
    const [a, b] = await Promise.all([h.leases.revoke(LEASE_1, 'a'), h.leases.revoke(LEASE_1, 'b')]);
    expect(a.state).toBe('revoked');
    expect(b.state).toBe('revoked');
    expect(requestsTo('DELETE', /./)).toHaveLength(1);
  });
});

describe('sweep', () => {
  it('deletes a token minted but never stored, by name prefix, and confirms 404', async () => {
    await h.fake.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
    h = await setup({ blockTokensFile: true });
    expect(await refusal(mint())).toBe('internal');
    expect(h.fake.tokens.size).toBe(1);
    const orphan = [...h.fake.tokens.values()][0];
    expect(orphan.name).toBe(`${LEASE_TOKEN_PREFIX}${LEASE_1}`);
    expect(leaseOnDisk(LEASE_1)).toMatchObject({ state: 'mint_failed' });
    const counts = await h.leases.sweep();
    expect(counts).toEqual({ revoked: 0, failed: 0, orphansDeleted: 1 });
    expect(h.fake.tokens.size).toBe(0);
    const tokenPath = `/accounts/${ACCOUNT}/tokens/${orphan.id}`;
    expect(requestsTo('DELETE', /./).map((r) => r.path)).toEqual([tokenPath]);
    const confirm = requestsTo('GET', new RegExp(`^${tokenPath}$`));
    expect(confirm).toHaveLength(1);
    expect(ledgerRows().find((row) => row.event === 'cf-lease-orphan-deleted')).toMatchObject({ leaseId: LEASE_1 });
  });

  it('revokes expired leases, retries revoke_failed, and deletes orphans across every page', async () => {
    await mint(LEASE_1, {}, HOUR);
    await mint(LEASE_2, {}, 2 * HOUR);
    await mint(LEASE_3, {}, 3 * HOUR);
    h.fake.hook = (req) =>
      req.method === 'DELETE' ? { status: 500, body: { success: false, errors: [] } } : undefined;
    expect((await h.leases.revoke(LEASE_2, 'requested')).state).toBe('revoke_failed');
    h.fake.hook = undefined;
    for (let i = 0; i < 120; i++) h.fake.addToken({ name: `unrelated-${i}` });
    const stray = h.fake.addToken({ name: `${LEASE_TOKEN_PREFIX}${'4'.repeat(32)}` });
    const expiredStray = h.fake.addToken({ name: `${LEASE_TOKEN_PREFIX}garbage`, expires_on: '2026-10-26T11:00:00Z' });
    h.clock.now = T0 + HOUR * 1000 + 1;
    const counts = await h.leases.sweep();
    expect(counts).toEqual({ revoked: 2, failed: 0, orphansDeleted: 2 });
    expect(h.leases.list().map((v) => [v.leaseId, v.state])).toEqual([
      [LEASE_1, 'revoked'],
      [LEASE_2, 'revoked'],
      [LEASE_3, 'active'],
    ]);
    expect(h.fake.tokens.has(stray.id)).toBe(false);
    expect(h.fake.tokens.has(expiredStray.id)).toBe(false);
    expect([...h.fake.tokens.values()].filter((t) => t.name.startsWith('unrelated-'))).toHaveLength(120);
    const pages = requestsTo('GET', new RegExp(`^/accounts/${ACCOUNT}/tokens$`)).map((r) => r.query);
    // dev2 and stage share the account: listed once, expired included, 50 per page, until a short page.
    expect(pages).toEqual([
      { per_page: '50', page: '1', include_expired: 'true' },
      { per_page: '50', page: '2', include_expired: 'true' },
      { per_page: '50', page: '3', include_expired: 'true' },
    ]);
    expect(await h.leases.sweep()).toEqual({ revoked: 0, failed: 0, orphansDeleted: 0 });
  });

  it('does not delete a token whose lease is still minting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posted!: () => void;
    const postedSeen = new Promise<void>((resolve) => {
      posted = resolve;
    });
    h.fake.hook = async (req, next) => {
      if (req.method !== 'POST') return undefined;
      const reply = next();
      posted();
      await gate;
      return reply;
    };
    const minting = mint();
    await postedSeen;
    expect(await h.leases.sweep()).toEqual({ revoked: 0, failed: 0, orphansDeleted: 0 });
    expect(h.fake.tokens.size).toBe(1);
    release();
    expect((await minting).state).toBe('active');
  });

  it('leaves alone a lease whose mint finishes while the sweep revokes another', async () => {
    await mint(LEASE_1, {}, 60);
    h.clock.now = T0 + 61_000;
    const postSeen = deferred();
    const postGate = deferred();
    const deleteSeen = deferred();
    const deleteGate = deferred();
    h.fake.hook = async (req, next) => {
      if (req.method === 'POST' && /\/tokens$/.test(req.path)) {
        postSeen.resolve();
        await postGate.promise;
        return next();
      }
      if (req.method === 'DELETE') {
        deleteSeen.resolve();
        await deleteGate.promise;
        return next();
      }
      return undefined;
    };
    const minting = mint(LEASE_2);
    await postSeen.promise;
    // The sweep starts while LEASE_2 is minting and is inside LEASE_1's revoke when the mint completes.
    const sweeping = h.leases.sweep();
    await deleteSeen.promise;
    postGate.resolve();
    expect((await minting).state).toBe('active');
    deleteGate.resolve();
    expect(await sweeping).toEqual({ revoked: 1, failed: 0, orphansDeleted: 0 });
    expect(leaseOnDisk(LEASE_2)).toMatchObject({ state: 'active' });
    expect([...h.fake.tokens.values()].map((t) => t.name)).toEqual([`${LEASE_TOKEN_PREFIX}${LEASE_2}`]);
    expect(ledgerRows().filter((row) => row.event === 'cf-lease-mint-failed')).toHaveLength(0);
    const res = await h.leases.call(
      LEASE_2,
      { method: 'GET', path: `/zones/${ZONE_A}/dns_records` },
      { sessionKey: 's' },
    );
    expect(res.status).toBe(200);
  });

  it('counts a lease revoked elsewhere during the sweep by its state now, not the snapshot', async () => {
    await mint(LEASE_1, {}, 60);
    await mint(LEASE_2);
    h.fake.hook = (req) =>
      req.method === 'DELETE' ? { status: 500, body: { success: false, errors: [] } } : undefined;
    expect((await h.leases.revoke(LEASE_2, 'requested')).state).toBe('revoke_failed');
    h.clock.now = T0 + 61_000;
    const deleteSeen = deferred();
    const deleteGate = deferred();
    let gated = false;
    h.fake.hook = async (req, next) => {
      if (req.method !== 'DELETE' || gated) return undefined;
      gated = true;
      deleteSeen.resolve();
      await deleteGate.promise;
      return next();
    };
    const sweeping = h.leases.sweep();
    await deleteSeen.promise;
    // While the sweep is inside LEASE_1's revoke, LEASE_2's retry succeeds through the API.
    expect((await h.leases.revoke(LEASE_2, 'requested again')).state).toBe('revoked');
    deleteGate.resolve();
    expect(await sweeping).toEqual({ revoked: 1, failed: 0, orphansDeleted: 0 });
    expect(requestsTo('DELETE', /./)).toHaveLength(3);
  });

  it('records the HTTP status when the token list fails', async () => {
    h.fake.hook = (req) =>
      req.method === 'GET' && /\/tokens$/.test(req.path)
        ? { status: 503, body: { success: false, errors: [{ code: 10000, message: 'unavailable' }] } }
        : undefined;
    expect(await h.leases.sweep()).toEqual({ revoked: 0, failed: 1, orphansDeleted: 0 });
    const row = ledgerRows().find((r) => r.event === 'cf-sweep-list-failed');
    expect(String(row?.error)).toContain('503');
  });

  it('keeps sweeping orphans when one lease revoke throws', async () => {
    await mint(LEASE_1, {}, 60);
    const stray = h.fake.addToken({ name: `${LEASE_TOKEN_PREFIX}${'4'.repeat(32)}` });
    h.clock.now = T0 + 61_000;
    h.store.failNext = 1;
    expect(await h.leases.sweep()).toEqual({ revoked: 0, failed: 1, orphansDeleted: 1 });
    expect(h.fake.tokens.has(stray.id)).toBe(false);
    expect(leaseOnDisk(LEASE_1)).toMatchObject({ state: 'active' });
    expect(await h.leases.sweep()).toEqual({ revoked: 1, failed: 0, orphansDeleted: 0 });
  });

  it('skips overlapping sweeps', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listed!: () => void;
    const firstList = new Promise<void>((resolve) => {
      listed = resolve;
    });
    h.fake.hook = async (req) => {
      if (req.method === 'GET' && /\/tokens$/.test(req.path)) {
        listed();
        await gate;
      }
      return undefined;
    };
    const stop = h.leases.startSweeper(5);
    await firstList;
    const direct = h.leases.sweep();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(requestsTo('GET', /\/tokens$/)).toHaveLength(1);
    release();
    await direct;
    stop();
    const afterStop = h.fake.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.fake.requests.length).toBe(afterStop);
  });
});

describe('permissionGroupNames', () => {
  it('maps ids to names with the forge key and caches for an hour', async () => {
    const names = await h.leases.permissionGroupNames('dev2');
    expect(names).toEqual({
      [PG_DNS_READ]: 'DNS Read',
      [PG_DNS_EDIT]: 'DNS Write',
      [PG_ACCOUNT_READ]: 'Account Settings Read',
    });
    await h.leases.permissionGroupNames('dev2');
    const groups = requestsTo('GET', /\/tokens\/permission_groups$/);
    expect(groups).toHaveLength(1);
    expect(groups[0].auth).toBe(FORGE_KEY);
    h.clock.now = T0 + HOUR * 1000;
    await h.leases.permissionGroupNames('dev2');
    expect(requestsTo('GET', /\/tokens\/permission_groups$/)).toHaveLength(2);
    expect(await refusal(h.leases.permissionGroupNames('prod'))).toBe('unknown-env');
  });
});

describe('secrecy', () => {
  it('never writes a lease key or the forge key to the lease file, ledger, errors, or views', async () => {
    await mint(LEASE_1);
    await mint(LEASE_2, { access: 'read', permissionGroupIds: [PG_DNS_READ] });
    await h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/dns_records` }, { sessionKey: 's' });
    await refusal(h.leases.call(LEASE_1, { method: 'GET', path: '/user/tokens' }, { sessionKey: 's' }));
    await refusal(
      h.leases.call(LEASE_2, { method: 'POST', path: `/zones/${ZONE_A}/dns_records` }, { sessionKey: 's' }),
    );
    h.fake.hook = (req) =>
      req.method === 'DELETE'
        ? { status: 500, body: { success: false, errors: [{ code: 1, message: `bad ${req.auth}` }] } }
        : undefined;
    await h.leases.revoke(LEASE_2, 'requested');
    h.fake.hook = undefined;
    h.clock.now = T0 + 2 * HOUR * 1000;
    await refusal(h.leases.call(LEASE_1, { method: 'GET', path: `/zones/${ZONE_A}/dns_records` }, { sessionKey: 's' }));
    await h.leases.sweep();
    expect(h.fake.issued).toHaveLength(2);
    const views = JSON.stringify(h.leases.list());
    const leasesText = fs.readFileSync(h.leasesFile, 'utf8');
    const ledgerText = fs.readFileSync(h.ledgerFile, 'utf8');
    const failures = JSON.stringify(h.revokeFailures);
    for (const haystack of [views, leasesText, ledgerText, failures, ...h.messages]) {
      expect(haystack).not.toContain(FAKE_TOKEN_VALUE_PREFIX);
      expect(haystack).not.toContain(FORGE_KEY);
    }
    expect(leasesText).toContain(LEASE_1);
    expect(h.messages.length).toBeGreaterThanOrEqual(3);
  });
});
