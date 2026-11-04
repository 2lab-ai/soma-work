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
    expect(clientFn('panelHeadData')).toContain("if (a.id === 'star' || a.id === 'rollback') x.pressed = !!a.pressed;");
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
    expect(on.rbTurnButtonHtml({ kind: 'input' }, 't1')).toContain(
      'data-rb-turn="t1">⏪ 이 지시 전으로 되돌리기</button>',
    );
    const locked = load(['rbButtonLabel', 'rbTurnButtonHtml'], {
      esc: (t: string) => t,
      escAttr: (t: string) => t,
      _rb: { view: { refusal: 'busy', refusalText: '작업이 진행 중' } },
    });
    expect(locked.rbTurnButtonHtml({ kind: 'input' }, 't1')).toContain(' disabled title="작업이 진행 중"');
  });
});

describe('the confirmation: the instruction quoted, what leaves, how to take it back', () => {
  const m = load(['rbConfirmHtml'], { esc: (t: string) => t });
  it('an input: "이 지시를 보내기 전으로", the whole instruction, and that it comes back into the composer', () => {
    const html = m.rbConfirmHtml({ kind: 'input', p: VIEW.inputs[0] }, { dropped: 3 });
    expect(html).toContain('이 지시를 보내기 <b>전</b>으로');
    expect(html).toContain('<blockquote class="rb-quote">배포해\n자세히</blockquote>');
    expect(html).toContain('그 뒤의 대화 3개가');
    expect(html).toContain('입력창에 다시 넣어 드려요');
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
  it('the work log and the conversation both draw the mark from those spans', () => {
    const wl = clientFn('wlEntryOf');
    expect(wl).toContain('rewoundBy(st.rewinds');
    expect(wl).toContain('REWOUND_MARK');
    expect(clientFn('wlSyncRewinds')).toContain('var spans = rewindSpansOf(s);');
    expect(clientFn('renderPanelHead')).toContain('wlSyncRewinds();');
    expect(clientFn('loadWorkLog')).toContain('wlSyncRewinds();');
    expect(clientFn('convPaint')).toContain('rewinds: rewindSpansOf(s),');
    expect(clientFn('convTurnsOf')).toContain('rewoundBy(');
    expect(TEMPLATE).toContain("var REWOUND_MARK = '↩︎ 문맥에서 빠짐';");
  });
  it('작업 로그 rows get their buttons after every paint (the element’s own rows)', () => {
    expect(clientFn('wlPaint')).toContain('wlRbSync();');
    const sync = clientFn('wlRbSync');
    expect(sync).toContain("root.querySelectorAll('.wl-entry[data-entry]')");
    expect(sync).toContain('new MutationObserver');
  });
});
