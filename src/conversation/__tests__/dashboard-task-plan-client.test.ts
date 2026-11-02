/**
 * Plan mode on the dashboard (SSOT 2026-11-02, T1 · T5 · T6 · T7) — the shipped client code cut out of
 * renderDashboardPage()'s template, with fakes — no DOM.
 *
 *   U1 (T1) the composer's 작업 계획 switch: on by default, sent as `plan` on a dashboard task only.
 *   U2 (T6) the task card (open body): the plan's state and summary, 시작 · 취소 · 직접 입력 as buttons.
 *   U3 (T6) the face says a plan waits; the card asks.
 *   U4 (T6) the detail card's top (status bar): 시작 (primary) · 취소 first while a plan waits.
 *   U5 (T5) the detail card: the plan inline in 입력 필요, fetched by revision; the bottom bar 시작 · 취소 · 직접 입력.
 *   U6 (T4) 시작 / 취소 post the revision the user saw; 직접 입력 opens the panel on the composer.
 *   U7 (T7) a simple question (yes / no, 시작 / 취소) is buttons on the task card: one press answers.
 *   U8 (T6 · T7) a card that newly needs a decision opens on the board by itself, once — without the panel.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} =`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const end = TEMPLATE.indexOf(';\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}, extra = '', vars: string[] = []): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const escJs = (s: unknown) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script', TEMPLATE.indexOf('<body'))));

const awaiting = (over: Record<string, unknown> = {}) => ({
  key: 'task:a',
  slackless: true,
  ownerId: 'U1',
  activityState: 'waiting',
  taskPlan: {
    state: 'awaiting',
    revision: 2,
    updatedAt: 1,
    summary: '새 작업에 계획 모드를 넣는다',
    phases: 2,
    steps: 5,
  },
  ...over,
});

describe('U1 — the composer’s 작업 계획 switch (T1)', () => {
  const m = load<{ ntDefaultState(c: unknown, d: unknown): any; ntBuildPayload(s: any, a: any[], r: string): any }>([
    'ntDefaultState',
    'ntBuildPayload',
  ]);
  const ctx = { defaultModel: 'opus', defaultEffort: 'high', defaultChannelId: 'C1', autogoalDefault: false };
  it('is on by default and rides a dashboard task’s body; off is sent as off; a Slack launch never carries it', () => {
    const state = m.ntDefaultState(ctx, null);
    expect(state.plan).toBe(true);
    const task = { ...state, destination: 'task', prompt: '대시보드 개선해줘' };
    expect(m.ntBuildPayload(task, [], 'req-1')).toMatchObject({ destination: 'task', plan: true });
    expect(m.ntBuildPayload({ ...task, plan: false }, [], 'req-1')).toMatchObject({ plan: false });
    expect(m.ntBuildPayload({ ...task, destination: 'slack' }, [], 'req-1')).not.toHaveProperty('plan');
  });
  it('sits in the destination row (shown for a dashboard task), checked from the state', () => {
    const row = PAGE.slice(PAGE.indexOf('id="nt-dest"'), PAGE.indexOf('</div>', PAGE.indexOf('id="nt-dest"')));
    expect(row).toMatch(/<label class="ui-switch nt-plan-switch" id="nt-plan-wrap"[^>]*hidden/);
    expect(row).toContain('<input type="checkbox" role="switch" id="nt-plan" onchange="ntToggle(\'plan\')"');
    expect(row).toContain('작업 계획');
    const render = clientFn('ntRender');
    expect(render).toContain('planWrap.hidden = !isTask;');
    expect(render).toContain("ntEl('nt-plan').checked = _ntState.plan !== false;");
  });
});

const lockFree = { viewerCanInstruct: () => true, isSiblingSession: () => false, isBusy: () => false };

describe('U2 — the task card shows the plan and its three buttons (T6)', () => {
  const m = load<{ taskPlanCardHtml(s: any): string }>(
    ['taskPlanCardHtml', 'planLock', 'planButtonsHtml'],
    { esc, escJs, escAttr: esc, ...lockFree },
    '',
    ['TASK_PLAN_STATE_LABEL'],
  );
  it('a waiting plan: its revision, summary and size, then 시작 · 취소 · 직접 입력', () => {
    const html = m.taskPlanCardHtml(awaiting());
    expect(html).toContain('작업 계획 v2');
    expect(html).toContain('새 작업에 계획 모드를 넣는다');
    expect(html).toContain('단계 2 · 작업 5');
    const at = (s: string) => html.indexOf(s);
    expect(at('data-plan="start"')).toBeGreaterThan(0);
    expect(at('data-plan="cancel"')).toBeGreaterThan(at('data-plan="start"'));
    expect(at('data-plan="input"')).toBeGreaterThan(at('data-plan="cancel"'));
    // The key rides as data: no value is built into inline JS.
    expect(html.match(/data-plan-key="task:a" onclick="event.stopPropagation\(\);planButton\(this\)"/g)?.length).toBe(
      3,
    );
    expect(html).toContain('is-primary');
  });
  it('writing, started and cancelled plans say so; no buttons', () => {
    const writing = m.taskPlanCardHtml(awaiting({ taskPlan: { state: 'drafting', revision: 0, updatedAt: 1 } }));
    expect(writing).toContain('계획을 세우는 중');
    expect(writing).not.toContain('data-plan="start"');
    const revising = m.taskPlanCardHtml(awaiting({ taskPlan: { state: 'drafting', revision: 1, updatedAt: 1 } }));
    expect(revising).toContain('v1 고치는 중');
    const started = m.taskPlanCardHtml(
      awaiting({ taskPlan: { state: 'approved', revision: 2, updatedAt: 1, summary: 's' } }),
    );
    expect(started).toContain('시작됨');
    expect(started).toContain('/dashboard/plan/');
    expect(started).not.toContain('data-plan="start"');
    expect(m.taskPlanCardHtml(awaiting({ taskPlan: { state: 'cancelled', revision: 1, updatedAt: 1 } }))).toContain(
      '취소됨',
    );
    expect(m.taskPlanCardHtml({ key: 'k' })).toBe('');
  });
  it('someone who may not instruct sees the buttons locked, with the reason', () => {
    const locked = load<{ taskPlanCardHtml(s: any): string }>(
      ['taskPlanCardHtml', 'planLock', 'planButtonsHtml'],
      {
        esc,
        escJs,
        escAttr: esc,
        viewerCanInstruct: () => false,
        isSiblingSession: () => false,
        isBusy: () => false,
        READ_ONLY_MSG: '읽기 전용',
      },
      '',
      ['TASK_PLAN_STATE_LABEL'],
    );
    const html = locked.taskPlanCardHtml(awaiting());
    expect(html).toMatch(/disabled title="읽기 전용"/);
  });
  it('the open card draws it with what asks, before the layout’s parts', () => {
    const body = clientFn('renderCardBody');
    expect(body).toContain('+ taskPlanCardHtml(s)');
    expect(body.indexOf('+ taskPlanCardHtml(s)')).toBeLessThan(body.indexOf('const lane ='));
  });
});

describe('U3 — the face says a plan waits; the card asks (T6)', () => {
  it('cardSummary leads with the plan; cardAsks says yes', () => {
    const m = load<{ cardSummary(s: any, col: string, h: string): string; cardAsks(s: any, col: string): boolean }>(
      ['cardSummary', 'cardAsks'],
      { cardCurrentTask: () => null, pendingAutoResume: () => null, dhShow: () => true, permissionSummary: () => '' },
    );
    expect(m.cardSummary(awaiting(), 'waiting', 'title')).toBe(
      '작업 계획 v2 — 시작할까요? · 새 작업에 계획 모드를 넣는다',
    );
    expect(m.cardAsks(awaiting(), 'waiting')).toBe(true);
    expect(m.cardAsks(awaiting({ taskPlan: { state: 'approved', revision: 2, updatedAt: 1 } }), 'idle')).toBe(false);
  });
});

describe('U4 — the detail card’s top: 시작 · 취소 first (T6)', () => {
  it('panelHeadData leads with 시작 (primary) and 취소 while a plan waits; onPanelHeadAction decides', () => {
    const m = load<{ panelHeadData(s: any, col: string): any }>(['panelHeadData', 'planHeadActions', 'planLock'], {
      rootStatusOf: () => 'waiting',
      PS_BAR_STATUS: { waiting: 'waiting' },
      AGENT_STATUS_LABEL: { waiting: '입력 대기' },
      toNum: Number,
      sessionActionsOf: () => [{ id: 'close', label: '닫기' }],
      SESSION_ACTION_ARIA: {},
      ...lockFree,
    });
    const d = m.panelHeadData(awaiting(), 'waiting');
    expect(d.actions.map((a: any) => a.id)).toEqual(['plan-start', 'plan-cancel', 'close']);
    expect(d.actions[0]).toMatchObject({ label: '▶ 시작', primary: true });
    // One press, as on the card and the bottom bar (not the bar's two-press danger).
    expect(d.actions[1]).toMatchObject({ label: '취소' });
    expect(d.actions[1].tone).toBeUndefined();
    const plain = m.panelHeadData({ key: 'k' }, 'idle');
    expect(plain.actions.map((a: any) => a.id)).toEqual(['close']);
    const onHead = clientFn('onPanelHeadAction');
    expect(onHead).toContain("if (id === 'plan-start') doPlanDecision(key, 'start');");
    expect(onHead).toContain("else if (id === 'plan-cancel') doPlanDecision(key, 'cancel');");
  });
});

describe('U5 — the detail card: the plan inline, the bottom bar (T5)', () => {
  it('the page has the plan in 입력 필요 and a plan bar above the composer', () => {
    const needs = PAGE.slice(PAGE.indexOf('id="panel-needs-head"'), PAGE.indexOf('id="panel-artifacts"'));
    expect(needs).toContain('id="panel-plan"');
    const command = PAGE.slice(PAGE.indexOf('id="panel-command"'), PAGE.indexOf('id="cmd-steer"'));
    expect(command).toContain('id="panel-plan-bar"');
    expect(command.indexOf('id="panel-plan-bar"')).toBeLessThan(command.indexOf('id="panel-controls"'));
  });
  it('renderPanelPlan fetches the plan once per revision and shows it at once; the bar has the three buttons', async () => {
    const el = (id: string) => ({
      id,
      hidden: true,
      innerHTML: '',
      style: { display: 'none' } as any,
      setAttribute() {},
    });
    const els: Record<string, any> = { 'panel-plan': el('panel-plan'), 'panel-plan-bar': el('panel-plan-bar') };
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ state: 'awaiting', revision: 2, html: '<article class="tp">PLAN</article>' }),
    }));
    const cache: Record<string, any> = {};
    const m = load<{ renderPanelPlan(s: any): void; planBarHtml(s: any): string }>(
      ['renderPanelPlan', 'planBarHtml', 'planLock', 'planButtonsHtml', 'loadPanelPlan', 'panelPlanHtml', 'planAskKey'],
      {
        _sessionCache: cache,
        document: { getElementById: (id: string) => els[id] ?? null },
        fetch: fetchFn,
        esc,
        escJs,
        escAttr: esc,
        _planDocs: Object.create(null),
        panelSessionKey: 'task:a',
        renderPanelNeedsHead: () => {},
        ...lockFree,
      },
      '',
      ['TASK_PLAN_STATE_LABEL', 'TASK_PLAN_TONE'],
    );
    const s = awaiting();
    cache['task:a'] = s;
    m.renderPanelPlan(s);
    expect(els['panel-plan'].hidden).toBe(false);
    expect(els['panel-plan'].innerHTML).toContain('불러오는 중');
    await vi.waitFor(() => expect(els['panel-plan'].innerHTML).toContain('PLAN'));
    m.renderPanelPlan(s);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as any)[0]).toBe('/api/dashboard/session/task%3Aa/plan');
    expect(els['panel-plan'].innerHTML).toContain('/dashboard/plan/task%3Aa');
    const bar = els['panel-plan-bar'];
    expect(bar.hidden).toBe(false);
    expect(bar.innerHTML).toContain('data-plan="start"');
    expect(bar.innerHTML).toContain('data-plan="cancel"');
    expect(bar.innerHTML).toContain('data-plan="input"');
    // A started plan: no bar, the plan folded.
    m.renderPanelPlan(awaiting({ taskPlan: { state: 'approved', revision: 2, updatedAt: 1 } }));
    expect(bar.hidden).toBe(true);
  });
  it('a server ahead of the board (same revision, another state) is fetched once, not again and again (review R1, fable P2)', async () => {
    const el = (id: string) => ({ id, hidden: true, innerHTML: '', style: {} as any, setAttribute() {} });
    const els: Record<string, any> = { 'panel-plan': el('panel-plan'), 'panel-plan-bar': el('panel-plan-bar') };
    // The plan was started meanwhile: the server says approved; the board's cache still says awaiting.
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ state: 'approved', revision: 2, html: '<article class="tp">PLAN</article>' }),
    }));
    const cache: Record<string, any> = {};
    const m = load<{ renderPanelPlan(s: any): void }>(
      ['renderPanelPlan', 'planBarHtml', 'planLock', 'planButtonsHtml', 'loadPanelPlan', 'panelPlanHtml', 'planAskKey'],
      {
        _sessionCache: cache,
        document: { getElementById: (id: string) => els[id] ?? null },
        fetch: fetchFn,
        esc,
        escJs,
        escAttr: esc,
        _planDocs: Object.create(null),
        panelSessionKey: 'task:a',
        renderPanelNeedsHead: () => {},
        ...lockFree,
      },
      '',
      ['TASK_PLAN_STATE_LABEL', 'TASK_PLAN_TONE'],
    );
    const s = awaiting();
    cache['task:a'] = s;
    m.renderPanelPlan(s);
    await vi.waitFor(() => expect(els['panel-plan'].innerHTML).toContain('PLAN'));
    for (let i = 0; i < 5; i++) {
      m.renderPanelPlan(s);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The board catches up (approved): one look for that, then none.
    const started = awaiting({ taskPlan: { state: 'approved', revision: 2, updatedAt: 2 } });
    cache['task:a'] = started;
    m.renderPanelPlan(started);
    await new Promise((r) => setTimeout(r, 0));
    m.renderPanelPlan(started);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it('the panel paints it with the needs, and the 입력 필요 count counts a waiting plan', () => {
    expect(clientFn('repaintPanelSession')).toContain('renderPanelPlan(s)');
    const needs = clientFn('renderPanelNeedsHead');
    expect(needs).toContain("(s.taskPlan && s.taskPlan.state === 'awaiting' ? 1 : 0)");
  });
});

describe('U6 — 시작 / 취소 post the revision; 직접 입력 opens the composer (T4)', () => {
  it('doPlanDecision posts {decision, revision} with the CSRF token and repaints', async () => {
    const posted: any[] = [];
    const m = load<{ doPlanDecision(key: string, decision: string): Promise<void> }>(['doPlanDecision'], {
      _sessionCache: { 'task:a': awaiting() },
      _csrfToken: 'tok',
      fetch: vi.fn(async (url: string, init: any) => {
        posted.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ ok: true, state: 'approved' }) };
      }),
      isBusy: () => false,
      setBusy: () => {},
      refreshCard: () => {},
      renderPanelHead: () => {},
      renderPanelPlan: () => {},
      panelOpen: false,
      panelSessionKey: '',
      dashToast: () => {},
      loadSessions: () => {},
      refreshCsrfToken: async () => {},
    });
    await m.doPlanDecision('task:a', 'start');
    expect(posted[0].url).toBe('/api/dashboard/session/task%3Aa/plan');
    expect(JSON.parse(posted[0].init.body)).toEqual({ decision: 'start', revision: 2 });
    expect(posted[0].init.headers['X-CSRF-Token']).toBe('tok');
  });
  it('planButton dispatches by its data; cardQuickAnswer answers with the attributes', () => {
    const calls: string[] = [];
    const m = load<{ planButton(b: any): void; cardQuickAnswer(b: any): void }>(['planButton', 'cardQuickAnswer'], {
      doPlanDecision: (k: string, d: string) => calls.push(`decide ${k} ${d}`),
      planDirectInput: (k: string) => calls.push(`input ${k}`),
      answerChoice: (k: string, q: string, c: string) => calls.push(`answer ${k} ${q} ${c}`),
    });
    const btn = (a: Record<string, string>, disabled = false) => ({
      disabled,
      getAttribute: (n: string) => a[n] ?? null,
    });
    m.planButton(btn({ 'data-plan-key': 'task:a', 'data-plan': 'start' }));
    m.planButton(btn({ 'data-plan-key': 'task:a', 'data-plan': 'cancel' }));
    m.planButton(btn({ 'data-plan-key': 'task:a', 'data-plan': 'input' }));
    m.planButton(btn({ 'data-plan': 'start' }));
    m.cardQuickAnswer(
      btn({ 'data-quick-key': 'task:a', 'data-quick-ask': 'a|x|q|["진행?"]', 'data-quick-choice': 'yes' }),
    );
    m.cardQuickAnswer(btn({ 'data-quick-key': 'task:a' }, true));
    expect(calls).toEqual([
      'decide task:a start',
      'decide task:a cancel',
      'input task:a',
      'answer task:a a|x|q|["진행?"] yes',
    ]);
  });
  it('planDirectInput opens the panel on the composer', () => {
    const fn = clientFn('planDirectInput');
    expect(fn).toContain('openPanel(key)');
    expect(fn).toContain('focusPanelComposer(');
  });
});

describe('U7 — a simple question is buttons on the task card (T7)', () => {
  const m = load<{ quickChoicesOf(q: any): any[] | null; quickChoiceHtml(s: any, q: any): string }>(
    ['quickChoicesOf', 'quickChoiceHtml'],
    {
      esc,
      escJs,
      escAttr: esc,
      stripRecommendedMarker: (l: string) => l.replace(/\s*\(추천\)$/, ''),
      resolveRecommendedId: (id: string) => id,
      acQuestionId: () => 'qid',
      acQuestionLock: () => '',
      _acState: {},
    },
  );
  const q = (choices: any[], extra: Record<string, unknown> = {}) => ({
    type: 'user_choice',
    question: '진행할까요?',
    choices,
    ...extra,
  });
  it('2–4 short choices are simple; long, many or a form are not', () => {
    expect(
      m.quickChoicesOf(
        q([
          { id: '1', label: '예' },
          { id: '2', label: '아니오' },
        ]),
      )?.length,
    ).toBe(2);
    expect(
      m.quickChoicesOf(
        q([
          { id: 'start', label: '시작' },
          { id: 'cancel', label: '취소' },
          { id: 'x', label: '직접 입력' },
        ]),
      )?.length,
    ).toBe(3);
    expect(m.quickChoicesOf(q([{ id: '1', label: '예' }]))).toBeNull();
    expect(m.quickChoicesOf(q(Array.from({ length: 5 }, (_, i) => ({ id: String(i), label: `옵션${i}` }))))).toBeNull();
    expect(
      m.quickChoicesOf(
        q([
          { id: '1', label: '아주 긴 선택지 이름이 여기 있어서 버튼으로는 못 쓰는 경우' },
          { id: '2', label: '아니오' },
        ]),
      ),
    ).toBeNull();
    expect(m.quickChoicesOf({ type: 'user_choices', questions: [] })).toBeNull();
  });
  it('one button per choice answers it at once; the recommended one is the primary', () => {
    const html = m.quickChoiceHtml(
      { key: 'task:a' },
      q(
        [
          { id: 'yes', label: '예 (추천)' },
          { id: 'no', label: '아니오' },
        ],
        { recommendedChoiceId: 'yes' },
      ),
    );
    expect(html).toContain('진행할까요?');
    // The model's ids ride as attribute data, never as inline JS.
    expect(html).toContain(
      'data-quick-key="task:a" data-quick-ask="qid" data-quick-choice="yes" onclick="event.stopPropagation();cardQuickAnswer(this)"',
    );
    expect(html).toContain('data-quick-choice="no"');
    expect(html).not.toMatch(/answerChoice\(/);
    expect(html).toMatch(/class="ui-btn is-primary card-quick-choice"[^>]*>예</);
    expect(html).not.toContain('(추천)');
  });
  it('the open card uses the buttons for a simple question, the approval card otherwise', () => {
    const body = clientFn('renderCardBody');
    expect(body).toContain(
      'if (quickChoicesOf(s.pendingQuestion)) questionHtml = quickChoiceHtml(s, s.pendingQuestion);',
    );
    expect(body).toContain('else questionHtml = acQuestionHtml(s, s.pendingQuestion);');
  });
});

describe('U8 — a card that newly needs a decision opens by itself, once, without the panel (T6 · T7)', () => {
  it('decisionSigOf names the decision; autoOpenDecisions reveals each one once; the toggle skips the panel', () => {
    const reveal = vi.fn(() => true);
    const host = { reveal };
    const cache: Record<string, any> = {
      'task:a': awaiting(),
      'task:b': {
        key: 'task:b',
        activityState: 'waiting',
        pendingQuestion: {
          type: 'user_choice',
          question: '?',
          askId: 'x',
          choices: [
            { id: '1', label: '예' },
            { id: '2', label: '아니오' },
          ],
        },
      },
      'task:c': { key: 'task:c', activityState: 'idle' },
    };
    const m = load<{ decisionSigOf(s: any): string; autoOpenDecisions(): void }>(
      ['decisionSigOf', 'autoOpenDecisions'],
      {
        _sessionCache: cache,
        _cardHost: { 'task:a': host, 'task:b': host, 'task:c': host },
        _cardCol: { 'task:a': 'waiting', 'task:b': 'waiting', 'task:c': 'idle' },
        _expanded: new Set<string>(),
        _autoOpened: Object.create(null),
        quickChoicesOf: (q: any) => (q && q.choices && q.choices.length === 2 ? q.choices : null),
        viewerOwns: () => true,
        isSiblingSession: () => false,
        _quietOpen: { key: '' },
      },
    );
    expect(m.decisionSigOf(cache['task:a'])).toBe('plan|2');
    expect(m.decisionSigOf(cache['task:b'])).toBe('ask|x');
    expect(m.decisionSigOf(cache['task:c'])).toBe('');
    m.autoOpenDecisions();
    expect(reveal).toHaveBeenCalledTimes(2);
    expect(reveal).toHaveBeenCalledWith('task:a', { open: true, scroll: false });
    m.autoOpenDecisions();
    expect(reveal).toHaveBeenCalledTimes(2);
    // Before the viewer is known (/auth/me), nothing is recorded: the call after it opens the card.
    let known = false;
    const late = load<{ autoOpenDecisions(): void }>(['decisionSigOf', 'autoOpenDecisions'], {
      _sessionCache: { 'task:a': awaiting() },
      _cardHost: { 'task:a': host },
      _cardCol: { 'task:a': 'waiting' },
      _expanded: new Set<string>(),
      _autoOpened: Object.create(null),
      quickChoicesOf: () => null,
      viewerOwns: () => known,
      isSiblingSession: () => false,
      _quietOpen: { key: '' },
    });
    reveal.mockClear();
    late.autoOpenDecisions();
    expect(reveal).not.toHaveBeenCalled();
    known = true;
    late.autoOpenDecisions();
    late.autoOpenDecisions();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(clientFn('_applyUserPill')).toContain('autoOpenDecisions();');
    // A board element not upgraded yet (no reveal): nothing recorded; it tries again once the element is defined.
    let defined: () => void = () => {};
    const waits: string[] = [];
    const early = load<{ autoOpenDecisions(): void }>(['decisionSigOf', 'autoOpenDecisions', 'autoOpenWhenDefined'], {
      _sessionCache: { 'task:a': awaiting() },
      _cardHost: { 'task:a': {} as any },
      _cardCol: { 'task:a': 'waiting' },
      _expanded: new Set<string>(),
      _autoOpened: Object.create(null),
      quickChoicesOf: () => null,
      viewerOwns: () => true,
      isSiblingSession: () => false,
      _quietOpen: { key: '' },
      _autoOpenWait: false,
      customElements: {
        whenDefined: (tag: string) => {
          waits.push(tag);
          return new Promise<void>((resolve) => {
            defined = resolve;
          });
        },
      },
      setTimeout: (fn: () => void) => fn(),
    });
    early.autoOpenDecisions();
    early.autoOpenDecisions();
    expect(waits).toEqual(['ui-agent-inbox']);
    expect(typeof defined).toBe('function');
    const toggle = TEMPLATE.slice(
      TEMPLATE.indexOf("host.addEventListener('ui-toggle'"),
      TEMPLATE.indexOf("host.addEventListener('ui-group-toggle'"),
    );
    expect(toggle).toContain('_quietOpen.key !== key');
    expect(clientFn('renderBoard')).toContain('if (!partial) autoOpenDecisions();');
  });
});
