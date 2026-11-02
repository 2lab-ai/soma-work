/**
 * The settings page "대시보드 화면" tab (SSOT 2026-11-02, .prd/21) — each user arranges what the dashboard and the
 * Slack thread show: the task card (its face and its open card, separately), the detail card and the thread card
 * ("스레드 태스크 카드"), in 미니멀 and 어드밴스드.
 *
 * UI decisions (research, .prd/21 §4):
 *   - one screen, two panes: the items on the left, a live preview on the right drawn by the dashboard's own code
 *     (view-layout-client.ts → <ui-agent-inbox>), with a sample picker (실행 중 · 질문 대기 · 완료);
 *   - presets 1 · 2 · 3 are starting points: the task card and the detail card each pick a default, a quick
 *     switch sets both; an edited preset says so and resets in one press;
 *   - every item keeps its place when hidden (the switch dims it — no "hidden" zone); order by dragging the
 *     handle or with ↑ ↓ (WCAG 2.5.7: dragging is never the only way); each move is announced and keeps focus;
 *   - what always shows (title, status, actions, approvals, the composer) is listed with a lock, never a switch;
 *   - changes save at once (debounced PUT of the whole document) with 되돌리기 (and ⌘/Ctrl+Z) — no Save bar;
 *   - the thread card follows the task card by default; "따로 설정" starts from what it shows now.
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte). It runs after the shared layout
 * script (VIEW_LAYOUT_CLIENT_JS) and uses its layoutOf · layoutPreset · layoutsFor · faceOf · openPartsOf ·
 * detailSpecOf · followThreadLayout.
 */

export const LAYOUT_TAB_HTML = `<div slot="layout" data-tab="layout" class="page lay-page" hidden>
  <main class="lay" id="lay-root">
    <p class="intro">카드 · 펼친 카드 · 디테일 카드 · 슬랙 스레드 카드에 무엇을 어떤 순서로 보여 줄지 고릅니다. 스위치로 켜고 끄고, 손잡이를 끌거나 ↑ ↓로 순서를 바꿉니다. 바꾸면 바로 저장되고 대시보드와 슬랙에 바로 반영됩니다.</p>
    <section class="group lay-defaults" aria-labelledby="h-lay-def">
      <header><h2 id="h-lay-def">기본 안</h2><p>1안 · 2안 · 3안은 고칠 수 있는 시작점입니다. 화면마다 어느 안을 쓸지 고릅니다.</p></header>
      <div class="lay-def-body">
        <label class="lay-field"><span>태스크 카드</span><select class="ui-input" id="lay-def-card" data-lay="def-card"></select></label>
        <label class="lay-field"><span>디테일 카드</span><select class="ui-input" id="lay-def-detail" data-lay="def-detail"></select></label>
        <label class="lay-field"><span>스레드 카드 (슬랙)</span><select class="ui-input" id="lay-thread-mode" data-lay="thread-mode">
          <option value="follow">태스크 카드 따라감</option>
          <option value="custom">따로 설정</option>
          <option value="theme">서버 슬랙 테마</option>
        </select></label>
        <div class="lay-field lay-quick"><span>한 번에</span><span class="lay-quick-btns" role="group" aria-label="모든 화면을 한 안으로">
          <button type="button" class="ui-btn is-sm" data-lay="quick" data-v="1">1안</button>
          <button type="button" class="ui-btn is-sm" data-lay="quick" data-v="2">2안</button>
          <button type="button" class="ui-btn is-sm" data-lay="quick" data-v="3">3안</button>
        </span></div>
      </div>
    </section>
    <div class="lay-bar" role="toolbar" aria-label="편집할 대상">
      <fieldset class="seg" id="lay-preset"><legend>편집할 안</legend></fieldset>
      <fieldset class="seg" id="lay-mode"><legend>모드</legend></fieldset>
      <span class="lay-badge" id="lay-badge" hidden>수정됨</span>
      <span class="lay-spacer"></span>
      <span class="status" id="lay-status" role="status" aria-live="polite"></span>
      <button type="button" class="ui-btn is-sm" data-lay="undo" id="lay-undo" disabled title="되돌리기 (⌘/Ctrl+Z)">되돌리기</button>
      <button type="button" class="ui-btn is-sm" data-lay="reset" id="lay-reset">이 화면 기본값으로</button>
    </div>
    <fieldset class="seg lay-surfaces" id="lay-surface"><legend>화면</legend></fieldset>
    <div class="lay-split">
      <section class="lay-controls" id="lay-controls" aria-label="보일 항목과 순서"><div class="ui-notice" role="status">불러오는 중…</div></section>
      <section class="lay-preview" aria-label="미리보기">
        <div class="lay-preview-head"><h3>미리보기</h3><fieldset class="seg" id="lay-sample"><legend>샘플 작업</legend></fieldset></div>
        <div class="lay-preview-body" id="lay-preview"></div>
        <p class="lay-note" id="lay-preview-note"></p>
      </section>
    </div>
    <p class="ui-sr-only" id="lay-live" role="status" aria-live="assertive"></p>
  </main>
</div>`;

