/**
 * 변경점 tab (.prd/26 §4, #1296) — the detail card's view of what the session did to code, and the full-screen file viewer.
 *
 *   tab     summary line · scope chips (전체 · 커밋 안 함 · 커밋함 · PR · 머지됨) · the session's PRs (a row = that PR as the
 *           scope) · repo → directory → file tree (single-child directory chains folded, every row with its +/−)
 *   viewer  a modal <dialog> over the whole page: the same tree on the left (the shown file marked), the file's layers on
 *           the right — each a block of hunks with old and new line numbers, like a GitHub PR
 *
 * Data: GET /api/dashboard/session/:cid/changes (list, no patches) and …/changes/file?repo=&path= (one file's layers).
 * Every string from the server is escaped here (chgEsc). The pure functions (chgFilesOf, chgTree, chgCounts,
 * chgHunkRows, chgSummaryText) take no DOM and are what the tests load.
 *
 * Client script: String.raw, no template substitutions and no backticks (ships byte for byte). Korean strings have
 * en-page.json entries (#771).
 */

export const CODE_CHANGES_JS = String.raw`
// ── 변경점 (.prd/26 §4) ──
var CHG_LAYERS = ['uncommitted', 'committed', 'pr', 'merged'];
var CHG_LAYER_LABEL = { uncommitted: '커밋 안 함', committed: '커밋함', pr: 'PR', merged: '머지됨', closed: '닫힘' };
var CHG_PR_STATE = { open: '열림', draft: '초안', merged: '머지됨', closed: '닫힘' };
var CHG_STATUS_MARK = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
var CHG_STATUS_TITLE = { added: '추가된 파일', modified: '수정된 파일', deleted: '삭제된 파일', renamed: '이름이 바뀐 파일' };
var CHG_EMPTY = '아직 변경 기록이 없습니다';
var CHG_DENIED = '변경점은 세션 소유자만 볼 수 있어요';
var CHG_FAILED = '변경점을 불러오지 못했어요';
var CHG_LOADING = '불러오는 중…';
var CHG_SCOPE_ALL = '전체';
var CHG_REFRESH = '새로 고침';
var CHG_REPOS = '레포 수';
var CHG_FILES = '파일 수';
var CHG_FILE_LIST = '바뀐 파일';
var CHG_AS_OF = '기준 시각';
var CHG_PRS = 'PR';
var CHG_NO_FILES = '이 범위에 바뀐 파일이 없습니다';
var CHG_BINARY = '바이너리 파일 — 줄 단위 변경을 보여 주지 않습니다';
var CHG_TOO_BIG = '변경이 너무 커서 여기에 다 보여 주지 않습니다';
var CHG_OPEN_GITHUB = 'GitHub에서 보기';
var CHG_CLOSE = '닫기';
var CHG_PREV = '이전 파일';
var CHG_NEXT = '다음 파일';
var CHG_TREE_TOGGLE = '파일 목록';
var CHG_SKIPPED = {
  'repo-config-runs-commands': '저장소 설정이 명령을 실행하게 되어 있어 이 체크아웃은 읽지 않았습니다',
  'repo-alternates': '다른 저장소의 객체를 빌려 쓰는 체크아웃이라 읽지 않았습니다',
  'repo-links-outside': '저장소 폴더 안에 심볼릭 링크가 있어 이 체크아웃은 읽지 않았습니다',
  'too-many-files': '추적 파일이 너무 많아 커밋 안 한 변경을 읽지 않았습니다',
  'git-config-unreadable': '저장소 설정을 읽지 못해 이 체크아웃은 읽지 않았습니다',
  'git-diff-failed': '커밋 안 한 변경을 읽지 못했습니다',
  'repo-changed-during-read': '읽는 동안 저장소 폴더가 바뀌어 이번 읽기는 버렸습니다 — 마지막으로 읽은 변경입니다',
  'git-failed': 'git이 응답하지 않아 이번에는 읽지 못했습니다 — 마지막으로 읽은 변경입니다',
};
// The committed layer's own reasons (the uncommitted note names the checkout-wide ones).
var CHG_SKIPPED_COMMITTED = {
  'git-diff-failed': '커밋한 변경을 이번에 읽지 못했습니다 — 마지막으로 읽은 변경입니다',
};
var CHG_FILE_FAILED = '이 파일의 변경을 불러오지 못했어요';
var CHG_MODE = '실행 권한이 바뀜';
var CHG_NO_CONTENT = '내용 변경 없음';
var CHG_RENAMED_FROM = '이전 이름';

var _chg = { cid: '', doc: null, state: 'idle', scope: 'all', closed: Object.create(null), files: Object.create(null), viewer: null, gen: 0 };

function chgEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function chgNum(v) {
  var n = Number(v);
  return isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function chgPrLayer(p) {
  return p.state === 'merged' ? 'merged' : p.state === 'closed' ? 'closed' : 'pr';
}

// Pure: the files a scope shows, one row per repo + path, oldest layer's status first (a file a merged PR added and the
// working tree changed again is still "added"), +/− summed over its layers, the layers it is in.
// scope: 'all' | a layer | 'pr:<id>' (one PR — closed ones only this way).
function chgFilesOf(doc, scope) {
  var rows = Object.create(null);
  var add = function(repo, f, layer) {
    if (!f || !f.path) return;
    var key = repo + '\n' + f.path;
    var r = rows[key];
    if (!r) r = rows[key] = { repo: repo, path: String(f.path), status: f.status || 'modified', oldPath: f.oldPath || '', additions: 0, deletions: 0, layers: [] };
    r.additions += chgNum(f.additions);
    r.deletions += chgNum(f.deletions);
    if (r.layers.indexOf(layer) < 0) r.layers.push(layer);
  };
  var prs = (doc && doc.prs) || [];
  var checkouts = (doc && doc.checkouts) || [];
  var want = function(layer) { return scope === 'all' || scope === layer; };
  // Oldest first: merged, open PRs, committed, uncommitted — the first one fixes the row's status.
  for (var i = prs.length - 1; i >= 0; i--) {
    var p = prs[i];
    var pl = chgPrLayer(p);
    var take = scope === 'pr:' + p.id || (pl !== 'closed' && want(pl));
    if (take && pl === 'merged') (p.files || []).forEach(function(f) { add(p.repo, f, 'merged'); });
  }
  for (var j = prs.length - 1; j >= 0; j--) {
    var q = prs[j];
    var ql = chgPrLayer(q);
    var takeq = scope === 'pr:' + q.id || (ql !== 'closed' && want(ql));
    if (takeq && ql !== 'merged') (q.files || []).forEach(function(f) { add(q.repo, f, ql); });
  }
  if (want('committed')) checkouts.forEach(function(c) { ((c.committed && c.committed.files) || []).forEach(function(f) { add(c.repo, f, 'committed'); }); });
  if (want('uncommitted')) checkouts.forEach(function(c) { ((c.uncommitted && c.uncommitted.files) || []).forEach(function(f) { add(c.repo, f, 'uncommitted'); }); });
  return Object.keys(rows).map(function(k) { return rows[k]; }).sort(function(a, b) {
    return a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

// Pure: how many files each scope chip counts.
function chgCounts(doc) {
  var out = { all: chgFilesOf(doc, 'all').length };
  CHG_LAYERS.forEach(function(l) { out[l] = chgFilesOf(doc, l).length; });
  return out;
}

// Pure: files → repo → directory → file nodes. A directory with one child directory and no file is folded into it
// ('src/conversation'). Every node carries its +/− and file count; key is stable across paints (the open state).
function chgTree(files) {
  var repos = [];
  // Maps without a prototype: a folder may be called constructor or __proto__.
  var byRepo = Object.create(null);
  files.forEach(function(f) {
    var r = byRepo[f.repo];
    if (!r) {
      r = byRepo[f.repo] = { type: 'repo', name: f.repo, key: 'r:' + f.repo, children: [], dirs: Object.create(null), additions: 0, deletions: 0, count: 0 };
      repos.push(r);
    }
    var parts = f.path.split('/');
    var node = r;
    var key = r.key;
    for (var i = 0; i < parts.length - 1; i++) {
      key = key + '/' + parts[i];
      var d = node.dirs[parts[i]];
      if (!d) {
        d = node.dirs[parts[i]] = { type: 'dir', name: parts[i], key: key, children: [], dirs: Object.create(null), additions: 0, deletions: 0, count: 0 };
        node.children.push(d);
      }
      node = d;
    }
    node.children.push({ type: 'file', name: parts[parts.length - 1], key: 'f:' + f.repo + '\n' + f.path, file: f });
  });
  var finish = function(node) {
    var adds = 0;
    var dels = 0;
    var count = 0;
    node.children = node.children.map(function(c) {
      if (c.type === 'file') {
        adds += c.file.additions;
        dels += c.file.deletions;
        count += 1;
        return c;
      }
      finish(c);
      while (c.children.length === 1 && c.children[0].type === 'dir') {
        var only = c.children[0];
        c = { type: 'dir', name: c.name + '/' + only.name, key: only.key, children: only.children, additions: only.additions, deletions: only.deletions, count: only.count };
      }
      adds += c.additions;
      dels += c.deletions;
      count += c.count;
      return c;
    });
    node.children.sort(function(a, b) {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    delete node.dirs;
    node.additions = adds;
    node.deletions = dels;
    node.count = count;
  };
  repos.forEach(finish);
  return repos;
}

// Pure: a unified patch → rows with old and new line numbers. type: hunk | ctx | add | del | note.
function chgHunkRows(patch) {
  var rows = [];
  var a = 0;
  var b = 0;
  var lines = String(patch || '').split('\n');
  // A patch ending in a newline is no extra empty line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.forEach(function(line) {
    var m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) {
      a = Number(m[1]);
      b = Number(m[2]);
      rows.push({ type: 'hunk', old: '', nu: '', text: line });
      return;
    }
    var c = line.charAt(0);
    if (c === '+') rows.push({ type: 'add', old: '', nu: b++, text: line.slice(1) });
    else if (c === '-') rows.push({ type: 'del', old: a++, nu: '', text: line.slice(1) });
    else if (c === '\\') rows.push({ type: 'note', old: '', nu: '', text: line.slice(1).trim() });
    else if (rows.length) rows.push({ type: 'ctx', old: a++, nu: b++, text: line.charAt(0) === ' ' ? line.slice(1) : line });
  });
  return rows;
}

function chgTime(ms) {
  var d = new Date(Number(ms) || 0);
  if (!isFinite(d.getTime()) || !ms) return '';
  var p = function(n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
function chgDelta(a, d) {
  return '<span class="chg-add">+' + chgNum(a) + '</span> <span class="chg-del">−' + chgNum(d) + '</span>';
}

// Pure: the summary line's parts — repos, files, +/−, as of.
function chgSummaryText(doc) {
  var files = chgFilesOf(doc, 'all');
  var repos = {};
  var adds = 0;
  var dels = 0;
  files.forEach(function(f) { repos[f.repo] = 1; adds += f.additions; dels += f.deletions; });
  return { repos: Object.keys(repos).length, files: files.length, additions: adds, deletions: dels, at: chgTime(doc && doc.updatedAt) };
}

function chgEl() { return document.getElementById('panel-changes'); }

// The tab opened (or the panel's conversation changed): the stored list at once, then — for a live session — a fresh
// collect (refresh=1) painted when it lands. A load for a conversation the panel left is dropped.
function chgOpen(cid) {
  if (!cid) { _chg = { cid: '', doc: null, state: 'idle', scope: 'all', closed: Object.create(null), files: Object.create(null), viewer: null, gen: _chg.gen + 1 }; chgPaint(); return; }
  if (_chg.cid !== cid) _chg = { cid: cid, doc: null, state: 'loading', scope: 'all', closed: Object.create(null), files: Object.create(null), viewer: null, gen: _chg.gen + 1 };
  chgPaint();
  chgLoad(cid, false).then(function() { return chgLoad(cid, true); });
}
function chgLoad(cid, refresh) {
  var gen = _chg.gen;
  var url = '/api/dashboard/session/' + encodeURIComponent(cid) + '/changes' + (refresh ? '?refresh=1' : '');
  return fetch(url, { credentials: 'same-origin' })
    .then(function(r) {
      if (r.status === 403) return { denied: true };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(body) {
      if (gen !== _chg.gen || _chg.cid !== cid) return;
      if (body && body.denied) { _chg.state = 'denied'; chgPaint(); return; }
      var doc = body && body.doc;
      // No document (not collected yet) never clears one that is shown.
      if (!doc && _chg.doc) return;
      // Two loads of one conversation can land in either order: an older collect never replaces a newer one.
      if (doc && _chg.doc && Number(doc.updatedAt) < Number(_chg.doc.updatedAt)) return;
      if (doc && _chg.doc && doc.updatedAt === _chg.doc.updatedAt && _chg.state === 'ok') return;
      if (doc && (!_chg.doc || doc.updatedAt !== _chg.doc.updatedAt)) _chg.files = Object.create(null);
      _chg.doc = doc || null;
      _chg.state = 'ok';
      chgPaint();
      if (_chg.viewer) chgViewerPaint();
    })
    .catch(function() {
      if (gen !== _chg.gen || _chg.cid !== cid) return;
      if (!_chg.doc) { _chg.state = 'error'; chgPaint(); }
    });
}
// A card push says the session's changes moved (codeChangesAt): read the stored list again.
function chgNoteCard(cid, at) {
  if (!cid || cid !== _chg.cid || !at || _chg.state === 'denied') return;
  if (_chg.doc && Number(at) <= Number(_chg.doc.updatedAt)) return;
  chgLoad(cid, false);
}

function chgScopeChips(doc) {
  var counts = chgCounts(doc);
  var chips = [{ id: 'all', label: CHG_SCOPE_ALL, n: counts.all }];
  CHG_LAYERS.forEach(function(l) { chips.push({ id: l, label: CHG_LAYER_LABEL[l], n: counts[l] }); });
  return '<div class="chg-scopes" role="group" aria-label="' + chgEsc(CHG_FILE_LIST) + '">' + chips.map(function(c) {
    var on = _chg.scope === c.id;
    var off = c.n === 0 && c.id !== 'all';
    return '<button type="button" class="chg-chip' + (on ? ' on' : '') + '" data-chg-scope="' + chgEsc(c.id) + '"' + (off ? ' disabled' : '') + ' aria-pressed="' + (on ? 'true' : 'false') + '">' + chgEsc(c.label) + ' <b>' + c.n + '</b></button>';
  }).join('') + '</div>';
}
function chgPrRows(doc) {
  var prs = (doc && doc.prs) || [];
  if (!prs.length) return '';
  return '<div class="chg-prs"><div class="chg-h">' + chgEsc(CHG_PRS) + '</div>' + prs.map(function(p) {
    var on = _chg.scope === 'pr:' + p.id;
    var href = /^https:\/\/github\.com\//.test(String(p.url || '')) ? String(p.url) : '';
    return '<div class="chg-pr' + (on ? ' on' : '') + '">' +
      '<button type="button" class="chg-pr-main" data-chg-scope="pr:' + chgEsc(p.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      '<span class="chg-pr-num">#' + chgNum(p.number) + '</span> <span class="chg-pr-title">' + chgEsc(p.title || p.repo) + '</span>' +
      ' <span class="chg-state chg-state-' + chgEsc(p.state) + '">' + chgEsc(CHG_PR_STATE[p.state] || p.state) + '</span> <span>' + chgDelta(p.additions, p.deletions) + '</span>' +
      ' <span class="chg-muted">' + chgEsc(CHG_FILES) + ' ' + chgNum(p.changedFiles) + '</span></button>' +
      (href ? '<a class="chg-pr-link" href="' + chgEsc(href) + '" target="_blank" rel="noopener noreferrer" title="' + chgEsc(CHG_OPEN_GITHUB) + '">↗</a>' : '') +
      '</div>';
  }).join('') + '</div>';
}
function chgLayerBadges(f) {
  return f.layers.map(function(l) { return '<span class="chg-badge chg-badge-' + l + '">' + chgEsc(CHG_LAYER_LABEL[l]) + '</span>'; }).join('');
}
// The tree as rows (tab and viewer). current marks the viewer's file.
function chgTreeHtml(tree, current) {
  var out = [];
  var walk = function(node, depth) {
    var pad = ' style="--chg-depth:' + depth + '"';
    if (node.type === 'file') {
      var f = node.file;
      var on = current && current === node.key;
      out.push('<button type="button" class="chg-row chg-file' + (on ? ' on' : '') + '"' + pad + ' data-chg-file="' + chgEsc(node.key) + '"' + (on ? ' aria-current="true"' : '') + ' title="' + chgEsc(f.path) + '">' +
        '<span class="chg-mark chg-mark-' + chgEsc(f.status) + '" title="' + chgEsc(CHG_STATUS_TITLE[f.status] || '') + '">' + chgEsc(CHG_STATUS_MARK[f.status] || 'M') + '</span>' +
        '<span class="chg-name">' + chgEsc(node.name) + '</span>' + chgLayerBadges(f) + '<span class="chg-delta">' + chgDelta(f.additions, f.deletions) + '</span></button>');
      return;
    }
    var shut = !!_chg.closed[node.key];
    out.push('<button type="button" class="chg-row chg-' + node.type + '"' + pad + ' data-chg-dir="' + chgEsc(node.key) + '" aria-expanded="' + (shut ? 'false' : 'true') + '">' +
      '<span class="chg-caret">' + (shut ? '▸' : '▾') + '</span><span class="chg-name">' + chgEsc(node.name) + '</span>' +
      '<span class="chg-muted">' + node.count + '</span><span class="chg-delta">' + chgDelta(node.additions, node.deletions) + '</span></button>');
    if (!shut) node.children.forEach(function(c) { walk(c, depth + 1); });
  };
  tree.forEach(function(r) { walk(r, 0); });
  return out.join('');
}
// A checkout the server did not read (its config runs commands, it borrows another store), or a layer it could not
// read this time (the last read stands): say which, and why.
function chgSkippedNote(doc) {
  var notes = [];
  ((doc && doc.checkouts) || []).forEach(function(c) {
    var u = c.uncommitted && CHG_SKIPPED[c.uncommitted.skipped];
    var k = c.committed && CHG_SKIPPED_COMMITTED[c.committed.skipped];
    [u, k].forEach(function(text) {
      if (text) notes.push('<div class="chg-note">' + chgEsc(c.repo) + ' · ' + chgEsc(c.dir) + ' — ' + chgEsc(text) + '</div>');
    });
  });
  return notes.join('');
}

function chgPaint() {
  var el = chgEl();
  if (!el) return;
  var html;
  if (_chg.state === 'denied') html = '<div class="chg-empty">' + chgEsc(CHG_DENIED) + '</div>';
  else if (_chg.state === 'error') html = '<div class="chg-empty">' + chgEsc(CHG_FAILED) + '</div>';
  else if (!_chg.doc) html = '<div class="chg-empty">' + chgEsc(_chg.state === 'loading' ? CHG_LOADING : CHG_EMPTY) + '</div>';
  else {
    var doc = _chg.doc;
    var s = chgSummaryText(doc);
    var files = chgFilesOf(doc, _chg.scope);
    html = '<div class="chg-summary"><span>' + chgEsc(CHG_REPOS) + ' <b>' + s.repos + '</b></span><span>' + chgEsc(CHG_FILES) + ' <b>' + s.files + '</b></span><span>' + chgDelta(s.additions, s.deletions) + '</span>' +
      (s.at ? '<span class="chg-muted">' + chgEsc(CHG_AS_OF) + ' ' + chgEsc(s.at) + '</span>' : '') +
      '<button type="button" class="chg-refresh" data-chg-refresh="1">' + chgEsc(CHG_REFRESH) + '</button></div>' +
      chgScopeChips(doc) + chgPrRows(doc) + chgSkippedNote(doc) +
      (files.length ? '<div class="chg-tree" role="tree">' + chgTreeHtml(chgTree(files), '') + '</div>' : '<div class="chg-empty">' + chgEsc(CHG_NO_FILES) + '</div>');
  }
  if (el._chgHtml !== html) {
    el._chgHtml = html;
    el.innerHTML = html;
  }
}

// ── The viewer ──
function chgFileOfKey(key) {
  var files = chgFilesOf(_chg.doc, _chg.scope);
  for (var i = 0; i < files.length; i++) if ('f:' + files[i].repo + '\n' + files[i].path === key) return { list: files, at: i };
  return { list: files, at: -1 };
}
function chgViewerEl() {
  var d = document.getElementById('chg-viewer');
  if (d) return d;
  d = document.createElement('dialog');
  d.id = 'chg-viewer';
  d.className = 'chg-viewer';
  d.setAttribute('aria-label', '변경점');
  d.innerHTML = '<div class="chg-v-head"><button type="button" class="chg-v-tree-toggle" data-chg-v="tree" aria-expanded="true">' + chgEsc(CHG_TREE_TOGGLE) + '</button>' +
    '<span class="chg-v-title" id="chg-v-title"></span>' +
    '<button type="button" data-chg-v="prev" aria-label="' + chgEsc(CHG_PREV) + '" title="' + chgEsc(CHG_PREV) + '">‹</button>' +
    '<button type="button" data-chg-v="next" aria-label="' + chgEsc(CHG_NEXT) + '" title="' + chgEsc(CHG_NEXT) + '">›</button>' +
    '<button type="button" data-chg-v="close" aria-label="' + chgEsc(CHG_CLOSE) + '" title="' + chgEsc(CHG_CLOSE) + '">✕</button></div>' +
    '<div class="chg-v-body"><nav class="chg-v-tree" id="chg-v-tree" aria-label="' + chgEsc(CHG_FILE_LIST) + '"></nav><section class="chg-v-main" id="chg-v-main" tabindex="-1"></section></div>';
  d.addEventListener('click', chgOnClick);
  // Escape closes this dialog only (its native cancel): the page's own Escape (which closes the detail card) never sees it.
  d.addEventListener('keydown', function(e) { if (e.key === 'Escape') e.stopPropagation(); });
  d.addEventListener('close', function() {
    var v = _chg.viewer;
    _chg.viewer = null;
    if (!v) return;
    // The viewer's tree folds the tab's folders too: paint the tab as they are now.
    chgPaint();
    // The row that opened it — or, when the tab was painted again meanwhile, the row of the file last shown.
    var back = v.opener && v.opener.isConnected ? v.opener : chgRowOf(v.key) || chgRowOf(v.openedKey);
    if (back && typeof back.focus === 'function') back.focus();
  });
  document.body.appendChild(d);
  return d;
}
// The tab's row of a file key (keys hold a newline, so no attribute selector).
function chgRowOf(key) {
  var el = chgEl();
  if (!el || !key) return null;
  var rows = el.querySelectorAll('[data-chg-file]');
  for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-chg-file') === key) return rows[i];
  return null;
}
function chgOpenViewer(key, opener) {
  if (!_chg.doc) return;
  var d = chgViewerEl();
  chgRetry(key);
  _chg.viewer = { key: key, openedKey: key, opener: opener || null };
  chgViewerPaint();
  if (!d.open && typeof d.showModal === 'function') d.showModal();
  var main = document.getElementById('chg-v-main');
  if (main) main.focus();
}
function chgViewerPaint() {
  var v = _chg.viewer;
  if (!v) return;
  var found = chgFileOfKey(v.key);
  var tree = document.getElementById('chg-v-tree');
  var title = document.getElementById('chg-v-title');
  var main = document.getElementById('chg-v-main');
  if (tree) tree.innerHTML = chgTreeHtml(chgTree(found.list), v.key);
  var f = found.at >= 0 ? found.list[found.at] : null;
  var scopeLabel = _chg.scope === 'all' ? CHG_SCOPE_ALL : CHG_LAYER_LABEL[_chg.scope] || _chg.scope.replace(/^pr:.*#/, '#');
  if (title) title.innerHTML = '<span class="chg-muted">' + chgEsc(scopeLabel) + '</span> ' + (f ? chgEsc(f.repo) + ' › <b>' + chgEsc(f.path) + '</b>' : '');
  if (!main) return;
  if (!f) { main.innerHTML = '<div class="chg-empty">' + chgEsc(CHG_NO_FILES) + '</div>'; return; }
  var cached = _chg.files[v.key];
  var head = '<div class="chg-v-file"><span class="chg-mark chg-mark-' + chgEsc(f.status) + '">' + chgEsc(CHG_STATUS_MARK[f.status] || 'M') + '</span> <b>' + chgEsc(f.path) + '</b> ' + chgDelta(f.additions, f.deletions) +
    (f.oldPath ? ' <span class="chg-muted">' + chgEsc(CHG_RENAMED_FROM) + ': ' + chgEsc(f.oldPath) + '</span>' : '') + '</div>';
  if (!cached || cached === 'loading') {
    main.innerHTML = head + '<div class="chg-empty">' + chgEsc(CHG_LOADING) + '</div>';
    if (!cached) chgFetchFile(v.key, f);
    return;
  }
  if (cached === 'error') { main.innerHTML = head + '<div class="chg-empty">' + chgEsc(CHG_FILE_FAILED) + '</div>'; return; }
  var srcs = (cached.sources || []).filter(function(s) { return chgSourceInScope(s); });
  main.innerHTML = head + srcs.map(chgSourceHtml).join('');
}
function chgSourceInScope(s) {
  var scope = _chg.scope;
  if (scope === 'all') return s.layer !== 'closed';
  if (scope.indexOf('pr:') === 0) return !!s.prNumber && scope.slice(-('#' + s.prNumber).length) === '#' + s.prNumber;
  return s.layer === scope;
}
function chgSourceHtml(s) {
  var f = s.file || {};
  var label = CHG_LAYER_LABEL[s.layer] + ' · ' + s.label;
  var link = s.prUrl && /^https:\/\/github\.com\//.test(String(s.prUrl)) ? ' <a href="' + chgEsc(s.prUrl + '/files') + '" target="_blank" rel="noopener noreferrer">' + chgEsc(CHG_OPEN_GITHUB) + '</a>' : '';
  var body;
  var mode = f.modeChange ? '<div class="chg-note">' + chgEsc(CHG_MODE) + ' · ' + chgEsc(f.modeChange) + '</div>' : '';
  if (f.binary) body = '<div class="chg-note">' + chgEsc(CHG_BINARY) + '</div>';
  else if (!f.patch && mode && !f.additions && !f.deletions) body = '';
  // A rename with no edit, an empty file added or removed: nothing to show, and nothing too big either.
  else if (!f.patch && !f.patchTruncated && !f.additions && !f.deletions) body = '<div class="chg-note">' + chgEsc(CHG_NO_CONTENT) + '</div>';
  else if (!f.patch) body = '<div class="chg-note">' + chgEsc(CHG_TOO_BIG) + '</div>';
  else {
    body = '<table class="chg-diff"><tbody>' + chgHunkRows(f.patch).map(function(r) {
      if (r.type === 'hunk') return '<tr class="chg-d-hunk"><td colspan="3">' + chgEsc(r.text) + '</td></tr>';
      if (r.type === 'note') return '<tr class="chg-d-note"><td></td><td></td><td>' + chgEsc(r.text) + '</td></tr>';
      var sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
      return '<tr class="chg-d-' + r.type + '"><td class="chg-ln">' + r.old + '</td><td class="chg-ln">' + r.nu + '</td><td class="chg-code"><span class="chg-sign">' + sign + '</span>' + chgEsc(r.text) + '</td></tr>';
    }).join('') + '</tbody></table>' + (f.patchTruncated ? '<div class="chg-note">' + chgEsc(CHG_TOO_BIG) + '</div>' : '');
  }
  return '<div class="chg-src"><div class="chg-src-head"><span class="chg-badge chg-badge-' + chgEsc(s.layer) + '">' + chgEsc(label) + '</span> ' + chgDelta(f.additions, f.deletions) + link + '</div>' + mode + body + '</div>';
}
// One file's layers, for the collect the list came from: an answer that lands after the list moved on (a newer collect
// cleared the cache) is dropped — it would put an old patch under new counts. A failure shows, and is asked again the
// next time the file is opened or chosen.
function chgFetchFile(key, f) {
  var cid = _chg.cid;
  var gen = _chg.gen;
  var ver = _chg.doc ? _chg.doc.updatedAt : null;
  var current = function() { return gen === _chg.gen && cid === _chg.cid && !!_chg.doc && _chg.doc.updatedAt === ver; };
  _chg.files[key] = 'loading';
  var url = '/api/dashboard/session/' + encodeURIComponent(cid) + '/changes/file?repo=' + encodeURIComponent(f.repo) + '&path=' + encodeURIComponent(f.path);
  fetch(url, { credentials: 'same-origin' })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(body) {
      if (!body || !Array.isArray(body.sources)) throw new Error('no sources');
      if (!current()) return;
      // A newer collect than the list: read the list again (it clears the cache and asks for this file anew).
      if (body.updatedAt != null && body.updatedAt !== ver) { delete _chg.files[key]; chgLoad(cid, false); return; }
      _chg.files[key] = body;
      chgViewerPaint();
    })
    .catch(function() { if (current()) { _chg.files[key] = 'error'; chgViewerPaint(); } });
}
// Whether the viewer is open (the page's Escape leaves the detail card alone then).
function chgViewerOpen() {
  var d = document.getElementById('chg-viewer');
  return !!(d && d.open);
}
// After the viewer's tree is painted again, focus the row it was on (else the viewer's body): a node replaced under focus
// drops focus to the page.
function chgRefocus(attr, key) {
  var tree = document.getElementById('chg-v-tree');
  var rows = tree ? tree.querySelectorAll('[' + attr + ']') : [];
  for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute(attr) === key) { rows[i].focus(); return; }
  var main = document.getElementById('chg-v-main');
  if (main) main.focus();
}
// A file whose read failed is asked again when it is opened or chosen.
function chgRetry(key) {
  if (_chg.files[key] === 'error') delete _chg.files[key];
}
function chgStep(delta) {
  var v = _chg.viewer;
  if (!v) return;
  var found = chgFileOfKey(v.key);
  if (!found.list.length) return;
  var at = (found.at + delta + found.list.length) % found.list.length;
  var f = found.list[at];
  v.key = 'f:' + f.repo + '\n' + f.path;
  chgRetry(v.key);
  chgViewerPaint();
}

// One delegated handler for the tab and the viewer.
function chgOnClick(e) {
  var t = e.target && e.target.closest ? e.target.closest('[data-chg-scope],[data-chg-dir],[data-chg-file],[data-chg-refresh],[data-chg-v]') : null;
  if (!t) return;
  var inViewer = !!(t.closest && t.closest('#chg-viewer'));
  if (t.hasAttribute('data-chg-scope')) {
    var sc = t.getAttribute('data-chg-scope');
    _chg.scope = _chg.scope === sc && sc.indexOf('pr:') === 0 ? 'all' : sc;
    chgPaint();
  } else if (t.hasAttribute('data-chg-dir')) {
    var k = t.getAttribute('data-chg-dir');
    _chg.closed[k] = !_chg.closed[k];
    if (inViewer) {
      chgViewerPaint();
      chgRefocus('data-chg-dir', k);
    } else chgPaint();
  } else if (t.hasAttribute('data-chg-file')) {
    var fk = t.getAttribute('data-chg-file');
    if (inViewer && _chg.viewer) {
      _chg.viewer.key = fk;
      chgRetry(fk);
      // A phone's tree panel covers the file: it steps aside once a file is chosen.
      var dv = document.getElementById('chg-viewer');
      if (dv && window.matchMedia && window.matchMedia('(max-width: 720px)').matches) dv.setAttribute('data-tree', 'off');
      chgViewerPaint();
      chgRefocus('data-chg-file', fk);
    }
    else chgOpenViewer(fk, t);
  } else if (t.hasAttribute('data-chg-refresh')) {
    if (_chg.cid) chgLoad(_chg.cid, true);
  } else {
    var act = t.getAttribute('data-chg-v');
    var d = document.getElementById('chg-viewer');
    if (act === 'close' && d) d.close();
    else if (act === 'prev') chgStep(-1);
    else if (act === 'next') chgStep(1);
    else if (act === 'tree' && d) {
      var panel = document.getElementById('chg-v-tree');
      var shown = !!panel && getComputedStyle(panel).display !== 'none';
      d.setAttribute('data-tree', shown ? 'off' : 'on');
      t.setAttribute('aria-expanded', shown ? 'false' : 'true');
    }
  }
}
function chgWire() {
  var el = chgEl();
  if (el && !el._chgWired) {
    el._chgWired = true;
    el.addEventListener('click', chgOnClick);
  }
}
`;

