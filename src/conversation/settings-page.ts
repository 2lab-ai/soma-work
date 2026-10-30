/**
 * The settings page (SSOT 2026-10-23 T2/T5) — `/dashboard/settings`.
 *
 * A separate page, not another view inside `dashboard.ts` (#155: that file is
 * already too big). One tab per area; this module renders the shell and the
 * "개인 설정" tab, driven entirely by `GET /api/settings` (the registry
 * decides which rows exist, their options and who may edit them).
 *
 * UI decisions (research brief, SSOT T5):
 *   - a left section list with a filter box (GitHub / Linear settings);
 *   - choices save at once, typed values save with an explicit button —
 *     never mixed inside one control (Primer "saving" pattern);
 *   - feedback next to the row in a polite live region, not a toast;
 *   - a row that differs from the default is marked and can be reset;
 *   - every row names the Slack command that changes the same setting;
 *   - consequential settings sit last, in a bordered danger zone, and are
 *     confirmed with a specific button label;
 *   - an admin-only row is shown read-only with the reason, never as a
 *     greyed control without an explanation.
 *
 * The client script is a String.raw literal: no `${…}` and no backticks in
 * it, so it reaches the browser byte for byte (tests run it as shipped).
 */

import { MEMORY_CLIENT_JS, MEMORY_TAB_CSS, MEMORY_TAB_HTML } from './settings-memory-tab';
import { soundClientJs, soundToggleHtml } from './sound-client';
import { pageTokenAliases, UI_LIB_VERSION, uiLibTokensCss } from './ui-lib';

export interface SettingsPageTab {
  id: string;
  label: string;
}

/** Tabs that exist on this build. Later areas append here. */
export const SETTINGS_TABS: SettingsPageTab[] = [
  { id: 'preferences', label: '개인 설정' },
  { id: 'memory', label: '기억' },
];