export const LAYOUT_TAB_CSS = String.raw`
.lay-page { grid-template-columns: minmax(0, 1fr); max-width: 1240px; }
.lay-defaults .lay-def-body { display: flex; flex-wrap: wrap; gap: 12px 20px; padding: 12px 16px 14px; align-items: flex-end; }
.lay-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); min-width: 180px; }
.lay-field select { min-width: 180px; }
.lay-quick-btns { display: inline-flex; gap: 6px; }
.lay-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 4px 0 10px; }
.lay-spacer { flex: 1; }
/* The kit's segmented control sets a display: the attribute must still hide it (the thread card has no preset). */
.lay-bar [hidden], .lay-badge[hidden] { display: none !important; }
.lay-badge { font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--ui-st-wait) 18%, transparent); color: var(--text); }
.lay-surfaces { margin-bottom: 12px; }
.lay-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: 20px; align-items: start; }
.lay-preview { position: sticky; top: calc(var(--topbar-h) + 12px); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; }
.lay-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.lay-preview-head h3 { font-size: 13px; font-weight: 650; }
.lay-preview-body { min-height: 200px; }
.lay-note { font-size: 12px; color: var(--text-secondary); margin-top: 8px; }
.lay-zone { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 12px; }
.lay-zone > header { display: flex; align-items: baseline; gap: 8px; padding: 10px 14px 6px; }
.lay-zone > header h3 { font-size: 13px; font-weight: 650; }
.lay-zone > header p { font-size: 11.5px; color: var(--text-secondary); }
.lay-list { list-style: none; margin: 0; padding: 0 6px 6px; }
.lay-item { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; min-height: 40px; background: var(--surface); }
.lay-item + .lay-item { border-top: 1px solid var(--border); }
.lay-item.is-off .lay-name, .lay-item.is-off .lay-hint { opacity: .5; }
.lay-item.is-dragging { opacity: .4; }
.lay-item.is-drop-before { box-shadow: inset 0 2px 0 var(--accent); }
.lay-item.is-drop-after { box-shadow: inset 0 -2px 0 var(--accent); }
.lay-handle { cursor: grab; color: var(--text-tertiary); font-size: 14px; line-height: 1; padding: 4px 2px; user-select: none; letter-spacing: -2px; }
.lay-handle.is-none { visibility: hidden; }
.lay-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.lay-name { font-size: 13px; font-weight: 550; }
.lay-hint { font-size: 11.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lay-lock { font-size: 11px; color: var(--text-secondary); padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; }
.lay-move { display: inline-flex; gap: 2px; }
.lay-move button { min-width: 28px; min-height: 28px; padding: 0; }
.lay-item select { font-size: 12px; padding: 2px 6px; min-height: 28px; }
.lay-slack-x { font-size: 10.5px; color: var(--text-tertiary); }
.lay-opts { display: flex; flex-wrap: wrap; gap: 10px 16px; padding: 4px 14px 12px; }
/* Preview: the open card's schematic body and the detail card's schematic panel. */
.lay-pv-body { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.lay-pv-actions { display: flex; gap: 6px; justify-content: flex-end; }
.lay-pv-block { border: 1px dashed var(--border); border-radius: 8px; padding: 6px 8px; color: var(--text-secondary); }
.lay-pv-block b { color: var(--text); font-weight: 600; margin-right: 6px; }
.lay-pv-ask { border: 1px solid var(--ui-st-wait); background: color-mix(in srgb, var(--ui-st-wait) 12%, transparent); border-radius: 8px; padding: 8px; color: var(--text); }
.lay-panel { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface); display: flex; flex-direction: column; min-height: 520px; font-size: 12px; }
.lay-panel > * { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.lay-panel .pv-head b { font-size: 13px; }
.lay-panel .pv-sub { color: var(--text-secondary); font-size: 11px; }
.lay-panel .pv-tabs { display: flex; gap: 12px; color: var(--text-secondary); }
.lay-panel .pv-tabs span:first-child { color: var(--text); font-weight: 600; }
.lay-panel .pv-chat { flex: 1; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--border); }
.lay-panel .pv-msg { background: var(--ib-seg); border-radius: 8px; padding: 6px 8px; max-width: 85%; }
.lay-panel .pv-msg.is-bot { align-self: flex-start; background: none; border: 1px solid var(--border); }
.lay-panel .pv-composer { color: var(--text-tertiary); border-bottom: 0; }
.lay-panel .pv-task { display: flex; gap: 6px; align-items: center; }
.lay-panel .pv-task i { width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--text-tertiary); display: inline-block; }
.lay-panel .pv-task.is-done i { background: var(--text-tertiary); }
.lay-panel .pv-task.is-run i { border-color: var(--text); border-width: 2px; }
.lay-slack { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); font-size: 13px; }
.lay-slack .sk-head { font-size: 15px; font-weight: 650; margin-bottom: 6px; }
.lay-slack .sk-ctx { font-size: 12px; color: var(--text-secondary); margin: 4px 0; display: flex; flex-wrap: wrap; gap: 4px 10px; }
.lay-slack code { font-size: 11.5px; padding: 0 4px; border-radius: 4px; border: 1px solid var(--border); }
@media (max-width: 900px) {
  .lay-split { grid-template-columns: minmax(0, 1fr); }
  .lay-preview { position: static; order: -1; }
}
`;

