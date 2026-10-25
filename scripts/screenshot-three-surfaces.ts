/**
 * Three surfaces of one agentic task — browser receipts and assertions
 * (.prd/13-dashboard-three-surfaces-spec.md).
 *
 * The real web server serves the real dashboard page; the browser-side HTTP
 * layer is mocked (board JSON, turns, work log, artifacts) and the WebSocket is
 * a stub, so every scenario is deterministic.
 *
 * Asserts (exit 1 on any failure), and writes screenshots, for
 * 1280 / 820 / 390 × light / dark, plus 390×520 (a phone with its keyboard up)
 * and 844×390 (a phone held sideways):
 *   - face (triage): the shipped face — task row, subagent pulse, tokens · cost, foot
 *   - expanded (settle it here), by state:
 *       running  → task window · compact agents · latest exchange · goal line · refs ·
 *                  control strip; never the face's numbers, meta, subtitles or artifacts
 *       waiting  → the ask first, then the latest exchange, ≤ 4 artifact tiles, tasks, agents
 *       idle     → the outcome: latest exchange, artifacts, goal line — no task window
 *     agent rows are compact (no tools, no waterfall); the control strip holds the
 *     model · effort switch (folded behind one toggle below 640px), the state
 *     action, Slack and 작업 로그
 *   - panel (understand and steer): 관리 → lands on the goal editor; the head chip
 *     (세션 · status · live time · Stop named 세션 중지; × named 패널 닫기); 세션 정보
 *     (summary line, links in view; opened, every number) that follows a live push
 *     while the reader's goal draft survives; rich agent rows; model · effort beside
 *     the composer (folded below 640px); 전체 task → shows the whole ledger with the
 *     earlier lists; a keyboard opening focuses its landing and Escape returns focus
 *   - documentElement.scrollWidth === innerWidth everywhere; the panel's scroll
 *     area keeps at least half of its body; the chip row stays one line
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-three-surfaces.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'three-surfaces');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CONVERSATION_VIEWER_PORT || '33918';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const NOW = Date.now();
const M = 60_000;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const K = (n: string) => `mock-inst::work:C123:1700000000.000${n}`;

function base(o: Record<string, unknown>) {
  return {
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model: 'claude-opus-5-5[1m]',
    effort: 'high',
    channelId: 'C123',
    sessionState: 'MAIN',
    activeAccumulatedMs: 0,
    compactionCount: 0,
    threadTotalActiveMs: 0,
    threadSessionCount: 1,
    slackThreadUrl: 'https://slack.example/archives/C123/p1700000000000',
    ...o,
  };
}

const USAGE = (tokens: number) => ({
  totalInputTokens: 1_200_000,
  totalOutputTokens: 91_000,
  totalCacheReadTokens: tokens,
  totalCacheCreateTokens: 300_000,
  totalCostUsd: 12.4,
  contextUsagePercent: 31,
});

const AGENTS = [
  {
    id: 'toolu_explore',
    n: 1,
    type: 'Explore',
    description: 'Trace subagent frames through the pipeline',
    status: 'running',
    background: true,
    startedAt: NOW - 6 * M,
    toolCalls: 18,
    tokens: 238_000,
    tasks: [
      {
        id: 'T1',
        content: 'Read the stream processor',
        activeForm: 'Reading the stream processor',
        status: 'in_progress',
        startedAt: NOW - 4 * M,
        toolCalls: 9,
      },
    ],
  },
  {
    id: 'toolu_nested',
    n: 3,
    parentId: 'toolu_explore',
    type: 'general-purpose',
    description: 'Check nested spawn frames',
    status: 'failed',
    startedAt: NOW - 5 * M,
    endedAt: NOW - 4 * M - 19_000,
    toolCalls: 3,
  },
  {
    id: 'toolu_lib',
    n: 2,
    type: 'librarian',
    description: 'Research multi-agent UI prior art',
    status: 'completed',
    startedAt: NOW - 5 * M - 30_000,
    endedAt: NOW - M,
    durationMs: 4 * M + 30_000,
    toolCalls: 31,
    lastTool: 'WebFetch',
  },
];

const ART = (cid: string, i: number, ext: string) => ({
  id: `${cid}-a${i}`,
  name: `surface-${i}.${ext}`,
  kind: ext === 'png' ? 'image' : 'file',
  source: 'slack_file',
  createdAt: NOW - i * M,
  stored: ext !== 'png',
  size: 2048 * (i + 1),
});
const ARTIFACTS: Record<string, unknown[]> = {
  'conv-ask': [1, 2, 3, 4, 5, 6].map((i) => ART('conv-ask', i, i % 2 ? 'html' : 'md')),
  'conv-run': [1, 2].map((i) => ART('conv-run', i, 'html')),
  'conv-done': [1, 2, 3].map((i) => ART('conv-done', i, 'html')),
};
const SUMMARY = (cid: string) => ({ count: ARTIFACTS[cid].length, recent: ARTIFACTS[cid].slice(0, 3) });

function makeBoard() {
  return {
    waiting: [
      base({
        key: K('100'),
        title: 'Ship the surfaces?',
        displayHeadline: 'Ship the three surfaces?',
        activityState: 'waiting',
        conversationId: 'conv-ask',
        lastActivity: iso(M),
        artifacts: SUMMARY('conv-ask'),
        pendingQuestion: {
          type: 'user_choice',
          question: 'Merge the surface split now?',
          choices: [
            { id: '1', label: 'Merge' },
            { id: '2', label: 'Wait for review' },
          ],
        },
        tasks: [{ id: 'T1', content: 'Ask before merging', status: 'in_progress', startedAt: NOW - 2 * M }],
      }),
    ],
    working: [
      base({
        key: K('200'),
        title: 'Dashboard surfaces',
        displayHeadline: 'Dashboard: three surfaces, three jobs',
        activityState: 'working',
        conversationId: 'conv-run',
        lastActivity: iso(0),
        activeLegStartedAtMs: NOW - 7 * M,
        activeAccumulatedMs: 0,
        tokenUsage: USAGE(8_000_000),
        autoCompactTokens: 750_000,
        threadTotalActiveMs: 12 * M,
        compactionCount: 2,
        threadSessionCount: 3,
        mergeStats: { totalLinesAdded: 120, totalLinesDeleted: 30 },
        issueUrl: 'https://github.com/2lab-ai/soma-work/issues/424',
        issueShortRef: '#424',
        issueLabel: '#424',
        issueTitle: 'Three surfaces, three jobs',
        prUrl: 'https://github.com/2lab-ai/soma-work/pull/999',
        prShortRef: 'PR #999',
        prLabel: 'PR #999',
        prTitle: 'Split the surfaces',
        artifacts: SUMMARY('conv-run'),
        agents: AGENTS,
        agentsTotal: 3,
        agentRoot: { toolCalls: 16, lastTool: 'Edit' },
        goal: {
          current: {
            goalId: 'g1',
            objective: 'Give each surface its own job',
            status: 'active',
            continuationCount: 2,
            maxContinuations: 10,
          },
          queue: [{ goalId: 'g2', objective: 'Deploy to dev' }],
          completedCount: 1,
          history: [
            { goalId: 'g0', objective: 'Recursive agent tree', completedAt: NOW - 60 * M, completedVia: 'eval-model' },
          ],
        },
        tasks: [
          {
            id: 'T3',
            content: 'Audit the surfaces',
            status: 'completed',
            startedAt: NOW - 7 * M,
            completedAt: NOW - 6 * M,
            toolCalls: 12,
          },
          {
            id: 'T4',
            content: 'Split the card body',
            status: 'completed',
            startedAt: NOW - 6 * M,
            completedAt: NOW - 4 * M,
            toolCalls: 20,
          },
          {
            id: 'T5',
            content: 'Build the panel head',
            status: 'completed',
            startedAt: NOW - 4 * M,
            completedAt: NOW - 3 * M,
            toolCalls: 9,
          },
          {
            id: 'T6',
            content: 'Wire the live path',
            status: 'completed',
            startedAt: NOW - 3 * M,
            completedAt: NOW - 2 * M,
            toolCalls: 7,
          },
          { id: 'T7', content: 'Write the receipts', status: 'in_progress', startedAt: NOW - 2 * M, toolCalls: 4 },
          { id: 'T8', content: 'Open the PR', status: 'pending' },
        ],
        earlierTasks: [
          { id: 'T1', content: 'Research prior art', status: 'completed', toolCalls: 30 },
          { id: 'T2', content: 'Trinity design review', status: 'completed', toolCalls: 3 },
        ],
      }),
    ],
    idle: [
      base({
        key: K('300'),
        title: 'Recursive tree',
        displayHeadline: 'Recursive agent tree — shipped',
        activityState: 'idle',
        conversationId: 'conv-done',
        lastActivity: iso(30 * M),
        activeAccumulatedMs: 41 * M,
        agents: Array.from({ length: 8 }, (_, i) => ({
          id: `toolu_w${i}`,
          n: i + 1,
          type: 'general-purpose',
          description: `Worker ${i + 1}`,
          status: 'completed',
          startedAt: NOW - 50 * M + i * 1000,
          endedAt: NOW - 40 * M,
          toolCalls: 3 + i,
        })),
        agentsTotal: 8,
        tokenUsage: USAGE(2_000_000),
        artifacts: SUMMARY('conv-done'),
        goal: {
          current: {
            goalId: 'g9',
            objective: 'Main and subagents as one node',
            status: 'complete',
            continuationCount: 4,
            maxContinuations: 10,
          },
          queue: [],
          completedCount: 0,
          history: [],
        },
        tasks: [
          {
            id: 'T1',
            content: 'Ship it',
            status: 'completed',
            startedAt: NOW - 50 * M,
            completedAt: NOW - 31 * M,
            toolCalls: 40,
          },
        ],
      }),
    ],
    closed: [],
  };
}

const E = (seq: number, o: Record<string, unknown>) => ({ seq, ts: NOW - (40 - seq) * 10_000, attributed: true, ...o });
const WORKLOG: Record<string, unknown[]> = {
  'conv-run': [
    E(1, { kind: 'instruction', text: '세 서피스에 각자 다른 일을 맡겨줘' }),
    E(2, {
      kind: 'tool',
      tool: 'Read',
      text: 'Read {"file_path":"dashboard.ts"}',
      taskId: 'T7',
      taskTitle: 'Write the receipts',
    }),
    E(3, {
      kind: 'tool_result',
      tool: 'Read',
      text: 'Read ok',
      ok: true,
      taskId: 'T7',
      taskTitle: 'Write the receipts',
    }),
  ],
  'conv-ask': [E(1, { kind: 'instruction', text: 'merge?' })],
  'conv-done': [E(1, { kind: 'instruction', text: 'ship' }), E(2, { kind: 'final', text: 'shipped' })],
};

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) {',
  '  this.url = url; this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;',
  '  window.__ws = this;',
  '};',
  'window.WebSocket.prototype.close = function () {};',
].join('\n');

let BOARD = makeBoard();
async function installMocks(page: Page) {
  await page.addInitScript({ content: PAGE_HELPERS });
  // tsx keeps function names with an __name() helper inside page.evaluate callbacks.
  await page.addInitScript({ content: 'window.__name = function (f) { return f; };' });
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  await page.route('**/auth/me', (r) => r.fulfill({ json: { user: { name: 'Zhuge' }, csrfToken: 'x' } }));
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: BOARD } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts/, (r) => {
    const conv = decodeURIComponent(new URL(r.request().url()).pathname.split('/')[4] || '');
    return r.fulfill({ json: { artifacts: ARTIFACTS[conv] ?? [] } });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog/, (r) => {
    const conv = decodeURIComponent(new URL(r.request().url()).pathname.split('/')[4] || '');
    const log = WORKLOG[conv];
    if (!log) return r.fulfill({ status: 404, json: { error: 'Not found' } });
    return r.fulfill({ json: { entries: log, hasMore: false } });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    const id = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    return r.fulfill({
      json: {
        id,
        title: id,
        titleSub: 'Three surfaces, three jobs',
        turnCount: 2,
        turns: [
          { id: 't1', role: 'user', timestamp: iso(8 * M), userName: 'Zhuge', rawContent: '세 서피스 개선' },
          {
            id: 't2',
            role: 'assistant',
            timestamp: iso(7 * M),
            summaryTitle: 'Splitting the surfaces',
            summaryBody: 'The card settles, the panel steers.',
            summarized: true,
          },
        ],
        hasMore: false,
      },
    });
  });
}

