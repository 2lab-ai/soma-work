/**
 * The settings page "작업 큐" tab — how many tasks (threads) each person may run at once (the per-user task queue,
 * src/user-task-queue). One row per person, each with a knob turned like a volume dial: 1 to 10, then ∞ (no limit).
 * A person with no setting has the default — 1, none for an admin — and 기본값 puts a turned knob back.
 *
 * The knob is a `role="slider"`: drag up or right to turn it up (down or left to turn it down), the wheel, the arrow
 * keys, Page Up / Down (3 at a time), Home (1) and End (∞). It saves when the hand lets go (a short pause after the
 * wheel or a key), and says what it saved.
 *
 * Admins only (the tab is `adminOnly`; `user-task-limits-routes.ts` refuses everyone else). Turning needs admin mode.
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte).
 */

export const TASK_QUEUE_TAB_HTML = `<div slot="task-queue" data-tab="task-queue" class="page" hidden>
  <aside class="side" aria-label="작업 큐 영역">
    <input type="search" class="ui-input" id="tq-filter" placeholder="이름 검색" aria-label="이름 검색" oninput="renderTaskQueue()">
  </aside>
  <main>
    <p class="intro">사람마다 동시에 진행할 수 있는 작업(스레드) 수입니다. 이보다 많이 시키면 새 요청은 그 사람의 대기큐에 들어가고, 진행 중인 작업이 끝나면 자동으로 시작합니다. 기본은 1개, 관리자는 무제한입니다. 노브를 볼륨처럼 돌려 정하세요 — 위·오른쪽으로 끌거나 휠·화살표 키로 돌리고, 손을 떼면 저장됩니다. 끝까지 돌리면 ∞(무제한)입니다.</p>
    <div id="tq-status" class="status" role="status" aria-live="polite"></div>
    <section class="group" id="tq-body"><div class="notice">불러오는 중…</div></section>
  </main>
</div>`;

export const TASK_QUEUE_TAB_CSS = `
#tq-body { padding: 16px; }
.tq-banner { font-size: 13px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); margin-bottom: 12px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.tq-rows { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.tq-row { display: flex; gap: 14px; align-items: center; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.tq-who { min-width: 0; flex: 1; display: grid; gap: 2px; }
.tq-name { font-size: 14px; font-weight: 650; overflow-wrap: anywhere; }
.tq-sub { font-size: 12px; color: var(--text-secondary); }
.tq-set { font-size: 12px; color: var(--text-secondary); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tq-set .btn { font-size: 12px; padding: 2px 8px; }
.tq-knob { position: relative; width: 76px; height: 76px; flex: none; border-radius: 50%; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; outline: none; }
.tq-knob:focus-visible { box-shadow: 0 0 0 3px var(--border-focus); }
.tq-knob.is-dragging { cursor: grabbing; }
.tq-knob[aria-disabled="true"] { cursor: not-allowed; opacity: .55; }
.tq-knob svg { width: 100%; height: 100%; display: block; overflow: visible; }
.tq-track { fill: none; stroke: var(--border); stroke-width: 5; stroke-linecap: round; }
.tq-fill { fill: none; stroke: var(--accent); stroke-width: 5; stroke-linecap: round; transition: d .12s ease-out; }
.tq-tick { stroke: var(--text-tertiary); stroke-width: 1.5; stroke-linecap: round; }
.tq-cap { fill: var(--surface-raised, var(--surface)); stroke: var(--border); stroke-width: 1.5; }
.tq-pointer { stroke: var(--text); stroke-width: 3; stroke-linecap: round; transition: transform .12s ease-out; transform-origin: 38px 38px; }
.tq-value { position: absolute; left: 0; right: 0; bottom: -2px; text-align: center; font-size: 14px; font-weight: 650; line-height: 18px; font-variant-numeric: tabular-nums; pointer-events: none; }
.tq-knob.is-default .tq-fill { stroke: var(--text-tertiary); }
@media (prefers-reduced-motion: reduce) { .tq-fill, .tq-pointer { transition: none; } }
`;

