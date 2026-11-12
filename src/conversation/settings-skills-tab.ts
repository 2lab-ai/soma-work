/**
 * The settings page "스킬" tab (#1079) — skills and who may run them, in three sections:
 *
 *   - 내 스킬: my personal skills (made in Slack). Open one to edit its SKILL.md and to say who else
 *     may run it; "all my skills" grants sit on the section itself.
 *   - 환경 스킬: the host's environment-plugin skills. Everyone sees the names and their own access;
 *     the description and the content only an admin or a user granted the skill; who has access only
 *     an admin, who changes it with admin mode on. Not editable here: the plugin is fetched again from
 *     its repo on restart.
 *   - 시스템 스킬: every installed built-in and plugin skill, read-only, grouped by source.
 *
 * The server (`skills-routes.ts`) decides and enforces all of this; the page draws what it is sent.
 * Same layout as the 프로젝트 메모리 tab: a section list with a filter on the left, the list or one
 * skill on the right.
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte).
 */

export const SKILLS_TAB_HTML = `<div slot="skills" data-tab="skills" class="page" hidden>
  <aside class="side" aria-label="스킬 영역">
    <input type="search" class="ui-input" id="sk-filter" placeholder="스킬 검색" aria-label="스킬 검색" oninput="skFilter()">
    <nav id="sk-nav"></nav>
  </aside>
  <main>
    <p class="intro">스킬을 보고, 누가 실행할 수 있는지 정합니다. 내 스킬은 Slack에서 만든 개인 스킬, 환경 스킬은 이 호스트의 환경 플러그인 스킬, 시스템 스킬은 이 서버에 설치된 기본 스킬과 플러그인 스킬입니다.</p>
    <div id="sk-status" class="status" role="status" aria-live="polite"></div>
    <section class="group" id="sk-detail"><div class="notice">불러오는 중…</div></section>
  </main>
</div>`;

export const SKILLS_TAB_CSS = `
.sk-nav { display: flex; justify-content: space-between; gap: 8px; width: 100%; text-align: left; font: inherit; font-size: 13px; color: var(--text); background: none; border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.sk-nav[aria-current="true"] { background: var(--surface-raised); font-weight: 600; }
#sk-detail { padding: 16px; }
#sk-detail h2 { font-size: 15px; }
#sk-detail h3 { font-size: 13px; font-weight: 650; margin-bottom: 8px; }
#sk-detail .meta { font-size: 12px; color: var(--text-secondary); margin: 4px 0 12px; }
.sk-box { border-top: 1px solid var(--border); padding: 12px 0; }
.sk-box .chips { margin-bottom: 8px; }
.sk-box .line, .sk-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.sk-actions { margin-top: 8px; }
.sk-banner { font-size: 13px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); margin-bottom: 12px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.sk-group { margin-top: 16px; }
.sk-rows { list-style: none; }
.sk-row { display: block; width: 100%; text-align: left; font: inherit; font-size: 13px; color: var(--text); background: none; border: 0; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
.sk-row .sk-desc { display: block; font-size: 12px; color: var(--text-secondary); }
.sk-badge { display: inline-block; font-size: 11px; font-weight: 500; color: var(--ib-text); background: var(--ib-pill); border: 1px solid var(--ib-card-border); border-radius: 999px; padding: 0 8px; margin-left: 6px; }
.sk-code { display: block; width: 100%; font-family: var(--mono); font-size: 12px; line-height: 1.5; }
pre.sk-code { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 12px; max-height: 60vh; overflow: auto; }
textarea.sk-code { min-height: 320px; resize: vertical; }
.sk-nav:focus-visible, .sk-row:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
@media (hover: hover) and (pointer: fine) {
  .sk-nav:hover, .sk-row:hover { background: var(--ib-pill); }
}
`;

