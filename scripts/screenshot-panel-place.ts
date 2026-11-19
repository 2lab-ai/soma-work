/**
 * 디테일 카드 위치 (SSOT 2026-11-19) — browser receipts on the real dashboard and settings pages.
 *
 * The real web server serves the real pages and the installed @2lab.ai/ui; the board, the conversation and the
 * user's layout document are browser routes (the place a PUT saves is what the next GET answers), the WebSocket a
 * stub. Every check prints the rects it judged, never a bare boolean.
 *
 *   P1  unlocked (nothing saved): the detail card docks right with a grip at the top centre of its title bar
 *   P2  the grip lifts on hover; a drag lifts the card, it follows the pointer, both docks show as slots, the left lit
 *   P3  let go past the middle: it glides to the left dock (its x falls frame by frame), the board moves right of it,
 *       one PUT …/dashboard-layout/panel saves { side: left }, a toast says so with 실행 취소
 *   P4  a reload opens it on the left; let go short of the middle and it settles back (nothing saved); Esc mid-drag too
 *   P5  ←/→ on the grip moves it from the keyboard; a press on the grip moves it to the other side; the title bar's
 *       own surface drags it too
 *   P6  locked: no grip, the title bar does not drag
 *   P7  a phone (390): a full-screen sheet, no grip
 *   P8  the settings page: 디테일 카드 위치 — two pictures and 위치 잠금; a pick and the lock each save alone
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-panel-place.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'panel-place');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.PANEL_PLACE_PORT || '33941';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NOW = Date.now();
const M = 60_000;
const KEY_A = 'mock-inst::work:C601:1700000000.000100';
const KEY_B = 'mock-inst::work:C602:1700000000.000200';
const KEY_C = 'mock-inst::work:C603:1700000000.000300';

function session(key: string, title: string, channel: string, state: string, summary: string) {
  return {
    key,
    title,
    displayHeadline: title,
    summaryTitle: title,
    summaryBody: summary,
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model: 'claude-opus-5-5[1m]',
    effort: 'high',
    channelId: channel,
    sessionState: 'MAIN',
    activityState: state,
    conversationId: `conv-${channel}`,
    lastActivity: new Date(NOW - 3 * M).toISOString(),
    activeLegStartedAtMs: NOW - 12 * M,
    activeAccumulatedMs: 0,
    slackThreadUrl: `https://slack.example/archives/${channel}/p1700000000000`,
    tokenUsage: { totalInputTokens: 300_000, totalOutputTokens: 40_000, totalCostUsd: 6.2, contextUsagePercent: 22 },
    artifacts: { count: 0, recent: [] },
    tasks: [{ id: '1', content: '디테일 카드 위치 바꾸기', activeForm: '위치 바꾸는 중', status: 'in_progress' }],
  };
}
const BOARD = {
  waiting: [],
  working: [
    session(KEY_A, '디테일 작업 카드 왼쪽 이동', 'C601', 'working', '상단바 손잡이로 디테일 카드를 왼쪽에 붙인다.'),
    session(KEY_B, 'dev 로그 문제 확인', 'C602', 'working', '배포 로그에서 재시작 원인을 찾는다.'),
  ],
  idle: [session(KEY_C, '릴리즈 노트 정리', 'C603', 'idle', '지난주 머지된 PR을 묶어 노트를 쓴다.')],
};
const TURNS = [
  {
    id: 'u1',
    role: 'user',
    timestamp: new Date(NOW - 10 * M).toISOString(),
    userName: 'Zhuge',
    rawContent: '디테일 작업 카드 패널을 왼쪽으로 옮길 수 있게 해줘',
    origin: { by: 'user' },
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: new Date(NOW - 5 * M).toISOString(),
    summaryTitle: '진행',
    summaryBody: '상단바에 손잡이를 달았습니다',
    summarized: true,
  },
];

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
  'window.__name = function (f) { return f; };',
].join('\n');

// The user's layout document as the server keeps it: a place PUT changes it, the next GET answers it.
let DOC: Record<string, unknown> = { v: 1 };
let placePuts: unknown[] = [];
let wholePuts: unknown[] = [];

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
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    const cid = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    return r.fulfill({
      json: { id: cid, title: cid, titleSub: '', turnCount: TURNS.length, turns: TURNS, hasMore: false },
    });
  });
  await page.route('**/api/settings/dashboard-layout/panel', async (r) => {
    const body = r.request().postDataJSON() as { panel: unknown };
    placePuts.push(body);
    DOC = { ...DOC, panel: body.panel };
    await r.fulfill({ json: { ok: true, layout: { doc: DOC } } });
  });
  await page.route('**/api/settings/dashboard-layout', async (r) => {
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON() as { doc: Record<string, unknown> };
      wholePuts.push(body);
      DOC = { ...body.doc, ...(DOC.panel && !body.doc.panel ? { panel: DOC.panel } : {}) };
      return r.fulfill({ json: { ok: true, layout: { doc: DOC } } });
    }
    const { BUILTIN_PRESETS, LAYOUT_CATALOG } = await import('../src/view-layout');
    return r.fulfill({
      json: {
        userId: 'U001',
        accepted: true,
        doc: DOC,
        plan: '1',
        mode: 'minimal',
        builtins: BUILTIN_PRESETS,
        catalog: LAYOUT_CATALOG,
      },
    });
  });
  await page.route(/\/api\/settings(\?.*)?$/, (r) =>
    r.fulfill({ json: { userId: 'U001', isAdmin: false, accepted: true, groups: [], settings: [] } }),
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
type Rect = { x: number; y: number; w: number; h: number };
const rnd = (r: DOMRect | { x: number; y: number; width: number; height: number }): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.width),
  h: Math.round(r.height),
});

