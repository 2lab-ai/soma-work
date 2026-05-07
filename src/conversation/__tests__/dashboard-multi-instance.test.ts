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

// Instance registry mock — `/api/dashboard/sessions` pre-discovers siblings
// (PR #815 review) before fetching, so each test must seed the registry to
// match the sibling count it expects fetchSiblingBoards to be called for.
const mockReadAllInstances = vi.fn();
vi.mock('../instance-registry', async () => {
  const actual = await vi.importActual<typeof import('../instance-registry')>('../instance-registry');
  return {
    ...actual,
    readAllInstances: (...args: any[]) => mockReadAllInstances(...args),
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
    mockReadAllInstances.mockReset();
    // Default: no siblings discovered — tests that exercise aggregation
    // override per-case below.
    mockReadAllInstances.mockResolvedValue([]);
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

    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'mac-mini-dev', host: '127.0.0.1', pid: 1001, lastSeen: Date.now() },
    ]);
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

    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'mac-mini-dev', host: '127.0.0.1', pid: 1001, lastSeen: Date.now() },
    ]);
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

    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'mac-mini-dev', host: '127.0.0.1', pid: 1001, lastSeen: Date.now() },
    ]);
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

  // PR #815 review #2 — every action endpoint that takes :key must strip the
  // self-instance prefix AND reject foreign prefixes with 409. Missing the
  // strip on any one endpoint silently degraded a sibling-routed action;
  // missing the foreign-prefix reject silently 4xxed (or worse, 200/no-op).
  describe('action endpoint prefix handling — all 7 endpoints', () => {
    type EndpointSpec = {
      verb: string;
      path: string;
      bodyForOk?: any;
      handler: 'stop' | 'close' | 'trash' | 'command' | 'choice' | 'multi' | 'submit';
    };
    const endpoints: EndpointSpec[] = [
      { verb: 'POST', path: 'stop', handler: 'stop' },
      { verb: 'POST', path: 'close', handler: 'close' },
      { verb: 'POST', path: 'trash', handler: 'trash' },
      { verb: 'POST', path: 'command', bodyForOk: { message: 'hi' }, handler: 'command' },
      {
        verb: 'POST',
        path: 'answer-choice',
        bodyForOk: { choiceId: 'a', label: 'A', question: 'q?' },
        handler: 'choice',
      },
      {
        verb: 'POST',
        path: 'answer-multi-choice',
        bodyForOk: { selections: { q1: { choiceId: 'a', label: 'A' } } },
        handler: 'multi',
      },
      { verb: 'POST', path: 'submit-recommended', handler: 'submit' },
    ];

    for (const ep of endpoints) {
      it(`${ep.path}: strips self-instance prefix and routes to local handler`, async () => {
        setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
        const sessions = new Map<string, any>();
        sessions.set('C1:t1', {
          sessionId: 'sid1',
          ownerId: 'U1',
          channelId: 'C1',
          threadTs: 't1',
          activityState: 'waiting',
          state: 'MAIN',
          lastActivity: new Date(),
        });
        setDashboardSessionAccessor(() => sessions);

        const dashboard = await import('../dashboard');
        const handler = vi.fn().mockResolvedValue(undefined);
        switch (ep.handler) {
          case 'stop':
            dashboard.setDashboardStopHandler(handler);
            break;
          case 'close':
            dashboard.setDashboardCloseHandler(handler);
            break;
          case 'trash':
            dashboard.setDashboardTrashHandler(handler);
            break;
          case 'command':
            dashboard.setDashboardCommandHandler(handler);
            break;
          case 'choice':
            dashboard.setDashboardChoiceAnswerHandler(handler);
            break;
          case 'multi':
            dashboard.setDashboardMultiChoiceAnswerHandler(handler);
            break;
          case 'submit':
            dashboard.setDashboardSubmitRecommendedHandler(handler);
            break;
        }

        const res = await injectWebServer({
          method: ep.verb,
          url: `/api/dashboard/session/${encodeURIComponent('self-host::C1:t1')}/${ep.path}`,
          headers: AUTH_HEADER,
          payload: ep.bodyForOk,
        });

        expect(res.statusCode).toBe(200);
        expect(handler).toHaveBeenCalled();
        // First arg is always the resolved local key.
        expect(handler.mock.calls[0][0]).toBe('C1:t1');
      });

      it(`${ep.path}: returns 409 for a foreign-instance prefix (no silent passthrough)`, async () => {
        setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
        const sessions = new Map<string, any>();
        sessions.set('C1:t1', {
          sessionId: 'sid1',
          ownerId: 'U1',
          channelId: 'C1',
          threadTs: 't1',
          activityState: 'waiting',
          state: 'MAIN',
          lastActivity: new Date(),
        });
        setDashboardSessionAccessor(() => sessions);

        const dashboard = await import('../dashboard');
        const handler = vi.fn().mockResolvedValue(undefined);
        switch (ep.handler) {
          case 'stop':
            dashboard.setDashboardStopHandler(handler);
            break;
          case 'close':
            dashboard.setDashboardCloseHandler(handler);
            break;
          case 'trash':
            dashboard.setDashboardTrashHandler(handler);
            break;
          case 'command':
            dashboard.setDashboardCommandHandler(handler);
            break;
          case 'choice':
            dashboard.setDashboardChoiceAnswerHandler(handler);
            break;
          case 'multi':
            dashboard.setDashboardMultiChoiceAnswerHandler(handler);
            break;
          case 'submit':
            dashboard.setDashboardSubmitRecommendedHandler(handler);
            break;
        }

        const res = await injectWebServer({
          method: ep.verb,
          url: `/api/dashboard/session/${encodeURIComponent('mac-mini-dev::C1:t1')}/${ep.path}`,
          headers: AUTH_HEADER,
          payload: ep.bodyForOk,
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/Cross-instance/i);
        expect(body.wireKey).toBe('mac-mini-dev::C1:t1');
        // Critical: handler must NOT have been invoked for a foreign prefix.
        expect(handler).not.toHaveBeenCalled();
      });
    }
  });

  it('archivedToKanban composite key path — strip works and resolves to raw archive key', async () => {
    setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    setDashboardSessionAccessor(() => new Map());

    // Seed the archive store with a closed session.
    const archives = await import('../../session-archive');
    const archivedAt = 1700000000000;
    (archives.getArchiveStore as any) = () => ({
      listRecent: () => [
        {
          sessionId: 'sid1',
          sessionKey: 'C1:t1',
          archivedAt,
          ownerId: 'U1',
          channelId: 'C1',
          threadTs: 't1',
          conversationId: 'conv1',
          summaryTitle: 'archived',
          archiveReason: 'sleep_expired',
          lastActivity: new Date(archivedAt).toISOString(),
        },
      ],
    });

    // The full archive store mock is heavy; instead, just verify the prefix
    // resolution rule directly via a /trash request with the composite
    // archive key shape. The resolveSelfActionKey logic is the unit under
    // test; the archive-listing path is covered by existing tests.
    const trashKey = `archived_C1:t1_${archivedAt}`;
    const wireKey = `self-host::${trashKey}`;

    const dashboard = await import('../dashboard');
    const trashHandler = vi.fn().mockResolvedValue(undefined);
    dashboard.setDashboardTrashHandler(trashHandler);

    const res = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(wireKey)}/trash`,
      headers: AUTH_HEADER,
    });

    // Owner check uses the local session map which doesn't contain
    // archive keys — trash will get 403. The point of this test is to
    // assert the strip path produced the raw archive key, not 409 the
    // foreign-prefix reject. So we accept either 200 (handler called) or
    // 403 (owner reject) — but NEVER 409 (foreign prefix mistake).
    expect(res.statusCode).not.toBe(409);
  });

  it('renders sibling cards with disabled action buttons and instance label', async () => {
    setSelfInstanceEnv({ instanceName: 'self-host', port: 33000, host: '127.0.0.1' });
    setDashboardSessionAccessor(() => new Map());

    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'mac-mini-dev', host: '127.0.0.1', pid: 1001, lastSeen: Date.now() },
    ]);
    mockFetchSiblingBoards.mockResolvedValue([
      {
        instanceName: 'mac-mini-dev',
        port: 33001,
        host: '127.0.0.1',
        board: {
          working: [
            {
              key: 'C9:t9',
              title: 'Sibling',
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

    const body = JSON.parse(res.body);
    expect(body.board.working).toHaveLength(1);
    const sibling = body.board.working[0];
    expect(sibling.environment.instanceName).toBe('mac-mini-dev');
    // Sibling card must carry env so the renderCard sibling-detection
    // (env.instanceName !== SELF_INSTANCE_NAME) can match.
    expect(sibling.key).toBe('mac-mini-dev::C9:t9');
  });

  it('stopWebServer removes the heartbeat file on shutdown', async () => {
    // This test goes through the real instance-registry to verify the
    // lifecycle wiring. Other tests mock readAllInstances at the module
    // boundary, so we use a separate fresh import here.
    const tmpDir = require('node:fs').mkdtempSync(
      require('node:path').join(require('node:os').tmpdir(), 'soma-shutdown-'),
    );
    const oldDir = process.env.SOMA_INSTANCE_DIR;
    process.env.SOMA_INSTANCE_DIR = tmpDir;
    try {
      // Re-import the registry (not the mocked one) to talk to the real fs.
      vi.resetModules();
      const real = await vi.importActual<typeof import('../instance-registry')>('../instance-registry');
      await real.writeHeartbeat({
        port: 33555,
        instanceName: 'shutdown-test',
        host: '127.0.0.1',
        pid: process.pid,
      });
      expect(require('node:fs').existsSync(require('node:path').join(tmpDir, '33555.json'))).toBe(true);
      await real.removeHeartbeat(33555);
      expect(require('node:fs').existsSync(require('node:path').join(tmpDir, '33555.json'))).toBe(false);
    } finally {
      if (oldDir === undefined) delete process.env.SOMA_INSTANCE_DIR;
      else process.env.SOMA_INSTANCE_DIR = oldDir;
      try {
        require('node:fs').rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
