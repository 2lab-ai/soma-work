/**
 * 보낸 지시 (SSOT 2026-11-27) — the detail card's way back to any instruction: finding one meant scrolling 대화 a long
 * way past the answers. A round button at the composer's top left (the follow-up queue's round button keeps the top
 * right, SSOT_2) shows how many instructions people sent this session from its first message on. A press opens their list —
 * numbered from the first, a page at a time as it scrolls (처음부터 · 최근부터) — and a row moves 대화 to that
 * instruction: the chat tab and the main agent are shown, the turns back to it are loaded in one answer (the session
 * route's `through`), and the turn is scrolled to the top of the chat and lit for a moment.
 *
 * Server half: instruction-history.ts (`GET /api/dashboard/session/:conversationId/instructions`). The page calls
 * `ihSync(cid)` when the detail card opens or closes and when a person's turn lands, guarded by `typeof` so the page's
 * test harnesses that load its panel functions without this script keep working.
 *
 * Plain ES5 with no template syntax: it reaches the browser byte for byte (String.raw).
 */
export const INSTRUCTION_HISTORY_CLIENT_JS = String.raw`
// ── 보낸 지시 (instruction-history-client.ts) ──
var IH_PAGE = 30; // rows per page of the list
var IH_COUNT_DEBOUNCE_MS = 600; // a burst of turns asks for the count once
var IH_COUNT_RETRY_MS = [2000, 5000, 15000]; // a count that failed is asked again (a blip must not lose the button)
var IH_GROW_MAX = 100; // 최근부터: more new rows than one page holds read the list afresh
var IH_DEADLINE_MS = 20000; // a load that has not answered by then is given up (nothing is left loading)
var IH_TEXT_LABEL = '보낸 지시 {0}개 — 눌러서 목록 보기';
var IH_TEXT_NOT_FOUND = '그 지시를 대화에서 찾지 못했어요';
var IH_TEXT_LOAD_FAILED = '대화를 불러오지 못했어요';
var IH_TEXT_LIST_FAILED = '목록을 불러오지 못했어요';
var IH_TEXT_LOADING = '불러오는 중…';
var IH_TEXT_MORE = '더 보기';
var IH_TEXT_RETRY = '다시 시도';
var IH_TEXT_EMPTY = '보낸 지시가 없습니다';
var IH_TEXT_FILES = '파일 {0}개';
var IH_TEXT_SKILLS_ONLY = '(스킬만 호출)';
// cid: the open card's conversation · reqSeq: every count and list request's number, in the order they were asked ·
// total: its instructions, the newest the page knows (the button) · raisedSeq: the request whose answer last raised it
// (a count asked before that is older news and cannot lower it) · countAppliedSeq: the count request that set it (a
// list answer asked before that is older news and cannot raise it) · lastId: the newest
// instruction's id, as the freshest answer said · listLastId: the newest the open list has taken in · rows: the
// list's rows as loaded · based: the open list's first page has landed · listTotal: the total the open list has taken
// in (최근부터: newer instructions than that are fetched onto its top) · growing: that fetch is on its way · next: the
// next page's offset (null: all loaded) · gen: bumped on a new conversation, an order change and each reopening (an
// older answer is dropped) · reopenedFor: the total 처음부터 last asked one more page for (once per total: a count
// that is ahead of a rollback must not ask forever) · countSeq: the latest count asked for (an older count's answer is
// dropped) · jump: the instruction 대화 is moving to.
var _ih = { cid: '', jumps: 0, reqSeq: 0, total: 0, raisedSeq: 0, countAppliedSeq: 0, lastId: '', listLastId: '', rows: [], based: false, listTotal: 0, growing: false, reopenedFor: -1, next: 0, order: 'asc', loading: false, why: '', open: false, gen: 0, countSeq: 0, countTries: 0, timer: 0, jump: null };

// Pure: the number on the button — 999+ past three digits.
function ihCountText(n) {
  n = Number(n) || 0;
  return n > 999 ? '999+' : String(n);
}
// Pure: the HTML-safe text.
function ihEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Pure: when a row was sent — the time today, the date and time before.
function ihWhen(ms, now) {
  var t = Number(ms) || 0;
  if (!t) return '';
  var d = new Date(t);
  var n = new Date(now || Date.now());
  var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm;
  var md = (d.getMonth() + 1) + '/' + d.getDate();
  return (d.getFullYear() === n.getFullYear() ? md : d.getFullYear() + '/' + md) + ' ' + hm;
}
// Pure: the list's rows — #n, the words (the skills it invoked when it has no words), who · when · files · skills.
function ihRowsHtml(rows, now) {
  var out = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || !r.id) continue;
    var skills = Array.isArray(r.skills) ? r.skills : [];
    var text = r.text ? String(r.text) : skills.length ? IH_TEXT_SKILLS_ONLY : '';
    var meta = [];
    if (r.userName) meta.push(ihEsc(r.userName));
    var when = ihWhen(r.at, now);
    if (when) meta.push(ihEsc(when));
    if (r.files) meta.push(ihEsc(adminFmt(IH_TEXT_FILES, r.files)));
    for (var k = 0; k < skills.length && k < 3; k++) meta.push('<span class="ih-skill">$' + ihEsc(skills[k]) + '</span>');
    out += '<li><button type="button" class="ih-row" data-id="' + ihEsc(r.id) + '">'
      + '<span class="ih-n">#' + ihEsc(r.n) + '</span>'
      + '<span class="ih-body"><span class="ih-text">' + ihEsc(text) + '</span>'
      + (meta.length ? '<span class="ih-meta">' + meta.join(' · ') + '</span>' : '') + '</span></button></li>';
  }
  return out;
}
// Pure: rows of a page added to the list — an id already listed is not listed twice, and the list stays in its order by
// number (desc: newest first), wherever the page's rows belong.
function ihMerge(rows, page, order) {
  var seen = Object.create(null);
  for (var i = 0; i < rows.length; i++) seen[rows[i].id] = true;
  var fresh = (page || []).filter(function(r) { return r && r.id && !seen[r.id]; });
  var out = rows.concat(fresh);
  out.sort(function(a, b) { return order === 'desc' ? Number(b.n) - Number(a.n) : Number(a.n) - Number(b.n); });
  return out;
}
function ihUrl(cid, offset, limit, order) {
  return '/api/dashboard/session/' + encodeURIComponent(cid) + '/instructions?offset=' + offset + '&limit=' + limit + '&order=' + order;
}
// deadlineMs: give up (and abort) a request that has not answered by then.
function ihGetJson(url, deadlineMs) {
  var ctl = deadlineMs && typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctl ? setTimeout(function() { ctl.abort(); }, deadlineMs) : 0;
  return fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function(r) {
    if (!r || r.ok === false) throw new Error('HTTP ' + (r ? r.status : '?'));
    return r.json();
  }).finally(function() {
    if (timer) clearTimeout(timer);
  });
}
// Pure: a page row whose number the list already shows under another id — the record changed under the list (a
// rollback, and a new instruction in its place): the list must be read afresh.
function ihConflict(rows, items) {
  var byN = Object.create(null);
  for (var i = 0; i < rows.length; i++) byN[rows[i].n] = rows[i].id;
  for (var k = 0; k < (items || []).length; k++) {
    var it = items[k];
    if (it && byN[it.n] !== undefined && byN[it.n] !== it.id) return true;
  }
  return false;
}

// The open card changed (cid: its conversation, '' when none) — or, refresh, a person's turn landed in it.
function ihSync(cid, refresh) {
  cid = cid ? String(cid) : '';
  if (cid !== _ih.cid) {
    _ih.cid = cid;
    _ih.total = 0;
    _ih.raisedSeq = 0;
    _ih.countAppliedSeq = 0;
    _ih.lastId = '';
    _ih.rows = [];
    _ih.next = 0;
    _ih.why = '';
    _ih.loading = false;
    _ih.jump = null;
    _ih.countTries = 0;
    _ih.gen++;
    ihClose(false);
    ihPaint();
    if (cid) ihCountSoon(0);
    return;
  }
  if (cid && refresh) ihCountSoon(IH_COUNT_DEBOUNCE_MS);
}
function ihCountSoon(ms) {
  if (_ih.timer) clearTimeout(_ih.timer);
  _ih.timer = setTimeout(ihCount, ms);
}
// The count — the only answer that may lower the button's number (a list page only ever raises it: one answered against
// an older total must not take a newer count back).
function ihCount() {
  _ih.timer = 0;
  var cid = _ih.cid;
  if (!cid) return;
  var seq = ++_ih.countSeq;
  var rs = ++_ih.reqSeq;
  ihGetJson(ihUrl(cid, 0, 0, 'asc'), IH_DEADLINE_MS).then(function(d) {
    if (cid !== _ih.cid || seq !== _ih.countSeq) return;
    _ih.countTries = 0;
    var n = Math.max(0, Number(d && d.total) || 0);
    if (!(n < _ih.total && rs < _ih.raisedSeq)) {
      _ih.total = n;
      _ih.countAppliedSeq = rs;
      _ih.lastId = d && d.lastId ? String(d.lastId) : '';
    }
    ihPaint();
    ihReconcile();
  }).catch(function() {
    // A count that could not be had keeps the last one (none: no button) and is asked again a few times.
    if (cid !== _ih.cid || seq !== _ih.countSeq || _ih.countTries >= IH_COUNT_RETRY_MS.length) return;
    ihCountSoon(IH_COUNT_RETRY_MS[_ih.countTries++]);
  });
}
// What a list answer reported (d: its total and newest id; rs: its request's number): it only ever raises the
// button's number, and only when it was asked after the count that set it.
function ihSeen(d, rs) {
  var total = d && typeof d.total === 'number' ? d.total : 0;
  if (rs > _ih.countAppliedSeq) {
    if (total > _ih.total) {
      _ih.total = total;
      _ih.raisedSeq = rs;
      ihPaint();
    }
    if (total >= _ih.total && d && d.lastId) _ih.lastId = String(d.lastId);
  }
  ihReconcile();
}
// After every answer that tells a total (the count, a page, the new top rows), the open list catches up with the
// newest total the page knows — whichever answer brought it, and whatever order they came in:
//   fewer than the list was built on (a rollback took one back) → the list is read afresh;
//   처음부터 → a page is due again while fewer rows are listed than there are (a late last page cannot close it);
//   최근부터 → the rows newer than the list's base come on top, once (one fetch at a time; a failure gives them back).
function ihReconcile() {
  if (!_ih.open || !_ih.based) return;
  // Fewer than the list was built on (a rollback took one back), or as many with another newest one (a rollback and a
  // new instruction in its place): the list is read afresh.
  var replaced = _ih.total === _ih.listTotal && !!_ih.lastId && !!_ih.listLastId && _ih.lastId !== _ih.listLastId;
  if (_ih.total < _ih.listTotal || replaced) {
    ihReload();
    return;
  }
  if (_ih.order === 'asc') {
    if (_ih.total > _ih.listTotal) _ih.listLastId = _ih.lastId;
    _ih.listTotal = _ih.total;
    if (_ih.next === null && _ih.rows.length < _ih.total && _ih.reopenedFor !== _ih.total) {
      _ih.reopenedFor = _ih.total;
      // A few rows back: the page overlaps what is listed, so a row replaced under the list is seen (ihConflict).
      _ih.next = Math.max(0, _ih.rows.length - 5);
      ihPaintList();
      ihMaybeMore();
    }
    return;
  }
  if (_ih.growing || _ih.total <= _ih.listTotal) return;
  var prev = _ih.listTotal;
  if (_ih.total - prev + 5 > IH_GROW_MAX) {
    ihReload();
    return;
  }
  var prevLastId = _ih.listLastId;
  _ih.listTotal = _ih.total;
  _ih.listLastId = _ih.lastId;
  ihGrow(_ih.total - prev, prev, prevLastId);
}
// 최근부터: the newest rows (a few more than came, so one that lands meanwhile is not skipped) go on top, each once.
// Later pages start where they would have: a row the shift brings up again is listed once. More than the margin landing
// while it was on its way could leave a gap under the fetched rows: the list is read afresh then. A fetch that fails
// gives the news back (listTotal: prev) and asks for the count again, so the rows come with the next answer.
function ihGrow(by, prev, prevLastId) {
  var cid = _ih.cid;
  var gen = _ih.gen;
  var target = _ih.listTotal;
  var rs = ++_ih.reqSeq;
  _ih.growing = true;
  ihGetJson(ihUrl(cid, 0, by + 5, 'desc'), IH_DEADLINE_MS).then(function(d) {
    if (gen !== _ih.gen) return;
    _ih.growing = false;
    // More landed than the margin (a gap could open under the fetched rows), or a row changed under the list.
    if ((d && typeof d.total === 'number' && d.total > target + 5) || ihConflict(_ih.rows, d && d.items)) {
      ihReload();
      return;
    }
    var list = document.getElementById('ih-list');
    var h = list ? list.scrollHeight : 0;
    _ih.rows = ihMerge(_ih.rows, (d && d.items) || [], 'desc');
    ihPaintList();
    // The reader keeps the rows they were on (none moves under them unless they were at the very top).
    if (list && list.scrollTop > 0) list.scrollTop += list.scrollHeight - h;
    ihSeen(d, rs);
  }).catch(function() {
    if (gen !== _ih.gen) return;
    _ih.growing = false;
    if (_ih.listTotal > prev) {
      _ih.listTotal = prev;
      _ih.listLastId = prevLastId;
    }
    ihCountSoon(IH_COUNT_RETRY_MS[0]);
  });
}

// The button: shown while the open card has an instruction (the composer's top left; the queue keeps the top right).
function ihPaint() {
  var dock = document.getElementById('ih-dock');
  if (!dock) return;
  var show = !!_ih.cid && _ih.total > 0;
  if (dock.hidden === show) dock.hidden = !show;
  var num = document.getElementById('ih-dock-n');
  var txt = ihCountText(_ih.total);
  if (num && num.textContent !== txt) num.textContent = txt;
  var label = adminFmt(IH_TEXT_LABEL, _ih.total);
  if (dock.getAttribute('aria-label') !== label) {
    dock.setAttribute('aria-label', label);
    dock.setAttribute('title', label);
  }
  dock.setAttribute('aria-expanded', _ih.open ? 'true' : 'false');
  var cnt = document.getElementById('ih-count');
  if (cnt && cnt.textContent !== txt) cnt.textContent = txt;
  if (!show && _ih.open) ihClose(false);
}
// The list's rows and its foot: 불러오는 중… · 더 보기 · why it failed with 다시 시도 · none.
function ihPaintList() {
  var list = document.getElementById('ih-list');
  var foot = document.getElementById('ih-foot');
  if (!list || !foot) return;
  var html = ihRowsHtml(_ih.rows, Date.now());
  if (list._ihHtml !== html) {
    // A row with keyboard focus keeps it across the repaint (a page appended while the reader steps through rows).
    var active = document.activeElement;
    var focusId = active && active.classList && active.classList.contains('ih-row') && list.contains(active) ? active.getAttribute('data-id') : null;
    list.innerHTML = html;
    list._ihHtml = html;
    if (focusId) {
      var rows = list.querySelectorAll('.ih-row');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-id') === focusId) {
          rows[i].focus({ preventScroll: true });
          break;
        }
      }
    }
  }
  var f = '';
  if (_ih.loading) f = '<span class="ih-note">' + ihEsc(IH_TEXT_LOADING) + '</span>';
  else if (_ih.why) f = '<span class="ih-note is-err">' + ihEsc(IH_TEXT_LIST_FAILED) + ' · ' + ihEsc(_ih.why) + '</span><button type="button" class="ui-btn is-sm ih-more" data-ih="retry">' + ihEsc(IH_TEXT_RETRY) + '</button>';
  else if (_ih.next !== null) f = '<button type="button" class="ui-btn is-sm ih-more" data-ih="more">' + ihEsc(IH_TEXT_MORE) + '</button>';
  else if (!_ih.rows.length) f = '<span class="ih-note">' + ihEsc(IH_TEXT_EMPTY) + '</span>';
  if (foot._ihHtml !== f) {
    foot.innerHTML = f;
    foot._ihHtml = f;
  }
  var segs = document.querySelectorAll('#ih-pop .ih-ord');
  for (var i = 0; i < segs.length; i++) segs[i].setAttribute('aria-pressed', segs[i].getAttribute('data-order') === _ih.order ? 'true' : 'false');
}

function ihToggle() {
  if (_ih.open) ihClose(true);
  else ihOpen();
}
// Opens on the first page of the order chosen (each opening reads the list afresh).
function ihOpen() {
  var pop = document.getElementById('ih-pop');
  if (!pop || !_ih.cid) return;
  _ih.open = true;
  pop.setAttribute('data-open', '');
  ihPaint();
  ihReload();
  ihCountSoon(0); // the count read afresh too: the list reconciles with it
  pop.focus({ preventScroll: true });
}
function ihClose(focusDock) {
  var pop = document.getElementById('ih-pop');
  var was = _ih.open;
  _ih.open = false;
  if (pop) pop.removeAttribute('data-open');
  var dock = document.getElementById('ih-dock');
  if (dock) dock.setAttribute('aria-expanded', 'false');
  if (was && focusDock && dock && !dock.hidden) dock.focus({ preventScroll: true });
}
function ihSetOrder(order) {
  order = order === 'desc' ? 'desc' : 'asc';
  if (order === _ih.order) return;
  _ih.order = order;
  try { localStorage.setItem('soma-ih-order', order); } catch (_e) {}
  ihReload();
}
function ihReload() {
  _ih.gen++;
  _ih.rows = [];
  _ih.based = false;
  _ih.listTotal = 0;
  _ih.listLastId = '';
  _ih.growing = false;
  _ih.reopenedFor = -1;
  _ih.next = 0;
  _ih.why = '';
  _ih.loading = false;
  var list = document.getElementById('ih-list');
  if (list) list.scrollTop = 0;
  ihLoadMore();
}
// The next page — the list asks as its end nears (and 더 보기, the keyboard's way).
function ihLoadMore() {
  if (_ih.loading || _ih.next === null || !_ih.cid) return;
  var cid = _ih.cid;
  var gen = _ih.gen;
  var offset = _ih.next;
  var rs = ++_ih.reqSeq;
  _ih.loading = true;
  _ih.why = '';
  ihPaintList();
  // A later page starts one row back: the row at the boundary is seen again, so one replaced under the list is caught.
  var from = offset > 0 ? offset - 1 : 0;
  ihGetJson(ihUrl(cid, from, offset > 0 ? IH_PAGE + 1 : IH_PAGE, _ih.order), IH_DEADLINE_MS).then(function(d) {
    if (gen !== _ih.gen) return;
    _ih.loading = false;
    if (ihConflict(_ih.rows, d && d.items)) {
      ihReload();
      return;
    }
    _ih.rows = ihMerge(_ih.rows, (d && d.items) || [], _ih.order);
    _ih.next = d && typeof d.nextOffset === 'number' ? d.nextOffset : null;
    var total = d && typeof d.total === 'number' ? d.total : 0;
    // The first page is what the list starts from (a newer count that came while it loaded is caught up below).
    if (offset === 0) {
      _ih.based = true;
      _ih.listTotal = total;
      _ih.listLastId = d && d.lastId ? String(d.lastId) : '';
    }
    ihPaintList();
    ihSeen(d, rs);
    ihMaybeMore();
  }).catch(function(err) {
    if (gen !== _ih.gen) return;
    _ih.loading = false;
    _ih.why = String((err && err.message) || '네트워크 오류');
    ihPaintList();
  });
}
// A list whose end is in view (it does not fill its box yet, or it was scrolled down) asks for the next page.
function ihMaybeMore() {
  var list = document.getElementById('ih-list');
  if (!list || !_ih.open || _ih.next === null || _ih.loading) return;
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 80) ihLoadMore();
}

// A row: 대화 moves to its instruction.
function ihJump(id) {
  ihClose(false);
  if (!id || !panelSessionKey) return;
  _ih.jump = { id: String(id), seq: ++_ih.jumps, gen: _panelGen, waits: 0, asks: 0, done: false, failed: false, fresh: false, freshNext: false };
  if (_panelAgent) selectPanelAgent('');
  if (_psec !== 'conv') selectPanelSection('conv');
  ihReveal();
}
function ihHasTurn(id) {
  return _panelTurnsList.some(function(t) { return t && String(t.id) === id; });
}
// A turn's time (epoch ms; the record keeps a number, a pushed turn may carry an ISO string).
function ihTurnAt(t) {
  var v = t && t.timestamp;
  var n = typeof v === 'number' ? v : Date.parse(String(v || ''));
  return isFinite(n) ? n : 0;
}
// The turn is in the chat's data: there it goes. Else the turns back to it come first (one answer, the route's
// through; a very long way back takes a few — the route says 'capped' while the target is still further) — after a
// load already on its way (the first page, an older page) settles. The route says when the target is not behind the
// turns held ('none'): the chat's copy may be behind the record (a missed push) — one ask for the latest window back to
// it takes the chat's place (contiguous; older pages come back on scroll-up); after that, 'none' is the last word.
function ihReveal() {
  var j = _ih.jump;
  if (!j || j.gen !== _panelGen) return;
  if (j.timer) {
    clearTimeout(j.timer);
    j.timer = 0;
  }
  if (ihHasTurn(j.id)) {
    _ih.jump = null;
    convPaint();
    ihScrollTo(j.id, 0, j);
    return;
  }
  if (_panelTurnsLoading) {
    if (++j.waits > 150) return ihMiss(IH_TEXT_LOAD_FAILED, j);
    // This jump's own wait: a newer jump keeps its own budget (an older timer does not spend it).
    j.timer = setTimeout(function() {
      j.timer = 0;
      if (_ih.jump === j) ihReveal();
    }, 100);
    return;
  }
  var cid = panelConvId;
  if (!cid || j.done || j.asks >= 50) return ihMiss(IH_TEXT_NOT_FOUND, j);
  j.asks++;
  var fresh = !!j.freshNext;
  j.freshNext = false;
  if (fresh) j.fresh = true;
  var oldest = fresh ? null : _panelTurnsOldestId;
  var url = '/api/dashboard/session/' + encodeURIComponent(cid) + '?limit=' + PANEL_TURNS_PAGE
    + (oldest ? '&before=' + encodeURIComponent(oldest) : '') + '&through=' + encodeURIComponent(j.id);
  _panelTurnsLoading = true;
  // No page yet (the first one failed): the chat says it is loading — no 다시 시도 to race this answer.
  if (!oldest) {
    _panelTurnsMsg = 'loading';
    _panelTurnsWhy = '';
  }
  convPaint(); // 이전 대화 불러오는 중…
  ihGetJson(url, IH_DEADLINE_MS).then(function(data) {
    if (j.gen !== _panelGen) return;
    var turns = (data && data.turns) || [];
    if (j.seq !== _ih.jumps) {
      // A newer jump took over: older turns before the oldest are still the chat's (they go in), a fresh window is not.
      if (oldest && turns.length) {
        _panelTurnsOldestId = turns[0].id;
        _panelTurnsList = turns.concat(_panelTurnsList);
        _panelTurnsHasMore = !!(data && data.hasMore);
      } else if (!oldest) _panelTurnsMsg = _panelTurnsList.length ? '' : 'failed';
      j.done = true;
      return;
    }
    if (oldest) {
      if (turns.length) {
        _panelTurnsOldestId = turns[0].id;
        _panelTurnsList = turns.concat(_panelTurnsList);
      }
    } else {
      // No page yet (the first one failed or was empty), or the chat's copy is behind: this answer is the chat's first
      // page, reaching back to it. From the old copy stay this browser's pending instructions and every turn newer
      // than the answer's last one (pushed while it was on its way); the older ones come back on scroll-up.
      var lastAt = turns.length ? ihTurnAt(turns[turns.length - 1]) : 0;
      _panelTurnsList = ptMergeFetched(turns, fresh ? _panelTurnsList.filter(function(t) { return t && (t._optimistic || ihTurnAt(t) >= lastAt); }) : _panelTurnsList);
      _panelTurnsCid = (data && data.id) || cid;
      _panelTurnsOldestId = turns.length ? turns[0].id : null;
      _panelTurnsMsg = _panelTurnsList.length ? '' : 'none';
      _panelTurnsWhy = '';
    }
    _panelTurnsHasMore = turns.length > 0 && !!(data && data.hasMore);
    _panelOlderWhy = '';
    var state = data && data.through;
    if (state === 'capped' && _panelTurnsHasMore) return; // further back: ask again
    if (state === 'none' && !j.fresh && !ihHasTurn(j.id)) j.freshNext = true;
    else j.done = true;
  }).catch(function(err) {
    if (j.gen !== _panelGen) return;
    var why = String((err && err.message) || '네트워크 오류');
    if (oldest) _panelOlderWhy = why;
    else {
      _panelTurnsMsg = _panelTurnsList.length ? '' : 'failed';
      _panelTurnsWhy = why;
    }
    j.failed = true;
  }).then(function() {
    if (j.gen !== _panelGen) return;
    _panelTurnsLoading = false;
    convPaint(); // the loading line goes, whatever comes next
    if (j.failed) return ihMiss(IH_TEXT_LOAD_FAILED, j);
    ihReveal();
  });
}
// A jump that ends without its turn says so — unless a newer jump has started since (its own outcome speaks).
function ihMiss(text, j) {
  if (j && j.seq !== _ih.jumps) return;
  _ih.jump = null;
  if (typeof dashToast === 'function') dashToast({ title: text, tone: 'warning' });
}
// The element draws the turn on its next frames: its row goes to the top of the chat's box and is lit for a moment.
// Answers that load above it later keep it in place (the scroller holds the reader's row); one late look puts it
// back if the box moved anyway.
function ihScrollTo(id, tries, j) {
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      // Another card, or a newer jump: this one stops here, silently.
      if (j && (j.gen !== _panelGen || j.seq !== _ih.jumps)) return;
      var el = convEl();
      var node = el && typeof el.turnElement === 'function' ? el.turnElement(id) : null;
      if (!node) {
        if (tries < 30) ihScrollTo(id, tries + 1, j);
        else ihMiss(IH_TEXT_NOT_FOUND, j);
        return;
      }
      ihAlign(el, node);
      ihFlash(node);
      setTimeout(function() {
        if (j && (j.gen !== _panelGen || j.seq !== _ih.jumps)) return;
        var again = el.turnElement(id);
        if (again) ihAlign(el, again, 48);
      }, 400);
    });
  });
}
// The node's top at the top of the chat's box (12px under it); slack: leave it where it is when it is that close.
function ihAlign(el, node, slack) {
  var vp = typeof convViewport === 'function' ? convViewport(el) : null;
  if (!vp) {
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' });
    return;
  }
  var off = node.getBoundingClientRect().top - vp.getBoundingClientRect().top - 12;
  if (slack && Math.abs(off) <= slack) return;
  vp.scrollTop = Math.max(0, vp.scrollTop + off);
}
function ihFlash(node) {
  if (typeof node.animate !== 'function') return;
  node.animate([
    { boxShadow: '0 0 0 2px var(--accent)', backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
    { boxShadow: '0 0 0 2px transparent', backgroundColor: 'transparent' },
  ], { duration: 1800, easing: 'ease-out' });
}

(function ihWire() {
  try {
    var saved = localStorage.getItem('soma-ih-order');
    if (saved === 'asc' || saved === 'desc') _ih.order = saved;
  } catch (_e) {}
  var pop = document.getElementById('ih-pop');
  var list = document.getElementById('ih-list');
  var foot = document.getElementById('ih-foot');
  if (!pop || !list || !foot) return;
  list.addEventListener('click', function(e) {
    var row = e.target && e.target.closest ? e.target.closest('.ih-row') : null;
    if (row) ihJump(row.getAttribute('data-id'));
  });
  list.addEventListener('scroll', ihMaybeMore, { passive: true });
  foot.addEventListener('click', function(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ih]') : null;
    if (!b) return;
    if (b.getAttribute('data-ih') === 'retry') _ih.why = '';
    ihLoadMore();
  });
  // Esc closes it (and only it: the card stays open); a press outside it and its button closes it.
  pop.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape' || !_ih.open) return;
    e.preventDefault();
    e.stopPropagation();
    ihClose(true);
  });
  document.addEventListener('pointerdown', function(e) {
    if (!_ih.open) return;
    var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    var dock = document.getElementById('ih-dock');
    if (path.indexOf(pop) >= 0 || (dock && path.indexOf(dock) >= 0)) return;
    ihClose(false);
  }, true);
})();
`;