async function rectOf(page: Page, sel: string): Promise<Rect | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      : null;
  }, sel);
}
const card = (page: Page) => rectOf(page, '#slide-panel[open] .panel-header');
const grip = (page: Page) => rectOf(page, '#panel-grip');
async function boardX(page: Page): Promise<number> {
  return page.evaluate(() => Math.round((document.querySelector('.main') as HTMLElement).getBoundingClientRect().x));
}
async function zones(page: Page) {
  return page.evaluate(() => {
    const z = document.getElementById('panel-dropzones')!;
    const slots = Array.from(z.querySelectorAll('.pdz')) as HTMLElement[];
    return {
      shown: !z.hidden && z.hasAttribute('data-on'),
      target: slots.filter((s) => s.classList.contains('is-target')).map((s) => s.getAttribute('data-side')),
      rects: slots.map((s) => {
        const r = s.getBoundingClientRect();
        return {
          side: s.getAttribute('data-side'),
          x: Math.round(r.x),
          w: Math.round(r.width),
          opacity: getComputedStyle(s).opacity,
        };
      }),
    };
  });
}
async function shot(page: Page, name: string, clip?: Rect) {
  await page.screenshot({
    path: path.join(OUT, name),
    ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h } } : {}),
  });
}
async function boot(page: Page) {
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await page
      .context()
      .addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForSelector(`li.ib-card[data-card="${KEY_A}"] [data-win="detail"]`, { timeout: 20_000 });
  await sleep(600);
}
async function openCard(page: Page) {
  await page.click(`li.ib-card[data-card="${KEY_A}"] [data-win="detail"]`);
  await page.waitForSelector('#slide-panel[open] .panel-header', { timeout: 10_000 });
  await sleep(700);
}

