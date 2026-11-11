/**
 * LLM capacity — fold / unfold receipt (2026-11-11 redesign). The real web server serves the real
 * dashboard page; the browser's HTTP layer is mocked (board, cron, capacity through the real
 * buildCapacityView) and the WebSocket is a stub. Writes, per width × theme:
 *   capacity-<w>-<theme>-folded.png    (the capacity section, folded — the default)
 *   capacity-<w>-<theme>-open.png      (the section unfolded)
 *   capacity-<w>-<theme>-page.png      (the first screen, folded, in its page)
 * Checks (exit 1 on any failure): the folded section is one line per provider — no chip, no
 * glyph — and short; a press on a line unfolds it into a detail card per provider with the
 * 7-day forecast; no page-level sideways scroll.
 * Run from the repo root:
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-capacity-fold.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'capacity-fold');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CONVERSATION_VIEWER_PORT || '33919';
process.env.CONVERSATION_VIEWER_PORT = PORT;
for (const k of ['CONVERSATION_VIEWER_TOKEN', 'DASHBOARD_JWT_SECRET', 'GOOGLE_CLIENT_ID', 'MICROSOFT_CLIENT_ID']) {
  process.env[k] = '';
}
const BASE_URL = `http://127.0.0.1:${PORT}`;
const GLYPHS = /[⏸⚠◌✗▲●]/;

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
// (names neutral) through the real buildCapacityView. Per row: [name, 7d used,
// 7d reset in h, status, reason, measured h ago]. There is no 5-hour window
// since 2026-11. Claude: 3 at the weekly ceiling, 3 in a cooldown that ends 1 s
// before their weekly reset, 1 paused.
type Row = [string, number, number, string, string | null, number];
const CLAUDE: Row[] = [
  ['ai15', 0.29, 137.2, 'active', null, 4.2],
  ['ai1', 0.0, 157.2, 'active', null, 3.9],
  ['ai30', 0.09, 149.2, 'ok', null, 1.2],
  ['ai40', 0.24, 138.2, 'ok', null, 1.5],
  ['ai9', 0.25, 139.2, 'ok', null, 4.4],
  ['ai41', 0.36, 131.2, 'ok', null, 1.9],
  ['ai44', 0.36, 134.2, 'ok', null, 0.9],
  ['ai5', 0.61, 109.2, 'ok', null, 1.7],
  ['ai2', 0.76, 104.2, 'ok', null, 1.0],
  ['ai6', 0.78, 114.2, 'ok', null, 3.0],
  ['ai8', 1.0, 8.2, 'ok', '7d 100.0% > 99%', 2.5],
  ['ai3', 1.0, 33.2, 'ok', '7d 100.0% > 99%', 2.2],
  ['ai7', 1.0, 43.2, 'cooldown', 'cooldown 1d19h', 0.2],
  ['ai43', 1.0, 55.2, 'cooldown', 'cooldown 2d7h', 3.2],
  ['ai10', 1.0, 28.2, 'ok', '7d 100.0% > 99%', 0.5],
  ['ai4', 1.0, 90.2, 'cooldown', 'cooldown 3d18h', 3.7],
  ['ai11', 0.02, 150.2, 'ok', 'paused', 3.5],
];
// Codex: the weekly measure. ai12 · ai13 have no tier.
const CODEX: Row[] = [
  ['ai12', 0.2, 135.4, 'active', null, 114.9],
  ['ai13', 0.01, 138.2, 'ok', null, 204.1],
  ['ai2', 0.23, 135.5, 'ok', null, 115.4],
  ['ai5', 0.0, 167.8, 'ok', null, 60.2],
  ['ai6', 1.0, 135.2, 'ok', '7d 100.0% > 99%', 60.1],
];
const win = (used: number, inH: number) => ({
  utilization: used,
  resets_at: Math.round(NOW_S + inH * H),
  resets_in_secs: Math.round(inH * H),
});
const toAccount = (group: string) => (r: Row) => {
  const [name, u7, r7, status, blocked, agoH] = r;
  return {
    name: `${group}:${name}@corp.example`,
    type: group === 'codex' ? 'codex' : 'oauth',
    group,
    status,
    order: 1,
    blocked,
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

async function openPage(browser: Browser, width: number, height: number, theme: 'light' | 'dark'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
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
  await page.waitForSelector('#boot', { state: 'detached' });
  await page.waitForSelector('#capacity:not([hidden]) .capacity', { state: 'attached' });
  // Park the pointer off the section so no hover state is captured.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(600);
  return page;
}

async function shoot(browser: Browser) {
  const sizes: Array<[number, number]> = [
    [1440, 1000],
    [390, 844],
  ];
  for (const [width, height] of sizes) {
    for (const theme of ['light', 'dark'] as const) {
      const page = await openPage(browser, width, height, theme);
      const tag = `${width}-${theme}`;
      const groups = (capacity as { groups: unknown[] }).groups.length;
      const aq = page.locator('#capacity-aq');
      check((await aq.locator('.cap-line').count()) === groups, `${tag}: folded — one line per provider (${groups})`);
      check((await aq.locator('.cap-detail, .cap-chip').count()) === 0, `${tag}: folded — no detail, no chip`);
      const folded = (await aq.locator('.cap-table').innerText()).replace(/\s+/g, ' ');
      check(!GLYPHS.test(folded), `${tag}: folded — words, no glyphs: ${folded}`);
      const h = Math.round((await page.locator('#capacity').boundingBox())?.height ?? 0);
      check(h <= (width < 600 ? 180 : 140), `${tag}: folded height ${h}px`);
      await page.screenshot({ path: path.join(OUT, `capacity-${tag}-page.png`) });
      await page.locator('#capacity').screenshot({ path: path.join(OUT, `capacity-${tag}-folded.png`) });
      // The folded section opens from a press on any of its lines (the toggle stays the keyboard's way in).
      await page.locator('#capacity-aq .cap-line').first().click();
      await page.waitForSelector('#capacity-aq .cap-detail', { state: 'visible' });
      await page.mouse.move(1, 1);
      await page.waitForTimeout(700);
      check(
        (await aq.locator('.cap-detail').count()) === groups,
        `${tag}: a press on a line unfolds — a detail card per provider`,
      );
      check(
        (await aq.locator('.cap-fc-svg').count()) >= 1 && (await aq.locator('.cap-tl').count()) === 0,
        `${tag}: 7-day step forecast, no log timeline`,
      );
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(sideways <= 0, `${tag}: no page-level sideways scroll (${sideways}px)`);
      await page.locator('#capacity').screenshot({ path: path.join(OUT, `capacity-${tag}-open.png`) });
      // A press on an account opens its card and leaves the section open.
      await aq.locator('.aq-mark').first().click();
      check(
        (await aq.locator('.aq-pop').count()) === 1 && (await aq.locator('.cap-detail').count()) === groups,
        `${tag}: an account press opens its card, the section stays open`,
      );
      await page.keyboard.press('Escape');
      // The head row folds it; the choice is saved per device and survives a reload.
      await aq.locator('.cap-title').click();
      await page.waitForTimeout(200);
      check((await aq.locator('.cap-detail').count()) === 0, `${tag}: a press on the head row folds it`);
      check(
        (await page.evaluate(() => localStorage.getItem('soma-sec-capacity'))) === 'closed',
        `${tag}: the fold is saved (soma-sec-capacity = closed)`,
      );
      await aq.locator('.cap-line').first().click();
      await page.reload();
      await page.waitForSelector('#boot', { state: 'detached' });
      await page.waitForSelector('#capacity-aq .cap-detail', { state: 'attached' });
      check(
        (await aq.locator('.cap-detail').count()) === groups,
        `${tag}: unfolded stays unfolded after a reload (soma-sec-capacity = open)`,
      );
      await page.context().close();
      console.log(`shot ${tag}`);
    }
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
    await shoot(browser);
  } finally {
    await browser.close();
    await ws.stopWebServer();
  }
  console.log(`done — ${OUT}`);
  if (failures.length > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
