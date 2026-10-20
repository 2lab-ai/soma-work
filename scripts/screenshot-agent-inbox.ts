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
 *   - work-log tool rows print the tool name once, with the emitter's stored
 *     text shape ("Read {...}", "Glob ok")
 *   - stats strip (1280 / 820 / 390 × light / dark): above the board, collapsed
 *     to period · 세션 · 토큰 · 비용 · 자세히 — one row from 640px, two below with
 *     44px targets; 자세히 opens the other cards and the charts between the strip
 *     and the board, survives a reload, and never scrolls the page sideways
 *     (stats-strip-*.png)
 *   - archives (light / dark × 1280 / 390): archived cards are hidden by default,
 *     Archives (N) — a toggle button, aria-pressed — shows them and survives a reload, the DONE count is what
 *     DONE shows, Show older counts only what it would add, and a deep link to
 *     a hidden archive (recent or 9 days old) still opens it without changing
 *     the stored choice (archives-*.png)
 *   - All Users: every card names its owner in a right-aligned badge, one colour
 *     per owner, text ≥4.5:1 on its fill, never over the title, long names
 *     ellipsized with the full name in title; gone once a user is selected
 *     (owner-badges-*.png)
 *   - side panel (light / dark × 1280 / 390): Tasks pinned above the scroll area
 *     (also with no tasks), the work log collapsed unless opened from 작업 로그,
 *     its count live while collapsed, expanding without a refetch; every entry
 *     opens its full raw output (fetched once, cached), the truncated note, the
 *     404 / 503 + 다시 시도 lines, the entry text when no raw is stored, copy,
 *     keyboard, a late answer for a closed row dropped, no tail-follow yank
 *     (panel-*.png)
 *   - stats: 오늘 → 지난 7일 changes 세션 / 토큰 / 비용 to the week's totals
 *     (stats + usage requests carry the period; All Users sends no userId), and
 *     a late answer for a period no longer selected does not repaint them
 *   - top bar, Chromium and WebKit, 360–1280px × status × pill name × selected
 *     user (see topbarChecks): no control label wraps or is cut, no two
 *     controls overlap, none leaves the viewport, each is reachable across its
 *     box and ≥44px tall below 640px, only user names end in an ellipsis (full
 *     name in title), the status badge keeps role="status" + a state
 *     aria-label, and the page never scrolls sideways (topbar-*.png)
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-agent-inbox.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page, webkit } from 'playwright';

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
/** archivedToKanban's key for an archived session: "<inst>::archived_<registry key>_<archivedAt>". */
const ARCHIVED_AT: Record<string, number> = {
  '700': NOW - 2 * 24 * 60 * M + 5 * M,
  '800': NOW - 9 * 24 * 60 * M + 5 * M,
};
const KA = (n: string) => `mock-inst::archived_work:C123:1700000000.000${n}_${ARCHIVED_AT[n]}`;

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
        key: KA('700'),
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
        key: KA('800'),
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

/** The owners of the team board (All Users view): one name long enough to ellipsize. */
// Slack-style member ids. A bare hash % 8 puts Zhuge and Alice on one hue and
// Carol and Dana on another; the board assigns them distinct ones.
const TEAM = [
  { id: 'U01ZHG7K2QD', name: 'Zhuge' },
  { id: 'U07KQ2M4XR1', name: 'Alice' },
  { id: 'U03BN8TZP6E', name: 'Bob' },
  { id: 'U05HJ1WQ9DA', name: 'Carol' },
  { id: 'U06TF4YQ8BN', name: 'Dana Alexandria Montgomery-Wellington' },
];
const [ZHUGE, ALICE, BOB, CAROL, DANA] = TEAM.map((t) => t.id);
/** makeBoard() with the cards spread over five owners (Alice twice). */
function makeTeamBoard() {
  const b = makeBoard() as Record<string, Array<Record<string, unknown>>>;
  const owner: Record<string, string> = {
    [K('100')]: ALICE,
    [K('200')]: BOB,
    [K('300')]: CAROL,
    [K('400')]: ALICE,
    [K('500')]: DANA,
    [K('600')]: ZHUGE,
    [KA('700')]: BOB,
    [KA('800')]: CAROL,
  };
  for (const col of Object.values(b)) {
    for (const card of col) {
      const t = TEAM.find((u) => u.id === owner[card.key as string]);
      if (t) Object.assign(card, { ownerId: t.id, ownerName: t.name });
    }
  }
  return b;
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
    // Tool rows in the emitter's stored shape (packages/slack/src/stream-processor.ts):
    // `text` starts with the tool name — the row must still print the name once.
    { seq: 3, ts: NOW - 9 * M + 6000, kind: 'tool', tool: 'Read', text: 'Read {"file_path":"db/schema.sql"}' },
    { seq: 4, ts: NOW - 9 * M + 6500, kind: 'tool_result', tool: 'Read', ok: true, text: 'Read ok' },
    {
      seq: 5,
      ts: NOW - 8 * M,
      kind: 'tool',
      tool: 'Grep',
      text: 'Grep {"pattern":"users\\\\b","path":"db/migrations"}',
    },
    { seq: 6, ts: NOW - 8 * M + 900, kind: 'tool_result', tool: 'Grep', ok: true, text: 'Grep ok' },
    {
      seq: 7,
      ts: NOW - 6 * M,
      kind: 'narration',
      text: 'Writing 0042_split_users: accounts keeps auth columns, profiles gets the rest.',
    },
    {
      seq: 8,
      ts: NOW - 5 * M,
      kind: 'tool',
      tool: 'Bash',
      text: 'Bash {"command":"npm run db:migrate -- --env staging --dry-run"}',
    },
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

/**
 * Stored raw output (GET …/worklog/:seq/raw) for the panel scenario's
 * conversation. Its list entries carry rawBytes for 3, 4, 6, 9, 11 and 12: 3
 * and 4 answer 200 (multi-line), 9 answers 200 truncated, 6 has no stored raw
 * (404), 11 fails at the network once, then answers 200, and 12 answers 503
 * (the log is damaged — the same answer every time).
 */
const RAW_STORE: Record<string, Record<number, { raw: string; rawBytes: number; rawTruncated?: boolean }>> = {
  'conv-panel': {
    3: {
      raw: JSON.stringify({ file_path: 'db/schema.sql', offset: 0, limit: 400 }, null, 2),
      rawBytes: 64,
    },
    4: {
      raw: [
        'CREATE TABLE users (',
        '  id          bigint PRIMARY KEY,',
        '  email       text NOT NULL UNIQUE,',
        '  password    text NOT NULL,',
        '  display     text,',
        '  created_at  timestamptz NOT NULL DEFAULT now()',
        ');',
      ].join('\n'),
      rawBytes: 196,
    },
    9: {
      raw: Array.from(
        { length: 60 },
        (_, i) => `[${String(i).padStart(2, '0')}] migrate 0042_split_users: relation "profiles" already exists`,
      ).join('\n'),
      rawBytes: 1_048_576,
      rawTruncated: true,
    },
    11: {
      raw: '> db:migrate --env staging --dry-run --reset\nreset 3 tables\nmigrated 0042_split_users\ndone in 41s',
      rawBytes: 98,
    },
  },
};
/** The entries the panel scenario lists: conv-1's log, with rawBytes where raw output was stored. */
function panelLog() {
  const bytes: Record<number, number> = { 3: 64, 4: 196, 6: 120, 9: 1_048_576, 11: 98, 12: 40 };
  return (WORKLOG['conv-1'] as Array<Record<string, unknown>>).map((e) => {
    const n = bytes[e.seq as number];
    return n ? { ...e, rawBytes: n, ...(e.seq === 9 ? { rawTruncated: true } : {}) } : { ...e };
  });
}
const RAW_CALLS: Array<{ conv: string; seq: number }> = [];
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
  // Every visible top-bar control: the text it shows, how many lines that text
  // takes, whether it is hard-cut (its own box, or a native select narrower than
  // its selected option), whether a user name in it (pill name, selected user)
  // ends in an ellipsis and the title that carries the full name, its height,
  // whether it sits inside the viewport, and whether a tap at its centre reaches it.
  // The stats strip (.prd/10 §3.1-2): its box and the board's, how many rows its
  // three parts (period · numbers · 자세히) take, its smallest button, and the 자세히 state.
  'window.__stripProbe = function () {',
  '  var box = function (el) { var q = el.getBoundingClientRect(); return { t: Math.round(q.top), b: Math.round(q.bottom), l: q.left, r: q.right }; };',
  '  var strip = document.querySelector(".stats-strip");',
  '  var more = document.getElementById("stats-more");',
  '  var parts = [strip.querySelector(".period-bar"), strip.querySelector(".strip-nums"), more].map(box);',
  '  var rows = [];',
  '  parts.forEach(function (p) { var mid = (p.t + p.b) / 2; if (!rows.some(function (m) { return Math.abs(m - mid) < 6; })) rows.push(mid); });',
  '  var heights = Array.prototype.map.call(strip.querySelectorAll("button"), function (b) { return Math.round(b.getBoundingClientRect().height); });',
  '  var detail = document.getElementById("stats-detail");',
  '  return {',
  '    stats: box(document.getElementById("stats")), board: box(document.getElementById("inbox")), rows: rows.length,',
  '    minTarget: Math.min.apply(null, heights), outside: parts.some(function (p) { return p.l < -0.5 || p.r > innerWidth + 0.5; }),',
  '    expanded: more.getAttribute("aria-expanded"), detailHidden: detail.hidden, detailH: Math.round(detail.getBoundingClientRect().height),',
  '    nums: Array.prototype.map.call(strip.querySelectorAll(".strip-num"), function (n) { return n.textContent; }),',
  '  };',
  '};',
  'window.__topbarProbe = function () {',
  '  var bar = document.querySelector(".topbar");',
  '  var els = Array.prototype.slice.call(bar.querySelectorAll("h1, .ws-badge, .user-select, select, a, button, .user-pill"))',
  '    .filter(function (el) { return !(el.tagName === "SELECT" && el.parentNode.classList.contains("user-select")); });',
  '  var range = document.createRange();',
  '  var items = [];',
  '  els.forEach(function (el) {',
  '    var cs = getComputedStyle(el);',
  '    var r = el.getBoundingClientRect();',
  '    if (cs.display === "none" || cs.visibility === "hidden" || r.width === 0) return;',
  '    var rects = [];',
  '    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);',
  '    var n;',
  '    while ((n = walker.nextNode())) {',
  '      if (!n.textContent.trim() || (n.parentNode.closest && n.parentNode.closest("select"))) continue;',
  '      range.selectNodeContents(n);',
  '      Array.prototype.forEach.call(range.getClientRects(), function (q) { if (q.width > 0 && q.height > 0) rects.push(q); });',
  '    }',
  '    rects.sort(function (a, b) { return a.top - b.top; });',
  '    var lines = 0, bottom = -Infinity;',
  '    rects.forEach(function (q) { if (q.top >= bottom - 1) { lines++; bottom = q.bottom; } else bottom = Math.max(bottom, q.bottom); });',
  '    var text = el.innerText.replace(/\\s+/g, " ").trim();',
  '    var wrap = el.classList.contains("user-select");',
  '    var nameEl = wrap ? el.querySelector(".user-select-label") : el.classList.contains("user-pill") ? el.querySelector("b") : null;',
  // Name boxes are judged by their parts (a part pushed past the box is cut):
  // WebKit counts a child's ellipsized text in the parent's scrollWidth.
  '    var clipped = nameEl',
  '      ? Array.prototype.some.call(el.children, function (k) { if (k.tagName === "SELECT") return false; var q = k.getBoundingClientRect(); return q.width > 0 && (q.left < r.left - 1 || q.right > r.right + 1); })',
  '      : el.scrollWidth > el.clientWidth + 1;',
  '    var name = null, nameTitle = "", ellipsized = false, target = el, covers = true;',
  '    if (nameEl) {',
  '      name = nameEl.textContent;',
  '      if (nameEl.scrollWidth > nameEl.clientWidth + 1) {',
  '        if (getComputedStyle(nameEl).textOverflow === "ellipsis") ellipsized = true; else clipped = true;',
  '      }',
  '      nameTitle = wrap ? el.querySelector("select").title : nameEl.getAttribute("title") || "";',
  '      if (wrap) {',
  '        target = el.querySelector("select"); text = name;',
  '        var sr = target.getBoundingClientRect();', // the tap target is exactly the visible box
  '        covers = Math.abs(sr.left - r.left) <= 1.5 && Math.abs(sr.right - r.right) <= 1.5 && Math.abs(sr.top - r.top) <= 1.5 && Math.abs(sr.bottom - r.bottom) <= 1.5;',
  '      }',
  '    }',
  '    if (el.tagName === "SELECT") {',
  '      var opt = el.options[el.selectedIndex];',
  '      text = name = opt ? opt.text : "";',
  '      nameTitle = el.title || "";',
  '      var probe = el.cloneNode(false);',
  '      probe.removeAttribute("id"); probe.removeAttribute("onchange");',
  '      var o = document.createElement("option"); o.textContent = text; probe.appendChild(o);',
  '      probe.style.cssText = "position:absolute;visibility:hidden;inline-size:auto;min-inline-size:0;max-inline-size:none;flex:none";',
  '      el.parentNode.appendChild(probe);',
  '      var need = probe.getBoundingClientRect().width;',
  '      probe.remove();',
  '      clipped = r.width + 0.5 < need; // a native select hard-cuts in WebKit',
  '      lines = 1;',
  '    }',
  '    if (!text) clipped = false; // icon-only (theme toggle): ::before glyph, ::after hit slop wider than the box',
  '    var dot = cs.textIndent !== "0px";',
  '    if (dot) { clipped = false; lines = 0; text = ""; }',
  // A tap near the left edge, at the centre and near the right edge must reach the control.
  '    var midY = r.top + r.height / 2;',
  '    var reaches = function (x) { var h = document.elementFromPoint(x, midY); return !!h && (h === target || target.contains(h)); };',
  '    var hit = [r.left + 3, r.left + r.width / 2, r.right - 3].every(reaches);',
  // The user select's chevron (its ::after, inside the right padding) must hand the tap to the select too.
  '    if (wrap) hit = hit && reaches(r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) - 4);',
  '    items.push({',
  '      el: el.id || el.className.split(" ")[0] || el.tagName.toLowerCase(),',
  '      text: text, label: el.getAttribute("aria-label") || el.getAttribute("title") || "", role: el.getAttribute("role") || "",',
  '      lines: lines, clipped: clipped, ellipsized: ellipsized, name: name, nameTitle: nameTitle, dot: dot,',
  '      h: Math.round(r.height), w: Math.round(r.width), outside: r.left < -0.5 || r.right > innerWidth + 0.5,',
  '      interactive: /^(SELECT|A|BUTTON)$/.test(el.tagName) || wrap || el.getAttribute("data-clickable") === "true",',
  '      hit: hit, covers: covers, box: { l: r.left, t: r.top, r: r.right, b: r.bottom },',
  '    });',
  '  });',
  '  var br = bar.getBoundingClientRect();',
  // overflow: sideways scroll of the page (0 = none). innerOverflow: against the
  // window, which in WebKit includes a classic scrollbar (then -8, not overflow).
  '  var de = document.documentElement;',
  '  return { items: items, bar: { h: Math.round(br.height), bottom: Math.ceil(br.bottom) }, overflow: de.scrollWidth - de.clientWidth, innerOverflow: de.scrollWidth - innerWidth };',
  '};',
].join('\n');