async function wideRun(browser: import('playwright').Browser) {
  DOC = { v: 1 };
  placePuts = [];
  wholePuts = [];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await boot(page);
  await openCard(page);

  // P1
  const c0 = await card(page);
  const g0 = await grip(page);
  check(!!c0 && c0.x + c0.w >= 1430, 'P1 the card docks on the right (its right edge at the window’s)', c0);
  check(
    !!g0 && !!c0 && Math.abs(g0.x + g0.w / 2 - (c0.x + c0.w / 2)) <= 1 && g0.y === c0.y,
    'P1 the grip sits at the top centre of its title bar',
    { grip: g0, card: c0 },
  );
  const titleTop = await rectOf(page, '#panel-title');
  check(!!g0 && !!titleTop && titleTop.y >= g0.y + g0.h, 'P1 the title row starts under the grip, not behind it', {
    grip: g0,
    title: titleTop,
  });
  await shot(page, '01-right-docked-grip.png');
  if (c0) await shot(page, '01b-title-bar-grip.png', { x: c0.x, y: c0.y, w: c0.w, h: 72 });

  // P2 hover
  const barW0 = await page.evaluate(() =>
    Math.round(document.querySelector('.panel-grip-bar')!.getBoundingClientRect().width),
  );
  await page.mouse.move(g0!.x + g0!.w / 2, g0!.y + g0!.h / 2);
  await sleep(250);
  const barW1 = await page.evaluate(() =>
    Math.round(document.querySelector('.panel-grip-bar')!.getBoundingClientRect().width),
  );
  const cursor = await page.evaluate(() => getComputedStyle(document.getElementById('panel-grip')!).cursor);
  check(barW1 > barW0 && cursor === 'grab', 'P2 the grip widens on hover, the pointer is a grab hand', {
    barW0,
    barW1,
    cursor,
  });
  if (c0) await shot(page, '02a-grip-hover.png', { x: c0.x, y: c0.y, w: c0.w, h: 72 });

  // P2 drag: press, move left in steps, hold mid-way
  const sx = g0!.x + g0!.w / 2;
  const sy = g0!.y + g0!.h / 2;
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(sx - i * 40, sy + i);
    await sleep(16);
  }
  await sleep(200);
  const cMid = await card(page);
  const z1 = await zones(page);
  const pdrag = await page.evaluate(() => document.getElementById('slide-panel')!.getAttribute('data-pdrag'));
  check(!!cMid && Math.abs(cMid.x - (c0!.x - 480)) <= 2, 'P2 in hand the card follows the pointer (moved 480px left)', {
    before: c0,
    now: cMid,
  });
  check(pdrag === 'drag' && z1.shown, 'P2 the card is lifted and the two docks show as slots', { pdrag, zones: z1 });
  check(
    JSON.stringify(z1.target) === '["right"]',
    'P2 its centre still on the right half: the right slot is lit',
    z1.target,
  );
  await shot(page, '02b-dragging-halfway.png');
  for (let i = 13; i <= 22; i++) {
    await page.mouse.move(sx - i * 40, sy + 12);
    await sleep(16);
  }
  await sleep(250);
  const cFar = await card(page);
  const z2 = await zones(page);
  check(JSON.stringify(z2.target) === '["left"]', 'P2 past the middle: the left slot is lit', {
    card: cFar,
    target: z2.target,
  });
  await shot(page, '02c-dragging-over-left.png');

  // P3 release → glide
  const bx0 = await boardX(page);
  const placeBefore = placePuts.length;
  await page.mouse.up();
  const xs: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await card(page);
    xs.push(r ? r.x : -1);
    await sleep(60);
  }
  await sleep(500);
  const c1 = await card(page);
  const bx1 = await boardX(page);
  check(
    xs.some((x) => x > 2) && xs[xs.length - 1] <= xs[0],
    'P3 let go, it glides into the left dock (x frame by frame)',
    xs,
  );
  check(!!c1 && c1.x === 0, 'P3 the card rests on the left dock', c1);
  check(bx1 > bx0 && !!c1 && bx1 >= c1.w, 'P3 the board moved right of the card', {
    before: bx0,
    after: bx1,
    card: c1,
  });
  const side = await page.evaluate(() => ({
    attr: document.getElementById('slide-panel')!.getAttribute('side'),
    root: document.documentElement.getAttribute('data-panel-side'),
    pdrag: document.getElementById('slide-panel')!.getAttribute('data-pdrag'),
    zonesHidden: document.getElementById('panel-dropzones')!.hidden,
  }));
  check(
    side.attr === 'left' && side.root === 'left' && side.pdrag === null && side.zonesHidden,
    'P3 the page is on the left, no drag left over',
    side,
  );
  check(
    placePuts.length === placeBefore + 1 &&
      JSON.stringify(placePuts[placePuts.length - 1]) === '{"panel":{"side":"left","locked":false}}',
    'P3 one PUT …/dashboard-layout/panel saves the place alone',
    placePuts,
  );
  check(wholePuts.length === 0, 'P3 no whole-document save', wholePuts.length);
  const toast = await page.evaluate(() => {
    const t = document.getElementById('dash-toaster');
    return t && t.shadowRoot ? t.shadowRoot.textContent || '' : '';
  });
  check(
    toast.includes('디테일 카드를 왼쪽으로 옮겼어요') && toast.includes('실행 취소'),
    'P3 a toast says so, with 실행 취소',
    toast.slice(0, 120),
  );
  await shot(page, '03-left-docked.png');

  // P4 reload: opens on the left
  await page.reload();
  await page.waitForSelector(`li.ib-card[data-card="${KEY_A}"] [data-win="detail"]`, { timeout: 20_000 });
  await sleep(600);
  await openCard(page);
  const c2 = await card(page);
  check(!!c2 && c2.x === 0, 'P4 a reload opens the card on the left', c2);
  // Short drag: let go before the middle — settles back, nothing saved.
  const g2 = await grip(page);
  const before4 = placePuts.length;
  await page.mouse.move(g2!.x + g2!.w / 2, g2!.y + g2!.h / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(g2!.x + g2!.w / 2 + i * 30, g2!.y + 8);
    await sleep(20);
  }
  await sleep(150); // stop before letting go: no flick
  await page.mouse.up();
  await sleep(600);
  const c3 = await card(page);
  check(
    !!c3 && c3.x === 0 && placePuts.length === before4,
    'P4 let go short of the middle: it settles back, nothing saved',
    { card: c3, puts: placePuts.length - before4 },
  );
  // Esc mid-drag
  await page.mouse.move(g2!.x + g2!.w / 2, g2!.y + g2!.h / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(g2!.x + g2!.w / 2 + i * 40, g2!.y + 8);
    await sleep(16);
  }
  await page.keyboard.press('Escape');
  await sleep(600);
  await page.mouse.up();
  await sleep(200);
  const c4 = await card(page);
  const stillOpen = await page.evaluate(() => document.getElementById('slide-panel')!.hasAttribute('open'));
  check(
    !!c4 && c4.x === 0 && stillOpen && placePuts.length === before4,
    'P4 Esc mid-drag puts it back (and does not close it)',
    { card: c4, stillOpen },
  );

  // P5 keyboard and a press
  await page.focus('#panel-grip');
  await page.keyboard.press('ArrowRight');
  await sleep(500);
  const c5 = await card(page);
  check(!!c5 && c5.x + c5.w >= 1430, 'P5 → on the grip moves it to the right', c5);
  await page.keyboard.press('ArrowLeft');
  await sleep(500);
  const c6 = await card(page);
  check(!!c6 && c6.x === 0, 'P5 ← moves it back to the left', c6);
  await page.click('#panel-grip');
  await sleep(700);
  const c7 = await card(page);
  check(!!c7 && c7.x + c7.w >= 1430, 'P5 a press on the grip moves it to the other side', c7);
  // The title bar's own surface drags too (a window's title bar), and the click it ends with presses nothing.
  const t7 = await rectOf(page, '#panel-title');
  const puts7 = placePuts.length;
  await page.mouse.move(t7!.x + 10, t7!.y + t7!.h / 2);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(t7!.x + 10 - i * 40, t7!.y + 6);
    await sleep(16);
  }
  await sleep(120);
  await page.mouse.up();
  await sleep(700);
  const c8 = await card(page);
  const sel = await page.evaluate(() => String(window.getSelection && window.getSelection()));
  check(
    !!c8 && c8.x === 0 && placePuts.length === puts7 + 1 && sel === '',
    'P5 a drag from the title bar’s text moves it too, nothing selected',
    { card: c8, sel },
  );
  check(errors.length === 0, 'no page errors', errors);
  await ctx.close();
}

