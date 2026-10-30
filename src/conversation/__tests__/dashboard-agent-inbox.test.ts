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
import { pageTokenAliases, uiLibTokensCss } from '../ui-lib';

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
    expect(TEMPLATE).toContain('<ui-segmented class="view-seg" id="view-seg"></ui-segmented>');
    expect(TEMPLATE).toContain("{ value: 'board', label: '보드', icon: 'board' }, { value: 'list', label: '목록', icon: 'list' }");
  });

  it('persists the view in localStorage and defaults to List below 640px', () => {
    expect(TEMPLATE).toContain("'soma-board-view'");
    expect(TEMPLATE).toContain('innerWidth < 640');
  });

  it('renders three columns in order NEEDS YOU → RUNNING → DONE (the element draws them from renderBoard’s plan)', () => {
    expect(TEMPLATE).toContain("var BOARD_LABELS = { waiting: 'NEEDS YOU', working: 'RUNNING', done: 'DONE' };");
    const body = fnBody('renderBoard');
    const waiting = body.indexOf("{ id: 'waiting', label: BOARD_LABELS.waiting");
    const working = body.indexOf("{ id: 'working', label: BOARD_LABELS.working");
    const done = body.indexOf("id: 'done',");
    expect(waiting).toBeGreaterThan(-1);
    expect(working).toBeGreaterThan(waiting);
    expect(done).toBeGreaterThan(working);
    // "Nothing here" is the element's own empty text (lang="en").
    expect(TEMPLATE).toContain('<ui-agent-inbox id="kanban" class="kanban" view="board"></ui-agent-inbox>');
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
    // The day heads are the element's (columns[].groups); the reader's choice comes back as ui-group-toggle.
    expect(fnBody('wireInbox')).toContain("host.addEventListener('ui-group-toggle', function(e) {");
    expect(fnBody('wireInbox')).toContain('_doneGroupOpen[day] = open;');
  });

  it('the stats strip leads the page and the board follows it (§3.1-2)', () => {
    const main = TEMPLATE.slice(TEMPLATE.indexOf('<div class="main">'));
    const strip = main.indexOf('<section class="stats" id="stats"');
    // Tone pass P6: closed, 자세히's region is hidden and inert (it folds to 0 rows).
    const detailAt = main.indexOf('<div class="stats-detail" id="stats-detail" hidden inert>');
    const board = main.indexOf('<section class="inbox ui-tok" id="inbox"');
    expect(strip).toBeGreaterThan(0);
    expect(detailAt).toBeGreaterThan(strip);
    expect(board).toBeGreaterThan(detailAt);
    // Collapsed: the period control, 세션 · 토큰 · 비용 and the 자세히 toggle.
    const row = main.slice(strip, detailAt);
    // D1 (B-02): the period control is @2lab.ai/ui <ui-segmented> — the same element as Board | List.
    expect(row).toContain('<ui-segmented class="period-bar" id="period-seg" full></ui-segmented>');
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

  it('D1 — the segmented controls are answered, not drawn: data in, ui-change answered', () => {
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/segmented.js?v=${UI_LIB_VERSION}"></script>');
    expect(fnBody('paintPeriodSeg')).toContain("seg.data = { label: '기간', value: currentPeriod, options: PERIOD_OPTIONS };");
    expect(fnBody('setPeriod')).toContain('paintPeriodSeg();');
    expect(TEMPLATE).toContain(
      "var PERIOD_OPTIONS = [{ value: 'day', label: '오늘' }, { value: 'week', label: '지난 7일' }, { value: 'month', label: '지난 30일' }];",
    );
    expect(TEMPLATE).toContain("periodSeg.addEventListener('ui-change', function(e) { setPeriod(e.detail.value); });");
    expect(TEMPLATE).toContain("viewSeg.addEventListener('ui-change', function(e) { setBoardView(e.detail.value, e); });");
    // The inline segmented rules are gone (the element draws its own well, chip, 44px rows and reduced motion).
    expect(TEMPLATE).not.toMatch(/\n\.seg \{|\.seg-btn/);
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
    // Tone pass P8: the group's name and its two buttons are Korean (보드 · 목록).
    // D1 (D-02): Board | List is <ui-segmented>; the page hands it the group name and the two choices.
    expect(head.indexOf('<ui-segmented class="view-seg" id="view-seg"></ui-segmented>')).toBeGreaterThan(btn);
    expect(TEMPLATE).toContain(
      "var VIEW_OPTIONS = [{ value: 'board', label: '보드', icon: 'board' }, { value: 'list', label: '목록', icon: 'list' }];",
    );
    expect(fnBody('setBoardView')).toContain("label: '보드 보기'");
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
    expect(body).toContain('planDoneColumn(rest.idle || [], rest.closed || [], {');
    expect(body).toContain('planDoneGroups(plan.done, Date.now(), _doneGroupOpen)');
    // DONE = one group per day; the element counts every group, open or closed (a closed day's cards are stubs).
    expect(body).toContain('groups: groups.map(function(g) {');
    expect(body).toContain('placeCard(it.s, it.col, kb, g.open)');
    expect(body).not.toContain('renderOlderToggle');
    expect(body).toContain('renderArchivesToggle(plan.archivedCount)');
    // The #814 tokens tooltip follows the board it describes.
    expect(body).toContain('updateTokenBreakdown();');
  });

  it('every card head carries the owner badge (All Users only — the mapper decides) (§3.1-3)', () => {
    // The element draws it at the right end of the head; the title truncates first (its styles).
    expect(fnBody('cardOf')).toContain("var owner = currentUserId ? '' : s.ownerName || s.ownerId || '';");
    expect(fnBody('cardOf')).toContain(
      'card.badge = { text: String(owner), hue: ownerBadgeHue(s.ownerId || owner), title: String(owner) };',
    );
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

// The keyed reconciler — persistent card nodes, a part rewritten only when its HTML changed, a same-data render
// that writes nothing, FLIP — is <ui-agent-inbox>'s (@2lab.ai/ui agent-inbox.test.ts: 'keeps focus on a face
// across data renders', 'shows a new status in place first …'). The page keeps its side of it.
describe('agent inbox board — keyed cards (§3.1-6)', () => {
  it('cards are keyed by the raw session key; an open card’s body is in that key’s slot', () => {
    expect(fnBody('cardOf')).toContain('id: s.key,');
    expect(fnBody('paintCardBody')).toContain("el.setAttribute('slot', 'body:' + key);");
  });

  it('renderBoard hands the element its data — it never writes the columns itself', () => {
    const body = fnBody('renderBoard');
    expect(body).not.toBe('');
    expect(body).not.toContain('innerHTML');
    expect(body).toContain('inboxPaint(kb);');
    expect(body).toContain('paintCronLaneCards(cronLaneSlots(cronPlan));');
  });

  it('a single card is repainted only when its card data changed; its body only when its markup changed', () => {
    const refresh = fnBody('refreshCard');
    expect(refresh).toContain('if (JSON.stringify(c) !== JSON.stringify(_cardData[key])) {');
    expect(fnBody('paintCardBody')).toContain(
      'if (b.html !== html && !isEditingGoal(b.el) && !isPickingModel(b.el)) {',
    );
    expect(fnBody('paintCardBody')).toContain('morphInnerHtml(b.el, html);');
  });

  it('dictionaries keyed by session keys / conversation ids are prototype-free', () => {
    for (const v of ['_cardHost', '_cardCol', '_cardData', '_cardDrawn', '_cardBodies', '_ioCache', '_cardClosing'])
      expect(TEMPLATE, v).toMatch(new RegExp(`var ${v} = Object\\.create\\(null\\);`));
    expect(TEMPLATE).toContain('let _sessionCache = Object.create(null);');
    expect(fnBody('renderBoard')).toContain('_cardHost = Object.create(null);');
    expect(fnBody('renderBoard')).toContain('_sessionCache = Object.create(null);');
  });

  it('sessionUpdated goes through the same single-card path', () => {
    const ws = fnBody('connectWs');
    expect(ws).toContain("msg.type === 'sessionUpdated'");
    expect(ws).toContain('if (_cardHost[updatedKey]) refreshCard(updatedKey);');
    expect(ws).not.toContain('replaceWith(');
  });
});

describe('agent inbox board — expanded card (§3.1-4)', () => {
  it('card click toggles expansion in place instead of opening the panel (the element’s ui-toggle)', () => {
    expect(fnBody('wireInbox')).toContain("host.addEventListener('ui-toggle', function(e) {");
    expect(TEMPLATE).not.toContain('onclick="openPanel(');
  });

  it('the multi-question form does not repeat the question the face already shows', () => {
    expect(fnBody('renderCardBody')).toContain('renderMultiChoiceCard(s, faceSummary)');
    expect(fnBody('renderMultiChoiceCard')).toContain('=== faceSummary');
    // affectUI batch 1: the single-choice question is a <ui-approval-card>, titled with the whole
    // question (the element has no untitled form), so there the face's summary is read again.
    expect(fnBody('renderCardBody')).toContain('questionHtml = acQuestionHtml(s, s.pendingQuestion);');
  });

  it('every card opens its detail card as it expands; without a conversation the work log reads 작업 로그 없음', () => {
    const body = fnBody('renderCardBody');
    // SSOT 2026-10-29 T2: no 작업 로그 button (nor its primary/steps-back logic) — expanding the
    // card opens its detail card (the element's ui-toggle → openPanel(key)), folding it takes it
    // out (deckDrop). The executed wiring is in dashboard-affectui-agent-inbox-client.test.ts.
    expect(body).not.toContain('worklogBtn');
    expect(body).not.toContain('canDecideHere');
    expect(body).not.toContain('작업 로그</button>');
    const toggle = fnBody('wireInbox');
    expect(toggle).toContain('openPanel(key);');
    expect(toggle).toContain('deckDrop(key);');
    expect(toggle.indexOf('openPanel(key);')).toBeLessThan(toggle.indexOf('deckDrop(key);'));
    // SSOT 2026-10-29 T1: the actions (Stop · Close · Trash) + Slack are the body's first row.
    expect(body).toContain(
      `const actionsHtml = '<div class="card-actions-bar"><span class="card-actions">' + sessionActionHtml(s, col, 'card') + slackBtn + '</span></div>';`,
    );
    expect(body).toMatch(/return '<div class="card-body">'\s*\+ actionsHtml\s*\+ permissionHtml/);
    expect(TEMPLATE).toContain("var WL_EMPTY_MSG = '작업 로그 없음';");
    // SSOT 2026-10-29: no conversation → no work-log state; the 작업 로그 tab reads 작업 로그 없음.
    expect(fnBody('resetWorkLog')).toContain('_wl = convId ? wlNewState(convId) : null;');
    expect(fnBody('paintLogTab')).toContain('var msg = !st ? WL_EMPTY_MSG');
    expect(fnBody('openPanel')).toContain('resetWorkLog(panelConvId);');
  });

  it('a WS session_update re-attaches sibling-instance cards from the last poll', () => {
    // The push goes through paintPushedBoard, which merges once the first poll has painted.
    expect(fnBody('connectWs')).toContain('paintPushedBoard(msg.board)');
    expect(fnBody('paintPushedBoard')).toContain('renderBoard(mergeSiblingCards(board))');
    expect(fnBody('loadSessions')).toContain('_lastPolledBoard = data.board;');
  });

  it('older panel turns keep the reading position (anchored on the first turn in view of the 지시와 답변 box)', () => {
    const body = fnBody('loadMorePanelTurns');
    // SSOT 2026-10-29: the box's first turn in view, captured before the page goes in, held after.
    const anchor = body.indexOf('var anchor = psecViewAnchor(box);');
    const insert = body.indexOf("turnsEl.insertAdjacentHTML('afterbegin'");
    expect(anchor).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(anchor);
    expect(body.indexOf('psecHoldPlace(box, anchor, fromBottom);')).toBeGreaterThan(insert);
    expect(fnBody('psecRestoreAnchor')).toContain(
      'el.getBoundingClientRect().top - box.getBoundingClientRect().top - a[i].at',
    );
  });

  it('reopening a card retries a failed 지시/응답 fetch at once', () => {
    expect(fnBody('wireInbox')).toContain('ensureCardIo(key, true)');
  });

  it('lazy-loads the latest instruction/response pair with limit=2', () => {
    expect(TEMPLATE).toContain("'?limit=2'");
    expect(TEMPLATE).toContain('지시');
    expect(TEMPLATE).toContain('응답');
  });

  it('no card button opens the panel at the work log any more (SSOT 2026-10-29 T2)', () => {
    // The removed 작업 로그 button was the only card control that passed `true` (the work-log
    // landing). The detail card opens with the card (Chat, the default); the 작업 로그 tab is
    // one click away in it.
    expect(DASHBOARD_TS).not.toContain("openPanel(\\\\'' + escJs(s.key) + '\\\\',true,");
    // (the same quoting is live on the goal line — the check above is not vacuous)
    expect(DASHBOARD_TS).toContain("openPanel(\\\\'' + escJs(s.key) + '\\\\',\\\\'goal\\\\',");
    expect(TEMPLATE).toContain('id="psec-tab-log" data-sec="log"');
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
    // SSOT 2026-10-29 T2: the panel carries the deck's depth (data-deck) from the start.
    const panelAt = TEMPLATE.indexOf('<div class="slide-panel" id="slide-panel" data-deck="0">');
    expect(panelAt).toBeGreaterThan(0);
    const panel = TEMPLATE.slice(panelAt);
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
    // The panel's own anchor: the question, Tasks (now in the scroll area) and the section tabs —
    // the turns and log rows are their section box's (psecViewAnchor).
    expect(fnBody('panelScrollAnchor')).toContain("'#panel-question, #panel-tasks, #panel-sections'");
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
  it('reads ?session= and opens the card + its detail card (on Chat, SSOT 2026-10-29 T2)', () => {
    expect(TEMPLATE).toContain('URLSearchParams(location.search)');
    expect(TEMPLATE).toContain(".get('session')");
    // Expanding the card already opened its detail card; the link only brings it to the
    // front when something else is there — and lands on the default (no `true`, no 작업 로그).
    const body = fnBody('openDeepLinkedSession');
    expect(body).toContain('if (!panelOpen || panelSessionKey !== key) openPanel(key);');
    expect(body).not.toContain('openPanel(key, true)');
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

// Tone pass P7 — surfaces and elevation: two levels of shadow (the library's --ib-shadow at rest,
// --ib-shadow-raised for what floats), no colour rails on the turns, glyphs instead of emoji.
describe('tone pass P7 — surfaces and elevation', () => {
  const rule = (sel: string) => {
    const at = TEMPLATE.indexOf(`\n${sel} {`);
    expect(at, sel).toBeGreaterThan(0);
    return TEMPLATE.slice(at, TEMPLATE.indexOf('}', at));
  };

  it('stat cards and charts are 12px cards on --ib-shadow; menus, dialogs, the peek, the viewer and tooltips are raised', () => {
    for (const sel of ['.stat-card', '.chart-container']) {
      expect(rule(sel), sel).toContain('border-radius: 12px;');
      expect(rule(sel), sel).toContain('box-shadow: var(--ib-shadow);');
    }
    for (const sel of [
      '.td-menu',
      '.nt-dialog',
      '.art-peek',
      '.art-modal',
    ]) {
      expect(rule(sel), sel).toContain('box-shadow: var(--ib-shadow-raised)');
    }
    // D1 (B-04, B-08): the token breakdown and the bar values are @2lab.ai/ui <ui-tooltip> — the element draws
    // its own surface (the breakdown its raised card variant); the page keeps no tooltip rule.
    expect(TEMPLATE).toContain('<ui-tooltip id="stat-tokens-tooltip" variant="card" placement="bottom" disabled>');
    expect(TEMPLATE).toContain(`return '<ui-tooltip text="' + escAttr(label + ': ' + values[i]) + '"><div class="bar"`);
    expect(TEMPLATE).not.toContain('bar-tooltip');
    expect(TEMPLATE).not.toContain('tooltip-open');
  });

  it('turns carry no colour rail; who spoke is a neutral 24px glyph tile with a hairline — the bot an SVG', () => {
    expect(TEMPLATE).not.toMatch(/\.turn\.(user|assistant|is-sys) \{[^}]*border-left/);
    const tile = rule('.turn-avatar');
    expect(tile).toContain('width: 24px; height: 24px;');
    expect(tile).toContain('box-shadow: inset 0 0 0 1px var(--border);');
    expect(tile).not.toMatch(/var\(--(accent|purple)\)/);
    expect(TEMPLATE).not.toMatch(/\.(user|bot)-avatar \{[^}]*var\(--(accent|purple)\)/);
    expect(TEMPLATE).not.toContain('&#x1F916;');
    expect(
      TEMPLATE.match(/<div class="turn-avatar bot-avatar" aria-hidden="true">' \+ BOT_AVATAR_SVG \+ '<\/div>/g),
    ).toHaveLength(3);
  });

  it('the goal mark is the target glyph, not the bullseye emoji', () => {
    expect(TEMPLATE).not.toContain('&#x1F3AF;');
    expect(TEMPLATE.match(/<span class="cgl-icon" aria-hidden="true">' \+ GOAL_SVG \+ '<\/span>/g)).toHaveLength(2);
    expect(TEMPLATE).toContain(`<span class="cg-label">' + GOAL_SVG + 'Goal</span>`);
  });
});

// Tone pass P8 — copy: Korean chrome from one STRINGS table, "…" not "...", no emoji in labels; the
// text triangles and the close / regenerate characters are the icon set's 16-grid stroke glyphs.
describe('tone pass P8 — copy and glyphs', () => {
  it('no emoji or text triangles in the chrome: close, regenerate, warnings, chevrons are glyphs', () => {
    for (const s of [
      '&#x1F504;',
      '\\uD83D\\uDD04',
      '&#x2715;',
      '&#xD7;</button>',
      '\\u274C',
      '\\u26A0\\uFE0F',
      '\\uD83D\\uDCCB',
      '\\u2705',
    ]) {
      expect(TEMPLATE, s).not.toContain(s);
    }
    for (const s of ['&#x25B2;', '&#x25BC;', "'\\\\25B6 '", "'\\\\25BC '", '▶ 수동 실행', "'🔐 '"]) {
      expect(TEMPLATE, s).not.toContain(s);
    }
    // One chevron: the icon set's, drawn as a mask in currentColor, turned by aria-expanded.
    expect(TEMPLATE).toMatch(
      /\n\.chev \{[^}]*mask: var\(--chev\) center \/ contain no-repeat;/,
    );
    expect(TEMPLATE).toContain('.chev.is-up, [aria-expanded="true"] > .chev { transform: rotate(180deg); }');
    expect(TEMPLATE).toContain(`<span class="wl-g-chev chev is-right" aria-hidden="true"></span>`);
    // The close buttons and the subtitle's regenerate are SVGs with a name.
    // D1: the glyphs are @2lab.ai/ui's icon set, named in an icon slot the server fills (fillUiIcons).
    expect(TEMPLATE).toMatch(
      /class="ui-icon-btn is-bordered panel-close"[^>]*><i data-ui-icon="close"><\/i><\/button>/,
    );
    expect(TEMPLATE).toMatch(
      /id="panel-title-sub-regen"[^>]*aria-label="부제 다시 만들기"[^>]*><i data-ui-icon="refresh"><\/i>/,
    );
  });

  it('Korean chrome with "…": the panel, the lifecycle dialog and the board tools; the panel copy comes from STRINGS', () => {
    for (const s of [
      'Session Detail</h3>',
      '>Session lifecycle<',
      'title="Session lifecycle (admin)"',
      'aria-label="Usage stats"',
      'aria-label="Breadcrumb"',
      '<span>Lifecycle</span>',
    ]) {
      expect(TEMPLATE, s).not.toContain(s);
    }
    expect(TEMPLATE).toContain('<h3 id="panel-title" tabindex="-1">작업 카드</h3>');
    expect(TEMPLATE).toContain('<h3 id="lifecycle-title">세션 수명 주기</h3>');
    for (const s of [
      "'Retrying...'",
      'Generating summary...',
      "'Generating title...'",
      "previous || 'Error'",
      'Multi-choice data unavailable',
      'Multi-choice questions could not be loaded',
      'Title generation failed',
    ]) {
      expect(TEMPLATE, s).not.toContain(s);
    }
    const table = TEMPLATE.slice(
      TEMPLATE.indexOf('var STRINGS = {'),
      TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')),
    );
    for (const k of [
      'summaryFailed',
      'summaryPending',
      'retry',
      'retrying',
      'titlePending',
      'titleFailed',
      'error',
      'mcUnavailable',
      'mcLoadFailed',
    ]) {
      expect(table, k).toMatch(new RegExp(`\\n  ${k}: '[^']+'`));
    }
    expect(table).not.toMatch(/\.\.\./);
  });
});

describe('agent inbox board — motion contract (§4)', () => {
  // P10 (tone pass): the tokens come from @2lab.ai/ui's tokens.css, emitted into the page, and the
  // dashboard's names are aliases of the library's --ui-* — one source, the values verbatim.
  it("declares the motion tokens verbatim (the library's tokens, aliased to the dashboard names)", () => {
    expect(TEMPLATE).toContain('${uiLibTokensCss()}');
    expect(TEMPLATE).toContain('${pageTokenAliases()}');
    const tokens = uiLibTokensCss();
    expect(tokens).toContain('--ui-ease-out: cubic-bezier(0.23, 1, 0.32, 1);');
    expect(tokens).toContain('--ui-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);');
    expect(tokens).toContain('--ui-dur-press: 160ms;');
    expect(tokens).toContain('--ui-dur-expand: 240ms;');
    expect(tokens).toContain('--ui-dur-move: 320ms;');
    expect(tokens).toContain('--ui-dur-fade: 180ms;');
    const aliases = pageTokenAliases();
    for (const n of ['ease-out', 'ease-in-out', 'dur-press', 'dur-expand', 'dur-move', 'dur-fade'])
      expect(aliases).toContain(`--${n}: var(--ui-${n});`);
  });

  it('the open card grows in place (0fr → 1fr) in the element; the page keeps no expansion rules', () => {
    expect(TEMPLATE).not.toContain('.card-expand');
    expect(TEMPLATE).not.toContain('.card.is-expanded');
  });

  it('runs FLIP through WAAPI and honours reduced motion', () => {
    expect(TEMPLATE).toContain('.animate(');
    expect(TEMPLATE).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
  });

  it('presses scale to 0.97 — pointer presses only, never keyboard activation (§4-5, §4-9)', () => {
    const rules = TEMPLATE.match(/^[^\n{]*:active[^\n{]*\{[^}]*transform: scale\(0\.97\)[^}]*\}/gm) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    // Tone pass P6: one shared press rule lists its controls in :is(…) — split on top-level commas only,
    // so each selector (the whole :is(…):active… one included) must still exclude keyboard presses.
    const topLevel = (list: string) => {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      for (const ch of list) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      return [...out, cur];
    };
    for (const rule of rules) {
      const selectors = topLevel(rule.slice(0, rule.indexOf('{')));
      for (const sel of selectors) expect(sel, sel).toContain(':not(:focus-visible)');
    }
    expect(TEMPLATE).toMatch(
      /:is\([^)]*\.stats-more[^)]*\):active:not\(:disabled\):not\(:focus-visible\) \{ transform: scale\(0\.97\); \}/,
    );
  });

  it('reduced motion stops the spinner and shows a static working indicator (§4-8)', () => {
    // Every reduced-motion block (SSOT 2026-10-29 T2 added the detail deck's own, earlier in the sheet).
    const reduced = (TEMPLATE.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? []).join('\n');
    expect(reduced).toContain('.spinner, .spin { animation: none !important; }');
    expect(reduced).toMatch(/\.spinner \{ border-color: var\(--st-run\); background: radial-gradient/);
  });

  it('the context fill animates transform scaleX, not width', () => {
    expect(TEMPLATE).toMatch(
      /\.card-body \.context-bar-fill \{[^}]*transform-origin: left center;[^}]*transition: transform/,
    );
    // The panel's 세션 정보 shows the context as <ui-context-window>'s field of cells now (re-context-window D5/D18), not a bar.
    expect(fnBody('cwSlotHtml')).toContain('<ui-context-window lang="ko"');
    expect(fnBody('panelInfoHtml')).not.toContain('transform:scaleX(');
  });

  it('board cards draw no recommended-choice button of their own: the approval card marks the recommendation', () => {
    // affectUI batch 1: the card's single-choice question is a <ui-approval-card>, which lists the
    // recommended choice first, tagged and preselected (library: approval-card.test.ts "lists the
    // recommended choice first and preselected; Submit sends it"). The card's star / ink overrides went
    // with the old buttons; the panel's multi-question form keeps the shared .btn-choice-recommended —
    // tone pass P2: tagged 추천 (a neutral tag, like the library's approval card), no star, no green.
    expect(TEMPLATE).not.toMatch(/\.card \.btn-choice-recommended|\.card \.btn-choice\.btn-choice-recommended/);
    expect(TEMPLATE).toMatch(/\n\.btn-choice-recommended::after \{ content: "추천";/);
    expect(TEMPLATE).not.toContain('2B50');
  });

  it('board hover effects live only inside (hover: hover) and (pointer: fine)', () => {
    expect(TEMPLATE).toContain('@media (hover: hover) and (pointer: fine) {');
    const outside = stripHoverBlocks(TEMPLATE);
    for (const sel of ['.card:hover', '.card-face:hover', '.show-older-btn:hover']) {
      expect(outside, sel).not.toContain(sel);
    }
  });
});

describe('agent inbox board — responsive (§5)', () => {
  it('caps the page at 1280px', () => {
    expect(TEMPLATE).toContain('max-width: 1280px');
  });

  it('a board narrower than 840px scrolls its columns sideways with snap — the element’s own container query', () => {
    // @2lab.ai/ui agent-inbox styles.ts: @container ib (max-width: 839px) … scroll-snap-type: x mandatory.
    expect(TEMPLATE).not.toMatch(/@container inbox \(max-width: 839px\)/);
    expect(TEMPLATE).toContain('.inbox { margin-bottom: 28px; container: inbox / inline-size; }');
  });

  it('<640px raises tap targets to 44px', () => {
    const block = TEMPLATE.match(/@media \(max-width: 639px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('min-height: 44px');
  });

  it('every remaining control is 44px on narrow or touch screens (panel, topbar, period tabs)', () => {
    const block = TEMPLATE.match(/@media \(max-width: 639px\), \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    // The panel's ✕ is the kit's icon button: 44px on touch / narrow screens is the kit's own rule.
    expect(TEMPLATE).toMatch(/<button type="button" class="ui-icon-btn is-bordered panel-close"/);
    // The period tabs are <ui-segmented>: 44px on touch / narrow screens is the element's own rule.
    expect(TEMPLATE).not.toContain('.period-btn');
    expect(block).toContain('.stats-more { min-height: 44px; }');
    expect(block).toContain(
      '.topbar .nav a, .topbar .nav .user-select, .topbar .user-pill, .topbar .admin-toggle { min-height: 44px; }',
    );
    expect(block).toContain('#theme-toggle { min-block-size: 44px; position: relative; }');
    // The subtitle's regenerate is the kit's small icon button (44px on touch / narrow: ui-kit.css).
    expect(TEMPLATE).toContain('id="panel-title-sub-regen" class="ui-icon-btn is-sm"');
    // Must follow the #800 coarse blocks so it wins the cascade.
    expect(TEMPLATE.indexOf('@media (max-width: 639px), (pointer: coarse)')).toBeGreaterThan(
      TEMPLATE.indexOf('@media (max-width: 480px) and (pointer: coarse)'),
    );
  });
});
