/**
 * Status waves on the board (Z 2026-11-21: "작업카드 상태 변할때 … fable모델은 요란하게 다른 것들은 좀 살짝") — browser
 * receipts on the real dashboard page.
 *
 * The real web server serves the real page and the installed @2lab.ai/ui (≥ 0.44.0: <ui-agent-inbox> card.wave and
 * the distortion wave's engine); the board JSON is a browser route and the WebSocket is a stub that pushes the next
 * board, so every step is deterministic. Each check prints what it measured.
 *
 *   W1  the cards carry their wave: the Fable card 'loud', the Opus card 'quiet'
 *   W2  the Fable card moves RUNNING → NEEDS YOU: a wave canvas is laid over that card (and only it), then taken off
 *   W3  the Opus card moves RUNNING → NEEDS YOU: its quiet wave runs and ends sooner than the loud one
 *   W4  reduced motion: no canvas; the card's border takes the status colour (is-cue) for a moment
 *   Frames of W2 and W3 (every 120 ms) are written for the eye.
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-status-wave.ts [outDir]
 * Software WebGL (SwiftShader) draws a few frames a second: the frames show the shapes, not the real pace.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'status-wave');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.STATUS_WAVE_PORT || '33941';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NOW = Date.now();
const M = 60_000;
const KEY_F = 'mock-inst::work:C601:1700000000.000100';
const KEY_O = 'mock-inst::work:C602:1700000000.000200';
const KEY_S = 'mock-inst::work:C603:1700000000.000300';

function session(key: string, title: string, channel: string, state: string, model: string) {
  return {
    key,
    title,
    displayHeadline: title,
    summaryTitle: title,
    summaryBody: '',
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model,
    effort: 'high',
    channelId: channel,
    sessionState: 'MAIN',
    activityState: state,
    conversationId: `conv-${channel}`,
    lastActivity: new Date(NOW - 3 * M).toISOString(),
    activeLegStartedAtMs: NOW - 12 * M,
    activeAccumulatedMs: 0,
    tokenUsage: { totalInputTokens: 300_000, totalOutputTokens: 40_000, totalCostUsd: 6.2, contextUsagePercent: 22 },
    artifacts: { count: 0, recent: [] },
  };
}
const FABLE = session(KEY_F, 'Fable — 상태 웨이브 붙이기', 'C601', 'working', 'claude-fable-5-2[1m]');
const OPUS = session(KEY_O, 'Opus — 릴리즈 노트 검토', 'C602', 'working', 'claude-opus-5-5[1m]');
const SONNET = session(KEY_S, 'Sonnet — 이슈 분류', 'C603', 'idle', 'claude-sonnet-4-6');
const BOARD0 = { waiting: [], working: [FABLE, OPUS], idle: [SONNET] };
const waiting = (s: typeof FABLE) => ({ ...s, activityState: 'waiting', waitingSince: NOW });
// What the server would answer now: the last board pushed (a poll must not undo a push).
let CURRENT: unknown = BOARD0;

const PAGE_HELPERS = [
  'window.__card = function (k) { var h = document.getElementById("kanban"); var r = h && h.shadowRoot; var all = r ? r.querySelectorAll("li.ib-card[data-card]") : []; for (var i = 0; i < all.length; i++) if (all[i].getAttribute("data-card") === k) return all[i]; return null; };',
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
  'window.__wsSend = function (msg) { window.__ws.onmessage({ data: JSON.stringify(msg) }); };',
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
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: CURRENT } }));
  await page.route(/\/api\/dashboard\/session\/.*/, (r) =>
    r.fulfill({ json: { ok: true, turns: [], hasMore: false } }),
  );
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

async function open(page: Page) {
  // The viewer token (CONVERSATION_VIEWER_TOKEN) as the dashboard's bearer cookie.
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await page
      .context()
      .addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForFunction((k) => !!(window as any).__card(k), KEY_F, { timeout: 20_000 });
  await sleep(2500); // the wave module is fetched when the browser is idle
}

/**
 * Push a board, then watch the board in the page: which cards a wave canvas is laid on, when, and when it leaves
 * (a MutationObserver on the element's shadow root, page clock). Frames every 150 ms for the eye.
 */
