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
 *   - Tasks and Artifacts stay pinned outside the scroll area (.prd/10
 *     §3.1-6), the static session info scrolls with the conversation, and
 *     the scroll area always keeps at least half of the panel body (R/2);
 *   - a change of layout mode {columns, panel closed|sheet|docked, view}
 *     animates the cards from where they were on screen to where they are
 *     now; a further resize while they fly retargets from the visible spot.
 *
 * These are static contracts plus executions of the pure client helpers cut
 * out of renderDashboardPage() (the harness of the other *-client tests).
 * The real-browser sweep is scripts/screenshot-responsive.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
function load<T>(fns: string[]): T {
  return new Function(`${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`)() as T;
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

  it('only a layout shift lets the drawer animate its width; ordinary window drags do not lag behind', () => {
    expect(rule('.is-layout-shift .slide-panel')).toContain('width var(--dur-move) var(--ease-out)');
    expect(rule('.slide-panel')).not.toContain('width var(');
  });
});

describe('panel body — pinned Tasks and Artifacts, one main scroll, at least half the body (R/2)', () => {
  const panel = TEMPLATE.slice(TEMPLATE.indexOf('<div class="slide-panel" id="slide-panel">'));
  const at = (s: string) => panel.indexOf(s);

  it('header → body (tasks, artifacts, scroll) → composer', () => {
    expect(at('<div class="panel-header">')).toBeGreaterThan(0);
    expect(at('<div class="panel-body" id="panel-body">')).toBeGreaterThan(at('<div class="panel-header">'));
    expect(at('<div class="panel-tasks" id="panel-tasks"></div>')).toBeGreaterThan(at('id="panel-body"'));
    expect(at('id="panel-artifacts"')).toBeGreaterThan(at('id="panel-tasks"'));
    expect(at('<div class="panel-scroll" id="panel-scroll">')).toBeGreaterThan(at('id="panel-artifacts"'));
    expect(at('<div class="panel-command" id="panel-command">')).toBeGreaterThan(at('id="panel-scroll"'));
  });

  it('the static session info (controls, meta, links, tokens, agents) scrolls with the conversation, above it', () => {
    const scroll = at('<div class="panel-scroll" id="panel-scroll">');
    const question = at('id="panel-question"');
    for (const id of ['panel-controls', 'panel-meta', 'panel-links', 'panel-tokens', 'panel-agents']) {
      expect(at(`id="${id}"`), id).toBeGreaterThan(scroll);
      expect(at(`id="${id}"`), id).toBeLessThan(question);
    }
  });

  it('the body is a grid whose last row (the scroll area) never gets less than half of it', () => {
    const body = rule('.panel-body');
    expect(body).toContain('display: grid');
    expect(body).toContain('grid-template-rows: auto auto minmax(50%, 1fr)');
    expect(body).toContain('container: pbody / size');
    expect(rule('.panel-scroll')).toContain('grid-row: 3');
  });

  it('pinned blocks yield height down to one row and scroll inside; nothing is clipped', () => {
    const tasks = rule('.panel-tasks');
    expect(tasks).toContain('grid-row: 1');
    expect(tasks).toContain('min-height: 44px');
    expect(tasks).toContain('max-height: min(30vh, 240px)');
    expect(tasks).toContain('overflow-y: auto');
    const arts = rule('.panel-artifacts');
    expect(arts).toContain('grid-row: 2');
    expect(arts).toContain('overflow-y: auto');
    expect(arts).not.toContain('overflow: hidden');
  });

  it('a short body shows artifacts as name chips (no thumbnail), the play button inline; every tile stays reachable sideways', () => {
    const compact = cssBlock('@container pbody (max-height: 640px) {');
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

  it('a board narrower than 840px scrolls its three columns sideways with snap', () => {
    const narrow = cssBlock('@container inbox (max-width: 839px) {');
    expect(narrow).toContain('.kanban[data-view="board"]');
    expect(narrow).toContain('grid-template-columns: repeat(3, minmax(min(300px, 84cqi), 1fr));');
    expect(narrow).toContain('scroll-snap-type: x mandatory');
    expect(narrow).toContain('overflow-x: auto');
  });

  it('no viewport media query decides the board columns any more', () => {
    expect(cssBlock('@media (max-width: 1023px) {')).not.toContain('.kanban');
    expect(cssBlock('@media (max-width: 639px) {')).not.toContain('.kanban[data-view="board"] { grid-template-columns');
  });
});

describe('phones — nothing zooms, nothing hides behind the FAB, nothing runs off the edge', () => {
  it('text inputs in the drawer are 16px on touch screens (iOS does not zoom into them)', () => {
    expect(TEMPLATE).toMatch(
      /@media \(pointer: coarse\) \{\n {2}\/\* Responsive[^@]*\.panel-command input, \.mc-custom-input input \{ font-size: 16px; \}/,
    );
  });

  it('below 640px the page clears the FAB, the defaults menu spans the bar, the artifact viewer is full screen', () => {
    const phone = cssBlock(PHONE);
    expect(phone).not.toBe('');
    expect(phone).toContain('.main { padding-bottom: calc(88px + env(safe-area-inset-bottom, 0px)); }');
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
    parseTranslate(t: string): { x: number; y: number };
    flipVisualPos(target: { left: number; top: number }, t: { x: number; y: number }): { left: number; top: number };
  };
  // Loaded lazily so each test reports its own RED instead of failing collection.
  let cached: Helpers | null = null;
  const helpers = (): Helpers => {
    cached ??= load<Helpers>(['defaultBoardView', 'layoutModeOf', 'layoutModeKey', 'parseTranslate', 'flipVisualPos']);
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

  it('parseTranslate reads the translation of a computed transform', () => {
    expect(h.parseTranslate('none')).toEqual({ x: 0, y: 0 });
    expect(h.parseTranslate('matrix(1, 0, 0, 1, 12.5, -4)')).toEqual({ x: 12.5, y: -4 });
    expect(h.parseTranslate('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 0, 1)')).toEqual({ x: 7, y: 8 });
  });

  it('flipVisualPos: the visible spot of a flying card is its last target plus the current translate', () => {
    // Target B = 100; flying from A = 70 means translate(A − B) = −30 at the start.
    expect(h.flipVisualPos({ left: 100, top: 50 }, { x: -30, y: 10 })).toEqual({ left: 70, top: 60 });
    expect(h.flipVisualPos({ left: 100, top: 50 }, { x: 0, y: 0 })).toEqual({ left: 100, top: 50 });
  });
});

describe('layout transition — one coordinator', () => {
  it('runLayoutCheck re-evaluates the default view without saving it, then animates from the visible spot', () => {
    const body = clientFn('runLayoutCheck');
    expect(body).toContain('defaultBoardView(window.innerWidth, savedBoardView())');
    // No event argument: setBoardView neither saves nor plays its own FLIP.
    expect(body).toMatch(/setBoardView\(autoView\)/);
    expect(body).toContain('parseTranslate(getComputedStyle(el).transform)');
    expect(body).toContain('el._flip.cancel()');
    expect(body).toContain('playFlip(el, dx, dy, false)');
    expect(body).toContain('reduceMotion()');
    expect(body).toContain('restorePanelAnchor(');
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
