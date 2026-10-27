/**
 * Dashboard task view (SSOT 2026-10-27) — browser receipts and assertions.
 *
 * The real web server serves the real dashboard page; the browser-side HTTP
 * layer is mocked (board JSON, turns + raw answers, work log + raw entries,
 * artifacts) and the WebSocket is a stub, so every scenario is deterministic.
 *
 * Asserts (exit 1 on any failure), and writes screenshots, for 1280 × light /
 * dark and 390 × light:
 *   T1.1  the common surface (세션 정보 · 입력 필요 · 산출물) sits above the tabs
 *   T1.2  agent tabs: Main first and pinned at the left; a subagent tab scopes
 *         Tasks, the work log and 지시와 답변 (its instruction and result)
 *   T1.3  Tasks and 작업 로그 folded, 지시와 답변 open by default
 *   T1.4  an assistant turn shows its answer (rendered markdown), Raw at its foot
 *   T1.5  the composer: a textarea (Shift+Enter breaks the line), a pasted image
 *         becomes a chip, the send carries it as an attachment
 *   T1.6  자세히 opens every section; off again, the defaults return
 *   T2    earlier plans: 완료 · 중단 · 실행 안 됨 counted, folded, never spinning
 *   and documentElement.scrollWidth === innerWidth everywhere.
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-task-view.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'task-view');
fs.mkdirSync(OUT, { recursive: true });
// Its own port — never one inherited from a shell that runs soma-work (the page would load the live dashboard).
const PORT = process.env.TASK_VIEW_PORT || '33921';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const NOW = Date.now();
const M = 60_000;
const KEY = 'mock-inst::work:C123:1700000000.000200';

const ANSWER = [
  '## 탭 구조로 바꿨습니다',
  '',
  '- **상단**: 세션 정보 · 입력 필요 · 산출물',
  '- **하단**: Main과 서브 에이전트 탭',
  '',
  '변경은 `src/conversation/dashboard.ts`에 있습니다. PR: https://github.com/2lab-ai/soma-work/pull/999',
].join('\n');
const AGENT_ANSWER = '서브 에이전트 결과: **3곳**에서 탭 패턴을 찾았습니다.\n\n1. Apple Music\n2. Xcode\n3. Safari';

const AGENTS = [
  {
    id: 'toolu_explore',
    n: 1,
    type: 'Explore',
    description: 'Trace the panel layout',
    status: 'running',
    startedAt: NOW - 6 * M,
    toolCalls: 18,
    tasks: [
      {
        id: 'T1',
        content: 'Read the panel',
        activeForm: 'Reading the panel',
        status: 'in_progress',
        startedAt: NOW - 4 * M,
        toolCalls: 9,
      },
    ],
    earlierTasks: [
      { id: 'T0', content: 'Old step', status: 'pending', dropped: 'unstarted', removedAt: NOW - 5 * M, toolCalls: 0 },
    ],
  },
  {
    id: 'toolu_lib',
    n: 2,
    type: 'librarian',
    description: 'Research tab patterns',
    status: 'completed',
    startedAt: NOW - 5 * M,
    endedAt: NOW - M,
    durationMs: 4 * M,
    toolCalls: 31,
    summary: 'Found three tab patterns',
  },
];

function makeBoard() {
  return {
    waiting: [],
    working: [
      {
        key: KEY,
        title: 'Task view',
        displayHeadline: '대시보드 태스크 뷰 개선',
        ownerId: 'U001',
        ownerName: 'Zhuge',
        workflow: 'zwork',
        model: 'claude-opus-5-5[1m]',
        effort: 'high',
        channelId: 'C123',
        sessionState: 'MAIN',
        activityState: 'working',
        conversationId: 'conv-run',
        lastActivity: new Date(NOW).toISOString(),
        activeLegStartedAtMs: NOW - 7 * M,
        activeAccumulatedMs: 0,
        compactionCount: 1,
        threadTotalActiveMs: 12 * M,
        threadSessionCount: 1,
        slackThreadUrl: 'https://slack.example/archives/C123/p1700000000000',
        tokenUsage: {
          totalInputTokens: 1_200_000,
          totalOutputTokens: 91_000,
          totalCacheReadTokens: 4_000_000,
          totalCacheCreateTokens: 300_000,
          totalCostUsd: 12.4,
          contextUsagePercent: 31,
        },
        prUrl: 'https://github.com/2lab-ai/soma-work/pull/999',
        prShortRef: 'PR #999',
        prLabel: 'PR #999',
        prTitle: 'Task view',
        prStatus: 'open',
        agents: AGENTS,
        agentsTotal: 2,
        agentRoot: { toolCalls: 16, lastTool: 'Edit' },
        artifacts: {
          count: 1,
          recent: [
            {
              id: 'a1',
              name: 'analysis.html',
              kind: 'file',
              source: 'slack_file',
              createdAt: NOW - M,
              stored: true,
              size: 4096,
            },
          ],
        },
        tasks: [
          {
            id: 'T5',
            content: 'ledger 수정',
            status: 'completed',
            startedAt: NOW - 6 * M,
            completedAt: NOW - 5 * M,
            toolCalls: 4,
          },
          {
            id: 'T6',
            content: '화면 수정',
            activeForm: '화면 수정 중',
            status: 'in_progress',
            startedAt: NOW - 4 * M,
            toolCalls: 7,
          },
          { id: 'T7', content: '검증', status: 'pending', toolCalls: 0 },
        ],
        earlierTasks: [
          {
            id: 'T4',
            content: 'PR 올리기',
            status: 'pending',
            dropped: 'unstarted',
            removedAt: NOW - 6 * M,
            toolCalls: 0,
          },
          { id: 'T3', content: '구현', status: 'pending', dropped: 'unstarted', removedAt: NOW - 6 * M, toolCalls: 0 },
          {
            id: 'T2',
            content: 'RED 테스트',
            status: 'in_progress',
            startedAt: NOW - 9 * M,
            dropped: 'started',
            removedAt: NOW - 6 * M,
            toolCalls: 3,
          },
          {
            id: 'T1',
            content: '구조 조사',
            status: 'completed',
            startedAt: NOW - 12 * M,
            completedAt: NOW - 10 * M,
            removedAt: NOW - 6 * M,
            toolCalls: 14,
          },
        ],
      },
    ],
    idle: [],
    closed: [],
  };
}

const E = (seq: number, o: Record<string, unknown>) => ({ seq, ts: NOW - (40 - seq) * 10_000, attributed: true, ...o });
const WORKLOG = [
  E(1, { kind: 'instruction', text: '대시보드 개선해줘' }),
  E(2, {
    kind: 'tool',
    tool: 'Agent',
    text: 'Agent Research tab patterns',
    agentRef: 'toolu_lib',
    rawBytes: 120,
    taskId: 'T6',
    taskTitle: '화면 수정',
  }),
  E(3, { kind: 'tool', tool: 'WebFetch', text: 'WebFetch https://developer.apple.com', agentId: 'toolu_lib' }),
  E(4, { kind: 'tool_result', tool: 'Agent', text: 'Agent ok', ok: true, agentRef: 'toolu_lib', rawBytes: 80 }),
];
const WORKLOG_RAW: Record<string, string> = {
  '2': JSON.stringify(
    {
      description: 'Research tab patterns',
      prompt: 'Apple 앱들의 탭 패턴을 조사해줘.\n결과는 목록으로.',
      subagent_type: 'librarian',
    },
    null,
    2,
  ),
  '4': AGENT_ANSWER,
};

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) {',
  '  this.url = url; this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;',
  '  window.__ws = this;',
  '};',
  'window.WebSocket.prototype.close = function () {};',
].join('\n');

let sentBodies: unknown[] = [];
async function installMocks(page: Page) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({ content: 'window.__name = function (f) { return f; };' });
  await page.addInitScript({
    content: 'localStorage.setItem("soma-board-view", "board"); localStorage.removeItem("soma-panel-detail");',
  });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'x' } }),
  );
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: makeBoard() } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts/, (r) =>
    r.fulfill({ json: { artifacts: makeBoard().working[0].artifacts.recent } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog/, (r) =>
    r.fulfill({ json: { entries: WORKLOG, hasMore: false } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog\/\d+\/raw/, (r) => {
    const seq = new URL(r.request().url()).pathname.split('/').slice(-2)[0];
    const raw = WORKLOG_RAW[seq];
    return raw
      ? r.fulfill({ json: { raw, rawBytes: raw.length } })
      : r.fulfill({ status: 404, json: { error: 'missing' } });
  });
  await page.route(/\/api\/conversations\/[^/]+\/turns\/[^/]+\/raw/, (r) => r.fulfill({ json: { raw: ANSWER } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/command/, (r) => {
    sentBodies.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    return r.fulfill({
      json: {
        id: 'conv-run',
        title: 'conv-run',
        titleSub: '탭으로 나눈 태스크 뷰',
        turnCount: 2,
        turns: [
          {
            id: 't1',
            role: 'user',
            timestamp: new Date(NOW - 8 * M).toISOString(),
            userName: 'Zhuge',
            rawContent: '대시보드 개선해줘\n탭으로 보여줘',
          },
          {
            id: 't2',
            role: 'assistant',
            timestamp: new Date(NOW - 7 * M).toISOString(),
            summaryTitle: '탭 구조',
            summaryBody: 'summary: tabs done (machine text)',
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
const visible = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }, sel);

async function scenario(browser: import('playwright').Browser, theme: 'light' | 'dark', width: number, height = 900) {
  const narrow = width < 640;
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    hasTouch: narrow,
    isMobile: narrow,
  });
  const page = await ctx.newPage();
  sentBodies = [];
  page.on('pageerror', (err) => check(false, `page error: ${err.message}`));
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 1, null, { timeout: 20000 });
  await page.evaluate((k) => (window as any).openPanel(k), KEY);
  await page.waitForTimeout(900);
  const tag = `${theme} ${width}×${height}`;

  // T1.1 · the surface sits above the tabs, the tab panel below them.
  const order = await page.evaluate(() => {
    const at = (id: string) => {
      const el = document.getElementById(id);
      const all = Array.from(document.querySelectorAll('#panel-scroll *'));
      return el ? all.indexOf(el) : -1;
    };
    return ['panel-info', 'panel-artifacts', 'panel-tabs', 'panel-tasks', 'panel-worklog', 'panel-conv'].map(at);
  });
  check(
    order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])),
    `${tag}: surface → tabs → Tasks · 작업 로그 · 지시와 답변 (${order.join(',')})`,
  );

  // T1.3 / T1.6 · minimal by default.
  const def = await page.evaluate(() => ({
    detail: document.getElementById('panel-detail-toggle')?.getAttribute('aria-pressed'),
    tasks: document.querySelector('#panel-tasks .panel-sec-head')?.getAttribute('aria-expanded'),
    taskSum: document.querySelector('#panel-tasks .ps-sec-sum')?.textContent ?? '',
    log: document.getElementById('worklog-toggle')?.getAttribute('aria-expanded'),
    conv: document.getElementById('conv-toggle')?.getAttribute('aria-expanded'),
    list: !!document.querySelector('#panel-tasks .pl-list'),
  }));
  check(
    def.detail === 'false' && def.tasks === 'false' && def.log === 'false' && def.conv === 'true' && !def.list,
    `${tag}: default — 자세히 off, Tasks/작업 로그 folded, 지시와 답변 open`,
  );
  check(
    /화면 수정 중/.test(def.taskSum) && /1\/3/.test(def.taskSum),
    `${tag}: folded Tasks head reads the running step and 1/3 ("${def.taskSum}")`,
  );

  // T1.4 · the answer is the face; Raw closed at the foot.
  await page
    .waitForFunction(() => !!document.querySelector('#panel-turns .turn-answer .ans-body'), null, { timeout: 8000 })
    .catch(() => {});
  const ans = await page.evaluate(() => {
    const turn = document.querySelector('#panel-turns .turn.assistant');
    const body = turn?.querySelector('.turn-answer .ans-body');
    const raw = turn?.querySelector('details.turn-raw') as HTMLDetailsElement | null;
    return {
      h2: !!body?.querySelector('h2, h3, strong'),
      text: body?.textContent ?? '',
      rawOpen: raw ? raw.open : null,
      rawLast: raw ? raw === turn?.querySelector('.turn-body')?.lastElementChild : false,
      src: turn?.querySelector('.turn-raw-src')?.textContent ?? '',
      summaryInRaw: !!raw?.textContent?.includes('summary: tabs done'),
      summaryOutside: !!turn?.querySelector('.turn-answer')?.textContent?.includes('summary: tabs done'),
    };
  });
  check(
    ans.h2 && /탭 구조로 바꿨습니다/.test(ans.text),
    `${tag}: the assistant turn shows its rendered answer by default`,
  );
  check(ans.rawOpen === false && ans.rawLast, `${tag}: Raw is the turn's last block, closed`);
  check(
    ans.src.includes('## 탭 구조로') && ans.summaryInRaw && !ans.summaryOutside,
    `${tag}: Raw holds the markdown source and the summary (not the face)`,
  );
  await page.screenshot({ path: path.join(OUT, `panel-default-${theme}-${width}.png`) });

  // T1.2 · tabs: Main first and sticky; a subagent tab scopes the tab panel.
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#panel-tabs [role="tab"]')).map((t) => ({
      id: t.getAttribute('data-agent-tab'),
      sel: t.getAttribute('aria-selected'),
      pos: getComputedStyle(t).position,
      text: t.textContent,
    })),
  );
  check(
    tabs.length === 3 && tabs[0].id === '' && tabs[0].sel === 'true' && tabs[0].pos === 'sticky',
    `${tag}: Main first, selected, sticky (${tabs.map((t) => t.text).join(' | ')})`,
  );
  check(tabs[1]?.id === 'toolu_explore' && tabs[2]?.id === 'toolu_lib', `${tag}: subagent tabs in spawn order`);
  await page.locator('#panel-tabs [data-agent-tab="toolu_lib"]').click();
  await page.waitForTimeout(700);
  const sub = await page.evaluate(() => ({
    sel: document.querySelector('#panel-tabs [aria-selected="true"]')?.getAttribute('data-agent-tab'),
    turnsHidden: (document.getElementById('panel-turns') as HTMLElement).hidden,
    conv: document.getElementById('panel-agent-conv')?.textContent ?? '',
    tasksTitle: document.querySelector('#panel-tasks .ps-sec-title')?.textContent ?? '',
  }));
  check(sub.sel === 'toolu_lib' && sub.turnsHidden, `${tag}: the A2 tab is selected and the main turns step aside`);
  check(
    /Apple 앱들의 탭 패턴/.test(sub.conv) && /3곳/.test(sub.conv),
    `${tag}: A2's tab shows its instruction (prompt) and its result`,
  );
  check(/A2/.test(sub.tasksTitle), `${tag}: Tasks are scoped to A2 ("${sub.tasksTitle}")`);
  await page.screenshot({ path: path.join(OUT, `panel-subagent-${theme}-${width}.png`) });
  // Arrow keys move along the strip.
  await page.locator('#panel-tabs [aria-selected="true"]').focus();
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
  check(
    (await page.evaluate(() => document.activeElement?.getAttribute('data-agent-tab'))) === '',
    `${tag}: Home returns to Main (focus and selection)`,
  );

  // T2 · earlier plans: counted, folded, never spinning.
  await page.locator('#panel-tasks .panel-sec-head').click();
  await page.waitForTimeout(250);
  const plan = await page.evaluate(() => ({
    toggle: document.querySelector('#panel-tasks .panel-tasks-earlier-toggle')?.textContent ?? '',
    groups: document.querySelectorAll('#panel-tasks .pl-earlier-group').length,
  }));
  check(
    /완료 1/.test(plan.toggle) && /중단 1/.test(plan.toggle) && /실행 안 됨 2/.test(plan.toggle) && plan.groups === 0,
    `${tag}: 이전 계획 counted and folded ("${plan.toggle.trim()}")`,
  );
  await page.locator('#panel-tasks .panel-tasks-earlier-toggle').click();
  await page.waitForTimeout(250);
  const earlier = await page.evaluate(() => ({
    groups: document.querySelectorAll('#panel-tasks .pl-earlier-group').length,
    spin: document.querySelectorAll('#panel-tasks .pl-earlier .spinner, #panel-tasks .pl-earlier .task-elapsed').length,
    steps: Array.from(document.querySelectorAll('#panel-tasks .pl-earlier .pl-step')).map((e) =>
      e.getAttribute('data-step'),
    ),
    when: document.querySelector('#panel-tasks .pl-earlier-when')?.textContent ?? '',
  }));
  check(earlier.groups === 1 && earlier.spin === 0, `${tag}: one replaced plan, no spinner or clock in it`);
  check(
    earlier.steps.join(',') === 'skipped,skipped,dropped,done' && /새 계획으로 교체/.test(earlier.when),
    `${tag}: fates ${earlier.steps.join(',')} · "${earlier.when}"`,
  );
  await page.locator('#panel-tasks').screenshot({ path: path.join(OUT, `tasks-earlier-${theme}-${width}.png`) });

  // T1.6 · 자세히 opens every section; off returns the defaults.
  await page.locator('#panel-detail-toggle').click();
  await page.waitForTimeout(400);
  const det = await page.evaluate(() => ({
    cls: document.getElementById('slide-panel')?.classList.contains('is-detail'),
    info: !!document.getElementById('panel-info-body'),
    tasks: document.querySelector('#panel-tasks .panel-sec-head')?.getAttribute('aria-expanded'),
    log: document.getElementById('worklog-toggle')?.getAttribute('aria-expanded'),
    saved: localStorage.getItem('soma-panel-detail'),
  }));
  check(
    !!det.cls && det.info && det.tasks === 'true' && det.log === 'true' && det.saved === '1',
    `${tag}: 자세히 on — 세션 정보 body, Tasks, 작업 로그 all open (saved)`,
  );
  await page.screenshot({ path: path.join(OUT, `panel-detail-${theme}-${width}.png`), fullPage: false });
  await page.locator('#panel-detail-toggle').click();
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => ({
    info: !!document.getElementById('panel-info-body'),
    tasks: document.querySelector('#panel-tasks .panel-sec-head')?.getAttribute('aria-expanded'),
    log: document.getElementById('worklog-toggle')?.getAttribute('aria-expanded'),
  }));
  check(!off.info && off.tasks === 'false' && off.log === 'false', `${tag}: 자세히 off — back to the folded defaults`);

  // T1.5 · composer: multiline, a pasted image, the send carries it.
  const input = page.locator('#cmd-input');
  check((await input.evaluate((el) => el.tagName)) === 'TEXTAREA', `${tag}: the composer is a textarea`);
  await input.click();
  await page.keyboard.type('첫 줄');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('둘째 줄');
  await page.evaluate(() => {
    const el = document.getElementById('cmd-input') as HTMLTextAreaElement;
    const dt = new DataTransfer();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  const chips = await page.locator('#pc-attachments .nt-att').count();
  check(chips === 1, `${tag}: a pasted image becomes one chip`);
  check((await input.inputValue()) === '첫 줄\n둘째 줄', `${tag}: Shift+Enter breaks the line`);
  await page.screenshot({ path: path.join(OUT, `composer-${theme}-${width}.png`) });
  if (narrow) await page.locator('#cmd-send').click();
  else await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const body = sentBodies[0] as
    | { message?: string; attachments?: Array<{ name: string; mimetype: string; data: string }> }
    | undefined;
  check(
    !!body &&
      body.message === '첫 줄\n둘째 줄' &&
      body.attachments?.length === 1 &&
      body.attachments[0].mimetype === 'image/png' &&
      /^screenshot-/.test(body.attachments[0].name),
    `${tag}: the send carries the multiline text and the image (${JSON.stringify(body && { message: body.message, files: body.attachments?.map((a) => a.name) })})`,
  );
  check((await page.locator('#pc-attachments .nt-att').count()) === 0, `${tag}: a sent file leaves the composer`);
  check(await visible(page, '#pc-mic'), `${tag}: the voice button is there`);

  check(
    (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0,
    `${tag}: no horizontal overflow`,
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
    await scenario(browser, 'light', 1280);
    await scenario(browser, 'dark', 1280);
    await scenario(browser, 'light', 390, 844);
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
