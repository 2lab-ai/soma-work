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
 *   T1.1  each surface part renders: 세션 정보 (owner · tokens · cost · PR link),
 *         산출물 (the session's files), 입력 필요 (a waiting session's question
 *         and permission request, counted in its head)
 *   T1.5  the composer: a textarea (Shift+Enter breaks the line), a pasted image
 *         becomes a chip, the send carries it as an attachment; a file picked
 *         with 📎, and a voice note recorded on Chromium's fake microphone
 *         (MediaRecorder), alone or still recording at send time, reach the REAL
 *         command route (validation, body limit, owner gate) and its handler
 *         uploads them on the Slack leg (`createSlackSteerUploader`, Slack double)
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
const KEY_WAIT = 'mock-inst::work:C124:1700000000.000300';
// The browser's command bodies are forwarded, byte for byte, to the real route under this bare key.
const LOCAL_KEY = 'C123:1700000000.000200';

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

// A session that waits on its owner: a question and a permission request (입력 필요).
function waitingSession() {
  return {
    key: KEY_WAIT,
    title: 'Needs you',
    displayHeadline: '배포 승인 대기',
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model: 'claude-opus-5-5[1m]',
    channelId: 'C124',
    sessionState: 'MAIN',
    activityState: 'waiting',
    conversationId: 'conv-wait',
    lastActivity: new Date(NOW).toISOString(),
    pendingQuestion: {
      type: 'user_choice',
      question: '어느 환경에 배포할까요?',
      choices: [
        { id: 'dev', label: 'dev', description: '먼저 dev에서 확인' },
        { id: 'prod', label: 'prod' },
      ],
      recommendedChoiceId: 'dev',
    },
    pendingPermissions: [
      {
        approvalId: 'ap-1',
        toolName: 'Bash',
        requesterId: 'U001',
        rules: [{ id: 'rm-rf', label: 'rm -rf', description: 'recursive delete' }],
        canDisableRule: false,
        createdAt: NOW - M,
        expiresAt: NOW + 10 * M,
      },
    ],
    artifacts: { count: 0, recent: [] },
    tasks: [],
    earlierTasks: [],
  };
}

