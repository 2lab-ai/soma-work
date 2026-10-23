/**
 * The settings page "기억" tab (SSOT 2026-10-23 T3) — every personal memory,
 * viewable and editable:
 *   - 개인 메모리: 에이전트 노트 (MEMORY.md) and 사용자 프로필 (USER.md) — one row per
 *     entry, a capacity meter, add / edit / delete / clear;
 *   - 지식 페이지: the semantic pages (agent / sites / concepts / projects / cron)
 *     with Current and the whole History, all editable; create and delete;
 *   - 관찰 기록 (에피소딕): every day, its entries editable and deletable, notes added.
 *
 * UI decisions (research, SSOT T5): one row per entry, never the raw `§`
 * format; a meter with visible numbers; a single delete happens at once with
 * an undo, "모두 지우기" confirms and names the count; every edit is
 * conditional on the revision the tab loaded — a 409 reloads that part and
 * keeps the user's draft.
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte).
 */

export const MEMORY_TAB_HTML = `<div data-tab="memory" class="page" hidden>
  <aside class="side" aria-label="기억 섹션">
    <nav>
      <button type="button" class="navbtn" onclick="memJump('m-l1')">개인 메모리</button>
      <button type="button" class="navbtn" onclick="memJump('m-pages')">지식 페이지</button>
      <button type="button" class="navbtn" onclick="memJump('m-episodic')">관찰 기록 (에피소딕)</button>
    </nav>
  </aside>
  <main>
    <p class="intro">에이전트가 기억하는 내용입니다. 개인 메모리는 모든 세션의 시작 프롬프트에 들어가고, 지식 페이지는 목록만 들어가며 내용은 에이전트가 필요할 때 읽습니다. 관찰 기록은 턴마다 자동으로 쌓이는 날짜별 기록입니다. 고친 내용은 새 세션부터, 진행 중인 세션은 다음에 프롬프트를 다시 만들 때 반영됩니다.</p>
    <div id="mem-status" class="status" role="status" aria-live="polite"></div>
    <section class="group" id="m-l1" aria-labelledby="h-m-l1">
      <header><h2 id="h-m-l1">개인 메모리</h2><p>짧은 항목 목록입니다. 용량이 차면 에이전트가 새로 기억하지 못하니, 오래된 항목을 지우거나 합치세요.</p></header>
      <div id="mem-l1-body" class="l1-grid"><div class="notice">불러오는 중…</div></div>
    </section>
    <section class="group" id="m-pages" aria-labelledby="h-m-pages">
      <header><h2 id="h-m-pages">지식 페이지</h2><p>주제별로 오래 남길 지식입니다. Current는 지금의 이해, History는 날짜별 변경 기록입니다.</p></header>
      <div class="pages-grid">
        <div class="pages-list">
          <input type="search" id="mem-page-filter" placeholder="페이지 검색" aria-label="페이지 검색" oninput="paintPageList()">
          <div id="mem-page-list"></div>
          <button type="button" class="btn" onclick="newPageForm()">새 페이지</button>
        </div>
        <div class="pages-detail" id="mem-page-detail"><p class="lock">왼쪽에서 페이지를 고르세요.</p></div>
      </div>
    </section>
    <section class="group" id="m-episodic" aria-labelledby="h-m-episodic">
      <header><h2 id="h-m-episodic">관찰 기록 (에피소딕)</h2><p>날짜별 기록입니다. 잘못 남은 기록은 고치거나 지울 수 있습니다.</p></header>
      <div class="ep-bar">
        <label for="mem-ep-date">날짜</label>
        <select id="mem-ep-date" onchange="loadDay(this.value)"></select>
      </div>
      <div id="mem-ep-body"></div>
      <div class="ep-add">
        <label for="mem-ep-new">오늘 기록에 메모 추가</label>
        <textarea id="mem-ep-new" rows="3" placeholder="에이전트가 참고할 메모"></textarea>
        <button type="button" class="btn primary" onclick="epAdd()">추가</button>
      </div>
    </section>
  </main>
</div>`;

