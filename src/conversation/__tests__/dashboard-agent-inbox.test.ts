/**
 * Static structure tests for the Agent inbox board (.prd/10-agent-inbox-board-spec.md
 * §3.1 board, §4 motion, §5 responsive).
 *
 * Like dashboard-topbar-mobile.test.ts these read the template source and
 * assert the pieces the contract depends on. Behaviour that can run without a
 * browser (work-log merge/paging, card 지시/응답 retry, escaping, contrast) is
 * executed from the shipped source in dashboard-agent-inbox-client.test.ts;
 * DOM + WAAPI behaviour (FLIP frames, no-op renders during entry/exit, 390px
 * overflow) runs in scripts/screenshot-agent-inbox.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
// Only the page template — server code above it must not satisfy (or trip)
// these assertions by accident.
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

/** Body of a top-level client function: from its declaration to the first `\n}\n`. */
function fnBody(name: string): string {
  // The browser runs the LAST of several same-named declarations — refuse to pick one.
  const decls = TEMPLATE.match(new RegExp(`^(?:async )?function ${name}\\(`, 'gm')) ?? [];
  if (decls.length > 1) throw new Error(`client function ${name} is declared ${decls.length} times`);
  const start = TEMPLATE.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = TEMPLATE.indexOf('\n}\n', start);
  return TEMPLATE.slice(start, end < 0 ? undefined : end);
}

/** Remove every `@media (hover: hover) and (pointer: fine) { ... }` block. */
function stripHoverBlocks(css: string): string {
  return css.replace(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/g, '');
}

