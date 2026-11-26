/**
 * The board's 작업 큐 section (.prd/36 v2 §4.3, SSOT_4) — right under the CRON lane: every queue a task can wait in,
 * in two tabs, `작업 큐 | 개인별 큐`.
 *
 * - 작업 큐: each lane (`qa-dev2`, `deploy-stage0` — one at a time). What runs (title, keys, owner, for how long), then
 *   the cards that wait in it, in their order — moved here from the board's columns (a session whose lane entry waits
 *   is not drawn on the board) — and the lane's history: a 24-hour strip whose bars never overlap (one at a time) and
 *   the last few entries with when they waited, ran and how they ended. An admin (admin mode on) lets a waiting card
 *   go first, takes one out, or gives the running turn back.
 * - 개인별 큐: each person with something running, waiting or recently decided: their limit, what runs, their waiting
 *   requests as the 대기큐 cards (먼저 진행 · 대기 취소 — moved here from 응답 필요), and their history (started,
 *   cancelled, refused as the same work).
 *
 * The data is `GET /api/dashboard/work-queues` (polled while the page is visible, and after an action); the cards are
 * the board's own (`placeCard`, `uqPlace`) in one <ui-agent-inbox view="list"> per queue, like a CRON job's box.
 *
 * Plain ES5 with no template syntax: it reaches the browser byte for byte (String.raw). The section's markup is written
 * in the page itself (dashboard.ts, under the CRON lane): the page's markup is one plain template slice.
 */

export const WORK_QUEUE_CSS = String.raw`
/* ── 작업 큐 section (.prd/36 v2, work-queue-client.ts): under the CRON lane, 작업 큐 | 개인별 큐 ── */
.wq-section { margin-bottom: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.wq-section[hidden] { display: none; }
.wq-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
.wq-title { font-weight: 600; color: var(--text); }
.wq-sum { color: var(--text-secondary); font-size: 12px; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wq-fold { margin-left: auto; }
.wq-body { padding: 0 12px 12px; }
.wq-section.is-folded .wq-body { display: none; }
.wq-tabs { display: block; }
.wq-panel { display: grid; gap: 12px; padding-top: 8px; }
.wq-q { border: 1px solid var(--border); border-radius: 10px; padding: 10px; display: grid; gap: 8px; min-width: 0; }
.wq-qh { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
.wq-qname { font-family: var(--mono); font-weight: 600; color: var(--text); }
.wq-meta { color: var(--text-secondary); font-size: 12px; }
.wq-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 13px; color: var(--text); min-width: 0; }
.wq-row.is-run::before { content: '\25B6'; color: var(--st-run, var(--accent)); font-size: 10px; }
.wq-row.is-wait::before { content: '\23F3'; font-size: 11px; }
.wq-row.is-empty { color: var(--text-tertiary); }
.wq-link { color: var(--accent); cursor: pointer; text-decoration: none; background: none; border: 0; padding: 0; font: inherit; text-align: left; }
.wq-link:hover { text-decoration: underline; }
.wq-keys { font-family: var(--mono); font-size: 11px; color: var(--text-secondary); }
.wq-owner { font-size: 12px; color: var(--text-secondary); }
.wq-acts { display: inline-flex; gap: 4px; margin-left: auto; }
.wq-cards:empty { display: none; }
.wq-hist { display: grid; gap: 4px; }
.wq-strip { position: relative; height: 10px; border-radius: 5px; background: var(--bg); border: 1px solid var(--border); overflow: hidden; }
.wq-bar { position: absolute; top: 0; bottom: 0; min-width: 2px; border-radius: 3px; background: var(--st-done, var(--green)); opacity: 0.85; }
.wq-bar.is-run { background: var(--st-run, var(--accent)); }
.wq-bar.is-cancelled, .wq-bar.is-released { background: var(--text-tertiary); }
.wq-axis { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-tertiary); }
.wq-rec { font-size: 12px; color: var(--text-secondary); display: flex; flex-wrap: wrap; gap: 2px 8px; min-width: 0; }
.wq-rec b { color: var(--text); font-weight: 500; }
.wq-empty { color: var(--text-tertiary); font-size: 13px; padding: 4px 0; }
`;

