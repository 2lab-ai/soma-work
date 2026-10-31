/**
 * The settings page "기억" tab (SSOT 2026-10-23 T3) — every personal memory, viewable and editable, each part
 * an @2lab.ai/ui element this tab gives the data and whose writes it carries:
 *   - 개인 메모리: 에이전트 노트 (MEMORY.md) and 사용자 프로필 (USER.md) — <ui-memory-panel> (one row per entry, a
 *     usage bar, add / edit / delete with undo / clear);
 *   - 지식 페이지: the semantic pages (agent / sites / concepts / projects / cron) — <ui-knowledge-pages> (M-05: a
 *     grouped, searchable list and an editor for title, aliases, Current and the dated History; create, delete),
 *     plus the page's own raw-markdown box for a page the form cannot hold;
 *   - 관찰 기록 (에피소딕): every day — <ui-episode-log> (M-06: a day filter, entries edited in place and deleted
 *     with two presses, a note added to today).
 *
 * UI decisions (research, SSOT T5): one row per entry, never the raw `§` format; every edit is conditional on the
 * revision the tab loaded — a 409 reloads that part and keeps the user's draft (the elements keep drafts across
 * updates); one memory write at a time across the tab. Rendering, keyboard and drafts are pinned by the library's
 * memory-panel / knowledge-pages / episode-log tests, the host glue by settings-memory-tab.test.ts.
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte).
 */

export const MEMORY_TAB_HTML = `<div slot="memory" data-tab="memory" class="page" hidden>
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
      <div class="ui-tok"><ui-knowledge-pages id="kp-panel" lang="ko"></ui-knowledge-pages></div>
      <p class="kp-tools" id="kp-tools" hidden><button type="button" class="ui-btn is-sm is-quiet" onclick="pageRawMode(true)">원문(markdown)으로 편집</button></p>
      <div class="kp-raw ui-card" id="kp-raw" hidden></div>
    </section>
    <section class="group" id="m-episodic" aria-labelledby="h-m-episodic">
      <header><h2 id="h-m-episodic">관찰 기록 (에피소딕)</h2><p>날짜별 기록입니다. 잘못 남은 기록은 고치거나 지울 수 있습니다.</p></header>
      <div class="ui-tok"><ui-episode-log id="ep-log" lang="ko"></ui-episode-log></div>
    </section>
  </main>
</div>`;

export const MEMORY_TAB_CSS = String.raw`
.navbtn { font: inherit; font-size: 13px; text-align: left; color: var(--text-secondary); background: none; border: 0; padding: 6px 10px; border-radius: 8px; cursor: pointer; }
.navbtn:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
/* The three parts are @2lab.ai/ui elements that draw their own surfaces: the sections keep only their headings
   — no card of their own, not even the group whisper shadow (tone pass P9). */
#m-l1, #m-pages, #m-episodic { background: none; border: 0; box-shadow: none; }
#m-l1 > header, #m-pages > header, #m-episodic > header { padding: 0 2px 10px; border-bottom: 0; }
#mem-l1-body:empty { display: none; }
/* <ui-knowledge-pages> fills the height it is given (its list and editor scroll inside it). */
#kp-panel { display: block; height: clamp(420px, calc(100dvh - 220px), 640px); }
.kp-tools { margin: 8px 0 0; text-align: right; }
.kp-raw { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; padding: 16px; }
.kp-raw[hidden] { display: none; }
.kp-raw-title { margin: 0; font-size: 13px; font-weight: 600; }
.kp-raw textarea { font-family: var(--mono); font-size: 12.5px; resize: vertical; }
.kp-raw-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.kp-raw .ui-notice p { margin: 0 0 8px; }
`;