export const CODE_CHANGES_CSS = String.raw`
/* ── 변경점 (.prd/26 §4) ── */
.panel-changes { overflow: auto; padding: 8px 10px 16px; font-size: 13px; color: var(--text); }
.chg-summary { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; margin-bottom: 8px; }
.chg-refresh { margin-left: auto; }
.chg-add { color: var(--green); font-variant-numeric: tabular-nums; }
.chg-del { color: var(--red); font-variant-numeric: tabular-nums; }
.chg-muted { color: var(--text-tertiary); }
.chg-scopes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.chg-chip, .chg-refresh { border: 1px solid var(--border); background: var(--surface); color: var(--text-secondary); border-radius: 999px; padding: 2px 10px; font: inherit; cursor: pointer; }
.chg-chip.on { border-color: var(--accent); color: var(--text); }
.chg-chip:disabled { opacity: .45; cursor: default; }
.chg-h { color: var(--text-tertiary); font-size: 12px; margin: 6px 0 2px; }
.chg-prs { margin-bottom: 8px; }
.chg-pr { display: flex; align-items: center; gap: 6px; }
.chg-pr-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; text-align: left; border: 1px solid transparent; background: none; color: inherit; font: inherit; padding: 3px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.chg-pr-main > * { flex: 0 0 auto; }
.chg-pr-main > .chg-pr-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.chg-pr.on .chg-pr-main { border-color: var(--accent); }
.chg-pr-num { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.chg-pr-link { color: var(--text-secondary); text-decoration: none; padding: 0 4px; }
.chg-state { font-size: 11px; border-radius: 4px; padding: 0 5px; border: 1px solid var(--border); }
.chg-state-merged { color: var(--purple); border-color: var(--purple); }
.chg-state-open { color: var(--green); border-color: var(--green); }
.chg-state-closed { color: var(--red); border-color: var(--red); }
.chg-tree { display: flex; flex-direction: column; }
.chg-row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: 0; background: none; color: inherit; font: inherit; padding: 3px 6px 3px calc(6px + var(--chg-depth, 0) * 14px); border-radius: 4px; cursor: pointer; }
.chg-row:hover, .chg-row:focus-visible { background: var(--surface); }
.chg-row.on { background: var(--surface); box-shadow: inset 2px 0 0 var(--accent); }
.chg-repo .chg-name { font-weight: 600; }
.chg-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chg-delta { margin-left: auto; white-space: nowrap; font-size: 12px; }
.chg-caret { width: 10px; color: var(--text-tertiary); }
.chg-mark { font-family: var(--mono); font-size: 11px; width: 14px; text-align: center; border-radius: 3px; }
.chg-mark-added { color: var(--green); }
.chg-mark-deleted { color: var(--red); }
.chg-mark-renamed { color: var(--purple); }
.chg-mark-modified { color: var(--orange); }
.chg-badge { font-size: 10.5px; border-radius: 4px; padding: 0 5px; background: var(--surface); color: var(--text-secondary); border: 1px solid var(--border); white-space: nowrap; }
.chg-badge-uncommitted { color: var(--orange); border-color: var(--orange); }
.chg-badge-committed { color: var(--yellow); border-color: var(--yellow); }
.chg-badge-pr { color: var(--green); border-color: var(--green); }
.chg-badge-merged { color: var(--purple); border-color: var(--purple); }
.chg-empty { color: var(--text-tertiary); padding: 16px 4px; }
.chg-note { color: var(--text-secondary); font-size: 12px; padding: 6px 4px; }
dialog.chg-viewer { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: var(--bg); color: var(--text); display: none; flex-direction: column; }
dialog.chg-viewer[open] { display: flex; }
dialog.chg-viewer::backdrop { background: rgba(0, 0, 0, .4); }
.chg-v-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.chg-v-head button { flex: 0 0 auto; white-space: nowrap; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; padding: 2px 10px; font: inherit; cursor: pointer; }
.chg-v-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chg-v-body { flex: 1 1 auto; min-height: 0; display: flex; }
.chg-v-tree { width: 300px; flex: 0 0 auto; overflow: auto; border-right: 1px solid var(--border); padding: 6px 4px; font-size: 13px; }
dialog.chg-viewer[data-tree="off"] .chg-v-tree { display: none; }
.chg-v-main { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 10px 14px 40px; outline: none; }
.chg-v-file { position: sticky; top: -10px; background: var(--bg); padding: 6px 0; margin-bottom: 6px; z-index: 1; }
.chg-src { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 14px; overflow: hidden; }
.chg-src-head { display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: var(--surface); border-bottom: 1px solid var(--border); font-size: 12px; }
.chg-src-head a { margin-left: auto; color: var(--accent); }
.chg-diff { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; line-height: 1.5; }
.chg-diff td { padding: 0 8px; vertical-align: top; }
.chg-ln { width: 1%; min-width: 40px; text-align: right; color: var(--text-tertiary); user-select: none; white-space: nowrap; }
.chg-code { white-space: pre-wrap; word-break: break-word; }
.chg-sign { user-select: none; display: inline-block; width: 1.2em; color: var(--text-tertiary); }
.chg-d-add { background: color-mix(in srgb, var(--green) 14%, transparent); }
.chg-d-del { background: color-mix(in srgb, var(--red) 14%, transparent); }
.chg-d-hunk td { color: var(--text-secondary); background: color-mix(in srgb, var(--accent) 10%, transparent); padding: 2px 8px; }
.chg-d-note td { color: var(--text-tertiary); font-style: italic; }
@media (max-width: 720px) {
  .chg-v-tree { position: absolute; z-index: 2; top: 45px; bottom: 0; left: 0; width: min(85vw, 320px); background: var(--bg); box-shadow: 2px 0 8px rgba(0,0,0,.2); }
  dialog.chg-viewer:not([data-tree="on"]) .chg-v-tree { display: none; }
}
`;
