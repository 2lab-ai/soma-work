/**
 * The settings page "기억" tab (SSOT 2026-10-23 T3) — every personal memory,
 * viewable and editable:
 *   - 개인 메모리: 에이전트 노트 (MEMORY.md) and 사용자 프로필 (USER.md) — the
 *     @2lab.ai/ui <ui-memory-panel> (one row per entry, a usage bar, add / edit /
 *     delete with undo / clear); this tab gives it the data and carries its writes;
 *   - 지식 페이지: the semantic pages (agent / sites / concepts / projects / cron)
 *     with Current and the whole History, all editable; create and delete;
 *   - 관찰 기록 (에피소딕): every day, its entries editable and deletable, notes added.
 *
 * UI decisions (research, SSOT T5): one row per entry, never the raw `§`
 * format; a meter with visible numbers; a single delete happens at once with
 * an undo, "모두 지우기" confirms and names the count; every edit is
 * conditional on the revision the tab loaded — a 409 reloads that part and
 * keeps the user's draft. The 개인 메모리 list is the library element; its
 * rendering, keyboard, tray and undo are pinned by the library's
 * memory-panel.test.ts, the host glue by settings-memory-tab.test.ts.
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
    <div id="mem-recover"></div>
    <section class="group" id="m-l1" aria-labelledby="h-m-l1">
      <header><h2 id="h-m-l1">개인 메모리</h2><p>짧은 항목 목록입니다. 용량이 차면 에이전트가 새로 기억하지 못하니, 오래된 항목을 지우거나 합치세요.</p></header>
      <div id="mem-l1-body"><div class="notice">불러오는 중…</div></div>
      <div class="ui-tok"><ui-memory-panel id="l1-panel" lang="ko"></ui-memory-panel></div>
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
.navbtn { font: inherit; font-size: 13px; text-align: left; color: var(--text-secondary); background: none; border: 0; padding: 6px 10px; border-radius: 8px; cursor: pointer; }
.navbtn:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
/* 개인 메모리 — <ui-memory-panel> (@2lab.ai/ui) draws its own card: the section keeps only its heading. */
#m-l1 { background: none; border: 0; box-shadow: none; } /* no card of its own — not even the group whisper shadow (tone pass P9) */
#m-l1 > header { padding: 0 2px 10px; border-bottom: 0; }
#mem-l1-body:empty { display: none; }
textarea { width: 100%; font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 8px; resize: vertical; }
textarea:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.pages-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 16px; padding: 16px; }
.pages-list { display: flex; flex-direction: column; gap: 8px; }
.pages-list input { font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
.pages-list h4 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); margin-top: 6px; }
/* Tone pass P9: the page list reads like the side nav — the --ib-pill chip on hover and for the open page. */
.pages-list .pg { display: block; width: 100%; text-align: left; font: inherit; font-size: 13px; color: var(--text); background: none; border: 0; border-radius: 8px; padding: 6px 8px; cursor: pointer; transition: background-color 150ms ease, transform var(--dur-press) var(--ease-out); }
.pages-list .pg[aria-current="true"] { background: var(--ib-pill); font-weight: 600; }
/* On the pill the page id steps up to the secondary ink: tertiary is 4.3:1 there, secondary 5.5:1 (light and dark). */
.pages-list .pg[aria-current="true"] .lock { color: var(--text-secondary); }
@media (hover: hover) and (pointer: fine) { .pages-list .pg:hover { background: var(--ib-pill); } .pages-list .pg:hover .lock { color: var(--text-secondary); } }
.pages-detail .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.pages-detail .field label { font-size: 12px; font-weight: 600; }
.pages-detail .field input[type="text"], .pages-detail .field select { font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; min-height: 34px; }
.pages-list .pg:focus-visible, .pages-list input:focus-visible, .pages-detail .field input:focus-visible, .pages-detail .field select:focus-visible, .ep-bar select:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
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
// One memory write at a time across the tab (review R10): while one is out, every other
// write, editor opening, day or page switch waits for its answer — however long it takes
// (a timed release let a second write race the first, review R11). The answer always
// comes: success, refusal, or a network error.
function memHold() {
  if (!memHold.at) return false;
  memStatus('저장 중입니다 — 끝난 뒤 다시 시도하세요', false);
  return true;
}
// A draft that has to leave its editor goes into an empty box next to it; if that box is
// in use, into the recovery box at the top of the tab — never dropped (review R10).
function memKeepDraft(boxId, text, label) {
  if (!text) return;
  var box = document.getElementById(boxId);
  if (box && box.value === text) return;
  if (box && !box.value) { box.value = text; return; }
  memRecover(label, text);
}
function memRecover(label, text) {
  var items = memRecover.items || [];
  for (var i = 0; i < items.length; i++) if (items[i].text === text) return; // kept once
  memRecover.items = items.concat([{ label: label, text: text }]);
  paintRecover();
}
function paintRecover() {
  var el = document.getElementById('mem-recover');
  if (!el) return;
  var items = memRecover.items || [];
  var html = '';
  for (var i = 0; i < items.length; i++) {
    html += '<div class="notice is-error" role="alert"><p>저장되지 않은 내용 — ' + esc(items[i].label) + '. 필요하면 복사해 다시 저장하세요.</p>'
      + '<textarea readonly rows="3" aria-label="' + escAttr('저장되지 않은 내용: ' + items[i].label) + '">' + esc(items[i].text) + '</textarea>'
      + '<button type="button" class="btn link" onclick="memRecoverDismiss(' + i + ')">닫기</button></div>';
  }
  el.innerHTML = html;
}
function memRecoverDismiss(i) {
  (memRecover.items || []).splice(i, 1);
  paintRecover();
}
// force: a 409 recovery that holds the tab itself. Otherwise a load answered while a
// write is out, or older than a later load, is dropped — it would repaint the cards
// under the write (review R12). A failed load never replaces cards already on screen:
// they carry what is being typed (review R12).
async function loadMemory(force) {
  var body = document.getElementById('mem-l1-body');
  var seq = (loadMemory.seq = (loadMemory.seq || 0) + 1);
  function failed(text) {
    if (_mem) { memStatus(text, true); return; }
    body.innerHTML = '<div class="notice is-error" role="alert">' + esc(text) + '</div>';
  }
  try {
    var res = await fetch('/api/memory');
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    // (the first load is always applied: nothing is on screen to protect yet, review R13)
    if (seq !== loadMemory.seq || (!force && memHold.at && _memLoaded)) return;
    if (!res.ok) {
      failed((data && data.error) || ('기억을 불러오지 못했습니다 (HTTP ' + res.status + ')'));
      return false;
    }
    _mem = data;
    _memLoaded = true;
    paintL1();
    paintPageList();
    paintDates();
    return true;
  } catch (_e) {
    if (seq === loadMemory.seq) failed('기억을 불러오지 못했습니다. 다시 시도하세요.');
    return false;
  }
}

