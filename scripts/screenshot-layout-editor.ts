/**
 * 대시보드 화면 editor (SSOT 2026-11-02, .prd/21) — browser receipts.
 *
 * The real web server serves the real settings page and dashboard; /api/settings/dashboard-layout is a per-user
 * store double that checks a PUT with the real normalizeLayoutDoc (a reload reads it back); the board JSON comes
 * from the real task ledger; the WebSocket is a stub. Asserts (exit 1 on any failure) and writes screenshots:
 *
 *   R1  설정 › 대시보드 화면: the defaults, the preset · mode · surface pickers, every item, the live preview
 *   R2  a switch shows a chip in the preview and saves (one PUT)
 *   R3  ↑ reorders the face's rows; the preview follows
 *   R4  dragging a handle reorders (the drop lands before the row under the pointer)
 *   R5  the open card: its parts below the actions; a switch adds the task window to the preview
 *   R6  the detail card: the task list as one line; the preview follows
 *   R7  the thread card: 따로 설정 starts from the task card; a switch adds the steps to the Slack preview
 *   R8  defaults per surface: the detail card's default preset
 *   R9  되돌리기 takes the last change back
 *   R10 the dashboard draws what was saved: the board card's rows in the new order (연결 included), the new chip, the detail
 *       card's task line
 *
 * Run from the repo root with a clean env:
 *   env -i PATH="$PATH" HOME="$TMP" TMPDIR="$TMP" SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst \
 *     PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" \
 *     CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-layout-editor.ts [outDir]
 * (PLAYWRIGHT_BROWSERS_PATH points at the real browser cache, since HOME is the temp dir.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';
import { applyTodoList, ledgerTasks, type TaskLedger } from '../src/session/task-ledger';
import {
  BUILTIN_PRESETS,
  type DashboardLayoutDoc,
  followThreadLayout,
  LAYOUT_CATALOG,
  normalizeLayoutDoc,
  resolveLayouts,
} from '../src/view-layout';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'layout-editor');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.LAYOUT_EDITOR_PORT || '33943';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BOT = 'Soma Dev (Beta)';
const NOW = Date.now();
const M = 60_000;
const KEY_A = 'mock-inst::work:C201:1700000000.000100';

function ledger() {
  let l: TaskLedger | undefined;
  l = applyTodoList(
    l,
    [
      { content: '요구 정리', status: 'completed' },
      { content: '화면 설계', status: 'completed' },
      { content: '카드 폼 검증 추가', status: 'in_progress' },
      { content: '확인', status: 'pending' },
    ],
    NOW - 20 * M,
  );
  return ledgerTasks(l as TaskLedger);
}
function board() {
  const view = ledger();
  const s = {
    key: KEY_A,
    title: '결제 페이지 리뉴얼',
    displayHeadline: '결제 페이지 리뉴얼',
    summaryTitle: '결제 페이지 리뉴얼',
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model: 'claude-opus-5-5[1m]',
    effort: 'high',
    channelId: 'C201',
    sessionState: 'MAIN',
    activityState: 'working',
    conversationId: 'conv-C201',
    lastActivity: new Date(NOW).toISOString(),
    activeLegStartedAtMs: NOW - 20 * M,
    activeAccumulatedMs: 0,
    slackThreadUrl: 'https://slack.example/archives/C201/p1700000000000',
    prUrl: 'https://github.com/2lab-ai/soma-work/pull/700',
    prShortRef: 'PR-700',
    prStatus: 'open',
    // 작업 카드의 연결 (sessionToKanban's cardLinks): the default face's 연결 row.
    cardLinks: [
      {
        kind: 'issue',
        url: 'https://2lab.atlassian.net/browse/PAY-12',
        text: 'PAY-12',
        status: 'In Progress',
        tone: 'run',
      },
      { kind: 'pr', url: 'https://github.com/2lab-ai/soma-work/pull/700', text: '#700', status: '열림', tone: 'run' },
      { kind: 'wiki', url: 'https://2lab.atlassian.net/wiki/spaces/PAY/pages/1/Payment+Form', text: '결제 폼 설계' },
    ],
    tokenUsage: {
      totalInputTokens: 300_000,
      totalOutputTokens: 40_000,
      totalCacheReadTokens: 6_000_000,
      totalCacheCreateTokens: 100_000,
      totalCostUsd: 6.2,
      contextUsagePercent: 64,
    },
    artifacts: {
      count: 2,
      recent: [
        { id: 'art1', name: 'analysis.html', kind: 'html' },
        { id: 'art2', name: 'board.png', kind: 'image' },
      ],
    },
    botName: BOT,
    tasks: view.current,
    earlierTasks: view.earlier,
  };
  return { waiting: [], working: [s], idle: [] };
}

const HELPERS = [
  'window.__card = function (k) { var h = document.getElementById("kanban"); var r = h && h.shadowRoot; var all = r ? r.querySelectorAll("li.ib-card[data-card]") : []; for (var i = 0; i < all.length; i++) if (all[i].getAttribute("data-card") === k) return all[i]; return null; };',
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
  'window.__name = function (f) { return f; };',
].join('\n');

type Store = { doc: DashboardLayoutDoc; puts: unknown[] };
async function mocks(page: Page, store: Store) {
  await page.addInitScript({ content: HELPERS });
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'x' } }),
  );
  await page.route('**/api/settings', (r) =>
    r.fulfill({ json: { userId: 'U001', isAdmin: false, accepted: true, groups: [], settings: [] } }),
  );
  await page.route('**/api/settings/dashboard-layout', (r) => {
    if (r.request().method() === 'PUT') {
      const body = JSON.parse(r.request().postData() || '{}');
      store.doc = normalizeLayoutDoc(body.doc);
      store.puts.push(store.doc);
    }
    return r.fulfill({
      json: {
        ok: true,
        layout: { doc: store.doc },
        userId: 'U001',
        accepted: true,
        doc: store.doc,
        plan: '1',
        mode: 'minimal',
        builtins: BUILTIN_PRESETS,
        catalog: LAYOUT_CATALOG,
      },
    });
  });
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: board() } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/(artifacts|worklog)/, (r) =>
    r.fulfill({ json: { artifacts: [], entries: [], hasMore: false } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) =>
    r.fulfill({ json: { id: 'conv-C201', title: 't', titleSub: '', turnCount: 0, turns: [], hasMore: false } }),
  );
}

