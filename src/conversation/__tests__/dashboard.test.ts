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

const mockListRecent = vi.fn().mockReturnValue([]);
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: mockListRecent }),
}));

// Metrics events the stats/usage routes read (the real store, minus the disk).
const mockReadRange = vi.fn().mockResolvedValue([]);
vi.mock('../../metrics/event-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../metrics/event-store')>();
  class TestMetricsEventStore extends actual.MetricsEventStore {
    override readRange(startDate: string, endDate: string) {
      return mockReadRange(startDate, endDate);
    }
  }
  return { ...actual, MetricsEventStore: TestMetricsEventStore };
});

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

describe('Dashboard API', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let setDashboardSessionAccessor: any;

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = 'test-token';

    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;

    const dashboard = await import('../dashboard');
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

  it('should expose summaryTitle on kanban sessions when session has one (#708)', async () => {
    // #708: the initial /sessions payload must carry summaryTitle so a
    // full-page refresh renders the same headline as the live
    // `summaryTitleChanged` WS patch. Before this fix, sessionToKanban
    // dropped the field and refreshed cards reverted to the raw title.
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      title: 'Raw PROJ-42 link',
      summaryTitle: 'Refactor dashboard card render',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date(),
    });
    // No summaryTitle → field should be absent (undefined), not an empty string.
    sessions.set('C2:t2', {
      sessionId: 's2',
      title: 'Raw only',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C2',
      threadTs: 't2',
      activityState: 'idle',
      state: 'MAIN',
      lastActivity: new Date(),
    });
    // Empty-string summaryTitle should be treated as absent to avoid forcing
    // the client to disambiguate '' from 'unset'.
    sessions.set('C3:t3', {
      sessionId: 's3',
      title: 'Empty summary',
      summaryTitle: '',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C3',
      threadTs: 't3',
      activityState: 'idle',
      state: 'MAIN',
      lastActivity: new Date(),
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const withSummary = body.board.working.find((s: any) => s.key === 'C1:t1');
    expect(withSummary.summaryTitle).toBe('Refactor dashboard card render');
    // Raw title remains populated so older clients still render something.
    expect(withSummary.title).toBeTruthy();

    const withoutSummary = body.board.idle.find((s: any) => s.key === 'C2:t2');
    expect(withoutSummary.summaryTitle).toBeUndefined();

    const emptySummary = body.board.idle.find((s: any) => s.key === 'C3:t3');
    expect(emptySummary.summaryTitle).toBeUndefined();
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

  it('should project recommendedChoiceId on pendingQuestion (user_choice)', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      title: 'Rec session',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      activityState: 'waiting',
      lastActivity: new Date(),
      actionPanel: {
        pendingQuestion: {
          type: 'user_choice',
          question: 'Pick one',
          recommendedChoiceId: '2',
          choices: [
            { id: '1', label: 'A' },
            { id: '2', label: 'B' },
          ],
        },
      },
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const pq = body.board.waiting[0].pendingQuestion;
    expect(pq).toBeDefined();
    expect(pq.type).toBe('user_choice');
    expect(pq.recommendedChoiceId).toBe('2');
  });

  it('should project per-question recommendedChoiceId on pendingQuestion (user_choices)', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      title: 'Multi rec session',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      activityState: 'waiting',
      lastActivity: new Date(),
      actionPanel: {
        pendingQuestion: {
          type: 'user_choices',
          title: 'Two decisions',
          questions: [
            {
              id: 'q1',
              question: 'First?',
              recommendedChoiceId: 'b',
              choices: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
              ],
            },
            {
              id: 'q2',
              question: 'Second?',
              choices: [
                { id: 'x', label: 'X' },
                { id: 'y', label: 'Y' },
              ],
            },
          ],
        },
      },
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const pq = body.board.waiting[0].pendingQuestion;
    expect(pq).toBeDefined();
    expect(pq.type).toBe('user_choices');
    expect(pq.questions).toHaveLength(2);
    expect(pq.questions[0].recommendedChoiceId).toBe('b');
    expect(pq.questions[1].recommendedChoiceId).toBeUndefined();
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

  describe('GET /api/dashboard/stats', () => {
    const now = Date.now();
    const ev = (id: string, userId: string, eventType: string, metadata?: Record<string, unknown>) => ({
      id,
      timestamp: now,
      eventType,
      userId,
      userName: userId,
      metadata,
    });
    const EVENTS = [
      ev('e1', 'U1', 'session_created', { workflow: 'zwork' }),
      ev('e2', 'U1', 'turn_used'),
      ev('e3', 'U2', 'session_created'),
      ev('e4', 'U2', 'session_created', { workflow: 'zwork' }),
      ev('e5', 'U2', 'pr_merged'),
      ev('e6', 'U2', 'merge_lines_added', { linesAdded: 40, linesDeleted: 7 }),
    ];

    afterEach(() => {
      mockReadRange.mockReset();
      mockReadRange.mockResolvedValue([]);
    });

    it('without userId aggregates every user for the period', async () => {
      mockReadRange.mockResolvedValue(EVENTS);
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/stats?period=week',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.userId).toBeNull();
      expect(body.period).toBe('week');
      expect(body.totals).toMatchObject({
        sessionsCreated: 3,
        turnsUsed: 1,
        prsMerged: 1,
        mergeLinesAdded: 40,
        mergeLinesDeleted: 7,
        workflowCounts: { zwork: 2, default: 1 },
      });
      // The period picks the date range that is read: 7 days, today included.
      const [start, end] = mockReadRange.mock.calls[0];
      expect(Date.parse(end) - Date.parse(start)).toBe(6 * 24 * 60 * 60 * 1000);
    });

    it('with userId still counts only that user', async () => {
      mockReadRange.mockResolvedValue(EVENTS);
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/stats?userId=U1&period=day',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.userId).toBe('U1');
      expect(body.totals).toMatchObject({ sessionsCreated: 1, turnsUsed: 1, prsMerged: 0, mergeLinesAdded: 0 });
      const [start, end] = mockReadRange.mock.calls[0];
      expect(start).toBe(end);
    });

    // #477: a month is thousands of events. Building a KST date per event with
    // toLocaleDateString constructs a new formatter every call (~35 µs each) —
    // 90% of the request's time, on the event loop every other request waits on.
    it('month: groups thousands of events by KST day without a formatter per event', async () => {
      const base = Date.parse('2026-10-26T14:59:00Z'); // 23:59 KST on the 26th
      const many = Array.from({ length: 3000 }, (_, i) => ({
        id: `m${i}`,
        // Half a minute either side of KST midnight, alternating.
        timestamp: i % 2 ? base + 2 * 60_000 : base,
        eventType: 'turn_used',
        userId: 'U1',
        userName: 'U1',
      }));
      mockReadRange.mockResolvedValue(many);
      const spy = vi.spyOn(Date.prototype, 'toLocaleDateString');
      try {
        const res = await injectWebServer({
          method: 'GET',
          url: '/api/dashboard/stats?period=month',
          headers: AUTH_HEADER,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.days.map((d: any) => [d.date, d.turnsUsed])).toEqual([
          ['2026-10-26', 1500],
          ['2026-10-27', 1500],
        ]);
        expect(body.totals.turnsUsed).toBe(3000);
        expect(spy.mock.calls.length).toBeLessThan(10);
      } finally {
        spy.mockRestore();
      }
    });

    it('skips an event without a usable timestamp instead of failing the period', async () => {
      mockReadRange.mockResolvedValue([
        ...EVENTS,
        { id: 'bad1', timestamp: Number.NaN, eventType: 'turn_used', userId: 'U1', userName: 'U1' },
        { id: 'bad2', timestamp: 'abc', eventType: 'turn_used', userId: 'U1', userName: 'U1' },
      ]);
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/stats?period=week',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).totals).toMatchObject({ sessionsCreated: 3, turnsUsed: 1 });
    });

    // The stats strip takes its tokens and cost from /usage for the same period.
    it('/usage totals follow the period and the optional user', async () => {
      const usage = (id: string, userId: string, inputTokens: number, outputTokens: number, costUsd: number) =>
        ev(id, userId, 'token_usage', { inputTokens, outputTokens, costUsd, model: 'claude-opus-4-6' });
      mockReadRange.mockResolvedValue([usage('t1', 'U1', 1000, 200, 0.5), usage('t2', 'U2', 3000, 400, 1.25)]);
      const all = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/usage?period=month',
        headers: AUTH_HEADER,
      });
      expect(all.statusCode).toBe(200);
      expect(JSON.parse(all.body).totals).toMatchObject({
        totalInputTokens: 4000,
        totalOutputTokens: 600,
        totalCostUsd: 1.75,
      });
      const [start, end] = mockReadRange.mock.calls[0];
      expect(Date.parse(end) - Date.parse(start)).toBe(29 * 24 * 60 * 60 * 1000);

      const one = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/usage?period=month&userId=U2',
        headers: AUTH_HEADER,
      });
      expect(JSON.parse(one.body).totals).toMatchObject({ totalInputTokens: 3000, totalOutputTokens: 400 });
    });
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
    const { getConversation } = await import('../recorder');
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
          summarized: true,
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
    expect(body.turns[1].summarized).toBe(true);
  });

  it('should return summarized:false for pending assistant turns', async () => {
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockResolvedValueOnce({
      id: 'conv-pending',
      title: 'Pending Summary',
      ownerName: 'Bob',
      workflow: 'default',
      createdAt: 1000,
      updatedAt: 2000,
      turns: [
        {
          id: 't1',
          role: 'assistant',
          timestamp: 1000,
          summaryTitle: undefined,
          summaryBody: undefined,
          summarized: false,
          rawContent: 'Some long response...',
        },
      ],
    });

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pending',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turns[0].summarized).toBe(false);
    expect(body.turns[0].summaryTitle).toBeUndefined();
    expect(body.turns[0].summaryBody).toBeUndefined();
    // rawContent excluded for assistant turns
    expect(body.turns[0].rawContent).toBeUndefined();
  });

  it('should return summarized:true with no title/body for failed summary', async () => {
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockResolvedValueOnce({
      id: 'conv-failed',
      title: 'Failed Summary',
      ownerName: 'Bob',
      workflow: 'default',
      createdAt: 1000,
      updatedAt: 2000,
      turns: [
        {
          id: 't1',
          role: 'assistant',
          timestamp: 1000,
          summaryTitle: undefined,
          summaryBody: undefined,
          summarized: true,
          rawContent: 'Some long response...',
        },
      ],
    });

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-failed',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // summarized=true but no title/body → UI shows "Summary failed"
    expect(body.turns[0].summarized).toBe(true);
    expect(body.turns[0].summaryTitle).toBeUndefined();
    expect(body.turns[0].summaryBody).toBeUndefined();
  });

  // ── Session detail pagination (limit + before cursor) ──

  // Helper: build a conversation with N sequential user turns (t1..tN).
  const makePaginatedConv = (id: string, n: number) => ({
    id,
    title: `Paginated ${id}`,
    ownerName: 'Alice',
    workflow: 'default',
    createdAt: 1000,
    updatedAt: 2000,
    turns: Array.from({ length: n }, (_, i) => ({
      id: `t${i + 1}`,
      role: 'user' as const,
      timestamp: 1000 + i,
      userName: 'Alice',
      rawContent: `msg ${i + 1}`,
    })),
  });

  it('pagination: backward compatible — no params returns latest 30 by default with hasMore', async () => {
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockResolvedValueOnce(makePaginatedConv('conv-pg-default', 50));

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pg-default',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turnCount).toBe(50);
    expect(body.turns).toHaveLength(30);
    // Latest window: last 30 (t21..t50)
    expect(body.turns[0].id).toBe('t21');
    expect(body.turns[body.turns.length - 1].id).toBe('t50');
    expect(body.hasMore).toBe(true);
  });

  it('pagination: returns latest N turns with hasMore:true when explicit limit smaller than total', async () => {
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockResolvedValueOnce(makePaginatedConv('conv-pg-limit', 20));

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pg-limit?limit=5',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turns).toHaveLength(5);
    expect(body.turns[0].id).toBe('t16');
    expect(body.turns[4].id).toBe('t20');
    expect(body.hasMore).toBe(true);
  });

  it('pagination: hasMore:false when all turns fit within limit', async () => {
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockResolvedValueOnce(makePaginatedConv('conv-pg-all', 10));

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pg-all?limit=30',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turns).toHaveLength(10);
    expect(body.turns[0].id).toBe('t1');
    expect(body.turns[9].id).toBe('t10');
    expect(body.hasMore).toBe(false);
  });

  it('pagination: before cursor returns older turns strictly before the given id', async () => {
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockResolvedValueOnce(makePaginatedConv('conv-pg-before', 20));

    // Ask for 5 turns before t10 → expect t5..t9
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pg-before?limit=5&before=t10',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turns).toHaveLength(5);
    expect(body.turns[0].id).toBe('t5');
    expect(body.turns[4].id).toBe('t9');
    expect(body.hasMore).toBe(true); // t1..t4 remain

    // Second page: before t5 → t1..t4, hasMore:false
    (getConversation as any).mockResolvedValueOnce(makePaginatedConv('conv-pg-before', 20));
    const res2 = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pg-before?limit=5&before=t5',
      headers: AUTH_HEADER,
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.turns).toHaveLength(4);
    expect(body2.turns[0].id).toBe('t1');
    expect(body2.turns[3].id).toBe('t4');
    expect(body2.hasMore).toBe(false);
  });

  it('pagination: unknown before cursor returns empty turns with hasMore:false', async () => {
    const { getConversation } = await import('../recorder');
    (getConversation as any).mockResolvedValueOnce(makePaginatedConv('conv-pg-unknown', 20));

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pg-unknown?limit=5&before=t999',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turns).toHaveLength(0);
    expect(body.hasMore).toBe(false);
    // turnCount still reflects full conversation
    expect(body.turnCount).toBe(20);
  });

  it('pagination: clamps limit to [1, 200]', async () => {
    const { getConversation } = await import('../recorder');

    // limit=0 → clamped to 1
    (getConversation as any).mockResolvedValueOnce(makePaginatedConv('conv-pg-clamp-lo', 10));
    const resLo = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pg-clamp-lo?limit=0',
      headers: AUTH_HEADER,
    });
    expect(resLo.statusCode).toBe(200);
    const bodyLo = JSON.parse(resLo.body);
    expect(bodyLo.turns).toHaveLength(1);
    expect(bodyLo.turns[0].id).toBe('t10'); // latest single
    expect(bodyLo.hasMore).toBe(true);

    // limit=9999 → clamped to 200 (but only 250 turns so returns last 200)
    (getConversation as any).mockResolvedValueOnce(makePaginatedConv('conv-pg-clamp-hi', 250));
    const resHi = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pg-clamp-hi?limit=9999',
      headers: AUTH_HEADER,
    });
    expect(resHi.statusCode).toBe(200);
    const bodyHi = JSON.parse(resHi.body);
    expect(bodyHi.turns).toHaveLength(200);
    expect(bodyHi.turns[0].id).toBe('t51');
    expect(bodyHi.turns[199].id).toBe('t250');
    expect(bodyHi.hasMore).toBe(true);

    // limit=NaN (non-numeric) → falls back to default 30
    (getConversation as any).mockResolvedValueOnce(makePaginatedConv('conv-pg-clamp-nan', 50));
    const resNaN = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/session/conv-pg-clamp-nan?limit=abc',
      headers: AUTH_HEADER,
    });
    expect(resNaN.statusCode).toBe(200);
    const bodyNaN = JSON.parse(resNaN.body);
    expect(bodyNaN.turns).toHaveLength(30);
  });

  // ── Inline JS escaping regression (PR #280) ──

  it('should render syntactically valid inline JavaScript', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const html: string = res.body;

    // Extract <script> content
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const scriptContent = scriptMatch![1];

    // Verify the script is syntactically valid JS
    // new Function() parses but does not execute the code
    expect(() => new Function(scriptContent)).not.toThrow();
  });

  it('declares every top-level client function and variable exactly once (all classic scripts)', async () => {
    // A second `function f` silently replaces the first in the browser (the
    // later declaration wins), so the page would run code no test looked at.
    // Classic scripts share one global scope, so a name declared in two
    // blocks (e.g. the <script data-fouc> head block and the main one)
    // collides the same way.
    const res = await injectWebServer({ method: 'GET', url: '/dashboard', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const html = res.body as string;
    const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m, i) => ({
      label: `#${i} <script${m[1]}>`,
      attrs: m[1],
      code: m[2],
    }));
    // Every opening tag was matched as a block (no script is skipped silently).
    expect(blocks.length).toBe((html.match(/<script\b/gi) ?? []).length);
    // Classic = inline and JavaScript (a module has its own scope, a data block is not code).
    const isClassic = (attrs: string) => {
      if (/\bsrc\s*=/i.test(attrs)) return false;
      const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
      return !type || type === 'text/javascript' || type === 'application/javascript';
    };
    const classic = blocks.filter((b) => isClassic(b.attrs));
    expect(classic.some((b) => /\bdata-fouc\b/.test(b.attrs))).toBe(true);
    const ts = await import('typescript');
    const where = new Map<string, string[]>(); // name → label of every block that declares it
    for (const b of classic) {
      expect(() => new Function(b.code), b.label).not.toThrow(); // each block parses on its own
      const file = ts.createSourceFile('client.js', b.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const add = (name: string) => where.set(name, [...(where.get(name) ?? []), b.label]);
      for (const stmt of file.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt.name.text);
        if (ts.isVariableStatement(stmt)) {
          for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name.text);
        }
        if (ts.isClassDeclaration(stmt) && stmt.name) add(stmt.name.text);
      }
    }
    expect(where.size).toBeGreaterThan(100); // the whole client script was parsed
    expect(where.has('ensureCardIo')).toBe(true);
    const duplicates = [...where].filter(([, at]) => at.length > 1).map(([name, at]) => `${name} in ${at.join(', ')}`);
    expect(duplicates).toEqual([]);
  });

  it('should render onclick handlers with properly escaped quotes', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard/U123',
      headers: AUTH_HEADER,
    });

    const html: string = res.body;

    // Extract <script> content
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch![1];

    // The JS code that builds onclick handlers must use \' for escaping
    // NOT '' (empty string concat) which was the bug before PR #280
    // Check doAction onclick builders have properly escaped quotes
    expect(script).toContain("doAction(\\''");
    // Spec 13: one builder (sessionActionHtml) serves the card and the panel head;
    // the action name is a closed set (stop · close · trash) joined in escaped quotes.
    expect(script).toContain("\\',\\'' + kind + '\\')");
    expect(script).toContain("var kind = running ? 'stop' : (col === 'closed' && s.terminated ? 'trash' : 'close');");
    // Check openPanel onclick builder
    expect(script).toContain("openPanel(\\''");
  });

  // ── Hostile input escaping (runtime safety) ──

  it('should safely return hostile session keys via API without corruption', async () => {
    const hostileKey = "C1:t1'\\evil";
    const sessions = new Map<string, any>();
    sessions.set(hostileKey, {
      sessionId: 'hostile-sid',
      title: "Session with 'hostile' key\\path",
      ownerId: 'U1',
      ownerName: "Al'ice",
      workflow: 'default',
      model: 'claude-opus-4-6',
      channelId: 'C1',
      threadTs: "t1'\\evil",
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-03-29T10:00:00Z'),
    });
    setDashboardSessionAccessor(() => sessions);

    // API must JSON-serialize hostile keys without corruption
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.working).toHaveLength(1);
    const s = body.board.working[0];
    // key field carries the hostile map key through JSON intact
    expect(s.key).toBe(hostileKey);
    expect(s.title).toBe("Session with 'hostile' key\\path");
    expect(s.ownerName).toBe("Al'ice");
  });

  it('should produce valid inline JS even with hostile session data present', async () => {
    const hostileKey = "C1:t1'\\evil";
    const sessions = new Map<string, any>();
    sessions.set(hostileKey, {
      sessionId: 'hostile-sid',
      title: "O'Reilly\\Media",
      ownerId: 'U1',
      ownerName: "Al'ice",
      workflow: 'default',
      model: 'claude-opus-4-6',
      channelId: 'C1',
      threadTs: "t1'\\evil",
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-03-29T10:00:00Z'),
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const html: string = res.body;

    // The entire inline <script> must still parse as valid JS
    // even though session data with hostile chars will be fetched at runtime
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const scriptContent = scriptMatch![1];
    expect(() => new Function(scriptContent)).not.toThrow();

    // Verify escJs function is present and structurally correct
    expect(scriptContent).toContain('function escJs(s)');
    // escJs must escape backslashes BEFORE quotes (order matters)
    const escJsBody = scriptContent.match(/function escJs\(s\)\s*\{([\s\S]*?)\n\s*\}/);
    expect(escJsBody).not.toBeNull();
    // The replace chain must handle \\ before ' — verify ordering
    const body = escJsBody![1];
    const bsPos = body.indexOf('replace(/\\\\/g');
    const quotePos = body.indexOf("replace(/'/g");
    expect(bsPos).toBeGreaterThan(-1);
    expect(quotePos).toBeGreaterThan(-1);
    expect(bsPos).toBeLessThan(quotePos); // backslash escape first, then quote
  });

  // ── Completeness: all inline handlers use correct escaping ──

  it('should not have any onclick handlers with broken empty-string escaping', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const html: string = res.body;

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch![1];

    // The broken pattern before PR #280 was: doAction('' + escJs(...)
    // Correct pattern is: doAction(\'' + escJs(...)
    // Scan for ALL doAction/openPanel calls and ensure none use the broken pattern
    const brokenDoAction = script.match(/doAction\(''/g);
    const brokenOpenPanel = script.match(/openPanel\(''/g);
    expect(brokenDoAction).toBeNull();
    expect(brokenOpenPanel).toBeNull();

    // Verify correct pattern exists for each action type
    const correctDoAction = script.match(/doAction\(\\'/g);
    const correctOpenPanel = script.match(/openPanel\(\\'/g);
    expect(correctDoAction).not.toBeNull();
    expect(correctOpenPanel).not.toBeNull();

    // There should be exactly 4 doAction calls (stop, close for idle/waiting, close for sleeping, trash for archived)
    // and 2 openPanel calls (open card's "작업 로그" button + multi-choice "답변하기" button).
    // A card click no longer opens the panel — it expands the card in place
    // through a delegated listener (.prd/10 §3.1-4), so it has no inline handler.
    // Spec 13: exactly 1 doAction builder (sessionActionHtml — stop / close / trash, shared by the
    // open card and the panel head) and 4 openPanel builders: 답변하기, 전체 task N개 →, the goal
    // line's 관리 → / 보기 →, the artifacts' 전체 N개 →. SSOT 2026-10-29 T2 removed the open card's
    // 작업 로그 button (openPanel(key,true,'',…) — an open card's detail card is always beside the
    // board now, the detail deck); the three left that pass an empty agent id still pin its \'\'.
    expect(correctDoAction!.length).toBe(1);
    expect(correctOpenPanel!.length).toBe(4);
    expect(script.match(/\\',\\'\\',event\.detail===0\)/g)?.length).toBe(3);
    expect(script).not.toContain("',true,\\'\\',event.detail===0)");
    // The panel's ✕ and backdrop close the front detail card (and fold its card): no string arguments.
    expect(html).toContain('<div class="slide-panel-overlay" id="panel-overlay" onclick="closeDetailCard()"></div>');
    expect(html).toMatch(/<button class="panel-close"[^>]*onclick="closeDetailCard\(\)">/);
  });

  it('should have all inline handlers escaped consistently', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });
    const html: string = res.body;
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch![1];

    // Every string literal in handler builders that uses escJs must
    // also close with escaped quotes: \\',\\'action\\')
    // Count action closings — each doAction has 2 escaped quote pairs (key + action)
    const actionClosings = script.match(/\\',\\'/g);
    expect(actionClosings).not.toBeNull();
    // 1 doAction builder + 1 resummarize + the intent of 전체 task (2), the goal line (2) and the
    // artifacts link (2) — every argument of every builder closes in escaped quotes = 8.
    // The 4 answerChoice sites (card/panel × recommended/other) and the selectMc
    // site no longer build inline JS strings: their model-written question /
    // label / id travel in attribute-escaped data-choice-* attributes read by
    // one delegated click handler, because escJs() inside a double-quoted
    // onclick could not carry " or newlines safely (.prd/10 round-2 review).
    expect(actionClosings!.length).toBe(8);
    expect(script).not.toMatch(/answerChoice\(\\'/);
    expect(script).not.toMatch(/selectMc\(\\'/);
  });

  // ── Guard: detect unescaped inline handlers if new ones are added ──

  it('should not contain any raw function calls in onclick without escJs protection', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });
    const html: string = res.body;
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch![1];

    // Guard: if someone adds a new onclick handler that builds strings with
    // unescaped single quotes, this catches it.
    // Pattern: any JS string concatenation building an onclick that uses (' or ')
    // without a preceding backslash — this would break in rendered HTML.
    //
    // Valid:   doAction(\'' + escJs(s.key) + '\\',\\'stop\\')
    // Invalid: doAction('' + s.key + '',''stop'')
    //
    // Check: every occurrence of "Action(" or "Panel(" in handler-building
    // lines must be followed by \' not just '
    const handlerCalls = script.match(/(?:doAction|openPanel|closePanel|sendCommand)\(/g);
    if (handlerCalls) {
      // For each unique handler function name found, verify escaping is used
      const uniqueHandlers = [...new Set(handlerCalls.map((h: string) => h.replace('(', '')))];
      for (const handler of uniqueHandlers) {
        // If this handler appears in a string-building context (with quotes),
        // it must use escaped quotes
        const buildPattern = new RegExp(`${handler}\\(''`, 'g');
        const broken = script.match(buildPattern);
        expect(broken).toBeNull();
      }
    }
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

  // ── Theme toggle follow-up (Issue #370) ──

  it('should include FOUC prevention script before styles', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const html: string = res.body;
    // FOUC script must appear before <style>
    const foucIdx = html.indexOf('<script data-fouc>');
    const styleIdx = html.indexOf('<style>');
    expect(foucIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeGreaterThan(-1);
    expect(foucIdx).toBeLessThan(styleIdx);
    // Must set data-theme attribute
    expect(html.substring(foucIdx, styleIdx)).toContain('data-theme');
  });

  // Tone pass P4: the theme toggle is the site's 34px icon button — the sun / moon are 16-grid SVGs
  // (no emoji, no ::before content), the visible one chosen by data-theme in CSS; Korean label.
  it('should have theme toggle button with aria-label and no hardcoded emoji', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    const html: string = res.body;
    // Button must exist with aria-label
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('aria-label="테마 전환"');
    // Button content: the two SVG glyphs, no text and no emoji
    const btnMatch = html.match(/<button[^>]*id="theme-toggle"[^>]*>(.*?)<\/button>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch![1]).toMatch(
      /^<svg class="ic-sun"[^>]*aria-hidden="true">.*<\/svg><svg class="ic-moon"[^>]*aria-hidden="true">.*<\/svg>$/,
    );
    expect(btnMatch![1].replace(/<[^>]+>/g, '').trim()).toBe('');
    expect(html).not.toContain('\\1F319');
  });

  it('should have CSS rules that pick the theme icon by data-theme', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    const html: string = res.body;
    // CSS shows the sun in the dark theme and the moon in the light one; no ::before glyph is left
    expect(html).toContain('#theme-toggle .ic-moon, [data-theme="light"] #theme-toggle .ic-sun { display: none; }');
    expect(html).toContain('[data-theme="light"] #theme-toggle .ic-moon { display: block; }');
    expect(html).not.toContain('#theme-toggle::before');
  });

  it('should have theme JS functions in inline script', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    const html: string = res.body;
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch![1];
    expect(script).toContain('function getPreferredTheme()');
    expect(script).toContain('function applyTheme(');
    expect(script).toContain('function toggleTheme()');
  });

  it('should have light theme functional color overrides for WCAG AA', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    const html: string = res.body;
    // P10 (tone pass): the light theme block is @2lab.ai/ui's tokens.css — it overrides the
    // functional colors as --ui-*, and the dashboard's names are aliases of them.
    const tokens = html.slice(html.indexOf('<style id="ui-tokens">'));
    const lightBlock = tokens.match(/\[data-theme="light"\]\s*\{([^}]+)\}/);
    expect(lightBlock).not.toBeNull();
    const block = lightBlock![1];
    for (const c of ['green', 'yellow', 'red', 'purple', 'orange']) {
      expect(block).toContain(`--ui-${c}:`);
      expect(html).toContain(`--${c}: var(--ui-${c});`);
    }
  });

  it('should auto-clear localStorage when toggled theme matches OS preference', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    const html: string = res.body;
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch![1];
    // toggleTheme must contain removeItem for auto-clear logic
    const toggleFn = script.match(/function toggleTheme\(\)\s*\{([\s\S]*?)\n\}/);
    expect(toggleFn).not.toBeNull();
    expect(toggleFn![1]).toContain('removeItem');
    expect(toggleFn![1]).toContain('osTheme');
  });

  // ── Hero "Submit All Recommended" endpoint (#581) ──

  describe('POST /api/dashboard/session/:key/submit-recommended', () => {
    let setDashboardSubmitRecommendedHandler: any;

    beforeEach(async () => {
      const dashboard = await import('../dashboard');
      setDashboardSubmitRecommendedHandler = dashboard.setDashboardSubmitRecommendedHandler;
    });

    it('Test 13a — returns 200 and { ok: true } on successful submission', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      setDashboardSubmitRecommendedHandler(handler);

      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/session/C1%3At1/submit-recommended',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(handler).toHaveBeenCalledWith('C1:t1');
    });

    it('Test 13b — returns 401 without auth', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      setDashboardSubmitRecommendedHandler(handler);

      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/session/C1%3At1/submit-recommended',
      });

      expect(res.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it('Test 13c — returns 404 when session not found', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Session not found'));
      setDashboardSubmitRecommendedHandler(handler);

      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/session/C1%3At1/submit-recommended',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'Session not found' });
    });

    it('Test 13d — returns 409 when session not waiting', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Session is not waiting for a choice'));
      setDashboardSubmitRecommendedHandler(handler);

      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/session/C1%3At1/submit-recommended',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toContain('not waiting');
    });

    it('Test 13e — returns 409 when no pending multi-choice question', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Session has no pending multi-choice question'));
      setDashboardSubmitRecommendedHandler(handler);

      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/session/C1%3At1/submit-recommended',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toContain('no pending multi-choice');
    });

    it('Test 13f — returns 409 when submission in progress (cross-surface lock)', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Submission in progress'));
      setDashboardSubmitRecommendedHandler(handler);

      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/session/C1%3At1/submit-recommended',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'Submission in progress' });
    });

    it('Test 13g — returns 409 when recommendations incomplete', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Recommendations incomplete'));
      setDashboardSubmitRecommendedHandler(handler);

      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/session/C1%3At1/submit-recommended',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'Recommendations incomplete' });
    });

    it('Test 13h — returns 422 when no recommendation available', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('No recommendation available'));
      setDashboardSubmitRecommendedHandler(handler);

      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/session/C1%3At1/submit-recommended',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body)).toEqual({ error: 'No recommendation available' });
    });

    it('Test 13i — returns 500 on unexpected handler error', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('boom unrelated'));
      setDashboardSubmitRecommendedHandler(handler);

      const res = await injectWebServer({
        method: 'POST',
        url: '/api/dashboard/session/C1%3At1/submit-recommended',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'Internal Server Error' });
    });

    it('Test 13j — returns 501 when no handler is configured', async () => {
      // Reset handler to null by re-importing fresh module (vi.resetModules in outer beforeEach)
      // but we never registered one for this test
      vi.resetModules();
      mockConfig.conversation.viewerToken = 'test-token';
      const webServer = await import('../web-server');
      const dashboard = await import('../dashboard');
      const startFresh = webServer.startWebServer;
      const injectFresh = webServer.injectWebServer;
      const stopFresh = webServer.stopWebServer;

      // Register session accessor but NOT submit-recommended handler
      dashboard.setDashboardSessionAccessor(() => new Map());
      await startFresh({ listen: false });

      try {
        const res = await injectFresh({
          method: 'POST',
          url: '/api/dashboard/session/C1%3At1/submit-recommended',
          headers: AUTH_HEADER,
        });

        expect(res.statusCode).toBe(501);
        expect(JSON.parse(res.body).error).toContain('handler not configured');
      } finally {
        await stopFresh();
      }
    });
  });

  // ── Hero button render (Test 10) ──

  describe('renderMultiChoicePanel hero button', () => {
    it('Test 10 — inline JS includes submitAllRecommended function and hero button branches', async () => {
      const res = await injectWebServer({
        method: 'GET',
        url: '/dashboard',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(200);
      const html: string = res.body;
      const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(scriptMatch).not.toBeNull();
      const script = scriptMatch![1];

      // submitAllRecommended function exists
      expect(script).toContain('function submitAllRecommended');
      // POSTs to the new endpoint
      expect(script).toContain('/submit-recommended');
      // CSRF header is set in the action
      expect(script).toContain('X-CSRF-Token');
      // Active branch button class + onclick wiring
      expect(script).toContain('btn-hero-recommended');
      // Active branch label (escaped Unicode for 추천대로 모두 선택) — tone pass P2: no star (the
      // hero is the form's ink primary; no emoji in labels)
      expect(script).toContain('\\uCD94\\uCC9C\\uB300\\uB85C \\uBAA8\\uB450 \\uC120\\uD0DD');
      expect(script).not.toContain('\\u2B50');
      // Blocked branch label sentinel (추천 부족), no lock emoji
      expect(script).toContain('\\uCD94\\uCC9C \\uBD80\\uC871');
      expect(script).not.toContain('\\uD83D\\uDD12');
      // Skips 직접입력 sentinel when counting
      expect(script).toContain('\\uC9C1\\uC811\\uC785\\uB825');
      // CSS class definition is present in the page (style tag)
      expect(html).toContain('.btn-hero-recommended');
    });
  });
});

