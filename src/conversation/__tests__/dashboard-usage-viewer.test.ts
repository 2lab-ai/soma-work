import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * affectUI review batch 1 (Z, 2026-10-27): the usage breakdown is by model for everyone and by user for
 * admins only. Server half: /api/dashboard/usage sends the per-user parts (byUser, the token and cost
 * rankings) to an admin or an operator token only — a non-admin's report leaves the server without them.
 * Real Fastify app, real JWT sign-in, the real aggregator over canned metrics events.
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

describe('usageForViewer — per-user usage to admins and operator tokens only', () => {
  // The first import transforms the whole dashboard module (seconds on a loaded runner): pay it once, outside the 5 s test budget.
  let usageForViewer: typeof import('../dashboard').usageForViewer;
  beforeAll(async () => {
    ({ usageForViewer } = await import('../dashboard'));
  }, 60_000);

  const report = () => ({
    totals: { totalCostUsd: 2 },
    byUser: { U1: { totalCostUsd: 1 }, U2: { totalCostUsd: 1 } },
    tokenRankings: [{ userId: 'U1' }],
    costRankings: [{ userId: 'U2' }],
    byDay: [{ date: '2026-10-28' }],
  });

  it('an admin, the header token and the token cookie get the whole report', async () => {
    for (const viewer of [{ isAdmin: true, mode: 'jwt' }, { mode: 'bearer_header' }, { mode: 'bearer_cookie' }]) {
      const r = report();
      expect(usageForViewer(r, viewer), JSON.stringify(viewer)).toBe(r);
    }
  });

  it('anyone else (a signed-in non-admin, no auth context) gets totals and models, no per-user parts', async () => {
    for (const viewer of [{ isAdmin: false, mode: 'jwt' }, undefined]) {
      const r = report();
      const out = usageForViewer(r, viewer);
      expect(out).toEqual({ ...r, byUser: {}, tokenRankings: [], costRankings: [] });
      expect(r.byUser).toHaveProperty('U1'); // the aggregator's report is not mutated
    }
  });
});

describe('/api/dashboard/usage — the route applies it', () => {
  let injectWebServer: any;
  let stopWebServer: any;

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    return { cookie: String(sso.headers['set-cookie']).split(';')[0] };
  }
  async function usage(headers: Record<string, string>) {
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/usage?period=month', headers });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  beforeEach(async () => {
    vi.resetModules();
    const now = Date.now();
    const ev = (id: string, userId: string, inputTokens: number, costUsd: number, model: string) => ({
      id,
      timestamp: now,
      eventType: 'token_usage',
      userId,
      userName: userId,
      metadata: { inputTokens, outputTokens: 10, costUsd, model },
    });
    mockReadRange.mockResolvedValue([
      ev('t1', 'U1', 1000, 0.5, 'claude-opus-5-5'),
      ev('t2', 'U2', 3000, 1.25, 'claude-haiku-4'),
    ]);
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    await import('../dashboard');
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  it('a non-admin: totals and spend by model, no byUser and no rankings', async () => {
    const body = await usage(await signIn('U1'));
    expect(body.totals.totalCostUsd).toBe(1.75);
    expect(Object.keys(body.totals.byModel).sort()).toEqual(['claude-haiku-4', 'claude-opus-5-5']);
    expect(body.byUser).toEqual({});
    expect(body.tokenRankings).toEqual([]);
    expect(body.costRankings).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/"userId":"U2"|"U2":/);
  });

  it('an admin and the operator token: byUser and the rankings', async () => {
    for (const headers of [await signIn('U_ADMIN'), { Authorization: 'Bearer test-token' }]) {
      const body = await usage(headers);
      expect(Object.keys(body.byUser).sort()).toEqual(['U1', 'U2']);
      expect(body.costRankings.map((r: { userId: string }) => r.userId)).toEqual(['U2', 'U1']);
    }
  });
});