describe('agent inbox board — layout (§3.1)', () => {
  it('has the breadcrumb and the Board | List segmented control', () => {
    expect(TEMPLATE).toContain('Agent inbox');
    expect(TEMPLATE).toContain('data-view="board"');
    expect(TEMPLATE).toContain('data-view="list"');
  });

  it('persists the view in localStorage and defaults to List below 640px', () => {
    expect(TEMPLATE).toContain("'soma-board-view'");
    expect(TEMPLATE).toContain('innerWidth < 640');
  });

  it('renders three columns in order NEEDS YOU → RUNNING → DONE', () => {
    const waiting = TEMPLATE.indexOf('id="col-waiting"');
    const working = TEMPLATE.indexOf('id="col-working"');
    const done = TEMPLATE.indexOf('id="col-done"');
    expect(waiting).toBeGreaterThan(-1);
    expect(working).toBeGreaterThan(waiting);
    expect(done).toBeGreaterThan(working);
    expect(TEMPLATE).toContain('NEEDS YOU');
    expect(TEMPLATE).toContain('RUNNING');
    expect(TEMPLATE).toContain('>DONE<');
    expect(TEMPLATE).toContain('Nothing here');
  });

  it('drops the old 4-column idle/closed containers', () => {
    expect(TEMPLATE).not.toContain('id="col-closed"');
    expect(TEMPLATE).not.toContain('id="cards-idle"');
    expect(TEMPLATE).not.toContain('id="cards-closed"');
  });

  it('DONE files closed cards under the day they finished instead of a 7-day Show older toggle (T11/T12)', () => {
    expect(TEMPLATE).not.toContain('Show older');
    expect(TEMPLATE).not.toContain('function toggleOlderClosed()');
    expect(TEMPLATE).toContain('function planDoneGroups(');
    expect(TEMPLATE).toContain('function toggleDoneGroup(');
  });

  it('the stats strip leads the page and the board follows it (§3.1-2)', () => {
    const main = TEMPLATE.slice(TEMPLATE.indexOf('<div class="main">'));
    const strip = main.indexOf('<section class="stats" id="stats"');
    const detailAt = main.indexOf('<div class="stats-detail" id="stats-detail" hidden>');
    const board = main.indexOf('<section class="inbox" id="inbox"');
    expect(strip).toBeGreaterThan(0);
    expect(detailAt).toBeGreaterThan(strip);
    expect(board).toBeGreaterThan(detailAt);
    // Collapsed: the period control, 세션 · 토큰 · 비용 and the 자세히 toggle.
    const row = main.slice(strip, detailAt);
    expect(row).toContain('class="period-bar"');
    for (const id of ['stat-sessions', 'stat-tokens-wrap', 'stat-tokens', 'stat-tokens-tooltip', 'stat-cost']) {
      expect(row, id).toContain(`id="${id}"`);
    }
    expect(row).toContain('id="stats-more" aria-expanded="false" aria-controls="stats-detail"');
    // Behind 자세히: the remaining cards and the charts, same ids as before.
    const detail = main.slice(detailAt, board);
    for (const id of [
      'stats-grid',
      'stat-turns',
      'stat-prs',
      'stat-merged',
      'stat-merge-lines',
      'stat-workflows',
      'chart-row',
    ]) {
      expect(detail, id).toContain(`id="${id}"`);
    }
  });

  it('the 자세히 choice persists in localStorage and starts collapsed (§3.1-2)', () => {
    expect(TEMPLATE).toContain("var STATS_DETAIL_KEY = 'soma-stats-detail';");
    expect(fnBody('toggleStatsDetail')).toContain('localStorage.setItem(STATS_DETAIL_KEY');
    expect(TEMPLATE).toContain("setStatsDetail(saved === 'open');");
  });

  it('Show archives sits in the board header next to Board | List, hidden until there are archives (§3.1-1)', () => {
    const head = TEMPLATE.slice(TEMPLATE.indexOf('<div class="inbox-head">'), TEMPLATE.indexOf('<div class="kanban"'));
    const btn = head.indexOf(
      '<button type="button" class="archives-btn" id="archives-toggle" aria-pressed="false" hidden onclick="toggleArchives()">',
    );
    expect(btn).toBeGreaterThan(0);
    expect(head.indexOf('class="seg" role="group" aria-label="Board layout"')).toBeGreaterThan(btn);
    expect(TEMPLATE).toContain("var SHOW_ARCHIVES_KEY = 'soma-show-archives';");
    expect(TEMPLATE).toContain('var showArchives = readShowArchives();');
    const toggle = fnBody('renderArchivesToggle');
    // A toggle button: the label stays "Archives (N)", aria-pressed carries the state.
    expect(toggle).toContain("'Archives (' + archivedCount + ')'");
    expect(toggle).not.toContain('Show archives');
    expect(toggle).not.toContain('Hide archives');
    expect(toggle).toContain('archivedCount === 0');
    expect(toggle).toContain("btn.setAttribute('aria-pressed', pressed)");
  });

  it('the DONE count is every card under its day groups; the days come from planDoneGroups (T11/T12)', () => {
    const body = fnBody('renderBoard');
    expect(body).toContain('planDoneColumn(board.idle || [], board.closed || [], {');
    expect(body).toContain('done: plan.done.length');
    expect(body).toContain('planDoneGroups(plan.done, Date.now(), _doneGroupOpen)');
    expect(body).not.toContain('renderOlderToggle');
    expect(body).toContain('renderArchivesToggle(plan.archivedCount)');
    // The #814 tokens tooltip follows the board it describes.
    expect(body).toContain('updateTokenBreakdown();');
  });

  it('every card head carries the owner badge (All Users only — the renderer decides) (§3.1-3)', () => {
    expect(fnBody('renderCardFace')).toContain("titleHtml + renderOwnerBadge(s) + '</div>'");
    expect(fnBody('renderOwnerBadge')).toContain('if (currentUserId) return');
    // The title truncates first; the badge keeps its size up to its cap.
    expect(TEMPLATE).toMatch(/\.card \.card-title-text \{[^}]*flex: 1 1 auto;/);
    expect(TEMPLATE).toMatch(/\.owner-badge \{[^}]*flex: 0 0 auto;[^}]*text-overflow: ellipsis;/);
  });
});