/**
 * What the stats / usage mocks answer per period: U001's own numbers, and the
 * All Users numbers (no userId) — sessions differ, tokens and cost are doubled.
 * None of them equals what the board's own cards add up to (8 cards, 1.7M
 * tokens, $11.63), so a strip still reading the session cache cannot pass.
 */
type Period = 'day' | 'week' | 'month';
const PERIOD_TOTALS: Record<Period, { sessions: number; all: number; input: number; output: number; cost: number }> = {
  day: { sessions: 6, all: 14, input: 1_000_000, output: 200_000, cost: 12.47 },
  week: { sessions: 37, all: 61, input: 9_000_000, output: 1_500_000, cost: 84.2 },
  month: { sessions: 112, all: 203, input: 30_000_000, output: 4_000_000, cost: 301.5 },
};
const PERIOD_DAYS: Record<Period, number> = { day: 1, week: 7, month: 30 };
/** The query string of every stats / usage request the mocks answered, in answer order. */
const STATS_CALLS: URLSearchParams[] = [];
const USAGE_CALLS: URLSearchParams[] = [];

function periodOf(q: URLSearchParams): Period {
  const p = q.get('period');
  return p === 'week' || p === 'month' ? p : 'day';
}

function statsBody(q: URLSearchParams) {
  const period = periodOf(q);
  const t = PERIOD_TOTALS[period];
  const sessions = q.get('userId') ? t.sessions : t.all;
  const n = PERIOD_DAYS[period];
  const days = Array.from({ length: n }, (_, i) => ({
    date: new Date(NOW - (n - 1 - i) * 24 * 60 * M).toISOString().slice(0, 10),
    sessionsCreated: Math.round(sessions / n) + (i % 3),
    turnsUsed: 0,
    prsCreated: 0,
    prsMerged: 0,
    commitsCreated: 0,
    linesAdded: 0,
    linesDeleted: 0,
    mergeLinesAdded: 40 + ((i * 37) % 90),
    mergeLinesDeleted: 5 + ((i * 11) % 20),
    workflowCounts: {},
  }));
  return {
    userId: q.get('userId') || null,
    period,
    totals: {
      sessionsCreated: sessions,
      turnsUsed: 41,
      prsCreated: 2,
      prsMerged: 1,
      commitsCreated: 9,
      linesAdded: 0,
      linesDeleted: 0,
      mergeLinesAdded: 254,
      mergeLinesDeleted: 33,
      workflowCounts: { zwork: 5, default: 3 },
    },
    days,
  };
}

function usageBody(q: URLSearchParams) {
  const period = periodOf(q);
  const t = PERIOD_TOTALS[period];
  const k = q.get('userId') ? 1 : 2;
  return {
    period,
    startDate: '2026-01-01',
    endDate: '2026-01-01',
    totals: {
      totalInputTokens: t.input * k,
      totalOutputTokens: t.output * k,
      totalCacheReadTokens: 5_000_000, // not part of the strip's token count
      totalCacheCreateTokens: 700_000,
      totalCostUsd: t.cost * k,
      byModel: {},
    },
    byUser: {},
    byDay: [],
    tokenRankings: [],
    costRankings: [],
    hasLegacyData: false,
  };
}

