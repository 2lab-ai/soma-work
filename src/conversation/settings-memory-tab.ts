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
var _memPage = null;      // { page, revision, raw, representable } open in the editor (revision null = new)
var _memPageRaw = false;  // the open page is edited as raw markdown
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
async function l1Write(method, url, payload, draft, at, orig) {
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
    restoreL1Draft(target, draft, at, orig);
    memStatus('그사이 다른 곳(에이전트·Slack)에서 바뀌어 최신 내용을 불러왔습니다.' + (draft ? ' 작성하던 내용은 편집 칸에 그대로 있습니다 — 확인하고 다시 저장하세요.' : ' 다시 적용하세요.'), true);
    return false;
  }
  memStatus('저장하지 못했습니다: ' + r.error, true);
  return false;
}
// The draft goes back into the editor of the entry it was for — found by its
// original text, never by position (the list may have shifted) — else into the
// add box as a recovery draft (review R2). Two notes with that text cannot be
// told apart, so that is a recovery draft too (review R3).
function restoreL1Draft(target, draft, at, orig) {
  if (!draft) return;
  var entries = (_mem && _mem.l1[target] && _mem.l1[target].entries) || [];
  var idx = typeof orig === 'string' ? entries.indexOf(orig) : -1;
  if (idx >= 0 && entries.lastIndexOf(orig) === idx) {
    paintL1({ target: target, index: idx, text: draft });
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
  var orig = _mem.l1[target].entries[i];
  if (await l1Write('PUT', '/api/memory/l1/' + target + '/' + i, { text: text, revision: _mem.l1[target].revision }, text, i, orig)) memStatus('저장했습니다', false);
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
  // Restore exactly what was deleted: a note Slack saved may be longer than a new note
  // may be (restore skips that cap, not the total). The undo stays offered until the
  // restore lands, and a refused restore leaves the text in the add box (review R5).
  if (await l1Write('POST', '/api/memory/l1/' + u.target, { text: u.text, revision: _mem.l1[u.target].revision, restore: true }, u.text)) {
    if (_memUndo === u) _memUndo = null;
    paintL1();
    memStatus('되돌렸습니다 (목록 끝에 다시 추가)', false);
    return;
  }
  var ta = document.getElementById('l1-new-' + u.target);
  if (ta && !ta.value) ta.value = u.text;
}
async function l1Clear(target) {
  // What the dialog names is what gets cleared: a reload under the open dialog makes it a 409 (review R3).
  var n = _mem.l1[target].entries.length;
  var revision = _mem.l1[target].revision;
  var ok = await confirmDialog({ title: L1_LABELS[target] + ' 항목 ' + n + '개를 모두 지울까요?', body: '되돌릴 수 없습니다. 에이전트는 다음 세션부터 이 내용을 모릅니다.', action: n + '개 모두 지우기' });
  if (!ok) return;
  if (await l1Write('DELETE', '/api/memory/l1/' + target, { revision: revision })) memStatus('모두 지웠습니다', false);
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
// A page save or delete in flight holds the editor (review R6): a second click and a
// switch to another page wait for the answer, so an answer always lands on the editor
// it was sent from, with nothing typed elsewhere in between. A request that hangs past
// the hold lets the user move on; its late answer then only reports (review R5).
function pageSaveBusy() {
  if (!_memPage || !_memPage.saving || Date.now() - _memPage.saving > 20000) return false;
  memStatus('저장 중입니다 — 끝난 뒤 다시 시도하세요', false);
  return true;
}
// The page editor's fields are locked while its save is out: an answer re-renders the
// editor, so nothing may be typed into it meanwhile (review R7).
function setPageFieldsDisabled(on) {
  var els = document.querySelectorAll('#mem-page-detail input, #mem-page-detail textarea, #mem-page-detail select');
  for (var i = 0; i < els.length; i++) els[i].disabled = !!on;
}
async function openPage(id) {
  if (pageSaveBusy()) return;
  var res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  if (!res.ok) { memStatus('페이지를 열지 못했습니다: ' + ((data && data.error) || res.status), true); return; }
  _memPage = data;
  _memPageConflict = null;
  _memPageRaw = false;
  renderPageEditor();
  paintPageList();
}
function pageRawMode(on) {
  if (pageSaveBusy()) return;
  _memPageRaw = !!on;
  renderPageEditor();
}
function renderPageEditor() {
  var el = document.getElementById('mem-page-detail');
  if (!_memPage) { el.innerHTML = '<p class="lock">왼쪽에서 페이지를 고르세요.</p>'; return; }
  var p = _memPage.page;
  var isNew = _memPage.revision === null;
  var html = '<div id="pg-conflict"></div><div class="meta">' + (isNew ? '새 페이지' : esc(p.id) + ' · 마지막 수정 ' + esc(p.updated)) + '</div>';
  // A page the form cannot hold (a heading inside Current, a multi-line History entry, another
  // section) is edited as the raw file — saving the form would drop the rest (review R3).
  if (!isNew && (_memPageRaw || _memPage.representable === false)) {
    var forced = _memPage.representable === false;
    html += (forced ? '<div class="notice" role="note">이 페이지에는 편집 양식에 담기지 않는 내용이 있어 원문(markdown) 그대로 고칩니다. 내용은 하나도 빠지지 않습니다.</div>' : '')
      + '<div class="field"><label for="pg-raw">원문 (markdown)</label><textarea id="pg-raw" rows="18" spellcheck="false">' + esc(_memPage.raw || '') + '</textarea></div>'
      + '<div class="line"><button type="button" class="btn primary" onclick="savePageRaw()">저장</button> '
      + (forced ? '' : '<button type="button" class="btn" onclick="pageRawMode(false)">양식으로 돌아가기</button> ')
      + '<button type="button" class="btn" onclick="deletePage()">페이지 삭제</button></div>';
    el.innerHTML = html;
    return;
  }
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
    + (isNew ? '' : '<button type="button" class="btn" onclick="deletePage()">페이지 삭제</button> <button type="button" class="btn link" onclick="pageRawMode(true)">원문(markdown)으로 편집</button>') + '</div>';
  el.innerHTML = html;
}
function addHistoryLine() {
  if (pageSaveBusy()) return;
  var box = document.getElementById('pg-history');
  var row = document.createElement('div');
  row.className = 'hist';
  var today = new Date().toISOString().slice(0, 10);
  row.innerHTML = '<input type="text" class="pg-hist" value="' + today + ': " aria-label="History 새 줄"><button type="button" class="btn link" onclick="this.parentNode.remove()">빼기</button>';
  box.insertBefore(row, box.firstChild);
  row.firstChild.focus();
}
function newPageForm() {
  if (pageSaveBusy()) return;
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
  if (pageSaveBusy()) return;
  var d = pageDraft();
  // The editor this save was sent from. If another page is opened before the answer
  // arrives, the answer must not retarget that editor: its id, revision and fields
  // would no longer belong together (review R5).
  var sentFrom = _memPage;
  var isNew = _memPage.revision === null;
  var id = _memPage.page.id;
  if (isNew) {
    var name = (document.getElementById('pg-name').value || '').trim();
    if (!name) { memStatus('이름을 넣으세요', true); return; }
    id = document.getElementById('pg-type').value + '/' + name;
  }
  var r;
  sentFrom.saving = Date.now();
  setPageFieldsDisabled(true);
  try { r = await apiWrite('PUT', '/api/memory/page', { id: id, title: d.title, aliases: d.aliases, current: d.current, history: d.history, revision: _memPage.revision }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  sentFrom.saving = 0;
  if (_memPage !== sentFrom) return pageAnswerElsewhere(r, id);
  setPageFieldsDisabled(false);
  if (r.ok) {
    // Keep the saved bytes too: a later switch to raw editing starts from them (review R4).
    // The editor is updated in one step, before anything else is awaited (review R5).
    _memPage = { page: r.data.page, revision: r.data.revision, raw: r.data.raw, representable: r.data.representable };
    renderPageEditor();
    memStatus(isNew ? id + ' 페이지를 만들었습니다' : '저장했습니다', false);
    await refreshPageIndex();
    return;
  }
  if (r.status === 409 && !isNew) {
    // Keep everything typed in the editor (title, aliases, Current, History) and
    // let the user choose: overwrite with the draft, or load the latest (review P1).
    var res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
    var latest = null;
    try { latest = await res.json(); } catch (_e) {}
    if (_memPage !== sentFrom) return pageAnswerElsewhere(r, id);
    _memPageConflict = res.ok && latest ? latest : { page: null, revision: null };
    renderPageConflict();
    memStatus('그사이 이 페이지가 바뀌었습니다. 작성하던 내용은 편집기에 그대로 있습니다.', true);
    return;
  }
  memStatus('저장하지 못했습니다: ' + r.error, true);
}
// A page answer that came back after the user opened another page: report it,
// refresh the list, leave the open editor alone (review R5).
async function pageAnswerElsewhere(r, id) {
  if (r.ok) memStatus(id + ' 페이지를 저장했습니다 (지금 연 페이지는 그대로)', false);
  else memStatus(id + ' 페이지를 저장하지 못했습니다' + (r.status === 409 ? ' — 그사이 바뀌었습니다. 다시 열어 확인하세요' : ': ' + r.error), true);
  await refreshPageIndex();
}
async function savePageRaw() {
  if (pageSaveBusy()) return;
  var ta = document.getElementById('pg-raw');
  var raw = ta ? ta.value : '';
  var sentFrom = _memPage; // as in savePage (review R5)
  var id = _memPage.page.id;
  var r;
  sentFrom.saving = Date.now();
  setPageFieldsDisabled(true);
  try { r = await apiWrite('PUT', '/api/memory/page/raw', { id: id, raw: raw, revision: _memPage.revision }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  sentFrom.saving = 0;
  if (_memPage !== sentFrom) return pageAnswerElsewhere(r, id);
  setPageFieldsDisabled(false);
  if (r.ok) {
    _memPage = r.data;
    _memPageRaw = !(r.data && r.data.representable);
    renderPageEditor();
    memStatus('저장했습니다', false);
    await refreshPageIndex();
    return;
  }
  if (r.status === 409) {
    // The draft stays in the editor; overwrite or load the latest (same as the form).
    var res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
    var latest = null;
    try { latest = await res.json(); } catch (_e) {}
    if (_memPage !== sentFrom) return pageAnswerElsewhere(r, id);
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
  var rawDraft = _memPageRaw || _memPage.representable === false; // the editor the draft is in
  // The editor now stands on the newer page: its revision, and its bytes for a later
  // switch to raw editing — never the ones first opened (review R4).
  _memPage.revision = _memPageConflict.revision;
  _memPage.raw = _memPageConflict.raw;
  _memPage.representable = _memPageConflict.representable;
  _memPageConflict = null;
  renderPageConflict();
  return rawDraft ? savePageRaw() : savePage();
}
function discardPageDraft() {
  var id = _memPage && _memPage.page && _memPage.page.id;
  _memPageConflict = null;
  if (id) openPage(id);
}
async function deletePage() {
  if (pageSaveBusy()) return;
  var p = _memPage.page;
  var revision = _memPage.revision; // the page the dialog names, as it was shown (review R3)
  var ok = await confirmDialog({ title: p.title + ' 페이지를 지울까요?', body: p.id + ' — Current와 History가 모두 사라집니다.', action: '페이지 삭제' });
  if (!ok) return;
  var sentFrom = _memPage;
  if (pageSaveBusy()) return; // a save started while the dialog was open
  sentFrom.saving = Date.now();
  var r;
  try { r = await apiWrite('DELETE', '/api/memory/page', { id: p.id, revision: revision }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  sentFrom.saving = 0;
  if (!r.ok) { memStatus((r.status === 409 ? '그사이 바뀌었습니다 — 다시 열어 확인하세요: ' : '지우지 못했습니다: ') + r.error, true); return; }
  // Close the editor only if it still shows the deleted page (review R5).
  if (_memPage === sentFrom) { _memPage = null; renderPageEditor(); }
  await refreshPageIndex();
  memStatus('페이지를 지웠습니다', false);
}
async function refreshPageIndex() {
  var res = await fetch('/api/memory');
  if (res.ok) { var data = await res.json(); _mem.pages = data.pages; _mem.episodicDates = data.episodicDates; }
  paintPageList();
}

// ── 관찰 기록 (에피소딕) ──
function fillDateSelect() {
  var sel = document.getElementById('mem-ep-date');
  var dates = (_mem && _mem.episodicDates) || [];
  var html = '';
  for (var i = 0; i < dates.length; i++) html += '<option value="' + escAttr(dates[i]) + '">' + esc(dates[i]) + '</option>';
  sel.innerHTML = html || '<option value="">기록 없음</option>';
  if (_memDay && dates.indexOf(_memDay.date) >= 0) sel.value = _memDay.date;
  return dates;
}
function paintDates() {
  var dates = fillDateSelect();
  if (dates.length) loadDay(_memDay && dates.indexOf(_memDay.date) >= 0 ? _memDay.date : dates[0]);
  else document.getElementById('mem-ep-body').innerHTML = '<p class="lock">아직 관찰 기록이 없습니다. 턴이 끝날 때마다 자동으로 쌓입니다.</p>';
}
// An episodic write in flight holds the day it was sent from (review R7): switching days,
// a second save or delete, and a note wait for the answer, so the answer lands on the day
// the picker shows. A write hung past the hold lets the user move on; its late answer then
// only reports.
function epBusy() {
  if (!_memDay || !_memDay.saving || Date.now() - _memDay.saving > 20000) return false;
  memStatus('저장 중입니다 — 끝난 뒤 다시 시도하세요', false);
  var sel = document.getElementById('mem-ep-date');
  if (sel) sel.value = _memDay.date;
  return true;
}
async function loadDay(date) {
  if (!date || epBusy()) return;
  // Only the latest day request paints the view: an older one answering last is dropped (review R8).
  var seq = (loadDay.seq = (loadDay.seq || 0) + 1);
  var res = await fetch('/api/memory/episodic/' + encodeURIComponent(date));
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  if (seq !== loadDay.seq) return;
  if (!res.ok) { memStatus('기록을 불러오지 못했습니다: ' + ((data && data.error) || res.status), true); return; }
  _memDay = data;
  document.getElementById('mem-ep-date').value = date;
  renderDay();
}
// The open episodic editor: the day, record and revision it was opened on. A save goes
// there, whatever day the view shows by then (review R6).
var _epEditor = null;
function renderDay(editIndex, draft) {
  var el = document.getElementById('mem-ep-body');
  var entries = (_memDay && _memDay.entries) || [];
  var edited = typeof editIndex === 'number' ? entries[editIndex] : undefined;
  _epEditor = edited ? { date: _memDay.date, revision: _memDay.revision, index: editIndex, time: edited.time, content: edited.content } : null;
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
async function epWrite(method, url, payload, draft, at, orig, origTime) {
  // The day is part of the record's identity: recover on the day the request was
  // for, even if the view moved to another day while it was in flight (review R4).
  var dayMatch = /\/api\/memory\/episodic\/([^/]+)\//.exec(url);
  var date = dayMatch ? decodeURIComponent(dayMatch[1]) : (_memDay && _memDay.date);
  var view = _memDay;
  if (view) view.saving = Date.now();
  // The open editor is locked while its save is out: a success re-renders it (review R8).
  var lockBox = method === 'PUT' ? document.getElementById('ep-edit') : null;
  if (lockBox) lockBox.disabled = true;
  var r;
  try { r = await apiWrite(method, url, payload); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (view) view.saving = 0;
  if (lockBox) lockBox.disabled = false;
  // The view shows another day (a day request finished behind a dialog, or the write
  // outlived the hold): an answer never repaints that day (review R7, R8). A 409 still
  // recovers on the request's day below, which moves the picker and the body together.
  var elsewhere = !_memDay || _memDay.date !== date;
  if (r.ok && elsewhere) {
    memStatus(date + ' 기록을 ' + (method === 'DELETE' ? '지웠습니다' : '저장했습니다') + ' (지금 보는 날은 그대로)', false);
    await refreshPageIndex();
    fillDateSelect();
    return true;
  }
  if (r.ok) { _memDay = r.data.day; renderDay(); refreshDatesIfEmptied(); return true; }
  if (r.status === 409) {
    await loadDay(date);
    if (!_memDay || _memDay.date !== date) { var box = document.getElementById('mem-ep-new'); if (draft && box) box.value = draft; memStatus('그사이 이 날의 기록이 바뀌었습니다. 작성하던 내용은 메모 칸에 옮겼습니다.', true); return false; }
    // The whole draft goes back into an edit box (review P1).
    // Back into the editor of the entry it was for — found by its original time
    // and text, never by position — else into the note box as a recovery draft
    // (review R2). Two records alike in both cannot be told apart: recovery (R3).
    var entries = (_memDay && _memDay.entries) || [];
    var idx = -1;
    var matches = 0;
    for (var k = 0; k < entries.length; k++) {
      if (typeof orig === 'string' && entries[k].content === orig && (typeof origTime !== 'string' || entries[k].time === origTime)) {
        if (idx < 0) idx = k;
        matches++;
      }
    }
    if (draft && idx >= 0 && matches === 1) renderDay(idx, draft);
    else if (draft) { var ta = document.getElementById('mem-ep-new'); if (ta) ta.value = draft; }
    memStatus('그사이 이 날의 기록이 바뀌어 최신 내용을 불러왔습니다.' + (draft ? ' 작성하던 내용은 편집 칸에 그대로 있습니다 — 확인하고 다시 저장하세요.' : ' 다시 적용하세요.'), true);
    return false;
  }
  if (elsewhere && draft) {
    var note = document.getElementById('mem-ep-new');
    if (note && !note.value) note.value = draft;
    memStatus(date + ' 기록을 저장하지 못했습니다: ' + r.error + ' — 작성하던 내용은 메모 칸에 옮겼습니다.', true);
    return false;
  }
  memStatus('저장하지 못했습니다: ' + r.error, true);
  return false;
}
async function epSave(i) {
  if (epBusy()) return;
  var ed = _epEditor;
  var ta = document.getElementById('ep-edit');
  if (!ed || ed.index !== i || !ta) return;
  var text = ta.value;
  if (!text.trim()) { memStatus('비어 있는 기록은 저장할 수 없습니다 — 지우려면 삭제를 쓰세요', true); return; }
  if (await epWrite('PUT', '/api/memory/episodic/' + ed.date + '/' + ed.index, { content: text, revision: ed.revision }, text, ed.index, ed.content, ed.time)) memStatus('저장했습니다', false);
}
async function epDelete(i) {
  // Date, index and revision as the dialog shows them: if the view moves to another day
  // under the open dialog, the delete still targets the record that was confirmed (review R3).
  var date = _memDay.date;
  var revision = _memDay.revision;
  var time = _memDay.entries[i].time;
  var ok = await confirmDialog({ title: date + ' ' + time + ' 기록을 지울까요?', body: '되돌릴 수 없습니다.', action: '기록 삭제' });
  if (!ok || epBusy()) return;
  if (await epWrite('DELETE', '/api/memory/episodic/' + date + '/' + i, { revision: revision })) memStatus('지웠습니다', false);
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
  if (!text.trim() || epBusy() || ta.disabled) return;
  // The note box is locked while the note is out: a double click adds nothing more, and
  // nothing typed meanwhile is cleared with it (review R8).
  ta.disabled = true;
  var r;
  try { r = await apiWrite('POST', '/api/memory/episodic', { text: text }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  ta.disabled = false;
  if (!r.ok) { memStatus('추가하지 못했습니다: ' + r.error, true); return; }
  ta.value = '';
  if (_epEditor && document.getElementById('ep-edit') && _epEditor.date !== r.data.day.date) {
    // A record of another day is open for editing: keep it (and its draft) on screen;
    // today's note shows when that day is opened (review R6).
    var keptDate = _epEditor.date;
    await refreshPageIndex();
    fillDateSelect(); // today is listed now; the picker stays on the open day
    memStatus('오늘 기록에 추가했습니다 (수정 중인 ' + keptDate + ' 기록은 그대로)', false);
    return;
  }
  var openEdit = document.getElementById('ep-edit');
  if (_epEditor && openEdit && _epEditor.date === r.data.day.date) {
    // A record of today is open for editing: it stays open with its draft (review R7).
    // It is re-attached to the new day only to the same record — its time and text, and
    // only one such — never by position; otherwise it stays bound to what it was opened
    // on, and its save meets the server's revision check (review R8).
    var ents = r.data.day.entries || [];
    var at = -1;
    var same = 0;
    for (var k = 0; k < ents.length; k++) {
      if (ents[k].time === _epEditor.time && ents[k].content === _epEditor.content) {
        if (at < 0) at = k;
        same++;
      }
    }
    if (same === 1) {
      var keepDraft = openEdit.value;
      _memDay = r.data.day;
      renderDay(at, keepDraft);
    }
    await refreshPageIndex();
    fillDateSelect();
    memStatus('오늘 기록에 추가했습니다 (수정 중인 기록은 그대로)', false);
    return;
  }
  // The view and its state move to today together, before anything is awaited (review R6).
  _memDay = r.data.day;
  renderDay();
  var sel = document.getElementById('mem-ep-date');
  if (sel) sel.value = _memDay.date;
  await refreshPageIndex();
  paintDates();
  memStatus('오늘 기록에 추가했습니다', false);
}
`;
