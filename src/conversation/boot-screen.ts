/**
 * The dashboard's first screen (#965): what a fresh load or a refresh shows until the page's own elements are drawn.
 *
 * Why it exists. The page is ~1 MB of HTML and ~40 @2lab.ai/ui modules. Modules run only after the whole document is
 * parsed, so on a phone the browser paints for seconds with no custom element defined — and an undefined element
 * draws its light-DOM children in the page's flow: the closed dialogs' forms and buttons (the session lifecycle form,
 * the rollback footer, the new-task form), an empty bar, an empty board. The overlays are hidden until defined by the
 * page sheet (`ui-dialog:not(:defined)` …); everything else waits under this screen.
 *
 * What it is. A layer over the page, in the page's colours (the theme is on <html> before the first paint), shaped
 * like the page under it so the swap reads as the content filling in: the app bar with the brand mark where the bar
 * draws it, the board's head, and the board's three columns with the skeleton cards @2lab.ai/ui's board draws while
 * it loads (2 · 3 · 2, the kit's `.ui-skeleton` pulse). Its geometry is the page's: the bar 56px (52 on phones), the
 * main column 1280px wide with 20px padding (14 / 12 on phones), the columns' 12px gap (300px each on a phone, the
 * second one peeking). A fast load sees still blocks: the pulse starts at 500ms and the mark breathes from 1s
 * (research: no motion for loads under a second). Reduced motion: still blocks, a still mark.
 *
 * When it goes. The first of:
 *  - the document is parsed and no custom element with a box in the viewport is still undefined (one painted frame
 *    of the real page under the layer first) — a closed dialog or a hidden section never holds it;
 *  - DOMContentLoaded (every module has run; a module that failed to load leaves its element undefined for good);
 *  - 12 seconds (a module request that never answers holds DOMContentLoaded back).
 * It fades out (180ms, the kit's fade) and leaves the DOM. Without script a CSS animation hides it at 15s.
 * While it is up the page under it is inert (#969) — every in-flow child of .app, not the drawers and dialogs — so a
 * keyboard cannot reach controls nobody can see; every lift gives the focus back, and an overlay that opens (a deep
 * link's drawer) lifts it at once. It draws the board in the view the page will choose (the saved one, else list below
 * 640px) and the kit's narrow-board columns; boot-screen.test.ts [T7] reads its numbers against the kit and the page.
 *
 * The script is a template literal with no backticks, no `${…}` and no backslashes: it reaches the browser byte for
 * byte and the tests run it as shipped (theme-client.ts's pattern). The layer carries no words, so no catalog entry: it is
 * aria-hidden, the board says its own loading state.
 *
 * Research and the real-server receipts: docs/misc/research/2026-11-05-dashboard-first-load.md.
 */

/** Skeleton cards per column — @2lab.ai/ui's board skeleton (2 · 3 · 2). */
const COLUMN_CARDS = [2, 3, 2];

function card(i: number): string {
  return (
    `<div class="boot-card"><span class="ui-skeleton boot-title" style="--i:${i}"></span>` +
    `<span class="ui-skeleton boot-meta" style="--i:${i}"></span>` +
    `<span class="ui-skeleton boot-pill" style="--i:${i}"></span></div>`
  );
}

function column(cards: number, col: number): string {
  let html = `<div class="boot-col"><div class="boot-col-head"><span class="ui-skeleton boot-col-name" style="--i:${col}"></span></div>`;
  for (let i = 0; i < cards; i++) html += card(col + i);
  return `${html}</div>`;
}

/** The layer's markup — the first child of <body>, so the first paint is it. */
export function bootScreenHtml(): string {
  return (
    '<div class="boot" id="boot" aria-hidden="true">' +
    '<div class="boot-bar">' +
    '<span class="boot-brand"><svg class="boot-mark" viewBox="0 0 16 16" width="20" height="20" focusable="false">' +
    '<rect x="2" y="2" width="5" height="5" rx="1.25"/><rect x="9" y="2" width="5" height="5" rx="1.25"/>' +
    '<rect x="9" y="9" width="5" height="5" rx="1.25"/><rect x="2" y="9" width="5" height="5" rx="1.25"/>' +
    '</svg><span class="boot-word">soma-work</span></span>' +
    '<span class="boot-grow"></span>' +
    '<span class="ui-skeleton boot-chip"></span><span class="ui-skeleton is-circle boot-avatar" style="--i:1"></span>' +
    '</div>' +
    '<div class="boot-barrow"></div>' +
    '<div class="boot-main">' +
    '<div class="boot-head"><span class="ui-skeleton boot-crumb"></span><span class="boot-tools">' +
    '<span class="ui-skeleton boot-scope" style="--i:1"></span>' +
    '<span class="ui-skeleton boot-filter" style="--i:1"></span><span class="ui-skeleton boot-sort" style="--i:1"></span>' +
    '<span class="boot-break"></span>' +
    '<span class="ui-skeleton boot-search" style="--i:2"></span><span class="ui-skeleton boot-seg" style="--i:2"></span>' +
    '</span></div>' +
    `<div class="boot-board">${COLUMN_CARDS.map((n, c) => column(n, c)).join('')}</div>` +
    '</div></div>'
  );
}

