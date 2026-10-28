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

  it('pages: latest window without afterSeq, forward from afterSeq, hasMore on both', async () => {
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
    expect(await get('')).toEqual([[1, 2, 3, 4, 5, 6], false]);
    expect(await get('?limit=2')).toEqual([[5, 6], true]);
    expect(await get('?limit=1')).toEqual([[6], true]);
    expect(await get('?limit=500')).toEqual([[1, 2, 3, 4, 5, 6], false]);
    // Forward pages; hasMore = newer entries follow.
    expect(await get('?afterSeq=1&limit=2')).toEqual([[2, 3], true]);
    expect(await get('?afterSeq=3&limit=2')).toEqual([[4, 5], true]);
    expect(await get('?afterSeq=5&limit=2')).toEqual([[6], false]);
    expect(await get('?afterSeq=0&limit=2')).toEqual([[1, 2], true]);
    expect(await get('?afterSeq=4')).toEqual([[5, 6], false]);
    expect(await get('?afterSeq=6')).toEqual([[], false]);
    expect(await get('?afterSeq=9007199254740991')).toEqual([[], false]);
  });

  it.each([
    '?limit=0',
    '?limit=501',
    '?limit=-1',
    '?limit=abc',
    '?limit=10abc',
    '?limit=1.5',
    '?limit=',
    '?limit=%2010',
    '?limit=1&limit=2',
    '?afterSeq=-1',
    '?afterSeq=abc',
    '?afterSeq=10abc',
    '?afterSeq=1e3',
    '?afterSeq=0x10',
    '?afterSeq=',
    '?afterSeq=99999999999999999999',
  ])('rejects %s with 400 bad_request instead of switching modes', async (qs) => {
    const res = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/conv-1/worklog${qs}`,
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'bad_request' });
  });

  it('serves an entry that landed on disk but whose append was rejected (clients backfill the gap)', async () => {
    await workLog.appendWorkLog('conv-1', { kind: 'narration', text: 'one' });
    // seq 2 lands (as if its fdatasync failed after the write); a live client never saw it.
    fs.appendFileSync(
      path.join(paths.dataDir, 'worklogs', 'conv-1.jsonl'),
      `${JSON.stringify({ seq: 2, ts: 2, kind: 'narration', text: 'landed' })}\n`,
    );
    const res = await web.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-1/worklog?afterSeq=1',
      headers: AUTH_HEADER,
    });
    expect(JSON.parse(res.body).entries.map((e: { text: string }) => e.text)).toEqual(['landed']);
  });

  describe('read authorization: owner and admins only', () => {
    const read = (headers: Record<string, string>, id = 'conv-1') =>
      web.injectWebServer({ method: 'GET', url: `/api/dashboard/session/${id}/worklog`, headers });

    beforeEach(async () => {
      await workLog.appendWorkLog('conv-1', { kind: 'instruction', text: 'raw instruction' });
    });

    it('owner: 200', async () => {
      const res = await read({ cookie: userCookie('U_OWNER') });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).entries).toHaveLength(1);
    });

    it('another logged-in user: 403 forbidden (the turns API stays world-readable)', async () => {
      const res = await read({ cookie: userCookie('U_OTHER') });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });

      const turns = await web.injectWebServer({
        method: 'GET',
        url: '/api/dashboard/session/conv-1',
        headers: { cookie: userCookie('U_OTHER') },
      });
      expect(turns.statusCode).toBe(200);
    });

    it('admin user (ADMIN_USERS): 200, no admin-mode header needed for reads', async () => {
      expect((await read({ cookie: userCookie('U_ADMIN') })).statusCode).toBe(200);
    });

    it('viewer token (bearer header or bearer cookie): 200', async () => {
      expect((await read(AUTH_HEADER)).statusCode).toBe(200);
      expect(
        (await read({ cookie: `soma_dash_token=${encodeURIComponent(`bearer:${VIEWER_TOKEN}`)}` })).statusCode,
      ).toBe(200);
    });

    it('a conversation with no recorded owner is admin-only', async () => {
      const { getConversation } = await import('../recorder');
      (getConversation as any).mockImplementation(async (id: string) =>
        id === 'conv-1' ? { ...CONVERSATION, ownerId: '' } : null,
      );
      expect((await read({ cookie: userCookie('U_OWNER') })).statusCode).toBe(403);
      expect((await read({ cookie: userCookie('U_ADMIN') })).statusCode).toBe(200);
    });

    it('unknown conversation: 404 before any ownership check', async () => {
      expect((await read({ cookie: userCookie('U_OTHER') }, 'conv-nope')).statusCode).toBe(404);
    });
  });

  describe('GET …/worklog/:seq/raw', () => {
    const RAW = '{\n  "command": "ls -la",\n  "note": "한글 😀"\n}';
    const rawUrl = (seq: string | number, id = 'conv-1') => `/api/dashboard/session/${id}/worklog/${seq}/raw`;
    const getRaw = (seq: string | number, headers: Record<string, string> = AUTH_HEADER, id = 'conv-1') =>
      web.injectWebServer({ method: 'GET', url: rawUrl(seq, id), headers });

    beforeEach(async () => {
      await workLog.appendWorkLog('conv-1', {
        kind: 'tool',
        text: 'Bash {"command":"ls -la"}',
        tool: 'Bash',
        raw: RAW,
      });
      await workLog.appendWorkLog('conv-1', { kind: 'narration', text: 'no raw' });
    });

    it('200 { seq, raw, rawBytes, rawTruncated } with Cache-Control: no-store', async () => {
      const res = await getRaw(1);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(res.body)).toEqual({ seq: 1, raw: RAW, rawBytes: Buffer.byteLength(RAW), rawTruncated: false });
    });

    it('the list carries rawBytes and never raw', async () => {
      const res = await web.injectWebServer({
        method: 'GET',
        url: '/api/dashboard/session/conv-1/worklog',
        headers: AUTH_HEADER,
      });
      const { entries } = JSON.parse(res.body) as { entries: Array<Record<string, unknown>> };
      expect(entries[0]).toMatchObject({ seq: 1, rawBytes: Buffer.byteLength(RAW) });
      expect(entries[0]).not.toHaveProperty('raw');
      expect(entries[1]).not.toHaveProperty('rawBytes');
    });

    it('a truncated raw reports rawTruncated and the original size', async () => {
      const big = 'x'.repeat(workLog.WORK_LOG_RAW_MAX_BYTES + 10);
      const entry = await workLog.appendWorkLog('conv-1', { kind: 'tool_result', text: 'Bash ok', raw: big });
      const body = JSON.parse((await getRaw(entry.seq)).body);
      expect(body).toMatchObject({ seq: entry.seq, rawBytes: big.length, rawTruncated: true });
      expect(body.raw).toBe(big.slice(0, workLog.WORK_LOG_RAW_MAX_BYTES));
    });

    it('404 for an entry without raw, an unknown seq, and an unknown conversation', async () => {
      for (const res of [await getRaw(2), await getRaw(99), await getRaw(1, AUTH_HEADER, 'conv-nope')]) {
        expect(res.statusCode).toBe(404);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('404 when the raw record at the recorded position is another seq or cut short', async () => {
      const rawFile = path.join(paths.dataDir, 'worklogs', 'conv-1.raw.jsonl');
      const original = fs.readFileSync(rawFile, 'utf-8');
      fs.writeFileSync(rawFile, original.replace('{"seq":1,', '{"seq":9,'));
      expect((await getRaw(1)).statusCode).toBe(404);
      fs.writeFileSync(rawFile, original.slice(0, 12));
      const res = await getRaw(1);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    });

    it('503 unavailable (not 404) when the read runs out of its scan budget before reaching the entry', async () => {
      const line = (seq: number) => `${JSON.stringify({ seq, ts: seq, kind: 'narration', text: `n${seq}` })}\n`;
      const logFile = path.join(paths.dataDir, 'worklogs', 'conv-1.jsonl');
      fs.writeFileSync(logFile, Array.from({ length: 50 }, (_, i) => line(i + 1)).join(''));
      fs.appendFileSync(logFile, Buffer.from('x\n'.repeat(4.5 * 1024 * 1024))); // 9 MB of junk
      fs.appendFileSync(logFile, Array.from({ length: 10 }, (_, i) => line(51 + i)).join(''));
      fs.appendFileSync(logFile, Buffer.from('x\n'.repeat(1.5 * 1024 * 1024))); // wider than the fast path

      const res = await getRaw(55);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: 'unavailable' });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it.each([
      '0',
      '-1',
      'abc',
      '1abc',
      '1.5',
      '1e3',
      '0x10',
      '%201',
      '99999999999999999999',
    ])('rejects seq %s with 400 bad_request', async (seq) => {
      const res = await getRaw(seq);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'bad_request' });
    });

    describe('authorization: exactly the list route rules', () => {
      it('401 without credentials, still no-store', async () => {
        const res = await getRaw(1, {});
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.body).error).toBe('Unauthorized');
        expect(res.headers['cache-control']).toBe('no-store');
      });

      it('403 carries no-store too', async () => {
        const res = await getRaw(1, { cookie: userCookie('U_OTHER') });
        expect(res.statusCode).toBe(403);
        expect(res.headers['cache-control']).toBe('no-store');
      });

      it('owner, admin user, viewer token (header or cookie): 200', async () => {
        for (const headers of [
          { cookie: userCookie('U_OWNER') },
          { cookie: userCookie('U_ADMIN') },
          AUTH_HEADER,
          { cookie: `soma_dash_token=${encodeURIComponent(`bearer:${VIEWER_TOKEN}`)}` },
        ]) {
          expect((await getRaw(1, headers)).statusCode).toBe(200);
        }
      });

      it('another logged-in user: 403 forbidden, and no raw in the body', async () => {
        const res = await getRaw(1, { cookie: userCookie('U_OTHER') });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });
      });

      it('a conversation with no recorded owner is admin-only', async () => {
        const { getConversation } = await import('../recorder');
        vi.mocked(getConversation).mockImplementation(async (id: string) =>
          id === 'conv-1' ? ({ ...CONVERSATION, ownerId: '' } as never) : null,
        );
        expect((await getRaw(1, { cookie: userCookie('U_OWNER') })).statusCode).toBe(403);
        expect((await getRaw(1, { cookie: userCookie('U_ADMIN') })).statusCode).toBe(200);
      });

      it('unknown conversation: 404 before any ownership check', async () => {
        expect((await getRaw(1, { cookie: userCookie('U_OTHER') }, 'conv-nope')).statusCode).toBe(404);
      });
    });
  });
});

describe('work log raw route behind the canonical-origin redirect', () => {
  let web: typeof import('../web-server');

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerUrl = 'https://dash.example.test';
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-worklog-redirect-'));
    web = await import('../web-server');
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await web.stopWebServer();
    mockConfig.conversation.viewerUrl = '';
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  it('the redirect a global hook sends for this route still carries no-store', async () => {
    const res = await web.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-1/worklog/1/raw',
      headers: { host: 'old-host:33000', ...AUTH_HEADER },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://dash.example.test/api/dashboard/session/conv-1/worklog/1/raw');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('work log read authorization with auth disabled', () => {
  let web: typeof import('../web-server');

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = '';
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-worklog-noauth-'));
    web = await import('../web-server');
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockImplementation(async (id: string) => (id === 'conv-1' ? CONVERSATION : null));
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await web.stopWebServer();
    mockConfig.conversation.viewerToken = VIEWER_TOKEN;
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  it('mode none (no viewer token, no OAuth) reads as admin, as today', async () => {
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/session/conv-1/worklog' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ entries: [], hasMore: false });
  });

  it('mode none: the raw route reads as admin too (404 = no such entry, not 401/403)', async () => {
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/session/conv-1/worklog/1/raw' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
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
