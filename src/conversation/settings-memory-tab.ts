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
    <div id="mem-recover"></div>
    <section class="group" id="m-l1" aria-labelledby="h-m-l1">
      <header><h2 id="h-m-l1">개인 메모리<span id="l1-total" class="mm-count" aria-hidden="true"></span></h2><p>짧은 항목 목록입니다. 용량이 차면 에이전트가 새로 기억하지 못하니, 오래된 항목을 지우거나 합치세요.</p></header>
      <div id="l1-panel" class="mm">
        <div id="l1-filters" class="mm-filters">
          <div id="l1-chips" class="mm-chips" role="radiogroup" aria-label="저장소" onkeydown="l1ChipKey(event)">
            <button type="button" id="l1-chip-all" class="mm-chip" role="radio" aria-checked="true" tabindex="0" onclick="l1Pick('')">전체 <span id="l1-n-all" class="mm-chip-n"></span></button>
            <button type="button" id="l1-chip-memory" class="mm-chip" role="radio" aria-checked="false" tabindex="-1" onclick="l1Pick('memory')">에이전트 노트 <span id="l1-n-memory" class="mm-chip-n"></span></button>
            <button type="button" id="l1-chip-user" class="mm-chip" role="radio" aria-checked="false" tabindex="-1" onclick="l1Pick('user')">사용자 프로필 <span id="l1-n-user" class="mm-chip-n"></span></button>
          </div>
          <div id="l1-search" class="mm-search" inert>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.25" stroke="currentColor" stroke-width="1.5"/><path d="M9.25 9.25 12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <input type="search" id="l1-q" placeholder="항목 검색" aria-label="개인 메모리 검색" autocomplete="off" oninput="l1SearchInput(this.value)" onkeydown="l1SearchKey(event)">
            <button type="button" class="mm-icon" aria-label="검색 닫기" onclick="l1SearchClose()">&times;</button>
          </div>
          <button type="button" id="l1-search-open" class="mm-icon mm-search-open" aria-label="개인 메모리 검색" aria-expanded="false" aria-controls="l1-search" onclick="l1SearchOpen()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.25" stroke="currentColor" stroke-width="1.5"/><path d="M9.25 9.25 12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
        </div>
        <div id="mem-l1-body" class="mm-list"><div class="notice">불러오는 중…</div></div>
        <div id="l1-foot" class="mm-foot" onmouseenter="l1TrayHold('hover', true)" onmouseleave="l1TrayHold('hover', false)">
          <span id="l1-caption" class="mm-caption" aria-hidden="true"></span>
          <span id="l1-live" class="mm-sr" role="status" aria-live="polite" aria-atomic="true"></span>
          <button type="button" id="l1-undo" class="mm-undo" hidden onclick="l1Undo()">되돌리기</button>
        </div>
      </div>
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
/* ── 개인 메모리 (L1) — memory panel ── */
/* store chips · search · one group per store · in-place edit · tray with undo
   (.prd/affectui/re-memory-panel.md D1–D17); settings tokens only. */