const failures: string[] = [];
const report: string[] = [];
function log(line: string) {
  report.push(line);
  console.log(line);
}
function check(ok: boolean, what: string, detail?: unknown) {
  log(
    `${ok ? '[ok]  ' : '[FAIL]'} ${what}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ''}`,
  );
  if (!ok) failures.push(what);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** The preview card's rows (class names) and foot chips (texts), from the element's shadow root. */
function previewFace(page: Page) {
  return page.evaluate(() => {
    const el = document.getElementById('lay-inbox') as HTMLElement | null;
    const face = el?.shadowRoot?.querySelector('li.ib-card .ib-face') as HTMLElement | null;
    if (!face) return null;
    return {
      rows: Array.from(face.children)
        .map((d) => (d as HTMLElement).className.split(' ')[0])
        .filter((c) => c !== 'ib-head' && c !== 'ib-foot'),
      chips: Array.from(face.querySelectorAll<HTMLElement>('.ib-foot .ib-metric')).map((m) => m.innerText.trim()),
      open: !!el?.shadowRoot?.querySelector('li.ib-card.is-open'),
      body: (el?.querySelector('[slot^="body:"]') as HTMLElement | null)?.innerText || '',
    };
  });
}
async function surface(page: Page, id: string) {
  await page.click(`#lay-surface input[value="${id}"]`, { force: true });
  await sleep(400);
}
async function saved(page: Page) {
  await page.waitForFunction(() => document.getElementById('lay-status')?.textContent === '저장됨', null, {
    timeout: 5000,
  });
}

/** A full-page shot from the top: a shot taken where the page was scrolled draws the fixed nav mid-page. */
async function fullShot(page: Page, file: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, file), fullPage: true });
}

