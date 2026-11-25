/**
 * Context rollback — 되돌리기 모드 (2026-11-03, replaces the #744 picker), client half. Executes the
 * shipped client code (cut out of renderDashboardPage()'s template literal and cooked as the browser
 * receives it): the panel head's toggle and Redo (never on the board's card), the points keyed to
 * the entries they sit on, the button a person's instruction gets in 지시와 답변, the confirmation
 * (the instruction quoted), what 되돌리기 sends and the instruction going back into the composer,
 * Redo, and the marks on what a rollback — waiting or applied — drops.
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
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load(fns: string[], inject: Record<string, unknown>, vars = ''): Record<string, (...a: any[]) => any> {
  const names = Object.keys(inject);
  const body = `${vars}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n]));
}

const VIEW = {
  redo: 0,
  inputs: [
    { turnId: 't1', anchor: 'sid~0~a', label: '입력 직전: 배포해', text: '배포해\n자세히', at: 100 },
    { turnId: 't2', anchor: 'sid~0~b', label: '입력 직전: 테스트 다시', text: '테스트 다시', at: 300 },
  ],
  instructions: [{ seq: 1, anchor: 'sid~0~a', label: '입력 직전: 배포해', text: '배포해\n자세히', at: 100 }],
  worklog: [
    { seq: 2, anchor: 'sid~0~c', label: '응답까지: 확인할게요', at: 150, kind: 'narration' },
    { seq: 4, anchor: 'sid~0~d', label: '툴 결과까지: Bash · ls', at: 170, kind: 'tool_result' },
  ],
};

describe('the panel head has 되돌리기 모드 and Redo; the board’s card has neither', () => {
  const inject = (on: boolean) => ({
    STRINGS: {},
    SELF_INSTANCE_NAME: '',
    OWNER_ONLY_MSG: 'owner only',
    viewerCanManage: () => true,
    isBusy: () => false,
    escJs: (t: string) => t,
    esc: (t: string) => t,
    escAttr: (t: string) => t,
    toNum: (v: unknown) => Number(v) || 0,
    rbOn: () => on,
  });
  const card = { key: 'C1:t1', rollbackAvailable: true, sessionState: 'MAIN' };
  it('the toggle reads its state; Redo shows only while there is a rollback to take back', () => {
    const m = load(['sessionActionsOf'], inject(true));
    const off = m.sessionActionsOf(card, 'idle').map((a: any) => a.id);
    expect(off).toContain('rollback');
    expect(off).not.toContain('redo');
    const acts = m.sessionActionsOf({ ...card, rewindRedo: 2 }, 'idle');
    expect(acts.find((a: any) => a.id === 'rollback')).toMatchObject({
      label: '되돌리기 모드',
      icon: 'undo',
      pressed: true,
    });
    expect(acts.find((a: any) => a.id === 'redo')).toMatchObject({ label: '↪︎ Redo' });
  });
  it('the card’s action bar leaves both out', () => {
    expect(clientFn('sessionActionHtml')).toContain("a.id !== 'rollback' && a.id !== 'redo'");
    expect(TEMPLATE).not.toContain('openRollbackDialog(');
  });
  it('the head toggles the mode and runs Redo', () => {
    const head = clientFn('onPanelHeadAction');
    expect(head).toContain("else if (id === 'rollback') rbToggle(key);");
    expect(head).toContain("else if (id === 'redo') rbRedo(key);");
    expect(clientFn('panelHeadData')).toContain("if (a.id === 'rollback') x.pressed = !!a.pressed;");
  });
});

describe('the points sit on their entries', () => {
  const m = load(['wlCallRows', 'rbIndexOf'], {});
  it('an input by its turn id; a work-log instruction, a reply by their seq; a tool result on its call’s card', () => {
    const calls = m.wlCallRows([
      { seq: 3, kind: 'tool', toolUseId: 'u1' },
      { seq: 4, kind: 'tool_result', toolUseId: 'u1' },
      { seq: 9, kind: 'tool_result', toolUseId: 'gone' },
    ]);
    expect(calls).toEqual({ 4: 3 });
    const idx = m.rbIndexOf(VIEW, calls);
    expect(idx.turns.t1).toEqual({ kind: 'input', p: VIEW.inputs[0] });
    expect(idx.rows['1']).toEqual({ kind: 'input', p: VIEW.instructions[0] });
    expect(idx.rows['2']).toEqual({ kind: 'worklog', p: VIEW.worklog[0] });
    expect(idx.rows['3']).toEqual({ kind: 'worklog', p: VIEW.worklog[1] });
    expect(idx.rows['4']).toBeUndefined();
    expect(m.rbIndexOf(null, {})).toEqual({ turns: {}, rows: {} });
  });
});

describe('지시와 답변: a person’s instruction carries the button above its words', () => {
  it('the turn asks for its media slot with the point; the slot writes the button', () => {
    const m = load(['convTurnsOf'], {
      sysTurnInfo: () => null,
      splitInvokedSkills: (t: string) => ({ text: t, skills: [] }),
      decodeSlackEntities: (t: string) => t,
      toNum: (v: unknown) => Number(v) || 0,
      rewoundBy: () => null,
      REWOUND_MARK: 'x',
      convSummaryOf: () => ({}),
      ansCacheKey: () => 'k',
      artInTurn: () => false,
    });
    const pt = { kind: 'input', p: VIEW.inputs[0] };
    const built = m.convTurnsOf(
      [
        { id: 't1', role: 'user', timestamp: 100, rawContent: '배포해', userName: 'Z' },
        { id: 'a1', role: 'assistant', timestamp: 120 },
      ],
      { cid: '', bot: 'Soma', answers: {}, failed: {}, arts: [], rb: { t1: pt } },
    );
    expect(built.turns[0].media).toBe(true);
    expect(built.slots).toEqual([{ name: 'media-t1', kind: 'media', list: [], turn: expect.any(Object), rb: pt }]);
    expect(clientFn('convSlots')).toContain('rbTurnButtonHtml(sl.rb, sl.turn.id)');
  });
  it('the button says what it does; a refusal disables it with the reason', () => {
    const on = load(['rbButtonLabel', 'rbTurnButtonHtml'], {
      esc: (t: string) => t,
      escAttr: (t: string) => t,
      _rb: { view: {} },
    });
    expect(on.rbTurnButtonHtml({ kind: 'input' }, 't1')).toContain('data-rb-turn="t1">⏪ 여기로 되돌리기</button>');
    const locked = load(['rbButtonLabel', 'rbTurnButtonHtml'], {
      esc: (t: string) => t,
      escAttr: (t: string) => t,
      _rb: { view: { refusal: 'busy', refusalText: '작업이 진행 중' } },
    });
    expect(locked.rbTurnButtonHtml({ kind: 'input' }, 't1')).toContain(' disabled title="작업이 진행 중"');
  });
});

describe('지시와 답변: what a rollback drops leaves the chat (SSOT 2026-11-25 "해당 프롬프트까지 히스토리에서 삭제")', () => {
  const span = { from: 99, to: 500, label: '입력 직전: 배포해', pending: true };
  const m = load(['convTurnsOf', 'rewoundBy', 'convRewound'], {
    sysTurnInfo: () => null,
    splitInvokedSkills: (t: string) => ({ text: t, skills: [] }),
    decodeSlackEntities: (t: string) => t,
    toNum: (v: unknown) => Number(v) || 0,
    REWOUND_MARK: '↩︎ 문맥에서 빠짐',
    convSummaryOf: () => ({}),
    ansCacheKey: () => 'k',
    artInTurn: (x: { at: number }, start: number, end: number) => x.at > start && x.at <= end,
  });
  const list = [
    { id: 't0', role: 'user', timestamp: 50, rawContent: '먼저', userName: 'Z' },
    { id: 'a0', role: 'assistant', timestamp: 90 },
    { id: 't1', role: 'user', timestamp: 100, rawContent: '배포해', userName: 'Z' },
    { id: 'a1', role: 'assistant', timestamp: 200 },
    { id: 't2', role: 'user', timestamp: 300, rawContent: '테스트 다시', userName: 'Z' },
  ];
  const ctx = (over: Record<string, unknown> = {}) => ({
    cid: '',
    bot: 'Soma',
    answers: {},
    failed: {},
    arts: [],
    ...over,
  });
  it('the instruction rolled back before and every turn after it are gone; what came before stays, unmarked', () => {
    const built = m.convTurnsOf(list, ctx({ rewinds: [span], rb: { t1: { kind: 'input', p: VIEW.inputs[0] } } }));
    expect(built.turns.map((t: { id: string }) => t.id)).toEqual(['t0', 'a0']);
    expect(built.turns[0].name).toBe('Z');
    expect(built.turns[1].name).toBe('Soma');
    // No slot for a turn that is not there (its button, its files).
    expect(built.slots).toEqual([]);
  });
  // The instruction sent again after the rollback, and its answer.
  const after = [
    ...list,
    { id: 't3', role: 'user', timestamp: 550, rawContent: '고친 지시', userName: 'Z' },
    { id: 'a3', role: 'assistant', timestamp: 600 },
  ];
  it('a file a dropped answer produced does not move to a later answer', () => {
    const built = m.convTurnsOf(
      after,
      ctx({
        rewinds: [span],
        arts: [
          { id: 'f1', at: 150 },
          { id: 'f2', at: 580 },
        ],
      }),
    );
    expect(built.turns.map((t: { id: string }) => t.id)).toEqual(['t0', 'a0', 't3', 'a3']);
    expect(built.slots).toEqual([
      { name: 'attachments-a3', kind: 'arts', list: [{ id: 'f2', at: 580 }], start: 550, end: 600 },
    ]);
  });
  it('a phone call a dropped answer placed does not ride the last turn left in the chat', () => {
    const built = m.convTurnsOf(list, ctx({ rewinds: [span], calls: [{ id: 'p1', createdAt: 150 }] }));
    expect(built.turns.map((t: { id: string }) => t.id)).toEqual(['t0', 'a0']);
    expect(built.slots).toEqual([]);
  });
  it('every turn by its own time: a point inside an answer’s turn drops it; the final reply’s point (its recorded time) keeps it', () => {
    // a0 is recorded at 90; its final work-log point carries 90 (the server's view), a tool result inside it 60.
    const mid = m.convTurnsOf(list, ctx({ rewinds: [{ from: 60, to: 500, label: '툴 결과까지: …', pending: true }] }));
    expect(mid.turns.map((t: { id: string }) => t.id)).toEqual(['t0']);
    const fin = m.convTurnsOf(list, ctx({ rewinds: [{ from: 90, to: 500, label: '최종 답까지: …', pending: true }] }));
    expect(fin.turns.map((t: { id: string }) => t.id)).toEqual(['t0', 'a0']);
  });
  it('a turn the record stamped (the rollback ran) stays out with no span — past the 10 spans a session keeps, after new/renew', () => {
    const stamped = list.map((t) => (t.timestamp >= 100 ? { ...t, rewoundAt: 501 } : t));
    const built = m.convTurnsOf(stamped, ctx({ rewinds: null }));
    expect(built.turns.map((t: { id: string }) => t.id)).toEqual(['t0', 'a0']);
  });
  it('a message the queue holds (its own row) is never hidden', () => {
    const queued = [...list, { id: 'queue-1', role: 'user', timestamp: 250, rawContent: '대기 중', _queued: true }];
    const built = m.convTurnsOf(queued, ctx({ rewinds: [span] }));
    expect(built.turns.map((t: { id: string }) => t.id)).toEqual(['t0', 'a0', 'queue-1']);
  });
  it('this browser’s own instruction sent after the rollback stays (its clock is not the server’s)', () => {
    const own = [
      ...list,
      { id: 'optimistic-1', role: 'user', timestamp: 450, rawContent: '고친 지시', userName: 'Z', _optimistic: true },
    ];
    const built = m.convTurnsOf(own, ctx({ rewinds: [span] }));
    expect(built.turns.map((t: { id: string }) => t.id)).toEqual(['t0', 'a0', 'optimistic-1']);
  });
  it('Redo (no span any more) brings them back', () => {
    const built = m.convTurnsOf(list, ctx({ rewinds: null }));
    expect(built.turns.map((t: { id: string }) => t.id)).toEqual(['t0', 'a0', 't1', 'a1', 't2']);
  });
});

describe('다음 행동: the steps of an answer a rollback took out of the chat are not offered', () => {
  const m = load(['nextActionsOfTurns', 'convRewound', 'rewoundBy'], { toNum: (v: unknown) => Number(v) || 0 });
  const turns = [
    { id: 't0', role: 'user', timestamp: 50 },
    { id: 'a0', role: 'assistant', timestamp: 90, nextActions: [{ label: '배포', command: 'deploy' }] },
    { id: 't1', role: 'user', timestamp: 100 },
    { id: 'a1', role: 'assistant', timestamp: 200, nextActions: [{ label: '머지', command: 'merge' }] },
  ];
  it('the latest answer left in the chat is the one whose steps show (a waiting or applied span)', () => {
    expect(m.nextActionsOfTurns(turns)?.turnId).toBe('a1');
    expect(m.nextActionsOfTurns(turns, [{ from: 99, to: 300, label: 'x' }])?.turnId).toBe('a0');
  });
  it('a turn the record stamped is skipped with no span', () => {
    const stamped = turns.map((t) => (t.timestamp >= 100 ? { ...t, rewoundAt: 301 } : t));
    expect(m.nextActionsOfTurns(stamped)?.turnId).toBe('a0');
  });
  it('the detail card’s bar passes the session’s spans; the API carries the stamp', () => {
    expect(clientFn('renderPanelNext')).toContain(
      "nextActionsOfTurns(_panelTurnsList, typeof rewindSpansOf === 'function' ? rewindSpansOf(s) : null)",
    );
    expect(DASHBOARD_TS).toContain('rewoundAt: t.rewoundAt');
  });
});

describe('the confirmation counts only what leaves the chat now', () => {
  it('turns an earlier rollback already took out of the chat are not counted again', () => {
    const html = vi.fn(() => '');
    const nodes: Record<string, any> = {
      'rollback-dialog': { show: vi.fn() },
      'rollback-body': { innerHTML: '' },
      'rollback-status': { textContent: '', setAttribute: vi.fn(), removeAttribute: vi.fn() },
      'rollback-confirm': { disabled: true },
    };
    const m = load(
      ['rbOpenConfirm', 'rbKeptUntil', 'rewoundBy', 'rewindSpansOf', 'convRewound', 'setRollbackStatus'],
      {
        document: { getElementById: (id: string) => nodes[id] ?? null },
        toNum: (v: unknown) => Number(v) || 0,
        rbConfirmHtml: html,
        rbUnderOf: () => '',
        _rb: { key: 'C1:t1' },
        panelSessionKey: 'C1:t1',
        // An applied rollback took t1 and its answer out (99 → 250); t2 started from the same point.
        _sessionCache: { 'C1:t1': { contextRewinds: [{ from: 99, to: 250, label: 'x', at: 251 }] } },
        _panelTurnsList: [
          { id: 't0', role: 'user', timestamp: 50 },
          { id: 't1', role: 'user', timestamp: 100 },
          { id: 'a1', role: 'assistant', timestamp: 200 },
          { id: 't2', role: 'user', timestamp: 300 },
          { id: 'a2', role: 'assistant', timestamp: 400 },
        ],
      },
      'var _rbPick = null;',
    );
    m.rbOpenConfirm({ kind: 'input', p: { anchor: 'sid~0~a', text: 't2', at: 100 } });
    expect(html).toHaveBeenCalledWith(expect.anything(), { dropped: 2, under: '' });
    expect(nodes['rollback-dialog'].show).toHaveBeenCalled();
  });
  it('counted by the chat’s own rule: the final reply’s point keeps its answer, a point inside the turn does not', () => {
    const html = vi.fn(() => '');
    const nodes: Record<string, any> = {
      'rollback-dialog': { show: vi.fn() },
      'rollback-body': { innerHTML: '' },
      'rollback-status': { textContent: '', setAttribute: vi.fn(), removeAttribute: vi.fn() },
      'rollback-confirm': { disabled: true },
    };
    const m = load(
      ['rbOpenConfirm', 'rbKeptUntil', 'rewoundBy', 'rewindSpansOf', 'convRewound', 'setRollbackStatus'],
      {
        document: { getElementById: (id: string) => nodes[id] ?? null },
        toNum: (v: unknown) => Number(v) || 0,
        rbConfirmHtml: html,
        rbUnderOf: () => '',
        _rb: { key: 'C1:t1' },
        panelSessionKey: 'C1:t1',
        _sessionCache: { 'C1:t1': {} },
        _panelTurnsList: [
          { id: 't0', role: 'user', timestamp: 50 },
          { id: 'a0', role: 'assistant', timestamp: 90 },
          { id: 't1', role: 'user', timestamp: 100 },
          { id: 'a1', role: 'assistant', timestamp: 200 },
          { id: 'queue-1', role: 'user', timestamp: 250, _queued: true },
        ],
      },
      'var _rbPick = null;',
    );
    // Kept: a0's final reply — its point carries a0's recorded time (90). The queue's row is never counted.
    m.rbOpenConfirm({ kind: 'worklog', p: { anchor: 'sid~0~c', label: '최종 답까지: …', at: 90, seq: 3 } });
    expect(html).toHaveBeenLastCalledWith(expect.anything(), { dropped: 2, under: '' });
    // A tool result inside a0's turn (60): a0 leaves too.
    m.rbOpenConfirm({ kind: 'worklog', p: { anchor: 'sid~0~d', label: '툴 결과까지: …', at: 60, seq: 2 } });
    expect(html).toHaveBeenLastCalledWith(expect.anything(), { dropped: 3, under: '' });
  });
});

describe('the confirmation: the instruction quoted, what leaves, how to take it back', () => {
  const m = load(['rbConfirmHtml'], { esc: (t: string) => t });
  it('an input: "이 지시를 보내기 전으로", the whole instruction, that it leaves the chat and comes back into the 지시창', () => {
    const html = m.rbConfirmHtml({ kind: 'input', p: VIEW.inputs[0] }, { dropped: 3 });
    expect(html).toContain('이 지시를 보내기 <b>전</b>으로 대화를 되돌립니다.');
    expect(html).toContain('<blockquote class="rb-quote">배포해\n자세히</blockquote>');
    expect(html).toContain('이 지시와 그 뒤의 대화 3개가 채팅과 모델 문맥에서 빠지고');
    expect(html).toContain('이 지시는 지시창에 다시 들어갑니다');
    expect(html).toContain('↪︎ Redo');
  });
  it('a work-log point: it stays, and the instruction it belongs to is shown', () => {
    const html = m.rbConfirmHtml({ kind: 'worklog', p: VIEW.worklog[1] }, { dropped: 0, under: '배포해' });
    expect(html).toContain('이 지점까지 유지하고');
    expect(html).toContain('툴 결과까지: Bash · ls');
    expect(html).toContain('<blockquote class="rb-quote rb-under">배포해</blockquote>');
  });
});

describe('되돌리기 sends the point; the instruction goes back into the composer; Redo takes it back', () => {
  function setup(answers: Array<{ status: number; body: unknown }>) {
    const nodes: Record<string, any> = {
      'rollback-dialog': {
        shown: true,
        hide() {
          this.shown = false;
        },
        show() {
          this.shown = true;
        },
      },
      'rollback-status': { textContent: '', setAttribute: vi.fn(), removeAttribute: vi.fn() },
      'rollback-confirm': { disabled: false },
      'pc-composer': { value: '', focus: vi.fn() },
    };
    const posts: any[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      posts.push(JSON.parse(String(init?.body)));
      const a = answers.shift() ?? { status: 200, body: { ok: true } };
      return { ok: a.status < 300, status: a.status, json: async () => a.body };
    });
    const m = load(
      ['setRollbackStatus', 'closeRollbackDialog', 'rbConfirm', 'rbRedo', 'postRollback', 'rbOn'],
      {
        document: { getElementById: (id: string) => nodes[id] ?? null },
        fetch: fetchMock,
        dashToast: vi.fn(),
        loadSessions: vi.fn(async () => undefined),
        refreshCsrfToken: vi.fn(async () => undefined),
        rbLoad: vi.fn(async () => undefined),
        _csrfToken: 'csrf',
        panelSessionKey: 'C1:t1',
        _rb: null,
      },
      'var _rbPick = null; var _rbPrefill = null;',
    );
    return { m, nodes, posts };
  }
  it('an input: anchor, label, source, its time and the instruction; the field gets the instruction back', async () => {
    const { nodes, posts } = setup([{ status: 200, body: { ok: true } }]);
    // The confirmation's point (set by rbOpenConfirm in the page).
    const page = load(
      ['setRollbackStatus', 'closeRollbackDialog', 'rbConfirm', 'rbRedo', 'postRollback', 'rbOn'],
      {
        document: { getElementById: (id: string) => nodes[id] ?? null },
        // Phone chrome T4 (SSOT 2026-11-04): the composer comes back before it takes the instruction — a seam here.
        rdTuck: () => {},
        fetch: vi.fn(async (_u: string, init?: { body?: string }) => {
          posts.push(JSON.parse(String(init?.body)));
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }),
        dashToast: vi.fn(),
        loadSessions: vi.fn(async () => undefined),
        refreshCsrfToken: vi.fn(async () => undefined),
        rbLoad: vi.fn(async () => undefined),
        _csrfToken: 'csrf',
        panelSessionKey: 'C1:t1',
        _rb: null,
      },
      `var _rbPick = { key: 'C1:t1', kind: 'input', p: ${JSON.stringify(VIEW.inputs[0])} }; var _rbPrefill = null;`,
    );
    await page.rbConfirm();
    expect(posts[posts.length - 1]).toEqual({
      anchor: 'sid~0~a',
      label: '입력 직전: 배포해',
      source: 'input',
      at: 100,
      text: '배포해\n자세히',
    });
    expect(nodes['rollback-dialog'].shown).toBe(false);
    expect(nodes['pc-composer'].value).toBe('배포해\n자세히');
    expect(nodes['pc-composer'].focus).toHaveBeenCalled();
    // Redo: the server takes the rollback back, and the untouched instruction leaves the field.
    await page.rbRedo('C1:t1');
    expect(posts[posts.length - 1]).toEqual({ redo: true });
    expect(nodes['pc-composer'].value).toBe('');
  });
  it('a work-log point keeps the field alone; a refusal stays in the dialog with its words', async () => {
    const nodes: Record<string, any> = {
      'rollback-dialog': {
        shown: true,
        hide() {
          this.shown = false;
        },
      },
      'rollback-status': { textContent: '', setAttribute: vi.fn(), removeAttribute: vi.fn() },
      'rollback-confirm': { disabled: false },
      'pc-composer': { value: 'draft', focus: vi.fn() },
    };
    const posts: any[] = [];
    const page = load(
      ['setRollbackStatus', 'closeRollbackDialog', 'rbConfirm', 'postRollback', 'rbOn'],
      {
        document: { getElementById: (id: string) => nodes[id] ?? null },
        fetch: vi.fn(async (_u: string, init?: { body?: string }) => {
          posts.push(JSON.parse(String(init?.body)));
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: '작업이 진행 중이라 지금은 되돌릴 수 없습니다.' }),
          };
        }),
        dashToast: vi.fn(),
        loadSessions: vi.fn(async () => undefined),
        refreshCsrfToken: vi.fn(async () => undefined),
        rbLoad: vi.fn(async () => undefined),
        _csrfToken: 'csrf',
        panelSessionKey: 'C1:t1',
        _rb: null,
      },
      `var _rbPick = { key: 'C1:t1', kind: 'worklog', p: ${JSON.stringify(VIEW.worklog[0])} }; var _rbPrefill = null;`,
    );
    await page.rbConfirm();
    expect(posts[0]).toEqual({ anchor: 'sid~0~c', label: '응답까지: 확인할게요', source: 'worklog', at: 150 });
    expect(nodes['rollback-dialog'].shown).toBe(true);
    expect(nodes['rollback-status'].textContent).toContain('진행 중');
    expect(nodes['rollback-confirm'].disabled).toBe(false);
    expect(nodes['pc-composer'].value).toBe('draft');
  });
  it('the setup helper is wired (fetch answers in order)', async () => {
    const { m, posts } = setup([{ status: 409, body: { error: '되돌리기를 취소할 것이 없습니다' } }]);
    await m.rbRedo('C1:t1');
    expect(posts[0]).toEqual({ redo: true });
  });
});

describe('marks on what a rollback drops — waiting or applied (client)', () => {
  const fn = new Function(`${clientFn('rewoundBy')}\nreturn rewoundBy;`)() as (r: unknown, ts: number) => unknown;
  const spans = [
    { from: 10, to: 20, label: 'a', at: 21 },
    { from: 30, to: 40, label: 'b', at: 41 },
  ];
  it('an entry or turn made after the kept point and up to the request is dropped', () => {
    expect(fn(spans, 10)).toBeNull();
    expect(fn(spans, 11)).toEqual(spans[0]);
    expect(fn(spans, 20)).toEqual(spans[0]);
    expect(fn(spans, 25)).toBeNull();
    expect(fn(spans, 35)).toEqual(spans[1]);
    expect(fn(undefined, 15)).toBeNull();
    expect(fn(spans, Number.NaN)).toBeNull();
  });
  it('a waiting rollback marks what it will drop at once (kept point → when it was asked)', () => {
    const spansOf = new Function(`${clientFn('rewindSpansOf')}\nreturn rewindSpansOf;`)() as (s: unknown) => unknown;
    expect(spansOf(null)).toBeNull();
    expect(spansOf({})).toBeNull();
    expect(spansOf({ contextRewinds: spans })).toEqual(spans);
    expect(
      spansOf({ contextRewinds: [spans[0]], pendingRewind: { label: 'p', requestedAt: 90, keptUntil: 50 } }),
    ).toEqual([spans[0], { from: 50, to: 90, label: 'p', pending: true }]);
    // No kept point (an older request): nothing to mark.
    expect(spansOf({ pendingRewind: { label: 'p', requestedAt: 90 } })).toBeNull();
  });
  it('the work log marks what the spans drop; the conversation leaves it out', () => {
    const wl = clientFn('wlEntryOf');
    expect(wl).toContain('rewoundBy(st.rewinds');
    expect(wl).toContain('REWOUND_MARK');
    expect(clientFn('wlSyncRewinds')).toContain('var spans = rewindSpansOf(s);');
    expect(clientFn('renderPanelHead')).toContain('wlSyncRewinds();');
    expect(clientFn('loadWorkLog')).toContain('wlSyncRewinds();');
    expect(clientFn('convPaint')).toContain('rewinds: rewindSpansOf(s),');
    expect(clientFn('convTurnsOf')).toContain('convRewound(t, c.rewinds)');
    expect(clientFn('convRewound')).toContain('rewoundBy(spans');
    expect(TEMPLATE).toContain("var REWOUND_MARK = '↩︎ 문맥에서 빠짐';");
  });
  it('작업 로그 rows get their buttons after every paint (the element’s own rows)', () => {
    expect(clientFn('wlPaint')).toContain('wlRbSync();');
    const sync = clientFn('wlRbSync');
    expect(sync).toContain("root.querySelectorAll('.wl-entry[data-entry]')");
    expect(sync).toContain('new MutationObserver');
  });
});
