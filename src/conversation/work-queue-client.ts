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
/* ── 작업 큐 section (.prd/36 v2, work-queue-client.ts): under the CRON lane, 작업 큐 | 개인별 큐. It speaks the CRON
   lane's grammar (@2lab.ai/ui <ui-agent-queue> .aq-lane): the same plane, head row (glyph · spaced caps title · count ·
   state pills · 펼치기 ⌄), job-box tiles (.cron-group: badge · name · its history button · run ticks · status line ·
   the moved card under it) and up-next chips (.aq-q) — values copied from the element, on the page's tokens. ── */
.wq-section { margin-bottom: 12px; --wq-queue: var(--card-queue, var(--purple)); --wq-queue-text: color-mix(in srgb, var(--wq-queue) calc(80% * var(--chroma, 1)), var(--text)); }
.wq-section[hidden] { display: none; }
.wq-lane { container: wqlane / inline-size; background: var(--ib-col); border-radius: 14px; padding: 2px 4px 10px; color: var(--ib-text); min-width: 0; }
.wq-section.is-folded .wq-lane { padding-bottom: 4px; }
.wq-lane-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 10px 8px 8px 10px; min-height: 40px; }
.wq-lane-ic { display: inline-flex; color: var(--ib-muted); }
.wq-lane-ic svg { width: 14px; height: 14px; }
/* The CRON head's spaced caps are for Latin; a Korean title takes the LLM 가용량 head's spacing (.cap-title). */
.wq-lane-title { margin: 0; font-size: 12px; font-weight: 500; letter-spacing: 0.02em; color: var(--ib-muted); }
.wq-pills { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.wq-count { background: var(--ib-pill); color: var(--ib-text-2); border-radius: 6px; padding: 1px 7px; font-size: 12px; font-weight: 500; min-width: 22px; text-align: center; font-variant-numeric: tabular-nums; }
.wq-pill { display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1.3; white-space: nowrap; font-variant-numeric: tabular-nums; color: color-mix(in srgb, var(--wq-pc, var(--ib-text-2)) calc(100% * var(--chroma, 1)), var(--ib-text-2)); background: color-mix(in srgb, var(--wq-pc, var(--ib-muted)) calc(14% * var(--chroma, 1)), transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wq-pc, var(--ib-muted)) 45%, transparent); }
.wq-pill.is-run { --wq-pc: var(--st-run); }
/* Waiting in a queue is the board's queue tint (--card-queue), not CRON's 응답 필요 amber: nobody owes an answer. */
.wq-pill.is-wait { --wq-pc: var(--wq-queue); color: var(--wq-queue-text); }
.wq-pill.is-stale { --wq-pc: var(--st-fail); color: var(--st-fail-text); }
.wq-fold { position: relative; flex-shrink: 0; align-self: center; display: inline-flex; align-items: center; gap: 4px; min-height: 32px; margin-left: auto; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--ib-muted); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background-color 150ms ease, color 150ms ease; }
.wq-fold svg { width: 14px; height: 14px; transition: transform var(--dur-press) var(--ease-out); }
.wq-fold[aria-expanded="true"] svg { transform: rotate(180deg); }
.wq-fold:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
@media (hover: hover) and (pointer: fine) { .wq-fold:hover { background: var(--ib-pill); color: var(--ib-text); } }
.wq-body { padding: 0 4px; }
.wq-section.is-folded .wq-body { display: none; }
.wq-tabs { display: block; }
.wq-panel { display: grid; gap: 10px; padding-top: 10px; min-width: 0; }
/* Tiles: the CRON lane's job boxes */
.wq-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 10px; align-items: start; min-width: 0; }
.wq-group { position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 10px; border-radius: 12px; border: 1px dashed var(--ib-card-border); background: color-mix(in srgb, var(--ib-card) 45%, transparent); transition: border-color 150ms ease; --st-color: var(--ib-text-2); }
.wq-group.is-running { border-style: solid; border-color: color-mix(in srgb, var(--st-run) 55%, transparent); --st-color: var(--st-run); }
.wq-group.is-waiting { border-style: solid; border-color: color-mix(in srgb, var(--wq-queue) 60%, var(--ib-card-border)); --st-color: var(--wq-queue-text); }
.wq-tile-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wq-badge { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px 1px 5px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; line-height: 1.5; color: color-mix(in srgb, var(--st-color, var(--ib-text-2)) calc(100% * var(--chroma, 1)), var(--ib-text-2)); background: color-mix(in srgb, var(--st-color, var(--ib-muted)) calc(14% * var(--chroma, 1)), transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--st-color, var(--ib-muted)) 45%, transparent); }
.wq-badge svg { width: 12px; height: 12px; color: var(--st-color, var(--ib-text-2)); }
.wq-name { flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 600; color: var(--ib-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wq-name.is-mono { font-family: var(--mono); font-size: 13px; }
.wq-btn { flex-shrink: 0; margin-left: auto; min-height: 28px; padding: 2px 10px; border-radius: 8px; border: 1px solid var(--ib-card-border); background: var(--ib-card); color: var(--ib-text-2); font: inherit; font-size: 12px; cursor: pointer; transition: transform var(--dur-press) var(--ease-out), border-color 150ms ease; }
.wq-btn + .wq-btn { margin-left: 0; }
.wq-btn:active:not(:focus-visible) { transform: scale(0.97); }
.wq-btn[aria-expanded="true"] { border-color: var(--ib-muted); color: var(--ib-text); }
@media (hover: hover) and (pointer: fine) { .wq-btn:hover { border-color: var(--ib-muted); color: var(--ib-text); } }
.wq-ticks { display: flex; align-items: flex-end; gap: 3px; height: 22px; padding: 2px 0; max-width: 100%; }
.wq-ticks.is-empty { font-size: 12px; color: var(--ib-muted); height: auto; }
.wq-tick { display: block; flex: none; width: 8px; height: 16px; border-radius: 2px; background: var(--st-done); }
.wq-tick.is-none { background: transparent; box-shadow: inset 0 0 0 1.5px var(--ib-muted); }
.wq-tick.is-run { background: var(--st-run); }
@keyframes wq-pulse { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: no-preference) { .wq-tick.is-run { animation: wq-pulse 1.6s ease-in-out infinite; } }
.wq-status { font-size: 12px; color: var(--ib-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wq-status.is-run { color: color-mix(in srgb, var(--st-run) calc(100% * var(--chroma, 1)), var(--ib-text-2)); font-weight: 600; }
.wq-status.is-wait { color: var(--wq-queue-text); font-weight: 600; }
.wq-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; color: var(--ib-text-2); min-width: 0; }
.wq-row > .wq-glyph { flex: none; width: 1em; text-align: center; }
.wq-row.is-run > .wq-glyph { color: var(--st-run); }
.wq-row.is-wait > .wq-glyph { color: var(--wq-queue-text); }
.wq-link { color: var(--ib-text); cursor: pointer; text-decoration: none; background: none; border: 0; padding: 0; font: inherit; font-weight: 500; text-align: left; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.wq-link:hover { text-decoration: underline; }
.wq-keys { font-family: var(--mono); font-size: 11px; color: var(--ib-muted); }
.wq-meta { color: var(--ib-muted); font-size: 12px; }
.wq-acts { display: inline-flex; gap: 4px; margin-left: auto; }
.wq-cards { display: flex; flex-direction: column; gap: 8px; position: relative; }
.wq-cards[hidden] { display: none; }
.wq-hist { display: grid; gap: 4px; padding-top: 2px; border-top: 1px dashed var(--ib-card-border); }
.wq-rec { font-size: 12px; color: var(--ib-text-2); display: flex; flex-wrap: wrap; gap: 2px 8px; min-width: 0; padding-top: 4px; }
.wq-rec b { color: var(--ib-text); font-weight: 500; }
/* Idle lanes: the CRON lane's up-next chips (.aq-q) under its column head (.aq-col-head) */
.wq-idle { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px; border-radius: 12px; border: 1px solid var(--ib-card-border); background: color-mix(in srgb, var(--ib-card) 45%, transparent); }
.wq-col-head { font-size: 12px; color: var(--ib-muted); margin-right: 2px; }
.wq-col-head b { color: var(--ib-text-2); font-weight: 600; }
.wq-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; max-width: 100%; padding: 0 4px 0 8px; border-radius: 8px; border: 1px solid var(--ib-card-border); background: var(--ib-card); color: var(--ib-text); font-size: 12.5px; }
.wq-chip svg { flex: none; width: 12px; height: 12px; color: var(--ib-muted); }
.wq-chip-name { color: var(--ib-text); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wq-chip-last { flex: none; font-size: 11.5px; color: var(--ib-muted); white-space: nowrap; padding-right: 4px; }
.wq-chip-x { border: 0; background: none; color: var(--ib-muted); cursor: pointer; min-width: 24px; min-height: 24px; border-radius: 6px; font: inherit; font-size: 12px; padding: 0 6px; }
.wq-chip-x.is-armed { color: var(--st-fail-text); }
@media (hover: hover) and (pointer: fine) { .wq-chip:hover { border-color: var(--ib-muted); } .wq-chip-x:hover { background: var(--ib-pill); color: var(--ib-text); } .wq-chip-name:hover { text-decoration: underline; } }
.wq-empty { padding: 4px 2px; font-size: 12px; color: var(--ib-muted); }
/* Narrow as the CRON lane is narrow: its fold keeps the chevron and says its word to a screen reader only. */
@container wqlane (max-width: 639.98px) {
  .wq-lane .wq-fold { padding: 2px 8px; min-width: 44px; justify-content: center; }
  .wq-lane .wq-fold-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
}
@media (pointer: coarse) { .wq-fold, .wq-btn { min-height: 44px; } .wq-chip { min-height: 36px; } .wq-chip-x { min-width: 36px; min-height: 36px; } }
@media (prefers-reduced-motion: reduce) { .wq-fold, .wq-fold svg, .wq-btn, .wq-tick, .wq-group { animation: none; transition: none; } }
`;

// Why an entry left a lane, in the reader's words — the board's section and the settings tab (TASK_QUEUE_CLIENT_JS)
// say it the same way.
export const WQ_REASON_JS = String.raw`function wqReason(reason) {
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
  if (s === 'same-work') return '같은 키가 다른 스레드에서 진행 중이거나 대기 중';
  return s;
}`;

export const WORK_QUEUE_CLIENT_JS = String.raw`
// ── 작업 큐 section (.prd/36 v2, work-queue-client.ts) ──
var WQ_POLL_MS = 15000;
var WQ_RECENT_SHOWN = 5;
// The CRON lane's glyphs (@2lab.ai/ui <ui-agent-queue>): queue lines for the section, a clock-free lane mark, the chevron.
var WQ_QUEUE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6"/></svg>';
var WQ_LANE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h8M8 4.5L11.5 8 8 11.5"/><path d="M13.5 3.5v9"/></svg>';
var WQ_PERSON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13c.8-2.4 2.5-3.5 4.5-3.5s3.7 1.1 4.5 3.5"/></svg>';
var WQ_CHEVRON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
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
${WQ_REASON_JS}


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
  var b = wqEl('button', 'wq-btn', label);
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
  var run = e.state === 'running';
  var row = wqEl('div', 'wq-row ' + (run ? 'is-run' : 'is-wait'));
  row.appendChild(wqEl('span', 'wq-glyph', run ? '●' : '▲'));
  if (!run) row.appendChild(wqEl('span', 'wq-meta', '#' + e.position));
  row.appendChild(wqTaskLink(e.task, e.label || e.id));
  if (e.keys && e.keys.length) row.appendChild(wqEl('span', 'wq-keys', e.keys.join(', ')));
  if (e.task && e.task.ownerName && q.kind === 'lane') row.appendChild(wqEl('span', 'wq-meta', e.task.ownerName));
  var since = run ? (e.startedAt != null ? e.startedAt : e.enteredAt) : e.enteredAt;
  row.appendChild(wqEl('span', 'wq-meta', (run ? '진행 ' : '대기 ') + wqDur(now - since)));
  var can = q.kind === 'lane' ? wqActionsFor(e, wqCanManage(), wqViewer()) : [];
  if (can.length) {
    var acts = wqEl('span', 'wq-acts');
    var labels = { release: '돌려놓기', first: '먼저 진행', cancel: '빼기' };
    can.forEach(function(a) { acts.appendChild(wqButton(labels[a], function() { wqAct(e.id, a, e); })); });
    row.appendChild(acts);
  }
  return row;
}

function wqHistory(q) {
  var box = wqEl('div', 'wq-hist');
  var recent = (q.recent || []).slice(0, WQ_RECENT_SHOWN);
  if (!recent.length) {
    box.appendChild(wqEl('div', 'wq-empty', '최근 내역 없음'));
    return box;
  }
  recent.forEach(function(r) {
    var t = wqRecordText(r);
    var line = wqEl('div', 'wq-rec');
    line.appendChild(wqEl('span', '', t.glyph + ' ' + t.end));
    line.appendChild(wqEl('b', '', t.label));
    if (t.keys) line.appendChild(wqEl('span', 'wq-keys', t.keys.slice(3)));
    line.appendChild(wqEl('span', '', t.when + t.why));
    box.appendChild(line);
  });
  return box;
}

// What the reader opened (a tile's 내역, a person's list): it survives the 15-second repaint.
var _wqOpen = Object.create(null);
function wqToggleBtn(id, label, openByDefault) {
  var open = id in _wqOpen ? _wqOpen[id] : !!openByDefault;
  var b = wqEl('button', 'wq-btn', label);
  b.type = 'button';
  b.setAttribute('aria-expanded', open ? 'true' : 'false');
  b.addEventListener('click', function(e) {
    e.stopPropagation();
    _wqOpen[id] = !open;
    wqRepaint();
  });
  return { el: b, open: open };
}

// Pure: a lane's badge word from its name — the work it serialises (qa-dev2 → QA, deploy-stage0 → 배포), else 레인.
function wqLaneKind(name) {
  var n = String(name || '');
  if (/^qa[-._]/.test(n)) return 'QA';
  if (/^deploy[-._]/.test(n)) return '배포';
  return '레인';
}

// Pure: the tile's run ticks, the CRON lane's strip — the last 12 that left the lane, oldest first, then the one that
// runs now. A lane hands its turn on one at a time, so the ticks read left to right as the order it ran in.
var WQ_TICK = { done: 'ok', started: 'ok', cancelled: 'none', released: 'none', refused: 'none' };
function wqTicks(q) {
  var out = (q.recent || []).slice(0, 12).reverse().map(function(r) {
    var t = wqRecordText(r);
    return { kind: WQ_TICK[r.end] || 'none', title: t.glyph + ' ' + t.end + ' · ' + t.label + ' · ' + t.when + t.why };
  });
  (q.running || []).forEach(function(e) {
    out.push({ kind: 'run', title: '● 진행 중 · ' + ((e.task && e.task.title) || e.label || e.id) });
  });
  return out;
}
function wqTicksEl(q) {
  var ticks = wqTicks(q);
  if (!ticks.length) return wqEl('div', 'wq-ticks is-empty', '아직 진행한 기록 없음');
  var box = wqEl('div', 'wq-ticks');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', q.title + ' 최근 ' + ticks.length + '개 — 한 번에 하나씩 진행한 순서');
  ticks.forEach(function(t) {
    var i = wqEl('i', 'wq-tick' + (t.kind === 'ok' ? '' : ' is-' + t.kind));
    i.title = t.title;
    box.appendChild(i);
  });
  return box;
}

// Pure: a lane worth a block — an entry runs or waits in it, or the board moved a card into it. The rest are idle.
function wqLaneActive(q, cards) {
  return q.running.length > 0 || q.waiting.length > 0 || !!(cards && cards.length);
}

// Pure: an idle lane's chip — its name and how its last entry ended.
function wqIdleText(q) {
  var r = (q.recent || [])[0];
  if (!r) return { name: q.title || q.id, last: '내역 없음' };
  return { name: q.title || q.id, last: (WQ_END_LABEL[r.end] || r.end) + ' ' + wqClock(r.endedAt) };
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

// A lane as the CRON lane draws a job: its box (solid in the run tone while it runs, the wait tone while something
// waits), badge · name · 내역 n, the run ticks, the status line, then what runs and waits and the moved cards.
function wqLaneTile(q, cards, now) {
  var waits = Math.max(q.waiting.length, cards.length);
  var sec = wqEl('section', 'wq-group wq-q' + (q.running.length ? ' is-running' : waits ? ' is-waiting' : ''));
  sec.setAttribute('data-q', q.id);
  sec.setAttribute('aria-label', q.title);
  var head = wqEl('div', 'wq-tile-head');
  var badge = wqEl('span', 'wq-badge');
  badge.innerHTML = WQ_LANE_SVG;
  badge.appendChild(wqEl('span', '', wqLaneKind(q.id)));
  head.appendChild(badge);
  var name = wqEl('span', 'wq-name is-mono', q.title);
  name.title = q.title;
  head.appendChild(name);
  var hist = wqToggleBtn('h:' + q.id, '내역 ' + (q.recent || []).length, false);
  head.appendChild(hist.el);
  sec.appendChild(head);
  sec.appendChild(wqTicksEl(q));
  var status = q.running.length ? '● 진행 중 ' + q.running.length + (waits ? ' · ▲ 대기 ' + waits : '') : waits ? '▲ 대기 ' + waits : '비어 있음';
  sec.appendChild(wqEl('div', 'wq-status' + (q.running.length ? ' is-run' : waits ? ' is-wait' : ''), status));
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
  if (hist.open) sec.appendChild(wqHistory(q));
  return sec;
}

// The idle lanes on one line: a chip each (name · how it last ended), linked to the settings tab's history; an admin
// (admin mode) can forget one — two presses, the first arms it.
var _wqArmed = null;
function wqIdleLine(idle) {
  var row = wqEl('div', 'wq-idle');
  var head = wqEl('span', 'wq-col-head', '쉬는 레인 ');
  head.appendChild(wqEl('b', '', String(idle.length)));
  row.appendChild(head);
  idle.forEach(function(q) {
    var t = wqIdleText(q);
    var chip = wqEl('span', 'wq-chip');
    chip.innerHTML = WQ_LANE_SVG;
    var a = wqEl('a', 'wq-chip-name', t.name);
    a.href = '/dashboard/settings#task-queue';
    a.title = t.name + ' — 최근: ' + t.last + ' (설정 › 작업 큐에서 내역)';
    chip.appendChild(a);
    chip.appendChild(wqEl('span', 'wq-chip-last', t.last));
    if (wqCanManage()) {
      var armed = _wqArmed && _wqArmed.id === q.id && Date.now() - _wqArmed.at < 4000;
      var x = wqEl('button', 'wq-chip-x' + (armed ? ' is-armed' : ''), armed ? '한 번 더 눌러 지우기' : '×');
      x.type = 'button';
      x.setAttribute('aria-label', armed ? q.id + ' 레인 지우기 — 한 번 더 누르세요' : q.id + ' 레인 지우기');
      x.title = '레인 지우기 — 내역이 사라지고, 고정 레인이 아니면 목록에서 빠집니다';
      x.addEventListener('click', function(e) {
        e.stopPropagation();
        if (armed) { _wqArmed = null; wqForget(q.id); return; }
        _wqArmed = { id: q.id, at: Date.now() };
        wqRepaint();
        setTimeout(function() { if (_wqArmed && _wqArmed.id === q.id) { _wqArmed = null; wqRepaint(); } }, 4000);
      });
      chip.appendChild(x);
    }
    row.appendChild(chip);
  });
  return row;
}

async function wqForget(queue) {
  try {
    var res = await acPost('/api/dashboard/work-queues/lane/' + encodeURIComponent(queue) + '/forget', '{}');
    if (res.ok) dashToast({ title: '레인을 지웠어요', description: queue, tone: 'success' });
    else dashToast({ title: '레인을 지우지 못했어요', description: (await acRefusal(res)).message, tone: 'warning' });
  } catch (_e) {
    dashToast({ title: '레인을 지우지 못했어요', description: '네트워크 오류 — 다시 시도하세요', tone: 'warning' });
  }
  _wqLoadedAt = 0;
  loadWorkQueues();
}

// A person as the same tile: badge 개인 · name · 목록 n (what runs and what left), the status line, the waiting cards.
// The list opens by itself while something of theirs waits.
function wqPersonTile(q, line, now) {
  var waits = Math.max(q.waiting.length, line.length);
  var sec = wqEl('section', 'wq-group wq-q wq-person' + (waits ? ' is-waiting' : q.running.length ? ' is-running' : ''));
  sec.setAttribute('data-q', q.id);
  sec.setAttribute('aria-label', q.title);
  var head = wqEl('div', 'wq-tile-head');
  var badge = wqEl('span', 'wq-badge');
  badge.innerHTML = WQ_PERSON_SVG;
  badge.appendChild(wqEl('span', '', '개인'));
  head.appendChild(badge);
  head.appendChild(wqEl('span', 'wq-name', q.title));
  var list = wqToggleBtn('p:' + q.id, '목록 ' + (q.running.length + (q.recent || []).length), waits > 0);
  head.appendChild(list.el);
  sec.appendChild(head);
  var status = '● 진행 ' + q.running.length + ' · ▲ 대기 ' + waits + ' · 한 번에 ' + (q.capacity == null ? '제한 없음' : q.capacity + '개');
  sec.appendChild(wqEl('div', 'wq-status' + (waits ? ' is-wait' : q.running.length ? ' is-run' : ''), status));
  var box = wqCardsBox(q.id);
  var keys = line.length ? uqPlace(line, box._inbox) : [];
  // A waiting entry the board did not send (another instance's line, a filter): its row.
  var shown = Object.create(null);
  line.forEach(function(it) { shown[it.entryId] = true; });
  q.waiting.forEach(function(e) { if (!shown[e.id]) sec.appendChild(wqEntryRow(q, e, now)); });
  sec.appendChild(box);
  wqPaintCards(box, keys);
  if (list.open) {
    q.running.forEach(function(e) { sec.appendChild(wqEntryRow(q, e, now)); });
    if ((q.recent || []).length) sec.appendChild(wqHistory(q));
  }
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
    var word = folded ? '펼치기' : '접기';
    if (fold._word !== word) {
      fold._word = word;
      fold.innerHTML = '<span class="wq-fold-text">' + word + '</span>' + WQ_CHEVRON_SVG;
    }
    fold.setAttribute('aria-expanded', folded ? 'false' : 'true');
    fold.setAttribute('aria-label', '작업 큐 ' + word);
  }
  // The head row as the CRON lane's: the count, then a pill per state that has any (진행 · 대기), the summary on hover.
  var count = document.getElementById('wq-count');
  if (count) count.textContent = String(lanes.length);
  var pills = document.getElementById('wq-pills');
  if (pills) {
    var runN = 0, waitN = 0;
    lanes.forEach(function(q) { runN += q.running.length; waitN += Math.max(q.waiting.length, (_wqLast.byLane[q.id] || []).length); });
    people.forEach(function(q) { waitN += Math.max(q.waiting.length, (byOwner[q.id.replace(/^user:/, '')] || []).length); });
    pills.textContent = '';
    if (runN) pills.appendChild(wqEl('span', 'wq-pill is-run', '\u25CF 진행 ' + runN));
    if (waitN) pills.appendChild(wqEl('span', 'wq-pill is-wait', '\u25B2 대기 ' + waitN));
    if (_wqStale) pills.appendChild(wqEl('span', 'wq-pill is-stale', '새로 고치지 못함'));
  }
  var headRow = document.getElementById('wq-head');
  if (headRow) headRow.title = wqSummary(lanes, people);
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
    var idle = [];
    var groups = wqEl('div', 'wq-groups');
    lanes.forEach(function(q) {
      var cards = _wqLast.byLane[q.id] || [];
      if (wqLaneActive(q, cards)) groups.appendChild(wqLaneTile(q, cards, now));
      else idle.push(q);
    });
    if (groups.childNodes.length) lanesEl.appendChild(groups);
    if (!lanes.length) lanesEl.appendChild(wqEl('div', 'wq-empty', '레인 없음 — 작업이 줄을 서면 생깁니다'));
    else if (idle.length === lanes.length) lanesEl.appendChild(wqEl('div', 'wq-empty', '진행·대기 없음'));
    if (idle.length) lanesEl.appendChild(wqIdleLine(idle));
  }
  if (peopleEl) {
    peopleEl.textContent = '';
    if (!people.length) peopleEl.appendChild(wqEl('div', 'wq-empty', '진행·대기 중인 개인 작업 없음'));
    var pg = wqEl('div', 'wq-groups');
    people.forEach(function(q) { pg.appendChild(wqPersonTile(q, byOwner[q.id.replace(/^user:/, '')] || [], now)); });
    if (pg.childNodes.length) peopleEl.appendChild(pg);
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
// Folded or open as the CRON lane is (secOpen): the reader's choice per device, else open only on a large screen.
function wqFolded() {
  var saved = null;
  try { saved = localStorage.getItem('soma-sec-wq'); } catch (_e) {}
  if (saved === 'open') return false;
  if (saved === 'closed') return true;
  return !(typeof _secMql !== 'undefined' && _secMql && _secMql.matches);
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
