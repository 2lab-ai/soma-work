/**
 * The settings page "서버 도구" tab (secret-access WU3, #1339, `.prd/32-secret-access-spec.md` §4.3) — every
 * server-tools tool and who may use it, edited where each rule lives:
 *
 *   - a tool's level (`config.json` `server-tools.permission`: read · write · 표에 없음). Admin-only tools are
 *     fixed in code and shown locked. Without a map at all the tab says server-tools is open to everyone (#1170)
 *     and offers "표 만들기" (every tool at its default level) before any level can be picked;
 *   - the server-tools grants (`mcp-tool-grants.json`: a user, read or write, for up to 4 weeks);
 *   - each server: its sections, the tools that run there, the secrets it uses (a missing one warned) and, on an
 *     environment's server, who holds that environment's grant.
 *
 * Shown to admins only (`adminOnly`); `server-tools-routes.ts` refuses everyone else anyway. Changes need admin mode.
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte). Uses `scWhen` of the 비밀 tab.
 */

export const SERVER_TOOLS_TAB_HTML = `<div slot="server-tools" data-tab="server-tools" class="page" hidden>
  <aside class="side" aria-label="서버 도구 영역">
    <input type="search" class="ui-input" id="st-filter" placeholder="도구 · 서버 이름 검색" aria-label="도구 · 서버 이름 검색" oninput="renderServerTools()">
  </aside>
  <main>
    <p class="intro">server-tools의 모든 도구와 서버입니다. 관리자가 아닌 사람의 호출은 셋 중 하나가 열어 줍니다 — 그 서버의 환경 허락, 도구 수준 이상의 server-tools 허락(기간제), 또는 그 호출이 쓰는 비밀이 모두 허락됨(비밀 탭). 관리자 전용 도구는 환경 허락이나 비밀 허락으로만 열립니다. 모델은 어떤 비밀도 보지 못합니다.</p>
    <div id="st-status" class="status" role="status" aria-live="polite"></div>
    <div id="st-body"><div class="notice">불러오는 중…</div></div>
  </main>
</div>`;

export const SERVER_TOOLS_TAB_CSS = `
#st-body h3 { font-size: 13px; font-weight: 650; margin-bottom: 8px; }
#st-body .meta { font-size: 12px; color: var(--text-secondary); margin: 4px 0 12px; }
.st-rows { list-style: none; }
.st-row { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 8px 0; border-top: 1px solid var(--border); }
.st-row:first-child { border-top: 0; }
.st-row > div:first-child { flex: 1 1 auto; min-width: 0; }
.st-name { font-family: var(--mono); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.st-sub { display: block; font-size: 12px; color: var(--text-secondary); margin-top: 2px; overflow-wrap: anywhere; }
.st-warn { color: var(--tint-fail-fg); }
.st-level { flex: none; min-width: 168px; text-align: right; font-size: 12px; }
.st-line, .st-chips { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.st-chips { margin-top: 6px; }
.st-chips .lbl { font-size: 12px; color: var(--text-secondary); }
.st-chips .chip:not(:has(button)) { padding-right: 10px; }
.st-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.st-cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.st-banner { font-size: 13px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); margin-bottom: 12px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.st-banner.is-warn { border-color: var(--tint-fail-fg); }
`;