export const SKILLS_CLIENT_JS = String.raw`
var _sk = null;            // GET /api/skills
var _skLoaded = false;
var _skSection = 'mine';   // 'mine' | 'env' | 'system'
var _skOpen = null;        // the open skill: { section, id, source }
var _skDetail = null;      // its SKILL.md (GET /api/skills/mine|env|system/…)
var _skDetailError = '';

function skIsAdmin() {
  return !!(_sk && _sk.isAdmin);
}
// Admins change environment-skill grants only with admin mode on — the dashboard's switch; the server checks the header.
function skCanEditEnv() {
  return skIsAdmin() && adminModeOn();
}
function skUserName(id) {
  var users = (_sk && _sk.users) || [];
  for (var i = 0; i < users.length; i++) if (users[i].id === id) return users[i].name;
  return id;
}
function skStatus(text, isError) {
  var el = document.getElementById('sk-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (text ? (isError ? ' is-error' : ' is-ok') : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
}
async function loadSkills() {
  var el = document.getElementById('sk-detail');
  try {
    var res = await fetch('/api/skills');
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) {
      el.innerHTML = '<div class="notice is-error" role="alert">' + esc((data && data.error) || ('스킬 목록을 불러오지 못했습니다 (HTTP ' + res.status + ')')) + '</div>';
      return;
    }
    _sk = data;
    _skLoaded = true;
    paintSkillNav();
    renderSkills();
  } catch (_e) {
    el.innerHTML = '<div class="notice is-error" role="alert">스킬 목록을 불러오지 못했습니다. 다시 시도하세요.</div>';
  }
}
function paintSkillNav() {
  var nav = document.getElementById('sk-nav');
  if (!nav || !_sk) return;
  var items = [
    ['mine', '내 스킬', _sk.mine ? _sk.mine.skills.length : null],
    ['env', '환경 스킬', _sk.env.skills.length],
    ['system', '시스템 스킬', _sk.system.length],
  ];
  var html = '';
  for (var i = 0; i < items.length; i++) {
    html += '<button type="button" class="sk-nav" data-sec="' + items[i][0] + '" aria-current="' + (items[i][0] === _skSection ? 'true' : 'false') + '" onclick="skShowSection(this.getAttribute(\'data-sec\'))">'
      + '<span>' + esc(items[i][1]) + '</span>' + (items[i][2] === null ? '' : '<span class="lock">' + items[i][2] + '</span>') + '</button>';
  }
  nav.innerHTML = html;
}
function skShowSection(section) {
  _skSection = section;
  _skOpen = null;
  _skDetail = null;
  skStatus('', false);
  paintSkillNav();
  renderSkills();
}
// Typing in the filter goes back to the list it filters.
function skFilter() {
  _skOpen = null;
  _skDetail = null;
  renderSkills();
}
function skFilterText() {
  return ((document.getElementById('sk-filter') || {}).value || '').toLowerCase().trim();
}
function skMatches(q, text) {
  return !q || String(text).toLowerCase().indexOf(q) >= 0;
}
function skAccessLabel(access) {
  if (access === 'admin') return '관리자';
  if (access === 'granted') return '허용됨';
  return '권한 없음';
}
// Who may run one skill (skill) or all of them (skill null). Editable: chips with a remove button, and a picker of the
// users not yet allowed — never the owner themself for 내 스킬.
function skGrantEditor(scope, skill, allowed, editable) {
  var chips = '';
  for (var i = 0; i < allowed.length; i++) {
    var name = skUserName(allowed[i]);
    chips += '<span class="chip">' + esc(name) + (editable ? '<button type="button" aria-label="' + escAttr(name + ' 빼기') + '" data-scope="' + scope + '" data-skill="' + escAttr(skill || '') + '" data-user="' + escAttr(allowed[i])
      + '" onclick="skRemoveGrant(this)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>' : '') + '</span>';
  }
  var html = '<div class="chips">' + (chips || '<span class="lock">없음</span>') + '</div>';
  if (!editable) return html;
  var opts = '';
  var users = (_sk && _sk.users) || [];
  for (var j = 0; j < users.length; j++) {
    if (allowed.indexOf(users[j].id) >= 0) continue;
    if (scope === 'mine' && users[j].id === _sk.me) continue;
    opts += '<option value="' + escAttr(users[j].id) + '">' + esc(users[j].name) + '</option>';
  }
  var off = opts ? '' : ' disabled';
  return html + '<div class="line"><select class="ui-input" id="' + escAttr(skPickId(scope, skill)) + '" aria-label="허용할 사람"' + off + '><option value="">사람 선택…</option>' + opts + '</select>'
    + '<button type="button" class="btn" data-scope="' + scope + '" data-skill="' + escAttr(skill || '') + '" onclick="skAddGrant(this)"' + off + '>추가</button></div>';
}
// The picker of one grant editor: one per environment, one for a skill, one for all.
function skPickId(scope, skill) {
  if (scope === 'environment') return 'sk-pick-env-' + skill;
  return 'sk-pick-' + (skill ? 'one' : 'all');
}
function skEnvBanner() {
  if (!skIsAdmin()) return '<div class="sk-banner" role="note"><span>권한 없는 환경 스킬이 필요하면 Slack에서 $플러그인:스킬 형식으로 실행하세요. 관리자에게 승인 요청이 갑니다.</span></div>';
  if (!adminModeOn()) {
    return '<div class="sk-banner" role="note"><span>관리자입니다. 실행 권한을 바꾸려면 관리자 모드를 켜세요. 대시보드 막대의 관리자 모드와 같은 스위치입니다.</span>'
      + '<button type="button" class="btn" onclick="skSetAdminMode(true)">관리자 모드 켜기</button></div>';
  }
  return '<div class="sk-banner" role="note"><span>관리자 모드 — 바꾼 실행 권한은 바로 적용됩니다.</span>'
    + '<button type="button" class="btn" onclick="skSetAdminMode(false)">관리자 모드 끄기</button></div>';
}
function skSetAdminMode(on) {
  try { localStorage.setItem('soma_admin_mode', on ? 'on' : 'off'); } catch (_e) {}
  renderSkills();
}
function skRow(section, id, source, label, extra, description) {
  return '<li><button type="button" class="sk-row" data-sec="' + section + '" data-id="' + escAttr(id) + '"' + (source ? ' data-src="' + escAttr(source) + '"' : '') + ' onclick="skOpenRow(this)">'
    + esc(label) + extra + (description ? '<span class="sk-desc">' + esc(description) + '</span>' : '') + '</button></li>';
}
function skMineList() {
  var html = '<h2>내 스킬</h2>';
  if (!_sk.mine) return html + '<p class="lock">Slack 계정으로 로그인해야 내 스킬을 볼 수 있습니다.</p>';
  html += '<p class="meta">Slack에서 만든 내 스킬입니다. 스킬을 열어 SKILL.md를 고치고, 그 스킬을 실행할 수 있는 사람을 정합니다.</p>'
    + '<div class="sk-box"><h3>내 모든 스킬을 실행할 수 있는 사람</h3>' + skGrantEditor('mine', null, _sk.mine.allowAll, true) + '</div>';
  var q = skFilterText();
  var rows = '';
  var list = _sk.mine.skills;
  for (var i = 0; i < list.length; i++) {
    if (skMatches(q, list[i].name + ' ' + list[i].description)) rows += skRow('mine', list[i].name, '', list[i].name, '', list[i].description);
  }
  if (!list.length) return html + '<p class="lock">아직 내 스킬이 없습니다.</p>';
  return html + (rows ? '<ul class="sk-rows">' + rows + '</ul>' : '<p class="lock">맞는 스킬이 없습니다.</p>');
}
function skEnvList() {
  var env = _sk.env;
  var html = '<h2>환경 스킬</h2><p class="meta">이 호스트의 환경 플러그인 스킬입니다. 테스트 계정이나 대상 같은 호스트 환경 값이 들어 있어, 관리자가 허용한 사람만 실행하고 내용을 볼 수 있습니다.</p>'
    + skEnvBanner();
  if (skIsAdmin()) html += '<div class="sk-box"><h3>모든 환경 스킬을 실행할 수 있는 사람</h3>' + skGrantEditor('env', null, env.allowAll || [], skCanEditEnv()) + '</div>';
  // env-access WU4: an environment held whole opens its skills and its servers' tools (ssh_exec, gh_pr too).
  var envs = (skIsAdmin() && env.environments) || [];
  for (var e = 0; e < envs.length; e++) {
    html += '<div class="sk-box"><h3>환경 ' + esc(envs[e].label) + ' 전체(스킬·서버 도구)를 쓸 수 있는 사람</h3>'
      + '<p class="meta">' + esc(envs[e].skills.join(', ')) + '</p>'
      + skGrantEditor('environment', envs[e].id, envs[e].allowed || [], skCanEditEnv()) + '</div>';
  }
  if (!env.skills.length) return html + '<p class="lock">이 호스트에는 환경 스킬이 없습니다.</p>';
  var q = skFilterText();
  var rows = '';
  for (var i = 0; i < env.skills.length; i++) {
    var s = env.skills[i];
    if (skMatches(q, s.key + ' ' + (s.description || ''))) rows += skRow('env', s.key, '', s.key, '<span class="sk-badge">' + esc(skAccessLabel(s.access)) + '</span>', s.description);
  }
  return html + (rows ? '<ul class="sk-rows">' + rows + '</ul>' : '<p class="lock">맞는 스킬이 없습니다.</p>');
}
function skSystemList() {
  var html = '<h2>시스템 스킬</h2><p class="meta">이 서버에 설치된 기본 스킬과 플러그인 스킬입니다. 누구나 쓸 수 있고, 여기서는 읽기만 합니다.</p>';
  var q = skFilterText();
  var groups = [];
  var bySource = {};
  for (var i = 0; i < _sk.system.length; i++) {
    var s = _sk.system[i];
    if (!skMatches(q, s.source + ':' + s.name + ' ' + s.description)) continue;
    if (!bySource[s.source]) { bySource[s.source] = []; groups.push(s.source); }
    bySource[s.source].push(s);
  }
  if (!groups.length) return html + '<p class="lock">' + (q ? '맞는 스킬이 없습니다.' : '설치된 시스템 스킬이 없습니다.') + '</p>';
  for (var g = 0; g < groups.length; g++) {
    var list = bySource[groups[g]];
    html += '<h3 class="sk-group">' + esc(groups[g]) + ' <span class="lock">' + list.length + '</span></h3><ul class="sk-rows">';
    for (var j = 0; j < list.length; j++) html += skRow('system', list[j].name, list[j].source, list[j].name, '', list[j].description);
    html += '</ul>';
  }
  return html;
}
function skFindMine(name) {
  var list = (_sk.mine && _sk.mine.skills) || [];
  for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
  return null;
}
function skFindEnv(key) {
  var list = _sk.env.skills;
  for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
  return null;
}
// save: the editor's 저장 — 'skSaveMine' or 'skSaveEnv'; none = read-only. The editor names the open skill
// (data-name = its id) so a redraw keeps a draft only for the skill it was typed for.
function skContent(save) {
  if (_skDetailError) return '<div class="notice is-error" role="alert">' + esc(_skDetailError) + '</div>';
  if (!_skDetail) return '<div class="notice">불러오는 중…</div>';
  // The HTML parser drops one newline right after <pre> and <textarea>: give it one, so a leading blank line survives.
  if (!save) return '<pre class="sk-code">\n' + esc(_skDetail.content) + '</pre>';
  return '<textarea id="sk-edit" class="ui-input sk-code" rows="18" spellcheck="false" aria-label="SKILL.md 내용" data-name="' + escAttr(_skOpen ? _skOpen.id : '') + '">\n' + esc(_skDetail.content) + '</textarea>'
    + '<div class="sk-actions"><button type="button" class="btn primary" onclick="' + (save === 'skSaveEnv' ? 'skSaveEnv' : 'skSaveMine') + '()">저장</button></div>';
}
function skBack(label) {
  return '<p><button type="button" class="btn link" onclick="skBackToList()">' + esc(label) + '</button></p>';
}
function skMineDetail() {
  var s = skFindMine(_skOpen.id);
  if (!s) return skBack('← 내 스킬') + '<p class="lock">이 스킬은 더 이상 없습니다.</p>';
  var all = _sk.mine.allowAll;
  var names = [];
  for (var i = 0; i < all.length; i++) names.push(skUserName(all[i]));
  return skBack('← 내 스킬') + '<h2>' + esc(s.name) + '</h2>' + (s.description ? '<div class="meta">' + esc(s.description) + '</div>' : '')
    + '<div class="sk-box"><h3>이 스킬을 실행할 수 있는 사람</h3>' + skGrantEditor('mine', s.name, s.allowed, true)
    + (names.length ? '<p class="lock">내 모든 스킬을 실행할 수 있는 사람도 실행합니다: ' + esc(names.join(', ')) + '</p>' : '') + '</div>'
    + '<div class="sk-box"><h3>SKILL.md</h3>'
    + ((_skDetail ? _skDetail.isSingleFile === false : !s.isSingleFile) ? '<p class="lock">이 스킬에는 SKILL.md 말고 다른 파일도 있습니다. 여기서는 SKILL.md만 고칩니다.</p>' : '')
    + skContent('skSaveMine') + '</div>';
}
function skEnvDetail() {
  var s = skFindEnv(_skOpen.id);
  if (!s) return skBack('← 환경 스킬') + '<p class="lock">이 스킬은 더 이상 없습니다.</p>';
  var html = skBack('← 환경 스킬') + '<h2>' + esc(s.key) + '<span class="sk-badge">' + esc(skAccessLabel(s.access)) + '</span></h2>'
    + (s.description ? '<div class="meta">' + esc(s.description) + '</div>' : '');
  if (skIsAdmin()) {
    var all = _sk.env.allowAll || [];
    var names = [];
    for (var i = 0; i < all.length; i++) names.push(skUserName(all[i]));
    html += skEnvBanner() + '<div class="sk-box"><h3>이 스킬을 실행할 수 있는 사람</h3>' + skGrantEditor('env', s.key, s.allowed || [], skCanEditEnv())
      + (names.length ? '<p class="lock">모든 환경 스킬을 실행할 수 있는 사람도 실행합니다: ' + esc(names.join(', ')) + '</p>' : '') + '</div>';
  }
  if (s.access === 'none') {
    return html + '<div class="sk-banner" role="note"><span>이 스킬의 내용은 관리자가 허용한 사람만 볼 수 있습니다. 이 명령을 Slack에서 실행하면 관리자에게 승인 요청이 갑니다.</span><code>$' + esc(s.key) + '</code></div>';
  }
  // 1.b — an admin edits it in admin mode. The edit is this host's file: it lasts until the plugin's repo gets a new
  // commit (or an admin forces an update), when the repo's copy replaces it — said before the editor, not after.
  var edit = skCanEditEnv();
  return html + '<div class="sk-box"><h3>SKILL.md</h3>'
    + (edit ? '<p class="lock">여기서 고치면 이 서버의 파일이 바로 바뀌고, 다음 실행부터 쓰입니다. 환경 플러그인 저장소에 새 커밋이 생기거나 관리자가 강제로 업데이트하면 저장소의 내용으로 덮어씁니다. 계속 쓰려면 저장소에도 반영하세요.</p>'
      : skIsAdmin() ? '<p class="lock">관리자 모드를 켜면 여기서 고칠 수 있습니다.</p>' : '')
    + skContent(edit ? 'skSaveEnv' : '') + '</div>';
}
function skSystemDetail() {
  var html = skBack('← 시스템 스킬') + '<h2>' + esc(_skOpen.source + ':' + _skOpen.id) + '</h2>';
  if (_skDetail && _skDetail.description) html += '<div class="meta">' + esc(_skDetail.description) + '</div>';
  return html + '<div class="sk-box"><h3>SKILL.md</h3>' + skContent('') + '</div>';
}
function renderSkills() {
  var el = document.getElementById('sk-detail');
  if (!el || !_sk) return;
  // A redraw (a grant change, the admin-mode switch) keeps what is typed in the open skill's editor.
  var ta = document.getElementById('sk-edit');
  var draft = ta && _skOpen && ta.getAttribute('data-name') === _skOpen.id ? ta.value : null;
  var html;
  if (_skOpen && _skOpen.section === 'mine') html = skMineDetail();
  else if (_skOpen && _skOpen.section === 'env') html = skEnvDetail();
  else if (_skOpen) html = skSystemDetail();
  else if (_skSection === 'env') html = skEnvList();
  else if (_skSection === 'system') html = skSystemList();
  else html = skMineList();
  el.innerHTML = html;
  var again = draft === null ? null : document.getElementById('sk-edit');
  if (again) again.value = draft;
}
function skDetailUrl(section, id, source) {
  if (section === 'mine') return '/api/skills/mine/' + encodeURIComponent(id);
  if (section === 'system') return '/api/skills/system/' + encodeURIComponent(source) + '/' + encodeURIComponent(id);
  var s = skFindEnv(id);
  return s && s.access !== 'none' ? '/api/skills/env/' + encodeURIComponent(id) : null;
}
function skOpenRow(btn) {
  return skOpen(btn.getAttribute('data-sec'), btn.getAttribute('data-id'), btn.getAttribute('data-src'));
}
async function skOpen(section, id, source) {
  var open = { section: section, id: id, source: source || '' };
  _skOpen = open;
  _skDetail = null;
  _skDetailError = '';
  renderSkills();
  var url = skDetailUrl(section, id, source);
  if (!url) return;
  var res = null;
  var data = null;
  try {
    res = await fetch(url);
    try { data = await res.json(); } catch (_e) {}
  } catch (_e) {}
  // Another skill was opened meanwhile: this answer is not for the page any more.
  if (_skOpen !== open) return;
  if (!res || !res.ok) _skDetailError = (data && data.error) || '스킬 내용을 불러오지 못했습니다.';
  else _skDetail = data;
  renderSkills();
}
function skBackToList() {
  _skOpen = null;
  _skDetail = null;
  renderSkills();
}
async function skSaveMine() {
  var ta = document.getElementById('sk-edit');
  if (!ta || !_skOpen || !_skDetail) return false;
  var content = ta.value;
  if (!content.trim()) { skStatus('비어 있는 스킬은 저장할 수 없습니다', true); return false; }
  var r;
  try { r = await apiWrite('PUT', '/api/skills/mine/' + encodeURIComponent(_skOpen.id), { content: content, hash: _skDetail.hash }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (r.ok) {
    _skDetail = r.data.skill;
    var list = (_sk.mine && _sk.mine.skills) || [];
    for (var i = 0; i < list.length; i++) if (list[i].name === _skDetail.name) list[i].description = _skDetail.description;
    renderSkills();
    skStatus('저장했습니다', false);
    return true;
  }
  // The draft stays in the editor: nothing is lost, and nothing overwrites the other change blind.
  if (r.status === 409) skStatus('그사이 다른 곳에서 이 스킬이 바뀌어 저장하지 않았습니다. 작성하던 내용을 복사해 두고 스킬을 다시 여세요.', true);
  else skStatus('저장하지 못했습니다: ' + r.error, true);
  return false;
}
// 1.b — an admin saves an environment skill (PUT /api/skills/env/:key, admin mode; the server checks again).
async function skSaveEnv() {
  var ta = document.getElementById('sk-edit');
  if (!ta || !_skOpen || !_skDetail) return false;
  var content = ta.value;
  if (!content.trim()) { skStatus('비어 있는 스킬은 저장할 수 없습니다', true); return false; }
  var r;
  try { r = await apiWrite('PUT', '/api/skills/env/' + encodeURIComponent(_skOpen.id), { content: content, hash: _skDetail.hash }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (r.ok) {
    _skDetail = r.data.skill;
    var s = skFindEnv(_skOpen.id);
    if (s) s.description = _skDetail.description;
    renderSkills();
    skStatus('저장했습니다', false);
    return true;
  }
  if (r.status === 409) skStatus('그사이 다른 곳에서 이 스킬이 바뀌어 저장하지 않았습니다. 작성하던 내용을 복사해 두고 스킬을 다시 여세요.', true);
  else skStatus((r.status === 403 ? '권한이 없습니다: ' : '저장하지 못했습니다: ') + r.error, true);
  return false;
}
async function skSetGrant(scope, skill, userId, allow) {
  var r;
  try { r = await apiWrite('POST', '/api/skills/grants', { scope: scope, skill: skill, userId: userId, allow: allow }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (!r.ok) {
    skStatus((r.status === 403 ? '권한이 없습니다: ' : '저장하지 못했습니다: ') + r.error, true);
    return false;
  }
  if (scope === 'mine') _sk.mine = r.data.mine;
  else _sk.env = r.data.env;
  renderSkills();
  skStatus(allow ? '허용했습니다' : '권한을 거뒀습니다', false);
  return true;
}
function skAddGrant(btn) {
  var skill = btn.getAttribute('data-skill') || null;
  var sel = document.getElementById(skPickId(btn.getAttribute('data-scope'), skill));
  if (!sel || !sel.value) return;
  return skSetGrant(btn.getAttribute('data-scope'), skill, sel.value, true);
}
function skRemoveGrant(btn) {
  return skSetGrant(btn.getAttribute('data-scope'), btn.getAttribute('data-skill') || null, btn.getAttribute('data-user'), false);
}
`;
