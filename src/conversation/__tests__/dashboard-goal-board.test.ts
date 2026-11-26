import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * .prd/39 S6 · D14 — the board places a goal by its state, not by the display activity alone (X17, A17).
 *
 * The dashboard's own rules come first (sleep, a question, an armed resume, a host wait …). Only a card they leave in
 * DONE asks the goal: a turn held or a restart resume pending → RUNNING; a question to the owner or a stop the loop
 * made → NEEDS YOU; a goal someone drives → RUNNING; the rest stays DONE. `driven` and `turnHeld` live in the host's
 * memory — the dashboard reads them through the goal runtime probe (wired in index.ts to the Slack handler).
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

function goal(overrides: Record<string, any> = {}) {
  return {
    goalId: 'g1',
    objective: '#4989 리뷰·아키텍처 지도·머지 판단',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U1',
    continuationCount: 1,
    maxContinuations: 10,
    epoch: 1,
    ...overrides,
  };
}

function session(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    activityState: 'idle',
    state: 'MAIN',
    lastActivity: new Date('2026-10-22T08:54:52Z'),
    activeAccumulatedMs: 3_485_924,
    ...overrides,
  };
}

describe('Dashboard — the goal places a card the board left in DONE (S6)', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    dashboard.setDashboardGoalRuntime(null);
    await stopWebServer();
  });

  type Runtime = { turnHeld?: boolean; driven?: boolean; resumePending?: boolean };
  const asked: string[] = [];
  async function board(sessions: Map<string, any>, runtime: Record<string, Runtime> = {}) {
    dashboard.setDashboardSessionAccessor(() => sessions);
    asked.length = 0;
    dashboard.setDashboardGoalRuntime((key: string) => {
      asked.push(key);
      return { turnHeld: false, driven: false, resumePending: false, ...runtime[key] };
    });
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).board;
  }

  it('A17 / X17: the loop drives the goal while the session reads idle (judging, injecting) → RUNNING, not DONE', async () => {
    const b = await board(new Map([['C1:t1', session({ goal: goal() })]]), { 'C1:t1': { driven: true } });
    expect(asked).toContain('C1:t1');
    expect(b.idle).toHaveLength(0);
    expect(b.working).toHaveLength(1);
    expect(b.working[0].goalBoard).toEqual({ col: 'working', why: 'driven' });
  });

  it('a turn prepares on the slot while the display still reads idle (X1) → RUNNING', async () => {
    const b = await board(new Map([['C1:t1', session()]]), { 'C1:t1': { turnHeld: true } });
    expect(b.working.map((c: any) => c.goalBoard)).toEqual([{ col: 'working', why: 'turn' }]);
  });

  it('a restart cut the turn and its resume has not run → RUNNING', async () => {
    const b = await board(new Map([['C1:t1', session({ goal: goal() })]]), { 'C1:t1': { resumePending: true } });
    expect(b.working.map((c: any) => c.goalBoard)).toEqual([{ col: 'working', why: 'resume' }]);
  });

  it('the cap question is open → NEEDS YOU, waiting since the round opened', async () => {
    const b = await board(
      new Map([
        ['C1:t1', session({ goal: goal({ continuationCount: 10, capDmPendingAt: 4242, capDecisionId: 'r1' }) })],
      ]),
    );
    expect(b.idle).toHaveLength(0);
    expect(b.waiting).toHaveLength(1);
    expect(b.waiting[0].goalBoard).toEqual({ col: 'waiting', why: 'cap', at: 4242 });
    expect(b.waiting[0].waitingSince).toBe(4242);
    expect(b.waiting[0].goal.current.phase).toEqual({ kind: 'asking', why: 'cap' });
  });

  it('the loop stopped the goal (judge failed) → NEEDS YOU with the reason; a person stopped it → DONE, 멈춤', async () => {
    const b = await board(
      new Map<string, any>([
        ['C1:a', session({ threadTs: 'a', goal: goal({ phase: { kind: 'stopped', why: 'judge-failed', at: 9 } }) })],
        ['C1:b', session({ threadTs: 'b', goal: goal({ phase: { kind: 'stopped', why: 'person-stopped', at: 9 } }) })],
      ]),
    );
    expect(b.waiting.map((c: any) => c.goalBoard)).toEqual([{ col: 'waiting', why: 'judge-failed', at: 9 }]);
    expect(b.idle).toHaveLength(1);
    expect(b.idle[0].goalBoard).toBeUndefined();
    expect(b.idle[0].goal.current.phase).toEqual({ kind: 'stopped', why: 'person-stopped' });
  });

  it('a running goal nobody drives, and a hold in the slot, stay DONE (the hold names its why)', async () => {
    const b = await board(
      new Map<string, any>([
        ['C1:a', session({ threadTs: 'a', goal: goal() })],
        ['C1:b', session({ threadTs: 'b', goal: goal({ status: 'paused', holdWhy: 'dashboard-stop' }) })],
      ]),
    );
    expect(b.idle).toHaveLength(2);
    expect(b.idle.map((c: any) => c.goal.current.phase)).toEqual([
      { kind: 'running' },
      { kind: 'hold', why: 'dashboard-stop' },
    ]);
  });

  it("the board's own rules come first: a sleeping card stays CLOSED, a question stays NEEDS YOU", async () => {
    const b = await board(
      new Map<string, any>([
        ['C1:a', session({ threadTs: 'a', state: 'SLEEPING', goal: goal({ capDmPendingAt: 1, capDecisionId: 'r' }) })],
        ['C1:b', session({ threadTs: 'b', activityState: 'waiting', goal: goal() })],
      ]),
      { 'C1:a': { driven: true }, 'C1:b': { driven: true } },
    );
    expect(b.closed).toHaveLength(1);
    expect(b.closed[0].goal.current.phase).toEqual({ kind: 'asking', why: 'cap' });
    expect(b.waiting).toHaveLength(1);
    expect(b.waiting[0].goalBoard).toEqual({ col: 'working', why: 'driven' });
    expect(b.working).toHaveLength(0);
  });

  it('without a runtime probe the board still reads the goal it can see (questions and stops)', async () => {
    dashboard.setDashboardGoalRuntime(null);
    dashboard.setDashboardSessionAccessor(
      () => new Map([['C1:t1', session({ goal: goal({ phase: { kind: 'stopped', why: 'start-failed', at: 3 } }) })]]),
    );
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    const b = JSON.parse(res.body).board;
    expect(b.waiting.map((c: any) => c.goalBoard)).toEqual([{ col: 'waiting', why: 'start-failed', at: 3 }]);
  });
});