describe('agent inbox board — drag and drop removed (§3.1-5)', () => {
  it('has no draggable cards, drag listeners, or confirm() prompts', () => {
    expect(TEMPLATE).not.toContain('draggable=');
    expect(TEMPLATE).not.toContain("'dragstart'");
    // Task view T1.5: the one 'drop' listener is the session composer's file
    // drop (#panel-command, files only) — never a board card or column.
    expect(TEMPLATE.match(/'drop'/g) ?? []).toHaveLength(1);
    const pc = fnBody('pcInit');
    expect(pc).toContain("var host = document.getElementById('panel-command');");
    expect(pc).toContain("host.addEventListener('drop', function(e) {");
    expect(pc).toContain("Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0");
    expect(TEMPLATE).not.toContain('confirm(');
  });
});

describe('agent inbox board — keyed reconciler (§3.1-6)', () => {
  it('cards are keyed by the raw session key (attribute-escaped)', () => {
    expect(TEMPLATE).toContain("data-session-key', key");
  });

  it('renderBoard no longer rewrites columns with innerHTML', () => {
    const body = fnBody('renderBoard');
    expect(body).not.toBe('');
    expect(body).not.toContain('innerHTML');
    expect(body).toContain('reconcileBoard(');
  });

  it('the reconciler only replaces a card part when its HTML changed', () => {
    const body = fnBody('applyCardParts');
    expect(body).not.toBe('');
    expect(body).toContain('_faceHtml !==');
    expect(body).toContain('_bodyHtml !==');
    expect(fnBody('patchCard')).toContain('applyCardParts(');
  });

  it('a same-data render stops before touching the DOM or a running entrance/exit (§3.1-6)', () => {
    const body = fnBody('reconcileBoard');
    expect(body).toContain('if (changed) applyBoardPlan(');
    // Nothing on the planning path finishes entrances or removes fading cards.
    expect(TEMPLATE).not.toContain('clearExitingCards');
    expect(fnBody('measureCards')).not.toContain('.finish(');
    expect(fnBody('exitCard')).toContain('anim.onfinish = anim.oncancel');
  });

  it('dictionaries keyed by session keys / conversation ids are prototype-free', () => {
    expect(TEMPLATE).toContain('var _cardEls = Object.create(null);');
    expect(TEMPLATE).toContain('var _ioCache = Object.create(null);');
    expect(TEMPLATE).toContain('let _sessionCache = Object.create(null);');
    expect(fnBody('reconcileBoard')).toContain('var wanted = Object.create(null);');
    expect(fnBody('renderBoard')).toContain('_sessionCache = Object.create(null);');
  });

  it('sessionUpdated goes through the same patch path', () => {
    const ws = fnBody('connectWs');
    expect(ws).toContain("msg.type === 'sessionUpdated'");
    expect(ws).toContain('patchCard(');
    expect(ws).not.toContain('replaceWith(');
  });
});

describe('agent inbox board — expanded card (§3.1-4)', () => {
  it('card click toggles expansion in place instead of opening the panel', () => {
    expect(TEMPLATE).toContain('function toggleCard(');
    expect(TEMPLATE).not.toContain('onclick="openPanel(');
  });

  it('the multi-question form does not repeat the question the face already shows', () => {
    expect(fnBody('renderCardBody')).toContain('renderMultiChoiceCard(s, faceSummary)');
    expect(fnBody('renderMultiChoiceCard')).toContain('=== faceSummary');
    // affectUI batch 1: the single-choice question is a <ui-approval-card>, titled with the whole
    // question (the element has no untitled form), so there the face's summary is read again.
    expect(fnBody('renderCardBody')).toContain('questionHtml = acQuestionHtml(s, s.pendingQuestion);');
  });

  it('every card can open the panel; without a conversation the work log reads 작업 로그 없음', () => {
    const body = fnBody('renderCardBody');
    // re-agent-inbox D10: 작업 로그 is the primary unless the card holds a decision for this viewer.
    expect(body).toMatch(
      /const worklogBtn = '<button type="button" class="btn-action' \+ \(canDecideHere \? '' : ' btn-primary'\) \+ '"/,
    );
    expect(TEMPLATE).toContain("var WL_EMPTY_MSG = '작업 로그 없음';");
    expect(fnBody('resetWorkLog')).toContain('WL_EMPTY_MSG');
    expect(fnBody('openPanel')).toContain('resetWorkLog(panelConvId, true)');
  });

  it('a WS session_update re-attaches sibling-instance cards from the last poll', () => {
    // The push goes through paintPushedBoard, which merges once the first poll has painted.
    expect(fnBody('connectWs')).toContain('paintPushedBoard(msg.board)');
    expect(fnBody('paintPushedBoard')).toContain('renderBoard(mergeSiblingCards(board))');
    expect(fnBody('loadSessions')).toContain('_lastPolledBoard = data.board;');
  });

  it('older panel turns keep the reading position (anchored on the first visible element)', () => {
    const body = fnBody('loadMorePanelTurns');
    expect(body).toContain('panelScrollAnchor(scrollEl)');
    expect(body).toContain('anchor.el.getBoundingClientRect().top - anchor.top');
  });

  it('reopening a card retries a failed 지시/응답 fetch at once', () => {
    expect(fnBody('toggleCard')).toContain('ensureCardIo(key, true)');
  });

  it('lazy-loads the latest instruction/response pair with limit=2', () => {
    expect(TEMPLATE).toContain("'?limit=2'");
    expect(TEMPLATE).toContain('지시');
    expect(TEMPLATE).toContain('응답');
  });

  it('the 작업 로그 button opens the panel at the work log', () => {
    // A keyboard click (event.detail === 0) lands focus too (spec 13).
    expect(DASHBOARD_TS).toContain("openPanel(\\\\'' + escJs(s.key) + '\\\\',true,");
    expect(TEMPLATE).toContain('작업 로그');
  });
});

