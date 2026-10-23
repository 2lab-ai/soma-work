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

export interface SettingsPageTab {
  id: string;
  label: string;
}

/** Tabs that exist on this build. Later areas append here. */
export const SETTINGS_TABS: SettingsPageTab[] = [{ id: 'preferences', label: '개인 설정' }];

export const SETTINGS_PAGE_CSS = String.raw`
*,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #1c1c1f; --surface: #232327; --surface-raised: #2a2a2f; --border: #34343a; --border-focus: #4d9de0;
  --text: #ededf0; --text-secondary: #a8a8b0; --text-tertiary: #93939b;
  --accent: #4d9de0; --green: #3ecf8e; --yellow: #f6c90e; --red: #f26b6b;
  --danger-bg: rgba(242,107,107,0.08);
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1); --dur-press: 160ms; --dur-fade: 180ms;
}
[data-theme="light"] {
  --bg: #f7f7f7; --surface: #ffffff; --surface-raised: #f1f1f1; --border: #e4e4e4;
  --text: #18181a; --text-secondary: #57575d; --text-tertiary: #68686f;
  --accent: #1f6fb5; --green: #13795b; --red: #c0392b; --danger-bg: rgba(192,57,43,0.06);
}
html, body { background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif; }
a { color: var(--accent); }
code { font-family: "SF Mono", "Fira Code", ui-monospace, monospace; font-size: 12px; }
.topbar { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 0 20px; background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.topbar h1 { font-size: 14px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
.topbar .back { font-size: 13px; text-decoration: none; color: var(--text-secondary); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; }
.tabs { display: flex; gap: 4px; margin-left: 8px; }
.tabs a { font-size: 13px; text-decoration: none; color: var(--text-secondary); padding: 12px 10px; border-bottom: 2px solid transparent; }
.tabs a[aria-current="page"] { color: var(--text); font-weight: 700; border-bottom-color: var(--accent); }
.topbar .account { margin-left: auto; display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-secondary); }
.topbar button.theme { font: inherit; background: var(--surface-raised); color: var(--text); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; cursor: pointer; }
.page { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
.side { position: sticky; top: 16px; align-self: start; display: flex; flex-direction: column; gap: 12px; }
.side input[type="search"] { width: 100%; font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.side .only-modified { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-secondary); }
.side nav { display: flex; flex-direction: column; gap: 2px; }
.side nav a { font-size: 13px; text-decoration: none; color: var(--text-secondary); padding: 6px 10px; border-radius: 6px; }
.side nav a:focus-visible, .side input:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.intro { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
.notice { font-size: 13px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.notice.is-error { border-color: var(--red); color: var(--red); }
section.group { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 20px; }
section.group.danger { border-color: var(--red); background: var(--danger-bg); }
section.group > header { padding: 14px 16px 10px; border-bottom: 1px solid var(--border); }
section.group > header h2 { font-size: 15px; letter-spacing: -0.01em; }
section.group > header p { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 8px 20px; padding: 14px 16px; border-top: 1px solid var(--border); }
.row:first-of-type { border-top: 0; }
.row.is-modified::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 2px; background: var(--accent); }
.row[hidden] { display: none; }
.row .meta label, .row .meta .label { font-weight: 700; font-size: 13px; }
.row .meta p { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.row .meta .hint { font-size: 11px; color: var(--text-tertiary); margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.row .control { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.row .control .line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.row input[type="text"], .row input[type="number"], .row select { font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; min-height: 34px; min-width: 0; }
.row input[type="text"] { flex: 1 1 220px; }
.row input[type="number"] { width: 110px; }
.row select { max-width: 100%; }
.btn { font: inherit; font-size: 12px; font-weight: 600; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; min-height: 34px; cursor: pointer; transition: transform var(--dur-press) var(--ease-out), border-color var(--dur-press) var(--ease-out); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.link { background: none; border: 0; padding: 0; min-height: 0; color: var(--accent); font-weight: 500; }
.btn.danger { background: var(--red); border-color: var(--red); color: #fff; }
.btn:active:not(:focus-visible) { transform: scale(0.97); }
.btn:focus-visible, .row input:focus-visible, .row select:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
@media (hover: hover) and (pointer: fine) { .btn:hover { border-color: var(--accent); } }
fieldset.seg { border: 0; display: inline-flex; flex-wrap: wrap; background: var(--surface-raised); border-radius: 8px; padding: 2px; gap: 2px; }
fieldset.seg legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
fieldset.seg label { position: relative; }
fieldset.seg input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
fieldset.seg span { display: inline-block; font-size: 12px; padding: 6px 10px; border-radius: 6px; color: var(--text-secondary); min-height: 30px; }
fieldset.seg input:checked + span { background: var(--surface); color: var(--text); font-weight: 700; box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
fieldset.seg input:focus-visible + span { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.switch input { width: 36px; height: 20px; accent-color: var(--accent); cursor: pointer; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: 999px; padding: 2px 4px 2px 10px; }
.chip button { font: inherit; background: none; border: 0; color: var(--text-tertiary); cursor: pointer; padding: 2px 6px; border-radius: 999px; }
.readonly { font-size: 13px; color: var(--text-secondary); display: flex; gap: 6px; align-items: center; }
.lock { font-size: 12px; color: var(--text-tertiary); }
.status { font-size: 12px; min-height: 18px; color: var(--text-secondary); }
.status.is-ok { color: var(--green); }
.status.is-error { color: var(--red); }
dialog { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); padding: 20px; max-width: 420px; }
dialog::backdrop { background: rgba(0,0,0,0.5); }
dialog h3 { font-size: 15px; margin-bottom: 8px; }
dialog p { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
dialog .actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 760px) {
  .page { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; }
  .side nav { flex-direction: row; overflow-x: auto; }
  .row { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
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
    await refreshCsrfToken();
    res = await fetch(url, { method: method, headers: headers(), body: body });
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
function renderSegmented(row) {
  var name = 'seg-' + row.key;
  var html = '<fieldset class="seg"><legend>' + esc(row.label) + '</legend>';
  var opts = row.options || [];
  for (var i = 0; i < opts.length; i++) {
    var o = opts[i];
    html += '<label title="' + escAttr(o.description || o.label) + '"><input type="radio" name="' + escAttr(name) + '" value="' + escAttr(o.value) + '"'
      + (o.value === row.value ? ' checked' : '') + ' data-key="' + escAttr(row.key) + '" onchange="onChoice(this)"><span>' + esc(o.label) + '</span></label>';
  }
  return html + '</fieldset>';
}
function renderSelect(row) {
  var html = '<select id="f-' + escAttr(row.key) + '" data-key="' + escAttr(row.key) + '" onchange="onChoice(this)">';
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
      + (row.lockedReason ? '<span class="lock" aria-hidden="true">&#x1F512;</span><span class="lock">' + esc(row.lockedReason) + '</span>' : '') + '</div>';
  }
  var k = escAttr(row.key);
  if (row.kind === 'choice') {
    return (row.options || []).length <= 5 && !row.allowCustom ? renderSegmented(row) : renderSelect(row);
  }
  if (row.kind === 'toggle') {
    return '<label class="switch"><input type="checkbox" role="switch" id="f-' + k + '" data-key="' + k + '"' + (row.value ? ' checked' : '')
      + ' onchange="onToggle(this)"><span>' + (row.value ? '켜짐' : '꺼짐') + '</span></label>';
  }
  if (row.kind === 'text' || row.kind === 'number') {
    var type = row.kind === 'number' ? 'number' : 'text';
    var bounds = row.kind === 'number' ? ' min="' + row.min + '" max="' + row.max + '" step="1"' : '';
    return '<div class="line"><input type="' + type + '" id="f-' + k + '" data-key="' + k + '" value="' + escAttr(row.value) + '"' + bounds
      + ' onkeydown="if(event.key===\'Enter\')saveTyped(this.getAttribute(\'data-key\'))">'
      + '<button type="button" class="btn primary" data-key="' + k + '" onclick="saveTyped(this.getAttribute(\'data-key\'))">저장</button>'
      + (row.kind === 'text' && row.value ? '<button type="button" class="btn" data-key="' + k + '" onclick="clearTyped(this.getAttribute(\'data-key\'))">지우기</button>' : '')
      + '</div>';
  }
  if (row.kind === 'list') {
    var chips = '';
    var list = row.value || [];
    for (var i = 0; i < list.length; i++) {
      chips += '<span class="chip">' + esc(list[i]) + '<button type="button" aria-label="' + escAttr(list[i] + ' 빼기') + '" data-key="' + k + '" data-item="' + escAttr(list[i])
        + '" onclick="removeListItem(this)">&#x2715;</button></span>';
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
    nav += '<a href="#g-' + escAttr(grp.id) + '">' + esc(grp.label) + '</a>';
    body += '<section class="group' + (grp.id === 'permissions' ? ' danger' : '') + '" id="g-' + escAttr(grp.id) + '" aria-labelledby="h-' + escAttr(grp.id) + '">'
      + '<header><h2 id="h-' + escAttr(grp.id) + '">' + esc(grp.label) + '</h2><p>' + esc(grp.description) + '</p></header>'
      + inGroup.map(renderRow).join('') + '</section>';
  }
  return { nav: nav, body: body };
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
  var rows = document.querySelectorAll('.row[data-key]');
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var hit = (!q || r.getAttribute('data-search').indexOf(q) >= 0) && (!onlyMod || r.getAttribute('data-modified') === '1');
    r.hidden = !hit;
  }
  var groups = document.querySelectorAll('section.group');
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

export function renderSettingsPage(tabs: SettingsPageTab[] = SETTINGS_TABS, extraTabsHtml = '', extraJs = ''): string {
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
<style>${SETTINGS_PAGE_CSS}</style>
</head>
<body>
<div class="topbar">
  <h1>&#x26A1; soma-work</h1>
  <a class="back" href="/dashboard">&larr; 대시보드</a>
  <nav class="tabs" aria-label="설정 영역">${tabLinks}</nav>
  <div class="account"><span id="who"></span><button type="button" class="theme" onclick="toggleTheme()" aria-label="테마 바꾸기">테마</button></div>
</div>
${preferencesTab()}
${extraTabsHtml}
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
<script>${SETTINGS_CLIENT_JS}${extraJs}</script>
</body>
</html>`;
}
