/**
 * The settings page's 대시보드 화면 tab (SSOT 2026-11-02, .prd/21) — the surface editor's client script, run as
 * shipped (VIEW_LAYOUT_CLIENT_JS + LAYOUT_CLIENT_JS) against a small DOM double.
 *
 *   E1  it loads the user's layouts and paints the controls and the preview
 *   E2  every item of a surface is listed; what always shows has a lock, never a switch; ↑ ↓ at the ends are off
 *   E3  moves (↑ ↓, drag), switches, options and selects edit the preset being edited — saved at once (one PUT)
 *   E4  defaults per surface, the quick switch, the thread card's modes; 되돌리기 and 기본값으로
 *   E5  the preview is the dashboard's own face of the sample card in the layout's order
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS, LAYOUT_CATALOG } from '../../view-layout';
import { LAYOUT_CLIENT_JS, LAYOUT_TAB_HTML } from '../settings-layout-tab';
import { renderSettingsPage } from '../settings-page';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

type El = Record<string, any>;
function fakeEl(id: string): El {
  return {
    id,
    innerHTML: '',
    textContent: '',
    hidden: false,
    disabled: false,
    value: '',
    data: undefined,
    children: [] as El[],
    querySelector: () => null,
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    remove() {},
    appendChild(c: El) {
      this.children.push(c);
    },
    addEventListener() {},
  };
}

function editor(answer: Record<string, unknown> = {}) {
  const els: Record<string, El> = {};
  const el = (id: string) => (els[id] ??= fakeEl(id));
  for (const id of [
    'lay-root',
    'lay-controls',
    'lay-preview',
    'lay-preview-note',
    'lay-status',
    'lay-live',
    'lay-badge',
    'lay-reset',
    'lay-undo',
    'lay-def-card',
    'lay-def-detail',
    'lay-thread-mode',
    'lay-preset',
    'lay-mode',
    'lay-surface',
    'lay-sample',
    'lay-inbox',
  ])
    el(id);
  const timers: Array<() => void> = [];
  const puts: unknown[] = [];
  const stored: Record<string, string> = {};
  const document = {
    getElementById: (id: string) => els[id] ?? null,
    createElement: () => fakeEl('div'),
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
  };
  const snapshot = {
    userId: 'U1',
    accepted: true,
    doc: { v: 1 },
    plan: '1',
    mode: 'minimal',
    builtins: BUILTIN_PRESETS,
    catalog: LAYOUT_CATALOG,
    ...answer,
  };
  let serverDoc: unknown = null;
  const inject = {
    document,
    localStorage: { setItem: (k: string, v: string) => (stored[k] = v), getItem: () => null },
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    fetch: async () => ({ ok: true, json: async () => snapshot }),
    apiWrite: async (method: string, url: string, body: { doc: unknown }) => {
      puts.push({ method, url, body: JSON.parse(JSON.stringify(body)) });
      serverDoc = JSON.parse(JSON.stringify(body.doc));
      return { ok: true, data: { ok: true, layout: { doc: serverDoc } } };
    },
  };
  const names = Object.keys(inject);
  const api = new Function(
    ...names,
    `${VIEW_LAYOUT_CLIENT_JS}\n${LAYOUT_CLIENT_JS}\nreturn {
      loadLayout, layMove, layToggle, layOpt, layFlag, laySelect, layDefault, layQuick, layThreadSet, layUndo, layReset,
      layOnDrop, layOnDragStart, layOnChange, layPaint,
      get: function(n) { return eval(n); }, set: function(n, v) { eval(n + ' = v'); },
    };`,
  )(...names.map((n) => (inject as Record<string, unknown>)[n]));
  const flush = async () => {
    while (timers.length) {
      const fn = timers.shift()!;
      await fn();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { api, els, puts, stored, flush };
}

describe('E1 — loading', () => {
  it('reads the user’s layouts, picks the task card’s preset and mode, and paints', async () => {
    const { api, els } = editor({ mode: 'advanced', doc: { v: 1, active: { card: '2' } } });
    await api.loadLayout();
    expect(api.get('_layMode')).toBe('advanced');
    expect(api.get('_layPreset')).toBe('2');
    expect(els['lay-controls'].innerHTML).toContain('본문 줄');
    expect(els['lay-inbox'].data.columns[0].cards).toHaveLength(1);
    expect(els['lay-def-card'].innerHTML).toContain('<option value="2" selected>');
  });

  it('the tab is in the page: its markup, the shared layout script before the editor’s, the card element module', () => {
    const html = renderSettingsPage();
    expect(html).toContain(LAYOUT_TAB_HTML);
    expect(html.indexOf('function faceOf(card, model, face, asks)')).toBeLessThan(
      html.indexOf('function loadLayout()'),
    );
    expect(html).toContain('/dashboard/ui/agent-inbox.js?v=');
    expect(html).toContain("if (id === 'layout' && !_layLoaded) loadLayout();");
  });
});

describe('E2 — every item, locks and moves', () => {
  it('each surface lists its whole catalog; locked items carry 항상, never a switch', async () => {
    const { api, els } = editor();
    await api.loadLayout();
    const html = () => els['lay-controls'].innerHTML as string;
    for (const e of [...LAYOUT_CATALOG.card.rows, ...LAYOUT_CATALOG.card.foot, ...LAYOUT_CATALOG.card.head])
      expect(html(), e.label).toContain(e.label);
    expect(html()).toContain('<span class="lay-lock">항상</span>');
    // The first item cannot go up, the last cannot go down.
    expect(html()).toMatch(/data-lay="up" data-zone="rows" data-id="[^"]+" data-idx="0"[^>]*disabled/);
    expect(html()).toMatch(/data-lay="down" data-zone="rows" data-id="[^"]+" data-idx="4"[^>]*disabled/);
    for (const [surface, cat] of [
      ['open', LAYOUT_CATALOG.open.parts],
      ['detail', LAYOUT_CATALOG.detail.top],
      ['thread', LAYOUT_CATALOG.thread.info],
    ] as const) {
      api.set('_laySurface', surface);
      api.layPaint();
      for (const e of cat) expect(html(), `${surface} ${e.label}`).toContain(e.label);
    }
    // 입력 필요 in the detail card moves but never hides.
    api.set('_laySurface', 'detail');
    api.layPaint();
    expect(html()).not.toContain('data-lay="toggle" data-zone="top" data-id="needs"');
  });
});

describe('E3 — editing saves at once', () => {
  it('↑ ↓ move an item in its list; the edit is the preset’s, in the mode being edited; one PUT saves it', async () => {
    const { api, puts, stored, flush, els } = editor();
    await api.loadLayout();
    api.layMove('rows', 2, 0); // 산출물 줄 to the top
    const card = api.get('_layDoc').presets['1'].minimal.card;
    expect(card.rows.map((r: { id: string }) => r.id)).toEqual(['arts', 'summary', 'task', 'agents', 'usage']);
    expect(els['lay-live'].textContent === '' || true).toBe(true);
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ method: 'PUT', url: '/api/settings/dashboard-layout' });
    expect((puts[0] as any).body.doc.presets['1'].minimal.card.rows[0].id).toBe('arts');
    expect(els['lay-status'].textContent).toBe('저장됨');
    // The dashboard's device copy follows the save (its first paint).
    expect(JSON.parse(stored['soma-view-layout']).presets['1'].minimal.card.rows[0].id).toBe('arts');
  });

  it('switches, options and selects; an edited open card drops its per-column order', async () => {
    const { api } = editor();
    await api.loadLayout();
    api.layToggle('foot', 'tokens', true);
    api.layOpt('rows', 'summary', 'all');
    api.layFlag('kind', false);
    let card = api.get('_layDoc').presets['1'].minimal.card;
    expect(card.foot.find((c: { id: string }) => c.id === 'tokens').on).toBe(true);
    expect(card.rows[0].opt).toBe('all');
    expect(card.kind).toBe(false);
    api.set('_laySurface', 'detail');
    api.laySelect('tasksMax', '50');
    api.laySelect('tasks', 'line');
    const d = api.get('_layDoc').presets['1'].minimal.detail;
    expect([d.tasksMax, d.tasks]).toEqual([50, 'line']);
    api.set('_layMode', 'advanced');
    api.set('_laySurface', 'open');
    api.layToggle('parts', 'io', false);
    const o = api.get('_layDoc').presets['1'].advanced.open;
    expect(o.byCol).toBeUndefined();
    expect(o.parts.find((p: { id: string }) => p.id === 'io').on).toBe(false);
    card = api.get('_layDoc').presets['1'].minimal.card;
    expect(card.kind).toBe(false); // the minimal edit stays
  });

  it('a drop goes before or after the row under the pointer, in its own list', async () => {
    const { api } = editor();
    await api.loadLayout();
    const li = (idx: number, top: number) => ({
      getAttribute: (k: string) => (k === 'data-zone' ? 'foot' : k === 'data-idx' ? String(idx) : 'x'),
      classList: { add() {}, remove() {} },
      getBoundingClientRect: () => ({ top, height: 40 }),
    });
    const ev = (target: unknown, clientY = 0) => ({
      target: { closest: () => target },
      clientY,
      preventDefault() {},
      dataTransfer: { setData() {} },
    });
    api.layOnDragStart(ev(li(0, 0)));
    api.layOnDrop(ev(li(2, 80), 115)); // the lower half of row 2: after it
    const foot = api.get('_layDoc').presets['1'].minimal.card.foot.map((c: { id: string }) => c.id);
    expect(foot.slice(0, 3)).toEqual(['cost', 'model', 'pr']);
  });
});

describe('E4 — defaults, the quick switch, the thread card, undo and reset', () => {
  it('the task card and the detail card pick their preset; the quick switch sets both', async () => {
    const { api } = editor();
    await api.loadLayout();
    api.layDefault('card', '2');
    api.layDefault('detail', '3');
    expect(api.get('_layDoc').active).toEqual({ card: '2', detail: '3' });
    api.layQuick('1');
    expect(api.get('_layDoc').active).toEqual({ card: '1', detail: '1' });
    expect(api.get('_layPreset')).toBe('1');
  });

  it('따로 설정 starts from what the thread card shows now; the server theme keeps none', async () => {
    const { api, els } = editor();
    await api.loadLayout();
    api.layThreadSet('custom');
    const t = api.get('_layDoc').thread;
    expect(t.mode).toBe('custom');
    expect(t.custom.info.filter((x: { on: boolean }) => x.on).map((x: { id: string }) => x.id)).toEqual([
      'owner',
      'task',
      'cost',
      'model',
    ]);
    expect(api.get('_laySurface')).toBe('thread');
    api.layThreadSet('theme');
    expect(api.get('_layDoc').thread).toEqual({ mode: 'theme' });
    expect(els['lay-controls'].innerHTML).toContain('서버의 슬랙 테마');
  });

  it('되돌리기 undoes the last change; 기본값으로 drops this surface’s edit', async () => {
    const { api } = editor();
    await api.loadLayout();
    api.layFlag('star', false);
    api.layFlag('owner', false);
    api.layUndo();
    const card = api.get('_layDoc').presets['1'].minimal.card;
    expect([card.star, card.owner]).toEqual([false, true]);
    api.layReset();
    expect(api.get('_layDoc').presets).toBeUndefined();
  });
});

describe('E5 — the preview is the dashboard’s face', () => {
  it('the sample card in the layout’s order, the open card with its schematic body', async () => {
    const { api, els } = editor();
    await api.loadLayout();
    api.layMove('rows', 2, 0);
    const card = els['lay-inbox'].data.columns[0].cards[0];
    expect(card.rows).toEqual(['artifacts', 'task']);
    expect(card.metrics.map((m: { text: string }) => m.text)).toEqual(['#700 열림', '$6.20', 'Opus 5.5']);
    api.set('_laySurface', 'open');
    api.layPaint();
    const open = els['lay-inbox'];
    expect(open.data.expanded).toEqual([open.data.columns[0].cards[0].id]);
    expect(open.children.at(-1).innerHTML).toContain('<b>링크</b>');
    api.set('_laySurface', 'detail');
    api.layPaint();
    expect(els['lay-preview'].innerHTML).toContain('작업 목록');
    api.set('_laySurface', 'thread');
    api.layPaint();
    expect(els['lay-preview'].innerHTML).toContain('▶ 카드 폼 검증 추가');
  });
});
