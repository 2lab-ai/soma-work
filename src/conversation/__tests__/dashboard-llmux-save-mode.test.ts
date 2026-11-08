/**
 * llmux save mode from the dashboard top bar: an admin turns it on with a
 * cutoff, or off, through PUT /api/dashboard/llmux-save-mode; the capacity
 * view carries the mode llmux reports so the bar can show it.
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
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [] }),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };
const URL = '/api/dashboard/llmux-save-mode';
const NOW_S = Math.floor(Date.now() / 1000);
const UNTIL = NOW_S + 3 * 86400;

function statusWith(saveMode: unknown) {
  return {
    current: 'ai7',
    ...(saveMode === undefined ? {} : { save_mode: saveMode }),
    accounts: [
      {
        name: 'ai7',
        type: 'oauth',
        group: 'claude',
        status: 'ok',
        order: 1,
        five_hour: { utilization: 0.5, resets_at: NOW_S + 3600, resets_in_secs: 3600 },
        seven_day: { utilization: 0.1, resets_at: NOW_S + 86400, resets_in_secs: 86400 },
      },
      {
        name: 'ai8',
        type: 'oauth',
        group: 'claude',
        status: 'ok',
        order: 2,
        blocked: 'saved · 7d resets in 4d4h',
        five_hour: { utilization: 0.1, resets_at: NOW_S + 3600, resets_in_secs: 3600 },
        seven_day: { utilization: 0.1, resets_at: NOW_S + 86400 * 4, resets_in_secs: 86400 * 4 },
      },
    ],
  };
}

describe('Dashboard — llmux save mode', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let llmuxMode: { until: number | null; active: boolean; held: number };
  let setSaveMode: ReturnType<typeof vi.fn>;
  let fetchStatus: ReturnType<typeof vi.fn>;
  let enabled: { ok: true } | { ok: false; reason: string };

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    llmuxMode = { until: null, active: false, held: 0 };
    enabled = { ok: true };
    fetchStatus = vi.fn(async () => statusWith(llmuxMode));
    setSaveMode = vi.fn(async (until: number | null) => {
      llmuxMode = { until, active: until !== null, held: until !== null ? 1 : 0 };
      return { ok: true, save_mode: llmuxMode };
    });
    dashboard.setCapacitySource({
      enabled: () => enabled,
      fetchStatus,
      tiers: () => ({}),
      setSaveMode,
    });
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    dashboard.setCapacitySource(null);
    await stopWebServer();
  });

  function put(payload: unknown, headers: Record<string, string> = AUTH_HEADER) {
    return injectWebServer({
      method: 'PUT',
      url: URL,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: payload as object,
    });
  }

  it('the capacity view carries the mode llmux reports and labels its held accounts', async () => {
    llmuxMode = { until: UNTIL, active: true, held: 1 };
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/capacity', headers: AUTH_HEADER });
    const { capacity } = JSON.parse(res.body);
    expect(capacity.saveMode).toEqual({ until: UNTIL, active: true, held: 1 });
    const held = capacity.groups[0].units.find((u: any) => u.name === 'ai8');
    expect(held).toMatchObject({ excluded: 'held', held: 'saved' });
  });

  it('an older llmux without save mode: no saveMode in the view', async () => {
    fetchStatus.mockImplementation(async () => statusWith(undefined));
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/capacity', headers: AUTH_HEADER });
    expect(JSON.parse(res.body).capacity.saveMode).toBeUndefined();
  });

  it('an admin turns it on with a cutoff; the answer is the fresh view, not the cached one', async () => {
    await injectWebServer({ method: 'GET', url: '/api/dashboard/capacity', headers: AUTH_HEADER });
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    const res = await put({ until: UNTIL });
    expect(res.statusCode).toBe(200);
    expect(setSaveMode).toHaveBeenCalledWith(UNTIL);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body).capacity.saveMode).toEqual({ until: UNTIL, active: true, held: 1 });
  });

  it('null turns it off', async () => {
    llmuxMode = { until: UNTIL, active: true, held: 1 };
    const res = await put({ until: null });
    expect(res.statusCode).toBe(200);
    expect(setSaveMode).toHaveBeenCalledWith(null);
    expect(JSON.parse(res.body).capacity.saveMode).toEqual({ until: null, active: false, held: 0 });
  });

  it('a cutoff that is not whole epoch seconds is a 400 and llmux is not called', async () => {
    for (const until of ['tomorrow', -5, 1.5, 0, undefined]) {
      const res = await put(until === undefined ? {} : { until });
      expect(res.statusCode, String(until)).toBe(400);
    }
    expect(setSaveMode).not.toHaveBeenCalled();
  });

  it("llmux's own refusal comes back as a 400 with its reason", async () => {
    const { LlmuxClientError } = await import('../../auth/llmux-client');
    setSaveMode.mockRejectedValueOnce(
      new LlmuxClientError('llmux POST /llmux/save-mode → 400: until must be in the future', 400),
    );
    const res = await put({ until: UNTIL });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('until must be in the future');
  });

  it('llmux unreachable is a 502 with a fixed reason (no host or URL)', async () => {
    setSaveMode.mockRejectedValueOnce(new Error('llmux unreachable at http://10.0.0.5:3456 (ECONNREFUSED)'));
    const res = await put({ until: UNTIL });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toBe('llmux unreachable');
  });

  it('not running on llmux: 409 and llmux is not called', async () => {
    enabled = { ok: false, reason: 'auth mode is ccp — llmux not in use' };
    const res = await put({ until: UNTIL });
    expect(res.statusCode).toBe(409);
    expect(setSaveMode).not.toHaveBeenCalled();
  });

  it('anonymous callers get 401', async () => {
    const res = await put({ until: UNTIL }, {});
    expect(res.statusCode).toBe(401);
    expect(setSaveMode).not.toHaveBeenCalled();
  });

  it('a signed-in user who is not an admin gets 403, admin mode header or not', async () => {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId: 'U_PLAIN', email: 'plain@slack.local', name: 'Plain' });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const setCookie = sso.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
    const me = await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } });
    const { csrfToken } = JSON.parse(me.body);
    const res = await put({ until: UNTIL }, { cookie, 'x-csrf-token': csrfToken, 'x-admin-mode': 'on' });
    expect(res.statusCode).toBe(403);
    expect(setSaveMode).not.toHaveBeenCalled();
  });
});
