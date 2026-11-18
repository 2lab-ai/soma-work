/**
 * The settings page "비밀" tab (secret-access WU1, #1337, `.prd/32-secret-access-spec.md` §4.2) — the host's
 * secret store as GitHub shows repository secrets: names, when each changed and by whom, where configuration
 * uses it. Never a value: a value is typed once, sent, and the box is cleared. An admin with admin mode on adds a
 * secret, replaces its value and deletes it; the delete confirmation names what stops working.
 *
 * Shown to admins only (the tab is `adminOnly`); the server (`secrets-routes.ts`) refuses everyone else anyway.
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte).
 */

export const SECRETS_TAB_HTML = `<div slot="secrets" data-tab="secrets" class="page" hidden>
  <aside class="side" aria-label="비밀 영역">
    <input type="search" class="ui-input" id="sc-filter" placeholder="비밀 이름 검색" aria-label="비밀 이름 검색" oninput="renderSecrets()">
  </aside>
  <main>
    <p class="intro">이 호스트의 비밀 저장소입니다. 이름과 바꾼 시각, 설정에서 쓰는 곳만 보이고 값은 다시 볼 수 없습니다. 값은 넣을 때 한 번 보내고, 바꾸려면 새 값으로 덮어씁니다. 모델은 어떤 비밀도 읽지 못합니다 — 봇의 도구가 대신 씁니다.</p>
    <div id="sc-status" class="status" role="status" aria-live="polite"></div>
    <section class="group" id="sc-body"><div class="notice">불러오는 중…</div></section>
  </main>
</div>`;

export const SECRETS_TAB_CSS = `
#sc-body { padding: 16px; }
#sc-body h2 { font-size: 15px; }
#sc-body h3 { font-size: 13px; font-weight: 650; margin-bottom: 8px; }
#sc-body .meta { font-size: 12px; color: var(--text-secondary); margin: 4px 0 12px; }
.sc-box { border-top: 1px solid var(--border); padding: 12px 0; }
.sc-rows { list-style: none; }
.sc-row { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; padding: 10px 0; border-top: 1px solid var(--border); }
.sc-row:first-child { border-top: 0; }
.sc-name { font-family: var(--mono); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.sc-sub { display: block; font-size: 12px; color: var(--text-secondary); margin-top: 2px; overflow-wrap: anywhere; }
.sc-warn { color: var(--tint-fail-fg); }
.sc-actions, .sc-line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.sc-form { display: grid; gap: 8px; max-width: 560px; }
.sc-value { font-family: var(--mono); font-size: 12px; min-height: 88px; resize: vertical; }
.sc-banner { font-size: 13px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); margin-bottom: 12px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
`;