function makeBoard() {
  return {
    waiting: [waitingSession()],
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
        goal: {
          current: {
            goalId: 'g1',
            objective: '태스크 뷰를 출시한다',
            status: 'active',
            continuationCount: 1,
            maxContinuations: 5,
          },
          queue: [],
          completedCount: 0,
          history: [],
        },
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
/** What the real command route handed its handler, and what the Slack leg made of it. */
interface Handled {
  key: string;
  message: string;
  names: string[];
  types: string[];
  sizes: number[];
  firstText: string;
  slack: Array<{ id: string; name: string; mimetype: string; url: string }>;
}
let handled: Handled[] = [];
/** A fresh Slack double (and uploader cache) per scenario — set up in main(). */
let resetSlackLeg: () => void = () => {};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function waitHandled(n: number) {
  for (let i = 0; i < 80 && handled.length < n; i++) await sleep(100);
}

// A Slack client double for the upload leg: files.uploadV2 takes each file, files.info reads it back.
function slackDouble() {
  let n = 0;
  const byId = new Map<string, { name: string; size: number }>();
  return {
    filesUploadV2: async (args: any) => {
      const files = args.file_uploads.map((u: any) => {
        const id = `F${++n}`;
        byId.set(id, { name: u.filename, size: Buffer.from(u.file).length });
        return { id, name: u.filename };
      });
      return { ok: true, files: [{ ok: true, files }] };
    },
    files: {
      info: async ({ file }: { file: string }) => {
        const f = byId.get(file);
        const ext = (f?.name.split('.').pop() ?? '').toLowerCase();
        const mimetype =
          {
            m4a: 'audio/mp4',
            mp4: 'audio/mp4',
            ogg: 'audio/ogg',
            webm: 'audio/webm',
            png: 'image/png',
            txt: 'text/plain',
          }[ext] ?? 'application/octet-stream';
        return {
          ok: true,
          file: {
            id: file,
            name: f?.name,
            mimetype,
            filetype: ext,
            size: f?.size ?? 0,
            url_private_download: `https://files.slack.com/files-pri/T1-${file}/download/${f?.name}`,
          },
        };
      },
    },
  };
}
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
  // The send goes on to the real route — the browser's exact bytes — and its answer comes back.
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/command/, async (r) => {
    const body = r.request().postData() || '{}';
    sentBodies.push(JSON.parse(body));
    const res = await fetch(`${BASE_URL}/api/dashboard/session/${encodeURIComponent(LOCAL_KEY)}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-mode': 'on' },
      body,
    });
    return r.fulfill({ status: res.status, json: await res.json().catch(() => ({})) });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/permission\/[^/?]+$/, (r) =>
    r.fulfill({
      json: { approvalId: 'ap-1', toolName: 'Bash', input: '{"command":"rm -rf build"}', truncated: false },
    }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    return r.fulfill({
      json: {
        id: 'conv-run',
        title: 'conv-run',
        titleSub: '탭으로 나눈 태스크 뷰',
        turnCount: 4,
        turns: [
          {
            id: 't0u',
            role: 'user',
            timestamp: new Date(NOW - 11 * M).toISOString(),
            userName: 'Zhuge',
            rawContent: '먼저 구조를 조사해줘',
          },
          {
            id: 't0a',
            role: 'assistant',
            timestamp: new Date(NOW - 10 * M).toISOString(),
            summaryTitle: '조사',
            summaryBody: 'summary: survey done',
            summarized: true,
          },
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

/** T1.5: the session's model (model · effort) is shown, above the steering input. */
const modelAboveInput = (page: Page) =>
  page.evaluate(() => {
    const c = document.getElementById('panel-controls') as HTMLElement;
    const i = document.getElementById('cmd-input') as HTMLElement;
    const cr = c.getBoundingClientRect();
    const ir = i.getBoundingClientRect();
    return {
      text: (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
      shown: cr.height > 0 && cr.width > 0,
      above: cr.bottom <= ir.top + 1,
      gap: Math.round(ir.top - cr.bottom),
    };
  });

async function scenario(browser: import('playwright').Browser, theme: 'light' | 'dark', width: number, height = 900) {
  const narrow = width < 640 || height < 560; // a phone, upright or sideways
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    hasTouch: narrow,
    isMobile: narrow,
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  sentBodies = [];
  handled = [];
  resetSlackLeg();
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

  // T1.1 · each part of the surface renders: 세션 정보 and 산출물 here, 입력 필요 on a waiting session below.
  await page
    .waitForFunction(() => /analysis\.html/.test(document.getElementById('panel-artifacts')?.textContent ?? ''), null, {
      timeout: 5000,
    })
    .catch(() => {});
  const surf = await page.evaluate(() => {
    const shown = (el: Element | null) => !!el && (el as HTMLElement).getBoundingClientRect().height > 0;
    const info = document.getElementById('panel-info');
    const art = document.getElementById('panel-artifacts');
    return {
      info: shown(info),
      title: info?.querySelector('.pi-title')?.textContent ?? '',
      sum: (info?.querySelector('.pi-sum')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      links: info?.querySelector('.pi-links')?.textContent ?? '',
      art: shown(art),
      artText: (art?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      needsHidden: (document.getElementById('panel-needs-head') as HTMLElement | null)?.hidden,
    };
  });
  check(
    surf.info &&
      surf.title === '세션 정보' &&
      /Zhuge/.test(surf.sum) &&
      /\$12\.40/.test(surf.sum) &&
      /PR #999/.test(surf.links),
    `${tag}: 세션 정보 renders — "${surf.sum}" · links "${surf.links}"`,
  );
  check(surf.art && /analysis\.html/.test(surf.artText), `${tag}: 산출물 renders — "${surf.artText.slice(0, 60)}"`);
  check(surf.needsHidden === true, `${tag}: 입력 필요 stays out of the way while nothing waits on the user`);

  // T1.1 / T1.6 · the opening lands at the top: the surface in view, then the tabs,
  // and 지시와 답변 holding the latest exchange (the earlier one folded).
  const land = await page.evaluate(() => {
    const sc = document.getElementById('panel-scroll') as HTMLElement;
    const r = (document.getElementById('panel-info') as HTMLElement).getBoundingClientRect();
    const a = sc.getBoundingClientRect();
    const btn = document.getElementById('conv-earlier') as HTMLElement;
    return {
      top: sc.scrollTop,
      infoIn: r.top >= a.top - 1 && r.bottom <= a.bottom,
      shown: Array.from(document.querySelectorAll('#panel-turns > .turn'))
        .filter((t) => t.getClientRects().length > 0)
        .map((t) => t.getAttribute('data-turn-id')),
      btn: btn.hidden ? '' : (btn.textContent ?? ''),
    };
  });
  check(
    land.top === 0 && land.infoIn,
    `${tag}: the opening lands at the top — 세션 정보 in view (scrollTop ${land.top})`,
  );
  // A layout shift (a narrower window reflows the rows) keeps a panel read at its top at its top.
  await page.setViewportSize({ width: narrow ? 360 : 390, height });
  await page.waitForTimeout(700);
  const afterResize = await page.evaluate(() => (document.getElementById('panel-scroll') as HTMLElement).scrollTop);
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(700);
  const afterBack = await page.evaluate(() => (document.getElementById('panel-scroll') as HTMLElement).scrollTop);
  check(
    afterResize === 0 && afterBack === 0,
    `${tag}: a window resize keeps the top landing (scrollTop ${afterResize} → ${afterBack})`,
  );
  check(
    land.shown.join(',') === 't1,t2' && land.btn === '이전 대화 2개',
    `${tag}: 지시와 답변 holds the latest exchange (${land.shown.join(',')}) under "${land.btn}"`,
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
    const all = document.querySelectorAll('#panel-turns .turn.assistant');
    const turn = all[all.length - 1];
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
  await page.locator('#conv-earlier').click();
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => ({
    shown: Array.from(document.querySelectorAll('#panel-turns > .turn'))
      .filter((t) => t.getClientRects().length > 0)
      .map((t) => t.getAttribute('data-turn-id')),
    btn: (document.getElementById('conv-earlier') as HTMLElement).hidden,
  }));
  check(
    opened.shown.join(',') === 't0u,t0a,t1,t2' && opened.btn,
    `${tag}: 이전 대화 opens every turn (${opened.shown.join(',')})`,
  );

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
  const mMain = await modelAboveInput(page);
  check(
    mMain.shown && /Opus 5\.5/.test(mMain.text) && mMain.above,
    `${tag}: Main tab — the session model ("${mMain.text}") sits above the steering input (gap ${mMain.gap}px)`,
  );
  await page.locator('#panel-tabs [data-agent-tab="toolu_lib"]').click();
  await page.waitForTimeout(700);
  const sub = await page.evaluate(() => ({
    sel: document.querySelector('#panel-tabs [aria-selected="true"]')?.getAttribute('data-agent-tab'),
    turnsHidden: (document.getElementById('panel-turns') as HTMLElement).hidden,
    conv: document.getElementById('panel-agent-conv')?.textContent ?? '',
    tasksTitle: document.querySelector('#panel-tasks .ps-sec-title')?.textContent ?? '',
    earlierBtn: (document.getElementById('conv-earlier') as HTMLElement).hidden,
  }));
  check(sub.sel === 'toolu_lib' && sub.turnsHidden, `${tag}: the A2 tab is selected and the main turns step aside`);
  check(
    /Apple 앱들의 탭 패턴/.test(sub.conv) && /3곳/.test(sub.conv),
    `${tag}: A2's tab shows its instruction (prompt) and its result`,
  );
  check(/A2/.test(sub.tasksTitle), `${tag}: Tasks are scoped to A2 ("${sub.tasksTitle}")`);
  check(sub.earlierBtn, `${tag}: the main conversation's 이전 대화 button is not on A2's tab`);
  const mSub = await modelAboveInput(page);
  check(
    mSub.shown && /Opus 5\.5/.test(mSub.text) && mSub.above,
    `${tag}: A2 tab — the session model ("${mSub.text}") still sits above the steering input (gap ${mSub.gap}px)`,
  );
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
  // While a send is in flight the button reads "Sending..." — it stays beside the field, in view.
  const sendingRow = await page.evaluate(() => {
    const b = document.getElementById('cmd-send') as HTMLButtonElement;
    const i = document.getElementById('cmd-input') as HTMLElement;
    const was = b.textContent;
    b.textContent = 'Sending...';
    const br = b.getBoundingClientRect();
    const ir = i.getBoundingClientRect();
    b.textContent = was;
    return { sameLine: br.top < ir.bottom && br.bottom > ir.top, inView: br.bottom <= window.innerHeight };
  });
  check(
    sendingRow.sameLine && sendingRow.inView,
    `${tag}: "Sending..." stays beside the field and in view (${JSON.stringify(sendingRow)})`,
  );
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
  await waitHandled(1);
  check(
    handled[0]?.message === '첫 줄\n둘째 줄' &&
      handled[0].types[0] === 'image/png' &&
      handled[0].sizes[0] === 12 &&
      handled[0].slack[0]?.id === 'F1',
    `${tag}: the real command route decoded the image (12 bytes) and the Slack leg uploaded it (${handled[0]?.slack.map((f) => `${f.id} ${f.name}`).join(', ')})`,
  );

  // T1.5 · a file picked with 📎 goes with a text instruction.
  await page.setInputFiles('#pc-file-input', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('메모 내용'),
  });
  await page.waitForTimeout(250);
  check(
    (await page.locator('#pc-attachments .nt-att').count()) === 1,
    `${tag}: a file picked with 📎 becomes one chip`,
  );
  await input.fill('파일 확인해줘');
  await page.locator('#cmd-send').click();
  await waitHandled(2);
  const fileBody = sentBodies[1] as { message?: string; attachments?: Array<{ name: string; mimetype: string }> };
  check(
    fileBody?.message === '파일 확인해줘' &&
      fileBody.attachments?.[0]?.name === 'notes.txt' &&
      handled[1]?.message === '파일 확인해줘' &&
      handled[1].names[0] === 'notes.txt' &&
      handled[1].types[0] === 'text/plain' &&
      handled[1].firstText === '메모 내용' &&
      handled[1].slack[0]?.name === 'notes.txt',
    `${tag}: the picked file reaches the route byte for byte ("${handled[1]?.firstText}") and Slack (${handled[1]?.slack[0]?.id})`,
  );

  // T1.5 · voice: 🎤 records on Chromium's fake microphone; 완료 files it; a voice-only send carries it.
  check(await visible(page, '#pc-mic'), `${tag}: the voice button is there`);
  await page.locator('#pc-mic').click();
  const recOn = await page
    .waitForFunction(() => !(document.getElementById('pc-recorder') as HTMLElement).hidden, null, { timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  check(
    recOn && (await page.locator('#pc-mic').getAttribute('aria-pressed')) === 'true',
    `${tag}: 🎤 starts a recording (recorder bar shown, mic pressed)`,
  );
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(OUT, `composer-recording-${theme}-${width}.png`) });
  await page.locator('#pc-recorder .nt-rec-btn.is-primary').click();
  await page
    .waitForFunction(() => document.querySelectorAll('#pc-attachments .nt-att').length === 1, null, { timeout: 5000 })
    .catch(() => {});
  const voiceName =
    (await page
      .locator('#pc-attachments .nt-att-name')
      .first()
      .textContent()
      .catch(() => '')) ?? '';
  check(/^voice-.+\.(m4a|mp4|ogg|webm)$/.test(voiceName), `${tag}: 완료 files the recording as a chip (${voiceName})`);
  await page.locator('#cmd-send').click();
  await waitHandled(3);
  const voiceBody = sentBodies[2] as { message?: string; attachments?: Array<{ name: string; mimetype: string }> };
  check(
    voiceBody?.message === '' &&
      /^audio\//.test(voiceBody.attachments?.[0]?.mimetype ?? '') &&
      handled[2]?.message === '' &&
      /^audio\//.test(handled[2].types[0] ?? '') &&
      (handled[2].sizes[0] ?? 0) > 1000 &&
      handled[2].slack[0]?.name === voiceName,
    `${tag}: a voice-only send reaches the route and Slack (${handled[2]?.types[0]}, ${handled[2]?.sizes[0]} bytes, ${handled[2]?.slack[0]?.id})`,
  );

  // T1.5 · sent while still recording: the send waits for the note to be filed (#488).
  await page.locator('#pc-mic').click();
  await page
    .waitForFunction(() => !(document.getElementById('pc-recorder') as HTMLElement).hidden, null, { timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(1300);
  await input.fill('녹음 중에 보냄');
  await page.locator('#cmd-send').click();
  await waitHandled(4);
  check(
    handled[3]?.message === '녹음 중에 보냄' &&
      handled[3].names.length === 1 &&
      /^audio\//.test(handled[3].types[0] ?? '') &&
      (handled[3].sizes[0] ?? 0) > 500,
    `${tag}: a send made while recording carries the note (${handled[3]?.names.join(', ')}, ${handled[3]?.sizes[0]} bytes)`,
  );

  check(
    (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0,
    `${tag}: no horizontal overflow`,
  );

  // ztrace S3: a panel opened straight onto a subagent (a tree item) fills its
  // instruction and result once the work log arrives — the log is slowed here.
  await page.evaluate(() => (window as any).closePanel());
  await page.waitForTimeout(300);
  const slowLog = /\/api\/dashboard\/session\/[^/?]+\/worklog(\?.*)?$/;
  await page.route(slowLog, async (r) => {
    await new Promise((res) => setTimeout(res, 1500));
    return r.fulfill({ json: { entries: WORKLOG, hasMore: false } });
  });
  await page.evaluate((k) => (window as any).openPanel(k, 'agent', 'toolu_lib'), KEY);
  await page.waitForTimeout(400);
  const early = await page.evaluate(() => document.getElementById('panel-agent-conv')?.textContent ?? '');
  await page.waitForTimeout(2500);
  const late = await page.evaluate(() => document.getElementById('panel-agent-conv')?.textContent ?? '');
  check(
    !/Apple 앱들의 탭 패턴/.test(early) && /Apple 앱들의 탭 패턴/.test(late) && /3곳/.test(late),
    `${tag}: a subagent tab opened before its work log fills its instruction and result when the log arrives`,
  );
  await page.unroute(slowLog);

  // 관리 → (a goal opening) lands with the goal at the top of the scroll area.
  await page.evaluate(() => (window as any).closePanel());
  await page.waitForTimeout(300);
  await page.evaluate((k) => (window as any).openPanel(k, 'goal'), KEY);
  await page.waitForTimeout(900);
  const goalAt = await page.evaluate(() => {
    const sc = document.getElementById('panel-scroll') as HTMLElement;
    const goal = document.getElementById('panel-goal') as HTMLElement;
    return {
      offset: Math.round(goal.getBoundingClientRect().top - sc.getBoundingClientRect().top),
      top: sc.scrollTop,
      h: sc.scrollHeight,
      ch: sc.clientHeight,
    };
  });
  check(
    Math.abs(goalAt.offset) <= 2,
    `${tag}: a goal opening lands with the goal at the top (${JSON.stringify(goalAt)})`,
  );

  // T1.1 · 입력 필요 — a session waiting on its owner: its question and its permission request, above the tabs.
  await page.evaluate(() => (window as any).closePanel());
  await page.waitForTimeout(300);
  await page.evaluate((k) => (window as any).openPanel(k), KEY_WAIT);
  await page
    .waitForFunction(() => /rm -rf build/.test(document.getElementById('panel-permission')?.textContent ?? ''), null, {
      timeout: 5000,
    })
    .catch(() => {});
  const needs = await page.evaluate(() => {
    const head = document.getElementById('panel-needs-head') as HTMLElement;
    const q = document.getElementById('panel-question') as HTMLElement;
    const p = document.getElementById('panel-permission') as HTMLElement;
    const all = Array.from(document.querySelectorAll('#panel-scroll *'));
    const flat = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      head: head && !head.hidden ? flat(head) : '',
      q: q && q.style.display !== 'none' ? flat(q) : '',
      choices: q ? q.querySelectorAll('button').length : 0,
      p: p && p.style.display !== 'none' ? flat(p) : '',
      order: [head, p, q, document.getElementById('panel-tabs')].map((el) => all.indexOf(el as Element)),
    };
  });
  check(
    /입력 필요/.test(needs.head) &&
      /2/.test(needs.head) &&
      needs.order.every((x, i) => x >= 0 && (i === 0 || x > needs.order[i - 1])),
    `${tag}: 입력 필요 renders — head "${needs.head}", then the permission, the question, and the tabs below`,
  );
  check(
    /어느 환경에 배포할까요/.test(needs.q) && needs.choices >= 2,
    `${tag}: 입력 필요 — the question with ${needs.choices} buttons ("${needs.q.slice(0, 50)}")`,
  );
  check(
    /Bash/.test(needs.p) && /rm -rf build/.test(needs.p),
    `${tag}: 입력 필요 — the permission request with its command ("${needs.p.slice(0, 60)}")`,
  );
  await page.screenshot({ path: path.join(OUT, `surface-needs-${theme}-${width}.png`) });
  await ctx.close();
}

// A phone sideways: the composer keeps the session model above the field, Send
// (even "Sending...") beside it, and the whole composer in view.
async function landscapeComposer(browser: import('playwright').Browser, width: number, height: number) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const tag = `light ${width}×${height} (phone sideways)`;
  page.on('pageerror', (err) => check(false, `page error: ${err.message}`));
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length >= 1, null, { timeout: 20000 });
  await page.evaluate((k) => (window as any).openPanel(k), KEY);
  await page.waitForTimeout(900);
  const m = await modelAboveInput(page);
  check(
    m.shown && /Opus 5\.5/.test(m.text) && m.above,
    `${tag}: the session model sits above the steering input (gap ${m.gap}px)`,
  );
  const row = await page.evaluate(() => {
    const b = document.getElementById('cmd-send') as HTMLButtonElement;
    const i = document.getElementById('cmd-input') as HTMLElement;
    const c = (document.getElementById('panel-command') as HTMLElement).getBoundingClientRect();
    const was = b.textContent;
    b.textContent = 'Sending...';
    const br = b.getBoundingClientRect();
    const ir = i.getBoundingClientRect();
    b.textContent = was;
    return {
      sameLine: br.top < ir.bottom && br.bottom > ir.top,
      composerInView: c.top >= 0 && c.bottom <= window.innerHeight + 1,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  check(row.sameLine, `${tag}: "Sending..." stays beside the field`);
  check(
    row.composerInView && row.overflow <= 0,
    `${tag}: the composer is in view, no sideways overflow (${JSON.stringify(row)})`,
  );
  await page.screenshot({ path: path.join(OUT, `composer-landscape-${width}.png`) });
  await ctx.close();
}

async function main() {
  const dashboard = await import('../src/conversation/dashboard');
  const { createSlackSteerUploader } = await import('../src/conversation/new-task-provider');
  // The real command route acts on this session; its handler runs the production Slack upload leg on a double.
  const sessions = new Map<string, any>([
    [LOCAL_KEY, { ownerId: 'U001', channelId: 'C123', threadTs: '1700000000.000200' }],
  ]);
  dashboard.setDashboardSessionAccessor(() => sessions);
  let upload = createSlackSteerUploader(slackDouble() as any);
  resetSlackLeg = () => {
    upload = createSlackSteerUploader(slackDouble() as any);
  };
  dashboard.setDashboardCommandHandler(async (key, message, files) => {
    const s = sessions.get(key);
    const slack = files.length ? await upload(s.channelId, s.threadTs, files) : [];
    handled.push({
      key,
      message,
      names: files.map((f) => f.name),
      types: files.map((f) => f.mimetype),
      sizes: files.map((f) => f.data.length),
      firstText: files[0] ? files[0].data.toString('utf8') : '',
      slack: slack.map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype, url: f.url_private_download })),
    });
  });
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  // A fake microphone (a tone) that needs no prompt: the recorder records something real.
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  try {
    await scenario(browser, 'light', 1280);
    await scenario(browser, 'dark', 1280);
    await scenario(browser, 'light', 390, 844);
    // A phone sideways (iPhone 18 Pro Max landscape, a target posture of the responsive sweep).
    await landscapeComposer(browser, 956, 440);
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
