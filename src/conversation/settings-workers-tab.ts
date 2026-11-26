/**
 * The settings page "작업 워커" tab — the machines soma-work runs tasks on (the process monitor's nodes, ADR 0003)
 * and the nickname each is read by. Today it is the node this soma-work runs on; worker nodes added later are listed
 * the same way. A nickname replaces the node id on the task card's node badge and the 프로세스 tab (the id stays in
 * their tooltip): a long host name can read as a short one.
 *
 * Admins only (the tab is `adminOnly`; `workers-routes.ts` refuses everyone else). Renaming needs admin mode.
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte).
 */

export const WORKERS_TAB_HTML = `<div slot="workers" data-tab="workers" class="page" hidden>
  <aside class="side" aria-label="작업 워커 영역">
    <input type="search" class="ui-input" id="wk-filter" placeholder="이름 검색" aria-label="이름 검색" oninput="renderWorkers()">
  </aside>
  <main>
    <p class="intro">작업(Claude Code)이 돌아가는 머신입니다. 지금은 이 soma-work가 설치된 노드 하나이고, 워커를 더 붙이면 여기에 함께 나옵니다.</p>
    <div id="wk-status" class="status" role="status" aria-live="polite"></div>
    <div id="wk-body"><div class="notice">불러오는 중…</div></div>
  </main>
</div>`;

export const WORKERS_TAB_CSS = `
.wk-banner { font-size: 13px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); margin-bottom: 12px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.wk-rows { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.wk-row { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.wk-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.wk-name { font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.wk-id { font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.wk-facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; margin: 0; }
.wk-facts dt { color: var(--text-secondary); }
.wk-facts dd { margin: 0; font-variant-numeric: tabular-nums; }
.wk-edit { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.wk-edit .ui-input { flex: 1; min-width: 140px; }
.wk-edit .btn { font-size: 13px; }
`;

