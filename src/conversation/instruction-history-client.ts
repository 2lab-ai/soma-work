/**
 * 보낸 지시 (SSOT 2026-11-27) — the detail card's way back to any instruction: finding one meant scrolling 대화 a long
 * way past the answers. A round button at the composer's top right (the follow-up queue's round button moves left of
 * it) shows how many instructions people sent this session from its first message on. A press opens their list —
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
// cid: the open card's conversation · total: its instructions · rows: the list's rows as loaded · next: the next
// page's offset (null: all loaded) · gen: bumped on a new conversation, an order change and each reopening (an older
// answer is dropped) · jump: the instruction 대화 is moving to.
var _ih = { cid: '', total: 0, rows: [], next: 0, order: 'asc', loading: false, why: '', open: false, gen: 0, timer: 0, jump: null };

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
// Pure: rows of a page added to the list — an id already listed is not listed twice.
function ihMerge(rows, page, atTop) {
  var seen = Object.create(null);
  for (var i = 0; i < rows.length; i++) seen[rows[i].id] = true;
  var fresh = (page || []).filter(function(r) { return r && r.id && !seen[r.id]; });
  return atTop ? fresh.concat(rows) : rows.concat(fresh);
}
function ihUrl(cid, offset, limit, order) {
  return '/api/dashboard/session/' + encodeURIComponent(cid) + '/instructions?offset=' + offset + '&limit=' + limit + '&order=' + order;
}
function ihGetJson(url) {
  return fetch(url).then(function(r) {
    if (!r || r.ok === false) throw new Error('HTTP ' + (r ? r.status : '?'));
    return r.json();
  });
}

// The open card changed (cid: its conversation, '' when none) — or, refresh, a person's turn landed in it.
function ihSync(cid, refresh) {
  cid = cid ? String(cid) : '';
  if (cid !== _ih.cid) {
    _ih.cid = cid;
    _ih.total = 0;
    _ih.rows = [];
    _ih.next = 0;
    _ih.why = '';
    _ih.loading = false;
    _ih.jump = null;
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
function ihCount() {
  _ih.timer = 0;
  var cid = _ih.cid;
  if (!cid) return;
  ihGetJson(ihUrl(cid, 0, 0, 'asc')).then(function(d) {
    if (cid !== _ih.cid) return;
    var before = _ih.total;
    _ih.total = Math.max(0, Number(d && d.total) || 0);
    ihPaint();
    if (_ih.open && _ih.total > before) ihGrow(_ih.total - before);
  }).catch(function() {}); // a count that could not be had keeps the last one (none: no button)
}
// The list is open and new instructions came: 처음부터 — the rows past the last one loaded are a page away again;
// 최근부터 — they go on top (each later page starts that many rows further down).
function ihGrow(by) {
  if (_ih.order === 'asc') {
    if (_ih.next === null) _ih.next = _ih.rows.length;
    ihPaintList();
    ihMaybeMore();
    return;
  }
  var cid = _ih.cid;
  var gen = _ih.gen;
  if (_ih.next !== null) _ih.next += by;
  ihGetJson(ihUrl(cid, 0, Math.min(by, 100), 'desc')).then(function(d) {
    if (gen !== _ih.gen) return;
    var list = document.getElementById('ih-list');
    var h = list ? list.scrollHeight : 0;
    _ih.rows = ihMerge(_ih.rows, (d && d.items) || [], true);
    ihPaintList();
    // The reader keeps the rows they were on (none moves under them unless they were at the very top).
    if (list && list.scrollTop > 0) list.scrollTop += list.scrollHeight - h;
  }).catch(function() {});
}

// The button: shown while the open card has an instruction; the queue's round button moves left of it.
function ihPaint() {
  var dock = document.getElementById('ih-dock');
  if (!dock) return;
  var show = !!_ih.cid && _ih.total > 0;
  if (dock.hidden === show) dock.hidden = !show;
  var wrap = dock.parentNode;
  if (wrap && typeof wrap.toggleAttribute === 'function') wrap.toggleAttribute('data-ih', show);
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
    list.innerHTML = html;
    list._ihHtml = html;
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
  _ih.loading = true;
  _ih.why = '';
  ihPaintList();
  ihGetJson(ihUrl(cid, offset, IH_PAGE, _ih.order)).then(function(d) {
    if (gen !== _ih.gen) return;
    _ih.loading = false;
    _ih.rows = ihMerge(_ih.rows, (d && d.items) || [], false);
    _ih.next = d && typeof d.nextOffset === 'number' ? d.nextOffset : null;
    if (d && typeof d.total === 'number' && d.total !== _ih.total) {
      _ih.total = d.total;
      ihPaint();
    }
    ihPaintList();
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
  _ih.jump = { id: String(id), gen: _panelGen, waits: 0, asks: 0 };
  if (_panelAgent) selectPanelAgent('');
  if (_psec !== 'conv') selectPanelSection('conv');
  ihReveal();
}
function ihHasTurn(id) {
  for (var i = 0; i < _panelTurnsList.length; i++) if (_panelTurnsList[i] && String(_panelTurnsList[i].id) === id) return true;
  return false;
}
// The turn is in the chat's data: there it goes. Else the turns back to it come first (one answer, the route's
// through) — after a load already on its way (the first page, an older page) settles.
function ihReveal() {
  var j = _ih.jump;
  if (!j || j.gen !== _panelGen) return;
  if (ihHasTurn(j.id)) {
    _ih.jump = null;
    convPaint();
    ihScrollTo(j.id, 0);
    return;
  }
  if (_panelTurnsLoading) {
    if (++j.waits > 150) return ihMiss(IH_TEXT_LOAD_FAILED);
    setTimeout(ihReveal, 100);
    return;
  }
  var cid = panelConvId;
  if (!cid || j.asks >= 3 || (j.asks > 0 && !_panelTurnsHasMore)) return ihMiss(IH_TEXT_NOT_FOUND);
  j.asks++;
  var oldest = _panelTurnsOldestId;
  var url = '/api/dashboard/session/' + encodeURIComponent(cid) + '?limit=' + PANEL_TURNS_PAGE
    + (oldest ? '&before=' + encodeURIComponent(oldest) : '') + '&through=' + encodeURIComponent(j.id);
  _panelTurnsLoading = true;
  convPaint(); // 이전 대화 불러오는 중…
  ihGetJson(url).then(function(data) {
    if (j.gen !== _panelGen) return;
    var turns = (data && data.turns) || [];
    if (oldest) {
      if (turns.length) {
        _panelTurnsOldestId = turns[0].id;
        _panelTurnsList = turns.concat(_panelTurnsList);
      }
    } else {
      // No page yet (the first one failed or was empty): this answer is the chat's first page, reaching back to it.
      _panelTurnsList = ptMergeFetched(turns, _panelTurnsList);
      _panelTurnsCid = (data && data.id) || cid;
      _panelTurnsOldestId = turns.length ? turns[0].id : null;
      _panelTurnsMsg = _panelTurnsList.length ? '' : 'none';
      _panelTurnsWhy = '';
    }
    _panelTurnsHasMore = turns.length > 0 && !!(data && data.hasMore);
    _panelOlderWhy = '';
  }).catch(function(err) {
    if (j.gen !== _panelGen) return;
    _panelOlderWhy = String((err && err.message) || '네트워크 오류');
    j.asks = 99;
  }).then(function() {
    if (j.gen !== _panelGen) return;
    _panelTurnsLoading = false;
    if (j.asks >= 99) {
      convPaint();
      return ihMiss(IH_TEXT_LOAD_FAILED);
    }
    ihReveal();
  });
}
function ihMiss(text) {
  _ih.jump = null;
  if (typeof dashToast === 'function') dashToast({ title: text, tone: 'warning' });
}
// The element draws the turn on its next frames: its row goes to the top of the chat's box and is lit for a moment.
// Answers that load above it later keep it in place (the scroller holds the reader's row); one late look puts it
// back if the box moved anyway.
function ihScrollTo(id, tries) {
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      var el = convEl();
      var node = el && typeof el.turnElement === 'function' ? el.turnElement(id) : null;
      if (!node) {
        if (tries < 30) ihScrollTo(id, tries + 1);
        else ihMiss(IH_TEXT_NOT_FOUND);
        return;
      }
      ihAlign(el, node);
      ihFlash(node);
      setTimeout(function() {
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

/** The button, the list and their place beside the follow-up queue's round button. */
export const INSTRUCTION_HISTORY_CSS = String.raw`
/* ── 보낸 지시 (SSOT 2026-11-27, instruction-history-client.ts) — the queue's round button's look and place: 8px
   above the composer at its right. With it there, the queue's button sits left of it (the element's own offset). ── */
.pc-steer-wrap { position: relative; }
.pc-steer-wrap[data-ih] > ui-agent-steering { --ui-steering-dock-right: 40px; }
.ih-dock { position: absolute; z-index: 3; right: 0; bottom: calc(100% + 8px); display: grid; place-items: center;
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
  .pc-steer-wrap[data-ih] > ui-agent-steering { --ui-steering-dock-right: 52px; }
  .ih-dock { min-width: 44px; height: 44px; font-size: 15px; }
}
/* The list: a raised card above the button, its right edge on the button's. */
.ih-pop { position: absolute; z-index: 20; right: 0; bottom: calc(100% + 48px); box-sizing: border-box;
  display: flex; flex-direction: column; width: min(400px, calc(100vw - 24px)); max-height: min(520px, 62vh);
  border-radius: 12px; background: var(--surface); color: var(--text); outline: none;
  box-shadow: 0 0 0 1px var(--border), var(--ib-shadow-raised, 0 14px 30px color-mix(in srgb, var(--text) 14%, transparent));
  transform-origin: bottom right; opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(4px) scale(0.97);
  transition: opacity 140ms ease, transform 180ms cubic-bezier(0.32, 0.72, 0.24, 1), visibility 0s linear 180ms; }
.ih-pop[data-open] { opacity: 1; visibility: visible; pointer-events: auto; transform: none;
  transition: opacity 160ms ease, transform 240ms cubic-bezier(0.32, 0.72, 0.24, 1), visibility 0s; }
@media (pointer: coarse) { .ih-pop { bottom: calc(100% + 60px); } }
@media (max-width: 639px) { .ih-pop { left: 0; width: auto; max-height: min(520px, 58vh); } }
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
