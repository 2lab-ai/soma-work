import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * secret-access WU3 (#1339, .prd/32 §4.3 · A10 · A11): the settings page 서버 도구 tab, server half. An admin
 * signed in with Slack sees every server-tools tool and every server, and changes the tool levels (config.json
 * `server-tools.permission`, that key only), the server-tools grants and the environment grants. Admin-only tools
 * stay code-defined. Every change is a line in the audit ledger.
 */

const mockConfig = {
  conversation: { summaryModel: 'x', viewerHost: '127.0.0.1', viewerPort: 0, viewerUrl: '', viewerToken: 'test-token' },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({ getArchiveStore: () => ({ listRecent: () => [] }) }));

const CONFIG = {
  mcpServers: { other: { command: 'x' } },
  'server-tools': {
    permission: { db_query: 'read', logs: 'read' },
    dev2: {
      envUser: 'env:acme-dev2',
      ssh: { host: 'dev2' },
      databases: { app: { type: 'mysql', password: { $secret: 'dev2-db' } } },
      github: { repos: ['acme/app'], token: { $secret: 'gh-missing' } },
    },
    phoneonly: { phone: { apiKey: { $secret: 'phone-key' } } },
  },
};

describe('server-tools routes (secret-access WU3)', () => {
  let stopWebServer: any;
  let inject: any;
  let secretsRoutes: typeof import('../secrets-routes');
  let routes: typeof import('../server-tools-routes');
  let root: string;
  let configFile: string;
  let dataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-routes-'));
    configFile = path.join(root, 'config.json');
    dataDir = process.env.DATA_DIR as string;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify(CONFIG, null, 2)}\n`);
    fs.mkdirSync(path.join(root, 'secrets'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'secrets', 'dev2-db'), 'x', { mode: 0o600 });
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    inject = webServer.injectWebServer;
    secretsRoutes = await import('../secrets-routes');
    routes = await import('../server-tools-routes');
    const paths = { secretsDir: path.join(root, 'secrets'), dataDir, configFile };
    secretsRoutes.setSecretsPathsForTests(paths);
    routes.setServerToolsPathsForTests(paths);
    secretsRoutes.setSecretsUserSourceForTests(() => [
      { userId: 'U_A', slackDisplayName: '에이', accepted: true },
      { userId: 'U_B', slackDisplayName: '비', accepted: true },
    ]);
    const grants = await import('../../user-skill-grants-store');
    grants.grantEnvironment('env:acme-dev2', 'U_B');
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    secretsRoutes.setSecretsPathsForTests(null);
    secretsRoutes.setSecretsUserSourceForTests(null);
    routes.setServerToolsPathsForTests(null);
    await stopWebServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function headers(user = 'U_ADMIN', mode = true) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId: user, email: `${user}@slack.local`, name: user });
    const sso = await inject({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, ...(mode ? { 'x-admin-mode': 'on' } : {}) };
  }
  async function call(method: string, url: string, h: Record<string, string>, payload?: unknown) {
    const res = await inject({
      method,
      url,
      headers: payload === undefined ? h : { ...h, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: res.statusCode as number, body: JSON.parse(res.body || 'null') };
  }
  const ledger = () =>
    fs
      .readFileSync(path.join(dataDir, 'secret-audit.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('A10 — every tool, every server, their sections, secrets and who is allowed', async () => {
    const r = await call('GET', '/api/server-tools', await headers());
    expect(r.status).toBe(200);
    expect(r.body.permissionMap).toBe('present');
    const names = r.body.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('db_query');
    expect(names).toContain('ssh_exec');
    expect(r.body.tools.find((t: any) => t.name === 'db_query')).toMatchObject({ level: 'read', adminOnly: false });
    expect(r.body.tools.find((t: any) => t.name === 'gh_pr')).toMatchObject({ level: null, adminOnly: true });
    expect(r.body.tools.find((t: any) => t.name === 'redis_query').level).toBeNull();

    const dev2 = r.body.servers.find((s: any) => s.name === 'dev2');
    expect(dev2).toMatchObject({ envUser: 'env:acme-dev2', sections: ['ssh', 'databases', 'github'] });
    expect(dev2.tools).toEqual(expect.arrayContaining(['db_query', 'logs', 'gh_pr', 'ssh_exec']));
    expect(dev2.tools).not.toContain('login');
    expect(dev2.secrets).toEqual([
      { name: 'dev2-db', path: 'databases.app.password', exists: true },
      { name: 'gh-missing', path: 'github.token', exists: false },
    ]);
    expect(dev2.environmentUsers).toEqual(['U_B']);
    const phone = r.body.servers.find((s: any) => s.name === 'phoneonly');
    expect(phone.envUser).toBeUndefined();
    expect(phone.tools).toEqual(expect.arrayContaining(['phone_call', 'phone_calls', 'list']));
    expect(r.body.users).toEqual([
      { id: 'U_B', name: '비' },
      { id: 'U_A', name: '에이' },
    ]);
  });

  it('A11 — a tool level changes only that key of config.json and is audited from → to', async () => {
    const h = await headers();
    expect((await call('PUT', '/api/server-tools/permission/redis_query', h, { level: 'read' })).status).toBe(200);
    expect((await call('PUT', '/api/server-tools/permission/db_query', h, { level: 'write' })).status).toBe(200);
    expect((await call('PUT', '/api/server-tools/permission/logs', h, { level: null })).status).toBe(200);
    const after = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(after['server-tools'].permission).toEqual({ db_query: 'write', redis_query: 'read' });
    expect(after.mcpServers).toEqual(CONFIG.mcpServers);
    expect(after['server-tools'].dev2).toEqual(CONFIG['server-tools'].dev2);
    expect(ledger().map((l) => [l.action, l.name, l.from, l.to])).toEqual([
      ['tool.level', 'redis_query', 'none', 'read'],
      ['tool.level', 'db_query', 'read', 'write'],
      ['tool.level', 'logs', 'read', 'none'],
    ]);
  });

  it('an admin-only tool or an unknown tool has no editable level', async () => {
    const h = await headers();
    expect((await call('PUT', '/api/server-tools/permission/gh_pr', h, { level: 'read' })).status).toBe(400);
    expect((await call('PUT', '/api/server-tools/permission/nope', h, { level: 'read' })).status).toBe(404);
    expect((await call('PUT', '/api/server-tools/permission/logs', h, { level: 'root' })).status).toBe(400);
  });

  it('makes a map where there is none (#1170), with the catalog defaults and no admin-only tool', async () => {
    const { permission: _p, ...rest } = CONFIG['server-tools'];
    fs.writeFileSync(configFile, JSON.stringify({ ...CONFIG, 'server-tools': rest }));
    const h = await headers();
    expect((await call('GET', '/api/server-tools', h)).body.permissionMap).toBe('missing');
    expect((await call('POST', '/api/server-tools/permission', h, {})).status).toBe(200);
    const map = JSON.parse(fs.readFileSync(configFile, 'utf-8'))['server-tools'].permission;
    expect(map).toMatchObject({ db_query: 'read', logs: 'read', list: 'read' });
    expect(map.ssh_exec).toBeUndefined();
    expect(map.gh_pr).toBeUndefined();
    expect((await call('POST', '/api/server-tools/permission', h, {})).status).toBe(409);
  });

  it('adds, lists and revokes a server-tools grant for an accepted user', async () => {
    const h = await headers();
    const added = await call('POST', '/api/server-tools/grants', h, { userId: 'U_A', level: 'read', duration: '7d' });
    expect(added.status).toBe(200);
    const list = (await call('GET', '/api/server-tools', h)).body.toolGrants;
    expect(list).toEqual([{ userId: 'U_A', level: 'read', expiresAt: expect.any(String), grantedBy: 'U_ADMIN' }]);
    expect(
      (await call('POST', '/api/server-tools/grants', h, { userId: 'U_X', level: 'read', duration: '7d' })).status,
    ).toBe(400);
    expect(
      (await call('POST', '/api/server-tools/grants', h, { userId: 'U_A', level: 'read', duration: '9w' })).status,
    ).toBe(400);
    expect((await call('DELETE', '/api/server-tools/grants/U_A/read', h)).status).toBe(200);
    expect((await call('GET', '/api/server-tools', h)).body.toolGrants).toEqual([]);
    expect(ledger().map((l) => [l.action, l.userId])).toEqual([
      ['tool.grant.add', 'U_A'],
      ['tool.grant.remove', 'U_A'],
    ]);
  });

  it('adds and removes an environment grant', async () => {
    const h = await headers();
    const r = await call('POST', '/api/server-tools/environments/env:acme-dev2/users', h, {
      userId: 'U_A',
      allow: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.environmentUsers).toEqual(['U_B', 'U_A']);
    await call('POST', '/api/server-tools/environments/env:acme-dev2/users', h, { userId: 'U_B', allow: false });
    const grants = await import('../../user-skill-grants-store');
    expect(grants.environmentGrantees('env:acme-dev2')).toEqual(['U_A']);
    expect(
      (await call('POST', '/api/server-tools/environments/env:nope/users', h, { userId: 'U_A', allow: true })).status,
    ).toBe(404);
  });

  it('refuses to remove the last level (an empty map would open server-tools to everyone)', async () => {
    const h = await headers();
    expect((await call('PUT', '/api/server-tools/permission/logs', h, { level: null })).status).toBe(200);
    const last = await call('PUT', '/api/server-tools/permission/db_query', h, { level: null });
    expect(last.status).toBe(409);
    expect(last.body.error).toContain('#1170');
    expect(JSON.parse(fs.readFileSync(configFile, 'utf-8'))['server-tools'].permission).toEqual({ db_query: 'read' });
  });

  it('every change route refuses a non-admin, an admin without admin mode, and a missing CSRF token', async () => {
    const changes: Array<[string, string, unknown]> = [
      ['PUT', '/api/server-tools/permission/logs', { level: 'write' }],
      ['POST', '/api/server-tools/permission', {}],
      ['POST', '/api/server-tools/grants', { userId: 'U_A', level: 'read', duration: '7d' }],
      ['DELETE', '/api/server-tools/grants/U_A/read', undefined],
      ['POST', '/api/server-tools/environments/env:acme-dev2/users', { userId: 'U_A', allow: true }],
    ];
    const before = fs.readFileSync(configFile, 'utf-8');
    const nonAdmin = await headers('U_A');
    const noMode = await headers('U_ADMIN', false);
    const { 'x-csrf-token': _csrf, ...noCsrf } = await headers();
    for (const [method, url, payload] of changes) {
      for (const h of [nonAdmin, noMode, noCsrf]) {
        expect((await call(method, url, h, payload)).status, `${method} ${url}`).toBe(403);
      }
    }
    expect(fs.readFileSync(configFile, 'utf-8')).toBe(before);
    const grants = await import('../../user-skill-grants-store');
    expect(grants.environmentGrantees('env:acme-dev2')).toEqual(['U_B']);
    expect((await call('GET', '/api/server-tools', await headers())).body.toolGrants).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, 'secret-audit.jsonl'))).toBe(false);
  });

  it('a non-admin and an admin without admin mode are refused', async () => {
    expect((await call('GET', '/api/server-tools', await headers('U_A'))).status).toBe(403);
    const noMode = await headers('U_ADMIN', false);
    expect((await call('GET', '/api/server-tools', noMode)).status).toBe(200);
    expect((await call('PUT', '/api/server-tools/permission/logs', noMode, { level: 'write' })).status).toBe(403);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf-8'))['server-tools'].permission.logs).toBe('read');
  });
});