async function installMocks(
  page: Page,
  board: unknown,
  opts: { holdLatestWorklog?: Promise<void>; holdDenied?: Promise<void> } = {},
) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.route('**/auth/me', (r) => r.fulfill({ json: { user: { name: 'Zhuge' }, csrfToken: 'x' } }));
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => {
    const q = new URL(r.request().url()).searchParams;
    STATS_CALLS.push(q);
    return r.fulfill({ json: statsBody(q) });
  });
  await page.route('**/api/dashboard/usage**', (r) => {
    const q = new URL(r.request().url()).searchParams;
    USAGE_CALLS.push(q);
    return r.fulfill({ json: usageBody(q) });
  });
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
  // Raw output of one entry. Registered after the list route, which also
  // matches this URL, so this one answers. 12 is a damaged log (503 every
  // time); 11 fails at the network once per page, then answers.
  const failedOnce = new Set<string>();
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog\/\d+\/raw/, (r) => {
    const parts = new URL(r.request().url()).pathname.split('/');
    const conv = decodeURIComponent(parts[4] || '');
    const seq = Number(parts[6]);
    RAW_CALLS.push({ conv, seq });
    if (seq === 12) return r.fulfill({ status: 503, json: { error: 'unavailable' } });
    if (seq === 11 && !failedOnce.has(conv)) {
      failedOnce.add(conv);
      return r.abort('failed');
    }
    const hit = RAW_STORE[conv]?.[seq];
    if (!hit) return r.fulfill({ status: 404, json: { error: 'not_found' } });
    return r.fulfill({
      json: { seq, raw: hit.raw, rawBytes: hit.rawBytes, rawTruncated: hit.rawTruncated === true },
      headers: { 'Cache-Control': 'no-store' },
    });
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
      // §3.1-2: the stats strip leads, collapsed; the board follows it.
      await page.waitForFunction(() => document.getElementById('stat-cost')?.textContent !== '-', null, {
        timeout: 5000,
      });
      const sp = (await page.evaluate(() => (window as unknown as PageWindow).__stripProbe())) as StripProbe;
      check(
        sp.stats.b <= sp.board.t,
        `${theme} ${width}: the stats strip sits above the board (strip ${sp.stats.t}–${sp.stats.b}px, board from ${sp.board.t}px)`,
      );
      check(
        sp.expanded === 'false' && sp.detailHidden && sp.detailH === 0 && sp.nums.length === 3,
        `${theme} ${width}: stats strip collapsed by default — ${sp.nums.join(' · ')} + 자세히`,
      );
      check(
        sp.rows === (width < 640 ? 2 : 1) && !sp.outside && (width >= 640 || sp.minTarget >= 44),
        `${theme} ${width}: stats strip in ${width < 640 ? 'two rows, 44px targets' : 'one row'}, inside the viewport (rows ${sp.rows}, smallest button ${sp.minTarget}px)`,
      );
      if (width === 1280 || width === 390) await shoot(page, `stats-strip-${theme}-${width}.png`, false);
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
        // A tool row prints the tool name once, even when the stored text starts with it.
        const twice = await page.evaluate(() =>
          Array.from(document.querySelectorAll('#worklog-list .wl-tool, #worklog-list .wl-tool_result'))
            .map((row) => ({
              name: row.querySelector('.wl-tool-name')?.textContent ?? '',
              text: row.querySelector('.wl-text')?.textContent ?? '',
            }))
            .filter((r) => r.name && (r.text === r.name || r.text.startsWith(`${r.name} `)))
            .map((r) => `${r.name} ${r.text}`),
        );
        check(
          twice.length === 0,
          `${theme} ${width}: work-log tool rows print the tool name once (${twice.join(' | ')})`,
        );
        await page.click('#worklog-toggle'); // every opening starts collapsed; the shot is of the log
        await page.waitForTimeout(300);
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
    const scroll = (document.getElementById('panel-scroll') as HTMLElement).getBoundingClientRect();
    const head = (document.getElementById('worklog-toggle') as HTMLElement).getBoundingClientRect();
    return {
      expanded: !!card?.classList.contains('is-expanded'),
      panelOpen: !!document.getElementById('slide-panel')?.classList.contains('open'),
      worklog: document.getElementById('worklog-toggle')?.getAttribute('aria-expanded') ?? null,
      headerInView: head.top >= scroll.top - 0.5 && head.bottom <= scroll.bottom + 0.5,
      seqs: (window as unknown as PageWindow).__wlSeqs(),
    };
  }, K('100'));
  log(
    `deep link → ${JSON.stringify({ ...state, seqs: `${state.seqs[0]}..${state.seqs[state.seqs.length - 1]} (${state.seqs.length})` })}`,
  );
  check(
    state.expanded && state.panelOpen && state.worklog === 'false' && state.headerInView,
    'deep link (Slack key without instance prefix) opens the card and the panel with the collapsed work-log header in view',
  );
  const inOrder = (s: number[]) => s.every((v, i) => i === 0 || v > s[i - 1]);
  check(
    state.seqs.length === 14 && state.seqs[0] === 1 && state.seqs[13] === 14 && inOrder(state.seqs),
    'a live entry that beat the HTTP page keeps the older batch, in seq order',
  );
  await shoot(page, 'deeplink-dark-1280.png', false);
  await page.click('#worklog-toggle'); // the reader opens the log for the live-append checks below
  await page.waitForTimeout(300);

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
  await page2.evaluate((key) => (window as unknown as PageWindow).openPanel(key, true), KA('700'));
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

type StripProbe = {
  stats: { t: number; b: number };
  board: { t: number; b: number };
  rows: number;
  minTarget: number;
  outside: boolean;
  expanded: string | null;
  detailHidden: boolean;
  detailH: number;
  nums: string[];
};

type TopbarItem = {
  el: string;
  text: string;
  label: string;
  role: string;
  lines: number;
  clipped: boolean;
  ellipsized: boolean;
  name: string | null;
  nameTitle: string;
  dot: boolean;
  h: number;
  w: number;
  outside: boolean;
  interactive: boolean;
  hit: boolean;
  covers: boolean;
  box: { l: number; t: number; r: number; b: number };
};
type TopbarProbe = {
  items: TopbarItem[];
  bar: { h: number; bottom: number };
  overflow: number;
  innerOverflow: number;
};

/** How a user name (pill or selected user) must render: whole, ellipsized, or whichever fits. */
type NameRule = 'full' | 'ellipsis' | 'fit';

/**
 * Top bar matrix, Chromium and WebKit: widths 1280 / 1100 / 1040 / 1024 / 820 /
 * 640 (mouse and touch) and 390 / 360 / 320 (touch) × status (Connecting... → Live →
 * Reconnecting... → Live) × pill (bearer "★ Admin", "Zhuge Hyuk", a 32-character
 * Korean name) × selected user (All Users, Zhuge, Zhuge Hyuk, the Korean name).
 * Control labels never wrap or cut, no two controls overlap, none leaves the
 * viewport, and a tap at the left edge, centre and right edge of each control
 * reaches it; only user names may shrink — then with a visible ellipsis and the
 * full name in title; every control is ≥44px tall below 640px; the status badge
 * keeps role="status" and an aria-label that follows the socket (a 10px dot
 * below 640px); the page never scrolls sideways.
 */
