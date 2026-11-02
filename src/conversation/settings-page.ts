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

import { DICTATION_BROWSER_JS } from './dictation-browser-client';
import { DICTATION_PREF_JS } from './dictation-pref';
import { DICTATION_SERVER_JS } from './dictation-server-client';
import { DICTATION_CLIENT_JS, DICTATION_TAB_CSS, DICTATION_TAB_HTML } from './settings-dictation-tab';
import { LAYOUT_CLIENT_JS, LAYOUT_TAB_CSS, LAYOUT_TAB_HTML } from './settings-layout-tab';
import { MEMORY_CLIENT_JS, MEMORY_TAB_CSS, MEMORY_TAB_HTML } from './settings-memory-tab';
import { soundClientJs } from './sound-client';
import { pageTokenAliases, UI_LIB_VERSION, uiLibKitCss, uiLibTokensCss } from './ui-lib';
import { VIEW_LAYOUT_CLIENT_JS } from './view-layout-client';

export interface SettingsPageTab {
  id: string;
  label: string;
  /** A glyph of @2lab.ai/ui's icon set before the label. */
  icon?: string;
}

/** Tabs that exist on this build. Later areas append here. */
export const SETTINGS_TABS: SettingsPageTab[] = [
  { id: 'preferences', label: '개인 설정', icon: 'gear' },
  { id: 'memory', label: '기억', icon: 'brain' },
  // 대시보드 화면 (SSOT 2026-11-02, .prd/21): the surface editor — card, open card, detail card, thread card.
  { id: 'layout', label: '대시보드 화면', icon: 'board' },
  // 받아쓰기 (SSOT 2026-11-02, epic #737): this device's engine — kept in this browser only — and its recogniser's details.
  { id: 'dictation', label: '받아쓰기', icon: 'mic' },
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
/* Korean breaks between words (D8): the page's h1 and every block — the kit gives it to its own classes only. */
html:lang(ko) body { word-break: keep-all; overflow-wrap: anywhere; }
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
/* ── App bar and tabs (M-01) — @2lab.ai/ui <ui-app-bar id="app-bar">, as on the dashboard: brand, the page
   links (folded into 메뉴 when the bar is short of room), the signed-in account, the speaker (interface sound,
   its ui-sound-change answered by the head's sound script) and the theme toggle are its data (paintAppBar);
   translucent over the page, one hairline, opaque under reduced transparency — all the
   element's own. Under it the tab list 개인 설정 · 기억 is <ui-tabs id="settings-tabs"> over the two tab pages
   (each a slotted panel); the location hash still picks the tab, so /dashboard/settings#memory opens 기억. ── */
.topbar { position: sticky; top: 0; z-index: 20; min-width: 0; }
/* Until the elements are defined: the bar's height and none of the raw content. */
ui-app-bar:not(:defined) { display: block; height: var(--topbar-h); }
ui-tabs:not(:defined) { display: block; }
/* The tab list lines up with the page column under it. */
/* (width: the tabs' column is a flex box, where auto margins alone would shrink the list to its tabs) */
.settings-tabs::part(list) { box-sizing: border-box; width: 100%; max-width: 1080px; margin: 0 auto; padding: 8px 20px 0; }
.page { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
/* An author display beats the UA [hidden] rule — tabs are switched with the hidden attribute. */
.page[hidden] { display: none; }
.side { position: sticky; top: calc(var(--topbar-h) + 16px); align-self: start; display: flex; flex-direction: column; gap: 12px; }
.side nav { display: flex; flex-direction: column; gap: 2px; }
.side nav a { font-size: 13px; text-decoration: none; color: var(--text-secondary); padding: 6px 10px; border-radius: 8px; }
.side nav .navbtn { font: inherit; font-size: 13px; text-align: left; color: var(--text-secondary); background: none; border: 0; padding: 6px 10px; border-radius: 8px; cursor: pointer; transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out); }
.side nav .navbtn:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.side nav a:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.intro { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
.notice { font-size: 13px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.notice.is-error { border-color: var(--tint-fail-line); background: var(--tint-fail-soft); color: var(--tint-fail-fg); }
/* 개인 설정 groups are kit cards (.ui-card, .is-danger for 권한) of <ui-setting-row>s (M-02): the row owns its
   label, hints, Modified dot, save state and lock; the page only places the control in the row's slot. A section
   link lands below the sticky bar. The 기억 tab's sections keep the same card look as section.group. */
#pref-body > .ui-card { margin-bottom: 20px; scroll-margin-top: calc(var(--topbar-h) + 16px); }
#pref-body > .ui-card[hidden] { display: none; }
#pref-body .ui-notice { margin-bottom: 16px; }
ui-setting-row[hidden] { display: none; }
ui-setting-row .line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
ui-setting-row .line .ui-input[type="text"] { flex: 1 1 220px; }
ui-setting-row .ui-input[type="number"] { width: 110px; }
ui-setting-row > select.ui-input { max-width: 100%; }
/* The row's slot is a wrapping flex row: a field line and the chip list take a whole line of it. */
ui-setting-row > :is(.line, .chips) { flex: 1 1 100%; }
.side ui-settings-nav [slot="notice"][hidden] { display: none; }
section.group { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--ib-shadow); margin-bottom: 20px; scroll-margin-top: calc(var(--topbar-h) + 16px); }
section.group.danger { border-color: var(--tint-fail-line); background: var(--tint-fail-soft); }
section.group > header { padding: 14px 16px 10px; border-bottom: 1px solid var(--border); }
section.group > header h2 { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
section.group > header p { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
/* Buttons are the library kit's (.ui-btn): a hairline card button, the ink primary — the one decision of
   its row or dialog — and the destructive confirm in the fail tone. One press rule: scale(.97). */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 13px; font-weight: 500; line-height: 1.2; color: var(--ib-text); background: var(--ib-card); border: 1px solid var(--ib-card-border); border-radius: 8px; padding: 6px 12px; min-height: 34px; white-space: nowrap; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, opacity 150ms ease, transform var(--dur-press) var(--ease-out); }
.btn.primary { background: var(--ib-text); border-color: var(--ib-text); color: var(--ib-card); }
.btn.link { background: none; border: 0; padding: 0; min-height: 0; color: var(--accent); font-weight: 500; }
.btn.danger { background: var(--st-fail); border-color: var(--st-fail); color: var(--ib-card); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
:is(.btn, .side nav .navbtn, .chip button):active:not(:disabled):not(:focus-visible) { transform: scale(0.97); }
.btn:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
/* The library segmented control: a recessed track, the selected option a raised chip. */
fieldset.seg { border: 0; display: inline-flex; flex-wrap: wrap; background: var(--ib-seg); border-radius: 10px; padding: 3px; gap: 2px; }
fieldset.seg legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
fieldset.seg label { position: relative; }
fieldset.seg input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
fieldset.seg span { display: inline-flex; align-items: center; font-size: 12.5px; font-weight: 500; padding: 5px 10px; border-radius: 8px; color: var(--ib-text-2); min-height: 28px; transition: background-color 150ms ease, color 150ms ease; }
fieldset.seg input:checked + span { background: var(--ib-seg-on); color: var(--ib-text); font-weight: 600; box-shadow: var(--ib-shadow); }
fieldset.seg input:focus-visible + span { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; font-weight: 500; color: var(--ib-text); background: var(--ib-pill); border: 1px solid var(--ib-card-border); border-radius: 999px; padding: 2px 2px 2px 10px; }
.chip button { display: inline-grid; place-items: center; width: 22px; height: 22px; font: inherit; background: none; border: 0; color: var(--ib-muted); cursor: pointer; padding: 0; border-radius: 999px; transition: background-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out); }
.chip button svg { width: 12px; height: 12px; }
.readonly { font-size: 13px; color: var(--text-secondary); }
.lock { font-size: 12px; color: var(--text-tertiary); }
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
  .side nav .navbtn:hover { background: var(--ib-pill); color: var(--text); }
  .btn:hover:not(:disabled) { border-color: var(--ib-muted); }
  .btn.primary:hover:not(:disabled), .btn.danger:hover:not(:disabled) { opacity: 0.88; }
  .btn.primary:hover:not(:disabled) { border-color: var(--ib-text); }
  .btn.danger:hover:not(:disabled) { border-color: var(--st-fail); }
  .btn.link:hover { text-decoration: underline; }
  fieldset.seg input:not(:checked):hover + span { color: var(--text); }
  .chip button:hover { background: var(--ib-card); color: var(--ib-text); }
}
/* Below 840px <ui-settings-nav> is a filter row over a row of chips (its layout="auto"): one column. */
@media (max-width: 839px) {
  .page { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; }
  .side nav { flex-direction: row; overflow-x: auto; }
}
/* Phones: the bar is one 52px row (its links fold into 메뉴); the tab list keeps the page's narrower gutter. */
@media (max-width: 640px) {
  .settings-tabs::part(list) { padding: 4px 12px 0; }
}
@media (pointer: coarse) {
  /* Touch screens (SSOT 2026-10-24): 16px text, so iOS does not zoom into a focused field.
     Every tab's fields — the memory tab's CSS comes after this sheet, hence !important. */
  .ui-input { font-size: 16px; }
  input[type="text"], input[type="search"], input[type="number"], select, textarea { font-size: 16px !important; }
  /* 44px targets, as on the dashboard's bar (the bar's own controls size themselves). */
  .settings-tabs::part(tab) { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  :is(.btn, .side nav .navbtn, .chip button):active:not(:disabled):not(:focus-visible) { transform: none; }
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
      if (data.user && data.user.name) {
        _appBarAccount = { name: data.user.name, href: '/login' };
        if (data.isAdmin) _appBarAccount.role = '관리자';
        paintAppBar();
      }
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
  var html = '<select class="ui-input" id="f-' + escAttr(row.key) + '" data-key="' + escAttr(row.key) + '" data-ui-sound="' + soundCue(row, 'select') + '" onchange="onChoice(this)">';
  var opts = row.options || [];
  for (var i = 0; i < opts.length; i++) {
    var o = opts[i];
    html += '<option value="' + escAttr(o.value) + '"' + (o.value === row.value ? ' selected' : '') + '>' + esc(o.label + (o.description && o.description !== o.label ? ' — ' + o.description : '')) + '</option>';
  }
  html += '</select>';
  if (row.allowCustom) {
    html += '<div class="line"><input type="text" class="ui-input" id="c-' + escAttr(row.key) + '" data-key="' + escAttr(row.key) + '" placeholder="다른 모델 ID 또는 별칭" aria-label="' + escAttr(row.label + ' 직접 입력') + '"'
      + ' onkeydown="if(event.key===\'Enter\')saveCustom(this.getAttribute(\'data-key\'))">'
      + '<button type="button" class="btn" data-key="' + escAttr(row.key) + '" onclick="saveCustom(this.getAttribute(\'data-key\'))">저장</button></div>';
  }
  return html;
}
function renderControl(row) {
  // A locked row has no control: <ui-setting-row> shows its value with the lock glyph and the reason (rowData).
  if (!row.editable) return '';
  var k = escAttr(row.key);
  if (row.kind === 'choice') {
    return (row.options || []).length <= 5 && !row.allowCustom ? renderSegmented(row) : renderSelect(row);
  }
  if (row.kind === 'toggle') {
    // The state word is aria-hidden: the row names the switch, role="switch" reads on / off.
    return '<label class="ui-switch"><input type="checkbox" role="switch" data-ui-sound="' + soundCue(row, 'toggle') + '" id="f-' + k + '" data-key="' + k + '"' + (row.value ? ' checked' : '')
      + ' onchange="onToggle(this)"><span aria-hidden="true">' + (row.value ? '켜짐' : '꺼짐') + '</span></label>';
  }
  if (row.kind === 'text' || row.kind === 'number') {
    var type = row.kind === 'number' ? 'number' : 'text';
    var bounds = row.kind === 'number' ? ' min="' + row.min + '" max="' + row.max + '" step="1"' : '';
    return '<div class="line"><input type="' + type + '" class="ui-input" id="f-' + k + '" data-key="' + k + '" value="' + escAttr(row.value) + '"' + bounds
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
      + '<div class="line"><select class="ui-input" id="f-' + k + '" aria-label="' + escAttr(row.label + ' 추가') + '"' + (full ? ' disabled' : '') + '><option value="">스킬 선택…</option>' + opts + '</select>'
      + '<button type="button" class="btn" data-key="' + k + '" onclick="addListItem(this.getAttribute(\'data-key\'))"' + (full ? ' disabled' : '') + '>추가</button></div>';
  }
  return '<div class="readonly">' + esc(valueText(row, row.value)) + '</div>';
}
// One <ui-setting-row> per preference (M-02): the row draws the label, description, the Slack command,
// the default, Modified with its reset, the save state, and a locked row's value with the reason (rowData);
// the control is page markup in its slot (renderControl). The data is a property: set after insertion.
function renderRow(row) {
  return '<ui-setting-row lang="ko" id="row-' + escAttr(row.key) + '" data-key="' + escAttr(row.key) + '">' + renderControl(row) + '</ui-setting-row>';
}
function rowData(row) {
  var st = _rowStatus[row.key];
  var d = {
    key: row.key,
    label: row.label,
    description: row.description || '',
    hints: row.slackCommand ? [{ label: 'Slack:', code: row.slackCommand }] : [],
    modified: !!row.modified,
    canReset: !!(row.modified && row.editable && row.defaultValue !== undefined && row.kind !== 'list'),
    status: st ? { state: st.state, text: st.text } : null,
    locked: row.editable ? null : { reason: row.lockedReason || '', value: valueText(row, row.value) },
  };
  if (row.defaultValue !== undefined && row.kind !== 'readonly') d.defaultText = valueText(row, row.defaultValue);
  if (row.adminOnly) d.badge = '관리자';
  return d;
}
function paintRowData(key) {
  var row = findRow(key);
  var el = document.getElementById('row-' + key);
  if (row && el) el.data = rowData(row);
}
// One kit card per settings group; the nav lists the groups that have rows.
function renderPreferences(snapshot) {
  var groups = snapshot.groups || [];
  var rows = snapshot.settings || [];
  var sections = [];
  var body = '';
  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    var inGroup = rows.filter(function (r) { return r.group === grp.id; });
    if (!inGroup.length) continue;
    sections.push({ id: 'g-' + grp.id, label: grp.label, keys: inGroup.map(function (r) { return r.key; }) });
    body += '<section class="ui-card group' + (grp.id === 'permissions' ? ' is-danger' : '') + '" id="g-' + escAttr(grp.id) + '" aria-labelledby="h-' + escAttr(grp.id) + '">'
      + '<header><h2 id="h-' + escAttr(grp.id) + '">' + esc(grp.label) + '</h2><p>' + esc(grp.description) + '</p></header>'
      + inGroup.map(renderRow).join('') + '</section>';
  }
  return { sections: sections, body: body };
}
function findRow(key) {
  var rows = (_snapshot && _snapshot.settings) || [];
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return rows[i];
  return null;
}
var _prefSections = []; // [{ id, label, keys }] of the groups on screen
function paintPreferences() {
  if (!_snapshot) return;
  var out = renderPreferences(_snapshot);
  _prefSections = out.sections;
  document.getElementById('pref-body').innerHTML = out.body;
  var rows = _snapshot.settings || [];
  for (var i = 0; i < rows.length; i++) paintRowData(rows[i].key);
  paintPrefNotice();
  applyFilter();
}
// A saved row keeps its element (and the row's save message): the control is re-rendered in its slot.
function repaintRow(key) {
  var row = findRow(key);
  var el = document.getElementById('row-' + key);
  if (!row || !el) return;
  el.innerHTML = renderControl(row);
  el.data = rowData(row);
  applyFilter();
}
// Page-wide notices sit in the nav's notice slot (M-03): rows locked until an admin accepts.
function paintPrefNotice() {
  var box = document.getElementById('pref-notice');
  if (!box) return;
  var locked = !!(_snapshot && _snapshot.accepted === false);
  box.hidden = !locked;
  box.textContent = locked ? '관리자 승인 전에는 바꿀 수 없습니다. 지금은 값만 볼 수 있습니다.' : '';
}
async function loadPreferences() {
  var body = document.getElementById('pref-body');
  try {
    var res = await fetch('/api/settings');
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) {
      body.innerHTML = '<div class="ui-notice" data-tone="fail" role="alert">' + esc((data && data.error) || ('설정을 불러오지 못했습니다 (HTTP ' + res.status + ')')) + '</div>';
      return;
    }
    _snapshot = lockIfNotAccepted(data);
    paintPreferences();
  } catch (e) {
    body.innerHTML = '<div class="ui-notice" data-tone="fail" role="alert">설정을 불러오지 못했습니다. 다시 시도하세요.</div>';
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
  _rowStatus[key] = { state: 'pending', text: '저장 중…' };
  paintRowData(key);
  var r;
  try { r = await apiWrite('PATCH', '/api/settings/' + encodeURIComponent(key), { value: value }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  if (!r.ok) {
    _rowStatus[key] = { state: 'error', text: '저장하지 못했습니다: ' + r.error };
    repaintRow(key);
    return false;
  }
  var rows = _snapshot.settings;
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) rows[i] = r.data.setting;
  // The dashboard's device copy of its view (dashboard.ts VIEW_MODE_KEY · VIEW_PLAN_KEY): its first paint after a
  // full reload, before its own settings load answers.
  var copy = { dashboardMode: 'soma-view-mode', dashboardPlan: 'soma-view-plan' }[key];
  if (copy) { try { localStorage.setItem(copy, String(r.data.setting.value)); } catch (_e) {} }
  _rowStatus[key] = { state: 'saved', text: '저장됨 — ' + valueText(r.data.setting, r.data.setting.value) };
  repaintRow(key);
  // The default effort follows the default model (its value and the levels it offers): read that row back.
  if (key === 'defaultModel') await refreshRow('defaultEffort');
  return true;
}
// One row read back from the server after another row's save changed it.
async function refreshRow(key) {
  try {
    var res = await fetch('/api/settings');
    if (!res.ok) return;
    var data = await res.json();
    var fresh = ((data && data.settings) || []).find(function(x) { return x.key === key; });
    var rows = _snapshot.settings;
    for (var i = 0; fresh && i < rows.length; i++) if (rows[i].key === key) rows[i] = fresh;
    if (fresh) repaintRow(key);
  } catch (_e) {}
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
// ── Side nav + filter (M-03) — @2lab.ai/ui <ui-settings-nav id="pref-nav"> ──
// The nav draws the section links (following the scroll), the search box, 바꾼 것만 and the notice slot; its
// ui-filter is applied with the library's applySettingsFilter (label, description, Slack command, key) — loaded
// by the page's module script as window.applySettingsFilter — and the nav gets the counts back. Only the
// 개인 설정 rows: the helper runs on #pref-body (other tabs have no setting rows, review P1).
var _prefFilter = { query: '', modifiedOnly: false };
function applyFilter() {
  var body = document.getElementById('pref-body');
  var result = body && typeof applySettingsFilter === 'function' ? applySettingsFilter(body, _prefFilter) : null;
  paintNav(result);
}
function paintNav(result) {
  var nav = document.getElementById('pref-nav');
  if (!nav) return;
  var filtering = !!String(_prefFilter.query || '').trim() || !!_prefFilter.modifiedOnly;
  var sections = [];
  for (var i = 0; i < _prefSections.length; i++) {
    var s = _prefSections[i];
    var modified = 0;
    for (var k = 0; k < s.keys.length; k++) { var row = findRow(s.keys[k]); if (row && row.modified) modified++; }
    var item = { id: s.id, label: s.label, modified: modified };
    if (filtering && result) item.count = result.sections[s.id] || 0;
    sections.push(item);
  }
  nav.data = {
    sections: sections,
    query: _prefFilter.query,
    modifiedOnly: _prefFilter.modifiedOnly,
    empty: !!(filtering && result && result.shown === 0),
    label: '개인 설정 섹션',
    placeholder: '설정 검색 (이름 · 설명 · Slack 명령)',
  };
}
function initPreferences() {
  var nav = document.getElementById('pref-nav');
  if (nav) nav.addEventListener('ui-filter', function (e) {
    var d = e.detail || {};
    _prefFilter = { query: String(d.query || ''), modifiedOnly: !!d.modifiedOnly };
    applyFilter();
  });
  var body = document.getElementById('pref-body');
  if (body) body.addEventListener('ui-reset', function (e) {
    var key = e.detail && e.detail.key;
    if (key) resetRow(key);
  });
}

// ── App bar (M-01) — @2lab.ai/ui <ui-app-bar id="app-bar"> ──
// The page hands the bar its data — brand, the page links, the signed-in account, the current theme and the
// sound choice — and answers ui-theme-change (the page owns the theme and its storage). The speaker is the
// bar's own: its ui-sound-change is answered by the head's sound script (somaSoundBindBar, bound to #app-bar
// at DOMContentLoaded), which keeps the choice and re-hands the bar its state. Links are real links:
// ui-navigate is not cancelled.
var APP_BAR_NAV = [
  { id: 'dashboard', label: '대시보드', href: '/dashboard', icon: 'board' },
  { id: 'conversations', label: '대화', href: '/conversations', icon: 'chat' },
  { id: 'settings', label: '설정', href: '/dashboard/settings', icon: 'gear', current: true },
];
var _appBarAccount = null; // { name, href, role? } once /auth/me answers
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function paintAppBar() {
  var bar = document.getElementById('app-bar');
  if (!bar) return;
  var data = {
    brand: { label: 'soma-work', mark: true, href: '/dashboard' },
    nav: APP_BAR_NAV,
    navLabel: '주 메뉴',
    theme: currentTheme(),
    // The speaker before the theme toggle (interface sound, #614): the head script's choice (_somaOn).
    sound: typeof _somaOn !== 'undefined' && !!_somaOn,
  };
  if (_appBarAccount) data.account = _appBarAccount;
  bar.data = data;
}
function setTheme(next) {
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('soma-theme', next); } catch (_e) {}
  paintAppBar();
}
function toggleTheme() {
  setTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

// ── Tabs — @2lab.ai/ui <ui-tabs id="settings-tabs"> over the tab pages (each a slotted [data-tab] panel) ──
// The hash picks the tab (links such as /dashboard/settings#memory); choosing a tab writes the hash. Until the
// element is defined, the hidden attribute keeps the other tab page out of sight.
function settingsTabs() {
  var el = document.getElementById('settings-tabs-data');
  try { return (el && JSON.parse(el.textContent || '[]')) || []; } catch (_e) { return []; }
}
function showTab(id) {
  var tabs = document.querySelectorAll('[data-tab]');
  var found = false;
  for (var i = 0; i < tabs.length; i++) if (tabs[i].getAttribute('data-tab') === id) found = true;
  if (!found) id = 'preferences';
  for (var j = 0; j < tabs.length; j++) {
    var on = tabs[j].getAttribute('data-tab') === id;
    tabs[j].hidden = !on;
  }
  var el = document.getElementById('settings-tabs');
  if (el) el.data = { tabs: settingsTabs(), value: id, label: '설정 영역' };
  var changed = showTab.current !== id;
  showTab.current = id;
  if (changed && typeof onTabShown === 'function') onTabShown(id);
}
function initShell() {
  var tabsEl = document.getElementById('settings-tabs');
  if (tabsEl) tabsEl.addEventListener('ui-change', function (e) {
    var v = e.detail && e.detail.value;
    if (!v) return;
    showTab(v);
    if (location.hash.slice(1) !== v) location.hash = v;
  });
  var bar = document.getElementById('app-bar');
  if (bar) bar.addEventListener('ui-theme-change', function (e) {
    var t = e.detail && e.detail.theme;
    if (t === 'light' || t === 'dark') setTheme(t);
  });
  paintAppBar();
}
window.addEventListener('hashchange', function () { showTab(location.hash.slice(1)); });
initShell();
// Settings changed in Slack show up when the tab comes back — rows being edited stay as typed.
document.addEventListener('visibilitychange', function () {
  if (document.hidden || !_snapshot) return;
  var a = document.activeElement;
  if (a && a.closest && a.closest('ui-setting-row')) return;
  loadPreferences();
});
refreshCsrfToken();
initPreferences();
showTab(location.hash.slice(1) || 'preferences');
loadPreferences();
`;

/** Markup of the 개인 설정 tab. */
function preferencesTab(): string {
  return `<div slot="preferences" data-tab="preferences" class="page">
  <aside class="side">
    <ui-settings-nav id="pref-nav" lang="ko"><div slot="notice" id="pref-notice" class="ui-notice" data-tone="wait" role="status" hidden></div></ui-settings-nav>
  </aside>
  <main>
    <p class="intro">Slack 명령으로 바꿀 수 있는 개인 설정을 여기서 모두 보고 바꿉니다. 선택하는 항목은 바로 저장되고, 직접 입력하는 항목은 저장을 눌러야 저장됩니다. 각 항목 아래에 같은 일을 하는 Slack 명령이 있습니다.</p>
    <div id="pref-body"><div class="ui-notice" role="status">불러오는 중…</div></div>
  </main>
</div>`;
}

// Tab hooks: a tab loads its data the first time it is shown.
const TAB_HOOKS_JS = String.raw`
function onTabShown(id) {
  if (id === 'memory' && !_memLoaded) loadMemory();
  if (id === 'layout' && !_layLoaded) loadLayout();
  if (id === 'dictation' && !_dicLoaded) loadDictationTab();
}
`;

export function renderSettingsPage(tabs: SettingsPageTab[] = SETTINGS_TABS): string {
  // The tab list's data, read by the page script (showTab): JSON with every < escaped, inert in a data script.
  const tabsJson = JSON.stringify(tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))).replace(
    /</g,
    '\\u003c',
  );
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>soma-work 설정</title>
<script data-fouc>
(function(){var t=localStorage.getItem('soma-theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();
</script>
<!-- Interface sound (@2lab.ai/ui/sound, sound-cuelume): off until the app bar's speaker turns it on; the script
     binds the bar's ui-sound-change (somaSoundBindBar) and the page's own data-ui-sound controls (bindSound). -->
<script data-sound>${soundClientJs(UI_LIB_VERSION)}</script>
<!-- @2lab.ai/ui kit (ui-kit.css): the light-DOM classes (.ui-btn, .ui-input, .ui-switch, .ui-card, .ui-notice,
     .ui-sr-only …) on the --ui-* tokens below. Before the page sheet, so a page rule that places a kit control wins. -->
<style id="ui-kit">
${uiLibKitCss()}
</style>
<style>${SETTINGS_PAGE_CSS}${MEMORY_TAB_CSS}${LAYOUT_TAB_CSS}${DICTATION_TAB_CSS}</style>
<!-- Tokens — @2lab.ai/ui is the single source, as on the dashboard (P10, P9): its tokens.css puts every
     --ui-* on :root and [data-theme="light|dark"], and the page's names are aliases of them. -->
<style id="ui-tokens">
${uiLibTokensCss()}
${pageTokenAliases()}
</style>
</head>
<body>
<header class="topbar" id="topbar">
  <h1 class="ui-sr-only">soma-work 설정</h1>
  <ui-app-bar id="app-bar" lang="ko"></ui-app-bar>
</header>
<ui-tabs id="settings-tabs" class="settings-tabs" panel-focus="none">
${preferencesTab()}
${MEMORY_TAB_HTML}
${LAYOUT_TAB_HTML}
${DICTATION_TAB_HTML}
</ui-tabs>
<script type="application/json" id="settings-tabs-data">${tabsJson}</script>
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
<script>${MEMORY_CLIENT_JS}${VIEW_LAYOUT_CLIENT_JS}${LAYOUT_CLIENT_JS}${DICTATION_PREF_JS}${DICTATION_SERVER_JS}${DICTATION_BROWSER_JS}${DICTATION_CLIENT_JS}${TAB_HOOKS_JS}${SETTINGS_CLIENT_JS}</script>
<script type="module" src="/dashboard/ui/app-bar.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/setting-row.js?v=${UI_LIB_VERSION}"></script>
<!-- <ui-settings-nav> and the library's own row filter (applySettingsFilter) for the page script's applyFilter. -->
<script type="module">
import { applySettingsFilter } from '/dashboard/ui/settings-nav.js?v=${UI_LIB_VERSION}';
window.applySettingsFilter = applySettingsFilter;
if (typeof applyFilter === 'function') applyFilter();
</script>
<script type="module" src="/dashboard/ui/tabs.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/memory-panel.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/knowledge-pages.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/episode-log.js?v=${UI_LIB_VERSION}"></script>
<!-- 대시보드 화면's preview draws the board's own card element. -->
<script type="module" src="/dashboard/ui/agent-inbox.js?v=${UI_LIB_VERSION}"></script>
</body>
</html>`;
}
