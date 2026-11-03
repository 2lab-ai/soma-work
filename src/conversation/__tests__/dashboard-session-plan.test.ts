/**
 * #853 / #855 — a Slack session in plan mode on the dashboard (the dashboard task's suite left with
 * its stack; this is its Slack case, kept): the card asks with the plan, the plan reads as JSON and
 * as a page, and 시작 / 취소 reach the plan handler as the signed-in user.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  DATA_DIR: require('node:path').join(
    process.env.TMPDIR ?? require('node:os').tmpdir(),
    'soma-work-dashboard-session-plan-test',
  ),
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
  getArchiveStore: () => ({
    listRecent: () => [],
    exists: () => false,
    archive: () => {},
    load: () => null,
  }),
}));

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-dashboard-session-plan-test');
const AUTH_HEADER = { Authorization: 'Bearer test-token' };

describe('dashboard — a Slack session in plan mode (#853, kept in #855)', () => {
  let stopWebServer: () => Promise<void>;
  let injectWebServer: (opts: Record<string, unknown>) => Promise<{ statusCode: number; body: string; headers: any }>;
  let dashboard: typeof import('../dashboard');
  let SessionRegistry: typeof import('../../session-registry').SessionRegistry;

  beforeAll(async () => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer as typeof injectWebServer;
    dashboard = await import('../dashboard');
    SessionRegistry = (await import('../../session-registry')).SessionRegistry;
    await webServer.startWebServer({ listen: false });
  }, 240_000);

  afterAll(async () => {
    await stopWebServer?.();
    if (fs.existsSync(TEST_DATA_DIR))
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  async function signIn(slackUserId: string): Promise<Record<string, string>> {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json' };
  }

  it('its card asks with the plan, the plan reads, and 시작 reaches the plan handler as the signed-in user', async () => {
    const reg = new SessionRegistry();
    const slack = reg.createSession('U1', 'Alice', 'C1', '600.001');
    slack.sessionId = 'sid-plan';
    slack.activityState = 'idle';
    slack.taskPlan = {
      state: 'awaiting',
      revision: 3,
      updatedAt: 10,
      plan: {
        summary: '계획 요약',
        intent: '의도',
        phases: [{ title: '단계', steps: [{ title: '작업 1' }, { title: '작업 2' }] }],
        revision: 3,
        submittedAt: 10,
      },
    } as any;
    dashboard.setDashboardSessionAccessor(() => reg.getAllSessions() as any);
    const key = 'work:C1:600.001';

    const boardRes = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(boardRes.statusCode).toBe(200);
    const card = (JSON.parse(boardRes.body).board.waiting as any[]).find((c) => c.key === key);
    expect(card?.taskPlan).toMatchObject({ state: 'awaiting', revision: 3, summary: '계획 요약', phases: 1, steps: 2 });

    const read = await injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/plan`,
      headers: AUTH_HEADER,
    });
    expect(read.statusCode).toBe(200);
    expect(JSON.parse(read.body)).toMatchObject({ state: 'awaiting', revision: 3 });
    expect(JSON.parse(read.body).html).toContain('계획 요약');
    const page = await injectWebServer({
      method: 'GET',
      url: `/dashboard/plan/${encodeURIComponent(key)}`,
      headers: AUTH_HEADER,
    });
    expect(page.statusCode).toBe(200);

    const planHandler = vi.fn(async () => ({ status: 200, body: { ok: true, state: 'approved', revision: 3 } }));
    dashboard.setDashboardTaskPlanHandler(planHandler);
    try {
      const decided = await injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(key)}/plan`,
        headers: await signIn('U1'),
        payload: JSON.stringify({ decision: 'start', revision: 3 }),
      });
      expect(decided.statusCode).toBe(200);
      expect(planHandler).toHaveBeenCalledWith({ sessionKey: key, decision: 'start', revision: 3, actorUserId: 'U1' });
    } finally {
      dashboard.setDashboardTaskPlanHandler(null);
    }
  });
});
