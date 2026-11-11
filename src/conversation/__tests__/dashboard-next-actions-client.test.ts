import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';

/**
 * Next actions as buttons — the page side (SSOT 2026-11-11, Z): "이렇게 대화 완료(대기)처리된후에 다음 행동을 3개씩
 * 주는데 이걸 버튼으로 표현해줘. 카드 펼쳤을때랑 디테일에 버튼으로 보여줘. 기존 입력처림할지 어떻게 할지는 니가
 * 리서치해서 알아서 1안으로 처리"
 *
 * The latest answer's steps (the turn's `nextActions`, read by the server) are buttons on the open task card and
 * right above the detail card's composer, once the turn is over and nothing else is asked. One press sends the
 * step's command as the viewer's instruction on the composer's own route.
 */

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
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}, extra = ''): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\n${extra}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const STEPS = [
  { label: 'dev에 배포해서 확인합니다', command: '$user:dev', recommended: true },
  { label: '확인 후 prod에 배포합니다', command: '$user:prod' },
  { label: '', command: '1193 진행' },
];
const SESSION = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  conversationId: 'conv-1',
  ownerId: 'U1',
  activityState: 'idle',
  ...over,
});
const GATE_FNS = ['nextActionsOpen', 'pcModeOf', 'turnHolds'];
const BASE_INJECT = (over: Record<string, unknown> = {}) => ({
  NEXT_ACTIONS_LABEL: '다음 행동',
  currentUserId: 'U1',
  READ_ONLY_MSG: '읽기 전용 — 내 세션이 아닙니다',
  isSiblingSession: () => false,
  _naSent: Object.create(null),
  _busy: Object.create(null),
  ...over,
});
const HTML_FNS = [...GATE_FNS, 'nextActionsHtml', 'isBusy', 'esc', 'escAttr'];

describe('nextActionsOfTurns — the latest answer, until an instruction follows it', () => {
  const c = load<{ nextActionsOfTurns(t: unknown): { turnId: string; list: unknown[] } | null }>([
    'nextActionsOfTurns',
  ]);

  it('the answer after the latest instruction; the Executive Summary turn counts', () => {
    expect(
      c.nextActionsOfTurns([
        { id: 'u1', role: 'user' },
        { id: 'a1', role: 'assistant' },
        { id: 'es', role: 'assistant', executiveSummary: true, nextActions: STEPS },
      ]),
    ).toEqual({ turnId: 'es', list: STEPS });
  });

  it('an instruction after it — a person, the host or this browser’s pending one — takes them away', () => {
    expect(
      c.nextActionsOfTurns([
        { id: 'a1', role: 'assistant', nextActions: STEPS },
        { id: 'optimistic-1', role: 'user', _optimistic: true },
      ]),
    ).toBeNull();
  });

  it('no steps anywhere, or no turns: null', () => {
    expect(c.nextActionsOfTurns([{ id: 'a1', role: 'assistant' }])).toBeNull();
    expect(c.nextActionsOfTurns(undefined)).toBeNull();
  });
});

describe('nextActionsOpen — only once the turn is over and nothing else is asked', () => {
  const open = (s: unknown, inject: Record<string, unknown> = {}) =>
    load<{ nextActionsOpen(s: unknown): boolean }>(GATE_FNS, BASE_INJECT(inject)).nextActionsOpen(s);

  it('a finished task the viewer may instruct: open', () => {
    expect(open(SESSION())).toBe(true);
    expect(open(SESSION({ activityState: 'waiting' }))).toBe(true);
  });

  it('a running turn, or one dispatched and not settled: not yet', () => {
    expect(open(SESSION({ activityState: 'working' }))).toBe(false);
    expect(open(SESSION({ turnBusy: true }))).toBe(false);
  });

  it('a question, a permission, a plan to start or the goal decision comes first', () => {
    expect(open(SESSION({ activityState: 'waiting', pendingQuestion: { type: 'user_choice' } }))).toBe(false);
    expect(open(SESSION({ pendingPermissions: [{ id: 'p' }] }))).toBe(false);
    expect(open(SESSION({ taskPlan: { state: 'awaiting', revision: 1 } }))).toBe(false);
    expect(open(SESSION({ pendingGoalDecision: { id: 'g' } }))).toBe(false);
    expect(open(SESSION({ pendingPermissions: [] }))).toBe(true);
  });

  it('ended, asleep, another instance’s, or a viewer who may not instruct it: never', () => {
    expect(open(SESSION({ terminated: true }))).toBe(false);
    expect(open(SESSION({ sessionState: 'SLEEPING' }))).toBe(false);
    expect(open(SESSION(), { isSiblingSession: () => true })).toBe(false);
    // someone else's DM needs manage rights
    expect(open(SESSION({ channelId: 'D1', ownerId: 'U2' }))).toBe(false);
  });
});