export const SETTINGS_PAGE_CSS = String.raw`
*,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
/* Tone pass P9 — the settings page speaks the dashboard's language. Its colour, geometry, type and motion
   tokens are the ui-tokens sheet after this one (@2lab.ai/ui tokens.css + the page aliases, the dashboard's
   single source since P10): no palette of its own. Only what the library has no counterpart for is here. */
:root {
  /* Status tints — the library recipe: a wash of the status into the surface, the word 70% of the status
     toward the ink. Every text pair is ≥ 4.5:1 in light and dark (numbers in the P9 commit). */
  --tint-done-fg: color-mix(in srgb, var(--st-done) 70%, var(--text));
  --tint-fail-fg: color-mix(in srgb, var(--st-fail-text) 70%, var(--text));
  --tint-fail-soft: color-mix(in srgb, var(--st-fail) 6%, var(--surface));
  --tint-fail-line: color-mix(in srgb, var(--st-fail) 55%, var(--border));
  /* Scrim under the confirm dialog (the dashboard's, until @2lab.ai/ui ships --scrim). */
  --scrim: rgba(20, 20, 22, 0.32);
  --topbar-h: 56px;
}
[data-theme="dark"] { --scrim: rgba(0, 0, 0, 0.56); }
html, body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.45; letter-spacing: 0; -webkit-font-smoothing: antialiased; }
/* @2lab.ai/ui elements (the 기억 tab's <ui-memory-panel>) draw with these tokens: each --ui-* an element
   reads is set on its wrapper from the same-named page token. Not on the element itself — its shadow :host
   defines --border: var(--ui-border, …), so --ui-border: var(--border) there is a cycle. Inherited from the
   wrapper, the values arrive resolved and follow the theme switch (the dashboard's .ui-tok, same names). */
.ui-tok {
  --ui-bg: var(--bg); --ui-surface: var(--surface); --ui-surface-raised: var(--surface-raised);
  --ui-border: var(--border); --ui-border-focus: var(--border-focus); --ui-text: var(--text);
  --ui-text-secondary: var(--text-secondary); --ui-text-tertiary: var(--text-tertiary); --ui-accent: var(--accent);
  --ui-green: var(--green); --ui-yellow: var(--yellow); --ui-red: var(--red); --ui-ib-pill: var(--ib-pill);
  --ui-st-wait: var(--st-wait); --ui-st-done: var(--st-done); --ui-st-fail: var(--st-fail);
  --ui-ease-out: var(--ease-out); --ui-dur-press: var(--dur-press); --ui-dur-fade: var(--dur-fade);
  --ui-radius: var(--radius); --ui-font: var(--font); --ui-mono: var(--mono);
}
a { color: var(--accent); }
code { font-family: var(--mono); font-size: 12px; }
/* ── App bar — ui.2lab.ai's, as on the dashboard (P4): the page colour at 86% over what scrolls under it,
   blurred, one hairline; opaque when the reader asks for less transparency. Chip links (no box at rest,
   the --ib-pill chip on hover and for the current tab), a neutral user pill, the 34px theme icon button. ── */
.topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; min-height: var(--topbar-h); padding: 0 20px; background: color-mix(in srgb, var(--bg) 86%, transparent); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
@media (prefers-reduced-transparency: reduce) {
  .topbar { background: var(--bg); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
.topbar h1 { display: inline-flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; flex: none; }
.topbar h1 .brand-mark { width: 22px; height: 22px; flex: none; }
.brand-mark .bm-bg { fill: var(--text); }
.brand-mark .bm-cell { fill: var(--surface); }
.topbar-nav { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tabs { display: flex; gap: 2px; }
.topbar .back, .tabs a { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 6px 10px; border-radius: 8px; font-size: 13px; font-weight: 500; color: var(--text-secondary); text-decoration: none; white-space: nowrap; transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out); }
.topbar .back svg { width: 15px; height: 15px; flex: none; }
.tabs a[aria-current="page"] { background: var(--ib-pill); color: var(--text); }
.topbar .account { margin-left: auto; display: flex; gap: 6px; align-items: center; min-width: 0; }
.topbar .who { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 260px; min-height: 32px; padding: 5px 12px 5px 8px; border: 1px solid var(--border); border-radius: 999px; font-size: 13px; font-weight: 500; line-height: 1; color: var(--text); white-space: nowrap; }
.topbar .who svg { width: 15px; height: 15px; flex: none; color: var(--text-tertiary); }
.topbar .who #who { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.topbar .who:has(#who:empty) { display: none; }
.topbar .theme { display: inline-grid; place-items: center; flex: none; width: 34px; height: 34px; padding: 0; background: var(--ib-card); border: 1px solid var(--ib-card-border); border-radius: 10px; color: var(--ib-text-2); cursor: pointer; transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out); }
.topbar .theme svg { width: 16px; height: 16px; }
.topbar .theme .ic-moon, [data-theme="light"] .topbar .theme .ic-sun { display: none; }
[data-theme="light"] .topbar .theme .ic-moon { display: block; }
/* The speaker beside it (interface sound, the dashboard's): the same icon button; sound-off while off. */
.topbar .sound { display: inline-grid; place-items: center; flex: none; width: 34px; height: 34px; padding: 0; background: var(--ib-card); border: 1px solid var(--ib-card-border); border-radius: 10px; color: var(--ib-text-2); cursor: pointer; transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out); }
.topbar .sound svg { width: 16px; height: 16px; }
.topbar .sound .ic-sound, :root[data-sound="on"] .topbar .sound .ic-sound-off { display: none; }
:root[data-sound="on"] .topbar .sound .ic-sound { display: block; }
.topbar .sound:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.topbar .sound:active:not(:focus-visible) { transform: scale(0.97); }
@media (hover: hover) and (pointer: fine) { .topbar .sound:hover { background: var(--ib-pill); color: var(--text); } }
.topbar .back:focus-visible, .tabs a:focus-visible, .topbar .theme:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.page { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
/* An author display beats the UA [hidden] rule — tabs are switched with the hidden attribute. */
.page[hidden] { display: none; }
.side { position: sticky; top: calc(var(--topbar-h) + 16px); align-self: start; display: flex; flex-direction: column; gap: 12px; }
.side input[type="search"] { width: 100%; font: inherit; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.side .only-modified { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-secondary); }
.side .only-modified input { accent-color: var(--ib-text); }
.side nav { display: flex; flex-direction: column; gap: 2px; }
.side nav a { font-size: 13px; text-decoration: none; color: var(--text-secondary); padding: 6px 10px; border-radius: 8px; }
.side nav .navbtn { font: inherit; font-size: 13px; text-align: left; color: var(--text-secondary); background: none; border: 0; padding: 6px 10px; border-radius: 8px; cursor: pointer; transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out); }
.side nav .navbtn:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.side nav a:focus-visible, .side input:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.intro { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
.notice { font-size: 13px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.notice.is-error { border-color: var(--tint-fail-line); background: var(--tint-fail-soft); color: var(--tint-fail-fg); }
/* Groups are the library's 12px cards with the whisper shadow; a section link lands below the sticky bar. */
section.group { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--ib-shadow); margin-bottom: 20px; scroll-margin-top: calc(var(--topbar-h) + 16px); }
section.group.danger { border-color: var(--tint-fail-line); background: var(--tint-fail-soft); }
section.group > header { padding: 14px 16px 10px; border-bottom: 1px solid var(--border); }
section.group > header h2 { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
section.group > header p { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 8px 20px; padding: 14px 16px; border-top: 1px solid var(--border); }
.row:first-of-type { border-top: 0; }
.row.is-modified::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 999px; background: var(--accent); }
.row[hidden] { display: none; }
.row .meta label, .row .meta .label { font-weight: 600; font-size: 13px; }
.row .meta p { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.row .meta .hint { font-size: 11px; color: var(--text-tertiary); margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.row .control { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.row .control .line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.row input[type="text"], .row input[type="number"], .row select { font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; min-height: 34px; min-width: 0; }
.row input[type="text"] { flex: 1 1 220px; }
.row input[type="number"] { width: 110px; font-variant-numeric: tabular-nums; }
.row select { max-width: 100%; }
/* Buttons are the library kit's (.ui-btn): a hairline card button, the ink primary — the one decision of
   its row or dialog — and the destructive confirm in the fail tone. One press rule: scale(.97). */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 13px; font-weight: 500; line-height: 1.2; color: var(--ib-text); background: var(--ib-card); border: 1px solid var(--ib-card-border); border-radius: 8px; padding: 6px 12px; min-height: 34px; white-space: nowrap; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, opacity 150ms ease, transform var(--dur-press) var(--ease-out); }
.btn.primary { background: var(--ib-text); border-color: var(--ib-text); color: var(--ib-card); }
.btn.link { background: none; border: 0; padding: 0; min-height: 0; color: var(--accent); font-weight: 500; }
.btn.danger { background: var(--st-fail); border-color: var(--st-fail); color: var(--ib-card); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
:is(.btn, .topbar .back, .tabs a, .topbar .theme, .side nav .navbtn, .chip button, .pages-list .pg):active:not(:disabled):not(:focus-visible) { transform: scale(0.97); }
.btn:focus-visible, .row input:focus-visible, .row select:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
/* The library segmented control: a recessed track, the selected option a raised chip. */
fieldset.seg { border: 0; display: inline-flex; flex-wrap: wrap; background: var(--ib-seg); border-radius: 10px; padding: 3px; gap: 2px; }
fieldset.seg legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
fieldset.seg label { position: relative; }
fieldset.seg input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
fieldset.seg span { display: inline-flex; align-items: center; font-size: 12.5px; font-weight: 500; padding: 5px 10px; border-radius: 8px; color: var(--ib-text-2); min-height: 28px; transition: background-color 150ms ease, color 150ms ease; }
fieldset.seg input:checked + span { background: var(--ib-seg-on); color: var(--ib-text); font-weight: 600; box-shadow: var(--ib-shadow); }
fieldset.seg input:focus-visible + span { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.switch input { width: 36px; height: 20px; accent-color: var(--ib-text); cursor: pointer; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; font-weight: 500; color: var(--ib-text); background: var(--ib-pill); border: 1px solid var(--ib-card-border); border-radius: 999px; padding: 2px 2px 2px 10px; }
.chip button { display: inline-grid; place-items: center; width: 22px; height: 22px; font: inherit; background: none; border: 0; color: var(--ib-muted); cursor: pointer; padding: 0; border-radius: 999px; transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out); }
.chip button svg { width: 12px; height: 12px; }
.readonly { font-size: 13px; color: var(--text-secondary); display: flex; gap: 6px; align-items: center; }
.lock { font-size: 12px; color: var(--text-tertiary); }
.lock-glyph { display: inline-flex; color: var(--text-tertiary); }
.lock-glyph svg { width: 14px; height: 14px; }
.status { font-size: 12px; min-height: 18px; color: var(--text-secondary); }
.status.is-ok { color: var(--tint-done-fg); }
.status.is-error { color: var(--tint-fail-fg); }
/* The confirm dialog (the dashboard's, P6/P7): a 16px raised card; it and its scrim fade in — the box
   opacity + scale(.97) on --dur-expand, the scrim on --dur-fade — and leave in 180ms. CSS only: the
   <form method="dialog"> closes it at once (returnValue as before), only the paint lingers. */
dialog { margin: auto; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); color: var(--text); padding: 20px; max-width: 420px; width: calc(100% - 32px); box-shadow: var(--ib-shadow-raised); opacity: 0; transform: scale(0.97); transition: opacity var(--dur-fade) var(--ease-out), transform var(--dur-fade) var(--ease-out), overlay var(--dur-fade) allow-discrete, display var(--dur-fade) allow-discrete; }
dialog[open] { opacity: 1; transform: none; transition-duration: var(--dur-expand); }
@starting-style { dialog[open] { opacity: 0; transform: scale(0.97); } }
dialog::backdrop { background: var(--scrim); opacity: 0; transition: opacity var(--dur-fade) var(--ease-out), overlay var(--dur-fade) allow-discrete, display var(--dur-fade) allow-discrete; }
dialog[open]::backdrop { opacity: 1; }
@starting-style { dialog[open]::backdrop { opacity: 0; } }
dialog h3 { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; margin-bottom: 8px; }
dialog p { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
dialog .actions { display: flex; justify-content: flex-end; gap: 8px; }
/* Hover is a fine-pointer affordance only, and it never moves anything: a neutral border or the pill. */
@media (hover: hover) and (pointer: fine) {
  .topbar .back:hover, .tabs a:hover, .topbar .theme:hover, .side nav .navbtn:hover { background: var(--ib-pill); color: var(--text); }
  .btn:hover:not(:disabled) { border-color: var(--ib-muted); }
  .btn.primary:hover:not(:disabled), .btn.danger:hover:not(:disabled) { opacity: 0.88; }
  .btn.primary:hover:not(:disabled) { border-color: var(--ib-text); }
  .btn.danger:hover:not(:disabled) { border-color: var(--st-fail); }
  .btn.link:hover { text-decoration: underline; }
  fieldset.seg input:not(:checked):hover + span { color: var(--text); }
  .chip button:hover { background: var(--ib-card); color: var(--ib-text); }
}
@media (max-width: 760px) {
  .page { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; }
  .side nav { flex-direction: row; overflow-x: auto; }
  .row { grid-template-columns: minmax(0, 1fr); }
}
/* Phones: brand and account on the first row, 대시보드 and the tabs on their own row under them. */
@media (max-width: 640px) {
  .topbar { padding: 0 12px; row-gap: 0; }
  .topbar-nav { order: 3; flex-basis: 100%; padding-bottom: 8px; margin-left: -4px; }
  .topbar h1, .topbar .account { min-height: 52px; }
  section.group { scroll-margin-top: 112px; }
}
@media (pointer: coarse) {
  /* Touch screens (SSOT 2026-10-24): 16px text, so iOS does not zoom into a focused field.
     Every tab's fields — the memory tab's CSS comes after this sheet, hence !important. */
  .side input[type="search"], .row input[type="text"], .row input[type="number"], .row select { font-size: 16px; }
  input[type="text"], input[type="search"], input[type="number"], select, textarea { font-size: 16px !important; }
  /* 44px targets, as on the dashboard's bar. */
  .topbar .back, .tabs a { min-height: 44px; }
  .topbar .theme { width: 44px; height: 44px; }
  .topbar .sound { width: 44px; height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  :is(.btn, .topbar .back, .tabs a, .topbar .theme, .topbar .sound, .side nav .navbtn, .chip button, .pages-list .pg):active:not(:disabled):not(:focus-visible) { transform: none; }
}
`;

