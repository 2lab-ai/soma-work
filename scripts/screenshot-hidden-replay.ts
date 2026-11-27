/**
 * Out of view → back (the hidden-tab replay) — browser receipts on the real dashboard page.
 *
 * A tab the browser froze (Chrome's Energy Saver, a collapsed tab group) or suspended (Safari) holds its socket's
 * messages and runs them all, back to back, once it is shown again. The page is visible by then, so every push used to
 * play its glides, fades and waves: the board replayed the time nobody watched. The fix lands that backlog still.
 *
 * The real web server serves the real page and the installed @2lab.ai/ui; the board JSON is a browser route and the
 * WebSocket is a stub this script drives, so every step is deterministic. The page's visibility is a switch this script
 * flips (document.hidden / visibilityState on Document.prototype, then a visibilitychange event), because a headless
 * browser never hides a tab. Every Element.animate() call is counted (the board's glides, enter fades, status pops).
 *
 *   H1  live and in view: a push that moves a card glides it (the counter sees the motion — the receipt can fail)
 *   H2  away (hidden), then back: the held pushes run back to back — the board ends where the last push put it, and
 *       not one animation runs while it catches up
 *   H3  once the socket has been quiet after the return, the next live push glides again
 *   H4  a reconnect's first board (onopen → hello → whole board) lands still too
 *   H5  back from away, the overdue board poll answers late (after the socket went quiet): its board lands still
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-hidden-replay.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'hidden-replay');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.HIDDEN_REPLAY_PORT || '33941';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NOW = Date.now();
const M = 60_000;
const KEYS = [0, 1, 2, 3].map((i) => `mock-inst::work:C60${i}:1700000000.00060${i}`);

function session(key: string, title: string, state: 'working' | 'waiting' | 'idle', tokens: number) {
  return {
    key,
    title,
    displayHeadline: title,
    summaryTitle: title,
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model: 'claude-opus-5-5[1m]',
    effort: 'high',
    channelId: key.split(':')[2],
    sessionState: 'MAIN',
    activityState: state,
    conversationId: `conv-${key.split(':')[2]}`,
    lastActivity: new Date(NOW - 3 * M).toISOString(),
    activeLegStartedAtMs: NOW - 12 * M,
    activeAccumulatedMs: 0,
    tokenUsage: {
      totalInputTokens: tokens,
      totalOutputTokens: 4_000,
      totalCostUsd: tokens / 50_000,
      contextUsagePercent: 22,
    },
    artifacts: { count: 0, recent: [] },
    tasks: [],
  };
}
const TITLES = ['결제 모듈 리팩터', 'dev 로그 확인', '릴리즈 노트 정리', '대시보드 지표'];
// A board: each card's column (w = working, n = needs you, i = idle) and its input tokens (they count up when they grow).
function board(cols: string, tokens = 300_000) {
  const b: Record<string, unknown[]> = { waiting: [], working: [], idle: [], closed: [] };
  cols.split('').forEach((c, i) => {
    const col = c === 'w' ? 'working' : c === 'n' ? 'waiting' : 'idle';
    b[col].push(session(KEYS[i], TITLES[i], col as 'working' | 'waiting' | 'idle', tokens + i * 1_000));
  });
  return b;
}
const FIRST = board('wwii');
// What the board poll answers, and how long it takes (H5: a slow answer after the return).
let POLL = FIRST;
let POLL_DELAY_MS = 0;

const PAGE_HELPERS = [
  // The tab's visibility, flipped by the script (a headless browser never hides a tab).
  'window.__hidden = false;',
  'Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: function () { return window.__hidden; } });',
  'Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: function () { return window.__hidden ? "hidden" : "visible"; } });',
  'window.__setHidden = function (h) { window.__hidden = h; document.dispatchEvent(new Event("visibilitychange")); };',
  // Every Element.animate() call: the board's glides, enter fades and status pops all go through it.
  'window.__anims = 0;',
  'var __animate = Element.prototype.animate;',
  'Element.prototype.animate = function () { window.__anims++; return __animate.apply(this, arguments); };',
  // The socket: a stub the script opens and feeds.
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
  'window.WebSocket.prototype.send = function () {};',
  'window.__pushed = 0;',
  'window.__push = function (msg) { window.__ws.onmessage({ data: JSON.stringify(msg) }); window.__pushed++; };',
  // Where each card is drawn now: its column (the <section> it sits in).
  'window.__cols = function () { var h = document.getElementById("kanban"); var r = h && h.shadowRoot; var out = {}; if (!r) return out; r.querySelectorAll("li.ib-card[data-card]").forEach(function (li) { var sec = li.closest("section"); out[li.getAttribute("data-card")] = sec ? sec.getAttribute("data-col") || sec.id || "?" : "?"; }); return out; };',
  'window.__name = function (f) { return f; };',
].join('\n');

async function installMocks(page: Page) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'x' } }),
  );
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route('**/api/dashboard/sessions**', async (r) => {
    const answer = POLL;
    if (POLL_DELAY_MS) await sleep(POLL_DELAY_MS);
    await r.fulfill({ json: { board: answer } });
  });
}