async function topbarChecks(browser: import('playwright').Browser) {
  const LONG = '가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라';
  const REAL = 'Zhuge Hyuk';
  const USERS = [
    { id: 'U001', name: 'Zhuge' },
    { id: 'U002', name: LONG },
    { id: 'U003', name: REAL },
  ];
  const PILLS: Array<{ key: string; me: Record<string, unknown>; name: string }> = [
    { key: 'admin', me: { isAdmin: true }, name: 'Admin' },
    { key: 'named', me: { user: { name: REAL }, isAdmin: true }, name: REAL },
    { key: 'long', me: { user: { name: LONG }, isAdmin: true }, name: LONG },
  ];
  const SELECTS: Array<{ key: string; value: string; name: string }> = [
    { key: 'all', value: '', name: 'All Users' },
    { key: 'zhuge', value: 'U001', name: 'Zhuge' },
    { key: 'named', value: 'U003', name: REAL },
    { key: 'long', value: 'U002', name: LONG },
  ];
  // The Korean name is wider than the select's cap on the one-row bar (≥1024)
  // and than the 360px nav row, so it ends in an ellipsis there; on the 640–1023
  // nav row it fits and must show whole. 1024 and 390 may be either: WebKit's
  // classic scrollbar makes 1024 lay out as two rows, and at 390 the name is
  // within 2px of the nav row's width.
  const selRule = (name: string, w: number): NameRule =>
    name !== LONG ? 'full' : w === 1024 || w === 390 ? 'fit' : w >= 1040 || w < 640 ? 'ellipsis' : 'full';
  // A realistic pill name stays whole everywhere — also on the tightest one-row
  // bar ("Reconnecting...", touch padding, the Korean name selected at 1024).
  const pillRule = (name: string, _w: number): NameRule => (name === LONG ? 'ellipsis' : 'full');
  const LABELS: Array<[string, string]> = [
    ['h1', 'SOMA-WORK'],
    ['a', 'Conversations'],
    ['admin-mode-toggle', 'Admin: OFF'],
  ];
  const WS_LABEL = {
    connecting: 'WebSocket: Connecting',
    live: 'WebSocket: Live',
    reconnecting: 'WebSocket: Reconnecting',
  };
  const SHOTS: Record<string, [string, string, string]> = {
    '': ['admin', 'all', 'live'],
    '-named': ['named', 'zhuge', 'live'],
    '-selected-named': ['admin', 'named', 'live'],
    '-selected-long': ['admin', 'long', 'live'],
    '-long-longsel': ['long', 'long', 'live'],
    '-reconn-long-longsel': ['long', 'long', 'reconnecting'],
  };
  const configs: Array<{ width: number; touch: boolean }> = [
    ...[1280, 1100, 1040, 1024, 820, 640].flatMap((width) => [
      { width, touch: false },
      { width, touch: true },
    ]),
    { width: 390, touch: true },
    { width: 360, touch: true },
    { width: 320, touch: true },
  ];

  // WebKit too: its native <select> hard-cuts text and ignores min-height.
  const wk = await webkit.launch({ headless: true });
  try {
    for (const [engine, b] of [
      ['', browser],
      ['webkit-', wk],
    ] as const) {
      for (const cfg of configs) await topbarPage(b, engine, cfg.width, cfg.touch);
    }
  } finally {
    await wk.close();
  }

  // Keyboard: Tab reaches the user select, the wrapper shows the focus ring, and a
  // type-ahead key changes the selection; the label, title and accessible name follow.
  for (const [engine, launch] of [
    ['chromium', async () => browser],
    ['webkit', () => webkit.launch({ headless: true })],
  ] as const) {
    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await installMocks(page, makeBoard());
    await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: USERS } }));
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForFunction(() => (document.getElementById('user-select') as HTMLSelectElement).options.length > 1);
    let tabs = 0;
    while (tabs < 15 && (await page.evaluate(() => document.activeElement?.id)) !== 'user-select') {
      await page.keyboard.press('Tab');
      tabs++;
    }
    const ring = await page.evaluate(() => {
      const w = document.querySelector('.topbar .user-select') as HTMLElement;
      const cs = getComputedStyle(w);
      return {
        focused: document.activeElement?.id === 'user-select',
        outline: `${cs.outlineStyle} ${cs.outlineWidth}`,
      };
    });
    await page.keyboard.press('z'); // type-ahead: the first option starting with "Z" (Zhuge)
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => {
      const s = document.getElementById('user-select') as HTMLSelectElement;
      return {
        value: s.value,
        title: s.title,
        label: document.getElementById('user-select-label')?.textContent,
        path: location.pathname,
      };
    });
    const aria = await page.locator('#user-select').ariaSnapshot();
    check(
      ring.focused &&
        ring.outline === 'solid 2px' &&
        after.value === 'U001' &&
        after.label === 'Zhuge' &&
        after.title === 'Zhuge' &&
        after.path === '/dashboard/U001' &&
        aria.startsWith('- combobox "Zhuge"'),
      `${engine} keyboard: Tab → user select with the wrapper focus ring, "z" selects Zhuge; label, title and accessible name follow (${JSON.stringify({ tabs, ...ring, ...after, aria })})`,
    );
    await ctx.close();
    if (engine === 'webkit') await b.close();
  }

  // Initial load of a user's own board: loadUsers marks their option selected,
  // and the visible label and the select's title follow it.
  {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await installMocks(page, makeBoard());
    await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: USERS } }));
    await page.goto(`${BASE_URL}/dashboard/U003`);
    await page.waitForFunction(() => (document.getElementById('user-select') as HTMLSelectElement).options.length > 1);
    const sel = await page.evaluate(() => {
      const s = document.getElementById('user-select') as HTMLSelectElement;
      return { value: s.value, title: s.title, label: document.getElementById('user-select-label')?.textContent };
    });
    check(
      sel.value === 'U003' && sel.label === REAL && sel.title === REAL,
      `/dashboard/U003 opens with "${REAL}" in the select label and title (${JSON.stringify(sel)})`,
    );
    await ctx.close();
  }

  async function topbarPage(b: import('playwright').Browser, engine: string, width: number, touch: boolean) {
    const ctx = await b.newContext({
      viewport: { width, height: 900 },
      colorScheme: 'dark',
      hasTouch: touch,
      // Playwright's isMobile is Chromium-only; hasTouch alone gives WebKit (pointer: coarse).
      isMobile: touch && engine === '',
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installMocks(page, makeBoard());
    // Registered after installMocks, so these answer first.
    await page.route('**/auth/me', (r) => r.fulfill({ json: { ...PILLS[0].me, csrfToken: 'x' } }));
    await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: USERS } }));
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 5, null, { timeout: 10000 });
    await page.waitForSelector('#admin-mode-toggle', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => (document.getElementById('user-select') as HTMLSelectElement).options.length > 1);
    const base = `topbar-${engine}${width}${touch ? '-touch' : ''}`;
    let probes = 0;
    let failed = 0;
    for (const state of ['connecting', 'live', 'reconnecting', 'live'] as const) {
      if (state !== 'connecting') {
        await page.evaluate((s) => {
          const w = window as unknown as PageWindow;
          if (s === 'live') w.__wsReopen();
          else w.__ws.onclose();
        }, state);
      }
      for (const sel of SELECTS) {
        await page.selectOption('#user-select', sel.value);
        await page.waitForTimeout(120);
        for (const pill of PILLS) {
          await page.evaluate((me) => (window as unknown as PageWindow)._applyUserPill(me), pill.me);
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          const p = (await page.evaluate(() => (window as unknown as PageWindow).__topbarProbe())) as TopbarProbe;
          probes++;
          const item = (el: string) => p.items.find((i) => i.el === el);
          const bad: string[] = [];
          const ws = item('ws-status');
          if (!ws || ws.role !== 'status' || ws.label !== WS_LABEL[state] || (width < 640 && !(ws.dot && ws.h === 10)))
            bad.push(
              `status badge ${ws ? `role=${ws.role} label="${ws.label}" dot=${ws.dot} ${ws.w}x${ws.h}` : 'missing'}`,
            );
          if (p.overflow !== 0 || p.innerOverflow > 0) bad.push(`page overflow ${p.overflow}/${p.innerOverflow}`);
          for (const i of p.items) {
            if (i.lines > 1) bad.push(`${i.el} wraps "${i.text}"`);
            if (i.clipped) bad.push(`${i.el} hard-cut "${i.text}"`);
            if (i.outside) bad.push(`${i.el} off-screen`);
            if (i.interactive && !i.hit) bad.push(`${i.el} not reachable across its box (edges, centre, chevron)`);
            if (!i.covers) bad.push(`${i.el} select does not cover its box`);
            if (width < 640 && i.interactive && i.h < 44) bad.push(`${i.el} ${i.h}px tall`);
          }
          for (let x = 0; x < p.items.length; x++) {
            for (let y = x + 1; y < p.items.length; y++) {
              const [a, c] = [p.items[x].box, p.items[y].box];
              const ox = Math.min(a.r, c.r) - Math.max(a.l, c.l);
              const oy = Math.min(a.b, c.b) - Math.max(a.t, c.t);
              if (ox > 0.5 && oy > 0.5) bad.push(`${p.items[x].el} overlaps ${p.items[y].el} by ${ox.toFixed(1)}px`);
            }
          }
          for (const [el, want] of LABELS) {
            const i = item(el);
            if (!i || i.ellipsized || !i.text.includes(want))
              bad.push(`${el} label "${i?.text ?? ''}" (want "${want}")`);
          }
          for (const [el, want, rule] of [
            ['user-pill', pill.name, pillRule(pill.name, width)],
            ['user-select', sel.name, selRule(sel.name, width)],
          ] as Array<[string, string, NameRule]>) {
            const i = item(el);
            const ok =
              !!i &&
              i.name === want &&
              !(rule === 'full' && i.ellipsized) &&
              !(rule === 'ellipsis' && !i.ellipsized) &&
              (!i.ellipsized || i.nameTitle === want);
            if (!ok)
              bad.push(
                `${el} want ${rule} "${want.slice(0, 12)}" got ${i ? `"${(i.name ?? '').slice(0, 12)}" ellipsized=${i.ellipsized} title=${i.nameTitle === want}` : 'missing'}`,
              );
          }
          const combo = `${state} pill=${pill.key} sel=${sel.key}`;
          if (bad.length) {
            failed++;
            log(`[FAIL] ${base} ${combo}: ${bad.join('; ')}`);
            failures.push(`${base} ${combo}`);
          }
          for (const [suffix, [pk, sk, st]] of Object.entries(SHOTS)) {
            const file = path.join(OUT, `${base}${suffix}.png`);
            if (pk === pill.key && sk === sel.key && st === state && !fs.existsSync(file)) {
              if (suffix === '' || suffix === '-selected-long')
                log(
                  `      ${base}${suffix}: bar ${p.bar.h}px — ${p.items.map((i) => `${i.el}="${i.text.slice(0, 16)}"${i.ellipsized ? '…' : ''} ${i.w}x${i.h}`).join(' | ')}`,
                );
              await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height: p.bar.bottom + 12 } });
            }
          }
        }
      }
    }
    check(
      failed === 0 && errors.length === 0,
      `${base}: ${probes - failed}/${probes} status × pill × selected combinations clean${errors.length ? ` (page errors: ${errors.join(' | ')})` : ''}`,
    );
    await ctx.close();
  }
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

/**
 * 자세히 (dark, 1280 / 820 / 390): opens the five other cards and the charts
 * between the strip and the board without sideways scroll; the choice survives
 * a reload, and closing it does too.
 */
async function statsStripDetail(browser: import('playwright').Browser) {
  const state = (page: Page) =>
    page.evaluate(() => {
      const detail = document.getElementById('stats-detail') as HTMLElement;
      return {
        expanded: document.getElementById('stats-more')?.getAttribute('aria-expanded') ?? null,
        hidden: detail.hidden,
        cards: Array.from(document.querySelectorAll('#stats-grid .stat-card')).filter(
          (c) => c.getBoundingClientRect().height > 0,
        ).length,
        charts: document.querySelectorAll('#chart-row .chart-container').length,
        detailBottom: Math.round(detail.getBoundingClientRect().bottom),
        boardTop: Math.round((document.getElementById('inbox') as HTMLElement).getBoundingClientRect().top),
        saved: localStorage.getItem('soma-stats-detail'),
      };
    });
  for (const width of [1280, 820, 390]) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: 'dark',
      hasTouch: width < 640,
      isMobile: width < 640,
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installMocks(page, makeBoard());
    await openBoard(page);
    await page.click('.period-btn[data-period="week"]'); // seven bars per chart
    await page.click('#stats-more');
    await page.waitForFunction(() => document.querySelectorAll('#chart-row .bar').length >= 14, null, {
      timeout: 5000,
    });
    await page.waitForTimeout(300);
    const open = await state(page);
    check(
      open.expanded === 'true' &&
        !open.hidden &&
        open.cards === 5 &&
        open.charts === 2 &&
        open.detailBottom <= open.boardTop &&
        open.saved === 'open',
      `dark ${width}: 자세히 opens the 5 other cards and the charts between the strip and the board (${JSON.stringify(open)})`,
    );
    check((await overflow(page)) === 0, `dark ${width}: stats detail open — no page overflow`);
    if (width === 1280) {
      await shoot(page, 'stats-strip-expanded-dark-1280.png', false);
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 5, null, {
        timeout: 10000,
      });
      const reopened = await state(page);
      await page.click('#stats-more');
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 5, null, {
        timeout: 10000,
      });
      const closed = await state(page);
      check(
        reopened.expanded === 'true' &&
          !reopened.hidden &&
          closed.expanded === 'false' &&
          closed.hidden &&
          closed.saved === 'closed',
        `자세히 open / closed survives a reload (${JSON.stringify({ reopened: reopened.expanded, closed: closed.expanded, saved: closed.saved })})`,
      );
    }
    check(errors.length === 0, `dark ${width}: stats detail — no page errors (${errors.join(' | ')})`);
    await ctx.close();
  }
}

