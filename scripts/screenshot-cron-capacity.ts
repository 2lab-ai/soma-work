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
 *   - an empty provider leads with the countdown to its first account back
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
const BASE_URL = `http://127.0.0.1:${PORT}`;

const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);
const M = 60_000;
const H = 3600;
const D = 86400;
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

const mk = (
  account: string,
  tier: string | undefined,
  window: string,
  inS: number,
  gainPct: number,
  returns = false,
) => ({
  account,
  tier,
  window,
  at: NOW_S + inS,
  gainPct,
  returns,
});
const capacity = {
  available: true,
  fetchedAtMs: NOW - 12_000,
  groups: [
    {
      group: 'claude',
      label: 'Claude',
      availablePct: 61.5,
      availableAccounts: 3,
      unknownAccounts: 1,
      totalAccounts: 5,
      state: 'ok',
      nextRefill: { account: 'ai7', tier: 'claude-max-20x', window: '5h', at: NOW_S + 41 * 60 },
      nextReturn: { account: 'ai12', tier: 'claude-max-20x', window: '7d', at: NOW_S + 5 * D },
      markers: [
        mk('ai7', 'claude-max-20x', '5h', 41 * 60, 62),
        mk('ai3', 'claude-max-5x', '5h', 3 * H, 10),
        mk('ai8', undefined, '5h', 3 * H + 20 * 60, 44),
        mk('ai3', 'claude-max-5x', '7d', 4 * D, 20),
        mk('ai7', 'claude-max-20x', '7d', 5 * D - 3 * H, 31),
        mk('ai12', 'claude-max-20x', '7d', 5 * D, 100, true),
        mk('ai13', 'claude-max-20x', '7d-fable', 5 * D + 6 * H, 70),
      ],
      accounts: [],
    },
    {
      group: 'codex',
      label: 'Codex',
      availablePct: 0,
      availableAccounts: 0,
      unknownAccounts: 0,
      totalAccounts: 4,
      state: 'empty',
      nextReturn: { account: 'ai5', tier: 'chatgpt-pro-500', window: '5h', at: NOW_S + 2 * H + 14 * 60 },
      markers: [
        mk('ai5', 'chatgpt-pro-500', '5h', 2 * H + 14 * 60, 100, true),
        mk('ai1', 'chatgpt-pro-200', 'cooldown', 4 * H, 0, true),
        mk('ai6', 'chatgpt-pro-500', '7d', 2 * D + 4 * H, 100, true),
        mk('ai2', 'chatgpt-pro-200', '7d', 3 * D + 12 * H, 100, true),
      ],
      accounts: [],
    },
  ],
};

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
].join('\n');

async function openPage(browser: Browser, width: number, theme: 'light' | 'dark'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 1100 }, colorScheme: theme });
  const page = await ctx.newPage();
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
  await page.waitForSelector('#cron-lane:not([hidden]) .cron-group');
  await page.waitForSelector('#capacity:not([hidden]) .cap-row');
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
          codexLead: document.querySelector('.cap-row.is-empty .cap-next')?.textContent || '',
          markers: document.querySelectorAll('.cap-mk').length,
        }));
        check(placement.columnCron === 0, 'no cron card left in the three columns');
        check(placement.laneCards === 2, `the lane shows each job's latest run as a card (${placement.laneCards})`);
        check(placement.laneBadges === 2, 'every lane card leads its head with the CRON badge');
        check(placement.tiles === 3, 'one tile per job, including a job with no card on the board');
        check(
          /다음 복귀 ai5 · 2h 1[34]m/.test(placement.codexLead),
          `empty Codex leads with its first return (${placement.codexLead})`,
        );
        check(placement.markers >= 8, `timeline markers rendered (${placement.markers})`);
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