const failures: string[] = [];
const report: string[] = [];
function log(line: string) {
  report.push(line);
  console.log(line);
}
function check(ok: boolean, what: string, detail?: unknown) {
  log(`${ok ? '[ok]  ' : '[FAIL]'} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(what);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const anims = (page: Page) => page.evaluate(() => (window as any).__anims as number);
const resetAnims = (page: Page) => page.evaluate(() => ((window as any).__anims = 0));
const push = (page: Page, msg: unknown) => page.evaluate((m) => (window as any).__push(m), msg);
const cols = (page: Page) => page.evaluate(() => (window as any).__cols() as Record<string, string>);
const where = (c: Record<string, string>) => KEYS.map((k) => c[k] ?? '-').join(' ');

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const tok = process.env.CONVERSATION_VIEWER_TOKEN;
    if (tok)
      await ctx.addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
    const page = await ctx.newPage();
    await installMocks(page);
    await page.goto(`${BASE_URL}/dashboard/U001`);
    await page.waitForSelector(`li.ib-card[data-card="${KEYS[0]}"]`, { timeout: 20_000 });
    // The socket opens and says hello with the board it holds.
    await page.evaluate(() => (window as any).__ws.onopen());
    await push(page, { type: 'hello', build: '' });
    await push(page, { type: 'session_update', board: FIRST });
    await sleep(1_500);
    log(`first board  — ${where(await cols(page))}`);

    // H1 — live, in view: a card moves to 응답 필요.
    await resetAnims(page);
    await push(page, { type: 'session_update', board: board('nwii', 310_000) });
    await sleep(700);
    const h1 = await anims(page);
    check(h1 > 0, 'H1 live in view: the push that moves a card animates it', {
      animations: h1,
      cols: where(await cols(page)),
    });
    await page.screenshot({ path: path.join(OUT, 'h1-live.png') });

    // H2 — away, then back: the browser held 6 pushes and runs them back to back the moment the tab shows.
    await page.evaluate(() => (window as any).__setHidden(true));
    await sleep(300);
    await resetAnims(page);
    const backlog = ['wnii', 'iwnw', 'nwwi', 'wiwn', 'iwwn', 'iinw'];
    const pushedBefore = await page.evaluate(() => (window as any).__pushed as number);
    await page.evaluate(
      (boards) => {
        (window as any).__setHidden(false);
        // Each held message is its own task, as a thawed socket delivers them.
        boards.forEach((b, i) => {
          setTimeout(() => (window as any).__push({ type: 'session_update', board: b }), i);
        });
      },
      backlog.map((c, i) => board(c, 320_000 + i * 10_000)),
    );
    // Every held push has run (a slow machine renders each board in tens of ms), and their frames are drawn.
    await page.waitForFunction((n) => (window as any).__pushed >= n, pushedBefore + backlog.length);
    await sleep(100);
    const h2 = await anims(page);
    const h2cols = await cols(page);
    // The last held push: A, B idle (DONE), C needs you, D running.
    const wantCols = 'done done waiting working';
    check(where(h2cols) === wantCols, 'H2 back from away: the board ends where the last held push put it', {
      cols: where(h2cols),
      want: wantCols,
    });
    check(h2 === 0, 'H2 back from away: the held pushes run without one animation', { animations: h2 });
    await page.screenshot({ path: path.join(OUT, 'h2-after-backlog.png') });

    // H3 — the socket was quiet after the return: the next live push animates again.
    await sleep(1_200);
    await resetAnims(page);
    await push(page, { type: 'session_update', board: board('wwii', 400_000) });
    await sleep(700);
    const h3 = await anims(page);
    check(h3 > 0, 'H3 settled: the next live push animates again', { animations: h3, cols: where(await cols(page)) });

    // H4 — a reconnect: the socket opens again and its first board is the whole board, all at once.
    await resetAnims(page);
    await page.evaluate(() => {
      (window as any).__ws.onopen();
      (window as any).__push({ type: 'hello', build: '' });
    });
    await push(page, { type: 'session_update', board: board('niwi', 410_000) });
    await sleep(120);
    const h4 = await anims(page);
    check(h4 === 0, 'H4 a reconnect lands its first board still', { animations: h4, cols: where(await cols(page)) });

    // H5 — away, then back: the 30 s poll a frozen tab owes fires at once and answers 1.5 s later, long after the
    // socket went quiet. Its board moved cards while nobody watched.
    await sleep(1_200);
    await page.evaluate(() => (window as any).__setHidden(true));
    await sleep(300);
    POLL = board('wnwi', 420_000);
    POLL_DELAY_MS = 1_500;
    await resetAnims(page);
    await page.evaluate(() => {
      (window as any).__setHidden(false);
      (window as any).loadSessions();
    });
    await sleep(2_300);
    const h5 = await anims(page);
    const h5cols = where(await cols(page));
    POLL_DELAY_MS = 0;
    check(h5cols === 'working waiting working done', 'H5 the late poll answer painted the board', { cols: h5cols });
    check(h5 === 0, 'H5 the late poll answer lands still', { animations: h5 });
  } finally {
    await browser.close();
  }
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  try {
    await run();
  } finally {
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
