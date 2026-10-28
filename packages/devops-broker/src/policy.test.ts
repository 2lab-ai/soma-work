import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_LEASE_TTL_SECONDS } from '@soma/process-shared/devops/protocol.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicy, MAX_APPROVAL_TIMEOUT_SECONDS, PolicyError, parsePolicy } from './policy.js';

const ZERO_ID = '0'.repeat(32);
const ONE_ID = '1'.repeat(32);
// Underscores make it invalid as every name, login and id the policy holds, and not identifier-like.
const MARKER = 'Test_Secret_0001_Marker';
const DELETE = Symbol('delete');

type Json = Record<string, unknown>;

/** The 16 §8 example with placeholders. */
function example(): Json {
  return {
    admins: ['U000ADMIN'],
    gh: {
      org: 'example-org',
      accounts: {
        member: { login: 'alice', class: 'member' },
        'org-admin': { login: 'alice-admin', class: 'org-admin' },
      },
      restWriteAllowlist: [],
    },
    cloudflare: {
      dev2: {
        accountId: ZERO_ID,
        zones: { 'example.com': ONE_ID },
        permissionGroups: { read: ['dns-read-group'], edit: ['dns-edit-group'] },
        defaultTtl: '1h',
        maxTtl: '71h',
        ipCondition: false,
      },
    },
    approvalTimeout: '5m',
  };
}

/** A copy of the example with one nested key set (or deleted). */
function changed(keys: string[], value: unknown): Json {
  const root = example();
  let node = root;
  for (const key of keys.slice(0, -1)) node = node[key] as Json;
  const last = keys[keys.length - 1];
  if (value === DELETE) delete node[last];
  else node[last] = value;
  return root;
}

function rejection(input: unknown): PolicyError {
  try {
    parsePolicy(input);
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyError);
    return err as PolicyError;
  }
  throw new Error('parsePolicy accepted the input');
}

describe('parsePolicy: accepts', () => {
  it('the 16 §8 example, converting durations to seconds', () => {
    expect(parsePolicy(example())).toEqual({
      admins: ['U000ADMIN'],
      gh: {
        org: 'example-org',
        allowedOwners: ['example-org'],
        accounts: {
          member: { login: 'alice', class: 'member' },
          'org-admin': { login: 'alice-admin', class: 'org-admin' },
        },
        restWriteAllowlist: [],
      },
      cloudflare: {
        dev2: {
          accountId: ZERO_ID,
          zones: { 'example.com': ONE_ID },
          permissionGroups: { read: ['dns-read-group'], edit: ['dns-edit-group'] },
          defaultTtlSeconds: 3600,
          maxTtlSeconds: MAX_LEASE_TTL_SECONDS,
          ipCondition: false,
        },
      },
      approvalTimeoutSeconds: 300,
      maxPendingApprovals: 3,
    });
  });

  it('defaults: allowedOwners = [org], ttl 1h/71h, ipCondition false, approval 5m, 3 pending', () => {
    const input = example();
    const cf = (input.cloudflare as Json).dev2 as Json;
    delete cf.defaultTtl;
    delete cf.maxTtl;
    delete cf.ipCondition;
    delete input.approvalTimeout;
    delete (input.gh as Json).restWriteAllowlist;
    const policy = parsePolicy(input);
    expect(policy.gh.allowedOwners).toEqual(['example-org']);
    expect(policy.gh.restWriteAllowlist).toEqual([]);
    expect(policy.cloudflare.dev2).toMatchObject({
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 71 * 3600,
      ipCondition: false,
    });
    expect(policy.approvalTimeoutSeconds).toBe(300);
    expect(policy.maxPendingApprovals).toBe(3);
  });

  it('caps approvalTimeout at 5 minutes, the same ceiling as a permission request', () => {
    expect(MAX_APPROVAL_TIMEOUT_SECONDS).toBe(300);
    expect(rejection(changed(['approvalTimeout'], '301m')).message).toBe(
      'policy.approvalTimeout: must be "<n>m" or "<n>h", at most 5m',
    );
  });

  it.each([
    ['explicit allowedOwners', ['gh', 'allowedOwners'], ['example-org', 'bob']],
    ['minute TTLs', ['cloudflare', 'dev2', 'defaultTtl'], '30m'],
    ['maxTtl exactly 71h', ['cloudflare', 'dev2', 'maxTtl'], '71h'],
    ['account-level only (no zones)', ['cloudflare', 'dev2', 'zones'], {}],
    ['an env without edit groups', ['cloudflare', 'dev2', 'permissionGroups'], { read: ['g'], edit: [] }],
    ['no Cloudflare envs', ['cloudflare'], {}],
    ['no cloudflare section', ['cloudflare'], DELETE],
    ['a single account', ['gh', 'accounts'], { member: { login: 'alice', class: 'member' } }],
    ['maxPendingApprovals', ['maxPendingApprovals'], 5],
    ['a shorter approvalTimeout', ['approvalTimeout'], '2m'],
    ['approvalTimeout exactly 5m', ['approvalTimeout'], '5m'],
  ])('%s', (_name, keys, value) => {
    expect(() => parsePolicy(changed(keys as string[], value))).not.toThrow();
  });

  it('keeps explicit values and returns fresh objects', () => {
    const input = changed(['gh', 'allowedOwners'], ['example-org', 'bob']);
    const policy = parsePolicy(input);
    expect(policy.gh.allowedOwners).toEqual(['example-org', 'bob']);
    ((input.gh as Json).allowedOwners as string[]).push('mallory');
    expect(policy.gh.allowedOwners).toEqual(['example-org', 'bob']);
  });
});

