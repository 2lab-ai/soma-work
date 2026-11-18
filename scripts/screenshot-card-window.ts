/**
 * Task card window controls (.prd/34) — browser receipts on the real dashboard page.
 *
 * The real web server serves the real page and the installed @2lab.ai/ui; the board JSON and the
 * conversation are browser routes and the WebSocket is a stub, so every step is deterministic.
 * Every check prints the rects it judged (card, panel), never a bare boolean (.prd skill: a
 * position claim leaves its coordinates).
 *
 *   S1  each card head: − · title · (★) · ▽, the face is no button
 *   S2  − → one line (≤ 44px tall), +; saved — a reload keeps it; + → back
 *   S3  title hover: accent underline + the side-panel glyph slides in
 *   S4  ▽ → the body opens in place, no detail card; the hop: mid-air (up, bigger), dust after landing, lands as △ (180°)
 *   S5  title → one line + ring, its detail card on the right; a second title → that one in front, the ring moves
 *   S6  ✕ → the front leaves and its card comes back as it was (open again if it was open); the last closes the panel
 *   S7  a card the reader folded stays one line after its detail card closes
 *   S8  a press on the face's text opens nothing
 *   S9  reduced motion: ▽ turns without the hop
 *   S10 the list view (1280) and a phone (390): −, title → detail card (a full-screen sheet on the phone), ✕
 *   S11 a starred card a day old starts on one line with its TL;DR; the TL;DR's × → one line; + is kept (SSOT_2)
 *   S12 ▽ on a one-line card whose detail card is open: open in place through a repaint, the detail card stays
 *   S13 a deck card hidden by the search and shown again keeps its detail fold; the reader's + stays
 *   S14 keyboard: Enter on a title → its detail card; Esc → focus back on that title
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-card-window.ts [outDir]
 * A deployed build instead of this checkout: run a copy of this file from a scratch folder whose
 * src/conversation/web-server.js is a symlink to the bundle's dist/conversation/web-server.js (Node follows the
 * link, so the bundle's own modules and its installed @2lab.ai/ui serve the page) — .prd/card-window/loop.md.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'card-window');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CARD_WINDOW_PORT || '33937';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NOW = Date.now();
const M = 60_000;
const KEY_A = 'mock-inst::work:C501:1700000000.000100';
const KEY_B = 'mock-inst::work:C502:1700000000.000200';
const KEY_C = 'mock-inst::work:C503:1700000000.000300';
// SSOT_2: a starred card whose work last moved 30 hours ago, with an Executive Summary TL;DR.
const KEY_D = 'mock-inst::work:C504:1700000000.000400';

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
    tasks: [{ id: '1', content: '카드 머리에 창 버튼 그리기', activeForm: '창 버튼 그리는 중', status: 'in_progress' }],
  };
}
const BOARD = {
  waiting: [],
  working: [
    session(
      KEY_A,
      '작업 카드 창 버튼 개선',
      'C501',
      'working',
      '보드 카드에 − · 제목 · ▽ 버튼을 붙이고 상태를 셋으로 나눈다.',
    ),
    session(KEY_B, 'dev 로그 문제 확인', 'C502', 'working', '배포 로그에서 재시작 원인을 찾는다.'),
  ],
  idle: [
    session(KEY_C, '릴리즈 노트 정리', 'C503', 'idle', '지난주 머지된 PR을 묶어 노트를 쓴다.'),
    {
      ...session(KEY_D, '분기 지표 대시보드', 'C504', 'idle', '분기 지표를 한 화면에 모은다.'),
      starred: true,
      lastActivity: new Date(NOW - 30 * 60 * M).toISOString(),
      esTldr: { lines: ['지표 6개를 한 화면에 모았다.', '다음: 알림 기준 정하기.'], at: NOW - 30 * 60 * M },
    },
  ],
};
const TURNS = [
  {
    id: 'u1',
    role: 'user',
    timestamp: new Date(NOW - 10 * M).toISOString(),
    userName: 'Zhuge',
    rawContent: '카드 버튼 개선해줘',
    origin: { by: 'user' },
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: new Date(NOW - 5 * M).toISOString(),
    summaryTitle: '진행',
    summaryBody: '버튼을 그렸습니다',
    summarized: true,
  },
];

const PAGE_HELPERS = [
  'window.__card = function (k) { var h = document.getElementById("kanban"); var r = h && h.shadowRoot; var all = r ? r.querySelectorAll("li.ib-card[data-card]") : []; for (var i = 0; i < all.length; i++) if (all[i].getAttribute("data-card") === k) return all[i]; return null; };',
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
  'window.__name = function (f) { return f; };',
].join('\n');

async function installMocks(page: Page, view: 'board' | 'list' = 'board') {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({ content: `localStorage.setItem("soma-board-view", "${view}");` });
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
type CardState = {
  rect: Rect;
  min: boolean;
  open: boolean;
  current: boolean;
  pressed: string | null;
  expanded: string | null;
  caret: string;
  head: string[];
  faceRole: string | null;
};
async function cardState(page: Page, key: string): Promise<CardState> {
  return page.evaluate((k) => {
    const c = (window as any).__card(k) as HTMLElement;
    const r = c.getBoundingClientRect();
    const q = (s: string) => c.querySelector(s) as HTMLElement | null;
    const lift = q('[data-win="expand"] .ib-caret-lift');
    return {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      min: c.classList.contains('is-min'),
      open: c.classList.contains('is-open'),
      current: c.classList.contains('is-current'),
      pressed: q('[data-win="min"]')?.getAttribute('aria-pressed') ?? null,
      expanded: q('[data-win="expand"]')?.getAttribute('aria-expanded') ?? null,
      caret: lift ? getComputedStyle(lift).transform : '',
      head: Array.from(q('.ib-head')?.children ?? []).map(
        (n) => n.getAttribute('data-win') ?? (n.classList.contains('ib-star') ? 'star' : n.className),
      ),
      faceRole: q('.ib-face')?.getAttribute('role') ?? null,
    };
  }, key);
}
async function panel(page: Page): Promise<{ open: boolean; key: string | null; rect: Rect | null; deck: string[] }> {
  // The page's own state (top-level let / var of its classic script): an expression Playwright evaluates in the
  // page's global scope.
  const state = (await page.evaluate(
    '({ open: typeof panelOpen !== "undefined" && !!panelOpen, key: typeof panelSessionKey !== "undefined" ? panelSessionKey : null, deck: typeof _deck !== "undefined" ? _deck.slice() : [] })',
  )) as { open: boolean; key: string | null; deck: string[] };
  const rect = await page.evaluate(() => {
    // <ui-drawer> lays out its slotted parts: the detail card's own header is what is drawn on the right.
    const p = document.querySelector('#slide-panel[open] .panel-header') as HTMLElement | null;
    const r = p?.getBoundingClientRect();
    return p && r && r.width > 0
      ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      : null;
  });
  return { ...state, rect };
}
// Playwright's click pierces the element's open shadow root and scrolls the control on screen (a phone's sideways
// board), as a reader would.
async function press(page: Page, key: string, what: 'min' | 'detail' | 'expand') {
  await page.click(`li.ib-card[data-card="${key}"] [data-win="${what}"]`);
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, name) });
}
async function boot(page: Page, view: 'board' | 'list' = 'board') {
  // The viewer token (CONVERSATION_VIEWER_TOKEN) as the dashboard's bearer cookie.
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await page
      .context()
      .addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  await installMocks(page, view);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForSelector(`li.ib-card[data-card="${KEY_A}"] [data-win="detail"]`, { timeout: 20_000 });
  await sleep(500);
}

async function motionRun(browser: import('playwright').Browser) {
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

  // S1
  const a0 = await cardState(page, KEY_A);
  check(
    a0.head[0] === 'min' &&
      a0.head.includes('detail') &&
      a0.head[a0.head.length - 1] === 'expand' &&
      a0.faceRole === null,
    'S1 head = − · title · (★) · ▽; the face is no button',
    { head: a0.head, faceRole: a0.faceRole, rect: a0.rect },
  );
  await shot(page, '01-normal.png');

  // S2
  await press(page, KEY_A, 'min');
  await sleep(450);
  const a1 = await cardState(page, KEY_A);
  const p1 = await panel(page);
  check(a1.min && a1.pressed === 'true' && a1.rect.h <= 44 && !p1.open, 'S2 − → one line, no detail card', {
    before: a0.rect,
    after: a1.rect,
    panel: p1,
  });
  await shot(page, '02-one-line.png');
  const saved = await page.evaluate(() => localStorage.getItem('soma-card-min'));
  check(saved === JSON.stringify([KEY_A]), 'S2 the fold is saved in this browser', { saved });
  await page.reload();
  await page.waitForSelector(`li.ib-card[data-card="${KEY_A}"] [data-win="detail"]`);
  await sleep(500);
  const a2 = await cardState(page, KEY_A);
  check(a2.min && a2.rect.h <= 44, 'S2 a reload keeps it on one line', { rect: a2.rect });
  await press(page, KEY_A, 'min');
  await sleep(450);
  const a3 = await cardState(page, KEY_A);
  check(!a3.min && a3.rect.h === a0.rect.h, 'S2 + → back as it was', { before: a0.rect, after: a3.rect });

  // S3
  await page.hover(`li.ib-card[data-card="${KEY_B}"] [data-win="detail"]`);
  await sleep(300);
  const hover = await page.evaluate((k) => {
    const c = (window as any).__card(k) as HTMLElement;
    const text = c.querySelector('.ib-title-text') as HTMLElement;
    const peek = c.querySelector('.ib-peek') as HTMLElement;
    const cs = getComputedStyle(text);
    return {
      underline: cs.textDecorationLine,
      decoColor: cs.textDecorationColor,
      peekOpacity: getComputedStyle(peek).opacity,
      cursor: getComputedStyle(c.querySelector('[data-win="detail"]') as HTMLElement).cursor,
      tooltip: (c.querySelector('[data-win="detail"]') as HTMLElement).title,
    };
  }, KEY_B);
  check(
    hover.underline.includes('underline') &&
      hover.peekOpacity === '1' &&
      hover.cursor === 'pointer' &&
      hover.decoColor !== 'rgba(0, 0, 0, 0)',
    'S3 title hover: underline + side-panel glyph + pointer + tooltip',
    hover,
  );
  await shot(page, '03-title-hover.png');
  await page.mouse.move(5, 5);

  // S4 — ▽ with its hop, frozen at points of its animation.
  await press(page, KEY_B, 'expand');
  const frames: Array<Record<string, unknown>> = [];
  for (const at of [150, 330, 430]) {
    const f = await page.evaluate(
      ([k, t]) => {
        const c = (window as any).__card(k) as HTMLElement;
        const caret = c.querySelector('[data-win="expand"]') as HTMLElement;
        const lift = caret.querySelector('.ib-caret-lift') as HTMLElement;
        const grains = Array.from(caret.querySelectorAll('.ib-dust i')) as HTMLElement[];
        const shadow = caret.querySelector('.ib-caret-shadow') as HTMLElement;
        for (const a of caret.getAnimations({ subtree: true })) {
          a.pause();
          a.currentTime = Number(t);
        }
        const lr = lift.getBoundingClientRect();
        const cr = caret.getBoundingClientRect();
        return {
          at: t,
          hop: caret.classList.contains('is-hop'),
          caretBox: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
          lift: { y: Math.round(lr.y * 10) / 10, w: Math.round(lr.width * 10) / 10 },
          transform: getComputedStyle(lift).transform,
          shadow: getComputedStyle(shadow).opacity,
          dust: grains.map((g) => Number(getComputedStyle(g).opacity).toFixed(2)),
        };
      },
      [KEY_B, String(at)],
    );
    frames.push(f);
    const r = f.caretBox as Rect;
    await page.screenshot({
      path: path.join(OUT, `04-hop-${at}ms.png`),
      clip: { x: r.x - 40, y: r.y - 24, width: r.w + 80, height: r.h + 40 },
    });
  }
  log(`      hop frames — ${JSON.stringify(frames)}`);
  const lifted = frames[0] as { lift: { y: number; w: number }; shadow: string };
  check(
    lifted.lift.w > 16.5 && Number(lifted.shadow) > 0,
    'S4 mid-air at 150 ms: bigger than 16px, a ground shadow',
    lifted,
  );
  const early = frames[0] as { dust: string[] };
  check(
    early.dust.every((o) => Number(o) === 0),
    'S4 no dust before the landing (150 ms)',
    early.dust,
  );
  const dusty = frames[2] as { dust: string[] };
  check(
    dusty.dust.some((o) => Number(o) > 0.1),
    'S4 dust after the landing (430 ms)',
    dusty.dust,
  );
  await page.evaluate((k) => {
    const caret = ((window as any).__card(k) as HTMLElement).querySelector('[data-win="expand"]') as HTMLElement;
    for (const a of caret.getAnimations({ subtree: true })) a.finish();
  }, KEY_B);
  await sleep(500);
  const b1 = await cardState(page, KEY_B);
  const p4 = await panel(page);
  // matrix(-1, ~0, ~0, -1, 0, 0) = rotate(180deg)
  const turned = /^matrix\(-1, [-0-9.e]+, [-0-9.e]+, -1, 0, 0\)$/.test(b1.caret);
  check(b1.open && b1.expanded === 'true' && turned && !p4.open, 'S4 ▽ → open in place, △ (180°), no detail card', {
    rect: b1.rect,
    caret: b1.caret,
    panel: p4,
  });
  await shot(page, '04-open-in-place.png');

  // S5 — the ring is there at once (no board render needed).
  await press(page, KEY_B, 'detail');
  await sleep(30);
  const ringNow = await cardState(page, KEY_B);
  check(ringNow.current, 'S5 the ring is on at once', { current: ringNow.current });
  try {
    await page.waitForSelector('#slide-panel[open]', { timeout: 8000 });
  } catch (e) {
    log(
      `DEBUG panel ${JSON.stringify(await panel(page))} errors ${JSON.stringify(errors)} card ${JSON.stringify(await cardState(page, KEY_B))}`,
    );
    throw e;
  }
  await sleep(600);
  const b2 = await cardState(page, KEY_B);
  const p5 = await panel(page);
  check(
    b2.min && b2.current && p5.open && p5.key === KEY_B && !!p5.rect && p5.rect.x >= b2.rect.x + b2.rect.w - 1,
    'S5 title → one line + ring, its detail card on the right',
    { card: b2.rect, panel: p5 },
  );
  await shot(page, '05-detail-open.png');
  await press(page, KEY_A, 'detail');
  await sleep(600);
  const a5 = await cardState(page, KEY_A);
  const b5 = await cardState(page, KEY_B);
  const p5b = await panel(page);
  check(
    a5.min && a5.current && !b5.current && b5.min && p5b.key === KEY_A && p5b.deck.join() === [KEY_B, KEY_A].join(),
    'S5 a second title → that one in front, the ring moves, both on one line',
    { a: a5.rect, b: b5.rect, panel: p5b },
  );
  await shot(page, '05-detail-two.png');

  // S6
  await page.click('#slide-panel .panel-close');
  await sleep(600);
  const a6 = await cardState(page, KEY_A);
  const p6 = await panel(page);
  check(
    !a6.min && !a6.current && p6.key === KEY_B && (await cardState(page, KEY_B)).current,
    'S6 ✕ → A back, B in front',
    {
      a: a6.rect,
      panel: p6,
    },
  );
  await page.click('#slide-panel .panel-close');
  await sleep(600);
  const b6 = await cardState(page, KEY_B);
  const p6b = await panel(page);
  check(
    !b6.min && b6.open && b6.expanded === 'true' && !p6b.open,
    'S6 ✕ again → B back open (as it was), the panel closed',
    {
      b: b6.rect,
      panel: p6b,
    },
  );
  await shot(page, '06-closed-restored.png');

  // S7
  await press(page, KEY_C, 'min');
  await sleep(400);
  await press(page, KEY_C, 'detail');
  await page.waitForSelector('#slide-panel[open]');
  await sleep(500);
  await page.click('#slide-panel .panel-close');
  await sleep(600);
  const c7 = await cardState(page, KEY_C);
  check(
    c7.min && !(await panel(page)).open,
    'S7 the reader’s one-line card stays one line after its detail card closes',
    {
      c: c7.rect,
    },
  );

  // S11 (SSOT_2) — the starred card a day old starts on one line with its TL;DR; the TL;DR's × makes it one line;
  // + brings it back and a reload keeps it open.
  const d0 = await cardState(page, KEY_D);
  const tl = await page.evaluate((k) => {
    const box = ((window as any).__card(k) as HTMLElement).querySelector('.ib-min-tldr') as HTMLElement | null;
    const r = box?.getBoundingClientRect();
    return box && r
      ? { shown: getComputedStyle(box).display !== 'none', h: Math.round(r.height), text: box.innerText }
      : null;
  }, KEY_D);
  check(
    d0.min && !!tl && tl.shown && tl.h > 30 && /지표 6개/.test(tl.text) && d0.rect.h > 44,
    'S11 a starred card 30 h old starts on one line, its TL;DR under the head',
    { card: d0.rect, tldr: tl },
  );
  await shot(page, '11-starred-tldr.png');
  await page.click(`li.ib-card[data-card="${KEY_D}"] .ib-min-tldr [data-dismiss="tldr"]`);
  await sleep(500);
  const d1 = await cardState(page, KEY_D);
  check(d1.min && d1.rect.h <= 44, 'S11 the TL;DR × → truly one line', { before: d0.rect, after: d1.rect });
  await shot(page, '11-starred-one-line.png');
  await press(page, KEY_D, 'min');
  await sleep(450);
  await page.reload();
  await page.waitForSelector(`li.ib-card[data-card="${KEY_D}"] [data-win="detail"]`);
  await sleep(500);
  const d2 = await cardState(page, KEY_D);
  const unfold = await page.evaluate(() => localStorage.getItem('soma-card-unfold'));
  // The reader's + list holds every card they brought back (A from S2 too).
  const unfolded = JSON.parse(unfold || '[]') as string[];
  check(!d2.min && unfolded.includes(KEY_D), 'S11 + → open, and a reload keeps it open', {
    card: d2.rect,
    unfold,
  });

  // S12 (review) — ▽ on a one-line card whose detail card is open: open in place, still open after a repaint, the
  // detail card stays.
  await press(page, KEY_A, 'detail');
  await page.waitForSelector('#slide-panel[open]');
  await sleep(500);
  await press(page, KEY_A, 'expand');
  await sleep(600);
  await page.evaluate('loadSessions()');
  await sleep(1200);
  const a12 = await cardState(page, KEY_A);
  const p12 = await panel(page);
  check(
    a12.open && !a12.min && a12.expanded === 'true' && p12.open && p12.key === KEY_A,
    'S12 ▽ on a one-line card with its detail card open: open in place through a repaint, the detail card stays',
    { a: a12.rect, panel: p12 },
  );
  await page.click('#slide-panel .panel-close');
  await sleep(600);
  await press(page, KEY_A, 'expand'); // back to the normal view for S8
  await sleep(500);

  // S13 (review) — a deck card hidden by the card search and shown again keeps its detail fold; a card the reader
  // brought back with + while in the deck stays back. Closing brings it back as it was.
  const search = async (q: string) => {
    await page.fill('#bf-search', q);
    await sleep(700);
  };
  await press(page, KEY_A, 'detail');
  await page.waitForSelector('#slide-panel[open]');
  await sleep(400);
  await press(page, KEY_B, 'detail');
  await sleep(400);
  await press(page, KEY_B, 'min'); // the reader's + on B while its detail card is in front
  await sleep(400);
  await search('없는검색어');
  const hidden = await page.evaluate((k) => !(window as any).__card(k), KEY_A);
  await search('');
  const a13 = await cardState(page, KEY_A);
  const b13 = await cardState(page, KEY_B);
  check(
    hidden && a13.min && !b13.min,
    'S13 hidden by the search and shown again: the deck card keeps its detail fold, the reader’s + stays',
    { hidden, a: { min: a13.min, h: a13.rect.h }, b: { min: b13.min, h: b13.rect.h } },
  );
  await page.click('#slide-panel .panel-close');
  await sleep(500);
  await page.click('#slide-panel .panel-close');
  await sleep(600);
  const a13b = await cardState(page, KEY_A);
  check(!a13b.min && !(await panel(page)).open, 'S13 both closed: A back as it was', { a: a13b.rect });

  // S14 (review) — keyboard: Enter on a card's title opens its detail card; Esc closes it and focus is that title
  // again (the opener is captured inside the board element's shadow root).
  await page.focus(`li.ib-card[data-card="${KEY_A}"] [data-win="detail"]`);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#slide-panel[open]');
  await sleep(500);
  await page.keyboard.press('Escape');
  await sleep(600);
  const focus = await page.evaluate((k) => {
    const host = document.activeElement as HTMLElement | null;
    const inner = host?.shadowRoot?.activeElement as HTMLElement | null;
    const title = ((window as any).__card(k) as HTMLElement).querySelector('[data-win="detail"]');
    return { host: host?.tagName ?? null, onTitle: !!inner && inner === title };
  }, KEY_A);
  check(
    focus.host === 'UI-AGENT-INBOX' && focus.onTitle && !(await panel(page)).open,
    'S14 Enter on a title → its detail card; Esc → focus back on that title',
    focus,
  );

  // S8
  const sum = await page.evaluate((k) => {
    // The first row under the head (the summary, the task in progress…): text, not a control.
    const s = ((window as any).__card(k) as HTMLElement).querySelector(
      '.ib-rest-in > :first-child',
    ) as HTMLElement | null;
    const r = s?.getBoundingClientRect();
    return r ? { x: r.x + 30, y: r.y + r.height / 2 } : null;
  }, KEY_A);
  if (sum) await page.mouse.click(sum.x, sum.y);
  await sleep(400);
  const a8 = await cardState(page, KEY_A);
  check(!!sum && !a8.open && !a8.min && !(await panel(page)).open, 'S8 a press on the face’s text opens nothing', {
    a: a8.rect,
    at: sum,
  });
  check(errors.length === 0, 'no page errors', errors);
  await ctx.close();
}

async function reducedRun(browser: import('playwright').Browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await boot(page);
  log('\n── 1440 dark · reduced motion ──');
  await press(page, KEY_B, 'expand');
  await sleep(60);
  const s = await page.evaluate((k) => {
    const caret = ((window as any).__card(k) as HTMLElement).querySelector('[data-win="expand"]') as HTMLElement;
    return { hop: caret.classList.contains('is-hop'), anims: caret.getAnimations({ subtree: true }).length };
  }, KEY_B);
  const b = await cardState(page, KEY_B);
  check(!s.hop && s.anims === 0 && b.open && /^matrix\(-1/.test(b.caret), 'S9 reduced motion: △ without the hop', {
    ...s,
    caret: b.caret,
  });
  await press(page, KEY_A, 'detail');
  await page.waitForSelector('#slide-panel[open]');
  await sleep(400);
  await shot(page, '09-dark-detail.png');
  await ctx.close();
}

// S10 — the list view and a phone (the detail card is a full-screen sheet there).
async function narrowRun(browser: import('playwright').Browser, w: number, h: number, view: 'list' | 'board') {
  {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      colorScheme: 'light',
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await boot(page, view);
    const tag = `${w}-${view}`;
    log(`\n── ${tag} ──`);
    const a0 = await cardState(page, KEY_A);
    await press(page, KEY_A, 'min');
    await sleep(450);
    const a1 = await cardState(page, KEY_A);
    check(a1.min && a1.rect.h <= 44 && a1.rect.h < a0.rect.h, `S10 ${tag} − → one line`, {
      before: a0.rect,
      after: a1.rect,
    });
    await shot(page, `10-${tag}-one-line.png`);
    await press(page, KEY_A, 'min');
    await sleep(450);
    await press(page, KEY_B, 'detail');
    await page.waitForSelector('#slide-panel[open]');
    await sleep(600);
    const p = await panel(page);
    check(p.open && p.key === KEY_B && !!p.rect, `S10 ${tag} title → its detail card`, { panel: p });
    await shot(page, `10-${tag}-detail.png`);
    await page.click('#slide-panel .panel-close');
    await sleep(600);
    const b = await cardState(page, KEY_B);
    check(!b.min && !(await panel(page)).open, `S10 ${tag} ✕ → the card is back`, { b: b.rect });
    check(errors.length === 0, `S10 ${tag} no page errors`, errors);
    await ctx.close();
  }
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  try {
    // Single-process Chromium (a sandboxed agent shell cannot register its Mach port for child processes) holds one
    // context per browser: a browser per run.
    for (const run of [
      motionRun,
      reducedRun,
      (b: import('playwright').Browser) => narrowRun(b, 1280, 860, 'list'),
      (b: import('playwright').Browser) => narrowRun(b, 390, 844, 'board'),
    ]) {
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
