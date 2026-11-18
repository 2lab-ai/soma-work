import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * secret-access WU1 (#1337, .prd/32 §4.2 · A7 · A8): the settings page 비밀 tab, server half.
 *   - Only an admin signed in with Slack reads or changes it; changes need admin mode and CSRF. The viewer token
 *     and a dashboard without sign-in are refused even for reading — the ledger must name a person.
 *   - Names, times, who changed it last and where configuration uses it — never a value, in no answer.
 *   - Every change leaves one audit line, without the value.
 */

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
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
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [] }),
}));

const VALUE = 'VALUE-MARKER-7f3a';

describe('secrets routes (secret-access WU1)', () => {
  let stopWebServer: any;
  let inject: any;
  let routes: typeof import('../secrets-routes');
  let root: string;
  let secretsDir: string;
  let dataDir: string;
  let configFile: string;

  beforeEach(async () => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-routes-'));
    secretsDir = path.join(root, 'secrets');
    dataDir = path.join(root, 'data');
    configFile = path.join(root, 'config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        'server-tools': {
          permission: { db_query: 'read' },
          dev2: {
            github: { token: { $secret: 'gh-token' } },
            web: { logins: { p: { body: { pw: { $secret: 'gone' } } } } },
          },
        },
      }),
    );
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    inject = webServer.injectWebServer;
    routes = await import('../secrets-routes');
    routes.setSecretsPathsForTests({ secretsDir, dataDir, configFile });
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    routes.setSecretsPathsForTests(null);
    await stopWebServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await inject({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json' };
  }
  async function admin() {
    return { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
  }
  async function call(method: string, url: string, headers: Record<string, string>, payload?: unknown) {
    // As the page's apiWrite: a request without a body sends no Content-Type.
    const { 'content-type': type, ...rest } = headers;
    const sent = payload === undefined ? rest : { ...rest, ...(type ? { 'content-type': type } : {}) };
    const res = await inject({ method, url, headers: sent, ...(payload === undefined ? {} : { payload }) });
    return { status: res.statusCode as number, raw: res.body as string, body: JSON.parse(res.body || 'null') };
  }
  function ledger(): string {
    try {
      return fs.readFileSync(path.join(dataDir, 'secret-audit.jsonl'), 'utf-8');
    } catch {
      return '';
    }
  }

  it('an admin adds, lists, overwrites and deletes — no answer and no ledger line carries the value', async () => {
    const h = await admin();
    const added = await call('PUT', '/api/secrets/gh-token', h, { value: VALUE });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ ok: true, created: true, secret: { name: 'gh-token' } });
    expect(fs.readFileSync(path.join(secretsDir, 'gh-token'), 'utf-8')).toBe(VALUE);
    expect(fs.statSync(path.join(secretsDir, 'gh-token')).mode & 0o777).toBe(0o600);

    const list = await call('GET', '/api/secrets', h);
    expect(list.status).toBe(200);
    expect(list.body.secrets).toEqual([
      {
        name: 'gh-token',
        updatedAt: expect.any(String),
        updatedBy: 'U_ADMIN',
        updatedByName: 'U_ADMIN', // no settings row for the id in this test: the id stands in
        usages: [{ server: 'dev2', path: 'github.token' }],
        // WU2: who may use it beyond admins (no grant yet; dev2 is not an environment server here)
        access: { direct: [], environments: [] },
      },
    ]);
    // Configuration names a secret the store does not hold: shown so the admin can add it.
    expect(list.body.missing).toEqual([{ name: 'gone', usages: [{ server: 'dev2', path: 'web.logins.p.body.pw' }] }]);

    expect((await call('PUT', '/api/secrets/gh-token', h, { value: 'second' })).status).toBe(409);
    const replaced = await call('PUT', '/api/secrets/gh-token', h, { value: `${VALUE}-2`, overwrite: true });
    expect(replaced.body).toMatchObject({ ok: true, created: false });

    expect((await call('DELETE', '/api/secrets/gh-token', h)).body).toEqual({ ok: true });
    expect(fs.existsSync(path.join(secretsDir, 'gh-token'))).toBe(false);
    expect((await call('DELETE', '/api/secrets/gh-token', h)).status).toBe(404);

    const actions = ledger()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((r) => [r.actor, r.action, r.name]);
    expect(actions).toEqual([
      ['U_ADMIN', 'secret.create', 'gh-token'],
      ['U_ADMIN', 'secret.overwrite', 'gh-token'],
      ['U_ADMIN', 'secret.delete', 'gh-token'],
    ]);
    for (const text of [added.raw, list.raw, replaced.raw, ledger()]) expect(text).not.toContain(VALUE);
  });

  it('a bad name or value is refused without a file or a ledger line', async () => {
    const h = await admin();
    expect((await call('PUT', '/api/secrets/has%20space', h, { value: 'v' })).status).toBe(400);
    expect((await call('PUT', '/api/secrets/ok', h, { value: '' })).status).toBe(400);
    expect((await call('PUT', '/api/secrets/ok', h, {})).status).toBe(400);
    expect(fs.existsSync(path.join(secretsDir, 'ok'))).toBe(false);
    expect(ledger()).toBe('');
  });

  it('a non-admin, the viewer token and an admin without admin mode are refused', async () => {
    const user = await signIn('U_USER');
    expect((await call('GET', '/api/secrets', user)).status).toBe(403);
    expect((await call('PUT', '/api/secrets/x', { ...user, 'x-admin-mode': 'on' }, { value: 'v' })).status).toBe(403);

    const bearer = { Authorization: 'Bearer test-token', 'content-type': 'application/json', 'x-admin-mode': 'on' };
    expect((await call('GET', '/api/secrets', bearer)).status).toBe(403);
    expect((await call('PUT', '/api/secrets/x', bearer, { value: 'v' })).status).toBe(403);

    const noMode = await signIn('U_ADMIN');
    expect((await call('GET', '/api/secrets', noMode)).status).toBe(200);
    expect((await call('PUT', '/api/secrets/x', noMode, { value: 'v' })).status).toBe(403);
    expect((await call('DELETE', '/api/secrets/x', noMode)).status).toBe(403);
    expect(fs.existsSync(path.join(secretsDir, 'x'))).toBe(false);
  });

  it('a change without the CSRF token is refused', async () => {
    const { 'x-csrf-token': _csrf, ...h } = await admin();
    expect((await call('PUT', '/api/secrets/x', h, { value: 'v' })).status).toBe(403);
    expect(fs.existsSync(path.join(secretsDir, 'x'))).toBe(false);
  });
});