describe('agent inbox board — work log panel (§3.1-7, §3.3)', () => {
  it('has a work log section tab in the panel (SSOT 2026-10-29)', () => {
    expect(TEMPLATE).toContain('id="psec-tab-log" data-sec="log"');
    expect(TEMPLATE).toContain('<div class="psec" id="psec-log" role="tabpanel" aria-labelledby="psec-tab-log"');
    expect(TEMPLATE).toContain('작업 로그 없음');
  });

  it('loads on open and recovers on every reconnect while a conversation is open', () => {
    expect(TEMPLATE).toContain("'/worklog'");
    expect(fnBody('openPanel')).toContain('loadWorkLog()');
    expect(fnBody('connectWs')).toContain('if (panelOpen && _wl) recoverWorkLog();');
    // Switching conversations closes the previous state so late responses drop.
    expect(fnBody('resetWorkLog')).toContain('_wl.closed = true');
  });

  it('Tasks sit in the focused tab after the agent tabs, inside the one scroll area — no pinned block (task view T1)', () => {
    const panel = TEMPLATE.slice(TEMPLATE.indexOf('<div class="slide-panel" id="slide-panel">'));
    const header = panel.indexOf('<div class="panel-header">');
    const scroll = panel.indexOf('<div class="panel-scroll" id="panel-scroll">');
    const surface = panel.indexOf('<section class="panel-surface" id="panel-surface"');
    const tabs = panel.indexOf('<div class="panel-tabs" id="panel-tabs" role="tablist"');
    const tabpanel = panel.indexOf('<section class="panel-tabpanel" id="panel-tabpanel" role="tabpanel"');
    const tasks = panel.indexOf(
      '<div class="panel-tasks" id="panel-tasks" role="region" aria-label="Tasks" tabindex="-1"></div>',
    );
    const sections = panel.indexOf('<div class="panel-sections" id="panel-sections" role="tablist"');
    const worklog = panel.indexOf('<div class="psec" id="psec-log" role="tabpanel"');
    const conv = panel.indexOf('<div class="psec-body panel-conv" id="panel-conv">');
    const command = panel.indexOf('<div class="panel-command" id="panel-command">');
    expect(header).toBeGreaterThan(0);
    expect(scroll).toBeGreaterThan(header);
    expect(surface).toBeGreaterThan(scroll);
    expect(tabs).toBeGreaterThan(surface);
    expect(tabpanel).toBeGreaterThan(tabs);
    expect(tasks).toBeGreaterThan(tabpanel);
    expect(sections).toBeGreaterThan(tasks);
    expect(worklog).toBeGreaterThan(sections);
    expect(conv).toBeGreaterThan(worklog);
    expect(command).toBeGreaterThan(conv);
    // Nothing of Tasks between the header and the scroll area any more.
    expect(panel.slice(header, scroll)).not.toContain('panel-tasks');
    expect(panel.match(/id="panel-tasks"/g) ?? []).toHaveLength(1);
    // The block no longer caps its height or scrolls inside: it scrolls with the tab.
    const tasksCss = /\n\.panel-tasks \{[^}]*\}/.exec(TEMPLATE)?.[0] ?? '';
    expect(tasksCss).toContain('padding: 4px 16px;');
    expect(tasksCss).not.toMatch(/max-height|overflow|grid-row/);
    expect(TEMPLATE).toMatch(/\n\.panel-scroll \{ flex: 1 1 auto; overflow-y: auto;[^}]*\}/);
    expect(TEMPLATE).toMatch(/\n\.panel-body \{[^}]*display: flex;[^}]*flex-direction: column;/);
    // The agent tabs stay in view while the tab scrolls.
    expect(TEMPLATE).toMatch(/\n\.panel-tabs \{[^}]*position: sticky;[^}]*top: 0;/);
    // Folded to one line by default (_panelTasksOpen), opened with 자세히 or a tasks landing.
    expect(TEMPLATE).toMatch(/^var _panelTasksOpen = false;/m);
    expect(fnBody('renderPanelTasks')).toContain(
      'if (!_panelTasksOpen) { writePanelTasks(container, head + live); return; }',
    );
    expect(fnBody('panelScrollAnchor')).not.toContain('#panel-tasks');
  });

  it('the work log is a section tab with its own scroll box — no disclosure header, never hidden-but-rendered (§3.1-6, SSOT 2026-10-29)', () => {
    expect(TEMPLATE).toContain(
      '<div class="psec-body worklog-list" id="worklog-list" role="log" aria-label="작업 로그"></div>',
    );
    expect(TEMPLATE).not.toContain('id="worklog-toggle"');
    expect(TEMPLATE).not.toContain('.worklog-list[hidden]');
    // The box scrolls, not the list: the list has no height cap of its own.
    expect(TEMPLATE).toMatch(/\n\.psec \{ position: relative; height: 100%; overflow-y: auto;/);
    expect(/\n\.worklog-list \{[^}]*\}/.exec(TEMPLATE)?.[0] ?? '').not.toMatch(/max-height|overflow/);
  });

  it('an opening names its section tab — 작업 로그 / ?session= open on the work log; the list is painted only while it is shown (§3.1-6, §3.1-7)', () => {
    const body = fnBody('openPanel');
    const reset = body.indexOf('resetWorkLog(panelConvId);');
    expect(reset).toBeGreaterThan(-1);
    expect(body.indexOf('_psec = psecForLanding(_panelLand);')).toBeGreaterThan(-1);
    expect(body.indexOf('selectPanelSection(_psec);')).toBeGreaterThan(reset);
    expect(fnBody('psecForLanding')).toContain("land === 'worklog' ? 'log'");
    expect(TEMPLATE).toMatch(/^var _panelDetail = false;/m);
    expect(fnBody('panelDetailFrom')).toContain("return saved === '1';");
    // 자세히 no longer opens the work log: it is a tab of its own.
    expect(fnBody('togglePanelDetail')).not.toMatch(/worklog|WorkLog/);
    // A batch is painted only while 작업 로그 is shown; else the tab paints from the state when opened.
    expect(fnBody('paintWorkLog')).toContain("if (_psec !== 'log' || !list || !box) {");
    expect(fnBody('paintLogTab')).toContain('wlRenderList(st, list);');
  });

  it('a section opens on its newest items; any reader input ends the settle hold (§3.1-6)', () => {
    const init = TEMPLATE.slice(TEMPLATE.indexOf('(function initPanelScrollHandler() {'));
    // Task view: a mouse press (a scrollbar drag) is the reader's input too.
    expect(init).toContain("['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(");
    expect(init).toContain("document.getElementById('slide-panel')");
    expect(init).toContain('_panelHold = false;');
    expect(fnBody('selectPanelSection')).toContain('psecToNewest();');
  });

  it('older items load as the reader scrolls up toward the top of a section — armed by the reader, never by a landing (§3.1-6, SSOT 2026-10-29)', () => {
    const init = TEMPLATE.slice(TEMPLATE.indexOf('(function initPanelSections() {'));
    expect(init).toContain('if (up && !_psecPin) box._armed = true;');
    expect(init).toContain('new IntersectionObserver(');
    expect(init).toContain("rootMargin: '100% 0px 0px 0px'");
    expect(fnBody('psecToNewest')).toContain('box._armed = false;');
    expect(fnBody('psecPageDue')).toContain('return !!armed && scrollTop <= clientHeight;');
  });

  it('entry rows toggle on click, Enter and Space; detail buttons do not toggle (§3.1-6)', () => {
    const init = TEMPLATE.slice(TEMPLATE.indexOf('(function initWorkLogInteractions() {'));
    expect(init).toContain("e.target.closest('.wl-detail')");
    expect(init).toContain("e.key === 'Enter' || e.key === ' '");
    expect(init).toContain('toggleWorkLogEntry(');
    // Roving tabindex: one stop in the list; the arrows, Home and End move it.
    expect(init).toContain('wlRovingIndex(e.key, rows.indexOf(row), rows.length)');
    expect(init).toContain("addEventListener('focusin'");
    expect(fnBody('paintWorkLog')).toContain('wlEnsureTabStop(list)');
    expect(TEMPLATE).toContain("act === 'retry'");
    expect(TEMPLATE).toContain("act === 'copy'");
  });

  it('live-appends work_log WS entries through the seq merge', () => {
    expect(fnBody('connectWs')).toContain("msg.type === 'work_log'");
    expect(fnBody('connectWs')).toContain('pushLiveWorkLog(msg.conversationId, msg.entry)');
    expect(fnBody('pushLiveWorkLog')).toContain('wlOnLive(');
    expect(fnBody('wlOnLive')).toContain('wlMerge(');
  });
});

