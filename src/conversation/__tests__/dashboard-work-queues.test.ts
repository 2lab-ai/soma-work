import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The board's 작업 큐 section, server half (.prd/36 v2 §4.3): `GET /api/dashboard/work-queues` reads every lane and
 * every person's queue in one shape (what runs, what waits, what left), named for the reader; `POST
 * /api/dashboard/work-queues/:entry/:action` lets an admin (admin mode) move a waiting lane entry first or give a
 * running one back, and the entry's holder (or an admin) take a waiting one out.
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
vi.mock('../../admin-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../admin-utils')>()),
  isAdminUser: (id: string) => id === 'U_ADMIN',
}));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
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
vi.mock('../../channel-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../channel-registry')>()),
  getChannel: (id: string) => (id.startsWith('C') ? { id, isPrivate: false } : undefined),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

function session(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    ownerName: 'Ann',
    channelId: 'C1',
    threadTs: 't1',
    activityState: 'idle',
    state: 'MAIN',
    title: 'ABC-1 QA',
    lastActivity: new Date('2026-11-26T08:00:00Z'),
    ...overrides,
  };
}

describe('Dashboard — the 작업 큐 section (lanes and people)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let store: any;
  let posted: Array<{ threadTs: string; text: string }>;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    const { MemoryWorkQueueStore } = await import('somalib/work-queue/memory-store');
    const { enterQueue } = await import('somalib/work-queue/ledger');
    const { WorkQueueHost, setActiveWorkQueueHost } = await import('../../work-queue/host');
    store = new MemoryWorkQueueStore();
    posted = [];
    const holder = (user: string, threadTs: string) => ({ user, channel: 'C1', threadTs });
    store.mutate((l: any) => enterQueue(l, { queue: 'qa-dev2', keys: ['ABC-1'], holder: holder('U1', 't1') }, 10));
    store.mutate((l: any) => enterQueue(l, { queue: 'qa-dev2', keys: ['ABC-2'], holder: holder('U2', 't2') }, 20));
    store.mutate((l: any) => enterQueue(l, { queue: 'qa-dev2', keys: ['ABC-3'], holder: holder('U3', 't3') }, 30));
    const host = new WorkQueueHost({
      store,
      probe: () => ({ exists: true, activity: 'idle', activityChangedAt: Date.now() }),
      deliver: () => undefined,
      post: async (h: any, text: string) => {
        posted.push({ threadTs: h.threadTs, text });
      },
      pinned: () => ['deploy-dev2'],
    });
    setActiveWorkQueueHost(host);
    dashboard.setDashboardSessionAccessor(
      () =>
        new Map([
          ['C1:t1', session()],
          ['C1:t2', session({ sessionId: 'sid2', ownerId: 'U2', ownerName: 'Bob', threadTs: 't2', title: 'ABC-2 QA' })],
        ]),
    );
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    const { setActiveWorkQueueHost } = await import('../../work-queue/host');
    setActiveWorkQueueHost(undefined);
    await stopWebServer();
  });

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string };
  }
  const act = (url: string, headers: Record<string, string>) =>
    injectWebServer({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{}',
    });

  it('lists the pinned lane and every lane in use: what runs, what waits in order, named by its session', async () => {
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/work-queues', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.lanes.map((q: any) => q.id)).toEqual(['deploy-dev2', 'qa-dev2']);
    const qa = body.lanes[1];
    expect(qa).toMatchObject({ kind: 'lane', capacity: 1 });
    expect(qa.running).toEqual([
      expect.objectContaining({
        id: 'wq-1',
        keys: ['ABC-1'],
        task: expect.objectContaining({ key: 'C1:t1', title: 'ABC-1 QA', ownerName: 'Ann' }),
      }),
    ]);
    expect(qa.waiting.map((e: any) => [e.id, e.position, e.task.ownerName])).toEqual([
      ['wq-2', 1, 'Bob'],
      ['wq-3', 2, 'U3'],
    ]);
  });

  it('an admin in admin mode lets an entry go first and gives the running turn back; its thread hears it', async () => {
    const admin = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    expect((await act('/api/dashboard/work-queues/wq-3/first', admin)).statusCode).toBe(200);
    expect(store.read().entries.map((e: any) => e.id)).toEqual(['wq-1', 'wq-3', 'wq-2']);
    expect((await act('/api/dashboard/work-queues/wq-1/release', admin)).statusCode).toBe(200);
    expect(store.read().entries.find((e: any) => e.state === 'running')?.id).toBe('wq-3');
    expect(posted.map((p) => p.threadTs)).toEqual(['t1']);
    expect(store.read().records.slice(-1)[0]).toMatchObject({ id: 'wq-1', end: 'released', reason: 'admin:U_ADMIN' });
  });

  it('a holder takes its own waiting entry out; another person, or an admin without admin mode, is refused', async () => {
    expect((await act('/api/dashboard/work-queues/wq-2/cancel', await signIn('U9'))).statusCode).toBe(403);
    expect(
      (await act('/api/dashboard/work-queues/wq-2/first', { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'off' }))
        .statusCode,
    ).toBe(403);
    expect((await act('/api/dashboard/work-queues/wq-2/first', await signIn('U2'))).statusCode).toBe(403);
    expect((await act('/api/dashboard/work-queues/wq-2/cancel', await signIn('U2'))).statusCode).toBe(200);
    expect(store.read().entries.map((e: any) => e.id)).toEqual(['wq-1', 'wq-3']);
  });

  it('an admin in admin mode forgets an idle lane; a busy lane is 409, anyone else 403', async () => {
    const admin = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    expect((await act('/api/dashboard/work-queues/lane/qa-dev2/forget', admin)).statusCode).toBe(409);
    expect((await act('/api/dashboard/work-queues/lane/qa-dev2/forget', await signIn('U1'))).statusCode).toBe(403);
    const { endEntry } = await import('somalib/work-queue/ledger');
    for (const id of ['wq-1', 'wq-2', 'wq-3']) {
      store.mutate((l: any) => {
        const e = l.entries.find((x: any) => x.id === id);
        return endEntry(l, { id, end: 'done', actor: e.holder }, 40);
      });
    }
    const res = await act('/api/dashboard/work-queues/lane/qa-dev2/forget', admin);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, removed: 3 });
    const view = JSON.parse(
      (await injectWebServer({ method: 'GET', url: '/api/dashboard/work-queues', headers: AUTH_HEADER })).body,
    );
    expect(view.lanes.map((q: any) => q.id)).toEqual(['deploy-dev2']);
  });

  it('says why it cannot: gone, wrong state, unknown action', async () => {
    const admin = { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' };
    expect((await act('/api/dashboard/work-queues/wq-9/cancel', admin)).statusCode).toBe(404);
    expect((await act('/api/dashboard/work-queues/wq-1/first', admin)).statusCode).toBe(409);
    expect((await act('/api/dashboard/work-queues/wq-1/explode', admin)).statusCode).toBe(404);
  });
});
