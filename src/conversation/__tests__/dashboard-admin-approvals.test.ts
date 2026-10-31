/**
 * #620 (SSOT T3/T4/T5) — "dashboard에 로그인중인 어드민에게 실시간으로 웹소켓으로 approval 카드
 * 표시하고 … 승인 처리 같은 방식으로 슬랙 dm과 동기화 처리".
 *
 * The server half: admins read the requests (REST on load and reconnect) and get
 * them pushed over the WebSocket — non-admins get neither; an admin with admin
 * mode on answers, through the same registry path every kind's Slack button
 * shares. The client half: the shipped functions that turn a request into an
 * approval card, toast an arrival, answer, and show who answered elsewhere.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}

const FNS = [
  'toNum',
  'adminInboxLoad',
  'adminUserName',
  'adminApprovalTitle',
  'adminApprovalLock',
  'adminResolutionOf',
  'adminResolvedState',
  'adminApprovalData',
  'applyAdminApprovals',
  'paintAdminInboxButton',
  'adminInboxAnnounce',
  'acPost',
  'acRefusal',
  'answerAdminApproval',
] as const;

function loadClient(inject: Record<string, unknown>) {
  const names = Object.keys(inject);
  const body = `${clientVar('ADMIN_KIND_LABEL')}
var _adminApprovals = { pending: [], resolved: [] };
var _adminKnown = null;
var _adminLast = Object.create(null);
var _adminKeep = Object.create(null);
var _adminState = Object.create(null);
var _adminInboxOpen = false;
var _adminPushSeq = 0;
${FNS.map(clientFn).join('\n')}
return { ${FNS.join(', ')}, pushed: function() { _adminPushSeq++; }, state: function() { return { _adminState: _adminState, _adminApprovals: _adminApprovals }; } };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as any;
}

const ENV_REQUEST = {
  id: 'env_skill:req-1',
  kind: 'env_skill',
  card: 'question',
  title: '환경 스킬 `acme-env:post-deploy` 실행 요청',
  description: '허용하면 요청한 턴을 다시 보내 이어서 실행합니다.',
  choices: [
    { id: 'env_skill_once', label: '✅ 1회 허용 (이 스레드)' },
    { id: 'env_skill_deny', label: '❌ 거부' },
  ],
  recommendedId: 'env_skill_once',
  requesterId: 'U1',
  place: { channel: 'C1', threadTs: '171.1' },
  createdAt: 1_700_000_000_000,
};

describe('dashboard admin approvals (#620)', () => {
  let injectWebServer: any;
  let injectWebServerWS: any;
  let stopWebServer: any;
  let dashboard: any;
  let registry: typeof import('../../admin-approvals');
  let issueSlackToken: typeof import('../oauth').issueSlackToken;
  let pending: any[];
  let resolved: any[];
  let answer: ReturnType<typeof vi.fn>;
  const sockets: any[] = [];

  beforeAll(async () => {
    process.env.ADMIN_USERS = 'UADMIN';
    vi.resetModules();
    (await import('../../admin-utils')).resetAdminUsersCache();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    injectWebServerWS = webServer.injectWebServerWS;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    registry = await import('../../admin-approvals');
    ({ issueSlackToken } = await import('../oauth'));
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterAll(async () => {
    delete process.env.ADMIN_USERS;
    await stopWebServer();
  });

  beforeEach(() => {
    pending = [ENV_REQUEST];
    resolved = [];
    answer = vi.fn(async () => {
      pending = [];
      resolved = [
        {
          id: 'env_skill:req-1',
          outcome: 'approved',
          choiceId: 'env_skill_once',
          by: 'UADMIN',
          via: 'dashboard',
          at: 5,
        },
      ];
      return { ok: true, outcome: 'approved' };
    });
    registry.clearAdminApprovalAdapters();
    registry.registerAdminApprovalAdapter({
      kind: 'env_skill',
      pending: () => pending,
      resolved: () => resolved,
      answer: answer as any,
    });
    dashboard.setDashboardSessionAccessor(() => new Map());
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate?.();
  });

  async function signIn(userId: string) {
    const token = issueSlackToken({ slackUserId: userId, email: `${userId}@slack.local`, name: userId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, csrf: me.csrfToken as string };
  }

  function post(who: { cookie: string; csrf: string }, body: unknown, adminMode = 'on') {
    return injectWebServer({
      method: 'POST',
      url: '/api/dashboard/admin-approvals/answer',
      headers: {
        cookie: who.cookie,
        'x-csrf-token': who.csrf,
        'x-admin-mode': adminMode,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(body),
    });
  }

  it('T3 — an admin reads the pending requests; a non-admin is refused', async () => {
    const admin = await signIn('UADMIN');
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/admin-approvals',
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body).pending.map((a: any) => a.id)).toEqual(['env_skill:req-1']);
    const user = await signIn('U2');
    const denied = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/admin-approvals',
      headers: { cookie: user.cookie },
    });
    expect(denied.statusCode).toBe(403);
    // A viewer token is "admin" for the board, but names nobody: the requests stay hidden.
    const bearer = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/admin-approvals',
      headers: { authorization: 'Bearer test-token' },
    });
    expect(bearer.statusCode).toBe(403);
  });

  it('T5 — an admin in admin mode answers through the registry (the Slack button path)', async () => {
    const admin = await signIn('UADMIN');
    const res = await post(admin, { id: 'env_skill:req-1', choiceId: 'env_skill_once' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, outcome: 'approved' });
    expect(answer).toHaveBeenCalledWith('req-1', 'env_skill_once', 'UADMIN');
  });

  it('refuses admin mode off, a non-admin, and a bad body — nothing is answered', async () => {
    const admin = await signIn('UADMIN');
    expect((await post(admin, { id: 'env_skill:req-1', choiceId: 'env_skill_once' }, 'off')).statusCode).toBe(403);
    const user = await signIn('U2');
    expect((await post(user, { id: 'env_skill:req-1', choiceId: 'env_skill_once' })).statusCode).toBe(403);
    expect((await post(admin, { id: 'env_skill:req-1' })).statusCode).toBe(400);
    expect(answer).not.toHaveBeenCalled();
  });

  it('reads and answers share one gate — a Slack-signed-in ADMIN_USERS admin (isSlackAdmin)', () => {
    const route = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf("'/api/dashboard/admin-approvals/answer'"));
    expect(route.slice(0, route.indexOf('stripSelfInstancePrefix'))).toContain('!isSlackAdmin(auth)');
    const read = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf("server.get('/api/dashboard/admin-approvals'"));
    expect(read.slice(0, 400)).toContain('isSlackAdmin(');
  });

  it('an adapter that refuses the actor is a 403, not a bad request', async () => {
    answer.mockImplementationOnce(async () => ({ ok: false, reason: 'forbidden' }));
    const admin = await signIn('UADMIN');
    expect((await post(admin, { id: 'env_skill:req-1', choiceId: 'env_skill_once' })).statusCode).toBe(403);
  });

  it('T5 — answered in Slack first: 409 with who answered and how', async () => {
    answer.mockImplementationOnce(async () => ({ ok: false, reason: 'already_answered' }));
    resolved = [
      { id: 'env_skill:req-1', outcome: 'denied', choiceId: 'env_skill_deny', by: 'UOTHER', via: 'slack', at: 7 },
    ];
    const admin = await signIn('UADMIN');
    const res = await post(admin, { id: 'env_skill:req-1', choiceId: 'env_skill_once' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).resolution).toMatchObject({ outcome: 'denied', by: 'UOTHER', via: 'slack' });
  });

  it('a socket stops at the end of the sign-in it was opened with (JWT expiry)', async () => {
    const saved = mockConfig.oauth.jwtExpiresIn;
    mockConfig.oauth.jwtExpiresIn = 1;
    try {
      const admin = await signIn('UADMIN');
      const deadline = dashboard.wsAuthDeadline('oauth_jwt', admin.cookie);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 1_000);
      const msgs: any[] = [];
      sockets.push(
        await injectWebServerWS('/ws/dashboard', { headers: { cookie: admin.cookie } }, (s: any) =>
          s.on('message', (d: any) => msgs.push(JSON.parse(d.toString()))),
        ),
      );
      await dashboard.broadcastAdminApprovals();
      await vi.waitFor(() => expect(msgs.some((m) => m.type === 'admin_approvals')).toBe(true));
      // Past the token's expiry the server has dropped (and closed) the socket: nothing more reaches it.
      await new Promise((r) => setTimeout(r, Math.max(deadline - Date.now(), 0) + 150));
      const before = msgs.length;
      await dashboard.broadcastAdminApprovals();
      await new Promise((r) => setTimeout(r, 50));
      expect(msgs.length).toBe(before);
    } finally {
      mockConfig.oauth.jwtExpiresIn = saved;
    }
  });

  it('only a session JWT expires a socket: a viewer token or no auth has no deadline', () => {
    expect(dashboard.wsAuthDeadline('bearer_header', undefined)).toBeUndefined();
    expect(dashboard.wsAuthDeadline('none', undefined)).toBeUndefined();
    // An unreadable session cookie is already over.
    expect(dashboard.wsAuthDeadline('oauth_jwt', 'soma_dash_token=garbage')).toBeLessThanOrEqual(Date.now());
  });

  it('T4 — the WebSocket pushes the requests to Slack-signed-in admins only, live on a change', async () => {
    const adminMsgs: any[] = [];
    const userMsgs: any[] = [];
    const bearerMsgs: any[] = [];
    const admin = await signIn('UADMIN');
    sockets.push(
      await injectWebServerWS('/ws/dashboard', { headers: { cookie: admin.cookie } }, (s: any) =>
        s.on('message', (d: any) => adminMsgs.push(JSON.parse(d.toString()))),
      ),
    );
    // A viewer token reads as admin elsewhere, but carries no identity.
    sockets.push(
      await injectWebServerWS('/ws/dashboard', { headers: { authorization: 'Bearer test-token' } }, (s: any) =>
        s.on('message', (d: any) => bearerMsgs.push(JSON.parse(d.toString()))),
      ),
    );
    const user = await signIn('U2');
    sockets.push(
      await injectWebServerWS('/ws/dashboard', { headers: { cookie: user.cookie } }, (s: any) =>
        s.on('message', (d: any) => userMsgs.push(JSON.parse(d.toString()))),
      ),
    );
    dashboard.broadcastAdminApprovals();
    await vi.waitFor(() => expect(adminMsgs.some((m) => m.type === 'admin_approvals')).toBe(true));
    const pushed = adminMsgs.find((m) => m.type === 'admin_approvals');
    expect(pushed.snapshot.pending.map((a: any) => a.id)).toEqual(['env_skill:req-1']);
    // An answer (here or in Slack — the store watch) pushes again.
    await post(admin, { id: 'env_skill:req-1', choiceId: 'env_skill_once' });
    await vi.waitFor(() => {
      const all = adminMsgs.filter((m) => m.type === 'admin_approvals');
      const last = all[all.length - 1];
      expect(last.snapshot.pending).toEqual([]);
      expect(last.snapshot.resolved[0]).toMatchObject({ id: 'env_skill:req-1', via: 'dashboard' });
    });
    expect(userMsgs.some((m) => m.type === 'admin_approvals')).toBe(false);
    expect(bearerMsgs.some((m) => m.type === 'admin_approvals')).toBe(false);
  });

  it('two pushes racing: a slower, older snapshot never lands after a newer one', async () => {
    const msgs: any[] = [];
    const admin = await signIn('UADMIN');
    sockets.push(
      await injectWebServerWS('/ws/dashboard', { headers: { cookie: admin.cookie } }, (s: any) =>
        s.on('message', (d: any) => msgs.push(JSON.parse(d.toString()))),
      ),
    );
    let calls = 0;
    registry.clearAdminApprovalAdapters();
    registry.registerAdminApprovalAdapter({
      kind: 'env_skill',
      // The first (older) read is slow and still sees the request; the second (newer) sees it answered.
      pending: () =>
        ++calls === 1 ? new Promise((r) => setTimeout(() => r([ENV_REQUEST as any]), 80)) : Promise.resolve([]),
      resolved: () => [],
      answer: answer as any,
    });
    const older = dashboard.broadcastAdminApprovals();
    const newer = dashboard.broadcastAdminApprovals();
    await Promise.all([older, newer]);
    await new Promise((r) => setTimeout(r, 30));
    const pushed = msgs.filter((m) => m.type === 'admin_approvals');
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[pushed.length - 1].snapshot.pending).toEqual([]);
  });

  describe('shipped client', () => {
    function client(over: Record<string, unknown> = {}) {
      const toasts: any[] = [];
      const c = loadClient({
        document: { getElementById: () => null },
        _sessionCache: {
          'C1:t1': { ownerId: 'U1', ownerName: '김민수' },
          'C2:t1': { ownerId: 'UOTHER', ownerName: '박지은' },
        },
        _viewerUserId: 'UADMIN',
        _viewerIsAdmin: true,
        _isAdminModeOn: () => true,
        dashToast: (t: any, fn?: () => void) => toasts.push({ t, fn }),
        paintAdminInbox: () => {},
        console: { error() {} },
        _csrfToken: 'x',
        refreshCsrfToken: async () => {},
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
        ...over,
      });
      return { c, toasts };
    }

    it('a request becomes an approval card with the DM choices and who asked', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [ENV_REQUEST], resolved: [] });
      const d = c.adminApprovalData('env_skill:req-1');
      expect(d).toMatchObject({
        kind: 'question',
        id: 'env_skill:req-1',
        question: ENV_REQUEST.title,
        recommendedId: 'env_skill_once',
        allowOther: false,
        label: '환경 스킬 · 김민수 요청',
      });
      expect(d.choices.map((x: any) => x.label)).toEqual(['✅ 1회 허용 (이 스레드)', '❌ 거부']);
      expect(d.description).toContain('요청 위치: #C1 스레드 171.1');
      expect(d.canAnswer).toBeUndefined();
    });

    it('an MCP grant request is a permission card: the tool, the DM rows, the risk', () => {
      const { c } = client();
      c.applyAdminApprovals({
        pending: [
          {
            id: 'mcp_grant:req-2',
            kind: 'mcp_grant',
            card: 'permission',
            title: 'MCP 도구 권한 요청',
            description: 'server-tools 서버 쓰기 권한을 24h 동안 요청합니다.',
            tool: 'mcp__server-tools',
            rows: { 요청자: 'U1', 서버: 'server-tools', 권한: '쓰기 (write)', 기간: '24h' },
            risk: 'medium',
            requesterId: 'U1',
            createdAt: 1_700_000_000_000,
          },
        ],
        resolved: [],
      });
      expect(c.adminApprovalData('mcp_grant:req-2')).toMatchObject({
        kind: 'permission',
        tool: 'mcp__server-tools',
        title: 'MCP 도구 권한 요청',
        input: { 서버: 'server-tools', 권한: '쓰기 (write)' },
        risk: 'medium',
        canExplain: false,
        canDisableRule: false,
        label: 'MCP 권한 · 김민수 요청',
      });
    });

    it('locked until admin mode is on, and for an admin without a Slack identity', () => {
      const off = client({ _isAdminModeOn: () => false }).c;
      off.applyAdminApprovals({ pending: [ENV_REQUEST], resolved: [] });
      expect(off.adminApprovalData('env_skill:req-1').canAnswer).toBe('관리자 모드를 켜면 응답할 수 있습니다');
      const bearer = client({ _viewerUserId: '' }).c;
      bearer.applyAdminApprovals({ pending: [ENV_REQUEST], resolved: [] });
      expect(bearer.adminApprovalData('env_skill:req-1').canAnswer).toContain('Slack 계정');
    });

    it('only a Slack-signed-in admin asks for the requests (the server refuses a viewer token)', () => {
      const urls: string[] = [];
      const fetch = async (url: string) => {
        urls.push(url);
        return { ok: true, json: async () => ({ pending: [], resolved: [] }) };
      };
      client({ fetch }).c.adminInboxLoad();
      client({ fetch, _viewerUserId: '' }).c.adminInboxLoad();
      client({ fetch, _viewerIsAdmin: false }).c.adminInboxLoad();
      expect(urls).toEqual(['/api/dashboard/admin-approvals']);
    });

    it('T4 — the first load is quiet; a later arrival toasts with 열기', () => {
      const { c, toasts } = client();
      c.applyAdminApprovals({ pending: [], resolved: [] });
      expect(toasts).toEqual([]);
      c.applyAdminApprovals({ pending: [ENV_REQUEST], resolved: [] });
      expect(toasts).toHaveLength(1);
      expect(toasts[0].t).toMatchObject({ title: '관리자 승인 요청', action: { id: 'open' } });
      expect(toasts[0].t.description).toContain('김민수');
    });

    it('T5 — answered in Slack by another admin: the card resolves with the real choice and who', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [ENV_REQUEST], resolved: [] });
      c.applyAdminApprovals({
        pending: [],
        resolved: [
          { id: 'env_skill:req-1', outcome: 'denied', choiceId: 'env_skill_deny', by: 'UOTHER', via: 'slack', at: 9 },
        ],
      });
      expect(c.adminApprovalData('env_skill:req-1').state).toMatchObject({
        status: 'resolved',
        outcome: 'answered',
        choiceId: 'env_skill_deny',
        by: '박지은 · Slack',
      });
    });

    it('T5 — answering here: one request names the choice; a lost race shows the winner', async () => {
      const calls: any[] = [];
      const { c, toasts } = client({
        fetch: async (url: string, init: any) => {
          calls.push({ url, body: JSON.parse(init.body) });
          return { ok: true, status: 200, json: async () => ({ ok: true, outcome: 'approved' }) };
        },
      });
      c.applyAdminApprovals({ pending: [ENV_REQUEST], resolved: [] });
      const st = await c.answerAdminApproval('env_skill:req-1', 'env_skill_once');
      expect(st).toMatchObject({ status: 'resolved', outcome: 'answered', choiceId: 'env_skill_once' });
      expect(calls).toEqual([
        { url: '/api/dashboard/admin-approvals/answer', body: { id: 'env_skill:req-1', choiceId: 'env_skill_once' } },
      ]);
      expect(toasts[0].t.description).toContain('Slack DM도 같은 결과로');

      const lost = client({
        fetch: async () => ({
          ok: false,
          status: 409,
          json: async () => ({
            resolution: { outcome: 'denied', choiceId: 'env_skill_deny', by: 'UOTHER', via: 'slack', at: 3 },
          }),
        }),
      }).c;
      lost.applyAdminApprovals({ pending: [ENV_REQUEST], resolved: [] });
      expect(await lost.answerAdminApproval('env_skill:req-1', 'env_skill_once')).toMatchObject({
        status: 'resolved',
        choiceId: 'env_skill_deny',
        by: '박지은 · Slack',
      });
    });

    it('answered elsewhere as a denial of a grant choice: the card shows denied, not the attempted choice', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [ENV_REQUEST], resolved: [] });
      c.applyAdminApprovals({
        pending: [],
        resolved: [
          { id: 'env_skill:req-1', outcome: 'denied', choiceId: 'env_skill_once', by: 'UOTHER', via: 'slack', at: 9 },
        ],
      });
      const st = c.adminApprovalData('env_skill:req-1').state;
      expect(st).toMatchObject({ status: 'resolved', outcome: 'denied', by: '박지은 · Slack' });
      expect(st.choiceId).toBeUndefined();
    });

    it('a GET that started before a WebSocket push is older than it — its snapshot is dropped', async () => {
      let release: (v: unknown) => void = () => {};
      const { c } = client({
        fetch: () =>
          new Promise((r) => {
            release = r;
          }),
      });
      c.applyAdminApprovals({ pending: [], resolved: [] });
      c.adminInboxLoad();
      // The push: the request was answered in Slack.
      c.pushed();
      c.applyAdminApprovals({ pending: [], resolved: [{ id: 'env_skill:req-1', outcome: 'approved', at: 2 }] });
      release({ ok: true, json: async () => ({ pending: [ENV_REQUEST], resolved: [] }) });
      await new Promise((r) => setTimeout(r, 10));
      expect(c.state()._adminApprovals.pending).toEqual([]);
    });

    it('the server outcome wins: a grant the server turned into a denial shows as denied', async () => {
      const { c, toasts } = client({
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, outcome: 'denied' }) }),
      });
      c.applyAdminApprovals({ pending: [ENV_REQUEST], resolved: [] });
      expect(await c.answerAdminApproval('env_skill:req-1', 'env_skill_once')).toMatchObject({
        status: 'resolved',
        outcome: 'denied',
      });
      expect(toasts[0].t).toMatchObject({ title: '거부로 처리됐어요', tone: 'warning' });
    });
  });
});
