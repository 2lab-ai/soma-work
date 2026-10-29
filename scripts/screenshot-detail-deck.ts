/**
 * Dashboard detail deck + executed task list (SSOT 2026-10-29) — browser receipts.
 *
 * The real web server serves the real dashboard page (the bot name is set on
 * the server, as src/index.ts does after users.info); the board JSON is built
 * from the REAL task ledger (applyTodoList / recordToolCall / creditTaskUsage
 * over a TodoWrite history shaped like the dev worklogs — the model rewrites a
 * task's text as it completes it) and served through a browser route, and the
 * WebSocket is a stub, so every scenario is deterministic.
 *
 * Asserts (exit 1 on any failure), and writes screenshots, for 1280 light /
 * dark and 390 light:
 *   T1  an opened card's first row is Stop · Slack, right under its face
 *   T2  no 작업 로그 button; opening a card opens its detail card on the right;
 *       a second open card stacks the deck (‹ 2 / 2 ›, edges behind); ‹ goes
 *       back; folding a card takes its detail card out; ✕ folds the card
 *   T3  the top bar stays on screen while the board scrolls
 *   T4  a running card's face names one task — the one in progress
 *   T5  Tasks list the tasks that ran with start → end · tools · tokens; a row
 *       opens its detail (시작 / 종료 / 토큰 / 문구 변경); totals at the foot
 *   T6  the bottom view opens on Chat; 에이전트 트리 sits at the strip's right end
 *   T7  a goal-continuation turn reads System (gear avatar), not the user
 *   T8  answers carry the Slack bot's name
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-detail-deck.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  applyTodoList,
  creditTaskUsage,
  ledgerTasks,
  recordAgentToolCall,
  recordToolCall,
  type TaskLedger,
} from '../src/session/task-ledger';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'detail-deck');
fs.mkdirSync(OUT, { recursive: true });
// Its own port — never one inherited from a shell that runs soma-work.
const PORT = process.env.DETAIL_DECK_PORT || '33931';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BOT = 'Soma Dev (Beta)';

const NOW = Date.now();
const M = 60_000;
const KEY_A = 'mock-inst::work:C201:1700000000.000100';
const KEY_B = 'mock-inst::work:C202:1700000000.000200';

// ── A task history shaped like the dev worklogs, through the real ledger ──
type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string };
function buildLedger(): ReturnType<typeof ledgerTasks> {
  let l: TaskLedger | undefined;
  const t0 = NOW - 40 * M;
  const call = (n: number, inTok: number, outTok: number, cache: number, cost: number) => {
    for (let i = 0; i < n; i++) recordToolCall(l);
    creditTaskUsage(
      l,
      `m:${Math.random()}`,
      { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cache, cacheCreateTokens: 0 },
      cost,
    );
  };
  const list = (at: number, todos: Todo[]) => {
    l = applyTodoList(l, todos, at);
  };
  list(t0, [
    {
      content: 'Intake: PR #3634 데이터·연결 이슈 조회, SSOT-TASK-TREE 작성',
      status: 'in_progress',
      activeForm: 'Reading the PR',
    },
    { content: '작업 폴더 생성·클론·node_modules 준비', status: 'pending', activeForm: 'Preparing workspace' },
    { content: 'astra 배포 증거 확인 1회(게이트 재실행)', status: 'pending', activeForm: 'Re-running the gate' },
    {
      content: 'GitHub 리뷰 게시(라인 코멘트 2건 + APPROVE)·squash 머지',
      status: 'pending',
      activeForm: 'Posting the review',
    },
    { content: '이전 계획: 수동 배포 스크립트 작성', status: 'pending', activeForm: 'Writing a deploy script' },
  ]);
  call(9, 40_000, 6_000, 900_000, 0.9);
  list(t0 + 6 * M, [
    {
      content: 'Intake: PR #3634 데이터·연결 이슈 조회, SSOT-TASK-TREE 작성 — 이슈 2건 연결',
      status: 'completed',
      activeForm: 'Reading the PR',
    },
    { content: '작업 폴더 생성·클론·node_modules 준비', status: 'in_progress', activeForm: 'Preparing workspace' },
    { content: 'astra 배포 증거 확인 1회(게이트 재실행)', status: 'pending', activeForm: 'Re-running the gate' },
    {
      content: 'GitHub 리뷰 게시(라인 코멘트 2건 + APPROVE)·squash 머지',
      status: 'pending',
      activeForm: 'Posting the review',
    },
  ]);
  call(5, 20_000, 3_000, 400_000, 0.4);
  list(t0 + 10 * M, [
    { content: 'Intake: PR #3634 데이터·연결 이슈 조회, SSOT-TASK-TREE 작성 — 이슈 2건 연결', status: 'completed' },
    { content: '작업 폴더 생성·클론·node_modules 준비', status: 'completed', activeForm: 'Preparing workspace' },
    { content: 'astra 배포 증거 확인 1회(게이트 재실행)', status: 'in_progress', activeForm: 'Re-running the gate' },
    {
      content: 'GitHub 리뷰 게시(라인 코멘트 2건 + APPROVE)·squash 머지',
      status: 'pending',
      activeForm: 'Posting the review',
    },
  ]);
  call(17, 80_000, 12_000, 2_400_000, 2.1);
  recordAgentToolCall(l);
  recordAgentToolCall(l);
  list(t0 + 22 * M, [
    { content: 'Intake: PR #3634 데이터·연결 이슈 조회, SSOT-TASK-TREE 작성 — 이슈 2건 연결', status: 'completed' },
    { content: '작업 폴더 생성·클론·node_modules 준비', status: 'completed' },
    {
      content: 'astra 배포 증거 확인 1회(게이트 재실행) — APPROVE, 3/3',
      status: 'completed',
      activeForm: 'Re-running the gate',
    },
    {
      content: 'GitHub 리뷰 게시(라인 코멘트 2건 + APPROVE)·squash 머지 (e28a450)',
      status: 'in_progress',
      activeForm: 'Posting the review',
    },
    {
      content: 'SSOT 성공 증명 게시(Jira PROJ-1234) + 최종 ES 보고 HTML',
      status: 'pending',
      activeForm: 'Posting the proof',
    },
  ]);
  call(10, 50_000, 8_000, 1_200_000, 1.2);
  return ledgerTasks(l as TaskLedger);
}

const TURNS = [
  {
    id: 'u1',
    role: 'user',
    timestamp: new Date(NOW - 41 * M).toISOString(),
    userName: 'Zhuge',
    rawContent: 'PR #3634 리뷰하고 머지까지 해줘',
    origin: { by: 'user' },
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: new Date(NOW - 30 * M).toISOString(),
    summaryTitle: '게이트 재실행',
    summaryBody: 'astra APPROVE 3/3',
    summarized: true,
  },
  {
    id: 'u2',
    role: 'user',
    timestamp: new Date(NOW - 20 * M).toISOString(),
    userName: 'Zhuge',
    rawContent:
      '[goal-continuation] Goal #5/10 — continue toward the goal.\n직전 평가: The work summary has no direct evidence of the merge yet.',
    origin: { by: 'system' },
  },
  {
    id: 'a2',
    role: 'assistant',
    timestamp: new Date(NOW - 5 * M).toISOString(),
    summaryTitle: '리뷰 게시',
    summaryBody: 'review posted',
    summarized: true,
  },
];
const ANSWER = '## 리뷰를 게시했습니다\n\n- 라인 코멘트 2건\n- APPROVE';

function session(key: string, title: string, channel: string, view: ReturnType<typeof ledgerTasks> | null) {
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
    channelId: channel,
    sessionState: 'MAIN',
    activityState: 'working',
    conversationId: `conv-${channel}`,
    lastActivity: new Date(NOW).toISOString(),
    activeLegStartedAtMs: NOW - 20 * M,
    activeAccumulatedMs: 0,
    slackThreadUrl: `https://slack.example/archives/${channel}/p1700000000000`,
    tokenUsage: {
      totalInputTokens: 300_000,
      totalOutputTokens: 40_000,
      totalCacheReadTokens: 6_000_000,
      totalCacheCreateTokens: 100_000,
      totalCostUsd: 6.2,
      contextUsagePercent: 22,
    },
    botName: BOT,
    artifacts: { count: 0, recent: [] },
    tasks: view ? view.current : [],
    earlierTasks: view ? view.earlier : [],
    tasksOutside: view?.outside,
  };
}
// A long board so the page scrolls (T3).
function makeBoard(view: ReturnType<typeof ledgerTasks>) {
  const idle = Array.from({ length: 10 }, (_, i) => ({
    ...session(`mock-inst::work:C3${i}:1700000000.000${i}`, `대기 중인 작업 ${i + 1}`, `C3${i}`, null),
    activityState: 'idle',
  }));
  return {
    waiting: [],
    working: [session(KEY_A, 'dev 로그 문제 확인', 'C201', view), session(KEY_B, '대시보드 카드 개선', 'C202', view)],
    idle,
  };
}

const PAGE_HELPERS = [
  // The board's cards live in <ui-agent-inbox>'s open shadow root; an open card's body is its light-DOM slot.
  'window.__card = function (k) { var h = document.getElementById("kanban"); var r = h && h.shadowRoot; var all = r ? r.querySelectorAll("li.ib-card[data-card]") : []; for (var i = 0; i < all.length; i++) if (all[i].getAttribute("data-card") === k) return all[i]; return null; };',
  'window.__body = function (k) { var h = document.getElementById("kanban"); var all = h ? h.children : []; for (var i = 0; i < all.length; i++) if (all[i].getAttribute("slot") === "body:" + k) return all[i]; return null; };',
  'window.WebSocket = function StubWebSocket(url) {',
  '  this.url = url; this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;',
  '  window.__ws = this;',
  '};',
  'window.WebSocket.prototype.close = function () {};',
  'window.__name = function (f) { return f; };',
].join('\n');

async function installMocks(page: Page, board: unknown) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({
    content: 'localStorage.setItem("soma-board-view", "board"); localStorage.removeItem("soma-panel-detail");',
  });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'x' } }),
  );
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts/, (r) => r.fulfill({ json: { artifacts: [] } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog/, (r) =>
    r.fulfill({ json: { entries: [], hasMore: false } }),
  );
  await page.route(/\/api\/conversations\/[^/]+\/turns\/[^/]+\/raw/, (r) => r.fulfill({ json: { raw: ANSWER } }));
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
  log(`${ok ? '[ok]  ' : '[FAIL]'} ${what}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(what);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function scenario(
  browser: import('playwright').Browser,
  theme: 'light' | 'dark',
  width: number,
  height: number,
  board: unknown,
) {
  const tag = `${width}-${theme}`;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
  // The viewer token (CONVERSATION_VIEWER_TOKEN) as the dashboard's bearer cookie.
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await ctx.addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await installMocks(page, board);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  try {
    await page.waitForSelector(`li.ib-card[data-card="${KEY_A}"] .ib-face`, { timeout: 15_000 });
  } catch (e) {
    const dbg = await page.evaluate(() => ({
      cards: Array.from(document.getElementById('kanban')?.shadowRoot?.querySelectorAll('li.ib-card[data-card]') ?? [])
        .map((c) => c.getAttribute('data-card'))
        .slice(0, 5),
      url: location.href,
    }));
    console.log('DEBUG', JSON.stringify(dbg), errors);
    throw e;
  }
  log(`\n── ${tag} ──`);

  // T4 — the face names one task: the one in progress.
  const face = await page.evaluate((k) => {
    const card = (window as any).__card(k) as HTMLElement;
    const faceEl = card.querySelector('.ib-face') as HTMLElement;
    return { rows: faceEl.querySelectorAll('.ib-task').length, text: faceEl.innerText };
  }, KEY_A);
  check(
    face.rows === 1 && face.text.includes('GitHub 리뷰 게시'),
    `${tag} T4 the face shows one task — the one in progress`,
    face,
  );
  check(
    !face.text.includes('작업 폴더 생성') && !face.text.includes('APPROVE, 3/3'),
    `${tag} T4 no completed task on the face`,
  );

  // T1/T2 — open card A: actions first, no 작업 로그, its detail card on the right.
  await page.click(`li.ib-card[data-card="${KEY_A}"] .ib-face`);
  await page.waitForSelector('#slide-panel.open');
  await sleep(400);
  const opened = await page.evaluate((k) => {
    const card = (window as any).__card(k) as HTMLElement;
    const slot = (window as any).__body(k) as HTMLElement;
    const body = slot.querySelector('.card-body') as HTMLElement;
    const first = body.firstElementChild as HTMLElement;
    const faceR = (card.querySelector('.ib-face') as HTMLElement).getBoundingClientRect();
    const bar = body.querySelector('.card-actions-bar') as HTMLElement | null;
    const barR = bar ? bar.getBoundingClientRect() : null;
    const labels = Array.from(body.querySelectorAll('button, a')).map((b) => (b as HTMLElement).innerText.trim());
    return {
      firstClass: first ? first.className : '',
      barGap: barR ? Math.round(barR.top - faceR.bottom) : -1,
      barText: bar ? bar.innerText.replace(/\s+/g, ' ') : '',
      hasWorklogBtn: labels.includes('작업 로그'),
      panelTitle: (document.getElementById('panel-title') as HTMLElement).textContent,
      deckHidden: (document.getElementById('panel-deck') as HTMLElement).hidden,
    };
  }, KEY_A);
  check(
    opened.firstClass === 'card-actions-bar',
    `${tag} T1 the open card's first row is the action bar`,
    opened.firstClass,
  );
  check(
    /Stop/.test(opened.barText) && /Slack/.test(opened.barText),
    `${tag} T1 Stop and Slack in that row`,
    opened.barText,
  );
  check(
    opened.barGap >= 0 && opened.barGap <= 40,
    `${tag} T1 the row sits right under the face (gap ${opened.barGap}px)`,
  );
  check(!opened.hasWorklogBtn, `${tag} T2 no 작업 로그 button`);
  check(
    opened.panelTitle === 'dev 로그 문제 확인',
    `${tag} T2 opening the card opened its detail card`,
    opened.panelTitle,
  );
  check(opened.deckHidden, `${tag} T2 one card: no deck controls`);

  // T6 — Chat by default; 에이전트 트리 at the strip's right end.
  const tabs = await page.evaluate(() => {
    const strip = document.getElementById('panel-sections') as HTMLElement;
    const sel = strip.querySelector('[aria-selected="true"]') as HTMLElement;
    const tree = document.getElementById('psec-tab-tree') as HTMLElement;
    const order = Array.from(strip.querySelectorAll('.psec-tab')).map((t) => (t.textContent || '').trim());
    const sr = strip.getBoundingClientRect();
    const tr = tree.getBoundingClientRect();
    return { selected: sel.id, order, treeRightGap: Math.round(sr.right - tr.right) };
  });
  check(tabs.selected === 'psec-tab-conv', `${tag} T6 Chat is the default view`, tabs.selected);
  check(
    tabs.order[0] === 'Chat' && tabs.order[2] === '에이전트 트리',
    `${tag} T6 order Chat · 작업 로그 · 에이전트 트리`,
    tabs.order,
  );
  check(tabs.treeRightGap <= 16, `${tag} T6 에이전트 트리 at the right end (gap ${tabs.treeRightGap}px)`);

  // T7 / T8 — the chat: System for the harness turn, the bot's name on answers.
  await page.waitForSelector('#panel-turns .turn.assistant');
  const chat = await page.evaluate(() => {
    // textContent: the earlier turns fold behind 이전 대화 (not rendered, so no innerText).
    const names = Array.from(document.querySelectorAll('#panel-turns .turn .turn-name')).map((n) =>
      (n.textContent || '').trim(),
    );
    const sys = document.querySelector('#panel-turns .turn.is-sys');
    return {
      names,
      sysName: sys ? (sys.querySelector('.turn-name')?.textContent || '').trim() : '',
      sysAvatar: sys ? !!sys.querySelector('.sys-avatar') : false,
      sysUserAvatar: sys ? !!sys.querySelector('.user-avatar') : true,
    };
  });
  check(
    chat.sysName === 'System' && chat.sysAvatar && !chat.sysUserAvatar,
    `${tag} T7 the goal continuation reads System`,
    chat,
  );
  check(chat.names.includes('Zhuge'), `${tag} T7 the user's own turn keeps the user's name`, chat.names);
  check(
    chat.names.filter((n) => n === BOT).length >= 2 && !chat.names.includes('Assistant'),
    `${tag} T8 answers carry the bot name`,
    chat.names,
  );
  await page.screenshot({ path: path.join(OUT, `${tag}-1-open-card.png`) });

  // T5 — Tasks: the runs, a row's detail, the totals.
  await page.click('#panel-tasks .panel-tasks-header');
  await page.waitForSelector('#panel-tasks .tr-run');
  const runs = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#panel-tasks .tr-list .tr-run'));
    return {
      n: rows.length,
      lines: rows.map((r) => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
      plan: document.querySelectorAll('#panel-tasks .tr-plan li').length,
      total: (document.querySelector('#panel-tasks .tr-total') as HTMLElement | null)?.innerText || '',
    };
  });
  check(runs.n === 4, `${tag} T5 four tasks ran (rewrites kept as one task each)`, runs.lines);
  check(
    runs.lines.every((l) => /툴 \d+/.test(l) && /tok/.test(l)),
    `${tag} T5 every run shows tools and tokens`,
    runs.lines,
  );
  check(
    runs.lines.some((l) => l.includes('APPROVE, 3/3') && /툴 17/.test(l)),
    `${tag} T5 the gate re-run keeps its 17 tool calls`,
    runs.lines,
  );
  check(runs.plan === 1, `${tag} T5 one step left in the plan`);
  check(/합계/.test(runs.total) && /tok/.test(runs.total), `${tag} T5 totals at the foot`, runs.total);
  await page.click('#panel-tasks .tr-run:nth-child(3) .tr-row');
  const detail = await page.evaluate(
    () => (document.querySelector('#panel-tasks .tr-detail') as HTMLElement | null)?.innerText || '',
  );
  check(
    /시작/.test(detail) && /종료/.test(detail) && /토큰/.test(detail) && /문구 변경/.test(detail),
    `${tag} T5 a run's detail: start, end, tokens, earlier text`,
    detail,
  );
  await page.evaluate(() => (document.querySelector('#panel-tasks') as HTMLElement).scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(OUT, `${tag}-2-tasks.png`) });

  if (width < 840) {
    // A phone: the detail card is a full-screen sheet over the board — ✕ folds the card and shows the board.
    await page.click('.panel-close');
    await sleep(300);
    const phone = await page.evaluate(
      (k) => ({
        open: document.getElementById('slide-panel')?.classList.contains('open'),
        aOpen: ((window as any).__card(k) as HTMLElement).classList.contains('is-open'),
      }),
      KEY_A,
    );
    check(phone.open === false && phone.aOpen === false, `${tag} T2 ✕ closes the sheet and folds the card`, phone);
    await page.evaluate(() => window.scrollTo(0, 900));
    await sleep(200);
    const top = await page.evaluate(() =>
      Math.round((document.querySelector('.topbar') as HTMLElement).getBoundingClientRect().top),
    );
    check(top === 0, `${tag} T3 the top bar stays at the top`, top);
    await page.screenshot({ path: path.join(OUT, `${tag}-4-scrolled.png`) });
    const overflowP = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflowP <= 0, `${tag} no horizontal overflow`, overflowP);
    check(errors.length === 0, `${tag} no page errors`, errors);
    await ctx.close();
    return;
  }
  // T2 — a second open card stacks the deck.
  await page.click(`li.ib-card[data-card="${KEY_B}"] .ib-face`);
  await sleep(400);
  const deck2 = await page.evaluate(() => ({
    title: (document.getElementById('panel-title') as HTMLElement).textContent,
    hidden: (document.getElementById('panel-deck') as HTMLElement).hidden,
    pos: (document.getElementById('panel-deck-pos') as HTMLElement).textContent,
    behind: (document.getElementById('slide-panel') as HTMLElement).getAttribute('data-deck'),
    peek: getComputedStyle(document.getElementById('panel-deck-peek') as HTMLElement).display,
  }));
  check(
    deck2.title === '대시보드 카드 개선' && !deck2.hidden && deck2.pos === '2 / 2',
    `${tag} T2 two open cards: the deck shows 2 / 2`,
    deck2,
  );
  check(deck2.behind === '1' && deck2.peek !== 'none', `${tag} T2 the other detail card's edge peeks behind`, deck2);
  await page.screenshot({ path: path.join(OUT, `${tag}-3-deck.png`) });
  await page.click('#panel-deck-prev');
  await sleep(300);
  const back = await page.evaluate(() => ({
    title: (document.getElementById('panel-title') as HTMLElement).textContent,
    pos: (document.getElementById('panel-deck-pos') as HTMLElement).textContent,
  }));
  check(
    back.title === 'dev 로그 문제 확인' && back.pos === '1 / 2',
    `${tag} T2 ‹ brings the first detail card back`,
    back,
  );

  // T3 — the top bar stays on screen while the page scrolls (wide only: the board has room to scroll).
  await page.evaluate(() => window.scrollTo(0, 900));
  await sleep(200);
  const bar = await page.evaluate(() => {
    const r = (document.querySelector('.topbar') as HTMLElement).getBoundingClientRect();
    return { top: Math.round(r.top), h: Math.round(r.height), y: Math.round(window.scrollY) };
  });
  check(bar.top === 0 && bar.h > 0, `${tag} T3 the top bar stays at the top (scrolled ${bar.y}px)`, bar);
  await page.screenshot({ path: path.join(OUT, `${tag}-4-scrolled.png`) });
  await page.evaluate(() => window.scrollTo(0, 0));

  // T2 — ✕ closes the front detail card and folds its card; the other comes to the front.
  await page.click('.panel-close');
  await sleep(300);
  const closed = await page.evaluate(
    (k) => ({
      aOpen: ((window as any).__card(k) as HTMLElement).classList.contains('is-open'),
      title: (document.getElementById('panel-title') as HTMLElement).textContent,
      deckHidden: (document.getElementById('panel-deck') as HTMLElement).hidden,
    }),
    KEY_A,
  );
  check(
    !closed.aOpen && closed.title === '대시보드 카드 개선' && closed.deckHidden,
    `${tag} T2 ✕ folds the card; the other detail card comes forward`,
    closed,
  );
  // Folding the last open card closes the panel.
  await page.click(`li.ib-card[data-card="${KEY_B}"] .ib-face`);
  await sleep(300);
  const none = await page.evaluate(() => document.getElementById('slide-panel')?.classList.contains('open'));
  check(none === false, `${tag} T2 folding the last open card closes the detail`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `${tag} no horizontal overflow`, overflow);
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
  const board = makeBoard(buildLedger());
  // Single-process (a sandboxed agent shell cannot register Chromium's Mach port
  // for child processes) — which holds one context per browser: a browser per scenario.
  const runs: Array<['light' | 'dark', number, number]> = [
    ['light', 1280, 860],
    ['dark', 1280, 860],
    ['light', 390, 844],
  ];
  try {
    for (const [theme, w, h] of runs) {
      const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
      try {
        await scenario(browser, theme, w, h, board);
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
