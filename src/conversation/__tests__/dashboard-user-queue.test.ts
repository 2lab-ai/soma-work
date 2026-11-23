import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The per-user task queue on the board (server half): a thread whose request waits for its owner's free slot is in
 * 응답 필요 with its place in line; the board carries the line itself (대기큐) — also entries whose thread has no
 * session yet — and what each entry waits for; 먼저 진행 / 대기 취소 act on it.
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
// C… channels are public, D… are DMs (private) — what the channel registry would say.
vi.mock('../../channel-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../channel-registry')>()),
  getChannel: (id: string) => (id.startsWith('C') ? { id, isPrivate: false } : undefined),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

function session(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    ownerName: 'Zed',
    channelId: 'C1',
    threadTs: 't1',
    activityState: 'idle',
    state: 'MAIN',
    title: 'first task',
    lastActivity: new Date('2026-11-23T08:54:52Z'),
    ...overrides,
  };
}

describe('Dashboard — the per-user task queue (대기큐)', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;
  let active: any;
  let interrupted: string[];
  let startedIds: string[];

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    const { UserTaskQueue } = await import('../../user-task-queue/user-task-queue');
    const { setActiveUserTaskQueue } = await import('../../user-task-queue/active');
    interrupted = [];
    startedIds = [];
    let running = [{ sessionKey: 'C1:t1', channel: 'C1', threadTs: 't1', title: 'first task', startedAt: 5 }];
    const queue = new UserTaskQueue({
      store: { load: () => undefined, save: () => undefined },
      limitFor: () => 1,
      runningTasks: (u: string) => (u === 'U1' ? running : []),
      start: (e: any) => startedIds.push(e.id),
      interrupt: (t: any) => {
        interrupted.push(t.sessionKey);
        running = [];
        return 'stopped' as const;
      },
      newId: (() => {
        let n = 0;
        return () => `q${++n}`;
      })(),
    });
    active = { queue, limits: {} as any, release: vi.fn() };
    setActiveUserTaskQueue(active);
    // t2: a thread with a session whose new request waits; t3: a first message (no session yet) that waits.
    for (const t of ['t2', 't3']) {
      queue.gate({
        userId: 'U1',
        sessionKey: `C1:${t}`,
        channel: 'C1',
        threadTs: t,
        text: `request in ${t}`,
        message: { user: 'U1', channel: 'C1', ts: `${t}.1`, thread_ts: t, text: `request in ${t}` },
        continuation: 'none',
        admitted: false,
      });
    }
    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    const { setActiveUserTaskQueue } = await import('../../user-task-queue/active');
    setActiveUserTaskQueue(undefined);
    await stopWebServer();
  });

  async function board() {
    dashboard.setDashboardSessionAccessor(
      () =>
        new Map([
          ['C1:t1', session({ activityState: 'working' })],
          ['C1:t2', session({ sessionId: 'sid2', threadTs: 't2', title: 'second', activityState: 'idle' })],
        ]),
    );
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).board;
  }

  it('a thread whose request waits is in 응답 필요 with its place in line, not DONE', async () => {
    const b = await board();
    expect(b.idle).toHaveLength(0);
    expect(b.working.map((c: any) => c.threadTs)).toEqual(['t1']);
    expect(b.waiting.map((c: any) => c.threadTs)).toEqual(['t2']);
    expect(b.waiting[0].userQueue).toMatchObject({ entryId: 'q1', kind: 'request', position: 1 });
  });

  it('the board carries the line — with the entry that has no session yet — and what it waits for', async () => {
    const b = await board();
    expect(b.userQueue.map((q: any) => [q.threadTs, q.position, q.preview, q.state])).toEqual([
      ['t2', 1, 'request in t2', 'waiting'],
      ['t3', 2, 'request in t3', 'waiting'],
    ]);
    expect(b.userQueue[0]).toMatchObject({ ownerId: 'U1', ownerName: 'Zed', limit: 1, key: 'C1:t2' });
    expect(b.userQueue[0].running).toEqual([expect.objectContaining({ key: 'C1:t1', title: 'first task' })]);
  });

  it('먼저 진행 stops the running task and starts the entry; the stopped one is first in line', async () => {
    const res = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/user-queue/q2/bypass',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, deferred: { sessionKey: 'C1:t1' } });
    expect(interrupted).toEqual(['C1:t1']);
    expect(startedIds).toEqual(['q2']);
    const line = active.queue.viewFor('U1').waiting.map((w: any) => [w.sessionKey, w.kind, w.state]);
    expect(line).toEqual([
      ['C1:t3', 'request', 'admitted'],
      ['C1:t1', 'resume', 'waiting'],
      ['C1:t2', 'request', 'waiting'],
    ]);
  });

  it('대기 취소 takes the entry out; unknown entries and actions are refused', async () => {
    const cancel = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/user-queue/q1/cancel',
      headers: AUTH_HEADER,
    });
    expect(cancel.statusCode).toBe(200);
    expect(active.queue.entry('q1')).toBeUndefined();
    const gone = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/user-queue/q1/cancel',
      headers: AUTH_HEADER,
    });
    expect(gone.statusCode).toBe(404);
    const bad = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/user-queue/q2/explode',
      headers: AUTH_HEADER,
    });
    expect(bad.statusCode).toBe(404);
  });

  it('a thread that still works stays RUNNING though it has an entry in line', async () => {
    dashboard.setDashboardSessionAccessor(
      () =>
        new Map([
          ['C1:t1', session({ activityState: 'working' })],
          ['C1:t2', session({ sessionId: 'sid2', threadTs: 't2', title: 'second', activityState: 'working' })],
        ]),
    );
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    const b = JSON.parse(res.body).board;
    expect(b.working.map((c: any) => c.threadTs).sort()).toEqual(['t1', 't2']);
    expect(b.waiting).toHaveLength(0);
  });

  it('an entry everyone may see does not name its owner’s private running task', async () => {
    const { UserTaskQueue } = await import('../../user-task-queue/user-task-queue');
    const { setActiveUserTaskQueue } = await import('../../user-task-queue/active');
    const queue = new UserTaskQueue({
      store: { load: () => undefined, save: () => undefined },
      limitFor: () => 1,
      runningTasks: () => [{ sessionKey: 'D9:t1', channel: 'D9', threadTs: 't1', title: '비밀 프로젝트 X' }],
      start: () => undefined,
      interrupt: () => 'stopped' as const,
    });
    queue.gate({
      userId: 'U1',
      sessionKey: 'C1:t2',
      channel: 'C1',
      threadTs: 't2',
      text: 'public request',
      message: {},
      continuation: 'none',
      admitted: false,
    });
    setActiveUserTaskQueue({ queue, limits: {} as any, release: vi.fn() });
    const b = await board();
    expect(b.userQueue[0].running).toEqual([{ key: 'D9:t1', title: '비공개 작업' }]);
    expect(JSON.stringify(b.userQueue)).not.toContain('비밀 프로젝트 X');
  });

  it('without the queue wired the board has no 대기큐', async () => {
    const { setActiveUserTaskQueue } = await import('../../user-task-queue/active');
    setActiveUserTaskQueue(undefined);
    const b = await board();
    expect(b.userQueue).toBeUndefined();
    expect(b.idle.map((c: any) => c.threadTs)).toEqual(['t2']);
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

  it('as Slack users: another person is refused, an admin needs admin mode, the owner may — a refusal changes nothing', async () => {
    const other = await act('/api/dashboard/user-queue/q2/bypass', await signIn('U_OTHER'));
    expect(other.statusCode).toBe(403);
    const adminOff = await act('/api/dashboard/user-queue/q2/cancel', {
      ...(await signIn('U_ADMIN')),
      'x-admin-mode': 'off',
    });
    expect(adminOff.statusCode).toBe(403);
    expect(interrupted).toEqual([]);
    expect(startedIds).toEqual([]);
    expect(active.queue.viewFor('U1').waiting.map((w: any) => w.id)).toEqual(['q1', 'q2']);
    const adminOn = await act('/api/dashboard/user-queue/q2/cancel', {
      ...(await signIn('U_ADMIN')),
      'x-admin-mode': 'on',
    });
    expect(adminOn.statusCode).toBe(200);
    const owner = await act('/api/dashboard/user-queue/q1/cancel', await signIn('U1'));
    expect(owner.statusCode).toBe(200);
    expect(active.queue.viewFor('U1').waiting).toEqual([]);
  });

  it('a private entry (a DM request, even with no session yet) reaches its owner and admins only', async () => {
    const { UserTaskQueue } = await import('../../user-task-queue/user-task-queue');
    const { setActiveUserTaskQueue } = await import('../../user-task-queue/active');
    const queue = new UserTaskQueue({
      store: { load: () => undefined, save: () => undefined },
      limitFor: () => 1,
      runningTasks: () => [{ sessionKey: 'C1:t1', channel: 'C1', threadTs: 't1', title: 'first task' }],
      start: () => undefined,
      interrupt: () => 'stopped' as const,
    });
    queue.gate({
      userId: 'U1',
      sessionKey: 'D7:t7',
      channel: 'D7',
      threadTs: 't7',
      text: 'DM 비밀 요청',
      message: { channel: 'D7' },
      continuation: 'none',
      admitted: false,
    });
    setActiveUserTaskQueue({ queue, limits: {} as any, release: vi.fn() });
    dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', session({ activityState: 'working' })]]));
    const read = async (headers: Record<string, string>) =>
      JSON.parse((await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers })).body).board;
    const stranger = await read(await signIn('U_OTHER'));
    expect(JSON.stringify(stranger.userQueue ?? [])).not.toContain('DM 비밀 요청');
    expect(JSON.stringify(stranger.userQueue ?? [])).not.toContain('D7');
    const owner = await read(await signIn('U1'));
    expect(owner.userQueue.map((q: any) => q.preview)).toEqual(['DM 비밀 요청']);
    const admin = await read(await signIn('U_ADMIN'));
    expect(admin.userQueue.map((q: any) => q.preview)).toEqual(['DM 비밀 요청']);
  });
});