/** DONE column state: visible cards by state, the header count, the archives button and the older toggle. */
type DoneRead = {
  keys: string[];
  archived: number;
  count: string;
  btnHidden: boolean;
  pressed: string | null;
  label: string;
  btnH: number;
  foot: string;
  saved: string | null;
};
async function readDone(page: Page): Promise<DoneRead> {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#cards-done > .card:not(.is-exiting)')) as HTMLElement[];
    const btn = document.getElementById('archives-toggle') as HTMLElement;
    return {
      keys: cards.map((c) => c.getAttribute('data-session-key') || ''),
      archived: cards.filter((c) => c.getAttribute('data-state') === 'archived').length,
      count: document.getElementById('count-done')?.textContent ?? '',
      btnHidden: btn.hidden,
      pressed: btn.getAttribute('aria-pressed'),
      label: document.getElementById('archives-label')?.textContent ?? '',
      btnH: Math.round(btn.getBoundingClientRect().height),
      foot: document.getElementById('foot-done')?.textContent ?? '',
      saved: localStorage.getItem('soma-show-archives'),
    };
  });
}

/**
 * Archived (terminated) cards: hidden by default, Show archives shows them and
 * is remembered, counts follow what is drawn, and a deep link to a hidden
 * archive still opens it.
 */
async function archivesChecks(browser: import('playwright').Browser) {
  const settle = (page: Page, want: (d: DoneRead) => boolean) =>
    (async () => {
      for (let i = 0; i < 100; i++) {
        const d = await readDone(page);
        if (want(d)) return d;
        await page.waitForTimeout(30);
      }
      return readDone(page);
    })();
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
        hasTouch: width < 640,
        isMobile: width < 640,
      });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await installMocks(page, makeBoard());
      await openBoard(page);
      const tag = `${theme} ${width}`;
      const off = await readDone(page);
      check(
        off.archived === 0 &&
          off.keys.length === 2 &&
          off.count === '2' &&
          off.foot === '' &&
          !off.btnHidden &&
          off.pressed === 'false' &&
          off.label === 'Archives (2)' &&
          (width >= 640 || off.btnH >= 44),
        `${tag}: archives hidden by default — DONE shows ${off.count}, "${off.label}", no Show older for archives (${JSON.stringify(off)})`,
      );
      check((await overflow(page)) === 0, `${tag}: board header with Show archives — no page overflow`);
      await shoot(page, `archives-hidden-${theme}-${width}.png`);
      await page.click('#archives-toggle');
      const on = await settle(page, (d) => d.archived === 1);
      check(
        on.archived === 1 &&
          on.keys.includes(KA('700')) &&
          on.count === '3' &&
          on.foot === '▼ Show older (1)' &&
          on.pressed === 'true' &&
          on.label === 'Archives (2)' &&
          on.saved === 'on',
        `${tag}: Archives (pressed) shows the recent archive, DONE ${on.count}, the 9-day one behind "${on.foot}" (${JSON.stringify(on)})`,
      );
      check((await overflow(page)) === 0, `${tag}: archives shown — no page overflow`);
      await shoot(page, `archives-shown-${theme}-${width}.png`);
      if (theme === 'dark' && width === 1280) {
        await page.click('#foot-done .show-older-btn');
        const older = await settle(page, (d) => d.archived === 2);
        await page.reload();
        await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 5, null, {
          timeout: 10000,
        });
        const kept = await settle(page, (d) => d.archived === 1);
        await page.click('#archives-toggle');
        const hidden = await settle(page, (d) => d.archived === 0);
        check(
          older.count === '4' &&
            older.foot === '▲ Hide older (1)' &&
            kept.pressed === 'true' &&
            kept.archived === 1 &&
            hidden.pressed === 'false' &&
            hidden.archived === 0 &&
            hidden.saved === 'off',
          `Show archives survives a reload and turns off again (older ${older.count}, reload ${kept.pressed}, off → ${hidden.saved})`,
        );
      }
      check(errors.length === 0, `${tag}: archives — no page errors (${errors.join(' | ')})`);
      await ctx.close();
    }
  }

  // Deep links to hidden archives: 2 days old and 9 days old (behind Show older too).
  for (const [n, age] of [
    ['700', 'recent'],
    ['800', '9-day'],
  ] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await installMocks(page, makeBoard());
    await page.goto(`${BASE_URL}/dashboard/U001?session=${encodeURIComponent(`work:C123:1700000000.000${n}`)}`);
    const opened = await page
      .waitForFunction(() => document.getElementById('slide-panel')?.classList.contains('open'), null, {
        timeout: 8000,
      })
      .then(
        () => true,
        () => false,
      );
    await page.waitForTimeout(400);
    const d = await readDone(page);
    const expanded = await page.evaluate(
      (key) => !!document.querySelector(`[data-session-key="${key}"]`)?.classList.contains('is-expanded'),
      KA(n),
    );
    check(
      opened &&
        expanded &&
        d.keys.includes(KA(n)) &&
        d.archived === 1 &&
        d.pressed === 'false' &&
        d.saved === null &&
        d.label === 'Archives (2)',
      `deep link (Slack key) to a hidden ${age} archive (${KA(n).slice(11, 60)}…) opens it alone; the stored choice stays unset (${JSON.stringify({ opened, expanded, ...d })})`,
    );
    if (n === '800') await shoot(page, 'archives-deeplink-dark-1280.png', false);
    await ctx.close();
  }
}

/** All Users: owner badges on every card head, one colour per owner. */
async function ownerBadgeChecks(browser: import('playwright').Browser) {
  type BadgeRead = {
    cards: number;
    badges: Array<{
      owner: string;
      text: string;
      title: string;
      bg: string;
      fg: string;
      inside: boolean;
      clear: boolean;
      cut: boolean;
    }>;
  };
  // The owner each card was given in makeTeamBoard(), by session key.
  const OWNER_OF = Object.fromEntries(
    Object.values(makeTeamBoard()).flatMap((col) => col.map((c) => [c.key as string, c.ownerId as string])),
  );
  const probe = (page: Page) =>
    page.evaluate((ownerOf) => {
      const cards = Array.from(document.querySelectorAll('#kanban .card:not(.is-exiting)')) as HTMLElement[];
      const badges = cards.flatMap((card) => {
        const b = card.querySelector('.card-head .owner-badge') as HTMLElement | null;
        if (!b) return [];
        const head = (card.querySelector('.card-head') as HTMLElement).getBoundingClientRect();
        const title = card.querySelector('.card-title-text') as HTMLElement | null;
        const br = b.getBoundingClientRect();
        const tr = title?.getBoundingClientRect();
        const cs = getComputedStyle(b);
        const key = card.getAttribute('data-session-key') || '';
        return [
          {
            owner: ownerOf[key] ?? '',
            text: b.textContent || '',
            title: b.getAttribute('title') || '',
            bg: cs.backgroundColor,
            fg: cs.color,
            inside: br.left >= head.left - 0.5 && br.right <= head.right + 0.5 && br.width > 0,
            clear: !tr || tr.right <= br.left + 0.5,
            cut: b.scrollWidth > b.clientWidth + 1,
          },
        ];
      });
      return { cards: cards.length, badges };
    }, OWNER_OF) as Promise<BadgeRead>;
  const lum = (rgb: string) => {
    const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const judge = (p: BadgeRead) => {
    const bad: string[] = [];
    if (p.badges.length !== p.cards) bad.push(`${p.badges.length} badges on ${p.cards} cards`);
    const colour = new Map<string, Set<string>>();
    for (const b of p.badges) {
      const want = TEAM.find((t) => t.id === b.owner)?.name;
      if (b.text !== want || b.title !== want) bad.push(`badge "${b.text}" for ${b.owner}`);
      if (!b.inside) bad.push(`${b.text} badge leaves its head`);
      if (!b.clear) bad.push(`${b.text} badge covers the title`);
      if (contrast(b.fg, b.bg) < 4.5) bad.push(`${b.text} contrast ${contrast(b.fg, b.bg).toFixed(2)}`);
      if (b.owner === DANA && !b.cut) bad.push('the long name is not ellipsized');
      if (!colour.has(b.owner)) colour.set(b.owner, new Set());
      colour.get(b.owner)?.add(b.bg);
    }
    for (const [o, set] of colour) if (set.size !== 1) bad.push(`${o} has ${set.size} colours`);
    const all = [...colour.values()].map((set) => [...set][0]);
    if (new Set(all).size !== all.length) bad.push(`owners share a colour (${all.join(' ')})`);
    return { bad, owners: colour.size };
  };
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
        hasTouch: width < 640,
        isMobile: width < 640,
      });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await installMocks(page, makeTeamBoard());
      await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: TEAM } }));
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 5, null, {
        timeout: 10000,
      });
      await page.waitForTimeout(350);
      const tag = `${theme} ${width}`;
      const view = await page.evaluate(() => document.getElementById('kanban')?.getAttribute('data-view'));
      const first = await probe(page);
      const j1 = judge(first);
      check(
        j1.bad.length === 0 && j1.owners >= 4 && (await overflow(page)) === 0,
        `${tag} ${view}: All Users — every card names its owner (${first.badges.length}/${first.cards} cards, ${j1.owners} owners, one colour each) ${j1.bad.join('; ')}`,
      );
      await shoot(page, `owner-badges-${theme}-${width}.png`, false);
      const other = view === 'board' ? 'list' : 'board';
      await page.click(`.seg-btn[data-view="${other}"]`);
      await page.waitForTimeout(450);
      const second = await probe(page);
      const j2 = judge(second);
      check(
        j2.bad.length === 0 && (await overflow(page)) === 0,
        `${tag} ${other}: owner badges hold in the other view ${j2.bad.join('; ')}`,
      );
      await page.selectOption('#user-select', ALICE);
      await page
        .waitForFunction(() => document.querySelectorAll('#kanban .owner-badge').length === 0, null, {
          timeout: 5000,
        })
        .catch(() => {});
      const mine = await probe(page);
      check(mine.badges.length === 0, `${tag}: a selected user shows no owner badges (${mine.badges.length})`);
      check(errors.length === 0, `${tag}: owner badges — no page errors (${errors.join(' | ')})`);
      await ctx.close();
    }
  }
}