/**
 * The layer's rules. After the kit sheet (it uses `.ui-skeleton` and its `ui-sk-pulse`), read from the page's tokens.
 * The mark's squares rest at the bar's own pattern (1 · .55 · .25 · .55, clockwise from the top left).
 */
export function bootScreenCss(): string {
  return `
.boot {
  position: fixed; inset: 0; z-index: 2147483000; overflow: hidden; background: var(--bg); color: var(--ib-text);
  padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);
  transition: opacity var(--dur-fade, 180ms) var(--ease-out), visibility 0s linear var(--dur-fade, 180ms);
  animation: boot-gone 0s linear 15s forwards;
}
.boot.is-out { opacity: 0; visibility: hidden; pointer-events: none; }
@keyframes boot-gone { to { opacity: 0; visibility: hidden; pointer-events: none; } }
.boot .ui-skeleton { animation-delay: calc(500ms + var(--i, 0) * 120ms); }
.boot-bar { display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 20px; border-bottom: 1px solid var(--border); }
.boot-brand { display: inline-flex; align-items: center; gap: 9px; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; line-height: 20px; white-space: nowrap; }
.boot-mark { flex: none; width: 20px; height: 20px; fill: currentColor; }
.boot-mark rect { animation: boot-mark 1.6s ease-in-out 1s infinite; }
.boot-mark rect:nth-child(2) { opacity: 0.55; animation-delay: 1.2s; }
.boot-mark rect:nth-child(3) { opacity: 0.25; animation-delay: 1.4s; }
.boot-mark rect:nth-child(4) { opacity: 0.55; animation-delay: 1.6s; }
@keyframes boot-mark { 35% { opacity: 1; } 70% { opacity: 0.25; } }
.boot-grow { flex: 1 1 0; }
.boot .boot-chip { width: 92px; height: 28px; border-radius: 999px; }
.boot .boot-avatar { width: 30px; height: 30px; }
.boot-main { max-width: 1280px; margin: 0 auto; padding: 20px; container: boot / inline-size; }
.boot-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; margin: 4px 0 16px; }
.boot-tools { display: flex; align-items: center; gap: 8px; }
.boot .boot-crumb { width: 176px; height: 14px; }
/* The board's tools as the page draws them (#976): filter · sort · search · Board | List, right of the breadcrumb. On a
   phone the scope chips join them and they wrap in two rows (chips · filter · sort / search · Board | List); the view
   switch is 50px tall on touch and on a phone, 34px otherwise. */
.boot .boot-scope, .boot-break { display: none; }
.boot .boot-filter { width: 41px; height: 24px; border-radius: 999px; }
.boot .boot-sort { width: 88px; height: 24px; border-radius: 999px; }
.boot .boot-search { width: 140px; height: 32px; border-radius: 10px; }
.boot .boot-seg { width: 135px; height: 34px; border-radius: 10px; }
/* Narrower than the bar's toolbarAt (1280px) the page's scope group takes the bar's own row under it: ~18px empty
   (padding and hairline) up to ~42px with the admin chips — the layer takes the middle, as it cannot know the role. */
.boot-barrow { display: none; height: 30px; border-bottom: 1px solid var(--border); }
@media (min-width: 640px) and (max-width: 1279px) and (min-height: 561px) {
  .boot-barrow { display: block; }
}
@media (pointer: coarse) {
  .boot .boot-seg { height: 50px; border-radius: 12px; }
  .boot-head { min-height: 50px; }
}
.boot-board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; }
/* The board's own views (the page's defaultBoardView, set by the script below before the first paint): list stacks the
   columns full width; a narrow board scrolls its columns sideways — the kit's rules, on the main column as container. */
.boot[data-view="list"] .boot-board { grid-template-columns: minmax(0, 1fr); }
@container boot (max-width: 839px) {
  .boot:not([data-view="list"]) .boot-board { grid-template-columns: repeat(3, minmax(min(300px, 84cqi), 1fr)); }
}
.boot-col { display: flex; flex-direction: column; gap: 8px; padding: 2px 4px 4px; border-radius: 14px; background: var(--ib-col); }
.boot-col-head { display: flex; align-items: center; min-height: 40px; padding: 10px 8px 8px 15px; margin-bottom: -8px; }
.boot .boot-col-name { width: 72px; height: 10px; }
.boot-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 12px; background: var(--ib-card); border: 1px solid var(--ib-card-border); box-shadow: var(--ib-shadow); }
.boot .boot-title { width: 68%; height: 14px; }
.boot .boot-meta { width: 42%; height: 10px; }
.boot .boot-pill { width: 34%; height: 20px; border-radius: 999px; }
@media (max-width: 639px) {
  .boot-bar { height: 52px; padding: 0 12px; gap: 8px; }
  .boot-word { display: none; }
  .boot-main { padding: 14px 12px; }
  .boot-head { flex-direction: column; align-items: stretch; gap: 8px; margin-bottom: 12px; }
  .boot .boot-crumb { margin: 15px 0; }
  .boot-tools { flex-wrap: wrap; justify-content: flex-end; row-gap: 0; }
  .boot .boot-scope { display: block; width: 150px; height: 28px; border-radius: 999px; margin-right: auto; }
  .boot-break { display: block; flex-basis: 100%; height: 0; }
  .boot .boot-search, .boot .boot-seg { margin-top: 8px; }
  .boot .boot-search { margin-right: auto; }
  .boot .boot-seg { height: 50px; border-radius: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .boot-mark rect { animation: none; }
}
`;
}

