/**
 * Agent inbox board — browser receipts and assertions (.prd/10 §3.1, §4, §5, §6).
 *
 * The real web server serves the real dashboard page; the browser-side HTTP
 * layer is mocked (board JSON, latest turns, work log) and the WebSocket is a
 * stub the script drives by hand, so every scenario is deterministic.
 *
 * Asserts (exit 1 on any failure), and writes screenshots for each:
 *   - 1280 / 820 / 390 × light / dark × Board / List, a card expanded:
 *     documentElement.scrollWidth === innerWidth (no page-level sideways scroll)
 *   - RUNNING → DONE move: the card passes through intermediate positions (FLIP)
 *   - reduced motion: the card never travels, it only fades
 *   - identical renders write nothing — also while a card is entering and while
 *     one is fading out (no entrance finished early, no exiting card removed early)
 *   - ?session=<Slack registry key> opens the card and the panel at the work log
 *   - work log: a live entry before the HTTP page keeps the older batch, entries
 *     stay in seq order, reconnect recovery pages forward (afterSeq=0 for an
 *     empty log), duplicates drop, a missing route reads "작업 로그 없음"
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-agent-inbox.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'agent-inbox');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CONVERSATION_VIEWER_PORT || '33917';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** The page's globals the probes touch (dashboard script + PAGE_HELPERS). */
// biome-ignore lint/suspicious/noExplicitAny: page globals are untyped client code
type PageWindow = Record<string, any>;

const NOW = Date.now();
const M = 60_000;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const K = (n: string) => `mock-inst::work:C123:1700000000.000${n}`;

function base(o: Record<string, unknown>) {
  return {
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model: 'claude-opus-4-6',
    channelId: 'C123',
    sessionState: 'MAIN',
    activeAccumulatedMs: 0,
    compactionCount: 0,
    threadTotalActiveMs: 0,
    threadSessionCount: 1,
    effort: 'high',
    ...o,
  };
}

function makeBoard() {
  return {
    waiting: [
      base({
        key: K('100'),
        title: 'Migrate users table',
        displayHeadline: 'Migrate users table',
        activityState: 'waiting',
        conversationId: 'conv-1',
        lastActivity: iso(1 * M),
        slackThreadUrl: 'https://example.slack.com/archives/C123/p1700000000000100',
        issueUrl: 'https://example.atlassian.net/browse/PROJ-7170',
        issueShortRef: 'PROJ-7170',
        issueTitle: 'Split users into accounts and profiles',
        activeAccumulatedMs: 6 * M + 12_000,
        threadTotalActiveMs: 6 * M + 12_000,
        tokenUsage: { totalInputTokens: 820000, totalOutputTokens: 91000, totalCostUsd: 7.42, contextUsagePercent: 42 },
        pendingQuestion: {
          type: 'user_choice',
          question: 'Run migration 0042_split_users on production now?',
          choices: [
            { id: '1', label: 'Approve', description: 'Run on production' },
            { id: '2', label: 'Reject', description: 'Keep staging only' },
          ],
          recommendedChoiceId: '1',
        },
        tasks: [
          {
            content: 'Read schema and 14 migrations',
            status: 'completed',
            startedAt: NOW - 9 * M,
            completedAt: NOW - 6 * M,
          },
          {
            content: 'Write migration 0042_split_users',
            status: 'completed',
            startedAt: NOW - 6 * M,
            completedAt: NOW - 4 * M,
          },
          {
            content: 'Dry run on staging — no errors',
            status: 'completed',
            startedAt: NOW - 4 * M,
            completedAt: NOW - 2 * M,
          },
          { content: 'Wait for approval to run it on production', status: 'in_progress', startedAt: NOW - 1 * M },
        ],
      }),
      base({
        key: K('200'),
        title: 'Clean up CRM contacts',
        displayHeadline: 'Clean up CRM contacts',
        summaryTitle: 'Matched 1,312 likely duplicates, then the merge hit the API rate limit (429).',
        activityState: 'waiting',
        conversationId: 'conv-2',
        lastActivity: iso(7 * M),
        model: 'claude-haiku-4-5',
        tokenUsage: { totalInputTokens: 120000, totalOutputTokens: 9000, totalCostUsd: 0.31, contextUsagePercent: 18 },
        tasks: [
          { content: 'Load 18,240 contacts', status: 'completed', startedAt: NOW - 10 * M, completedAt: NOW - 9 * M },
          { content: 'Match likely duplicates', status: 'completed', startedAt: NOW - 9 * M, completedAt: NOW - 8 * M },
          { content: 'Merge — stopped on API rate limit (429)', status: 'pending' },
        ],
      }),
    ],
    working: [
      base({
        key: K('300'),
        title: 'Review PR #482',
        displayHeadline: 'Review PR #482',
        activityState: 'working',
        conversationId: 'conv-3',
        lastActivity: iso(10_000),
        activeLegStartedAtMs: NOW - (3 * M + 41_000),
        prUrl: 'https://github.com/2lab-ai/soma-work/pull/482',
        prShortRef: 'PR-482',
        prTitle: 'Billing webhooks: retry with idempotency keys',
        tokenUsage: { totalInputTokens: 410000, totalOutputTokens: 52000, totalCostUsd: 3.1, contextUsagePercent: 61 },
        tasks: [
          {
            content: 'Read the diff (14 files)',
            status: 'completed',
            startedAt: NOW - 3 * M,
            completedAt: NOW - 2 * M,
          },
          {
            content: 'Billing webhooks: reading the diff and the test run, writing comments.',
            status: 'in_progress',
            startedAt: NOW - 2 * M,
          },
          { content: 'Post the review', status: 'pending' },
        ],
      }),
      base({
        key: K('400'),
        title: 'Release notes v2.4',
        displayHeadline: 'Release notes v2.4',
        activityState: 'working',
        conversationId: 'conv-4',
        lastActivity: iso(20_000),
        activeLegStartedAtMs: NOW - (1 * M + 19_000),
        model: 'claude-sonnet-4-5',
        tokenUsage: { totalInputTokens: 90000, totalOutputTokens: 12000, totalCostUsd: 0.6, contextUsagePercent: 23 },
        tasks: [
          {
            content: 'Grouping 23 merged pull requests into features and fixes.',
            status: 'in_progress',
            startedAt: NOW - 1 * M,
          },
          { content: 'Draft notes', status: 'pending' },
        ],
      }),
    ],
    idle: [
      base({
        key: K('500'),
        title: 'Weekly metrics digest',
        displayHeadline: 'Weekly metrics digest',
        summaryTitle: 'Pulled numbers from three dashboards and posted the digest to #metrics.',
        activityState: 'idle',
        conversationId: 'conv-5',
        lastActivity: iso(18 * M),
        activeAccumulatedMs: 4 * M + 12_000,
        model: 'claude-haiku-4-5',
        tokenUsage: { totalInputTokens: 64000, totalOutputTokens: 8000, totalCostUsd: 0.2, contextUsagePercent: 9 },
        tasks: [
          {
            content: 'Pulled numbers from 3 dashboards',
            status: 'completed',
            startedAt: NOW - 24 * M,
            completedAt: NOW - 22 * M,
          },
          { content: 'Posted to #metrics', status: 'completed', startedAt: NOW - 20 * M, completedAt: NOW - 18 * M },
        ],
      }),
    ],
    closed: [
      base({
        key: K('600'),
        title: 'Cron scheduler fix',
        displayHeadline: 'Cron scheduler fix',
        summaryTitle: 'Fixed the DST skip in the nightly cron and added a regression test.',
        activityState: 'idle',
        sessionState: 'SLEEPING',
        conversationId: 'conv-6',
        lastActivity: iso(6 * 60 * M),
        activeAccumulatedMs: 12 * M,
      }),
      base({
        key: K('700'),
        title: 'OAuth token refresh',
        displayHeadline: 'OAuth token refresh',
        summaryTitle: 'Refresh now retries once on 401 before logging the user out.',
        activityState: 'idle',
        sessionState: 'SLEEPING',
        terminated: true,
        conversationId: 'conv-7',
        lastActivity: iso(2 * 24 * 60 * M),
      }),
      base({
        key: K('800'),
        title: 'Old spike: vector search',
        displayHeadline: 'Old spike: vector search',
        activityState: 'idle',
        sessionState: 'SLEEPING',
        terminated: true,
        conversationId: 'conv-8',
        lastActivity: iso(9 * 24 * 60 * M),
      }),
    ],
  };
}