describe('agent inbox board — deep link (§3.1-8)', () => {
  it('reads ?session= and opens the card + panel at the work log', () => {
    expect(TEMPLATE).toContain('URLSearchParams(location.search)');
    expect(TEMPLATE).toContain(".get('session')");
    expect(fnBody('openDeepLinkedSession')).toContain('openPanel(key, true)');
  });

  it('retries on board renders for ~10s, then gives up silently', () => {
    expect(TEMPLATE).toContain('DEEP_LINK_WINDOW_MS = 10000');
    const body = fnBody('openDeepLinkedSession');
    // The deadline gates every attempt, not only misses — a card that first
    // appears on the 30 s poll must not open the panel long after load.
    const deadline = body.indexOf('Date.now() > _deepLinkDeadline');
    expect(deadline).toBeGreaterThan(-1);
    expect(deadline).toBeLessThan(body.indexOf('resolveDeepLinkKey('));
    expect(fnBody('renderBoard')).toContain('openDeepLinkedSession()');
  });

  // Execute the shipped client function itself. It must stay free of
  // backslashes so the TS source text is byte-identical to the served JS.
  const src = fnBody('resolveDeepLinkKey');
  const resolve = (ref: string, keys: string[], self: string | null) =>
    new Function(`${src}\n}\nreturn resolveDeepLinkKey;`)()(ref, keys, self) as string | null;

  it('resolveDeepLinkKey source is extractable verbatim', () => {
    expect(src).toContain('function resolveDeepLinkKey(ref, keys, selfInstance)');
    expect(src).not.toContain('\\');
  });

  it('matches an exact board key (prefixed form, or unprefixed single-instance board)', () => {
    const prefixed = ['mac-mini::work:C1:1700000000.000100', 'mac-mini::work:C2:1700000000.000200'];
    expect(resolve('mac-mini::work:C2:1700000000.000200', prefixed, 'mac-mini')).toBe(
      'mac-mini::work:C2:1700000000.000200',
    );
    const raw = ['work:C1:1700000000.000100', 'work:C2:1700000000.000200'];
    expect(resolve('work:C1:1700000000.000100', raw, null)).toBe('work:C1:1700000000.000100');
  });

  it('maps the Slack registry key (no instance prefix) to the unique "::<key>" card', () => {
    const keys = ['mac-mini::work:C1:1700000000.000100', 'mac-mini::work:C2:1700000000.000200'];
    expect(resolve('work:C1:1700000000.000100', keys, 'mac-mini')).toBe('mac-mini::work:C1:1700000000.000100');
    // Sibling card, self instance unknown — still unique by suffix.
    expect(resolve('work:C2:1700000000.000200', keys, null)).toBe('mac-mini::work:C2:1700000000.000200');
  });

  it('prefers this instance when the same thread is on two instances, else refuses to guess', () => {
    const keys = ['oud::work:C1:1700000000.000100', 'mac-mini::work:C1:1700000000.000100'];
    expect(resolve('work:C1:1700000000.000100', keys, 'mac-mini')).toBe('mac-mini::work:C1:1700000000.000100');
    expect(resolve('work:C1:1700000000.000100', keys, 'other')).toBeNull();
  });

  it('with no live card, maps the Slack key to its latest archive ("…archived_<ref>_<archivedAt>")', () => {
    const ref = 'work:C1:1700000000.000100';
    const keys = [
      'mac-mini::work:C2:1700000000.000200',
      `mac-mini::archived_${ref}_1790000000000`,
      `mac-mini::archived_${ref}_1792000000000`,
      `oud::archived_${ref}_1791000000000`,
      `mac-mini::archived_${ref}_17920x`, // not an archivedAt
      `mac-mini::archived_${ref}.5_1799000000000`, // another thread whose key extends this one
    ];
    expect(resolve(ref, keys, 'mac-mini')).toBe(`mac-mini::archived_${ref}_1792000000000`);
    // Single-instance board: archive keys carry no instance prefix.
    expect(resolve(ref, [`archived_${ref}_1790000000000`], null)).toBe(`archived_${ref}_1790000000000`);
    // A live card of the thread wins over any archive.
    expect(resolve(ref, [...keys, `mac-mini::${ref}`], 'mac-mini')).toBe(`mac-mini::${ref}`);
    // Two live cards on two siblings are still refused, archives or not.
    expect(resolve(ref, [...keys, `oud::${ref}`, `mac-mini::${ref}`], 'other')).toBeNull();
  });

  it('returns null when nothing matches yet (caller retries on the next render)', () => {
    expect(resolve('work:C9:1700000000.000900', ['mac-mini::work:C1:1700000000.000100'], 'mac-mini')).toBeNull();
    // A bare suffix of a key segment is not a match.
    expect(resolve('1700000000.000100', ['mac-mini::work:C1:1700000000.000100'], 'mac-mini')).toBeNull();
    expect(resolve('', ['mac-mini::work:C1:1700000000.000100'], 'mac-mini')).toBeNull();
  });
});

