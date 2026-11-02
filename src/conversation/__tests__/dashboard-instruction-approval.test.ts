/**
 * #767 T2/T3 — "대시보드 승인 요청 일반적인 권한 요청 해서 처리해줘. 승인 /
 * 이세션에서 항상 승인 / 해당 사람의 지시 항상 승인 / 거절".
 *
 * The board carries a session's pending instruction approvals (someone else's
 * instruction waiting on the owner), the shipped client renders each as a
 * <ui-approval-card> with the four answers the owner's DM has, and the
 * dashboard answer runs the one decision path the DM buttons run: the held
 * instructions are released (or dropped), the DM is rewritten, the card leaves.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

const DASHBOARD_TS = fs.readFileSync(path.join(__dirname, '..', 'dashboard.ts'), 'utf-8');
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
  'esc',
  'escAttr',
  'toNum',
  'acSlotHtml',
  'acInstructionApprovalLock',
  'acInstructionApprovalData',
  'acInstructionApprovalsHtml',
  'acPost',
  'acRefusal',
  'acDrop',
  'answerInstructionApproval',
] as const;

interface InstrClient {
  acInstructionApprovalData(s: unknown, a: unknown): Record<string, any>;
  acInstructionApprovalsHtml(s: unknown): string;
  answerInstructionApproval(key: string, requestId: string, choiceId: string): Promise<Record<string, unknown> | null>;
}

function load(inject: Record<string, unknown>): InstrClient {
  const names = Object.keys(inject);
  const body = `${clientVar('AC_SIBLING')}
${clientVar('INSTRUCTION_APPROVAL_CHOICES')}
${clientVar('INSTRUCTION_APPROVAL_SENT')}
var _acState = Object.create(null);
${FNS.map(clientFn).join('\n')}
return { ${FNS.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as InstrClient;
}

describe('dashboard instruction approvals — board, route, shipped client (#767)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let mod: typeof import('../../instruction-approval');
  let blocks: typeof import('../../slack/instruction-approval-blocks');
  let issueSlackToken: typeof import('../oauth').issueSlackToken;
  let key: string;
  let live: any;
  let approvals: import('../../instruction-approval').InstructionApprovals;
  let dir: string;
  let released: string[];
  let dmUpdates: string[];
  let owner: { cookie: string; csrf: string };

  beforeAll(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    mod = await import('../../instruction-approval');
    blocks = await import('../../slack/instruction-approval-blocks');
    ({ issueSlackToken } = await import('../oauth'));
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterAll(async () => {
    await stopWebServer();
  });

  beforeEach(async () => {
    const channel = `C_IA_${Math.random().toString(36).slice(2, 10)}`;
    key = `${channel}:t1`;
    released = [];
    dmUpdates = [];
    live = {
      sessionId: 'sid1',
      ownerId: 'U1',
      ownerName: 'Owner',
      channelId: channel,
      threadTs: 't1',
      activityState: 'idle',
      state: 'MAIN',
      lastActivity: new Date(),
    };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-instr-'));
    approvals = new mod.InstructionApprovals({
      storeFile: path.join(dir, 'instruction-approvals.json'),
      getSession: (k) => (k === key ? live : undefined),
      saveSessions: () => {},
      isTrusted: () => false,
      trust: () => {},
      postOwnerDm: async () => ({ channel: 'D-U1', ts: '1.1' }),
      updateDm: async (_ref, msg) => {
        dmUpdates.push(msg.text);
      },
      release: async (_r, held) => {
        released.push(held.kind === 'message' ? held.text : '');
      },
      broadcast: () => dashboard.broadcastSessionUpdate(),
    });
    await approvals.hold({
      sessionKey: key,
      session: live,
      senderId: 'U2',
      senderName: 'Helper',
      instruction: {
        kind: 'message',
        ts: '2.2',
        text: '배포해줘',
        at: 1,
        event: { user: 'U2', channel, thread_ts: 't1', ts: '2.2', text: '배포해줘' },
      },
    });
    dashboard.setDashboardSessionAccessor(() => new Map([[key, live]]));
    dashboard.setDashboardInstructionApprovals(approvals);
    owner = await signIn('U1');
  });

  afterEach(() => {
    dashboard.setDashboardInstructionApprovals(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function signIn(userId: string) {
    const token = issueSlackToken({ slackUserId: userId, email: `${userId}@slack.local`, name: userId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, csrf: me.csrfToken as string };
  }

  async function card() {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: { Authorization: 'Bearer test-token' },
    });
    const board = JSON.parse(res.body).board;
    return [...board.working, ...board.waiting, ...board.idle].find((c: any) => c.key === key);
  }

  function post(body: unknown, who = owner) {
    return injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/instruction-approval`,
      headers: { cookie: who.cookie, 'x-csrf-token': who.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  it('T2 — the board carries the pending request (no instruction beyond a preview) and the card waits on the owner', async () => {
    const c = await card();
    expect(c.pendingInstructionApprovals).toHaveLength(1);
    expect(c.pendingInstructionApprovals[0]).toMatchObject({
      ownerId: 'U1',
      requesterId: 'U2',
      requesterName: 'Helper',
      count: 1,
      preview: '배포해줘',
    });
    expect(c.activityState).toBe('waiting');
  });

  it('T2 — the card has the DM’s four answers; only the owner may press them', async () => {
    const c = await card();
    const a = c.pendingInstructionApprovals[0];
    const d = load({ _viewerUserId: 'U1', isSiblingSession: () => false }).acInstructionApprovalData(c, a);
    expect(d).toMatchObject({ kind: 'question', id: a.requestId, allowOther: false });
    expect(d.canAnswer).toBeUndefined();
    expect(d.choices.map((x: any) => x.id)).toEqual([...blocks.INSTRUCTION_APPROVAL_DECISIONS]);
    expect(d.choices.map((x: any) => x.label)).toEqual(
      blocks.INSTRUCTION_APPROVAL_DECISIONS.map((id) => blocks.INSTRUCTION_APPROVAL_LABELS[id]),
    );
    expect(d.question).toContain('Helper');
    expect(d.description).toContain('배포해줘');
    expect(load({ _viewerUserId: 'U1', isSiblingSession: () => false }).acInstructionApprovalsHtml(c)).toContain(
      `data-ac-kind="instr" data-ac-id="${a.requestId}"`,
    );
    const other = load({ _viewerUserId: 'U2', isSiblingSession: () => false }).acInstructionApprovalData(c, a);
    expect(other.canAnswer).toContain('소유자만');
  });

  it('T3 — answered on the dashboard: released, the DM rewritten, the card leaves; a second answer is 409', async () => {
    const [{ requestId }] = (await card()).pendingInstructionApprovals;
    const res = await post({ requestId, decision: 'approve_session' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, decision: 'approve_session' });
    await vi.waitFor(() => expect(released).toEqual(['배포해줘']));
    expect(live.approvedInstructors).toEqual(['U2']);
    expect(dmUpdates[dmUpdates.length - 1]).toContain('대시보드');
    const c = await card();
    expect(c.pendingInstructionApprovals).toBeUndefined();
    expect(c.activityState).toBe('idle');
    expect((await post({ requestId, decision: 'deny' })).statusCode).toBe(409);
  });

  it('T3 — 거절 drops the instruction', async () => {
    const [{ requestId }] = (await card()).pendingInstructionApprovals;
    const res = await post({ requestId, decision: 'deny' });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(released).toEqual([]);
  });

  it('refuses the requester and strangers (403), a malformed answer (400), an unknown or foreign request (404)', async () => {
    const [{ requestId }] = (await card()).pendingInstructionApprovals;
    expect((await post({ requestId, decision: 'maybe' })).statusCode).toBe(400);
    expect((await post({ decision: 'approve' })).statusCode).toBe(400);
    expect((await post({ requestId: 'iap_nope', decision: 'approve' })).statusCode).toBe(404);
    const requester = await signIn('U2');
    expect((await post({ requestId, decision: 'approve' }, requester)).statusCode).toBe(403);
    expect(released).toEqual([]);
    expect((await card()).pendingInstructionApprovals).toHaveLength(1);
  });

  it('T3 — the shipped client answer: sending → resolved, a toast, the request names the request id', async () => {
    const c = await card();
    const toasts: any[] = [];
    const calls: Array<{ url: string; body: any }> = [];
    const client = load({
      _viewerUserId: 'U1',
      isSiblingSession: () => false,
      console: { error() {} },
      _csrfToken: owner.csrf,
      refreshCsrfToken: async () => {},
      acRepaint: vi.fn(),
      dashToast: (t: any) => toasts.push(t),
      _sessionCache: { [key]: c },
      fetch: async (url: string, init: any) => {
        calls.push({ url, body: JSON.parse(init.body) });
        const res = await injectWebServer({
          method: init.method,
          url,
          headers: { ...init.headers, cookie: owner.cookie },
          payload: init.body,
        });
        return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body) };
      },
    });
    const requestId = c.pendingInstructionApprovals[0].requestId;
    const st = await client.answerInstructionApproval(key, requestId, 'approve');
    expect(st).toMatchObject({ status: 'resolved', choiceId: 'approve' });
    expect(calls[0]).toEqual({
      url: `/api/dashboard/session/${encodeURIComponent(key)}/instruction-approval`,
      body: { requestId, decision: 'approve' },
    });
    expect(toasts[0]).toMatchObject({ tone: 'success' });
    const again = await client.answerInstructionApproval(key, requestId, 'deny');
    expect(again).toMatchObject({ status: 'resolved', choiceId: 'approve' });
    expect(calls).toHaveLength(1);
  });

  it('a dashboard instruction from someone else is answered with pendingApproval', async () => {
    const commands: Array<{ key: string; actor?: string }> = [];
    dashboard.setDashboardCommandHandler(async (k: string, _m: string, _a: unknown, actor?: string) => {
      commands.push({ key: k, actor });
    });
    const helper = await signIn('U2');
    const res = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/command`,
      headers: { cookie: helper.cookie, 'x-csrf-token': helper.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ message: '테스트도 돌려줘' }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, pendingApproval: true });
    // It still goes into the thread (the gate there holds it).
    expect(commands).toEqual([{ key, actor: 'U2' }]);
    const mine = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/command`,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ message: '내 지시' }),
    });
    expect(JSON.parse(mine.body)).toEqual({ ok: true });
  });

  it('the page script still parses with the instruction approval card wired in', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.statusCode).toBe(200);
    const scripts = [
      ...String(res.body).matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
    const all = scripts.join('\n');
    expect(all).toContain('answerInstructionApproval');
    expect(all).toContain('acInstructionApprovalsHtml(s)');
  });
});
