/**
 * 보낸 지시 (SSOT 2026-11-27) — browser receipts on the real dashboard page: the round button with the count beside
 * the follow-up queue's, the list it opens, and a row moving 대화 to its instruction.
 *
 * The real web server serves the real page and the installed @2lab.ai/ui; the board JSON, the conversation and the
 * instruction list are browser routes (the list is answered by instruction-history.ts's own instructionPage, the turns
 * by the session route's limit · before · through rules), and the WebSocket is a stub. Every check prints what it
 * judged (rects, counts, ids), never a bare boolean.
 *
 *   I1  the card opens: the button shows the count (40 instructions; the host turns are not counted) at the composer's
 *       top right, the queue's round button left of it on the same line
 *   I2  a press opens the list: #1 first, a page of 30; scrolled to its end, the next page comes (40 rows)
 *   I3  a row (#3, older than the turns the chat holds) closes the list; 대화 loads back to it and its turn sits at
 *       the top of the chat's box
 *   I4  최근부터: #40 first
 *   I5  from another tab (작업 로그): a row brings 대화 back and goes to the turn
 *   I6  a phone (390): the button at the composer's top right, the list across the sheet
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-instruction-history.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { ConversationTurn } from '../src/conversation/types';

// The list's answers come from the server's own rules; loaded in main(), after the port is set (a static import would
// load the config before it).
let ih: typeof import('../src/conversation/instruction-history');

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'instruction-history');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.IH_PORT || '33941';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NOW = Date.now();
const M = 60_000;
const KEY = 'mock-inst::work:C601:1700000000.000100';
const CID = 'conv-C601';

// 40 instructions, each answered at length (the chat is long), and two host turns (a cron fire, a goal continuation).
const TURNS: ConversationTurn[] = [];
for (let i = 1; i <= 40; i++) {
  const at = NOW - (200 - i * 4) * M;
  TURNS.push({
    id: `u${i}`,
    role: 'user',
    timestamp: at,
    userName: i % 7 === 0 ? 'Kate' : 'Zhuge',
    rawContent:
      i === 3
        ? '로그인 실패 시 에러 메시지를 사용자가 이해할 수 있게 바꾸고, 재시도 버튼도 붙여줘. 모바일에서도 확인해줘.'
        : `지시 ${i} — ${['테스트 보강', 'PR 리뷰 반영', '배포 확인', '문서 정리', '버그 재현'][i % 5]}`,
    origin: { by: 'user' },
  });
  TURNS.push({
    id: `a${i}`,
    role: 'assistant',
    timestamp: at + 2 * M,
    rawContent: '',
    summaryTitle: `답변 ${i}`,
    summaryBody: `지시 ${i}에 대한 긴 답변입니다.\n${'세부 내용 줄. '.repeat(30)}`,
    summarized: true,
  });
  if (i === 10)
    TURNS.push({
      id: 's1',
      role: 'user',
      timestamp: at + 3 * M,
      rawContent: '[cron:daily] 리포트',
      origin: { by: 'system' },
    });
  if (i === 20)
    TURNS.push({
      id: 's2',
      role: 'user',
      timestamp: at + 3 * M,
      rawContent: '[goal-continuation] go on',
      origin: { by: 'system' },
    });
}

const BOARD = {
  waiting: [],
  working: [
    {
      key: KEY,
      title: '로그인 오류 메시지 개선',
      displayHeadline: '로그인 오류 메시지 개선',
      summaryTitle: '로그인 오류 메시지 개선',
      summaryBody: '오류 메시지와 재시도 버튼',
      ownerId: 'U001',
      ownerName: 'Zhuge',
      workflow: 'zwork',
      model: 'claude-opus-5-5[1m]',
      effort: 'high',
      channelId: 'C601',
      sessionState: 'MAIN',
      activityState: 'working',
      conversationId: CID,
      lastActivity: new Date(NOW - 1 * M).toISOString(),
      activeLegStartedAtMs: NOW - 12 * M,
      activeAccumulatedMs: 0,
      slackThreadUrl: 'https://slack.example/archives/C601/p1700000000000',
      tokenUsage: { totalInputTokens: 300_000, totalOutputTokens: 40_000, totalCostUsd: 6.2, contextUsagePercent: 22 },
      artifacts: { count: 0, recent: [] },
      tasks: [],
      // One note waits in the follow-up queue: its round button shows beside 보낸 지시.
      followups: {
        items: [
          {
            id: 'f1',
            text: '끝나면 스크린샷도 올려줘',
            state: 'queued',
            enqueuedAt: NOW - M,
            author: 'Zhuge',
            authorId: 'U001',
          },
        ],
      },
    },
  ],
  idle: [],
};

function turnsPage(url: URL) {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 30)));
  const before = url.searchParams.get('before');
  const through = url.searchParams.get('through');
  let end = TURNS.length;
  if (before)
    end = Math.max(
      0,
      TURNS.findIndex((t) => t.id === before),
    );
  let start = Math.max(0, end - limit);
  if (through) {
    const ti = TURNS.findIndex((t) => t.id === through);
    if (ti >= 0 && ti < start) start = Math.max(ti, end - 1000);
  }
  const turns = TURNS.slice(start, end).map((t) => ({
    ...t,
    rawContent: t.role === 'user' ? t.rawContent : undefined,
  }));
  return { id: CID, title: CID, titleSub: '', turnCount: TURNS.length, turns, hasMore: start > 0 };
}

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
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
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: BOARD } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts/, (r) => r.fulfill({ json: { artifacts: [] } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog/, (r) =>
    r.fulfill({ json: { entries: [], hasMore: false } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/instructions/, (r) => {
    const u = new URL(r.request().url());
    const q = ih.parseInstructionQuery(Object.fromEntries(u.searchParams.entries()));
    return r.fulfill({ json: ih.instructionPage(TURNS, q) });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    return r.fulfill({ json: turnsPage(new URL(r.request().url())) });
  });
  await page.route(/\/api\/conversations\/[^/]+\/turns\/[^/]+\/raw/, (r) =>
    r.fulfill({ json: { raw: `답변 본문입니다.\n\n${'긴 답변의 한 문단입니다. '.repeat(40)}` } }),
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
async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, name) });
}

async function boot(page: Page) {
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await page
      .context()
      .addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForSelector(`li.ib-card[data-card="${KEY}"] [data-win="detail"]`, { timeout: 30_000 });
  await sleep(600);
  await page.click(`li.ib-card[data-card="${KEY}"] [data-win="detail"]`);
  await page.waitForSelector('#ih-dock:not([hidden])', { timeout: 15_000 });
  await sleep(900);
}

type Rect = { x: number; y: number; w: number; h: number };
async function docks(page: Page) {
  return page.evaluate(() => {
    const r = (el: Element | null | undefined): Rect | null => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const steer = document.getElementById('cmd-steer');
    const q = steer?.shadowRoot?.querySelector('.as-dock[data-shown]');
    return {
      ih: r(document.getElementById('ih-dock')),
      ihText: document.getElementById('ih-dock-n')?.textContent,
      queue: r(q),
      queueText: q?.textContent?.trim(),
      composer: r(steer),
    };
  });
}
async function listState(page: Page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#ih-list .ih-row'));
    const pop = document.getElementById('ih-pop') as HTMLElement;
    const b = pop.getBoundingClientRect();
    return {
      open: pop.hasAttribute('data-open'),
      rows: rows.length,
      first: rows[0]?.querySelector('.ih-n')?.textContent,
      last: rows[rows.length - 1]?.querySelector('.ih-n')?.textContent,
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    };
  });
}
// Where the turn sits in the chat's box (its top against the box's top), and which section shows.
async function turnInChat(page: Page, id: string) {
  return page.evaluate((tid) => {
    const conv = document.getElementById('panel-conv') as any;
    const node = conv?.turnElement ? conv.turnElement(tid) : null;
    const sc = conv?.shadowRoot?.querySelector('ui-log-scroller');
    const vp = sc?.shadowRoot?.querySelector('.ls-vp') as HTMLElement | null;
    if (!node || !vp) return { found: !!node, vp: !!vp };
    const n = node.getBoundingClientRect();
    const v = vp.getBoundingClientRect();
    return {
      found: true,
      offset: Math.round(n.top - v.top),
      inView: n.top >= v.top - 1 && n.top < v.bottom,
      vpH: Math.round(v.height),
      section: (window as any)._psec,
    };
  }, id);
}

async function desktopRun(browser: import('playwright').Browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await boot(page);
  log('\n── 1440 light ──');

  // I1
  const d = await docks(page);
  check(
    d.ihText === '40' &&
      !!d.ih &&
      !!d.queue &&
      d.queue.x + d.queue.w <= d.ih.x &&
      Math.abs(d.queue.y + d.queue.h / 2 - (d.ih.y + d.ih.h / 2)) <= 2 &&
      !!d.composer &&
      d.ih.x + d.ih.w <= d.composer.x + d.composer.w + 1 &&
      d.ih.y + d.ih.h <= d.composer.y,
    'I1 the count (40, host turns left out) at the composer’s top right; the queue’s button left of it, same line',
    d,
  );
  await shot(page, '01-button.png');

  // I2
  await page.click('#ih-dock');
  await sleep(700);
  const l1 = await listState(page);
  check(l1.open && l1.first === '#1' && l1.rows >= 30, 'I2 a press opens the list: #1 first, the first page', l1);
  await shot(page, '02-list.png');
  await page.evaluate(() => {
    const list = document.getElementById('ih-list') as HTMLElement;
    list.scrollTop = list.scrollHeight;
  });
  await sleep(800);
  const l2 = await listState(page);
  check(l2.rows === 40 && l2.last === '#40', 'I2 scrolled to its end, the next page comes', l2);
  await shot(page, '03-list-end.png');

  // I3
  await page.evaluate(() => {
    const list = document.getElementById('ih-list') as HTMLElement;
    list.scrollTop = 0;
  });
  await sleep(200);
  const before = await page.evaluate(() => (window as any)._panelTurnsList.length);
  await page.click('#ih-list .ih-row[data-id="u3"]');
  await sleep(1500);
  const t3 = await turnInChat(page, 'u3');
  const after = await page.evaluate(() => (window as any)._panelTurnsList.length);
  const l3 = await listState(page);
  check(
    !l3.open && t3.found === true && (t3 as any).inView === true && Math.abs((t3 as any).offset - 12) <= 24,
    'I3 a row (#3) closes the list; 대화 loads back to it and its turn sits at the top of the chat',
    { turn: t3, turnsHeldBefore: before, turnsHeldAfter: after, listOpen: l3.open },
  );
  await shot(page, '04-jumped.png');

  // I4
  await page.click('#ih-dock');
  await sleep(500);
  await page.click('.ih-ord[data-order="desc"]');
  await sleep(700);
  const l4 = await listState(page);
  check(l4.first === '#40', 'I4 최근부터: #40 first', l4);
  await shot(page, '05-newest-first.png');

  // I5
  await page.click('#ih-list .ih-row[data-id="u30"]');
  await sleep(300);
  await page.evaluate(() => (window as any).selectPanelSection('log'));
  await sleep(300);
  await page.click('#ih-dock');
  await sleep(600);
  await page.click('#ih-list .ih-row[data-id="u12"]');
  await sleep(1500);
  const t12 = await turnInChat(page, 'u12');
  check(
    (t12 as any).section === 'conv' && (t12 as any).inView === true,
    'I5 from 작업 로그: a row brings 대화 back and goes to the turn',
    t12,
  );
  await shot(page, '06-from-log.png');
  check(errors.length === 0, 'no page errors (1440)', errors);
  await ctx.close();
}

async function phoneRun(browser: import('playwright').Browser) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await boot(page);
  log('\n── 390 phone dark ──');
  const d = await docks(page);
  check(
    !!d.ih && d.ih.w >= 44 && d.ih.h >= 44 && d.ih.x + d.ih.w <= 390 && !!d.queue && d.queue.x + d.queue.w <= d.ih.x,
    'I6 the button (44px) at the composer’s top right on a phone, the queue’s left of it',
    d,
  );
  await shot(page, '07-phone-button.png');
  await page.tap('#ih-dock');
  await sleep(700);
  const l = await listState(page);
  check(l.open && l.rect.x >= 0 && l.rect.x + l.rect.w <= 390, 'I6 the list across the sheet', l);
  await shot(page, '08-phone-list.png');
  await page.tap('#ih-list .ih-row[data-id="u5"]');
  await sleep(1500);
  const t5 = await turnInChat(page, 'u5');
  check((t5 as any).inView === true, 'I6 a row on the phone goes to the turn', t5);
  await shot(page, '09-phone-jumped.png');
  check(errors.length === 0, 'no page errors (390)', errors);
  await ctx.close();
}

async function main() {
  ih = await import('../src/conversation/instruction-history');
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  try {
    for (const run of [desktopRun, phoneRun]) {
      const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