const failures: string[] = [];
const report: string[] = [];
function log(line: string) {
  report.push(line);
  console.log(line);
}
function check(ok: boolean, what: string) {
  log(`${ok ? '[ok]  ' : '[FAIL]'} ${what}`);
  if (!ok) failures.push(what);
}
async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
async function shootCard(page: Page, key: string, name: string) {
  const box = await page.locator(`[data-session-key="${key}"]`).boundingBox();
  if (box) await page.screenshot({ path: path.join(OUT, name), clip: box, fullPage: true });
}
async function pushSession(page: Page, key: string, edit: (s: Record<string, unknown>) => void) {
  const all = Object.values(BOARD).flat() as Array<Record<string, unknown>>;
  const s = all.find((x) => x.key === key);
  if (!s) throw new Error(`no session ${key}`);
  edit(s);
  await page.evaluate(
    (payload) => {
      // biome-ignore lint/suspicious/noExplicitAny: the stub socket the page opened
      (window as any).__ws.onmessage({ data: payload });
    },
    JSON.stringify({ type: 'sessionUpdated', session: s }),
  );
  await page.waitForTimeout(150);
}
async function expand(page: Page, key: string) {
  await page.locator(`[data-session-key="${key}"] .card-face`).click();
  await page.waitForTimeout(450);
}

