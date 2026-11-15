/**
 * 사용자 할 일 (instruct_user) on the board: GET /api/dashboard/sessions carries a session's user actions — what, where,
 * the script and the host's check — on its card, so the detail card draws them in their own section. The Slack ts
 * stays server-side; a session without any gets no field.
 */
import * as fs from 'node:fs';
import { inspectUserActionScript } from 'somalib/user-action/user-action';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/dash-user-actions-data-') };
});
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

const AUTH = { Authorization: 'Bearer test-token' };

afterAll(async () => {
  const { DATA_DIR } = await import('../../env-paths');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('dashboard — user actions on the board', () => {
  let web: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await web.stopWebServer();
  });

  it('a session with a user action carries it (without the Slack ts); one without carries nothing', async () => {
    const script = "open 'https://example.com/verify'";
    const action = {
      id: 'ua_1',
      title: '인증 페이지 열기',
      host: 'owner-mac',
      why: '소유자 본인만 할 수 있다.',
      script,
      shell: 'bash',
      expect: '페이지가 열린다',
      effects: '페이지를 연다.',
      optional: false,
      createdAt: 1,
      status: 'pending',
      slackTs: '111.222',
      inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
    };
    const base = {
      ownerId: 'U1',
      ownerName: 'A',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date('2026-11-14T00:00:00Z'),
    };
    const sessions = new Map<string, any>([
      ['C1:t1', { ...base, sessionId: 's1', title: 'With', channelId: 'C1', threadTs: 't1', userActions: [action] }],
      ['C2:t2', { ...base, sessionId: 's2', title: 'Without', channelId: 'C2', threadTs: 't2' }],
    ]);
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH });
    const cards = JSON.parse(res.body).board.working;
    const withIt = cards.find((c: any) => c.title === 'With');
    expect(withIt.userActions).toHaveLength(1);
    expect(withIt.userActions[0]).toMatchObject({ id: 'ua_1', host: 'owner-mac', script, status: 'pending' });
    expect(withIt.userActions[0].inspection.syntax).toEqual({ checked: true, ok: true, tool: 'bash -n' });
    expect(withIt.userActions[0]).not.toHaveProperty('slackTs');
    expect(cards.find((c: any) => c.title === 'Without').userActions).toBeUndefined();
  });

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: 'N' });
    const sso = await web.injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const setCookie = sso.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
    const me = await web.injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } });
    return { cookie, 'x-csrf-token': JSON.parse(me.body).csrfToken as string, 'content-type': 'application/json' };
  }

  it('POST …/user-action answers through the handler as the signed-in user; a bad body is refused', async () => {
    const key = 'work:C1:500.001';
    dashboard.setDashboardSessionAccessor(
      () => new Map([[key, { ownerId: 'U_OWNER', channelId: 'C1', threadTs: '500.001', sessionId: 's1' }]]),
    );
    const handler = vi.fn(async () => ({ status: 200, body: { ok: true, status: 'done' } }));
    dashboard.setDashboardUserActionHandler(handler);
    const headers = await signIn('U_OWNER');
    const url = `/api/dashboard/session/${encodeURIComponent(key)}/user-action`;
    const ok = await web.injectWebServer({ method: 'POST', url, headers, payload: { id: 'ua_1', status: 'done' } });
    expect(ok.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledWith({ sessionKey: key, id: 'ua_1', status: 'done', actorUserId: 'U_OWNER' });
    const bad = await web.injectWebServer({ method: 'POST', url, headers, payload: { id: 'ua_1', status: 'maybe' } });
    expect(bad.statusCode).toBe(400);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // The route lets every signed-in user through to the handler, as an instruction does (SSOT 2026-11-02); the
  // handler's gate (answerUserAction → InstructionApprovals.allows) refuses a stranger, and its status is the answer.
  it('POST …/user-action carries a stranger to the handler as themselves and answers with its refusal', async () => {
    const key = 'work:C1:500.002';
    dashboard.setDashboardSessionAccessor(
      () => new Map([[key, { ownerId: 'U_OWNER', channelId: 'C1', threadTs: '500.002', sessionId: 's2' }]]),
    );
    const handler = vi.fn(async () => ({ status: 403, body: { ok: false, error: 'forbidden' } }));
    dashboard.setDashboardUserActionHandler(handler);
    const headers = await signIn('U_STRANGER');
    const res = await web.injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/user-action`,
      headers,
      payload: { id: 'ua_1', status: 'done' },
    });
    expect(res.statusCode).toBe(403);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'U_STRANGER' }));
  });
});
