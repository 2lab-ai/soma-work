/**
 * Agent tree — browser receipts and assertions (.prd/12 §4).
 *
 * The real web server serves the real dashboard page; the browser-side HTTP
 * layer is mocked (board JSON, turns, work log) and the WebSocket is a stub,
 * so every scenario is deterministic.
 *
 * Asserts (exit 1 on any failure), and writes screenshots, for
 * 1280 / 820 / 390 × light / dark:
 *   - the collapsed card names its subagents in words (서브에이전트 N · 실행 r · 실패 f)
 *   - the open card shows 메인 then its subagents, nested agents indented,
 *     each with a status word and a waterfall bar
 *   - a subagent row opens the panel on that agent: path 메인 › A1 Explore,
 *     Tasks = that agent's, the work log = its own entries + 지시 / 결과
 *   - the agent list opens vertically; choosing 메인 shows only main entries
 *     and a spawn row's 서브에이전트 열기 → switches back to the subagent
 *   - a card without subagents shows no agents row
 *   - documentElement.scrollWidth === innerWidth everywhere; < 640px agent
 *     rows and the agent bar's buttons are ≥ 44px tall
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-agent-tree.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'agent-tree');
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
    channelId: 'C123',
    sessionState: 'MAIN',
    activeAccumulatedMs: 0,
    compactionCount: 0,
    threadTotalActiveMs: 0,
    threadSessionCount: 1,
    effort: 'high',
    ...o,
  };
}

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
        content: 'Read the mapper',
        status: 'completed',
        startedAt: NOW - 6 * M,
        completedAt: NOW - 4 * M,
        toolCalls: 9,
      },
      {
        id: 'T2',
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
    background: true,
    startedAt: NOW - 5 * M - 30_000,
    endedAt: NOW - M,
    durationMs: 4 * M + 30_000,
    toolCalls: 31,
    lastTool: 'WebFetch',
  },
  {
    id: 'toolu_review',
    n: 4,
    type: 'code-reviewer',
    description: 'Review the diff',
    status: 'running',
    startedAt: NOW - 2 * M,
    toolCalls: 6,
    summary: 'Reading stream-processor.ts',
  },
];

function makeBoard() {
  return {
    waiting: [
      base({
        key: K('100'),
        title: 'Plain session',
        displayHeadline: 'Plain session without subagents',
        activityState: 'waiting',
        conversationId: 'conv-plain',
        lastActivity: iso(M),
        tasks: [
          { id: 'T1', content: 'Answer the question', status: 'in_progress', startedAt: NOW - 2 * M, toolCalls: 1 },
        ],
      }),
    ],
    working: [
      base({
        key: K('200'),
        title: 'Dashboard agent tree',
        displayHeadline: 'Dashboard: main agent → subagents',
        summaryTitle: 'Dashboard: main agent → subagents',
        activityState: 'working',
        conversationId: 'conv-agents',
        lastActivity: iso(0),
        activeLegStartedAtMs: NOW - 7 * M,
        tokenUsage: {
          totalInputTokens: 1_200_000,
          totalOutputTokens: 91_000,
          totalCacheReadTokens: 8_000_000,
          totalCacheCreateTokens: 300_000,
          totalCostUsd: 12.4,
          contextUsagePercent: 31,
        },
        tasks: [
          {
            id: 'T1',
            content: 'Diagnose the mixing',
            status: 'completed',
            startedAt: NOW - 7 * M,
            completedAt: NOW - 6 * M,
            toolCalls: 12,
          },
          {
            id: 'T2',
            content: 'Fan out research',
            activeForm: 'Fanning out research',
            status: 'in_progress',
            startedAt: NOW - 6 * M,
            toolCalls: 4,
          },
          { id: 'T3', content: 'Design the tree', status: 'pending', toolCalls: 0 },
        ],
        agents: AGENTS,
        agentsTotal: 4,
      }),
    ],
    idle: [],
    closed: [],
  };
}

const E = (seq: number, o: Record<string, unknown>) => ({ seq, ts: NOW - (40 - seq) * 10_000, attributed: true, ...o });
const WORKLOG: Record<string, unknown[]> = {
  'conv-agents': [
    E(1, { kind: 'instruction', text: '대시보드 개선 — 메인과 서브에이전트를 나눠서 보여줘' }),
    E(2, {
      kind: 'narration',
      text: 'Tracing where the subagent frames go.',
      taskId: 'T1',
      taskTitle: 'Diagnose the mixing',
    }),
    E(3, {
      kind: 'tool',
      tool: 'Grep',
      text: 'Grep {"pattern":"parent_tool_use_id"}',
      taskId: 'T1',
      taskTitle: 'Diagnose the mixing',
    }),
    E(4, {
      kind: 'tool_result',
      tool: 'Grep',
      text: 'Grep ok',
      ok: true,
      taskId: 'T1',
      taskTitle: 'Diagnose the mixing',
    }),
    E(5, {
      kind: 'tool',
      tool: 'Agent',
      text: 'Agent {"description":"Trace subagent frames"}',
      agentRef: 'toolu_explore',
      taskId: 'T2',
      taskTitle: 'Fan out research',
    }),
    E(6, {
      kind: 'tool_result',
      tool: 'Agent',
      text: 'Agent ok',
      ok: true,
      agentRef: 'toolu_explore',
      taskId: 'T2',
      taskTitle: 'Fan out research',
    }),
    E(7, {
      kind: 'tool',
      tool: 'Read',
      text: 'Read {"file_path":"sdk-message-to-event.ts"}',
      agentId: 'toolu_explore',
      taskId: 'T1',
      taskTitle: 'Read the mapper',
    }),
    E(8, {
      kind: 'tool_result',
      tool: 'Read',
      text: 'Read ok',
      ok: true,
      agentId: 'toolu_explore',
      taskId: 'T1',
      taskTitle: 'Read the mapper',
    }),
    E(9, {
      kind: 'tool',
      tool: 'Agent',
      text: 'Agent {"description":"Check nested spawn frames"}',
      agentId: 'toolu_explore',
      agentRef: 'toolu_nested',
      taskId: 'T1',
      taskTitle: 'Read the mapper',
    }),
    E(10, { kind: 'tool', tool: 'Bash', text: 'Bash {"command":"ls"}', agentId: 'toolu_nested' }),
    E(11, { kind: 'tool_result', tool: 'Bash', text: 'Bash error', ok: false, agentId: 'toolu_nested' }),
    E(12, {
      kind: 'tool_result',
      tool: 'Agent',
      text: 'Agent error',
      ok: false,
      agentId: 'toolu_explore',
      agentRef: 'toolu_nested',
      taskId: 'T1',
    }),
    E(13, {
      kind: 'tool',
      tool: 'Grep',
      text: 'Grep {"pattern":"TodoWrite"}',
      agentId: 'toolu_explore',
      taskId: 'T2',
      taskTitle: 'Read the stream processor',
    }),
    E(14, {
      kind: 'tool',
      tool: 'Agent',
      text: 'Agent {"description":"Research multi-agent UI prior art"}',
      agentRef: 'toolu_lib',
      taskId: 'T2',
      taskTitle: 'Fan out research',
    }),
    E(15, { kind: 'tool_result', tool: 'Agent', text: 'Agent ok', ok: true, agentRef: 'toolu_lib', taskId: 'T2' }),
    E(16, {
      kind: 'tool',
      tool: 'WebFetch',
      text: 'WebFetch {"url":"https://code.claude.com/docs"}',
      agentId: 'toolu_lib',
    }),
    E(17, {
      kind: 'tool',
      tool: 'Agent',
      text: 'Agent {"description":"Review the diff"}',
      agentRef: 'toolu_review',
      taskId: 'T2',
      taskTitle: 'Fan out research',
    }),
    E(18, { kind: 'tool', tool: 'Read', text: 'Read {"file_path":"stream-processor.ts"}', agentId: 'toolu_review' }),
    E(19, { kind: 'narration', text: 'Waiting for the research agents.', taskId: 'T2', taskTitle: 'Fan out research' }),
  ],
  'conv-plain': [E(1, { kind: 'instruction', text: 'hello' }), E(2, { kind: 'final', text: 'hi' })],
};

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) {',
  '  this.url = url; this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;',
  '  window.__ws = this;',
  '};',
  'window.WebSocket.prototype.close = function () {};',
].join('\n');

async function installMocks(page: Page) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  await page.route('**/auth/me', (r) => r.fulfill({ json: { user: { name: 'Zhuge' }, csrfToken: 'x' } }));
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: makeBoard() } }));
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
        turnCount: 2,
        turns: [
          { id: 't1', role: 'user', timestamp: iso(8 * M), userName: 'Zhuge', rawContent: '대시보드 개선' },
          {
            id: 't2',
            role: 'assistant',
            timestamp: iso(7 * M),
            summaryTitle: 'Working',
            summaryBody: 'On it.',
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
async function shoot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: path.join(OUT, name), fullPage });
}
// The entries of the scope the panel shows (closed task groups hold no nodes,
// so the scope is read from the page's own scope function, as it renders it).
const visibleSeqs = (page: Page) =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: page globals are untyped client code
    const w = window as any;
    return (w.wlScopeEntries(w._wl.entries) as Array<{ seq: number }>).map((e) => e.seq);
  });

