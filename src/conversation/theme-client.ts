import { DESIGNS } from '@2lab.ai/ui/server';

/**
 * The theme on every page — the dashboard, the settings page, the conversation viewer and the sign-in pages (soma-work 830).
 *
 * Four themes, in the order the app bar's toggle walks them: light → dark → light·mono → dark·mono → light. The two
 * colour themes are @2lab.ai/ui's light and dark as they were; the mono pair (`data-palette="mono"` beside
 * `data-theme`, @2lab.ai/ui ≥ 0.25.0) keeps colour for the four task states only, and only on their marks.
 *
 * Designs (@2lab.ai/ui ≥ 0.39.0): a whole look such as Modern Mono, applied with `data-design` on <html> and drawn for
 * one light / dark of its own. The bar gets the designs (`THEME_DESIGNS`, the library's `DESIGNS`), so its theme
 * button opens one menu with every theme and design; choosing a design puts it on <html> and keeps it until a theme
 * is chosen. The OS switching light / dark leaves a design alone.
 *
 * This browser keeps the choice in three keys:
 *  - `soma-theme` — 'light' | 'dark', stored only while it differs from the OS (absent = follow the OS, live);
 *  - `soma-palette` — 'mono', or absent for the colour palette;
 *  - `soma-design` — a design id while one is on (it wins over the two above), absent otherwise.
 * `soma-theme` keeps its old values, so a page that reads only it still gets the right light or dark.
 *
 * The script is a String.raw literal with no backticks and no `${…}`, so it reaches the browser byte for byte and the
 * tests run it as shipped. It goes first in <head>: the theme is on <html> before the first paint. It answers the
 * page's <ui-app-bar id="app-bar"> ui-theme-change from the document (bound before the bar can be clicked) and hands
 * the bar the new theme; the page's own bar data reads `somaThemeNow()`.
 */

/** 'light' | 'dark' while it differs from the OS; absent = follow the OS. */
export const THEME_STORAGE_KEY = 'soma-theme';
/** 'mono' for the mono pair; absent = the colour palette. */
export const PALETTE_STORAGE_KEY = 'soma-palette';
/** A design id (e.g. 'modern-mono') while one is on; absent = a plain theme. */
export const DESIGN_STORAGE_KEY = 'soma-design';

/** The designs the bar's theme menu offers: the library's DESIGNS, as <ui-app-bar> reads them. */
export const THEME_DESIGNS: ReadonlyArray<{ id: string; label: string; scheme: 'light' | 'dark' }> = DESIGNS.map(
  (d) => ({
    id: d.id,
    label: d.name,
    scheme: d.scheme,
  }),
);

