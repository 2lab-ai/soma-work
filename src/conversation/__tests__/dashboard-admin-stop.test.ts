import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPublicChannel } from '../__fixtures__/public-channel';

/**
 * Z 2026-11-23: "내가 어드민인데 … 내가 왜 중지 못함? … 어드민이면 다른 사람 작업 중지할수 있게 픽스해"
 *
 * Server half of the admin stop: `POST /api/dashboard/session/:key/stop` lets every admin signed in with Slack stop
 * anyone's task — 관리자 모드 on or not. The stop is the emergency brake (it cuts the running turn and leaves the task
 * resumable); every other manage action keeps the #716 rule (owner, or an admin in 관리자 모드).
 *
 *   S1  the owner stops their own task
 *   S2  an admin stops someone else's task without 관리자 모드 (was 403)
 *   S3  an admin in 관리자 모드 still stops it
 *   S4  any other signed-in user may not (403) — nothing is stopped
 *   S5  close stays the #716 rule: an admin without 관리자 모드 may not close someone else's task
 *   S6  an admin's stop on someone else's task whose goal runs is asked first, like the owner's (409 with the goal)
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

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U_OWNER',
    channelId: 'C1',
    threadTs: 't1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'working',
    state: 'MAIN',
    lastActivity: new Date('2026-11-23T00:00:00Z'),
    ...overrides,
  };
}

describe('Dashboard — an admin stops anyone’s task (Z 2026-11-23)', () => {
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;
  let session: Record<string, any>;
  let stopHandler: ReturnType<typeof vi.fn>;
  let closeHandler: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    await webServer.startWebServer({ listen: false });
    // #1315 — other signed-in users read this task: its channel is a public one.
    await registerPublicChannel('C1');
    session = liveSession();
    dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', session]]));
    stopHandler = vi.fn().mockResolvedValue(undefined);
    closeHandler = vi.fn().mockResolvedValue(undefined);
    dashboard.setDashboardStopHandler(stopHandler);
    dashboard.setDashboardCloseHandler(closeHandler);
  });

  afterEach(async () => {
    await stopWebServer();
  });

  /** A signed-in Slack user: SSO cookie + CSRF token from /auth/me. */
  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string };
  }

  async function act(action: 'stop' | 'close', headers: Record<string, string>, payload?: unknown) {
    return injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent('C1:t1')}/${action}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  it('S1 the owner stops their own task', async () => {
    const res = await act('stop', await signIn('U_OWNER'));
    expect(res.statusCode).toBe(200);
    expect(stopHandler).toHaveBeenCalledWith('C1:t1');
  });

  it('S2 an admin stops someone else’s task without 관리자 모드', async () => {
    const res = await act('stop', await signIn('U_ADMIN'));
    expect(res.statusCode).toBe(200);
    expect(stopHandler).toHaveBeenCalledWith('C1:t1');
  });

  it('S3 an admin in 관리자 모드 still stops it', async () => {
    const res = await act('stop', { ...(await signIn('U_ADMIN')), 'x-admin-mode': 'on' });
    expect(res.statusCode).toBe(200);
    expect(stopHandler).toHaveBeenCalledTimes(1);
  });

  it('S4 any other signed-in user may not — nothing is stopped', async () => {
    const res = await act('stop', await signIn('U_OTHER'));
    expect(res.statusCode).toBe(403);
    expect(stopHandler).not.toHaveBeenCalled();
    // A non-admin shipping 관리자 모드 proves nothing.
    expect((await act('stop', { ...(await signIn('U_OTHER')), 'x-admin-mode': 'on' })).statusCode).toBe(403);
    expect(stopHandler).not.toHaveBeenCalled();
  });

  it('S5 close keeps the #716 rule: an admin needs 관리자 모드 to close someone else’s task', async () => {
    const admin = await signIn('U_ADMIN');
    expect((await act('close', admin)).statusCode).toBe(403);
    expect(closeHandler).not.toHaveBeenCalled();
    expect((await act('close', { ...admin, 'x-admin-mode': 'on' })).statusCode).toBe(200);
    expect(closeHandler).toHaveBeenCalledTimes(1);
  });

  it('S6 a running goal is asked first for an admin too, and the yes pauses it and stops', async () => {
    session.goal = { goalId: 'g1', objective: 'PR 리뷰', status: 'active' };
    const admin = await signIn('U_ADMIN');
    const asked = await act('stop', admin);
    expect(asked.statusCode).toBe(409);
    expect(JSON.parse(asked.body).goal).toMatchObject({ goalId: 'g1' });
    expect(stopHandler).not.toHaveBeenCalled();
    const res = await act('stop', { ...admin, 'content-type': 'application/json' }, { pauseGoalId: 'g1' });
    expect(res.statusCode).toBe(200);
    expect(stopHandler).toHaveBeenCalledWith('C1:t1', { pauseGoalId: 'g1' });
  });
});