const TURNS: Record<string, unknown[]> = {
  'conv-1': [
    {
      id: 't9',
      role: 'user',
      userName: 'Zhuge',
      timestamp: NOW - 9 * M,
      rawContent:
        'users 테이블을 accounts와 profiles로 나누고 staging에서 dry run 해줘. 문제 없으면 prod 적용 전에 물어봐.',
    },
    {
      id: 't10',
      role: 'assistant',
      timestamp: NOW - 2 * M,
      summarized: true,
      summaryTitle: 'Dry run on staging passed',
      summaryBody:
        'Migration 0042_split_users ran on staging in 41s with no errors. Waiting for your approval to run it on production.',
    },
  ],
  'conv-3': [
    {
      id: 't1',
      role: 'assistant',
      timestamp: NOW - 30 * M,
      summarized: true,
      summaryTitle: 'Earlier answer',
      summaryBody: 'Not the reply to the latest instruction.',
    },
    {
      id: 't2',
      role: 'user',
      userName: 'Zhuge',
      timestamp: NOW - 3 * M,
      rawContent: 'PR #482 리뷰해줘. billing webhook 쪽 테스트 위주로.',
    },
  ],
};

const WORKLOG: Record<string, unknown[]> = {
  'conv-1': [
    {
      seq: 1,
      ts: NOW - 9 * M,
      kind: 'instruction',
      text: 'users 테이블을 accounts와 profiles로 나누고 staging에서 dry run 해줘. 문제 없으면 prod 적용 전에 물어봐.',
    },
    {
      seq: 2,
      ts: NOW - 9 * M + 4000,
      kind: 'narration',
      text: 'Reading the current schema and the migration history first.',
    },
    { seq: 3, ts: NOW - 9 * M + 6000, kind: 'tool', tool: 'Read', text: 'db/schema.sql' },
    { seq: 4, ts: NOW - 9 * M + 6500, kind: 'tool_result', tool: 'Read', ok: true, text: '412 lines' },
    { seq: 5, ts: NOW - 8 * M, kind: 'tool', tool: 'Grep', text: 'users\\b in db/migrations (14 files)' },
    { seq: 6, ts: NOW - 8 * M + 900, kind: 'tool_result', tool: 'Grep', ok: true, text: '37 matches' },
    {
      seq: 7,
      ts: NOW - 6 * M,
      kind: 'narration',
      text: 'Writing 0042_split_users: accounts keeps auth columns, profiles gets the rest.',
    },
    { seq: 8, ts: NOW - 5 * M, kind: 'tool', tool: 'Bash', text: 'npm run db:migrate -- --env staging --dry-run' },
    {
      seq: 9,
      ts: NOW - 4 * M,
      kind: 'tool_result',
      tool: 'Bash',
      ok: false,
      text: 'exit 1: relation "profiles" already exists',
    },
    { seq: 10, ts: NOW - 4 * M + 2000, kind: 'notice', text: 'Context compacted (62% → 18%).' },
    {
      seq: 11,
      ts: NOW - 3 * M,
      kind: 'tool',
      tool: 'Bash',
      text: 'npm run db:migrate -- --env staging --dry-run --reset',
    },
    { seq: 12, ts: NOW - 2 * M, kind: 'tool_result', tool: 'Bash', ok: true, text: 'exit 0 (41s)' },
    {
      seq: 13,
      ts: NOW - 2 * M + 3000,
      kind: 'final',
      text: 'Dry run on staging passed in 41s with no errors. Approve to run 0042_split_users on production.',
    },
  ],
};

/** Mutable mock server state: the work log grows while the "socket" is down. */
const WORKLOG_EXTRA: Record<string, number> = { 'conv-1': 0 };
const WORKLOG_CALLS: Array<{ conv: string; afterSeq: number | null }> = [];
const FLAKY_CALLS = { n: 0 };
const PAGE = 5;

function fullLog(conv: string): Array<Record<string, unknown>> {
  const head = (WORKLOG[conv] || []) as Array<Record<string, unknown>>;
  const extra = WORKLOG_EXTRA[conv] || 0;
  const tail = Array.from({ length: extra }, (_, i) => ({
    seq: head.length + 1 + i,
    ts: NOW + i * 1000,
    kind: 'tool',
    tool: 'Bash',
    text: `backfill step ${head.length + 1 + i}`,
  }));
  return head.concat(tail);
}

