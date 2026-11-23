import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings page 작업 큐 tab, server half: an admin reads every person's limit (how many tasks they may run at
 * once — 1 by default, none for an admin) and turns one person's knob. Only an admin signed in with Slack; a change
 * needs admin mode and CSRF. A change starts what may start now.
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

describe('user task limit routes (작업 큐 tab)', () => {
  let stopWebServer: any;
  let inject: any;
  let root: string;
  let release: ReturnType<typeof vi.fn<(userId?: string) => void>>;
  let limits: any;

  beforeEach(async () => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-limits-'));
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    inject = webServer.injectWebServer;
    const secrets = await import('../secrets-routes');
    secrets.setSecretsUserSourceForTests(() => [
      { userId: 'U_ADMIN', slackDisplayName: 'Admin', accepted: true },
      { userId: 'U_ALICE', slackDisplayName: 'Alice', accepted: true },
      { userId: 'U_PENDING', slackDisplayName: 'Pending', accepted: false },
    ]);
    const { UserTaskLimits } = await import('../../user-task-queue/store');
    const { UserTaskQueue } = await import('../../user-task-queue/user-task-queue');
    const { setActiveUserTaskQueue } = await import('../../user-task-queue/active');
    limits = new UserTaskLimits(root, (id: string) => id === 'U_ADMIN');
    const queue = new UserTaskQueue({
      store: { load: () => undefined, save: () => undefined },
      limitFor: (u: string) => limits.limitFor(u),
      runningTasks: (u: string) => (u === 'U_ALICE' ? [{ sessionKey: 'C1:1', channel: 'C1', threadTs: '1' }] : []),
      start: () => undefined,
      interrupt: () => 'stopped' as const,
    });
    queue.gate({
      userId: 'U_ALICE',
      sessionKey: 'C1:2',
      channel: 'C1',
      threadTs: '2',
      text: 'x',
      message: {},
      continuation: 'none',
      admitted: false,
    });
    release = vi.fn<(userId?: string) => void>();
    setActiveUserTaskQueue({ queue, limits, release });
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    const secrets = await import('../secrets-routes');
    secrets.setSecretsUserSourceForTests(null);
    const { setActiveUserTaskQueue } = await import('../../user-task-queue/active');
    setActiveUserTaskQueue(undefined);
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

  it('an admin reads every accepted person: the default, the setting, what runs and what waits', async () => {
    const h = await signIn('U_ADMIN');
    const res = await call('GET', '/api/settings/task-limits', h);
    expect(res.status).toBe(200);
    expect(res.body.max).toBe(10);
    expect(res.body.users).toEqual([
      {
        id: 'U_ADMIN',
        name: 'Admin',
        admin: true,
        limit: null,
        setting: null,
        defaultLimit: null,
        running: 0,
        waiting: 0,
      },
      { id: 'U_ALICE', name: 'Alice', admin: false, limit: 1, setting: null, defaultLimit: 1, running: 1, waiting: 1 },
    ]);
  });

  it('turning a knob saves the limit, starts what may start, and answers the row', async () => {
    const h = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    const set = await call('PUT', '/api/settings/task-limits/U_ALICE', h, { limit: 3 });
    expect(set.status).toBe(200);
    expect(set.body.user).toMatchObject({ id: 'U_ALICE', limit: 3, setting: 3 });
    expect(limits.limitFor('U_ALICE')).toBe(3);
    expect(release).toHaveBeenCalledWith('U_ALICE');

    const unlimited = await call('PUT', '/api/settings/task-limits/U_ALICE', h, { limit: 'unlimited' });
    expect(unlimited.body.user).toMatchObject({ limit: null, setting: 'unlimited' });

    const back = await call('PUT', '/api/settings/task-limits/U_ALICE', h, { limit: null });
    expect(back.body.user).toMatchObject({ limit: 1, setting: null });
  });

  it('refuses what the knob cannot send', async () => {
    const h = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    for (const limit of [0, 11, 2.5, '3', true]) {
      const res = await call('PUT', '/api/settings/task-limits/U_ALICE', h, { limit });
      expect(res.status).toBe(400);
    }
  });

  it('a person who is not an admin, the viewer token, and a change without admin mode are refused', async () => {
    const alice = await signIn('U_ALICE');
    expect((await call('GET', '/api/settings/task-limits', alice)).status).toBe(403);
    expect((await call('PUT', '/api/settings/task-limits/U_ALICE', alice, { limit: 5 })).status).toBe(403);
    const token = await inject({
      method: 'GET',
      url: '/api/settings/task-limits',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(token.statusCode).toBe(403);
    const noMode = await signIn('U_ADMIN');
    expect((await call('PUT', '/api/settings/task-limits/U_ALICE', noMode, { limit: 5 })).status).toBe(403);
    expect(limits.limitFor('U_ALICE')).toBe(1);
  });
});
