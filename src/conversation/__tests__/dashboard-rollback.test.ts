/**
 * #744 — the dashboard's context rollback routes: GET …/rollback-points and
 * POST …/rollback (request or cancel), behind the owner gate, answered by the
 * host handler (SlackHandler in production).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    conversationId: 'conv1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    activityState: 'idle',
    state: 'MAIN',
    lastActivity: new Date('2026-11-02T00:00:00Z'),
    ...overrides,
  };
}

describe('Dashboard — context rollback routes (#744)', () => {
  let web: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    await web.startWebServer({ listen: false });
  });
  afterEach(async () => {
    dashboard.setDashboardRollbackHandler(null);
    await web.stopWebServer();
  });

  it('GET rollback-points answers the host view', async () => {
    dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', liveSession()]]));
    const points = vi.fn(async () => ({ inputs: [{ anchor: 'a', label: 'l', at: 1 }], worklog: [] }));
    dashboard.setDashboardRollbackHandler({ points, request: vi.fn() });
    const res = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/${encodeURIComponent('C1:t1')}/rollback-points`,
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).inputs[0].anchor).toBe('a');
    expect(points).toHaveBeenCalledWith('C1:t1', undefined);
  });

  it('POST rollback passes the point; a refusal answers its status and words', async () => {
    dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', liveSession()]]));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: 'busy' })
      .mockResolvedValueOnce({ ok: true, cancelled: true });
    dashboard.setDashboardRollbackHandler({ points: vi.fn(), request });
    const post = (payload: unknown) =>
      web.injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent('C1:t1')}/rollback`,
        headers: AUTH_HEADER,
        payload,
      });

    const ok = await post({ anchor: 'sid1~0~u', label: '입력 직전: x', source: 'input', at: 50 });
    expect(ok.statusCode).toBe(200);
    expect(request).toHaveBeenNthCalledWith(
      1,
      'C1:t1',
      { anchor: 'sid1~0~u', label: '입력 직전: x', source: 'input', at: 50 },
      undefined,
    );

    const busy = await post({ anchor: 'sid1~0~u', label: 'x', source: 'worklog' });
    expect(busy.statusCode).toBe(409);
    expect(JSON.parse(busy.body).error).toContain('진행 중');

    const cancel = await post({ cancel: true });
    expect(cancel.statusCode).toBe(200);
    expect(request).toHaveBeenNthCalledWith(3, 'C1:t1', { cancel: true }, undefined);
  });

  it('rejects a malformed body before the handler', async () => {
    dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', liveSession()]]));
    const request = vi.fn();
    dashboard.setDashboardRollbackHandler({ points: vi.fn(), request });
    const res = await web.injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent('C1:t1')}/rollback`,
      headers: AUTH_HEADER,
      payload: { anchor: 'x', source: 'elsewhere' },
    });
    expect(res.statusCode).toBe(400);
    const badAt = await web.injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent('C1:t1')}/rollback`,
      headers: AUTH_HEADER,
      payload: { anchor: 'sid1~0~u', label: 'x', source: 'input', at: 'yesterday' },
    });
    expect(badAt.statusCode).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it('the card says a rollback is possible and shows a waiting one', async () => {
    dashboard.setDashboardSessionAccessor(
      () =>
        new Map([
          [
            'C1:t1',
            liveSession({
              pendingRewind: {
                anchor: 'a',
                label: '입력 직전: 배포',
                requestedAt: 9,
                requestedBy: 'U1',
                source: 'input',
              },
            }),
          ],
        ]),
    );
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    const board = JSON.parse(res.body).board;
    const all = Object.values(board).flat() as any[];
    const card = all.find((c: any) => c && c.key === 'C1:t1');
    expect(card.rollbackAvailable).toBe(true);
    expect(card.pendingRewind).toEqual({ label: '입력 직전: 배포', requestedAt: 9 });
  });

  it('the card carries what earlier rollbacks dropped, for the log and the conversation marks', async () => {
    dashboard.setDashboardSessionAccessor(
      () =>
        new Map([['C1:t1', liveSession({ contextRewinds: [{ from: 10, to: 20, label: '입력 직전: 배포', at: 21 }] })]]),
    );
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    const all = Object.values(JSON.parse(res.body).board).flat() as any[];
    const card = all.find((c: any) => c && c.key === 'C1:t1');
    expect(card.contextRewinds).toEqual([{ from: 10, to: 20, label: '입력 직전: 배포', at: 21 }]);
  });
});
