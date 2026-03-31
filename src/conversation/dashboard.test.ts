import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──

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

vi.mock('../config', () => ({ config: mockConfig }));
vi.mock('../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('./recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('./viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

describe('Dashboard API', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let setDashboardSessionAccessor: any;

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = 'test-token';

    const webServer = await import('./web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;

    const dashboard = await import('./dashboard');
    setDashboardSessionAccessor = dashboard.setDashboardSessionAccessor;

    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  // ── Kanban Sessions API ──

  it('should return empty kanban board when no sessions', async () => {
    setDashboardSessionAccessor(() => new Map());

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board).toEqual({ working: [], waiting: [], idle: [], closed: [] });
  });

  it('should categorize sessions into kanban columns', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      title: 'Working session',
      ownerId: 'U1',
      ownerName: 'Alice',
      workflow: 'jira-create-pr',
      model: 'claude-opus-4-6',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-03-29T10:00:00Z'),
    });
    sessions.set('C2:t2', {
      sessionId: 'sid2',
      title: 'Waiting session',
      ownerId: 'U2',
      ownerName: 'Bob',
      workflow: 'default',
      model: 'claude-sonnet-4-6',
      channelId: 'C2',
      threadTs: 't2',
      activityState: 'waiting',
      state: 'MAIN',
      lastActivity: new Date('2026-03-29T09:00:00Z'),
    });
    sessions.set('C3:t3', {
      sessionId: 'sid3',
      title: 'Idle session',
      ownerId: 'U1',
      ownerName: 'Alice',
      workflow: 'default',
      model: 'claude-opus-4-6',
      channelId: 'C3',
      threadTs: 't3',
      activityState: 'idle',
      state: 'MAIN',
      lastActivity: new Date('2026-03-29T08:00:00Z'),
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.working).toHaveLength(1);
    expect(body.board.working[0].title).toBe('Working session');
    expect(body.board.waiting).toHaveLength(1);
    expect(body.board.waiting[0].title).toBe('Waiting session');
    expect(body.board.idle).toHaveLength(1);
    expect(body.board.idle[0].title).toBe('Idle session');
  });

  it('should filter sessions by userId', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      title: 'Alice session',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      activityState: 'working',
      lastActivity: new Date(),
    });
    sessions.set('C2:t2', {
      sessionId: 's2',
      title: 'Bob session',
      ownerId: 'U2',
      ownerName: 'Bob',
      channelId: 'C2',
      activityState: 'working',
      lastActivity: new Date(),
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions?userId=U1',
      headers: AUTH_HEADER,
    });

    const body = JSON.parse(res.body);
    expect(body.board.working).toHaveLength(1);
    expect(body.board.working[0].ownerId).toBe('U1');
  });

  it('should include token usage in kanban sessions', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      title: 'Token session',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      activityState: 'working',
      lastActivity: new Date(),
      usage: {
        totalInputTokens: 100000,
        totalOutputTokens: 50000,
        totalCostUsd: 1.23,
        currentInputTokens: 80000,
        contextWindow: 200000,
      },
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    const body = JSON.parse(res.body);
    const session = body.board.working[0];
    expect(session.tokenUsage).toBeDefined();
    expect(session.tokenUsage.totalInputTokens).toBe(100000);
    expect(session.tokenUsage.totalOutputTokens).toBe(50000);
    expect(session.tokenUsage.totalCostUsd).toBe(1.23);
    expect(session.tokenUsage.contextUsagePercent).toBe(40); // 80000/200000 * 100
  });

  it('should include merge stats in kanban sessions', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      title: 'Merge session',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      activityState: 'idle',
      lastActivity: new Date(),
      mergeStats: { totalLinesAdded: 500, totalLinesDeleted: 100 },
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    const body = JSON.parse(res.body);
    expect(body.board.idle[0].mergeStats).toEqual({
      totalLinesAdded: 500,
      totalLinesDeleted: 100,
    });
  });

  it('should skip sessions without sessionId', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      // No sessionId — should be filtered out
      title: 'Ghost',
      ownerId: 'U1',
      channelId: 'C1',
      activityState: 'working',
      lastActivity: new Date(),
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    const body = JSON.parse(res.body);
    expect(body.board.working).toHaveLength(0);
  });

  // ── Users API ──

  it('should return unique users from sessions', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', { ownerId: 'U1', ownerName: 'Alice' });
    sessions.set('C2:t2', { ownerId: 'U2', ownerName: 'Bob' });
    sessions.set('C3:t3', { ownerId: 'U1', ownerName: 'Alice' }); // duplicate
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/users',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.users).toHaveLength(2);
    expect(body.users.map((u: any) => u.name).sort()).toEqual(['Alice', 'Bob']);
  });

  // ── Stats API ──

  it('should require userId for stats', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/stats',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(400);
  });

  // ── Dashboard HTML ──

  it('should serve dashboard HTML page', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('soma-work');
    expect(res.body).toContain('kanban');
  });

  it('should serve dashboard for specific user', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard/U123',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('U123');
  });

  // ── Session detail API ──

  it('should return 404 for unknown conversation', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/nonexistent',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return conversation turns for valid conversation', async () => {
    const { getConversation } = await import('./recorder');
    (getConversation as any).mockResolvedValueOnce({
      id: 'conv-1',
      title: 'Test Conversation',
      ownerName: 'Alice',
      workflow: 'default',
      createdAt: 1000,
      updatedAt: 2000,
      turns: [
        { id: 't1', role: 'user', timestamp: 1000, userName: 'Alice', rawContent: 'Hello' },
        {
          id: 't2',
          role: 'assistant',
          timestamp: 1500,
          summaryTitle: 'Greeting',
          summaryBody: 'Said hello',
          rawContent: 'Hi there, long response...',
        },
      ],
    });

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-1',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe('Test Conversation');
    expect(body.turnCount).toBe(2);
    expect(body.turns).toHaveLength(2);
    // User turn includes rawContent
    expect(body.turns[0].rawContent).toBe('Hello');
    // Assistant turn excludes rawContent (only summaries)
    expect(body.turns[1].rawContent).toBeUndefined();
    expect(body.turns[1].summaryTitle).toBe('Greeting');
  });

  // ── Auth ──

  it('should require auth for dashboard API', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: { Accept: 'application/json' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('should redirect to login for unauthenticated HTML requests', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  // ── Login page (public) ──

  it('should serve login page without auth', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/login',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Sign in');
  });
});