export const SERVER_TOOLS_CLIENT_JS = String.raw`
var _st = null;            // GET /api/server-tools
var _stLoaded = false;

function stStatus(text, isError) {
  var el = document.getElementById('st-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (text ? (isError ? ' is-error' : ' is-ok') : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
}
async function loadServerTools() {
  var el = document.getElementById('st-body');
  try {
    var res = await fetch('/api/server-tools');
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok || !data || !Array.isArray(data.tools) || !Array.isArray(data.servers) || !Array.isArray(data.toolGrants)) {
      // Not loaded: the next time the tab is shown it asks again.
      el.innerHTML = '<div class="notice is-error" role="alert">' + esc((data && data.error) || ('서버 도구를 불러오지 못했습니다 (HTTP ' + res.status + ')')) + '</div>';
      return;
    }
    _st = data;
    _stLoaded = true;
    renderServerTools();
  } catch (_e) {
    el.innerHTML = '<div class="notice is-error" role="alert">서버 도구를 불러오지 못했습니다. 다시 시도하세요.</div>';
  }
}
// A change that was made but not written to the audit ledger says so (the server answers ok with a warning).
function stOk(text, data) {
  var warning = data && data.warning;
  stStatus(text + (warning ? ' — ' + warning : ''), !!warning);
}
function stUserName(id) {
  var users = (_st && _st.users) || [];
  for (var i = 0; i < users.length; i++) if (users[i].id === id) return users[i].name;
  return id;
}
function stAccessText(access) {
  if (access === 'read') return '읽기';
  if (access === 'write') return '쓰기';
  return '읽기 · 쓰기(인자에 따라)';
}
// The level a non-admin needs: read (a read or write grant), write (a write grant), or 표에 없음 (admins only).
function stLevelCell(t, editable, mapPresent) {
  if (t.adminOnly) return '<span class="st-level lock">관리자 전용 — 코드에 정해짐</span>';
  if (!mapPresent) return '<span class="st-level st-warn">표 없음 — 모두에게 열림</span>';
  var label = t.level === 'read' ? 'read — 읽기 허락 이상' : t.level === 'write' ? 'write — 쓰기 허락' : '표에 없음 — 관리자만';
  if (!editable) return '<span class="st-level">' + esc(label) + '</span>';
  var opts = [['read', 'read — 읽기 허락 이상'], ['write', 'write — 쓰기 허락'], ['', '표에 없음 — 관리자만']];
  var html = '<select class="ui-input st-level" data-tool="' + escAttr(t.name) + '" aria-label="' + escAttr(t.name + ' 수준') + '" onchange="stSetLevel(this)">';
  for (var i = 0; i < opts.length; i++) {
    var on = (t.level || '') === opts[i][0] ? ' selected' : '';
    html += '<option value="' + opts[i][0] + '"' + on + '>' + esc(opts[i][1]) + '</option>';
  }
  return html + '</select>';
}
function stToolRow(t, editable, mapPresent) {
  var where = t.sections && t.sections.length ? t.sections.join(' · ') : '절 없음';
  return '<li class="st-row"><div><span class="st-name">' + esc(t.name) + '</span>'
    + '<span class="st-sub">' + esc(t.summary) + '</span>'
    + '<span class="st-sub">' + esc(stAccessText(t.access) + ' · 필요한 절: ' + where) + '</span></div>'
    + stLevelCell(t, editable, mapPresent) + '</li>';
}
function stGrantRow(g, editable) {
  var html = '<li class="st-row"><div><span class="st-name">' + esc(stUserName(g.userId)) + '</span>'
    + '<span class="st-sub">' + esc(g.level + ' · ' + scWhen(g.expiresAt) + '까지 · 허락한 사람 ' + stUserName(g.grantedBy)) + '</span></div>';
  if (editable) {
    html += '<div class="st-line"><button type="button" class="btn danger" data-user="' + escAttr(g.userId) + '" data-level="' + escAttr(g.level)
      + '" onclick="stRevokeGrant(this)">거두기</button></div>';
  }
  return html + '</li>';
}
function stGrantForm() {
  var users = (_st && _st.users) || [];
  var opts = '';
  for (var i = 0; i < users.length; i++) opts += '<option value="' + escAttr(users[i].id) + '">' + esc(users[i].name) + '</option>';
  return '<div class="st-line" style="margin-top:8px">'
    + '<select class="ui-input" id="st-grant-user" aria-label="허락할 사람"><option value="">사람 선택…</option>' + opts + '</select>'
    + '<select class="ui-input" id="st-grant-level" aria-label="허락 수준"><option value="read">read</option><option value="write">write</option></select>'
    + '<select class="ui-input" id="st-grant-duration" aria-label="기간"><option value="24h">24시간</option><option value="7d" selected>7일</option><option value="4w">4주</option></select>'
    + '<button type="button" class="btn" onclick="stAddGrant()">허락</button></div>';
}
function stEnvChips(s, editable) {
  var html = '<div class="st-chips"><span class="lbl">' + esc(String(s.envUser).replace(/^env:/, '')) + ' 환경 허락:</span>';
  var list = s.environmentUsers || [];
  for (var i = 0; i < list.length; i++) {
    var label = stUserName(list[i]);
    html += '<span class="chip">' + esc(label) + (editable ? '<button type="button" aria-label="' + escAttr(label + ' 빼기') + '" data-env="' + escAttr(s.envUser)
      + '" data-server="' + escAttr(s.name) + '" data-user="' + escAttr(list[i]) + '" onclick="stRemoveEnvUser(this)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>' : '') + '</span>';
  }
  if (!list.length) html += '<span class="lock">없음</span>';
  html += '</div>';
  if (editable) {
    var users = (_st && _st.users) || [];
    var opts = '';
    for (var u = 0; u < users.length; u++) {
      if (list.indexOf(users[u].id) >= 0) continue;
      opts += '<option value="' + escAttr(users[u].id) + '">' + esc(users[u].name) + '</option>';
    }
    var off = opts ? '' : ' disabled';
    html += '<div class="st-line" style="margin-top:6px"><select class="ui-input" id="' + escAttr('st-env-pick-' + s.name) + '" aria-label="' + escAttr(s.name + ' 환경을 허락할 사람') + '"' + off + '><option value="">사람 선택…</option>' + opts + '</select>'
      + '<button type="button" class="btn" data-env="' + escAttr(s.envUser) + '" data-server="' + escAttr(s.name) + '" onclick="stAddEnvUser(this)"' + off + '>추가</button></div>';
  }
  return html;
}
function stServerCard(s, editable) {
  var html = '<div class="st-card"><span class="st-name">' + esc(s.name) + '</span>'
    + '<span class="st-sub">' + esc(s.envUser ? '환경 ' + String(s.envUser).replace(/^env:/, '') + '의 서버' : '환경 없음 — 관리자 · 허락받은 사람의 서버') + '</span>'
    + '<span class="st-sub">절: ' + esc(s.sections && s.sections.length ? s.sections.join(' · ') : '없음') + '</span>'
    + '<span class="st-sub">여기서 도는 도구: ' + esc(s.tools && s.tools.length ? s.tools.join(', ') : '없음') + '</span>';
  var secrets = s.secrets || [];
  for (var i = 0; i < secrets.length; i++) {
    var x = secrets[i];
    html += '<span class="st-sub' + (x.exists ? '' : ' st-warn') + '">' + (x.exists ? '' : '⚠️ ') + '비밀 ' + esc(x.name) + ' › ' + esc(x.path)
      + (x.exists ? '' : ' — 저장소에 없어 이 절이 빠져 있습니다') + '</span>';
  }
  if (s.envUser) html += stEnvChips(s, editable);
  return html + '</div>';
}
function stBanner() {
  if (!adminModeOn()) {
    return '<div class="st-banner" role="note"><span>수준이나 허락을 바꾸려면 관리자 모드를 켜세요. 대시보드 막대의 관리자 모드와 같은 스위치입니다.</span>'
      + '<button type="button" class="btn" onclick="scSetAdminMode(true);renderServerTools()">관리자 모드 켜기</button></div>';
  }
  return '<div class="st-banner" role="note"><span>관리자 모드 — 바꾸면 바로 적용되고 감사 기록에 남습니다.</span>'
    + '<button type="button" class="btn" onclick="scSetAdminMode(false);renderServerTools()">관리자 모드 끄기</button></div>';
}
function stFilterText() {
  return ((document.getElementById('st-filter') || {}).value || '').toLowerCase().trim();
}
function renderServerTools() {
  var el = document.getElementById('st-body');
  if (!el || !_st) return;
  var editable = adminModeOn();
  var mapPresent = _st.permissionMap === 'present';
  var q = stFilterText();
  var html = stBanner();
  if (!mapPresent) {
    html += '<div class="st-banner is-warn" role="alert"><span>⚠️ 권한 표(server-tools.permission)가 없어 server-tools가 모든 유저에게 열려 있습니다(#1170). 표를 만들면 읽기 도구는 read, 쓰기 도구는 write가 되고 관리자 전용 도구는 그대로입니다.</span>'
      + (editable ? '<button type="button" class="btn primary" onclick="stCreateMap()">표 만들기</button>' : '') + '</div>';
  }
  var tools = '';
  for (var i = 0; i < _st.tools.length; i++) {
    if (!q || _st.tools[i].name.toLowerCase().indexOf(q) >= 0) tools += stToolRow(_st.tools[i], editable, mapPresent);
  }
  // Three cards, each with its head (groupCard): the tools, the server-tools grants, the servers.
  html += groupCard('도구', _st.tools.length + '개 — 수준은 config.json의 server-tools.permission에 저장됩니다.',
    tools ? '<ul class="st-rows">' + tools + '</ul>' : '<p class="lock">맞는 도구가 없습니다.</p>');
  var grants = '';
  for (var j = 0; j < _st.toolGrants.length; j++) grants += stGrantRow(_st.toolGrants[j], editable);
  html += groupCard('server-tools 허락', '기간제, 최대 4주 — ' + _st.toolGrants.length + '명',
    (grants ? '<ul class="st-rows">' + grants + '</ul>' : '<p class="lock">허락받은 사람이 없습니다.</p>')
    + (editable ? stGrantForm() : ''));
  var cards = '';
  for (var k = 0; k < _st.servers.length; k++) {
    var sv = _st.servers[k];
    var hit = !q || sv.name.toLowerCase().indexOf(q) >= 0 || (sv.tools || []).some(function (t) { return t.toLowerCase().indexOf(q) >= 0; });
    if (hit) cards += stServerCard(sv, editable);
  }
  html += groupCard('서버 · 환경', _st.servers.length + '개 — 서버마다 절, 여기서 도는 도구, 쓰는 비밀', cards ? '<div class="st-cards">' + cards + '</div>' : '<p class="lock">설정된 서버가 없습니다.</p>');
  el.innerHTML = html;
}
async function stSetLevel(sel) {
  var tool = sel.getAttribute('data-tool');
  var level = sel.value || null;
  var r = await apiWrite('PUT', '/api/server-tools/permission/' + encodeURIComponent(tool), { level: level });
  if (!r.ok) {
    stStatus((r.status === 403 ? '권한이 없습니다: ' : '바꾸지 못했습니다: ') + r.error, true);
    renderServerTools();
    return;
  }
  stOk(tool + ' 수준: ' + (level || '표에 없음(관리자만)'), r.data);
  await loadServerTools();
}
async function stCreateMap() {
  var ok = await confirmDialog({ title: '권한 표를 만들까요?', body: '읽기 도구는 read, 쓰기 도구는 write로 표가 생깁니다. 허락이 없는 사람은 그때부터 server-tools를 못 씁니다.', action: '표 만들기' });
  if (!ok) return;
  var r = await apiWrite('POST', '/api/server-tools/permission', {});
  if (!r.ok) {
    stStatus((r.status === 403 ? '권한이 없습니다: ' : '만들지 못했습니다: ') + r.error, true);
    return;
  }
  stOk('권한 표를 만들었습니다', r.data);
  await loadServerTools();
}
async function stAddGrant() {
  var user = (document.getElementById('st-grant-user') || {}).value || '';
  var level = (document.getElementById('st-grant-level') || {}).value || 'read';
  var duration = (document.getElementById('st-grant-duration') || {}).value || '7d';
  if (!user) {
    stStatus('허락할 사람을 고르세요', true);
    return;
  }
  var r = await apiWrite('POST', '/api/server-tools/grants', { userId: user, level: level, duration: duration });
  if (!r.ok) {
    stStatus((r.status === 403 ? '권한이 없습니다: ' : '허락하지 못했습니다: ') + r.error, true);
    return;
  }
  if (r.data && r.data.toolGrants) _st.toolGrants = r.data.toolGrants;
  stOk('허락했습니다: ' + stUserName(user) + ' — ' + level + ' · ' + duration, r.data);
  renderServerTools();
}
async function stRevokeGrant(btn) {
  var user = btn.getAttribute('data-user');
  var level = btn.getAttribute('data-level');
  var r = await apiWrite('DELETE', '/api/server-tools/grants/' + encodeURIComponent(user) + '/' + encodeURIComponent(level));
  if (!r.ok) {
    stStatus((r.status === 403 ? '권한이 없습니다: ' : '거두지 못했습니다: ') + r.error, true);
    return;
  }
  if (r.data && r.data.toolGrants) _st.toolGrants = r.data.toolGrants;
  stOk('거뒀습니다: ' + stUserName(user) + ' — ' + level, r.data);
  renderServerTools();
}
async function stEnvGrant(envId, server, userId, allow) {
  var r = await apiWrite('POST', '/api/server-tools/environments/' + encodeURIComponent(envId) + '/users', { userId: userId, allow: allow });
  if (!r.ok) {
    stStatus((r.status === 403 ? '권한이 없습니다: ' : '바꾸지 못했습니다: ') + r.error, true);
    return;
  }
  var list = (_st && _st.servers) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].envUser === envId && r.data && r.data.environmentUsers) list[i].environmentUsers = r.data.environmentUsers;
  }
  stOk((allow ? '환경을 허락했습니다: ' : '환경 허락을 뺐습니다: ') + stUserName(userId) + ' — ' + String(envId).replace(/^env:/, ''), r.data);
  renderServerTools();
}
async function stAddEnvUser(btn) {
  var server = btn.getAttribute('data-server');
  var pick = document.getElementById('st-env-pick-' + server);
  var userId = pick ? pick.value : '';
  if (!userId) {
    stStatus('허락할 사람을 고르세요', true);
    return;
  }
  await stEnvGrant(btn.getAttribute('data-env'), server, userId, true);
}
async function stRemoveEnvUser(btn) {
  await stEnvGrant(btn.getAttribute('data-env'), btn.getAttribute('data-server'), btn.getAttribute('data-user'), false);
}
`;