export const MEMORY_CLIENT_JS = String.raw`
var _mem = null;          // GET /api/memory
var _memLoaded = false;
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
// A draft that has to leave its editor and has no box to go to is kept in the recovery box at the top of
// the tab — never dropped (review R10).
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
      + '<textarea class="ui-input is-block" readonly rows="3" aria-label="' + escAttr('저장되지 않은 내용: ' + items[i].label) + '">' + esc(items[i].text) + '</textarea>'
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
    paintPages();
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

// ── 지식 페이지 — @2lab.ai/ui <ui-knowledge-pages> ──
// The element draws the grouped, searchable list and the editor (title, aliases, Current with a preview,
// dated History), keeps every draft across updates and asks before leaving unsaved changes. This tab owns the
// data and the writes: ui-select loads a page, ui-save / ui-delete go to the page routes with the revision the
// page was loaded with, and a 409 hands the element a conflict — it keeps the draft and offers Reload or
// Overwrite (an overwrite writes over the revision this tab fetched with the conflict). A page the form cannot
// hold (representable: false), or one the user opens as raw markdown, is edited in the box under the element
// while the element is read-only: saving the form would drop what it cannot show (review R3).
var KP_EVENTS = ['ui-select', 'ui-new', 'ui-save', 'ui-delete', 'ui-reload'];
var KP_GROUPS = PAGE_GROUPS.map(function (g) { return { id: g[0], label: g[1] }; });
// open: GET /api/memory/page's answer for the page in the editor; latest: the newer one after a 409.
var _kp = { selected: null, open: null, loading: false, saving: false, error: '', status: '', conflict: '', latest: null, raw: false, rawConflict: null };
// "YYYY-MM-DD: text" (the store's History bullet) <-> { date, text }; a line without that prefix keeps date ''.
function kpHistoryIn(line) {
  var m = /^(\d{4}-\d{2}-\d{2}): ([\s\S]*)$/.exec(String(line));
  return m ? { date: m[1], text: m[2] } : { date: '', text: String(line) };
}
function kpHistoryOut(h) {
  return h.date && h.text ? h.date + ': ' + h.text : (h.date || h.text);
}
function kpPage(open) {
  var p = open.page;
  return { id: p.id, title: p.title, aliases: (p.aliases || []).slice(), group: p.type, current: p.current || '', history: (p.history || []).map(kpHistoryIn), revision: open.revision, updatedAt: p.updated };
}
function paintPages() {
  var el = document.getElementById('kp-panel');
  if (!_mem || !el) return;
  if (!el.kpBound) {
    el.kpBound = true;
    for (var i = 0; i < KP_EVENTS.length; i++) el.addEventListener(KP_EVENTS[i], kpOnEvent);
  }
  var pages = (_mem.pages || []).map(function (p) { return { id: p.id, title: p.title, aliases: p.aliases || [], group: p.type, updatedAt: p.updated }; });
  el.data = {
    pages: pages,
    groups: KP_GROUPS,
    selected: _kp.selected,
    page: _kp.open && _kp.open.page ? kpPage(_kp.open) : null,
    loading: _kp.loading,
    saving: _kp.saving,
    error: _kp.error,
    status: _kp.status,
    conflict: _kp.conflict,
    readOnly: _kp.raw,
  };
  var tools = document.getElementById('kp-tools');
  if (tools) tools.hidden = !(_kp.open && _kp.open.representable !== false && !_kp.raw && !_kp.loading);
  var box = document.getElementById('kp-raw');
  if (box) box.hidden = !(_kp.raw && _kp.open);
}
function kpOnEvent(e) {
  // One memory write at a time across the tab (review R10): a switch, a new page or a write waits for it.
  if (memHold()) { e.preventDefault(); return; }
  var d = e.detail || {};
  if (e.type === 'ui-select' || e.type === 'ui-reload') kpOpen(String(d.id));
  else if (e.type === 'ui-new') { keepRawDraft(); _kp.raw = false; _kp.error = ''; _kp.status = ''; paintPages(); }
  else if (e.type === 'ui-save') kpSave(e, d);
  else if (e.type === 'ui-delete') kpDelete(e, d);
}
// Opens a page (or the latest of the open one, for Reload). Only the latest open is shown: an earlier one
// answering last is dropped (review R9).
async function kpOpen(id) {
  var seq = (kpOpen.seq = (kpOpen.seq || 0) + 1);
  keepRawDraft();
  _kp.selected = id;
  _kp.loading = true;
  _kp.error = _kp.status = _kp.conflict = '';
  _kp.latest = _kp.rawConflict = null;
  _kp.raw = false;
  paintPages();
  var res = null;
  var data = null;
  try {
    res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
    try { data = await res.json(); } catch (_e) {}
  } catch (_e) {}
  if (seq !== kpOpen.seq) return false;
  _kp.loading = false;
  if (!res || !res.ok || !data || !data.page) {
    _kp.open = null;
    _kp.error = '페이지를 열지 못했습니다: ' + ((data && data.error) || (res ? res.status : '네트워크 오류'));
    paintPages();
    return false;
  }
  _kp.open = data;
  _kp.raw = data.representable === false;
  paintPages();
  renderPageRaw();
  return true;
}
// A new page's id: <group>/<name>, the name made from the title (letters, digits, - _ .), else from the clock;
// never one the index already has.
function kpNewId(group, title) {
  var type = KP_GROUPS.some(function (g) { return g.id === group; }) ? group : KP_GROUPS[0].id;
  var name = String(title || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  if (!name) name = 'page-' + Date.now().toString(36);
  var ids = (_mem.pages || []).map(function (p) { return p.id; });
  var id = type + '/' + name;
  for (var n = 2; ids.indexOf(id) >= 0; n++) id = type + '/' + name + '-' + n;
  return id;
}
async function kpSave(e, d) {
  var isNew = d.id === null || d.id === undefined;
  var id = isNew ? kpNewId(d.group, d.title) : String(d.id);
  var revision = isNew ? null : d.overwrite ? (_kp.latest && _kp.latest.revision) : d.revision;
  if (!isNew && typeof revision !== 'string') {
    e.preventDefault();
    _kp.error = '최신 내용을 불러오지 못해 덮어쓸 수 없습니다 — 다시 불러오세요';
    paintPages();
    return;
  }
  _kp.saving = true;
  _kp.error = _kp.status = '';
  memHold.at = Date.now();
  paintPages();
  var r;
  try {
    r = await apiWrite('PUT', '/api/memory/page', { id: id, title: d.title, aliases: d.aliases || [], current: d.current, history: (d.history || []).map(kpHistoryOut), revision: revision });
  } catch (x) { r = { ok: false, status: 0, error: String(x && x.message || x) }; }
  if (r.status === 409 && !isNew) {
    // The hold lasts until the newer version is fetched, and is released however that ends (review R12).
    try { await kpConflict(id); } finally {
      memHold.at = 0;
      _kp.saving = false;
      paintPages();
    }
    return;
  }
  memHold.at = 0;
  _kp.saving = false;
  if (r.ok && r.data && r.data.page) {
    _kp.open = { page: r.data.page, revision: r.data.revision, raw: r.data.raw, representable: r.data.representable };
    _kp.selected = r.data.page.id;
    _kp.conflict = '';
    _kp.latest = null;
    _kp.raw = r.data.representable === false;
    _kp.status = isNew ? id + ' 페이지를 만들었습니다' : '저장했습니다';
    paintPages();
    renderPageRaw();
    await refreshPageIndex();
    return;
  }
  _kp.error = isNew && r.status === 409 ? id + ' 페이지가 이미 있습니다 — 제목을 바꿔 다시 만드세요' : '저장하지 못했습니다: ' + r.error;
  paintPages();
}
// A save refused with 409: fetch the newer version (its revision is what Overwrite writes over) and tell the
// element; its draft stays in the editor (review P1).
async function kpConflict(id) {
  var res = null;
  var latest = null;
  try {
    res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
    try { latest = await res.json(); } catch (_e) {}
  } catch (_e) {}
  _kp.latest = res && res.ok && latest && latest.page ? latest : null;
  _kp.conflict = '다른 곳(에이전트·Slack)에서 이 페이지를 고쳤습니다' + (_kp.latest ? ' (마지막 수정 ' + _kp.latest.page.updated + ')' : ' — 최신 내용은 불러오지 못했습니다') + '.';
}
async function kpDelete(e, d) {
  if (typeof d.revision !== 'string') { e.preventDefault(); return; }
  var ok = await kpDeleteWrite(String(d.id), d.revision);
  if (!ok) paintPages();
}
// Deletes a page; on success the editor closes if it still shows that page, and the list loses it (the element
// drops its draft once the id leaves the list).
async function kpDeleteWrite(id, revision) {
  _kp.saving = true;
  _kp.error = _kp.status = '';
  memHold.at = Date.now();
  paintPages();
  var r;
  try { r = await apiWrite('DELETE', '/api/memory/page', { id: id, revision: revision }); } catch (x) { r = { ok: false, status: 0, error: String(x && x.message || x) }; }
  memHold.at = 0;
  _kp.saving = false;
  if (!r.ok) {
    _kp.error = (r.status === 409 ? '그사이 바뀌었습니다 — 다시 불러와 확인하세요: ' : '지우지 못했습니다: ') + r.error;
    return false;
  }
  if (_kp.selected === id) { _kp.selected = null; _kp.open = null; _kp.raw = false; _kp.rawConflict = null; }
  memStatus(id + ' 페이지를 지웠습니다', false);
  await refreshPageIndex();
  return true;
}
// ── 원문(markdown) 편집 — the page's own box under the element ──
function pageRawMode(on) {
  if (memHold() || !_kp.open) return;
  if (!on && _kp.open.representable === false) return;
  if (!on) keepRawDraft(); // the form starts from the saved page
  _kp.raw = !!on;
  _kp.rawConflict = null;
  paintPages();
  renderPageRaw();
}
function renderPageRaw() {
  var box = document.getElementById('kp-raw');
  if (!box) return;
  if (!_kp.raw || !_kp.open) { box.innerHTML = ''; return; }
  var forced = _kp.open.representable === false;
  var c = _kp.rawConflict;
  box.innerHTML = '<h3 class="kp-raw-title">' + esc(_kp.open.page.id) + ' — 원문 (markdown)</h3>'
    + (forced ? '<div class="ui-notice" role="note">이 페이지에는 편집 양식에 담기지 않는 내용이 있어 원문(markdown) 그대로 고칩니다. 내용은 하나도 빠지지 않습니다.</div>' : '')
    + (c ? '<div class="ui-notice" data-tone="fail" role="alert"><p>다른 곳(에이전트·Slack)에서 이 페이지를 고쳤습니다' + (c.page ? ' (마지막 수정 ' + esc(c.page.updated) + ')' : '') + '.</p>'
      + '<div class="kp-raw-actions"><button type="button" class="ui-btn is-danger" onclick="overwritePageRaw()">내 수정본으로 덮어쓰기</button> '
      + '<button type="button" class="ui-btn" onclick="discardPageRaw()">최신 내용 불러오기 (내 수정 버림)</button></div></div>' : '')
    + '<label class="ui-sr-only" for="pg-raw">원문 (markdown)</label><textarea id="pg-raw" class="ui-input is-block" rows="18" spellcheck="false">' + esc(_kp.open.raw || '') + '</textarea>'
    + '<div class="kp-raw-actions"><button type="button" class="ui-btn is-primary" onclick="savePageRaw()">저장</button> '
    + (forced ? '' : '<button type="button" class="ui-btn" onclick="pageRawMode(false)">양식으로 돌아가기</button> ')
    + '<button type="button" class="ui-btn is-danger" onclick="deletePageRaw()">페이지 삭제</button></div>';
}
// What the raw box holds that is not saved — kept in the recovery box when the box is about to show another page.
function keepRawDraft() {
  var ta = document.getElementById('pg-raw');
  if (!_kp.raw || !_kp.open || !ta || typeof ta.value !== 'string' || ta.value === (_kp.open.raw || '')) return;
  memRecover(_kp.open.page.id + ' 원문 수정본', ta.value);
}
function setRawDisabled(on) {
  var els = document.querySelectorAll ? document.querySelectorAll('#kp-raw textarea, #kp-raw button') : [];
  for (var i = 0; i < els.length; i++) els[i].disabled = !!on;
}
async function savePageRaw() {
  if (memHold() || !_kp.open) return;
  var ta = document.getElementById('pg-raw');
  var raw = ta ? ta.value : '';
  var sentFrom = _kp.open;
  var id = sentFrom.page.id;
  memHold.at = Date.now();
  setRawDisabled(true);
  var r;
  try { r = await apiWrite('PUT', '/api/memory/page/raw', { id: id, raw: raw, revision: sentFrom.revision }); } catch (x) { r = { ok: false, status: 0, error: String(x && x.message || x) }; }
  if (r.status === 409) {
    try {
      var res = await fetch('/api/memory/page?id=' + encodeURIComponent(id));
      var latest = null;
      try { latest = await res.json(); } catch (_e) {}
      _kp.rawConflict = res.ok && latest && latest.page ? latest : { page: null, revision: null };
    } catch (_e) {
      _kp.rawConflict = { page: null, revision: null };
    } finally {
      memHold.at = 0;
    }
    renderPageRaw();
    var box = document.getElementById('pg-raw');
    if (box) box.value = raw; // what was typed stays in the box (review P1)
    memStatus('그사이 이 페이지가 바뀌었습니다. 작성하던 내용은 편집 칸에 그대로 있습니다.', true);
    return;
  }
  memHold.at = 0;
  setRawDisabled(false);
  if (r.ok && r.data && r.data.page) {
    _kp.open = r.data;
    _kp.rawConflict = null;
    _kp.raw = !r.data.representable;
    _kp.status = '저장했습니다';
    paintPages();
    renderPageRaw();
    memStatus('저장했습니다', false);
    await refreshPageIndex();
    return;
  }
  memStatus('저장하지 못했습니다: ' + r.error, true);
}
function overwritePageRaw() {
  var c = _kp.rawConflict;
  if (!c || !c.revision || !_kp.open || memHold()) return;
  var ta = document.getElementById('pg-raw');
  var draft = ta ? ta.value : '';
  // The box now stands on the newer page: its revision, never the one first opened (review R4).
  _kp.open = { page: c.page, revision: c.revision, raw: c.raw, representable: c.representable };
  _kp.rawConflict = null;
  renderPageRaw();
  var box = document.getElementById('pg-raw');
  if (box) box.value = draft;
  return savePageRaw();
}
function discardPageRaw() {
  if (!_kp.open || memHold()) return;
  _kp.raw = false; // the user dropped this draft: nothing to keep
  kpOpen(_kp.open.page.id);
}
async function deletePageRaw() {
  if (memHold() || !_kp.open) return;
  // The page and revision the dialog is about, fixed before it opens (review R3, R9).
  var p = _kp.open.page;
  var revision = _kp.open.revision;
  setRawDisabled(true);
  var ok = await confirmDialog({ title: p.title + ' 페이지를 지울까요?', body: p.id + ' — Current와 History가 모두 사라집니다.', action: '페이지 삭제' });
  if (!ok || memHold() || !_kp.open || _kp.open.page.id !== p.id) { setRawDisabled(false); return; }
  if (!(await kpDeleteWrite(p.id, revision))) { setRawDisabled(false); memStatus(_kp.error, true); paintPages(); return; }
  renderPageRaw();
}
// The index (pages, episodic dates) after a write; a failed refresh keeps what is on screen.
async function refreshPageIndex() {
  try {
    var res = await fetch('/api/memory');
    if (res.ok) {
      var data = await res.json();
      _mem.pages = data.pages;
      _mem.episodicDates = data.episodicDates;
    }
  } catch (_e) {}
  paintPages();
  epDatesChanged();
}

// ── 관찰 기록 (에피소딕) — @2lab.ai/ui <ui-episode-log> ──
// The element draws the day filter, each day's entries with in-place edit and a two-press delete, and the note
// box; an open editor and a note survive data updates (a draft whose entry changed moves to the note box). This
// tab loads days (GET /api/memory/episodic/:date), and each write goes to the day's route with the revision that
// day was loaded with; a 409 reloads the day and the element keeps what was typed. Times are UTC, as the store
// writes them, and "today" is the store's (UTC) day, the one a note lands in.
var EP_EVENTS = ['ui-date', 'ui-edit', 'ui-delete', 'ui-add'];
var _ep = { days: {}, date: null, today: '', loading: false, busy: false, status: '', error: '' };
function epToday() {
  return _ep.today || new Date().toISOString().slice(0, 10);
}
function epDay(d) {
  return { date: d.date, revision: d.revision, entries: (d.entries || []).map(function (e) { return { time: e.time, text: e.content }; }) };
}
// Every day with entries, newest first: the index's dates and any day loaded since (a note's day before the
// index is refreshed).
function epDates() {
  var dates = ((_mem && _mem.episodicDates) || []).slice();
  for (var k in _ep.days) if (Object.prototype.hasOwnProperty.call(_ep.days, k) && dates.indexOf(k) < 0) dates.push(k);
  return dates.sort().reverse();
}
function paintEpisodes() {
  var el = document.getElementById('ep-log');
  if (!_mem || !el) return;
  if (!el.epBound) {
    el.epBound = true;
    for (var i = 0; i < EP_EVENTS.length; i++) el.addEventListener(EP_EVENTS[i], epOnEvent);
  }
  var days = [];
  for (var k in _ep.days) if (Object.prototype.hasOwnProperty.call(_ep.days, k)) days.push(epDay(_ep.days[k]));
  el.data = {
    days: days,
    dates: epDates(),
    date: _ep.date,
    today: epToday(),
    timeLabel: 'UTC',
    loading: _ep.loading,
    busy: _ep.busy,
    status: _ep.status,
    error: _ep.error,
    addLabel: '오늘 기록에 메모 추가',
    placeholder: '에이전트가 참고할 메모',
    emptyText: '아직 관찰 기록이 없습니다. 턴이 끝날 때마다 자동으로 쌓입니다.',
  };
}
// After the index is (re)loaded: the shown day is (re)loaded — the newest when none is shown or it is gone.
function paintDates() {
  epDatesChanged(true);
}
function epDatesChanged(reload) {
  // (a loaded day leaves only with its last entry — epTakeDay — never because a refresh missed it)
  var dates = epDates();
  var moved = false;
  if (_ep.date && dates.indexOf(_ep.date) < 0) { _ep.date = null; moved = true; }
  if (!_ep.date && dates.length && (moved || !epDatesChanged.seen)) { _ep.date = dates[0]; moved = true; }
  epDatesChanged.seen = true;
  paintEpisodes();
  if (_ep.date && (reload || (moved && !_ep.days[_ep.date]))) loadDay(_ep.date);
}
// Only the latest day request paints (review R8); one answered while a write is out is dropped — the write's
// answer carries its day (review R9) — unless it is that write's own 409 reload (force).
async function loadDay(date, force) {
  if (!date) return false;
  var seq = (loadDay.seq = (loadDay.seq || 0) + 1);
  _ep.loading = true;
  paintEpisodes();
  var res = null;
  var data = null;
  try {
    res = await fetch('/api/memory/episodic/' + encodeURIComponent(date));
    try { data = await res.json(); } catch (_e) {}
  } catch (_e) {}
  if (seq !== loadDay.seq) return false;
  _ep.loading = false;
  if (!force && memHold.at) { paintEpisodes(); return false; }
  if (!res || !res.ok || !data) {
    _ep.error = '기록을 불러오지 못했습니다: ' + ((data && data.error) || (res ? res.status : '네트워크 오류'));
    paintEpisodes();
    return false;
  }
  _ep.days[date] = data;
  paintEpisodes();
  return true;
}
function epOnEvent(e) {
  if (memHold()) { e.preventDefault(); return; }
  var d = e.detail || {};
  if (e.type === 'ui-date') {
    _ep.date = d.date || null;
    _ep.error = _ep.status = '';
    paintEpisodes();
    if (_ep.date && !_ep.days[_ep.date]) loadDay(_ep.date);
    return;
  }
  if (e.type === 'ui-add') { epAdd(String(d.text || '')); return; }
  // An edit or delete names its entry by day, index and text: the index goes to the server only while that day,
  // as loaded here, still holds that text there (the revision guards the server's side).
  var day = _ep.days[d.date];
  var cur = day && day.entries ? day.entries[d.index] : null;
  var named = e.type === 'ui-edit' ? d.original : d.text;
  if (!cur || cur.content !== named) {
    e.preventDefault();
    _ep.error = '그사이 이 기록이 바뀌었습니다 — 최신 내용을 불러왔습니다. 확인하고 다시 하세요.';
    loadDay(d.date, true);
    return;
  }
  var url = '/api/memory/episodic/' + encodeURIComponent(d.date) + '/' + d.index;
  if (e.type === 'ui-edit') epWrite('PUT', url, { content: d.text, revision: day.revision }, d.date, '저장했습니다', '저장하지 못했습니다: ');
  else if (e.type === 'ui-delete') epWrite('DELETE', url, { revision: day.revision }, d.date, '지웠습니다', '지우지 못했습니다: ');
}
// One episodic edit or delete. The tab is held until it is answered — a 409 until the day is reloaded too
// (review R11), released however that ends (review R12).
async function epWrite(method, url, payload, date, okText, failText) {
  memHold.at = Date.now();
  _ep.busy = true;
  _ep.error = _ep.status = '';
  paintEpisodes();
  var r;
  try { r = await apiWrite(method, url, payload); } catch (x) { r = { ok: false, status: 0, error: String(x && x.message || x) }; }
  if (r.status === 409) {
    var reloaded = false;
    try { reloaded = (await loadDay(date, true)) === true; } finally {
      memHold.at = 0;
      _ep.busy = false;
    }
    _ep.error = '그사이 이 날의 기록이 바뀌었습니다' + (reloaded ? ' — 최신 내용을 불러왔습니다.' : ' — 최신 내용은 불러오지 못했습니다.') + (method === 'PUT' ? ' 작성하던 내용은 그대로 있습니다 — 확인하고 다시 저장하세요.' : ' 다시 확인하세요.');
    paintEpisodes();
    return false;
  }
  memHold.at = 0;
  _ep.busy = false;
  if (r.ok && r.data && r.data.day) {
    epTakeDay(r.data.day);
    _ep.status = okText;
    paintEpisodes();
    // the last entry of a day was deleted (the file is gone): the dates change
    if (!r.data.day.entries || !r.data.day.entries.length) await refreshPageIndex();
    return true;
  }
  _ep.error = failText + r.error;
  paintEpisodes();
  return false;
}
function epTakeDay(day) {
  if (day.entries && day.entries.length) _ep.days[day.date] = day;
  else delete _ep.days[day.date];
}
// A note goes to today's log (the store's day). The element shows it pending and empties its box once the
// note is in today's entries; a refused note stays in the box.
async function epAdd(text) {
  if (!text.trim()) return;
  memHold.at = Date.now();
  _ep.busy = true;
  _ep.error = _ep.status = '';
  paintEpisodes();
  var r;
  try { r = await apiWrite('POST', '/api/memory/episodic', { text: text }); } catch (x) { r = { ok: false, status: 0, error: String(x && x.message || x) }; }
  memHold.at = 0;
  _ep.busy = false;
  if (!(r.ok && r.data && r.data.day)) {
    _ep.error = '추가하지 못했습니다: ' + r.error;
    paintEpisodes();
    return false;
  }
  var day = r.data.day;
  _ep.today = day.date;
  epTakeDay(day);
  _ep.status = !_ep.date || _ep.date === day.date ? '오늘 기록에 추가했습니다' : '오늘(' + day.date + ') 기록에 추가했습니다 — 지금 보는 날은 그대로';
  paintEpisodes();
  await refreshPageIndex();
  return true;
}
`;