async function lockedRun(browser: import('playwright').Browser) {
  DOC = { v: 1, panel: { side: 'left', locked: true } };
  placePuts = [];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await boot(page);
  await openCard(page);
  const c0 = await card(page);
  const gHidden = await page.evaluate(() => {
    const g = document.getElementById('panel-grip')!;
    return { hidden: g.hidden, display: getComputedStyle(g).display };
  });
  check(!!c0 && c0.x === 0, 'P6 locked on the left: the card docks left', c0);
  check(gHidden.hidden && gHidden.display === 'none', 'P6 locked: no grip', gHidden);
  // Drag the title bar's surface: nothing moves.
  const title = await rectOf(page, '#panel-title');
  await page.mouse.move(title!.x + 4, title!.y + title!.h / 2);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(title!.x + 4 + i * 40, title!.y + 8);
    await sleep(16);
  }
  const mid = await card(page);
  await page.mouse.up();
  await sleep(400);
  check(!!mid && mid.x === 0 && placePuts.length === 0, 'P6 locked: the title bar does not drag', { mid });
  await shot(page, '04-locked-left-dark.png');
  await ctx.close();
}

async function phoneRun(browser: import('playwright').Browser) {
  DOC = { v: 1, panel: { side: 'left', locked: false } };
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await boot(page);
  await page.click(`li.ib-card[data-card="${KEY_A}"] [data-win="detail"]`);
  await page.waitForSelector('#slide-panel[open] .panel-header', { timeout: 10_000 });
  await sleep(800);
  const c = await card(page);
  const g = await page.evaluate(() => getComputedStyle(document.getElementById('panel-grip')!).display);
  check(!!c && c.x === 0 && c.w === 390, 'P7 a phone: the card is a full-screen sheet', c);
  check(g === 'none', 'P7 a phone: no grip', g);
  await shot(page, '05-phone-sheet.png');
  await ctx.close();
}

