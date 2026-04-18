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

const mockListRecent = vi.fn().mockReturnValue([]);
vi.mock('../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: mockListRecent }),
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
    const { getConversation } = await import('./recorder');
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
    const { getConversation } = await import('./recorder');
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
    expect(script).toContain("\\',\\'stop\\'");
    expect(script).toContain("\\',\\'close\\'");
    expect(script).toContain("\\',\\'trash\\'");
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
    // and 2 openPanel calls (card click + multi-choice "답변하기" button)
    expect(correctDoAction!.length).toBe(4);
    expect(correctOpenPanel!.length).toBe(2);
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
    // 4 doAction calls × 1 sep + 1 resummarize + 4 answerChoice × 3 seps + 1 selectMc × 1 sep = 18 closing patterns
    // (answerChoice appears at 4 sites: card-recommended, card-non-recommended, panel-recommended, panel-non-recommended)
    expect(actionClosings!.length).toBe(18);
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

  it('should have theme toggle button with aria-label and no hardcoded emoji', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    const html: string = res.body;
    // Button must exist with aria-label
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('aria-label="Toggle theme"');
    // Button content must be empty — icon is rendered via CSS ::before
    const btnMatch = html.match(/<button[^>]*id="theme-toggle"[^>]*>(.*?)<\/button>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch![1].trim()).toBe('');
  });

  it('should have CSS pseudo-element rules for theme icon', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    const html: string = res.body;
    // CSS must define ::before for theme-toggle
    expect(html).toContain('#theme-toggle::before');
    expect(html).toContain('[data-theme="light"] #theme-toggle::before');
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
    // Light theme block must override functional colors
    const lightBlock = html.match(/\[data-theme="light"\]\s*\{([^}]+)\}/);
    expect(lightBlock).not.toBeNull();
    const block = lightBlock![1];
    expect(block).toContain('--green:');
    expect(block).toContain('--yellow:');
    expect(block).toContain('--red:');
    expect(block).toContain('--purple:');
    expect(block).toContain('--orange:');
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
      const dashboard = await import('./dashboard');
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
      const webServer = await import('./web-server');
      const dashboard = await import('./dashboard');
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
      expect(script).toContain("X-CSRF-Token");
      // Active branch button class + onclick wiring
      expect(script).toContain('btn-hero-recommended');
      // Active branch label (escaped Unicode for ⭐ 추천대로 모두 선택)
      expect(script).toContain('\\u2B50');
      // Blocked branch label sentinel (🔒 추천 부족)
      expect(script).toContain('\\uD83D\\uDD12');
      // Skips 직접입력 sentinel when counting
      expect(script).toContain("\\uC9C1\\uC811\\uC785\\uB825");
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
