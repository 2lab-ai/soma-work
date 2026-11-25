import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings page 작업 워커 tab, server half: an admin reads the work workers (the process monitor's nodes — today
 * the one this daemon runs on) and gives one a nickname, which the task card's node badge reads instead of the node
 * id. Only an admin signed in with Slack; a change needs admin mode and CSRF.
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

const GiB = 1024 ** 3;
const SNAPSHOT = {
  node: {
    nodeId: 'studio-build-01',
    platform: 'darwin',
    cpuCount: 16,
    cpuBusyPercent: 42.4,
    loadAvg1: 6,
    totalMemBytes: 64 * GiB,
    availableMemBytes: 24 * GiB,
  },
  sampledAt: 1_700_000_000_000,
  sessions: [
    {
      sessionKey: 'C1:1',
      nodeId: 'studio-build-01',
      rootAlive: true,
      processCount: 5,
      stoppedCount: 0,
      cpuPercent: 30,
      rssBytes: GiB,
      sampledAt: 1,
      processes: [],
    },
    {
      sessionKey: 'C1:2',
      nodeId: 'studio-build-01',
      rootAlive: false,
      processCount: 1,
      stoppedCount: 0,
      cpuPercent: 0,
      rssBytes: 1,
      sampledAt: 1,
      processes: [],
    },
  ],
  unattributed: { processCount: 2, cpuPercent: 1, rssBytes: 1 },
};

describe('workers routes (작업 워커 tab)', () => {
  let stopWebServer: any;
  let inject: any;
  let root: string;
  let nicknames: any;

  beforeEach(async () => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-routes-'));
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    inject = webServer.injectWebServer;
    const { WorkerNicknames, setActiveWorkerNicknames } = await import('../../process-monitor/worker-nicknames');
    nicknames = new WorkerNicknames(root);
    setActiveWorkerNicknames(nicknames);
    const { setWorkerNodeSource } = await import('../workers-routes');
    setWorkerNodeSource({ fresh: async () => SNAPSHOT as any });
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    const { setActiveWorkerNicknames } = await import('../../process-monitor/worker-nicknames');
    setActiveWorkerNicknames(undefined);
    const { setWorkerNodeSource } = await import('../workers-routes');
    setWorkerNodeSource(null);
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
  async function call(method: string, url: string, headers: Record<string, string>, payload?: unknown) {
    const { 'content-type': type, ...rest } = headers;
    const sent = payload === undefined ? rest : { ...rest, ...(type ? { 'content-type': type } : {}) };
    const res = await inject({ method, url, headers: sent, ...(payload === undefined ? {} : { payload }) });
    return { status: res.statusCode as number, body: JSON.parse(res.body || 'null') };
  }
  const NICK = '/api/settings/workers/studio-build-01/nickname';

  it('an admin reads the workers: this node, its capacity, what runs on it — named by its node id until renamed', async () => {
    const h = await signIn('U_ADMIN');
    const res = await call('GET', '/api/settings/workers', h);
    expect(res.status).toBe(200);
    expect(res.body.maxNickname).toBe(24);
    expect(res.body.workers).toEqual([
      {
        nodeId: 'studio-build-01',
        nickname: null,
        name: 'studio-build-01',
        self: true,
        platform: 'darwin',
        cpuCount: 16,
        cpuBusyPercent: 42.4,
        totalMemBytes: 64 * GiB,
        availableMemBytes: 24 * GiB,
        sampledAt: 1_700_000_000_000,
        tasks: 1,
        processes: 8,
      },
    ]);
  });

  it('renaming saves the nickname, answers the row and the list reads it; null goes back to the node id', async () => {
    const h = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    const set = await call('PUT', NICK, h, { nickname: '  b01 ' });
    expect(set.status).toBe(200);
    expect(set.body.worker).toMatchObject({ nodeId: 'studio-build-01', nickname: 'b01', name: 'b01' });
    expect(nicknames.nicknameOf('studio-build-01')).toBe('b01');
    expect((await call('GET', '/api/settings/workers', h)).body.workers[0]).toMatchObject({ name: 'b01' });

    const back = await call('PUT', NICK, h, { nickname: null });
    expect(back.status).toBe(200);
    expect(back.body.worker).toMatchObject({ nickname: null, name: 'studio-build-01' });
    expect(nicknames.nicknameOf('studio-build-01')).toBeUndefined();
  });

  it('refuses a nickname the page cannot send, and a node the list does not have', async () => {
    const h = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    for (const nickname of ['', '   ', 'x'.repeat(25), 'a\nb', 7, true]) {
      expect((await call('PUT', NICK, h, { nickname })).status).toBe(400);
    }
    expect((await call('PUT', '/api/settings/workers/other-node/nickname', h, { nickname: 'o' })).status).toBe(404);
    expect(nicknames.nicknameOf('other-node')).toBeUndefined();
    expect(nicknames.nicknameOf('studio-build-01')).toBeUndefined();
  });

  it('a person who is not an admin, the viewer token, and a change without admin mode are refused', async () => {
    const alice = await signIn('U_ALICE');
    expect((await call('GET', '/api/settings/workers', alice)).status).toBe(403);
    expect((await call('PUT', NICK, { ...alice, 'x-admin-mode': 'on' }, { nickname: 'a' })).status).toBe(403);
    const token = await inject({
      method: 'GET',
      url: '/api/settings/workers',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(token.statusCode).toBe(403);
    const noMode = await signIn('U_ADMIN');
    expect((await call('PUT', NICK, noMode, { nickname: 'a' })).status).toBe(403);
    expect(nicknames.nicknameOf('studio-build-01')).toBeUndefined();
  });

  it('no process monitor on this instance: an empty list, and nothing to rename', async () => {
    const { setWorkerNodeSource } = await import('../workers-routes');
    setWorkerNodeSource(null);
    const h = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    expect((await call('GET', '/api/settings/workers', h)).body.workers).toEqual([]);
    expect((await call('PUT', NICK, h, { nickname: 'b01' })).status).toBe(404);
  });
});
