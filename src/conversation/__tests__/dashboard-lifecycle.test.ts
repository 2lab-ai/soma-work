/**
 * Dashboard ↔ session lifecycle policy: the board ships the policy to the
 * page, admins change it through PUT /api/dashboard/lifecycle, and the DONE
 * column lists archives for the policy's window instead of a fixed 48h.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    jwtSecret: 'test-jwt-secret',
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

const AUTH_HEADER = { Authorization: 'Bearer test-token' };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DEFAULTS = { sleepAfterMs: 24 * HOUR, archiveAfterMs: 7 * DAY, boardArchiveWindowMs: 48 * HOUR };

describe('Dashboard lifecycle policy API', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dir: string;
  let sessions: Map<string, any>;

  beforeEach(async () => {
    vi.resetModules();
    mockListRecent.mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-dash-lifecycle-'));
    const policy = await import('../../session-lifecycle-policy');
    policy.__resetSessionLifecyclePolicyForTests(path.join(dir, 'session-lifecycle.json'));
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    const dashboard = await import('../dashboard');
    sessions = new Map();
    dashboard.setDashboardSessionAccessor(() => sessions);
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the board response carries the lifecycle policy for the page', async () => {
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).lifecycle).toEqual(DEFAULTS);
  });

  it('the DONE column lists archives for the policy window', async () => {
    await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(mockListRecent).toHaveBeenLastCalledWith(48 * HOUR);

    const put = await injectWebServer({
      method: 'PUT',
      url: '/api/dashboard/lifecycle',
      headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
      payload: { boardArchiveWindowMs: 10 * DAY },
    });
    expect(put.statusCode).toBe(200);
    await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(mockListRecent).toHaveBeenLastCalledWith(10 * DAY);
  });

  it('an admin (viewer token) updates the policy; GET reads it back', async () => {
    const put = await injectWebServer({
      method: 'PUT',
      url: '/api/dashboard/lifecycle',
      headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
      payload: { sleepAfterMs: 6 * HOUR, archiveAfterMs: 3 * DAY },
    });
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body).lifecycle).toEqual({ ...DEFAULTS, sleepAfterMs: 6 * HOUR, archiveAfterMs: 3 * DAY });

    const get = await injectWebServer({ method: 'GET', url: '/api/dashboard/lifecycle', headers: AUTH_HEADER });
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body).lifecycle).toEqual({ ...DEFAULTS, sleepAfterMs: 6 * HOUR, archiveAfterMs: 3 * DAY });
  });

  it('a value out of bounds is a 400 naming the field, and nothing changes', async () => {
    const put = await injectWebServer({
      method: 'PUT',
      url: '/api/dashboard/lifecycle',
      headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
      payload: { sleepAfterMs: 60_000 },
    });
    expect(put.statusCode).toBe(400);
    expect(JSON.parse(put.body)).toMatchObject({ field: 'sleepAfterMs' });
    const get = await injectWebServer({ method: 'GET', url: '/api/dashboard/lifecycle', headers: AUTH_HEADER });
    expect(JSON.parse(get.body).lifecycle).toEqual(DEFAULTS);
  });

  it('anonymous callers cannot read or write it', async () => {
    expect((await injectWebServer({ method: 'GET', url: '/api/dashboard/lifecycle' })).statusCode).toBe(401);
    const put = await injectWebServer({
      method: 'PUT',
      url: '/api/dashboard/lifecycle',
      headers: { 'content-type': 'application/json' },
      payload: { sleepAfterMs: 6 * HOUR },
    });
    expect(put.statusCode).toBe(401);
  });

  it('a signed-in user who is not an admin gets 403', async () => {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId: 'U_PLAIN', email: 'plain@slack.local', name: 'Plain' });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const setCookie = sso.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
    const me = await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } });
    const { csrfToken, isAdmin } = JSON.parse(me.body);
    expect(isAdmin).toBe(false);

    const put = await injectWebServer({
      method: 'PUT',
      url: '/api/dashboard/lifecycle',
      headers: { cookie, 'x-csrf-token': csrfToken, 'x-admin-mode': 'on', 'content-type': 'application/json' },
      payload: { sleepAfterMs: 6 * HOUR },
    });
    expect(put.statusCode).toBe(403);
    expect(JSON.parse(put.body).error).toMatch(/admin/i);
    const get = await injectWebServer({ method: 'GET', url: '/api/dashboard/lifecycle', headers: { cookie } });
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body).lifecycle).toEqual(DEFAULTS);
  });

  it('a change that would sleep or end live sessions answers 409 with counts until confirmed', async () => {
    sessions.set('C1:t1', {
      sessionId: 's1',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      state: 'MAIN',
      activityState: 'idle',
      lastActivity: new Date(Date.now() - 5 * HOUR),
    });
    sessions.set('C1:t2', {
      sessionId: 's2',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't2',
      state: 'SLEEPING',
      activityState: 'idle',
      lastActivity: new Date(Date.now() - 4 * DAY),
      sleepStartedAt: new Date(Date.now() - 3 * DAY),
    });
    // INITIALIZING is swept like MAIN (anything not SLEEPING goes through the idle check), so it counts too.
    sessions.set('C1:t3', {
      sessionId: 's3',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't3',
      state: 'INITIALIZING',
      activityState: 'idle',
      lastActivity: new Date(Date.now() - 30 * HOUR),
    });
    const body = { sleepAfterMs: 2 * HOUR, archiveAfterMs: 2 * DAY };
    const headers = { ...AUTH_HEADER, 'content-type': 'application/json' };

    const first = await injectWebServer({ method: 'PUT', url: '/api/dashboard/lifecycle', headers, payload: body });
    expect(first.statusCode).toBe(409);
    // t1 (idle 5h) newly past 2h; t3 (idle 30h) was already past 24h and moves on the next sweep anyway.
    expect(JSON.parse(first.body)).toEqual({ needsConfirm: true, willSleep: 1, willArchive: 1 });
    const unchanged = await injectWebServer({ method: 'GET', url: '/api/dashboard/lifecycle', headers: AUTH_HEADER });
    expect(JSON.parse(unchanged.body).lifecycle).toEqual(DEFAULTS);

    const confirmed = await injectWebServer({
      method: 'PUT',
      url: '/api/dashboard/lifecycle?confirm=1',
      headers,
      payload: body,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(JSON.parse(confirmed.body).lifecycle).toEqual({ ...DEFAULTS, ...body });
  });

  it('an unreadable saved policy is flagged degraded to the page', async () => {
    fs.writeFileSync(path.join(dir, 'session-lifecycle.json'), '{ broken');
    fs.writeFileSync(path.join(dir, 'session-lifecycle.json.bak'), '{ broken');
    const policy = await import('../../session-lifecycle-policy');
    policy.__resetSessionLifecyclePolicyForTests(path.join(dir, 'session-lifecycle.json'));
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(JSON.parse(res.body).lifecycle).toEqual({ ...DEFAULTS, degraded: true });
  });
});
