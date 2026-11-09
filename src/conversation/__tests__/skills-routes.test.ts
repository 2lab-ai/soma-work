import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1079 — the settings page "스킬" tab, server half. Who sees and changes what:
 *   - 내 스킬: the signed-in user's own skills only (the user is the session's, never a body field);
 *     they read and save SKILL.md and say who else may run each skill.
 *   - 환경 스킬: every signed-in user sees the names and their own access; the description and the
 *     content (host values: test accounts, targets) only an admin or a granted user; who has access
 *     only an admin; changing it needs the dashboard's admin gate (admin mode, or the viewer token).
 *   - 시스템 스킬: every installed skill except the environment plugins', read-only for everyone.
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

const USERS = [
  { userId: 'U_OWNER', slackDisplayName: '오너', accepted: true },
  { userId: 'U_OTHER', slackName: 'other', accepted: true },
  { userId: 'U_ADMIN', slackDisplayName: '관리자님', accepted: true },
  { userId: 'U_PENDING', slackDisplayName: '대기', accepted: false },
];

const ENV_SECRET_DESC = 'QA account env-desc-marker';
const ENV_SECRET_BODY = 'ENV-BODY-MARKER password=hunter2';

function writeSkill(dir: string, name: string, description: string, body: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

describe('skills routes (#1079)', () => {
  let stopWebServer: any;
  let inject: any;
  let routes: typeof import('../skills-routes');
  let grants: typeof import('../../user-skill-grants-store');
  let root: string;
  const dataDir = process.env.DATA_DIR as string;

  beforeEach(async () => {
    vi.resetModules();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-routes-'));
    const pluginsDir = path.join(root, 'plugins');
    const localDir = path.join(root, 'local', 'skills');
    writeSkill(path.join(pluginsDir, 'envx', 'skills'), 'post-deploy', ENV_SECRET_DESC, ENV_SECRET_BODY);
    writeSkill(path.join(pluginsDir, '.backups', 'envx', 'skills'), 'post-deploy', ENV_SECRET_DESC, ENV_SECRET_BODY);
    writeSkill(path.join(pluginsDir, 'stv', 'skills'), 'debug', '버그를 찾는 방법', 'STV DEBUG BODY');
    writeSkill(localDir, 'zcheck', 'Post-implementation gate', 'ZCHECK BODY');

    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    inject = webServer.injectWebServer;
    routes = await import('../skills-routes');
    grants = await import('../../user-skill-grants-store');
    routes.setSkillsEnvRegistrySource(() => ({ pluginNames: new Set(['envx']), pluginsDir }));
    routes.setSkillsUserSource(() => USERS);
    routes.setSkillsLocalDirsForTests([localDir]);

    const store = await import('../../user-skill-store');
    store.createUserSkill('U_OWNER', 'deploy', '---\nname: deploy\ndescription: 배포 절차\n---\n\n배포한다.\n');
    store.createUserSkill('U_OWNER', 'multi', '---\nname: multi\ndescription: 여러 파일\n---\nbody\n');
    fs.writeFileSync(path.join(dataDir, 'U_OWNER', 'skills', 'multi', 'helper.sh'), 'echo hi\n');
    await webServer.startWebServer({ listen: false });
  }, 60_000); // the first import of the web server is slow on a loaded machine

  afterEach(async () => {
    routes.setSkillsEnvRegistrySource(null);
    routes.setSkillsUserSource(null);
    routes.setSkillsLocalDirsForTests(null);
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
  const BEARER = { Authorization: 'Bearer test-token', 'content-type': 'application/json' };

  async function get(url: string, headers: Record<string, string>) {
    const res = await inject({ method: 'GET', url, headers });
    return { status: res.statusCode as number, raw: res.body as string, body: JSON.parse(res.body) };
  }
  async function grant(headers: Record<string, string>, payload: Record<string, unknown>) {
    const res = await inject({ method: 'POST', url: '/api/skills/grants', headers, payload });
    return { status: res.statusCode as number, body: JSON.parse(res.body) };
  }

  describe('GET /api/skills', () => {
    it('a signed-in user gets their own skills, the accepted users, env names only and the system list', async () => {
      const r = await get('/api/skills', await signIn('U_OWNER'));
      expect(r.status).toBe(200);
      expect(r.body.me).toBe('U_OWNER');
      expect(r.body.isAdmin).toBe(false);
      // accepted users only, by the name the picker shows
      expect(r.body.users).toEqual([
        { id: 'U_OTHER', name: 'other' },
        { id: 'U_ADMIN', name: '관리자님' },
        { id: 'U_OWNER', name: '오너' },
      ]);
      expect(r.body.mine).toEqual({
        allowAll: [],
        skills: [
          { name: 'deploy', description: '배포 절차', isSingleFile: true, allowed: [] },
          { name: 'multi', description: '여러 파일', isSingleFile: false, allowed: [] },
        ],
      });
      // the environment skill: its name and this user's access — nothing it carries
      expect(r.body.env).toEqual({
        skills: [{ key: 'envx:post-deploy', plugin: 'envx', name: 'post-deploy', access: 'none' }],
      });
      expect(r.raw).not.toContain('env-desc-marker');
      expect(r.raw).not.toContain('ENV-BODY-MARKER');
      expect(r.body.system).toEqual([
        { source: 'local', name: 'zcheck', description: 'Post-implementation gate' },
        { source: 'stv', name: 'debug', description: '버그를 찾는 방법' },
      ]);
    });

    it('an admin sees the env description and who has access; a granted user sees the description but not the list', async () => {
      grants.grantSkill(grants.ENV_SKILL_GRANT_OWNER, 'envx:post-deploy', 'U_OTHER');
      const admin = await get('/api/skills', await signIn('U_ADMIN'));
      expect(admin.body.isAdmin).toBe(true);
      expect(admin.body.env).toEqual({
        allowAll: [],
        skills: [
          {
            key: 'envx:post-deploy',
            plugin: 'envx',
            name: 'post-deploy',
            access: 'admin',
            description: ENV_SECRET_DESC,
            allowed: ['U_OTHER'],
          },
        ],
      });
      const granted = await get('/api/skills', await signIn('U_OTHER'));
      expect(granted.body.env).toEqual({
        skills: [
          {
            key: 'envx:post-deploy',
            plugin: 'envx',
            name: 'post-deploy',
            access: 'granted',
            description: ENV_SECRET_DESC,
          },
        ],
      });
      expect(granted.body.env.allowAll).toBeUndefined();
      expect(granted.body.env.skills[0].allowed).toBeUndefined();
    });

    it('the viewer token has no 내 스킬 section and reads env as an admin; no credentials is 401', async () => {
      const r = await get('/api/skills', BEARER);
      expect(r.status).toBe(200);
      expect(r.body.mine).toBeNull();
      expect(r.body.me).toBeNull();
      expect(r.body.isAdmin).toBe(true);
      expect(r.body.env.skills[0].access).toBe('admin');
      expect((await inject({ method: 'GET', url: '/api/skills' })).statusCode).toBe(401);
    });
  });

  describe('environment skill content', () => {
    it('is 403 for a non-granted non-admin, 200 for a granted user and an admin; an unknown key is 404', async () => {
      const plain = await get('/api/skills/env/envx:post-deploy', await signIn('U_OWNER'));
      expect(plain.status).toBe(403);
      expect(plain.raw).not.toContain('ENV-BODY-MARKER');
      grants.grantSkill(grants.ENV_SKILL_GRANT_OWNER, 'envx:post-deploy', 'U_OWNER');
      const granted = await get('/api/skills/env/envx:post-deploy', await signIn('U_OWNER'));
      expect(granted.status).toBe(200);
      expect(granted.body.content).toContain('ENV-BODY-MARKER');
      expect((await get('/api/skills/env/envx:post-deploy', await signIn('U_ADMIN'))).status).toBe(200);
      expect((await get('/api/skills/env/envx:nope', await signIn('U_ADMIN'))).status).toBe(404);
      expect((await get('/api/skills/env/stv:debug', await signIn('U_ADMIN'))).status).toBe(404);
      expect((await get('/api/skills/env/envx:..', await signIn('U_ADMIN'))).status).toBe(404);
    });
  });

  describe('system skill content', () => {
    it('reads an installed skill; an environment plugin, a backup or an unsafe name is 404', async () => {
      const u = await signIn('U_OWNER');
      const ok = await get('/api/skills/system/stv/debug', u);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ source: 'stv', name: 'debug', description: '버그를 찾는 방법' });
      expect(ok.body.content).toContain('STV DEBUG BODY');
      expect((await get('/api/skills/system/local/zcheck', u)).body.content).toContain('ZCHECK BODY');
      for (const url of [
        '/api/skills/system/envx/post-deploy',
        '/api/skills/system/.backups/post-deploy',
        '/api/skills/system/%2E%2E/debug',
        '/api/skills/system/stv/%2E%2E',
        '/api/skills/system/stv/missing',
      ]) {
        const r = await get(url, u);
        expect(r.status, url).toBe(404);
        expect(r.raw).not.toContain('ENV-BODY-MARKER');
      }
    });
  });

  describe('내 스킬 — read and save', () => {
    it('the owner reads SKILL.md with its hash and saves it verbatim', async () => {
      const u = await signIn('U_OWNER');
      const r = await get('/api/skills/mine/deploy', u);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ name: 'deploy', description: '배포 절차', isSingleFile: true });
      expect(r.body.content).toContain('배포한다.');
      const content = '---\nname: deploy\ndescription: 새 설명\n---\n\n  공백도 그대로  \n';
      const res = await inject({
        method: 'PUT',
        url: '/api/skills/mine/deploy',
        headers: u,
        payload: { content, hash: r.body.hash },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).skill).toMatchObject({ name: 'deploy', description: '새 설명', content });
      expect(fs.readFileSync(path.join(dataDir, 'U_OWNER', 'skills', 'deploy', 'SKILL.md'), 'utf-8')).toBe(content);
    });

    it('a stale hash is 409, empty or oversize content 400, a missing skill 404 — nothing written', async () => {
      const u = await signIn('U_OWNER');
      const { hash } = (await get('/api/skills/mine/deploy', u)).body;
      const put = (name: string, payload: Record<string, unknown>) =>
        inject({ method: 'PUT', url: `/api/skills/mine/${name}`, headers: u, payload });
      expect((await put('deploy', { content: 'x', hash: 'stale' })).statusCode).toBe(409);
      expect((await put('deploy', { content: '   ', hash })).statusCode).toBe(400);
      expect((await put('deploy', { content: 'a'.repeat(11 * 1024), hash })).statusCode).toBe(400);
      expect((await put('deploy', { content: 'x' })).statusCode).toBe(400);
      expect((await put('missing', { content: 'x', hash })).statusCode).toBe(404);
      expect((await put('Bad_Name', { content: 'x', hash })).statusCode).toBe(404);
      expect(fs.readFileSync(path.join(dataDir, 'U_OWNER', 'skills', 'deploy', 'SKILL.md'), 'utf-8')).toContain(
        '배포한다.',
      );
    });

    it('another user reads and writes only their own namespace; a write needs CSRF; the viewer token has no skills', async () => {
      const other = await signIn('U_OTHER');
      expect((await get('/api/skills/mine/deploy', other)).status).toBe(404);
      const owner = await signIn('U_OWNER');
      const { hash } = (await get('/api/skills/mine/deploy', owner)).body;
      const { 'x-csrf-token': _drop, ...noCsrf } = owner;
      const res = await inject({
        method: 'PUT',
        url: '/api/skills/mine/deploy',
        headers: noCsrf,
        payload: { content: 'x', hash },
      });
      expect(res.statusCode).toBe(403);
      expect((await get('/api/skills/mine/deploy', BEARER)).status).toBe(400);
    });
  });

  describe('POST /api/skills/grants — 내 스킬', () => {
    it('the owner adds and takes back one skill and all skills; the grant store follows', async () => {
      const u = await signIn('U_OWNER');
      let r = await grant(u, { scope: 'mine', skill: 'deploy', userId: 'U_OTHER', allow: true });
      expect(r.status).toBe(200);
      expect(r.body.mine.skills[0]).toMatchObject({ name: 'deploy', allowed: ['U_OTHER'] });
      expect(grants.isSkillUseAllowed('U_OWNER', 'deploy', 'U_OTHER')).toBe(true);
      r = await grant(u, { scope: 'mine', skill: null, userId: 'U_ADMIN', allow: true });
      expect(r.body.mine.allowAll).toEqual(['U_ADMIN']);
      r = await grant(u, { scope: 'mine', skill: 'deploy', userId: 'U_OTHER', allow: false });
      expect(r.body.mine.skills[0].allowed).toEqual([]);
      expect(grants.isSkillUseAllowed('U_OWNER', 'deploy', 'U_OTHER')).toBe(false);
      r = await grant(u, { scope: 'mine', skill: null, userId: 'U_ADMIN', allow: false });
      expect(r.body.mine.allowAll).toEqual([]);
    });

    it('refuses self, an unknown or unaccepted user, a missing skill and a bad body', async () => {
      const u = await signIn('U_OWNER');
      expect((await grant(u, { scope: 'mine', skill: 'deploy', userId: 'U_OWNER', allow: true })).status).toBe(400);
      expect((await grant(u, { scope: 'mine', skill: 'deploy', userId: 'U_NOBODY', allow: true })).status).toBe(400);
      expect((await grant(u, { scope: 'mine', skill: 'deploy', userId: 'U_PENDING', allow: true })).status).toBe(400);
      expect((await grant(u, { scope: 'mine', skill: 'missing', userId: 'U_OTHER', allow: true })).status).toBe(404);
      expect((await grant(u, { scope: 'mine', skill: 'deploy', userId: 'U_OTHER', allow: 'yes' })).status).toBe(400);
      expect((await grant(u, { scope: 'theirs', skill: 'deploy', userId: 'U_OTHER', allow: true })).status).toBe(400);
      expect(grants.loadGrants('U_OWNER')).toEqual({ allowAll: [], perSkill: {} });
    });

    it('the owner is always the session user — a body owner field is ignored; the viewer token is refused', async () => {
      const other = await signIn('U_OTHER');
      const r = await grant(other, {
        scope: 'mine',
        skill: 'deploy',
        userId: 'U_ADMIN',
        allow: true,
        ownerId: 'U_OWNER',
      });
      expect(r.status).toBe(404); // U_OTHER has no skill called deploy
      expect(grants.loadGrants('U_OWNER')).toEqual({ allowAll: [], perSkill: {} });
      expect((await grant(BEARER, { scope: 'mine', skill: 'deploy', userId: 'U_OTHER', allow: true })).status).toBe(
        400,
      );
    });
  });

  describe('POST /api/skills/grants — 환경 스킬', () => {
    it('a non-admin is 403 even with the admin-mode header; an admin needs admin mode', async () => {
      const plain = { ...(await signIn('U_OWNER')), 'x-admin-mode': 'on' };
      expect(
        (await grant(plain, { scope: 'env', skill: 'envx:post-deploy', userId: 'U_OWNER', allow: true })).status,
      ).toBe(403);
      const admin = await signIn('U_ADMIN');
      expect(
        (await grant(admin, { scope: 'env', skill: 'envx:post-deploy', userId: 'U_OTHER', allow: true })).status,
      ).toBe(403);
      expect(grants.isEnvSkillUseAllowed('envx:post-deploy', 'U_OWNER')).toBe(false);
      expect(grants.isEnvSkillUseAllowed('envx:post-deploy', 'U_OTHER')).toBe(false);
    });

    it('an admin in admin mode adds and takes back one skill and all environment skills', async () => {
      const on = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
      let r = await grant(on, { scope: 'env', skill: 'envx:post-deploy', userId: 'U_OTHER', allow: true });
      expect(r.status).toBe(200);
      expect(r.body.env.skills[0]).toMatchObject({ key: 'envx:post-deploy', allowed: ['U_OTHER'] });
      expect(grants.isEnvSkillUseAllowed('envx:post-deploy', 'U_OTHER')).toBe(true);
      r = await grant(on, { scope: 'env', skill: null, userId: 'U_OWNER', allow: true });
      expect(r.body.env.allowAll).toEqual(['U_OWNER']);
      r = await grant(on, { scope: 'env', skill: 'envx:post-deploy', userId: 'U_OTHER', allow: false });
      expect(r.body.env.skills[0].allowed).toEqual([]);
      r = await grant(on, { scope: 'env', skill: null, userId: 'U_OWNER', allow: false });
      expect(r.body.env.allowAll).toEqual([]);
      expect(grants.loadGrants(grants.ENV_SKILL_GRANT_OWNER)).toEqual({ allowAll: [], perSkill: {} });
    });

    it('refuses an unknown key, a system skill key and an unknown user; the viewer token may write', async () => {
      const on = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
      expect((await grant(on, { scope: 'env', skill: 'envx:nope', userId: 'U_OTHER', allow: true })).status).toBe(404);
      expect((await grant(on, { scope: 'env', skill: 'stv:debug', userId: 'U_OTHER', allow: true })).status).toBe(404);
      expect((await grant(on, { scope: 'env', skill: 'envx:post-deploy', userId: 'U_X', allow: true })).status).toBe(
        400,
      );
      const r = await grant(BEARER, { scope: 'env', skill: 'envx:post-deploy', userId: 'U_OTHER', allow: true });
      expect(r.status).toBe(200);
      expect(grants.isEnvSkillUseAllowed('envx:post-deploy', 'U_OTHER')).toBe(true);
    });

    it('a write without a CSRF token is refused', async () => {
      const { 'x-csrf-token': _drop, ...noCsrf } = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
      expect((await grant(noCsrf, { scope: 'env', skill: null, userId: 'U_OTHER', allow: true })).status).toBe(403);
      expect(grants.loadGrants(grants.ENV_SKILL_GRANT_OWNER).allowAll).toEqual([]);
    });

    it('a dashboard with no credentials configured reads env as a non-admin and cannot change grants', async () => {
      const saved = mockConfig.conversation.viewerToken;
      mockConfig.conversation.viewerToken = '';
      try {
        const anon = { 'content-type': 'application/json', 'x-admin-mode': 'on' };
        const r = await get('/api/skills', anon);
        expect(r.status).toBe(200);
        expect(r.body.isAdmin).toBe(false);
        expect(r.body.env.skills[0].access).toBe('none');
        expect(r.raw).not.toContain('env-desc-marker');
        expect((await get('/api/skills/env/envx:post-deploy', anon)).status).toBe(403);
        expect((await grant(anon, { scope: 'env', skill: null, userId: 'U_OTHER', allow: true })).status).toBe(403);
        expect(grants.loadGrants(grants.ENV_SKILL_GRANT_OWNER).allowAll).toEqual([]);
      } finally {
        mockConfig.conversation.viewerToken = saved;
      }
    });
  });
});
