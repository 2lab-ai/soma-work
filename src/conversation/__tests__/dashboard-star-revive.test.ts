import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task star + revive (SSOT 2026-10-30) — the HTTP half.
 *
 *   T1.2 POST /api/dashboard/session/:key/star   { starred }
 *   T4.1 POST /api/dashboard/session/:key/revive
 *   T5   starring an archived card restores it first
 *   T2.1 the board lists starred cards first in their column
 *
 * The registry semantics are covered in session-registry-star-revive.test.ts;
 * here the host handler is a double and the HTTP contract around it is pinned:
 * owner gate (an archived card by its archive's owner), the exact archive the
 * card names, refusals answered with their status and words.
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

const mockLoad = vi.fn();
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [], load: mockLoad }),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };
const ARCHIVED_KEY = 'archived_work:C1:800.001_1793600000000';

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'idle',
    state: 'MAIN',
    lastActivity: new Date('2026-10-23T00:00:00Z'),
    ...overrides,
  };
}

function archivedRecord(overrides: Record<string, any> = {}) {
  return {
    archivedAt: 1793600000000,
    archiveReason: 'sleep_expired',
    sessionKey: 'work:C1:800.001',
    sessionId: '7f3c2a10-0000-4000-8000-000000000001',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: '800.001',
    lastActivity: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('Dashboard — task star + revive (SSOT 2026-10-30)', () => {
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;
  let sessions: Map<string, any>;

  beforeEach(async () => {
    vi.resetModules();
    mockLoad.mockReset();
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    await webServer.startWebServer({ listen: false });
    sessions = new Map([['C1:t1', liveSession()]]);
    dashboard.setDashboardSessionAccessor(() => sessions);
    // The first import transforms the whole dashboard module (cold, under parallel load).
  }, 60_000);

  afterEach(async () => {
    await stopWebServer();
  });

  async function post(action: string, payload: any, headers: Record<string, string> = AUTH_HEADER, key = 'C1:t1') {
    return injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/${action}`,
      headers,
      payload,
    });
  }

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string };
  }

  function handler(overrides: Record<string, any> = {}) {
    const h = {
      star: vi.fn((key: string, starred: boolean) => ({ ok: true, sessionKey: key, starred, revived: false })),
      revive: vi.fn((key: string) => ({ ok: true, sessionKey: key, starred: false, revived: true })),
      restore: vi.fn(() => ({ ok: true, sessionKey: 'work:C1:800.001', starred: false, revived: true })),
      ...overrides,
    };
    dashboard.setDashboardLifecycleHandler(h);
    return h;
  }

  it('T1.2 — star / unstar a live session through the host handler', async () => {
    const h = handler();
    const res = await post('star', { starred: true });
    expect(res.statusCode).toBe(200);
    expect(h.star).toHaveBeenCalledWith('C1:t1', true);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, key: 'C1:t1', starred: true });

    const off = await post('star', { starred: false });
    expect(off.statusCode).toBe(200);
    expect(h.star).toHaveBeenLastCalledWith('C1:t1', false);
  });

  it.each([[{}], [{ starred: 'yes' }], [{ starred: 1 }]])('T1.2 — 400 for %j', async (body) => {
    handler();
    expect((await post('star', body)).statusCode).toBe(400);
  });

  it('T1.2 — the owner may star; another signed-in user may not (403)', async () => {
    const h = handler();
    expect((await post('star', { starred: true }, await signIn('U2'))).statusCode).toBe(403);
    expect(h.star).not.toHaveBeenCalled();
    expect((await post('star', { starred: true }, await signIn('U1'))).statusCode).toBe(200);
  });

  it('501 when no handler is wired', async () => {
    expect((await post('star', { starred: true })).statusCode).toBe(501);
    expect((await post('revive', {})).statusCode).toBe(501);
  });

  it('T4.1 — revive a live (sleeping) session', async () => {
    const h = handler();
    const res = await post('revive', {});
    expect(res.statusCode).toBe(200);
    expect(h.revive).toHaveBeenCalledWith('C1:t1');
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, key: 'C1:t1', revived: true });
  });

  it('T4.1 — revive an archived card: the exact archive it names, gated by the archive owner, answered with the live key', async () => {
    const h = handler();
    const record = archivedRecord();
    mockLoad.mockReturnValue(record);

    expect((await post('revive', {}, await signIn('U2'), ARCHIVED_KEY)).statusCode).toBe(403);
    expect(h.restore).not.toHaveBeenCalled();

    const res = await post('revive', {}, await signIn('U1'), ARCHIVED_KEY);
    expect(res.statusCode).toBe(200);
    expect(mockLoad).toHaveBeenCalledWith('work:C1:800.001', 1793600000000);
    expect(h.restore).toHaveBeenCalledWith(record);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, key: 'work:C1:800.001', revived: true });
  });

  it('T4.1 — an archived card whose archive is gone is a 404', async () => {
    handler();
    mockLoad.mockReturnValue(null);
    expect((await post('revive', {}, AUTH_HEADER, ARCHIVED_KEY)).statusCode).toBe(404);
  });

  it('T5 — starring an archived card restores it, then stars the live session', async () => {
    const h = handler();
    mockLoad.mockReturnValue(archivedRecord());
    const res = await post('star', { starred: true }, AUTH_HEADER, ARCHIVED_KEY);
    expect(res.statusCode).toBe(200);
    expect(h.restore).toHaveBeenCalledTimes(1);
    expect(h.star).toHaveBeenCalledWith('work:C1:800.001', true);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, key: 'work:C1:800.001', starred: true, revived: true });
  });

  it.each([
    ['transcript_missing', 422],
    ['invalid_cwd', 422],
    ['incident_provenance', 422],
    ['no_conversation', 422],
    ['conflict', 409],
    ['terminated', 409],
    ['forbidden', 403],
    ['not_found', 404],
  ])('a refusal (%s) is answered with %i and its words', async (code, status) => {
    handler({ restore: vi.fn(() => ({ ok: false, code, message: `거부: ${code}` })) });
    mockLoad.mockReturnValue(archivedRecord());
    const res = await post('revive', {}, AUTH_HEADER, ARCHIVED_KEY);
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toMatchObject({ error: `거부: ${code}`, code });
  });

  it('a starred session cannot be put in the trash (409)', async () => {
    handler();
    const trash = vi.fn();
    dashboard.setDashboardTrashHandler(trash);
    sessions.set('C1:t1', liveSession({ starred: true }));
    expect((await post('trash', {})).statusCode).toBe(409);
    expect(trash).not.toHaveBeenCalled();
  });

  it('T2.1 — the board lists starred cards first in their column and marks them', async () => {
    sessions = new Map([
      ['C1:a', liveSession({ threadTs: 'a', lastActivity: new Date('2026-10-29T00:00:00Z') })],
      ['C1:b', liveSession({ threadTs: 'b', starred: true, lastActivity: new Date('2026-10-01T00:00:00Z') })],
      ['C1:c', liveSession({ threadTs: 'c', lastActivity: new Date('2026-10-28T00:00:00Z') })],
    ]);
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    const { board } = JSON.parse(res.body);
    expect(board.idle.map((s: any) => s.key)).toEqual(['C1:b', 'C1:a', 'C1:c']);
    expect(board.idle[0].starred).toBe(true);
    expect(board.idle[1].starred).toBeUndefined();
  });
});
