/**
 * The settings page "프로젝트 메모리" tab (SSOT 2026-10-23 T4) — shared notes per
 * repo (`owner/repo`). Everyone reads; only admins edit.
 *
 * UI decisions (research, SSOT T5 — GitHub / Notion permission patterns, NN/g
 * on disabled controls): a non-admin sees the content as plain, selectable
 * text with a lock banner that says who can change it — no greyed-out form.
 * An admin sees the same view plus edit controls once admin mode is on (the
 * same "Admin: ON" switch as the dashboard; the server checks it), with a note
 * that a change applies to every session in the repo's channels. The server
 * enforces all of this; hiding controls is only presentation.
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte).
 */

export const PROJECT_TAB_HTML = `<div data-tab="project" class="page" hidden>
  <aside class="side" aria-label="프로젝트 목록">
    <input type="search" id="pm-filter" placeholder="프로젝트 검색" aria-label="프로젝트 검색" oninput="paintProjectList()">
    <nav id="pm-list"></nav>
    <div id="pm-new-box"></div>
  </aside>
  <main>
    <p class="intro">공유 프로젝트 메모리는 저장소(owner/repo)마다 하나입니다. 그 저장소에 연결된 채널의 모든 세션 프롬프트에 들어가므로 모든 사용자에게 적용됩니다. 기억 탭의 "내 프로젝트 페이지"는 나만의 기록이고, 이것과 다릅니다.</p>
    <div id="pm-banner"></div>
    <div id="pm-status" class="status" role="status" aria-live="polite"></div>
    <section class="group" id="pm-detail" aria-live="polite"><div class="notice">불러오는 중…</div></section>
  </main>
</div>`;

export const PROJECT_TAB_CSS = String.raw`
.pm-banner { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; font-size: 13px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); margin-bottom: 12px; }
.pm-banner.is-locked { border-color: var(--text-tertiary); }
.pm-banner.is-admin { border-color: var(--accent); }
.pm-item { display: block; width: 100%; text-align: left; font: inherit; font-size: 13px; color: var(--text); background: none; border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.pm-item[aria-current="true"] { background: var(--surface-raised); font-weight: 700; }
.pm-item .lock { display: block; font-weight: 400; }
#pm-detail { padding: 16px; }
#pm-detail h2 { font-size: 15px; }
#pm-detail .meta { font-size: 12px; color: var(--text-secondary); margin: 4px 0 12px; }
`;