/** The side panel's pinned Tasks, the collapsible work log and the raw output of its entries. */
type PanelRead = {
  tasksOutside: boolean;
  tasksHeader: string;
  tasksItems: number;
  tasksEmpty: string | null;
  expanded: string | null;
  listHidden: boolean;
  count: string;
  entries: number;
  tasks: { t: number; b: number; h: number };
  scroll: { t: number; b: number; h: number; top: number; scrollable: boolean; fromEnd: number };
  header: { t: number; b: number };
  turns: number;
  small: string[];
};
async function readPanel(page: Page): Promise<PanelRead> {
  return page.evaluate(() => {
    const tasks = document.getElementById('panel-tasks') as HTMLElement;
    const scroll = document.getElementById('panel-scroll') as HTMLElement;
    const list = document.getElementById('worklog-list') as HTMLElement;
    // No named functions in here: tsx would wrap them in a __name() the page lacks.
    const [tb, sb] = [tasks, scroll].map((el) => {
      const q = el.getBoundingClientRect();
      return { t: Math.round(q.top), b: Math.round(q.bottom), h: Math.round(q.height) };
    });
    const panel = document.getElementById('slide-panel') as HTMLElement;
    const small = Array.from(panel.querySelectorAll('button, a, input, [role="button"]'))
      .filter((el) => {
        const q = el.getBoundingClientRect();
        return q.width > 0 && q.height > 0 && q.bottom > 0 && q.top < innerHeight;
      })
      .filter((el) => el.getBoundingClientRect().height < 43.5)
      .map(
        (el) =>
          `${el.id || (el as HTMLElement).className || el.tagName}:${Math.round(el.getBoundingClientRect().height)}`,
      );
    return {
      tasksOutside: !scroll.contains(tasks),
      tasksHeader: tasks.querySelector('.panel-tasks-header')?.textContent ?? '',
      tasksItems: tasks.querySelectorAll('.panel-task-item').length,
      tasksEmpty: tasks.querySelector('.panel-tasks-empty')?.textContent ?? null,
      expanded: document.getElementById('worklog-toggle')?.getAttribute('aria-expanded') ?? null,
      listHidden: list.hidden,
      count: document.getElementById('worklog-count')?.textContent ?? '',
      entries: list.querySelectorAll('.wl-entry').length,
      tasks: tb,
      scroll: {
        ...sb,
        top: Math.round(scroll.scrollTop),
        scrollable: scroll.scrollHeight > scroll.clientHeight + 1,
        fromEnd: Math.round(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop),
      },
      header: {
        t: Math.round((document.getElementById('worklog-toggle') as HTMLElement).getBoundingClientRect().top),
        b: Math.round((document.getElementById('worklog-toggle') as HTMLElement).getBoundingClientRect().bottom),
      },
      turns: document.querySelectorAll('#panel-turns .turn').length,
      small,
    };
  });
}
async function readDetail(page: Page, seq: number) {
  return page.evaluate((n) => {
    const el = document.querySelector(`#worklog-list .wl-entry[data-seq="${n}"]`) as HTMLElement | null;
    const detail = el?.querySelector('.wl-detail') as HTMLElement | null;
    return {
      expanded: el?.querySelector('.wl-row')?.getAttribute('aria-expanded') ?? null,
      hidden: detail?.hidden ?? null,
      html: detail?.innerHTML ?? '',
      pre: (detail?.querySelector('.wl-raw') as HTMLElement | null)?.textContent ?? null,
      note: detail?.querySelector('.wl-detail-note')?.textContent ?? null,
      msg: detail?.querySelector('.wl-detail-msg')?.textContent ?? null,
      retry: !!detail?.querySelector('[data-wl-act="retry"]'),
    };
  }, seq);
}