describe('Ghost session filtering (#438)', () => {
  let injectWebServer: any;
  let setDashboardSessionAccessor: any;
  let startWebServer: any;
  let stopWebServer: any;

  beforeEach(async () => {
    vi.resetModules();
    mockListRecent.mockReturnValue([]);
    mockConfig.conversation.viewerToken = 'test-token';

    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;

    const dashboard = await import('../dashboard');
    setDashboardSessionAccessor = dashboard.setDashboardSessionAccessor;

    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  it('should filter out archives without sessionId', async () => {
    setDashboardSessionAccessor(() => new Map());
    mockListRecent.mockReturnValue([
      {
        archivedAt: Date.now(),
        archiveReason: 'terminated',
        sessionKey: 'C1:t1',
        // no sessionId — ghost session
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C1',
        threadTs: 't1',
        title: 'Untitled',
        model: 'default',
        workflow: 'unknown',
        lastActivity: new Date().toISOString(),
      },
    ]);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.closed).toHaveLength(0);
  });

  it('should show archives with sessionId', async () => {
    setDashboardSessionAccessor(() => new Map());
    mockListRecent.mockReturnValue([
      {
        archivedAt: Date.now(),
        archiveReason: 'terminated',
        sessionKey: 'C1:t1',
        sessionId: 'sid-valid',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C1',
        threadTs: 't1',
        title: 'Real Session',
        model: 'claude-opus-4-6',
        workflow: 'jira-create-pr',
        lastActivity: new Date().toISOString(),
      },
    ]);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.closed).toHaveLength(1);
    expect(body.board.closed[0].title).toBe('Real Session');
  });

  it('should dedup archives by conversationId (newer wins)', async () => {
    setDashboardSessionAccessor(() => new Map());
    const now = Date.now();
    mockListRecent.mockReturnValue([
      {
        archivedAt: now - 1000, // older
        archiveReason: 'terminated',
        sessionKey: 'C1:t1',
        sessionId: 'sid-old',
        conversationId: 'conv-shared',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C1',
        threadTs: 't1',
        title: 'Old Session',
        model: 'claude-opus-4-6',
        workflow: 'default',
        lastActivity: new Date(now - 1000).toISOString(),
      },
      {
        archivedAt: now, // newer
        archiveReason: 'terminated',
        sessionKey: 'C1:t2',
        sessionId: 'sid-new',
        conversationId: 'conv-shared',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C1',
        threadTs: 't2',
        title: 'New Session',
        model: 'claude-opus-4-6',
        workflow: 'default',
        lastActivity: new Date(now).toISOString(),
      },
    ]);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.closed).toHaveLength(1);
    expect(body.board.closed[0].title).toBe('New Session');
  });

  it('should dedup archives by thread key (newer wins)', async () => {
    setDashboardSessionAccessor(() => new Map());
    const now = Date.now();
    mockListRecent.mockReturnValue([
      {
        archivedAt: now - 2000, // older
        archiveReason: 'terminated',
        sessionKey: 'key-old',
        sessionId: 'sid-old',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C1',
        threadTs: 't-shared',
        title: 'Old Thread Session',
        model: 'claude-opus-4-6',
        workflow: 'default',
        lastActivity: new Date(now - 2000).toISOString(),
      },
      {
        archivedAt: now, // newer
        archiveReason: 'terminated',
        sessionKey: 'key-new',
        sessionId: 'sid-new',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C1',
        threadTs: 't-shared',
        title: 'New Thread Session',
        model: 'claude-opus-4-6',
        workflow: 'default',
        lastActivity: new Date(now).toISOString(),
      },
    ]);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.closed).toHaveLength(1);
    expect(body.board.closed[0].title).toBe('New Thread Session');
  });

  it('should still filter archives overlapping with live sessions', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t-live', {
      sessionId: 'sid-live',
      title: 'Live Session',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      threadTs: 't-live',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date(),
    });
    setDashboardSessionAccessor(() => sessions);

    mockListRecent.mockReturnValue([
      {
        archivedAt: Date.now(),
        archiveReason: 'terminated',
        sessionKey: 'C1:t-live',
        sessionId: 'sid-archived',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C1',
        threadTs: 't-live', // same thread as live session
        title: 'Archived Overlap',
        model: 'claude-opus-4-6',
        workflow: 'default',
        lastActivity: new Date().toISOString(),
      },
    ]);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.closed).toHaveLength(0);
  });

  it('should not produce false positives — different archives both appear', async () => {
    setDashboardSessionAccessor(() => new Map());
    const now = Date.now();
    mockListRecent.mockReturnValue([
      {
        archivedAt: now,
        archiveReason: 'terminated',
        sessionKey: 'C1:t1',
        sessionId: 'sid-1',
        conversationId: 'conv-a',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C1',
        threadTs: 't1',
        title: 'Session A',
        model: 'claude-opus-4-6',
        workflow: 'default',
        lastActivity: new Date(now).toISOString(),
      },
      {
        archivedAt: now - 1000,
        archiveReason: 'terminated',
        sessionKey: 'C2:t2',
        sessionId: 'sid-2',
        conversationId: 'conv-b',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C2',
        threadTs: 't2',
        title: 'Session B',
        model: 'claude-opus-4-6',
        workflow: 'default',
        lastActivity: new Date(now - 1000).toISOString(),
      },
    ]);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.board.closed).toHaveLength(2);
    const titles = body.board.closed.map((c: any) => c.title);
    expect(titles).toContain('Session A');
    expect(titles).toContain('Session B');
  });
});

