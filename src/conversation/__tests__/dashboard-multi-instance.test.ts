import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
    instanceName: 'self-host',
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

// Aggregator mock — we drive `fetchSiblingBoards` directly so each test
// pins the cross-instance behaviour without a network shim.
const mockFetchSiblingBoards = vi.fn();
vi.mock('../aggregator', async () => {
  const actual = await vi.importActual<typeof import('../aggregator')>('../aggregator');
  return {
    ...actual,
    fetchSiblingBoards: (...args: any[]) => mockFetchSiblingBoards(...args),
  };
});

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

describe('Dashboard multi-instance aggregation (#814)', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let setDashboardSessionAccessor: any;
  let setSelfInstanceEnv: any;
  let __resetSelfInstanceEnvForTests: any;

  beforeEach(async () => {
    vi.resetModules();
    mockFetchSiblingBoards.mockReset();
    mockConfig.conversation.viewerToken = 'test-token';
    mockConfig.conversation.instanceName = 'self-host';

    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;

    const dashboard = await import('../dashboard');
    setDashboardSessionAccessor = dashboard.setDashboardSessionAccessor;
    setSelfInstanceEnv = dashboard.setSelfInstanceEnv;
    __resetSelfInstanceEnvForTests = dashboard.__resetSelfInstanceEnvForTests;

    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    if (__resetSelfInstanceEnvForTests) __resetSelfInstanceEnvForTests();
    await stopWebServer();
  });

  it('composes session.key as `${instanceName}::${rawKey}` once self env is wired', async () => {
    setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      title: 'Working session',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-04-01T10:00:00Z'),
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions?selfOnly=true',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.working).toHaveLength(1);
    expect(body.board.working[0].key).toBe('self-host::C1:t1');
  });

  it('stamps environment metadata on self cards when env is wired', async () => {
    setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-04-01T10:00:00Z'),
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions?selfOnly=true',
      headers: AUTH_HEADER,
    });

    const body = JSON.parse(res.body);
    expect(body.board.working[0].environment).toEqual({
      instanceName: 'self-host',
      port: 33000,
      host: '127.0.0.1',
    });
  });

  it('selfOnly=true bypasses the aggregator (no fan-out)', async () => {
    setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    setDashboardSessionAccessor(() => new Map());

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions?selfOnly=true',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    expect(mockFetchSiblingBoards).not.toHaveBeenCalled();
  });

  it('aggregates sibling boards into self board when env is wired and siblings exist', async () => {
    setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-04-01T10:00:00Z'),
    });
    setDashboardSessionAccessor(() => sessions);

    mockFetchSiblingBoards.mockResolvedValue([
      {
        instanceName: 'mac-mini-dev',
        port: 33001,
        host: '127.0.0.1',
        board: {
          working: [
            {
              key: 'C9:t9',
              title: 'Sibling working',
              ownerId: 'U2',
              channelId: 'C9',
              activityState: 'working',
              lastActivity: '2026-04-01T09:30:00Z',
            },
          ],
          waiting: [],
          idle: [],
          closed: [],
        },
      },
    ]);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.working).toHaveLength(2);
    // Self card preserved (composite key) first.
    expect(body.board.working[0].key).toBe('self-host::C1:t1');
    expect(body.board.working[0].environment.instanceName).toBe('self-host');
    // Sibling card stamped with sibling env and composite key.
    expect(body.board.working[1].key).toBe('mac-mini-dev::C9:t9');
    expect(body.board.working[1].environment).toEqual({
      instanceName: 'mac-mini-dev',
      port: 33001,
      host: '127.0.0.1',
    });
  });

  it('falls back to self-only board when aggregator throws', async () => {
    setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-04-01T10:00:00Z'),
    });
    setDashboardSessionAccessor(() => sessions);

    mockFetchSiblingBoards.mockRejectedValue(new Error('boom'));

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.working).toHaveLength(1);
    expect(body.board.working[0].key).toBe('self-host::C1:t1');
  });

  it('sibling-instance card with same channelId:threadTs as self does not collide on key', async () => {
    setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-04-01T10:00:00Z'),
    });
    setDashboardSessionAccessor(() => sessions);

    mockFetchSiblingBoards.mockResolvedValue([
      {
        instanceName: 'mac-mini-dev',
        port: 33001,
        host: '127.0.0.1',
        board: {
          working: [
            {
              key: 'C1:t1', // identical raw key on the sibling
              title: 'Sibling collision attempt',
              ownerId: 'U2',
              channelId: 'C1',
              activityState: 'working',
              lastActivity: '2026-04-01T09:30:00Z',
            },
          ],
          waiting: [],
          idle: [],
          closed: [],
        },
      },
    ]);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    const body = JSON.parse(res.body);
    const keys = body.board.working.map((s: any) => s.key).sort();
    expect(keys).toEqual(['mac-mini-dev::C1:t1', 'self-host::C1:t1']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('action endpoint /stop strips the self-instance prefix and looks up the raw key', async () => {
    setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date(),
    });
    setDashboardSessionAccessor(() => sessions);

    const stopHandler = vi.fn().mockResolvedValue(undefined);
    const dashboard = await import('../dashboard');
    dashboard.setDashboardStopHandler(stopHandler);

    const res = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/session/' + encodeURIComponent('self-host::C1:t1') + '/stop',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    expect(stopHandler).toHaveBeenCalledWith('C1:t1');
  });
});
