/**
 * affectUI Model Picker → the dashboard's model · effort picker, client half
 * (.prd/affectui/re-model-picker.md §4 D1–D18). Executes the shipped page code
 * cut out of renderDashboardPage()'s template literal and cooked exactly as the
 * browser receives it (the harness of dashboard-three-surfaces-client.test.ts).
 *
 *   trigger   one button per surface (card control strip, panel composer)
 *   menu      listbox of the representative models with window · autocompact ·
 *             cost bars, the effort radiogroup, the price tray
 *   behaviour keyboard, placement, the one-write lock, live repaint guards
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
const STYLE = TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>'));
const strip = (html: string) => html.replace(/<[^>]*>/g, '');

const MODELS = [
  {
    nickname: 'opus[1m]',
    model: 'claude-opus-5-5[1m]',
    label: 'Opus 5.5 (1M)',
    contextWindow: 1_000_000,
    autoCompactTokens: 750_000,
    price: { input: 5, output: 25 },
  },
  {
    nickname: 'fable[1m]',
    model: 'claude-fable-5-1[1m]',
    label: 'Fable 5.1 (1M)',
    contextWindow: 1_000_000,
    autoCompactTokens: 750_000,
    price: { input: 10, output: 50 },
  },
  {
    nickname: 'sonnet[1m]',
    model: 'claude-sonnet-4-6[1m]',
    label: 'Sonnet 4.6 (1M)',
    contextWindow: 1_000_000,
    autoCompactTokens: 750_000,
    price: { input: 3, output: 15 },
  },
  {
    nickname: 'sol[1m]',
    model: 'gpt-5.6-sol[1m]',
    label: 'GPT-5.6 Sol (1M)',
    contextWindow: 1_000_000,
    autoCompactTokens: 600_000,
    price: { input: 5, output: 30 },
  },
  {
    nickname: 'astra[1m]',
    model: 'gpt-6-astra[1m]',
    label: 'GPT-6 Astra (1M)',
    contextWindow: 1_000_000,
    autoCompactTokens: 600_000,
    price: { input: 10, output: 50 },
  },
  {
    nickname: 'grok[1m]',
    model: 'grok-4.6',
    label: 'Grok 4.6 (500k)',
    contextWindow: 500_000,
    autoCompactTokens: 450_000,
  },
];
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Every pure renderer of the menu, loaded together over the shared state. */
const RENDER_FNS = [
  'esc',
  'escAttr',
  'toNum',
  'formatTokens',
  'effortLabel',
  'isBusy',
  'setBusy',
  'mpShort',
  'mpOptions',
  'mpCurrentIndex',
  'mpSegments',
  'mpMax',
  'mpMetersHtml',
  'mpMoney',
  'mpPriceWords',
  'mpTray',
  'mpEffortLevels',
  'renderEffortControl',
  'renderModelMenu',
  'renderModelPicker',
];
const RENDER_VARS = ['_busy', '_mp', '_modelNotes', 'EFFORT_LABELS', 'MP_EFFORT_SHORT'];
const STATE_FN = 'function mpState(patch) { if (patch) for (var k in patch) _mp[k] = patch[k]; return _mp; }';

type Renderers = {
  renderModelPicker(s: unknown, canSwitch: boolean, short: string, surface?: string): string;
  renderModelMenu(s: unknown): string;
  renderEffortControl(s: unknown): string;
  mpSegments(v: unknown, max: unknown): number;
  mpTray(o: unknown): { html: string; sr: string };
  mpMoney(v: number, ref?: number): string;
  setBusy(k: string, op: string, on: boolean): void;
  mpState(patch?: Record<string, unknown>): Record<string, unknown>;
};
function renderers(models: unknown[] = MODELS): Renderers {
  return load<Renderers>(RENDER_FNS, RENDER_VARS, { REPRESENTATIVE_MODELS: models, EFFORT_LEVELS: LEVELS }, [STATE_FN]);
}
const sess = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  model: 'claude-opus-5-5[1m]',
  effort: 'high',
  contextTokens: 500_000,
  ...over,
});
/** The option blocks of a rendered menu, in order. */
function optionBlocks(html: string): string[] {
  return html.split('<div class="mp-opt"').slice(1);
}
/** Filled segments per meter of one option block; '—' when the meter has no value. */
function meterCounts(block: string): Array<number | string> {
  return block
    .split('<span class="mp-meter')
    .slice(1)
    .map((m) => (m.startsWith(' is-none') ? '—' : (m.split('</span></span>')[0].match(/data-on=""/g) ?? []).length));
}

// ── D1 — the trigger ──
describe('D1 — one trigger per surface: glyph, model, effort, chevron', () => {
  it('the owner gets a dialog trigger (no <select>) naming the model and the level that runs', () => {
    const m = renderers();
    const html = m.renderModelPicker(sess(), true, 'opus-5-5[1m]', 'card');
    expect(html).not.toContain('<select');
    expect(html).toContain(
      '<button type="button" class="mp-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="mp-menu"',
    );
    expect(html).toContain('data-mp-key="inst::C1:t1" data-mp-surface="card"');
    expect(html).toContain('aria-label="모델 Opus 5.5 (1M), effort High — 바꾸기"');
    expect(html).toContain(
      '<span class="mp-glyph" aria-hidden="true">O</span><span class="mp-name">Opus 5.5 (1M)</span>',
    );
    expect(html).toContain('<span class="mp-level">&middot; High</span>');
    expect(html).toContain('<span class="mp-chev" aria-hidden="true"></span></button>');
    // A capped level shows what really runs.
    expect(m.renderModelPicker(sess({ effort: 'max', effortEffective: 'high' }), true, 'opus', 'panel')).toContain(
      '&middot; High',
    );
  });

  it('a model outside the list is named by its short id; the key is attribute-escaped', () => {
    const m = renderers();
    const html = m.renderModelPicker(
      sess({ key: "self::C1:t'1", model: 'claude-haiku-4-5-20251001' }),
      true,
      'haiku-4-5',
    );
    expect(html).toContain('<span class="mp-name">haiku-4-5</span>');
    expect(html).toContain('data-mp-key="self::C1:t&#39;1" data-mp-surface="card"');
    expect(html).toContain('<span class="mp-glyph" aria-hidden="true">H</span>');
  });

  it('read-only viewers keep the plain text, byte for byte', () => {
    const m = renderers();
    expect(m.renderModelPicker(sess(), false, 'opus-5-5[1m]', 'card')).toBe(
      '<span class="cb-model-name">opus-5-5[1m]</span>',
    );
  });

  it('a write in flight marks the trigger busy without disabling it; the open anchor says expanded', () => {
    const m = renderers();
    m.setBusy('inst::C1:t1', 'effort', true);
    const busy = m.renderModelPicker(sess(), true, 'opus', 'card');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).not.toContain(' disabled');
    m.setBusy('inst::C1:t1', 'effort', false);
    m.mpState({ key: 'inst::C1:t1', surface: 'panel' });
    expect(m.renderModelPicker(sess(), true, 'opus', 'panel')).toContain('aria-expanded="true"');
    expect(m.renderModelPicker(sess(), true, 'opus', 'card')).toContain('aria-expanded="false"');
  });
});