// ── Short-ref extractors (used by the Kanban card meta / refs rows) ──
describe('extractIssueShortRef / extractPrShortRef', () => {
  let extractIssueShortRef: (url?: string) => string | undefined;
  let extractPrShortRef: (url?: string) => string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../dashboard');
    extractIssueShortRef = mod.extractIssueShortRef;
    extractPrShortRef = mod.extractPrShortRef;
  });

  it('extracts PROJ-123 from /browse/PROJ-123', () => {
    expect(extractIssueShortRef('https://x.atlassian.net/browse/PROJ-123')).toBe('PROJ-123');
  });

  it('extracts key followed by trailing path', () => {
    expect(extractIssueShortRef('https://x/browse/ABC-42/detail')).toBe('ABC-42');
  });

  it('returns undefined for no URL', () => {
    expect(extractIssueShortRef(undefined)).toBeUndefined();
  });

  it('returns undefined for non-browse URL', () => {
    expect(extractIssueShortRef('https://github.com/org/repo')).toBeUndefined();
  });

  it('rejects single-letter project key (A-123)', () => {
    expect(extractIssueShortRef('https://x/browse/A-123')).toBeUndefined();
  });

  it('extracts PR-123 from /pull/123', () => {
    expect(extractPrShortRef('https://github.com/org/repo/pull/123')).toBe('PR-123');
  });

  it('extracts PR-123 from /pull/123/files', () => {
    expect(extractPrShortRef('https://github.com/org/repo/pull/123/files')).toBe('PR-123');
  });

  it('extracts PR-123 from /pull/123#issuecomment-999', () => {
    expect(extractPrShortRef('https://github.com/org/repo/pull/123#issuecomment-999')).toBe('PR-123');
  });

  it('returns undefined for issues URL (not a PR)', () => {
    expect(extractPrShortRef('https://github.com/org/repo/issues/123')).toBeUndefined();
  });

  it('returns undefined for no URL (PR)', () => {
    expect(extractPrShortRef(undefined)).toBeUndefined();
  });
});

