/**
 * The theme on every page — the dashboard, the settings page, the conversation viewer and the sign-in pages (soma-work 830).
 *
 * Four themes, in the order the app bar's toggle walks them: light → dark → light·mono → dark·mono → light. The two
 * colour themes are @2lab.ai/ui's light and dark as they were; the mono pair (`data-palette="mono"` beside
 * `data-theme`, @2lab.ai/ui ≥ 0.25.0) keeps colour for the four task states only, and only on their marks.
 *
 * This browser keeps the choice in two keys:
 *  - `soma-theme` — 'light' | 'dark', stored only while it differs from the OS (absent = follow the OS, live);
 *  - `soma-palette` — 'mono', or absent for the colour palette.
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

const THEME_CLIENT_JS = String.raw`
// ── Theme — light · dark · light·mono · dark·mono (soma-work 830); the choice is this browser's ──
function somaThemeOs() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function somaThemeSaved() {
  try { var t = localStorage.getItem('soma-theme'); return t === 'light' || t === 'dark' ? t : null; } catch (_e) { return null; }
}
function somaPaletteSaved() {
  try { return localStorage.getItem('soma-palette') === 'mono' ? 'mono' : 'color'; } catch (_e) { return 'color'; }
}
// What the page shows now: { theme: 'light' | 'dark', palette: 'color' | 'mono' }.
function somaThemeNow() {
  var r = document.documentElement;
  return {
    theme: r.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    palette: r.getAttribute('data-palette') === 'mono' ? 'mono' : 'color',
  };
}
function somaThemeShow(theme, palette) {
  var r = document.documentElement;
  r.setAttribute('data-theme', theme);
  if (palette === 'mono') r.setAttribute('data-palette', 'mono');
  else r.removeAttribute('data-palette');
  // The page's <ui-app-bar> draws its toggle from data.theme / data.palette.
  var bar = document.getElementById('app-bar');
  if (bar && bar.data && (bar.data.theme !== theme || bar.data.palette !== palette)) {
    bar.data = Object.assign({}, bar.data, { theme: theme, palette: palette });
  }
}
// The person chose a theme: the light / dark is stored only while it differs from the OS, the palette while mono.
function somaThemeSet(theme, palette) {
  if (theme !== 'light' && theme !== 'dark') return;
  if (palette !== 'mono') palette = 'color';
  try {
    if (theme === somaThemeOs()) localStorage.removeItem('soma-theme');
    else localStorage.setItem('soma-theme', theme);
    if (palette === 'mono') localStorage.setItem('soma-palette', 'mono');
    else localStorage.removeItem('soma-palette');
  } catch (_e) {}
  somaThemeShow(theme, palette);
}
somaThemeShow(somaThemeSaved() || somaThemeOs(), somaPaletteSaved());
// The OS switched light / dark: followed while the person has not pinned one (the palette stays).
if (window.matchMedia) {
  var _somaThemeMq = window.matchMedia('(prefers-color-scheme: light)');
  var _somaThemeOnOs = function (e) {
    if (!somaThemeSaved()) somaThemeShow(e.matches ? 'light' : 'dark', somaThemeNow().palette);
  };
  if (_somaThemeMq.addEventListener) _somaThemeMq.addEventListener('change', _somaThemeOnOs);
  else if (_somaThemeMq.addListener) _somaThemeMq.addListener(_somaThemeOnOs);
}
// The bar's toggle asks for the next theme (its palette rides along — @2lab.ai/ui ≥ 0.25.0). Listened for on the
// document from here, before the bar exists: the event bubbles out of the bar, so a click can never land before
// the listener (a bar defined by an early module while a later one still loads, DOMContentLoaded not yet fired).
document.addEventListener('ui-theme-change', function (e) {
  var t = e && e.target;
  if (!t || t.id !== 'app-bar') return;
  var d = (e && e.detail) || {};
  somaThemeSet(d.theme, d.palette === undefined ? somaThemeNow().palette : d.palette);
});
`;

/** The head script: the theme on <html> before paint, the storage, the OS follow and the app bar's toggle. */
export function themeClientJs(): string {
  return THEME_CLIENT_JS;
}
