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
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[] = []): T {
  return new Function(
    `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`,
  )() as T;
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
    // Half the body — unless the two pinned 44px floors leave less, so no row ever
    // overflows the body (which clips) on the shortest docked screens.
    expect(body).toContain('grid-template-rows: auto auto minmax(min(50%, calc(100% - 88px)), 1fr)');
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
    // 560px: below it, R/2 cannot hold full thumbnails plus a couple of task rows.
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
    // Only a board with cards gets the clearance: an empty page must not turn scrollable.
    expect(phone).toContain('.inbox:has(.card) { padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px)); }');
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

describe('layout transition — review fixes (trinity code review R1)', () => {
  it('a user Board/List switch hands its own FLIP targets to the coordinator, so nothing animates twice', () => {
    const body = clientFn('setBoardView');
    // The FLIP path adopts the targets it measured; the no-animation user path adopts the settled layout.
    expect(body).toContain('adoptLayoutTargets(targets)');
    expect(body).toContain('adoptLayoutTargets(null)');
    expect(clientFn('adoptLayoutTargets')).toContain('_layoutModeKey = layoutModeKey(currentLayoutMode())');
  });

  it('an element whose layout did not move keeps its flight: no cancel, no second FLIP', () => {
    const { sameSpot } = load<{
      sameSpot(a: { left: number; top: number }, b: { left: number; top: number }): boolean;
    }>(['sameSpot']);
    expect(sameSpot({ left: 10, top: 20 }, { left: 10.4, top: 19.7 })).toBe(true);
    expect(sameSpot({ left: 10, top: 20 }, { left: 11, top: 20 })).toBe(false);
    const body = clientFn('runLayoutCheck');
    expect(body).toContain('sameSpot(target, layout)');
  });

  it('every FLIP (board render, view switch, shift) records its landing spot in the shift cache (trinity review R2)', () => {
    // A card that moves column on a live render flies to a new spot; a shift during
    // that flight must not add the render's translate to the old spot.
    expect(clientFn('playFlip')).toContain('noteFlipTarget(el)');
    expect(clientFn('noteFlipTarget')).toContain('_layoutRects.set(el,');
    // The cache stores layout spots, never a mid-flight drawn box.
    expect(clientFn('measureLayout')).toContain('layoutSpotOf(');
    expect(clientFn('layoutSpotOf')).toContain('parseTranslate(getComputedStyle(el).transform)');
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
  it('the board scroll compensation applies only to movers inside the kanban (CRON lane cards sit outside it)', () => {
    // One rule for both paths that use the board's scrollLeft: reading the cache
    // (runLayoutCheck) and writing a FLIP's landing spot into it (noteFlipTarget, R5).
    const make = new Function('document', `${clientFn('boardScrollShift')}\nreturn boardScrollShift;`);
    const inside = {};
    const shift = make({ getElementById: () => ({ contains: (el: unknown) => el === inside }) }) as (
      el: unknown,
      dk: number,
    ) => number;
    expect(shift(inside, 295)).toBe(295);
    expect(shift({}, 295)).toBe(0);
    expect(clientFn('runLayoutCheck')).toContain('cached.left - sx - boardScrollShift(el, sk)');
    expect(clientFn('noteFlipTarget')).toContain('boardScrollShift(el, now.k - _layoutScroll.k)');
    expect(clientFn('noteFlipTarget')).not.toContain('+ (now.k - _layoutScroll.k)');
  });

  it('Escape with a docked panel and the cron drawer open closes the drawer only (the topmost)', () => {
    expect(TEMPLATE).toContain(
      "if (e.key === 'Escape' && panelOpen && !artModalIsOpen() && !_cronDrawerKey) closePanel();",
    );
  });

  it('the capacity timeline repacks on its own width: a docked panel narrows the page without a window resize', () => {
    const body = iife('initCapacityResize');
    expect(body).toContain("getElementById('capacity')");
    expect(body).toContain('new ResizeObserver(');
    expect(body).toContain('setTimeout(paintCapacity, 150)');
  });

  it('the cron drawer close button and history buttons are 44px touch targets on touch screens', () => {
    const resp = TEMPLATE.slice(TEMPLATE.indexOf('/* ═══ Device-responsive layout (SSOT 2026-10-24)'));
    const coarse = resp.slice(resp.indexOf('@media (pointer: coarse) {'));
    const block = coarse.slice(0, coarse.indexOf('\n}'));
    expect(block).toContain('.cron-drawer-close { min-width: 44px; min-height: 44px; }');
    expect(block).toContain('.cron-history-btn { min-height: 44px; }');
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

  it('the toggles are static buttons outside the regions that are re-rendered (focus and state survive repaints)', () => {
    const cap = TEMPLATE.slice(TEMPLATE.indexOf('<section class="capacity" id="capacity"'));
    const capSection = cap.slice(0, cap.indexOf('</section>'));
    expect(capSection).toMatch(
      /<button type="button" class="sec-toggle" id="capacity-toggle" data-sec-toggle="capacity" aria-expanded="false" aria-controls="capacity-view">/,
    );
    expect(capSection).toContain('<div class="capacity-view" id="capacity-view"></div>');
    const lane = TEMPLATE.slice(TEMPLATE.indexOf('<div class="cron-lane" id="cron-lane"'));
    const laneBar = lane.slice(0, lane.indexOf('<div class="cron-groups"'));
    expect(laneBar).toContain('<div class="cron-lane-head" id="cron-lane-head"></div>');
    expect(laneBar).toMatch(
      /<button type="button" class="sec-toggle" id="cron-toggle" data-sec-toggle="cron" aria-expanded="false" aria-controls="cron-groups">/,
    );
    // paintCapacity writes its timeline into the view, never over the toggle.
    expect(clientFn('paintCapacity')).toContain("getElementById('capacity-view')");
  });

  it('a collapsed capacity shows one chip per provider: both measures in max accounts, a state glyph, the next event as its tooltip', () => {
    const fns = load<{ renderCapacitySummary: (v: unknown, nowMs: number) => string }>(
      [
        'esc',
        'escAttr',
        'pad2',
        'capCountdown',
        'capClockLabel',
        'capFmt1',
        'capGain',
        'capPct',
        'capNextLine',
        'capAdvance',
        'capCount',
        'capDur',
        'renderCapacitySummary',
      ],
      ['CAP_CAUSE', 'CAP_WORD', 'CAP_5H', 'CAP_7D'],
    );
    const nowS = 1_800_000_000;
    const ev = (cause: string, at: number, dNow: number, dWeek: number) => ({
      account: 'a',
      cause,
      at: nowS + at,
      dNow,
      dWeek,
    });
    const html = fns.renderCapacitySummary(
      {
        available: true,
        groups: [
          { label: 'Claude', state: 'ok', has5h: true, total: 16, now: 6.2, week: 6.3, events: [ev('7d', 7200, 1, 1)] },
          {
            label: 'Codex',
            state: 'low',
            has5h: false,
            total: 2.4,
            now: 0.3,
            week: 0.3,
            events: [ev('7d', 3600, 1, 1)],
          },
          {
            label: 'Gemini',
            state: 'empty',
            has5h: true,
            total: 1,
            now: 0,
            week: 0.5,
            events: [ev('release', 600, 0.5, 0)],
          },
          { label: 'Other', state: 'unknown', has5h: true, total: 0, now: 0, week: 0, events: [] },
        ],
      },
      nowS * 1000,
    );
    expect(html).toContain('class="cap-summary"');
    expect(html).not.toContain('aria-live');
    // The glyph leads (the state shows first even where the row scrolls); the whole
    // sentence is the chip's accessible name.
    // Requirement 1a while folded: each measure as max accounts' worth AND % of the total.
    expect(html).toMatch(
      /cap-chip is-ok"[^>]*>Claude <span class="cap-m is-now"><i class="cap-chip-k">지금 <\/i><b>6\.2<\/b><i class="cap-chip-of">\/16\.0<\/i> <em>39%<\/em><\/span> · <span class="cap-m is-wk"><i class="cap-chip-k">주 <\/i><b>6\.3<\/b><i class="cap-chip-of">\/16\.0<\/i> <em>39%<\/em><\/span>/,
    );
    // weekly-only: the total rides on the one measure
    expect(html).toMatch(
      /cap-chip is-low"[^>]*>▲ Codex <span class="cap-m is-wk"><i class="cap-chip-k">주 <\/i><b>0\.3<\/b><i class="cap-chip-of">\/2\.4<\/i> <em>13%<\/em><\/span>/,
    );
    expect(html).toMatch(
      /cap-chip is-empty"[^>]*>✗ Gemini <span class="cap-m is-now"><i class="cap-chip-k">지금 <\/i><b>0\.0<\/b><i class="cap-chip-of">\/1\.0<\/i> <em>0%<\/em>/,
    );
    expect(html).toMatch(/cap-chip is-unknown"[^>]*>◌ Other <b>—<\/b>/);
    // r7: the tooltip speaks the card's words — 계정, 시간·분, 일주일 리셋.
    expect(html).toMatch(/cap-chip is-low" title="[^"]*다음 \+1\.0계정 · 1시간 0분 후 \([^)]*\) · ◆ a 일주일 리셋/);
    // the tooltip carries the counts too, not only the next event
    expect(html).toMatch(/cap-chip is-low" title="일주일 0\.3\/2\.4 계정 \(13%\)[^"]*1시간 0분 후/);
    expect(html).toMatch(/aria-label="Codex 일주일 0\.3\/2\.4 계정 \(13%\) · 부족 — [^"]*1시간 0분 후/);
    const off = fns.renderCapacitySummary({ available: false, reason: 'llmux unreachable', groups: [] }, nowS * 1000);
    expect(off).toContain('가용량 미확인');
    expect(off).toContain('llmux unreachable');
  });

  // Trinity mockup v5 (astra P1): the folded chip is the default view, so it carries what
  // the card's disclosure line flags — a reading over a day old, and a pool where a fifth
  // or more of the accounts is left out of the total. A fresh, (almost) full pool shows none.
  it('a folded chip flags a day-old reading and a partly counted pool', () => {
    const fns = load<{ renderCapacitySummary: (v: unknown, nowMs: number) => string }>(
      [
        'esc',
        'escAttr',
        'pad2',
        'capCountdown',
        'capClockLabel',
        'capFmt1',
        'capGain',
        'capPct',
        'capNextLine',
        'capAdvance',
        'capCount',
        'capDur',
        'renderCapacitySummary',
      ],
      ['CAP_CAUSE', 'CAP_WORD', 'CAP_5H', 'CAP_7D'],
    );
    const nowS = 1_800_000_000;
    const g = (over: Record<string, unknown>) => ({
      label: 'X',
      state: 'ok',
      has5h: false,
      total: 2.4,
      now: 2.37,
      week: 2.37,
      events: [],
      accountCount: 5,
      countedAccounts: 5,
      oldestRefreshAt: nowS - 600,
      ...over,
    });
    const html = fns.renderCapacitySummary(
      {
        available: true,
        groups: [
          g({ label: 'Codex', countedAccounts: 3, oldestRefreshAt: nowS - 5 * 86400 - 3600 }),
          g({ label: 'Claude', has5h: true, total: 16, now: 5.2, week: 5.6, accountCount: 17, countedAccounts: 16 }),
          g({ label: 'Gemini', oldestRefreshAt: nowS - 2 * 3600 }),
        ],
      },
      nowS * 1000,
    );
    const chip = (name: string) =>
      html.slice(html.indexOf(`>${name} `) - 200, html.indexOf('</span></span>', html.indexOf(`>${name} `)) + 200);
    expect(html).toMatch(
      />Codex [\s\S]*?<em>99%<\/em><\/span> <i class="cap-chip-flag">⚠ 5일 전 · 3\/5 반영<\/i><\/span>/,
    );
    expect(html).toMatch(/aria-label="Codex 일주일 2\.37\/2\.4 계정 \(99%\) · 측정 5일 전 · 3\/5 반영/);
    // one held account out of 17 and a two-hour-old reading are the card's business, not the chip's
    expect(chip('Claude')).not.toContain('cap-chip-flag');
    expect(chip('Gemini')).not.toContain('cap-chip-flag');
    expect(TEMPLATE).toContain('.cap-chip .cap-chip-flag { color: var(--st-wait); font-weight: 600; }');
  });

  // Trinity mockup v5 (grok P1): every measure reads "count / total %" — the week too, and
  // on phones too; the folded row wraps rather than drop a denominator.
  it('phones keep labelled counts, totals and % for both windows; the folded row wraps instead', () => {
    expect(TEMPLATE).not.toMatch(/\.cap-chip-of \{ display: none/);
    expect(TEMPLATE).toContain(
      '.capacity.is-collapsed .cap-summary { flex: 1 1 auto; flex-wrap: wrap; overflow-x: visible; gap: 4px; }',
    );
    // Below 840px (Duo cover ~300px, Duo inner 669px) a chip wider than the row breaks
    // between its two measures, never inside one; both rules come after the base .cap-chip.
    const wrap = '.cap-chip { flex: 0 1 auto; min-width: 0; flex-wrap: wrap; white-space: normal; column-gap: 4px; }';
    expect(TEMPLATE).toContain(`@media (max-width: 839px) {`);
    expect(TEMPLATE).toContain(wrap);
    expect(TEMPLATE).toContain('.cap-chip .cap-m, .cap-chip .cap-chip-flag { white-space: nowrap; }');
    expect(TEMPLATE).toContain('@media (max-width: 639px) { .cap-chip { padding: 2px 6px; font-size: 11px; } }');
    for (const rule of [wrap, '.cap-chip { padding: 2px 6px; font-size: 11px; }'])
      expect(TEMPLATE.indexOf(rule)).toBeGreaterThan(TEMPLATE.indexOf('.cap-chip {\n  flex: none;'));
    expect(TEMPLATE).not.toMatch(/\.cap-chip[^{]*(?:\bb|em|cap-chip-k)[^{]*\{ display: none/);
  });

  it('collapsed: the timeline, legend and subtitle are hidden; the chips only show while collapsed', () => {
    expect(TEMPLATE).toContain(
      '.capacity.is-collapsed .cap-sub, .capacity.is-collapsed .cap-legend, .capacity.is-collapsed .cap-rows, .capacity.is-collapsed .cap-off { display: none; }',
    );
    expect(TEMPLATE).toContain('.capacity:not(.is-collapsed) .cap-summary { display: none; }');
    expect(TEMPLATE).toContain('.cron-group[hidden] { display: none; }');
    expect(TEMPLATE).toContain('@media (pointer: coarse) { .sec-toggle { min-height: 44px; } }');
  });

  it('a folded CRON lane drops the cards of every job that does not wait for a reply (out of the DOM, not display:none)', () => {
    const slots = clientFn('cronLaneSlots');
    expect(slots).toContain('cronLaneFolded()');
    expect(slots).toContain('!g.waiting');
    const sync = clientFn('syncCronLane');
    expect(sync).toContain('sec.hidden = folded && !g.waiting;');
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
    expect(clientFn('collectViewMovers')).toContain('getClientRects().length');
  });

  it('a capacity paint that changes the page height refreshes the shift cache (it sits above the board, outside #inbox)', () => {
    expect(clientFn('paintCapacity')).toContain('scheduleLayoutRefresh(');
  });

  it('a deep link into a folded CRON lane opens it for this page load only', () => {
    expect(clientFn('openDeepLinkedSession')).toContain('_cronLaneRevealed = true;');
    expect(clientFn('secIsOpen')).toContain('_cronLaneRevealed');
  });
});

describe('secondary sections — trinity code review R1 follow-ups (astra)', () => {
  it('a disclosure render leaves every board move to the coordinator (no FLIP from a half-revealed lane)', () => {
    expect(clientFn('applyBoardPlan')).toContain('_boardFlipOff');
    expect(clientFn('renderBoardForLayout')).toContain('_boardFlipOff = true;');
    expect(clientFn('toggleSection')).toContain('renderBoardForLayout()');
    expect(clientFn('runLayoutCheck')).toContain('renderBoardForLayout()');
    expect(clientFn('toggleSection')).not.toContain('renderBoard(_lastBoardData)');
  });

  it('the 44px touch size comes after the toggle base rule, so it wins', () => {
    const base = TEMPLATE.indexOf('.sec-toggle {\n  position: relative;\n  display: inline-flex;');
    const touch = TEMPLATE.indexOf('@media (pointer: coarse) { .sec-toggle { min-height: 44px; } }');
    expect(base).toBeGreaterThan(-1);
    expect(touch).toBeGreaterThan(base);
  });

  it('a toggle works for this page even when storage refuses the write', () => {
    expect(TEMPLATE).toContain('var _secChoice = {};');
    expect(clientFn('toggleSection')).toMatch(
      /_secChoice\[sec\] = open \? 'open' : 'closed';[\s\S]*localStorage\.setItem/,
    );
    expect(clientFn('secIsOpen')).toContain('_secChoice[sec]');
  });
});
