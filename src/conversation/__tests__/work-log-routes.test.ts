import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (same shape as dashboard.test.ts) ──

const VIEWER_TOKEN = 'test-token';

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: VIEWER_TOKEN,
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    // Empty → getJwtSecret() falls back to the viewer token.
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

const paths = vi.hoisted(() => ({ dataDir: '' }));

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  get DATA_DIR() {
    return paths.dataDir;
  },
}));
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
  getArchiveStore: () => ({ listRecent: vi.fn().mockReturnValue([]) }),
}));

const AUTH_HEADER = { Authorization: `Bearer ${VIEWER_TOKEN}` };

function userCookie(sub: string): string {
  const token = jwt.sign({ sub, email: `${sub}@x`, name: sub, provider: 'slack' }, VIEWER_TOKEN, { expiresIn: 3600 });
  return `soma_dash_token=${encodeURIComponent(token)}`;
}

const CONVERSATION = {
  id: 'conv-1',
  ownerId: 'U_OWNER',
  ownerName: 'Owner',
  title: 'Work',
  workflow: 'default',
  createdAt: 1,
  updatedAt: 2,
  turns: [],
};

describe('GET /api/dashboard/session/:conversationId/worklog', () => {
  let web: typeof import('../web-server');
  let workLog: typeof import('../work-log');

  beforeEach(async () => {
    vi.resetModules();
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-worklog-route-'));
    web = await import('../web-server');
    workLog = await import('../work-log');
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockImplementation(async (id: string) => (id === 'conv-1' ? CONVERSATION : null));
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await web.stopWebServer();
    await workLog.flushWorkLog();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  it('returns 401 JSON without credentials', async () => {
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/session/conv-1/worklog' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('Unauthorized');
  });

  it('returns 404 for an unknown conversation, like the session-turns API', async () => {
    const res = await web.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-nope/worklog',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the stored entries in seq order', async () => {
    await workLog.appendWorkLog('conv-1', { kind: 'instruction', text: 'fix it' });
    await workLog.appendWorkLog('conv-1', { kind: 'tool', text: 'Bash: npm test', tool: 'Bash' });
    await workLog.appendWorkLog('conv-1', { kind: 'final', text: 'fixed' });

    const res = await web.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-1/worklog',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasMore).toBe(false);
    expect(body.entries.map((e: { seq: number; kind: string }) => [e.seq, e.kind])).toEqual([
      [1, 'instruction'],
      [2, 'tool'],
      [3, 'final'],
    ]);
  });

  it('pages: latest window without afterSeq, forward from afterSeq, hasMore on both, bad values clamped', async () => {
    for (let i = 1; i <= 6; i++) await workLog.appendWorkLog('conv-1', { kind: 'narration', text: `n${i}` });
    const get = async (qs: string): Promise<[number[], boolean]> => {
      const res = await web.injectWebServer({
        method: 'GET',
        url: `/api/dashboard/session/conv-1/worklog${qs}`,
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { entries: Array<{ seq: number }>; hasMore: boolean };
      return [body.entries.map((e) => e.seq), body.hasMore];
    };
    // Latest window; hasMore = older entries exist.
    expect(await get('?limit=2')).toEqual([[5, 6], true]);
    expect(await get('?limit=0')).toEqual([[6], true]); // clamped to 1
    expect(await get('?limit=abc&afterSeq=-3')).toEqual([[1, 2, 3, 4, 5, 6], false]); // defaults
    // Forward pages; hasMore = newer entries follow.
    expect(await get('?afterSeq=1&limit=2')).toEqual([[2, 3], true]);
    expect(await get('?afterSeq=3&limit=2')).toEqual([[4, 5], true]);
    expect(await get('?afterSeq=5&limit=2')).toEqual([[6], false]);
    expect(await get('?afterSeq=0&limit=2')).toEqual([[1, 2], true]);
    expect(await get('?afterSeq=4')).toEqual([[5, 6], false]);
    expect(await get('?afterSeq=6')).toEqual([[], false]);
  });

  // #716: dashboard reads are world-readable for any authenticated user. The
  // session-turns API does not restrict reads to the owner, so the work log
  // follows the same policy.
  it('lets the owner and a non-owner logged-in user read, like the session-turns API', async () => {
    await workLog.appendWorkLog('conv-1', { kind: 'narration', text: 'hello' });
    for (const sub of ['U_OWNER', 'U_OTHER']) {
      const res = await web.injectWebServer({
        method: 'GET',
        url: '/api/dashboard/session/conv-1/worklog',
        headers: { cookie: userCookie(sub) },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).entries).toHaveLength(1);

      const turns = await web.injectWebServer({
        method: 'GET',
        url: '/api/dashboard/session/conv-1',
        headers: { cookie: userCookie(sub) },
      });
      expect(turns.statusCode).toBe(200);
    }
  });
});

describe('work_log WebSocket broadcast scoping', () => {
  let web: typeof import('../web-server');
  let dashboard: typeof import('../dashboard');
  let workLog: typeof import('../work-log');
  const sockets: any[] = [];

  async function connect(headers: Record<string, string>): Promise<{ messages: any[] }> {
    const messages: any[] = [];
    const ws = await web.injectWebServerWS('/ws/dashboard', { headers }, (socket: any) => {
      socket.on('message', (data: any) => messages.push(JSON.parse(data.toString())));
    });
    sockets.push(ws);
    return { messages };
  }

  /**
   * Scoped events are only provable as "not delivered" relative to a later
   * event that every client gets. session_update goes to everyone, and one
   * socket preserves order, so once it arrives anything scoped sent earlier
   * would already be there.
   */
  async function flushAll(clients: Array<{ messages: any[] }>): Promise<void> {
    const marks = clients.map((c) => c.messages.filter((m) => m.type === 'session_update').length);
    dashboard.broadcastSessionUpdate();
    await vi.waitFor(() => {
      clients.forEach((c, i) => {
        expect(c.messages.filter((m) => m.type === 'session_update').length).toBeGreaterThan(marks[i]);
      });
    });
  }

  const workLogs = (c: { messages: any[] }) => c.messages.filter((m) => m.type === 'work_log');

  beforeEach(async () => {
    vi.resetModules();
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-worklog-ws-'));
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    workLog = await import('../work-log');
    dashboard.setDashboardSessionAccessor(
      () =>
        new Map<string, any>([
          [
            'C1:t1',
            {
              sessionId: 'sid1',
              conversationId: 'conv-live',
              title: 'Live',
              ownerId: 'U_OWNER',
              ownerName: 'Owner',
              workflow: 'default',
              model: 'claude-opus-4-6',
              channelId: 'C1',
              threadTs: 't1',
              activityState: 'working',
              state: 'MAIN',
              lastActivity: new Date('2026-10-16T00:00:00Z'),
            },
          ],
        ]),
    );
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await web.stopWebServer();
    await workLog.flushWorkLog();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  it('rejects an unauthenticated upgrade', async () => {
    await expect(web.injectWebServerWS('/ws/dashboard', { headers: {} })).rejects.toThrow(/302/);
  });

  it('sends work_log to the session owner and admins only', async () => {
    const owner = await connect({ cookie: userCookie('U_OWNER') });
    const other = await connect({ cookie: userCookie('U_OTHER') });
    const admin = await connect({ cookie: userCookie('U_ADMIN') });
    // injectWS hands headers to the route as-is (no lowercasing like Node's parser).
    const bearer = await connect({ authorization: `Bearer ${VIEWER_TOKEN}` });

    // Wired the way src/index.ts wires it.
    workLog.setOnWorkLogAppendedCallback(dashboard.broadcastWorkLog);
    const entry = await workLog.appendWorkLog('conv-live', { kind: 'narration', text: 'reading the code' });
    await flushAll([owner, other, admin, bearer]);

    expect(workLogs(owner)).toEqual([{ type: 'work_log', conversationId: 'conv-live', entry }]);
    expect(workLogs(admin)).toHaveLength(1);
    expect(workLogs(bearer)).toHaveLength(1);
    expect(workLogs(other)).toHaveLength(0);
  });

  it('sends work_log only to admins when no live session owns the conversation', async () => {
    const owner = await connect({ cookie: userCookie('U_OWNER') });
    const admin = await connect({ cookie: userCookie('U_ADMIN') });

    dashboard.broadcastWorkLog('conv-archived', { seq: 1, ts: 1, kind: 'notice', text: 'compacted' });
    await flushAll([owner, admin]);

    expect(workLogs(owner)).toHaveLength(0);
    expect(workLogs(admin)).toHaveLength(1);
  });

  it('keeps conversation_update on the same audience after the shared-scope refactor', async () => {
    const owner = await connect({ cookie: userCookie('U_OWNER') });
    const other = await connect({ cookie: userCookie('U_OTHER') });

    dashboard.broadcastConversationUpdate('conv-live', { id: 't1', role: 'assistant', rawContent: 'long text' });
    await flushAll([owner, other]);

    const updates = (c: { messages: any[] }) => c.messages.filter((m) => m.type === 'conversation_update');
    expect(updates(owner)).toHaveLength(1);
    expect(updates(owner)[0].turn.rawContent).toBeUndefined();
    expect(updates(other)).toHaveLength(0);
  });
});
