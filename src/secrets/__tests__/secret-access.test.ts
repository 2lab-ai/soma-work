import * as fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addSecretThreadGrant,
  grantEnvironment,
  grantSecret,
  hasSecretGrant,
  revokeSecret,
  secretGrantees,
} from '../../user-skill-grants-store';
import { checkSecretAccess, secretsForCall } from '../secret-access';

/**
 * secret-access WU2 (#1338, .prd/33 §3): which secrets one server-tools call uses, and whether a non-admin may
 * use them — an "always" grant (user × secret) or a grant for this thread. Read from the raw `server-tools` section.
 */

const SECTION = {
  permission: { db_query: 'read' },
  dev2: {
    ssh: { host: 'dev2' },
    databases: {
      app: { type: 'mysql', password: { $secret: 'dev2-db-app' } },
      cache: { type: 'redis', password: { $secret: 'dev2-redis' } },
    },
    github: { repos: ['acme/app'], token: { $secret: 'gh-org-admin' } },
    web: {
      logins: {
        player: { url: 'https://x.test/login', body: { id: 'p', pw: { $secret: 'dev2-player' } } },
        admin: { url: 'https://x.test/login', body: { id: 'a', pw: { $secret: 'dev2-bo' } } },
      },
    },
    phone: { apiKey: { $secret: 'phone-key' } },
  },
  stage0: {
    cloudflare: {
      accounts: {
        main: { token: { $secret: 'cf-main' }, sources: { repo: 'acme/app' } },
        side: { token: { $secret: 'cf-side' } },
      },
    },
    github: { token: { $secret: 'gh-stage0' } },
  },
  one: { cloudflare: { token: { $secret: 'cf-one' } } },
};

const T = (tool: string) => `mcp__server-tools__${tool}`;

describe('secretsForCall', () => {
  it.each([
    ['db_query', { server: 'dev2', database: 'app' }, ['dev2-db-app']],
    ['redis_query', { server: 'dev2', database: 'cache' }, ['dev2-redis']],
    // no such database: every database the server has (fail closed: more names, never fewer)
    ['db_query', { server: 'dev2', database: 'nope' }, ['dev2-db-app', 'dev2-redis']],
    ['gh_pr', { server: 'dev2', action: 'merge' }, ['gh-org-admin']],
    ['gh_read', { server: 'dev2', path: 'repos/acme/app' }, ['gh-org-admin']],
    ['login', { server: 'dev2', account: 'player' }, ['dev2-player']],
    ['login', { server: 'dev2' }, ['dev2-bo', 'dev2-player']],
    ['phone_call', { server: 'dev2', to: '010' }, ['phone-key']],
    ['cf_api', { server: 'stage0', account: 'side', method: 'GET', path: 'x' }, ['cf-side']],
    // an account that deploys from a repository reads it with the environment's GitHub token too
    ['cf_api', { server: 'stage0', account: 'main' }, ['cf-main', 'gh-stage0']],
    ['cf_api', { server: 'one' }, ['cf-one']],
  ])('%s %j → %j', (tool, input, names) => {
    expect(secretsForCall(SECTION, T(tool), input)).toEqual(names);
  });

  it.each([
    ['logs', { server: 'dev2' }],
    ['ssh_exec', { server: 'dev2', command: 'id' }],
    ['list_service', { server: 'dev2' }],
    ['list_stack', { server: 'dev2' }],
    ['phone_calls', { server: 'dev2' }],
    ['list', {}],
    ['db_query', { server: 'nowhere', database: 'app' }],
  ])('%s uses no secret', (tool, input) => {
    expect(secretsForCall(SECTION, T(tool), input)).toEqual([]);
  });

  it('a tool it does not know reads the whole server section (fail closed)', () => {
    expect(secretsForCall(SECTION, T('new_tool'), { server: 'stage0' })).toEqual(['cf-main', 'cf-side', 'gh-stage0']);
  });

  it('is empty for a tool of another server, no section or no server argument', () => {
    expect(secretsForCall(SECTION, 'mcp__github__get_issue', { server: 'dev2' })).toEqual([]);
    expect(secretsForCall(null, T('db_query'), { server: 'dev2', database: 'app' })).toEqual([]);
    expect(secretsForCall(SECTION, T('db_query'), { database: 'app' })).toEqual([]);
  });
});

describe('secret grants (user × secret)', () => {
  beforeEach(() => {
    const dir = process.env.DATA_DIR as string;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('grants, lists and revokes, idempotently', () => {
    grantSecret('gh-token', 'U1');
    grantSecret('gh-token', 'U1');
    grantSecret('gh-token', 'U2');
    expect(secretGrantees('gh-token')).toEqual(['U1', 'U2']);
    expect(hasSecretGrant('gh-token', 'U1')).toBe(true);
    expect(revokeSecret('gh-token', 'U1')).toBe(true);
    expect(revokeSecret('gh-token', 'U1')).toBe(false);
    expect(secretGrantees('gh-token')).toEqual(['U2']);
    revokeSecret('gh-token', 'U2');
    expect(secretGrantees('gh-token')).toEqual([]);
  });

  it('refuses a name the store cannot hold, and never reads an inherited key', () => {
    expect(() => grantSecret('../x', 'U1')).toThrow();
    expect(hasSecretGrant('__proto__', 'U1')).toBe(false);
    expect(secretGrantees('constructor')).toEqual([]);
  });

  it('keeps the environment grants beside it in the same file', () => {
    grantEnvironment('env:acme-dev2', 'U1');
    grantSecret('k', 'U1');
    const raw = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/env-skill-grants.json`, 'utf-8'));
    expect(raw.perEnvironment).toEqual({ 'env:acme-dev2': ['U1'] });
    expect(raw.perSecret).toEqual({ k: ['U1'] });
  });
});

describe('checkSecretAccess', () => {
  const scope = { channel: 'C1', threadTs: '1.0' };
  beforeEach(() => {
    const dir = process.env.DATA_DIR as string;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('a call that uses no secret is none', () => {
    expect(checkSecretAccess(T('logs'), { server: 'dev2' }, 'U1', scope, SECTION)).toEqual({ kind: 'none' });
  });

  it('missing names every ungranted secret the call uses, in order', () => {
    expect(checkSecretAccess(T('cf_api'), { server: 'stage0', account: 'main' }, 'U1', scope, SECTION)).toEqual({
      kind: 'missing',
      names: ['cf-main', 'gh-stage0'],
    });
    grantSecret('gh-stage0', 'U1');
    expect(checkSecretAccess(T('cf_api'), { server: 'stage0', account: 'main' }, 'U1', scope, SECTION)).toEqual({
      kind: 'missing',
      names: ['cf-main'],
    });
  });

  it('an always grant covers every thread; a thread grant only its thread; never another user', () => {
    const call = [T('gh_pr'), { server: 'dev2', action: 'view' }] as const;
    addSecretThreadGrant('gh-org-admin', 'U1', scope);
    expect(checkSecretAccess(call[0], call[1], 'U1', scope, SECTION)).toEqual({ kind: 'covered' });
    expect(checkSecretAccess(call[0], call[1], 'U1', { channel: 'C1', threadTs: '2.0' }, SECTION).kind).toBe('missing');
    expect(checkSecretAccess(call[0], call[1], 'U2', scope, SECTION).kind).toBe('missing');
    grantSecret('gh-org-admin', 'U2');
    expect(checkSecretAccess(call[0], call[1], 'U2', { channel: 'C9' }, SECTION)).toEqual({ kind: 'covered' });
  });
});