export const WORKERS_CLIENT_JS = String.raw`
var _wk = null;            // GET /api/settings/workers
var _wkLoaded = false;
var _wkBusy = {};          // nodeId → a rename on its way

function wkStatus(text, isError) {
  var el = document.getElementById('wk-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (text ? (isError ? ' is-error' : ' is-ok') : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
}
function wkPlatform(p) {
  return p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : String(p || '알 수 없음');
}
function wkBytes(n) {
  var gb = (Number(n) || 0) / 1073741824;
  return (gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10) + 'GB';
}
function wkCpu(p) {
  return p === null || p === undefined ? '측정 중' : Math.round(Number(p) || 0) + '%';
}
function wkRow(w, editable) {
  var max = (_wk && _wk.maxNickname) || 24;
  var id = escAttr(w.nodeId);
  var used = Math.max(0, (Number(w.totalMemBytes) || 0) - (Number(w.availableMemBytes) || 0));
  var head = '<div class="wk-head"><span class="wk-name">' + esc(w.name) + '</span>'
    + (w.nickname ? '<span class="wk-id">' + esc(w.nodeId) + '</span>' : '')
    + (w.self ? '<span class="ui-chip is-sm">이 soma-work</span>' : '') + '</div>';
  var facts = '<dl class="wk-facts">'
    + '<dt>플랫폼</dt><dd>' + esc(wkPlatform(w.platform)) + '</dd>'
    + '<dt>코어</dt><dd>' + (Number(w.cpuCount) || 0) + '개' + (w.cpuBusyPercent === null || w.cpuBusyPercent === undefined ? '' : ' · 사용 중 ' + esc(wkCpu(w.cpuBusyPercent))) + '</dd>'
    + '<dt>메모리</dt><dd>' + esc(wkBytes(used)) + ' / ' + esc(wkBytes(w.totalMemBytes)) + ' 사용</dd>'
    + '<dt>지금</dt><dd>작업 ' + (Number(w.tasks) || 0) + '개 · 프로세스 ' + (Number(w.processes) || 0) + '개</dd>'
    + '</dl>';
  var busy = !!_wkBusy[w.nodeId];
  var off = !editable || busy ? ' disabled' : '';
  var edit = '<form class="wk-edit" data-node="' + id + '" onsubmit="wkSubmit(event, this)">'
    + '<input type="text" class="ui-input" name="nickname" maxlength="' + max + '" value="' + escAttr(w.nickname || '') + '"'
    + ' placeholder="' + id + '" aria-label="' + escAttr(w.nodeId + ' 닉네임') + '"' + off + '>'
    + '<button type="submit" class="btn btn-primary"' + off + '>저장</button>'
    + (w.nickname ? '<button type="button" class="btn" onclick="wkReset(this)" data-node="' + id + '"' + off + '>노드 이름으로</button>' : '')
    + '</form>';
  return '<li class="wk-row">' + head + facts + edit + '</li>';
}
function wkBanner() {
  if (!adminModeOn()) {
    return '<div class="wk-banner" role="note"><span>닉네임을 바꾸려면 관리자 모드를 켜세요. 대시보드 막대의 관리자 모드와 같은 스위치입니다.</span>'
      + '<button type="button" class="btn" onclick="wkSetAdminMode(true)">관리자 모드 켜기</button></div>';
  }
  return '';
}
function wkSetAdminMode(on) {
  try { localStorage.setItem('soma_admin_mode', on ? 'on' : 'off'); } catch (_e) {}
  renderWorkers();
}
async function loadWorkers() {
  var el = document.getElementById('wk-body');
  try {
    var res = await fetch('/api/settings/workers');
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) {
      el.innerHTML = '<div class="notice is-error" role="alert">' + esc((data && data.error) || ('작업 워커를 불러오지 못했습니다 (HTTP ' + res.status + ')')) + '</div>';
      return;
    }
    _wk = data;
    _wkLoaded = true;
    renderWorkers();
  } catch (_e) {
    el.innerHTML = '<div class="notice is-error" role="alert">작업 워커를 불러오지 못했습니다. 다시 시도하세요.</div>';
  }
}
function renderWorkers() {
  var el = document.getElementById('wk-body');
  if (!el || !_wk) return;
  var all = _wk.workers || [];
  var q = ((document.getElementById('wk-filter') || {}).value || '').toLowerCase().trim();
  var workers = all.filter(function(w) {
    return !q || String(w.name || '').toLowerCase().indexOf(q) >= 0 || String(w.nodeId || '').toLowerCase().indexOf(q) >= 0;
  });
  // The admin-mode banner over the card; the card's head says how many and what a nickname does (groupCard).
  el.innerHTML = wkBanner() + groupCard('작업 워커', all.length + '대 — 닉네임을 정하면 작업 카드의 노드 배지와 프로세스 탭에 노드 이름 대신 닉네임이 나옵니다. 노드 이름은 배지의 툴팁에 남습니다.',
    workers.length
      ? '<ul class="wk-rows">' + workers.map(function(w) { return wkRow(w, adminModeOn()); }).join('') + '</ul>'
      : all.length
        ? '<p class="lock">찾는 이름의 작업 워커가 없습니다.</p>'
        : '<p class="lock">작업 워커가 없습니다 — 이 인스턴스에서 프로세스 모니터가 꺼져 있어요.</p>');
}
function wkSubmit(e, form) {
  if (e && e.preventDefault) e.preventDefault();
  var input = form.querySelector('input[name="nickname"]');
  var value = input ? String(input.value || '').trim() : '';
  wkRename(form.getAttribute('data-node'), value ? value : null);
}
function wkReset(btn) {
  wkRename(btn.getAttribute('data-node'), null);
}
async function wkRename(nodeId, nickname) {
  if (!nodeId || _wkBusy[nodeId]) return;
  _wkBusy[nodeId] = true;
  renderWorkers();
  var r;
  try {
    r = await apiWrite('PUT', '/api/settings/workers/' + encodeURIComponent(nodeId) + '/nickname', { nickname: nickname });
  } catch (_e) {
    // The request itself failed (network, a restarting server): the field comes back and says so.
    r = { ok: false, error: '연결 오류 — 다시 시도하세요' };
  } finally {
    delete _wkBusy[nodeId];
  }
  if (r.ok && r.data && r.data.worker && _wk && _wk.workers) {
    for (var i = 0; i < _wk.workers.length; i++) if (_wk.workers[i].nodeId === nodeId) _wk.workers[i] = r.data.worker;
  }
  renderWorkers();
  if (!r.ok) {
    wkStatus(nodeId + ' 닉네임을 저장하지 못했습니다 — ' + r.error, true);
    return;
  }
  wkStatus(nickname === null
    ? nodeId + ': 닉네임을 지웠습니다 — 노드 이름으로 나옵니다'
    : nodeId + ': 닉네임을 ' + nickname + '(으)로 저장했습니다 — 작업 카드에는 몇 초 안에 반영됩니다');
}
`;