export const TASK_QUEUE_CLIENT_JS = String.raw`
var _tq = null;            // GET /api/settings/task-limits
var _tqLoaded = false;
var TQ_MAX = 10;           // the knob's last number; one step past it is ∞
var TQ_SWEEP = 270;        // degrees the knob turns from 1 to ∞
var TQ_PX_PER_STEP = 14;   // a drag this long turns it one step
var _tqSaveTimers = {};
var _tqDrag = null;

function tqStatus(text, isError) {
  var el = document.getElementById('tq-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (text ? (isError ? ' is-error' : ' is-ok') : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
}
// The knob's step for a limit: 1..TQ_MAX, and TQ_MAX + 1 for no limit (null or 'unlimited').
function tqStepOf(limit) {
  if (limit === null || limit === undefined || limit === 'unlimited') return TQ_MAX + 1;
  var n = Math.round(Number(limit));
  if (!(n >= 1)) return 1;
  return Math.min(n, TQ_MAX + 1);
}
// What a step sends: the number, or 'unlimited' past TQ_MAX.
function tqSettingOf(step) {
  return step > TQ_MAX ? 'unlimited' : step;
}
function tqLabel(step) {
  return step > TQ_MAX ? '무제한' : step + '개';
}
function tqClamp(step) {
  return Math.max(1, Math.min(TQ_MAX + 1, Math.round(step)));
}
// Degrees from 12 o'clock: 1 at the lower left (-135°), ∞ at the lower right (+135°).
function tqAngle(step) {
  return -TQ_SWEEP / 2 + ((tqClamp(step) - 1) * TQ_SWEEP) / TQ_MAX;
}
function tqPoint(cx, cy, r, deg) {
  var a = (deg * Math.PI) / 180;
  return [Math.round((cx + r * Math.sin(a)) * 100) / 100, Math.round((cy - r * Math.cos(a)) * 100) / 100];
}
// An SVG arc along the dial from angle a to b (clockwise).
function tqArc(cx, cy, r, a, b) {
  var p = tqPoint(cx, cy, r, a);
  var q = tqPoint(cx, cy, r, b);
  var large = b - a > 180 ? 1 : 0;
  return 'M ' + p[0] + ' ' + p[1] + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + q[0] + ' ' + q[1];
}
// A key's new step (or the same step for a key the knob does not take).
function tqStepFromKey(step, key) {
  if (key === 'ArrowUp' || key === 'ArrowRight') return tqClamp(step + 1);
  if (key === 'ArrowDown' || key === 'ArrowLeft') return tqClamp(step - 1);
  if (key === 'PageUp') return tqClamp(step + 3);
  if (key === 'PageDown') return tqClamp(step - 3);
  if (key === 'Home') return 1;
  if (key === 'End') return TQ_MAX + 1;
  return step;
}
// A drag's step: up and right turn it up — the larger of the two moves wins, like a volume knob.
function tqStepFromDrag(startStep, dx, dy) {
  var move = Math.abs(dx) > Math.abs(dy) ? dx : -dy;
  return tqClamp(startStep + Math.trunc(move / TQ_PX_PER_STEP));
}
// The knob's drawing for a step (track, fill to the step, ticks, cap and pointer).
function tqKnobSvg(step) {
  var c = 38;
  var a0 = -TQ_SWEEP / 2;
  var a = tqAngle(step);
  var ticks = '';
  for (var i = 1; i <= TQ_MAX + 1; i++) {
    var t = tqAngle(i);
    var p = tqPoint(c, c, 36, t);
    var q = tqPoint(c, c, 33, t);
    ticks += '<line class="tq-tick" x1="' + p[0] + '" y1="' + p[1] + '" x2="' + q[0] + '" y2="' + q[1] + '"/>';
  }
  var fill = step > 1 ? '<path class="tq-fill" d="' + tqArc(c, c, 29, a0, a) + '"/>' : '';
  return '<svg viewBox="0 0 76 76" aria-hidden="true">' + ticks
    + '<path class="tq-track" d="' + tqArc(c, c, 29, a0, -a0) + '"/>' + fill
    + '<circle class="tq-cap" cx="' + c + '" cy="' + c + '" r="21"/>'
    + '<line class="tq-pointer" x1="' + c + '" y1="' + (c - 6) + '" x2="' + c + '" y2="' + (c - 18) + '" style="transform: rotate(' + a + 'deg)"/>'
    + '</svg>';
}
function tqRow(u, editable) {
  var step = tqStepOf(u.limit);
  var isDefault = u.setting === null || u.setting === undefined;
  var def = tqLabel(tqStepOf(u.defaultLimit));
  var name = u.name || u.id;
  var sub = (u.admin ? '관리자 · ' : '') + '진행 중 ' + (u.running || 0) + ' · 대기 ' + (u.waiting || 0);
  var set = isDefault
    ? '기본값 (' + esc(def) + ')'
    : '관리자가 정함 · 기본값 ' + esc(def)
      + (editable ? ' <button type="button" class="btn" data-user="' + escAttr(u.id) + '" onclick="tqReset(this)">기본값으로</button>' : '');
  return '<li class="tq-row" data-user="' + escAttr(u.id) + '">'
    + '<div class="tq-knob' + (isDefault ? ' is-default' : '') + '" role="slider" tabindex="' + (editable ? '0' : '-1') + '"'
    + ' aria-label="' + escAttr(name + ' 동시 작업 한도') + '" aria-valuemin="1" aria-valuemax="' + (TQ_MAX + 1) + '"'
    + ' aria-valuenow="' + step + '" aria-valuetext="' + escAttr(tqLabel(step)) + '"'
    + (editable ? '' : ' aria-disabled="true" title="관리자 모드를 켜야 바꿀 수 있습니다"')
    + ' data-user="' + escAttr(u.id) + '" data-step="' + step + '">'
    + tqKnobSvg(step) + '<span class="tq-value">' + (step > TQ_MAX ? '∞' : step) + '</span></div>'
    + '<div class="tq-who"><span class="tq-name">' + esc(name) + '</span>'
    + '<span class="tq-sub">' + esc(sub) + '</span>'
    + '<span class="tq-set" id="tq-set-' + escAttr(u.id) + '">' + set + '</span></div></li>';
}
function tqBanner() {
  if (!adminModeOn()) {
    return '<div class="tq-banner" role="note"><span>노브를 돌리려면 관리자 모드를 켜세요. 대시보드 막대의 관리자 모드와 같은 스위치입니다.</span>'
      + '<button type="button" class="btn" onclick="tqSetAdminMode(true)">관리자 모드 켜기</button></div>';
  }
  return '<div class="tq-banner" role="note"><span>관리자 모드 — 노브를 돌리고 손을 떼면 바로 저장되고, 대기 중인 작업은 새 한도로 바로 시작합니다.</span>'
    + '<button type="button" class="btn" onclick="tqSetAdminMode(false)">관리자 모드 끄기</button></div>';
}
function tqSetAdminMode(on) {
  try { localStorage.setItem('soma_admin_mode', on ? 'on' : 'off'); } catch (_e) {}
  renderTaskQueue();
}
async function loadTaskQueue() {
  var el = document.getElementById('tq-body');
  try {
    var res = await fetch('/api/settings/task-limits');
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) {
      el.innerHTML = '<div class="notice is-error" role="alert">' + esc((data && data.error) || ('한도를 불러오지 못했습니다 (HTTP ' + res.status + ')')) + '</div>';
      return;
    }
    _tq = data;
    if (data && data.max) TQ_MAX = data.max;
    _tqLoaded = true;
    renderTaskQueue();
  } catch (_e) {
    el.innerHTML = '<div class="notice is-error" role="alert">한도를 불러오지 못했습니다. 다시 시도하세요.</div>';
  }
}
function renderTaskQueue() {
  var el = document.getElementById('tq-body');
  if (!el || !_tq) return;
  var q = ((document.getElementById('tq-filter') || {}).value || '').toLowerCase().trim();
  var editable = adminModeOn();
  var users = (_tq.users || []).filter(function(u) {
    return !q || String(u.name || '').toLowerCase().indexOf(q) >= 0 || String(u.id).toLowerCase().indexOf(q) >= 0;
  });
  el.innerHTML = tqBanner() + (users.length
    ? '<ul class="tq-rows">' + users.map(function(u) { return tqRow(u, editable); }).join('') + '</ul>'
    : '<div class="notice">사람이 없습니다.</div>');
  if (editable) tqWire(el);
}
function tqUser(id) {
  return ((_tq && _tq.users) || []).find(function(u) { return u.id === id; }) || null;
}
// Paint a knob at a step (while it turns) without rebuilding the row.
function tqPaint(knob, step) {
  knob.setAttribute('data-step', String(step));
  knob.setAttribute('aria-valuenow', String(step));
  knob.setAttribute('aria-valuetext', tqLabel(step));
  var value = knob.querySelector('.tq-value');
  knob.innerHTML = tqKnobSvg(step);
  if (value) value.textContent = step > TQ_MAX ? '∞' : String(step);
  knob.appendChild(value || document.createElement('span'));
}
function tqWire(root) {
  var knobs = root.querySelectorAll('.tq-knob[role="slider"]');
  for (var i = 0; i < knobs.length; i++) {
    (function(knob) {
      knob.addEventListener('pointerdown', function(e) {
        if (e.button !== undefined && e.button !== 0) return;
        _tqDrag = { knob: knob, x: e.clientX, y: e.clientY, start: Number(knob.getAttribute('data-step')) || 1 };
        knob.classList.add('is-dragging');
        if (knob.setPointerCapture) knob.setPointerCapture(e.pointerId);
        knob.focus();
        e.preventDefault();
      });
      knob.addEventListener('pointermove', function(e) {
        if (!_tqDrag || _tqDrag.knob !== knob) return;
        var step = tqStepFromDrag(_tqDrag.start, e.clientX - _tqDrag.x, e.clientY - _tqDrag.y);
        if (step !== Number(knob.getAttribute('data-step'))) tqPaint(knob, step);
      });
      var end = function() {
        if (!_tqDrag || _tqDrag.knob !== knob) return;
        var moved = Number(knob.getAttribute('data-step')) !== _tqDrag.start;
        _tqDrag = null;
        knob.classList.remove('is-dragging');
        if (moved) tqSave(knob, 0);
      };
      knob.addEventListener('pointerup', end);
      knob.addEventListener('pointercancel', end);
      knob.addEventListener('wheel', function(e) {
        e.preventDefault();
        var cur = Number(knob.getAttribute('data-step')) || 1;
        var step = tqClamp(cur + (e.deltaY < 0 ? 1 : -1));
        if (step === cur) return;
        tqPaint(knob, step);
        tqSave(knob, 500);
      }, { passive: false });
      knob.addEventListener('keydown', function(e) {
        var cur = Number(knob.getAttribute('data-step')) || 1;
        var step = tqStepFromKey(cur, e.key);
        if (step === cur) return;
        e.preventDefault();
        tqPaint(knob, step);
        tqSave(knob, 400);
      });
    })(knobs[i]);
  }
}
// Save a knob's step after a short quiet (one write per turn of the hand).
function tqSave(knob, delay) {
  var id = knob.getAttribute('data-user');
  if (_tqSaveTimers[id]) clearTimeout(_tqSaveTimers[id]);
  _tqSaveTimers[id] = setTimeout(function() {
    delete _tqSaveTimers[id];
    tqPut(id, tqSettingOf(Number(knob.getAttribute('data-step')) || 1));
  }, delay);
}
async function tqPut(id, limit) {
  var u = tqUser(id);
  var who = (u && u.name) || id;
  var r = await apiWrite('PUT', '/api/settings/task-limits/' + encodeURIComponent(id), { limit: limit });
  if (!r.ok) {
    tqStatus(who + ' 한도를 저장하지 못했습니다 — ' + r.error, true);
    // The knob goes back to what is saved; nothing else on the page moves.
    tqRefreshRow(id);
    return;
  }
  var row = r.data && r.data.user;
  if (row && _tq && _tq.users) {
    for (var i = 0; i < _tq.users.length; i++) if (_tq.users[i].id === id) _tq.users[i] = row;
  }
  tqStatus(who + ': 동시 작업 ' + (limit === null ? '기본값 (' + tqLabel(tqStepOf(row && row.limit)) + ')' : tqLabel(tqStepOf(limit))) + '로 저장했습니다');
  tqRefreshRow(id);
}
// One person's row as saved — updated in place: the knob keeps its focus, and a knob being dragged is left alone
// (a save of another person's knob, or of this one, must not take it from under the hand).
function tqRefreshRow(id) {
  var u = tqUser(id);
  var body = document.getElementById('tq-body');
  if (!u || !body) return;
  var li = null;
  var rows = body.querySelectorAll('.tq-row');
  for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-user') === id) li = rows[i];
  if (!li) return;
  var editable = adminModeOn();
  var probe = document.createElement('ul');
  probe.innerHTML = tqRow(u, editable);
  var fresh = probe.firstChild;
  var who = li.querySelector('.tq-who');
  var freshWho = fresh && fresh.querySelector('.tq-who');
  if (who && freshWho) who.innerHTML = freshWho.innerHTML;
  var knob = li.querySelector('.tq-knob');
  if (!knob) return;
  var isDefault = u.setting === null || u.setting === undefined;
  if (isDefault) knob.classList.add('is-default');
  else knob.classList.remove('is-default');
  var dragging = _tqDrag && _tqDrag.knob === knob;
  var step = tqStepOf(u.limit);
  if (!dragging && !_tqSaveTimers[id] && Number(knob.getAttribute('data-step')) !== step) tqPaint(knob, step);
}
function tqReset(btn) {
  tqPut(btn.getAttribute('data-user'), null);
}
`;
