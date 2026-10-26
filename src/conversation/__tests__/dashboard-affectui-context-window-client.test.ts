/**
 * re-context-window D5–D20 (.prd/affectui/re-context-window.md §4.2–4.10) —
 * the context block at the top of the panel's open 세션 정보: a field of 216
 * cells (one per window/216 tokens) filled by the request's cache categories,
 * the auto-compact point on it, levels against that point, a hover link
 * between rows and cells, and one owner-gated "지금 압축" (`compact --yes`).
 * Executes the shipped client code cut out of renderDashboardPage()'s template
 * literal, cooked exactly as the browser receives it (the harness of
 * dashboard-three-surfaces-client.test.ts).
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
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
function clientFn(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  const names = Object.keys(inject);
  const extraNames = extra.map((src) => /^function (\w+)/.exec(src)?.[1] ?? '').filter(Boolean);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${[...fns, ...extraNames].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The page's CSS as written in the template (the <style> block). */
const CSS = TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>'));

const NOW = 1_800_000_000_000;
const READ_ONLY = 'Read-only — not your session';
const CW_FNS = [
  'esc',
  'escAttr',
  'toNum',
  'formatTokens',
  'ctxLevel',
  'cwShort',
  'cwParts',
  'cwCells',
  'cwMarkIndex',
  'cwPhase',
  'cwSay',
  'cwCanCompact',
  'cwCompactHtml',
  'contextBlockHtml',
];
const CW_VARS = [
  'CW_CELLS',
  'CW_PARTS',
  'CW_UNSPLIT',
  'CW_ANNOUNCE',
  'CW_ARM_MS',
  'CW_DONE_MS',
  'CW_LEAVE_MS',
  'CW_SAVED_MS',
  'CW_FAIL_MS',
  'CW_CEIL_MS',
  'CW_COMPACT_SVG',
  'CW_CHECK_SVG',
  '_cw',
];
const STATE = ['function cwTestState() { return _cw; }', 'function cwTestSet(o) { _cw = o; }'];
type Cw = {
  cwShort(n: number): string;
  cwParts(cp: unknown): { key: string; label: string; tokens: number; color: string }[];
  cwCells(parts: { tokens: number }[], limit: number, cells: number): number[];
  cwMarkIndex(auto: unknown, limit: unknown, cells: number): number;
  ctxLevel(pct: unknown, used?: unknown, auto?: unknown, pending?: unknown): string;
  cwPhase(s: unknown, now: number): string;
  cwSay(
    s: unknown,
    used: number,
    auto: number,
    win: number,
    lv: string,
    phase: string,
    now: number,
  ): { id: string; tone: string; html: string; sr?: string };
  cwCompactHtml(s: unknown, phase: string, used: number): string;
  contextBlockHtml(s: unknown, now?: number): string;
  cwTestState(): Record<string, number | string | boolean>;
  cwTestSet(o: Record<string, number | string | boolean>): void;
};
const ENV = {
  currentUserId: 'U1',
  READ_ONLY_MSG: READ_ONLY,
  isSiblingSession: (s: { environment?: { instanceName?: string } }) =>
    !!s.environment && s.environment.instanceName === 'other',
};
const cw = () => load<Cw>(CW_FNS, CW_VARS, ENV, STATE);
const freshState = (key = 'inst::C1:t1', extra: Record<string, number | string | boolean> = {}) => ({
  key,
  count: 0,
  armedAt: 0,
  busySince: 0,
  sentAt: 0,
  queued: false,
  doneAt: 0,
  observedAt: 0,
  savedWait: 0,
  usedAtRise: 0,
  lcSeen: '',
  lcAtRise: '',
  savedAt: 0,
  failAt: 0,
  timedOutAt: 0,
  ...extra,
});