export const SETTINGS_CLIENT_JS = String.raw`
var _csrfToken = '';
var _snapshot = null;
var _rowStatus = Object.create(null); // key -> { text, error }

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) {
  return esc(s).replace(/'/g, '&#39;');
}
function adminModeOn() {
  try { return localStorage.getItem('soma_admin_mode') === 'on'; } catch (_e) { return false; }
}
async function refreshCsrfToken() {
  try {
    var res = await fetch('/auth/me');
    if (res.ok) {
      var data = await res.json();
      _csrfToken = data.csrfToken || '';
      var who = document.getElementById('who');
      if (who && data.user && data.user.name) who.textContent = data.user.name + (data.isAdmin ? ' · 관리자' : '');
    }
  } catch (_e) {}
}
// Every write: CSRF token, admin-mode header, one retry after a token refresh.
async function apiWrite(method, url, payload) {
  var body = payload === undefined ? undefined : JSON.stringify(payload);
  function headers() {
    var h = { 'X-Admin-Mode': adminModeOn() ? 'on' : 'off' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (_csrfToken) h['X-CSRF-Token'] = _csrfToken;
    return h;
  }
  var res = await fetch(url, { method: method, headers: headers(), body: body });
  if (res.status === 403) {
    // Retry once only when the CSRF token went stale (JWT rotation) — not after a real refusal.
    var first = null;
    try { first = await res.clone().json(); } catch (_e) {}
    if (first && /CSRF/i.test(String(first.error || ''))) {
      await refreshCsrfToken();
      res = await fetch(url, { method: method, headers: headers(), body: body });
    } else {
      return { ok: false, status: 403, data: first, error: (first && first.error) || 'HTTP 403' };
    }
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  return { ok: res.ok, status: res.status, data: data, error: (data && data.error) || ('HTTP ' + res.status) };
}

// ── 개인 설정 ──
function valueText(row, value) {
  if (row.kind === 'toggle') return value ? '켬' : '끔';
  if (row.kind === 'list') return Array.isArray(value) && value.length ? value.join(', ') : '없음';
  var opts = row.options || [];
  for (var i = 0; i < opts.length; i++) if (opts[i].value === value) return opts[i].label;
  return value === '' || value == null ? '없음' : String(value);
}
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
// The interface-sound cue a row's control plays through bindSound. A setting that asks first (danger) stays
// silent: its change fires before the confirm dialog, so a cancelled change would still have sounded.
function soundCue(row, cue) {
  return row && row.danger ? 'off' : cue;
}
function renderSegmented(row) {
  var name = 'seg-' + row.key;
  var html = '<fieldset class="seg"><legend>' + esc(row.label) + '</legend>';
  var opts = row.options || [];
  for (var i = 0; i < opts.length; i++) {
    var o = opts[i];
    html += '<label title="' + escAttr(o.description || o.label) + '"><input type="radio" name="' + escAttr(name) + '" value="' + escAttr(o.value) + '"'
      + (o.value === row.value ? ' checked' : '') + ' data-key="' + escAttr(row.key) + '" data-ui-sound="' + soundCue(row, 'select') + '" onchange="onChoice(this)"><span>' + esc(o.label) + '</span></label>';
  }
  return html + '</fieldset>';
}
function renderSelect(row) {
  var html = '<select id="f-' + escAttr(row.key) + '" data-key="' + escAttr(row.key) + '" data-ui-sound="' + soundCue(row, 'select') + '" onchange="onChoice(this)">';
  var opts = row.options || [];
  for (var i = 0; i < opts.length; i++) {
    var o = opts[i];
    html += '<option value="' + escAttr(o.value) + '"' + (o.value === row.value ? ' selected' : '') + '>' + esc(o.label + (o.description && o.description !== o.label ? ' — ' + o.description : '')) + '</option>';
  }
  html += '</select>';
  if (row.allowCustom) {
    html += '<div class="line"><input type="text" id="c-' + escAttr(row.key) + '" data-key="' + escAttr(row.key) + '" placeholder="다른 모델 ID 또는 별칭" aria-label="' + escAttr(row.label + ' 직접 입력') + '"'
      + ' onkeydown="if(event.key===\'Enter\')saveCustom(this.getAttribute(\'data-key\'))">'
      + '<button type="button" class="btn" data-key="' + escAttr(row.key) + '" onclick="saveCustom(this.getAttribute(\'data-key\'))">저장</button></div>';
  }
  return html;
}
function renderControl(row) {
  if (!row.editable) {
    return '<div class="readonly"><span>' + esc(valueText(row, row.value)) + '</span>'
      + (row.lockedReason ? '<span class="lock-glyph" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.25" y="7" width="9.5" height="6.75" rx="1.75"/><path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7"/></svg></span><span class="lock">' + esc(row.lockedReason) + '</span>' : '') + '</div>';
  }
  var k = escAttr(row.key);
  if (row.kind === 'choice') {
    return (row.options || []).length <= 5 && !row.allowCustom ? renderSegmented(row) : renderSelect(row);
  }
  if (row.kind === 'toggle') {
    return '<label class="switch"><input type="checkbox" role="switch" data-ui-sound="' + soundCue(row, 'toggle') + '" id="f-' + k + '" data-key="' + k + '"' + (row.value ? ' checked' : '')
      + ' onchange="onToggle(this)"><span>' + (row.value ? '켜짐' : '꺼짐') + '</span></label>';
  }
  if (row.kind === 'text' || row.kind === 'number') {
    var type = row.kind === 'number' ? 'number' : 'text';
    var bounds = row.kind === 'number' ? ' min="' + row.min + '" max="' + row.max + '" step="1"' : '';
    return '<div class="line"><input type="' + type + '" id="f-' + k + '" data-key="' + k + '" value="' + escAttr(row.value) + '"' + bounds
      + ' onkeydown="if(event.key===\'Enter\')saveTyped(this.getAttribute(\'data-key\'))">'
      + '<button type="button" class="btn primary" data-ui-sound data-key="' + k + '" onclick="saveTyped(this.getAttribute(\'data-key\'))">저장</button>'
      + (row.kind === 'text' && row.value ? '<button type="button" class="btn" data-key="' + k + '" onclick="clearTyped(this.getAttribute(\'data-key\'))">지우기</button>' : '')
      + '</div>';
  }
  if (row.kind === 'list') {
    var chips = '';
    var list = row.value || [];
    for (var i = 0; i < list.length; i++) {
      chips += '<span class="chip">' + esc(list[i]) + '<button type="button" aria-label="' + escAttr(list[i] + ' 빼기') + '" data-key="' + k + '" data-item="' + escAttr(list[i])
        + '" onclick="removeListItem(this)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></span>';
    }
    var opts = '';
    var all = row.options || [];
    for (var j = 0; j < all.length; j++) {
      if (list.indexOf(all[j].value) < 0) opts += '<option value="' + escAttr(all[j].value) + '">' + esc(all[j].label) + '</option>';
    }
    var full = row.maxItems && list.length >= row.maxItems;
    return '<div class="chips">' + (chips || '<span class="lock">없음</span>') + '</div>'
      + '<div class="line"><select id="f-' + k + '" aria-label="' + escAttr(row.label + ' 추가') + '"' + (full ? ' disabled' : '') + '><option value="">스킬 선택…</option>' + opts + '</select>'
      + '<button type="button" class="btn" data-key="' + k + '" onclick="addListItem(this.getAttribute(\'data-key\'))"' + (full ? ' disabled' : '') + '>추가</button></div>';
  }
  return '<div class="readonly">' + esc(valueText(row, row.value)) + '</div>';
}
function renderRow(row) {
  var st = _rowStatus[row.key];
  var reset = row.modified && row.editable && row.defaultValue !== undefined && row.kind !== 'list'
    ? '<button type="button" class="btn link" data-key="' + escAttr(row.key) + '" onclick="resetRow(this.getAttribute(\'data-key\'))">기본값으로</button>' : '';
  var def = row.defaultValue !== undefined && row.kind !== 'readonly' ? '<span>기본값: ' + esc(valueText(row, row.defaultValue)) + '</span>' : '';
  return '<div class="row' + (row.modified ? ' is-modified' : '') + '" id="row-' + escAttr(row.key) + '" data-key="' + escAttr(row.key) + '"'
    + ' data-search="' + escAttr((row.label + ' ' + row.description + ' ' + row.slackCommand + ' ' + row.key).toLowerCase()) + '" data-modified="' + (row.modified ? '1' : '0') + '">'
    + '<div class="meta"><div class="label">' + esc(row.label) + (row.adminOnly ? ' <span class="lock">(관리자)</span>' : '') + '</div>'
    + '<p>' + esc(row.description) + '</p>'
    + '<div class="hint"><span>Slack: <code>' + esc(row.slackCommand) + '</code></span>' + def + reset + '</div></div>'
    + '<div class="control">' + renderControl(row)
    + '<div class="status' + (st ? (st.error ? ' is-error' : ' is-ok') : '') + '" id="st-' + escAttr(row.key) + '"' + (st && st.error ? ' role="alert"' : ' role="status" aria-live="polite"') + '>' + (st ? esc(st.text) : '') + '</div>'
    + '</div></div>';
}
function renderPreferences(snapshot) {
  var groups = snapshot.groups || [];
  var rows = snapshot.settings || [];
  var nav = '';
  var body = '';
  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    var inGroup = rows.filter(function (r) { return r.group === grp.id; });
    if (!inGroup.length) continue;
    nav += '<button type="button" class="navbtn" data-target="g-' + escAttr(grp.id) + '" onclick="jumpTo(this.getAttribute(\'data-target\'))">' + esc(grp.label) + '</button>';
    body += '<section class="group' + (grp.id === 'permissions' ? ' danger' : '') + '" id="g-' + escAttr(grp.id) + '" aria-labelledby="h-' + escAttr(grp.id) + '">'
      + '<header><h2 id="h-' + escAttr(grp.id) + '">' + esc(grp.label) + '</h2><p>' + esc(grp.description) + '</p></header>'
      + inGroup.map(renderRow).join('') + '</section>';
  }
  return { nav: nav, body: body };
}
// Section links scroll; they never touch location.hash (that selects tabs).
function jumpTo(id) {
  var el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function findRow(key) {
  var rows = (_snapshot && _snapshot.settings) || [];
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return rows[i];
  return null;
}
function paintPreferences() {
  if (!_snapshot) return;
  var out = renderPreferences(_snapshot);
  document.getElementById('pref-nav').innerHTML = out.nav;
  document.getElementById('pref-body').innerHTML = out.body;
  applyFilter();
}
function repaintRow(key) {
  var row = findRow(key);
  var el = document.getElementById('row-' + key);
  if (!row || !el) return;
  var tmp = document.createElement('div');
  tmp.innerHTML = renderRow(row);
  el.replaceWith(tmp.firstChild);
  applyFilter();
}
async function loadPreferences() {
  var body = document.getElementById('pref-body');
  try {
    var res = await fetch('/api/settings');
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) {
      body.innerHTML = '<div class="notice is-error" role="alert">' + esc((data && data.error) || ('설정을 불러오지 못했습니다 (HTTP ' + res.status + ')')) + '</div>';
      return;
    }
    _snapshot = lockIfNotAccepted(data);
    paintPreferences();
  } catch (e) {
    body.innerHTML = '<div class="notice is-error" role="alert">설정을 불러오지 못했습니다. 다시 시도하세요.</div>';
  }
}
// Without admin acceptance the server refuses every write: show the rows read-only, with why.
function lockIfNotAccepted(data) {
  if (!data || data.accepted !== false) return data;
  var rows = data.settings || [];
  for (var i = 0; i < rows.length; i++) {
    rows[i].editable = false;
    rows[i].lockedReason = '관리자 승인 전에는 바꿀 수 없습니다.';
  }
  return data;
}
// Danger rows confirm before saving a riskier value (bypass, sandbox off, network off).
function needsConfirm(row, value) {
  if (!row || !row.danger) return null;
  if (row.key === 'permissionMode' && value === 'bypass') return { title: '확인 없이 실행으로 바꿀까요?', body: '에이전트가 파일 삭제·배포 명령도 묻지 않고 실행합니다.', action: '확인 없이 실행 켜기' };
  if (row.key === 'sandbox' && value === false) return { title: '샌드박스를 끌까요?', body: 'Bash 명령이 격리 없이 실행됩니다. 다음 메시지부터 적용됩니다.', action: '샌드박스 끄기' };
  if (row.key === 'sandboxNetwork' && value === false) return { title: '네트워크 허용 목록을 끌까요?', body: '샌드박스 안에서 모든 도메인으로 나갈 수 있습니다.', action: '허용 목록 끄기' };
  return null;
}
function confirmDialog(c) {
  return new Promise(function (resolve) {
    var dlg = document.getElementById('confirm');
    document.getElementById('confirm-title').textContent = c.title;
    document.getElementById('confirm-body').textContent = c.body;
    var ok = document.getElementById('confirm-ok');
    ok.textContent = c.action;
    dlg.onclose = function () { resolve(dlg.returnValue === 'ok'); };
    dlg.showModal();
    document.getElementById('confirm-cancel').focus();
  });
}
async function saveSetting(key, value) {
  var row = findRow(key);
  var c = needsConfirm(row, value);
  if (c && !(await confirmDialog(c))) { repaintRow(key); return false; }
  _rowStatus[key] = { text: '저장 중…', error: false };
  var stEl = document.getElementById('st-' + key);
  if (stEl) { stEl.textContent = '저장 중…'; stEl.className = 'status'; }
  var r;
  try { r = await apiWrite('PATCH', '/api/settings/' + encodeURIComponent(key), { value: value }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  if (!r.ok) {
    _rowStatus[key] = { text: '저장하지 못했습니다: ' + r.error, error: true };
    repaintRow(key);
    return false;
  }
  var rows = _snapshot.settings;
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) rows[i] = r.data.setting;
  _rowStatus[key] = { text: '저장됨 — ' + valueText(r.data.setting, r.data.setting.value), error: false };
  repaintRow(key);
  return true;
}
function onChoice(el) {
  return saveSetting(el.getAttribute('data-key'), el.value);
}
function onToggle(el) {
  return saveSetting(el.getAttribute('data-key'), !!el.checked);
}
function saveTyped(key) {
  var row = findRow(key);
  var el = document.getElementById('f-' + key);
  if (!row || !el) return;
  var v = row.kind === 'number' ? Number(el.value) : el.value;
  return saveSetting(key, v);
}
function clearTyped(key) {
  return saveSetting(key, '');
}
function saveCustom(key) {
  var el = document.getElementById('c-' + key);
  if (!el || !el.value.trim()) return;
  return saveSetting(key, el.value.trim());
}
function resetRow(key) {
  var row = findRow(key);
  if (!row) return;
  return saveSetting(key, row.defaultValue);
}
function addListItem(key) {
  var row = findRow(key);
  var el = document.getElementById('f-' + key);
  if (!row || !el || !el.value) return;
  return saveSetting(key, (row.value || []).concat([el.value]));
}
function removeListItem(btn) {
  var key = btn.getAttribute('data-key');
  var item = btn.getAttribute('data-item');
  var row = findRow(key);
  if (!row) return;
  return saveSetting(key, (row.value || []).filter(function (x) { return x !== item; }));
}
function applyFilter() {
  var q = ((document.getElementById('pref-filter') || {}).value || '').toLowerCase().trim();
  var onlyMod = !!(document.getElementById('pref-modified') || {}).checked;
  // Only the 개인 설정 tab: other tabs have sections without setting rows (review P1).
  var rows = document.querySelectorAll('[data-tab="preferences"] .row[data-key]');
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var hit = (!q || r.getAttribute('data-search').indexOf(q) >= 0) && (!onlyMod || r.getAttribute('data-modified') === '1');
    r.hidden = !hit;
  }
  var groups = document.querySelectorAll('[data-tab="preferences"] section.group');
  for (var g = 0; g < groups.length; g++) groups[g].hidden = !groups[g].querySelector('.row:not([hidden])');
}

// ── Tabs + theme ──
function showTab(id) {
  var tabs = document.querySelectorAll('[data-tab]');
  var found = false;
  for (var i = 0; i < tabs.length; i++) if (tabs[i].getAttribute('data-tab') === id) found = true;
  if (!found) id = 'preferences';
  for (var j = 0; j < tabs.length; j++) {
    var on = tabs[j].getAttribute('data-tab') === id;
    tabs[j].hidden = !on;
  }
  var links = document.querySelectorAll('.tabs a');
  for (var k = 0; k < links.length; k++) {
    if (links[k].getAttribute('href') === '#' + id) links[k].setAttribute('aria-current', 'page');
    else links[k].removeAttribute('aria-current');
  }
  if (typeof onTabShown === 'function') onTabShown(id);
}
function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  var next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('soma-theme', next); } catch (_e) {}
}
window.addEventListener('hashchange', function () { showTab(location.hash.slice(1)); });
// Settings changed in Slack show up when the tab comes back — rows being edited stay as typed.
document.addEventListener('visibilitychange', function () {
  if (document.hidden || !_snapshot) return;
  var a = document.activeElement;
  if (a && a.closest && a.closest('.row')) return;
  loadPreferences();
});
refreshCsrfToken();
showTab(location.hash.slice(1) || 'preferences');
loadPreferences();
`;