export const WORK_QUEUE_CLIENT_JS = String.raw`
// ── 작업 큐 section (.prd/36 v2, work-queue-client.ts) ──
var WQ_POLL_MS = 15000;
var WQ_DAY_MS = 24 * 60 * 60 * 1000;
var WQ_RECENT_SHOWN = 5;
var _wqData = null;
var _wqTab = null;
var _wqLast = { byLane: {}, line: [] };
var _wqEntryByCard = Object.create(null);
var _wqBoxes = Object.create(null);
var _wqLoading = false;
var _wqLoadedAt = 0;

function wqTabNow() {
  if (_wqTab) return _wqTab;
  try { _wqTab = localStorage.getItem('soma-wq-tab') === 'people' ? 'people' : 'lanes'; } catch (_e) { _wqTab = 'lanes'; }
  return _wqTab;
}

// Pure: the board's columns with the idle cards that wait in a lane taken out, and those cards by lane in their order.
// A card whose turn runs, or that waits on a person's answer, stays on the board.
function wqSplitBoard(rest) {
  var byLane = Object.create(null);
  var out = {};
  for (var col in rest) {
    var list = rest[col];
    if (!Array.isArray(list) || (col !== 'waiting' && col !== 'working' && col !== 'idle' && col !== 'closed')) {
      out[col] = list;
      continue;
    }
    out[col] = list.filter(function(s) {
      var w = s && s.queueWait;
      if (!w || w.kind !== 'queued' || !w.queue) return true;
      // A card that needs an answer, or whose turn runs, stays where the board puts it (review 2026-11-26).
      if (s.activityState && s.activityState !== 'idle') return true;
      (byLane[w.queue] = byLane[w.queue] || []).push(s);
      return false;
    });
  }
  for (var lane in byLane) {
    byLane[lane].sort(function(a, b) { return (a.queueWait.position || 0) - (b.queueWait.position || 0); });
  }
  return { board: out, byLane: byLane };
}

// Pure: n minutes / hours as the section says them.
function wqDur(ms) {
  var m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return m + '분';
  var h = Math.floor(m / 60);
  return h + '시간' + (m % 60 ? ' ' + (m % 60) + '분' : '');
}
function wqClock(ms) {
  var d = new Date(ms);
  var hh = d.getHours(), mm = d.getMinutes();
  return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}
var WQ_END_LABEL = { done: '완료', cancelled: '취소', released: '돌려놓음', started: '시작', refused: '같은 작업이라 거절' };
var WQ_END_GLYPH = { done: '✓', cancelled: '✕', released: '⏹', started: '▶', refused: '⛔' };

// Pure: one history line — what it was, when it waited and ran, how it ended.
function wqRecordText(r) {
  var label = (r.task && r.task.title) || r.label || r.id;
  var keys = r.keys && r.keys.length ? ' · ' + r.keys.join(', ') : '';
  var when;
  if (r.end === 'started') {
    when = wqClock(r.endedAt) + ' 시작 (대기 ' + wqDur(r.endedAt - r.enteredAt) + ')';
  } else if (r.end === 'refused') {
    when = wqClock(r.endedAt);
  } else if (r.startedAt != null) {
    when = wqClock(r.startedAt) + ' → ' + wqClock(r.endedAt) + ' (' + wqDur(r.endedAt - r.startedAt) + ')';
  } else {
    when = wqClock(r.enteredAt) + ' 대기 → ' + wqClock(r.endedAt) + ' 빠짐';
  }
  var why = r.reason && r.end !== 'started' ? ' — ' + wqReason(r.reason) : '';
  return { glyph: WQ_END_GLYPH[r.end] || '·', end: WQ_END_LABEL[r.end] || r.end, label: label, keys: keys, when: when, why: why };
}
function wqReason(reason) {
  var s = String(reason || '');
  if (s.indexOf('admin:') === 0) return '관리자';
  if (s === 'holder-idle') return '세션이 일을 하지 않음';
  if (s === 'holder-asking') return '사람 답을 오래 기다림';
  if (s === 'holder-gone') return '세션이 사라짐';
  if (s === 'holder-stuck') return '턴이 너무 오래 멈춤';
  if (s === 'wake-expired') return '차례를 알리지 못함';
  if (s === 'person') return '본인';
  if (s === 'admin') return '관리자';
  if (s === 'closed') return '세션 종료';
  return s;
}

// Pure: the 24-hour strip's bars — every lane run (ended or running) inside the window, left and width in percent.
// A lane runs one at a time, so the bars never overlap: the strip itself shows it.
function wqStripBars(q, now) {
  var from = now - WQ_DAY_MS;
  var bars = [];
  function add(id, start, end, kind, title) {
    if (start == null || end < from) return;
    var s = Math.max(start, from);
    var left = ((s - from) / WQ_DAY_MS) * 100;
    var width = Math.max(((end - s) / WQ_DAY_MS) * 100, 0.2);
    bars.push({ id: id, left: Math.round(left * 100) / 100, width: Math.round(width * 100) / 100, kind: kind, title: title });
  }
  (q.recent || []).forEach(function(r) {
    if (r.startedAt == null || r.end === 'started' || r.end === 'refused') return;
    var t = wqRecordText(r);
    add(r.id, r.startedAt, r.endedAt, r.end, t.end + ' · ' + t.label + t.keys + ' · ' + t.when);
  });
  (q.running || []).forEach(function(e) {
    if (e.startedAt == null) return;
    add(e.id, e.startedAt, now, 'run', '진행 중 · ' + ((e.task && e.task.title) || e.id) + ' · ' + wqClock(e.startedAt) + '부터');
  });
  // The minimum width makes a short run visible; it never runs into the next run (one at a time stays visible).
  bars.sort(function(a, b) { return a.left - b.left; });
  for (var i = 0; i + 1 < bars.length; i++) {
    var room = Math.round((bars[i + 1].left - bars[i].left) * 100) / 100;
    if (bars[i].width > room) bars[i].width = Math.max(room, 0);
  }
  return bars;
}

// Pure: the section's one-line summary (shown folded too).
function wqSummary(lanes, people) {
  var waitLanes = 0, runLanes = 0, waitPeople = 0;
  lanes.forEach(function(q) { waitLanes += q.waiting.length; runLanes += q.running.length ? 1 : 0; });
  people.forEach(function(q) { waitPeople += q.waiting.length; });
  return '레인 ' + lanes.length + '개 · 진행 ' + runLanes + ' · 대기 ' + waitLanes + ' | 개인별 대기 ' + waitPeople;
}

function wqEl(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = String(text);
  return el;
}
// Pure: what the reader may do to a lane entry — an admin with admin mode: 먼저 진행 · 빼기 on a waiting entry,
// 돌려놓기 on a running one; the entry's owner: 빼기 on their own waiting entry (the server checks the same).
function wqActionsFor(e, canManage, viewer) {
  if (canManage) return e.state === 'running' ? ['release'] : ['first', 'cancel'];
  if (viewer && e.state === 'waiting' && e.task && e.task.ownerId === viewer) return ['cancel'];
  return [];
}
function wqViewer() {
  return typeof _viewerUserId !== 'undefined' && _viewerUserId ? _viewerUserId : undefined;
}
function wqCanManage() {
  return !!(_wqData && _wqData.canManage && typeof _isAdminModeOn === 'function' && _isAdminModeOn());
}
function wqButton(label, onClick) {
  var b = wqEl('button', 'ui-btn is-sm', label);
  b.type = 'button';
  b.addEventListener('click', function(e) { e.stopPropagation(); onClick(); });
  return b;
}
function wqTaskLink(task, fallback) {
  var title = (task && task.title) || fallback || '작업';
  if (task && task.key && _sessionCache[task.key]) {
    var a = wqEl('button', 'wq-link', title);
    a.type = 'button';
    a.addEventListener('click', function() { openPanel(task.key); });
    return a;
  }
  if (task && task.slackThreadUrl) {
    var l = wqEl('a', 'wq-link', title);
    l.href = task.slackThreadUrl;
    l.target = '_blank';
    l.rel = 'noopener';
    return l;
  }
  return wqEl('span', '', title);
}

// One entry's row: what it is, its keys, whose, since when — and the admin's hands on it.
function wqEntryRow(q, e, now) {
  var row = wqEl('div', 'wq-row ' + (e.state === 'running' ? 'is-run' : 'is-wait'));
  if (e.state === 'waiting') row.appendChild(wqEl('span', 'wq-meta', '#' + e.position));
  row.appendChild(wqTaskLink(e.task, e.label || e.id));
  if (e.keys && e.keys.length) row.appendChild(wqEl('span', 'wq-keys', e.keys.join(', ')));
  if (e.task && e.task.ownerName && q.kind === 'lane') row.appendChild(wqEl('span', 'wq-owner', e.task.ownerName));
  var since = e.state === 'running' ? (e.startedAt != null ? e.startedAt : e.enteredAt) : e.enteredAt;
  row.appendChild(wqEl('span', 'wq-meta', (e.state === 'running' ? '진행 ' : '대기 ') + wqDur(now - since)));
  var can = q.kind === 'lane' ? wqActionsFor(e, wqCanManage(), wqViewer()) : [];
  if (can.length) {
    var acts = wqEl('span', 'wq-acts');
    var labels = { release: '돌려놓기', first: '먼저 진행', cancel: '빼기' };
    can.forEach(function(a) { acts.appendChild(wqButton(labels[a], function() { wqAct(e.id, a, e); })); });
    row.appendChild(acts);
  }
  return row;
}

function wqHistory(q, now) {
  var box = wqEl('div', 'wq-hist');
  if (q.kind === 'lane') {
    var strip = wqEl('div', 'wq-strip');
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label', '지난 24시간 — 한 번에 하나씩 진행한 구간');
    wqStripBars(q, now).forEach(function(b) {
      var bar = wqEl('span', 'wq-bar is-' + b.kind);
      bar.style.left = b.left + '%';
      bar.style.width = b.width + '%';
      bar.title = b.title;
      strip.appendChild(bar);
    });
    box.appendChild(strip);
    var axis = wqEl('div', 'wq-axis');
    axis.appendChild(wqEl('span', '', '24시간 전'));
    axis.appendChild(wqEl('span', '', '한 번에 ' + (q.capacity == null ? '제한 없음' : q.capacity + '개')));
    axis.appendChild(wqEl('span', '', '지금'));
    box.appendChild(axis);
  }
  var recent = (q.recent || []).slice(0, WQ_RECENT_SHOWN);
  if (!recent.length) {
    box.appendChild(wqEl('div', 'wq-empty', '최근 내역 없음'));
    return box;
  }
  recent.forEach(function(r) {
    var t = wqRecordText(r);
    var line = wqEl('div', 'wq-rec');
    line.appendChild(wqEl('span', '', t.glyph + ' ' + t.end));
    var name = wqEl('b', '', t.label);
    line.appendChild(name);
    if (t.keys) line.appendChild(wqEl('span', 'wq-keys', t.keys.slice(3)));
    line.appendChild(wqEl('span', '', t.when + t.why));
    box.appendChild(line);
  });
  return box;
}

// The cards box of one queue: its own <ui-agent-inbox view="list">, one bare column (the CRON lane's way).
function wqCardsBox(id) {
  var box = _wqBoxes[id];
  if (!box) {
    box = wqEl('div', 'wq-cards');
    var el = document.createElement('ui-agent-inbox');
    el.className = 'cron-inbox';
    el.setAttribute('view', 'list');
    el.setAttribute('lang', document.documentElement && document.documentElement.lang === 'en' ? 'en' : 'ko');
    wireInbox(el);
    box._inbox = el;
    box.appendChild(el);
    _wqBoxes[id] = box;
  }
  return box;
}
function wqPaintCards(box, keys) {
  var el = box._inbox;
  el._ibPlan = { cols: [{ id: 'wq', label: '', bare: true, keys: keys }], load: 'ready', announce: false };
  el.classList.toggle('is-empty', !keys.length);
  box.hidden = !keys.length;
  inboxPaint(el);
}

function wqLaneBlock(q, cards, now) {
  var sec = wqEl('section', 'wq-q');
  sec.setAttribute('data-q', q.id);
  var head = wqEl('div', 'wq-qh');
  head.appendChild(wqEl('span', 'wq-qname', q.title));
  head.appendChild(wqEl('span', 'ui-chip', '한 번에 ' + (q.capacity == null ? '제한 없음' : q.capacity + '개')));
  head.appendChild(wqEl('span', 'wq-meta', '진행 ' + q.running.length + ' · 대기 ' + q.waiting.length));
  sec.appendChild(head);
  if (!q.running.length) sec.appendChild(wqEl('div', 'wq-row is-empty', '비어 있음 — 다음 차례가 바로 시작합니다'));
  q.running.forEach(function(e) { sec.appendChild(wqEntryRow(q, e, now)); });
  // The waiting entries: the card where the board has it (moved here), else a row (another owner's, a private one).
  var carded = Object.create(null);
  var keys = [];
  cards.forEach(function(s) {
    var entry = null;
    for (var i = 0; i < q.waiting.length; i++) if (q.waiting[i].task && q.waiting[i].task.key === s.key) entry = q.waiting[i];
    placeCard(s, 'working', null, true);
    if (entry) {
      carded[entry.id] = true;
      // What the reader may do to it: its open card draws the buttons (wqCardButtonsHtml) — a session card's body is
      // the page's own, so the element's data actions never show on it.
      _wqEntryByCard[s.key] = { id: entry.id, queue: q.id, can: wqActionsFor(entry, wqCanManage(), wqViewer()) };
    }
    keys.push(s.key);
  });
  q.waiting.forEach(function(e) { if (!carded[e.id]) sec.appendChild(wqEntryRow(q, e, now)); });
  var box = wqCardsBox('lane:' + q.id);
  keys.forEach(function(k) { _cardHost[k] = box._inbox; });
  sec.appendChild(box);
  wqPaintCards(box, keys);
  sec.appendChild(wqHistory(q, now));
  return sec;
}

function wqPersonBlock(q, line, now) {
  var sec = wqEl('section', 'wq-q');
  sec.setAttribute('data-q', q.id);
  var head = wqEl('div', 'wq-qh');
  head.appendChild(wqEl('span', 'wq-qname', q.title));
  head.appendChild(wqEl('span', 'ui-chip', '한 번에 ' + (q.capacity == null ? '제한 없음' : q.capacity + '개')));
  head.appendChild(wqEl('span', 'wq-meta', '진행 ' + q.running.length + ' · 대기 ' + q.waiting.length));
  sec.appendChild(head);
  if (!q.running.length) sec.appendChild(wqEl('div', 'wq-row is-empty', '진행 중인 작업 없음'));
  q.running.forEach(function(e) { sec.appendChild(wqEntryRow(q, e, now)); });
  var box = wqCardsBox(q.id);
  var keys = line.length ? uqPlace(line, box._inbox) : [];
  // A waiting entry the board did not send (another instance's line, a filter): its row.
  var shown = Object.create(null);
  line.forEach(function(it) { shown[it.entryId] = true; });
  q.waiting.forEach(function(e) { if (!shown[e.id]) sec.appendChild(wqEntryRow(q, e, now)); });
  sec.appendChild(box);
  wqPaintCards(box, keys);
  sec.appendChild(wqHistory(q, now));
  return sec;
}

// The section from the last data and this render's moved cards (renderBoard calls it with them).
function paintWorkQueues(byLane, line) {
  _wqLast = { byLane: byLane || {}, line: line || [] };
  var sec = document.getElementById('wq-section');
  if (!sec) return;
  var now = Date.now();
  var d = _wqData || { lanes: [], people: [], canManage: false };
  _wqEntryByCard = Object.create(null);
  var lanes = (d.lanes || []).slice();
  var known = Object.create(null);
  lanes.forEach(function(q) { known[q.id] = true; });
  for (var lane in _wqLast.byLane) {
    if (!known[lane]) lanes.push({ id: lane, kind: 'lane', title: lane, capacity: 1, running: [], waiting: [], recent: [] });
  }
  var people = (d.people || []).slice();
  var byOwner = Object.create(null);
  _wqLast.line.forEach(function(it) { (byOwner[it.ownerId] = byOwner[it.ownerId] || []).push(it); });
  var listed = Object.create(null);
  people.forEach(function(q) { listed[q.id.replace(/^user:/, '')] = true; });
  for (var owner in byOwner) {
    if (!listed[owner]) {
      var first = byOwner[owner][0];
      people.push({ id: 'user:' + owner, kind: 'person', title: first.ownerName || owner, capacity: first.limit, running: [], waiting: [], recent: [] });
    }
  }
  sec.hidden = !lanes.length && !people.length;
  var folded = wqFolded();
  sec.classList.toggle('is-folded', folded);
  var fold = document.getElementById('wq-fold');
  if (fold) {
    fold.textContent = folded ? '펼치기' : '접기';
    fold.setAttribute('aria-expanded', folded ? 'false' : 'true');
  }
  var sum = document.getElementById('wq-sum');
  if (sum) sum.textContent = wqSummary(lanes, people) + (_wqStale ? ' · 새로 고치지 못함 (다시 시도 중)' : '');
  var tabs = document.getElementById('wq-tabs');
  if (tabs) {
    var waitLanes = 0, waitPeople = 0;
    lanes.forEach(function(q) { waitLanes += Math.max(q.waiting.length, (_wqLast.byLane[q.id] || []).length); });
    people.forEach(function(q) { waitPeople += Math.max(q.waiting.length, (byOwner[q.id.replace(/^user:/, '')] || []).length); });
    var data = {
      tabs: [
        { id: 'lanes', label: '작업 큐', badge: waitLanes ? String(waitLanes) : undefined },
        { id: 'people', label: '개인별 큐', badge: waitPeople ? String(waitPeople) : undefined },
      ],
      value: wqTabNow(),
      label: '작업 큐 종류',
    };
    var sig = JSON.stringify(data);
    if (tabs._sig !== sig) {
      tabs._sig = sig;
      tabs.data = data;
    }
  }
  var lanesEl = document.getElementById('wq-lanes');
  var peopleEl = document.getElementById('wq-people');
  if (lanesEl) {
    lanesEl.textContent = '';
    if (!lanes.length) lanesEl.appendChild(wqEl('div', 'wq-empty', '아직 쓰인 레인이 없습니다 — 작업이 queue_enter로 줄을 서면 여기 생깁니다'));
    lanes.forEach(function(q) { lanesEl.appendChild(wqLaneBlock(q, _wqLast.byLane[q.id] || [], now)); });
  }
  if (peopleEl) {
    peopleEl.textContent = '';
    if (!people.length) peopleEl.appendChild(wqEl('div', 'wq-empty', '기다리는 개인 작업이 없습니다'));
    people.forEach(function(q) { peopleEl.appendChild(wqPersonBlock(q, byOwner[q.id.replace(/^user:/, '')] || [], now)); });
  }
}

function wqRepaint() {
  paintWorkQueues(_wqLast.byLane, _wqLast.line);
}

var WQ_FETCH_MS = 10000;
var _wqStale = false;
async function loadWorkQueues() {
  if (_wqLoading) return;
  _wqLoading = true;
  // A hung request never blocks the next poll: it is cut after WQ_FETCH_MS.
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var cut = ctl ? setTimeout(function() { ctl.abort(); }, WQ_FETCH_MS) : null;
  try {
    var res = await fetch('/api/dashboard/work-queues', ctl ? { signal: ctl.signal } : undefined);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _wqData = await res.json();
    _wqLoadedAt = Date.now();
    _wqStale = false;
  } catch (_e) {
    // The section keeps what it drew and says it is not fresh; the next poll tries again.
    _wqStale = true;
  } finally {
    if (cut) clearTimeout(cut);
    _wqLoading = false;
  }
  wqRepaint();
}

// After a board render: fresh data when the last is a few seconds old (a push often follows a queue change).
function wqAfterBoard() {
  if (Date.now() - _wqLoadedAt > 3000) loadWorkQueues();
}

// An admin's hand on a lane entry (or its holder's 빼기): the server ends or moves it, then the section reloads.
async function wqAct(entryId, action, entry) {
  var label = action === 'first' ? '먼저 진행' : action === 'release' ? '돌려놓기' : '빼기';
  try {
    var res = await acPost('/api/dashboard/work-queues/' + encodeURIComponent(String(entryId)) + '/' + action, '{}');
    if (res.ok) {
      dashToast({ title: label + ' 했어요', description: (entry && entry.task && entry.task.title) || String(entryId), tone: 'success' });
    } else {
      var st = await acRefusal(res);
      dashToast({ title: label + '하지 못했어요', description: st.message, tone: 'warning' });
    }
  } catch (_e) {
    dashToast({ title: label + '하지 못했어요', description: '네트워크 오류 — 다시 시도하세요', tone: 'warning' });
  }
  _wqLoadedAt = 0;
  loadWorkQueues();
}

// A lane card's buttons on its open card (renderCardBody's actions bar, before 중지 · Slack): 먼저 진행 · 대기에서 빼기,
// as the reader may (wqActionsFor at the last paint). Nothing for a card that does not wait in a lane.
var WQ_CARD_BUTTONS = [['first', 'wq-first', '먼저 진행'], ['cancel', 'wq-cancel', '대기에서 빼기']];
function wqCardButtonsHtml(key) {
  var at = _wqEntryByCard[key];
  if (!at || !at.can || !at.can.length) return '';
  var k = escJs(key);
  return WQ_CARD_BUTTONS.filter(function(b) { return at.can.indexOf(b[0]) >= 0; }).map(function(b) {
    return '<button type="button" class="ui-btn" data-action="' + b[1] + '" onclick="event.stopPropagation();wqCardAction(\'' + k + '\',\'' + b[1] + '\')">' + esc(b[2]) + '</button>';
  }).join('');
}

// A lane card's own buttons (먼저 진행 · 대기에서 빼기), pressed on its open card (wqCardButtonsHtml).
function wqCardAction(cardId, actionId) {
  var at = _wqEntryByCard[cardId];
  if (!at) return;
  wqAct(at.id, actionId === 'wq-first' ? 'first' : 'cancel', { task: { title: (_sessionCache[cardId] || {}).title } });
}

// Open unless the reader folded it (saved per device): the cards that wait live here, so it never starts folded.
function wqFolded() {
  var saved = null;
  try { saved = localStorage.getItem('soma-sec-wq'); } catch (_e) {}
  return saved === 'closed';
}
function wqToggleFold() {
  var next = wqFolded() ? 'open' : 'closed';
  try { localStorage.setItem('soma-sec-wq', next); } catch (_e) {}
  wqRepaint();
}

(function wqWire() {
  var tabs = document.getElementById('wq-tabs');
  if (tabs) {
    tabs.addEventListener('ui-change', function(e) {
      if (e.target !== tabs || !e.detail) return;
      _wqTab = e.detail.value === 'people' ? 'people' : 'lanes';
      try { localStorage.setItem('soma-wq-tab', _wqTab); } catch (_e) {}
      tabs._sig = '';
      wqRepaint();
    });
  }
  setInterval(function() {
    if (document.visibilityState === 'hidden') return;
    loadWorkQueues();
  }, WQ_POLL_MS);
  loadWorkQueues();
})();
`;
