/**
 * An instruction sent from the detail card shows the writing row at once (Z 2026-11-26) — browser receipts.
 *
 *   S1  an idle card: the instruction typed in the composer and sent shows the 응답 작성 중 row under it within
 *       300 ms, while the command request is still open (the real server answers it only after the whole turn) and
 *       the session still says idle.
 *   S2  the session turns working: the row stays (its own state rules now).
 *   S3  the answer lands and the session goes idle: the row goes.
 *
 * The real web server serves the real page; the browser's HTTP layer is mocked (board, turns, the held command) and
 * the WebSocket is a stub the script pushes session and turn updates through.
 *
 * Run from the repo root in a clean env (prefix `env -i PATH="$PATH"`):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-sent-writing-row.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'sent-writing-row');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.SENT_ROW_PORT || '33957';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const NOW = Date.now();
const M = 60_000;
const KEY = 'mock-inst::work:C123:1700000000.000400';
const CID = 'conv-sent';
const SENT = '이 작업을 stage0 배포 리포트에도 적용해줘';

function session(over: Record<string, unknown> = {}) {
  return {
    key: KEY,
    title: 'Sent writing row',
    displayHeadline: '즉시 작업 준비 알림',
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'default',
    model: 'claude-opus-5-5[1m]',
    effort: 'xhigh',
    channelId: 'C123',
    sessionState: 'MAIN',
    activityState: 'idle',
    finishedAt: NOW - 5 * M,
    conversationId: CID,
    lastActivity: new Date(NOW - 5 * M).toISOString(),
    activeAccumulatedMs: 0,
    slackThreadUrl: 'https://slack.example/archives/C123/p1700000000000',
    tokenUsage: { totalInputTokens: 200_000, totalOutputTokens: 9_000, totalCostUsd: 0.3, contextUsagePercent: 12 },
    tasks: [],
    earlierTasks: [],
    artifacts: { count: 0, recent: [] },
    ...over,
  };
}

const TURNS = Array.from({ length: 6 }, (_, i) => [
  {
    id: `u${i}`,
    role: 'user',
    timestamp: new Date(NOW - (40 - i * 6) * M).toISOString(),
    userName: 'Zhuge',
    rawContent: `지시 ${i + 1}: 리포트 형식을 확인해줘.`,
  },
  {
    id: `a${i}`,
    role: 'assistant',
    timestamp: new Date(NOW - (39 - i * 6) * M).toISOString(),
    summaryTitle: `답변 ${i + 1}`,
    summaryBody: `summary ${i + 1}`,
    summarized: true,
  },
]).flat();

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) {',
  '  this.url = url; this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;',
  '  window.__ws = this;',
  '};',
  'window.WebSocket.prototype.close = function () {};',
  'window.WebSocket.prototype.send = function () {};',
  'window.__name = function (f) { return f; };',
  'delete window.webkitSpeechRecognition; delete window.SpeechRecognition;',
  '(function tick() { requestAnimationFrame(tick); })();',
].join('\n');

/** Each command the page sent, with the time it reached the route. */
const commands: { message: string; at: number }[] = [];

