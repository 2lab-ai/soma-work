/**
 * Device-responsive dashboard (SSOT 2026-10-24): iPhone Duo (folded 382×580 /
 * unfolded 951×543), iPhone 18 Pro Max (440×956 / 956×440) and Galaxy Z Fold8
 * (cover ≈476×751 / main ≈933×704). Research: docs/misc/research/2026-10-24-dashboard-device-viewports.md.
 *
 * The layout was agreed by a unanimous trinity panel (round 5/5):
 *
 *   - the session drawer is a full-screen sheet below 840px and docks beside
 *     the board from 840px (no dim, the board stays live);
 *   - the board's column layout follows the inbox's own width (container
 *     query), not the viewport, so a docked drawer narrows it correctly;
 *   - the panel body is one scroll area (task view, SSOT 2026-10-27 — it
 *     replaced the pinned Tasks/Artifacts rows and their R/2 floor): the
 *     task's common surface (세션 정보, goal, 입력 필요, 산출물), then the
 *     agent tabs (sticky at its top) and the focused agent's tab;
 *   - a change of layout mode {columns, panel closed|sheet|docked, view}
 *     animates the cards from where they were on screen to where they are
 *     now; a further resize while they fly retargets from the visible spot.
 *
 * The board is @2lab.ai/ui <ui-agent-inbox>: its columns (the sideways snap of
 * a narrow board too), its Board ↔ List FLIP and its glides are the element's
 * (library src/components/agent-inbox/agent-inbox.test.ts, 'motion for host
 * layout changes'). The page keeps the coordinator: it caches each element's
 * measure() and hands it back to flipFrom() on a mode change.
 *
 * These are static contracts plus executions of the pure client helpers cut
 * out of renderDashboardPage() (the harness of the other *-client tests).
 * The real-browser sweep is scripts/screenshot-responsive.ts.
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
  const re = new RegExp(`^(?:async function|function) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n !== 1) throw new Error(`client function ${name} is declared ${n} times`);
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[] = []): T {
  return loadWith<T>(fns, vars, {});
}
/** load() with injected fakes; `seam` is a shipped-scope function compiled in the same body (state reads). */
function loadWith<T>(fns: string[], vars: string[], inject: Record<string, unknown>, seam = ''): T {
  const names = Object.keys(inject);
  const seamName = /^function (\w+)/.exec(seam)?.[1];
  const out = seamName ? [...fns, seamName] : fns;
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${seam}\nreturn { ${out.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
function cssBlock(opening: string): string {
  const i = TEMPLATE.indexOf(opening);
  if (i < 0) return '';
  const end = TEMPLATE.indexOf('\n}', i);
  return TEMPLATE.slice(i, end + 2);
}
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc} \\{[^}]*\\}`, 'm').exec(TEMPLATE)?.[0] ?? '';
}
function iife(name: string): string {
  const i = TEMPLATE.indexOf(`(function ${name}() {`);
  if (i < 0) return '';
  return TEMPLATE.slice(i, TEMPLATE.indexOf('\n})();', i));
}

const SHEET = '@media (max-width: 839px) {\n  /* Drawer';
const DOCKED = '@media (min-width: 840px) {\n  /* Drawer';
const PHONE = '@media (max-width: 639px) {\n  /* Responsive';

describe('viewport and safe areas', () => {
  it('the page extends under the notch and Dynamic Island (viewport-fit=cover), so env() insets are real', () => {
    expect(TEMPLATE).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">',
    );
  });

  it('the page content keeps clear of the left and right insets (landscape phones, the Duo cover)', () => {
    const app = rule('.app');
    expect(app).toContain('padding-left: env(safe-area-inset-left, 0px)');
    expect(app).toContain('padding-right: env(safe-area-inset-right, 0px)');
  });
});

describe('drawer — a sheet below 840px, docked beside the board from 840px', () => {
  it('is hidden by a transform, never by a right offset, and follows the visual viewport', () => {
    const panel = rule('.slide-panel');
    expect(panel).toContain('transform: translateX(100%)');
    expect(panel).toContain('right: 0');
    expect(panel).toContain('height: var(--pv-h, 100dvh)');
    expect(panel).toContain('top: var(--pv-t, 0px)');
    expect(TEMPLATE).not.toContain('right: -440px');
    expect(rule('.slide-panel.open')).toContain('transform: none');
  });

  it('below 840px it is a full-width sheet: no resize handle, chips stay under it, the FAB hides while it is open', () => {
    const sheet = cssBlock(SHEET);
    expect(sheet).not.toBe('');
    expect(sheet).toContain('.slide-panel { width: 100%; }');
    expect(sheet).toContain('.panel-resize-handle { display: none; }');
    expect(sheet).toContain('.topbar .topbar-defaults { z-index: auto; }');
    expect(sheet).toContain('.slide-panel.open ~ .new-task-fab { display: none !important; }');
    expect(sheet).toContain('padding-top: max(12px, env(safe-area-inset-top, 0px))');
  });

  it('from 840px it docks: width from the saved preference capped at half the screen, no dim, under the top bar', () => {
    const docked = cssBlock(DOCKED);
    expect(docked).not.toBe('');
    expect(docked).toContain(':root { --panel-w: min(var(--panel-w-pref, 440px), 50vw); }');
    expect(docked).toContain(
      '.slide-panel { width: var(--panel-w); top: calc(var(--pv-t, 0px) + var(--topbar-b, 0px));',
    );
    expect(docked).toContain('.slide-panel-overlay.open { display: none; }');
  });

  it('a docked drawer narrows the page instead of covering it, and the 1280px page stays centred in what is left', () => {
    const docked = cssBlock(DOCKED);
    expect(docked).toContain('.app:has(> .slide-panel.open) > .main {');
    expect(docked).toContain('max-width: min(1280px, calc(100% - var(--panel-w)));');
    expect(docked).toContain('margin-left: max(0px, calc((100% - var(--panel-w) - 1280px) / 2));');
  });

  it('the FAB keeps its own show/hide rule when docked and moves clear of the drawer; the composer still hides it everywhere', () => {
    expect(cssBlock(DOCKED)).toContain('.slide-panel.open ~ .new-task-fab { right: calc(var(--panel-w) + 16px); }');
    // The modal-era rule (hide the FAB whenever the panel is open) lives only in the sheet block now.
    expect(TEMPLATE).not.toMatch(/^\.slide-panel\.open ~ \.new-task-fab/m);
    expect(TEMPLATE).toContain('body.nt-open .new-task-fab { display: none !important; }');
  });

  it('the saved width is a preference only: JS never writes the drawer width or right offset', () => {
    const resize = iife('initPanelResize');
    expect(resize).not.toBe('');
    expect(resize).toContain("'--panel-w-pref'");
    expect(resize).not.toContain('panel.style.right');
    expect(resize).not.toContain('panel.style.width');
    expect(resize).not.toContain('MutationObserver');
  });

  it('only a layout shift animates the drawer width (WAAPI from the coordinator); window drags never lag behind', () => {
    // A CSS width transition would trail every desktop window drag; a class toggled
    // in a resize handler lands after the browser has already styled the new size.
    expect(rule('.slide-panel')).not.toContain('width var(');
    expect(TEMPLATE).not.toContain('.is-layout-shift .slide-panel');
    expect(clientFn('runLayoutCheck')).toContain("panel.animate([{ width: fromW + 'px' }, { width: toW + 'px' }]");
  });
});

describe("panel body — one scroll area: the task surface, the sticky agent tabs, the focused agent's tab", () => {
  const panel = TEMPLATE.slice(TEMPLATE.indexOf('<div class="slide-panel" id="slide-panel">'));
  const at = (s: string) => panel.indexOf(s);

  it('header (자세히) → body (scroll: surface → tabs → tabpanel) → composer', () => {
    expect(at('<div class="panel-header">')).toBeGreaterThan(0);
    expect(at('id="panel-detail-toggle"')).toBeGreaterThan(at('<div class="panel-header">'));
    expect(at('<div class="panel-body" id="panel-body">')).toBeGreaterThan(at('id="panel-detail-toggle"'));
    expect(at('<div class="panel-scroll" id="panel-scroll">')).toBeGreaterThan(at('id="panel-body"'));
    expect(at('<section class="panel-surface" id="panel-surface"')).toBeGreaterThan(at('id="panel-scroll"'));
    expect(at('id="panel-artifacts"')).toBeGreaterThan(at('id="panel-surface"'));
    expect(at('<div class="panel-tabs" id="panel-tabs" role="tablist"')).toBeGreaterThan(at('id="panel-artifacts"'));
    expect(at('<section class="panel-tabpanel" id="panel-tabpanel" role="tabpanel"')).toBeGreaterThan(
      at('id="panel-tabs"'),
    );
    expect(
      at('<div class="panel-tasks" id="panel-tasks" role="region" aria-label="Tasks" tabindex="-1"></div>'),
    ).toBeGreaterThan(at('id="panel-tabpanel"'));
    expect(at('id="panel-turns"')).toBeGreaterThan(at('id="panel-tasks"'));
    expect(at('<div class="panel-command" id="panel-command">')).toBeGreaterThan(at('id="panel-turns"'));
    // One scroll area in the body.
    expect(panel.slice(0, at('id="panel-command"')).split('class="panel-scroll"').length - 1).toBe(1);
  });

  it('the static session info (세션 정보, goal) scrolls with the conversation, above it; agents follow the question (spec 13)', () => {
    const scroll = at('<div class="panel-scroll" id="panel-scroll">');
    const question = at('id="panel-question"');
    for (const id of ['panel-info', 'panel-goal']) {
      expect(at(`id="${id}"`), id).toBeGreaterThan(scroll);
      expect(at(`id="${id}"`), id).toBeLessThan(question);
    }
    expect(at('id="panel-agents"')).toBeGreaterThan(question);
    // SSOT 2026-10-29: then the section tabs (에이전트 트리 · 작업 로그 · 지시와 답변).
    expect(at('id="panel-agents"')).toBeLessThan(at('id="panel-sections"'));
    expect(at('id="panel-sections"')).toBeLessThan(at('id="worklog-list"'));
    // Model · effort sit beside the composer, outside the scroll area.
    expect(at('id="panel-controls"')).toBeGreaterThan(at('<div class="panel-command" id="panel-command">'));
  });

  it('the body is a flex column whose one scroll area takes every row left (no grid, no pinned rows)', () => {
    const body = rule('.panel-body');
    expect(body).toContain('display: flex');
    expect(body).toContain('flex-direction: column');
    expect(body).toContain('container: pbody / size');
    expect(body).not.toContain('display: grid');
    expect(body).not.toContain('grid-template-rows');
    const scroll = rule('.panel-scroll');
    expect(scroll).toContain('flex: 1 1 auto');
    expect(scroll).toContain('overflow-y: auto');
    expect(scroll).toContain('min-height: 0');
    expect(scroll).not.toContain('grid-row');
    // The agent tabs stay at the top of the scroll area while the conversation scrolls.
    const tabs = rule('.panel-tabs');
    expect(tabs).toContain('position: sticky');
    expect(tabs).toContain('top: 0');
  });

  it('Tasks and Artifacts are no longer pinned: no grid row, no height cap, no inner scroll; nothing is clipped', () => {
    const tasks = rule('.panel-tasks');
    expect(tasks).not.toBe('');
    for (const pinned of ['grid-row', 'max-height', 'overflow']) expect(tasks, pinned).not.toContain(pinned);
    const arts = rule('.panel-artifacts');
    expect(arts).not.toBe('');
    for (const pinned of ['grid-row', 'max-height', 'overflow']) expect(arts, pinned).not.toContain(pinned);
    expect(TEMPLATE).not.toContain('minmax(min(50%, calc(100% - 88px)), 1fr)');
  });

  it('a short body shows artifacts as name chips (no thumbnail), the play button inline; every tile stays reachable sideways', () => {
    // 560px: below it, full thumbnails would push the conversation out of a short body.
    const compact = cssBlock('@container pbody (max-height: 560px) {');
    expect(compact).not.toBe('');
    expect(compact).toContain('.art-strip-panel .art-thumb { display: none; }');
    expect(compact).toContain('.art-strip-panel .art-play { position: static;');
    expect(rule('.art-strip')).toContain('overflow-x: auto');
  });
});

describe('board columns follow the inbox width, not the viewport', () => {
  it('the inbox is the size container', () => {
    expect(rule('.inbox')).toContain('container: inbox / inline-size');
  });

  it('a board narrower than 840px: the element snaps its own columns; the page only lets it shrink to the inbox', () => {
    // The sideways snap is the element's own container query (@2lab.ai/ui agent-inbox styles.ts,
    // '@container ib (max-width: 839px)'; no library test pins it yet). The page keeps no board
    // column rules: it gives the elements the inbox width, never their content's.
    expect(cssBlock('@container inbox (max-width: 839px) {')).not.toContain('.kanban');
    expect(rule('ui-agent-inbox.kanban, ui-agent-inbox.cron-inbox')).toContain('display: block; min-width: 0;');
    // The coordinator's mode flips at the same 840px of inbox width (layoutModeOf, below).
    expect(clientFn('layoutModeOf')).toContain("cols: inboxW >= 840 ? 'full' : 'snap'");
  });

  it('no viewport media query decides the board columns any more', () => {
    expect(cssBlock('@media (max-width: 1023px) {')).not.toContain('.kanban');
    expect(cssBlock('@media (max-width: 639px) {')).not.toContain('.kanban[data-view="board"] { grid-template-columns');
  });
});

describe('phones — nothing zooms, nothing hides behind the FAB, nothing runs off the edge', () => {
  it('text inputs in the drawer are 16px on touch screens (iOS does not zoom into them)', () => {
    // The composer is @2lab.ai/ui <ui-agent-steering> (dashboard batch 2): its field and its edit box are 16px on a
    // coarse pointer in the element's own styles (@2lab.ai/ui src/components/agent-steering/styles.ts,
    // `@media (pointer: coarse) { … .as-input, .as-edit { font-size: 16px; } }`). The page's own inputs stay here.
    expect(TEMPLATE).toContain('<ui-agent-steering id="cmd-steer" lang="ko">');
    expect(TEMPLATE).toMatch(
      /@media \(pointer: coarse\) \{\n {2}\/\* Responsive[^@]*\.mc-custom-input input \{ font-size: 16px; \}/,
    );
  });

  it('below 640px the page clears the FAB, the defaults menu spans the bar, the artifact viewer is full screen', () => {
    const phone = cssBlock(PHONE);
    expect(phone).not.toBe('');
    // Only a board with cards gets the clearance: an empty page must not turn scrollable. The cards
    // are inside the element, so renderBoard marks the inbox (.has-cards) instead of :has(.card) — drawn
    // cards only (a closed DONE day's are stubs).
    expect(phone).toContain('.inbox.has-cards { padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px)); }');
    expect(clientFn('renderBoard')).toContain(
      "if (inbox) inbox.classList.toggle('has-cards', Object.keys(_cardDrawn).length > 0);",
    );
    expect(phone).toContain('.td-menu { left: 12px; right: 12px; min-width: 0; max-width: none; }');
    expect(phone).toContain('.art-modal { width: 100vw; height: 100dvh; border: 0; border-radius: 0; }');
  });
});

describe('layout transition — pure helpers', () => {
  type Helpers = {
    defaultBoardView(w: number, saved: string | null): string;
    layoutModeOf(
      innerW: number,
      inboxW: number,
      panelOpen: boolean,
      view: string,
    ): { cols: string; panel: string; view: string };
    layoutModeKey(m: { cols: string; panel: string; view: string }): string;
    scrolledSpots(
      layout: { spots: Record<string, { x: number; y: number }> } | null,
      sx: number,
      sy: number,
    ): { spots: Record<string, { x: number; y: number }> };
  };
  // Loaded lazily so each test reports its own RED instead of failing collection.
  let cached: Helpers | null = null;
  const helpers = (): Helpers => {
    cached ??= load<Helpers>(['defaultBoardView', 'layoutModeOf', 'layoutModeKey', 'scrolledSpots']);
    return cached;
  };
  const h = new Proxy({} as Helpers, { get: (_t, k) => helpers()[k as keyof Helpers] });
  const key = (w: number, inbox: number, open: boolean, view = 'board') =>
    h.layoutModeKey(h.layoutModeOf(w, inbox, open, view));

  it('defaultBoardView: a saved choice wins; otherwise List below 640px, Board from 640px', () => {
    expect(h.defaultBoardView(382, null)).toBe('list');
    expect(h.defaultBoardView(639, null)).toBe('list');
    expect(h.defaultBoardView(640, null)).toBe('board');
    expect(h.defaultBoardView(951, null)).toBe('board');
    expect(h.defaultBoardView(382, 'board')).toBe('board');
    expect(h.defaultBoardView(951, 'list')).toBe('list');
    expect(h.defaultBoardView(951, 'bogus')).toBe('board');
  });

  it('layoutModeOf: columns by inbox width, panel closed|sheet|docked by viewport, the view as applied', () => {
    expect(h.layoutModeOf(951, 911, false, 'board')).toEqual({ cols: 'full', panel: 'closed', view: 'board' });
    expect(h.layoutModeOf(382, 358, true, 'list')).toEqual({ cols: 'snap', panel: 'sheet', view: 'list' });
    expect(h.layoutModeOf(951, 471, true, 'board')).toEqual({ cols: 'snap', panel: 'docked', view: 'board' });
  });

  it('every fold, unfold and rotation of the target devices changes the mode', () => {
    // iPhone Duo with the panel open: cover sheet → unfolded dock (the inbox stays < 840 both times).
    expect(key(382, 358, true)).not.toBe(key(951, 471, true));
    // Galaxy Z Fold8 cover → main, iPhone 18 Pro Max portrait → landscape, Duo inner landscape → portrait.
    expect(key(476, 452, false)).not.toBe(key(933, 893, false));
    expect(key(440, 416, false)).not.toBe(key(956, 916, false));
    expect(key(951, 911, false)).not.toBe(key(669, 645, false));
  });

  it('a transient size inside the same mode (the Duo reports 466×498 mid-fold) and a desktop maximise do not', () => {
    expect(key(466, 442, true)).toBe(key(382, 358, true));
    expect(key(1200, 1160, false)).toBe(key(1920, 1240, false));
  });

  it('scrolledSpots: the cached spots where the reader saw them, moved by the page scroll since', () => {
    const cache = { spots: { 'c:a': { x: 10, y: 300 }, 'h:waiting': { x: 0, y: 40 } } };
    // The page scrolled 120px down (and 5px right) since the cache: everything sat that much higher.
    expect(h.scrolledSpots(cache, 5, 120)).toEqual({
      spots: { 'c:a': { x: 5, y: 180 }, 'h:waiting': { x: -5, y: -80 } },
    });
    expect(h.scrolledSpots(cache, 0, 0)).toEqual(cache);
    expect(cache.spots['c:a']).toEqual({ x: 10, y: 300 }); // the cache itself is never moved
    expect(h.scrolledSpots(null, 3, 4)).toEqual({ spots: {} });
  });

  // Deleted: 'parseTranslate reads the translation of a computed transform' — library 'measure() before a host layout change, flipFrom() after it, glides every card from where it was'.
  // Deleted: 'flipVisualPos: the visible spot of a flying card is its last target plus the current translate' — library 'measure() before a host layout change, flipFrom() after it, glides every card from where it was'.
});

// ── The coordinator, executed: runLayoutCheck on fake elements (measure() / flipFrom()) ──
type Spots = { spots: Record<string, { x: number; y: number }> };
type FakeHost = { isConnected: boolean; flipFrom: ReturnType<typeof vi.fn> };
function coordinator(o: {
  fromKey?: string;
  mode?: { cols: string; panel: string; view: string };
  snap?: Array<[FakeHost, Spots]>;
  scrolled?: { x: number; y: number };
  reduce?: boolean;
  flying?: boolean;
  autoView?: string;
}) {
  const kb = { getAttribute: (k: string) => (k === 'view' ? 'board' : null), animate: vi.fn() };
  const calls = { setBoardView: [] as unknown[][], measure: 0, restore: [] as unknown[], timers: 0 };
  const m = loadWith<{
    runLayoutCheck(): void;
    state(): { key: string; until: number };
  }>(
    ['layoutModeKey', 'scrolledSpots', 'runLayoutCheck'],
    [],
    {
      document: { getElementById: (id: string) => (id === 'kanban' ? kb : null) },
      window: { innerWidth: 1280 },
      _layoutCheckFrame: null,
      defaultBoardView: () => o.autoView ?? 'board',
      savedBoardView: () => null,
      setBoardView: (...a: unknown[]) => calls.setBoardView.push(a),
      applySectionState: () => false,
      renderBoardForLayout: () => {},
      currentLayoutMode: () => o.mode ?? { cols: 'snap', panel: 'closed', view: 'board' },
      _layoutModeKey: o.fromKey ?? 'full|closed|board',
      _layoutShiftUntil: o.flying ? Date.now() + 10_000 : 0,
      measureLayout: () => {
        calls.measure++;
      },
      _panelAnchor: null,
      _panelScrollGen: 0,
      _layoutScroll: { x: 0, y: 0 },
      _lastScroll: o.scrolled ?? { x: 0, y: 0 },
      canAnimate: () => true,
      reduceMotion: () => !!o.reduce,
      _layoutSnap: o.snap ?? [],
      MOTION: { move: 320, fade: 160, easeOut: 'ease-out' },
      panelOpen: false,
      _layoutPanelW: 0,
      restorePanelAnchor: (a: unknown) => calls.restore.push(a),
      refreshLayoutCache: () => {},
      setTimeout: () => {
        calls.timers++;
      },
    },
    'function state() { return { key: _layoutModeKey, until: _layoutShiftUntil }; }',
  );
  return { m, kb, calls };
}
const host = (connected = true): FakeHost => ({ isConnected: connected, flipFrom: vi.fn() });

describe('layout transition — one coordinator', () => {
  it('runLayoutCheck re-evaluates the default view without saving it, then animates from the visible spot', () => {
    expect(clientFn('runLayoutCheck')).toContain('defaultBoardView(window.innerWidth, savedBoardView())');
    // A fold below 640px: the default view follows, with no event — setBoardView neither saves it nor adopts it.
    const auto = coordinator({ autoView: 'list' });
    auto.m.runLayoutCheck();
    expect(auto.calls.setBoardView).toEqual([['list']]);
    // A mode change: each cached element glides from where the reader saw it — its measure(),
    // moved by the page scroll since (the element retargets a card still in flight itself).
    const board = host();
    const lane = host();
    const gone = host(false);
    const at = (x: number, y: number) => ({ x, y });
    const c = coordinator({
      snap: [
        [board, { spots: { 'c:a': at(10, 300), 'h:waiting': at(10, 40) } }],
        [lane, { spots: { 'c:cron': at(20, 900) } }],
        [gone, { spots: { 'c:old': at(0, 0) } }],
      ],
      scrolled: at(0, 100),
    });
    c.m.runLayoutCheck();
    expect(board.flipFrom).toHaveBeenCalledWith({ spots: { 'c:a': at(10, 200), 'h:waiting': at(10, -60) } });
    expect(lane.flipFrom).toHaveBeenCalledWith({ spots: { 'c:cron': at(20, 800) } });
    expect(gone.flipFrom).not.toHaveBeenCalled();
    expect(c.kb.animate).not.toHaveBeenCalled();
    expect(c.calls.restore).toEqual([null]);
    expect(c.m.state().key).toBe('snap|closed|board');
    expect(c.m.state().until).toBeGreaterThan(Date.now());
    expect(c.calls.timers).toBe(1);
    // Reduced motion: no glide, the board fades in place.
    const still = host();
    const r = coordinator({ snap: [[still, { spots: {} }]], reduce: true });
    r.m.runLayoutCheck();
    expect(still.flipFrom).not.toHaveBeenCalled();
    expect(r.kb.animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'linear' });
  });

  it('an unchanged mode measures a settled board again and leaves a glide in flight alone', () => {
    const settled = host();
    const a = coordinator({ fromKey: 'snap|closed|board', snap: [[settled, { spots: {} }]] });
    a.m.runLayoutCheck();
    expect(a.calls.measure).toBe(1);
    expect(settled.flipFrom).not.toHaveBeenCalled();
    const b = coordinator({ fromKey: 'snap|closed|board', flying: true });
    b.m.runLayoutCheck();
    expect(b.calls.measure).toBe(0);
  });

  it('it starts on a mode change and retargets while cards are still flying', () => {
    const body = clientFn('runLayoutCheck');
    expect(body).toContain('layoutModeKey(mode) !== _layoutModeKey');
    expect(body).toContain('_layoutShiftUntil');
  });

  it('signals: window resize, the inbox ResizeObserver, and panel open/close', () => {
    const init = iife('initLayoutTransitions');
    expect(init).not.toBe('');
    expect(init).toContain("window.addEventListener('resize', requestLayoutCheck");
    expect(init).toContain('new ResizeObserver(');
    expect(init).toContain("document.getElementById('inbox')");
    const open = clientFn('openPanel');
    expect(open.indexOf('layoutBeforeChange()')).toBeGreaterThan(-1);
    expect(open.indexOf('layoutBeforeChange()')).toBeLessThan(open.indexOf(".classList.add('open')"));
    const close = clientFn('closePanel');
    expect(close.indexOf('layoutBeforeChange()')).toBeGreaterThan(-1);
    expect(close.indexOf('layoutBeforeChange()')).toBeLessThan(close.indexOf(".classList.remove('open')"));
  });

  it('the default view at load comes from the same helper (List below 640px)', () => {
    expect(TEMPLATE).toContain('setBoardView(defaultBoardView(window.innerWidth, savedBoardView()));');
    expect(clientFn('defaultBoardView')).toContain('innerWidth < 640');
  });
});

describe('layout transition — review fixes (trinity code review R1)', () => {
  it('a user Board/List switch glides in the element and the coordinator adopts it, so nothing animates twice', () => {
    const attrs: Record<string, string> = { view: 'board' };
    const kb = {
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
    };
    const seg = (view: string) => {
      const a: Record<string, string> = { 'data-view': view, 'aria-pressed': String(view === 'board') };
      return {
        a,
        getAttribute: (k: string) => a[k] ?? null,
        setAttribute: (k: string, v: string) => {
          a[k] = v;
        },
      };
    };
    const segs = [seg('board'), seg('list')];
    const saved: string[] = [];
    let adopted = 0;
    const { setBoardView } = loadWith<{ setBoardView(view: string, ev?: unknown): void }>(['setBoardView'], [], {
      document: { querySelectorAll: () => segs, getElementById: (id: string) => (id === 'kanban' ? kb : null) },
      localStorage: { setItem: (_k: string, v: string) => saved.push(v) },
      adoptLayout: () => {
        adopted++;
      },
    });
    // The reader's switch (an event): saved, the element's view attribute (it FLIPs), adopted.
    setBoardView('list', {});
    expect(attrs.view).toBe('list');
    expect(saved).toEqual(['list']);
    expect(segs.map((b) => b.a['aria-pressed'])).toEqual(['false', 'true']);
    expect(adopted).toBe(1);
    // The default following the screen (no event): not saved, not adopted — the coordinator runs the only glide.
    setBoardView('board');
    expect(attrs.view).toBe('board');
    expect(saved).toEqual(['list']);
    expect(adopted).toBe(1);
    // The view it already has, or no view at all: nothing moves.
    setBoardView('board', {});
    setBoardView('grid', {});
    expect(adopted).toBe(1);
    const adopt = clientFn('adoptLayout');
    expect(adopt).toContain('_layoutModeKey = layoutModeKey(currentLayoutMode())');
    expect(adopt).toContain('_layoutShiftUntil = Date.now() + MOTION.move');
  });

  // Deleted: 'an element whose layout did not move keeps its flight: no cancel, no second FLIP' — library 'measure() before a host layout change, flipFrom() after it, glides every card from where it was'.

  it('the shift cache is each element’s own measure(), taken once the board has settled (trinity review R2)', () => {
    // Cards gliding after a render, a view switch or a shift are not at their places: the
    // cache is refreshed after the glide (renderBoard, adoptLayout) and never mid-shift.
    expect(clientFn('renderBoard')).toContain('scheduleLayoutRefresh(MOTION.move + 40);');
    expect(clientFn('refreshLayoutCache')).toContain('if (Date.now() < _layoutShiftUntil) return;');
    const kbSnap = { spots: { 'c:a': { x: 1, y: 2 } } };
    const laneSnap = { spots: { 'c:cron': { x: 3, y: 4 } } };
    const kb = { measure: () => kbSnap };
    const lane = { isConnected: true, getClientRects: () => [{}], measure: () => laneSnap };
    const upgrading = { isConnected: true, getClientRects: () => [{}] }; // not defined yet: no measure()
    const m = loadWith<{
      measureLayout(): void;
      state(): { snap: unknown[]; scroll: unknown; last: unknown; key: string; anchor: unknown };
    }>(
      ['boardHosts', 'layoutModeKey', 'measureLayout'],
      [],
      {
        document: {
          getElementById: (id: string) => (id === 'kanban' ? kb : null),
          querySelectorAll: () => [lane, upgrading],
        },
        currentLayoutMode: () => ({ cols: 'full', panel: 'closed', view: 'list' }),
        layoutScrollNow: () => ({ x: 0, y: 75 }),
        capturePanelAnchor: () => 'anchor',
        panelOpen: false,
        _layoutSnap: [],
        _layoutScroll: null,
        _lastScroll: null,
        _layoutModeKey: '',
        _panelAnchor: null,
        _layoutPanelW: 0,
      },
      'function state() { return { snap: _layoutSnap, scroll: _layoutScroll, last: _lastScroll, key: _layoutModeKey, anchor: _panelAnchor }; }',
    );
    m.measureLayout();
    expect(m.state()).toEqual({
      snap: [
        [kb, kbSnap],
        [lane, laneSnap],
      ],
      scroll: { x: 0, y: 75 },
      last: { x: 0, y: 75 },
      key: 'full|closed|list',
      anchor: 'anchor',
    });
  });

  it('the drawer width animates only on a sheet ↔ dock change (or its retarget), never under a handle drag (trinity R2, fable)', () => {
    const body = clientFn('runLayoutCheck');
    expect(body).toContain('prevPanel !== mode.panel');
    expect(body).toContain("panel.classList.contains('resizing')");
  });

  it('runs at most once per frame (window resize, ResizeObserver and timers share one frame stamp)', () => {
    const body = clientFn('runLayoutCheck');
    expect(body).toContain('document.timeline');
    expect(body).toContain('_layoutCheckFrame');
  });

  it('the end of a shift restores the panel anchor only if the reader has not touched the panel since', () => {
    expect(clientFn('runLayoutCheck')).toContain('gen === _panelScrollGen');
    expect(iife('initLayoutTransitions')).toContain('_panelScrollGen++');
  });
});

describe('drawer follows the visual viewport (keyboard) and sits under the top bar when docked', () => {
  it('syncPanelViewport writes --pv-h / --pv-t from visualViewport, on resize and scroll', () => {
    const body = clientFn('syncPanelViewport');
    expect(body).toContain("'--pv-h'");
    expect(body).toContain("'--pv-t'");
    expect(TEMPLATE).toContain("window.visualViewport.addEventListener('resize', syncPanelViewport)");
    expect(TEMPLATE).toContain("window.visualViewport.addEventListener('scroll', syncPanelViewport)");
  });

  it('syncTopbarBottom writes --topbar-b (0 once the bar has scrolled away)', () => {
    const body = clientFn('syncTopbarBottom');
    expect(body).toContain("'--topbar-b'");
    expect(body).toContain('Math.max(0,');
  });
});

describe('views merged from #374 follow the same device contract', () => {
  const RESP_TAIL = TEMPLATE.slice(TEMPLATE.indexOf('/* ═══ Device-responsive layout (SSOT 2026-10-24)'));

  it('the cron run drawer fills the visible viewport (not 100vh behind the Safari toolbar) and keeps clear of the insets', () => {
    // viewport-fit=cover makes env() insets real: a drawer pinned to the right edge
    // must pad for the landscape iPhone notch side and the home indicator.
    const drawer = /^\.cron-drawer \{[^}]*\}/m.exec(RESP_TAIL)?.[0] ?? '';
    expect(drawer).toContain('height: 100dvh');
    expect(drawer).toContain('padding-right: env(safe-area-inset-right, 0px)');
    // 100vw counts a classic scrollbar: a narrow window would push the drawer's left
    // edge off screen (the device sweep caught -8px in WebKit). A fixed box's 100% is
    // the viewport without the scrollbar.
    expect(drawer).toContain('width: min(560px, 100%)');
    expect(RESP_TAIL).toMatch(/^\.cron-drawer-head \{[^}]*padding-top: max\(16px, env\(safe-area-inset-top, 0px\)\)/m);
    expect(RESP_TAIL).toMatch(
      /^\.cron-drawer-body \{[^}]*padding-bottom: calc\(24px \+ env\(safe-area-inset-bottom, 0px\)\)/m,
    );
  });
});

describe('settings page — reached from the dashboard top bar', () => {
  it('every text field on every tab (the #379 memory tab too) is 16px on touch screens', () => {
    const settingsTs = readFileSync(join(__dirname, '..', 'settings-page.ts'), 'utf-8');
    expect(settingsTs).toContain(
      '  input[type="text"], input[type="search"], input[type="number"], select, textarea { font-size: 16px !important; }',
    );
  });

  const SETTINGS_TS = readFileSync(join(__dirname, '..', 'settings-page.ts'), 'utf-8');

  it('its text inputs and selects are 16px on touch screens (iOS does not zoom into them)', () => {
    const coarse = SETTINGS_TS.slice(SETTINGS_TS.indexOf('@media (pointer: coarse) {'));
    expect(SETTINGS_TS).toContain('@media (pointer: coarse) {');
    expect(coarse.slice(0, coarse.indexOf('\n}'))).toMatch(
      /\.row input\[type="text"\], \.row input\[type="number"\], \.row select \{ font-size: 16px; \}/,
    );
  });
});

describe('merged views — trinity code review R4 follow-ups', () => {
  it('scroll compensation is per element: the board and each CRON job’s element are measured on their own', () => {
    // The kanban-only shift (boardScrollShift) is gone: every element's measure() is its own, so
    // the CRON lane's cards (outside the board) and the board's get the same page-scroll correction.
    const board = host();
    const lane = host();
    const c = coordinator({
      snap: [
        [board, { spots: { 'c:a': { x: 300, y: 500 } } }],
        [lane, { spots: { 'c:cron': { x: 40, y: 200 } } }],
      ],
      scrolled: { x: 0, y: 50 },
    });
    c.m.runLayoutCheck();
    expect(board.flipFrom).toHaveBeenCalledWith({ spots: { 'c:a': { x: 300, y: 450 } } });
    expect(lane.flipFrom).toHaveBeenCalledWith({ spots: { 'c:cron': { x: 40, y: 150 } } });
    expect(clientFn('runLayoutCheck')).not.toContain('boardScrollShift');
  });

  it('Escape with a docked panel and the cron drawer open closes the drawer only (the topmost)', () => {
    expect(TEMPLATE).toContain(
      "if (e.key === 'Escape' && panelOpen && !artModalIsOpen() && !_cronDrawerKey) closePanel();",
    );
  });

  it('the capacity timeline repacks on its own width: a docked panel narrows the page without a window resize', () => {
    // <ui-agent-queue> observes its own width (ResizeObserver) and re-lays its timeline out;
    // the page only learns the section's new height for the shift cache.
    const body = iife('initCapacityResize');
    expect(body).toContain("getElementById('capacity')");
    expect(body).toContain('new ResizeObserver(');
    expect(body).toContain('contentRect.height');
    expect(body).toContain('scheduleLayoutRefresh(40)');
    expect(body).not.toContain('paintCapacity');
    expect(TEMPLATE).not.toContain('_capResizeTimer');
  });

  it('the cron drawer close button is a 44px touch target on touch screens (the lane’s buttons are the element’s)', () => {
    const resp = TEMPLATE.slice(TEMPLATE.indexOf('/* ═══ Device-responsive layout (SSOT 2026-10-24)'));
    const coarse = resp.slice(resp.indexOf('@media (pointer: coarse) {'));
    const block = coarse.slice(0, coarse.indexOf('\n}'));
    expect(block).toContain('.cron-drawer-close { min-width: 44px; min-height: 44px; }');
    // 지난 실행, the strip, the queue chips, the marks and the fold toggle: @2lab.ai/ui agent-queue
    // styles.ts, '@media (pointer: coarse)' — 44px.
    expect(block).not.toContain('.cron-history-btn');
  });

  it('the settings search field is 16px on touch screens too', () => {
    const settings = readFileSync(join(__dirname, '..', 'settings-page.ts'), 'utf-8');
    const coarse = settings.slice(settings.indexOf('@media (pointer: coarse) {'));
    expect(coarse.slice(0, coarse.indexOf('\n}'))).toContain('.side input[type="search"]');
  });
});

describe('secondary sections (#374 LLM capacity, CRON lane) — a disclosure on small screens', () => {
  // Measured with both sections populated: the first board card sat at 989–1247px on
  // every phone and foldable posture and at 864px on a 1440×900 PC (trinity design
  // consult: a disclosure, collapsed unless the window is at least 840×1000).
  it('the default is open only on a large window (840 wide and 1000 tall); a saved choice wins', () => {
    const { secOpen } = load<{ secOpen: (saved: string | null, large: boolean) => boolean }>(['secOpen']);
    expect(secOpen(null, false)).toBe(false);
    expect(secOpen(null, true)).toBe(true);
    expect(secOpen('open', false)).toBe(true);
    expect(secOpen('closed', true)).toBe(false);
    expect(TEMPLATE).toContain("var SEC_OPEN_QUERY = '(min-width: 840px) and (min-height: 1000px)';");
    // capacity v2 is taller: it opens on its own only on a 1400px+ tall window (board first)
    // capacity v2 starts folded on every window (its chips carry both measures); the
    // reader's unfold choice persists
    expect(clientFn('secIsOpen')).toContain(
      "secOpen(saved, sec === 'capacity' ? false : !!(_secMql && _secMql.matches))",
    );
    expect(TEMPLATE).not.toContain('SEC_OPEN_QUERY_CAPACITY');
  });

  it('each section’s toggle is its element’s own, in its head row; the page decides and hands the fold back', () => {
    // <ui-agent-queue collapsible>: 펼치기 / 접기 at the end of the head row, aria-expanded, and its
    // focus survives the element's re-render by its data-key (library: 'collapsible: the toggle in each
    // head says what a press does and sends a cancelable ui-collapse').
    expect(TEMPLATE).not.toContain('data-sec-toggle');
    expect(clientFn('capData')).toContain("collapsible: true, collapsed: { capacity: !secIsOpen('capacity') }");
    expect(clientFn('laneData')).toContain('collapsible: true, collapsed: { lane: cronLaneFolded() }');
    const on = TEMPLATE.slice(TEMPLATE.indexOf("document.addEventListener('ui-collapse', function(e) {"));
    const body = on.slice(0, on.indexOf('\n});'));
    expect(body).toContain('e.preventDefault();');
    expect(body).toContain('toggleSection(sec)');
  });

  // The folded capacity chips (both measures as count/total %, ⏸ limited · first return, ⚠ stale /
  // partial / assumed tier, the next line as the tooltip and accessible name) and their phone wrap are
  // <ui-agent-queue>'s: library 'collapsed capacity: the head and one chip per provider — measures,
  // ⏸ limited · first return, ⚠ flags' and styles.ts '@container aqcap (max-width: 839.98px)'. The
  // mapped data the chips read is pinned in dashboard-affectui-agent-queue-client.test.ts (capData).

  it('a folded CRON lane drops the cards of every job that does not wait for a reply (out of the DOM, not display:none)', () => {
    const slots = clientFn('cronLaneSlots');
    expect(slots).toContain('cronLaneFolded()');
    expect(slots).toContain('!g.waiting');
    // the element draws only the waiting jobs (and their slots) while folded — library 'collapsed lane'
    expect(clientFn('laneData')).toContain('collapsed: { lane: cronLaneFolded() }');
  });

  it('the disclosure state is part of the layout mode, so a toggle or a window change moves the board by FLIP', () => {
    const { layoutModeKey } = load<{ layoutModeKey: (m: Record<string, string>) => string }>(['layoutModeKey']);
    expect(layoutModeKey({ cols: 'full', panel: 'closed', view: 'board' })).toBe('full|closed|board');
    expect(layoutModeKey({ cols: 'full', panel: 'closed', view: 'board', sec: 'cR' })).toBe('full|closed|board|cR');
    expect(clientFn('currentLayoutMode')).toContain('secStateKey()');
    expect(clientFn('runLayoutCheck')).toContain('applySectionState()');
    const toggle = clientFn('toggleSection');
    expect(toggle.indexOf('layoutBeforeChange()')).toBeGreaterThan(-1);
    expect(toggle.indexOf('layoutBeforeChange()')).toBeLessThan(toggle.indexOf('localStorage.setItem'));
  });

  it('elements that are not rendered never enter the shift cache (no FLIP from the top-left corner)', () => {
    const kb = { id: 'kanban' };
    const shown = { isConnected: true, getClientRects: () => [{}] };
    const folded = { isConnected: true, getClientRects: () => [] }; // a folded CRON lane: display none
    const detached = { isConnected: false, getClientRects: () => [{}] };
    const { boardHosts } = loadWith<{ boardHosts(): unknown[] }>(['boardHosts'], [], {
      document: {
        getElementById: (id: string) => (id === 'kanban' ? kb : null),
        querySelectorAll: (sel: string) => (sel === 'ui-agent-inbox.cron-inbox' ? [shown, folded, detached] : []),
      },
    });
    expect(boardHosts()).toEqual([kb, shown]);
  });

  it('a capacity paint that changes the page height refreshes the shift cache (it sits above the board, outside #inbox)', () => {
    expect(iife('initCapacityResize')).toContain('scheduleLayoutRefresh(');
  });

  it('a deep link into a folded CRON lane opens it for this page load only', () => {
    expect(clientFn('openDeepLinkedSession')).toContain('_cronLaneRevealed = true;');
    expect(clientFn('secIsOpen')).toContain('_cronLaneRevealed');
  });
});

describe('secondary sections — trinity code review R1 follow-ups (astra)', () => {
  it('a disclosure render leaves every board move to the coordinator (no FLIP from a half-revealed lane)', () => {
    // The layout is measured before the fold changes it (layoutBeforeChange); the render after it only
    // re-plans the board — the element glides only what its own data moved (library 'measure() before a
    // host layout change, flipFrom() after it, glides every card from where it was').
    const toggle = clientFn('toggleSection');
    expect(toggle.indexOf('layoutBeforeChange()')).toBeLessThan(toggle.indexOf('renderBoardForLayout()'));
    expect(toggle).not.toContain('renderBoard(_lastBoardData)');
    expect(clientFn('runLayoutCheck')).toContain('if (applySectionState()) renderBoardForLayout();');
    let rendered: unknown = null;
    const { renderBoardForLayout } = loadWith<{ renderBoardForLayout(): void }>(['renderBoardForLayout'], [], {
      _lastBoardData: { waiting: [] },
      renderBoard: (b: unknown, ...rest: unknown[]) => {
        rendered = [b, ...rest];
      },
    });
    renderBoardForLayout();
    expect(rendered).toEqual([{ waiting: [] }]);
  });

  it('a toggle works for this page even when storage refuses the write', () => {
    expect(TEMPLATE).toContain('var _secChoice = {};');
    expect(clientFn('toggleSection')).toMatch(
      /_secChoice\[sec\] = open \? 'open' : 'closed';[\s\S]*localStorage\.setItem/,
    );
    expect(clientFn('secIsOpen')).toContain('_secChoice[sec]');
  });
});