const BOOT_CLIENT_JS = `
// ── The first screen (#965): over the page until what the viewport shows is defined — see boot-screen.ts ──
(function () {
  var boot = document.getElementById('boot');
  if (!boot) return;
  var gone = false;
  // The board's view, as the page will choose it (defaultBoardView): the saved choice, else list below 640px (#969).
  var saved = null;
  try { saved = localStorage.getItem('soma-board-view'); } catch (_e) {}
  boot.setAttribute('data-view', saved === 'board' || saved === 'list' ? saved : window.innerWidth < 640 ? 'list' : 'board');
  // The page under the layer takes no keyboard focus while it is up (#969): every in-flow child of .app goes inert as
  // the parser adds it, and gets its focus back at the lift. The overlays (drawers, dialogs) stay live, and the layer
  // lifts the moment one opens (a deep link's drawer: docked from 840px it sits under the layer). A child the page made
  // inert itself is left alone.
  var held = [];
  function hold() {
    var app = document.querySelector('.app');
    for (var el = app && app.firstElementChild; el; el = el.nextElementSibling) {
      if (el.inert || held.indexOf(el) >= 0 || el.tagName === 'UI-DRAWER' || el.tagName === 'UI-DIALOG') continue;
      el.inert = true;
      held.push(el);
    }
  }
  // A custom element that is still undefined and has a box in the viewport: the page is not drawn yet.
  function undrawn() {
    var els;
    try { els = document.querySelectorAll(':not(:defined)'); } catch (_e) { return false; }
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if ((r.width > 0 || r.height > 0) && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth) return true;
    }
    return false;
  }
  function lift() {
    if (gone) return;
    gone = true;
    for (var i = 0; i < held.length; i++) held[i].inert = false;
    boot.classList.add('is-out');
    setTimeout(function () { if (boot.parentNode) boot.parentNode.removeChild(boot); }, 400);
  }
  function check() {
    if (gone) return;
    hold();
    if (document.querySelector('.app > ui-drawer[open], .app > ui-dialog[open]')) return lift();
    if (document.readyState !== 'loading' && !undrawn()) return requestAnimationFrame(lift);
    requestAnimationFrame(check);
  }
  document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(lift); });
  setTimeout(lift, 12000);
  requestAnimationFrame(check);
})();
`;

/** The layer's script — right after its markup, before the page's own script. */
export function bootClientJs(): string {
  return BOOT_CLIENT_JS;
}

/** The slot renderDashboardPage leaves first in <body>: a comment, so the body markup stays a plain template slice. */
export const BOOT_SCREEN_SLOT = '<!-- boot-screen -->';

/**
 * Puts the layer and its script in the page's slot. The script carries data-boot, so it is never taken for the page's
 * own (the only bare <script> in <body>).
 */
export function withBootScreen(html: string): string {
  return html.replace(BOOT_SCREEN_SLOT, () => `${bootScreenHtml()}\n<script data-boot>${bootClientJs()}</script>`);
}