async function installMocks(page: Page) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, isAdmin: true, csrfToken: 'x' } }),
  );
  await page.route('**/api/dashboard/admin-approvals', (r) => r.fulfill({ json: { pending: [], recent: [] } }));
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route('**/api/dashboard/sessions**', (r) =>
    r.fulfill({ json: { board: { waiting: [], working: [], idle: [session()], closed: [] } } }),
  );
  // The real route answers only after the whole turn: held open for the whole run.
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/command$/, (r) => {
    commands.push({ message: JSON.parse(r.request().postData() || '{}').message, at: Date.now() });
    return new Promise(() => {});
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts/, (r) => r.fulfill({ json: { artifacts: [] } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog(\?.*)?$/, (r) =>
    r.fulfill({ json: { entries: [], hasMore: false } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    return r.fulfill({ json: { id: CID, title: CID, turnCount: TURNS.length, turns: TURNS, hasMore: false } });
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
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** What the chat shows now: its last turn's words, whether a writing row is drawn, and its words. */
const chat = (page: Page) =>
  page.evaluate(() => {
    const conv = document.getElementById('panel-conv') as any;
    const rows = [...(conv?.shadowRoot?.querySelectorAll('[aria-busy="true"]') ?? [])] as HTMLElement[];
    const pendingRow = rows.find((r) => r.querySelector?.('ui-ai-answer')) ?? null;
    const answer = pendingRow?.querySelector('ui-ai-answer') as any;
    const words = answer?.shadowRoot?.querySelector('.ans-shimmer')?.textContent ?? '';
    const turns = conv?.data?.turns ?? [];
    const last = turns[turns.length - 1];
    return {
      pending: !!conv?.data?.pending,
      drawn: !!pendingRow,
      words,
      lastRole: last?.role ?? '',
      lastWords: String(last?.rawContent ?? last?.text ?? '').slice(0, 40),
    };
  });

const push = (page: Page, msg: unknown) =>
  page.evaluate((m) => (window as any).__ws.onmessage({ data: JSON.stringify(m) }), msg);

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', (err) => log(`[pageerror] ${err.message}`));
    await installMocks(page);
    // The board (the session the mock served, idle) has loaded once its response is in and the page took it.
    const board = page.waitForResponse((r) => r.url().includes('/api/dashboard/sessions'), { timeout: 20000 });
    await page.goto(`${BASE_URL}/dashboard/U001`);
    await page.waitForFunction(() => typeof (window as any).openPanel === 'function', null, { timeout: 20000 });
    await board;
    await sleep(800);
    await page.evaluate((k) => (window as any).openPanel(k), KEY);
    await page.waitForFunction(
      () => ((document.getElementById('panel-conv') as any)?.data?.turns?.length ?? 0) >= 12,
      null,
      { timeout: 15000 },
    );
    await sleep(1200);
    const before = await chat(page);
    check(!before.pending && !before.drawn, `before: idle, no writing row ${JSON.stringify(before)}`);

    // S1 — typed in the real composer and sent.
    const field = page.locator('#pc-composer textarea');
    await field.click();
    await field.fill(SENT);
    // Measured in the page from the Enter keydown to the first frame the row is drawn in.
    await page.evaluate(() => {
      const w = window as any;
      w.__drawnMs = -1;
      const t0 = performance.now();
      const look = () => {
        const conv = document.getElementById('panel-conv') as any;
        const row = [...(conv?.shadowRoot?.querySelectorAll('[aria-busy="true"]') ?? [])].find((r: any) =>
          r.querySelector?.('ui-ai-answer'),
        );
        if (row) w.__drawnMs = Math.round(performance.now() - t0);
        else if (performance.now() - t0 < 10_000) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await page.keyboard.press('Enter');
    await sleep(300);
    const drawnMs = await page.evaluate(() => (window as any).__drawnMs as number);
    const s1 = await chat(page);
    await page.screenshot({ path: path.join(OUT, '1-sent-idle.png') });
    check(commands.length === 1 && commands[0].message === SENT, `S1 the command went out (${commands.length})`);
    check(
      s1.lastRole === 'user' && s1.lastWords.startsWith(SENT.slice(0, 10)),
      `S1 the instruction is the chat's last turn ${JSON.stringify(s1)}`,
    );
    check(
      s1.pending && s1.drawn && s1.words.length > 0 && drawnMs >= 0 && drawnMs <= 300,
      `S1 drawn ${drawnMs} ms after Enter, the session still idle (nothing pushed yet): the writing row ("${s1.words}")`,
    );

    // S2 — the session turns working.
    await push(page, {
      type: 'sessionUpdated',
      session: session({ activityState: 'working', finishedAt: NOW - 5 * M }),
    });
    await sleep(500);
    const s2 = await chat(page);
    await page.screenshot({ path: path.join(OUT, '2-working.png') });
    check(s2.pending && s2.drawn, `S2 working: the row stays ${JSON.stringify(s2)}`);

    // S3 — the answer lands, the session goes idle.
    await push(page, {
      type: 'conversation_update',
      conversationId: CID,
      turn: {
        id: 'a-new',
        role: 'assistant',
        timestamp: new Date().toISOString(),
        summaryTitle: '적용 완료',
        summaryBody: 'done',
        summarized: true,
      },
    });
    await push(page, { type: 'sessionUpdated', session: session({ activityState: 'idle', finishedAt: Date.now() }) });
    await sleep(800);
    const s3 = await chat(page);
    await page.screenshot({ path: path.join(OUT, '3-answered.png') });
    check(!s3.pending && !s3.drawn, `S3 answered and idle: the row is gone ${JSON.stringify(s3)}`);
    await ctx.close();
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
