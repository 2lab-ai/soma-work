import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPublicChannel } from '../__fixtures__/public-channel';

/**
 * The 프로세스 tab's routes and the card's CPU · 메모리 projection (src/process-monitor):
 *   GET  /api/dashboard/session/:key/processes            — whoever may see the task
 *   GET  /api/dashboard/session/:key/processes/:pid/detail — the owner and admins (a snapshot of one process)
 *   POST /api/dashboard/session/:key/processes/:pid/:op   — owner, or admin in admin mode; CSRF
 *   GET  /api/dashboard/nodes                             — admins (it names every session on the node)
 * The monitor is a double here; its own behaviour is pinned in src/process-monitor/__tests__.
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
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
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

const AUTH_HEADER = { Authorization: 'Bearer test-token' };
const KEY = 'C1:t1';

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'working',
    state: 'MAIN',
    lastActivity: new Date('2026-11-23T00:00:00Z'),
    ...overrides,
  };
}

const node = {
  nodeId: 'n1',
  platform: 'darwin',
  cpuCount: 8,
  cpuBusyPercent: 20,
  loadAvg1: 1,
  totalMemBytes: 16e9,
  availableMemBytes: 8e9,
};
const proc = (pid: number, extra: Record<string, unknown> = {}) => ({
  pid,
  ppid: 1,
  startToken: 'Mon Nov 23 10:00:00 2026',
  depth: 0,
  role: 'root',
  state: 'running',
  cpuPercent: 40,
  rssBytes: 300e6,
  name: 'claude',
  command: 'claude --model …',
  cwd: '/work/repo',
  ...extra,
});
function snapshot(sessions: any[] = []) {
  return { node, sampledAt: 1, sessions, unattributed: { processCount: 0, cpuPercent: 0, rssBytes: 0 } };
}
const sessionA = {
  sessionKey: KEY,
  nodeId: 'n1',
  rootAlive: true,
  processCount: 2,
  stoppedCount: 1,
  cpuPercent: 42.5,
  rssBytes: 1.2e9,
  sampledAt: 1,
  processes: [proc(200), proc(300, { ppid: 200, depth: 1, role: 'child', state: 'stopped', name: 'bash' })],
};

function fakeSource(snap = snapshot([sessionA])) {
  const listeners = new Set<(s: any) => void>();
  return {
    snap,
    latest: vi.fn(() => snap),
    fresh: vi.fn(async () => snap),
    inspect: vi.fn(async (input: any) => ({
      ok: true as const,
      detail: { pid: input.pid, startToken: input.startToken, commandLine: 'claude --model opus --mcp-config {•••}' },
    })),
    control: vi.fn(async (input: any) => ({
      ok: true as const,
      pid: input.pid,
      state: input.action === 'pause' ? 'stopped' : 'running',
    })),
    onSample: vi.fn((l: (s: any) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
    emit(s: any) {
      for (const l of listeners) l(s);
    },
  };
}

describe('Dashboard — the 프로세스 tab and the CPU · 메모리 chip', () => {
  let web: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    await web.startWebServer({ listen: false });
    await registerPublicChannel('C1');
    dashboard.setDashboardSessionAccessor(() => new Map([[KEY, liveSession()]]));
  });

  afterEach(async () => {
    dashboard.setDashboardProcessSource(null);
    await web.stopWebServer();
  });

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await web.injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await web.injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string };
  }
  const get = (headers: Record<string, string> = AUTH_HEADER, key = KEY) =>
    web.injectWebServer({ method: 'GET', url: `/api/dashboard/session/${encodeURIComponent(key)}/processes`, headers });
  const control = (op: string, pid: string | number, payload: unknown, headers: Record<string, string> = AUTH_HEADER) =>
    web.injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(KEY)}/processes/${pid}/${op}`,
      headers,
      payload,
    });

  it('GET answers the node and this session’s tree — any signed-in viewer of a public task', async () => {
    const src = fakeSource();
    dashboard.setDashboardProcessSource(src);
    const res = await get(await signIn('U2'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.node).toEqual(node);
    expect(body.session.processes.map((p: any) => p.pid)).toEqual([200, 300]);
    expect(src.fresh).toHaveBeenCalled();
  });

  it('GET shows commands to the owner and admins only (the work log’s rule); others get the rows without them', async () => {
    dashboard.setDashboardProcessSource(fakeSource());
    const read = async (who: string) => JSON.parse((await get(await signIn(who))).body);
    const owner = await read('U1');
    expect(owner.commands).toBe(true);
    expect(owner.session.processes[0].command).toBe('claude --model …');
    const admin = await read('U_ADMIN');
    expect(admin.session.processes[0].command).toBe('claude --model …');
    const other = await read('U2');
    expect(other.commands).toBe(false);
    expect(owner.session.processes[0].cwd).toBe('/work/repo');
    expect(admin.session.processes[0].cwd).toBe('/work/repo');
    // Working directories are paths of the work, like commands: the same rule.
    expect(other.session.processes.map((p: any) => [p.pid, p.command, p.cwd])).toEqual([
      [200, '', ''],
      [300, '', ''],
    ]);
    // The source's snapshot itself is untouched.
    expect(sessionA.processes[0].command).toBe('claude --model …');
    expect(sessionA.processes[0].cwd).toBe('/work/repo');
  });

  it('GET answers session null when the task has no live process, 503 with no monitor', async () => {
    expect((await get()).statusCode).toBe(503);
    dashboard.setDashboardProcessSource(fakeSource(snapshot([])));
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).session).toBeNull();
  });

  it('GET of a private task is hidden from another user (the private-task gate covers the route)', async () => {
    dashboard.setDashboardSessionAccessor(() => new Map([[KEY, liveSession({ channelId: 'D_PRIVATE' })]]));
    dashboard.setDashboardProcessSource(fakeSource());
    expect((await get(await signIn('U2'))).statusCode).toBe(404);
    expect((await get(await signIn('U1'))).statusCode).toBe(200);
  });

  const detail = (pid: string | number, start: string | null, headers: Record<string, string> = AUTH_HEADER) =>
    web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/${encodeURIComponent(KEY)}/processes/${pid}/detail${start === null ? '' : `?start=${encodeURIComponent(start)}`}`,
      headers,
    });

  it('GET …/:pid/detail answers the monitor’s snapshot of that process — the owner and admins only', async () => {
    const src = fakeSource();
    dashboard.setDashboardProcessSource(src);
    const start = 'Mon Nov 23 10:00:00 2026';
    const owner = await detail(300, start, await signIn('U1'));
    expect(owner.statusCode).toBe(200);
    expect(JSON.parse(owner.body)).toEqual({
      ok: true,
      detail: { pid: 300, startToken: start, commandLine: 'claude --model opus --mcp-config {•••}' },
    });
    expect(src.inspect).toHaveBeenCalledWith({ sessionKey: KEY, pid: 300, startToken: start });
    // An admin reads without admin mode (a read, like the commands).
    expect((await detail(300, start, await signIn('U_ADMIN'))).statusCode).toBe(200);
    const other = await detail(300, start, await signIn('U2'));
    expect(other.statusCode).toBe(403);
    expect(JSON.parse(other.body).code).toBe('forbidden');
    expect(src.inspect).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['abc', 'x'],
    [0, 'x'],
    [300, null],
    [300, ''],
    [300, 'x'.repeat(65)],
  ])('GET …/%s/detail?start=%s → 400, and the monitor is never asked', async (pid, start) => {
    const src = fakeSource();
    dashboard.setDashboardProcessSource(src);
    expect((await detail(pid, start as string | null)).statusCode).toBe(400);
    expect(src.inspect).not.toHaveBeenCalled();
  });

  it.each([
    ['not-found', 404],
    ['stale', 409],
    ['unsupported', 501],
  ])('GET …/detail answers the monitor’s refusal %s with %i; 503 with no monitor', async (reason, status) => {
    expect((await detail(300, 'x')).statusCode).toBe(503);
    const src = fakeSource();
    src.inspect.mockResolvedValueOnce({ ok: false, reason } as any);
    dashboard.setDashboardProcessSource(src);
    const res = await detail(300, 'x');
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ ok: false, code: reason });
  });

  it('GET …/detail of a private task is hidden from another user', async () => {
    dashboard.setDashboardSessionAccessor(() => new Map([[KEY, liveSession({ channelId: 'D_PRIVATE' })]]));
    dashboard.setDashboardProcessSource(fakeSource());
    expect((await detail(300, 'x', await signIn('U2'))).statusCode).toBe(404);
    expect((await detail(300, 'x', await signIn('U1'))).statusCode).toBe(200);
  });

  it('POST pauses through the monitor with the pid and the start time the tab showed', async () => {
    const src = fakeSource();
    dashboard.setDashboardProcessSource(src);
    const res = await control('pause', 300, { startToken: 'Mon Nov 23 10:00:00 2026' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, pid: 300, state: 'stopped' });
    expect(src.control).toHaveBeenCalledWith({
      sessionKey: KEY,
      pid: 300,
      startToken: 'Mon Nov 23 10:00:00 2026',
      action: 'pause',
    });
  });

  it('POST resume continues through the monitor and answers the running state', async () => {
    const src = fakeSource();
    dashboard.setDashboardProcessSource(src);
    const res = await control('resume', 300, { startToken: 'Mon Nov 23 10:00:00 2026' });
    expect(JSON.parse(res.body)).toEqual({ ok: true, pid: 300, state: 'running' });
    expect(src.control).toHaveBeenCalledWith(expect.objectContaining({ pid: 300, action: 'resume' }));
  });

  it('POST: owner yes; another user 403; admin only in admin mode; no CSRF 403', async () => {
    const src = fakeSource();
    dashboard.setDashboardProcessSource(src);
    const body = { startToken: 'Mon Nov 23 10:00:00 2026' };
    expect((await control('resume', 300, body, await signIn('U1'))).statusCode).toBe(200);
    expect((await control('resume', 300, body, await signIn('U2'))).statusCode).toBe(403);
    const admin = await signIn('U_ADMIN');
    expect((await control('resume', 300, body, admin)).statusCode).toBe(403);
    expect((await control('resume', 300, body, { ...admin, 'x-admin-mode': 'on' })).statusCode).toBe(200);
    const { cookie } = await signIn('U1');
    expect((await control('resume', 300, body, { cookie })).statusCode).toBe(403);
    expect(src.control).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['kill', 300, { startToken: 'x' }, 404],
    ['pause', 'abc', { startToken: 'x' }, 400],
    ['pause', 0, { startToken: 'x' }, 400],
    ['pause', 300, {}, 400],
    ['pause', 300, { startToken: 'x'.repeat(65) }, 400],
  ])('POST %s %s %j → %i, and the monitor is never asked', async (op, pid, payload, status) => {
    const src = fakeSource();
    dashboard.setDashboardProcessSource(src);
    expect((await control(op, pid, payload)).statusCode).toBe(status);
    expect(src.control).not.toHaveBeenCalled();
  });

  it.each([
    ['not-found', 404],
    ['stale', 409],
    ['denied', 403],
    ['unsupported', 501],
  ])('POST answers the monitor’s refusal %s with %i', async (reason, status) => {
    const src = fakeSource();
    src.control.mockResolvedValueOnce({ ok: false, reason } as any);
    dashboard.setDashboardProcessSource(src);
    const res = await control('pause', 300, { startToken: 'x' });
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ ok: false, code: reason });
  });

  it('a sibling instance’s key is refused (409) — its processes are on that instance', async () => {
    dashboard.setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    try {
      dashboard.setDashboardProcessSource(fakeSource());
      expect((await get(AUTH_HEADER, 'other-instance::C9:t9')).statusCode).toBe(409);
      expect((await get(AUTH_HEADER, `self-host::${KEY}`)).statusCode).toBe(200);
    } finally {
      dashboard.setSelfInstanceEnv(undefined as never);
    }
  });

  it('the board card carries procUsage from the latest sample, and none when the session has no process', async () => {
    dashboard.setDashboardProcessSource(fakeSource());
    const board = JSON.parse(
      (await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER })).body,
    ).board;
    const card = [...board.working, ...board.waiting, ...board.idle].find((c: any) => c.key.endsWith(KEY));
    expect(card.procUsage).toEqual({
      nodeId: 'n1',
      cpuCount: 8,
      // The node badge: the whole node's CPU (all cores) and memory in use (16 GB, 8 GB available).
      nodeCpuPercent: 20,
      nodeMemPercent: 50,
      rootAlive: true,
      processCount: 2,
      stoppedCount: 1,
      cpuPercent: 42.5,
      rssBytes: 1.2e9,
    });

    dashboard.setDashboardProcessSource(fakeSource(snapshot([])));
    const board2 = JSON.parse(
      (await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER })).body,
    ).board;
    const card2 = [...board2.working, ...board2.waiting, ...board2.idle].find((c: any) => c.key.endsWith(KEY));
    expect(card2).not.toHaveProperty('procUsage');
  });

  it('GET /api/dashboard/nodes: admins get each node’s capacity and per-session totals; others 403', async () => {
    dashboard.setDashboardProcessSource(fakeSource());
    expect(
      (await web.injectWebServer({ method: 'GET', url: '/api/dashboard/nodes', headers: await signIn('U2') }))
        .statusCode,
    ).toBe(403);
    const res = await web.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/nodes',
      headers: await signIn('U_ADMIN'),
    });
    expect(res.statusCode).toBe(200);
    const [n] = JSON.parse(res.body).nodes;
    expect(n.node).toEqual(node);
    expect(n.sessions).toEqual([
      {
        sessionKey: KEY,
        nodeId: 'n1',
        rootAlive: true,
        processCount: 2,
        stoppedCount: 1,
        cpuPercent: 42.5,
        rssBytes: 1.2e9,
        sampledAt: 1,
      },
    ]);
  });

  it('a sample pushes only cards whose chip changed, and once more when the last process exits', () => {
    const pushed = new Map<string, string>();
    expect(dashboard.procCardsToPush(pushed, snapshot([sessionA]))).toEqual([KEY]);
    // Same 5-point CPU bucket (over 10%), same 10 MB: no push.
    expect(
      dashboard.procCardsToPush(pushed, snapshot([{ ...sessionA, cpuPercent: 43.9, rssBytes: 1.2e9 + 1e6 }])),
    ).toEqual([]);
    // Another bucket: a push. Memory alone moving 10 MB: a push. CPU alone under 10%, a whole point: a push.
    expect(dashboard.procCardsToPush(pushed, snapshot([{ ...sessionA, cpuPercent: 61 }]))).toEqual([KEY]);
    expect(dashboard.procCardsToPush(pushed, snapshot([{ ...sessionA, cpuPercent: 61, rssBytes: 1.3e9 }]))).toEqual([
      KEY,
    ]);
    expect(dashboard.procCardsToPush(pushed, snapshot([{ ...sessionA, cpuPercent: 3, rssBytes: 1.3e9 }]))).toEqual([
      KEY,
    ]);
    expect(dashboard.procCardsToPush(pushed, snapshot([{ ...sessionA, cpuPercent: 4, rssBytes: 1.3e9 }]))).toEqual([
      KEY,
    ]);
    // A process paused: the chip changes.
    expect(dashboard.procCardsToPush(pushed, snapshot([{ ...sessionA, stoppedCount: 2 }]))).toEqual([KEY]);
    // The node badge's gauges: a push when the node's CPU or memory crosses a 10-point step, none inside one.
    const at = (cpuBusyPercent: number | null, availableMemBytes = 8e9) => ({
      ...snapshot([{ ...sessionA, stoppedCount: 2 }]),
      node: { ...node, cpuBusyPercent, availableMemBytes },
    });
    expect(dashboard.procCardsToPush(pushed, at(20))).toEqual([]);
    expect(dashboard.procCardsToPush(pushed, at(19.5))).toEqual([]);
    expect(dashboard.procCardsToPush(pushed, at(21))).toEqual([KEY]);
    expect(dashboard.procCardsToPush(pushed, at(21, 7e9))).toEqual([KEY]);
    expect(dashboard.procCardsToPush(pushed, at(null, 7e9))).toEqual([KEY]);
    // Every process gone: one more push so the chip disappears, then nothing.
    expect(dashboard.procCardsToPush(pushed, snapshot([]))).toEqual([KEY]);
    expect(dashboard.procCardsToPush(pushed, snapshot([]))).toEqual([]);
  });

  it('gaugeStep fills the badge’s 10 steps: 0 → 0, any load → at least 1, 100 → 10; nodeLoadOf clamps', () => {
    expect([null, -1, 0, 0.1, 10, 10.1, 55, 99, 100, 140].map(dashboard.gaugeStep)).toEqual([
      0, 0, 0, 1, 1, 2, 6, 10, 10, 10,
    ]);
    expect(dashboard.nodeLoadOf(node)).toEqual({ cpu: 20, mem: 50 });
    expect(dashboard.nodeLoadOf({ ...node, cpuBusyPercent: null, totalMemBytes: 0 })).toEqual({ cpu: null, mem: null });
    expect(dashboard.nodeLoadOf({ ...node, cpuBusyPercent: 100.4, availableMemBytes: -1 })).toEqual({
      cpu: 100,
      mem: 100,
    });
  });

  it('a wired source’s samples push the changed cards; unwiring stops them', () => {
    const src = fakeSource();
    const pushCard = vi.fn();
    dashboard.setDashboardProcessSource(src, pushCard);
    src.emit(snapshot([sessionA]));
    src.emit(snapshot([sessionA])); // nothing changed
    src.emit(snapshot([])); // the last process exited
    expect(pushCard.mock.calls).toEqual([[KEY], [KEY]]);
    dashboard.setDashboardProcessSource(null);
    src.emit(snapshot([sessionA]));
    expect(pushCard).toHaveBeenCalledTimes(2);
  });
});