describe('agent inbox board — motion contract (§4)', () => {
  it('declares the motion tokens verbatim', () => {
    expect(TEMPLATE).toContain('--ease-out: cubic-bezier(0.23, 1, 0.32, 1);');
    expect(TEMPLATE).toContain('--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);');
    expect(TEMPLATE).toContain('--dur-press: 160ms;');
    expect(TEMPLATE).toContain('--dur-expand: 240ms;');
    expect(TEMPLATE).toContain('--dur-move: 320ms;');
    expect(TEMPLATE).toContain('--dur-fade: 180ms;');
  });

  it('expands with grid-template-rows 0fr → 1fr', () => {
    expect(TEMPLATE).toContain('grid-template-rows: 0fr;');
    expect(TEMPLATE).toContain('grid-template-rows: 1fr;');
  });

  it('runs FLIP through WAAPI and honours reduced motion', () => {
    expect(TEMPLATE).toContain('.animate(');
    expect(TEMPLATE).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
  });

  it('presses scale to 0.97 — pointer presses only, never keyboard activation (§4-5, §4-9)', () => {
    const rules = TEMPLATE.match(/^[^\n{]*:active[^\n{]*\{[^}]*transform: scale\(0\.97\)[^}]*\}/gm) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const selectors = rule.slice(0, rule.indexOf('{')).split(',');
      for (const sel of selectors) expect(sel, sel).toContain(':not(:focus-visible)');
    }
  });

  it('reduced motion stops the spinner and shows a static working indicator (§4-8)', () => {
    const reduced = TEMPLATE.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(reduced).toContain('.spinner, .spin { animation: none !important; }');
    expect(reduced).toMatch(/\.spinner \{ border-color: var\(--st-run\); background: radial-gradient/);
  });

  it('the context fill animates transform scaleX, not width', () => {
    expect(TEMPLATE).toMatch(
      /\.card \.context-bar-fill \{[^}]*transform-origin: left center;[^}]*transition: transform/,
    );
    // The panel's 세션 정보 shows the context as a field of cells now (re-context-window D5/D18), not a bar.
    expect(fnBody('contextBlockHtml')).toContain('<div class="cw-field" aria-hidden="true">');
    expect(fnBody('panelInfoHtml')).not.toContain('transform:scaleX(');
  });

  it('board cards draw no recommended-choice button of their own: the approval card marks the recommendation', () => {
    // affectUI batch 1: the card's single-choice question is a <ui-approval-card>, which lists the
    // recommended choice first, tagged and preselected (library: approval-card.test.ts "lists the
    // recommended choice first and preselected; Submit sends it"). The card's star / ink overrides went
    // with the old buttons; the panel's multi-question form keeps the shared .btn-choice-recommended.
    expect(TEMPLATE).not.toMatch(/\.card \.btn-choice-recommended|\.card \.btn-choice\.btn-choice-recommended/);
    expect(TEMPLATE).toMatch(/\n\.btn-choice-recommended::before \{ content: "\\\\2B50 "; \}/);
  });

  it('board hover effects live only inside (hover: hover) and (pointer: fine)', () => {
    expect(TEMPLATE).toContain('@media (hover: hover) and (pointer: fine) {');
    const outside = stripHoverBlocks(TEMPLATE);
    for (const sel of [
      '.card:hover',
      '.card-face:hover',
      '.seg-btn:hover',
      '.btn-action:hover',
      '.show-older-btn:hover',
    ]) {
      expect(outside, sel).not.toContain(sel);
    }
  });
});