/** Markup of the 개인 설정 tab. */
function preferencesTab(): string {
  return `<div data-tab="preferences" class="page">
  <aside class="side" aria-label="개인 설정 섹션">
    <input type="search" id="pref-filter" placeholder="설정 검색 (이름 · 설명 · Slack 명령)" aria-label="설정 검색" oninput="applyFilter()">
    <label class="only-modified"><input type="checkbox" id="pref-modified" onchange="applyFilter()"> 기본값과 다른 것만</label>
    <nav id="pref-nav"></nav>
  </aside>
  <main>
    <p class="intro">Slack 명령으로 바꿀 수 있는 개인 설정을 여기서 모두 보고 바꿉니다. 선택하는 항목은 바로 저장되고, 직접 입력하는 항목은 저장을 눌러야 저장됩니다. 각 항목 아래에 같은 일을 하는 Slack 명령이 있습니다.</p>
    <div id="pref-body"><div class="notice">불러오는 중…</div></div>
  </main>
</div>`;
}

// Tab hooks: a tab loads its data the first time it is shown.
const TAB_HOOKS_JS = String.raw`
function onTabShown(id) {
  if (id === 'memory' && !_memLoaded) loadMemory();
}
`;

export function renderSettingsPage(tabs: SettingsPageTab[] = SETTINGS_TABS): string {
  const tabLinks = tabs.map((t) => `<a href="#${t.id}">${t.label}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>soma-work 설정</title>
<script data-fouc>
(function(){var t=localStorage.getItem('soma-theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();
</script>
<script data-sound>${soundClientJs(UI_LIB_VERSION)}</script>
<style>${SETTINGS_PAGE_CSS}${MEMORY_TAB_CSS}</style>
<!-- Tokens — @2lab.ai/ui is the single source, as on the dashboard (P10, P9): its tokens.css puts every
     --ui-* on :root and [data-theme="light|dark"], and the page's names are aliases of them. -->
<style id="ui-tokens">
${uiLibTokensCss()}
${pageTokenAliases()}
</style>
</head>
<body>
<div class="topbar">
  <h1><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect class="bm-bg" width="32" height="32" rx="8"/><rect class="bm-cell" x="7" y="7" width="7" height="7" rx="1.5"/><rect class="bm-cell" x="18" y="7" width="7" height="7" rx="1.5" opacity=".55"/><rect class="bm-cell" x="7" y="18" width="7" height="7" rx="1.5" opacity=".55"/><rect class="bm-cell" x="18" y="18" width="7" height="7" rx="1.5" opacity=".25"/></svg>soma-work</h1>
  <div class="topbar-nav">
    <a class="back" href="/dashboard"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8H3M7.25 3.75L3 8l4.25 4.25"/></svg>대시보드</a>
    <nav class="tabs" aria-label="설정 영역">${tabLinks}</nav>
  </div>
  <div class="account">
    <span class="who"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 13.75a5.25 5.25 0 0 1 10.5 0"/></svg><span id="who"></span></span>
    ${soundToggleHtml()}
    <button type="button" class="theme" onclick="toggleTheme()" aria-label="테마 바꾸기"><svg class="ic-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.75"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.05 1.05M11.55 11.55l1.05 1.05M3.4 12.6l1.05-1.05M11.55 4.45l1.05-1.05"/></svg><svg class="ic-moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/></svg></button>
  </div>
</div>
${preferencesTab()}
${MEMORY_TAB_HTML}
<dialog id="confirm" aria-labelledby="confirm-title">
  <form method="dialog">
    <h3 id="confirm-title"></h3>
    <p id="confirm-body"></p>
    <div class="actions">
      <button type="submit" class="btn" id="confirm-cancel" value="cancel">취소</button>
      <button type="submit" class="btn danger" id="confirm-ok" value="ok"></button>
    </div>
  </form>
</dialog>
<script>${MEMORY_CLIENT_JS}${TAB_HOOKS_JS}${SETTINGS_CLIENT_JS}</script>
<script type="module" src="/dashboard/ui/memory-panel.js?v=${UI_LIB_VERSION}"></script>
</body>
</html>`;
}