describe('nextActionsHtml — the buttons', () => {
  const html = (s: unknown, na: unknown, inject: Record<string, unknown> = {}) =>
    load<{ nextActionsHtml(s: unknown, na: unknown, where: string): string }>(
      HTML_FNS,
      BASE_INJECT(inject),
    ).nextActionsHtml(s, na, 'card');

  it('one button per step: what it does, the command it sends; (권장) is the one primary', () => {
    const out = html(SESSION(), { turnId: 'a1', list: STEPS });
    const buttons = [...out.matchAll(/<button([^>]*)>(.*?)<\/button>/g)];
    expect(buttons).toHaveLength(3);
    expect(buttons[0][1]).toContain('is-primary');
    expect(buttons[1][1]).not.toContain('is-primary');
    expect(buttons[0][2]).toBe(
      '<span class="na-label">dev에 배포해서 확인합니다</span><code class="na-cmd">$user:dev</code>',
    );
    // No label: the command is the button's words, said once.
    expect(buttons[2][2]).toBe('<span class="na-label">1193 진행</span>');
    expect(buttons.map((b) => /data-na-cmd="([^"]*)"/.exec(b[1])?.[1])).toEqual([
      '$user:dev',
      '$user:prod',
      '1193 진행',
    ]);
    expect(out).toContain('aria-label="다음 행동"');
    expect(out).toContain('nextActionButton(this)');
  });

  it('the command is attribute data, escaped — never inline JS', () => {
    const out = html(SESSION(), { turnId: 'a1', list: [{ label: '<b>x</b>', command: `'); alert(1); ("` }] });
    expect(out).not.toContain('<b>x</b>');
    expect(out).toContain('data-na-cmd="&#39;); alert(1); (&quot;"');
    expect(out).not.toMatch(/onclick="[^"]*alert/);
  });

  it('nothing when the gate is closed, the steps are empty, or this answer’s step was sent', () => {
    expect(html(SESSION({ activityState: 'working' }), { turnId: 'a1', list: STEPS })).toBe('');
    expect(html(SESSION(), { turnId: 'a1', list: [] })).toBe('');
    expect(html(SESSION(), null)).toBe('');
    expect(html(SESSION(), { turnId: 'a1', list: STEPS }, { _naSent: { 'inst::C1:t1': 'a1' } })).toBe('');
    // a newer answer's steps show again
    expect(html(SESSION(), { turnId: 'a2', list: STEPS }, { _naSent: { 'inst::C1:t1': 'a1' } })).not.toBe('');
  });

  it('a send in flight holds every button', () => {
    const out = html(SESSION(), { turnId: 'a1', list: STEPS }, { _busy: { 'inst::C1:t1|next': true } });
    expect(out.match(/disabled aria-busy="true"/g)).toHaveLength(3);
  });
});