.mm { --mm-fold: 320ms; --mm-warn: var(--yellow); container-type: inline-size; }
[data-theme="light"] .mm { --mm-warn: #9a6700; }
.mm:not([data-ready]) .mm-filters, .mm:not([data-ready]) .mm-foot { display: none; }
.mm-count { display: inline-block; min-width: 20px; height: 20px; margin-left: 8px; padding: 0 6px; border-radius: 5px; background: var(--surface-raised); font-size: 12px; font-weight: 500; line-height: 20px; text-align: center; color: var(--text-tertiary); font-variant-numeric: tabular-nums; vertical-align: 1px; letter-spacing: 0; }
.mm-count:empty { display: none; }
.mm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.mm :is(button, input, textarea):focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.mm-filters { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px; padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--border); }
.mm-chips, .mm-search { grid-area: 1 / 1; transition: opacity 220ms ease, filter 220ms ease; }
.mm-chips { display: flex; gap: 4px; min-width: 0; margin: -3px -4px; padding: 3px 4px; overflow-x: auto; scrollbar-width: none; mask-image: linear-gradient(90deg, black calc(100% - 14px), transparent); }
.mm-chips::-webkit-scrollbar { display: none; }
.mm-chip { display: inline-flex; flex: none; align-items: center; gap: 5px; height: 28px; padding: 0 9px; font: inherit; font-size: 12.5px; color: var(--text-secondary); background: none; border: 0; border-radius: 8px; white-space: nowrap; cursor: pointer; transition: background-color var(--dur-press) ease, color var(--dur-press) ease, box-shadow var(--dur-press) ease; }
.mm-chip[aria-checked="true"] { background: var(--surface-raised); color: var(--text); font-weight: 600; box-shadow: inset 0 0 0 1px var(--border); }
.mm-chip-n { font-size: 11.5px; font-weight: 400; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.mm-search { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 2px 0 9px; border-radius: 8px; background: var(--surface-raised); color: var(--text-tertiary); opacity: 0; visibility: hidden; }
.mm-search input { flex: 1; min-width: 0; height: 28px; padding: 0; font: inherit; font-size: 13px; color: var(--text); background: none; border: 0; outline: none; }
.mm-search input::placeholder { color: var(--text-tertiary); }
.mm-search input::-webkit-search-cancel-button { display: none; }
.mm .mm-search input:focus-visible { outline: none; }
.mm-search:focus-within { box-shadow: inset 0 0 0 1px var(--border-focus); }
.mm-filters[data-searching] .mm-chips { opacity: 0; filter: blur(2px); }
.mm-filters[data-searching] .mm-search { grid-area: 1 / 1 / 2 / 3; opacity: 1; visibility: visible; }
.mm-filters[data-searching] .mm-search-open { opacity: 0; visibility: hidden; }
.mm-icon { display: grid; flex: none; place-items: center; width: 28px; height: 28px; padding: 0; font: inherit; font-size: 16px; line-height: 1; color: var(--text-tertiary); background: none; border: 0; border-radius: 8px; cursor: pointer; transition: background-color var(--dur-press) ease, color var(--dur-press) ease, opacity 200ms ease; }
.mm-search-open { grid-area: 1 / 2; }
.mm-list { padding: 2px 8px 6px; }
.mm-fold { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--mm-fold) var(--ease-out), opacity var(--dur-fade) ease; }
.mm-fold[data-open] { grid-template-rows: 1fr; opacity: 1; transition: grid-template-rows var(--mm-fold) var(--ease-out), opacity 240ms ease 60ms; }
.mm-fold[data-leaving] { transition: grid-template-rows var(--mm-fold) var(--ease-out), opacity 200ms ease, filter 200ms ease; filter: blur(2px); }
.mm-clip { min-height: 0; overflow: hidden; }
.mm-ghead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 16px; padding: 12px 8px 4px; }
.mm-ghead h3 { font-size: 13px; font-weight: 600; }
.mm-ghead .sub { margin-left: 4px; font-size: 12px; font-weight: 400; color: var(--text-tertiary); }
.mm-ghead .meter-line { flex: 0 1 280px; margin: 0; }
.mm .meter-line.is-warn, .mm-over { color: var(--mm-warn); }
.mm-items { list-style: none; }
.mm-row { padding: 6px 8px 5px; border-radius: 8px; transition: background-color var(--dur-press) ease; }
.mm-row:hover, .mm-row:focus-within, .mm-row[data-editing] { background: var(--surface-raised); }
.mm-text { font-size: 13px; line-height: 20px; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
.mm-meta { display: flex; align-items: center; gap: 6px; min-height: 26px; font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.mm-src { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mm-acts { display: inline-flex; flex: none; align-items: center; gap: 2px; margin: -1px -4px -1px auto; opacity: 0; transition: opacity 180ms ease; }
.mm-row:hover .mm-acts, .mm-row:focus-within .mm-acts, .mm-acts.is-on { opacity: 1; }
.mm-act { height: 26px; padding: 0 9px; font: inherit; font-size: 12.5px; font-weight: 500; color: var(--text-secondary); background: none; border: 0; border-radius: 8px; cursor: pointer; transition: background-color var(--dur-press) ease, color var(--dur-press) ease, opacity var(--dur-press) ease; }
.mm-act-main { background: var(--text); color: var(--surface); }
.mm-act:disabled { opacity: 0.4; cursor: default; }
.mm textarea.mm-edit { display: block; width: 100%; min-height: 20px; margin: 0; padding: 0; font-size: 13px; line-height: 20px; color: var(--text); background: none; border: 0; border-radius: 0; resize: none; overflow: hidden; }
.mm textarea.mm-edit:focus-visible { outline: none; }
.mm-row[data-editing]:focus-within, .mm-new:focus-within { box-shadow: inset 0 0 0 1px var(--border-focus); }
.mm-empty { padding: 4px 8px 8px; font-size: 12.5px; color: var(--text-tertiary); }
.mm-nomatch { padding: 18px 8px 12px; text-align: center; }
.mm-addline { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 3px 8px; } /* room for the focus ring inside the clipping fold */
.mm-add { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 8px; font: inherit; font-size: 13px; color: var(--text-tertiary); background: none; border: 0; border-radius: 8px; cursor: pointer; transition: background-color var(--dur-press) ease, color var(--dur-press) ease; }
.mm-clear { height: 28px; padding: 0 8px; font: inherit; font-size: 12px; color: var(--text-tertiary); background: none; border: 0; border-radius: 8px; cursor: pointer; transition: background-color var(--dur-press) ease, color var(--dur-press) ease; }
.mm-new { margin: 2px 0 8px; padding: 8px 8px 6px; border-radius: 8px; background: var(--surface-raised); }
.mm-new label { display: block; margin-bottom: 4px; }
.mm-new .line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; margin-top: 6px; }
.mm-foot { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 4px 8px 4px 16px; border-top: 1px solid var(--border); border-radius: 0 0 9px 9px; background: var(--bg); }
.mm-caption { display: grid; flex: 1; min-width: 0; font-size: 12.5px; color: var(--text-tertiary); white-space: nowrap; font-variant-numeric: tabular-nums; }
.mm-caption b { font-weight: 600; color: var(--text); }
.mm-swap { grid-area: 1 / 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; animation: mm-swap-in 320ms ease both; }
.mm-swap[data-out] { animation: mm-swap-out 220ms ease both; }
.mm-forgot { display: flex; min-width: 0; }
.mm-flat { flex: none; white-space: pre; }
.mm-quote { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.mm-undo { display: inline-flex; flex: none; align-items: center; height: 28px; padding: 0 10px; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; animation: mm-swap-in 300ms ease both; }
.mm-undo[hidden] { display: none; }
@keyframes mm-swap-in { from { opacity: 0; filter: blur(2px); } }
@keyframes mm-swap-out { to { opacity: 0; filter: blur(2px); } }
@media (hover: hover) and (pointer: fine) {
  .mm-chip:hover, .mm-icon:hover, .mm-add:hover { background: var(--surface-raised); color: var(--text); }
  .mm-act:hover { background: var(--surface); color: var(--text); }
  .mm-act-main:hover { background: var(--text); color: var(--surface); opacity: 0.86; }
  .mm-act-del:hover, .mm-clear:hover { background: var(--danger-bg); color: var(--red); }
  .mm-undo:hover { border-color: var(--accent); }
}
@container (max-width: 480px) { .mm-cap { display: none; } .mm-ghead .meter-line { flex-basis: 100%; } }
@container (max-width: 340px) { .mm-chip-n { display: none; } .mm-chip { padding: 0 7px; } }
@media (pointer: coarse) { .mm-acts { opacity: 1; } .mm-act, .mm-chip, .mm-clear { height: 32px; } .mm-icon { width: 32px; height: 32px; } .mm-meta { min-height: 32px; } .mm-add, .mm-undo { height: 36px; } }
@media (prefers-reduced-motion: reduce) { .mm *, .mm *::before, .mm *::after { animation: none !important; transition: none !important; } }
.meter-line { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.meter-line meter { flex: 1; height: 8px; }
.meter-line.is-warn { color: var(--yellow); }
.meter-line.is-full { color: var(--red); }
textarea { width: 100%; font: inherit; font-size: 13px; color: var(--text); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 8px; padding: 8px; resize: vertical; }
textarea:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.counter { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.counter.is-over { color: var(--red); }
/* ── end 개인 메모리 (L1) ── */
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
var _memUndo = null;      // last single delete, offered on the tray: { target, text, key, left, timer }
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
// One panel (affectUI Memory Panel, #443 — .prd/affectui/re-memory-panel.md): store chips,
// search, one group per store, in-place edit, a delete that folds away at once with a 5 s
// undo on the tray. The chrome (chips, search, tray) is static markup; paintL1 repaints the
// groups only. View state lives on paintL1 like the open editor: paintL1.view (chip +
// search), paintL1.adding (open add editors).
//
// One store group. ctx = { view, adding } (absent: everything shown, add editor folded).
// Name and first three parameters are the card renderer's (settings-memory-tab.test.ts loads it).
function renderL1Card(target, block, editing, ctx) {
  var pct = block.charLimit > 0 ? Math.round((block.totalChars / block.charLimit) * 100) : 0;
  var state = pct >= 100 ? ' is-full' : pct >= 80 ? ' is-warn' : '';
  var view = ctx && ctx.view;
  var inView = !view || !view.target || view.target === target;
  var q = view && view.q ? String(view.q).trim() : '';
  var adding = !!(ctx && ctx.adding);
  var entries = block.entries || [];
  var rows = '';
  var shown = 0;
  for (var i = 0; i < entries.length; i++) {
    var isEdit = editing && editing.index === i;
    var show = inView && (!view || isEdit || l1Matches(target, entries[i], view));
    if (show) shown++;
    var row;
    if (isEdit) {
      var n = String(editing.text || '').trim().length;
      row = '<div class="mm-row" data-editing><textarea id="l1-edit-' + target + '" class="mm-edit" rows="1" aria-label="' + escAttr(L1_LABELS[target] + ' ' + (i + 1) + '번 수정') + '" onkeydown="l1EditKey(event,\'' + target + '\',' + i + ')" oninput="l1EditInput(this,\'' + target + '\')">' + esc(editing.text) + '</textarea>'
        + '<div class="mm-meta"><span class="counter' + (n > block.perEntryCap ? ' is-over' : '') + '" id="l1-ecount-' + target + '">' + fmtNum(n) + ' / ' + fmtNum(block.perEntryCap) + '자</span>'
        + '<span class="mm-acts is-on"><button type="button" class="mm-act" onclick="l1Cancel()">취소</button>'
        + '<button type="button" class="mm-act mm-act-main" onclick="l1Save(\'' + target + '\',' + i + ')">저장</button></span></div></div>';
    } else {
      var len = entries[i].length;
      var short = len > 40 ? entries[i].slice(0, 40) + '…' : entries[i];
      row = '<div class="mm-row"><p class="mm-text">' + esc(entries[i]) + '</p><div class="mm-meta">'
        + '<span class="mm-src">#' + (i + 1) + ' · ' + fmtNum(len) + '자' + (len > block.perEntryCap ? ' · <span class="mm-over">한 항목 한도 초과</span>' : '') + '</span>'
        + '<span class="mm-acts"><button type="button" class="mm-act" id="l1-ed-' + target + '-' + i + '" aria-label="' + escAttr('수정: “' + short + '”') + '" onclick="l1EditStart(\'' + target + '\',' + i + ')">수정</button>'
        + '<button type="button" class="mm-act mm-act-del" id="l1-del-' + target + '-' + i + '" aria-label="' + escAttr('삭제: “' + short + '”') + '" onkeydown="l1KeyGuard(event)" onclick="l1Delete(\'' + target + '\',' + i + ')">삭제</button></span></div></div>';
    }
    rows += '<li><div class="mm-fold" id="l1-f-' + target + '-' + i + '"' + (show ? ' data-open' : ' inert') + '><div class="mm-clip">' + row + '</div></div></li>';
  }
  var groupOpen = inView && (shown > 0 || !q);
  var html = '<section id="l1-g-' + target + '" class="mm-group mm-fold"' + (groupOpen ? ' data-open' : ' inert') + ' aria-labelledby="l1-h-' + target + '"><div class="mm-clip">'
    + '<div class="mm-ghead"><h3 id="l1-h-' + target + '">' + esc(L1_LABELS[target]) + ' <span class="sub">' + esc(L1_FILES[target]) + '</span></h3>'
    + '<div class="meter-line' + state + '"><meter min="0" max="' + block.charLimit + '" low="' + Math.round(block.charLimit * 0.8) + '" high="' + Math.round(block.charLimit * 0.95) + '" optimum="0" value="' + block.totalChars + '" aria-label="' + escAttr(L1_LABELS[target] + ' 사용량') + '"></meter>'
    + '<span>' + fmtNum(block.totalChars) + ' / ' + fmtNum(block.charLimit) + '자' + (pct >= 100 ? ' · 가득 참' : '') + '</span></div></div>';
  if (!entries.length) html += '<p class="mm-empty">비어 있음 — Slack에서 "기억해줘"라고 하거나 아래에서 추가하세요.</p>';
  html += '<ol class="mm-items">' + rows + '</ol>';
  // Add: a button that unfolds this store's editor (its box stays in the DOM while folded — drafts survive, review R9).
  html += '<div class="mm-fold" id="l1-addbtn-' + target + '"' + (adding ? ' inert' : ' data-open') + '><div class="mm-clip"><div class="mm-addline">'
    + '<button type="button" class="mm-add" id="l1-add-' + target + '" aria-expanded="' + (adding ? 'true' : 'false') + '" aria-controls="l1-newbox-' + target + '" onclick="l1AddOpen(\'' + target + '\')">+ ' + esc(L1_LABELS[target]) + '에 추가</button>'
    + (entries.length ? '<button type="button" class="mm-clear" onclick="l1Clear(\'' + target + '\')">모두 지우기</button>' : '') + '</div></div></div>'
    + '<div class="mm-fold" id="l1-newbox-' + target + '"' + (adding ? ' data-open' : ' inert') + '><div class="mm-clip"><div class="mm-new">'
    + '<label class="lock" for="l1-new-' + target + '">새 항목 (한 항목 최대 ' + fmtNum(block.perEntryCap) + '자)</label>'
    + '<textarea id="l1-new-' + target + '" class="mm-edit" rows="2" oninput="l1Count(\'' + target + '\')" onkeydown="l1AddKey(event,\'' + target + '\')"></textarea>'
    + '<div class="line"><span class="counter" id="l1-count-' + target + '">추가하면 ' + fmtNum(block.totalChars) + ' / ' + fmtNum(block.charLimit) + '자</span>'
    + '<span class="mm-acts is-on"><button type="button" class="mm-act" onclick="l1AddClose(\'' + target + '\')">취소</button>'
    + '<button type="button" class="mm-act mm-act-main" onclick="l1Add(\'' + target + '\')">추가</button></span></div></div></div></div>';
  return html + '</div></section>';
}
// Repaint both store groups. What is typed survives a repaint (review R9): an open editor is
// re-attached to the entry with the same text (only one such), else its draft goes to
// that store's add box; the add boxes keep their text (an add editor with a draft stays
// open). opts.close closes the editor (cancel, its own save); opts.clearAdd empties one
// add box (its note was added).
function paintL1(editing, opts) {
  if (!_mem) return;
  opts = opts || {};
  var targets = ['memory', 'user'];
  var adds = {};
  for (var a = 0; a < targets.length; a++) {
    var box = document.getElementById('l1-new-' + targets[a]);
    if (box && box.value) adds[targets[a]] = box.value;
  }
  // The open editor's identity lives on paintL1, not in _mem: a reload replaces _mem (review R10).
  var open = paintL1.open;
  var openBox = open ? document.getElementById('l1-edit-' + open.target) : null;
  var lost = null;
  var unique = null;
  if (!editing && open && openBox && !opts.close) {
    var ents = (_mem.l1[open.target] && _mem.l1[open.target].entries) || [];
    var at = ents.indexOf(open.orig);
    // re-attached only to an entry that was unique when the editor opened and is unique now
    if (open.unique && at >= 0 && ents.lastIndexOf(open.orig) === at) { editing = { target: open.target, index: at, text: openBox.value }; unique = true; }
    else if (openBox.value !== open.orig) lost = { target: open.target, text: openBox.value };
  } else if (editing && open && openBox && openBox.value !== open.orig && !(open.target === editing.target && open.index === editing.index)) {
    // opening another editor: the draft of the one it replaces is kept (review R10)
    lost = { target: open.target, text: openBox.value };
  }
  if (editing) {
    var cur = (_mem.l1[editing.target].entries || []);
    var origText = cur[editing.index];
    if (unique === null) unique = open && open.target === editing.target && open.index === editing.index ? open.unique : cur.indexOf(origText) === cur.lastIndexOf(origText);
    paintL1.open = { target: editing.target, index: editing.index, orig: origText, unique: unique };
  } else {
    paintL1.open = null;
  }
  var adding = paintL1.adding || (paintL1.adding = {});
  var html = '';
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    if (adds[t] && opts.clearAdd !== t) adding[t] = true;
    html += renderL1Card(t, _mem.l1[t], editing && editing.target === t ? editing : null, { view: paintL1.view || {}, adding: !!adding[t] });
  }
  html += '<div class="mm-fold" id="l1-nomatch" inert><div class="mm-clip"><p class="mm-empty mm-nomatch" id="l1-nomatch-text"></p></div></div>';
  document.getElementById('mem-l1-body').innerHTML = html;
  for (var k = 0; k < targets.length; k++) {
    var tk = targets[k];
    if (!adds[tk] || opts.clearAdd === tk) continue;
    var nb = document.getElementById('l1-new-' + tk);
    if (nb) {
      nb.value = adds[tk];
      l1Grow(nb);
    }
  }
  if (editing) l1Grow(document.getElementById('l1-edit-' + editing.target));
  if (lost) memKeepDraft('l1-new-' + lost.target, lost.text, L1_LABELS[lost.target] + ' 수정본');
  l1OpenDrafts();
  l1ApplyView();
}
function l1Cancel() {
  if (l1Held()) return;
  var o = paintL1.open;
  paintL1(null, { close: true });
  if (o) l1FocusAct('ed', o.target, o.index);
}
// An L1 write in flight holds its card: a second click waits (review R9).
function l1Busy(target) {
  if (l1Held()) return true;
  var b = _mem && _mem.l1 && _mem.l1[target];
  if (!b || !b.saving) return false;
  l1Say('저장 중입니다 — 끝난 뒤 다시 시도하세요', false);
  return true;
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
// Live total after the addition (the store joins entries with a 3-char delimiter).
function l1Count(target) {
  var block = _mem.l1[target];
  var box = document.getElementById('l1-new-' + target);
  l1Grow(box);
  var v = (box || {}).value || '';
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
// settle: a delete's fold — the answer lands after the row has folded away (D9).
async function l1Write(method, url, payload, draft, at, orig, unique, settle) {
  var target = url.split('/')[4];
  var sentOpen = paintL1.open; // the editor a save was sent from
  var held = _mem.l1[target];
  if (held) held.saving = Date.now();
  memHold.at = Date.now();
  // the card's editor and add box are locked while the write is out: its answer repaints them (review R9)
  var locked = [document.getElementById('l1-edit-' + target), document.getElementById('l1-new-' + target)];
  for (var lk = 0; lk < locked.length; lk++) if (locked[lk]) locked[lk].disabled = true;
  var r;
  try { r = await apiWrite(method, url, payload); } catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
  if (r.ok && settle) await settle;
  if (held) held.saving = 0;
  if (r.status === 409) {
    // The hold and the locks last until the reload is done: nothing typed meanwhile (review R11),
    // and are released however the reload ends (review R12).
    var back = false;
    var reloaded = false;
    try {
      reloaded = (await loadMemory(true)) !== false; // false: the load failed
      back = reloaded ? restoreL1Draft(target, draft, at, orig, unique) : true;
      if (reloaded) l1OpenDrafts(); // a draft that went to the add box shows its editor
    } finally {
      memHold.at = 0;
      for (var ul2 = 0; ul2 < locked.length; ul2++) if (locked[ul2]) locked[ul2].disabled = false;
    }
    l1Say('그사이 다른 곳(에이전트·Slack)에서 바뀌었습니다' + (reloaded ? ' — 최신 내용을 불러왔습니다.' : ' — 최신 내용은 불러오지 못했습니다.') + (draft ? (back ? ' 작성하던 내용은 편집 칸에 그대로 있습니다' : ' 작성하던 내용은 보관했습니다') + ' — 확인하고 다시 저장하세요.' : ' 다시 적용하세요.'), true);
    return false;
  }
  memHold.at = 0;
  for (var ul = 0; ul < locked.length; ul++) if (locked[ul]) locked[ul].disabled = false;
  if (r.ok) {
    l1Unsay();
    _mem.l1[target] = r.data.l1;
    // its own editor closes on its save; a new note empties its box (an undo leaves the box alone)
    // its own editor closes on its save — only if it is still the open one (a save answered
    // after the hold expired leaves another editor alone, review R11); a new note empties its
    // box (an undo leaves the box alone)
    paintL1(null, method === 'PUT' && paintL1.open === sentOpen ? { close: true } : method === 'POST' && !(payload && payload.restore) ? { clearAdd: target } : {});
    return true;
  }
  l1Say('저장하지 못했습니다: ' + r.error, true);
  return false;
}
// The draft goes back into the editor of the entry it was for — found by its
// original text, never by position (the list may have shifted) — else into the
// add box as a recovery draft (review R2). Two notes with that text cannot be
// told apart, so that is a recovery draft too (review R3).
function restoreL1Draft(target, draft, at, orig, unique) {
  if (!draft) return;
  var entries = (_mem && _mem.l1[target] && _mem.l1[target].entries) || [];
  var idx = typeof orig === 'string' ? entries.indexOf(orig) : -1;
  // only an entry that was unique when the editor opened (review R10) and is unique now
  if (unique !== false && idx >= 0 && entries.lastIndexOf(orig) === idx) {
    paintL1({ target: target, index: idx, text: draft });
    return true;
  }
  memKeepDraft('l1-new-' + target, draft, L1_LABELS[target] + ' 수정본');
  return false;
}
function l1EditStart(target, i) {
  if (l1Held()) return;
  paintL1({ target: target, index: i, text: _mem.l1[target].entries[i] });
  var ta = document.getElementById('l1-edit-' + target);
  if (ta) {
    ta.focus();
    if (ta.setSelectionRange) ta.setSelectionRange(ta.value.length, ta.value.length);
    l1Grow(ta);
  }
}
async function l1Save(target, i) {
  if (l1Busy(target)) return;
  var ta = document.getElementById('l1-edit-' + target);
  var text = ta ? ta.value : '';
  if (!text.trim()) { l1Say('비어 있는 항목은 저장할 수 없습니다 — 지우려면 삭제를 쓰세요', true); return; }
  var orig = _mem.l1[target].entries[i];
  // unchanged once both sides are trimmed (the store trims what it saves): close without a request (D8);
  // any other change is sent as typed
  if (text.trim() === String(orig).trim()) { paintL1(null, { close: true }); l1FocusAct('ed', target, i); return; }
  var ents = _mem.l1[target].entries;
  var unique = paintL1.open && paintL1.open.target === target && paintL1.open.orig === orig ? paintL1.open.unique : ents.indexOf(orig) === ents.lastIndexOf(orig);
  if (await l1Write('PUT', '/api/memory/l1/' + target + '/' + i, { text: text, revision: _mem.l1[target].revision }, text, i, orig, unique)) {
    l1Notice('저장했습니다');
    if (!paintL1.open) l1FocusAct('ed', target, i); // (not when another editor was opened meanwhile)
  }
}
async function l1Add(target) {
  if (l1Busy(target)) return;
  var ta = document.getElementById('l1-new-' + target);
  var text = ta ? ta.value : '';
  if (!text.trim()) return;
  if (await l1Write('POST', '/api/memory/l1/' + target, { text: text, revision: _mem.l1[target].revision }, text)) {
    // reveal first (it may reset the view), then fold the editor back to its button and focus it
    l1Reveal(target, ((_mem.l1[target] && _mem.l1[target].entries) || []).length - 1, true);
    l1AddClose(target);
    l1Notice('추가했습니다');
  }
}
// A real DELETE, sent at once (the hold stops a second click); the row folds away while it
// is out and the answer repaints after the fold. The tray then offers 되돌리기 for 5 s (D9/D10).
async function l1Delete(target, i) {
  if (l1Busy(target)) return;
  var text = _mem.l1[target].entries[i];
  var row = l1El('l1-f-' + target + '-' + i);
  var settle = null;
  if (row) {
    row.setAttribute('data-leaving', '');
    l1Fold('l1-f-' + target + '-' + i, false);
    if (!l1Reduced()) settle = new Promise(function (res) { setTimeout(res, 320); });
  }
  if (await l1Write('DELETE', '/api/memory/l1/' + target + '/' + i, { revision: _mem.l1[target].revision }, undefined, undefined, undefined, undefined, settle)) {
    // (the write's answer already repainted the groups: only the tray changes)
    if (_memUndo && _memUndo.timer) clearTimeout(_memUndo.timer);
    _memUndo = { target: target, text: text, key: (l1Delete.seq = (l1Delete.seq || 0) + 1), left: 5000 };
    l1UndoArm(_memUndo);
    l1PaintTray();
    l1FocusAfterDelete(target, i);
    return;
  }
  // refused: the row comes back as the view now has it (a 409 already reloaded and repainted)
  if (row) row.removeAttribute('data-leaving');
  l1ApplyView();
}
// Focus after a delete: the next row the view shows (it now sits at index i or later), else the
// nearest shown row before it, else the store's add button when its group shows, else the search
// box / the selected chip (D9).
function l1FocusAfterDelete(target, i) {
  var ents = (_mem.l1[target] && _mem.l1[target].entries) || [];
  var shown = function (id) {
    var f = l1El(id);
    return !!f && !f.hasAttribute('inert');
  };
  for (var j = i; j < ents.length; j++) if (shown('l1-f-' + target + '-' + j) && l1FocusAct('del', target, j)) return;
  for (var k = Math.min(i, ents.length) - 1; k >= 0; k--) if (shown('l1-f-' + target + '-' + k) && l1FocusAct('del', target, k)) return;
  if (shown('l1-g-' + target) && l1FocusAct('add', target)) return;
  var v = paintL1.view || {};
  var q = v.searching ? document.getElementById('l1-q') : null;
  if (q && q.focus) q.focus();
  else l1FocusAct('chip', v.target || 'all');
}
// A held Enter repeats the click: on a 삭제 that the next row's 삭제 replaces, that would delete row after row.
function l1KeyGuard(e) {
  if (e.repeat) e.preventDefault();
}
async function l1Undo() {
  var u = _memUndo;
  if (!u || l1Busy(u.target)) return;
  // Restore exactly what was deleted: a note Slack saved may be longer than a new note
  // may be (restore skips that cap, not the total). The undo stays offered until the
  // restore lands, and a refused restore leaves the text in the add box (review R5).
  // The store appends a restored note: it comes back at the end of its group.
  if (await l1Write('POST', '/api/memory/l1/' + u.target, { text: u.text, revision: _mem.l1[u.target].revision, restore: true }, u.text)) {
    if (u.timer) clearTimeout(u.timer);
    if (_memUndo === u) _memUndo = null;
    l1Notice('되돌렸습니다 — 목록 끝에 다시 넣었습니다'); // (the write's answer already repainted the groups)
    l1Reveal(u.target, ((_mem.l1[u.target] && _mem.l1[u.target].entries) || []).length - 1);
    return;
  }
  memKeepDraft('l1-new-' + u.target, u.text, L1_LABELS[u.target] + ' 되돌리지 못한 항목');
  l1OpenDrafts();
}
async function l1Clear(target) {
  // What the dialog names is what gets cleared: a reload under the open dialog makes it a 409 (review R3).
  if (l1Busy(target)) return;
  var n = _mem.l1[target].entries.length;
  var revision = _mem.l1[target].revision;
  var ok = await confirmDialog({ title: L1_LABELS[target] + ' 항목 ' + n + '개를 모두 지울까요?', body: '되돌릴 수 없습니다. 에이전트는 다음 세션부터 이 내용을 모릅니다.', action: n + '개 모두 지우기' });
  if (!ok || l1Busy(target)) return;
  if (await l1Write('DELETE', '/api/memory/l1/' + target, { revision: revision })) l1Notice('모두 지웠습니다');
}
// ·· panel helpers — every lookup tolerates a missing element (tests run on a partial DOM) ··
function l1El(id) {
  var el = document.getElementById(id);
  return el && el.setAttribute && el.removeAttribute ? el : null;
}
function l1Fold(id, open) {
  var el = l1El(id);
  if (!el) return;
  if (open) {
    el.setAttribute('data-open', '');
    el.removeAttribute('inert');
  } else {
    el.removeAttribute('data-open');
    el.setAttribute('inert', '');
  }
}
function l1Reduced() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function l1FocusAct(kind, target, i) {
  var b = l1El('l1-' + kind + '-' + target + (i === undefined ? '' : '-' + i));
  if (!b || !b.focus) return false;
  b.focus({ preventScroll: true });
  return true;
}
function l1Grow(el) {
  if (!el || !el.style) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
// Search matches the entry text, or the store's name / file (D5).
function l1Matches(target, text, view) {
  var q = String((view && view.q) || '').trim().toLowerCase();
  if (!q) return true;
  return String(text).toLowerCase().indexOf(q) >= 0 || (L1_LABELS[target] + ' ' + L1_FILES[target]).toLowerCase().indexOf(q) >= 0;
}
// Fold rows and groups to the chip + search without repainting (what is typed stays put).
function l1ApplyView() {
  if (!_mem || !_mem.l1) return;
  var v = paintL1.view || {};
  var q = String(v.q || '').trim();
  var open = paintL1.open;
  var targets = ['memory', 'user'];
  var any = false;
  for (var t = 0; t < targets.length; t++) {
    var tg = targets[t];
    var ents = (_mem.l1[tg] && _mem.l1[tg].entries) || [];
    var inView = !v.target || v.target === tg;
    var shown = 0;
    for (var i = 0; i < ents.length; i++) {
      var show = inView && (!!(open && open.target === tg && open.index === i) || l1Matches(tg, ents[i], v));
      if (show) shown++;
      var row = l1El('l1-f-' + tg + '-' + i);
      if (row && row.hasAttribute && row.hasAttribute('data-leaving')) continue;
      l1Fold('l1-f-' + tg + '-' + i, show);
    }
    if (shown) any = true;
    l1Fold('l1-g-' + tg, inView && (shown > 0 || !q));
  }
  l1Fold('l1-nomatch', !!q && !any);
  var nm = l1El('l1-nomatch-text');
  if (nm && q) nm.textContent = '“' + q + '” 검색 결과가 없습니다';
  l1Sync();
}
// Chrome after any change: counts, chips (roving tab stop), search state, tray.
function l1Sync() {
  if (!_mem || !_mem.l1) return;
  var panel = l1El('l1-panel');
  if (panel) panel.setAttribute('data-ready', '');
  if (panel && panel.addEventListener && !panel.mmFocus) {
    panel.mmFocus = true;
    panel.addEventListener('focusin', l1PanelFocus);
    panel.addEventListener('focusout', l1PanelFocus);
  }
  var v = paintL1.view || {};
  var counts = { memory: ((_mem.l1.memory && _mem.l1.memory.entries) || []).length, user: ((_mem.l1.user && _mem.l1.user.entries) || []).length };
  counts.all = counts.memory + counts.user;
  l1Roll(l1El('l1-total'), counts.all);
  var keys = ['all', 'memory', 'user'];
  for (var k = 0; k < keys.length; k++) {
    var n = l1El('l1-n-' + keys[k]);
    if (n) n.textContent = fmtNum(counts[keys[k]]);
    var chip = l1El('l1-chip-' + keys[k]);
    if (!chip) continue;
    var on = (v.target || 'all') === keys[k];
    chip.setAttribute('aria-checked', on ? 'true' : 'false');
    chip.setAttribute('tabindex', on ? '0' : '-1');
  }
  var filters = l1El('l1-filters');
  var chips = l1El('l1-chips');
  var box = l1El('l1-search');
  var opener = l1El('l1-search-open');
  if (filters) { if (v.searching) filters.setAttribute('data-searching', ''); else filters.removeAttribute('data-searching'); }
  if (chips) { if (v.searching) chips.setAttribute('inert', ''); else chips.removeAttribute('inert'); }
  if (box) { if (v.searching) box.removeAttribute('inert'); else box.setAttribute('inert', ''); }
  if (opener) {
    opener.setAttribute('aria-expanded', v.searching ? 'true' : 'false');
    if (v.searching) opener.setAttribute('inert', ''); else opener.removeAttribute('inert');
  }
  l1PaintTray();
}
function l1Pick(target) {
  var v = paintL1.view || {};
  paintL1.view = { target: target || null, q: v.q || '', searching: !!v.searching };
  l1ApplyView();
}
// Store chips: one tab stop, arrows move and select (wrapping), Home / End (D4).
function l1ChipKey(e) {
  var order = ['', 'memory', 'user'];
  if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].indexOf(e.key) < 0) return;
  e.preventDefault();
  var cur = order.indexOf((paintL1.view && paintL1.view.target) || '');
  var next = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : (cur + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length;
  l1Pick(order[next]);
  var chip = l1El('l1-chip-' + (order[next] || 'all'));
  if (chip && chip.focus) {
    chip.focus();
    if (chip.scrollIntoView) chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
function l1SearchOpen() {
  paintL1.view = { target: null, q: '', searching: true };
  l1ApplyView();
  var q = document.getElementById('l1-q');
  if (q && q.focus) q.focus();
}
function l1SearchInput(value) {
  paintL1.view = { target: null, q: String(value || ''), searching: true };
  l1ApplyView();
}
function l1SearchKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  l1SearchClose();
}
function l1SearchClose() {
  paintL1.view = { target: null, q: '', searching: false };
  var q = document.getElementById('l1-q');
  if (q) q.value = '';
  l1ApplyView();
  var b = l1El('l1-search-open');
  if (b && b.focus) b.focus();
}
// In-place edit: Enter saves, Shift+Enter is a line break, Esc cancels; never while an IME
// is composing (Korean input commits with Enter) (D8).
function l1EditKey(e, target, i) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    return l1Save(target, i);
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    l1Cancel();
  }
}
function l1EditInput(el, target) {
  l1Grow(el);
  var b = _mem && _mem.l1 && _mem.l1[target];
  var c = l1El('l1-ecount-' + target);
  if (!b || !c) return;
  var n = String(el.value || '').trim().length;
  c.textContent = fmtNum(n) + ' / ' + fmtNum(b.perEntryCap) + '자';
  c.className = 'counter' + (n > b.perEntryCap ? ' is-over' : '');
}
// Add per store (D11): the button folds away and the editor unfolds in its place.
function l1AddOpen(target, quiet) {
  var adding = paintL1.adding || (paintL1.adding = {});
  adding[target] = true;
  l1Fold('l1-addbtn-' + target, false);
  l1Fold('l1-newbox-' + target, true);
  var b = l1El('l1-add-' + target);
  if (b) b.setAttribute('aria-expanded', 'true');
  var ta = document.getElementById('l1-new-' + target);
  l1Grow(ta); // a draft that landed here may be several lines
  if (ta && ta.focus && !quiet) ta.focus();
  l1Sync();
}
// Closing keeps the draft in the box (it opens again with the next repaint).
function l1AddClose(target) {
  var adding = paintL1.adding || (paintL1.adding = {});
  adding[target] = false;
  l1Fold('l1-newbox-' + target, false);
  l1Fold('l1-addbtn-' + target, true);
  var b = l1El('l1-add-' + target);
  if (b) {
    b.setAttribute('aria-expanded', 'false');
    if (b.focus) b.focus();
  }
  l1Sync();
}
function l1AddKey(e, target) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    return l1Add(target);
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    l1AddClose(target);
  }
}
// A draft that landed in a folded add box (a 409, a lost edit, a refused undo) shows its editor.
function l1OpenDrafts() {
  var adding = paintL1.adding || (paintL1.adding = {});
  var targets = ['memory', 'user'];
  for (var i = 0; i < targets.length; i++) {
    var box = document.getElementById('l1-new-' + targets[i]);
    if (box && box.value && !adding[targets[i]]) l1AddOpen(targets[i], true);
  }
}
// A row that came back (undo) or was added: shown under the current view (else the view
// resets), unfolded, scrolled into view; focus on its 수정 unless keepFocus.
function l1Reveal(target, i, keepFocus) {
  var text = ((_mem.l1[target] && _mem.l1[target].entries) || [])[i];
  if (text === undefined) return;
  var v = paintL1.view || {};
  if ((v.target && v.target !== target) || !l1Matches(target, text, v)) {
    paintL1.view = { target: null, q: '', searching: false };
    var q = document.getElementById('l1-q');
    if (q) q.value = '';
    l1ApplyView();
  }
  var f = l1El('l1-f-' + target + '-' + i);
  if (f && !l1Reduced()) {
    f.removeAttribute('data-open');
    void f.offsetHeight; // start the unfold from closed
    f.setAttribute('data-open', '');
  }
  if (f && f.scrollIntoView) setTimeout(function () { f.scrollIntoView({ block: 'nearest', behavior: l1Reduced() ? 'auto' : 'smooth' }); }, 120);
  if (!keepFocus) l1FocusAct('ed', target, i);
}
// Counts roll to their new value: 520 ms, ease-out quart; at once with reduced motion (D13).
function l1Roll(el, to) {
  if (!el) return;
  if (el.mmRaf && el.mmN === to) return; // already rolling to this value (a second repaint must not cut it short)
  var from = typeof el.mmN === 'number' ? el.mmN : to;
  el.mmN = to;
  if (el.mmRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(el.mmRaf);
  el.mmRaf = 0;
  if (from === to || l1Reduced() || typeof requestAnimationFrame !== 'function') {
    el.textContent = fmtNum(to);
    return;
  }
  var t0 = 0;
  function step(now) {
    if (!t0) t0 = now;
    var p = Math.min(1, (now - t0) / 520);
    el.textContent = fmtNum(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 4))));
    el.mmRaf = p < 1 ? requestAnimationFrame(step) : 0;
  }
  el.mmRaf = requestAnimationFrame(step);
}
// The tray line, by priority: the deleted note with 되돌리기 > a 3 s notice > editing /
// adding hints > counts and capacity. html = the visible caption, live = the polite status.
function l1TrayState() {
  var l1 = (_mem && _mem.l1) || {};
  var u = _memUndo;
  if (u && typeof u.text === 'string') {
    var short = u.text.length > 40 ? u.text.slice(0, 40) + '…' : u.text; // spoken like the row names (the caption ellipsizes)
    return { key: 'forgot-' + (u.key || 0), html: '<span class="mm-forgot"><span class="mm-flat">삭제함 “</span><b class="mm-quote">' + esc(u.text) + '</b><span class="mm-flat">”</span></span>', live: '삭제함 “' + short + '” — 되돌리기로 되돌릴 수 있습니다' };
  }
  var n = l1Notice.cur;
  if (n) return { key: 'notice-' + n.seq, html: esc(n.text), live: n.text };
  if (paintL1.open) return { key: 'editing', html: 'Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소', live: 'Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소' };
  var adding = paintL1.adding || {};
  if (adding.memory || adding.user) return { key: 'adding', html: 'Enter 추가 · Shift+Enter 줄바꿈 · Esc 닫기', live: 'Enter 추가 · Shift+Enter 줄바꿈 · Esc 닫기' };
  var m = l1.memory || {};
  var us = l1.user || {};
  var total = (m.entries || []).length + (us.entries || []).length;
  var cap = ' · ' + L1_LABELS.memory + ' ' + fmtNum(m.totalChars || 0) + ' / ' + fmtNum(m.charLimit || 0) + '자 · '
    + L1_LABELS.user + ' ' + fmtNum(us.totalChars || 0) + ' / ' + fmtNum(us.charLimit || 0) + '자';
  return { key: 'rest', total: total, cap: cap, html: '<b class="mm-n">' + fmtNum(total) + '</b>개 항목<span class="mm-cap">' + esc(cap) + '</span>', live: fmtNum(total) + '개 항목' + cap };
}
function l1PaintTray() {
  var s = l1TrayState();
  var undo = l1El('l1-undo');
  if (undo) { if (s.key.indexOf('forgot-') === 0) undo.removeAttribute('hidden'); else undo.setAttribute('hidden', ''); }
  var live = l1El('l1-live');
  if (live && live.textContent !== s.live) live.textContent = s.live;
  var cap = l1El('l1-caption');
  if (!cap || !document.createElement) return;
  if (cap.mmKey === s.key && cap.mmItem) {
    // same line, new numbers: the count rolls in place
    if (s.key !== 'rest' || !cap.mmItem.querySelector) return;
    l1Roll(cap.mmItem.querySelector('.mm-n'), s.total);
    var c = cap.mmItem.querySelector('.mm-cap');
    if (c) c.textContent = s.cap;
    return;
  }
  cap.mmKey = s.key;
  var old = cap.mmItem;
  if (old) {
    old.setAttribute('data-out', '');
    setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, l1Reduced() ? 0 : 260);
  }
  var item = document.createElement('span');
  item.className = 'mm-swap';
  item.innerHTML = s.html;
  cap.appendChild(item);
  cap.mmItem = item;
  var nb = s.key === 'rest' && item.querySelector ? item.querySelector('.mm-n') : null;
  if (nb) nb.mmN = s.total;
}
function l1Notice(text) {
  var n = { text: text, seq: (l1Notice.seq = (l1Notice.seq || 0) + 1) };
  l1Notice.cur = n;
  setTimeout(function () {
    if (l1Notice.cur !== n) return;
    l1Notice.cur = null;
    l1PaintTray();
  }, 3000);
  l1PaintTray();
}
// The undo window: 5 s, paused while the pointer rests on the tray or focus is anywhere in the
// panel — a keyboard or screen-reader user reaches 되돌리기 without a clock (D10/D17). The hold is
// its own state: a hover or focus that began before the delete landed still holds.
function l1TrayHeld() {
  return !!(l1TrayHold.hover || l1TrayHold.panel);
}
function l1UndoArm(u) {
  if (u.timer) clearTimeout(u.timer);
  u.timer = 0;
  u.started = Date.now();
  if (l1TrayHeld()) return; // held: the clock starts when the hold ends (l1TrayHold)
  u.timer = setTimeout(function () {
    u.timer = 0;
    if (_memUndo !== u) return;
    _memUndo = null;
    l1PaintTray();
  }, Math.max(0, u.left));
}
// kind: 'hover' (pointer on the tray) | 'panel' (focus inside the panel)
function l1TrayHold(kind, on) {
  var was = l1TrayHeld();
  l1TrayHold[kind] = !!on;
  var held = l1TrayHeld();
  var u = _memUndo;
  if (held === was || !u || !u.key) return;
  if (!held) {
    l1UndoArm(u);
  } else if (u.timer) {
    clearTimeout(u.timer);
    u.timer = 0;
    u.left -= Date.now() - u.started;
  }
}
function l1PanelFocus(e) {
  var panel = l1El('l1-panel');
  var to = e.type === 'focusout' ? e.relatedTarget : e.target;
  l1TrayHold('panel', !!(panel && to && panel.contains(to)));
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