// Page-side probes. Plain-JS source (not TS functions): tsx's keepNames would
// inject a __name() helper that does not exist in the page.
const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) {',
  '  this.url = url; this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;',
  '  window.__ws = this;',
  '};',
  'window.WebSocket.prototype.close = function () {};',
  'window.__wsSend = function (msg) { window.__ws.onmessage({ data: JSON.stringify(msg) }); };',
  'window.__wsReopen = function () { window.__ws.onopen(); };',
  'window.__flipSample = function (board, key) {',
  '  window.__samples = [];',
  "  var el = document.querySelector('[data-session-key=\"' + key + '\"]');",
  '  var t0 = performance.now();',
  '  window.renderBoard(board);',
  '  function tick() {',
  '    var r = el.getBoundingClientRect(); var cs = getComputedStyle(el);',
  '    window.__samples.push({ t: Math.round(performance.now() - t0), x: Math.round(r.left), y: Math.round(r.top), transform: cs.transform, opacity: cs.opacity, flying: el.classList.contains("is-flying") });',
  '    if (performance.now() - t0 < 450) requestAnimationFrame(tick);',
  '  }',
  '  requestAnimationFrame(tick);',
  '};',
  // Render `board` twice more and return the DOM mutation records the two
  // identical renders produced (timer tick paused so only the reconciler counts).
  'window.__noopMutations = function (board) {',
  '  clearInterval(window._timerTick);',
  '  var kb = document.getElementById("kanban");',
  '  var obs = new MutationObserver(function () {});',
  '  obs.observe(kb, { subtree: true, childList: true, attributes: true, characterData: true });',
  '  window.renderBoard(JSON.parse(JSON.stringify(board)));',
  '  window.renderBoard(JSON.parse(JSON.stringify(board)));',
  '  var recs = obs.takeRecords(); obs.disconnect();',
  '  return recs.map(function (r) { return r.type + ":" + (r.target.className || r.target.nodeName) + ":" + (r.attributeName || ""); });',
  '};',
  // Load older panel turns while `which` ('turn' = 7th turn, 'worklog') sits at
  // the top of the panel; report how far it moved right after and 400 ms later.
  'window.__holdProbe = async function (which) {',
  '  var settle = async function () { while (window._panelTurnsLoading) await new Promise(function (r) { setTimeout(r, 20); }); };',
  '  await settle();',
  '  var scroll = document.getElementById("panel-scroll");',
  '  var target = which === "turn" ? document.querySelectorAll("#panel-turns .turn")[6] : document.getElementById("panel-worklog");',
  '  scroll.scrollTo({ top: scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top, behavior: "instant" });',
  '  await new Promise(function (r) { setTimeout(r, 50); });',
  '  await settle();',
  '  var turnsBefore = document.querySelectorAll("#panel-turns .turn").length;',
  '  var before = target.getBoundingClientRect().top;',
  '  if (window._panelTurnsHasMore) await window.loadMorePanelTurns();',
  '  var at0 = target.getBoundingClientRect().top - before;',
  '  await new Promise(function (r) { setTimeout(r, 400); });',
  '  var at400 = target.getBoundingClientRect().top - before;',
  '  return { at0: Math.round(at0), at400: Math.round(at400), turnsBefore: turnsBefore, turnsAfter: document.querySelectorAll("#panel-turns .turn").length };',
  '};',
  // Older-turns load that is still pending while the reader scrolls on.
  'window.__beginPendingLoad = async function () {',
  '  var settle = async function () { while (window._panelTurnsLoading) await new Promise(function (r) { setTimeout(r, 20); }); };',
  '  await settle();',
  '  var scroll = document.getElementById("panel-scroll");',
  '  var t6 = document.querySelectorAll("#panel-turns .turn")[6];',
  '  scroll.scrollTo({ top: scroll.scrollTop + t6.getBoundingClientRect().top - scroll.getBoundingClientRect().top, behavior: "instant" });',
  '  await new Promise(function (r) { setTimeout(r, 50); });',
  '  await settle();',
  '  window.__pending = window.loadMorePanelTurns();',
  '  return document.querySelectorAll("#panel-turns .turn").length;',
  '};',
  'window.__scrollWhilePending = function (dy) {',
  '  var scroll = document.getElementById("panel-scroll");',
  '  scroll.scrollTo({ top: scroll.scrollTop + dy, behavior: "instant" });',
  '  var top = scroll.getBoundingClientRect().top;',
  '  var turns = document.querySelectorAll("#panel-turns .turn");',
  '  for (var i = 0; i < turns.length; i++) {',
  '    var r = turns[i].getBoundingClientRect();',
  '    if (r.bottom > top) { window.__readEl = turns[i]; window.__readTop = r.top; window.__userScrollTop = scroll.scrollTop; break; }',
  '  }',
  '  return !!window.__readEl;',
  '};',
  'window.__afterPending = async function () {',
  '  await window.__pending;',
  '  await new Promise(function (r) { setTimeout(r, 400); });',
  '  var scroll = document.getElementById("panel-scroll");',
  '  return { moved: Math.round(window.__readEl.getBoundingClientRect().top - window.__readTop), scrollTopKeptOrGrew: scroll.scrollTop >= window.__userScrollTop, turns: document.querySelectorAll("#panel-turns .turn").length };',
  '};',
  // Older-turns load bookkeeping for the stale-response checks.
  'window.__startLoadMore = function () { (window.__loads = window.__loads || []).push(window.loadMorePanelTurns()); return !!window._panelTurnsLoading; };',
  'window.__turnState = function () { return { turns: document.querySelectorAll("#panel-turns .turn").length, loading: !!window._panelTurnsLoading }; };',
  'window.__wlSeqs = function () { return Array.prototype.map.call(document.querySelectorAll("#worklog-list .wl-entry"), function (e) { return Number(e.getAttribute("data-seq")); }); };',
].join('\n');

async function installMocks(
  page: Page,
  board: unknown,
  opts: { holdLatestWorklog?: Promise<void>; holdDenied?: Promise<void> } = {},
) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.route('**/auth/me', (r) => r.fulfill({ json: { user: { name: 'Zhuge' }, csrfToken: 'x' } }));
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) =>
    r.fulfill({
      json: {
        totals: {
          sessionsCreated: 8,
          turnsUsed: 41,
          prsCreated: 2,
          prsMerged: 1,
          commitsCreated: 9,
          mergeLinesAdded: 254,
          mergeLinesDeleted: 33,
          workflowCounts: { zwork: 5, default: 3 },
        },
        days: [],
      },
    }),
  );
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board } }));
  // Work log seam: no afterSeq = latest PAGE window; afterSeq=N = first PAGE after N.
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog/, async (r) => {
    const url = new URL(r.request().url());
    const conv = decodeURIComponent(url.pathname.split('/')[4] || '');
    const raw = url.searchParams.get('afterSeq');
    WORKLOG_CALLS.push({ conv, afterSeq: raw === null ? null : Number(raw) });
    if (conv === 'conv-denied') {
      if (opts.holdDenied) await opts.holdDenied;
      return r.fulfill({ status: 403, json: { error: 'forbidden' } });
    }
    if (conv === 'conv-flaky') {
      FLAKY_CALLS.n++;
      return FLAKY_CALLS.n === 1
        ? r.fulfill({ status: 502, json: { error: 'bad gateway' } })
        : r.fulfill({ status: 403, json: { error: 'forbidden' } });
    }
    if (!(conv in WORKLOG)) return r.fulfill({ status: 404, json: { error: 'Not found' } });
    const log = fullLog(conv);
    if (raw === null) {
      if (opts.holdLatestWorklog) await opts.holdLatestWorklog;
      return r.fulfill({ json: { entries: log.slice(-13), hasMore: log.length > 13 } });
    }
    const rest = log.filter((e) => (e.seq as number) > Number(raw));
    return r.fulfill({ json: { entries: rest.slice(0, PAGE), hasMore: rest.length > PAGE } });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    const u = new URL(r.request().url());
    const id = decodeURIComponent(u.pathname.split('/').pop() || '');
    const all = (TURNS[id] || []) as Array<{ id: string }>;
    const limit = Number(u.searchParams.get('limit') || 30);
    const before = u.searchParams.get('before');
    const end = before ? all.findIndex((x) => x.id === before) : all.length;
    const start = Math.max(0, end - limit);
    return r.fulfill({
      json: { id, title: id, turnCount: all.length, turns: all.slice(start, Math.max(end, 0)), hasMore: start > 0 },
    });
  });
  // Choice answers: record the exact values the click handler sent.
  await page.route(/\/answer-choice$/, (r) => {
    ANSWERS.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ json: { ok: true } });
  });
}
const ANSWERS: Array<Record<string, unknown>> = [];

async function openBoard(page: Page, query = '') {
  await page.goto(`${BASE_URL}/dashboard/U001${query}`);
  await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 5, null, { timeout: 10000 });
  await page.waitForTimeout(350);
}

const failures: string[] = [];
const report: string[] = [];
function log(line: string) {
  report.push(line);
  console.log(line);
}
function check(ok: boolean, what: string) {
  log(`${ok ? '[ok]  ' : '[FAIL]'} ${what}`);
  if (!ok) failures.push(what);
}
async function shoot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: path.join(OUT, name), fullPage });
}
async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** The board after `Review PR #482` finished: RUNNING → top of DONE. */
function boardAfterFinish() {
  const moved = makeBoard();
  const card = moved.working.shift() as Record<string, unknown> & { tasks: Array<Record<string, unknown>> };
  card.activityState = 'idle';
  card.activeAccumulatedMs = 3 * M + 55_000;
  delete card.activeLegStartedAtMs;
  card.tasks = card.tasks.map((t) => ({ ...t, status: 'completed', completedAt: t.completedAt || NOW }));
  moved.idle.unshift(card);
  return moved;
}