describe('the open task card', () => {
  it('reads the steps its 지시/응답 fetch brought; none on an ended card', () => {
    const io = { 'conv-1': { state: 'ok', stamp: '', data: { nextActions: { turnId: 'a1', list: STEPS } } } };
    const c = load<{ cardNextActionsHtml(s: unknown, col: string): string }>(
      [...HTML_FNS, 'cardNextActionsHtml'],
      BASE_INJECT({ _ioCache: io }),
    );
    expect(c.cardNextActionsHtml(SESSION(), 'idle')).toContain('$user:dev');
    expect(c.cardNextActionsHtml(SESSION(), 'waiting')).toContain('$user:dev');
    expect(c.cardNextActionsHtml(SESSION(), 'closed')).toBe('');
    expect(c.cardNextActionsHtml(SESSION({ conversationId: 'conv-2' }), 'idle')).toBe('');
  });

  it('only from a current fetch: not while it refetches, after it failed, or for an older activity (trinity R1)', () => {
    const data = { nextActions: { turnId: 'a1', list: STEPS } };
    const html = (entry: unknown, s = SESSION({ lastActivity: '2026-11-11T10:00:00.000Z' })) =>
      load<{ cardNextActionsHtml(s: unknown, col: string): string }>(
        [...HTML_FNS, 'cardNextActionsHtml'],
        BASE_INJECT({ _ioCache: { 'conv-1': entry } }),
      ).cardNextActionsHtml(s, 'idle');
    expect(html({ state: 'ok', stamp: '2026-11-11T10:00:00.000Z', data })).toContain('$user:dev');
    expect(html({ state: 'loading', stamp: '2026-11-11T10:00:00.000Z', data })).toBe('');
    expect(html({ state: 'error', stamp: '2026-11-11T10:00:00.000Z', data })).toBe('');
    expect(html({ state: 'ok', stamp: '2026-11-11T09:00:00.000Z', data })).toBe('');
    // a landed turn invalidates the entry (invalidateCardIo sets its stamp to null)
    expect(html({ state: 'ok', stamp: null, data })).toBe('');
  });

  it('its body draws them with what it needs — after the question, before the rest', () => {
    const body = clientFn('renderCardBody');
    expect(body).toMatch(/\+ questionHtml\s*\+ cardNextActionsHtml\(s, col\);/);
  });

  it('the 지시/응답 fetch keeps the steps of the latest answer, the Executive Summary’s included', async () => {
    const turns = [
      { id: 'u1', role: 'user', rawContent: 'go', userName: 'Z' },
      { id: 'a1', role: 'assistant', summaryTitle: 'done', summaryBody: 'b' },
      { id: 'es', role: 'assistant', executiveSummary: true, summaryTitle: 'ES', nextActions: STEPS },
    ];
    const c = load<{ fetchCardIo(cid: string): Promise<any> }>(['fetchCardIo', 'nextActionsOfTurns'], {
      fetch: async () => ({ ok: true, json: async () => ({ turns }) }),
      decodeSlackEntities: (x: string) => x,
      umRegister: () => undefined,
    });
    const d = await c.fetchCardIo('conv-1');
    expect(d.response).toEqual({ title: 'done', body: 'b' });
    expect(d.nextActions).toEqual({ turnId: 'es', list: STEPS });
  });
});

describe('the detail card — right above its composer', () => {
  function panel(inject: Record<string, unknown>) {
    const bar: any = { hidden: true, innerHTML: '', _html: '' };
    const c = load<{ renderPanelNext(): void }>(
      [...HTML_FNS, 'renderPanelNext', 'nextActionsOfTurns'],
      BASE_INJECT({
        document: { getElementById: (id: string) => (id === 'panel-next-bar' ? bar : null) },
        panelOpen: true,
        panelSessionKey: 'inst::C1:t1',
        _sessionCache: { 'inst::C1:t1': SESSION() },
        _panelTurnsCid: 'conv-1',
        _panelTurnsList: [
          { id: 'u1', role: 'user' },
          { id: 'a1', role: 'assistant', nextActions: STEPS },
        ],
        ...inject,
      }),
    );
    c.renderPanelNext();
    return bar;
  }

  it('the bar shows the latest answer’s steps', () => {
    const bar = panel({});
    expect(bar.hidden).toBe(false);
    expect(bar.innerHTML).toContain('$user:prod');
  });

  it('hidden for a conversation it does not show yet, or once an instruction follows', () => {
    expect(panel({ _panelTurnsCid: 'conv-other' }).hidden).toBe(true);
    expect(
      panel({
        _panelTurnsList: [
          { id: 'a1', role: 'assistant', nextActions: STEPS },
          { id: 'u2', role: 'user' },
        ],
      }).hidden,
    ).toBe(true);
    expect(panel({ panelOpen: false }).hidden).toBe(true);
  });

  it('the page has the bar right after the plan bar, inside the command row', () => {
    const plan = TEMPLATE.indexOf('id="panel-plan-bar"');
    const next = TEMPLATE.indexOf('id="panel-next-bar"');
    const steer = TEMPLATE.indexOf('<ui-agent-steering id="cmd-steer"');
    expect(plan).toBeGreaterThan(0);
    expect(next).toBeGreaterThan(plan);
    expect(steer).toBeGreaterThan(next);
  });
});