describe('parsePolicy: rejects, naming the JSON path', () => {
  it.each<[string, unknown, string]>([
    ['null', null, 'policy'],
    ['an array', [], 'policy'],
    ['an unknown top-level key', changed(['extra'], 1), 'policy.extra'],
    ['missing admins', changed(['admins'], DELETE), 'policy.admins'],
    ['empty admins', changed(['admins'], []), 'policy.admins'],
    ['a malformed admin id', changed(['admins'], ['u000admin']), 'policy.admins[0]'],
    ['a channel id as admin', changed(['admins'], ['C000ADMIN']), 'policy.admins[0]'],
    ['duplicate admins', changed(['admins'], ['U000ADMIN', 'U000ADMIN']), 'policy.admins[1]'],
    ['missing gh', changed(['gh'], DELETE), 'policy.gh'],
    ['an unknown gh key', changed(['gh', 'token'], 'x'), 'policy.gh.token'],
    ['a malformed org', changed(['gh', 'org'], 'example org'), 'policy.gh.org'],
    ['empty allowedOwners', changed(['gh', 'allowedOwners'], []), 'policy.gh.allowedOwners'],
    ['a malformed owner', changed(['gh', 'allowedOwners'], ['a/b']), 'policy.gh.allowedOwners[0]'],
    ['empty accounts', changed(['gh', 'accounts'], {}), 'policy.gh.accounts'],
    [
      'an uppercase account name',
      changed(['gh', 'accounts', 'Member'], { login: 'a', class: 'member' }),
      'policy.gh.accounts',
    ],
    [
      'a 33-char account name',
      changed(['gh', 'accounts', 'a'.repeat(33)], { login: 'a', class: 'member' }),
      'policy.gh.accounts',
    ],
    ['a third class', changed(['gh', 'accounts', 'member', 'class'], 'owner'), 'policy.gh.accounts.member.class'],
    ['a malformed login', changed(['gh', 'accounts', 'member', 'login'], '-alice'), 'policy.gh.accounts.member.login'],
    [
      'a token inside an account',
      changed(['gh', 'accounts', 'member', 'token'], MARKER),
      'policy.gh.accounts.member.token',
    ],
    [
      'a non-empty restWriteAllowlist',
      changed(['gh', 'restWriteAllowlist'], [{ method: 'POST', path: '/x' }]),
      'policy.gh.restWriteAllowlist',
    ],
    ['cloudflare as an array', changed(['cloudflare'], []), 'policy.cloudflare'],
    ['a 17-char env name', changed(['cloudflare', 'a'.repeat(17)], {}), 'policy.cloudflare'],
    ['an uppercase env name', changed(['cloudflare', 'Dev2'], {}), 'policy.cloudflare'],
    ['an unknown env key', changed(['cloudflare', 'dev2', 'apiToken'], MARKER), 'policy.cloudflare.dev2.apiToken'],
    [
      'uppercase hex accountId',
      changed(['cloudflare', 'dev2', 'accountId'], 'A'.repeat(32)),
      'policy.cloudflare.dev2.accountId',
    ],
    [
      'a short accountId',
      changed(['cloudflare', 'dev2', 'accountId'], '0'.repeat(31)),
      'policy.cloudflare.dev2.accountId',
    ],
    [
      'a malformed zone id',
      changed(['cloudflare', 'dev2', 'zones'], { 'example.com': 'zone' }),
      'policy.cloudflare.dev2.zones["example.com"]',
    ],
    [
      'a malformed zone name',
      changed(['cloudflare', 'dev2', 'zones'], { 'Example.COM': ONE_ID }),
      'policy.cloudflare.dev2.zones',
    ],
    [
      'two names for one zone id',
      changed(['cloudflare', 'dev2', 'zones'], { 'example.com': ONE_ID, 'example.org': ONE_ID }),
      'policy.cloudflare.dev2.zones',
    ],
    [
      'missing edit groups',
      changed(['cloudflare', 'dev2', 'permissionGroups'], { read: ['g'] }),
      'policy.cloudflare.dev2.permissionGroups.edit',
    ],
    [
      'an empty group id',
      changed(['cloudflare', 'dev2', 'permissionGroups'], { read: [''], edit: [] }),
      'policy.cloudflare.dev2.permissionGroups.read[0]',
    ],
    [
      'an unknown permissionGroups key',
      changed(['cloudflare', 'dev2', 'permissionGroups'], { read: [], edit: [], admin: [] }),
      'policy.cloudflare.dev2.permissionGroups.admin',
    ],
    ['maxTtl 72h', changed(['cloudflare', 'dev2', 'maxTtl'], '72h'), 'policy.cloudflare.dev2.maxTtl'],
    ['maxTtl 4320m', changed(['cloudflare', 'dev2', 'maxTtl'], '4320m'), 'policy.cloudflare.dev2.maxTtl'],
    [
      'defaultTtl past the 71h ceiling',
      changed(['cloudflare', 'dev2', 'defaultTtl'], '72h'),
      'policy.cloudflare.dev2.defaultTtl',
    ],
    ['a day unit', changed(['cloudflare', 'dev2', 'defaultTtl'], '1d'), 'policy.cloudflare.dev2.defaultTtl'],
    ['a zero TTL', changed(['cloudflare', 'dev2', 'defaultTtl'], '0h'), 'policy.cloudflare.dev2.defaultTtl'],
    ['a numeric TTL', changed(['cloudflare', 'dev2', 'defaultTtl'], 3600), 'policy.cloudflare.dev2.defaultTtl'],
    ['ipCondition true', changed(['cloudflare', 'dev2', 'ipCondition'], true), 'policy.cloudflare.dev2.ipCondition'],
    ['a malformed approvalTimeout', changed(['approvalTimeout'], '300'), 'policy.approvalTimeout'],
    // The MCP client gives up at expiry + 30 s and its call dies at 360 s; a longer card outlives both.
    ['an approvalTimeout of 6m', changed(['approvalTimeout'], '6m'), 'policy.approvalTimeout'],
    ['an approvalTimeout in hours', changed(['approvalTimeout'], '1h'), 'policy.approvalTimeout'],
    ['zero pending approvals', changed(['maxPendingApprovals'], 0), 'policy.maxPendingApprovals'],
    ['fractional pending approvals', changed(['maxPendingApprovals'], 1.5), 'policy.maxPendingApprovals'],
    ['string pending approvals', changed(['maxPendingApprovals'], '3'), 'policy.maxPendingApprovals'],
  ])('%s', (_name, input, jsonPath) => {
    const err = rejection(input);
    expect(err.path).toBe(jsonPath);
    expect(err.message.startsWith(`${jsonPath}: `)).toBe(true);
  });

  it('applies the defaultTtl ≤ maxTtl rule to the narrowed maxTtl', () => {
    const input = changed(['cloudflare', 'dev2', 'maxTtl'], '30m');
    expect(rejection(input).path).toBe('policy.cloudflare.dev2.defaultTtl');
  });

  it('never echoes values', () => {
    for (const input of [
      changed(['admins'], [MARKER]),
      changed(['gh', 'org'], MARKER),
      changed(['gh', 'accounts', 'member', 'login'], `${MARKER}!`),
      changed(['gh', 'accounts', MARKER], { login: 'a', class: 'member' }),
      changed(['cloudflare', 'dev2', 'accountId'], MARKER),
      changed(['cloudflare', 'dev2', 'zones'], { [MARKER]: ONE_ID }),
      changed(['cloudflare', 'dev2', 'zones'], { 'example.com': MARKER }),
      changed(['cloudflare', 'dev2', 'defaultTtl'], MARKER),
      changed(['gh', 'restWriteAllowlist'], [MARKER]),
      changed([MARKER], 1),
    ]) {
      expect(rejection(input).message).not.toContain(MARKER);
    }
  });
});

