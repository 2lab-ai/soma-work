/**
 * #1466 (Z 2026-11-26) — an instruction sent from the detail card says where it really is — browser receipts.
 *
 *   "큐에 들어갔는지 대기중인지 모델이 받았는지 명확하게 구분해서 표시해줘"
 *
 *   S0  typed in the real composer and sent (the command request held open, as the real server holds it until the
 *       turn ends): the instruction reads 보내는 중 at once, and no 응답 작성 중 is drawn.
 *   S1  the server took it (instructionProgress received): 접수됨.
 *   S2  the person's task queue holds it, 2nd in line: 작업 큐 대기 · 2번째.
 *   S3  its turn is dispatched, the session works, the model does not have it yet: 처리 중 · 새 작업을 시작…, still
 *       no 응답 작성 중.
 *       The turn records the instruction as it starts: the recorded turn (its ref kept) keeps the chip.
 *   S4  the turn's first SDK event: 모델이 받았어요, and the writing row under it.
 *   S5  the answer lands: the chip and the writing row go.
 *
 * The real web server serves the real page; the browser's HTTP layer is mocked (board, turns, the held command) and
 * the WebSocket is a stub the script pushes the session's stages and the answer through.
 *
 * Run from the repo root in a clean env (prefix `env -i PATH="$PATH"`):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-instruction-stages.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'instruction-stages');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.STAGES_PORT || '33958';
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

/** Each command the page sent: its words and the ref the panel gave it (its optimistic turn's id). */
const commands: { message: string; ref: string }[] = [];

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
    const sent = JSON.parse(r.request().postData() || '{}');
    commands.push({ message: String(sent.message || ''), ref: String(sent.clientRef || '') });
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

/** What the chat shows now: the chip on the latest instruction (its words), and whether 응답 작성 중 is drawn. */
const chat = (page: Page) =>
  page.evaluate(() => {
    const conv = document.getElementById('panel-conv') as any;
    const turns = conv?.data?.turns ?? [];
    const last = turns[turns.length - 1];
    const chips = [...document.querySelectorAll('#panel-conv .cv-steer')] as HTMLElement[];
    const chip = chips.length ? (chips[chips.length - 1].textContent ?? '').trim() : '';
    const rows = [...(conv?.shadowRoot?.querySelectorAll('[aria-busy="true"]') ?? [])] as HTMLElement[];
    const writing = rows.some((r) => !!r.querySelector?.('ui-ai-answer'));
    return { chip, writing, pending: !!conv?.data?.pending, lastRole: last?.role ?? '' };
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
    check(!before.chip && !before.writing, `before: no chip, no writing row ${JSON.stringify(before)}`);

    // S0 — typed in the real composer and sent.
    const field = page.locator('#pc-composer textarea');
    await field.click();
    await field.fill(SENT);
    await page.keyboard.press('Enter');
    await sleep(400);
    const ref = commands[0]?.ref ?? '';
    const s0 = await chat(page);
    await page.screenshot({ path: path.join(OUT, '0-sending.png') });
    check(
      commands.length === 1 && commands[0].message === SENT && !!ref,
      `S0 the command went out with its ref (${ref})`,
    );
    check(s0.chip.includes('보내는 중') && !s0.writing, `S0 보내는 중, no 응답 작성 중 ${JSON.stringify(s0)}`);

    // Pushed, then read once the chat shows what it should (a loaded host paints late) — at most 8 s, then as it is.
    type View = Awaited<ReturnType<typeof chat>>;
    const settle = async (done: (v: View) => boolean) => {
      let v = await chat(page);
      for (let i = 0; i < 40 && !done(v); i++) {
        await sleep(200);
        v = await chat(page);
      }
      return v;
    };
    const stage = async (over: Record<string, unknown>, shot: string, done: (v: View) => boolean) => {
      await push(page, { type: 'sessionUpdated', session: session(over) });
      const v = await settle(done);
      await page.screenshot({ path: path.join(OUT, shot) });
      return v;
    };
    const progress = (s: string) => ({ instructionStages: [{ ref, stage: s, at: Date.now() }] });

    const s1 = await stage(progress('received'), '1-received.png', (v) => v.chip.includes('접수됨'));
    check(s1.chip.includes('접수됨') && !s1.writing, `S1 접수됨 ${JSON.stringify(s1)}`);

    const s2 = await stage(
      { ...progress('queued'), userQueue: { entryId: 'e1', kind: 'request', position: 2, since: Date.now() } },
      '2-queued.png',
      (v) => v.chip.includes('2번째'),
    );
    check(s2.chip.includes('작업 큐 대기 · 2번째') && !s2.writing, `S2 작업 큐 대기 · 2번째 ${JSON.stringify(s2)}`);

    const s3 = await stage({ ...progress('starting'), activityState: 'working' }, '3-starting.png', (v) =>
      v.chip.includes('새 작업을 시작'),
    );
    check(
      s3.chip.includes('새 작업을 시작') && !s3.writing && !s3.pending,
      `S3 working, not the model's yet: 시작 중, no 응답 작성 중 ${JSON.stringify(s3)}`,
    );

    // The turn records the instruction as it starts: the recorded turn (its ref kept) takes this browser's copy's place.
    await push(page, {
      type: 'conversation_update',
      conversationId: CID,
      turn: {
        id: 'u-rec',
        role: 'user',
        timestamp: new Date().toISOString(),
        userName: 'Zhuge',
        rawContent: SENT,
        clientRef: ref,
      },
    });
    const s3b = await settle((v) => v.lastRole === 'user' && v.chip.includes('새 작업을 시작'));
    check(s3b.chip.includes('새 작업을 시작'), `S3 the recorded turn keeps the stage ${JSON.stringify(s3b)}`);

    const s4 = await stage(
      { ...progress('delivered'), activityState: 'working' },
      '4-delivered.png',
      (v) => v.chip.includes('모델이 받았어요') && v.writing,
    );
    check(s4.chip.includes('모델이 받았어요') && s4.writing, `S4 모델이 받았어요 + 응답 작성 중 ${JSON.stringify(s4)}`);

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
    const s5 = await stage(
      { ...progress('delivered'), activityState: 'idle', finishedAt: Date.now() },
      '5-answered.png',
      (v) => !v.chip && !v.writing && v.lastRole === 'assistant',
    );
    check(!s5.chip && !s5.writing && s5.lastRole === 'assistant', `S5 answered: no chip, no row ${JSON.stringify(s5)}`);
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