describe('agent inbox board — responsive (§5)', () => {
  it('caps the page at 1280px', () => {
    expect(TEMPLATE).toContain('max-width: 1280px');
  });

  it('a board narrower than 840px scrolls the three columns horizontally with snap (container query, SSOT 2026-10-24)', () => {
    const block = TEMPLATE.match(/@container inbox \(max-width: 839px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('scroll-snap-type: x mandatory');
    expect(block).toContain('minmax(min(300px');
  });

  it('<640px raises tap targets to 44px', () => {
    const block = TEMPLATE.match(/@media \(max-width: 639px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('min-height: 44px');
  });

  it('every remaining control is 44px on narrow or touch screens (panel, topbar, period tabs)', () => {
    const block = TEMPLATE.match(/@media \(max-width: 639px\), \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('.panel-close { width: 44px; height: 44px; }');
    expect(block).toContain('.period-btn { min-height: 44px; }');
    expect(block).toContain('.stats-more { min-height: 44px; }');
    expect(block).toContain(
      '.topbar .nav a, .topbar .nav .user-select, .topbar .user-pill, .topbar .admin-toggle { min-height: 44px; }',
    );
    expect(block).toContain('#theme-toggle { min-block-size: 44px; position: relative; }');
    expect(block).toContain('#panel-title-sub-regen { min-width: 44px; min-height: 44px; }');
    // Must follow the #800 coarse blocks so it wins the cascade.
    expect(TEMPLATE.indexOf('@media (max-width: 639px), (pointer: coarse)')).toBeGreaterThan(
      TEMPLATE.indexOf('@media (max-width: 480px) and (pointer: coarse)'),
    );
  });
});