export const PROJECT_CLIENT_JS = String.raw`
var _pm = null;           // GET /api/project-memory
var _pmLoaded = false;
var _pmSlug = null;       // the open project
var _pmEditing = -1;      // entry index being edited

function pmIsAdmin() {
  return !!(_pm && _pm.isAdmin);
}
// Admins edit only with admin mode on — the same switch the dashboard uses; the server checks the header.
function pmCanEdit() {
  return pmIsAdmin() && adminModeOn();
}
function pmProject() {
  var list = (_pm && _pm.projects) || [];
  for (var i = 0; i < list.length; i++) if (list[i].slug === _pmSlug) return list[i];
  return null;
}
function pmStatus(text, isError) {
  var el = document.getElementById('pm-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (text ? (isError ? ' is-error' : ' is-ok') : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
}
async function loadProjects() {
  var res = await fetch('/api/project-memory');
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  if (!res.ok) {
    document.getElementById('pm-detail').innerHTML = '<div class="notice is-error" role="alert">' + esc((data && data.error) || ('프로젝트 메모리를 불러오지 못했습니다 (HTTP ' + res.status + ')')) + '</div>';
    return;
  }
  _pm = data;
  _pmLoaded = true;
  if (!_pmSlug && _pm.projects.length) _pmSlug = _pm.projects[0].slug;
  paintProjectBanner();
  paintProjectList();
  renderProjectDetail();
}
function paintProjectBanner() {
  var el = document.getElementById('pm-banner');
  // The server could not load the stored notes: say so — an empty list here would be a lie.
  var html = _pm && _pm.storeError
    ? '<div class="notice is-error" role="alert">' + esc(_pm.storeError) + '</div>'
    : '';
  if (!pmIsAdmin() && _pm && _pm.readOnlyReason === 'anonymous') {
    html += '<div class="pm-banner is-locked" role="note"><span><span aria-hidden="true">&#x1F512;</span> 읽기 전용 — 이 대시보드는 인증이 설정되지 않아 아무도 수정할 수 없습니다. 관리자 로그인을 설정하세요.</span></div>';
  } else if (!pmIsAdmin()) {
    html += '<div class="pm-banner is-locked" role="note"><span><span aria-hidden="true">&#x1F512;</span> 읽기 전용 — 관리자만 수정할 수 있습니다.</span></div>';
  } else if (!adminModeOn()) {
    html += '<div class="pm-banner is-admin" role="note"><span>관리자입니다. 수정하려면 관리자 모드를 켜세요.</span>'
      + '<button type="button" class="btn" onclick="setAdminModeHere(true)">관리자 모드 켜기</button></div>';
  } else {
    html += '<div class="pm-banner is-admin" role="note"><span>관리자 모드 — 바꾼 내용은 이 저장소 채널의 모든 세션에 적용됩니다.</span>'
      + '<button type="button" class="btn" onclick="setAdminModeHere(false)">관리자 모드 끄기</button></div>';
  }
  el.innerHTML = html;
  var box = document.getElementById('pm-new-box');
  box.innerHTML = pmCanEdit()
    ? '<div class="line"><input type="text" id="pm-new-slug" placeholder="owner/repo" aria-label="새 프로젝트 (owner/repo)"><button type="button" class="btn" onclick="pmNewProject()">추가</button></div>'
    : '';
}
function setAdminModeHere(on) {
  try { localStorage.setItem('soma_admin_mode', on ? 'on' : 'off'); } catch (_e) {}
  paintProjectBanner();
  renderProjectDetail();
}
function paintProjectList() {
  if (!_pm) return;
  var q = ((document.getElementById('pm-filter') || {}).value || '').toLowerCase().trim();
  var html = '';
  var list = _pm.projects || [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (q && (p.slug + ' ' + (p.channels || []).join(' ')).toLowerCase().indexOf(q) < 0) continue;
    html += '<button type="button" class="pm-item" data-slug="' + escAttr(p.slug) + '" aria-current="' + (p.slug === _pmSlug ? 'true' : 'false') + '" onclick="openProject(this.getAttribute(\'data-slug\'))">'
      + esc(p.slug) + ' <span class="lock">' + (p.entries.length ? p.entries.length + '개 항목' : '비어 있음') + ((p.channels || []).length ? ' · #' + esc(p.channels.join(', #')) : '') + '</span></button>';
  }
  document.getElementById('pm-list').innerHTML = html || '<p class="lock">' + (q ? '맞는 프로젝트가 없습니다.' : '저장소에 연결된 채널이 아직 없습니다.') + '</p>';
}
function openProject(slug) {
  _pmSlug = slug;
  _pmEditing = -1;
  paintProjectList();
  renderProjectDetail();
}
function renderProjectDetail() {
  var el = document.getElementById('pm-detail');
  var p = pmProject();
  if (!p) { el.innerHTML = '<p class="lock">왼쪽에서 프로젝트를 고르세요.</p>'; return; }
  var edit = pmCanEdit();
  var html = '<h2>공유 프로젝트 메모리 · ' + esc(p.slug) + '</h2>'
    + '<div class="meta">' + ((p.channels || []).length ? '채널 #' + esc(p.channels.join(', #')) + ' · ' : '') + fmtNum(p.totalChars) + ' / 4,000자'
    + (p.updatedAt ? ' · 마지막 수정 ' + esc(p.updatedAt.slice(0, 16).replace('T', ' ')) + ' UTC' + (p.updatedBy ? ' (' + esc(p.updatedBy) + ')' : '') : '') + '</div>';
  if (!p.entries.length) html += '<p class="lock">아직 항목이 없습니다.' + (edit ? ' 아래에서 추가하세요.' : '') + '</p>';
  html += '<ol class="entries">';
  for (var i = 0; i < p.entries.length; i++) {
    if (edit && _pmEditing === i) {
      html += '<li><textarea id="pm-edit" rows="3" aria-label="' + escAttr((i + 1) + '번 항목 수정') + '">' + esc(p.entries[i]) + '</textarea>'
        + '<div class="actions"><button type="button" class="btn primary" onclick="pmSave(' + i + ')">저장</button> <button type="button" class="btn" onclick="pmCancel()">취소</button></div></li>';
    } else {
      html += '<li><div class="text">' + esc(p.entries[i]) + '</div>'
        + (edit ? '<div class="actions"><button type="button" class="btn link" onclick="pmEditStart(' + i + ')">수정</button> <button type="button" class="btn link" onclick="pmDelete(' + i + ')">삭제</button></div>' : '')
        + '</li>';
    }
  }
  html += '</ol>';
  if (edit) {
    html += '<div class="l1-add"><label class="lock" for="pm-new">새 항목 (한 항목 최대 1,000자, 모든 사용자에게 적용)</label><textarea id="pm-new" rows="2"></textarea>'
      + '<div class="line"><span></span><span><button type="button" class="btn primary" onclick="pmAdd()">추가</button> '
      + (p.entries.length ? '<button type="button" class="btn" onclick="pmClear()">모두 지우기</button>' : '') + '</span></div></div>';
  }
  el.innerHTML = html;
}
function pmEditStart(i) { _pmEditing = i; renderProjectDetail(); }
function pmCancel() { _pmEditing = -1; renderProjectDetail(); }
// One admin write; 409 (another admin changed it) reloads and keeps the draft in the status line.
async function pmWrite(method, url, payload, draft) {
  var r;
  try { r = await apiWrite(method, url, payload); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (r.ok) {
    var list = _pm.projects;
    var found = false;
    for (var i = 0; i < list.length; i++) if (list[i].slug === r.data.project.slug) { list[i] = r.data.project; found = true; }
    if (!found) list.push(r.data.project);
    _pmSlug = r.data.project.slug;
    _pmEditing = -1;
    paintProjectList();
    renderProjectDetail();
    return true;
  }
  if (r.status === 409) {
    await loadProjects();
    pmStatus('그사이 다른 관리자가 바꿔 최신 내용을 불러왔습니다. 다시 적용하세요.' + (draft ? ' 작성하던 내용: ' + draft.slice(0, 200) : ''), true);
    return false;
  }
  pmStatus((r.status === 403 ? '권한이 없습니다: ' : '저장하지 못했습니다: ') + r.error, true);
  return false;
}
async function pmAdd() {
  var ta = document.getElementById('pm-new');
  var text = ta ? ta.value : '';
  if (!text.trim()) return;
  var p = pmProject();
  if (await pmWrite('POST', '/api/project-memory/entries', { project: p.slug, text: text, revision: p.revision }, text)) pmStatus('추가했습니다', false);
}
async function pmSave(i) {
  var ta = document.getElementById('pm-edit');
  var text = ta ? ta.value : '';
  if (!text.trim()) { pmStatus('비어 있는 항목은 저장할 수 없습니다 — 지우려면 삭제를 쓰세요', true); return; }
  var p = pmProject();
  if (await pmWrite('PUT', '/api/project-memory/entries/' + i, { project: p.slug, text: text, revision: p.revision }, text)) pmStatus('저장했습니다', false);
}
async function pmDelete(i) {
  var p = pmProject();
  var ok = await confirmDialog({ title: p.slug + '의 ' + (i + 1) + '번 항목을 지울까요?', body: '모든 사용자의 세션에서 빠집니다.', action: '항목 삭제' });
  if (!ok) return;
  if (await pmWrite('DELETE', '/api/project-memory/entries/' + i, { project: p.slug, revision: p.revision })) pmStatus('지웠습니다', false);
}
async function pmClear() {
  var p = pmProject();
  var ok = await confirmDialog({ title: p.slug + ' 항목 ' + p.entries.length + '개를 모두 지울까요?', body: '모든 사용자의 세션에서 빠지고 되돌릴 수 없습니다.', action: p.entries.length + '개 모두 지우기' });
  if (!ok) return;
  if (await pmWrite('DELETE', '/api/project-memory', { project: p.slug, revision: p.revision })) pmStatus('모두 지웠습니다', false);
}
function pmNewProject() {
  var el = document.getElementById('pm-new-slug');
  var slug = (el && el.value || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(slug)) { pmStatus('owner/repo 형식으로 넣으세요', true); return; }
  var list = _pm.projects;
  for (var i = 0; i < list.length; i++) if (list[i].slug === slug) { openProject(slug); return; }
  // A project without notes has the server's emptyRevision (the hash of no entries).
  list.push({ slug: slug, entries: [], totalChars: 0, revision: _pmEmptyRevision(), channels: [] });
  openProject(slug);
}
function _pmEmptyRevision() {
  return _pm && _pm.emptyRevision;
}
`;
