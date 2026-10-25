/**
 * Agent tree — browser receipts and assertions (.prd/12 §4, rev 2: one node
 * type, rendered recursively — the main agent is the root).
 *
 * The real web server serves the real dashboard page; the browser-side HTTP
 * layer is mocked (board JSON, turns, work log) and the WebSocket is a stub,
 * so every scenario is deterministic.
 *
 * Asserts (exit 1 on any failure), and writes screenshots, for
 * 1280 / 820 / 390 × light / dark:
 *   - the collapsed card names its subagents in words (서브에이전트 N · 실행 r · 실패 f)
 *   - the open card is one ARIA tree: the root (메인) and every subagent are the
 *     same item with the same row slots (status word, time, tools), nested in
 *     groups by level; a deeper parent starts folded with +N, its chevron
 *     unfolds it; the tree keys (↓ → ← Enter) move, fold and activate
 *   - an item opens the panel on that node: path 메인 › A1 Explore, its header,
 *     its subtree (levels relative to it), Tasks = its own, the work log = its
 *     own entries + 지시 / 결과; the root's header carries the same slots
 *   - in a parent's log each spawn row carries the child's live block; ↓ +
 *     Enter on it, or a click, drills into that child
 *   - live pushes keep the focused tree item, its spinner and bar, a focused
 *     task-group head, a focused crumb and a child block (same nodes)
 *   - a card without subagents shows no agents row
 *   - documentElement.scrollWidth === innerWidth everywhere; < 640px tree rows
 *     and crumbs are ≥ 44px tall and the path shrinks to ‹ parent › here
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
    id: 'toolu_deep',
    n: 5,
    parentId: 'toolu_nested',
    type: 'Plan',
    description: 'Sketch the nested frame fix',
    status: 'completed',
    startedAt: NOW - 5 * M + 10_000,
    endedAt: NOW - 4 * M - 40_000,
    toolCalls: 2,
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
        // A copy per board: live pushes edit the board, never the fixture.
        agents: structuredClone(AGENTS),
        agentsTotal: 5,
        agentRoot: { toolCalls: 16, lastTool: 'Agent' },
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
    E(20, {
      kind: 'tool',
      tool: 'Agent',
      text: 'Agent {"description":"Sketch the nested frame fix"}',
      agentId: 'toolu_nested',
      agentRef: 'toolu_deep',
    }),
    E(21, { kind: 'tool', tool: 'Read', text: 'Read {"file_path":"agent-tree.ts"}', agentId: 'toolu_deep' }),
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
  // The board the server would serve now — live pushes edit it too, so a board
  // reload in the middle of a scenario never rolls a pushed tool count back.
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: BOARD } }));
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
// The server-side board of the running scenario (reset per scenario).
let BOARD = makeBoard();
async function pushSession(page: Page, key: string, edit: SessionEdit = {}) {
  type Live = { key: string; lastActivity: string; agents?: Array<{ id: string; toolCalls: number }> };
  const all = Object.values(BOARD).flat() as Live[];
  const s = all.find((x) => x.key === key);
  if (!s) throw new Error(`no session ${key}`);
  for (const a of s.agents ?? []) if (a.id === edit.agent) a.toolCalls += edit.tools ?? 0;
  if (edit.shiftMs) s.lastActivity = new Date(Date.parse(s.lastActivity) + edit.shiftMs).toISOString();
  await page.evaluate(
    (payload) => {
      // biome-ignore lint/suspicious/noExplicitAny: the stub socket the page opened
      (window as any).__ws.onmessage({ data: payload });
    },
    JSON.stringify({ type: 'sessionUpdated', session: s }),
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
  BOARD = makeBoard();
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
    face.includes('서브에이전트 5') && face.includes('실행 2') && face.includes('실패 1'),
    `${tag}: collapsed card says "${face.trim()}"`,
  );
  const plain = await page.evaluate(
    (key) => !!document.querySelector(`[data-session-key="${key}"] .card-agents`),
    K('100'),
  );
  check(!plain, `${tag}: a card without subagents has no agents row`);
  check((await overflow(page)) === 0, `${tag}: board — no page overflow`);
  await shoot(page, `${theme}-${width}-board.png`);

  // §4.2 open card: one tree, one item type at every level.
  await page.click(`[data-session-key="${K('200')}"] .card-face`);
  await page.waitForTimeout(500);
  const readTree = (key: string) =>
    page.evaluate((k) => {
      const items = Array.from(document.querySelectorAll(`[data-session-key="${k}"] .an-tree .an[role="treeitem"]`));
      return items.map((li) => {
        const row = li.querySelector(':scope > .an-row') as HTMLElement;
        return {
          id: li.getAttribute('data-agent-open'),
          root: li.classList.contains('is-root'),
          level: li.getAttribute('aria-level'),
          expanded: li.getAttribute('aria-expanded'),
          tab: li.getAttribute('tabindex'),
          st: row?.querySelector('.ag-st')?.textContent ?? '',
          tools: row?.querySelector('.ag-tools')?.textContent ?? '',
          more: row?.querySelector('.an-more')?.textContent ?? '',
          span: !!row?.querySelector('.ag-span i'),
          pad: Number.parseFloat(getComputedStyle(row).paddingLeft),
          h: Math.round(row.getBoundingClientRect().height),
        };
      });
    }, key);
  const tree = await readTree(K('200'));
  const ids = tree.map((r) => r.id);
  check(
    JSON.stringify(ids) === JSON.stringify(['', 'toolu_explore', 'toolu_nested', 'toolu_lib', 'toolu_review']),
    `${tag}: open card tree = 메인 → A1 (→ A3) · A2 · A4 (${ids.join(',')})`,
  );
  check(
    tree[0]?.root && tree[0].level === '1' && tree[0].expanded === 'true',
    `${tag}: the root item is 메인 at level 1, open`,
  );
  check(
    tree.every((r) => r.st && /^툴 \d+$/.test(r.tools)),
    `${tag}: every item — the root included — has a status word and a tool count (${tree.map((r) => `${r.st}/${r.tools}`).join(' · ')})`,
  );
  check(tree[0]?.tools === '툴 16', `${tag}: the root's own tool count (${tree[0]?.tools})`);
  check(
    tree[2]?.level === '3' && tree[2]?.expanded === 'false' && tree[2]?.more === '+1',
    `${tag}: A3 (level 3) starts folded with +1 (${JSON.stringify(tree[2])})`,
  );
  check(
    tree[0].pad < tree[1].pad && tree[1].pad < tree[2].pad,
    `${tag}: indent grows with the level (${tree.map((r) => r.pad).join(',')})`,
  );
  check(
    !tree[0].span && tree.slice(1).every((r) => r.span),
    `${tag}: subagent rows carry the waterfall bar, the root none`,
  );
  check(tree.filter((r) => r.tab === '0').length === 1, `${tag}: the tree has one tab stop`);
  if (width < 640)
    check(
      tree.every((r) => r.h >= 44),
      `${tag}: tree rows ≥ 44px (${tree.map((r) => r.h).join(',')})`,
    );
  check((await overflow(page)) === 0, `${tag}: open card — no page overflow`);
  await shoot(page, `${theme}-${width}-card-tree.png`);
  // The chevron unfolds A3: A5 appears one level down.
  await page.click(`[data-session-key="${K('200')}"] [data-an-toggle="toolu_nested"]`);
  await page.waitForTimeout(200);
  const unfolded = await readTree(K('200'));
  const deep = unfolded.find((r) => r.id === 'toolu_deep');
  check(
    deep?.level === '4' && unfolded.find((r) => r.id === 'toolu_nested')?.expanded === 'true',
    `${tag}: the chevron unfolds A3 — A5 at level 4 (${deep?.level})`,
  );
  check((await overflow(page)) === 0, `${tag}: unfolded tree — no page overflow`);
  // After a chevron click focus sits on the item, not on the chevron: the arrows still work.
  const afterChev = await page.evaluate(() => {
    const a = document.activeElement;
    return a?.getAttribute('role') === 'treeitem'
      ? a.getAttribute('data-agent-open')
      : `(${a?.tagName}.${a?.className})`;
  });
  await page.keyboard.press('ArrowDown');
  const afterChevDown = await page.evaluate(() => document.activeElement?.getAttribute('data-agent-open') ?? '');
  check(
    afterChev === 'toolu_nested' && afterChevDown === 'toolu_deep',
    `${tag}: a chevron click leaves focus on its item, ↓ moves on (${afterChev} → ${afterChevDown})`,
  );
  const cardBox0 = await page.locator(`[data-session-key="${K('200')}"]`).boundingBox();
  if (cardBox0) await page.screenshot({ path: path.join(OUT, `${theme}-${width}-card-tree-deep.png`), clip: cardBox0 });
  // Tree keys (WAI-ARIA): ↓ from the root to A1, → into A3, ← folds A3, ← up to A1.
  const focusedId = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return a?.getAttribute('role') === 'treeitem' ? a.getAttribute('data-agent-open') : `(${a?.tagName})`;
    });
  await page.evaluate((key) => {
    (document.querySelector(`[data-session-key="${key}"] .an-tree .an.is-root`) as HTMLElement).focus();
  }, K('200'));
  await page.keyboard.press('ArrowDown');
  const k1 = await focusedId();
  await page.keyboard.press('ArrowRight');
  const k2 = await focusedId();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  const foldedByKey = (await readTree(K('200'))).find((r) => r.id === 'toolu_nested')?.expanded;
  const k3 = await focusedId();
  await page.keyboard.press('ArrowLeft');
  const k4 = await focusedId();
  check(
    k1 === 'toolu_explore' &&
      k2 === 'toolu_nested' &&
      foldedByKey === 'false' &&
      k3 === 'toolu_nested' &&
      k4 === 'toolu_explore',
    `${tag}: tree keys ↓ → ← ← move and fold (${[k1, k2, foldedByKey, k3, k4].join(' / ')})`,
  );
  // §4.4 live: a running subagent's tool count and the waterfall move; the item
  // the reader focused, its spinner and its bar are the same nodes after.
  await page.evaluate((key) => {
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    const li = document.querySelector(`[data-session-key="${key}"] .an[data-agent-open="toolu_explore"]`) as any;
    li.focus();
    li.__mark = 1;
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    (li.querySelector('.ag-spinner') as any).__mark = 1;
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    (li.querySelector('.ag-span i') as any).__mark = 1;
  }, K('200'));
  await pushSession(page, K('200'), { agent: 'toolu_explore', tools: 1, shiftMs: 60_000 });
  const liveCard = await page.evaluate((key) => {
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    const li = document.querySelector(`[data-session-key="${key}"] .an[data-agent-open="toolu_explore"]`) as any;
    const row = li?.querySelector(':scope > .an-row');
    return {
      sameItem: li?.__mark === 1,
      focused: document.activeElement === li,
      // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
      spinner: (li?.querySelector('.ag-spinner') as any)?.__mark === 1,
      // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
      bar: (li?.querySelector('.ag-span i') as any)?.__mark === 1,
      tools: row?.querySelector('.ag-tools')?.textContent ?? '',
    };
  }, K('200'));
  check(
    liveCard.sameItem && liveCard.focused && liveCard.spinner && liveCard.bar && liveCard.tools === '툴 19',
    `${tag}: live card update keeps the focused item, its spinner and bar (${JSON.stringify(liveCard)})`,
  );
  const cardBox = await page.locator(`[data-session-key="${K('200')}"]`).boundingBox();
  if (cardBox) await page.screenshot({ path: path.join(OUT, `${theme}-${width}-card-tree-crop.png`), clip: cardBox });

  // §4.3 Enter on a tree item opens the panel on that node.
  await page.keyboard.press('Enter');
  await page.waitForSelector('#slide-panel.open', { timeout: 5000 });
  const onHeader = await page.evaluate(() => document.activeElement?.classList.contains('pa-focus') ?? false);
  check(onHeader, `${tag}: Enter on a card item moves focus onto the node's header in the panel`);
  await page.waitForFunction(() => document.querySelectorAll('#worklog-list .wl-entry').length > 0, null, {
    timeout: 8000,
  });
  await page.click('#worklog-toggle');
  await page.waitForTimeout(350);
  const readPanel = () =>
    page.evaluate(() => ({
      path: Array.from(document.querySelectorAll('#panel-agents .pa-crumb')).map((b) => b.textContent),
      visiblePath: Array.from(document.querySelectorAll('#panel-agents .pa-crumb'))
        .filter((b) => (b as HTMLElement).offsetParent !== null)
        .map((b) => b.textContent),
      // What the path reads on screen, separators included (a hidden step takes its separator along).
      pathText:
        (document.querySelector('#panel-agents .pa-path') as HTMLElement | null)?.innerText
          .replace(/\s+/g, ' ')
          .trim() ?? '',
      upMark: (() => {
        const up = document.querySelector('#panel-agents .pa-crumb.is-up');
        return up ? getComputedStyle(up, '::before').content : '';
      })(),
      head: document.querySelector('#panel-agents .pa-focus')?.textContent ?? '',
      sub: Array.from(document.querySelectorAll('#panel-agents .pa-tree .an[role="treeitem"]')).map((li) => ({
        id: li.getAttribute('data-agent-select'),
        level: li.getAttribute('aria-level'),
      })),
      tasks: document.querySelector('#panel-tasks .panel-tasks-header')?.textContent ?? '',
      roles: Array.from(document.querySelectorAll('#worklog-list .wl-role')).map((r) => r.textContent),
      heights: Array.from(document.querySelectorAll('#panel-agents .pa-crumb, #panel-agents .pa-tree .an-row'))
        .filter((b) => (b as HTMLElement).offsetParent !== null)
        .map((b) => Math.round(b.getBoundingClientRect().height)),
    }));
  const bar = await readPanel();
  check(bar.path.join(' › ') === '메인 › A1 Explore', `${tag}: panel path ${bar.path.join(' › ')}`);
  check(
    bar.head.includes('A1') && bar.head.includes('Explore') && bar.head.includes('실행 중') && /툴 \d+/.test(bar.head),
    `${tag}: the focused node's header (${bar.head.trim().slice(0, 80)})`,
  );
  check(
    JSON.stringify(bar.sub) ===
      JSON.stringify([
        { id: 'toolu_nested', level: '1' },
        { id: 'toolu_deep', level: '2' },
      ]),
    `${tag}: its subtree, levels relative to it (${JSON.stringify(bar.sub)})`,
  );
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
      `${tag}: crumbs and subtree rows ≥ 44px (${bar.heights.join(',')})`,
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
        sum: document.querySelector('#panel-agents .pa-focus .pa-sum')?.textContent ?? '',
      };
    });
  })();
  check(
    crumbLive.focusedCrumb && crumbLive.sum.includes('툴 21'),
    `${tag}: the focused 메인 crumb keeps focus while the header moves (${JSON.stringify(crumbLive)})`,
  );
  // Drill one level down through the subtree: the path grows, and on a phone it
  // shrinks to "‹ parent › here".
  await page.click('#panel-agents .pa-tree .an[data-agent-select="toolu_nested"] > .an-row');
  await page.waitForTimeout(250);
  const drilled = await readPanel();
  check(
    drilled.path.join(' › ') === '메인 › A1 Explore › A3 general-purpose' && drilled.head.includes('실패'),
    `${tag}: drilling into A3 (${drilled.path.join(' › ')})`,
  );
  if (width < 640)
    check(
      drilled.pathText === 'A1 Explore › A3 general-purpose' && drilled.upMark.includes('‹'),
      `${tag}: the phone path reads ‹ parent › here (${drilled.upMark} ${drilled.pathText})`,
    );
  await shoot(page, `${theme}-${width}-panel-deep.png`, false);

  // Back to the root one level at a time through the parent crumb (the only
  // one a phone shows besides here): its header carries the same slots as any node's.
  for (let up = 0; up < 2; up++) {
    await page.click('#panel-agents .pa-crumb.is-up');
    await page.waitForTimeout(200);
  }
  const atRoot = await readPanel();
  check(
    atRoot.head.includes('메인') &&
      atRoot.head.includes('실행 중') &&
      atRoot.head.includes('툴 16') &&
      atRoot.head.includes('세션 Σ'),
    `${tag}: the root's header — status, tools, session Σ (${atRoot.head.trim().slice(0, 90)})`,
  );
  check(
    JSON.stringify(atRoot.sub.map((n) => n.id)) ===
      JSON.stringify(['toolu_explore', 'toolu_nested', 'toolu_lib', 'toolu_review']),
    `${tag}: the root's subtree in the panel (${atRoot.sub.map((n) => n.id).join(',')})`,
  );
  await shoot(page, `${theme}-${width}-panel-root.png`, false);
  const mainSeqs = await visibleSeqs(page);
  check(
    JSON.stringify(mainSeqs) === JSON.stringify([1, 2, 3, 4, 5, 6, 14, 15, 17, 19]),
    `${tag}: main log has no subagent entries (${mainSeqs.join(',')})`,
  );
  const blocks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#worklog-list .wl-child')).map((b) => ({
      id: b.getAttribute('data-agent-block'),
      st: b.querySelector('.ag-st')?.textContent ?? '',
      tools: b.querySelector('.ag-tools')?.textContent ?? '',
    })),
  );
  check(
    blocks.length === 3 && blocks.every((b) => b.st && b.tools),
    `${tag}: each spawn row in the main log carries its child's block (${blocks.map((b) => `${b.id}:${b.st}/${b.tools}`).join(' · ')})`,
  );
  await page.locator('#worklog-list .wl-child').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await shoot(page, `${theme}-${width}-panel-root-log.png`, false);
  check(
    !(await page.evaluate(() => !!document.querySelector('#panel-agents .pa-path'))),
    `${tag}: at the root the panel shows no path (nothing above it)`,
  );
  // A child block is live: the same node takes the new tool count.
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    const b = document.querySelector('#worklog-list .wl-child[data-agent-block="toolu_review"]') as any;
    b.__mark = 1;
  });
  await pushSession(page, K('200'), { agent: 'toolu_review', tools: 1 });
  const blockLive = await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: marks on live nodes
    const b = document.querySelector('#worklog-list .wl-child[data-agent-block="toolu_review"]') as any;
    return { same: b?.__mark === 1, tools: b?.querySelector('.ag-tools')?.textContent ?? '' };
  });
  check(
    blockLive.same && blockLive.tools === '툴 7',
    `${tag}: a child block updates in place (${JSON.stringify(blockLive)})`,
  );
  // Keyboard: ArrowDown from a spawn row lands on its child block, Enter opens that child.
  await page.evaluate(() => {
    const block = document.querySelectorAll('#worklog-list .wl-child')[0];
    (block.parentElement?.querySelector('.wl-row') as HTMLElement).focus();
  });
  await page.keyboard.press('ArrowDown');
  const onBlock = await page.evaluate(() => document.activeElement?.classList.contains('wl-child') ?? false);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const kbPath = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#panel-agents .pa-crumb'))
      .map((b) => b.textContent)
      .join(' › '),
  );
  const kbFocus = await page.evaluate(() => {
    const a = document.activeElement;
    return a?.classList.contains('pa-focus') ? (a.querySelector('.pa-name')?.textContent ?? '') : (a?.tagName ?? '');
  });
  check(kbFocus === 'A1Explore', `${tag}: after the keyboard switch focus is on the shown node's header (${kbFocus})`);
  // Keyboard drill in the panel's subtree: Enter on A3 lands on A3's header, not on its child.
  await page.evaluate(() => {
    (document.querySelector('#panel-agents .pa-tree .an[data-agent-select="toolu_nested"]') as HTMLElement).focus();
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const drillFocus = await page.evaluate(() => {
    const a = document.activeElement;
    return a?.classList.contains('pa-focus')
      ? (a.querySelector('.pa-name')?.textContent ?? '')
      : (a?.getAttribute('data-agent-select') ?? a?.tagName ?? '');
  });
  check(
    drillFocus === 'A3general-purpose',
    `${tag}: Enter on a subtree item lands on that node's header (${drillFocus})`,
  );
  await page.click('#panel-agents .pa-crumb.is-up');
  await page.waitForTimeout(200);
  check(
    onBlock && kbPath === '메인 › A1 Explore',
    `${tag}: keyboard ↓ + Enter on a child block opens it (${onBlock}, ${kbPath})`,
  );
  await page.click('#panel-agents .pa-crumb[data-agent-select=""]');
  await page.waitForTimeout(250);
  await page.click('#worklog-list .wl-child >> nth=1');
  await page.waitForTimeout(250);
  const libPath = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#panel-agents .pa-crumb'))
      .map((b) => b.textContent)
      .join(' › '),
  );
  check(libPath === '메인 › A2 librarian', `${tag}: a child block's click drills into it (${libPath})`);
  // Keyboard round trip: Enter on a card item opens the panel, Escape closes it, focus is back on the item.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await page.evaluate((key) => {
    (document.querySelector(`[data-session-key="${key}"] .an[data-agent-open="toolu_lib"]`) as HTMLElement).focus();
  }, K('200'));
  await page.keyboard.press('Enter');
  await page.waitForSelector('#slide-panel.open', { timeout: 5000 });
  await page.waitForTimeout(250);
  const opened = await page.evaluate(() => document.activeElement?.classList.contains('pa-focus') ?? false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const back = await page.evaluate(() => document.activeElement?.getAttribute('data-agent-open') ?? '');
  check(opened && back === 'toolu_lib', `${tag}: Enter → panel header, Escape → back on the item (${opened}, ${back})`);
  check((await overflow(page)) === 0, `${tag}: panel — no page overflow`);
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