export const MEMORY_TAB_CSS = String.raw`
.navbtn { font: inherit; font-size: 13px; text-align: left; color: var(--text-secondary); background: none; border: 0; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
.navbtn:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.l1-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; padding: 16px; }
.l1-card h3 { font-size: 14px; }
.l1-card .sub { font-size: 12px; color: var(--text-secondary); }
.meter-line { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.meter-line meter { flex: 1; height: 8px; }
.meter-line.is-warn { color: var(--yellow); }
.meter-line.is-full { color: var(--red); }
.entries { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.entries li { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--surface-raised); }
.entries .text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.entries .actions { display: flex; gap: 8px; margin-top: 6px; }
textarea { width: 100%; font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 8px; resize: vertical; }
textarea:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.counter { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.counter.is-over { color: var(--red); }
.l1-add { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.l1-add .line { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.pages-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 16px; padding: 16px; }
.pages-list { display: flex; flex-direction: column; gap: 8px; }
.pages-list input { font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
.pages-list h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); margin-top: 6px; }
.pages-list .pg { display: block; width: 100%; text-align: left; font: inherit; font-size: 13px; color: var(--text); background: none; border: 0; border-radius: 6px; padding: 6px 8px; cursor: pointer; }
.pages-list .pg[aria-current="true"] { background: var(--surface-raised); font-weight: 700; }
.pages-detail .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.pages-detail .field label { font-size: 12px; font-weight: 700; }
.pages-detail .field input[type="text"] { font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
.pages-detail .hist { display: flex; gap: 6px; margin-bottom: 4px; }
.pages-detail .hist input { flex: 1; }
.pages-detail .meta { font-size: 11px; color: var(--text-tertiary); margin-bottom: 8px; }
.ep-bar { display: flex; gap: 8px; align-items: center; padding: 12px 16px 0; font-size: 13px; }
.ep-bar select { font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
#mem-ep-body { padding: 12px 16px; }
.ep-entry { border-top: 1px solid var(--border); padding: 10px 0; }
.ep-entry:first-child { border-top: 0; }
.ep-entry .when { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.ep-add { display: flex; flex-direction: column; gap: 6px; padding: 0 16px 16px; font-size: 12px; }
@media (max-width: 760px) { .pages-grid { grid-template-columns: minmax(0, 1fr); } }
`;