/** The button, the list and their place: the composer's top left (the follow-up queue's round button is at its right). */
export const INSTRUCTION_HISTORY_CSS = String.raw`
/* ── 보낸 지시 (SSOT 2026-11-27, instruction-history-client.ts) — the queue's round button's look, at the composer's
   top left (SSOT_2: 지시 큐는 입력창 오른쪽 위, 내 지시 리스트는 입력창 왼쪽 위). Placed in the command area (its
   padding is 10px 16px): on the composer's left edge (16px) and, with nothing above the composer, at the queue's
   height — its bottom 8px above the composer's top, the command area's top + 2px. A plan or next-steps bar above the
   composer stays clear: the button sits above the whole area, never over the bar's buttons. ── */
.ih-dock { position: absolute; z-index: 3; left: 16px; bottom: calc(100% - 2px); display: grid; place-items: center;
  box-sizing: border-box; min-width: 32px; height: 32px; padding: 0 8px; border: 0; border-radius: 999px;
  background: var(--surface); color: var(--text);
  box-shadow: 0 0 0 1px var(--border), var(--ib-shadow, 0 2px 8px color-mix(in srgb, var(--text) 10%, transparent));
  font: inherit; font-size: 13px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: 0;
  cursor: pointer; transition: background-color var(--dur-press, 120ms) ease, color var(--dur-press, 120ms) ease,
    box-shadow var(--dur-press, 120ms) ease, transform var(--dur-press, 120ms) ease; }
.ih-dock[hidden] { display: none; }
.ih-dock[aria-expanded="true"] { background: var(--text); color: var(--surface); box-shadow: 0 0 0 1px var(--text); }
.ih-dock:focus-visible { outline: 2px solid var(--border-focus, var(--accent)); outline-offset: 2px; }
.ih-dock:active { transform: scale(0.94); }
@media (hover: hover) {
  .ih-dock[aria-expanded="false"]:hover { background: color-mix(in srgb, var(--text) 6%, var(--surface)); }
}
@media (pointer: coarse) {
  .ih-dock { min-width: 44px; height: 44px; font-size: 15px; }
}
/* The list: a raised card above the button, its left edge on the button's. */
.ih-pop { position: absolute; z-index: 20; left: 16px; bottom: calc(100% + 38px); box-sizing: border-box;
  display: flex; flex-direction: column; width: min(400px, calc(100% - 32px)); max-height: min(520px, 62vh);
  border-radius: 12px; background: var(--surface); color: var(--text); outline: none;
  box-shadow: 0 0 0 1px var(--border), var(--ib-shadow-raised, 0 14px 30px color-mix(in srgb, var(--text) 14%, transparent));
  transform-origin: bottom left; opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(4px) scale(0.97);
  transition: opacity 140ms ease, transform 180ms cubic-bezier(0.32, 0.72, 0.24, 1), visibility 0s linear 180ms; }
.ih-pop[data-open] { opacity: 1; visibility: visible; pointer-events: auto; transform: none;
  transition: opacity 160ms ease, transform 240ms cubic-bezier(0.32, 0.72, 0.24, 1), visibility 0s; }
@media (pointer: coarse) { .ih-pop { bottom: calc(100% + 50px); } }
@media (max-width: 639px) { .ih-pop { right: 16px; width: auto; max-height: min(520px, 58vh); } }
@media (prefers-reduced-motion: reduce) { .ih-pop, .ih-pop[data-open] { transition: opacity 120ms ease, visibility 0s; transform: none; } }
.ih-head { display: flex; flex: none; align-items: center; gap: 8px; padding: 8px 6px 6px 14px; border-bottom: 1px solid var(--border); }
.ih-title { font-size: 12px; font-weight: 650; color: var(--text); white-space: nowrap; }
.ih-count { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: var(--ib-pill, color-mix(in srgb, var(--text) 8%, transparent)); color: var(--text-secondary);
  font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ih-order { display: inline-flex; margin-left: auto; padding: 2px; border-radius: 8px; background: var(--ib-pill, color-mix(in srgb, var(--text) 6%, transparent)); }
.ih-ord { appearance: none; border: 0; margin: 0; padding: 0 8px; height: 24px; border-radius: 6px; background: none;
  color: var(--text-secondary); font: inherit; font-size: 11.5px; cursor: pointer; white-space: nowrap; }
.ih-ord[aria-pressed="true"] { background: var(--surface); color: var(--text); font-weight: 600;
  box-shadow: 0 0 0 1px var(--border); }
.ih-ord:focus-visible, .ih-row:focus-visible { outline: 2px solid var(--border-focus, var(--accent)); outline-offset: -2px; }
.ih-list { flex: 1 1 auto; min-height: 0; margin: 0; padding: 4px 6px; list-style: none; overflow-y: auto; overscroll-behavior: contain; }
.ih-row { appearance: none; display: flex; align-items: flex-start; gap: 10px; width: 100%; margin: 0; padding: 8px;
  border: 0; border-radius: 8px; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
@media (hover: hover) { .ih-row:hover { background: color-mix(in srgb, var(--text) 6%, transparent); } }
.ih-row:active { background: color-mix(in srgb, var(--text) 10%, transparent); }
.ih-n { flex: none; min-width: 30px; padding-top: 1px; color: var(--text-tertiary, var(--text-secondary)); font-size: 11.5px;
  font-weight: 600; font-variant-numeric: tabular-nums; }
.ih-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ih-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
.ih-meta { color: var(--text-secondary); font-size: 11px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ih-skill { color: var(--accent); }
.ih-foot { display: flex; flex: none; align-items: center; justify-content: center; gap: 8px; min-height: 0; padding: 0 10px; }
.ih-foot:not(:empty) { padding: 6px 10px 10px; }
.ih-note { color: var(--text-secondary); font-size: 12px; }
.ih-note.is-err { color: var(--danger, #d4380d); }
@media (pointer: coarse) { .ih-row { min-height: 44px; } .ih-ord { height: 32px; } }
`;