// ── D3 / D4 / D11 — the model list ──
describe('D3 — the model list is a listbox of the representative models', () => {
  it('six options in server order, the current one selected and checked, the active one the descendant', () => {
    const m = renderers();
    const html = m.renderModelMenu(sess());
    expect(html).toContain(
      '<div class="mp-list" role="listbox" aria-label="모델" tabindex="0" aria-activedescendant="mp-opt-0"',
    );
    expect([...html.matchAll(/data-mp-nick="([^"]*)"/g)].map((x) => x[1])).toEqual([
      'opus[1m]',
      'fable[1m]',
      'sonnet[1m]',
      'sol[1m]',
      'astra[1m]',
      'grok[1m]',
    ]);
    expect(html).toContain('id="mp-opt-0" role="option" data-mp-i="0" data-mp-nick="opus[1m]" aria-selected="true"');
    expect(html).toContain('id="mp-opt-5" role="option" data-mp-i="5" data-mp-nick="grok[1m]" aria-selected="false"');
    expect(html.match(/class="mp-check"/g)).toHaveLength(1);
    expect(html).toContain('<span class="mp-title-name">Opus 5.5 (1M)</span>');
  });

  it('the description line keeps the switch rule: a target below the context compacts first, never the current one', () => {
    const html = renderers().renderModelMenu(sess());
    expect(html).toContain('<span class="mp-desc">grok[1m] · autocompact 450.0K · compact 후 전환</span>');
    expect(html).toContain('fable[1m] · autocompact 750.0K<');
    expect(html).not.toContain('opus[1m] · autocompact 750.0K · compact');
  });

  it('a model outside the list is the current, unselectable first entry', () => {
    const html = renderers().renderModelMenu(sess({ model: 'claude-haiku-4-5-20251001' }));
    const blocks = optionBlocks(html);
    expect(blocks).toHaveLength(7);
    expect(blocks[0]).toContain('id="mp-opt-0" role="option" data-mp-i="0" aria-selected="true" aria-disabled="true"');
    expect(blocks[0]).toContain('<span class="mp-title-name">haiku-4-5</span>');
    expect(blocks[0]).not.toContain('data-mp-nick');
  });

  it('options carry their numbers as a sentence (the bars and the head are aria-hidden)', () => {
    const html = renderers().renderModelMenu(sess());
    expect(html).toContain(
      'aria-label="Grok 4.6 (500k), grok[1m] · autocompact 450.0K · compact 후 전환. 창 500.0K, 가격 정보 없음"',
    );
    expect(html).toContain(
      'aria-label="Opus 5.5 (1M), opus[1m] · autocompact 750.0K. 창 1.0M, 입력 $5 · 출력 $25 / 백만 토큰"',
    );
    expect(html).toContain('<div class="mp-head" aria-hidden="true"><span>이 세션 모델</span>');
    expect(html).toContain('<span class="mp-bars" aria-hidden="true">');
  });

  it('D11 — a waiting switch or a model write in flight locks every option and says why', () => {
    const m = renderers();
    const pending = m.renderModelMenu(sess({ pendingModel: 'grok[1m]' }));
    expect(optionBlocks(pending).every((b) => b.includes('aria-disabled="true"'))).toBe(true);
    expect(pending).toContain(
      'role="listbox" aria-label="모델" tabindex="0" aria-activedescendant="mp-opt-0" aria-disabled="true"',
    );
    expect(pending).toContain('<div class="mp-wait">compact 후 grok[1m](으)로 전환 대기 중</div>');
    m.setBusy('inst::C1:t1', 'model', true);
    expect(m.renderModelMenu(sess())).toContain('<div class="mp-wait">모델 전환 중…</div>');
  });

  it('pointing (mouse or arrows) lights the active row; otherwise the current row is lit', () => {
    const m = renderers();
    m.mpState({ active: 3, pointing: false });
    let blocks = optionBlocks(m.renderModelMenu(sess()));
    expect(blocks[0]).toContain('data-lit=""');
    expect(blocks[3]).toContain('data-active=""');
    expect(blocks[3]).not.toContain('data-lit');
    m.mpState({ active: 3, pointing: true });
    const html = m.renderModelMenu(sess());
    expect(html).toContain('aria-activedescendant="mp-opt-3" data-pointing=""');
    blocks = optionBlocks(html);
    expect(blocks[3]).toContain('data-lit=""');
    expect(blocks[0]).not.toContain('data-lit');
    m.mpState({ active: 0, pointing: false });
  });
});

