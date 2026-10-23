import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SSOT 2026-10-23 T4 — "프로젝트 메모리 보는 것과 업데이트: 어드민 권한이 없는
 * 경우 읽기만 가능하고 어드민 권한이 있으면 업데이트할 수 있다". Every signed-in
 * user reads; only an admin (in admin mode) or the viewer token writes — enforced
 * by the server, not just hidden in the page.
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

describe('project memory routes (SSOT 2026-10-23 T4)', () => {
  let stopWebServer: any;
  let inject: any;
  let routes: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    inject = webServer.injectWebServer;
    routes = await import('../project-memory-routes');
    const { ProjectMemoryStore } = await import('../../project-memory-store');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projmem-routes-'));
    routes.setProjectMemoryStoreForTests(new ProjectMemoryStore(path.join(dir, 'project-memory.json')));
    routes.setProjectRepoSource(() => [
      { repo: '2lab-ai/soma-work', channels: ['soma-work-dev'] },
      { repo: 'https://github.com/2lab-ai/soma', channels: ['soma'] },
    ]);
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    routes.setProjectMemoryStoreForTests(null);
    await stopWebServer();
  });

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await inject({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json' };
  }

  async function list(headers: Record<string, string>) {
    const res = await inject({ method: 'GET', url: '/api/project-memory', headers });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('any signed-in user lists every mapped project with its channels; isAdmin tells the page who may edit', async () => {
    const r = await list(await signIn('U_PLAIN'));
    expect(r.status).toBe(200);
    expect(r.body.isAdmin).toBe(false);
    expect(r.body.projects.map((p: any) => [p.slug, p.channels, p.entries])).toEqual([
      ['2lab-ai/soma', ['soma'], []],
      ['2lab-ai/soma-work', ['soma-work-dev'], []],
    ]);
    expect((await list(await signIn('U_ADMIN'))).body.isAdmin).toBe(true);
  });

  it('a non-admin cannot write (403), even with a valid CSRF token and the admin-mode header', async () => {
    const auth = { ...(await signIn('U_PLAIN')), 'x-admin-mode': 'on' };
    const rev = (await list(auth)).body.projects[1].revision;
    const res = await inject({
      method: 'POST',
      url: '/api/project-memory/entries',
      headers: auth,
      payload: { project: '2lab-ai/soma-work', text: 'x', revision: rev },
    });
    expect(res.statusCode).toBe(403);
    expect((await list(auth)).body.projects[1].entries).toEqual([]);
  });

  it('an admin needs admin mode; then add, replace, delete and clear work, and everyone reads the result', async () => {
    const admin = await signIn('U_ADMIN');
    let rev = (await list(admin)).body.projects[1].revision;
    const off = await inject({
      method: 'POST',
      url: '/api/project-memory/entries',
      headers: admin,
      payload: { project: '2lab-ai/soma-work', text: 'x', revision: rev },
    });
    expect(off.statusCode).toBe(403);

    const on = { ...admin, 'x-admin-mode': 'on' };
    let res = await inject({
      method: 'POST',
      url: '/api/project-memory/entries',
      headers: on,
      payload: { project: '2lab-ai/soma-work', text: 'CI 러너는 1대', revision: rev },
    });
    expect(res.statusCode).toBe(200);
    let body = JSON.parse(res.body);
    expect(body.project).toMatchObject({
      slug: '2lab-ai/soma-work',
      entries: ['CI 러너는 1대'],
      updatedBy: 'U_ADMIN',
      channels: ['soma-work-dev'],
    });
    rev = body.project.revision;

    res = await inject({
      method: 'PUT',
      url: '/api/project-memory/entries/0',
      headers: on,
      payload: { project: '2lab-ai/soma-work', text: 'CI 러너 1대 — 큐가 길다', revision: rev },
    });
    body = JSON.parse(res.body);
    expect(body.project.entries).toEqual(['CI 러너 1대 — 큐가 길다']);

    // a stale revision (another admin) → 409
    expect(
      (
        await inject({
          method: 'DELETE',
          url: '/api/project-memory/entries/0',
          headers: on,
          payload: { project: '2lab-ai/soma-work', revision: rev },
        })
      ).statusCode,
    ).toBe(409);

    const plain = await list(await signIn('U_PLAIN'));
    expect(plain.body.projects[1].entries).toEqual(['CI 러너 1대 — 큐가 길다']);

    res = await inject({
      method: 'DELETE',
      url: '/api/project-memory',
      headers: on,
      payload: { project: '2lab-ai/soma-work', revision: body.project.revision },
    });
    expect(res.statusCode).toBe(200);
    expect((await list(on)).body.projects[1].entries).toEqual([]);
  });

  it('an admin can start a project the registry does not map yet; a malformed slug is 400', async () => {
    const on = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    const fresh = await inject({ method: 'GET', url: '/api/project-memory', headers: on });
    void fresh;
    const { ProjectMemoryStore } = await import('../../project-memory-store');
    const rev = new ProjectMemoryStore(path.join(os.tmpdir(), 'never-written.json')).get('acme/new').revision;
    let res = await inject({
      method: 'POST',
      url: '/api/project-memory/entries',
      headers: on,
      payload: { project: 'acme/new', text: 'first note', revision: rev },
    });
    expect(res.statusCode).toBe(200);
    expect((await list(on)).body.projects.map((p: any) => p.slug)).toContain('acme/new');
    res = await inject({
      method: 'POST',
      url: '/api/project-memory/entries',
      headers: on,
      payload: { project: '../../etc', text: 'x', revision: rev },
    });
    expect(res.statusCode).toBe(400);
  });

  it('the viewer token may write (global admin credential); unauthenticated reads are 401', async () => {
    expect((await inject({ method: 'GET', url: '/api/project-memory' })).statusCode).toBe(401);
    const bearer = { Authorization: 'Bearer test-token', 'content-type': 'application/json' };
    const rev = (await list(bearer)).body.projects[0].revision;
    const res = await inject({
      method: 'POST',
      url: '/api/project-memory/entries',
      headers: bearer,
      payload: { project: '2lab-ai/soma', text: 'via viewer token', revision: rev },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).project.updatedBy).toBe('viewer-token');
  });

  it('a dashboard with no credentials configured cannot write: the notes reach every session prompt (#380 review)', async () => {
    const saved = mockConfig.conversation.viewerToken;
    mockConfig.conversation.viewerToken = '';
    try {
      const anon = { 'content-type': 'application/json', 'x-admin-mode': 'on' };
      const r = await list(anon);
      expect(r.status).toBe(200); // reading stays open, like the rest of an unauthenticated dashboard
      expect(r.body.isAdmin).toBe(false);
      expect(r.body.readOnlyReason).toBe('anonymous');
      const rev = r.body.projects[1].revision;
      for (const [method, url, payload] of [
        ['POST', '/api/project-memory/entries', { project: '2lab-ai/soma-work', text: 'anon', revision: rev }],
        ['PUT', '/api/project-memory/entries/0', { project: '2lab-ai/soma-work', text: 'anon', revision: rev }],
        ['DELETE', '/api/project-memory/entries/0', { project: '2lab-ai/soma-work', revision: rev }],
        ['DELETE', '/api/project-memory', { project: '2lab-ai/soma-work', revision: rev }],
      ] as const) {
        const res = await inject({ method, url, headers: anon, payload });
        expect(res.statusCode).toBe(403);
      }
      expect((await list(anon)).body.projects[1].entries).toEqual([]);
    } finally {
      mockConfig.conversation.viewerToken = saved;
    }
  });

  it('every write verb refuses a non-admin and an admin without a CSRF token', async () => {
    const plain = { ...(await signIn('U_PLAIN')), 'x-admin-mode': 'on' };
    const admin = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    const { 'x-csrf-token': _drop, ...adminNoCsrf } = admin;
    const rev = (await list(admin)).body.projects[1].revision;
    for (const [method, url, payload] of [
      ['POST', '/api/project-memory/entries', { project: '2lab-ai/soma-work', text: 'x', revision: rev }],
      ['PUT', '/api/project-memory/entries/0', { project: '2lab-ai/soma-work', text: 'x', revision: rev }],
      ['DELETE', '/api/project-memory/entries/0', { project: '2lab-ai/soma-work', revision: rev }],
      ['DELETE', '/api/project-memory', { project: '2lab-ai/soma-work', revision: rev }],
    ] as const) {
      expect((await inject({ method, url, headers: plain, payload })).statusCode).toBe(403);
      expect((await inject({ method, url, headers: adminNoCsrf, payload })).statusCode).toBe(403);
    }
  });

  it('an unreadable store is reported to the page instead of looking empty (#380 review)', async () => {
    const { ProjectMemoryStore } = await import('../../project-memory-store');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projmem-broken-'));
    const file = path.join(dir, 'project-memory.json');
    fs.writeFileSync(file, '{ broken');
    routes.setProjectMemoryStoreForTests(new ProjectMemoryStore(file));
    const r = await list(await signIn('U_PLAIN'));
    expect(r.status).toBe(200);
    expect(r.body.storeError).toMatch(/읽을 수 없/);
  });
});
