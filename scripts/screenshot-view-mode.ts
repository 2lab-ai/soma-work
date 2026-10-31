/**
 * Dashboard minimal / advanced mode (SSOT 2026-11-01) — browser receipts.
 *
 * The real web server serves the real dashboard page; the board JSON is built
 * from the REAL task ledger and served through a browser route, /api/settings
 * is a per-user store double (the PATCH body is kept, a reload reads it back),
 * and the WebSocket is a stub, so every scenario is deterministic.
 *
 * Asserts (exit 1 on any failure), and writes screenshots, for 1280 light /
 * dark and 390 light:
 *   M1  a user with no saved choice opens in minimal mode; the top bar's
 *       어드밴스드 toggle reads off (aria-pressed=false)
 *   M2  minimal: no stats strip, no capacity, no CRON lane; the board stays
 *   M3  minimal: a card face keeps title · status · time · the task in
 *       progress · a pending question; no tokens · cost · context · agents ·
 *       artifacts · PR · media
 *   M4  minimal: the open detail card has no 자세히 chip; its top part
 *       (header + surface) is at most 20% of it; Tasks and Chat take the rest
 *       and the composer stays; the section tabs (작업 로그 · 에이전트 트리) and
 *       the agent tabs are hidden
 *   M5  minimal: a waiting session's question card still answers
 *   M6  the toggle saves the choice per user (PATCH /api/settings/dashboardMode)
 *       and a reload keeps it; advanced shows everything the page showed
 *       before (stats, capacity slot, every card field, 자세히-on sections)
 *
 * Run from the repo root with a clean env (keeps state out of the checkout):
 *   env -i PATH="$PATH" HOME="$TMP" TMPDIR="$TMP" SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst \
 *     CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-view-mode.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  applyTodoList,
  creditTaskUsage,
  ledgerTasks,
  recordToolCall,
  type TaskLedger,
} from '../src/session/task-ledger';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'view-mode');
fs.mkdirSync(OUT, { recursive: true });
// Its own port — never one inherited from a shell that runs soma-work.
const PORT = process.env.VIEW_MODE_PORT || '33941';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BOT = 'Soma Dev (Beta)';
const BASELINE = process.env.VIEW_MODE_BASELINE === '1'; // screenshots only, no checks (the page before this change)

const NOW = Date.now();
const M = 60_000;
const KEY_A = 'mock-inst::work:C201:1700000000.000100';
const KEY_Q = 'mock-inst::work:C202:1700000000.000200';

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string };
function buildLedger(): ReturnType<typeof ledgerTasks> {
  let l: TaskLedger | undefined;
  const t0 = NOW - 40 * M;
  const call = (n: number, cost: number) => {
    for (let i = 0; i < n; i++) recordToolCall(l);
    creditTaskUsage(
      l,
      `m:${Math.random()}`,
      { inputTokens: 40_000, outputTokens: 6_000, cacheReadTokens: 900_000, cacheCreateTokens: 0 },
      cost,
    );
  };
  const list = (at: number, todos: Todo[]) => {
    l = applyTodoList(l, todos, at);
  };
  list(t0, [
    { content: '요구 정리: 음성 메모 받아쓰기, 의도 트리 작성', status: 'in_progress' },
    { content: '보드 카드 · 상세 카드 현재 구조 확인', status: 'pending' },
    { content: '미니멀 모드 구현', status: 'pending' },
    { content: '브라우저 스크린샷으로 확인', status: 'pending' },
  ]);
  call(6, 0.6);
  list(t0 + 8 * M, [
    { content: '요구 정리: 음성 메모 받아쓰기, 의도 트리 작성', status: 'completed' },
    { content: '보드 카드 · 상세 카드 현재 구조 확인', status: 'completed' },
    { content: '미니멀 모드 구현', status: 'in_progress' },
    { content: '브라우저 스크린샷으로 확인', status: 'pending' },
  ]);
  call(14, 1.4);
  return ledgerTasks(l as TaskLedger);
}

const TURNS = [
  {
    id: 'u1',
    role: 'user',
    timestamp: new Date(NOW - 41 * M).toISOString(),
    userName: 'Zhuge',
    rawContent: '대시보드를 미니멀하게 바꿔줘. 채팅이랑 작업 목록이 커야 돼.',
    origin: { by: 'user' },
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: new Date(NOW - 30 * M).toISOString(),
    summaryTitle: '구조 확인',
    summaryBody: '보드 카드와 상세 카드의 현재 구조를 확인했습니다',
    summarized: true,
  },
  {
    id: 'u2',
    role: 'user',
    timestamp: new Date(NOW - 20 * M).toISOString(),
    userName: 'Zhuge',
    rawContent: '어드밴스드 모드는 지금 화면 그대로 두고',
    origin: { by: 'user' },
  },
  {
    id: 'a2',
    role: 'assistant',
    timestamp: new Date(NOW - 5 * M).toISOString(),
    summaryTitle: '미니멀 모드 구현 중',
    summaryBody: '카드 면과 상세 카드를 줄이고 있습니다',
    summarized: true,
  },
];
const ANSWER = '## 미니멀 모드 구현 중\n\n- 카드 면: 제목 · 상태 · 시간 · 진행 중 작업\n- 상세 카드: 작업 목록과 채팅';

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
    prUrl: 'https://github.com/2lab-ai/soma-work/pull/700',
    prShortRef: 'PR-700',
    prStatus: 'open',
    prTitle: '대시보드 미니멀 모드',
    tokenUsage: {
      totalInputTokens: 300_000,
      totalOutputTokens: 40_000,
      totalCacheReadTokens: 6_000_000,
      totalCacheCreateTokens: 100_000,
      totalCostUsd: 6.2,
      contextUsagePercent: 64,
    },
    contextTokens: 640_000,
    autoCompactTokens: 750_000,
    agents: [
      {
        id: 'ag1',
        type: 'Explore',
        label: 'Explore',
        status: 'completed',
        startedAt: NOW - 30 * M,
        endedAt: NOW - 25 * M,
      },
      { id: 'ag2', type: 'general-purpose', label: 'general-purpose', status: 'running', startedAt: NOW - 4 * M },
    ],
    agentsTotal: 2,
    userMedia: { count: 1 },
    botName: BOT,
    artifacts: {
      count: 2,
      recent: [
        { id: 'art1', name: 'analysis.html', kind: 'html' },
        { id: 'art2', name: 'board.png', kind: 'image' },
      ],
    },
    tasks: view ? view.current : [],
    earlierTasks: view ? view.earlier : [],
    tasksOutside: view?.outside,
  };
}
function makeBoard(view: ReturnType<typeof ledgerTasks>) {
  const idle = Array.from({ length: 4 }, (_, i) => ({
    ...session(`mock-inst::work:C3${i}:1700000000.000${i}`, `끝난 작업 ${i + 1}`, `C3${i}`, null),
    activityState: 'idle',
    finishedAt: NOW - (i + 1) * 60 * M,
  }));
  const waiting = {
    ...session(KEY_Q, '배포 전 확인 질문', 'C202', null),
    activityState: 'waiting',
    waitingSince: NOW - 3 * M,
    pendingQuestion: {
      type: 'user_choice',
      question: 'dev에 먼저 배포할까요?',
      choices: [
        { id: 'yes', label: '네, dev 먼저' },
        { id: 'no', label: '아니요' },
      ],
    },
  };
  return { waiting: [waiting], working: [session(KEY_A, '대시보드 미니멀 모드', 'C201', view)], idle };
}

const PAGE_HELPERS = [
  'window.__card = function (k) { var h = document.getElementById("kanban"); var r = h && h.shadowRoot; var all = r ? r.querySelectorAll("li.ib-card[data-card]") : []; for (var i = 0; i < all.length; i++) if (all[i].getAttribute("data-card") === k) return all[i]; return null; };',
  'window.__body = function (k) { var h = document.getElementById("kanban"); var all = h ? h.children : []; for (var i = 0; i < all.length; i++) if (all[i].getAttribute("slot") === "body:" + k) return all[i]; return null; };',
  'window.WebSocket = function StubWebSocket(url) {',
  '  this.url = url; this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;',
  '  window.__ws = this;',
  '};',
  'window.WebSocket.prototype.close = function () {};',
  'window.__name = function (f) { return f; };',
].join('\n');

// The per-user store double: one value per user, kept across page loads of a scenario.
type Store = { mode: string | null; patches: unknown[] };
function settingsSnapshot(store: Store) {
  const settings: unknown[] = [
    {
      key: 'defaultModel',
      group: 'model',
      label: '기본 모델',
      description: '',
      kind: 'choice',
      value: 'opus',
      modified: false,
      options: [{ value: 'opus', label: 'Opus' }],
      editable: true,
      slackCommand: 'model set <모델>',
    },
    {
      key: 'defaultEffort',
      group: 'model',
      label: '기본 effort',
      description: '',
      kind: 'choice',
      value: 'high',
      modified: false,
      options: [{ value: 'high', label: 'High' }],
      editable: true,
      slackCommand: 'effort',
    },
    {
      key: 'dashboardMode',
      group: 'output',
      label: '대시보드 화면',
      description: '',
      kind: 'choice',
      value: store.mode ?? 'minimal',
      defaultValue: 'minimal',
      modified: (store.mode ?? 'minimal') !== 'minimal',
      options: [
        { value: 'minimal', label: '미니멀' },
        { value: 'advanced', label: '어드밴스드' },
      ],
      editable: true,
    },
  ];
  return { userId: 'U001', isAdmin: false, accepted: true, groups: [], settings };
}

async function installMocks(page: Page, board: unknown, store: Store) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({
    content: 'localStorage.setItem("soma-board-view", "board"); localStorage.removeItem("soma-panel-detail");',
  });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'x' } }),
  );
  await page.route('**/api/settings', (r) => r.fulfill({ json: settingsSnapshot(store) }));
  await page.route(/\/api\/settings\/[^/?]+$/, (r) => {
    const key = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    const body = JSON.parse(r.request().postData() || '{}');
    store.patches.push({ key, value: body.value });
    if (key === 'dashboardMode') store.mode = body.value;
    const row = (settingsSnapshot(store).settings as Array<{ key: string }>).find((s) => s.key === key);
    return r.fulfill({ json: { ok: true, setting: row } });
  });
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
  if (BASELINE) return;
  log(`${ok ? '[ok]  ' : '[FAIL]'} ${what}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(what);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function waitBoard(page: Page) {
  await page.waitForSelector(`li.ib-card[data-card="${KEY_A}"] .ib-face`, { timeout: 15_000 });
  await sleep(400);
}

function faceOf(page: Page, key: string) {
  return page.evaluate((k) => {
    const card = (window as any).__card(k) as HTMLElement;
    const face = card.querySelector('.ib-face') as HTMLElement;
    const has = (sel: string) => {
      const el = face.querySelector(sel) as HTMLElement | null;
      return !!el && el.checkVisibility();
    };
    return {
      text: face.innerText,
      height: Math.round(face.getBoundingClientRect().height),
      tokens: /토큰|tokens/i.test(face.innerText) || has('.ib-tokens'),
      cost: /\$\d/.test(face.innerText),
      ctx: /\d+%/.test(face.innerText),
      pr: /#700/.test(face.innerText),
      task: has('.ib-task'),
    };
  }, key);
}

async function openCard(page: Page, key: string) {
  await page.click(`li.ib-card[data-card="${key}"] .ib-face`);
  await page.waitForFunction(() => {
    const p = document.getElementById('slide-panel') as any;
    return !!p && (p.open === true || p.hasAttribute('open') || p.classList.contains('open'));
  });
  await sleep(700);
}

function panelLayout(page: Page) {
  return page.evaluate(() => {
    const vis = (id: string) => {
      const el = document.getElementById(id);
      return !!el && el.checkVisibility();
    };
    const rect = (id: string) => {
      const el = document.getElementById(id);
      if (!el || !el.checkVisibility()) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    // The drawer host has no box of its own (its sheet is in its shadow root): the detail card runs from its
    // header's top to the composer's bottom.
    const header = document.querySelector('#slide-panel .panel-header') as HTMLElement;
    const hr = header.getBoundingClientRect();
    const cr = (document.getElementById('panel-command') as HTMLElement).getBoundingClientRect();
    const pr = { top: hr.top, height: cr.bottom - hr.top };
    const tasks = rect('panel-tasks');
    const conv = rect('psec-conv');
    return {
      panel: { top: Math.round(pr.top), height: Math.round(pr.height) },
      header: Math.round(hr.height),
      tasksTop: tasks ? tasks.top - Math.round(pr.top) : null,
      tasks,
      conv,
      detailChip: vis('panel-detail-toggle'),
      surface: rect('panel-surface'),
      info: vis('panel-info'),
      artifacts: vis('panel-artifacts'),
      agentTabs:
        vis('panel-tabs') &&
        !!document.querySelector('#panel-tabs')?.shadowRoot?.querySelector('[role="tab"]')?.checkVisibility(),
      sectionStrip: (() => {
        const t = document.getElementById('panel-sections') as any;
        const strip = t?.shadowRoot?.querySelector('[role="tablist"]') as HTMLElement | null;
        return !!strip && strip.checkVisibility();
      })(),
      controls: vis('panel-controls'),
      composer: vis('pc-composer'),
      titleSub: vis('panel-title-sub'),
    };
  });
}

function pageLayout(page: Page) {
  return page.evaluate(() => {
    const vis = (id: string) => {
      const el = document.getElementById(id);
      return !!el && el.checkVisibility();
    };
    const btn = document.getElementById('view-mode-toggle');
    return {
      stats: vis('stats'),
      capacitySlot: !!document.getElementById('capacity'),
      cron: Array.from(document.querySelectorAll('ui-agent-inbox.cron-inbox')).some((e) =>
        (e as HTMLElement).checkVisibility(),
      ),
      toggle: btn
        ? { visible: btn.checkVisibility(), pressed: btn.getAttribute('aria-pressed'), text: btn.textContent }
        : null,
      bodyMode: document.body.getAttribute('data-view-mode'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

async function scenario(
  browser: import('playwright').Browser,
  theme: 'light' | 'dark',
  width: number,
  height: number,
  board: unknown,
) {
  const tag = `${width}-${theme}`;
  const store: Store = { mode: null, patches: [] };
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await ctx.addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await installMocks(page, board, store);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await waitBoard(page);
  log(`\n── ${tag} ──`);

  // M1 / M2 — first visit: minimal, the toggle off, the page's extras gone.
  const p0 = await pageLayout(page);
  check(p0.bodyMode === 'minimal', `${tag} M1 a user with no saved choice opens in minimal mode`, p0);
  check(
    !!p0.toggle && p0.toggle.visible && p0.toggle.pressed === 'false',
    `${tag} M1 the top bar's 어드밴스드 toggle is there, off`,
    p0.toggle,
  );
  check(!p0.stats && !p0.cron, `${tag} M2 minimal hides the stats strip and the CRON lane`, p0);

  // M3 — the face: what matters only.
  const fA = await faceOf(page, KEY_A);
  check(fA.task && fA.text.includes('미니멀 모드 구현'), `${tag} M3 the running card names its task in progress`, fA);
  check(!fA.tokens && !fA.cost && !fA.ctx && !fA.pr, `${tag} M3 minimal face: no tokens · cost · context · PR`, fA);
  const fQ = await faceOf(page, KEY_Q);
  check(fQ.text.includes('dev에 먼저 배포할까요?'), `${tag} M3 a waiting card's face says its question`, fQ);
  await page.screenshot({ path: path.join(OUT, `${tag}-1-minimal-board.png`) });

  // M4 — the open detail card.
  await openCard(page, KEY_A);
  const l1 = await panelLayout(page);
  check(!l1.detailChip, `${tag} M4 no 자세히 chip on the detail card`, l1);
  check(
    l1.tasksTop !== null && l1.tasksTop <= Math.round(l1.panel.height * 0.2),
    `${tag} M4 the top part (header + surface) is at most 20% of the detail card`,
    { tasksTop: l1.tasksTop, panel: l1.panel.height },
  );
  if (l1.tasksTop !== null && l1.panel.height > 0)
    log(
      `${tag} M4 measured: top part ${l1.tasksTop}px of ${l1.panel.height}px (${Math.round((100 * l1.tasksTop) / l1.panel.height)}%), task list ${l1.tasks?.height}px, chat ${l1.conv?.height}px`,
    );
  check(
    !!l1.conv && !!l1.tasks && l1.conv.height + l1.tasks.height >= Math.round(l1.panel.height * 0.5),
    `${tag} M4 Tasks and Chat take the body`,
    l1,
  );
  check(!l1.sectionStrip && !l1.agentTabs, `${tag} M4 minimal hides the section tabs and the agent tabs`, l1);
  check(l1.composer && !l1.controls, `${tag} M4 the composer stays; model · effort go`, l1);
  check(!l1.info && !l1.artifacts && !l1.titleSub, `${tag} M4 minimal hides 세션 정보 · 산출물 · 부제`, l1);
  await page.screenshot({ path: path.join(OUT, `${tag}-2-minimal-detail.png`) });

  // M5 — the waiting card answers in minimal mode too. (A phone's detail card is a full-screen sheet over the
  // board: ✕ folds the card first.)
  if (width < 840) {
    await page.evaluate(() => (window as any).closeDetailCard());
    await sleep(500);
  }
  await openCard(page, KEY_Q);
  const q = await page.evaluate(() => {
    const host = document.getElementById('panel-question') as HTMLElement | null;
    return { visible: !!host && host.checkVisibility(), text: host ? host.innerText : '' };
  });
  check(q.visible, `${tag} M5 minimal keeps a waiting session's question card`, q);
  await page.screenshot({ path: path.join(OUT, `${tag}-3-minimal-question.png`) });
  if (BASELINE) {
    log(`${tag} baseline page: ${JSON.stringify(p0)}`);
    log(`${tag} baseline face A: ${JSON.stringify(fA)}`);
    log(`${tag} baseline detail: ${JSON.stringify(l1)}`);
    await ctx.close();
    return;
  }

  // M6 — switch to advanced: saved per user, a reload keeps it. (A phone's sheet covers the top bar: ✕ first.)
  if (width < 840) {
    await page.evaluate(() => (window as any).closeDetailCard());
    await sleep(500);
  }
  await page.click('#view-mode-toggle');
  await sleep(600);
  const p1 = await pageLayout(page);
  check(p1.bodyMode === 'advanced' && p1.toggle?.pressed === 'true', `${tag} M6 the toggle turns advanced on`, p1);
  check(
    store.patches.some((x) => JSON.stringify(x) === JSON.stringify({ key: 'dashboardMode', value: 'advanced' })),
    `${tag} M6 the choice is saved per user (PATCH /api/settings/dashboardMode)`,
    store.patches,
  );
  check(p1.stats, `${tag} M6 advanced shows the stats strip again`, p1);
  const fA2 = await faceOf(page, KEY_A);
  check(fA2.cost && fA2.ctx && fA2.pr, `${tag} M6 advanced face carries cost · context · PR again`, fA2);
  await page.reload();
  await waitBoard(page);
  const p2 = await pageLayout(page);
  check(p2.bodyMode === 'advanced', `${tag} M6 a reload keeps advanced (the server's value)`, p2);
  await page.screenshot({ path: path.join(OUT, `${tag}-4-advanced-board.png`) });
  if (width < 840) {
    await page.evaluate(() => (window as any).closeDetailCard());
    await sleep(500);
  }
  await openCard(page, KEY_A);
  const l2 = await panelLayout(page);
  check(!l2.detailChip, `${tag} M6 advanced has no 자세히 chip either (the mode is the switch)`, l2);
  check(l2.sectionStrip && l2.controls && l2.info, `${tag} M6 advanced detail: section tabs · model · 세션 정보`, l2);
  await page.screenshot({ path: path.join(OUT, `${tag}-5-advanced-detail.png`) });

  check(p0.overflow <= 0 && p1.overflow <= 0, `${tag} no horizontal overflow`, [p0.overflow, p1.overflow]);
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