// ── 개인 메모리 (L1) ──
// <ui-memory-panel> (@2lab.ai/ui — chips, search, in-place edit, delete with a 5 s undo, add, clear all)
// draws the two stores; this tab owns the data and the writes. paintL1 hands it GET /api/memory's L1
// blocks; each ui-* write it sends goes to the L1 route with the revision that block was loaded with
// (CSRF via apiWrite), and the answer's block becomes the next data. The element shows a write at once;
// a write the server refuses is handed back with el.refuse(e, message), which puts what was typed back in
// an editor and withdraws a refused delete's undo. One memory write at a time across the tab (review R10):
// while one is out, the element's write is cancelled (it keeps what was typed) and #mem-status says so.
var L1_TARGETS = ['memory', 'user'];
var L1_EMPTY = '비어 있음 — Slack에서 "기억해줘"라고 하거나 아래에서 추가하세요.';
var L1_WRITES = ['ui-add', 'ui-edit', 'ui-delete', 'ui-restore', 'ui-clear'];
// The element's data: one store per L1 block, numbered and counted the way the store counts
// (entries joined with the 3-char delimiter = the server's totalChars).
function l1Stores(l1) {
  var stores = [];
  for (var i = 0; i < L1_TARGETS.length; i++) {
    var t = L1_TARGETS[i];
    var b = (l1 && l1[t]) || {};
    stores.push({ id: t, label: L1_LABELS[t], file: L1_FILES[t], limit: b.charLimit || 0, perEntryLimit: b.perEntryCap || 0, separator: '\n§\n', entries: (b.entries || []).slice(), empty: L1_EMPTY });
  }
  return stores;
}
function paintL1() {
  var el = document.getElementById('l1-panel');
  if (!_mem || !_mem.l1 || !el) return;
  if (!el.l1Bound) {
    el.l1Bound = true;
    for (var i = 0; i < L1_WRITES.length; i++) el.addEventListener(L1_WRITES[i], l1OnWrite);
  }
  el.data = { stores: l1Stores(_mem.l1) };
  var body = document.getElementById('mem-l1-body');
  if (body) body.innerHTML = ''; // the loading notice
}
// One write event → its route: [method, url, body]; null when the event names no store this tab has.
function l1Route(type, d, revision) {
  var base = '/api/memory/l1/' + d.store;
  if (type === 'ui-add') return ['POST', base, { text: d.text, revision: revision }];
  if (type === 'ui-edit') return ['PUT', base + '/' + d.index, { text: d.text, revision: revision }];
  if (type === 'ui-delete') return ['DELETE', base + '/' + d.index, { revision: revision }];
  // undo: the exact note back — it may be longer than a new note may be (review R5); the store appends it
  if (type === 'ui-restore') return ['POST', base, { text: d.text, revision: revision, restore: true }];
  if (type === 'ui-clear') return ['DELETE', base, { revision: revision }];
  return null;
}
function l1OnWrite(e) {
  var el = e.currentTarget;
  var d = e.detail || {};
  var block = _mem && _mem.l1 && L1_TARGETS.indexOf(d.store) >= 0 ? _mem.l1[d.store] : null;
  var route = block ? l1Route(e.type, d, block.revision) : null;
  if (!route) { e.preventDefault(); return; }
  if (l1Held()) { e.preventDefault(); return; } // another write is out: try again after it
  // An edit or delete names its entry by index and text: the index goes to the server only while it
  // still holds that text here (the revision guards the server's side).
  var named = e.type === 'ui-edit' ? d.previous : e.type === 'ui-delete' ? d.text : null;
  if (named !== null && (block.entries || [])[d.index] !== named) {
    el.refuse(e, '그사이 바뀌었습니다 — 다시 시도하세요');
    loadMemory();
    return;
  }
  l1Write(el, e, route[0], route[1], route[2]);
}
// #mem-status is shared by the tab's sections. What L1 puts there (a 409, a refusal, "저장 중") is
// remembered, and the next successful L1 write clears it — unless another section wrote since.
function l1Say(text, isError) {
  memStatus(text, isError);
  l1Say.last = text;
}
function l1Held() {
  if (!memHold()) return false;
  var st = document.getElementById('mem-status');
  l1Say.last = st ? st.textContent : '';
  return true;
}
function l1Unsay() {
  var st = document.getElementById('mem-status');
  if (st && l1Say.last && st.textContent === l1Say.last) memStatus('', false);
  l1Say.last = '';
}
// One L1 write. The tab is held until it is answered — a 409 until the reload is done too (review R11),
// released however that ends (review R12). A 409 reloads the stores, then hands the write back to the
// element: what was typed goes back into an editor, and the whole message stays in #mem-status.
async function l1Write(el, e, method, url, payload) {
  var target = url.split('/')[4];
  var typed = e.type !== 'ui-delete' && e.type !== 'ui-clear';
  memHold.at = Date.now();
  var r;
  try { r = await apiWrite(method, url, payload); } catch (x) { r = { ok: false, status: 0, error: String(x && x.message || x) }; }
  if (r.status === 409) {
    var reloaded = false;
    try { reloaded = (await loadMemory(true)) !== false; } finally { memHold.at = 0; }
    el.refuse(e, '그사이 다른 곳에서 바뀌었습니다');
    l1Say('그사이 다른 곳(에이전트·Slack)에서 바뀌었습니다' + (reloaded ? ' — 최신 내용을 불러왔습니다.' : ' — 최신 내용은 불러오지 못했습니다.') + (typed ? ' 작성하던 내용은 편집 칸에 그대로 있습니다 — 확인하고 다시 저장하세요.' : ' 다시 적용하세요.'), true);
    return false;
  }
  memHold.at = 0;
  if (r.ok && r.data && r.data.l1) {
    l1Unsay();
    _mem.l1[target] = r.data.l1;
    paintL1();
    return true;
  }
  el.refuse(e, '저장하지 못했습니다: ' + r.error);
  l1Say('저장하지 못했습니다: ' + r.error, true);
  return false;
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
  if (memHold()) return true;
  if (!_memPage || !_memPage.saving) return false;
  memStatus('저장 중입니다 — 끝난 뒤 다시 시도하세요', false);
  return true;
}
// The page editor's fields are locked while its save is out: an answer re-renders the
// editor, so nothing may be typed into it meanwhile (review R7).
function setPageFieldsDisabled(on) {
  if (!document.querySelectorAll) return;
  var els = document.querySelectorAll('#mem-page-detail input, #mem-page-detail textarea, #mem-page-detail select');
  for (var i = 0; i < els.length; i++) els[i].disabled = !!on;
}
// What the page editor holds that is not saved, as text — or null (review R12).
function pageUnsavedText() {
  if (!_memPage) return null;
  var raw = document.getElementById('pg-raw');
  if (raw && typeof raw.value === 'string') return raw.value !== (_memPage.raw || '') ? raw.value : null;
  var title = document.getElementById('pg-title');
  if (!title || typeof title.value !== 'string') return null;
  var d = pageDraft();
  var p = _memPage.page || {};
  var same = d.title === (p.title || '') && d.aliases.join(', ') === (p.aliases || []).join(', ')
    && d.current === (p.current || '') && d.history.join('\n') === (p.history || []).join('\n');
  return same ? null : pageDraftText(d);
}
// The page editor is about to show something else: its unsaved changes are kept.
function keepPageDraft() {
  var unsaved = pageUnsavedText();
  if (unsaved) memRecover(((_memPage && _memPage.page && _memPage.page.id) || '새 페이지') + ' 수정본', unsaved);
}
async function openPage(id, discard) {
  if (!discard && pageSaveBusy()) return;
  // Only the latest page opened is shown: an earlier one answering last is dropped (review R9).
  var seq = (openPage.seq = (openPage.seq || 0) + 1);
  var res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  if (seq !== openPage.seq) return;
  if (!res.ok) { memStatus('페이지를 열지 못했습니다: ' + ((data && data.error) || res.status), true); return; }
  if (!discard) keepPageDraft();
  _memPage = data;
  _memPageConflict = null;
  _memPageRaw = false;
  renderPageEditor();
  paintPageList();
}
function pageRawMode(on) {
  if (pageSaveBusy()) return;
  keepPageDraft(); // the other editor starts from the saved page
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
      + '<button type="button" class="btn link" onclick="removeHistoryLine(this)">빼기</button></div>';
  }
  html += '</div><button type="button" class="btn link" onclick="addHistoryLine()">History 줄 추가</button></div>'
    + '<div class="line"><button type="button" class="btn primary" onclick="savePage()">' + (isNew ? '만들기' : '저장') + '</button> '
    + (isNew ? '' : '<button type="button" class="btn" onclick="deletePage()">페이지 삭제</button> <button type="button" class="btn link" onclick="pageRawMode(true)">원문(markdown)으로 편집</button>') + '</div>';
  el.innerHTML = html;
}
// "빼기" on a History line waits for a save like every other edit (review R14).
function removeHistoryLine(btn) {
  if (pageSaveBusy()) return;
  if (btn && btn.parentNode) btn.parentNode.remove();
}
function addHistoryLine() {
  if (pageSaveBusy()) return;
  var box = document.getElementById('pg-history');
  var row = document.createElement('div');
  row.className = 'hist';
  var today = new Date().toISOString().slice(0, 10);
  row.innerHTML = '<input type="text" class="pg-hist" value="' + today + ': " aria-label="History 새 줄"><button type="button" class="btn link" onclick="removeHistoryLine(this)">빼기</button>';
  box.insertBefore(row, box.firstChild);
  row.firstChild.focus();
}
function newPageForm() {
  if (pageSaveBusy()) return;
  openPage.seq = (openPage.seq || 0) + 1; // a page still being opened is dropped: the latest action wins (review R13)
  keepPageDraft();
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
  memHold.at = Date.now();
  setPageFieldsDisabled(true);
  try { r = await apiWrite('PUT', '/api/memory/page', { id: id, title: d.title, aliases: d.aliases, current: d.current, history: d.history, revision: _memPage.revision }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (r.status === 409 && !isNew && _memPage === sentFrom) {
    // The hold and the locks last until the newer version is loaded, and are released
    // however that ends (review R12, as for L1 and episodic).
    try { await pageConflict409(id); } finally {
      sentFrom.saving = 0;
      memHold.at = 0;
      setPageFieldsDisabled(false);
    }
    return;
  }
  sentFrom.saving = 0;
  memHold.at = 0;
  if (_memPage !== sentFrom) return pageAnswerElsewhere(r, id, pageDraftText(d));
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
  memStatus('저장하지 못했습니다: ' + r.error, true);
}
// A page save was refused with 409: keep everything typed in the editor (title, aliases,
// Current, History — or the raw text) and let the user choose: overwrite with the draft,
// or load the latest (review P1). Called while the save still holds the tab.
async function pageConflict409(id) {
  var latest = null;
  var res = null;
  try {
    res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
    try { latest = await res.json(); } catch (_e) {}
  } catch (_e) {}
  _memPageConflict = res && res.ok && latest ? latest : { page: null, revision: null };
  renderPageConflict();
  memStatus('그사이 이 페이지가 바뀌었습니다. 작성하던 내용은 편집기에 그대로 있습니다.', true);
}
// A page answer that came back after the user opened another page: report it,
// refresh the list, leave the open editor alone (review R5).
async function pageAnswerElsewhere(r, id, unsent) {
  if (r.ok) memStatus(id + ' 페이지를 저장했습니다 (지금 연 페이지는 그대로)', false);
  else {
    // the refused draft has no editor any more: it is kept (review R11)
    if (unsent) memRecover(id + ' 페이지 수정본', unsent);
    memStatus(id + ' 페이지를 저장하지 못했습니다' + (r.status === 409 ? ' — 그사이 바뀌었습니다' : ': ' + r.error) + (unsent ? '. 작성한 내용은 보관했습니다' : ''), true);
  }
  await refreshPageIndex();
}
// A form draft as text, for the recovery box.
function pageDraftText(d) {
  return '제목: ' + d.title + (d.aliases && d.aliases.length ? '\n별칭: ' + d.aliases.join(', ') : '') + '\n\nCurrent:\n' + d.current + (d.history && d.history.length ? '\n\nHistory:\n' + d.history.join('\n') : '');
}
async function savePageRaw() {
  if (pageSaveBusy()) return;
  var ta = document.getElementById('pg-raw');
  var raw = ta ? ta.value : '';
  var sentFrom = _memPage; // as in savePage (review R5)
  var id = _memPage.page.id;
  var r;
  sentFrom.saving = Date.now();
  memHold.at = Date.now();
  setPageFieldsDisabled(true);
  try { r = await apiWrite('PUT', '/api/memory/page/raw', { id: id, raw: raw, revision: _memPage.revision }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (r.status === 409 && _memPage === sentFrom) {
    // as in savePage (review R12)
    try { await pageConflict409(id); } finally {
      sentFrom.saving = 0;
      memHold.at = 0;
      setPageFieldsDisabled(false);
    }
    return;
  }
  sentFrom.saving = 0;
  memHold.at = 0;
  if (_memPage !== sentFrom) return pageAnswerElsewhere(r, id, raw);
  setPageFieldsDisabled(false);
  if (r.ok) {
    _memPage = r.data;
    _memPageRaw = !(r.data && r.data.representable);
    renderPageEditor();
    memStatus('저장했습니다', false);
    await refreshPageIndex();
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
  if (!_memPageConflict || !_memPageConflict.revision || pageSaveBusy()) return; // (busy first: the conflict stays offered)
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
async function discardPageDraft() {
  var id = _memPage && _memPage.page && _memPage.page.id;
  if (!id || memHold()) return;
  _memPageConflict = null;
  // The user chose to drop this draft — this one only: the tab holds and the fields stay
  // locked until the latest is shown, so nothing typed or opened meanwhile is replaced (review R13).
  memHold.at = Date.now();
  setPageFieldsDisabled(true);
  try { await openPage(id, true); } finally {
    memHold.at = 0;
    setPageFieldsDisabled(false);
  }
}
async function deletePage() {
  if (pageSaveBusy()) return;
  // The page, revision and editor the dialog is about, fixed before it opens: a page
  // opened behind the dialog is not the one the delete may close (review R3, R9).
  var sentFrom = _memPage;
  var p = _memPage.page;
  var revision = _memPage.revision;
  // the editor is locked from the dialog on until the delete is answered: nothing typed in
  // that span exists to be lost (review R14, R15)
  setPageFieldsDisabled(true);
  var ok = await confirmDialog({ title: p.title + ' 페이지를 지울까요?', body: p.id + ' — Current와 History가 모두 사라집니다.', action: '페이지 삭제' });
  if (!ok || pageSaveBusy()) { setPageFieldsDisabled(false); return; } // (a save started while the dialog was open)
  sentFrom.saving = Date.now();
  memHold.at = Date.now();
  var r;
  try { r = await apiWrite('DELETE', '/api/memory/page', { id: p.id, revision: revision }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  sentFrom.saving = 0;
  memHold.at = 0;
  setPageFieldsDisabled(false);
  if (!r.ok) { memStatus((r.status === 409 ? '그사이 바뀌었습니다 — 다시 열어 확인하세요: ' : '지우지 못했습니다: ') + r.error, true); return; }
  // Close the editor only if it still shows the deleted page (review R5); changes it held
  // that were never saved go to the recovery box first (review R15).
  if (_memPage === sentFrom) { keepPageDraft(); _memPage = null; renderPageEditor(); }
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
  if (memHold()) {
    var picker = document.getElementById('mem-ep-date');
    if (picker && _memDay) picker.value = _memDay.date;
    return true;
  }
  if (!_memDay || !_memDay.saving) return false;
  memStatus('저장 중입니다 — 끝난 뒤 다시 시도하세요', false);
  var sel = document.getElementById('mem-ep-date');
  if (sel) sel.value = _memDay.date;
  return true;
}
async function loadDay(date, force) {
  if (!date || (!force && epBusy())) return;
  // Only the latest day request paints the view: an older one answering last is dropped (review R8).
  var seq = (loadDay.seq = (loadDay.seq || 0) + 1);
  var res;
  try { res = await fetch('/api/memory/episodic/' + encodeURIComponent(date)); } catch (e) {
    if (seq === loadDay.seq) memStatus('기록을 불러오지 못했습니다: ' + String(e && e.message || e), true);
    if (force) throw e;
    return;
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  if (seq !== loadDay.seq) return;
  // A write that started meanwhile holds the day on screen: this load is dropped (review R9).
  if (!force && _memDay && _memDay.saving) {
    var held = document.getElementById('mem-ep-date');
    if (held) held.value = _memDay.date;
    return;
  }
  if (!res.ok) { memStatus('기록을 불러오지 못했습니다: ' + ((data && data.error) || res.status), true); return false; }
  _memDay = data;
  document.getElementById('mem-ep-date').value = date;
  repaintDay();
  return true;
}
// The open episodic editor: the day, record and revision it was opened on. A save goes
// there, whatever day the view shows by then (review R6).
var _epEditor = null;
function renderDay(editIndex, draft) {
  // "수정" waits while an episodic write is out: its answer re-renders the day (review R8).
  if (typeof editIndex === 'number' && draft === undefined && epBusy()) return;
  if (typeof editIndex === 'number' && draft === undefined) {
    // opening another record's editor keeps the draft of the one it replaces (review R10)
    var replaced = openEpEditor();
    if (replaced && !(replaced.date === (_memDay && _memDay.date) && replaced.index === editIndex)) keepEpDraft(replaced);
  }
  var el = document.getElementById('mem-ep-body');
  var entries = (_memDay && _memDay.entries) || [];
  var edited = typeof editIndex === 'number' ? entries[editIndex] : undefined;
  var twins = 0;
  for (var q = 0; edited && q < entries.length; q++) if (entries[q].time === edited.time && entries[q].content === edited.content) twins++;
  // unique: no other record of the day had the same time and text when the editor
  // opened — only then can a later repaint tell which record it was (review R9).
  _epEditor = edited ? { date: _memDay.date, revision: _memDay.revision, index: editIndex, time: edited.time, content: edited.content, unique: twins === 1 } : null;
  if (!entries.length) { el.innerHTML = '<p class="lock">이 날의 기록이 없습니다.</p>'; return; }
  var html = '';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    html += '<div class="ep-entry"><div class="when">' + esc(e.time) + ' UTC</div>';
    if (editIndex === i) {
      html += '<textarea id="ep-edit" rows="5" aria-label="' + escAttr(e.time + ' 기록 수정') + '">' + esc(typeof draft === 'string' ? draft : e.content) + '</textarea>'
        + '<div class="actions"><button type="button" class="btn primary" onclick="epSave(' + i + ')">저장</button> <button type="button" class="btn" onclick="epCancel()">취소</button></div>';
    } else {
      html += '<div class="text">' + esc(e.content) + '</div>'
        + '<div class="actions"><button type="button" class="btn link" onclick="renderDay(' + i + ')">수정</button> <button type="button" class="btn link" onclick="epDelete(' + i + ')">삭제</button></div>';
    }
    html += '</div>';
  }
  el.innerHTML = html;
}
async function epWrite(method, url, payload, draft, at, orig, origTime, unique) {
  // The day is part of the record's identity: recover on the day the request was
  // for, even if the view moved to another day while it was in flight (review R4).
  var dayMatch = /\/api\/memory\/episodic\/([^/]+)\//.exec(url);
  var date = dayMatch ? decodeURIComponent(dayMatch[1]) : (_memDay && _memDay.date);
  var view = _memDay;
  var sentEditor = _epEditor; // the editor a save was sent from
  if (view) view.saving = Date.now();
  memHold.at = Date.now();
  // The open editor is locked while its save is out: a success re-renders it (review R8).
  var lockBox = method === 'PUT' ? document.getElementById('ep-edit') : null;
  if (lockBox) lockBox.disabled = true;
  var r;
  try { r = await apiWrite(method, url, payload); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (view) view.saving = 0;
  if (r.status === 409) {
    // The hold and the lock last until the reload is done: nothing typed meanwhile (review R11),
    // and are released however the reload ends (review R12).
    try {
      return await epRecover409(date, draft, orig, origTime, unique);
    } catch (_e) {
      memKeepDraft('mem-ep-new', draft, date + ' 기록 수정본');
      memStatus('그사이 이 날의 기록이 바뀌었는데 다시 불러오지 못했습니다. 작성하던 내용은 보관했습니다.', true);
      return false;
    } finally {
      memHold.at = 0;
      if (lockBox) lockBox.disabled = false;
    }
  }
  memHold.at = 0;
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
  if (r.ok) {
    _memDay = r.data.day;
    // its own editor closes on its save; any other open editor is kept (review R8, R9)
    if (method === 'PUT' && _epEditor === sentEditor) renderDay();
    else repaintDay();
    refreshDatesIfEmptied();
    return true;
  }
  if (elsewhere && draft) {
    memKeepDraft('mem-ep-new', draft, date + ' 기록 수정본');
    memStatus(date + ' 기록을 저장하지 못했습니다: ' + r.error + ' — 작성하던 내용은 보관했습니다.', true);
    return false;
  }
  memStatus('저장하지 못했습니다: ' + r.error, true);
  return false;
}
// A 409 reloads the day the request was for and puts the draft back where it belongs.
async function epRecover409(date, draft, orig, origTime, unique) {
  if ((await loadDay(date, true)) === false) {
    // the latest could not be loaded: the editor and its draft stay as they are (review R13)
    memStatus('그사이 이 날의 기록이 바뀌었는데 최신 내용을 불러오지 못했습니다. 작성하던 내용은 편집 칸에 그대로 있습니다.', true);
    return false;
  }
  if (!_memDay || _memDay.date !== date) { memKeepDraft('mem-ep-new', draft, date + ' 기록 수정본'); memStatus('그사이 이 날의 기록이 바뀌었습니다. 작성하던 내용은 보관했습니다.', true); return false; }
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
  // only a record that was unique when the editor opened (review R10) and is unique now
  var back = !!(draft && unique !== false && idx >= 0 && matches === 1);
  if (back) renderDay(idx, draft);
  else if (draft) memKeepDraft('mem-ep-new', draft, date + ' ' + (origTime || '') + ' 기록 수정본');
  memStatus('그사이 이 날의 기록이 바뀌어 최신 내용을 불러왔습니다.' + (draft ? (back ? ' 작성하던 내용은 편집 칸에 그대로 있습니다' : ' 작성하던 내용은 보관했습니다') + ' — 확인하고 다시 저장하세요.' : ' 다시 적용하세요.'), true);
  return false;
}
// The open episodic editor with what is typed in it, or null.
function openEpEditor() {
  var box = document.getElementById('ep-edit');
  return _epEditor && box ? { date: _epEditor.date, index: _epEditor.index, time: _epEditor.time, content: _epEditor.content, unique: _epEditor.unique, draft: box.value } : null;
}
// Repaint the shown day. What is typed survives (review R9): an open editor of this day is
// re-attached to the same record (time and text, only one such); otherwise — or when the
// view moved to another day — its draft goes to the note box.
function repaintDay() {
  var open = openEpEditor();
  if (open && _memDay && open.date === _memDay.date) { reopenEpEditor(open); return; }
  renderDay();
  if (open) keepEpDraft(open);
}
function keepEpDraft(open) {
  if (open.draft === open.content) return;
  memKeepDraft('mem-ep-new', open.draft, open.date + ' ' + open.time + ' 기록 수정본');
  memStatus('수정하던 ' + open.date + ' ' + open.time + ' 기록의 내용을 보관했습니다.', true);
}
// Re-open an editor on the record of the current day with the same time and text, if
// there is exactly one; otherwise close it and move the draft to the note box.
function reopenEpEditor(open) {
  var ents = (_memDay && _memDay.entries) || [];
  var at = -1;
  var same = 0;
  for (var k = 0; k < ents.length; k++) {
    if (ents[k].time === open.time && ents[k].content === open.content) {
      if (at < 0) at = k;
      same++;
    }
  }
  if (open.unique && same === 1) { renderDay(at, open.draft); return; }
  renderDay();
  keepEpDraft(open);
}
function epCancel() {
  if (epBusy()) return; // its save may still be refused: the editor stays until answered (review R12)
  renderDay();
}
async function epSave(i) {
  if (epBusy()) return;
  var ed = _epEditor;
  var ta = document.getElementById('ep-edit');
  if (!ed || ed.index !== i || !ta) return;
  var text = ta.value;
  if (!text.trim()) { memStatus('비어 있는 기록은 저장할 수 없습니다 — 지우려면 삭제를 쓰세요', true); return; }
  if (await epWrite('PUT', '/api/memory/episodic/' + ed.date + '/' + ed.index, { content: text, revision: ed.revision }, text, ed.index, ed.content, ed.time, ed.unique)) memStatus('저장했습니다', false);
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
  // A note holds the day on screen like any episodic write (review R8).
  var view = _memDay;
  if (view) view.saving = Date.now();
  memHold.at = Date.now();
  var r;
  try { r = await apiWrite('POST', '/api/memory/episodic', { text: text }); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (view) view.saving = 0;
  memHold.at = 0;
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
  var openToday = openEpEditor();
  if (openToday && openToday.date === r.data.day.date) {
    // A record of today is open for editing: re-attached to the same record (unique when
    // it opened and now), else its draft is kept — every case (review R7–R10).
    _memDay = r.data.day;
    reopenEpEditor(openToday);
    await refreshPageIndex();
    fillDateSelect();
    memStatus('오늘 기록에 추가했습니다 (수정 중인 기록은 그대로)', false);
    return;
  }
  // The view and its state move to today together, before anything is awaited (review R6).
  _memDay = r.data.day;
  renderDay();
  await refreshPageIndex();
  // the day came back with the answer: list today, show it, no reload (review R9)
  fillDateSelect();
  var sel = document.getElementById('mem-ep-date');
  if (sel) sel.value = _memDay.date;
  memStatus('오늘 기록에 추가했습니다', false);
}
`;