describe('secrets routes — who may use each secret (secret-access WU2)', () => {
  let stopWebServer: any;
  let inject: any;
  let routes: typeof import('../secrets-routes');
  let root: string;
  let dataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-grants-'));
    dataDir = process.env.DATA_DIR as string;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const configFile = path.join(root, 'config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        'server-tools': {
          dev2: { envUser: 'env:acme-dev2', github: { token: { $secret: 'gh-token' } } },
        },
      }),
    );
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    inject = webServer.injectWebServer;
    routes = await import('../secrets-routes');
    routes.setSecretsPathsForTests({ secretsDir: path.join(root, 'secrets'), dataDir, configFile });
    routes.setSecretsUserSourceForTests(() => [
      { userId: 'U_A', slackDisplayName: '에이', accepted: true },
      { userId: 'U_B', slackName: 'bee', accepted: true },
      { userId: 'U_WAIT', slackDisplayName: '대기', accepted: false },
    ]);
    const grants = await import('../../user-skill-grants-store');
    grants.grantEnvironment('env:acme-dev2', 'U_B');
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    routes.setSecretsPathsForTests(null);
    routes.setSecretsUserSourceForTests(null);
    await stopWebServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function admin() {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId: 'U_ADMIN', email: 'a@slack.local', name: 'U_ADMIN' });
    const sso = await inject({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json', 'x-admin-mode': 'on' };
  }
  async function call(method: string, url: string, headers: Record<string, string>, payload?: unknown) {
    const res = await inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    return { status: res.statusCode as number, body: JSON.parse(res.body || 'null') };
  }

  it('lists who may use a secret — directly and through an environment — and the users to pick from', async () => {
    const h = await admin();
    await call('PUT', '/api/secrets/gh-token', h, { value: 'v' });
    const list = await call('GET', '/api/secrets', h);
    expect(list.body.users).toEqual([
      { id: 'U_B', name: 'bee' },
      { id: 'U_A', name: '에이' },
    ]);
    expect(list.body.secrets[0].access).toEqual({
      direct: [],
      environments: [{ id: 'env:acme-dev2', server: 'dev2', users: ['U_B'] }],
    });
  });

  it('adds and removes a user, audits both, and refuses a user who is not accepted', async () => {
    const h = await admin();
    await call('PUT', '/api/secrets/gh-token', h, { value: 'v' });
    const added = await call('POST', '/api/secrets/gh-token/grants', h, { userId: 'U_A', allow: true });
    expect(added.status).toBe(200);
    expect(added.body.access.direct).toEqual(['U_A']);
    const grants = await import('../../user-skill-grants-store');
    expect(grants.hasSecretGrant('gh-token', 'U_A')).toBe(true);
    expect((await call('POST', '/api/secrets/gh-token/grants', h, { userId: 'U_WAIT', allow: true })).status).toBe(400);
    const removed = await call('POST', '/api/secrets/gh-token/grants', h, { userId: 'U_A', allow: false });
    expect(removed.body.access.direct).toEqual([]);
    const actions = fs
      .readFileSync(path.join(dataDir, 'secret-audit.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.action.startsWith('grant.'))
      .map((r) => [r.action, r.name, r.userId]);
    expect(actions).toEqual([
      ['grant.add', 'gh-token', 'U_A'],
      ['grant.remove', 'gh-token', 'U_A'],
    ]);
  });

  it('grant changes need the named admin with admin mode, and a valid name', async () => {
    const h = await admin();
    const { 'x-admin-mode': _mode, ...noMode } = h;
    expect((await call('POST', '/api/secrets/gh-token/grants', noMode, { userId: 'U_A', allow: true })).status).toBe(
      403,
    );
    expect((await call('POST', '/api/secrets/has%20space/grants', h, { userId: 'U_A', allow: true })).status).toBe(400);
    expect((await call('POST', '/api/secrets/gh-token/grants', h, { userId: 'U_A' })).status).toBe(400);
  });
});