async function panelChecks(browser: import('playwright').Browser) {
  // Conversation for this scenario: conv-1's work log (with rawBytes) and six turns.
  WORKLOG['conv-panel'] = panelLog();
  TURNS['conv-panel'] = Array.from({ length: 6 }, (_, i) => ({
    id: `P${i + 1}`,
    role: i % 2 ? 'assistant' : 'user',
    userName: 'Zhuge',
    timestamp: NOW - (6 - i) * M,
    rawContent: i % 2 ? undefined : `step ${i / 2 + 1}: check the migration on staging`,
    summarized: true,
    summaryTitle: i % 2 ? `step ${(i + 1) / 2} done` : undefined,
    summaryBody: i % 2 ? 'Ran it on staging; no errors.' : undefined,
  }));
  const row = (seq: number) => `#worklog-list .wl-entry[data-seq="${seq}"] > .wl-row`;
  const shown = (page: Page, seq: number, what: 'pre' | 'msg') =>
    page
      .waitForFunction(
        ([n, w]) =>
          !!document.querySelector(
            `#worklog-list .wl-entry[data-seq="${n}"] .wl-detail ${w === 'pre' ? '.wl-raw' : '.wl-detail-msg:not(.is-loading)'}`,
          ),
        [seq, what] as const,
        { timeout: 5000 },
      )
      .then(
        () => true,
        () => false,
      );
  const intoView = (page: Page, seq: number) =>
    page.evaluate((n) => {
      const el = document.querySelector(`#worklog-list .wl-entry[data-seq="${n}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }, seq);
  const rawCalls = (seq: number) => RAW_CALLS.filter((c) => c.conv === 'conv-panel' && c.seq === seq).length;

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      const tag = `${theme} ${width}`;
      const extra = theme === 'dark' && width === 1280;
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
        hasTouch: width < 640,
        isMobile: width < 640,
        ...(extra ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}),
      });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const board = makeBoard() as Record<string, Array<Record<string, unknown>>>;
      board.waiting[0].conversationId = 'conv-panel'; // Migrate users table: 4 tasks
      await installMocks(page, board);
      await openBoard(page);
      RAW_CALLS.length = 0;
      WORKLOG_CALLS.length = 0;

      // The user's path: open the card, press its 작업 로그 button. Tasks pinned, the
      // work log collapsed (but loaded: the count) with its header in view.
      await page.click(`[data-session-key="${K('100')}"] .card-face`);
      await page.waitForTimeout(350);
      await page.click(`[data-session-key="${K('100')}"] .btn-primary`);
      await page
        .waitForFunction(() => document.getElementById('worklog-count')?.textContent === '13', null, { timeout: 5000 })
        .catch(() => {});
      await page.waitForTimeout(450);
      const d0 = await readPanel(page);
      check(
        d0.tasksOutside &&
          d0.tasksHeader.startsWith('Tasks') &&
          d0.tasksItems === 4 &&
          d0.expanded === 'false' &&
          d0.listHidden &&
          d0.count === '13' &&
          d0.tasks.b <= d0.scroll.t &&
          d0.header.t >= d0.scroll.t &&
          d0.header.b <= d0.scroll.b,
        `${tag}: the 작업 로그 button opens the panel with Tasks pinned and the work log collapsed (13), its header in view (${JSON.stringify({ ...d0, small: undefined })})`,
      );
      check((await overflow(page)) === 0, `${tag}: panel from 작업 로그 — no page overflow`);
      if (width < 640) check(d0.small.length === 0, `${tag}: panel controls ≥44px (${d0.small.join(' | ')})`);
      await shoot(page, `panel-open-button-${theme}-${width}.png`, false);

      // A live entry while collapsed moves the count; expanding does not refetch.
      await page.evaluate(() =>
        (window as unknown as PageWindow).__wsSend({
          type: 'work_log',
          conversationId: 'conv-panel',
          entry: { seq: 14, ts: Date.now(), kind: 'notice', text: 'live while collapsed' },
        }),
      );
      const d1 = await readPanel(page);
      const listCalls = WORKLOG_CALLS.length;
      await page.click('#worklog-toggle');
      await page.waitForTimeout(300);
      const d2 = await readPanel(page);
      check(
        d1.count === '14' &&
          d1.listHidden &&
          d2.expanded === 'true' &&
          !d2.listHidden &&
          d2.entries === 14 &&
          WORKLOG_CALLS.length === listCalls,
        `${tag}: count follows live entries while collapsed (${d1.count}); expanding shows them without a refetch (${WORKLOG_CALLS.length - listCalls} requests)`,
      );

      // Tasks stay put while the scroll area scrolls.
      await page.evaluate(() => {
        const sc = document.getElementById('panel-scroll') as HTMLElement;
        sc.scrollTo({ top: sc.scrollHeight, behavior: 'instant' });
      });
      await page.waitForTimeout(150);
      const atEnd = await readPanel(page);
      await page.evaluate(() =>
        (document.getElementById('panel-scroll') as HTMLElement).scrollTo({ top: 0, behavior: 'instant' }),
      );
      await page.waitForTimeout(150);
      const atTop = await readPanel(page);
      log(
        `${tag}: tasks ${JSON.stringify(atTop.tasks)} / ${JSON.stringify(atEnd.tasks)} · scroll ${JSON.stringify(atTop.scroll)} / ${JSON.stringify(atEnd.scroll)}`,
      );
      check(
        atEnd.scroll.scrollable &&
          atEnd.scroll.top > 50 &&
          atTop.scroll.top === 0 &&
          atTop.tasks.t === atEnd.tasks.t &&
          atTop.tasks.b === atEnd.tasks.b &&
          atEnd.tasks.b <= atEnd.scroll.t,
        `${tag}: Tasks top stays at ${atTop.tasks.t}px while the scroll area moves ${atEnd.scroll.top}px`,
      );
      await shoot(page, `panel-worklog-expanded-${theme}-${width}.png`, false);

      // A tool entry with stored raw: fetched once, kept when closed and reopened.
      await page.click(row(3));
      const okPre = await shown(page, 3, 'pre');
      const raw3 = await readDetail(page, 3);
      const live = await page.evaluate(() => ({
        list: document.getElementById('worklog-list')?.getAttribute('aria-live'),
        detail: document.querySelector('#worklog-list .wl-entry[data-seq="3"] .wl-detail')?.getAttribute('aria-live'),
      }));
      check(
        live.list === 'polite' && live.detail === 'off',
        `${tag}: an opened raw output stays out of the polite log region (${JSON.stringify(live)})`,
      );
      await page.click(row(3));
      const closed3 = await readDetail(page, 3);
      await page.click(row(3));
      await shown(page, 3, 'pre');
      check(
        okPre &&
          raw3.expanded === 'true' &&
          raw3.pre === RAW_STORE['conv-panel'][3].raw &&
          closed3.hidden === true &&
          closed3.expanded === 'false' &&
          rawCalls(3) === 1,
        `${tag}: a tool entry opens its full raw output; close + reopen asks once (${rawCalls(3)} request)`,
      );
      await intoView(page, 3);
      await shoot(page, `panel-raw-${theme}-${width}.png`, false);
      if (extra) {
        await page.click(`#worklog-list .wl-entry[data-seq="3"] [data-wl-act="copy"]`);
        await page.waitForTimeout(200);
        const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
        const label = await page.evaluate(
          () => document.querySelector('#worklog-list .wl-entry[data-seq="3"] [data-wl-act="copy"]')?.textContent,
        );
        check(
          clip === RAW_STORE['conv-panel'][3].raw && label === '복사됨',
          `copy puts the shown raw output on the clipboard ("${label}")`,
        );
      }
      await page.click(row(3));

      // Narration (no stored raw): its own full text, no request.
      await page.click(row(2));
      await shown(page, 2, 'pre');
      const n2 = await readDetail(page, 2);
      check(
        n2.pre === 'Reading the current schema and the migration history first.' && rawCalls(2) === 0,
        `${tag}: an entry without stored raw shows its full text, no request (${rawCalls(2)})`,
      );
      await page.click(row(2));

      // Truncated raw.
      await page.click(row(9));
      await shown(page, 9, 'pre');
      const t9 = await readDetail(page, 9);
      check(
        t9.note === '저장된 앞 256 KiB만 표시 — 원본 1.0 MiB' && (t9.pre || '').split('\n').length === 60,
        `${tag}: a truncated raw output says so ("${t9.note}")`,
      );
      await intoView(page, 9);
      await shoot(page, `panel-raw-truncated-${theme}-${width}.png`, false);
      await page.click(row(9));

      // 404: nothing stored.
      await page.click(row(6));
      await shown(page, 6, 'msg');
      const m6 = await readDetail(page, 6);
      check(m6.msg === '원본 출력이 저장되어 있지 않습니다' && !m6.retry, `${tag}: 404 reads "${m6.msg}"`);
      await page.click(row(6));

      // 503: the log is damaged — its own line, no 다시 시도, asked once.
      await page.click(row(12));
      await shown(page, 12, 'msg');
      const d12 = await readDetail(page, 12);
      await intoView(page, 12);
      await shoot(page, `panel-raw-damaged-${theme}-${width}.png`, false);
      await page.click(row(12));
      await page.click(row(12));
      await shown(page, 12, 'msg');
      check(
        d12.msg === '로그가 손상되어 원본을 읽을 수 없습니다' && !d12.retry && rawCalls(12) === 1,
        `${tag}: 503 reads "${d12.msg}" with no 다시 시도; reopening does not ask again (${rawCalls(12)} request)`,
      );
      await page.click(row(12));

      // A network failure → 다시 시도 → the raw.
      await page.click(row(11));
      await shown(page, 11, 'msg');
      const e11 = await readDetail(page, 11);
      await intoView(page, 11);
      await shoot(page, `panel-raw-error-${theme}-${width}.png`, false);
      if (width < 640) {
        const small = (await readPanel(page)).small;
        check(small.length === 0, `${tag}: rows, 다시 시도 and the header are ≥44px (${small.join(' | ')})`);
      }
      await page.click(`#worklog-list .wl-entry[data-seq="11"] [data-wl-act="retry"]`);
      const retried = await shown(page, 11, 'pre');
      const r11 = await readDetail(page, 11);
      check(
        (e11.msg || '').startsWith('원본 출력을 불러오지 못했어요') &&
          e11.retry &&
          retried &&
          r11.pre === RAW_STORE['conv-panel'][11].raw &&
          rawCalls(11) === 2,
        `${tag}: a network failure offers 다시 시도, which refetches and shows the raw (${rawCalls(11)} requests)`,
      );

      // Tail-follow does not yank the list while a detail is open.
      const before = await page.evaluate(() => {
        const l = document.getElementById('worklog-list') as HTMLElement;
        l.scrollTop = l.scrollHeight;
        return Math.round(l.scrollTop);
      });
      await page.evaluate(() =>
        (window as unknown as PageWindow).__wsSend({
          type: 'work_log',
          conversationId: 'conv-panel',
          entry: { seq: 15, ts: Date.now(), kind: 'tool', tool: 'Bash', text: 'Bash {"command":"npm test"}' },
        }),
      );
      await page.waitForTimeout(100);
      const after = await page.evaluate(() =>
        Math.round((document.getElementById('worklog-list') as HTMLElement).scrollTop),
      );
      check(
        after === before,
        `${tag}: a live entry does not move the list while a detail is open (${before} → ${after})`,
      );
      check((await overflow(page)) === 0, `${tag}: raw output open — no page overflow`);
      await page.click(row(11));

      if (extra) {
        // Keyboard: the list is one tab stop (the newest row); arrows, Home and End
        // move it; Enter opens an entry's raw output, Space closes it; Tab leaves.
        const roving = () =>
          page.evaluate(() => {
            const stops = Array.from(document.querySelectorAll('#worklog-list .wl-row[tabindex="0"]'));
            const a = document.activeElement as HTMLElement | null;
            return {
              stops: stops.length,
              stopSeq: stops[0]?.parentElement?.getAttribute('data-seq') ?? null,
              focusSeq: a?.classList.contains('wl-row') ? a.parentElement?.getAttribute('data-seq') : null,
              rows: document.querySelectorAll('#worklog-list .wl-row').length,
            };
          });
        await page.click('#worklog-toggle');
        await page.click('#worklog-toggle'); // focus on the header, list open
        const r0 = await roving();
        await page.keyboard.press('Tab');
        const r1 = await roving();
        await page.keyboard.press('ArrowUp');
        const r2 = await roving();
        await page.keyboard.press('Home');
        const r3 = await roving();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        const r4 = await roving();
        await page.keyboard.press('Enter');
        const k1 = await readDetail(page, 5);
        await page.keyboard.press(' ');
        const k2 = await readDetail(page, 5);
        await page.keyboard.press('End');
        const r5 = await roving();
        await page.keyboard.press('Tab');
        const r6 = await roving();
        log(`roving: ${JSON.stringify({ r0, r1, r2, r3, r4, r5, r6 })}`);
        // The stop is the row focused last (the clicks above), else the newest row.
        const stop = Number(r0.stopSeq);
        const last = String(r0.rows); // seqs 1..n, one row each
        check(
          r0.stops === 1 &&
            r1.focusSeq === r0.stopSeq &&
            r2.focusSeq === String(stop - 1) &&
            r2.stops === 1 &&
            r2.stopSeq === r2.focusSeq &&
            r3.focusSeq === '1' &&
            r4.focusSeq === '5' &&
            r5.focusSeq === last &&
            r6.focusSeq === null &&
            r6.stops === 1 &&
            r6.stopSeq === last,
          `keyboard: one tab stop in the list (${r0.rows} rows, on seq ${r0.stopSeq}); Tab enters there, ↑ / Home / ↓ / End move it, Tab leaves`,
        );
        check(
          k1.expanded === 'true' && !!k1.pre && k2.expanded === 'false' && k2.hidden === true,
          `keyboard: Enter opens an entry's raw output, Space closes it`,
        );
      }
      if (theme === 'light' && width === 1280) {
        // A late answer for a row closed in the meantime is dropped; reopening uses it.
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
          release = r;
        });
        let asked = false;
        await page.route(/\/worklog\/4\/raw/, async (r) => {
          asked = true;
          await gate;
          await r.fallback();
        });
        await page.click(row(4));
        for (let i = 0; i < 50 && !asked; i++) await page.waitForTimeout(20);
        await page.click(row(4));
        release();
        await page.waitForTimeout(300);
        const late = await readDetail(page, 4);
        await page.click(row(4));
        await shown(page, 4, 'pre');
        const reopened = await readDetail(page, 4);
        check(
          asked &&
            late.hidden === true &&
            late.html === '' &&
            reopened.pre === RAW_STORE['conv-panel'][4].raw &&
            rawCalls(4) === 1,
          `a late raw answer for a closed row is dropped; reopening shows it without asking again (${rawCalls(4)} request)`,
        );
        await page.unroute(/\/worklog\/4\/raw/);
      }

      // A session with no tasks: the pinned block says so. A 작업 로그 opening is expanded.
      await page.evaluate((k) => (window as unknown as PageWindow).openPanel(k), K('600'));
      await page.waitForTimeout(400);
      const e0 = await readPanel(page);
      check(
        e0.tasksOutside &&
          e0.tasksHeader === 'Tasks' &&
          e0.tasksEmpty === '아직 작업 목록이 없습니다' &&
          e0.expanded === 'false',
        `${tag}: no tasks yet — the pinned block reads "${e0.tasksEmpty}"`,
      );
      await shoot(page, `panel-empty-tasks-${theme}-${width}.png`, false);
      // Any other opening (답변하기, …) lands on the newest turns, the log collapsed too.
      await page.evaluate((k) => (window as unknown as PageWindow).openPanel(k), K('100'));
      await page.waitForTimeout(500);
      const f0 = await readPanel(page);
      check(
        f0.expanded === 'false' && f0.listHidden && f0.scroll.fromEnd <= 2,
        `${tag}: another opening lands on the newest turns with the log collapsed (${f0.scroll.fromEnd}px from the end)`,
      );
      check(errors.length === 0, `${tag}: panel — no page errors (${errors.join(' | ')})`);
      await ctx.close();

      // The Slack 작업 로그 link: a real ?session= navigation.
      const ctx2 = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
        hasTouch: width < 640,
        isMobile: width < 640,
      });
      const page2 = await ctx2.newPage();
      await installMocks(page2, board);
      await page2.goto(`${BASE_URL}/dashboard/U001?session=${encodeURIComponent('work:C123:1700000000.000100')}`);
      await page2
        .waitForFunction(() => document.getElementById('worklog-count')?.textContent === '13', null, { timeout: 8000 })
        .catch(() => {});
      await page2.waitForTimeout(500);
      const g0 = await readPanel(page2);
      const cardOpen = await page2.evaluate(
        (k) => !!document.querySelector(`[data-session-key="${k}"]`)?.classList.contains('is-expanded'),
        K('100'),
      );
      check(
        cardOpen &&
          g0.tasksOutside &&
          g0.expanded === 'false' &&
          g0.listHidden &&
          g0.count === '13' &&
          g0.header.t >= g0.scroll.t &&
          g0.header.b <= g0.scroll.b,
        `${tag}: the ?session= link opens the card and the panel with the work log collapsed, its header in view (${JSON.stringify({ header: g0.header, scroll: g0.scroll })})`,
      );
      check((await overflow(page2)) === 0, `${tag}: panel from ?session= — no page overflow`);
      if (width < 640)
        check(g0.small.length === 0, `${tag}: deep-linked panel controls ≥44px (${g0.small.join(' | ')})`);
      await shoot(page2, `panel-open-deeplink-${theme}-${width}.png`, false);
      await ctx2.close();
    }
  }

  // Landing at the top (작업 로그) loads no older turns by itself; one scroll gesture
  // up into the first turns loads exactly one older page — no cascade.
  TURNS['conv-cascade'] = Array.from({ length: 100 }, (_, i) => ({
    id: `C${i + 1}`,
    role: i % 2 ? 'assistant' : 'user',
    userName: 'Zhuge',
    timestamp: NOW - (100 - i) * M,
    rawContent: i % 2 ? undefined : `instruction ${i + 1}`,
    summarized: true,
    summaryTitle: i % 2 ? `reply ${i + 1}` : undefined,
    summaryBody: i % 2 ? 'body' : undefined,
  }));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const board = makeBoard() as Record<string, Array<Record<string, unknown>>>;
  board.working[0].conversationId = 'conv-cascade'; // Review PR #482: 100 turns
  await installMocks(page, board);
  await openBoard(page);
  await page.click(`[data-session-key="${K('300')}"] .card-face`);
  await page.waitForTimeout(350);
  await page.click(`[data-session-key="${K('300')}"] .btn-primary`);
  await page.waitForFunction(() => document.querySelectorAll('#panel-turns .turn').length >= 30, null, {
    timeout: 5000,
  });
  await page.waitForTimeout(900);
  const landed = await readPanel(page);
  const box = await page.evaluate(() => {
    const q = (document.getElementById('panel-scroll') as HTMLElement).getBoundingClientRect();
    return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(500);
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(1200);
  const once = await readPanel(page);
  // Small moves that stay near the first turns (the reader adjusting) load nothing more.
  for (const dy of [40, -40, 30, -30]) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(900);
  const settled = await readPanel(page);
  check(
    landed.turns === 30 &&
      landed.scroll.top === 0 &&
      once.turns === 60 &&
      settled.turns === 60 &&
      settled.header.t >= settled.scroll.t,
    `작업 로그 landing at the top loads nothing by itself; one scroll up loads one older page, small moves near the top no more (turns ${landed.turns} → ${once.turns} → ${settled.turns})`,
  );
  await ctx.close();
}

/** Expected strip text for a period: U001's own numbers or All Users'. */
function stripWant(scope: 'user' | 'all', period: Period) {
  const t = PERIOD_TOTALS[period];
  const k = scope === 'user' ? 1 : 2;
  const tokens = ((t.input + t.output) * k) / 1_000_000;
  return {
    sessions: String(scope === 'user' ? t.sessions : t.all),
    tokens: `${tokens.toFixed(1)}M`,
    cost: `$${(t.cost * k).toFixed(2)}`,
  };
}
type StripRead = { sessions: string; tokens: string; cost: string; active: string };

/**
 * Every stat follows the selected period (오늘 / 지난 7일 / 지난 30일): sessions
 * from /api/dashboard/stats, tokens (input + output) and cost from
 * /api/dashboard/usage — for one user and for All Users (no userId) — and a
 * late response for a period no longer selected is dropped.
 */
async function statsChecks(browser: import('playwright').Browser) {
  const read = (page: Page) =>
    page.evaluate(() => ({
      sessions: document.getElementById('stat-sessions')?.textContent ?? '',
      tokens: document.getElementById('stat-tokens')?.textContent ?? '',
      cost: document.getElementById('stat-cost')?.textContent ?? '',
      active: (document.querySelector('.period-btn.active') as HTMLElement | null)?.dataset.period ?? '',
    })) as Promise<StripRead>;
  const shows = (page: Page, want: Omit<StripRead, 'active'>) =>
    page
      .waitForFunction(
        (w) =>
          document.getElementById('stat-sessions')?.textContent === w.sessions &&
          document.getElementById('stat-tokens')?.textContent === w.tokens &&
          document.getElementById('stat-cost')?.textContent === w.cost,
        want,
        { timeout: 5000 },
      )
      .then(
        () => true,
        () => false,
      );
  const callsFor = (calls: URLSearchParams[], period: Period) => calls.filter((q) => periodOf(q) === period);

  for (const scope of ['user', 'all'] as const) {
    const label = scope === 'user' ? 'stats U001' : 'stats All Users';
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installMocks(page, makeBoard());
    STATS_CALLS.length = 0;
    USAGE_CALLS.length = 0;
    if (scope === 'user') await openBoard(page);
    else {
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 5, null, {
        timeout: 10000,
      });
    }
    const dayOk = await shows(page, stripWant(scope, 'day'));
    check(dayOk, `${label}: 오늘 shows the day's sessions, tokens and cost (${JSON.stringify(await read(page))})`);
    await page.click('.period-btn[data-period="week"]');
    const weekOk = await shows(page, stripWant(scope, 'week'));
    check(
      weekOk,
      `${label}: 지난 7일 changes sessions, tokens and cost to the week totals (want ${JSON.stringify(stripWant(scope, 'week'))}, got ${JSON.stringify(await read(page))})`,
    );
    const asked = [...callsFor(STATS_CALLS, 'week'), ...callsFor(USAGE_CALLS, 'week')];
    const userIds = [...STATS_CALLS, ...USAGE_CALLS].map((q) => q.get('userId'));
    check(
      callsFor(STATS_CALLS, 'week').length === 1 &&
        callsFor(USAGE_CALLS, 'week').length === 1 &&
        userIds.every((u) => (scope === 'user' ? u === 'U001' : u === null)),
      `${label}: one stats + one usage request per period, userId ${scope === 'user' ? '=U001' : 'absent'} (${asked.length} week requests, userIds ${JSON.stringify(userIds)})`,
    );
    check(errors.length === 0, `${label}: no page errors (${errors.join(' | ')})`);
    await ctx.close();
  }

  // Fast clicks: 오늘 → 지난 7일 (both responses held) → 오늘; the late week
  // responses land last and must not repaint the strip.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await installMocks(page, makeBoard());
  const held: Array<() => void> = [];
  await page.route(/\/api\/dashboard\/(stats|usage)\?.*period=week/, async (r) => {
    await new Promise<void>((res) => {
      held.push(res);
    });
    await r.fallback();
  });
  await page.goto(`${BASE_URL}/dashboard`);
  await shows(page, stripWant('all', 'day'));
  STATS_CALLS.length = 0;
  USAGE_CALLS.length = 0;
  await page.click('.period-btn[data-period="week"]');
  for (let i = 0; i < 100 && held.length < 2; i++) await page.waitForTimeout(20);
  await page.click('.period-btn[data-period="day"]');
  for (let i = 0; i < 100 && (STATS_CALLS.length < 1 || USAGE_CALLS.length < 1); i++) await page.waitForTimeout(20);
  await page.waitForTimeout(200);
  for (const release of held) release();
  for (let i = 0; i < 100 && (STATS_CALLS.length < 2 || USAGE_CALLS.length < 2); i++) await page.waitForTimeout(20);
  await page.waitForTimeout(400);
  const end = await read(page);
  const order = STATS_CALLS.map(periodOf).join('>');
  const want = stripWant('all', 'day');
  check(
    held.length === 2 &&
      order === 'day>week' &&
      end.active === 'day' &&
      end.sessions === want.sessions &&
      end.tokens === want.tokens &&
      end.cost === want.cost,
    `stats: 오늘 → 지난 7일 → 오늘 with the week answers landing last ends on today's numbers (answers ${order}, ${JSON.stringify(end)})`,
  );
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
    await topbarChecks(browser);
    await cardIoOutage(browser);
    await titleSubPanelSwitch(browser);
    await statsChecks(browser);
    await statsStripDetail(browser);
    await archivesChecks(browser);
    await ownerBadgeChecks(browser);
    await panelChecks(browser);
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