export const MEMORY_CLIENT_JS = String.raw`
var _mem = null;          // GET /api/memory
var _memLoaded = false;
var _memPage = null;      // { page, revision } open in the editor (revision null = new)
var _memDay = null;       // { date, revision, entries }
var _memUndo = null;      // { target, text } last single delete
var L1_LABELS = { memory: '에이전트 노트', user: '사용자 프로필' };
var L1_FILES = { memory: 'MEMORY.md', user: 'USER.md' };
var PAGE_GROUPS = [['agent', '에이전트'], ['sites', '사이트'], ['concepts', '개념'], ['project', '프로젝트'], ['cron', '반복 작업']];

function memJump(id) {
  var el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function memStatus(text, isError) {
  var el = document.getElementById('mem-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (text ? (isError ? ' is-error' : ' is-ok') : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
}
function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
async function loadMemory() {
  var body = document.getElementById('mem-l1-body');
  try {
    var res = await fetch('/api/memory');
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) {
      body.innerHTML = '<div class="notice is-error" role="alert">' + esc((data && data.error) || ('기억을 불러오지 못했습니다 (HTTP ' + res.status + ')')) + '</div>';
      return;
    }
    _mem = data;
    _memLoaded = true;
    paintL1();
    paintPageList();
    paintDates();
  } catch (_e) {
    body.innerHTML = '<div class="notice is-error" role="alert">기억을 불러오지 못했습니다. 다시 시도하세요.</div>';
  }
}

// ── 개인 메모리 (L1) ──
function renderL1Card(target, block, editing) {
  var pct = block.charLimit > 0 ? Math.round((block.totalChars / block.charLimit) * 100) : 0;
  var state = pct >= 100 ? ' is-full' : pct >= 80 ? ' is-warn' : '';
  var html = '<div class="l1-card" id="l1-' + target + '"><h3>' + esc(L1_LABELS[target]) + ' <span class="sub">' + esc(L1_FILES[target]) + '</span></h3>'
    + '<div class="meter-line' + state + '"><meter min="0" max="' + block.charLimit + '" low="' + Math.round(block.charLimit * 0.8) + '" high="' + Math.round(block.charLimit * 0.95) + '" optimum="0" value="' + block.totalChars + '" aria-label="' + escAttr(L1_LABELS[target] + ' 사용량') + '"></meter>'
    + '<span>' + fmtNum(block.totalChars) + ' / ' + fmtNum(block.charLimit) + '자' + (pct >= 100 ? ' · 가득 참' : '') + '</span></div>';
  var entries = block.entries || [];
  if (!entries.length) html += '<p class="lock">아직 항목이 없습니다. Slack에서 "기억해줘"라고 하거나 아래에서 추가하세요.</p>';
  html += '<ol class="entries">';
  for (var i = 0; i < entries.length; i++) {
    if (editing && editing.index === i) {
      html += '<li><textarea id="l1-edit-' + target + '" rows="3" aria-label="' + escAttr(L1_LABELS[target] + ' ' + (i + 1) + '번 수정') + '">' + esc(editing.text) + '</textarea>'
        + '<div class="actions"><button type="button" class="btn primary" onclick="l1Save(\'' + target + '\',' + i + ')">저장</button>'
        + '<button type="button" class="btn" onclick="paintL1()">취소</button></div></li>';
    } else {
      html += '<li><div class="text">' + esc(entries[i]) + '</div><div class="actions">'
        + '<button type="button" class="btn link" onclick="l1EditStart(\'' + target + '\',' + i + ')">수정</button>'
        + '<button type="button" class="btn link" onclick="l1Delete(\'' + target + '\',' + i + ')">삭제</button></div></li>';
    }
  }
  html += '</ol>';
  if (_memUndo && _memUndo.target === target) {
    html += '<p class="status is-ok">삭제했습니다. <button type="button" class="btn link" onclick="l1Undo()">되돌리기</button></p>';
  }
  html += '<div class="l1-add"><label class="lock" for="l1-new-' + target + '">새 항목 (한 항목 최대 ' + fmtNum(block.perEntryCap) + '자)</label>'
    + '<textarea id="l1-new-' + target + '" rows="2" oninput="l1Count(\'' + target + '\')"></textarea>'
    + '<div class="line"><span class="counter" id="l1-count-' + target + '">추가하면 ' + fmtNum(block.totalChars) + ' / ' + fmtNum(block.charLimit) + '자</span>'
    + '<span><button type="button" class="btn primary" onclick="l1Add(\'' + target + '\')">추가</button> '
    + (entries.length ? '<button type="button" class="btn" onclick="l1Clear(\'' + target + '\')">모두 지우기</button>' : '') + '</span></div></div></div>';
  return html;
}
function paintL1(editing) {
  if (!_mem) return;
  var html = '';
  var targets = ['memory', 'user'];
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    html += renderL1Card(t, _mem.l1[t], editing && editing.target === t ? editing : null);
  }
  document.getElementById('mem-l1-body').innerHTML = html;
}
// Live total after the addition (the store joins entries with a 3-char delimiter).
function l1Count(target) {
  var block = _mem.l1[target];
  var v = (document.getElementById('l1-new-' + target) || {}).value || '';
  var add = v.trim().length ? v.trim().length + (block.entries.length ? 3 : 0) : 0;
  var total = block.totalChars + add;
  var el = document.getElementById('l1-count-' + target);
  if (!el) return;
  var over = total > block.charLimit ? total - block.charLimit : 0;
  var long = v.trim().length > block.perEntryCap;
  el.textContent = '추가하면 ' + fmtNum(total) + ' / ' + fmtNum(block.charLimit) + '자' + (over ? ' — ' + fmtNum(over) + '자 초과' : '') + (long ? ' — 한 항목 한도 초과' : '');
  el.className = 'counter' + (over || long ? ' is-over' : '');
}
// One L1 write. A 409 reloads the stores and puts the WHOLE draft back in an
// edit box — the entry it was for when it still exists, else the add box —
// so nothing typed is lost (review P1).
async function l1Write(method, url, payload, draft, at) {
  var r;
  try { r = await apiWrite(method, url, payload); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  var target = url.split('/')[4];
  if (r.ok) {
    _mem.l1[target] = r.data.l1;
    paintL1();
    return true;
  }
  if (r.status === 409) {
    await loadMemory();
    restoreL1Draft(target, draft, at);
    memStatus('그사이 다른 곳(에이전트·Slack)에서 바뀌어 최신 내용을 불러왔습니다.' + (draft ? ' 작성하던 내용은 편집 칸에 그대로 있습니다 — 확인하고 다시 저장하세요.' : ' 다시 적용하세요.'), true);
    return false;
  }
  memStatus('저장하지 못했습니다: ' + r.error, true);
  return false;
}
function restoreL1Draft(target, draft, at) {
  if (!draft) return;
  var entries = (_mem && _mem.l1[target] && _mem.l1[target].entries) || [];
  if (typeof at === 'number' && at >= 0 && at < entries.length) {
    paintL1({ target: target, index: at, text: draft });
    return;
  }
  var ta = document.getElementById('l1-new-' + target);
  if (ta) ta.value = draft;
}
function l1EditStart(target, i) {
  paintL1({ target: target, index: i, text: _mem.l1[target].entries[i] });
  var ta = document.getElementById('l1-edit-' + target);
  if (ta) ta.focus();
}
async function l1Save(target, i) {
  var ta = document.getElementById('l1-edit-' + target);
  var text = ta ? ta.value : '';
  if (!text.trim()) { memStatus('비어 있는 항목은 저장할 수 없습니다 — 지우려면 삭제를 쓰세요', true); return; }
  if (await l1Write('PUT', '/api/memory/l1/' + target + '/' + i, { text: text, revision: _mem.l1[target].revision }, text, i)) memStatus('저장했습니다', false);
}
async function l1Add(target) {
  var ta = document.getElementById('l1-new-' + target);
  var text = ta ? ta.value : '';
  if (!text.trim()) return;
  if (await l1Write('POST', '/api/memory/l1/' + target, { text: text, revision: _mem.l1[target].revision }, text)) memStatus('추가했습니다', false);
}
async function l1Delete(target, i) {
  var text = _mem.l1[target].entries[i];
  if (await l1Write('DELETE', '/api/memory/l1/' + target + '/' + i, { revision: _mem.l1[target].revision })) {
    _memUndo = { target: target, text: text };
    paintL1();
  }
}
async function l1Undo() {
  var u = _memUndo;
  if (!u) return;
  _memUndo = null;
  if (await l1Write('POST', '/api/memory/l1/' + u.target, { text: u.text, revision: _mem.l1[u.target].revision }, u.text)) memStatus('되돌렸습니다 (목록 끝에 다시 추가)', false);
}
async function l1Clear(target) {
  var n = _mem.l1[target].entries.length;
  var ok = await confirmDialog({ title: L1_LABELS[target] + ' 항목 ' + n + '개를 모두 지울까요?', body: '되돌릴 수 없습니다. 에이전트는 다음 세션부터 이 내용을 모릅니다.', action: n + '개 모두 지우기' });
  if (!ok) return;
  if (await l1Write('DELETE', '/api/memory/l1/' + target, { revision: _mem.l1[target].revision })) memStatus('모두 지웠습니다', false);
}

// ── 지식 페이지 ──
function paintPageList() {
  if (!_mem) return;
  var q = ((document.getElementById('mem-page-filter') || {}).value || '').toLowerCase().trim();
  var pages = _mem.pages || [];
  var html = '';
  for (var g = 0; g < PAGE_GROUPS.length; g++) {
    var type = PAGE_GROUPS[g][0];
    var inGroup = pages.filter(function (p) {
      return p.type === type && (!q || (p.id + ' ' + p.title + ' ' + (p.aliases || []).join(' ')).toLowerCase().indexOf(q) >= 0);
    });
    if (!inGroup.length) continue;
    html += '<h4>' + esc(PAGE_GROUPS[g][1]) + ' (' + inGroup.length + ')</h4>';
    for (var i = 0; i < inGroup.length; i++) {
      var p = inGroup[i];
      var cur = _memPage && _memPage.page && _memPage.page.id === p.id;
      html += '<button type="button" class="pg" data-id="' + escAttr(p.id) + '" aria-current="' + (cur ? 'true' : 'false') + '" onclick="openPage(this.getAttribute(\'data-id\'))">'
        + esc(p.title) + ' <span class="lock">' + esc(p.id) + '</span></button>';
    }
  }
  document.getElementById('mem-page-list').innerHTML = html || '<p class="lock">' + (q ? '맞는 페이지가 없습니다.' : '아직 페이지가 없습니다. 에이전트가 오래 남길 지식을 정리하면 여기에 생깁니다.') + '</p>';
}
async function openPage(id) {
  var res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  if (!res.ok) { memStatus('페이지를 열지 못했습니다: ' + ((data && data.error) || res.status), true); return; }
  _memPage = data;
  _memPageConflict = null;
  renderPageEditor();
  paintPageList();
}
function renderPageEditor() {
  var el = document.getElementById('mem-page-detail');
  if (!_memPage) { el.innerHTML = '<p class="lock">왼쪽에서 페이지를 고르세요.</p>'; return; }
  var p = _memPage.page;
  var isNew = _memPage.revision === null;
  var html = '<div id="pg-conflict"></div><div class="meta">' + (isNew ? '새 페이지' : esc(p.id) + ' · 마지막 수정 ' + esc(p.updated)) + '</div>';
  if (isNew) {
    var opts = '';
    for (var g = 0; g < PAGE_GROUPS.length; g++) opts += '<option value="' + PAGE_GROUPS[g][0] + '">' + esc(PAGE_GROUPS[g][1] + ' (' + PAGE_GROUPS[g][0] + ')') + '</option>';
    html += '<div class="field"><label for="pg-type">종류</label><select id="pg-type">' + opts + '</select></div>'
      + '<div class="field"><label for="pg-name">이름 (영문·숫자·-·_ · 프로젝트 이슈는 project/이름/이슈)</label><input type="text" id="pg-name" placeholder="예: ci-runner"></div>';
  }
  html += '<div class="field"><label for="pg-title">제목</label><input type="text" id="pg-title" value="' + escAttr(p.title) + '"></div>'
    + '<div class="field"><label for="pg-aliases">별칭 (쉼표로 구분)</label><input type="text" id="pg-aliases" value="' + escAttr((p.aliases || []).join(', ')) + '"></div>'
    + '<div class="field"><label for="pg-current">Current — 지금의 이해</label><textarea id="pg-current" rows="8">' + esc(p.current) + '</textarea></div>'
    + '<div class="field"><label>History — 날짜별 기록 (위가 최신)</label><div id="pg-history">';
  var hist = p.history || [];
  for (var i = 0; i < hist.length; i++) {
    html += '<div class="hist"><input type="text" class="pg-hist" value="' + escAttr(hist[i]) + '" aria-label="History ' + (i + 1) + '">'
      + '<button type="button" class="btn link" onclick="this.parentNode.remove()">빼기</button></div>';
  }
  html += '</div><button type="button" class="btn link" onclick="addHistoryLine()">History 줄 추가</button></div>'
    + '<div class="line"><button type="button" class="btn primary" onclick="savePage()">' + (isNew ? '만들기' : '저장') + '</button> '
    + (isNew ? '' : '<button type="button" class="btn" onclick="deletePage()">페이지 삭제</button>') + '</div>';
  el.innerHTML = html;
}
function addHistoryLine() {
  var box = document.getElementById('pg-history');
  var row = document.createElement('div');
  row.className = 'hist';
  var today = new Date().toISOString().slice(0, 10);
  row.innerHTML = '<input type="text" class="pg-hist" value="' + today + ': " aria-label="History 새 줄"><button type="button" class="btn link" onclick="this.parentNode.remove()">빼기</button>';
  box.insertBefore(row, box.firstChild);
  row.firstChild.focus();
}
function newPageForm() {
  _memPage = { page: { id: '', title: '', aliases: [], current: '', history: [] }, revision: null };
  renderPageEditor();
  paintPageList();
}
function pageDraft() {
  var hist = [];
  var inputs = document.querySelectorAll('#pg-history .pg-hist');
  for (var i = 0; i < inputs.length; i++) if (inputs[i].value.trim()) hist.push(inputs[i].value.trim());
  var aliases = (document.getElementById('pg-aliases').value || '').split(',').map(function (a) { return a.trim(); }).filter(Boolean);
  return { title: document.getElementById('pg-title').value, aliases: aliases, current: document.getElementById('pg-current').value, history: hist };
}
async function savePage() {
  var d = pageDraft();
  var isNew = _memPage.revision === null;
  var id = _memPage.page.id;
  if (isNew) {
    var name = (document.getElementById('pg-name').value || '').trim();
    if (!name) { memStatus('이름을 넣으세요', true); return; }
    id = document.getElementById('pg-type').value + '/' + name;
  }
  var r;
  try { r = await apiWrite('PUT', '/api/memory/page', { id: id, title: d.title, aliases: d.aliases, current: d.current, history: d.history, revision: _memPage.revision }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (r.ok) {
    _memPage = { page: r.data.page, revision: r.data.revision };
    await refreshPageIndex();
    renderPageEditor();
    memStatus(isNew ? id + ' 페이지를 만들었습니다' : '저장했습니다', false);
    return;
  }
  if (r.status === 409 && !isNew) {
    // Keep everything typed in the editor (title, aliases, Current, History) and
    // let the user choose: overwrite with the draft, or load the latest (review P1).
    var res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
    var latest = null;
    try { latest = await res.json(); } catch (_e) {}
    _memPageConflict = res.ok && latest ? latest : { page: null, revision: null };
    renderPageConflict();
    memStatus('그사이 이 페이지가 바뀌었습니다. 작성하던 내용은 편집기에 그대로 있습니다.', true);
    return;
  }
  memStatus('저장하지 못했습니다: ' + r.error, true);
}
var _memPageConflict = null; // { page, revision } of the newer version after a 409
function renderPageConflict() {
  var box = document.getElementById('pg-conflict');
  if (!box) return;
  if (!_memPageConflict) { box.innerHTML = ''; return; }
  var p = _memPageConflict.page;
  box.innerHTML = '<div class="notice is-error" role="alert"><p>다른 곳(에이전트·Slack)에서 이 페이지를 고쳤습니다' + (p ? ' (마지막 수정 ' + esc(p.updated) + ')' : '') + '.</p>'
    + (p ? '<details><summary>지금 저장된 Current 보기</summary><pre class="text">' + esc(p.current) + '</pre></details>' : '')
    + '<div class="line"><button type="button" class="btn danger" onclick="overwritePage()">내 수정본으로 덮어쓰기</button> '
    + '<button type="button" class="btn" onclick="discardPageDraft()">최신 내용 불러오기 (내 수정 버림)</button></div></div>';
}
function overwritePage() {
  if (!_memPageConflict || !_memPageConflict.revision) return;
  _memPage.revision = _memPageConflict.revision;
  _memPageConflict = null;
  renderPageConflict();
  return savePage();
}
function discardPageDraft() {
  var id = _memPage && _memPage.page && _memPage.page.id;
  _memPageConflict = null;
  if (id) openPage(id);
}
async function deletePage() {
  var p = _memPage.page;
  var ok = await confirmDialog({ title: p.title + ' 페이지를 지울까요?', body: p.id + ' — Current와 History가 모두 사라집니다.', action: '페이지 삭제' });
  if (!ok) return;
  var r = await apiWrite('DELETE', '/api/memory/page', { id: p.id, revision: _memPage.revision });
  if (!r.ok) { memStatus((r.status === 409 ? '그사이 바뀌었습니다 — 다시 열어 확인하세요: ' : '지우지 못했습니다: ') + r.error, true); return; }
  _memPage = null;
  await refreshPageIndex();
  renderPageEditor();
  memStatus('페이지를 지웠습니다', false);
}
async function refreshPageIndex() {
  var res = await fetch('/api/memory');
  if (res.ok) { var data = await res.json(); _mem.pages = data.pages; _mem.episodicDates = data.episodicDates; }
  paintPageList();
}

// ── 관찰 기록 (에피소딕) ──
function paintDates() {
  var sel = document.getElementById('mem-ep-date');
  var dates = (_mem && _mem.episodicDates) || [];
  var html = '';
  for (var i = 0; i < dates.length; i++) html += '<option value="' + escAttr(dates[i]) + '">' + esc(dates[i]) + '</option>';
  sel.innerHTML = html || '<option value="">기록 없음</option>';
  if (dates.length) loadDay(_memDay && dates.indexOf(_memDay.date) >= 0 ? _memDay.date : dates[0]);
  else document.getElementById('mem-ep-body').innerHTML = '<p class="lock">아직 관찰 기록이 없습니다. 턴이 끝날 때마다 자동으로 쌓입니다.</p>';
}
async function loadDay(date) {
  if (!date) return;
  var res = await fetch('/api/memory/episodic/' + encodeURIComponent(date));
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  if (!res.ok) { memStatus('기록을 불러오지 못했습니다: ' + ((data && data.error) || res.status), true); return; }
  _memDay = data;
  document.getElementById('mem-ep-date').value = date;
  renderDay();
}
function renderDay(editIndex, draft) {
  var el = document.getElementById('mem-ep-body');
  var entries = (_memDay && _memDay.entries) || [];
  if (!entries.length) { el.innerHTML = '<p class="lock">이 날의 기록이 없습니다.</p>'; return; }
  var html = '';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    html += '<div class="ep-entry"><div class="when">' + esc(e.time) + ' UTC</div>';
    if (editIndex === i) {
      html += '<textarea id="ep-edit" rows="5" aria-label="' + escAttr(e.time + ' 기록 수정') + '">' + esc(typeof draft === 'string' ? draft : e.content) + '</textarea>'
        + '<div class="actions"><button type="button" class="btn primary" onclick="epSave(' + i + ')">저장</button> <button type="button" class="btn" onclick="renderDay()">취소</button></div>';
    } else {
      html += '<div class="text">' + esc(e.content) + '</div>'
        + '<div class="actions"><button type="button" class="btn link" onclick="renderDay(' + i + ')">수정</button> <button type="button" class="btn link" onclick="epDelete(' + i + ')">삭제</button></div>';
    }
    html += '</div>';
  }
  el.innerHTML = html;
}
async function epWrite(method, url, payload, draft, at) {
  var r;
  try { r = await apiWrite(method, url, payload); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (r.ok) { _memDay = r.data.day; renderDay(); refreshDatesIfEmptied(); return true; }
  if (r.status === 409) {
    await loadDay(_memDay.date);
    // The whole draft goes back into an edit box (review P1).
    var entries = (_memDay && _memDay.entries) || [];
    if (draft && typeof at === 'number' && at < entries.length) renderDay(at, draft);
    else if (draft) { var ta = document.getElementById('mem-ep-new'); if (ta) ta.value = draft; }
    memStatus('그사이 이 날의 기록이 바뀌어 최신 내용을 불러왔습니다.' + (draft ? ' 작성하던 내용은 편집 칸에 그대로 있습니다 — 확인하고 다시 저장하세요.' : ' 다시 적용하세요.'), true);
    return false;
  }
  memStatus('저장하지 못했습니다: ' + r.error, true);
  return false;
}
async function epSave(i) {
  var ta = document.getElementById('ep-edit');
  var text = ta ? ta.value : '';
  if (!text.trim()) { memStatus('비어 있는 기록은 저장할 수 없습니다 — 지우려면 삭제를 쓰세요', true); return; }
  if (await epWrite('PUT', '/api/memory/episodic/' + _memDay.date + '/' + i, { content: text, revision: _memDay.revision }, text, i)) memStatus('저장했습니다', false);
}
async function epDelete(i) {
  var ok = await confirmDialog({ title: _memDay.date + ' ' + _memDay.entries[i].time + ' 기록을 지울까요?', body: '되돌릴 수 없습니다.', action: '기록 삭제' });
  if (!ok) return;
  if (await epWrite('DELETE', '/api/memory/episodic/' + _memDay.date + '/' + i, { revision: _memDay.revision })) memStatus('지웠습니다', false);
}
// The last entry of a day was deleted (the file is gone): drop the date from the list.
async function refreshDatesIfEmptied() {
  if (_memDay && _memDay.entries && _memDay.entries.length) return;
  await refreshPageIndex();
  paintDates();
}
async function epAdd() {
  var ta = document.getElementById('mem-ep-new');
  var text = ta ? ta.value : '';
  if (!text.trim()) return;
  var r = await apiWrite('POST', '/api/memory/episodic', { text: text });
  if (!r.ok) { memStatus('추가하지 못했습니다: ' + r.error, true); return; }
  ta.value = '';
  _memDay = r.data.day;
  await refreshPageIndex();
  paintDates();
  memStatus('오늘 기록에 추가했습니다', false);
}
`;