describe('a press — the step goes as the viewer’s instruction (1안: the composer’s own route)', () => {
  function press(inject: Record<string, unknown>) {
    const posts: Array<[string, any]> = [];
    const toasts: any[] = [];
    const sent: string[] = [];
    const naSent: Record<string, string> = Object.create(null);
    const c = load<{ sendNextAction(key: string, turnId: string, cmd: string): Promise<void> }>(
      [...GATE_FNS, 'sendNextAction', 'nextActionPost', 'isBusy', 'setBusy', 'pcCommandBody'],
      BASE_INJECT({
        _naSent: naSent,
        _sessionCache: { 'inst::C1:t1': SESSION() },
        panelOpen: false,
        panelSessionKey: '',
        nextActionsRepaint: () => undefined,
        loadSessions: () => undefined,
        pcThreadAnswerToast: () => ({ title: 'thread' }),
        dashToast: (t: unknown) => toasts.push(t),
        acPost: async (url: string, body: string) => {
          posts.push([url, JSON.parse(body)]);
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        },
        sendCommand: async (text: string) => {
          sent.push(text);
          return true;
        },
        effortSettled: async () => null,
        ...inject,
      }),
    );
    return { c, posts, toasts, sent, naSent };
  }

  it('from the board: the command route with the command as the message; the answer’s buttons go', async () => {
    const p = press({});
    await p.c.sendNextAction('inst::C1:t1', 'a1', '$user:dev');
    expect(p.posts).toEqual([['/api/dashboard/session/inst%3A%3AC1%3At1/command', { message: '$user:dev' }]]);
    expect(p.sent).toEqual([]);
    expect(p.naSent['inst::C1:t1']).toBe('a1');
    expect(p.toasts[0]).toMatchObject({ title: '다음 행동을 보냈어요', tone: 'success' });
  });

  it('with the detail card open on it: the composer’s own send', async () => {
    const p = press({ panelOpen: true, panelSessionKey: 'inst::C1:t1' });
    await p.c.sendNextAction('inst::C1:t1', 'a1', '1193 진행');
    expect(p.sent).toEqual(['1193 진행']);
    expect(p.posts).toEqual([]);
    expect(p.naSent['inst::C1:t1']).toBe('a1');
  });

  it('refused: said in a toast, the buttons stay', async () => {
    const p = press({
      acPost: async () => ({ ok: false, status: 403, json: async () => ({ error: 'nope' }) }),
    });
    await p.c.sendNextAction('inst::C1:t1', 'a1', '$user:dev');
    expect(p.naSent['inst::C1:t1']).toBeUndefined();
    expect(p.toasts[0]).toMatchObject({
      title: '메시지를 보내지 못했어요',
      description: 'nope (HTTP 403)',
      tone: 'error',
    });
  });

  it('someone else’s task: it waits for the owner, as typed words would', async () => {
    const p = press({
      acPost: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, pendingApproval: true }) }),
    });
    await p.c.sendNextAction('inst::C1:t1', 'a1', '$user:dev');
    expect(p.toasts[0]).toMatchObject({ title: '작업 소유자의 승인을 기다려요', tone: 'wait' });
  });

  it('a level picked just before goes first; a refused switch sends nothing (trinity R1)', async () => {
    const p = press({ effortSettled: async () => ({ ok: false, error: 'busy' }) });
    await p.c.sendNextAction('inst::C1:t1', 'a1', '$user:dev');
    expect(p.posts).toEqual([]);
    expect(p.naSent['inst::C1:t1']).toBeUndefined();
    expect(p.toasts[0]).toMatchObject({ title: '메시지를 보내지 못했어요', tone: 'error' });
    expect(String(p.toasts[0].description)).toContain('busy');
  });

  it('a running turn: nothing is sent', async () => {
    const p = press({ _sessionCache: { 'inst::C1:t1': SESSION({ activityState: 'working' }) } });
    await p.c.sendNextAction('inst::C1:t1', 'a1', '$user:dev');
    expect(p.posts).toEqual([]);
    expect(p.sent).toEqual([]);
  });

  it('the composer’s send says whether it went (true), so the press can let the buttons go', () => {
    const fn = clientFn('sendCommand');
    expect(fn).toContain('if (!why) return true;');
  });
});