async function run(browser: import('playwright').Browser, width: number, height: number) {
  const tag = `${width}`;
  const store: Store = { doc: { v: 1 }, puts: [] };
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: 'light', reducedMotion: 'reduce' });
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await ctx.addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mocks(page, store);
  log(`\n── ${tag} ──`);
  await page.goto(`${BASE_URL}/dashboard/settings#layout`);
  await page.waitForSelector('#lay-controls .lay-zone', { timeout: 15_000 });
  await page.waitForFunction(() => !!document.getElementById('lay-inbox')?.shadowRoot?.querySelector('li.ib-card'));
  await sleep(400);

  // R1
  const r1 = await page.evaluate(() => ({
    defCard: (document.getElementById('lay-def-card') as HTMLSelectElement).value,
    defDetail: (document.getElementById('lay-def-detail') as HTMLSelectElement).value,
    thread: (document.getElementById('lay-thread-mode') as HTMLSelectElement).value,
    surfaces: Array.from(document.querySelectorAll('#lay-surface input')).map((i) => (i as HTMLInputElement).value),
    zones: Array.from(document.querySelectorAll('#lay-controls .lay-zone h3')).map((h) => h.textContent),
    items: document.querySelectorAll('#lay-controls li.lay-item').length,
  }));
  check(
    r1.defCard === '1' &&
      r1.defDetail === '1' &&
      r1.thread === 'follow' &&
      r1.surfaces.join() === 'card,open,detail,thread',
    `${tag} R1 the tab opens on the defaults (1안 · 1안 · 태스크 카드 따라감) and the four surfaces`,
    r1,
  );
  check(
    r1.zones.join() === '머리,본문 줄,맨 아래 오른쪽' && r1.items === 19,
    `${tag} R1 the card's zones list every item (5 head + 6 rows + 8 chips)`,
    r1,
  );
  const f0 = await previewFace(page);
  check(
    !!f0 && f0.rows.join() === 'ib-task,ib-links,ib-arts' && f0.chips.join('|').includes('$6.20'),
    `${tag} R1 the preview is the 1안 face (연결 on by default, right after the task)`,
    f0,
  );
  await fullShot(page, `${tag}-1-card.png`);

  // R2 — a switch: the tokens chip.
  await page.click('#lay-controls input[data-lay="toggle"][data-zone="foot"][data-id="tokens"]', { force: true });
  await saved(page);
  const f1 = await previewFace(page);
  check(!!f1 && f1.chips.some((c) => /토큰/.test(c)), `${tag} R2 the 토큰 switch adds the chip to the preview`, f1);
  check(store.puts.length === 1, `${tag} R2 the change saved at once (one PUT)`, store.puts.length);

  // R3 — ↑ three times: 산출물 줄 to the top of the rows.
  await page.click('#lay-controls button[data-lay="up"][data-zone="rows"][data-idx="3"]');
  await sleep(150);
  await page.click('#lay-controls button[data-lay="up"][data-zone="rows"][data-idx="2"]');
  await sleep(150);
  await page.click('#lay-controls button[data-lay="up"][data-zone="rows"][data-idx="1"]');
  await saved(page);
  const f2 = await previewFace(page);
  check(
    !!f2 && f2.rows.join() === 'ib-arts,ib-task,ib-links',
    `${tag} R3 ↑ moves 산출물 줄 above 현재 작업 in the preview`,
    f2,
  );
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  check(/산출물 줄/.test(String(focused)), `${tag} R3 focus stays on the moved item's control`, focused);

  // R4 — drag 모델 (foot, index 2) onto the top of 'PR' (index 0).
  await page.dragAndDrop(
    '#lay-controls li.lay-item[data-zone="foot"][data-idx="2"]',
    '#lay-controls li.lay-item[data-zone="foot"][data-idx="0"]',
    { targetPosition: { x: 40, y: 4 } },
  );
  await saved(page);
  const foot = store.doc.presets?.['1']?.minimal?.card?.foot.map((c) => c.id) ?? [];
  check(foot[0] === 'model', `${tag} R4 dragging 모델 onto PR puts it first`, foot);
  const f3 = await previewFace(page);
  check(!!f3 && /Opus/.test(f3.chips[0] || ''), `${tag} R4 the preview's foot starts with the model`, f3);
  await fullShot(page, `${tag}-2-card-edited.png`);

  // R5 — the open card.
  await surface(page, 'open');
  await page.click('#lay-controls input[data-lay="toggle"][data-zone="parts"][data-id="tasks"]', { force: true });
  await saved(page);
  await sleep(300);
  const o = await previewFace(page);
  check(
    !!o && o.open && /중지/.test(o.body) && /작업 창/.test(o.body),
    `${tag} R5 the open card's preview: actions first, then the task window`,
    o,
  );
  await fullShot(page, `${tag}-3-open.png`);

  // R6 — the detail card: the task list as one line.
  await surface(page, 'detail');
  await page.selectOption('#lay-controls select[data-key="tasks"]', 'line');
  await saved(page);
  const d = await page.evaluate(() => (document.getElementById('lay-preview') as HTMLElement).innerText);
  check(/작업 2 \/ 4/.test(d), `${tag} R6 the detail preview shows the task line`, d.slice(0, 200));
  await fullShot(page, `${tag}-4-detail.png`);

  // R7 — the thread card: 따로 설정, then 진행 n/m on.
  await page.selectOption('#lay-thread-mode', 'custom');
  await saved(page);
  const t0 = store.doc.thread;
  const want = followThreadLayout(resolveLayouts(store.doc, 'minimal', '1').card);
  check(
    t0?.mode === 'custom' && JSON.stringify(t0.custom) === JSON.stringify(want),
    `${tag} R7 따로 설정 starts from what the thread card showed (the task card)`,
    { got: t0, want },
  );
  await page.click('#lay-controls input[data-lay="toggle"][data-zone="info"][data-id="steps"]', { force: true });
  await saved(page);
  const sk = await page.evaluate(() => (document.getElementById('lay-preview') as HTMLElement).innerText);
  check(/작업 2\/4/.test(sk) && /결제 페이지 리뉴얼/.test(sk), `${tag} R7 the Slack preview adds the steps`, sk);
  await fullShot(page, `${tag}-5-thread.png`);

  // R8 — the detail card's default preset.
  await page.selectOption('#lay-def-detail', '3');
  await saved(page);
  check(store.doc.active?.detail === '3', `${tag} R8 the detail card's default preset is saved`, store.doc.active);

  // R9 — 되돌리기 takes it back, then redo by choosing again (the board check below uses 1안's detail).
  await page.click('#lay-undo');
  await saved(page);
  check(store.doc.active?.detail === undefined, `${tag} R9 되돌리기 takes the last change back`, store.doc.active);

  // R10 — the dashboard draws the saved layout.
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForSelector(`li.ib-card[data-card="${KEY_A}"] .ib-face`, { timeout: 15_000 });
  await sleep(800);
  const b = await page.evaluate((k) => {
    const face = (window as any).__card(k).querySelector('.ib-face') as HTMLElement;
    return {
      rows: Array.from(face.children)
        .map((x) => (x as HTMLElement).className.split(' ')[0])
        .filter((c) => c !== 'ib-head' && c !== 'ib-foot'),
      chips: Array.from(face.querySelectorAll<HTMLElement>('.ib-foot .ib-metric')).map((m) => m.innerText.trim()),
    };
  }, KEY_A);
  check(b.rows.join() === 'ib-arts,ib-task,ib-links', `${tag} R10 the board card's rows follow the saved order`, b);
  check(
    /Opus/.test(b.chips[0] || '') && b.chips.some((c) => /토큰/.test(c)),
    `${tag} R10 the board card's foot: the model first, the tokens chip`,
    b,
  );
  await page.click(`li.ib-card[data-card="${KEY_A}"] .ib-face .ib-title`);
  await sleep(1000);
  const body = await page.evaluate((k) => {
    const h = document.getElementById('kanban') as HTMLElement;
    const slot = Array.from(h.children).find((c) => c.getAttribute('slot') === `body:${k}`) as HTMLElement | undefined;
    // The task window is <ui-task-plan> (its text is in its shadow root): its presence, then the slot's text.
    return slot ? (slot.querySelector('ui-task-plan') ? '[작업 창] ' : '') + slot.innerText : '';
  }, KEY_A);
  // R6 set 1안's detail card to the task line (R9 took back only the default): the detail card shows the line.
  const detail = await page.evaluate(() => {
    const line = document.querySelector('#panel-tasks .ptl-line') as HTMLElement | null;
    return { line: !!line && line.checkVisibility(), text: line ? line.innerText : '' };
  });
  check(
    /중지/.test(body) &&
      // The refs wrap on a phone: one space for any run of white space.
      /#700 열림/.test(body.replace(/\s+/g, ' ')) &&
      /PAY-12 In Progress/.test(body.replace(/\s+/g, ' ')) &&
      /\[작업 창\]/.test(body) &&
      detail.line,
    `${tag} R10 the open card (actions, links, the task window) and its detail card (the task line)`,
    { body: body.slice(0, 200), detail },
  );
  await page.screenshot({ path: path.join(OUT, `${tag}-6-board-after.png`) });
  check(errors.length === 0, `${tag} no page errors`, errors);
  await ctx.close();
}

async function main() {
  const dashboard = await import('../src/conversation/dashboard');
  dashboard.setDashboardBotName(BOT);
  dashboard.setDashboardSessionAccessor(() => new Map());
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  try {
    for (const [w, h] of [
      [1280, 900],
      [390, 844],
    ] as const) {
      const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
      try {
        await run(browser, w, h);
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