// Spec 12 §4.4 — push a sessionUpdated over the stubbed socket: the session as
// the page holds it, with one agent's tool count raised and the last activity
// moved (both optional; no edit = the same payload again).
interface SessionEdit {
  agent?: string;
  tools?: number;
  shiftMs?: number;
}
// The page's own session cache (a top-level `let` of the dashboard script).
declare const _sessionCache: Record<
  string,
  { agents?: Array<{ id: string; toolCalls: number }>; lastActivity: string }
>;
async function pushSession(page: Page, key: string, edit: SessionEdit = {}) {
  await page.evaluate(
    ({ k, e }) => {
      const s = JSON.parse(JSON.stringify(_sessionCache[k]));
      for (const a of s.agents ?? []) if (a.id === e.agent) a.toolCalls += e.tools ?? 0;
      if (e.shiftMs) s.lastActivity = new Date(Date.parse(s.lastActivity) + e.shiftMs).toISOString();
      // biome-ignore lint/suspicious/noExplicitAny: the stub socket the page opened
      (window as any).__ws.onmessage({ data: JSON.stringify({ type: 'sessionUpdated', session: s }) });
    },
    { k: key, e: edit },
  );
  await page.waitForTimeout(120);
}

async function scenario(browser: import('playwright').Browser, theme: 'light' | 'dark', width: number) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    hasTouch: width < 640,
    isMobile: width < 640,
  });
  const page = await ctx.newPage();
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 2, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const tag = `${theme} ${width}`;

  // §4.1 collapsed face.
  const face = await page.evaluate((key) => {
    const card = document.querySelector(`[data-session-key="${key}"]`);
    return card?.querySelector('.card-agents')?.textContent ?? '';
  }, K('200'));
  check(
    face.includes('서브에이전트 4') && face.includes('실행 2') && face.includes('실패 1'),
    `${tag}: collapsed card says "${face.trim()}"`,
  );
  const plain = await page.evaluate(
    (key) => !!document.querySelector(`[data-session-key="${key}"] .card-agents`),
    K('100'),
  );
  check(!plain, `${tag}: a card without subagents has no agents row`);
  check((await overflow(page)) === 0, `${tag}: board — no page overflow`);
  await shoot(page, `${theme}-${width}-board.png`);

  // §4.2 open card tree.
  await page.click(`[data-session-key="${K('200')}"] .card-face`);
  await page.waitForTimeout(500);
  const tree = await page.evaluate((key) => {
    const rows = Array.from(document.querySelectorAll(`[data-session-key="${key}"] .ag-row`));
    return rows.map((r) => ({
      main: r.classList.contains('is-main'),
      depth: getComputedStyle(r).getPropertyValue('--ag-depth').trim(),
      st: r.querySelector('.ag-st')?.textContent ?? '',
      span: !!r.querySelector('.ag-span i'),
      h: Math.round(r.getBoundingClientRect().height),
    }));
  }, K('200'));
  check(tree.length === 5 && tree[0].main, `${tag}: open card shows 메인 + 4 subagents (${tree.length} rows)`);
  check(tree[2]?.depth === '2', `${tag}: the nested agent is indented one level deeper (depth ${tree[2]?.depth})`);
  check(
    tree.slice(1).every((r) => r.st && r.span),
    `${tag}: every subagent row has a status word and a waterfall bar (${tree.map((r) => r.st).join(' / ')})`,
  );
  if (width < 640)
    check(
      tree.every((r) => r.h >= 44),
      `${tag}: agent rows ≥ 44px (${tree.map((r) => r.h).join(',')})`,
    );
  check((await overflow(page)) === 0, `${tag}: open card — no page overflow`);
  await shoot(page, `${theme}-${width}-card-tree.png`);
  // §4.4 live: a running subagent's tool count and the waterfall move; the row
  // the reader focused, its spinner and its bar are the same nodes after.
  await page.evaluate((key) => {
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    const row = document.querySelector(`[data-session-key="${key}"] .ag-row[data-agent-open="toolu_explore"]`) as any;
    row.focus();
    row.__mark = 1;
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    (row.querySelector('.ag-spinner') as any).__mark = 1;
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    (row.querySelector('.ag-span i') as any).__mark = 1;
  }, K('200'));
  await pushSession(page, K('200'), { agent: 'toolu_explore', tools: 1, shiftMs: 60_000 });
  const liveCard = await page.evaluate((key) => {
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    const row = document.querySelector(`[data-session-key="${key}"] .ag-row[data-agent-open="toolu_explore"]`) as any;
    return {
      sameRow: row?.__mark === 1,
      focused: document.activeElement === row,
      // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
      spinner: (row?.querySelector('.ag-spinner') as any)?.__mark === 1,
      // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
      bar: (row?.querySelector('.ag-span i') as any)?.__mark === 1,
      tools: row?.querySelector('.ag-tools')?.textContent ?? '',
    };
  }, K('200'));
  check(
    liveCard.sameRow && liveCard.focused && liveCard.spinner && liveCard.bar && liveCard.tools === '툴 19',
    `${tag}: live card update keeps the focused row, its spinner and bar (${JSON.stringify(liveCard)})`,
  );
  const cardBox = await page.locator(`[data-session-key="${K('200')}"]`).boundingBox();
  if (cardBox) await page.screenshot({ path: path.join(OUT, `${theme}-${width}-card-tree-crop.png`), clip: cardBox });

  // §4.3 a subagent row opens the panel on that agent.
  await page.click(`[data-session-key="${K('200')}"] .ag-row.is-sub >> nth=0`);
  await page.waitForSelector('#slide-panel.open', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#worklog-list .wl-entry').length > 0, null, {
    timeout: 8000,
  });
  await page.click('#worklog-toggle');
  await page.waitForTimeout(350);
  const bar = await page.evaluate(() => ({
    path: Array.from(document.querySelectorAll('#panel-agents .pa-crumb')).map((b) => b.textContent),
    tasks: document.querySelector('#panel-tasks .panel-tasks-header')?.textContent ?? '',
    count: document.getElementById('worklog-count')?.textContent ?? '',
    roles: Array.from(document.querySelectorAll('#worklog-list .wl-role')).map((r) => r.textContent),
    heights: Array.from(document.querySelectorAll('#panel-agents .pa-crumb, #panel-agents .pa-toggle')).map((b) =>
      Math.round(b.getBoundingClientRect().height),
    ),
  }));
  check(bar.path.join(' › ') === '메인 › A1 Explore', `${tag}: panel path ${bar.path.join(' › ')}`);
  check(bar.tasks.includes('A1 Explore'), `${tag}: Tasks are the subagent's (${bar.tasks.trim()})`);
  const subSeqs = await visibleSeqs(page);
  check(
    JSON.stringify(subSeqs) === JSON.stringify([5, 6, 7, 8, 9, 12, 13]),
    `${tag}: subagent log = its entries + 지시/결과 (${subSeqs.join(',')})`,
  );
  check(
    bar.roles.includes('지시') && bar.roles.includes('배경 실행 시작'),
    `${tag}: spawn / ack rows labelled (${bar.roles.join(',')})`,
  );
  if (width < 640)
    check(
      bar.heights.every((h) => h >= 44),
      `${tag}: agent bar buttons ≥ 44px (${bar.heights.join(',')})`,
    );
  check((await overflow(page)) === 0, `${tag}: panel on a subagent — no page overflow`);
  await shoot(page, `${theme}-${width}-panel-subagent.png`, false);
  // §4.4 live, panel: a task-group head and the 메인 crumb keep focus through
  // session pushes (the same payload, then a changed tool count).
  const headLive = await (async () => {
    await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
      const head = document.querySelector('#worklog-list .wl-group-head') as any;
      head.focus();
      head.__mark = 1;
    });
    await pushSession(page, K('200'));
    await pushSession(page, K('200'), { agent: 'toolu_explore', tools: 1 });
    return page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
      const a = document.activeElement as any;
      return { focusedHead: !!a?.classList.contains('wl-group-head') && a.__mark === 1, tag: a?.tagName };
    });
  })();
  check(
    headLive.focusedHead,
    `${tag}: a focused task-group head keeps focus through session pushes (${JSON.stringify(headLive)})`,
  );
  const crumbLive = await (async () => {
    await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
      const crumb = document.querySelector('#panel-agents .pa-crumb[data-agent-select=""]') as any;
      crumb.focus();
      crumb.__mark = 1;
    });
    await pushSession(page, K('200'), { agent: 'toolu_explore', tools: 1 });
    return page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
      const a = document.activeElement as any;
      return {
        focusedCrumb: a?.__mark === 1 && a.getAttribute('data-agent-select') === '',
        sum: document.querySelector('#panel-agents .pa-sum')?.textContent ?? '',
      };
    });
  })();
  check(
    crumbLive.focusedCrumb && crumbLive.sum.includes('툴 21'),
    `${tag}: the focused 메인 crumb keeps focus while the summary moves (${JSON.stringify(crumbLive)})`,
  );

  // The agent list, then back to main.
  await page.click('#pa-toggle');
  await page.waitForTimeout(250);
  const listRows = await page.evaluate(() => document.querySelectorAll('#pa-list .ag-row').length);
  check(listRows === 5, `${tag}: agent list shows 메인 + 4 (${listRows})`);
  await shoot(page, `${theme}-${width}-panel-agent-list.png`, false);
  await page.click('#pa-list .ag-row.is-main');
  await page.waitForTimeout(250);
  const mainSeqs = await visibleSeqs(page);
  check(
    JSON.stringify(mainSeqs) === JSON.stringify([1, 2, 3, 4, 5, 6, 14, 15, 17, 19]),
    `${tag}: main log has no subagent entries (${mainSeqs.join(',')})`,
  );
  const links = await page.evaluate(() => document.querySelectorAll('#worklog-list .wl-agent-link').length);
  check(links === 3, `${tag}: each spawn row in the main log links to its subagent (${links})`);
  // Keyboard: ArrowDown from a spawn row lands on its 서브에이전트 열기, Enter opens that agent.
  await page.evaluate(() => {
    const link = document.querySelectorAll('#worklog-list .wl-agent-link')[0];
    (link.parentElement?.querySelector('.wl-row') as HTMLElement).focus();
  });
  await page.keyboard.press('ArrowDown');
  const onLink = await page.evaluate(() => document.activeElement?.classList.contains('wl-agent-link') ?? false);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const kbPath = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#panel-agents .pa-crumb'))
      .map((b) => b.textContent)
      .join(' › '),
  );
  const kbFocus = await page.evaluate(() => {
    const a = document.activeElement;
    return a?.classList.contains('pa-crumb') && a.getAttribute('aria-current') === 'true'
      ? a.textContent
      : (a?.tagName ?? '');
  });
  check(kbFocus === 'A1 Explore', `${tag}: after the keyboard switch focus is on the shown agent's crumb (${kbFocus})`);
  check(
    onLink && kbPath === '메인 › A1 Explore',
    `${tag}: keyboard ↓ + Enter on 서브에이전트 열기 opens it (${onLink}, ${kbPath})`,
  );
  await page.click('#panel-agents .pa-crumb[data-agent-select=""]');
  await page.waitForTimeout(250);
  await page.click('#worklog-list .wl-agent-link >> nth=1');
  await page.waitForTimeout(250);
  const libPath = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#panel-agents .pa-crumb'))
      .map((b) => b.textContent)
      .join(' › '),
  );
  check(libPath === '메인 › A2 librarian', `${tag}: 서브에이전트 열기 → switches to it (${libPath})`);
  await shoot(page, `${theme}-${width}-panel-librarian.png`, false);
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