/** A live session: the last request read 412,000 tokens of a 1M window; compacts at 750K. */
const sess = (over: Record<string, unknown> = {}, parts: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  ownerId: 'U1',
  model: 'claude-opus-5-5[1m]',
  activityState: 'idle',
  compactionCount: 0,
  tokenUsage: { totalInputTokens: 900_000, contextUsagePercent: 41.2 },
  contextTokens: 412_000,
  autoCompactTokens: 750_000,
  contextParts: { window: 1_000_000, cacheRead: 354_320, cacheWrite: 16_480, input: 32_960, output: 8_240, ...parts },
  ...over,
});
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('D5/D6/D18 — the block: head, figure, field, parts in prompt order, foot', () => {
  it('renders one labelled group with the model tag, the rolling figure, 216 cells and the parts', () => {
    const html = cw().contextBlockHtml(sess(), NOW);
    expect(html.startsWith('<section class="cw" role="group" aria-labelledby="cw-title" data-level="ok">')).toBe(true);
    expect(html).toContain(
      '<span class="cw-title" id="cw-title">컨텍스트</span><span class="cw-model">opus-5-5[1m]</span>',
    );
    expect(html).toContain('<span class="cw-big" aria-hidden="true" data-to="412000">412.0K</span>');
    expect(html).toContain('<span class="cw-of" aria-hidden="true" data-total="/ 1M 토큰">/ 1M 토큰</span>');
    expect(html).toContain('<span class="cw-pill" aria-hidden="true">41%</span>');
    expect(html).toContain('<span class="cw-sr">컨텍스트 412.0K / 1M 토큰 사용, 41%, 자동 압축 750K</span>');
    expect(html).toContain('<div class="cw-field" aria-hidden="true">');
    expect(count(html, '<i class="cw-cell"')).toBe(216);
    expect(html).toContain('<span class="cw-say"><span class="cw-say-t"');
    const order = ['read', 'write', 'input', 'output'].map((k) => html.indexOf(`<li class="cw-part" data-part="${k}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain(
      '<li class="cw-part" data-part="read" data-tok="354320" data-of="이전 맥락 (캐시 읽기) · 창의 35%"><i class="cw-sw" style="background:var(--cw-c1)"></i><span class="cw-label">이전 맥락 (캐시 읽기)</span><span class="cw-val">354.3K</span></li>',
    );
    expect(html).toContain('<span class="cw-label">새로 캐시 (캐시 쓰기)</span>');
    expect(html).toContain('<span class="cw-label">캐시 안 된 입력</span>');
    // Under 10% of the window the share keeps one decimal.
    expect(html).toContain('data-part="output" data-tok="8240" data-of="마지막 출력 · 창의 0.8%"');
    expect(html).toContain(
      '<li class="cw-mark"><i class="cw-sw is-mark"></i><span class="cw-label">자동 압축 지점</span><span class="cw-val">750K</span></li>',
    );
  });

  it('a part at zero is left out of the list and the field', () => {
    const html = cw().contextBlockHtml(sess({}, { cacheWrite: 0 }), NOW);
    expect(html).not.toContain('data-part="write"');
    expect(cw().cwParts({ window: 1, cacheRead: 0, cacheWrite: 0, input: 0, output: 0 })).toEqual([]);
  });

  it('D6 — one unsplit total is said as what it is, never as a cache category', () => {
    const compacted = cw().contextBlockHtml(
      sess({ contextTokens: 64_000 }, { cacheRead: 0, cacheWrite: 0, input: 64_000, output: 0, unsplit: 'compact' }),
      NOW,
    );
    expect(compacted).toContain('data-part="total"');
    expect(compacted).toContain('<span class="cw-label">압축 후 맥락</span>');
    expect(compacted).not.toContain('캐시 안 된 입력');
    const unknown = cw().contextBlockHtml(
      sess({}, { cacheRead: 0, cacheWrite: 0, input: 64_000, output: 0, unsplit: 'unknown' }),
      NOW,
    );
    expect(unknown).toContain('<span class="cw-label">맥락 (분류 없음)</span>');
  });

  it('no parts on the card (archived, no usage): no block', () => {
    expect(cw().contextBlockHtml(sess({ contextParts: undefined }), NOW)).toBe('');
    expect(cw().contextBlockHtml(sess({}, { window: 0 }), NOW)).toBe('');
  });

  it('D18 — the old 4px bar and its line are gone from 세션 정보 and the CSS', () => {
    expect(clientFn('panelInfoHtml')).not.toContain('context-bar');
    expect(clientFn('panelInfoHtml')).not.toContain('pi-ctx');
    expect(CSS).not.toContain('.pi-ctx');
  });

  it('D5 — panelInfoHtml opens with the block from one call; the old bar line is gone', () => {
    const src = clientFn('panelInfoHtml');
    expect(src).toContain(`'<div class="pi-body" id="panel-info-body">' + contextBlockHtml(s) + body`);
    expect(count(src, 'contextBlockHtml(')).toBe(1);
  });
});

describe('D7 — the field: one cell per window/216 tokens, every non-empty part at least one cell', () => {
  it('allocates by cumulative rounding in part order, the rest free', () => {
    const map = cw().cwCells(
      [{ tokens: 354_320 }, { tokens: 16_480 }, { tokens: 32_960 }, { tokens: 8_240 }],
      1_000_000,
      216,
    );
    expect(map).toHaveLength(216);
    const per = [0, 1, 2, 3, -1].map((i) => map.filter((x) => x === i).length);
    expect(per).toEqual([77, 3, 7, 2, 127]);
    expect(map.slice(0, 77).every((x) => x === 0)).toBe(true);
    expect(map[88]).toBe(3);
    expect(map[89]).toBe(-1);
  });

  it('a tiny part still gets its cell; over the window every cell is filled', () => {
    const tiny = cw().cwCells([{ tokens: 10 }, { tokens: 500_000 }], 1_000_000, 216);
    expect(tiny[0]).toBe(0);
    expect(tiny.filter((x) => x === 0)).toHaveLength(1);
    const over = cw().cwCells([{ tokens: 2_000_000 }], 1_000_000, 216);
    expect(over.every((x) => x === 0)).toBe(true);
  });

  it('marks the auto-compact point: cells from round(auto / perCell) on are past it', () => {
    const c = cw();
    expect(c.cwMarkIndex(750_000, 1_000_000, 216)).toBe(162);
    expect(c.cwMarkIndex(160_000, 200_000, 216)).toBe(173);
    expect(c.cwMarkIndex(0, 1_000_000, 216)).toBe(-1);
    expect(c.cwMarkIndex(1_000_000, 1_000_000, 216)).toBe(-1);
    const html = c.contextBlockHtml(sess(), NOW);
    expect(count(html, ' data-past')).toBe(216 - 162);
    expect(html).toContain('<i class="cw-cell" style="--i:162" data-past></i>');
    expect(html).toContain('<i class="cw-cell" style="--i:0;--c:var(--cw-c1)" data-part="read"></i>');
  });
});

describe('D8/D9 — the figure and the level against the auto-compact point', () => {
  it('ctxLevel keeps the 1-argument window bands exactly', () => {
    const c = cw();
    expect(c.ctxLevel(12)).toBe('');
    expect(c.ctxLevel(61)).toBe('ctx-warn');
    expect(c.ctxLevel(81)).toBe('ctx-danger');
    expect(c.ctxLevel('x')).toBe('');
  });

  it('with the auto-compact point: warn from 0.8 of it, full from 0.95, a scheduled compact is full', () => {
    const c = cw();
    expect(c.ctxLevel(41, 599_999, 750_000)).toBe('');
    expect(c.ctxLevel(41, 600_000, 750_000)).toBe('ctx-warn');
    expect(c.ctxLevel(71, 712_499, 750_000)).toBe('ctx-warn');
    expect(c.ctxLevel(71, 712_500, 750_000)).toBe('ctx-danger');
    // conv-run2 of the preview: 76% of the window but 475% of its 160K point.
    expect(c.ctxLevel(76, 760_000, 160_000)).toBe('ctx-danger');
    expect(c.ctxLevel(10, 100_000, 750_000, true)).toBe('ctx-danger');
    // Point unknown: the window bands.
    expect(c.ctxLevel(70, 700_000, 0)).toBe('ctx-warn');
  });

  it('data-level follows it; the pill is the face number (rounded, capped at 100)', () => {
    const c = cw();
    expect(
      c.contextBlockHtml(
        sess({ contextTokens: 620_000, tokenUsage: { contextUsagePercent: 62 } }, { cacheRead: 562_320 }),
        NOW,
      ),
    ).toContain('data-level="warn"');
    expect(
      c.contextBlockHtml(
        sess({ contextTokens: 720_000, tokenUsage: { contextUsagePercent: 72 } }, { cacheRead: 662_320 }),
        NOW,
      ),
    ).toContain('data-level="full"');
    expect(c.contextBlockHtml(sess({ tokenUsage: { contextUsagePercent: 104.6 } }), NOW)).toContain(
      '<span class="cw-pill" aria-hidden="true">100%</span>',
    );
  });

  it('cwShort drops a trailing .0 only', () => {
    const c = cw();
    expect(c.cwShort(1_000_000)).toBe('1M');
    expect(c.cwShort(750_000)).toBe('750K');
    expect(c.cwShort(337_600)).toBe('337.6K');
    expect(c.cwShort(200_000)).toBe('200K');
  });
});

describe('D10 — the tray line, one state at a time', () => {
  const say = (
    over: Record<string, unknown>,
    used: number,
    auto: number,
    lv: string,
    phase = 'idle',
    st?: Record<string, number | string | boolean>,
  ) => {
    const c = cw();
    if (st) c.cwTestSet(freshState('inst::C1:t1', st));
    return c.cwSay(sess(over), used, auto, 1_000_000, lv, phase, NOW);
  };

  it('how far to the auto-compact point, toned by the level', () => {
    expect(say({}, 412_000, 750_000, '')).toEqual({ id: 'left', tone: '', html: '자동 압축까지 338K' });
    expect(say({}, 620_000, 750_000, 'ctx-warn')).toEqual({ id: 'left', tone: 'warn', html: '자동 압축까지 130K' });
    expect(say({}, 720_000, 750_000, 'ctx-danger')).toEqual({
      id: 'soon',
      tone: 'full',
      html: '자동 압축 임박 · 30K 남음',
    });
    expect(say({}, 800_000, 750_000, 'ctx-danger')).toEqual({
      id: 'over',
      tone: 'full',
      html: '자동 압축 지점을 넘음',
    });
    expect(say({ compactPending: true }, 760_000, 750_000, 'ctx-danger')).toEqual({
      id: 'pending',
      tone: 'full',
      html: '다음 입력 때 자동 압축',
    });
    expect(say({}, 412_000, 0, '')).toEqual({ id: 'free', tone: '', html: '창에 588K 남음' });
  });

  it('sending, sent (queued behind a running turn), armed, failed, timed out, a compaction observed and its saving', () => {
    expect(say({}, 412_000, 750_000, '', 'sending').html).toBe('압축 요청 보내는 중…');
    expect(say({}, 412_000, 750_000, '', 'sent', { busySince: NOW - 10, sentAt: NOW - 5 }).html).toBe(
      '압축 요청 보냄 — 압축을 기다리는 중',
    );
    expect(say({}, 412_000, 750_000, '', 'sent', { busySince: NOW - 10, sentAt: NOW - 5, queued: true }).html).toBe(
      '압축 요청 보냄 — 지금 턴이 끝나면 압축',
    );
    // On screen the button already says 한 번 더 눌러 압축; the live region reads the whole sentence.
    expect(say({}, 412_000, 750_000, '', 'armed')).toEqual({
      id: 'armed',
      tone: 'warn',
      html: '지난 대화가 요약으로 줄어듭니다',
      sr: '한 번 더 누르면 압축 — 지난 대화가 요약으로 줄어듭니다',
    });
    expect(say({}, 412_000, 750_000, '', 'idle', { failAt: NOW - 100 })).toEqual({
      id: 'fail',
      tone: 'fail',
      html: '압축 요청 실패',
    });
    expect(say({}, 412_000, 750_000, '', 'idle', { timedOutAt: NOW - 100 }).html).toBe('압축 결과를 아직 받지 못함');
    const lastCompact = { preTokens: 812_000, postTokens: 64_000 };
    expect(say({ lastCompact }, 64_000, 750_000, '', 'idle', { savedAt: NOW - 100 })).toEqual({
      id: 'saved',
      tone: 'ok',
      html: '새 압축 관측됨 · <b>748K</b> 줄임 (812K → 64K)',
    });
    expect(say({}, 412_000, 750_000, '', 'idle', { observedAt: NOW - 100, savedWait: NOW - 100 })).toEqual({
      id: 'observed',
      tone: 'ok',
      html: '새 압축 관측됨',
    });
    // 3.2s later the line is back to the distance.
    expect(
      say({ lastCompact }, 64_000, 750_000, '', 'idle', { savedAt: NOW - 3_300, observedAt: NOW - 3_400 }).id,
    ).toBe('left');
  });

  it('is written keyed (swap); only transitions reach the polite live region, never a distance', () => {
    const html = cw().contextBlockHtml(sess(), NOW);
    expect(html).toContain(
      '<span class="cw-say"><span class="cw-say-t" data-mk="say-left">자동 압축까지 338K</span></span>',
    );
    expect(html).toContain('<span class="cw-sr" aria-live="polite"></span>');
    expect(count(html, 'aria-live')).toBe(1);
    const c = cw();
    c.cwTestSet(freshState('inst::C1:t1', { armedAt: NOW - 100 }));
    expect(c.contextBlockHtml(sess(), NOW)).toContain(
      '<span class="cw-sr" aria-live="polite">한 번 더 누르면 압축 — 지난 대화가 요약으로 줄어듭니다</span>',
    );
    expect(c.contextBlockHtml(sess({ compactPending: true }), NOW + 10_000)).toContain(
      '<span class="cw-sr" aria-live="polite">다음 입력 때 자동 압축</span>',
    );
  });
});

/** A minimal element: attributes, text, and the selectors cwApply asks for. */
function el(attrs: Record<string, string> = {}, text = '') {
  const a = new Map(Object.entries(attrs));
  return {
    textContent: text,
    getAttribute: (n: string) => (a.has(n) ? (a.get(n) as string) : null),
    setAttribute: (n: string, v: string) => void a.set(n, v),
    removeAttribute: (n: string) => void a.delete(n),
    hasAttribute: (n: string) => a.has(n),
  };
}

describe('D11/D20 — hover links a row and its cells; re-applied after every write', () => {
  function block() {
    const rows = [
      el({ 'data-part': 'read', 'data-tok': '354320', 'data-of': '이전 맥락 (캐시 읽기) · 창의 35%' }),
      el({ 'data-part': 'input', 'data-tok': '32960', 'data-of': '캐시 안 된 입력 · 창의 3.3%' }),
    ];
    const mark = el();
    const cells = [el({ 'data-part': 'read' }), el({ 'data-part': 'read' }), el({ 'data-part': 'input' })];
    const field = el();
    const big = el({ 'data-to': '412000' }, '412.0K');
    const of = el({ 'data-total': '/ 1M 토큰' }, '/ 1M 토큰');
    const cwEl = {
      querySelector: (q: string) =>
        q === '.cw-field'
          ? field
          : q === '.cw-big'
            ? big
            : q === '.cw-of'
              ? of
              : (rows.find((r) => q === `.cw-part[data-part="${r.getAttribute('data-part')}"]`) ?? null),
      querySelectorAll: (q: string) =>
        q === '.cw-cell[data-part]' ? cells : q === '.cw-part, .cw-mark' ? [...rows, mark] : [],
    };
    const root = { querySelector: (q: string) => (q === '.cw' ? cwEl : null) };
    return { root, rows, mark, cells, field, big, of };
  }
  const apply = (hot: string) => {
    const roll = vi.fn();
    const c = load<{ cwApply(root: unknown): void }>(['toNum', 'cwApply'], [], { _cwHot: hot, cwRoll: roll });
    return { c, roll };
  };

  it('a hot part: its cells lifted, the field marked, other rows dimmed, the figure on the part', () => {
    const b = block();
    const { c, roll } = apply('read');
    c.cwApply(b.root);
    expect(b.field.hasAttribute('data-hot')).toBe(true);
    expect(b.cells.map((x) => x.hasAttribute('data-on'))).toEqual([true, true, false]);
    expect(b.rows[0].hasAttribute('data-hot')).toBe(true);
    expect(b.rows[0].hasAttribute('data-dim')).toBe(false);
    expect(b.rows[1].hasAttribute('data-dim')).toBe(true);
    expect(b.mark.hasAttribute('data-dim')).toBe(true);
    expect(b.of.textContent).toBe('이전 맥락 (캐시 읽기) · 창의 35%');
    expect(roll).toHaveBeenCalledWith(b.big, 354_320);
  });

  it('nothing hot (or a part that left): everything back, the figure on the total', () => {
    const b = block();
    b.field.setAttribute('data-hot', '');
    b.cells[0].setAttribute('data-on', '');
    b.rows[1].setAttribute('data-dim', '');
    const { c, roll } = apply('gone');
    c.cwApply(b.root);
    expect(b.field.hasAttribute('data-hot')).toBe(false);
    expect(b.cells.some((x) => x.hasAttribute('data-on'))).toBe(false);
    expect(b.rows.some((x) => x.hasAttribute('data-dim') || x.hasAttribute('data-hot'))).toBe(false);
    expect(b.of.textContent).toBe('/ 1M 토큰');
    expect(roll).toHaveBeenCalledWith(b.big, 412_000);
  });

  it('mouse only; re-applied after every write; the panel session change resets it', () => {
    expect(clientFn('cwBind')).toContain("e.pointerType !== 'mouse'");
    expect(clientFn('renderPanelInfo')).toContain(
      "if (writePanelPart(el, s ? panelInfoHtml(s, _panelInfoOpen) : '')) cwApply(el);",
    );
    expect(clientFn('renderPanelInfo')).toContain('cwObserve(s, Date.now());');
    const c = load<{ cwObserve(s: unknown, now: number): void; cwTestState(): Record<string, unknown> }>(
      ['toNum', 'cwObserve'],
      ['_cw', 'CW_DONE_MS', 'CW_LEAVE_MS', 'CW_SAVED_MS', 'CW_FAIL_MS', 'CW_CEIL_MS'],
      { cwLater: () => {}, _cwHot: 'read' },
      STATE,
    );
    c.cwObserve(sess({ compactionCount: 3 }), NOW);
    expect(c.cwTestState()).toMatchObject({ key: 'inst::C1:t1', count: 3, busySince: 0 });
  });

  it('the number rolls both ways in 640ms (ease-out quart); reduced motion sets it at once', () => {
    expect(clientVar('CW_ROLL_MS')).toBe('var CW_ROLL_MS = 640;');
    const src = clientFn('cwRoll');
    expect(src).toContain('1 - Math.pow(1 - p, 4)');
    expect(src).toContain('reduceMotion()');
    expect(src).not.toContain('to < from');
  });
});

describe('D12 — 지금 압축: owner-gated, confirmed by a second press, sent as `compact --yes`', () => {
  const btn = (
    over: Record<string, unknown> = {},
    phase = 'idle',
    used = 412_000,
    st?: Record<string, number | string | boolean>,
  ) => {
    const c = cw();
    if (st) c.cwTestSet(freshState('inst::C1:t1', st));
    return c.cwCompactHtml(sess(over), phase, used);
  };

  it('the owner gets an enabled button named for what it does', () => {
    expect(btn()).toBe(
      `<button type="button" class="cw-compact" data-state="idle" aria-label="지금 압축 — 컨텍스트 압축" onclick="cwCompact()"><span class="cw-ci" data-mk="ci-idle">${cook(clientVar('CW_COMPACT_SVG').replace(/^var CW_COMPACT_SVG = '|';$/g, ''))}</span><span class="cw-ct" data-mk="ct-idle">지금 압축</span></button>`,
    );
  });

  it('disabled with the reason: not the owner, another instance, a switch waiting on a compact, a compact already scheduled', () => {
    expect(btn({ ownerId: 'U2' })).toContain(` disabled title="${READ_ONLY}"`);
    expect(btn({ environment: { instanceName: 'other', host: 'h', port: 1 } })).toContain(
      ' disabled title="Open other (h:1) to act on this session"',
    );
    expect(btn({ pendingModel: 'fable[1m]' })).toContain(' disabled title="모델 전환이 압축을 기다리는 중"');
    expect(btn({ compactPending: true })).toContain(' disabled title="다음 입력 때 자동 압축됩니다"');
  });

  it('absent: a closed session, an empty context, nothing added since the last compaction', () => {
    expect(btn({ terminated: true })).toBe('');
    expect(btn({}, 'idle', 0)).toBe('');
    expect(btn({ lastCompact: { preTokens: 812_000, postTokens: 64_000 } }, 'idle', 64_000)).toBe('');
    expect(btn({ lastCompact: { preTokens: 812_000, postTokens: 64_000 } }, 'idle', 90_000)).toContain('지금 압축');
    expect(btn({}, 'idle', 412_000, { savedWait: NOW - 10 })).toBe('');
  });

  it('armed, sending / sent (spinner, aria-busy, wave on the filled cells), a compaction observed, leaving', () => {
    expect(btn({}, 'armed')).toContain('data-state="armed"');
    expect(btn({}, 'armed')).toContain('>한 번 더 눌러 압축</span>');
    const sending = btn({}, 'sending');
    expect(sending).toContain('data-state="busy" disabled aria-busy="true"');
    expect(sending).toContain('<span class="cw-spin" aria-hidden="true"></span>');
    expect(sending).toContain('<span class="cw-ct" data-mk="ct-sending">보내는 중</span>');
    expect(btn({}, 'sent')).toContain('<span class="cw-ct" data-mk="ct-sent">요청 보냄</span>');
    // Never "your compaction is done": a compaction was observed.
    expect(btn({}, 'done')).toContain('data-state="done" disabled');
    expect(btn({}, 'done')).toContain('>압축 관측됨</span>');
    expect(btn({}, 'leaving')).toContain('data-state="done" data-leaving disabled');
    const c = cw();
    c.cwTestSet(freshState('inst::C1:t1', { busySince: NOW - 1000 }));
    const html = c.contextBlockHtml(sess(), NOW);
    expect(count(html, ' data-busy')).toBe(89);
  });

  it('phase: sending, sent, done for 1.5s, leaving for 0.4s, armed for 4s', () => {
    const c = cw();
    const s = sess();
    expect(c.cwPhase(s, NOW)).toBe('idle');
    c.cwTestSet(freshState('inst::C1:t1', { armedAt: NOW - 3_999 }));
    expect(c.cwPhase(s, NOW)).toBe('armed');
    c.cwTestSet(freshState('inst::C1:t1', { armedAt: NOW - 4_000 }));
    expect(c.cwPhase(s, NOW)).toBe('idle');
    c.cwTestSet(freshState('inst::C1:t1', { busySince: NOW - 10 }));
    expect(c.cwPhase(s, NOW)).toBe('sending');
    c.cwTestSet(freshState('inst::C1:t1', { busySince: NOW - 10, sentAt: NOW - 5 }));
    expect(c.cwPhase(s, NOW)).toBe('sent');
    c.cwTestSet(freshState('inst::C1:t1', { doneAt: NOW - 1_499 }));
    expect(c.cwPhase(s, NOW)).toBe('done');
    c.cwTestSet(freshState('inst::C1:t1', { doneAt: NOW - 1_600 }));
    expect(c.cwPhase(s, NOW)).toBe('leaving');
    c.cwTestSet(freshState('inst::C1:t1', { doneAt: NOW - 1_900 }));
    expect(c.cwPhase(s, NOW)).toBe('idle');
    c.cwTestSet(freshState('other', { busySince: NOW - 10 }));
    expect(c.cwPhase(s, NOW)).toBe('idle');
  });

  type Flow = {
    cwCompact(): Promise<void>;
    cwTestState(): Record<string, number | string | boolean>;
    cwTestSet(o: Record<string, number | string | boolean>): void;
  };
  function flow(responses: { ok: boolean; status: number }[]) {
    const fetchSpy = vi.fn(async () => responses.shift() ?? { ok: true, status: 200 });
    const render = vi.fn();
    const refresh = vi.fn(async () => {});
    const later = vi.fn();
    const s = sess();
    const c = load<Flow>(
      ['toNum', 'cwCanCompact', 'cwObserve', 'cwCompact'],
      ['_cw', 'CW_ARM_MS', 'CW_DONE_MS', 'CW_LEAVE_MS', 'CW_SAVED_MS', 'CW_FAIL_MS', 'CW_CEIL_MS'],
      {
        panelSessionKey: s.key,
        _sessionCache: { [s.key]: s },
        currentUserId: 'U1',
        READ_ONLY_MSG: READ_ONLY,
        isSiblingSession: () => false,
        fetch: fetchSpy,
        _csrfToken: 'tok',
        refreshCsrfToken: refresh,
        renderPanelInfo: render,
        cwLater: later,
        _cwHot: '',
      },
      STATE,
    );
    return { c, fetchSpy, render, refresh, later };
  }

  it('the first press arms (nothing sent); the second sends compact --yes to the owner-gated command route', async () => {
    const { c, fetchSpy, later } = flow([{ ok: true, status: 200 }]);
    await c.cwCompact();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Number(c.cwTestState().armedAt)).toBeGreaterThan(0);
    expect(later).toHaveBeenCalledWith(4000);
    await c.cwCompact();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/dashboard/session/inst%3A%3AC1%3At1/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' },
      body: '{"message":"compact --yes"}',
    });
    expect(c.cwTestState().armedAt).toBe(0);
    expect(Number(c.cwTestState().busySince)).toBeGreaterThan(0);
    // Taken by the server: sent (not "compacted").
    expect(Number(c.cwTestState().sentAt)).toBeGreaterThan(0);
    expect(c.cwTestState().queued).toBe(false);
  });

  it('a 403 refreshes the CSRF token and retries once; a failure ends the busy state with the reason', async () => {
    const a = flow([
      { ok: false, status: 403 },
      { ok: true, status: 200 },
    ]);
    await a.c.cwCompact();
    await a.c.cwCompact();
    expect(a.refresh).toHaveBeenCalledTimes(1);
    expect(a.fetchSpy).toHaveBeenCalledTimes(2);
    expect(Number(a.c.cwTestState().busySince)).toBeGreaterThan(0);
    const b = flow([{ ok: false, status: 500 }]);
    await b.c.cwCompact();
    await b.c.cwCompact();
    expect(b.c.cwTestState().busySince).toBe(0);
    expect(Number(b.c.cwTestState().failAt)).toBeGreaterThan(0);
    expect(b.later).toHaveBeenCalledWith(4000);
  });

  // Trinity R1 (P1): the card carries no correlation between the request and a
  // compaction — a count rise is "a compaction was observed", and its saving is
  // shown only from THAT compaction's own counts.
  const observer = () =>
    load<
      Pick<Cw, 'cwSay' | 'cwCompactHtml' | 'cwPhase' | 'cwTestState' | 'cwTestSet'> & {
        cwObserve(s: unknown, now: number): void;
      }
    >([...CW_FNS, 'cwObserve'], CW_VARS, { ...ENV, cwLater: () => {}, _cwHot: '' }, STATE);
  const OLD = { preTokens: 500_000, postTokens: 40_000 };
  const NEW = { preTokens: 812_000, postTokens: 64_000 };
  const line = (c: ReturnType<typeof observer>, s: Record<string, unknown>, now: number) =>
    c.cwSay(s, 412_000, 750_000, 1_000_000, '', c.cwPhase(s, now), now);

  it('(1) an unrelated compaction lands first: observed, not claimed; its old counts are not this saving', () => {
    const c = observer();
    c.cwTestSet(
      freshState('inst::C1:t1', {
        count: 2,
        busySince: NOW - 5_000,
        sentAt: NOW - 4_000,
        queued: true,
        lcSeen: '500000/40000',
      }),
    );
    const rose = sess({ compactionCount: 3, lastCompact: OLD });
    c.cwObserve(rose, NOW);
    expect(c.cwTestState()).toMatchObject({
      count: 3,
      busySince: 0,
      sentAt: 0,
      doneAt: NOW,
      observedAt: NOW,
      savedWait: NOW,
      savedAt: 0,
    });
    const said = line(c, rose, NOW);
    expect(said).toEqual({ id: 'observed', tone: 'ok', html: '새 압축 관측됨' });
    expect(said.html).not.toContain('요청');
    expect(c.cwCompactHtml(rose, c.cwPhase(rose, NOW), 412_000)).toContain('>압축 관측됨</span>');
  });

  it('(2) the count arrives before the counts: observed, no saving yet', () => {
    const c = observer();
    c.cwTestSet(freshState('inst::C1:t1', { count: 2, busySince: NOW - 5_000, sentAt: NOW - 4_000 }));
    const rose = sess({ compactionCount: 3 });
    c.cwObserve(rose, NOW);
    expect(c.cwTestState()).toMatchObject({ busySince: 0, savedWait: NOW, savedAt: 0 });
    expect(line(c, rose, NOW + 100).html).toBe('새 압축 관측됨');
  });

  it('(3) the counts arrive later: the line then says what that compaction saved', () => {
    const c = observer();
    c.cwTestSet(
      freshState('inst::C1:t1', { count: 2, busySince: NOW - 5_000, sentAt: NOW - 4_000, lcSeen: '500000/40000' }),
    );
    c.cwObserve(sess({ compactionCount: 3, lastCompact: OLD }), NOW);
    const later = sess({ compactionCount: 3, lastCompact: NEW, contextTokens: 64_000 });
    c.cwObserve(later, NOW + 800);
    expect(c.cwTestState()).toMatchObject({ savedWait: 0, savedAt: NOW + 800 });
    expect(line(c, later, NOW + 900)).toEqual({
      id: 'saved',
      tone: 'ok',
      html: '새 압축 관측됨 · <b>748K</b> 줄임 (812K → 64K)',
    });
    // Missing counts never hang the line: the next context sample ends the wait.
    const d = observer();
    d.cwTestSet(freshState('inst::C1:t1', { count: 2, usedAtRise: 0 }));
    d.cwObserve(sess({ compactionCount: 3 }), NOW);
    d.cwObserve(sess({ compactionCount: 3, contextTokens: 70_000 }), NOW + 900);
    expect(d.cwTestState()).toMatchObject({ savedWait: 0, savedAt: 0 });
  });

  it('a request never answered ends at the 5-minute ceiling', () => {
    const c = observer();
    c.cwTestSet(freshState('inst::C1:t1', { count: 3, busySince: NOW - 300_000, sentAt: NOW - 299_000 }));
    c.cwObserve(sess({ compactionCount: 3 }), NOW);
    expect(c.cwTestState()).toMatchObject({ busySince: 0, sentAt: 0, timedOutAt: NOW });
  });

  it('Escape or leaving the armed button disarms it (the panel stays open)', () => {
    const src = clientFn('cwBind');
    expect(src).toContain("e.key === 'Escape' && _cw.armedAt");
    expect(src).toContain('e.stopPropagation()');
    expect(src).toContain("addEventListener('focusout'");
  });
});

describe('D13/D14/D15/D19 — motion, container widths, a11y and theme tokens', () => {
  it('cells sweep (2ms per cell), dim and lift; the wave runs only without reduced motion', () => {
    expect(CSS).toMatch(
      /\.cw-cell \{[^}]*transition: background-color 380ms var\(--ease-out\)[^}]*transition-delay: calc\(var\(--i\) \* 2ms\)/,
    );
    expect(CSS).toMatch(/\.cw-field\[data-hot\] \.cw-cell\[data-part\]:not\(\[data-on\]\) \{ opacity: 0\.22; \}/);
    expect(CSS).toMatch(/\.cw-cell\[data-on\] \{ transform: scale\(1\.12\); \}/);
    expect(CSS).toMatch(/\.cw-cell\[data-busy\] \{ opacity: 0\.5; \}/);
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{[^@]*\.cw-cell\[data-busy\] \{ animation: cw-wave 900ms ease-in-out infinite; animation-delay: calc\(var\(--i\) \* 15ms\); \}/,
    );
    expect(CSS).toMatch(
      /@keyframes cw-wave \{ 0%, 100% \{ opacity: 1; transform: none; \} 50% \{ opacity: 0\.28; transform: scale\(0\.72\); \} \}/,
    );
    expect(CSS).toMatch(/\.cw-compact\[data-leaving\] \{ animation: cw-leave 400ms var\(--ease-out\) both; \}/);
  });

  it('36 columns; 24 under 310px of block, 54 from 520px; a 44px button on touch', () => {
    expect(CSS).toMatch(/\.cw \{ container: cw \/ inline-size; max-width: 560px;/);
    expect(CSS).toMatch(/\.cw-field \{[^}]*grid-template-columns: repeat\(36, minmax\(0, 1fr\)\);/);
    expect(CSS).toMatch(
      /@container cw \(max-width: 309px\) \{[^@]*repeat\(24, minmax\(0, 1fr\)\)[^@]*\.cw-ct \{ display: none; \}/,
    );
    expect(CSS).toMatch(
      /@container cw \(min-width: 520px\) \{ \.cw-field \{ grid-template-columns: repeat\(54, minmax\(0, 1fr\)\); \} \}/,
    );
    expect(CSS).toMatch(/@media \(pointer: coarse\), \(max-width: 639px\) \{ \.cw-compact \{ min-height: 44px; \}/);
  });

  it('every new colour token has a dark and a light value; amber text uses the 4.5:1 yellow in light', () => {
    for (const t of [
      '--cw-c1',
      '--cw-c2',
      '--cw-c3',
      '--cw-c4',
      '--cw-free',
      '--cw-warn',
      '--cw-warn-bg',
      '--cw-full-bg',
      '--cw-ok',
    ])
      expect(CSS.match(new RegExp(`${t}:`, 'g'))?.length, t).toBe(2);
    expect(CSS).toMatch(/\[data-theme="light"\] \{ --cw-c1:[^}]*--cw-warn: var\(--yellow\);/);
    expect(CSS).toMatch(/\.cw\[data-level="full"\] \.cw-pill \{[^}]*var\(--st-fail-text\)/);
    expect(CSS).toMatch(
      /\.cw-sr \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\);/,
    );
  });
});

// The face's ctx metric (D16) — the face layout is the board's; only the class and tooltip change.
const FACE_FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'formatTokens',
  'formatCount',
  'cardTotalTokens',
  'cardCurrentTask',
  'renderCardTaskRow',
  'agentStatusOf',
  'agentCounts',
  'renderCardAgents',
  'renderCardUsage',
  'formatTaskTime',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardSummary',
  'doneTimeOf',
  'cardAgo',
  'renderCardStatus',
  'renderOwnerBadge',
  'ctxLevel',
  'renderCardPr',
  'renderCardFace',
];
const FACE_VARS = [
  'SPARK_SVG',
  'WAIT_SVG',
  'TASKS_SVG',
  'CTX_SVG',
  'RESUME_SVG',
  'PR_STATE_LABEL',
  'PR_SVG',
  'AGENT_STATUS_LABEL',
  'AGENT_DOTS_MAX',
  'AGENTS_SVG',
];
const FACE_ENV = {
  dhShow: () => true,
  dhMax: (_f: string, d: number) => d,
  dhTruncate: () => null,
  currentUserId: 'U1',
  isSiblingSession: () => false,
  artFaceChips: () => '',
  umFaceBadge: () => '',
};

describe('D16 — the face ctx metric and the summary line use the same level and say the distance', () => {
  const face = load<{ renderCardFace(s: unknown, col: string): string }>(FACE_FNS, FACE_VARS, FACE_ENV);
  const card = (over: Record<string, unknown>) => ({
    key: 'inst::C1:t1',
    displayHeadline: 'Context',
    ownerId: 'U1',
    activityState: 'idle',
    activeAccumulatedMs: 0,
    lastActivity: '2026-10-26T10:00:00.000Z',
    autoCompactTokens: 750_000,
    ...over,
  });
  const ctx = (pct: number, used?: number, extra: Record<string, unknown> = {}) =>
    face.renderCardFace(
      card({ tokenUsage: { totalInputTokens: 1, contextUsagePercent: pct }, contextTokens: used, ...extra }),
      'idle',
    );

  it('point known: the level against it, the tooltip says how far', () => {
    expect(ctx(41.2, 412_000)).toContain('<span class="metric" title="컨텍스트 41% · 자동 압축 750K까지 338K">');
    expect(ctx(62, 620_000)).toContain('<span class="metric ctx-warn" title="컨텍스트 62% · 자동 압축 750K까지 130K">');
    expect(ctx(72, 720_000)).toContain(
      '<span class="metric ctx-danger" title="컨텍스트 72% · 자동 압축 750K까지 30K">',
    );
    expect(ctx(76, 760_000, { compactPending: true })).toContain(
      '<span class="metric ctx-danger" title="컨텍스트 76% · 다음 입력 때 자동 압축">',
    );
    expect(ctx(80, 800_000)).toContain('title="컨텍스트 80% · 자동 압축 지점을 넘음"');
  });

  it('point unknown: the window bands and the old words, unchanged', () => {
    expect(ctx(65)).toContain('<span class="metric ctx-warn" title="Context window used">');
    expect(ctx(90)).toContain('<span class="metric ctx-danger" title="Context window used — 80% 넘게 찼다">');
  });

  it('세션 정보 summary: ctx N% carries the same class; the open grid says the totals are cumulative (D17)', () => {
    const info = load<{ panelInfoHtml(s: unknown, open: boolean): string }>(
      [...CW_FNS, 'panelInfoHtml'],
      [...CW_VARS, 'PI_CHEV_SVG'],
      { ...ENV, formatNmSSs: (n: number) => `${n}ms`, cardTotalTokens: () => 1, safeHref: (u: string) => u },
    ).panelInfoHtml;
    const s = sess({
      contextTokens: 620_000,
      tokenUsage: { totalInputTokens: 1, contextUsagePercent: 62 },
      lastActivity: NOW,
    });
    expect(info(s, false)).toContain('<span class="pi-cs ctx-warn">ctx 62%</span>');
    const open = info(s, true);
    const body = open.slice(open.indexOf('class="pi-body"'));
    expect(body.indexOf('<section class="cw"')).toBeLessThan(body.indexOf('class="pi-grid"'));
    for (const label of ['누적 입력', '누적 출력', '누적 캐시 읽기', '누적 캐시 쓰기'])
      expect(body).toContain(`<dt>${label}</dt>`);
  });
});