export const LAYOUT_CLIENT_JS = String.raw`
// ── 대시보드 화면 (.prd/21) — the surface editor ──
var REPRESENTATIVE_MODELS = [{ model: 'claude-opus-5-5[1m]', label: 'Opus 5.5' }];
var _lay = null;            // GET /api/settings/dashboard-layout: { doc, builtins, catalog, plan, mode, accepted }
var _layDoc = null;         // the document being edited; saved as it changes
var _layUndo = [];          // earlier documents, newest last (되돌리기)
var _layPreset = '1';
var _layMode = 'minimal';
var _laySurface = 'card';   // card · open · detail · thread
var _laySample = 'run';     // run · wait · done
var _laySaveTimer = 0;
var _laySaving = false;
var _layResave = false;
var _layLoaded = false;
var _layDrag = null;        // { zone, from } while a handle is dragged

var LAY_SURFACES = [
  { id: 'card', label: '카드 (접힘)' },
  { id: 'open', label: '카드 (펼침)' },
  { id: 'detail', label: '디테일 카드' },
  { id: 'thread', label: '스레드 카드 (슬랙)' },
];
var LAY_MODES = [{ id: 'minimal', label: '미니멀' }, { id: 'advanced', label: '어드밴스드' }];
var LAY_SAMPLES = [{ id: 'run', label: '실행 중' }, { id: 'wait', label: '질문 대기' }, { id: 'done', label: '완료' }];

function layClone(v) { return JSON.parse(JSON.stringify(v)); }
function layEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function layPresetName(p, mode) {
  var b = _lay && _lay.builtins && _lay.builtins[p];
  return p + '안' + (b ? ' — ' + b.name[mode || _layMode] : '');
}
function setLayStatus(text) {
  var el = document.getElementById('lay-status');
  if (el) el.textContent = text || '';
}
function layAnnounce(text) {
  var el = document.getElementById('lay-live');
  if (!el) return;
  el.textContent = '';
  setTimeout(function() { el.textContent = text; }, 30);
}

async function loadLayout() {
  setLayStatus('불러오는 중…');
  try {
    var res = await fetch('/api/settings/dashboard-layout');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _lay = await res.json();
  } catch (e) {
    var c = document.getElementById('lay-controls');
    if (c) c.innerHTML = '<div class="ui-notice" data-tone="fail" role="alert">불러오지 못했습니다: ' + layEsc(e && e.message || e) + '</div>';
    setLayStatus('');
    return;
  }
  _layDoc = layClone(_lay.doc || { v: 1 });
  _layMode = _lay.mode === 'advanced' ? 'advanced' : 'minimal';
  _layPreset = layoutPreset(_layDoc, 'card', _lay.plan);
  _layLoaded = true;
  setLayStatus(_lay.accepted === false ? '관리자 승인을 받은 뒤에 바꿀 수 있습니다' : '');
  layPaint();
}

// ── The document ──
// The layout being edited: the user's copy of this preset's surface, else the built-in (a copy either way).
function layCur() {
  if (_laySurface === 'thread') {
    var t = _layDoc.thread;
    if (t && t.mode === 'custom' && t.custom) return layClone(t.custom);
    return followThreadLayout(layoutsFor(_layDoc, _lay.builtins, _layMode, _lay.plan).card);
  }
  return layClone(layoutOf(_layDoc, _lay.builtins, _layPreset, _layMode, _laySurface));
}
function layThreadMode() {
  return (_layDoc && _layDoc.thread && _layDoc.thread.mode) || 'follow';
}
function layEdited(preset, mode, surface) {
  var p = _layDoc.presets && _layDoc.presets[preset];
  return !!(p && p[mode] && p[mode][surface]);
}
function layPush() {
  _layUndo.push(layClone(_layDoc));
  if (_layUndo.length > 50) _layUndo.shift();
}
// Write the edited layout back (an edited open card is one order for every column: its byCol goes).
function laySet(layout) {
  layPush();
  if (_laySurface === 'thread') {
    _layDoc.thread = { mode: 'custom', custom: layout };
  } else {
    if (_laySurface === 'open') delete layout.byCol;
    _layDoc.presets = _layDoc.presets || {};
    _layDoc.presets[_layPreset] = _layDoc.presets[_layPreset] || {};
    _layDoc.presets[_layPreset][_layMode] = _layDoc.presets[_layPreset][_layMode] || {};
    _layDoc.presets[_layPreset][_layMode][_laySurface] = layout;
  }
  layChanged();
}
function layChanged() {
  layPaint();
  setLayStatus('저장 중…');
  clearTimeout(_laySaveTimer);
  _laySaveTimer = setTimeout(saveLayout, 350);
}
// One PUT of the whole document at a time; a change while it runs is saved after it.
async function saveLayout() {
  if (_laySaving) { _layResave = true; return; }
  _laySaving = true;
  var why = '';
  try {
    do {
      _layResave = false;
      var r = await apiWrite('PUT', '/api/settings/dashboard-layout', { doc: _layDoc });
      if (!r.ok) { why = r.error || 'HTTP'; break; }
      // The server's checked copy (its order, the items it appended) is the truth, unless the user moved on.
      if (!_layResave && r.data && r.data.layout && r.data.layout.doc) {
        _layDoc = layClone(r.data.layout.doc);
        try { localStorage.setItem('soma-view-layout', JSON.stringify(_layDoc)); } catch (_e) {}
      }
    } while (_layResave);
  } catch (e) { why = String((e && e.message) || e); }
  finally { _laySaving = false; }
  setLayStatus(why ? '저장하지 못했습니다 — ' + why : '저장됨');
  if (!why) layPaint();
}
function layUndo() {
  if (!_layUndo.length) return;
  _layDoc = _layUndo.pop();
  layChanged();
  layAnnounce('되돌렸습니다');
}

// ── Items ──
// The zones of a surface: an ordered list of items (switch, drag, ↑ ↓), or fixed rows (locked, a switch, a select).
function layZones(l) {
  var cat = _lay.catalog;
  if (_laySurface === 'card') return [
    { title: '머리', note: '카드 맨 위 줄', fixed: [cat.card.head[0], cat.card.head[1]], flags: [
      { key: 'kind', entry: cat.card.head[2] }, { key: 'star', entry: cat.card.head[3] }, { key: 'owner', entry: cat.card.head[4] }] },
    { key: 'rows', title: '본문 줄', note: '제목 아래, 위에서 아래로', items: l.rows, cat: cat.card.rows },
    { key: 'foot', title: '맨 아래 오른쪽', note: '상태 옆 칩, 왼쪽에서 오른쪽으로', items: l.foot, cat: cat.card.foot },
  ];
  if (_laySurface === 'open') return [
    { title: '항상 맨 위', fixed: cat.open.fixed, flags: [{ key: 'star', entry: cat.open.star }] },
    { key: 'parts', title: '그 아래', note: l.byCol ? '이 안은 칸마다 순서가 다릅니다 — 바꾸면 모든 칸이 이 순서를 씁니다' : '위에서 아래로', items: l.parts, cat: cat.open.parts },
  ];
  if (_laySurface === 'detail') return [
    { title: '머리', fixed: [cat.detail.fixed[0]], flags: [{ key: 'subtitle', entry: cat.detail.toggles[0] }] },
    { key: 'top', title: '위쪽', note: '위에서 아래로 — 입력 필요는 숨길 수 없습니다', items: l.top, cat: cat.detail.top },
    { title: '본문', selects: [
      { key: 'tasks', label: '작업 목록', opts: cat.detail.tasks, value: l.tasks },
      { key: 'tasksMax', label: '작업 목록 높이', opts: [{ value: '34', label: '3분의 1' }, { value: '50', label: '절반' }, { value: '70', label: '3분의 2' }], value: String(l.tasksMax), off: l.tasks !== 'list' && l.tasks !== 'line' },
      { key: 'agents', label: '에이전트 탭', opts: cat.detail.agents, value: l.agents }],
      flags: [{ key: 'agenthead', entry: cat.detail.toggles[1] }, { key: 'sections', entry: cat.detail.toggles[2] }, { key: 'open', entry: cat.detail.toggles[4] }],
      fixed: [cat.detail.fixed[1]] },
    { title: '아래', fixed: [cat.detail.fixed[2]], flags: [{ key: 'controls', entry: cat.detail.toggles[3] }] },
  ];
  var follow = layThreadMode() !== 'custom';
  return [
    { title: '머리 줄', fixed: cat.thread.fixed },
    { key: 'info', title: '정보 줄', note: follow ? '태스크 카드를 따라갑니다 — 고치면 따로 설정으로 바뀝니다' : '왼쪽에서 오른쪽으로', items: l.info, cat: cat.thread.info },
    { key: 'nav', title: '링크 · 상태', note: '대시보드 · 이슈 · PR · 종료', items: l.nav, cat: cat.thread.nav },
  ];
}
function layCatEntry(cat, id) {
  for (var i = 0; i < cat.length; i++) if (cat[i].id === id) return cat[i];
  return { id: id, label: id, hint: '' };
}
function layItemHtml(zone, it, idx, count, entry) {
  var locked = !!entry.locked;
  var name = layEsc(entry.label);
  var opt = '';
  if (entry.opts && entry.opts.length) {
    opt = '<select class="ui-input" data-lay="opt" data-zone="' + zone + '" data-id="' + layEsc(it.id) + '" aria-label="' + name + ' 옵션">';
    for (var o = 0; o < entry.opts.length; o++)
      opt += '<option value="' + layEsc(entry.opts[o].value) + '"' + (entry.opts[o].value === it.opt ? ' selected' : '') + '>' + layEsc(entry.opts[o].label) + '</option>';
    opt += '</select>';
  }
  var sw = locked ? '<span class="lay-lock">항상</span>'
    : '<label class="ui-switch"><input type="checkbox" role="switch" data-lay="toggle" data-zone="' + zone + '" data-id="' + layEsc(it.id) + '"' + (it.on ? ' checked' : '') + ' aria-label="' + name + ' 보이기"><span aria-hidden="true">' + (it.on ? '켜짐' : '꺼짐') + '</span></label>';
  var slack = _laySurface === 'card' && entry.slack === false && layThreadMode() === 'follow' ? '<span class="lay-slack-x" title="슬랙 스레드 카드에는 나오지 않습니다">슬랙 X</span>' : '';
  return '<li class="lay-item' + (it.on || locked ? '' : ' is-off') + '" draggable="true" data-zone="' + zone + '" data-idx="' + idx + '" data-id="' + layEsc(it.id) + '">'
    + '<span class="lay-handle" aria-hidden="true" title="끌어서 순서 바꾸기">⋮⋮</span>'
    + '<span class="lay-text"><span class="lay-name">' + name + '</span><span class="lay-hint">' + layEsc(entry.hint || '') + '</span></span>'
    + slack + opt + sw
    + '<span class="lay-move"><button type="button" class="ui-btn is-sm" data-lay="up" data-zone="' + zone + '" data-id="' + layEsc(it.id) + '" data-idx="' + idx + '" aria-label="' + name + ' 위로"' + (idx === 0 ? ' disabled' : '') + '>↑</button>'
    + '<button type="button" class="ui-btn is-sm" data-lay="down" data-zone="' + zone + '" data-id="' + layEsc(it.id) + '" data-idx="' + idx + '" aria-label="' + name + ' 아래로"' + (idx === count - 1 ? ' disabled' : '') + '>↓</button></span>'
    + '</li>';
}
function layFixedHtml(entry) {
  return '<li class="lay-item"><span class="lay-handle is-none" aria-hidden="true">⋮⋮</span><span class="lay-text"><span class="lay-name">' + layEsc(entry.label)
    + '</span><span class="lay-hint">' + layEsc(entry.hint || '') + '</span></span><span class="lay-lock">항상</span></li>';
}
function layFlagHtml(key, entry, on) {
  return '<li class="lay-item' + (on ? '' : ' is-off') + '"><span class="lay-handle is-none" aria-hidden="true">⋮⋮</span><span class="lay-text"><span class="lay-name">' + layEsc(entry.label)
    + '</span><span class="lay-hint">' + layEsc(entry.hint || '') + '</span></span>'
    + '<label class="ui-switch"><input type="checkbox" role="switch" data-lay="flag" data-key="' + key + '"' + (on ? ' checked' : '') + ' aria-label="' + layEsc(entry.label) + ' 보이기"><span aria-hidden="true">' + (on ? '켜짐' : '꺼짐') + '</span></label></li>';
}
function laySelectHtml(s) {
  var h = '<label class="lay-field"><span>' + layEsc(s.label) + '</span><select class="ui-input" data-lay="select" data-key="' + s.key + '"' + (s.off ? ' disabled' : '') + '>';
  for (var i = 0; i < s.opts.length; i++) h += '<option value="' + layEsc(s.opts[i].value) + '"' + (String(s.opts[i].value) === String(s.value) ? ' selected' : '') + '>' + layEsc(s.opts[i].label) + '</option>';
  return h + '</select></label>';
}
function layControlsHtml(l) {
  if (_laySurface === 'thread' && layThreadMode() === 'theme')
    return '<div class="ui-notice" role="status">이 스레드 카드는 서버의 슬랙 테마(config.json의 ui.threadheader, 테마 명령)를 씁니다. 위 "스레드 카드"에서 "태스크 카드 따라감"이나 "따로 설정"을 고르면 여기서 고칠 수 있습니다.</div>';
  var zones = layZones(l);
  var html = '';
  for (var z = 0; z < zones.length; z++) {
    var zone = zones[z];
    html += '<section class="lay-zone"><header><h3>' + layEsc(zone.title) + '</h3>' + (zone.note ? '<p>' + layEsc(zone.note) + '</p>' : '') + '</header>';
    if (zone.selects) {
      html += '<div class="lay-opts">';
      for (var s = 0; s < zone.selects.length; s++) html += laySelectHtml(zone.selects[s]);
      html += '</div>';
    }
    html += '<ol class="lay-list"' + (zone.key ? ' data-zone="' + zone.key + '" aria-label="' + layEsc(zone.title) + '"' : '') + '>';
    var fixed = zone.fixed || [];
    for (var f = 0; f < fixed.length; f++) html += layFixedHtml(fixed[f]);
    var flags = zone.flags || [];
    for (var g = 0; g < flags.length; g++) html += layFlagHtml(flags[g].key, flags[g].entry, !!l[flags[g].key]);
    var items = zone.items || [];
    for (var i = 0; i < items.length; i++) html += layItemHtml(zone.key, items[i], i, items.length, layCatEntry(zone.cat, items[i].id));
    html += '</ol></section>';
  }
  return html;
}

// ── Painting ──
function laySeg(id, items, value, name) {
  var el = document.getElementById(id);
  if (!el) return;
  var legend = el.querySelector('legend');
  var html = legend ? legend.outerHTML : '';
  for (var i = 0; i < items.length; i++)
    html += '<label><input type="radio" name="' + name + '" value="' + items[i].id + '"' + (items[i].id === value ? ' checked' : '') + ' data-lay="' + name + '"><span>' + layEsc(items[i].label) + '</span></label>';
  el.innerHTML = html;
}
function layOptions(id, value, withFollow) {
  var el = document.getElementById(id);
  if (!el) return;
  var html = '';
  for (var p = 1; p <= 3; p++) {
    var v = String(p);
    html += '<option value="' + v + '"' + (v === value ? ' selected' : '') + '>' + layEsc(layPresetName(v, _layMode)) + '</option>';
  }
  el.innerHTML = html;
}
function layPaint() {
  if (!_layLoaded) return;
  layOptions('lay-def-card', layoutPreset(_layDoc, 'card', _lay.plan));
  layOptions('lay-def-detail', layoutPreset(_layDoc, 'detail', _lay.plan));
  var tm = document.getElementById('lay-thread-mode');
  if (tm) tm.value = layThreadMode();
  var presets = [];
  for (var p = 1; p <= 3; p++) presets.push({ id: String(p), label: layPresetName(String(p)) });
  laySeg('lay-preset', presets, _layPreset, 'lay-preset');
  laySeg('lay-mode', LAY_MODES, _layMode, 'lay-mode');
  laySeg('lay-surface', LAY_SURFACES, _laySurface, 'lay-surface');
  laySeg('lay-sample', LAY_SAMPLES, _laySample, 'lay-sample');
  var thread = _laySurface === 'thread';
  var presetEl = document.getElementById('lay-preset');
  if (presetEl) presetEl.hidden = thread;
  var edited = thread ? layThreadMode() === 'custom' : layEdited(_layPreset, _layMode, _laySurface);
  var badge = document.getElementById('lay-badge');
  if (badge) badge.hidden = !edited;
  var reset = document.getElementById('lay-reset');
  if (reset) { reset.disabled = !edited; reset.textContent = thread ? '태스크 카드 따라가기로' : '이 화면 기본값으로'; }
  var undo = document.getElementById('lay-undo');
  if (undo) undo.disabled = !_layUndo.length;
  var l = layCur();
  var c = document.getElementById('lay-controls');
  if (c) {
    var keep = layFocusKey();
    c.innerHTML = layControlsHtml(l);
    layRestoreFocus(keep);
  }
  layPreview(l);
}
// Focus survives a repaint: the control that had it (same action, zone and id) gets it back.
function layFocusKey() {
  var a = document.activeElement;
  if (!a || !a.getAttribute || !a.closest || !a.closest('#lay-controls')) return null;
  return { lay: a.getAttribute('data-lay'), zone: a.getAttribute('data-zone'), id: a.getAttribute('data-id'), key: a.getAttribute('data-key'), idx: a.getAttribute('data-idx') };
}
function layRestoreFocus(k) {
  if (!k) return;
  var sel = '#lay-controls [data-lay="' + k.lay + '"]';
  if (k.zone) sel += '[data-zone="' + k.zone + '"]';
  if (k.id) sel += '[data-id="' + k.id + '"]';
  if (k.key) sel += '[data-key="' + k.key + '"]';
  if (k.idx && !k.id) sel += '[data-idx="' + k.idx + '"]';
  var el = document.querySelector(sel);
  // A moved item that reached an end: its other arrow keeps the focus (the item is still the one in hand).
  if (el && el.disabled && (k.lay === 'up' || k.lay === 'down'))
    el = document.querySelector(sel.replace('[data-lay="' + k.lay + '"]', '[data-lay="' + (k.lay === 'up' ? 'down' : 'up') + '"]'));
  if (el && !el.disabled) el.focus();
}

// ── Preview — the dashboard's own code draws it ──
var LAY_NOW = Date.now();
function laySampleCard(id) {
  var M = 60000;
  var c = {
    id: id,
    title: '결제 페이지 리뉴얼',
    status: 'running',
    bodyMode: 'slot',
    since: LAY_NOW - 20 * M,
    elapsedMs: 0,
    summary: '원래 지시: 결제 페이지를 새 디자인으로 바꿔 줘',
    task: { id: 'T3', label: '카드 폼 검증 추가', startedAt: LAY_NOW - 5 * M },
    agents: { total: 2, running: 1, done: 1, failed: 0, dots: ['done', 'running'] },
    tokens: 6440000,
    costUsd: 6.2,
    artifactsCount: 3,
    artifacts: [{ id: 'a1', name: 'analysis.html', kind: 'html' }, { id: 'a2', name: 'board.png', kind: 'image' }, { id: 'a3', name: 'notes.md', kind: 'file' }],
    steps: { done: 2, total: 4 },
    contextPct: 64,
    contextLevel: 'warn',
    titles: { cost: 'API 환산 비용 (작업 합계)', tokens: '총 토큰 6.4M', context: '컨텍스트 64%', steps: '완료한 작업 / 전체' },
    metrics: [{ text: '1', glyph: 'attach', title: '지시 첨부 1개', label: '지시 첨부 1개' }, { text: '#700 열림', glyph: 'pr', title: 'PR #700 열림' }],
    badge: { text: 'Zhuge', hue: 2, title: 'Zhuge' },
    star: { on: false, title: '즐겨찾기 — 항상 맨 위' },
  };
  if (_laySample === 'wait') {
    c.status = 'waiting';
    c.since = LAY_NOW - 3 * M;
    c.summary = 'dev에 먼저 배포할까요?';
  } else if (_laySample === 'done') {
    c.status = 'done';
    c.since = LAY_NOW - 60 * M;
    c.elapsedMs = 32 * M;
    delete c.task;
    c.steps = { done: 4, total: 4 };
    c.agents = { total: 2, running: 0, done: 2, failed: 0, dots: ['done', 'done'] };
  }
  return c;
}
var LAY_MODEL = 'claude-opus-5-5[1m]';
function layInbox(card, open) {
  return {
    columns: [{ id: 'preview', label: '미리보기', cards: [card], bare: true }],
    expanded: open ? [card.id] : [],
    load: 'ready',
    announce: false,
  };
}
function layPartHtml(id) {
  if (id === 'tasks') return '<div class="lay-pv-block"><b>작업 창</b>✔ 요구 정리 · ✔ 화면 설계 · ◌ 카드 폼 검증 추가 · ○ 확인</div>';
  if (id === 'agents') return '<div class="lay-pv-block"><b>에이전트 트리</b>A1 Explore 완료 · A2 general-purpose 실행 중</div>';
  if (id === 'io') return '<div class="lay-pv-block"><b>최근 지시와 답변</b>“폼 검증도 넣어 줘” → “검증 규칙 4개를 추가했습니다…”</div>';
  if (id === 'arts') return '<div class="lay-pv-block"><b>산출물</b>analysis.html · board.png · notes.md</div>';
  if (id === 'goal') return '<div class="lay-pv-block"><b>목표</b>결제 페이지 리뉴얼 끝내기 · 진행 중 · 2/10</div>';
  if (id === 'refs') return '<div class="lay-pv-block"><b>링크</b>PR-700 · PAY-12</div>';
  if (id === 'model') return '<div class="lay-pv-block"><b>모델</b>Opus 5.5 · 높음 ▾</div>';
  return '';
}
function layOpenBody(open) {
  var col = _laySample === 'run' ? 'working' : _laySample === 'wait' ? 'waiting' : 'idle';
  var parts = openPartsOf(open, col);
  var html = '<div class="lay-pv-body">';
  html += '<div class="lay-pv-actions">' + (open.star ? '<span class="ui-btn is-sm">☆ 즐겨찾기</span>' : '') + '<span class="ui-btn is-sm">' + (col === 'working' ? '중지' : '닫기') + '</span><span class="ui-btn is-sm">Slack</span></div>';
  if (_laySample === 'wait') html += '<div class="lay-pv-ask"><b>질문</b> dev에 먼저 배포할까요? [네, dev 먼저] [아니요]</div>';
  for (var i = 0; i < parts.length; i++) html += layPartHtml(parts[i]);
  return html + '</div>';
}
function layDetailHtml(d) {
  var spec = detailSpecOf(d);
  var has = function(t) { return spec.show.indexOf(t) >= 0; };
  var html = '<div class="lay-panel" aria-label="디테일 카드 미리보기">';
  html += '<div class="pv-head"><b>결제 페이지 리뉴얼</b>' + (has('subtitle') ? '<div class="pv-sub">새 디자인 적용 · 폼 검증</div>' : '') + '<div class="pv-sub">● ' + (_laySample === 'run' ? '실행 중 · 20분' : _laySample === 'wait' ? '입력 대기 · 3분' : '완료 · 32분') + ' · Slack · ☆ · ' + (_laySample === 'run' ? '중지' : '닫기') + '</div></div>';
  var top = spec.order;
  for (var i = 0; i < top.length; i++) {
    var id = top[i];
    if (id === 'needs') { if (_laySample === 'wait') html += '<div class="lay-pv-ask"><b>입력 필요</b> dev에 먼저 배포할까요?</div>'; continue; }
    if (!has(id)) continue;
    if (id === 'info') html += '<div><b>세션 정보</b> Zhuge · zwork · 6.4M 토큰 · $6.20 · 컨텍스트 64%' + (spec.open ? '<div class="pv-sub">모델 · 시작한 사람 · 도구 호출 · 활성 시간 · 누적 토큰 …</div>' : '') + '</div>';
    if (id === 'goal') html += '<div><b>목표</b> 결제 페이지 리뉴얼 끝내기 · 진행 중</div>';
    if (id === 'artifacts') html += '<div><b>산출물</b> analysis.html · board.png · notes.md</div>';
  }
  if (has('agenttabs') || has('subtabs')) html += '<div class="pv-tabs"><span>메인</span><span>A1 Explore</span><span>A2 general-purpose</span></div>';
  if (has('agenthead')) html += '<div class="pv-sub">메인 에이전트 · opus-5-5</div>';
  if (spec.tasks === 'list') html += '<div><b>작업 목록</b> 2 / 4 완료<div class="pv-task is-done"><i></i>요구 정리</div><div class="pv-task is-done"><i></i>화면 설계</div><div class="pv-task is-run"><i></i>카드 폼 검증 추가</div><div class="pv-task"><i></i>확인</div></div>';
  else if (spec.tasks === 'line') html += '<div><b>작업 2 / 4</b> 지금: 카드 폼 검증 추가 ▾</div>';
  else if (spec.tasks === 'runs') html += '<div><b>작업</b> ' + (spec.open ? '실행 표 — T1 요구 정리 8분 · T2 화면 설계 12분 · T3 카드 폼 검증 추가 5분… · 남은 계획 1 · 이전 계획' : '카드 폼 검증 추가 · 실행 3 · 완료 2 · 남은 1 ▸') + '</div>';
  if (has('sections')) html += '<div class="pv-tabs"><span>대화</span><span>작업 로그</span><span>에이전트 트리</span></div>';
  html += '<div class="pv-chat"><div class="pv-msg">폼 검증도 넣어 줘</div><div class="pv-msg is-bot">검증 규칙 4개를 추가했습니다. 카드 번호 · 만료일 · CVC · 이름…</div></div>';
  if (has('controls')) html += '<div class="pv-sub">이 세션 · Opus 5.5 · 높음 ▾</div>';
  html += '<div class="pv-composer">작업 중인 에이전트에 지시…</div>';
  return html + '</div>';
}
var LAY_SLACK_SAMPLE = {
  owner: '<span>@Zhuge</span>',
  workflow: '<code>zwork</code>',
  model: '<code>Opus 5.5</code>',
  ctx: '<span>▓▓▓░░ 64%</span>',
  cost: '<span>$6.20</span>',
  tokens: '<span>6.4M 토큰</span>',
  task: '<span>▶ 카드 폼 검증 추가</span>',
  steps: '<span>작업 2/4</span>',
  dashboardLink: '<span>📋 작업 로그</span>',
  linkhistory: '<span>🔀 PR-700 · Open</span><span>🎫 PAY-12</span>',
  links: '<span>🔀 PR-700</span>',
};
function layThreadHtml(t) {
  var html = '<div class="lay-slack" aria-label="슬랙 스레드 카드 미리보기"><div class="sk-head">결제 페이지 리뉴얼</div>';
  var line = function(items) {
    var out = '';
    for (var i = 0; i < items.length; i++) if (items[i].on && items[i].id !== 'status' && LAY_SLACK_SAMPLE[items[i].id]) out += LAY_SLACK_SAMPLE[items[i].id];
    return out ? '<div class="sk-ctx">' + out + '</div>' : '';
  };
  html += line(t.info || []) + line(t.nav || []);
  var status = (t.nav || []).some(function(x) { return x.id === 'status' && x.on; });
  if (status && _laySample === 'done') html += '<div class="sk-ctx"><span>⚫ <i>종료됨</i></span></div>';
  return html + '</div>';
}
function layPreview(l) {
  var box = document.getElementById('lay-preview');
  var note = document.getElementById('lay-preview-note');
  if (!box) return;
  var mode = _layMode;
  if (_laySurface === 'detail') {
    box.innerHTML = layDetailHtml(l);
    if (note) note.textContent = '디테일 카드의 배치입니다. 실제 화면은 대시보드에서 카드를 열면 오른쪽(휴대폰은 아래)에 열립니다.';
    return;
  }
  if (_laySurface === 'thread') {
    if (layThreadMode() === 'theme') { box.innerHTML = '<div class="ui-notice">서버 슬랙 테마를 씁니다.</div>'; if (note) note.textContent = ''; return; }
    box.innerHTML = layThreadHtml(l);
    if (note) note.textContent = '슬랙 스레드 맨 위 카드입니다. 채널의 다른 사람에게도 보입니다.';
    return;
  }
  var all = layoutsFor(_layDoc, _lay.builtins, mode, _lay.plan);
  var face = _laySurface === 'card' ? l : layoutOf(_layDoc, _lay.builtins, _layPreset, mode, 'card');
  var id = 'pv-' + _laySurface + '-' + _laySample;
  var full = laySampleCard(id);
  var asks = _laySample === 'wait';
  var card = faceOf(full, LAY_MODEL, face, asks);
  var html = '<div class="ui-tok"><ui-agent-inbox id="lay-inbox" lang="ko"></ui-agent-inbox></div>';
  if (box._kind !== id) { box.innerHTML = html; box._kind = id; }
  var inbox = document.getElementById('lay-inbox');
  if (!inbox) return;
  var body = inbox.querySelector('[slot="body:' + id + '"]');
  if (_laySurface === 'open') {
    if (!body) { body = document.createElement('div'); body.setAttribute('slot', 'body:' + id); inbox.appendChild(body); }
    body.innerHTML = layOpenBody(l);
  } else if (body) body.remove();
  inbox.data = layInbox(card, _laySurface === 'open');
  if (note) note.textContent = (_laySurface === 'card' ? '보드의 접힌 카드입니다' : '카드를 눌렀을 때 펼쳐지는 본문입니다 — 디테일 카드도 옆에 같이 열립니다')
    + (all.cardPreset !== _layPreset ? ' · 지금 태스크 카드의 기본 안은 ' + all.cardPreset + '안입니다' : '');
}

// ── Editing ──
function layList(l, zone) {
  if (_laySurface === 'thread') return l[zone];
  return l[zone];
}
function layMove(zone, from, to) {
  var l = layCur();
  var list = layList(l, zone);
  if (!list || from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return;
  var item = list.splice(from, 1)[0];
  list.splice(to, 0, item);
  laySet(l);
  var cat = layZoneCat(zone);
  layAnnounce(layCatEntry(cat, item.id).label + ' — ' + (from + 1) + '번째에서 ' + (to + 1) + '번째로 옮겼습니다');
}
function layZoneCat(zone) {
  var c = _lay.catalog;
  if (zone === 'rows') return c.card.rows;
  if (zone === 'foot') return c.card.foot;
  if (zone === 'parts') return c.open.parts;
  if (zone === 'top') return c.detail.top;
  if (zone === 'info') return c.thread.info;
  if (zone === 'nav') return c.thread.nav;
  return [];
}
function layToggle(zone, id, on) {
  var l = layCur();
  var list = layList(l, zone) || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].on = on;
  laySet(l);
  layAnnounce(layCatEntry(layZoneCat(zone), id).label + (on ? ' 보임' : ' 숨김'));
}
function layOpt(zone, id, value) {
  var l = layCur();
  var list = layList(l, zone) || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].opt = value;
  laySet(l);
}
function layFlag(key, on) {
  var l = layCur();
  l[key] = on;
  laySet(l);
}
function laySelect(key, value) {
  var l = layCur();
  l[key] = key === 'tasksMax' ? Number(value) : value;
  laySet(l);
}
function layReset() {
  layPush();
  if (_laySurface === 'thread') {
    _layDoc.thread = { mode: 'follow' };
  } else {
    var p = _layDoc.presets && _layDoc.presets[_layPreset];
    if (p && p[_layMode]) {
      delete p[_layMode][_laySurface];
      if (!Object.keys(p[_layMode]).length) delete p[_layMode];
      if (!Object.keys(p).length) delete _layDoc.presets[_layPreset];
      if (!Object.keys(_layDoc.presets).length) delete _layDoc.presets;
    }
  }
  layChanged();
  layAnnounce('기본값으로 돌렸습니다');
}
function layDefault(surface, value) {
  layPush();
  _layDoc.active = _layDoc.active || {};
  _layDoc.active[surface] = value;
  layChanged();
}
function layQuick(value) {
  layPush();
  _layDoc.active = { card: value, detail: value };
  _layPreset = value;
  layChanged();
  layAnnounce('태스크 카드와 디테일 카드를 ' + value + '안으로 바꿨습니다');
}
function layThreadSet(mode) {
  layPush();
  if (mode === 'custom') {
    var t = _layDoc.thread && _layDoc.thread.custom;
    // 따로 설정 starts from what the thread card shows now.
    _layDoc.thread = { mode: 'custom', custom: t || followThreadLayout(layoutsFor(_layDoc, _lay.builtins, _layMode, _lay.plan).card) };
  } else {
    _layDoc.thread = { mode: mode };
  }
  if (mode !== 'theme') _laySurface = 'thread';
  layChanged();
}

function layOnChange(e) {
  var t = e.target;
  var act = t && t.getAttribute && t.getAttribute('data-lay');
  if (!act) return;
  if (act === 'toggle') return layToggle(t.getAttribute('data-zone'), t.getAttribute('data-id'), !!t.checked);
  if (act === 'flag') return layFlag(t.getAttribute('data-key'), !!t.checked);
  if (act === 'opt') return layOpt(t.getAttribute('data-zone'), t.getAttribute('data-id'), t.value);
  if (act === 'select') return laySelect(t.getAttribute('data-key'), t.value);
  if (act === 'def-card') return layDefault('card', t.value);
  if (act === 'def-detail') return layDefault('detail', t.value);
  if (act === 'thread-mode') return layThreadSet(t.value);
  if (act === 'lay-preset') { _layPreset = t.value; return layPaint(); }
  if (act === 'lay-mode') { _layMode = t.value === 'advanced' ? 'advanced' : 'minimal'; return layPaint(); }
  if (act === 'lay-surface') { _laySurface = t.value; return layPaint(); }
  if (act === 'lay-sample') { _laySample = t.value; return layPaint(); }
}
function layOnClick(e) {
  var t = e.target && e.target.closest ? e.target.closest('[data-lay]') : null;
  if (!t || t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
  var act = t.getAttribute('data-lay');
  var idx = Number(t.getAttribute('data-idx'));
  if (act === 'up') return layMove(t.getAttribute('data-zone'), idx, idx - 1);
  if (act === 'down') return layMove(t.getAttribute('data-zone'), idx, idx + 1);
  if (act === 'undo') return layUndo();
  if (act === 'reset') return layReset();
  if (act === 'quick') return layQuick(t.getAttribute('data-v'));
}
// Drag by the handle (the row is draggable; the drop goes before or after the row under the pointer, in its list).
function layOnDragStart(e) {
  var li = e.target && e.target.closest ? e.target.closest('li.lay-item[data-zone]') : null;
  if (!li) return;
  _layDrag = { zone: li.getAttribute('data-zone'), from: Number(li.getAttribute('data-idx')) };
  li.classList.add('is-dragging');
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', li.getAttribute('data-id')); } catch (_e) {}
}
function layDropTarget(e) {
  var li = e.target && e.target.closest ? e.target.closest('li.lay-item[data-zone]') : null;
  if (!li || !_layDrag || li.getAttribute('data-zone') !== _layDrag.zone) return null;
  var r = li.getBoundingClientRect();
  return { li: li, idx: Number(li.getAttribute('data-idx')), after: e.clientY > r.top + r.height / 2 };
}
function layClearDrop() {
  var marks = document.querySelectorAll('.lay-item.is-drop-before, .lay-item.is-drop-after, .lay-item.is-dragging');
  for (var i = 0; i < marks.length; i++) marks[i].classList.remove('is-drop-before', 'is-drop-after', 'is-dragging');
}
function layOnDragOver(e) {
  var d = layDropTarget(e);
  if (!d) return;
  e.preventDefault();
  var marks = document.querySelectorAll('.lay-item.is-drop-before, .lay-item.is-drop-after');
  for (var i = 0; i < marks.length; i++) marks[i].classList.remove('is-drop-before', 'is-drop-after');
  d.li.classList.add(d.after ? 'is-drop-after' : 'is-drop-before');
}
function layOnDrop(e) {
  var d = layDropTarget(e);
  if (!d) { layClearDrop(); _layDrag = null; return; }
  e.preventDefault();
  var from = _layDrag.from;
  var to = d.idx + (d.after ? 1 : 0);
  if (to > from) to--;
  var zone = _layDrag.zone;
  _layDrag = null;
  layClearDrop();
  layMove(zone, from, to);
}
function initLayout() {
  var root = document.getElementById('lay-root');
  if (!root) return;
  root.addEventListener('change', layOnChange);
  root.addEventListener('click', layOnClick);
  root.addEventListener('dragstart', layOnDragStart);
  root.addEventListener('dragover', layOnDragOver);
  root.addEventListener('drop', layOnDrop);
  root.addEventListener('dragend', function() { _layDrag = null; layClearDrop(); });
  root.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' && e.target.type === 'text') return;
      e.preventDefault();
      layUndo();
    }
  });
}
initLayout();
`;