async function watch(page: Page, key: string, board: unknown, tag: string) {
  CURRENT = board;
  const box = await page.evaluate((k) => {
    const r = (window as any).__card(k).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, key);
  await page.evaluate((b) => {
    const w = window as any;
    const root = document.getElementById('kanban')!.shadowRoot!;
    w.__waveLog = [];
    w.__waveT0 = performance.now();
    w.__waveObs?.disconnect();
    w.__waveObs = new MutationObserver((recs) => {
      for (const r of recs) {
        const t = Math.round(performance.now() - w.__waveT0);
        if (r.type === 'attributes' && r.attributeName === 'data-status')
          w.__waveLog.push({
            t,
            status: (r.target as Element).getAttribute('data-status'),
            card: (r.target as Element).getAttribute('data-card'),
          });
        for (const n of Array.from(r.addedNodes))
          if ((n as Element).localName === 'canvas')
            w.__waveLog.push({ t, on: true, card: (r.target as Element).getAttribute('data-card') });
        for (const n of Array.from(r.removedNodes))
          if ((n as Element).localName === 'canvas')
            w.__waveLog.push({ t, on: false, card: (r.target as Element).getAttribute('data-card') });
      }
    });
    w.__waveObs.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] });
    w.__wsSend({ type: 'session_update', board: b });
  }, board);
  for (let i = 0; i < (process.env.NO_SHOTS ? 0 : 12); i++) {
    await page.screenshot({
      path: path.join(OUT, `${tag}-${String(i).padStart(2, '0')}.png`),
      clip: { x: Math.max(0, box.x - 380), y: Math.max(0, box.y - 120), width: 1100, height: 420 },
    });
    await sleep(150);
  }
  await sleep(process.env.NO_SHOTS ? 5000 : 2000);
  const events = (await page.evaluate(() => (window as any).__waveLog)) as Array<{
    t: number;
    on?: boolean;
    status?: string;
    card: string;
  }>;
  const mine = events.filter((e) => e.card === key);
  // Times from the moment the card shows its new status (the board's own paint), not from the push.
  const changed = mine.find((e) => e.status !== undefined)?.t ?? 0;
  const first = (mine.find((e) => e.on === true)?.t ?? -1) - changed;
  const gone = (mine.find((e) => e.on === false)?.t ?? -1) - changed;
  const others = Array.from(new Set(events.filter((e) => e.card !== key && e.on !== undefined).map((e) => e.card)));
  return { changedAt: changed, first, gone, others: others.length, events };
}

async function motionRun(browser: import('playwright').Browser) {
  CURRENT = BOARD0;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
  await open(page);
  const waves = await page.evaluate(
    (keys) => {
      const h = document.getElementById('kanban') as any;
      const cards = (h.data?.columns || []).flatMap((c: any) => [
        ...(c.cards || []),
        ...(c.groups || []).flatMap((g: any) => g.cards || []),
      ]);
      return keys.map((k: string) => (cards.find((c: any) => c.id === k) || {}).wave ?? null);
    },
    [KEY_F, KEY_O, KEY_S],
  );
  check(waves[0] === 'loud' && waves[1] === 'quiet' && waves[2] === 'quiet', 'W1 Fable loud, the rest quiet', waves);
  const loud = await watch(page, KEY_F, { waiting: [waiting(FABLE)], working: [OPUS], idle: [SONNET] }, 'loud');
  check(
    loud.first >= 0 && loud.first < 400 && loud.gone > loud.first && loud.others === 0,
    'W2 Fable → NEEDS YOU: one wave on that card at once, then gone',
    loud,
  );
  await sleep(31_000); // past the loud card's cool-down, so the next board's pushes are fresh
  const quiet = await watch(
    page,
    KEY_O,
    { waiting: [waiting(FABLE), waiting(OPUS)], working: [], idle: [SONNET] },
    'quiet',
  );
  check(
    quiet.first >= 0 && quiet.first < 400 && quiet.gone > quiet.first && quiet.others === 0,
    'W3 Opus → NEEDS YOU: its quiet wave runs at once and ends; no other card waves',
    quiet,
  );
  check(quiet.gone - quiet.first <= loud.gone - loud.first, 'W3 the quiet wave is the shorter', {
    loud: loud.gone - loud.first,
    quiet: quiet.gone - quiet.first,
  });
  await ctx.close();
}

async function reducedRun(browser: import('playwright').Browser) {
  CURRENT = BOARD0;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await open(page);
  CURRENT = { waiting: [waiting(FABLE)], working: [OPUS], idle: [SONNET] };
  await page.evaluate((b) => (window as any).__wsSend({ type: 'session_update', board: b }), CURRENT);
  await sleep(200);
  const s = await page.evaluate((k) => {
    const c = (window as any).__card(k) as HTMLElement;
    return {
      cue: c.classList.contains('is-cue'),
      canvas: !!c.querySelector('canvas'),
      border: getComputedStyle(c).borderTopColor,
    };
  }, KEY_F);
  check(s.cue && !s.canvas, 'W4 reduced motion: no wave, the border cue instead', s);
  await page.screenshot({ path: path.join(OUT, 'reduced.png') });
  await ctx.close();
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  try {
    for (const run of [motionRun, reducedRun]) {
      const browser = await chromium.launch({
        headless: true,
        args: ['--single-process', '--no-zygote', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      });
      try {
        await run(browser);
      } finally {
        await browser.close();
      }
    }
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