async function settingsRun(browser: import('playwright').Browser) {
  DOC = { v: 1 };
  placePuts = [];
  wholePuts = [];
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await page
      .context()
      .addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/settings#layout`);
  await page.waitForSelector('#lay-place', { state: 'visible', timeout: 20_000 });
  await sleep(900);
  const sec = await rectOf(page, '#lay-place');
  const st0 = await page.evaluate(() => ({
    right: (document.getElementById('lay-place-right') as HTMLInputElement).checked,
    lock: (document.getElementById('lay-place-lock') as HTMLInputElement).checked,
    hint: document.getElementById('lay-place-lock-hint')!.textContent,
  }));
  check(!!sec && st0.right && !st0.lock, 'P8 the section shows the saved place (right, unlocked)', { sec, ...st0 });
  if (sec)
    await shot(page, '06a-settings-place-right.png', { x: sec.x - 8, y: sec.y - 8, w: sec.w + 16, h: sec.h + 16 });
  await page.click('label.lay-place-opt:has(#lay-place-left)');
  await sleep(400);
  check(
    JSON.stringify(placePuts[0]) === '{"panel":{"side":"left","locked":false}}' && wholePuts.length === 0,
    'P8 왼쪽 saves the place alone',
    placePuts,
  );
  await page.click('label.ui-switch:has(#lay-place-lock)');
  await sleep(400);
  const st1 = await page.evaluate(() => ({
    left: (document.getElementById('lay-place-left') as HTMLInputElement).checked,
    lock: (document.getElementById('lay-place-lock') as HTMLInputElement).checked,
    hint: document.getElementById('lay-place-lock-hint')!.textContent,
    status: document.getElementById('lay-status')!.textContent,
  }));
  check(
    st1.left &&
      st1.lock &&
      JSON.stringify(placePuts[1]) === '{"panel":{"side":"left","locked":true}}' &&
      st1.status === '저장됨',
    'P8 위치 잠금 saves the lock; the hint says the grip is gone',
    st1,
  );
  if (sec)
    await shot(page, '06b-settings-place-left-locked.png', {
      x: sec.x - 8,
      y: sec.y - 8,
      w: sec.w + 16,
      h: sec.h + 16,
    });
  await shot(page, '06c-settings-page.png');
  check(errors.length === 0, 'P8 no page errors', errors);
  await ctx.close();
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  try {
    for (const run of [wideRun, lockedRun, phoneRun, settingsRun]) {
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

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