describe('D4 — window · autocompact · cost bars: real quantities only', () => {
  it('segments = round(5·v/max), at least one for a known value, none for an unknown one', () => {
    const m = renderers();
    expect(m.mpSegments(1_000_000, 1_000_000)).toBe(5);
    expect(m.mpSegments(500_000, 1_000_000)).toBe(3);
    expect(m.mpSegments(600_000, 750_000)).toBe(4);
    expect(m.mpSegments(450_000, 750_000)).toBe(3);
    expect(m.mpSegments(15, 50)).toBe(2);
    expect(m.mpSegments(25, 50)).toBe(3);
    expect(m.mpSegments(1, 1000)).toBe(1);
    expect(m.mpSegments(0, 50)).toBe(0);
    expect(m.mpSegments(undefined, 50)).toBe(0);
    expect(m.mpSegments(5, 0)).toBe(0);
  });

  it('each row draws its three meters against the largest of the menu; no price, no cost meter', () => {
    const blocks = optionBlocks(renderers().renderModelMenu(sess()));
    expect(blocks.map(meterCounts)).toEqual([
      [5, 5, 3],
      [5, 5, 5],
      [5, 5, 2],
      [5, 4, 3],
      [5, 4, 5],
      [3, 3, '—'],
    ]);
    expect(blocks[0]).toContain('<span class="mp-meter" style="--c:2"><span class="mp-seg" style="--s:0" data-on="">');
  });
});