async function viewportMatrix(browser: import('playwright').Browser) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 820, 390]) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
        hasTouch: width < 640,
        isMobile: width < 640,
      });
      const page = await ctx.newPage();
      await installMocks(page, makeBoard());
      await openBoard(page);
      const view0 = await page.evaluate(() => document.getElementById('kanban')?.getAttribute('data-view'));
      check(width < 640 ? view0 === 'list' : view0 === 'board', `${theme} ${width}: default view ${view0}`);
      check((await overflow(page)) === 0, `${theme} ${width} ${view0}: no page overflow`);
      await shoot(page, `${theme}-${width}-${view0}.png`);
      await page.click(`[data-session-key="${K('100')}"] .card-face`);
      await page.waitForSelector(`[data-session-key="${K('100')}"] .io-in`, { timeout: 5000 });
      await page.waitForTimeout(450);
      check((await overflow(page)) === 0, `${theme} ${width} ${view0} expanded: no page overflow`);
      // §3.1 item 11: the face summary already shows the question — no second copy.
      const qCopies = await page.evaluate(
        (key) => document.querySelectorAll(`[data-session-key="${key}"] .card-question-text`).length,
        K('100'),
      );
      check(qCopies === 0, `${theme} ${width}: pending question not repeated in the open card`);
      await shoot(page, `${theme}-${width}-${view0}-expanded.png`);
      const other = view0 === 'board' ? 'list' : 'board';
      await page.click(`.seg-btn[data-view="${other}"]`);
      await page.waitForTimeout(500);
      check((await overflow(page)) === 0, `${theme} ${width} ${other} expanded: no page overflow`);
      await shoot(page, `${theme}-${width}-${other}-expanded.png`);
      if (width === 1280 || width === 390) {
        await page.click(`[data-session-key="${K('100')}"] .btn-primary`);
        await page.waitForFunction(() => document.querySelectorAll('#worklog-list .wl-entry').length > 5, null, {
          timeout: 5000,
        });
        await page.waitForTimeout(400);
        await shoot(page, `${theme}-${width}-panel-worklog.png`, false);
      }
      await ctx.close();
    }
  }
}

async function motion(browser: import('playwright').Browser) {
  for (const rm of ['no-preference', 'reduce'] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: 'light',
      reducedMotion: rm,
    });
    const page = await ctx.newPage();
    await installMocks(page, makeBoard());
    await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
    await openBoard(page);
    const moved = boardAfterFinish();
    await page.evaluate(([b, k]) => (window as unknown as PageWindow).__flipSample(b, k), [moved, K('300')] as const);
    if (rm === 'no-preference') {
      for (let i = 0; i < 8; i++) {
        await shoot(page, `flip-${String(i).padStart(2, '0')}.png`, false);
        await page.waitForTimeout(25);
      }
    }
    await page.waitForTimeout(500);
    const samples: Array<{ x: number; transform: string; opacity: string }> = await page.evaluate(
      () => (window as unknown as PageWindow).__samples,
    );
    fs.writeFileSync(path.join(OUT, `flip-samples-${rm}.json`), JSON.stringify(samples, null, 1));
    const xs = new Set(samples.map((s) => s.x));
    if (rm === 'no-preference') {
      check(
        xs.size >= 10,
        `FLIP RUNNING→DONE passes through intermediate positions (${xs.size} distinct x in ${samples.length} frames)`,
      );
      await shoot(page, 'flip-after.png', false);
    } else {
      check(
        xs.size === 1 && samples.every((s) => s.transform === 'none'),
        `reduced motion: no travel (${xs.size} x, transforms none)`,
      );
      check(Number(samples[0]?.opacity) < 1, 'reduced motion: the moved card fades in instead');
    }
    const muts: string[] = await page.evaluate((b) => (window as unknown as PageWindow).__noopMutations(b), moved);
    check(
      muts.length === 0,
      `identical renders write nothing (reducedMotion=${rm}): ${muts.length} mutations ${muts.slice(0, 3).join(' | ')}`,
    );
    await ctx.close();
  }

  // Identical renders while a card is entering and while another is fading out.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await installMocks(page, makeBoard());
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  await openBoard(page);
  const next = makeBoard() as Record<string, Array<Record<string, unknown>>>;
  const gone = next.working.pop() as Record<string, unknown>; // Release notes leaves the board
  next.waiting.unshift({
    ...next.waiting[1],
    key: K('900'),
    title: 'Rotate staging keys',
    displayHeadline: 'Rotate staging keys',
    conversationId: 'conv-9',
  });
  const probe = await page.evaluate(
    ([b, newKey]) => {
      const w = window as unknown as PageWindow;
      w.renderBoard(b); // starts the entrance + the exit
      const entering = w._cardEls[newKey];
      const exiting = document.querySelector('.kanban-col > .card.is-exiting') as HTMLElement & { _exit?: Animation };
      const before = {
        enter: entering?._enter?.playState,
        enterTime: Number(entering?._enter?.currentTime ?? -1),
        exitConnected: !!exiting?.isConnected,
        exit: exiting?._exit?.playState,
      };
      const muts = w.__noopMutations(b); // two identical renders right away
      return {
        before,
        muts,
        after: {
          enter: entering?._enter?.playState,
          enterTime: Number(entering?._enter?.currentTime ?? -1),
          exitConnected: !!exiting?.isConnected,
          exit: exiting?._exit?.playState,
        },
      };
    },
    [next, K('900')] as const,
  );
  log(`entry/exit probe: ${JSON.stringify(probe)}`);
  check(
    probe.before.enter === 'running' && probe.after.enter === 'running',
    'identical renders leave a running entrance running',
  );
  check(probe.after.enterTime < 180, `the entrance was not finished early (t=${probe.after.enterTime}ms of 180)`);
  check(
    probe.before.exitConnected && probe.after.exitConnected && probe.after.exit === 'running',
    'identical renders leave a fading card in place',
  );
  check(probe.muts.length === 0, `identical renders during entry/exit write nothing (${probe.muts.length} mutations)`);
  await page.waitForTimeout(400);
  const leftovers = await page.evaluate(() => document.querySelectorAll('.card.is-exiting').length);
  check(
    leftovers === 0,
    `the faded card removes itself when its fade ends (${leftovers} left) — removed ${String(gone.title)}`,
  );
  await ctx.close();
}