const THEME_CLIENT_JS = String.raw`
// ── Theme — light · dark · light·mono · dark·mono (soma-work 830), and the designs (SOMA_DESIGNS, above); the choice
// is this browser's ──
function somaThemeOs() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function somaThemeSaved() {
  try { var t = localStorage.getItem('soma-theme'); return t === 'light' || t === 'dark' ? t : null; } catch (_e) { return null; }
}
function somaPaletteSaved() {
  try { return localStorage.getItem('soma-palette') === 'mono' ? 'mono' : 'color'; } catch (_e) { return 'color'; }
}
// The design with this id among SOMA_DESIGNS, or null.
function somaDesignOf(id) {
  for (var i = 0; i < SOMA_DESIGNS.length; i++) if (SOMA_DESIGNS[i].id === id) return SOMA_DESIGNS[i];
  return null;
}
function somaDesignSaved() {
  try { var d = somaDesignOf(localStorage.getItem('soma-design')); return d ? d.id : null; } catch (_e) { return null; }
}
// What the page shows now: { theme: 'light' | 'dark', palette: 'color' | 'mono', design: id | null }.
function somaThemeNow() {
  var r = document.documentElement;
  var d = somaDesignOf(r.getAttribute('data-design'));
  return {
    theme: r.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    palette: r.getAttribute('data-palette') === 'mono' ? 'mono' : 'color',
    design: d ? d.id : null,
  };
}
// A design brings its own light / dark and no palette; without one, the theme and palette as given.
function somaThemeShow(theme, palette, design) {
  var r = document.documentElement;
  var d = somaDesignOf(design);
  if (d) {
    theme = d.scheme;
    palette = 'color';
    r.setAttribute('data-design', d.id);
  } else r.removeAttribute('data-design');
  r.setAttribute('data-theme', theme);
  if (palette === 'mono') r.setAttribute('data-palette', 'mono');
  else r.removeAttribute('data-palette');
  // The page's <ui-app-bar> draws its theme menu from data.theme / data.palette / data.design / data.designs.
  var bar = document.getElementById('app-bar');
  var id = d ? d.id : null;
  if (bar && bar.data && (bar.data.theme !== theme || bar.data.palette !== palette || bar.data.design !== id)) {
    bar.data = Object.assign({}, bar.data, { theme: theme, palette: palette, design: id, designs: SOMA_DESIGNS });
  }
}
// The person chose a theme or a design. A design is stored on its own (it wins while it is there); a theme clears it,
// and stores the light / dark only while it differs from the OS, the palette while mono.
function somaThemeSet(theme, palette, design) {
  var d = somaDesignOf(design);
  if (design && !d) return;
  if (d) {
    try { localStorage.setItem('soma-design', d.id); } catch (_e) {}
    somaThemeShow(d.scheme, 'color', d.id);
    return;
  }
  if (theme !== 'light' && theme !== 'dark') return;
  if (palette !== 'mono') palette = 'color';
  try {
    localStorage.removeItem('soma-design');
    if (theme === somaThemeOs()) localStorage.removeItem('soma-theme');
    else localStorage.setItem('soma-theme', theme);
    if (palette === 'mono') localStorage.setItem('soma-palette', 'mono');
    else localStorage.removeItem('soma-palette');
  } catch (_e) {}
  somaThemeShow(theme, palette, null);
}
somaThemeShow(somaThemeSaved() || somaThemeOs(), somaPaletteSaved(), somaDesignSaved());
// The OS switched light / dark: followed while the person has not pinned one (the palette stays); a design keeps its own.
if (window.matchMedia) {
  var _somaThemeMq = window.matchMedia('(prefers-color-scheme: light)');
  var _somaThemeOnOs = function (e) {
    if (!somaThemeSaved() && !somaThemeNow().design) somaThemeShow(e.matches ? 'light' : 'dark', somaThemeNow().palette, null);
  };
  if (_somaThemeMq.addEventListener) _somaThemeMq.addEventListener('change', _somaThemeOnOs);
  else if (_somaThemeMq.addListener) _somaThemeMq.addListener(_somaThemeOnOs);
}
// The bar asks for a theme (its palette rides along — @2lab.ai/ui ≥ 0.25.0) or, from its theme menu, a design
// (≥ 0.39.0; design is null for a plain theme, and a toggle that sends none is a plain theme too). Listened for on the
// document from here, before the bar exists: the event bubbles out of the bar, so a click can never land before
// the listener (a bar defined by an early module while a later one still loads, DOMContentLoaded not yet fired).
document.addEventListener('ui-theme-change', function (e) {
  var t = e && e.target;
  if (!t || t.id !== 'app-bar') return;
  var d = (e && e.detail) || {};
  somaThemeSet(d.theme, d.palette === undefined ? somaThemeNow().palette : d.palette, d.design || null);
});
`;

/**
 * The head script: the designs (SOMA_DESIGNS, from the library, as JSON with `<` escaped so nothing in it can close the
 * <script>), then the theme on <html> before paint, the storage, the OS follow and the app bar's theme menu.
 */
export function themeClientJs(): string {
  const designs = JSON.stringify(THEME_DESIGNS).replace(/</g, '\\u003c');
  return `\nvar SOMA_DESIGNS = ${designs};${THEME_CLIENT_JS}`;
}
