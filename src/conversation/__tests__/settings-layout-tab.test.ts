/**
 * The settings page's 대시보드 화면 tab (SSOT 2026-11-02, .prd/21) — the surface editor's client script, run as
 * shipped (VIEW_LAYOUT_CLIENT_JS + LAYOUT_CLIENT_JS) against a small DOM double.
 *
 *   E1  it loads the user's layouts and paints the controls and the preview
 *   E2  every item of a surface is listed; what always shows has a lock, never a switch; ↑ ↓ at the ends are off
 *   E3  moves (↑ ↓, drag), switches, options and selects edit the preset being edited — saved at once (one PUT)
 *   E4  defaults per surface, the quick switch, the thread card's modes; 되돌리기 and 기본값으로
 *   E5  the preview is the dashboard's own face of the sample card in the layout's order
 *   E6  미니멀 상세 카드: the 대화 · 작업 로그 tab switch (on in minimal) and its preview row
 *   E7  상세 카드 세 구역 (SSOT 2026-11-03): 타이틀 바 · 입력 필요 · 탭 바 · 아래 — the title bar's items and the tabs
 *       switch and move; the preview's tabs open and close as the card's do
 *   E8  디테일 카드 위치 (SSOT 2026-11-19): 왼쪽 · 오른쪽 and 위치 잠금 — saved alone and at once, outside 되돌리기;
 *       the whole-document save leaves the place out
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  followThreadLayout,
  LAYOUT_CATALOG,
  resolveLayouts,
  threadCardLines,
  threadLines,
} from '../../view-layout';
import { LAYOUT_CLIENT_JS, LAYOUT_TAB_HTML } from '../settings-layout-tab';
import { renderSettingsPage } from '../settings-page';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

// A change on a control of the editor (data-lay), and a few turns of the event loop.
const pick = (lay: string, value: string, checked = false) => ({
  target: { getAttribute: (k: string) => (k === 'data-lay' ? lay : null), value, checked },
});
const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};
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

function editor(
  answer: Record<string, unknown> = {},
  opts: {
    gate?: boolean;
    refusePlace?: boolean;
    refusePlaceFrom?: number;
    gatePlace?: boolean;
    gateGet?: boolean;
    failLayout?: boolean;
  } = {},
) {
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
    'lay-place',
    'lay-place-left',
    'lay-place-right',
    'lay-place-lock',
    'lay-place-lock-word',
    'lay-place-lock-hint',
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
    addEventListener() {},
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
  // With a gate, each PUT waits until the test releases it (a slow network).
  const gates: Array<() => void> = [];
  const placeGates: Array<() => void> = [];
  let placeCount = 0;
  const getGates: Array<() => void> = [];
  const release = async () => {
    gates.shift()?.();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const inject = {
    document,
    localStorage: { setItem: (k: string, v: string) => (stored[k] = v), getItem: (k: string) => stored[k] ?? null },
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    fetch: async () => {
      // The answer is the server's copy when the read left.
      const sent = JSON.parse(JSON.stringify(snapshot));
      if (opts.gateGet) await new Promise<void>((r) => getGates.push(r));
      return { ok: true, json: async () => sent };
    },
    apiWrite: async (method: string, url: string, body: { doc?: unknown; panel?: unknown }) => {
      puts.push({ method, url, body: JSON.parse(JSON.stringify(body)) });
      if (url === '/api/settings/dashboard-layout/panel') {
        const nth = placeCount++;
        if (opts.gatePlace) await new Promise<void>((r) => placeGates.push(r));
        if (opts.refusePlace || (opts.refusePlaceFrom !== undefined && nth >= opts.refusePlaceFrom))
          return { ok: false, error: '관리자 승인을 받은 뒤에 바꿀 수 있습니다' };
        // The server merges the fields a write names over the stored place and counts the write (writePanelPlace).
        const base = ((serverDoc as any) ?? (snapshot.doc as any)) || { v: 1 };
        const prev = base.panel || {};
        const doc = {
          ...base,
          panel: { side: 'right', locked: false, ...prev, ...(body.panel as object), rev: (prev.rev ?? 0) + 1 },
        };
        serverDoc = doc;
        return { ok: true, data: { ok: true, layout: { doc } } };
      }
      const sent = JSON.parse(JSON.stringify(body.doc));
      // The server keeps the stored place when the document leaves it out (writeLayout), as it is when handled.
      const kept = ((serverDoc as any) ?? (snapshot.doc as any))?.panel;
      if (opts.failLayout) return { ok: false, error: '레이아웃을 저장하지 못했습니다' };
      if (opts.gate) await new Promise<void>((r) => gates.push(r));
      const answer = kept && !sent.panel ? { ...sent, panel: kept } : sent;
      serverDoc = answer;
      return { ok: true, data: { ok: true, layout: { doc: answer } } };
    },
  };
  const names = Object.keys(inject);
  const api = new Function(
    ...names,
    `${VIEW_LAYOUT_CLIENT_JS}\n${LAYOUT_CLIENT_JS}\nreturn {
      loadLayout, layMove, layToggle, layOpt, layFlag, laySelect, layDefault, layQuick, layThreadSet, layUndo, layReset,
      layOnDrop, layOnDragStart, layOnChange, layOnClick, layPaint, layPlaceSave, layRefreshPlace,
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
  const releasePlace = async () => {
    placeGates.shift()?.();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  const releaseGet = async (at = 0) => {
    getGates.splice(at, 1)[0]?.();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  return { api, els, puts, stored, flush, timers, release, releasePlace, releaseGet, placeGates, getGates };
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
    expect(html()).toMatch(/data-lay="down" data-zone="rows" data-id="[^"]+" data-idx="5"[^>]*disabled/);
    for (const [surface, cat] of [
      ['open', LAYOUT_CATALOG.open.parts],
      ['detail', [...LAYOUT_CATALOG.detail.head, ...LAYOUT_CATALOG.detail.tabs]],
      ['thread', LAYOUT_CATALOG.thread.info],
    ] as const) {
      api.set('_laySurface', surface);
      api.layPaint();
      for (const e of cat) expect(html(), `${surface} ${e.label}`).toContain(e.label);
    }
    // 입력 필요 in the detail card is locked: never a switch, never in a tab.
    api.set('_laySurface', 'detail');
    api.layPaint();
    expect(html()).toContain('<span class="lay-name">입력 필요</span>');
    expect(html()).not.toContain('data-id="needs"');
  });
});

describe('E3 — editing saves at once', () => {
  it('↑ ↓ move an item in its list; the edit is the preset’s, in the mode being edited; one PUT saves it', async () => {
    const { api, puts, stored, flush, els } = editor();
    await api.loadLayout();
    api.layMove('rows', 3, 0); // 산출물 줄 to the top
    const card = api.get('_layDoc').presets['1'].minimal.card;
    expect(card.rows.map((r: { id: string }) => r.id)).toEqual(['arts', 'summary', 'task', 'links', 'agents', 'usage']);
    await flush();
    // The move is announced (the live region is set after a tick, so a repeat is read again).
    expect(els['lay-live'].textContent).toBe('산출물 줄 — 4번째에서 1번째로 옮겼습니다');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ method: 'PUT', url: '/api/settings/dashboard-layout' });
    expect((puts[0] as any).body.doc.presets['1'].minimal.card.rows[0].id).toBe('arts');
    expect(els['lay-status'].textContent).toBe('저장됨');
    // The dashboard's device copy follows the save (its first paint).
    expect(JSON.parse(stored['soma-view-layout']).presets['1'].minimal.card.rows[0].id).toBe('arts');
  });

  it('a slow save never undoes a change made while it ran (review P1, the autosave race)', async () => {
    const { api, puts, stored, timers, release } = editor({}, { gate: true });
    await api.loadLayout();
    const foot = () => {
      const f = api.get('_layDoc').presets['1'].minimal.card.foot;
      const on = (id: string) => f.find((c: { id: string }) => c.id === id).on;
      return { tokens: on('tokens'), model: on('model') };
    };
    api.layToggle('foot', 'tokens', true);
    timers.splice(0).forEach((fn) => fn()); // the debounce fires: PUT 1 leaves (tokens on, model on)
    expect(puts).toHaveLength(1);
    api.layToggle('foot', 'model', false); // while PUT 1 is on its way
    await release(); // PUT 1 answers with the document it was sent
    expect(foot()).toEqual({ tokens: true, model: false });
    timers.splice(0).forEach((fn) => fn());
    await release();
    await release();
    expect(foot()).toEqual({ tokens: true, model: false });
    const last = (puts[puts.length - 1] as any).body.doc.presets['1'].minimal.card.foot;
    expect(last.find((c: { id: string }) => c.id === 'model').on).toBe(false);
    const copy = JSON.parse(stored['soma-view-layout']).presets['1'].minimal.card.foot;
    expect(copy.find((c: { id: string }) => c.id === 'model').on).toBe(false);
  });

  it('a change saved while a PUT runs goes in one more PUT, and that answer is the one kept', async () => {
    const { api, puts, timers, release } = editor({}, { gate: true });
    await api.loadLayout();
    api.layToggle('foot', 'tokens', true);
    timers.splice(0).forEach((fn) => fn()); // PUT 1 leaves
    api.layToggle('foot', 'model', false);
    timers.splice(0).forEach((fn) => fn()); // its debounce fires while PUT 1 runs: queued, not a second PUT
    expect(puts).toHaveLength(1);
    await release(); // PUT 1 answers: an edit came after it, so the newer document leaves at once
    expect(puts).toHaveLength(2);
    await release();
    const f = api.get('_layDoc').presets['1'].minimal.card.foot;
    expect(f.find((c: { id: string }) => c.id === 'model').on).toBe(false);
    expect(f.find((c: { id: string }) => c.id === 'tokens').on).toBe(true);
    expect(api.get('_laySaving')).toBe(false);
  });

  it('coming back to the tab while a change is unsaved keeps the change (review residual)', async () => {
    const { api, timers, release } = editor({}, { gate: true });
    await api.loadLayout();
    const tokens = () =>
      api.get('_layDoc').presets['1'].minimal.card.foot.find((c: { id: string }) => c.id === 'tokens').on;
    api.layToggle('foot', 'tokens', true);
    await api.loadLayout(); // the debounce has not fired: the server still has the old document
    expect(tokens()).toBe(true);
    timers.splice(0).forEach((fn) => fn()); // PUT leaves
    await api.loadLayout(); // and is still on its way
    expect(tokens()).toBe(true);
    await release();
    expect(tokens()).toBe(true);
    expect(api.get('_layPending')).toBe(false);
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
    // 1안 미니멀's foot leads with 레포 · 채널 (SSOT 2026-11-05): row 0 (레포) lands after row 2 (PR).
    expect(foot.slice(0, 3)).toEqual(['channel', 'pr', 'repo']);
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

  it('따로 설정 starts from what the thread card shows now; the server theme keeps the custom card', async () => {
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
    // The custom card stays saved: 따로 설정 brings it back after the server theme (review P3).
    expect(api.get('_layDoc').thread).toEqual({ mode: 'theme', custom: t.custom });
    expect(els['lay-controls'].innerHTML).toContain('서버의 슬랙 테마');
    api.layThreadSet('custom');
    expect(api.get('_layDoc').thread).toEqual({ mode: 'custom', custom: t.custom });
    // 태스크 카드 따라가기로 (the reset on this surface) also keeps it (review P2).
    api.layReset();
    expect(api.get('_layDoc').thread).toEqual({ mode: 'follow', custom: t.custom });
  });

  it('the thread card follows the dashboard’s own mode, not the editor’s mode switch (review P2)', async () => {
    const { api, els } = editor({ mode: 'advanced' });
    await api.loadLayout();
    api.set('_layMode', 'minimal'); // the editor is showing minimal
    api.set('_laySurface', 'thread');
    api.layPaint();
    expect(els['lay-mode'].hidden).toBe(true);
    api.layThreadSet('custom');
    const want = followThreadLayout(resolveLayouts({ v: 1 }, 'advanced', '1').card);
    expect(api.get('_layDoc').thread.custom).toEqual(want);
    // What Slack shows for this user is the same card.
    expect(threadLines(want)).toEqual(threadCardLines({ v: 1 }, 'advanced', '1'));
    api.set('_laySurface', 'card');
    api.layPaint();
    expect(els['lay-mode'].hidden).toBe(false);
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
    api.layMove('rows', 3, 0);
    const card = els['lay-inbox'].data.columns[0].cards[0];
    expect(card.rows).toEqual(['artifacts', 'task', 'links']);
    // 작업 카드의 연결: the preview shows the linked issue, PR and wiki with their states; no PR chip (the row has it).
    expect(card.links.map((l: { text: string; status?: string }) => [l.text, l.status])).toEqual([
      ['PAY-12', 'In Progress'],
      ['#700', '열림'],
      ['결제 폼 설계', undefined],
    ]);
    // #805: the model as icons — the mark in its colour and the sample's effort; the name is the title.
    // SSOT 2026-11-05: the sample's repo and channel lead the foot (레포 · 채널).
    expect(card.metrics.map((m: { text: string }) => m.text)).toEqual(['app', '#pay', '$6.20', '']);
    expect(card.metrics[0]).toMatchObject({ title: '레포 example/app' });
    expect(card.metrics[3]).toMatchObject({
      glyph: 'claude',
      color: '#d97757',
      effort: 'high',
      label: '모델 Opus 5.5, 추론 강도 높음',
    });
    api.set('_laySurface', 'open');
    api.layPaint();
    const open = els['lay-inbox'];
    expect(open.data.expanded).toEqual([open.data.columns[0].cards[0].id]);
    expect(open.children.at(-1).innerHTML).toContain('<b>링크</b>');
    api.set('_laySurface', 'detail');
    api.layPaint();
    // The tab bar, every tab closed: the 작업 tab's count, not its list.
    expect(els['lay-preview'].innerHTML).toContain('data-v="tasks" aria-pressed="false">작업<span>2/4</span></button>');
    expect(els['lay-preview'].innerHTML).not.toContain('작업 목록');
    api.set('_laySurface', 'thread');
    api.layPaint();
    expect(els['lay-preview'].innerHTML).toContain('▶ 카드 폼 검증 추가');
  });
});

describe('E6 — 미니멀 상세 카드의 대화 · 작업 로그 탭 (SSOT 2026-11-03)', () => {
  it('the detail card lists the switch, on in minimal; the preview shows the two tabs, advanced the whole strip', async () => {
    const { api, els } = editor();
    await api.loadLayout();
    api.set('_laySurface', 'detail');
    api.layPaint();
    const controls = () => els['lay-controls'].innerHTML as string;
    const preview = () => els['lay-preview'].innerHTML as string;
    const TWO = '<div class="pv-tabs"><span>대화</span><span>작업 로그</span><span>변경점</span></div>';
    const ALL =
      '<div class="pv-tabs"><span>대화</span><span>작업 로그</span><span>변경점</span><span>에이전트 트리</span></div>';
    expect(controls()).toContain('대화 · 작업 로그 탭');
    expect(controls()).toContain('data-lay="flag" data-key="logtab" checked');
    expect(preview()).toContain(TWO);
    expect(preview()).not.toContain(ALL);
    // Off: the chat alone, no tab row.
    api.layFlag('logtab', false);
    api.layPaint();
    expect(api.get('_layDoc').presets['1'].minimal.detail.logtab).toBe(false);
    expect(preview()).not.toContain('<div class="pv-tabs"><span>대화</span>');
    api.set('_layMode', 'advanced');
    api.layPaint();
    expect(controls()).toContain('data-lay="flag" data-key="logtab"');
    expect(controls()).not.toContain('data-lay="flag" data-key="logtab" checked');
    expect(preview()).toContain(ALL);
    expect(preview()).not.toContain(TWO);
  });
});

describe('E7 — 상세 카드 세 구역: 타이틀 바 · 탭 바 · 아래 (SSOT 2026-11-03; 입력 필요 in the chat — 2026-11-13)', () => {
  const zones = (html: string) =>
    [...html.matchAll(/<section class="lay-zone"><header><h3>([^<]+)<\/h3>/g)].map((m) => m[1]);

  it('the detail card is edited as it reads: 타이틀 바, 탭 바, 아래 (입력 필요 locked in 아래, after the chat)', async () => {
    const { api, els } = editor();
    await api.loadLayout();
    api.set('_laySurface', 'detail');
    api.layPaint();
    const html = els['lay-controls'].innerHTML as string;
    expect(zones(html)).toEqual(['타이틀 바', '탭 바', '아래']);
    // 아래 lists, locked and as the card reads: the chat, 입력 필요 (its last message), the composer.
    const bottom = html.slice(html.lastIndexOf('<section class="lay-zone"><header><h3>아래</h3>'));
    expect(bottom.indexOf('<span class="lay-name">채팅</span>')).toBeGreaterThan(-1);
    expect(bottom.indexOf('<span class="lay-name">입력 필요</span>')).toBeGreaterThan(
      bottom.indexOf('<span class="lay-name">채팅</span>'),
    );
    expect(bottom.indexOf('<span class="lay-name">입력창</span>')).toBeGreaterThan(
      bottom.indexOf('<span class="lay-name">입력 필요</span>'),
    );
    // The title bar's items and the tabs are lists: switches and ↑ ↓.
    for (const id of ['model', 'cost', 'tokens', 'speed', 'ctx', 'owner', 'workflow'])
      expect(html, id).toContain(`data-lay="toggle" data-zone="head" data-id="${id}"`);
    for (const id of ['goal', 'tasks', 'agents', 'artifacts', 'info'])
      expect(html, id).toContain(`data-lay="toggle" data-zone="tabs" data-id="${id}"`);
    expect(html).toContain('data-lay="toggle" data-zone="head" data-id="speed" checked');
    expect(html).not.toContain('data-lay="toggle" data-zone="head" data-id="owner" checked');
    // The tab bar's own switches come after its tabs.
    const tabs = html.slice(html.indexOf('<h3>탭 바</h3>'), html.indexOf('<h3>아래</h3>'));
    expect(tabs.indexOf('data-zone="tabs" data-id="info"')).toBeLessThan(tabs.indexOf('data-key="agenthead"'));
    expect(tabs).toContain('<span>작업 탭 보기</span>');
  });

  it('a switch and a move edit this preset’s title bar and tabs; the preview follows', async () => {
    const { api, els, puts, flush } = editor();
    await api.loadLayout();
    api.set('_laySurface', 'detail');
    api.layToggle('head', 'cost', false);
    api.layToggle('head', 'owner', true);
    api.layMove('tabs', 2, 0);
    api.layToggle('tabs', 'artifacts', false);
    const d = api.get('_layDoc').presets['1'].minimal.detail;
    expect(d.head.filter((x: { on: boolean }) => x.on).map((x: { id: string }) => x.id)).toEqual([
      'model',
      'tokens',
      'speed',
      'owner',
    ]);
    expect(d.tabs.filter((x: { on: boolean }) => x.on).map((x: { id: string }) => x.id)).toEqual([
      'agents',
      'goal',
      'tasks',
    ]);
    const pv = els['lay-preview'].innerHTML as string;
    expect(pv).toContain(
      '<span class="pv-m">● Opus 5.5</span><span class="pv-m">6.4M 토큰</span><span class="pv-m">97 tok/s</span><span class="pv-m">Zhuge</span>',
    );
    expect(pv).not.toContain('$6.20');
    expect(pv.indexOf('data-v="agents"')).toBeLessThan(pv.indexOf('data-v="goal"'));
    expect(pv).not.toContain('data-v="artifacts"');
    await flush();
    // Saved (this harness's clearTimeout keeps every debounce, so each edit is a PUT): the last one is the document.
    const last = puts[puts.length - 1] as { body: { doc: { presets: Record<string, any> } } };
    expect(last.body.doc.presets['1'].minimal.detail.tabs).toEqual(d.tabs);
  });

  it('the preview’s tabs start closed; a press opens one tab’s content, a second press closes it', async () => {
    const { api, els } = editor();
    await api.loadLayout();
    api.set('_laySurface', 'detail');
    api.layPaint();
    const pv = () => els['lay-preview'].innerHTML as string;
    expect(pv()).not.toContain('pv-tabbody');
    const press = (v: string) => {
      const btn = {
        getAttribute: (k: string) => (k === 'data-lay' ? 'pvtab' : k === 'data-v' ? v : null),
        tagName: 'BUTTON',
      };
      api.layOnClick({ target: { closest: () => btn } });
    };
    press('goal');
    expect(pv()).toContain('data-v="goal" aria-pressed="true"');
    expect(pv()).toContain('<div class="pv-tabbody"><div><b>목표</b>');
    press('tasks');
    expect(pv()).toContain('<div class="pv-tabbody"><div><b>작업 목록</b>');
    expect(pv()).toContain('data-v="goal" aria-pressed="false"');
    press('tasks');
    expect(pv()).not.toContain('pv-tabbody');
    // 입력 필요 is the chat's last message, after the tab bar and before the composer (the 질문 대기 sample).
    api.set('_laySample', 'wait');
    api.layPaint();
    expect(pv().indexOf('<b>입력 필요</b>')).toBeGreaterThan(pv().indexOf('pv-midbar'));
    expect(pv().indexOf('<b>입력 필요</b>')).toBeGreaterThan(pv().indexOf('검증 규칙 4개를 추가했습니다'));
    expect(pv().indexOf('<b>입력 필요</b>')).toBeLessThan(pv().indexOf('pv-composer'));
  });
});

describe('E8 — 디테일 카드 위치: 왼쪽 · 오른쪽 and 위치 잠금 (SSOT 2026-11-19)', () => {
  it('the section is in the tab: two pictures as radio buttons, then the lock switch with its hint', () => {
    expect(LAYOUT_TAB_HTML).toContain('<h2 id="h-lay-place">디테일 카드 위치</h2>');
    expect(LAYOUT_TAB_HTML).toMatch(
      /<input type="radio" name="lay-place-side" id="lay-place-left" value="left" data-lay="place-side">/,
    );
    expect(LAYOUT_TAB_HTML).toMatch(
      /<input type="radio" name="lay-place-side" id="lay-place-right" value="right" data-lay="place-side">/,
    );
    expect(LAYOUT_TAB_HTML).toMatch(/<input type="checkbox" role="switch" id="lay-place-lock" data-lay="place-lock"/);
    expect(LAYOUT_TAB_HTML).toContain('<span class="lay-name" id="lay-place-lock-name">위치 잠금</span>');
    // Before the editor's toolbar: it is a setting of the dashboard, not of a preset.
    expect(LAYOUT_TAB_HTML.indexOf('id="lay-place"')).toBeLessThan(LAYOUT_TAB_HTML.indexOf('class="lay-bar"'));
  });

  it('nothing saved: right, unlocked — the hint says the grip moves it', async () => {
    const { api, els } = editor();
    await api.loadLayout();
    expect(els['lay-place-right'].checked).toBe(true);
    expect(els['lay-place-left'].checked).toBe(false);
    expect(els['lay-place-lock'].checked).toBe(false);
    expect(els['lay-place-lock-word'].textContent).toBe('꺼짐');
    expect(els['lay-place-lock-hint'].textContent).toContain('손잡이를 끌어 반대쪽에 놓을 수 있습니다');
    expect(els['lay-place'].attrs['data-locked']).toBe('false');
  });

  it('a saved place shows as saved', async () => {
    const { api, els } = editor({ doc: { v: 1, panel: { side: 'left', locked: true } } });
    await api.loadLayout();
    expect(els['lay-place-left'].checked).toBe(true);
    expect(els['lay-place-lock'].checked).toBe(true);
    expect(els['lay-place-lock-word'].textContent).toBe('켜짐');
    expect(els['lay-place-lock-hint'].textContent).toContain('손잡이가 없고');
    expect(els['lay-place'].attrs['data-locked']).toBe('true');
  });

  it('왼쪽 and 잠금 save at once, each alone (PUT …/panel) — no whole-document save, nothing to undo', async () => {
    const { api, els, puts, flush, stored } = editor();
    await api.loadLayout();
    await api.layOnChange(pick('place-side', 'left'));
    expect(puts).toEqual([
      { method: 'PUT', url: '/api/settings/dashboard-layout/panel', body: { panel: { side: 'left' } } },
    ]);
    expect(els['lay-place-left'].checked).toBe(true);
    expect(els['lay-status'].textContent).toBe('저장됨');
    expect(JSON.parse(stored['soma-view-layout']).panel).toMatchObject({ side: 'left', locked: false });
    await api.layOnChange(pick('place-lock', '', true));
    expect(puts[1]).toEqual({
      method: 'PUT',
      url: '/api/settings/dashboard-layout/panel',
      body: { panel: { locked: true } },
    });
    expect(els['lay-place-lock-word'].textContent).toBe('켜짐');
    // No whole-document save follows, and 되돌리기 has nothing of it.
    await flush();
    expect(puts.filter((x: any) => x.url === '/api/settings/dashboard-layout')).toHaveLength(0);
    expect(api.get('_layUndo')).toHaveLength(0);
  });

  it('the layouts’ save leaves the place out (the dashboard may have moved it); 되돌리기 keeps the place', async () => {
    const { api, els, puts, flush } = editor({ doc: { v: 1, panel: { side: 'left', locked: false } } });
    await api.loadLayout();
    api.layDefault('card', '2');
    await flush();
    const whole = puts.find((x: any) => x.url === '/api/settings/dashboard-layout') as any;
    expect(whole.body.doc).toEqual({ v: 1, active: { card: '2' } });
    // After the layouts save the place is still the saved one, on the page and in the controls.
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: false });
    expect(els['lay-place-left'].checked).toBe(true);
    await api.layOnChange(pick('place-side', 'right'));
    api.layUndo();
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'right', locked: false });
    expect(api.get('_layDoc').active).toBeUndefined();
  });

  it('a refused place goes back to what is saved and says why', async () => {
    const { api, els } = editor({}, { refusePlace: true });
    await api.loadLayout();
    await api.layOnChange(pick('place-side', 'left'));
    expect(els['lay-place-right'].checked).toBe(true);
    // The place shown is the saved one (nothing saved: the default).
    expect(api.get('layPlaceShown()')).toMatchObject({ side: 'right', locked: false });
    expect(els['lay-status'].textContent).toBe('저장하지 못했습니다 — 관리자 승인을 받은 뒤에 바꿀 수 있습니다');
  });

  it('a user not yet accepted sees the place, not a control that would be refused', async () => {
    const { api, els } = editor({ accepted: false });
    await api.loadLayout();
    expect(els['lay-place-left'].disabled).toBe(true);
    expect(els['lay-place-right'].disabled).toBe(true);
    expect(els['lay-place-lock'].disabled).toBe(true);
  });

  it('back on the page, a drag made on the dashboard meanwhile shows', async () => {
    const doc: Record<string, unknown> = { v: 1 };
    const { api, els } = editor({ doc });
    await api.loadLayout();
    expect(els['lay-place-right'].checked).toBe(true);
    // The server now has the place the dashboard saved (its next revision).
    doc.panel = { side: 'left', locked: false, rev: 1 };
    await api.layRefreshPlace();
    expect(els['lay-place-left'].checked).toBe(true);
  });
});

describe('E9 — a layouts save racing a place save keeps the newer place (review 2026-11-19)', () => {
  it('the layouts’ answer that left before the place was picked does not paint it back', async () => {
    const { api, els, puts, flush, stored, release } = editor({ doc: { v: 1 } }, { gate: true });
    await api.loadLayout();
    api.layDefault('card', '2');
    // The debounced layouts PUT goes out and waits on the network …
    const saving = flush();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(puts.filter((x: any) => x.url === '/api/settings/dashboard-layout')).toHaveLength(1);
    // … the reader picks 왼쪽 meanwhile (its own PUT answers at once).
    await api.layOnChange({
      target: { getAttribute: (k: string) => (k === 'data-lay' ? 'place-side' : null), value: 'left', checked: false },
    });
    expect(els['lay-place-left'].checked).toBe(true);
    // Now the layouts PUT answers with the document it carried — no place in it.
    await release();
    await saving;
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: false });
    expect(els['lay-place-left'].checked).toBe(true);
    expect(JSON.parse(stored['soma-view-layout']).panel).toMatchObject({ side: 'left', locked: false });
  });

  it('loading while a place save is on its way keeps the place picked here', async () => {
    const doc: Record<string, unknown> = { v: 1 };
    const { api } = editor({ doc });
    await api.loadLayout();
    api.set('_layDoc', { v: 1, panel: { side: 'left', locked: true } });
    api.set('_layPlaceSaving', 1);
    await api.loadLayout();
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: true });
  });
});

describe('E10 — PR review (review-of-legends): place saves in order, stale reads (2026-11-19)', () => {
  it('왼쪽 then 잠금 before the first answer: one PUT at a time, the second carries both choices', async () => {
    const { api, els, puts, releasePlace } = editor({}, { gatePlace: true });
    await api.loadLayout();
    const a = api.layOnChange(pick('place-side', 'left'));
    await tick();
    const b = api.layOnChange(pick('place-lock', '', true));
    await tick();
    const placePuts = () => puts.filter((x: any) => x.url === '/api/settings/dashboard-layout/panel');
    expect(placePuts()).toHaveLength(1);
    await releasePlace();
    expect(placePuts().map((x: any) => x.body.panel)).toEqual([{ side: 'left' }, { locked: true }]);
    await releasePlace();
    await Promise.all([a, b]);
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: true });
    expect(els['lay-place-lock'].checked).toBe(true);
    expect(els['lay-status'].textContent).toBe('저장됨');
  });

  it('a refresh read that left before a pick does not paint the old place back after the pick saved', async () => {
    const doc: Record<string, unknown> = { v: 1 };
    const { api, els, releaseGet } = editor({ doc }, { gateGet: true });
    const first = api.loadLayout();
    await releaseGet();
    await first;
    // The tab comes back: a read leaves …
    const refresh = api.layRefreshPlace();
    await tick();
    // … the reader picks 왼쪽, and its PUT answers before the read does.
    await api.layOnChange(pick('place-side', 'left'));
    await releaseGet();
    await refresh;
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: false });
    expect(els['lay-place-left'].checked).toBe(true);
  });
});

describe('E11 — PR review round 2: saves pending when a request leaves, refresh order, status (2026-11-19)', () => {
  it('a layouts PUT that left while a place save was on its way keeps the place, even answering after it', async () => {
    const { api, els, flush, release, releasePlace, stored } = editor(
      { doc: { v: 1 } },
      { gate: true, gatePlace: true },
    );
    await api.loadLayout();
    const placing = api.layOnChange(pick('place-side', 'left'));
    await tick();
    api.layDefault('card', '2');
    const saving = flush(); // the layouts PUT leaves (handled now: the stored place is still none)
    await tick();
    await releasePlace(); // the place PUT answers first
    await placing;
    await release(); // then the layouts PUT's answer arrives, with the place as it was when handled
    await saving;
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: false });
    expect(els['lay-place-left'].checked).toBe(true);
    expect(JSON.parse(stored['soma-view-layout']).panel).toMatchObject({ side: 'left', locked: false });
  });

  it('a layouts answer never publishes a place to the shared copy (another tab may have moved the card since)', async () => {
    const { api, flush, stored } = editor({ doc: { v: 1, panel: { side: 'right', locked: false } } });
    await api.loadLayout();
    stored['soma-view-layout'] = JSON.stringify({ v: 1, panel: { side: 'left', locked: false } }); // a dashboard drag
    api.layDefault('card', '2');
    await flush();
    expect(JSON.parse(stored['soma-view-layout'])).toMatchObject({
      v: 1,
      active: { card: '2' },
      panel: { side: 'left', locked: false },
    });
  });

  it('two refresh reads answering out of order: the older answer does not paint over the newer', async () => {
    const doc: Record<string, unknown> = { v: 1, panel: { side: 'right', locked: false } };
    const { api, els, releaseGet } = editor({ doc }, { gateGet: true });
    const first = api.loadLayout();
    await releaseGet();
    await first;
    const older = api.layRefreshPlace(); // reads right
    await tick();
    doc.panel = { side: 'left', locked: false, rev: 9 }; // another tab moves the card
    const newer = api.layRefreshPlace(); // reads left
    await tick();
    await releaseGet(1); // the newer answers first
    await newer;
    expect(els['lay-place-left'].checked).toBe(true);
    await releaseGet(0); // then the older
    await older;
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: false });
    expect(els['lay-place-left'].checked).toBe(true);
  });

  it('a failed layouts save keeps saying so after a place saves — the place is not the layouts', async () => {
    const { api, els, flush } = editor({}, { failLayout: true });
    await api.loadLayout();
    api.layDefault('card', '2');
    await flush();
    expect(els['lay-status'].textContent).toContain('저장하지 못했습니다');
    await api.layOnChange(pick('place-side', 'left'));
    expect(els['lay-status'].textContent).toContain('저장하지 못했습니다');
  });
});

describe('E12 — PR review round 3 (2026-11-19)', () => {
  it('a layouts save that ends while a place save is on its way does not say 저장됨', async () => {
    const { api, els, flush, releasePlace } = editor({}, { gatePlace: true });
    await api.loadLayout();
    const placing = api.layOnChange(pick('place-side', 'left'));
    await tick();
    api.layDefault('card', '2');
    await flush();
    expect(els['lay-status'].textContent).toBe('저장 중…');
    await releasePlace();
    await placing;
    expect(els['lay-status'].textContent).toBe('저장됨');
  });

  it('a queued choice refused after an earlier one saved: back to the saved one, published, the failure shown', async () => {
    const { api, els, releasePlace, stored } = editor({}, { gatePlace: true, refusePlaceFrom: 1 });
    await api.loadLayout();
    const a = api.layOnChange(pick('place-side', 'left'));
    await tick();
    const b = api.layOnChange(pick('place-lock', '', true));
    await tick();
    await releasePlace(); // 왼쪽 saves; the lock goes next
    expect(JSON.parse(stored['soma-view-layout']).panel).toMatchObject({ side: 'left', locked: false });
    await releasePlace(); // the lock is refused
    await Promise.all([a, b]);
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: false });
    expect(els['lay-place-left'].checked).toBe(true);
    expect(els['lay-place-lock'].checked).toBe(false);
    expect(els['lay-status'].textContent).toContain('저장하지 못했습니다');
    expect(JSON.parse(stored['soma-view-layout']).panel).toMatchObject({ side: 'left', locked: false });
  });

  it('a place save publishes the place only — never this tab’s layouts', async () => {
    const { api, stored } = editor({ doc: { v: 1 } });
    await api.loadLayout();
    stored['soma-view-layout'] = JSON.stringify({ v: 1, active: { card: '3' } }); // another tab saved presets
    await api.layOnChange(pick('place-side', 'left'));
    expect(JSON.parse(stored['soma-view-layout'])).toMatchObject({
      v: 1,
      active: { card: '3' },
      panel: { side: 'left', locked: false },
    });
  });

  it('a place refresh makes a layouts answer that left before it stale', async () => {
    const doc: Record<string, unknown> = { v: 1, panel: { side: 'right', locked: false } };
    const { api, els, flush, release } = editor({ doc }, { gate: true });
    await api.loadLayout();
    api.layDefault('card', '2');
    const saving = flush(); // handled now: the stored place is right
    await tick();
    doc.panel = { side: 'left', locked: false, rev: 9 }; // another tab moves the card
    await api.layRefreshPlace();
    expect(els['lay-place-left'].checked).toBe(true);
    await release(); // the layouts answer, with the place as it was when handled
    await saving;
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: false });
  });
});

describe('E13 — PR review round 4: each control sends only its own field (2026-11-19)', () => {
  it('잠금 sends the lock only — a side moved elsewhere (the dashboard on another device) stays', async () => {
    const doc: Record<string, unknown> = { v: 1, panel: { side: 'right', locked: false } };
    const { api, els, puts } = editor({ doc });
    await api.loadLayout(); // shows right
    doc.panel = { side: 'left', locked: false, rev: 9 }; // another device moves the card (this page has not refreshed)
    // The double's server is the snapshot's doc until a write: make it the moved one.
    await api.layOnChange(pick('place-lock', '', true));
    const last = puts[puts.length - 1] as any;
    expect(last.body).toEqual({ panel: { locked: true } });
    // The answer is the server's merged place: the side the other device chose, now locked.
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: true });
    expect(els['lay-place-left'].checked).toBe(true);
  });

  it('왼쪽 then 잠금 queued: the second PUT carries the lock only; the page shows both until the answers', async () => {
    const { api, els, puts, releasePlace } = editor({}, { gatePlace: true });
    await api.loadLayout();
    const a = api.layOnChange(pick('place-side', 'left'));
    await tick();
    const b = api.layOnChange(pick('place-lock', '', true));
    await tick();
    // Shown at once, before any answer (the held place is still the server's).
    expect(api.get('layPlaceShown()')).toMatchObject({ side: 'left', locked: true });
    await releasePlace();
    // After the first answer the queued lock still shows.
    expect(els['lay-place-lock'].checked).toBe(true);
    await releasePlace();
    await Promise.all([a, b]);
    expect(puts.filter((x: any) => x.url.endsWith('/panel')).map((x: any) => x.body.panel)).toEqual([
      { side: 'left' },
      { locked: true },
    ]);
    expect(api.get('_layDoc').panel).toMatchObject({ side: 'left', locked: true });
  });
});

describe('E14 — places are ordered by the server’s revision (PR review round 5)', () => {
  it('an older answer (a lock handled before another tab’s move, answering after it) changes nothing here', async () => {
    const { api, els, stored } = editor({ doc: { v: 1, panel: { side: 'left', locked: false, rev: 5 } } });
    await api.loadLayout();
    stored['soma-view-layout'] = JSON.stringify({ v: 1, panel: { side: 'left', locked: false, rev: 5 } });
    expect(api.get("layPlaceAccept({ side: 'right', locked: true, rev: 3 })")).toBe(false);
    expect(api.get('layPlaceShown()')).toMatchObject({ side: 'left', locked: false });
    expect(els['lay-place-left'].checked).toBe(true);
    expect(JSON.parse(stored['soma-view-layout']).panel).toEqual({ side: 'left', locked: false, rev: 5 });
    // A newer one is taken and published.
    expect(api.get("layPlaceAccept({ side: 'right', locked: true, rev: 6 })")).toBe(true);
    expect(JSON.parse(stored['soma-view-layout']).panel).toEqual({ side: 'right', locked: true, rev: 6 });
  });
});