describe('loadPolicy', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-policy-'));
    file = path.join(dir, 'policy.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(content: string, mode = 0o640): void {
    fs.writeFileSync(file, content);
    fs.chmodSync(file, mode);
  }

  it('loads a group-readable broker-owned file', () => {
    write(JSON.stringify(example()));
    expect(loadPolicy(file).approvalTimeoutSeconds).toBe(300);
  });

  it('rejects invalid JSON without quoting the file', () => {
    write(`{"admins": ["${MARKER}"`);
    expect(() => loadPolicy(file)).toThrow(PolicyError);
    expect(() => loadPolicy(file)).toThrow(/not valid JSON/);
    try {
      loadPolicy(file);
    } catch (err) {
      expect((err as Error).message).not.toContain(MARKER);
    }
  });

  it.each([0o660, 0o646, 0o602])('rejects a file another user could write (mode %o)', (mode) => {
    write(JSON.stringify(example()), mode);
    expect(() => loadPolicy(file)).toThrow(/writable/);
  });

  it('rejects a parent directory another user could write', () => {
    write(JSON.stringify(example()));
    fs.chmodSync(dir, 0o770);
    expect(() => loadPolicy(file)).toThrow(/writable/);
  });

  it('rejects a file owned by an untrusted user', () => {
    write(JSON.stringify(example()));
    const uid = process.getuid?.() ?? 0;
    expect(() => loadPolicy(file, { trustedUids: [uid + 1] })).toThrow(/owned by uid/);
  });

  it('rejects a symlink', () => {
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, JSON.stringify(example()));
    fs.symlinkSync(real, file);
    expect(() => loadPolicy(file)).toThrow(/symlink/);
  });

  it('reports a missing file with its path', () => {
    expect(() => loadPolicy(file)).toThrow(file);
  });
});
