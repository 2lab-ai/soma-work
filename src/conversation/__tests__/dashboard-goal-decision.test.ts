/**
 * SSOT T1/T2 — "goal이 10/10이 되면 slack dm으로 … 묻고 있는데 이거 Approval
 * 카드로 대시보드에도 같은 내용 표시해줘. 아무데서나 수락하면 둘다 수락 처리".
 *
 * The board carries the goal's open cap decision (the same request the owner's
 * DM asks), the shipped client renders it as a <ui-approval-card> with the DM's
 * content and choices, and the dashboard's answer runs the real decision path:
 * the goal resumes and the owner's DM is rewritten. A DM answer pushes the
 * board so the card leaves.
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
  'esc',
  'escAttr',
  'toNum',
  'acSlotHtml',
  'acGoalDecisionLock',
  'acGoalDecisionData',
  'acGoalDecisionHtml',
  'acPost',
  'acRefusal',
  'acDrop',
  'answerGoalDecision',
] as const;

interface GoalClient {
  acGoalDecisionData(s: unknown, d: unknown): Record<string, any>;
  acGoalDecisionHtml(s: unknown): string;
  answerGoalDecision(key: string, decisionId: string, choiceId: string): Promise<Record<string, unknown> | null>;
  state: { _acState: Record<string, Record<string, unknown>> };
}

function load(inject: Record<string, unknown>): GoalClient {
  const names = Object.keys(inject);
  const body = `${clientVar('AC_SIBLING')}
${clientVar('GOAL_DECISION_CHOICES')}
${clientVar('GOAL_DECISION_SENT')}
var _acState = Object.create(null);
${FNS.map(clientFn).join('\n')}
return { ${FNS.join(', ')}, state: { _acState: _acState } };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as GoalClient;
}

describe('dashboard goal cap decision — board, route, shipped client (T1/T2)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let decision: typeof import('../../slack/goal-cap-decision');
  let issueSlackToken: typeof import('../oauth').issueSlackToken;
  let buildCapDecisionDmBlocks: typeof import('../../slack/goal-blocks').buildCapDecisionDmBlocks;
  let key: string;
  let live: any;
  let signedIn: { cookie: string; csrf: string };
  let dmUpdates: Array<{ ref: { channel: string; ts: string }; text: string }>;
  let resumed: string[];

  beforeAll(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    decision = await import('../../slack/goal-cap-decision');
    ({ issueSlackToken } = await import('../oauth'));
    ({ buildCapDecisionDmBlocks } = await import('../../slack/goal-blocks'));
    (await import('../../slack/goal-loop-resume')).setGoalLoopResumeHandler((k: string) => resumed.push(k));
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterAll(async () => {
    decision.setGoalCapDecisionSurfaces(null);
    await stopWebServer();
  });

  beforeEach(async () => {
    const channel = `C_GD_${Math.random().toString(36).slice(2, 10)}`;
    key = `${channel}:t1`;
    dmUpdates = [];
    resumed = [];
    live = {
      sessionId: 'sid1',
      ownerId: 'U1',
      channelId: channel,
      threadTs: 't1',
      activityState: 'idle',
      state: 'MAIN',
      lastActivity: new Date(),
      systemPrompt: 'cached',
      goal: {
        goalId: 'g1',
        objective: '대시보드 승인 카드',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'U1',
        continuationCount: 10,
        maxContinuations: 10,
        lastEvalReason: '테스트가 아직 없다',
        epoch: 1,
      },
    };
    decision.openGoalCapDecision(live.goal, 1_700_000_000_000);
    decision.recordGoalCapDm(live.goal, live.goal.capDecisionId, { channel: 'D-U1', ts: '1700000000.000100' });
    dashboard.setDashboardSessionAccessor(() => new Map([[key, live]]));
    decision.setGoalCapDecisionSurfaces({
      updateDm: async (ref, text) => {
        dmUpdates.push({ ref, text });
      },
      broadcast: () => dashboard.broadcastSessionUpdate(),
    });
    dashboard.setDashboardGoalDecisionHandler((sessionKey: string, answer: any, actor: string | undefined) =>
      decision.answerGoalCapDecision({
        session: sessionKey === key ? live : undefined,
        sessionKey,
        goalId: answer.goalId,
        decisionId: answer.decisionId,
        actor,
        decision: answer.decision,
        surface: 'dashboard',
        save: () => {},
      }),
    );
    signedIn = await signIn('U1');
  });

  afterEach(() => {
    dashboard.setDashboardGoalDecisionHandler(null);
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

  function post(body: unknown, who = signedIn) {
    return injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/goal-decision`,
      headers: { cookie: who.cookie, 'x-csrf-token': who.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  it('T1 — the board carries the open decision and the card waits on its owner', async () => {
    const c = await card();
    expect(c.pendingGoalDecision).toEqual({
      decisionId: live.goal.capDecisionId,
      goalId: 'g1',
      objective: '대시보드 승인 카드',
      maxContinuations: 10,
      reason: '테스트가 아직 없다',
      askedAt: 1_700_000_000_000,
      ownerId: 'U1',
    });
    expect(c.activityState).toBe('waiting');
    expect(c.waitingSince).toBe(1_700_000_000_000);
  });

  it('T1 — the card shows the DM content: the budget, the objective, the latest reason, 계속 / 취소', async () => {
    const c = await card();
    const client = load({ _viewerUserId: 'U1', isSiblingSession: () => false });
    const d = client.acGoalDecisionData(c, c.pendingGoalDecision);
    expect(d).toMatchObject({ kind: 'question', id: live.goal.capDecisionId, allowOther: false });
    expect(d.recommendedId).toBeUndefined();
    expect(d.canAnswer).toBeUndefined();
    expect(d.choices).toEqual([
      { id: 'continue', label: '✅ 계속' },
      { id: 'cancel', label: '🛑 취소' },
    ]);
    // Same words as the DM blocks.
    const dm = buildCapDecisionDmBlocks({
      value: { sessionKey: key, goalId: 'g1' },
      objective: live.goal.objective,
      maxContinuations: 10,
      reason: live.goal.lastEvalReason,
      formatObjective: (o: string) => o,
    });
    const dmText: string = dm[0].text.text;
    expect(dmText).toContain('reached its 10-turn budget');
    expect(d.question).toContain('reached its 10-turn budget');
    expect(d.question).toContain('계속 진행할까요?');
    expect(dmText).toContain('계속 진행할까요?');
    expect(d.description).toContain('대시보드 승인 카드');
    expect(d.description).toContain('테스트가 아직 없다');
    const dmLabels = dm[1].elements.map((e: any) => e.text.text);
    expect(d.choices.map((x: any) => x.label)).toEqual(dmLabels);
    expect(d.label).toBe('Goal 자동 진행 10/10');
    // The slot is bound by attributes (no inline handler).
    expect(client.acGoalDecisionHtml(c)).toContain(`data-ac-kind="goal" data-ac-id="${live.goal.capDecisionId}"`);
    // Another viewer reads it locked.
    const other = load({ _viewerUserId: 'U2', isSiblingSession: () => false }).acGoalDecisionData(
      c,
      c.pendingGoalDecision,
    );
    expect(other.canAnswer).toBe('goal 소유자만 응답할 수 있습니다');
  });

  it('T2 — answered on the dashboard: the goal continues, the DM is rewritten, the card leaves the board', async () => {
    const id = live.goal.capDecisionId;
    const res = await post({ goalId: 'g1', decisionId: id, decision: 'continue' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, decision: 'continue' });
    expect(live.goal.continuationCount).toBe(0);
    expect(resumed).toEqual([key]);
    await new Promise((r) => setTimeout(r, 0));
    expect(dmUpdates).toHaveLength(1);
    expect(dmUpdates[0].ref).toEqual({ channel: 'D-U1', ts: '1700000000.000100' });
    expect(dmUpdates[0].text).toContain('계속 진행합니다');
    const c = await card();
    expect(c.pendingGoalDecision).toBeUndefined();
    expect(c.activityState).toBe('idle');
    // The DM's button for the same round is now stale: one answer across surfaces.
    const again = decision.answerGoalCapDecision({
      session: live,
      sessionKey: key,
      goalId: 'g1',
      decisionId: id,
      actor: 'U1',
      decision: 'cancel',
      surface: 'slack',
      save: () => {},
    });
    expect(again).toEqual({ ok: false, reason: 'stale' });
    expect(live.goal.status).toBe('active');
  });

  it('T2 — answered in the DM first: the dashboard answer is refused as already answered (409)', async () => {
    const id = live.goal.capDecisionId;
    decision.answerGoalCapDecision({
      session: live,
      sessionKey: key,
      goalId: 'g1',
      decisionId: id,
      actor: 'U1',
      decision: 'cancel',
      surface: 'slack',
      save: () => {},
    });
    expect((await card()).pendingGoalDecision).toBeUndefined();
    const res = await post({ goalId: 'g1', decisionId: id, decision: 'continue' });
    expect(res.statusCode).toBe(409);
    expect(live.goal.status).toBe('paused');
  });

  it('the goal creator answers even when another user owns the session (review gate P2)', async () => {
    live.ownerId = 'U9';
    const res = await post({ goalId: 'g1', decisionId: live.goal.capDecisionId, decision: 'continue' });
    expect(res.statusCode).toBe(200);
    expect(live.goal.capDmPendingAt).toBeUndefined();
  });

  it('refuses a non-owner (403) and a malformed answer (400)', async () => {
    const id = live.goal.capDecisionId;
    expect((await post({ goalId: 'g1', decisionId: id, decision: 'maybe' })).statusCode).toBe(400);
    expect((await post({ goalId: 'g1', decision: 'continue' })).statusCode).toBe(400);
    const stranger = await signIn('U2');
    const res = await post({ goalId: 'g1', decisionId: id, decision: 'continue' }, stranger);
    expect(res.statusCode).toBe(403);
    expect(live.goal.capDmPendingAt).toBeDefined();
  });

  it('T2 — the shipped client answer: sending → resolved, a toast, the request names the round', async () => {
    const c = await card();
    const toasts: any[] = [];
    const calls: Array<{ url: string; body: any }> = [];
    const repaint = vi.fn();
    const client = load({
      _viewerUserId: 'U1',
      isSiblingSession: () => false,
      console: { error() {} },
      _csrfToken: signedIn.csrf,
      refreshCsrfToken: async () => {},
      acRepaint: repaint,
      dashToast: (t: any) => toasts.push(t),
      _sessionCache: { [key]: c },
      fetch: async (url: string, init: any) => {
        calls.push({ url, body: JSON.parse(init.body) });
        const res = await injectWebServer({
          method: init.method,
          url,
          headers: { ...init.headers, cookie: signedIn.cookie },
          payload: init.body,
        });
        return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body) };
      },
    });
    const st = await client.answerGoalDecision(key, c.pendingGoalDecision.decisionId, 'continue');
    expect(st).toMatchObject({ status: 'resolved', outcome: 'answered', choiceId: 'continue' });
    expect(calls[0]).toEqual({
      url: `/api/dashboard/session/${encodeURIComponent(key)}/goal-decision`,
      body: { goalId: 'g1', decisionId: c.pendingGoalDecision.decisionId, decision: 'continue' },
    });
    expect(toasts[0]).toMatchObject({ title: '계속 진행을 보냈어요', tone: 'success' });
    expect(repaint).toHaveBeenCalledWith(key);
    // A second answer for the same round is a no-op client-side too.
    const again = await client.answerGoalDecision(key, c.pendingGoalDecision.decisionId, 'cancel');
    expect(again).toMatchObject({ status: 'resolved', choiceId: 'continue' });
    expect(calls).toHaveLength(1);
  });

  it('the page script still parses with the goal card wired in', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.statusCode).toBe(200);
    const scripts = [
      ...String(res.body).matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
    expect(scripts.join('\n')).toContain('answerGoalDecision');
  });
});