async function deepLinkAndWorkLog(browser: import('playwright').Browser) {
  // The latest work-log page is held back until a live entry has arrived first.
  let releaseLatest: () => void = () => {};
  const hold = new Promise<void>((r) => {
    releaseLatest = r;
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await installMocks(page, makeBoard(), { holdLatestWorklog: hold });
  await openBoard(page, `?session=${encodeURIComponent('work:C123:1700000000.000100')}`);
  await page.waitForFunction(() => document.getElementById('slide-panel')?.classList.contains('open'), null, {
    timeout: 5000,
  });
  await page.evaluate(() =>
    (window as unknown as PageWindow).__wsSend({
      type: 'work_log',
      conversationId: 'conv-1',
      entry: { seq: 14, ts: Date.now(), kind: 'notice', text: 'live before HTTP' },
    }),
  );
  releaseLatest();
  await page.waitForFunction(() => document.querySelectorAll('#worklog-list .wl-entry').length >= 14, null, {
    timeout: 5000,
  });
  await page.waitForTimeout(400);
  const state = await page.evaluate((key) => {
    const card = document.querySelector(`[data-session-key="${key}"]`);
    const scroll = document.getElementById('panel-scroll') as HTMLElement;
    const wl = document.getElementById('panel-worklog') as HTMLElement;
    return {
      expanded: !!card?.classList.contains('is-expanded'),
      panelOpen: !!document.getElementById('slide-panel')?.classList.contains('open'),
      worklogTop: Math.round(wl.getBoundingClientRect().top - scroll.getBoundingClientRect().top),
      seqs: (window as unknown as PageWindow).__wlSeqs(),
    };
  }, K('100'));
  log(
    `deep link → ${JSON.stringify({ ...state, seqs: `${state.seqs[0]}..${state.seqs[state.seqs.length - 1]} (${state.seqs.length})` })}`,
  );
  check(
    state.expanded && state.panelOpen && state.worklogTop === 0,
    'deep link (Slack key without instance prefix) opens the card and the panel at the work log',
  );
  const inOrder = (s: number[]) => s.every((v, i) => i === 0 || v > s[i - 1]);
  check(
    state.seqs.length === 14 && state.seqs[0] === 1 && state.seqs[13] === 14 && inOrder(state.seqs),
    'a live entry that beat the HTTP page keeps the older batch, in seq order',
  );
  await shoot(page, 'deeplink-dark-1280.png', false);

  // Live duplicate + out-of-order entries.
  const seqs2: number[] = await page.evaluate(() => {
    const w = window as unknown as PageWindow;
    for (const entry of [
      { seq: 14, kind: 'final', text: 'duplicate — dropped' },
      { seq: 16, kind: 'tool', tool: 'Bash', text: 'npm run db:migrate -- --env production' },
      { seq: 15, kind: 'instruction', text: '좋아, prod에 적용해줘.' },
    ]) {
      w.__wsSend({ type: 'work_log', conversationId: 'conv-1', entry: { ts: Date.now(), ...entry } });
    }
    return w.__wlSeqs();
  });
  check(
    seqs2.length === 16 && inOrder(seqs2),
    `live duplicate dropped, out-of-order seq inserted in place (${seqs2.length} entries)`,
  );
  await shoot(page, 'deeplink-dark-1280-live-append.png', false);

  // Reconnect: the server log grew to 31; recovery pages forward from the
  // confirmed cursor — 16, since live 14–16 directly followed the HTTP page.
  WORKLOG_EXTRA['conv-1'] = 31 - 13;
  WORKLOG_CALLS.length = 0;
  await page.evaluate(() => (window as unknown as PageWindow).__wsReopen());
  await page.waitForTimeout(800);
  const seqs3: number[] = await page.evaluate(() => (window as unknown as PageWindow).__wlSeqs());
  const after = WORKLOG_CALLS.map((c) => c.afterSeq);
  log(`reconnect recovery afterSeq calls ${JSON.stringify(after)} → ${seqs3.length} entries`);
  check(
    JSON.stringify(after) === JSON.stringify([16, 21, 26]) && seqs3.length === 31 && inOrder(seqs3),
    'reconnect pages forward from the confirmed cursor while hasMore',
  );

  // Gap: a live entry that skips seqs backfills the hole from the cursor (31).
  WORKLOG_EXTRA['conv-1'] = 40 - 13;
  WORKLOG_CALLS.length = 0;
  await page.evaluate(() =>
    (window as unknown as PageWindow).__wsSend({
      type: 'work_log',
      conversationId: 'conv-1',
      entry: { seq: 40, ts: Date.now(), kind: 'final', text: 'live entry after a gap' },
    }),
  );
  await page.waitForTimeout(500);
  const seqs4: number[] = await page.evaluate(() => (window as unknown as PageWindow).__wlSeqs());
  const gapCalls = WORKLOG_CALLS.map((c) => c.afterSeq);
  check(
    JSON.stringify(gapCalls) === '[31,36]' && seqs4.length === 40 && inOrder(seqs4),
    `live seq 40 after 31 backfills 32–39 (afterSeq ${JSON.stringify(gapCalls)}, ${seqs4.length} entries)`,
  );

  // Permanent hole: the store jumped to a new seq block (40 → 1001). One
  // backfill confirms nothing exists in between; the next live entry is quiet.
  WORKLOG_CALLS.length = 0;
  for (const seq of [1001, 1002]) {
    await page.evaluate(
      (s) =>
        (window as unknown as PageWindow).__wsSend({
          type: 'work_log',
          conversationId: 'conv-1',
          entry: { seq: s, ts: Date.now(), kind: 'notice', text: `after the seq jump (${s})` },
        }),
      seq,
    );
    await page.waitForTimeout(300);
  }
  const holeCalls = WORKLOG_CALLS.map((c) => c.afterSeq);
  const seqs5: number[] = await page.evaluate(() => (window as unknown as PageWindow).__wlSeqs());
  check(
    JSON.stringify(holeCalls) === '[40]' && seqs5.slice(-2).join() === '1001,1002' && inOrder(seqs5),
    `permanent seq hole 40 → 1001: one backfill, then none (afterSeq ${JSON.stringify(holeCalls)})`,
  );
  await ctx.close();

  // Empty log + reconnect → explicit afterSeq=0; missing route → "작업 로그 없음".
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page2 = await ctx2.newPage();
  WORKLOG.empty = [];
  const emptyBoard = makeBoard() as Record<string, Array<Record<string, unknown>>>;
  emptyBoard.working[1].conversationId = 'empty'; // Release notes: a conversation with no log yet
  emptyBoard.closed[0].conversationId = 'conv-denied'; // Cron scheduler fix: someone else's session (403)
  emptyBoard.closed[1].conversationId = 'conv-flaky'; // OAuth token refresh: 502, then 403
  await installMocks(page2, emptyBoard);
  await openBoard(page2);
  await page2.evaluate((key) => (window as unknown as PageWindow).openPanel(key, true), K('400'));
  await page2.waitForTimeout(400);
  WORKLOG.empty = [{ seq: 1, ts: NOW, kind: 'narration', text: 'first entry after reconnect' }];
  WORKLOG_CALLS.length = 0;
  await page2.evaluate(() => (window as unknown as PageWindow).__wsReopen());
  await page2.waitForTimeout(400);
  const emptyCalls = WORKLOG_CALLS.map((c) => c.afterSeq);
  const emptySeqs: number[] = await page2.evaluate(() => (window as unknown as PageWindow).__wlSeqs());
  check(
    JSON.stringify(emptyCalls) === '[0]' && emptySeqs.join() === '1',
    `empty-log reconnect asks afterSeq=0 (${JSON.stringify(emptyCalls)})`,
  );
  await page2.evaluate((key) => (window as unknown as PageWindow).openPanel(key, true), K('500'));
  await page2.waitForTimeout(400);
  const txt = await page2.evaluate(() => document.getElementById('worklog-list')?.textContent);
  check(txt === '작업 로그 없음', `work-log 404 reads "${txt}"`);

  // 403 (not the session owner): its own message, and no retry on reconnect.
  await page2.evaluate((key) => (window as unknown as PageWindow).openPanel(key, true), K('600'));
  await page2.waitForTimeout(400);
  WORKLOG_CALLS.length = 0;
  await page2.evaluate(() => (window as unknown as PageWindow).__wsReopen());
  await page2.waitForTimeout(300);
  const denied = await page2.evaluate(() => document.getElementById('worklog-list')?.textContent);
  check(
    denied === '작업 로그는 세션 소유자만 볼 수 있어요' && WORKLOG_CALLS.length === 0,
    `work-log 403 reads "${denied}" and is not retried (${WORKLOG_CALLS.length} requests on reconnect)`,
  );
  await shoot(page2, 'worklog-403-light-1280.png', false);

  // First load fails transiently (502), the reconnect's retry answers 403.
  await page2.evaluate((key) => (window as unknown as PageWindow).openPanel(key, true), K('700'));
  await page2.waitForTimeout(400);
  const afterFirst = await page2.evaluate(() => document.getElementById('worklog-list')?.textContent);
  await page2.evaluate(() => (window as unknown as PageWindow).__wsReopen());
  await page2.waitForTimeout(400);
  const afterRecovery = await page2.evaluate(() => document.getElementById('worklog-list')?.textContent);
  check(
    afterFirst === '작업 로그 없음' &&
      afterRecovery === '작업 로그는 세션 소유자만 볼 수 있어요' &&
      FLAKY_CALLS.n === 2,
    `502 then 403 on recovery shows the owner-only message ("${afterFirst}" → "${afterRecovery}", ${FLAKY_CALLS.n} calls)`,
  );
  await ctx2.close();
}

/** Round-2 review scenarios: hostile choices, panel reading position, no-conversation panel, sibling cards over WS. */
async function reviewScenarios(browser: import('playwright').Browser) {
  const board = makeBoard() as Record<string, Array<Record<string, unknown>>>;
  const HOSTILE_Q = 'Merge "dupes" now? it\'s <b>safe</b> \\ path\nline 2';
  const HOSTILE_LABEL = 'Yes "go" \'now\' <i>x</i> \\';
  board.waiting[1].pendingQuestion = {
    type: 'user_choice',
    question: HOSTILE_Q,
    choices: [
      { id: '1', label: HOSTILE_LABEL },
      { id: '2', label: '<img src=x onerror=alert(1)>' },
    ],
    recommendedChoiceId: '1',
  };
  board.working[1].conversationId = undefined; // Release notes: no recorded conversation
  board.idle[0].conversationId = 'conv-long'; // Weekly digest: 100 turns
  board.working[0].conversationId = 'conv-long2'; // Review PR: another 100 turns
  board.idle.push({
    ...board.idle[0],
    key: 'oud::work:C9:1700000000.000900',
    title: 'Sibling instance session',
    displayHeadline: 'Sibling instance session',
    conversationId: 'conv-sib',
    environment: { instanceName: 'oud', host: '127.0.0.1', port: 33999 },
  });
  TURNS['conv-long'] = Array.from({ length: 100 }, (_, i) => ({
    id: `L${i + 1}`,
    role: i % 2 ? 'assistant' : 'user',
    userName: 'Zhuge',
    timestamp: NOW - (100 - i) * M,
    rawContent: i % 2 ? undefined : `instruction ${i + 1}`,
    summarized: true,
    summaryTitle: i % 2 ? `reply ${i + 1}` : undefined,
    summaryBody: i % 2 ? 'body' : undefined,
  }));
  TURNS['conv-long2'] = (TURNS['conv-long'] as Array<Record<string, unknown>>).map((x) => ({
    ...x,
    id: `M${String(x.id).slice(1)}`,
  }));

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installMocks(page, board);
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  await openBoard(page);

  // B — the choice click sends exactly what the model wrote, and injects nothing.
  const crm = `[data-session-key="${K('200')}"]`;
  await page.click(`${crm} .card-face`);
  await page.waitForTimeout(400);
  const injected = await page.evaluate(
    (sel) => document.querySelectorAll(`${sel} b, ${sel} i, ${sel} img`).length,
    crm,
  );
  await page.click(`${crm} .btn-choice-recommended`);
  await page.waitForTimeout(300);
  const sent = ANSWERS[ANSWERS.length - 1] || {};
  check(injected === 0, `hostile choice text renders as text (${injected} injected elements)`);
  check(
    sent.question === HOSTILE_Q && sent.label === HOSTILE_LABEL && sent.choiceId === '1',
    `choice click posts the exact question / label (${JSON.stringify(sent).slice(0, 120)})`,
  );
  await shoot(page, 'review-hostile-choice.png', false);

  // E — a card without a conversation still opens the panel.
  await page.click(`[data-session-key="${K('400')}"] .card-face`);
  await page.waitForTimeout(300);
  await page.click(`[data-session-key="${K('400')}"] .btn-primary`);
  await page.waitForTimeout(300);
  const noConv = await page.evaluate(() => ({
    open: !!document.getElementById('slide-panel')?.classList.contains('open'),
    log: document.getElementById('worklog-list')?.textContent,
    input: !!document.getElementById('cmd-input'),
  }));
  check(
    noConv.open && noConv.log === '작업 로그 없음' && noConv.input,
    `card without a conversation opens the panel (${JSON.stringify(noConv)})`,
  );
  await page.evaluate(() => (window as unknown as PageWindow).closePanel());

  // D — older turns load without moving what the reader is looking at. Positions
  // are set instantly; the panel itself scrolls smoothly, so each check also
  // re-measures 400 ms later to catch any glide.
  await page.evaluate((key) => (window as unknown as PageWindow).openPanel(key), K('500'));
  await page.waitForFunction(() => document.querySelectorAll('#panel-turns .turn').length >= 30, null, {
    timeout: 5000,
  });
  await page.waitForTimeout(500);
  const hold = (which: 'turn' | 'worklog') =>
    page.evaluate((w) => (window as unknown as PageWindow).__holdProbe(w), which);
  const turnHold = await hold('turn');
  check(
    turnHold.turnsAfter > turnHold.turnsBefore && Math.abs(turnHold.at0) <= 1 && Math.abs(turnHold.at400) <= 1,
    `older turns keep the turn being read in place (${JSON.stringify(turnHold)})`,
  );
  const logHold = await hold('worklog');
  check(
    logHold.turnsAfter > logHold.turnsBefore && Math.abs(logHold.at0) <= 1 && Math.abs(logHold.at400) <= 1,
    `older turns below the work log do not move it (${JSON.stringify(logHold)})`,
  );
  await page.evaluate(() => (window as unknown as PageWindow).closePanel());

  // The reader scrolls while the older-turns request is still pending: what
  // they read after that scroll stays put, and their scroll is not undone.
  let releaseTurns: () => void = () => {};
  let turnsHeld = false;
  await page.route(/\/api\/dashboard\/session\/conv-long\?.*before=/, async (r) => {
    turnsHeld = true;
    await new Promise<void>((res) => {
      releaseTurns = res;
    });
    await r.fallback();
  });
  await page.evaluate((key) => (window as unknown as PageWindow).openPanel(key), K('500'));
  await page.waitForFunction(() => document.querySelectorAll('#panel-turns .turn').length >= 30, null, {
    timeout: 5000,
  });
  await page.waitForTimeout(400);
  const turnsAtStart: number = await page.evaluate(() => (window as unknown as PageWindow).__beginPendingLoad());
  for (let i = 0; i < 50 && !turnsHeld; i++) await page.waitForTimeout(20);
  const found: boolean = await page.evaluate(() => (window as unknown as PageWindow).__scrollWhilePending(240));
  releaseTurns();
  const pendingHold = await page.evaluate(() => (window as unknown as PageWindow).__afterPending());
  check(
    turnsHeld &&
      found &&
      pendingHold.turns > turnsAtStart &&
      Math.abs(pendingHold.moved) <= 1 &&
      pendingHold.scrollTopKeptOrGrew,
    `scrolling during a pending older-turns load is kept (${JSON.stringify(pendingHold)})`,
  );
  await page.unroute(/\/api\/dashboard\/session\/conv-long\?.*before=/);
  await page.evaluate(() => (window as unknown as PageWindow).closePanel());

  // A stale older-turns response (panel switched, or the same session closed
  // and reopened) must neither land in the new panel nor clear its in-flight flag.
  const held: Array<{ conv: string; release: () => void }> = [];
  const heldRe = /\/api\/dashboard\/session\/conv-long2?\?.*before=/;
  await page.route(heldRe, async (r) => {
    const conv = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    await new Promise<void>((res) => {
      held.push({ conv, release: res });
    });
    await r.fallback();
  });
  const pw = () =>
    page.evaluate(() => (window as unknown as PageWindow).__turnState()) as Promise<{
      turns: number;
      loading: boolean;
    }>;
  const openAndWait = async (key: string) => {
    await page.evaluate((k) => (window as unknown as PageWindow).openPanel(k), key);
    await page.waitForFunction(() => document.querySelectorAll('#panel-turns .turn').length >= 30, null, {
      timeout: 5000,
    });
    await page.waitForTimeout(200);
  };
  const waitHeld = async (n: number) => {
    for (let i = 0; i < 100 && held.length < n; i++) await page.waitForTimeout(20);
  };
  const startLoad = () => page.evaluate(() => (window as unknown as PageWindow).__startLoadMore());

  // Switch: A (conv-long) pending → open B (conv-long2) → B pending → A settles.
  await openAndWait(K('500'));
  await startLoad();
  await waitHeld(1);
  await openAndWait(K('300'));
  await startLoad();
  await waitHeld(2);
  held[0].release(); // A's stale response
  await page.waitForTimeout(400);
  const afterStaleA = await pw();
  const extra = await startLoad(); // must be refused: B is still loading
  await page.waitForTimeout(150);
  const requestsAfterRetry = held.length;
  held[1].release();
  await page.waitForTimeout(400);
  const afterB = await pw();
  check(
    afterStaleA.turns === 30 &&
      afterStaleA.loading &&
      extra &&
      requestsAfterRetry === 2 &&
      afterB.turns === 60 &&
      !afterB.loading,
    `stale response after a panel switch is dropped and keeps B's in-flight flag (${JSON.stringify({ afterStaleA, requestsAfterRetry, afterB })})`,
  );
  await page.evaluate(() => (window as unknown as PageWindow).closePanel());

  // Reopen: the same session closed and reopened while its older-turns load is pending.
  await openAndWait(K('500'));
  await startLoad();
  await waitHeld(3);
  await page.evaluate(() => (window as unknown as PageWindow).closePanel());
  await openAndWait(K('500'));
  await startLoad();
  await waitHeld(4);
  held[2].release(); // the first opening's stale response
  await page.waitForTimeout(400);
  const afterStaleReopen = await pw();
  held[3].release();
  await page.waitForTimeout(400);
  const afterReopen = await pw();
  check(
    afterStaleReopen.turns === 30 && afterStaleReopen.loading && afterReopen.turns === 60 && !afterReopen.loading,
    `stale response after close + reopen of the same session is dropped (${JSON.stringify({ afterStaleReopen, afterReopen })})`,
  );
  await page.unroute(heldRe);
  await page.evaluate(() => (window as unknown as PageWindow).closePanel());

  // F — a WS push (this instance only) keeps the sibling card's node and writes nothing.
  const selfOnly = JSON.parse(JSON.stringify(board));
  selfOnly.idle = selfOnly.idle.filter((s: Record<string, unknown>) => !s.environment);
  const sib = await page.evaluate((b) => {
    const w = window as unknown as PageWindow;
    const node = w._cardEls['oud::work:C9:1700000000.000900'];
    clearInterval(w._timerTick);
    const kb = document.getElementById('kanban') as HTMLElement;
    const obs = new MutationObserver(() => {});
    obs.observe(kb, { subtree: true, childList: true, attributes: true, characterData: true });
    w.__wsSend({ type: 'session_update', board: b });
    const recs = obs.takeRecords().length;
    obs.disconnect();
    const now = w._cardEls['oud::work:C9:1700000000.000900'];
    return {
      same: !!node && node === now,
      connected: !!now?.isConnected,
      exiting: !!now?.classList.contains('is-exiting'),
      recs,
    };
  }, selfOnly);
  check(
    sib.same && sib.connected && !sib.exiting && sib.recs === 0,
    `WS session_update keeps the sibling card (${JSON.stringify(sib)})`,
  );
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

/** Opus round-2 findings: hostile panel numbers, live entries then 403, long choice labels at 390. */
async function addendumChecks(browser: import('playwright').Browser) {
  const board = makeBoard() as Record<string, Array<Record<string, unknown>>>;
  const LONG_URL = `https://example.com/${'very-long-path-segment-'.repeat(12)}end?query=${'x'.repeat(60)}`;
  (board.waiting[0].pendingQuestion as { choices: Array<{ id: string; label: string }> }).choices.push({
    id: '3',
    label: LONG_URL,
  });
  board.idle[0].tokenUsage = {
    totalInputTokens: '<img src=x onerror="window.__pwned=1">',
    totalOutputTokens: '"><b>out</b>',
    totalCostUsd: '<i>cost</i>',
    contextUsagePercent: '<u>ctx</u>',
  };
  board.idle[0].mergeStats = { totalLinesAdded: '<img src=y onerror="window.__pwned=2">', totalLinesDeleted: '"x' };
  board.working[1].conversationId = 'conv-denied'; // Release notes: someone else's log (403, held)
  let releaseDenied: () => void = () => {};
  const holdDenied = new Promise<void>((r) => {
    releaseDenied = r;
  });

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 900 },
    colorScheme: 'light',
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installMocks(page, board, { holdDenied });
  await openBoard(page);

  // 4 — a long unbroken choice label wraps inside the open card at 390px.
  await page.click(`[data-session-key="${K('100')}"] .card-face`);
  await page.waitForTimeout(450);
  const clip = await page.evaluate((key) => {
    const card = document.querySelector(`[data-session-key="${key}"]`) as HTMLElement;
    const cr = card.getBoundingClientRect();
    const btns = Array.from(card.querySelectorAll('.btn-choice')) as HTMLElement[];
    return {
      buttons: btns.length,
      clipped: btns.filter((b) => b.scrollWidth > b.clientWidth + 1).length,
      // Either edge: the choices row is right-aligned, so a too-wide button
      // spills out on the LEFT, where the open card clips it.
      outside: btns.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.left < cr.left - 0.5 || r.right > cr.right + 0.5;
      }).length,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  }, K('100'));
  check(
    clip.buttons === 3 && clip.clipped === 0 && clip.outside === 0 && clip.overflow === 0,
    `long URL choice wraps inside the card at 390 (${JSON.stringify(clip)})`,
  );
  await shoot(page, 'addendum-390-long-choice.png', true);

  // 1 — hostile token / merge values: no injection, and the panel opens fully.
  const openError = await page
    .evaluate((key) => (window as unknown as PageWindow).openPanel(key, true), K('500'))
    .then(
      () => null,
      (e: Error) => e.message.split('\n')[0],
    );
  await page.waitForTimeout(500);
  const panel = await page.evaluate(() => ({
    open: !!document.getElementById('slide-panel')?.classList.contains('open'),
    injected: document.querySelectorAll('#panel-tokens img, #panel-tokens b, #panel-tokens i, #panel-tokens u').length,
    pwned: (window as unknown as PageWindow).__pwned ?? null,
    worklog: document.getElementById('worklog-list')?.textContent,
    tokens: document.getElementById('panel-tokens')?.textContent,
  }));
  check(
    openError === null &&
      panel.open &&
      panel.injected === 0 &&
      panel.pwned === null &&
      panel.worklog === '작업 로그 없음',
    `hostile panel numbers: no injection, panel open, work log loaded (${JSON.stringify({ openError, ...panel })})`,
  );
  await page.evaluate(() => (window as unknown as PageWindow).closePanel());

  // 2 — live entries painted before a 403 are replaced by the owner-only message.
  await page.evaluate((key) => (window as unknown as PageWindow).openPanel(key, true), K('400'));
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    for (const seq of [1, 2, 3]) {
      (window as unknown as PageWindow).__wsSend({
        type: 'work_log',
        conversationId: 'conv-denied',
        entry: { seq, ts: Date.now(), kind: 'tool', tool: 'Bash', text: `live before the 403 (${seq})` },
      });
    }
  });
  const beforeDeny = await page.evaluate(() => document.querySelectorAll('#worklog-list .wl-entry').length);
  releaseDenied();
  await page.waitForTimeout(400);
  const afterDeny = await page.evaluate(() => ({
    entries: document.querySelectorAll('#worklog-list .wl-entry').length,
    text: document.getElementById('worklog-list')?.textContent,
  }));
  check(
    beforeDeny === 3 && afterDeny.entries === 0 && afterDeny.text === '작업 로그는 세션 소유자만 볼 수 있어요',
    `live entries before a 403 give way to the owner-only message (${beforeDeny} → ${JSON.stringify(afterDeny)})`,
  );
  check(errors.length === 0, `addendum: no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

/** The served page with real timers: card 지시/응답 during an endpoint outage. */
async function cardIoOutage(browser: import('playwright').Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installMocks(page, makeBoard());
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  // Registered after installMocks, so it answers the card's ?limit=2 requests first.
  let down = true;
  const ioRequests: number[] = [];
  await page.route(/\/api\/dashboard\/session\/conv-1\?limit=2$/, (r) => {
    ioRequests.push(Date.now());
    if (down) return r.fulfill({ status: 500, json: { error: 'boom' } });
    return r.fallback();
  });
  await openBoard(page);
  const key = K('100');
  await page.click(`[data-session-key="${key}"] .card-face`); // the opening fetch (fails)
  for (let i = 0; i < 50 && ioRequests.length < 1; i++) await page.waitForTimeout(10);
  const t1 = ioRequests[0];
  // Board pushes with a new lastActivity every 100 ms while the endpoint is down
  // (~500 ms of pushes leaves headroom before the 1 s deadline on a loaded host).
  for (let i = 1; i <= 5; i++) {
    const b = makeBoard() as Record<string, Array<Record<string, unknown>>>;
    b.waiting[0].lastActivity = new Date(NOW + i * 1000).toISOString();
    await page.evaluate((board) => (window as unknown as PageWindow).__wsSend({ type: 'session_update', board }), b);
    await page.waitForTimeout(100);
  }
  const beforeDeadline = ioRequests.length;
  const elapsed = Date.now() - t1;
  down = false; // the endpoint recovers before the 1 s deadline
  await page.waitForTimeout(1400);
  const gaps = ioRequests.map((x) => x - t1);
  const card = await page.evaluate(
    (k) => ({
      instruction: document.querySelector(`[data-session-key="${k}"] .io-in .io-text`)?.textContent ?? null,
      response: document.querySelector(`[data-session-key="${k}"] .io-out .io-text`)?.textContent ?? null,
    }),
    key,
  );
  log(
    `card I/O outage: requests at ${JSON.stringify(gaps)} ms (renders until ${elapsed} ms), card ${JSON.stringify(card)}`,
  );
  check(
    beforeDeadline === 1 && elapsed < 1000,
    `outage: 5 re-renders with new stamps send nothing before the deadline (${beforeDeadline} request(s) in ${elapsed} ms)`,
  );
  check(
    ioRequests.length === 2 && gaps[1] >= 950 && gaps[1] <= 1600,
    `outage: exactly one request at the 1 s deadline (${JSON.stringify(gaps)})`,
  );
  check(
    !!card.instruction &&
      card.instruction.includes('staging에서 dry run') &&
      !!card.response &&
      card.response.includes('Dry run on staging passed'),
    'outage: after recovery the open card shows 지시/응답',
  );
  check(errors.length === 0, `outage: no page errors (${errors.join(' | ')})`);
  await shoot(page, 'card-io-outage-recovered-1280.png', false);
  await ctx.close();
}

// Panel A's generated subtitle lands after panel B opened: B keeps its own.
async function titleSubPanelSwitch(browser: import('playwright').Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installMocks(page, makeBoard());
  // The mocked session GET has no titleSub, so every panel opening asks for one.
  let releaseA: () => void = () => {};
  const aHeld = new Promise<void>((r) => {
    releaseA = r;
  });
  const posts: string[] = [];
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/generate-title$/, async (r) => {
    const conv = decodeURIComponent(new URL(r.request().url()).pathname.split('/')[4] || '');
    posts.push(conv);
    if (conv === 'conv-1') await aHeld;
    return r.fulfill({ json: { titleSub: `subtitle of ${conv}` } });
  });
  await openBoard(page);
  const sub = () => page.evaluate(() => document.getElementById('panel-title-sub-text')?.textContent ?? null);
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i++) await page.waitForTimeout(20);
  };
  await page.evaluate((k) => (window as unknown as PageWindow).openPanel(k), K('100')); // panel A
  await waitFor(() => posts.includes('conv-1'));
  const whileHeld = await sub();
  await page.evaluate((k) => (window as unknown as PageWindow).openPanel(k), K('200')); // panel B
  await waitFor(() => posts.includes('conv-2'));
  await page.waitForTimeout(300);
  const bBefore = await sub();
  releaseA(); // A's response lands late
  await page.waitForTimeout(400);
  const bAfter = await sub();
  log(`titleSub panel switch: ${JSON.stringify({ posts, whileHeld, bBefore, bAfter })}`);
  check(
    whileHeld === 'Generating title...' && bBefore === 'subtitle of conv-2' && bAfter === 'subtitle of conv-2',
    `titleSub: A's late response does not overwrite panel B's subtitle (${JSON.stringify({ bBefore, bAfter })})`,
  );
  check(errors.length === 0, `titleSub: no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

async function main() {
  const dashboard = await import('../src/conversation/dashboard');
  dashboard.setDashboardSessionAccessor(() => new Map());
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  const browser = await chromium.launch({ headless: true });
  try {
    await viewportMatrix(browser);
    await motion(browser);
    await deepLinkAndWorkLog(browser);
    await reviewScenarios(browser);
    await addendumChecks(browser);
    await cardIoOutage(browser);
    await titleSubPanelSwitch(browser);
  } finally {
    await browser.close();
    await ws.stopWebServer();
  }
  fs.writeFileSync(path.join(OUT, 'report.txt'), `${report.join('\n')}\n`);
  log(
    `\n${report.filter((l) => l.startsWith('[ok]')).length}/${report.filter((l) => /^\[(ok|FAIL)/.test(l)).length} checks passed — ${OUT}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
