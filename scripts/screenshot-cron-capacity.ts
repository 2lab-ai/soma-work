/**
 * CRON lane + LLM capacity timeline — browser receipts (SSOT 2026-10-23,
 * .prd/12-cron-lane-and-llm-capacity-spec.md).
 *
 * The real web server serves the real dashboard page; the browser-side HTTP
 * layer is mocked (board, cron jobs, capacity) and the WebSocket is a stub.
 * Asserts (exit 1 on any failure) and writes screenshots for each:
 *   - 1280 / 390 × light / dark: the capacity section sits between the stats
 *     strip and the inbox, the CRON lane above the columns, no page-level
 *     sideways scroll (cron-capacity-<w>-<theme>.png)
 *   - cron cards are in the lane, not in the columns, and lead with the CRON badge
 *   - capacity (simplified): Claude shows a 5시간 and an 일주일 bar, Codex the
 *     weekly bar only, one timeline per card, an honest disclosure line
 *   - "지난 실행" opens the run drawer with one row per run; Escape closes it
 *     (cron-drawer-<theme>.png)
 *
 * Run from the repo root:
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-cron-capacity.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'cron-capacity');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CONVERSATION_VIEWER_PORT || '33918';
process.env.CONVERSATION_VIEWER_PORT = PORT;
// Hermetic: a shell that carries the deployment's viewer auth (token, OAuth,
// JWT secret) would send every page to /login. This receipt runs auth-less.
for (const k of ['CONVERSATION_VIEWER_TOKEN', 'DASHBOARD_JWT_SECRET', 'GOOGLE_CLIENT_ID', 'MICROSOFT_CLIENT_ID']) {
  process.env[k] = '';
}
const BASE_URL = `http://127.0.0.1:${PORT}`;

const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);
const M = 60_000;
const H = 3600;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const report: string[] = [];
const failures: string[] = [];
function check(ok: boolean, label: string) {
  report.push(`${ok ? '[ok]' : '[FAIL]'} ${label}`);
  if (!ok) failures.push(label);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

const usage = (tokens: number, cost: number) => ({
  totalInputTokens: Math.round(tokens * 0.02),
  totalOutputTokens: Math.round(tokens * 0.01),
  totalCacheReadTokens: Math.round(tokens * 0.9),
  totalCacheCreateTokens: Math.round(tokens * 0.07),
  totalCostUsd: cost,
  contextUsagePercent: 31,
});

function card(n: string, over: Record<string, unknown>) {
  return {
    key: `mock-inst::work:C123:1700000000.000${n}`,
    title: 'Untitled',
    displayHeadline: 'Untitled',
    ownerName: 'Zhuge',
    ownerId: 'U001',
    workflow: 'default',
    model: 'claude-opus-5-5[1m]',
    channelId: 'C123',
    threadTs: `1700000000.000${n}`,
    activityState: 'idle',
    sessionState: 'MAIN',
    conversationId: `conv-${n}`,
    lastActivity: iso(10 * M),
    activeAccumulatedMs: 0,
    tokenUsage: usage(1_200_000, 1.4),
    ...over,
  };
}

const board = {
  working: [
    card('100', {
      displayHeadline: '결제 모듈 리팩터링',
      title: '결제 모듈 리팩터링',
      activityState: 'working',
      activeLegStartedAtMs: NOW - 4 * M,
      lastActivity: iso(30_000),
    }),
    card('200', {
      displayHeadline: 'QA pass: orders API on staging',
      title: 'QA pass: orders API on staging',
      activityState: 'working',
      activeLegStartedAtMs: NOW - 4 * M - 12_000,
      lastActivity: iso(20_000),
      cronJob: { id: 'job-1', name: 'nightly-qa' },
      tokenUsage: usage(52_343_063, 29.71),
    }),
  ],
  waiting: [
    card('300', {
      displayHeadline: '배포 승인 필요',
      title: '배포 승인 필요',
      activityState: 'waiting',
      lastActivity: iso(3 * M),
    }),
  ],
  idle: [
    card('400', {
      displayHeadline: '대시보드 접근성 점검',
      title: '대시보드 접근성 점검',
      activeAccumulatedMs: 6 * M,
      doneAt: NOW - 40 * M,
    }),
    card('500', {
      displayHeadline: '야간 리포트 — 오류 0건',
      title: '야간 리포트 — 오류 0건',
      cronJob: { id: 'job-2', name: 'nightly-report' },
      activeAccumulatedMs: 4 * M + 3000,
      doneAt: NOW - 5 * 60 * M,
      lastActivity: iso(5 * 60 * M),
    }),
  ],
  closed: [],
};

const run = (agoMs: number, over: Record<string, unknown> = {}) => ({
  executedAt: NOW - agoMs,
  status: 'success',
  executionPath: 'new_thread',
  ...over,
});
const cronJobs = [
  {
    id: 'job-1',
    name: 'nightly-qa',
    expression: '0 * * * *',
    owner: 'U001',
    channel: 'C123',
    mode: 'fastlane',
    target: 'channel',
    model: 'default',
    nextRunAt: Math.ceil(NOW / (60 * M)) * 60 * M,
    lastRunAt: NOW - 4 * M,
    historyCap: 20,
    runs: [
      run(4 * M, {
        session: {
          headline: 'QA pass: orders API on staging',
          activityState: 'working',
          live: true,
          boardKey: 'mock-inst::work:C123:1700000000.000200',
          conversationId: 'conv-200',
          tokens: 52_343_063,
          costUsd: 29.71,
          activeMs: 4 * M,
        },
      }),
      run(64 * M, {
        session: {
          headline: 'QA pass: 정산 배치',
          activityState: 'idle',
          live: false,
          conversationId: 'conv-x1',
          tokens: 18_200_000,
          costUsd: 9.12,
          activeMs: 21 * M,
        },
      }),
      run(124 * M, { status: 'failed', error: 'thread creation returned no ts' }),
      run(184 * M, {
        triggeredBy: 'U009',
        session: { headline: 'QA pass: 로그인 흐름', activityState: 'idle', live: false, conversationId: 'conv-x2' },
      }),
      run(244 * M),
      run(304 * M, { status: 'queued', executionPath: 'busy_queue' }),
    ],
  },
  {
    id: 'job-2',
    name: 'nightly-report',
    expression: '0 9 * * *',
    owner: 'U001',
    channel: 'C123',
    mode: 'default',
    target: 'channel',
    model: 'opus',
    nextRunAt: NOW + 19 * 60 * M,
    lastRunAt: NOW - 5 * 60 * M,
    historyCap: 20,
    runs: [5, 29, 53, 77, 101].map((h) =>
      run(h * 60 * M, { session: { headline: '야간 리포트 — 오류 0건', activityState: 'idle', live: h === 5 } }),
    ),
  },
  {
    id: 'job-3',
    name: 'dependabot-sweep',
    expression: '0 1 * * 1-5',
    owner: 'U001',
    channel: 'C123',
    mode: 'default',
    target: 'dm',
    model: 'fast',
    nextRunAt: NOW + 2 * 24 * 60 * M,
    lastRunAt: NOW - 24 * 60 * M,
    historyCap: 20,
    runs: [
      run(24 * 60 * M, { executionPath: 'dm' }),
      run(48 * 60 * M, { status: 'failed', executionPath: 'dm', error: 'delivery failed' }),
    ],
  },
];

// LLM capacity v2: an llmux snapshot shaped like the live pool of 2026-10-25
// (names neutral) through the real buildCapacityView. Per row: [name, 5h used,
// 5h reset in h (null = no 5h window), 7d used, 7d reset in h, status, reason,
// measured h ago]. Claude: 1 account 5h-capped, 9 weekly-capped, 3 at the
// weekly ceiling, 3 in a cooldown that ends 1 s before their weekly reset, 1 paused.
type Row = [string, number | null, number | null, number, number, string, string | null, number];
const CLAUDE: Row[] = [
  ['ai15', 0.23, 0.2, 0.29, 137.2, 'active', null, 4.2],
  ['ai1', 0.01, 4.8, 0.0, 157.2, 'active', null, 3.9],
  ['ai30', 0.0, -3.3, 0.09, 149.2, 'ok', null, 1.2],
  ['ai40', 0.0, -14, 0.24, 138.2, 'ok', null, 1.5],
  ['ai9', 0.0, -12.8, 0.25, 139.2, 'ok', null, 4.4],
  ['ai41', 0.0, -16.3, 0.36, 131.2, 'ok', null, 1.9],
  ['ai44', 0.0, -5.8, 0.36, 134.2, 'ok', null, 0.9],
  ['ai5', 0.0, -16.8, 0.61, 109.2, 'ok', null, 1.7],
  ['ai2', 0.05, 4.2, 0.76, 104.2, 'ok', null, 1.0],
  ['ai6', 0.19, 0.2, 0.78, 114.2, 'ok', null, 3.0],
  ['ai8', null, null, 1.0, 8.2, 'ok', '7d 100.0% > 99%', 2.5],
  ['ai3', null, null, 1.0, 33.2, 'ok', '7d 100.0% > 99%', 2.2],
  ['ai7', 0.0, -37, 1.0, 43.2, 'cooldown', 'cooldown 1d19h', 0.2],
  ['ai43', 0.0, -38.7, 1.0, 55.2, 'cooldown', 'cooldown 2d7h', 3.2],
  ['ai10', null, null, 1.0, 28.2, 'ok', '7d 100.0% > 99%', 0.5],
  ['ai4', 0.0, -38.7, 1.0, 90.2, 'cooldown', 'cooldown 3d18h', 3.7],
  ['ai11', 0.0, -0.8, 0.02, 150.2, 'ok', 'paused', 3.5],
];
// Codex reports no 5h window: the weekly measure only. ai12 · ai13 have no tier.
const CODEX: Row[] = [
  ['ai12', null, null, 0.2, 135.4, 'active', null, 114.9],
  ['ai13', null, null, 0.01, 138.2, 'ok', null, 204.1],
  ['ai2', null, null, 0.23, 135.5, 'ok', null, 115.4],
  ['ai5', null, null, 0.0, 167.8, 'ok', null, 60.2],
  ['ai6', null, null, 1.0, 135.2, 'ok', '7d 100.0% > 99%', 60.1],
];
const win = (used: number, inH: number) => ({
  utilization: used,
  resets_at: Math.round(NOW_S + inH * H),
  resets_in_secs: Math.round(inH * H),
});
const toAccount = (group: string) => (r: Row) => {
  const [name, u5, r5, u7, r7, status, blocked, agoH] = r;
  return {
    name: `${group}:${name}@corp.example`,
    type: group === 'codex' ? 'codex' : 'oauth',
    group,
    status,
    order: 1,
    blocked,
    five_hour: u5 === null || r5 === null ? null : win(u5, r5),
    seven_day: win(u7, r7),
    // live llmux: a long cooldown ends one second before the weekly reset
    cooldown_until: status === 'cooldown' ? Math.round(NOW_S + r7 * H) - 1 : null,
    last_refresh_ms: Math.round(NOW - agoH * H * 1000),
  };
};
const TIERS: Record<string, string> = Object.fromEntries(CLAUDE.map((r) => [`claude:${r[0]}`, 'claude-max-20x']));
let capacity: unknown = null;
function buildCapacity(build: (status: unknown, tiers: unknown, nowMs: number) => unknown) {
  const status = { current: null, accounts: [...CLAUDE.map(toAccount('claude')), ...CODEX.map(toAccount('codex'))] };
  capacity = { ...(build(status, TIERS, NOW) as object), fetchedAtMs: NOW - 12_000 };
}

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
].join('\n');

async function openPage(browser: Browser, width: number, theme: 'light' | 'dark'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 1100 }, colorScheme: theme });
  const page = await ctx.newPage();
  // A client script error must fail the receipt with its message, not a selector timeout.
  page.on('pageerror', (err) => check(false, `page error: ${err.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[console] ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`);
  });
  await page.addInitScript({
    content: `${PAGE_HELPERS}\nlocalStorage.setItem("soma-theme", "${theme}");localStorage.setItem("soma-board-view", "board");`,
  });
  await page.route('**/auth/me', (r) => r.fulfill({ json: { user: { name: 'Zhuge' }, csrfToken: 'x' } }));
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) =>
    r.fulfill({
      json: { totalSessions: 14, turnsUsed: 210, prsCreated: 6, prsMerged: 5, mergeLines: {}, workflows: {} },
    }),
  );
  await page.route('**/api/dashboard/usage**', (r) =>
    r.fulfill({ json: { totals: { totalInputTokens: 4_000_000, totalOutputTokens: 900_000, totalCostUsd: 58.2 } } }),
  );
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board } }));
  await page.route('**/api/dashboard/cron**', (r) => r.fulfill({ json: { jobs: cronJobs } }));
  await page.route('**/api/dashboard/capacity', (r) => r.fulfill({ json: { capacity } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => r.fulfill({ json: { turns: [] } }));
  await page.goto(`${BASE_URL}/dashboard/U001`);
  // Below 840×1000 both sections start folded (#409): wait for them to render,
  // then unfold capacity so the receipt shows the full view.
  await page.waitForSelector('#cron-lane:not([hidden]) .cron-group', { state: 'attached' });
  await page.waitForSelector('#capacity:not([hidden]) .cap-prov', { state: 'attached' });
  if ((await page.getAttribute('#capacity-toggle', 'aria-expanded')) === 'false') {
    await page.screenshot({ path: path.join(OUT, `cron-capacity-${width}-${theme}-folded.png`) });
    await page.click('#capacity-toggle');
  }
  await page.waitForSelector('#capacity .cap-prov', { state: 'visible' });
  await page.waitForTimeout(500);
  return page;
}

async function layout(browser: Browser) {
  for (const width of [1280, 390]) {
    for (const theme of ['light', 'dark'] as const) {
      const page = await openPage(browser, width, theme);
      const tag = `${width}-${theme}`;
      // Plain-JS page source: tsx's keepNames would wrap a named helper in __name().
      const order = (await page.evaluate(
        "(function () { var o = {}; ['stats', 'capacity', 'inbox', 'cron-lane', 'kanban'].forEach(function (id) { var el = document.getElementById(id); o[id] = el ? el.getBoundingClientRect().top : -1; }); return o; })()",
      )) as Record<string, number>;
      check(
        order.stats < order.capacity && order.capacity < order.inbox,
        `${tag}: capacity sits between the stats strip and the inbox`,
      );
      check(
        order['cron-lane'] < order.kanban && order['cron-lane'] >= order.inbox,
        `${tag}: CRON lane above the columns`,
      );
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(sideways <= 0, `${tag}: no page-level sideways scroll (${sideways}px)`);
      if (width === 1280 && theme === 'light') {
        const placement = await page.evaluate(() => ({
          laneCards: document.querySelectorAll('#cron-lane .card').length,
          columnCron: document.querySelectorAll('#kanban .card .cron-badge').length,
          laneBadges: document.querySelectorAll('#cron-lane .card .card-head > .cron-badge:first-child').length,
          tiles: document.querySelectorAll('#cron-groups .cron-group').length,
          claudeNow:
            document.querySelector('[data-group="claude"] .cap-bar-row.is-h5 .cap-bar-val b')?.textContent || '',
          claudeWeek:
            document.querySelector('[data-group="claude"] .cap-bar-row.is-wk .cap-bar-val b')?.textContent || '',
          codexNow: document.querySelectorAll('[data-group="codex"] .cap-bar-row.is-h5').length,
          codexWeek:
            document.querySelector('[data-group="codex"] .cap-bar-row.is-wk .cap-bar-val b')?.textContent || '',
          timelines: document.querySelectorAll('[data-group="claude"] .cap-tl').length,
          weeklyMarks: document.querySelectorAll('[data-group="claude"] .cap-tl-mk.is-wk').length,
          disc: document.querySelector('[data-group="claude"] .cap-disc')?.textContent || '',
        }));
        check(placement.columnCron === 0, 'no cron card left in the three columns');
        check(placement.laneCards === 2, `the lane shows each job's latest run as a card (${placement.laneCards})`);
        check(placement.laneBadges === 2, 'every lane card leads its head with the CRON badge');
        check(placement.tiles === 3, 'one tile per job, including a job with no card on the board');
        // The live-shaped pool: now ≈ week ≈ 6.3 of 16.0 Claude max accounts; Codex weekly only.
        const g0 = (capacity as { groups: { now: number; week: number }[] }).groups[0];
        const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
        check(
          placement.claudeNow === f1(g0.now) && placement.claudeWeek === '6.3',
          `Claude now/week ${placement.claudeNow}/${placement.claudeWeek} (server ${g0.now}/${g0.week})`,
        );
        check(
          placement.codexNow === 0 && placement.codexWeek === '1.3',
          `Codex shows the weekly measure only (${placement.codexWeek})`,
        );
        // Simplified card: one timeline with ◆ weekly refills; one honest disclosure line.
        check(
          placement.timelines === 1 && placement.weeklyMarks >= 3,
          `one timeline, weekly refills marked (${placement.weeklyMarks})`,
        );
        check(
          /16\/17 반영/.test(placement.disc) &&
            /차단 6/.test(placement.disc) &&
            /제외 1\(보류\)/.test(placement.disc),
          `disclosure line: ${placement.disc}`,
        );
      }
      if (width === 390) {
        const narrow = await page.evaluate(() => ({
          cards: document.querySelectorAll('.cap-prov.is-narrow').length,
          bars: document.querySelectorAll('.cap-prov.is-narrow .cap-bar-row').length,
        }));
        check(narrow.cards === 2 && narrow.bars === 3, `${tag}: narrow cards keep their bars (${narrow.bars})`);
      }
      await page.screenshot({ path: path.join(OUT, `cron-capacity-${tag}.png`), fullPage: true });
      await page.context().close();
    }
  }
}

async function drawer(browser: Browser) {
  for (const theme of ['light', 'dark'] as const) {
    const page = await openPage(browser, 1280, theme);
    await page.click('.cron-group[data-group="id:job-1"] .cron-history-btn');
    await page.waitForSelector('#cron-drawer.open');
    await page.waitForTimeout(400);
    const rows = await page.evaluate(() => ({
      title: document.getElementById('cron-drawer-title')?.textContent,
      runs: document.querySelectorAll('#cron-drawer-body .cron-run').length,
      fail: document.querySelectorAll('#cron-drawer-body .cron-run.is-fail').length,
      none: document.querySelectorAll('#cron-drawer-body .cron-run.is-none').length,
    }));
    check(rows.title === 'nightly-qa', `${theme}: drawer titled with the job (${rows.title})`);
    check(rows.runs === 6, `${theme}: one drawer row per run (${rows.runs})`);
    check(rows.fail === 1 && rows.none === 1, `${theme}: failed and queued runs carry their own glyph class`);
    await page.screenshot({ path: path.join(OUT, `cron-drawer-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const open = await page.evaluate(() => document.getElementById('cron-drawer')?.classList.contains('open'));
    check(open === false, `${theme}: Escape closes the drawer`);
    await page.context().close();
  }
}

async function main() {
  const { buildCapacityView } = await import('../src/conversation/capacity-view');
  buildCapacity(buildCapacityView as never);
  const dashboard = await import('../src/conversation/dashboard');
  dashboard.setDashboardSessionAccessor(() => new Map());
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  const browser = await chromium.launch({ headless: true });
  try {
    await layout(browser);
    await drawer(browser);
  } finally {
    await browser.close();
    await ws.stopWebServer();
  }
  fs.writeFileSync(path.join(OUT, 'report.txt'), `${report.join('\n')}\n`);
  console.log(`\n${report.filter((l) => l.startsWith('[ok]')).length}/${report.length} checks passed — ${OUT}`);
  if (failures.length > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