// ── D7 — effort ──
describe('D7 — effort is a radiogroup of the levels the model runs', () => {
  it('without a catalog menu: all five levels, the current checked and the only tab stop', () => {
    const html = renderers().renderEffortControl(sess());
    expect(html).toContain('role="radiogroup" aria-labelledby="mp-effort-label" style="--i:2;--n:5"');
    expect([...html.matchAll(/data-mp-effort="([^"]*)"/g)].map((x) => x[1])).toEqual(LEVELS);
    expect(html).toContain(
      '<button type="button" class="mp-seg-btn" role="radio" data-mp-effort="high" aria-checked="true" tabindex="0" aria-label="High">High</button>',
    );
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Extra high">XHigh</button>');
    expect(html).toContain('<span class="mp-thumb" aria-hidden="true"></span>');
    expect(html).not.toContain('mp-effort-cap');
  });

  it('with the model’s menu: only those levels; a capped level checks what runs and says what was set', () => {
    const html = renderers().renderEffortControl(
      sess({ effort: 'max', effortEffective: 'high', effortLevels: ['low', 'medium', 'high', 'ultra'] }),
    );
    expect([...html.matchAll(/data-mp-effort="([^"]*)"/g)].map((x) => x[1])).toEqual(['low', 'medium', 'high']);
    expect(html).toContain('style="--i:2;--n:3"');
    expect(html).toContain('data-mp-effort="high" aria-checked="true" tabindex="0"');
    expect(html).toContain('<span class="mp-effort-cap">설정 Max &rarr; 이 모델은 High까지 실행</span>');
  });

  it('an effort write in flight disables the group', () => {
    const m = renderers();
    m.setBusy('inst::C1:t1', 'effort', true);
    expect(m.renderEffortControl(sess())).toContain(
      'role="radiogroup" aria-labelledby="mp-effort-label" aria-disabled="true"',
    );
  });

  it('the menu carries it under the list, and a failed write shows in the menu too', () => {
    const m = load<Renderers>(
      RENDER_FNS,
      ['_busy', '_mp', 'EFFORT_LABELS', 'MP_EFFORT_SHORT'],
      {
        REPRESENTATIVE_MODELS: MODELS,
        EFFORT_LEVELS: LEVELS,
        _modelNotes: { 'inst::C1:t1': { text: '종료된 세션', error: true } },
      },
      [STATE_FN],
    );
    const html = m.renderModelMenu(sess());
    expect(html.indexOf('role="radiogroup"')).toBeGreaterThan(html.indexOf('role="listbox"'));
    expect(html).toContain('<div class="mp-err">종료된 세션</div>');
  });
});

// ── D8 — tray ──
describe('D8 — the tray: price per M tokens and window of the lit model', () => {
  it('input · output price and window; an unknown price says so', () => {
    const m = renderers();
    const opus = m.mpTray({ m: MODELS[0] });
    expect(strip(opus.html)).toBe('입력 $5 · 출력 $25 / M · 창 1.0M');
    expect(opus.html).toContain('<b class="mp-roll" data-mp-roll="input">$5</b>');
    expect(opus.html).toContain('<b class="mp-roll" data-mp-roll="output">$25</b>');
    expect(opus.sr).toBe('Opus 5.5 (1M): 입력 $5 · 출력 $25 / 백만 토큰, 창 1.0M');
    expect(strip(m.mpTray({ m: MODELS[5] }).html)).toBe('가격 정보 없음 · 창 500.0K');
    expect(strip(m.mpTray({ m: null, outside: true }).html)).toBe('전환 목록 밖 모델 · 가격 정보 없음');
  });

  it('dollars: whole when the target is whole, cents otherwise', () => {
    const m = renderers();
    expect(m.mpMoney(25)).toBe('$25');
    expect(m.mpMoney(12.37, 25)).toBe('$12');
    expect(m.mpMoney(2.5)).toBe('$2.50');
    expect(m.mpMoney(0.5, 0.5)).toBe('$0.50');
  });

  it('the foot has the key hints and one polite live region with the sentence', () => {
    const html = renderers().renderModelMenu(sess());
    expect(html).toContain(
      '<span class="mp-keys" aria-hidden="true"><kbd>&#x2191;&#x2193;</kbd><kbd>&#x21B5;</kbd></span>',
    );
    expect(html).toContain(
      '<span class="mp-sr" aria-live="polite">Opus 5.5 (1M): 입력 $5 · 출력 $25 / 백만 토큰, 창 1.0M</span>',
    );
    expect(html.match(/aria-live=/g)).toHaveLength(1);
  });

  it('the prices roll to the new row (ease-out over MP_ROLL_MS), and jump under reduced motion', () => {
    let now = 1000;
    const frames: Array<(t: number) => void> = [];
    const els = [
      { attr: 'input', textContent: '' },
      { attr: 'output', textContent: '' },
    ].map((e) => ({ ...e, getAttribute: () => e.attr }));
    const menu = { querySelectorAll: () => els };
    let reduce = false;
    const m = load<{ mpRollTray(menu: unknown, to: unknown): void } & Renderers>(
      ['toNum', 'mpMoney', 'mpRollTray'],
      ['_mp', 'MP_ROLL_MS'],
      {
        performance: { now: () => now },
        requestAnimationFrame: (f: (t: number) => void) => frames.push(f),
        cancelAnimationFrame: () => {},
        reduceMotion: () => reduce,
      },
      [STATE_FN],
    );
    m.mpRollTray(menu, { input: 5, output: 25 }); // first paint: nothing to roll from
    expect(frames).toHaveLength(0);
    m.mpRollTray(menu, { input: 10, output: 50 });
    expect(els[1].textContent).toBe('$25'); // starts where it was
    now += 280;
    frames.shift()!(now);
    const mid = Number(els[1].textContent.slice(1));
    expect(mid).toBeGreaterThan(40); // ease-out: most of the way at half time
    expect(mid).toBeLessThan(50);
    now += 280;
    frames.shift()!(now);
    expect(els.map((e) => e.textContent)).toEqual(['$10', '$50']);
    reduce = true;
    m.mpRollTray(menu, { input: 3, output: 15 });
    expect(frames).toHaveLength(0);
    expect(m.mpState().shown).toEqual({ input: 3, output: 15 });
  });
});

// ── D2 — placement ──
describe('D2 — the menu is placed from the trigger, inside the viewport', () => {
  type Place = { left: number; top: number; side: string };
  const m = {
    mpPlace: (r: unknown, w: number, h: number, vw: number, vh: number, side: string): Place =>
      load<{ mpPlace(...a: unknown[]): Place }>(['mpPlace'], []).mpPlace(r, w, h, vw, vh, side),
  };
  const rect = (left: number, top: number) => ({
    left,
    top,
    bottom: top + 30,
    right: left + 150,
    width: 150,
    height: 30,
  });

  it('below the trigger, its left edge on the trigger’s (align start)', () => {
    expect(m.mpPlace(rect(100, 200), 320, 400, 1440, 900, 'bottom')).toEqual({ left: 100, top: 236, side: 'bottom' });
  });
  it('flips above when there is no room below; the panel opens above and flips below when it must', () => {
    expect(m.mpPlace(rect(100, 700), 320, 400, 1440, 900, 'bottom')).toEqual({ left: 100, top: 294, side: 'top' });
    expect(m.mpPlace(rect(100, 700), 320, 400, 1440, 900, 'top')).toEqual({ left: 100, top: 294, side: 'top' });
    expect(m.mpPlace(rect(100, 60), 320, 400, 1440, 900, 'top')).toEqual({ left: 100, top: 96, side: 'bottom' });
  });
  it('kept 12px inside the viewport edges', () => {
    expect(m.mpPlace(rect(1300, 200), 320, 400, 1440, 900, 'bottom').left).toBe(1108);
    expect(m.mpPlace(rect(4, 200), 320, 400, 1440, 900, 'bottom').left).toBe(12);
    expect(m.mpPlace(rect(30, 200), 358, 400, 390, 844, 'bottom').left).toBe(20);
    expect(m.mpPlace(rect(100, 300), 320, 800, 1440, 600, 'bottom').top).toBe(12);
  });
});

describe('D2 — an anchor whose card moves closes the menu (column move, FLIP, reflow); a scroll does not', () => {
  const m = () =>
    load<{
      mpSpot(a: unknown): { left: number; top: number };
      mpMoved(at: unknown, now: unknown): boolean;
    }>(['mpSpot', 'mpMoved'], [], {
      getComputedStyle: (n: { fixed?: boolean }) => ({ position: n.fixed ? 'fixed' : 'static' }),
    });
  const anchor = (top: number, pageScroll: number, colScroll: number) => {
    const html = { nodeType: 1, scrollLeft: 0, scrollTop: pageScroll, parentNode: null };
    const col = { nodeType: 1, scrollLeft: 0, scrollTop: colScroll, parentNode: html };
    return { getBoundingClientRect: () => ({ left: 100, top }), parentNode: col };
  };
  // The panel's trigger: inside the fixed slide panel, which a page scroll does not move.
  const inPanel = (top: number, pageScroll: number, panelScroll: number) => {
    const html = { nodeType: 1, scrollLeft: 0, scrollTop: pageScroll, parentNode: null };
    const panel = { nodeType: 1, scrollLeft: 0, scrollTop: 0, fixed: true, parentNode: html };
    const inner = { nodeType: 1, scrollLeft: 0, scrollTop: panelScroll, parentNode: panel };
    return { getBoundingClientRect: () => ({ left: 1060, top }), parentNode: inner };
  };
  it('a fixed ancestor ends the walk: a page scroll under the panel is not a move (R1 fable P1)', () => {
    const at = m().mpSpot(inPanel(830, 0, 0));
    expect(m().mpMoved(at, m().mpSpot(inPanel(830, 400, 0)))).toBe(false); // the page scrolled, the panel did not move
    expect(m().mpMoved(at, m().mpSpot(inPanel(790, 0, 40)))).toBe(false); // a scroll inside the panel
    expect(m().mpMoved(at, m().mpSpot(inPanel(600, 0, 0)))).toBe(true); // the composer moved
    // A wheel over the menu stays in the menu (no scroll chained to the page).
    expect(/\.mp-pop \{[^}]*\}/.exec(STYLE)?.[0]).toContain('overscroll-behavior: contain;');
  });
  it('the spot takes every ancestor’s scroll out: page or column scrolls keep it, a layout move changes it', () => {
    const at = m().mpSpot(anchor(500, 0, 0));
    expect(at).toEqual({ left: 100, top: 500 });
    expect(m().mpMoved(at, m().mpSpot(anchor(380, 120, 0)))).toBe(false); // page scrolled 120
    expect(m().mpMoved(at, m().mpSpot(anchor(440, 0, 60)))).toBe(false); // column scrolled 60
    expect(m().mpMoved(at, m().mpSpot(anchor(820, 0, 0)))).toBe(true); // the card moved down
    expect(m().mpMoved(at, m().mpSpot(anchor(501, 0, 0)))).toBe(false); // sub-pixel jitter
    expect(m().mpMoved(null, at)).toBe(false);
  });
  it('the watcher runs only while the menu is open', () => {
    expect(clientFn('mpOpen')).toContain('_mp.at = mpSpot(btn);');
    expect(clientFn('mpOpen')).toContain('if (!_mp.watch) _mp.watch = setInterval(mpWatch, MP_WATCH_MS);');
    expect(clientFn('mpClose')).toContain('clearInterval(_mp.watch);');
    expect(clientFn('mpWatch')).toContain('if (!a || mpMoved(_mp.at, mpSpot(a))) mpClose(false);');
  });
});

// ── D9 / D11 — keyboard and picking ──
describe('D9 — keyboard: list arrows, pick, Escape, effort arrows', () => {
  function setup(over: Record<string, unknown> = {}) {
    const writes: string[] = [];
    const list = { classList: { contains: (c: string) => c === 'mp-list' }, focus: vi.fn() };
    const menu = {
      classList: { add: vi.fn(), remove: vi.fn() },
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      querySelector: (sel: string) => (sel === '.mp-list' ? list : null),
      querySelectorAll: () => [],
    };
    const trigger = {
      attrs: { 'data-mp-key': 'k', 'data-mp-surface': 'card', 'aria-expanded': 'true' } as Record<string, string>,
      getAttribute(n: string) {
        return this.attrs[n];
      },
      setAttribute(n: string, v: string) {
        this.attrs[n] = v;
      },
      focus: vi.fn(),
    };
    const document = {
      getElementById: (id: string) => (id === 'mp-menu' ? menu : null),
      querySelectorAll: (sel: string) => (sel === '.mp-trigger' ? [trigger] : []),
    };
    const changeModel = vi.fn();
    const changeEffort = vi.fn();
    const m = load<
      Renderers & {
        mpMenuKey(e: unknown): void;
        mpTriggerKey(e: unknown, btn: unknown): void;
      }
    >(
      [
        ...RENDER_FNS,
        'mpLit',
        'mpAnchor',
        'mpRepaint',
        'mpClose',
        'mpPick',
        'mpPickEffort',
        'mpListKey',
        'mpEffortKey',
        'mpMenuKey',
      ],
      RENDER_VARS,
      {
        REPRESENTATIVE_MODELS: MODELS,
        EFFORT_LEVELS: LEVELS,
        document,
        _sessionCache: { k: sess({ key: 'k', ...over }) },
        morphInnerHtml: (_el: unknown, html: string) => writes.push(html),
        mpRollTray: () => {},
        mpReposition: () => {},
        refreshCard: vi.fn(),
        repaintPanelControlsFor: vi.fn(),
        changeModel,
        changeEffort,
      },
      [STATE_FN],
    );
    m.mpState({ key: 'k', surface: 'card', active: 0, pointing: false });
    const key = (k: string, target: unknown = list, shiftKey = false) => {
      const e = { key: k, target, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      m.mpMenuKey(e);
      return e;
    };
    return { m, key, list, trigger, writes, changeModel, changeEffort };
  }

  it('↓ ↑ wrap, Home and End jump; arrows point (the active row lights up)', () => {
    const { m, key, writes } = setup();
    expect(key('ArrowDown').preventDefault).toHaveBeenCalled();
    expect(m.mpState()).toMatchObject({ active: 1, pointing: true });
    expect(writes[writes.length - 1]).toContain('aria-activedescendant="mp-opt-1" data-pointing=""');
    key('ArrowUp');
    key('ArrowUp');
    expect(m.mpState().active).toBe(5);
    key('Home');
    expect(m.mpState().active).toBe(0);
    key('End');
    expect(m.mpState().active).toBe(5);
    key('ArrowDown');
    expect(m.mpState().active).toBe(0);
  });

  it('Enter picks another model: the menu closes, focus goes back to the trigger, the switch is posted', () => {
    const { m, key, trigger, changeModel } = setup();
    key('End');
    key('Enter');
    expect(changeModel).toHaveBeenCalledWith('k', 'grok[1m]');
    expect(m.mpState().key).toBeNull();
    expect(trigger.attrs['aria-expanded']).toBe('false');
    expect(trigger.focus).toHaveBeenCalled();
  });

  it('Space on the current model just closes; Escape closes without letting the panel see it', () => {
    const a = setup();
    a.key(' ');
    expect(a.changeModel).not.toHaveBeenCalled();
    expect(a.m.mpState().key).toBeNull();
    const b = setup();
    const e = b.key('Escape');
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(b.m.mpState().key).toBeNull();
    expect(b.trigger.focus).toHaveBeenCalled();
  });

  it('a locked list (waiting switch) ignores Enter and stays open', () => {
    const { m, key, changeModel } = setup({ pendingModel: 'grok[1m]' });
    key('ArrowDown');
    key('Enter');
    expect(changeModel).not.toHaveBeenCalled();
    expect(m.mpState().key).toBe('k');
  });

  it('Tab leaves the menu back on the trigger from its last stop; Shift+Tab from the list', () => {
    const a = setup();
    a.key('Tab', a.list, true);
    expect(a.m.mpState().key).toBeNull();
    expect(a.trigger.focus).toHaveBeenCalled();
    const b = setup();
    const radio = { classList: { contains: () => false }, closest: () => radio, parentNode: null };
    b.key('Tab', radio);
    expect(b.m.mpState().key).toBeNull();
  });

  it('effort: → selects the next level at once and moves focus to it; ← wraps', () => {
    const { key, changeEffort } = setup();
    const btns = LEVELS.map((l) => ({
      level: l,
      focus: vi.fn(),
      getAttribute: (n: string) => (n === 'data-mp-effort' ? l : null),
    }));
    const group = { querySelectorAll: () => btns, getAttribute: () => null };
    // indexOf over the group compares identity: the button objects themselves are the targets.
    const target = (i: number) =>
      Object.assign(btns[i], {
        classList: { contains: () => false },
        closest: (sel: string) => (sel === '.mp-seg-btn' ? btns[i] : null),
        parentNode: group,
      });
    key('ArrowRight', target(2));
    expect(changeEffort).toHaveBeenCalledWith('k', 'xhigh');
    expect(btns[3].focus).toHaveBeenCalled();
    key('ArrowLeft', target(0));
    expect(changeEffort).toHaveBeenLastCalledWith('k', 'max');
  });

  it('Escape on an open trigger closes the menu and stops there (no card or panel Escape)', () => {
    const mpClose = vi.fn();
    const m = load<{ mpTriggerKey(e: unknown, btn: unknown): void } & Renderers>(
      ['mpTriggerKey'],
      ['_mp'],
      { mpClose, mpOpen: vi.fn() },
      [STATE_FN],
    );
    m.mpState({ key: 'k' });
    const e = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    m.mpTriggerKey(e, { getAttribute: (n: string) => (n === 'aria-expanded' ? 'true' : null) });
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(mpClose).toHaveBeenCalledWith(true);
    // The menu's own keydown stops every key (the board's shortcuts, the card's and the panel's Escape).
    expect(clientFn('mpMenuKey')).toMatch(/if \(!_mp\.key\) return;\n {2}e\.stopPropagation\(\);/);
    expect(clientFn('mpHost')).toContain("el.addEventListener('keydown', mpMenuKey);");
  });

  it('the trigger opens on ↓ / ↑ (Enter and Space are the button’s own click)', () => {
    const mpOpen = vi.fn();
    const m = load<{ mpTriggerKey(e: unknown, btn: unknown): void }>(['mpTriggerKey'], [], { mpOpen });
    const e = { key: 'ArrowDown', preventDefault: vi.fn() };
    m.mpTriggerKey(e, 'BTN');
    expect(mpOpen).toHaveBeenCalledWith('BTN');
    expect(e.preventDefault).toHaveBeenCalled();
    m.mpTriggerKey({ key: 'Enter', preventDefault: vi.fn() }, 'BTN');
    expect(mpOpen).toHaveBeenCalledTimes(1);
  });
});

describe('D9 — Tab moves between the menu’s two stops itself; past them focus goes home (R1 grok P1)', () => {
  // A fake DOM in which focus() moves document.activeElement and fires the page's focusin
  // listener (mpOutside), and an unprevented Tab does what a browser would in the worst
  // case: focus the page's next stop, outside the menu.
  function dom() {
    const doc: { activeElement: unknown } = { activeElement: null };
    let m: {
      mpMenuKey(e: unknown): void;
      mpOutside(e: unknown): void;
      mpState(p?: Record<string, unknown>): Record<string, unknown>;
    };
    const node = (cls: string, attrs: Record<string, string> = {}) => {
      const n: any = {
        cls,
        attrs: { ...attrs },
        classList: { contains: (c: string) => c === cls, add() {}, remove() {} },
        getAttribute(k: string) {
          return k in n.attrs ? n.attrs[k] : null;
        },
        setAttribute(k: string, v: string) {
          n.attrs[k] = v;
        },
        removeAttribute(k: string) {
          delete n.attrs[k];
        },
        closest: (sel: string) => (sel === '.mp-seg-btn' && cls === 'mp-seg-btn' ? n : null),
        contains: (x: unknown) => x === n,
        focus() {
          doc.activeElement = n;
          m.mpOutside({ target: n });
        },
      };
      return n;
    };
    const list = node('mp-list');
    const level = node('mp-seg-btn', { tabindex: '0' });
    const other = node('mp-seg-btn', { tabindex: '-1' });
    const menu = node('mp-pop', { id: 'mp-menu' });
    menu.contains = (x: unknown) => x === menu || x === list || x === level || x === other;
    menu.querySelector = (sel: string) =>
      sel === '.mp-list' ? list : sel === '.mp-seg-btn[tabindex="0"]' ? level : null;
    const trigger = node('mp-trigger', { 'data-mp-key': 'k', 'data-mp-surface': 'panel', 'aria-expanded': 'true' });
    const pageNext = node('cmd-input');
    const document = {
      getElementById: (id: string) => (id === 'mp-menu' ? menu : null),
      querySelectorAll: (sel: string) => (sel === '.mp-trigger' ? [trigger] : []),
      get activeElement() {
        return doc.activeElement;
      },
    };
    m = load<typeof m>(
      ['mpAnchor', 'mpInside', 'mpOutside', 'mpClose', 'mpMenuKey'],
      ['_mp'],
      {
        document,
        refreshCard: () => {},
        repaintPanelControlsFor: () => {},
        clearInterval: () => {},
        cancelAnimationFrame: () => {},
      },
      [STATE_FN],
    );
    const open = () => {
      m.mpState({ key: 'k', surface: 'panel' });
      trigger.attrs['aria-expanded'] = 'true';
      doc.activeElement = list;
    };
    const press = (key: string, shiftKey = false) => {
      const e = {
        key,
        shiftKey,
        target: doc.activeElement,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      m.mpMenuKey(e);
      if (key === 'Tab' && !e.defaultPrevented) pageNext.focus();
    };
    return { m, doc, list, level, trigger, open, press };
  }

  it('list → Tab → the checked level; Shift+Tab → back on the list; the menu stays open', () => {
    const d = dom();
    d.open();
    d.press('Tab');
    expect(d.doc.activeElement).toBe(d.level);
    expect(d.m.mpState().key).toBe('k');
    d.press('Tab', true);
    expect(d.doc.activeElement).toBe(d.list);
    expect(d.m.mpState().key).toBe('k');
  });

  it('Tab past the level or Shift+Tab before the list: closed, focus on the trigger (a later Escape is the trigger’s, not the panel’s)', () => {
    const a = dom();
    a.open();
    a.press('Tab');
    a.press('Tab');
    expect(a.m.mpState().key).toBeNull();
    expect(a.doc.activeElement).toBe(a.trigger);
    expect(a.trigger.attrs['aria-expanded']).toBe('false');
    const b = dom();
    b.open();
    b.press('Tab', true);
    expect(b.m.mpState().key).toBeNull();
    expect(b.doc.activeElement).toBe(b.trigger);
  });
});

describe('D9 — every open starts fresh; the current row closes', () => {
  it('reopening the same session from the other surface starts on its model, unlit (R1 grok P3)', () => {
    const menu = { removeAttribute() {}, classList: { add() {} }, querySelector: () => ({ focus() {} }) };
    const btn = (surface: string) => ({
      attrs: { 'data-mp-key': 'k', 'data-mp-surface': surface } as Record<string, string>,
      getAttribute(n: string) {
        return this.attrs[n] ?? null;
      },
      setAttribute(n: string, v: string) {
        this.attrs[n] = v;
      },
    });
    const m = load<{ mpOpen(b: unknown): void } & Renderers>(
      ['mpOptions', 'mpCurrentIndex', 'mpOpen'],
      ['_mp'],
      {
        REPRESENTATIVE_MODELS: MODELS,
        _sessionCache: { k: sess({ key: 'k', model: 'claude-sonnet-4-6[1m]' }) },
        mpHost: () => menu,
        mpClose: function (this: unknown) {
          (m as Renderers).mpState({ key: null, surface: null });
        },
        mpRepaint: () => {},
        mpSpot: () => ({ left: 0, top: 0 }),
        setInterval: () => 1,
        MP_WATCH_MS: 150,
        mpWatch: () => {},
      },
      [STATE_FN],
    );
    m.mpOpen(btn('card'));
    expect(m.mpState()).toMatchObject({ key: 'k', surface: 'card', active: 2, pointing: false });
    m.mpState({ active: 5, pointing: true });
    m.mpOpen(btn('panel'));
    expect(m.mpState()).toMatchObject({ key: 'k', surface: 'panel', active: 2, pointing: false });
  });

  it('Enter on the current row closes — also when the session’s model is outside the list (R1 fable P3)', () => {
    const mpClose = vi.fn();
    const changeModel = vi.fn();
    const m = load<{ mpPick(i: number): void } & Renderers>(
      ['isBusy', 'mpOptions', 'mpCurrentIndex', 'mpPick'],
      ['_mp', '_busy'],
      {
        REPRESENTATIVE_MODELS: MODELS,
        _sessionCache: { k: sess({ key: 'k', model: 'claude-haiku-4-5-20251001' }) },
        mpClose,
        changeModel,
      },
      [STATE_FN],
    );
    m.mpState({ key: 'k' });
    m.mpPick(0);
    expect(mpClose).toHaveBeenCalledWith(true);
    expect(changeModel).not.toHaveBeenCalled();
  });

  it('the menu element exists from boot, so every trigger’s aria-controls names it (R1 fable P3)', () => {
    expect(TEMPLATE).toMatch(/\nmpHost\(\);\n/);
  });
});

describe('D11 — one write per session and operation, by value', () => {
  it('a second model switch while the first is pending is refused; the peer surface shows busy at once', async () => {
    let release: (v: unknown) => void = () => {};
    const posts: string[] = [];
    const peer: boolean[] = [];
    const notes: Record<string, unknown> = {};
    const m = load<{ changeModel(k: string, n: string): Promise<void>; isBusy(k: string, op: string): boolean }>(
      ['isBusy', 'setBusy', 'modelSwitchNote', 'changeModel'],
      ['_busy'],
      {
        postModelSwitch: (_k: string, nick: string) => {
          posts.push(nick);
          return new Promise((r) => (release = r));
        },
        _modelNotes: notes,
        formatTokens: String,
        refreshCard: () => {},
        repaintPanelControlsFor: () => peer.push(m.isBusy('k', 'model')),
        loadSessions: () => {},
      },
    );
    const first = m.changeModel('k', 'sonnet[1m]');
    expect(peer).toEqual([true]);
    await m.changeModel('k', 'fable[1m]');
    expect(posts).toEqual(['sonnet[1m]']);
    release({ ok: true, result: { status: 'switched', nickname: 'sonnet[1m]', autoCompactTokens: 750000 } });
    await first;
    expect(m.isBusy('k', 'model')).toBe(false);
    expect(notes.k).toEqual({ text: 'sonnet[1m](으)로 전환 · autocompact 750000', error: false });
  });

  it('an effort change the server accepted is the session’s level at once (the menu does not wait for the poll)', async () => {
    const cache: Record<string, any> = { k: { key: 'k', effort: 'max', effortEffective: 'high' } };
    const repaints: string[] = [];
    const m = load<{ changeEffort(k: string, l: string): Promise<void> }>(
      ['isBusy', 'setBusy', 'effortLabel', 'effortSwitchNote', 'mpApplyEffort', 'changeEffort'],
      ['_busy', 'EFFORT_LABELS', '_mp'],
      {
        postEffortSwitch: async () => ({ ok: true, result: { status: 'switched', effort: 'low', effective: 'low' } }),
        _modelNotes: {},
        _sessionCache: cache,
        refreshCard: () => {},
        repaintPanelControlsFor: () => {},
        mpRepaint: () => repaints.push(cache.k.effort),
        loadSessions: () => {},
      },
      [STATE_FN],
    );
    (m as unknown as Renderers).mpState?.({ key: 'k' });
    await m.changeEffort('k', 'low');
    expect(cache.k.effort).toBe('low');
    expect(cache.k.effortEffective).toBeUndefined();
    expect(repaints[repaints.length - 1]).toBe('low');
  });
});

// ── D12 — live repaint guards ──
describe('D12 — an open menu holds its anchor still', () => {
  it('isPickingModel sees an expanded trigger inside the root', () => {
    const m = load<{ isPickingModel(root: unknown): boolean }>(['isPickingModel'], []);
    expect(
      m.isPickingModel({ querySelector: (s: string) => (s === '.mp-trigger[aria-expanded="true"]' ? {} : null) }),
    ).toBe(true);
    expect(m.isPickingModel({ querySelector: () => null })).toBe(false);
  });

  it('the panel controls: one trigger after "이 세션" for the owner, text for others; skipped while their menu is open', () => {
    const writes: string[] = [];
    let open = false;
    const el = {
      _html: '',
      querySelector: (s: string) => (open && s === '.mp-trigger[aria-expanded="true"]' ? {} : null),
    };
    const mpRepaint = vi.fn();
    const m = load<{ renderPanelControls(s: unknown): void }>(
      ['renderPanelControls'],
      ['_mp'],
      {
        document: { getElementById: (id: string) => (id === 'panel-controls' ? el : null) },
        currentUserId: 'U1',
        isSiblingSession: () => false,
        esc: (x: string) => x,
        renderModelPicker: (_s: unknown, can: boolean, _short: string, surface: string) => `[M:${can}:${surface}]`,
        renderEffortPicker: () => '[E]',
        renderModelNote: () => '[NOTE]',
        morphInnerHtml: (_e: unknown, h: string) => writes.push(h),
        mpRepaint,
      },
      [STATE_FN],
    );
    m.renderPanelControls({ key: 'k', ownerId: 'U1', model: 'claude-opus-5-5[1m]', effort: 'high' });
    expect(writes[writes.length - 1]).toBe('<span class="pc-scope">이 세션</span>[M:true:panel][NOTE]');
    m.renderPanelControls({ key: 'k2', ownerId: 'U2', model: 'claude-opus-5-5[1m]', effort: 'high' });
    expect(writes[writes.length - 1]).toBe('<span class="pc-scope">이 세션</span>[M:false:panel][E][NOTE]');
    open = true;
    (m as unknown as Renderers).mpState({ key: 'k' });
    const before = writes.length;
    m.renderPanelControls({ key: 'k', ownerId: 'U1', model: 'claude-fable-5-1[1m]', effort: 'low' });
    expect(writes.length).toBe(before);
    expect(mpRepaint).toHaveBeenCalled(); // the open menu follows the session instead
  });

  it('the card strip: the owner gets the trigger alone, others the text and the level', () => {
    const body = clientFn('renderCardBody');
    expect(body).toContain("renderModelPicker(s, true, modelShort, 'card')");
    expect(body).not.toContain('renderEffortPicker(s, canSwitchModel)');
  });
});

// ── D13–D15 — CSS ──
describe('D13–D15 — motion, tokens, responsive', () => {
  it('the menu is a fixed, 320px-at-most popover with its own container', () => {
    const rule = /\.mp-pop \{[^}]*\}/.exec(STYLE)?.[0] ?? '';
    expect(rule).toContain('position: fixed;');
    expect(rule).toContain('width: min(320px, calc(100vw - 32px));');
    expect(rule).toContain('container-type: inline-size;');
    expect(rule).toContain('transform: translateY(-4px) scale(0.96);');
    expect(STYLE).toContain('.mp-pop.is-open { opacity: 1; visibility: visible; transform: none;');
    expect(STYLE).toContain('transform: translateY(4px) scale(0.96)');
  });

  it('bars fill in order on the lit row; other rows step back while pointing; the thumb slides over n levels', () => {
    expect(STYLE).toContain('calc(var(--c) * 70ms + var(--s) * 45ms)');
    expect(STYLE).toContain('.mp-list[data-pointing] .mp-opt:not([data-active]) { opacity: 0.5; }');
    expect(STYLE).toContain('grid-template-columns: repeat(var(--n), 1fr)');
    expect(STYLE).toContain('transform: translateX(calc(var(--i) * 100%))');
    expect(STYLE).toContain('@keyframes mp-fill');
  });

  it('every new colour token has a light value', () => {
    const dark = /:root \{ (--mp-[^}]*)\}/.exec(STYLE)?.[1] ?? '';
    const light = /\[data-theme="light"\] \{ (--mp-[^}]*)\}/.exec(STYLE)?.[1] ?? '';
    const names = (s: string) => [...s.matchAll(/(--mp-[a-z-]+):/g)].map((x) => x[1]).sort();
    expect(names(dark).length).toBeGreaterThan(0);
    expect(names(light)).toEqual(names(dark));
  });

  it('narrow container, narrow or touch screens — in the menu’s own block (the shared 44px block stays as it was)', () => {
    expect(STYLE).toMatch(/@container \(max-width: 300px\) \{[^@]*\.mp-keys/);
    const own = STYLE.slice(STYLE.indexOf('@media (pointer: coarse), (max-width: 639px) {'));
    const block = own.slice(0, own.indexOf('\n}\n'));
    expect(block).toContain('.mp-trigger, .mp-seg-btn { min-height: 44px; }');
    expect(block).toContain('.mp-opt { min-height: 54px; }');
    // After the shared blocks: tests (and readers) take the first touch / reduced-motion block as the board's.
    expect(STYLE.indexOf('@media (pointer: coarse), (max-width: 639px) {')).toBeGreaterThan(
      STYLE.indexOf('@media (max-width: 639px), (pointer: coarse) {'),
    );
    expect(STYLE.indexOf('@media all and (prefers-reduced-motion: reduce) {')).toBeGreaterThan(
      STYLE.indexOf('@media (prefers-reduced-motion: reduce) {'),
    );
    const shared = STYLE.slice(STYLE.indexOf('@media (max-width: 639px), (pointer: coarse) {'));
    expect(shared.slice(0, shared.indexOf('\n}\n'))).not.toContain('.mp-');
  });

  it('reduced motion: no scale, no staggered fill — the delays go too, not only the durations', () => {
    // Its own block (all and …): the shared reduced-motion block, which other tests read as the first one, stays first.
    const own = STYLE.slice(STYLE.indexOf('@media all and (prefers-reduced-motion: reduce) {'));
    expect(own.slice(0, own.indexOf('\n}\n'))).toContain(
      '.mp-opt[data-lit] .mp-seg[data-on] { animation: none; transition-delay: 0s; }',
    );
  });
});

// ── D16 — the folds are gone ──
describe('D16 — one trigger does the fold’s job', () => {
  it('no fold toggles, no <select> pickers, no fold state', () => {
    for (const gone of [
      'cfb-model-toggle',
      'pc-toggle',
      'pc-pick',
      'toggleCardModel',
      'togglePanelControls',
      '_panelControlsOpen',
      '_cardModelOpen',
      'cb-model-select',
      'resetPicker',
    ]) {
      expect(TEMPLATE.includes(gone), gone).toBe(false);
    }
  });

  it('the page script declares every menu function once', () => {
    for (const name of [
      'mpOpen',
      'mpClose',
      'mpRepaint',
      'mpPlace',
      'mpHost',
      'renderModelMenu',
      'renderEffortControl',
    ]) {
      expect(declarationCount(name), name).toBe(1);
    }
  });
});