// ── Dashboard header surface config injection (ui.dashboardheader) ──
describe('DASHBOARD_HEADER_CONFIG injection', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let surfaceConfig: any;

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = 'test-token';

    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;

    // Import via the same src shim dashboard.ts uses so this test shares the
    // module-store instance with the served page (resetModules gives a fresh
    // store per test).
    surfaceConfig = await import('../../slack/surface-config');
    await import('../dashboard');

    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    surfaceConfig.resetUiSurfacesConfig();
    await stopWebServer();
  });

  function extractInjectedConfig(html: string): any {
    const match = html.match(/const DASHBOARD_HEADER_CONFIG = (.*);/);
    expect(match, 'DASHBOARD_HEADER_CONFIG assignment not found in served HTML').toBeTruthy();
    return JSON.parse((match as RegExpMatchArray)[1]);
  }

  it('serves the default dashboardheader lines (title, tasks, tokens...) in the HTML', async () => {
    const res = await injectWebServer({ method: 'GET', url: '/dashboard', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);

    const lines = extractInjectedConfig(res.body);
    const fields = lines.flatMap((l: any) => l.fields.map((f: any) => f.field));
    expect(fields).toContain('title');
    expect(fields).toContain('tasks');
    expect(fields).toContain('tokens');
    expect(fields).toContain('cost');
    expect(fields).toContain('contextwindow');
    expect(fields).toContain('mergestats');
    expect(fields).toContain('links');
    // Meta-row fields the card renders — part of the default lines so they
    // are gateable (registry contract: fields absent from config lines are
    // hidden). Pre-fix these rendered unconditionally and were missing here.
    expect(fields).toContain('owner');
    expect(fields).toContain('workflow');
    expect(fields).toContain('model');
    expect(fields).toContain('status');
  });

  it('hiding workflow/model via custom dashboardheader config resolves them hidden in the injected JSON', async () => {
    surfaceConfig.setUiSurfacesConfig({
      dashboardheader: {
        lines: [
          { fields: [{ field: 'title' }, { field: 'links' }] },
          {
            fields: [
              { field: 'workflow', show: false },
              { field: 'model', show: false },
              { field: 'owner' },
              { field: 'status' },
            ],
          },
        ],
      },
    });

    const res = await injectWebServer({ method: 'GET', url: '/dashboard', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);

    const lines = extractInjectedConfig(res.body);
    const byField: Record<string, any> = {};
    for (const line of lines) for (const f of line.fields) if (!(f.field in byField)) byField[f.field] = f;

    // dhShow(field) in the client is `!!f && f.show !== false` — these two
    // must resolve hidden while owner/status stay visible.
    expect(byField.workflow.show).toBe(false);
    expect(byField.model.show).toBe(false);
    expect(byField.owner.show).not.toBe(false);
    expect(byField.status.show).not.toBe(false);
    // Fields absent from the custom lines resolve hidden too (no entry).
    expect(byField.tasks).toBeUndefined();
  });

  it('reflects a setUiSurfacesConfig override in the injected JSON', async () => {
    surfaceConfig.setUiSurfacesConfig({
      dashboardheader: { lines: [{ fields: [{ field: 'title' }] }] },
    });

    const res = await injectWebServer({ method: 'GET', url: '/dashboard', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);

    const lines = extractInjectedConfig(res.body);
    const fields = lines.flatMap((l: any) => l.fields.map((f: any) => f.field));
    expect(fields).toEqual(['title']);
    expect(fields).not.toContain('tasks');
  });

  it('escapes </script>-capable sequences in the injected JSON', async () => {
    surfaceConfig.setUiSurfacesConfig({
      dashboardheader: { lines: [{ fields: [{ field: 'title', label: '</script><b>' }] }] },
    });

    const res = await injectWebServer({ method: 'GET', url: '/dashboard', headers: AUTH_HEADER });
    const match = res.body.match(/const DASHBOARD_HEADER_CONFIG = (.*);/);
    expect(match).toBeTruthy();
    expect(match![1]).not.toContain('</script>');
    const lines = JSON.parse(match![1]);
    expect(lines[0].fields[0].label).toBe('</script><b>');
  });
});

// ── SSOT 2026-10-29 T8 — the Slack bot's name (setDashboardBotName) ──
// The answers in the dashboard's chat carry the bot's Slack name: the page gets
// this instance's as `const BOT_NAME` (the client's fallback), and every card
// this instance serves carries it as `botName` (a sibling's cards bring theirs).
describe('BOT_NAME injection (SSOT 2026-10-29 T8)', () => {
  let webServer: typeof import('../web-server');
  let setDashboardBotName: typeof import('../dashboard')['setDashboardBotName'];
  let setDashboardSessionAccessor: typeof import('../dashboard')['setDashboardSessionAccessor'];

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = 'test-token';

    webServer = await import('../web-server');
    // The same module instance the served page reads (resetModules: fresh per test).
    const dashboard = await import('../dashboard');
    setDashboardBotName = dashboard.setDashboardBotName;
    setDashboardSessionAccessor = dashboard.setDashboardSessionAccessor;

    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    // The name is module state: never let one test's bot name another's page.
    setDashboardBotName('');
    await webServer.stopWebServer();
  });

  async function servedBotNameLine(): Promise<string> {
    const res = await webServer.injectWebServer({ method: 'GET', url: '/dashboard', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const match = res.body.match(/^const BOT_NAME = .*;$/m);
    expect(match, 'BOT_NAME assignment not found in served HTML').toBeTruthy();
    return (match as RegExpMatchArray)[0];
  }

  it('serves the bot’s Slack name as a JSON string literal', async () => {
    setDashboardBotName('Soma Dev (Beta)');
    expect(await servedBotNameLine()).toBe('const BOT_NAME = "Soma Dev (Beta)";');
  });

  it('escapes < in the name (it comes from Slack) — no </script> can end the page script', async () => {
    setDashboardBotName('<b>x');
    expect(await servedBotNameLine()).toBe('const BOT_NAME = "\\u003cb>x";');
    setDashboardBotName('</script><img src=x onerror=alert(1)>');
    const line = await servedBotNameLine();
    expect(line).not.toContain('</script>');
    // Still the same name once the browser reads the literal.
    expect(JSON.parse(line.slice('const BOT_NAME = '.length, -1))).toBe('</script><img src=x onerror=alert(1)>');
  });

  it('null until the name resolves (empty, blank or absent) — the client then says Assistant', async () => {
    expect(await servedBotNameLine()).toBe('const BOT_NAME = null;');
    for (const name of ['', '   ', undefined]) {
      setDashboardBotName(name);
      expect(await servedBotNameLine()).toBe('const BOT_NAME = null;');
    }
  });

  it('trims the name and caps it at 80 characters', async () => {
    setDashboardBotName('  Soma Dev (Beta)  ');
    expect(await servedBotNameLine()).toBe('const BOT_NAME = "Soma Dev (Beta)";');
    setDashboardBotName('x'.repeat(100));
    expect(await servedBotNameLine()).toBe(`const BOT_NAME = "${'x'.repeat(80)}";`);
  });

  it('every card this instance serves carries the name as botName (absent until it resolves)', async () => {
    const sessions = new Map<string, Record<string, unknown>>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      title: 'Working session',
      ownerId: 'U1',
      ownerName: 'Alice',
      workflow: 'default',
      model: 'claude-opus-4-6',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-03-29T10:00:00Z'),
    });
    setDashboardSessionAccessor(() => sessions);
    const board = async () => {
      const res = await webServer.injectWebServer({
        method: 'GET',
        url: '/api/dashboard/sessions',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).board;
    };

    expect((await board()).working[0]).not.toHaveProperty('botName');
    setDashboardBotName('Soma Dev (Beta)');
    expect((await board()).working[0].botName).toBe('Soma Dev (Beta)');
  });
});
