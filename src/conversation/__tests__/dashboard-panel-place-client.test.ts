/**
 * 디테일 카드 위치 (SSOT 2026-11-19) — the page's side.
 *
 * SSOT_1: "1. 설정에서 "디테일 작업 카드" 패널을 왼쪽으로 변경할수 있게해줘. Lock 토글도.
 *          2. Lock토글이 안되어 있으면 디테일 작업 카드 상단바에 드래그 표시해주고 해당 부분 드래그해서 왼쪽으로 이동하게 해줘."
 *
 *   P1  the place on the page: the drawer's side, the root's data-panel-side, the grip only while unlocked
 *   P2  a released card lands on the half its centre is in — a flick on the side it heads for
 *   P3  in hand it follows the pointer and never leaves the window (a rubber band past the edges)
 *   P4  a drag that moves the card saves the place alone (PUT …/dashboard-layout/panel), with the CSRF retry
 *   P5  the markup and the CSS: the grip in the title bar, the two slots, the board beside a left dock
 *   P6  the board's cards glide when the card changes side (the layout mode carries the side)
 *
 * Executes the shipped client code cut out of renderDashboardPage()'s template literal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const CHG_TS = readFileSync(join(__dirname, '..', 'code-changes-client.ts'), 'utf-8');

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const head = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const asyncHead = TEMPLATE.indexOf(`\nasync function ${name}(`);
  const start = head >= 0 ? head : asyncHead;
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(
  fns: string[],
  vars: string[],
  inject: Record<string, unknown> = {},
  exportsExtra = '',
  prelude = '',
): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${prelude}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}${exportsExtra} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

// A small element: attributes, hidden, a style with custom properties.
function el(id = '') {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  return {
    id,
    hidden: false,
    title: '',
    attrs,
    props,
    setAttribute(k: string, v: string) {
      attrs[k] = String(v);
    },
    removeAttribute(k: string) {
      delete attrs[k];
    },
    getAttribute(k: string) {
      return k in attrs ? attrs[k] : null;
    },
    hasAttribute(k: string) {
      return k in attrs;
    },
    style: {
      setProperty(k: string, v: string) {
        props[k] = v;
      },
      removeProperty(k: string) {
        delete props[k];
      },
      getPropertyValue(k: string) {
        return props[k] || '';
      },
    },
  };
}

const PLACE_FNS = ['applyPanelPlace', 'panelMovable', 'panelWide'];
const PLACE_VARS = ['_panelPlace', '_panelPlaceWritable', 'PANEL_GRIP_LABEL', 'PANEL_DOCK_MQ'];

function placePage() {
  const root = el('html');
  const panel = el('slide-panel');
  const grip = el('panel-grip');
  const byId: Record<string, unknown> = { 'slide-panel': panel, 'panel-grip': grip };
  const document = { documentElement: root, getElementById: (id: string) => byId[id] ?? null };
  return { root, panel, grip, document };
}

describe('P1 — the place on the page', () => {
  it('left: the drawer docks left, the root says so (the board and the 변경점 viewer follow), the grip shows unlocked', () => {
    const page = placePage();
    const c = load<{ applyPanelPlace(p: unknown): boolean }>(PLACE_FNS, PLACE_VARS, { document: page.document });
    expect(c.applyPanelPlace({ side: 'left', locked: false })).toBe(true);
    expect(page.panel.getAttribute('side')).toBe('left');
    expect(page.root.getAttribute('data-panel-side')).toBe('left');
    expect(page.panel.hasAttribute('data-movable')).toBe(true);
    expect(page.grip.hidden).toBe(false);
    expect(page.grip.getAttribute('aria-label')).toBe('디테일 카드 옮기기 — 지금 왼쪽, 누르면 오른쪽으로');
    // The same place again moves nothing.
    expect(c.applyPanelPlace({ side: 'left', locked: false })).toBe(false);
  });

  it('locked: no grip and the bar does not drag (no data-movable); right is the drawer’s own default (no attribute)', () => {
    const page = placePage();
    const c = load<{ applyPanelPlace(p: unknown): boolean }>(PLACE_FNS, PLACE_VARS, { document: page.document });
    c.applyPanelPlace({ side: 'left', locked: false });
    expect(c.applyPanelPlace({ side: 'right', locked: true })).toBe(true);
    expect(page.panel.hasAttribute('side')).toBe(false);
    expect(page.root.getAttribute('data-panel-side')).toBe('right');
    expect(page.panel.hasAttribute('data-movable')).toBe(false);
    expect(page.grip.hidden).toBe(true);
  });

  it('nothing saved: right, unlocked — the grip is there to be found', () => {
    const page = placePage();
    const c = load<{ applyPanelPlace(p: unknown): boolean }>(PLACE_FNS, PLACE_VARS, { document: page.document });
    expect(c.applyPanelPlace(undefined)).toBe(false);
    expect(page.root.getAttribute('data-panel-side')).toBe('right');
    expect(page.grip.hidden).toBe(false);
  });
});

describe('P2 — where a released card lands', () => {
  const c = load<{ panelDropSide(cx: number, vw: number, vx: number): string }>(['panelDropSide'], ['PDRAG_FLICK']);
  it('the half of the window its centre is in', () => {
    expect(c.panelDropSide(300, 1440, 0)).toBe('left');
    expect(c.panelDropSide(719, 1440, 0)).toBe('left');
    expect(c.panelDropSide(720, 1440, 0)).toBe('right');
    expect(c.panelDropSide(1200, 1440, 0)).toBe('right');
  });
  it('a flick lands on the side it heads for, even short of the middle', () => {
    expect(c.panelDropSide(1100, 1440, -0.8)).toBe('left');
    expect(c.panelDropSide(300, 1440, 0.9)).toBe('right');
    // A slow drift is no flick.
    expect(c.panelDropSide(1100, 1440, -0.2)).toBe('right');
  });
});

describe('P3 — in hand the card follows the pointer and stays on screen', () => {
  const c = load<{ panelDragOffset(dx: number, left0: number, w: number, vw: number): number }>(
    ['panelDragOffset'],
    [],
  );
  // A 440px card docked right in a 1440px window: its left edge at 1000.
  it('inside the window it follows the pointer one to one', () => {
    expect(c.panelDragOffset(-300, 1000, 440, 1440)).toBe(-300);
    expect(c.panelDragOffset(-1000, 1000, 440, 1440)).toBe(-1000);
    expect(c.panelDragOffset(0, 1000, 440, 1440)).toBe(0);
  });
  it('past an edge it gives a quarter of the overshoot, 48px at most', () => {
    expect(c.panelDragOffset(-1100, 1000, 440, 1440)).toBe(-1025);
    expect(c.panelDragOffset(-5000, 1000, 440, 1440)).toBe(-1048);
    expect(c.panelDragOffset(80, 1000, 440, 1440)).toBe(20);
    expect(c.panelDragOffset(900, 1000, 440, 1440)).toBe(48);
  });
});

describe('P4 — a moved card saves the place alone', () => {
  type Saver = { savePanelPlace(p: { side: string; locked: boolean }): Promise<void> };
  function saver(responses: Array<{ status: number; body?: unknown }>) {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const fetch = vi.fn(async (url: string, init: never) => {
      calls.push({ url, init });
      const r = responses.shift() ?? { status: 200, body: { ok: true } };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
    });
    const items: Record<string, string> = {};
    const localStorage = {
      setItem: (k: string, v: string) => (items[k] = v),
      getItem: (k: string) => items[k] ?? null,
    };
    const toasts: unknown[] = [];
    const c = load<Saver & { layout(): unknown; saving(): number }>(
      ['savePanelPlace', 'putPanelPlace'],
      ['_panelPlaceSaving', '_panelPlaceRev', '_panelPlaceQueued', 'VIEW_LAYOUT_KEY'],
      { fetch, localStorage, dashToast: (t: unknown) => toasts.push(t) },
      ', layout: function() { return _viewLayout; }, saving: function() { return _panelPlaceSaving; }',
      "var _viewLayout = { v: 1, active: { card: '2' } }; var _csrfToken = 'T1'; async function refreshCsrfToken() { _csrfToken = 'T2'; }",
    );
    return { c, calls, items, toasts };
  }

  it('PUT …/dashboard-layout/panel with only the place; the page’s copy carries it before the answer', async () => {
    const { c, calls, items, toasts } = saver([{ status: 200, body: { ok: true } }]);
    const done = c.savePanelPlace({ side: 'left', locked: false });
    expect(c.saving()).toBe(1);
    expect(JSON.parse(items['soma-view-layout'])).toEqual({
      v: 1,
      active: { card: '2' },
      panel: { side: 'left', locked: false },
    });
    await done;
    expect(c.saving()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/settings/dashboard-layout/panel');
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.headers['X-CSRF-Token']).toBe('T1');
    expect(JSON.parse(calls[0].init.body)).toEqual({ panel: { side: 'left', locked: false } });
    expect(toasts).toEqual([]);
  });

  it('a 403 refreshes the CSRF token once and sends again; a refusal says why', async () => {
    const ok = saver([{ status: 403 }, { status: 200, body: { ok: true } }]);
    await ok.c.savePanelPlace({ side: 'left', locked: false });
    expect(ok.calls.map((x) => x.init.headers['X-CSRF-Token'])).toEqual(['T1', 'T2']);
    expect(ok.toasts).toEqual([]);
    const bad = saver([{ status: 400, body: { error: '디테일 카드 위치는 left 또는 right여야 합니다' } }]);
    await bad.c.savePanelPlace({ side: 'left', locked: false });
    expect(bad.toasts).toEqual([
      {
        title: '디테일 카드 위치를 저장하지 못했어요',
        description: '디테일 카드 위치는 left 또는 right여야 합니다',
        tone: 'error',
      },
    ]);
    expect(bad.c.saving()).toBe(0);
  });
});

describe('P5 — the markup and the CSS', () => {
  it('the grip is the title bar’s first child, a named button, hidden until the place says unlocked', () => {
    const head = TEMPLATE.indexOf('<div class="panel-header">');
    const grip = TEMPLATE.indexOf('id="panel-grip"');
    const title = TEMPLATE.indexOf('id="panel-title"');
    expect(head).toBeGreaterThan(0);
    expect(grip).toBeGreaterThan(head);
    expect(grip).toBeLessThan(title);
    expect(TEMPLATE).toMatch(/<button type="button" class="panel-grip" id="panel-grip" hidden aria-label="[^"]+"/);
  });
  it('the two slots sit before the drawer (its sibling rules stay), hidden, out of the pointer’s way', () => {
    const zones = TEMPLATE.indexOf('id="panel-dropzones"');
    const drawer = TEMPLATE.indexOf('<ui-drawer class="slide-panel"');
    expect(zones).toBeGreaterThan(0);
    expect(zones).toBeLessThan(drawer);
    expect(TEMPLATE).toContain('<div class="pdz" data-side="left">');
    expect(TEMPLATE).toContain('<div class="pdz" data-side="right">');
    expect(TEMPLATE).toMatch(/\.panel-dropzones \{[^}]*pointer-events: none/);
  });
  it('docked left, the board sits right of the card and the FAB keeps its corner; the 변경점 viewer takes the right', () => {
    expect(TEMPLATE).toMatch(
      /html\[data-panel-side="left"\] \.app:has\(> \.slide-panel\[open\]\) > \.main \{\s*margin-left: calc\(var\(--panel-w, 440px\) \+/,
    );
    expect(TEMPLATE).toContain('html[data-panel-side="left"] .slide-panel[open] ~ .new-task-fab { right: 16px; }');
    expect(CHG_TS).toContain(
      'html[data-panel-side="left"] dialog.chg-viewer[data-mode="panel"] { inset: var(--topbar-b, 0px) 0 0 var(--panel-w, 440px);',
    );
  });
  it('no grip and no slots on a sheet (below 840px)', () => {
    expect(TEMPLATE).toMatch(
      /@media \(max-width: 839px\) \{ \.panel-grip, \.panel-dropzones \{ display: none !important; \} \}/,
    );
  });
  it('the page starts from the device’s copy of the place, and every layout answer carries it', () => {
    expect(TEMPLATE).toMatch(
      /_viewLayout = readViewLayout\(\);\napplyViewMode\(\);\nsyncBoardScope\(\);\n[^\n]*\napplyPanelPlace\(panelPlaceOf\(_viewLayout\)\);/,
    );
    expect(clientFn('setViewLayout')).toContain('placePanel(panelPlaceOf(_viewLayout));');
  });
});

describe('P6 — the board glides when the card changes side', () => {
  // (the shared layout script's layoutSansPlace keys a rerender: see the last test)
  it('a card docked on the left is a layout of its own', () => {
    const fn = clientFn('currentLayoutMode');
    expect(fn).toContain("if (m.panel === 'docked' && _panelPlace.side === 'left') m.panel = 'docked-left';");
  });
  it('a place alone redraws no card: the layouts without the place key a rerender (one helper, both pages)', async () => {
    const { VIEW_LAYOUT_CLIENT_JS } = await import('../view-layout-client');
    const sans = new Function(`${VIEW_LAYOUT_CLIENT_JS}\nreturn layoutSansPlace;`)() as (d: unknown) => unknown;
    expect(sans({ v: 1, active: { card: '2' }, panel: { side: 'left', locked: true } })).toEqual({
      v: 1,
      active: { card: '2' },
    });
    expect(clientFn('setViewLayout')).toContain(
      'JSON.stringify(layoutSansPlace(d)) !== JSON.stringify(layoutSansPlace(_viewLayout))',
    );
  });
});

describe('P7 — review fixes (2026-11-19)', () => {
  type Place = { applyPanelPlace(p: unknown): boolean; panelMovable(): boolean };
  function page(wide: boolean) {
    const pg = placePage();
    const window = { matchMedia: (q: string) => ({ matches: q === '(min-width: 840px)' ? wide : false }) };
    return { pg, window };
  }

  it('a phone: the sheet keeps the drawer’s own side (it slides in from the right) — left is a dock, not a sheet', () => {
    const { pg, window } = page(false);
    const c = load<Place>(PLACE_FNS, PLACE_VARS, { document: pg.document, window });
    c.applyPanelPlace({ side: 'left', locked: false });
    expect(pg.panel.hasAttribute('side')).toBe(false);
    expect(pg.root.getAttribute('data-panel-side')).toBe('left');
    const wide = page(true);
    const w = load<Place>(PLACE_FNS, PLACE_VARS, { document: wide.pg.document, window: wide.window });
    w.applyPanelPlace({ side: 'left', locked: false });
    expect(wide.pg.panel.getAttribute('side')).toBe('left');
  });

  it('a user the server does not accept sees no grip: the move would be refused', () => {
    const { pg, window } = page(true);
    const c = load<Place & { setWritable(v: boolean): void }>(
      PLACE_FNS,
      PLACE_VARS,
      { document: pg.document, window },
      ', setWritable: function(v) { _panelPlaceWritable = v; }',
    );
    c.applyPanelPlace({ side: 'right', locked: false });
    expect(pg.grip.hidden).toBe(false);
    c.setWritable(false);
    c.applyPanelPlace({ side: 'right', locked: false });
    expect(pg.grip.hidden).toBe(true);
    expect(pg.panel.hasAttribute('data-movable')).toBe(false);
    expect(c.panelMovable()).toBe(false);
  });

  it('the settings answer says whether the place can be saved; the grip follows', () => {
    const fn = clientFn('loadMyDefaults');
    expect(fn).toMatch(
      /_panelPlaceWritable = !\(data && data\.accepted === false\);\s*\n\s*applyPanelPlace\(_panelPlace\);/,
    );
  });

  it('a press during a settle starts from where the card is drawn, measured against its dock', () => {
    const fn = clientFn('pdragDown');
    // The drawn box, then the dock without the settle's offset: the drag starts at the drawn place, its origin the dock.
    expect(fn).toMatch(
      /var box = panelBoxNow\(\);[\s\S]*pdragClear\(panel\);[\s\S]*var dock = panelBoxNow\(\) \|\| box;[\s\S]*var drawn = box\.left - dock\.left;/,
    );
    expect(fn).toContain('left0: dock.left');
    expect(clientFn('pdragEnd')).toContain(
      "if (!d.live) { if (d.off) pdragSettle(document.getElementById('slide-panel'), d.off); return; }",
    );
  });

  it('a touch on the title bar drags it on a tablet (pan-y), and the grip is 24px tall for a finger', () => {
    expect(TEMPLATE).toMatch(
      /@media \(min-width: 840px\) \{ \.slide-panel\[data-movable\] \.panel-header \{ touch-action: pan-y; \} \}/,
    );
    expect(TEMPLATE).toMatch(
      /@media \(pointer: coarse\) and \(min-width: 840px\) \{[^}]*\.panel-grip \{ height: 24px; \}/,
    );
  });
});

describe('P8 — PR review (review-of-legends): ordered saves, stale reads, the first move after a mid-glide grab', () => {
  // A fetch double whose PUTs answer only when the test lets them (in order of arrival).
  function net(getDoc: () => unknown) {
    const puts: Array<{ body: unknown; done: () => void }> = [];
    const gets: Array<(v: unknown) => void> = [];
    const fetch = vi.fn((url: string, init?: { method?: string; body?: string }) => {
      if (init && init.method === 'PUT') {
        return new Promise((res) => {
          puts.push({
            body: JSON.parse(init.body || '{}'),
            done: () => res({ ok: true, status: 200, json: async () => ({ ok: true }) }),
          });
        });
      }
      return new Promise((res) =>
        gets.push(() => res({ ok: true, status: 200, json: async () => ({ doc: getDoc() }) })),
      );
    });
    return { fetch, puts, gets };
  }
  const tick = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  type Page = {
    savePanelPlace(p: { side: string; locked: boolean }): Promise<void>;
    loadViewLayout(): Promise<void>;
    layout(): any;
  };
  function dash(n: ReturnType<typeof net>) {
    const placed: unknown[] = [];
    const c = load<Page>(
      ['savePanelPlace', 'putPanelPlace', 'loadViewLayout'],
      ['_panelPlaceSaving', '_panelPlaceRev', '_panelPlaceQueued', 'VIEW_LAYOUT_KEY', '_layoutLoads'],
      {
        fetch: n.fetch,
        localStorage: { setItem() {}, getItem: () => null },
        dashToast() {},
        setViewLayout: (d: unknown) => placed.push(JSON.parse(JSON.stringify(d))),
      },
      ', layout: function() { return _viewLayout; }',
      "var _viewLayout = { v: 1 }; var _csrfToken = 'T'; async function refreshCsrfToken() {}",
    );
    return { c, placed };
  }

  it('moves in a row go one at a time, in order; the moves made meanwhile send only the newest', async () => {
    const n = net(() => ({ v: 1 }));
    const { c } = dash(n);
    const a = c.savePanelPlace({ side: 'left', locked: false });
    const b = c.savePanelPlace({ side: 'right', locked: false }); // e.g. the toast's 실행 취소
    const d = c.savePanelPlace({ side: 'left', locked: false });
    await tick();
    expect(n.puts.map((x) => x.body)).toEqual([{ panel: { side: 'left', locked: false } }]);
    n.puts[0].done();
    await tick();
    // Only the newest of the two made meanwhile goes, after the first answered.
    expect(n.puts.map((x) => x.body)).toEqual([
      { panel: { side: 'left', locked: false } },
      { panel: { side: 'left', locked: false } },
    ]);
    n.puts[1].done();
    await Promise.all([a, b, d]);
    expect(n.puts).toHaveLength(2);
    expect(c.layout().panel).toEqual({ side: 'left', locked: false });
  });

  it('a layouts read that left before a move does not move the card back, even after the move saved', async () => {
    const n = net(() => ({ v: 1 })); // the server's copy as it was when the read left: no place
    const { c, placed } = dash(n);
    const reading = c.loadViewLayout();
    await tick();
    const saving = c.savePanelPlace({ side: 'left', locked: false });
    await tick();
    n.puts[0].done();
    await saving;
    n.gets[0](undefined);
    await reading;
    expect((placed[placed.length - 1] as any).panel).toEqual({ side: 'left', locked: false });
  });

  it('the first move after a mid-glide grab continues from where the card is drawn (no jump toward its dock)', () => {
    // The card is drawn 300px left of its right dock (x 700 of 1000), mid-glide; the press reads the drawn box, the
    // settle is dropped, the dock is read.
    const boxes = [
      { left: 700, w: 440 },
      { left: 1000, w: 440 },
    ];
    const panel = el('slide-panel');
    (panel as any).querySelector = () => null;
    const document = {
      documentElement: el('html'),
      getElementById: (id: string) => (id === 'slide-panel' ? panel : null),
    };
    const window = { addEventListener() {}, removeEventListener() {}, getSelection: () => null };
    const c = load<{ pdragDown(e: unknown): void; pdragMove(e: unknown): void }>(
      ['pdragDown', 'pdragMove', 'panelDragOffset', 'panelDropSide'],
      ['_pdrag', 'PDRAG_SLOP', 'PDRAG_FLICK', '_panelPlace'],
      {
        document,
        window,
        panelBoxNow: () => boxes.shift() ?? { left: 1000, w: 440 },
        panelMovable: () => true,
        panelDocked: () => true,
        pdragSource: () => true,
        pdragClear: (p: any) => {
          p.removeAttribute('data-pdrag');
          p.style.removeProperty('--pdrag-x');
        },
        panelViewW: () => 1440,
        paintDropZones() {},
        pdragUp() {},
        pdragCancel() {},
      },
    );
    const target = { closest: () => null };
    c.pdragDown({
      button: 0,
      isPrimary: true,
      pointerId: 7,
      clientX: 900,
      clientY: 20,
      timeStamp: 0,
      target,
      preventDefault() {},
    });
    // Held where it is drawn at the press.
    expect(panel.props['--pdrag-x']).toBe('-300px');
    c.pdragMove({ pointerId: 7, clientX: 910, clientY: 20, timeStamp: 16, preventDefault() {} });
    // 10px right of where it was drawn — not 10px right of its dock (which would be +10px).
    expect(panel.props['--pdrag-x']).toBe('-290px');
  });
});