export const SECRETS_CLIENT_JS = String.raw`
var _sc = null;            // GET /api/secrets
var _scLoaded = false;
var _scReplacing = '';     // the name whose value is being replaced, or ''

function scStatus(text, isError) {
  var el = document.getElementById('sc-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (text ? (isError ? ' is-error' : ' is-ok') : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
}
async function loadSecrets() {
  var el = document.getElementById('sc-body');
  try {
    var res = await fetch('/api/secrets');
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) {
      el.innerHTML = '<div class="notice is-error" role="alert">' + esc((data && data.error) || ('비밀 목록을 불러오지 못했습니다 (HTTP ' + res.status + ')')) + '</div>';
      return;
    }
    _sc = data;
    _scLoaded = true;
    renderSecrets();
  } catch (_e) {
    el.innerHTML = '<div class="notice is-error" role="alert">비밀 목록을 불러오지 못했습니다. 다시 시도하세요.</div>';
  }
}
function scWhen(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
// Where configuration uses a secret: "dev2 › github.token · stage0 › cloudflare.token".
function scUsageText(usages) {
  if (!usages || !usages.length) return '쓰는 곳 없음';
  var parts = [];
  for (var i = 0; i < usages.length; i++) parts.push(usages[i].server + ' › ' + usages[i].path);
  return parts.join(' · ');
}
function scFilterText() {
  return ((document.getElementById('sc-filter') || {}).value || '').toLowerCase().trim();
}
function scBanner() {
  if (!adminModeOn()) {
    return '<div class="sc-banner" role="note"><span>비밀을 추가하거나 바꾸려면 관리자 모드를 켜세요. 대시보드 막대의 관리자 모드와 같은 스위치입니다.</span>'
      + '<button type="button" class="btn" onclick="scSetAdminMode(true)">관리자 모드 켜기</button></div>';
  }
  return '<div class="sc-banner" role="note"><span>관리자 모드 — 추가 · 값 바꾸기 · 삭제가 바로 적용되고 감사 기록에 남습니다.</span>'
    + '<button type="button" class="btn" onclick="scSetAdminMode(false)">관리자 모드 끄기</button></div>';
}
function scSetAdminMode(on) {
  try { localStorage.setItem('soma_admin_mode', on ? 'on' : 'off'); } catch (_e) {}
  renderSecrets();
}
function scValueBox(id, label) {
  return '<textarea class="ui-input sc-value" id="' + escAttr(id) + '" aria-label="' + escAttr(label) + '" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="값을 붙여넣으세요 — 저장한 뒤에는 다시 볼 수 없습니다"></textarea>';
}
function scRow(s, editable) {
  var who = s.updatedByName || s.updatedBy;
  var by = who ? ' · ' + who : '';
  var html = '<li class="sc-row"><div><span class="sc-name">' + esc(s.name) + '</span>'
    + '<span class="sc-sub">바꾼 시각 ' + esc(scWhen(s.updatedAt)) + esc(by) + '</span>'
    + '<span class="sc-sub">' + esc(s.usages && s.usages.length ? '쓰는 곳: ' + scUsageText(s.usages) : '설정에서 쓰지 않음') + '</span>';
  if (editable && _scReplacing === s.name) {
    html += '<div class="sc-form" style="margin-top:8px">' + scValueBox('sc-replace-value', s.name + '의 새 값')
      + '<div class="sc-line"><button type="button" class="btn primary" data-name="' + escAttr(s.name) + '" onclick="scSaveReplace(this)">새 값 저장</button>'
      + '<button type="button" class="btn" onclick="scCancelReplace()">취소</button></div></div>';
  }
  html += '</div>';
  if (editable && _scReplacing !== s.name) {
    html += '<div class="sc-actions"><button type="button" class="btn" data-name="' + escAttr(s.name) + '" onclick="scStartReplace(this)">값 바꾸기</button>'
      + '<button type="button" class="btn danger" data-name="' + escAttr(s.name) + '" onclick="scDelete(this)">삭제</button></div>';
  }
  return html + '</li>';
}
function scMissingRow(m, editable) {
  return '<li class="sc-row"><div><span class="sc-name">' + esc(m.name) + '</span>'
    + '<span class="sc-sub sc-warn">⚠️ 설정이 가리키지만 저장소에 없습니다 — 이 절은 지금 빠져 있습니다</span>'
    + '<span class="sc-sub">쓰는 곳: ' + esc(scUsageText(m.usages)) + '</span></div>'
    + (editable ? '<div class="sc-actions"><button type="button" class="btn" data-name="' + escAttr(m.name) + '" onclick="scFillName(this)">이 이름으로 추가</button></div>' : '')
    + '</li>';
}
function scAddForm() {
  return '<div class="sc-box"><h3>비밀 추가</h3><div class="sc-form">'
    + '<input type="text" class="ui-input" id="sc-name" aria-label="비밀 이름" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="이름 (예: dev2-db-app)">'
    + scValueBox('sc-value', '비밀 값')
    + '<div class="sc-line"><button type="button" class="btn primary" onclick="scAdd()">추가</button></div></div></div>';
}
function renderSecrets() {
  var el = document.getElementById('sc-body');
  if (!el || !_sc) return;
  var editable = adminModeOn();
  var q = scFilterText();
  var rows = '';
  for (var i = 0; i < _sc.secrets.length; i++) {
    if (!q || _sc.secrets[i].name.toLowerCase().indexOf(q) >= 0) rows += scRow(_sc.secrets[i], editable);
  }
  var missing = '';
  for (var j = 0; j < _sc.missing.length; j++) {
    if (!q || _sc.missing[j].name.toLowerCase().indexOf(q) >= 0) missing += scMissingRow(_sc.missing[j], editable);
  }
  var html = scBanner() + '<h2>비밀</h2><p class="meta">' + _sc.secrets.length + '개 — 값은 보이지 않습니다.</p>';
  if (editable) html += scAddForm();
  html += '<div class="sc-box">' + (rows ? '<ul class="sc-rows">' + rows + '</ul>' : '<p class="lock">' + (_sc.secrets.length ? '맞는 비밀이 없습니다.' : '아직 비밀이 없습니다.') + '</p>') + '</div>';
  if (missing) html += '<div class="sc-box"><h3>없는 비밀</h3><ul class="sc-rows">' + missing + '</ul></div>';
  el.innerHTML = html;
}
function scFindSecret(name) {
  var list = (_sc && _sc.secrets) || [];
  for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
  return null;
}
function scFillName(btn) {
  var input = document.getElementById('sc-name');
  if (!input) return;
  input.value = btn.getAttribute('data-name');
  var box = document.getElementById('sc-value');
  if (box) box.focus();
}
async function scPut(name, value, overwrite) {
  var r = await apiWrite('PUT', '/api/secrets/' + encodeURIComponent(name), { value: value, overwrite: overwrite });
  if (!r.ok) {
    scStatus((r.status === 403 ? '권한이 없습니다: ' : '저장하지 못했습니다: ') + r.error, true);
    return false;
  }
  scStatus((r.data && r.data.created ? '추가했습니다: ' : '값을 바꿨습니다: ') + name, false);
  return true;
}
async function scAdd() {
  var nameEl = document.getElementById('sc-name');
  var valueEl = document.getElementById('sc-value');
  var name = (nameEl && nameEl.value || '').trim();
  var value = valueEl ? valueEl.value : '';
  if (!name || !value) {
    scStatus('이름과 값을 모두 넣으세요', true);
    return;
  }
  var overwrite = false;
  var existing = scFindSecret(name);
  if (existing) {
    var ok = await confirmDialog({ title: name + '의 값을 덮어쓸까요?', body: '쓰는 곳: ' + scUsageText(existing.usages) + '. 옛 값은 남지 않습니다.', action: name + ' 덮어쓰기' });
    if (!ok) return;
    overwrite = true;
  }
  if (await scPut(name, value, overwrite)) {
    if (valueEl) valueEl.value = '';
    if (nameEl) nameEl.value = '';
    await loadSecrets();
  }
}
function scStartReplace(btn) {
  _scReplacing = btn.getAttribute('data-name');
  renderSecrets();
  var box = document.getElementById('sc-replace-value');
  if (box) box.focus();
}
function scCancelReplace() {
  _scReplacing = '';
  renderSecrets();
}
async function scSaveReplace(btn) {
  var name = btn.getAttribute('data-name');
  var box = document.getElementById('sc-replace-value');
  var value = box ? box.value : '';
  if (!value) {
    scStatus('새 값을 넣으세요', true);
    return;
  }
  if (await scPut(name, value, true)) {
    if (box) box.value = '';
    _scReplacing = '';
    await loadSecrets();
  }
}
async function scDelete(btn) {
  var name = btn.getAttribute('data-name');
  var s = scFindSecret(name);
  var uses = s && s.usages && s.usages.length;
  var body = uses ? '지우면 이 비밀을 쓰는 설정 절이 빠집니다 — ' + scUsageText(s.usages) + '.' : '설정에서 쓰는 곳이 없습니다.';
  var ok = await confirmDialog({ title: name + '을(를) 삭제할까요?', body: body + ' 되돌릴 수 없습니다.', action: name + ' 삭제' });
  if (!ok) return;
  var r = await apiWrite('DELETE', '/api/secrets/' + encodeURIComponent(name));
  if (!r.ok) {
    scStatus((r.status === 403 ? '권한이 없습니다: ' : '삭제하지 못했습니다: ') + r.error, true);
    return;
  }
  scStatus('삭제했습니다: ' + name, false);
  await loadSecrets();
}
`;