/** Order of the body's sections, by document position; -1 = absent. */
const bodyOrder = (page: Page, key: string, sels: string[]) =>
  page.evaluate(
    ({ k, list }) => {
      const body = document.querySelector(`[data-session-key="${k}"] .card-body`);
      if (!body) return list.map(() => -1);
      const all = Array.from(body.querySelectorAll('*'));
      return list.map((sel) => {
        const el = body.querySelector(sel);
        return el ? all.indexOf(el) : -1;
      });
    },
    { k: key, list: sels },
  );
const ascending = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

async function scenario(
  browser: import('playwright').Browser,
  theme: 'light' | 'dark',
  width: number,
  height = 900,
  full = true,
) {
  const narrow = width < 640;
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    hasTouch: narrow || height < 500,
    isMobile: narrow,
  });
  const page = await ctx.newPage();
  BOARD = makeBoard();
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 3, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const tag = `${theme} ${width}×${height}`;

  // ── Face: the shipped triage surface ──
  const face = await page.evaluate((k) => {
    const f = document.querySelector(`[data-session-key="${k}"] .card-face`);
    return {
      task: !!f?.querySelector('.card-task'),
      agents: f?.querySelector('.card-agents')?.textContent ?? '',
      usage: f?.querySelector('.card-usage')?.textContent ?? '',
      status: f?.querySelector('.card-status')?.textContent ?? '',
    };
  }, K('200'));
  check(
    face.task && face.agents.includes('서브에이전트') && face.usage.includes('tok') && face.status.length > 0,
    `${tag}: face — task row, subagent pulse, tokens · cost, status (${face.agents.trim()} | ${face.usage.trim()})`,
  );
  check((await overflow(page)) === 0, `${tag}: board — no page overflow`);
  if (full) await shootCard(page, K('200'), `${theme}-${width}-face-running.png`);
  if (full) await page.screenshot({ path: path.join(OUT, `${theme}-${width}-board.png`), fullPage: false });

  // ── Expanded, running: settle it here ──
  await expand(page, K('200'));
  const run = await page.evaluate((k) => {
    const b = document.querySelector(`[data-session-key="${k}"] .card-body`) as HTMLElement;
    const vis = (sel: string) => {
      const el = b.querySelector(sel) as HTMLElement | null;
      return !!el && el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    };
    return {
      repeats: [
        '.card-tokens',
        '.context-bar',
        '.card-meta',
        '.card-timer-total',
        '.card-subtitle',
        '.card-merge',
      ].filter((sel) => !!b.querySelector(sel)),
      arts: !!b.querySelector('.card-artifacts'),
      rows: Array.from(b.querySelectorAll('.an-row')).map((r) => ({
        compact: r.classList.contains('is-compact'),
        tools: !!r.querySelector('.ag-tools'),
        span: !!r.querySelector('.ag-span'),
      })),
      goal: b.querySelector('.card-goal-line')?.textContent ?? '',
      editor: !!b.querySelector('.cg-add-input'),
      foot: (b.querySelector('.card-foot-bar') as HTMLElement | null)?.innerText ?? '',
      selects: vis('.card-foot-bar .cb-model-select'),
      toggle: vis('.cfb-model-toggle'),
      window: b.querySelectorAll('.tl-item').length,
      all: b.querySelector('.tl-toggle')?.textContent ?? '',
    };
  }, K('200'));
  check(
    run.repeats.length === 0,
    `${tag}: running body repeats none of the face's numbers or the panel's meta (${run.repeats.join(',')})`,
  );
  const runOrder = await bodyOrder(page, K('200'), [
    '.tl-wrap',
    '.ag-tree',
    '.card-io',
    '.card-goal-line',
    '.card-refs',
    '.card-foot-bar',
  ]);
  check(
    ascending(runOrder),
    `${tag}: running body order — tasks → agents → latest exchange → goal → refs → controls (${runOrder.join(',')})`,
  );
  check(!run.arts, `${tag}: running body has no artifact tiles (the face chips suffice)`);
  check(
    run.rows.length === 4 && run.rows.every((r) => r.compact && !r.tools && !r.span),
    `${tag}: agent rows on the card are compact — no tools, no waterfall (${run.rows.length})`,
  );
  check(
    run.goal.includes('Give each surface its own job') && run.goal.includes('관리') && !run.editor,
    `${tag}: the goal is one line pointing at the panel — no editor on the card (${run.goal.trim()})`,
  );
  check(
    run.foot.includes('Stop') && run.foot.includes('Slack') && run.foot.includes('작업 로그'),
    `${tag}: control strip — state action, Slack, 작업 로그 (${run.foot.replace(/\s+/g, ' ').trim()})`,
  );
  check(
    narrow ? run.toggle && !run.selects : run.selects && !run.toggle,
    `${tag}: model · effort switch ${narrow ? 'folded behind one toggle' : 'in the control strip'} (selects ${run.selects}, toggle ${run.toggle})`,
  );
  check(
    run.window === 5 && run.all.includes('전체 task 8개'),
    `${tag}: task window of 5 + 전체 task 8개 → (${run.window}, ${run.all})`,
  );
  check((await overflow(page)) === 0, `${tag}: running card open — no page overflow`);
  if (full) await shootCard(page, K('200'), `${theme}-${width}-expanded-running.png`);

  // ── Expanded, waiting: the ask first, the evidence to answer with ──
  await expand(page, K('100'));
  await page.waitForTimeout(300);
  const askOrder = await bodyOrder(page, K('100'), ['.card-question', '.card-io', '.card-artifacts', '.tl-wrap']);
  const ask = await page.evaluate((k) => {
    const b = document.querySelector(`[data-session-key="${k}"] .card-body`) as HTMLElement;
    return {
      tiles: b.querySelectorAll('.art-tile').length,
      more: b.querySelector('.card-more-link')?.textContent ?? '',
    };
  }, K('100'));
  check(
    ascending(askOrder),
    `${tag}: waiting body — the ask → latest exchange → artifacts → tasks (${askOrder.join(',')})`,
  );
  check(
    ask.tiles === 4 && ask.more.includes('전체 6개'),
    `${tag}: ≤ 4 artifact tiles + 전체 6개 → (${ask.tiles}, ${ask.more})`,
  );
  if (full) await shootCard(page, K('100'), `${theme}-${width}-expanded-waiting.png`);

  // ── Expanded, idle: the outcome ──
  await expand(page, K('300'));
  const doneOrder = await bodyOrder(page, K('300'), [
    '.card-io',
    '.card-artifacts',
    '.card-goal-line',
    '.card-foot-bar',
  ]);
  const done = await page.evaluate((k) => {
    const b = document.querySelector(`[data-session-key="${k}"] .card-body`) as HTMLElement;
    return {
      window: !!b.querySelector('.tl-wrap'),
      foot: (b.querySelector('.card-foot-bar') as HTMLElement).innerText,
    };
  }, K('300'));
  check(
    ascending(doneOrder) && !done.window,
    `${tag}: idle body — latest exchange → artifacts → goal; no task window (${doneOrder.join(',')})`,
  );
  check(
    done.foot.includes('Close') && !done.foot.includes('Stop'),
    `${tag}: idle control strip offers Close, not Stop`,
  );
  if (full) await shootCard(page, K('300'), `${theme}-${width}-expanded-idle.png`);
  check((await overflow(page)) === 0, `${tag}: three open cards — no page overflow`);

  // ── Panel: 관리 → lands on the goal editor ──
  await page.locator(`[data-session-key="${K('200')}"] .cgl-go`).click();
  await page.waitForSelector('#slide-panel.open', { timeout: 5000 });
  await page.waitForTimeout(700);
  const land = await page.evaluate(() => {
    const sc = document.getElementById('panel-scroll') as HTMLElement;
    const goal = document.getElementById('panel-goal') as HTMLElement;
    return {
      offset: Math.round(goal.getBoundingClientRect().top - sc.getBoundingClientRect().top),
      editor: !!goal.querySelector('.cg-add-input'),
      history: goal.querySelector('.cg-history-toggle')?.textContent ?? '',
      queue: goal.textContent?.includes('Deploy to dev') ?? false,
    };
  });
  check(
    Math.abs(land.offset) <= 4,
    `${tag}: 관리 → lands with the goal at the top of the scroll area (${land.offset}px)`,
  );
  check(
    land.editor && land.history.includes('완료된 goal 1개') && land.queue,
    `${tag}: the panel goal is the full editor — queue, add, completed goals`,
  );

  const head = await page.evaluate(() => {
    const st = document.getElementById('panel-status') as HTMLElement;
    const row = st.querySelector('.ps-row') as HTMLElement;
    return {
      chip: st.querySelector('.ps-chip')?.textContent ?? '',
      time: (st.querySelector('.ps-time') as HTMLElement | null)?.innerText ?? '',
      action: st.querySelector('.ps-actions .btn-action')?.getAttribute('aria-label') ?? '',
      slack: !!st.querySelector('.ps-slack'),
      close: document.querySelector('.panel-close')?.getAttribute('aria-label') ?? '',
      rowH: Math.round(row.getBoundingClientRect().height),
      live: st.querySelector('[role="status"]')?.textContent ?? '',
    };
  });
  check(
    head.chip.includes('세션') && head.chip.includes('실행 중') && /\d/.test(head.time) && head.live === '실행 중',
    `${tag}: head chip — 세션 · 실행 중 (announced alone) · live time (${head.chip} ${head.time})`,
  );
  check(
    head.action === 'Stop — 세션 중지' && head.close === '패널 닫기' && head.slack,
    `${tag}: the session's one action is named "Stop — 세션 중지" (label first), × is 패널 닫기, Slack in the chip row`,
  );
  check(head.rowH <= 52, `${tag}: the chip row stays one line (${head.rowH}px)`);

  const info = async () =>
    page.evaluate(() => {
      const el = document.getElementById('panel-info') as HTMLElement;
      return {
        sum: el.querySelector('.pi-sum')?.textContent ?? '',
        expanded: el.querySelector('.pi-head')?.getAttribute('aria-expanded'),
        links: (el.querySelector('.pi-links') as HTMLElement | null)?.innerText ?? '',
        body: (el.querySelector('.pi-body') as HTMLElement | null)?.innerText ?? '',
      };
    });
  const i0 = await info();
  check(
    ['Zhuge', 'zwork', 'tok', '$12.40', 'ctx 31%'].every((w) => i0.sum.includes(w)) && i0.expanded === 'false',
    `${tag}: 세션 정보 — one summary line, collapsed (${i0.sum})`,
  );
  check(
    i0.links.includes('#424') && i0.links.includes('PR #999') && i0.links.includes('전체 대화'),
    `${tag}: the links stay in view (${i0.links.replace(/\s+/g, ' ')})`,
  );
  await page.locator('#panel-info .pi-head').click();
  await page.waitForTimeout(200);
  const i1 = await info();
  const bar = await page.evaluate(() => {
    const b = document.querySelector('#panel-info .pi-ctx .context-bar') as HTMLElement | null;
    const f = document.querySelector('#panel-info .pi-ctx .context-bar-fill') as HTMLElement | null;
    return {
      h: b ? Math.round(b.getBoundingClientRect().height) : 0,
      w: f ? Math.round(f.getBoundingClientRect().width) : 0,
    };
  });
  check(bar.h >= 3 && bar.w > 0, `${tag}: the context bar is drawn in 세션 정보 (${bar.h}px tall, fill ${bar.w}px)`);
  check(
    ['입력', '출력', '캐시 읽기', '캐시 쓰기', 'autocompact', '압축 2', '세션 3', '+120 / -30'].every((w) =>
      i1.body.includes(w),
    ),
    `${tag}: opened — every token kind, cost, context + autocompact, Σ · 압축 · 세션, merge`,
  );
  // Live: a push moves the numbers; the open disclosure and the reader's goal draft stay.
  await page.locator('#panel-goal .cg-add-input').fill('draft goal');
  await page.locator('#panel-info .pi-head').focus();
  await pushSession(page, K('200'), (s) => {
    s.tokenUsage = USAGE(9_000_000);
  });
  const i2 = await info();
  const draft = await page.inputValue('#panel-goal .cg-add-input');
  check(
    i2.sum !== i0.sum && i2.expanded === 'true',
    `${tag}: a live push moves 세션 정보 and keeps it open (${i0.sum} → ${i2.sum})`,
  );
  check(draft === 'draft goal', `${tag}: the reader's goal draft survives the live push (${draft})`);
  if (full) await page.screenshot({ path: path.join(OUT, `${theme}-${width}-panel-goal.png`) });

  // Rich agent rows in the panel.
  const rich = await page.evaluate(() => ({
    tools: document.querySelectorAll('#panel-agents .ag-tools').length,
    spans: document.querySelectorAll('#panel-agents .ag-span').length,
    compact: document.querySelectorAll('#panel-agents .an-row.is-compact').length,
  }));
  check(
    rich.tools >= 3 && rich.spans >= 3 && rich.compact === 0,
    `${tag}: panel agent rows are rich — tools ${rich.tools}, waterfall ${rich.spans}`,
  );

  // Model · effort beside the composer.
  const ctl = async () =>
    page.evaluate(() => {
      const c = document.getElementById('panel-controls') as HTMLElement;
      const vis = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null;
      return {
        inComposer: !!c.closest('.panel-command'),
        selects: vis(c.querySelector('.cb-model-select')),
        toggle: vis(c.querySelector('.pc-toggle')),
      };
    });
  const c0 = await ctl();
  // Folded on a narrow or a short screen (a phone with its keyboard up, or sideways).
  const folded = narrow || height <= 560;
  check(c0.inComposer, `${tag}: model · effort live beside the composer`);
  check(
    folded ? c0.toggle && !c0.selects : c0.selects && !c0.toggle,
    `${tag}: composer switch ${folded ? 'folded' : 'open'} (selects ${c0.selects})`,
  );
  const budgetOf = () =>
    page.evaluate(() => {
      const body = (document.getElementById('panel-body') as HTMLElement).getBoundingClientRect().height;
      const sc = (document.getElementById('panel-scroll') as HTMLElement).getBoundingClientRect().height;
      return { body: Math.round(body), scroll: Math.round(sc) };
    });
  const folded0 = await budgetOf();
  if (folded) {
    // Folded, the toggle shares the input's line: the reading area keeps its room.
    const sameLine = await page.evaluate(() => {
      const t = (document.querySelector('#panel-controls .pc-toggle') as HTMLElement).getBoundingClientRect();
      const i = (document.getElementById('cmd-input') as HTMLElement).getBoundingClientRect();
      return Math.abs(t.top + t.height / 2 - (i.top + i.height / 2)) < 12;
    });
    check(sameLine, `${tag}: the folded toggle sits on the input's line`);
    await page.locator('#panel-controls .pc-toggle').click();
    await page.waitForTimeout(150);
    check((await ctl()).selects, `${tag}: the toggle unfolds model · effort`);
    const unfolded = await budgetOf();
    check(
      unfolded.scroll === folded0.scroll && unfolded.body === folded0.body,
      `${tag}: unfolded, model · effort float over the composer — the reading area keeps its height (${folded0.scroll} → ${unfolded.scroll})`,
    );
  }

  // Layout budget: the panel body stays usable (≥ 176px, spec 10 §3.1-6) and the
  // scroll area keeps at least half of it — floors that cannot go negative.
  const budget = await budgetOf();
  check(
    budget.body >= 176 && budget.scroll >= Math.ceil(budget.body / 2) - 1 && budget.scroll >= 88,
    `${tag}: the panel body ≥ 176px and its scroll area ≥ half of it (${budget.scroll}/${budget.body})`,
  );
  check((await overflow(page)) === 0, `${tag}: panel — no page overflow`);
  if (full || height < 600) await page.screenshot({ path: path.join(OUT, `${theme}-${width}x${height}-panel.png`) });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 전체 task → the whole ledger, earlier lists included.
  await page.locator(`[data-session-key="${K('200')}"] .tl-toggle`).click();
  await page.waitForSelector('#slide-panel.open', { timeout: 5000 });
  await page.waitForTimeout(300);
  const ledger = await page.evaluate(() => {
    const t = document.getElementById('panel-tasks') as HTMLElement;
    return { text: t.innerText, items: t.querySelectorAll('.panel-task-item').length };
  });
  check(
    ledger.text.includes('Research prior art') &&
      ledger.text.includes('Audit the surfaces') &&
      ledger.text.includes('이전 task 2개'),
    `${tag}: 전체 task → opens every task and the earlier lists in the panel`,
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // A keyboard 전체 task → focuses the Tasks box, opened at its head.
  await page.locator(`[data-session-key="${K('200')}"] .tl-toggle`).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#slide-panel.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const tasksLand = await page.evaluate(() => ({
    focus: document.activeElement?.id ?? '',
    top: (document.getElementById('panel-tasks') as HTMLElement).scrollTop,
  }));
  check(
    tasksLand.focus === 'panel-tasks' && tasksLand.top === 0,
    `${tag}: keyboard 전체 task → focuses the Tasks box at its head (${JSON.stringify(tasksLand)})`,
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // The idle card's tree: 6 of 8 workers, the rest is 전체 8개 → 상세 — the panel on that parent.
  const allItem = page.locator(`[data-session-key="${K('300')}"] .an-all`);
  const allText = (await allItem.textContent()) ?? '';
  await allItem.click();
  await page.waitForSelector('#slide-panel.open', { timeout: 5000 });
  await page.waitForTimeout(600);
  const agentLand = await page.evaluate(() => {
    const sc = document.getElementById('panel-scroll') as HTMLElement;
    const ag = document.getElementById('panel-agents') as HTMLElement;
    return {
      offset: Math.round(ag.getBoundingClientRect().top - sc.getBoundingClientRect().top),
      rows: ag.querySelectorAll('.pa-tree .an[role="treeitem"]').length,
    };
  });
  check(
    allText.includes('전체 8개') && Math.abs(agentLand.offset) <= 4 && agentLand.rows === 8,
    `${tag}: 전체 8개 → 상세 opens the panel on that parent — agents at the top, all 8 (${allText} | ${JSON.stringify(agentLand)})`,
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // A keyboard opening focuses its landing; Escape hands focus back to the opener.
  await page.locator(`[data-session-key="${K('200')}"] .card-foot-bar .btn-primary`).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#slide-panel.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const inPanel = await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.className ?? '');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => document.activeElement?.textContent ?? '');
  check(
    inPanel === 'worklog-toggle' && back === '작업 로그',
    `${tag}: keyboard 작업 로그 → focus on the work log head; Escape → back on 작업 로그 (${inPanel} / ${back})`,
  );

  await ctx.close();
}

async function main() {
  const dashboard = await import('../src/conversation/dashboard');
  dashboard.setDashboardSessionAccessor(() => new Map());
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [1280, 820, 390]) await scenario(browser, theme, width);
    }
    await scenario(browser, 'light', 390, 520, false); // a phone with its keyboard up
    await scenario(browser, 'light', 844, 390, false); // a phone held sideways
  } finally {
    await browser.close();
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
