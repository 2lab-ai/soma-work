/**
 * Dashboard "New task" — a paste too long for the instruction goes in as a text file, browser receipts
 * (SSOT 2026-11-04: "붙여넣는데 너무 크면 첨부 파일로 처리해줘").
 *
 * The real web server serves the real dashboard page; the composer's API calls are mocked. Exit 1 on any failed
 * check; screenshots are written for every scenario.
 *
 *   Chromium (a real ⌘/Ctrl+V from the system clipboard) and WebKit (a paste event dispatched on the field), PC 1280:
 *     - a paste that keeps the instruction under 12,000 characters goes into the field (Chromium);
 *     - a paste that would take it past 12,000 does not go into the field: a pasted-text-<stamp>.txt chip appears,
 *       and 작업 시작 posts the typed instruction plus that file as text/plain carrying the whole paste;
 *     - a dashboard task (no attachments yet) leaves the long paste alone;
 *     - with 10 files already attached the composer refuses the file and the paste goes into the field (not lost);
 *     - a long paste over a selection replaces it: the selected text leaves the field and the draft.
 *
 * Run from the repo root (keeps state out of the checkout):
 *   env -i HOME="$HOME" PATH="$PATH" SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst \
 *     npx tsx scripts/screenshot-new-task-paste.ts [outDir]
 * (env -i: a bot-spawned shell carries the live viewer token and port — the run must not inherit them.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page, webkit } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'new-task-paste');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CONVERSATION_VIEWER_PORT || '33923';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const report: string[] = [];
const failures: string[] = [];
function log(line: string) {
  report.push(line);
  console.log(line);
}
function check(name: string, ok: boolean, detail = '') {
  log(`${ok ? '[ok]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const CONTEXT = {
  models: [{ nickname: 'opus[1m]', model: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M)', battery: null }],
  defaultModel: 'opus[1m]',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'xhigh',
  channels: [{ id: 'C_ALPHA', name: 'workspace-alpha', repos: ['2lab-ai/soma-work'] }],
  defaultChannelId: 'C_ALPHA',
  membershipUnknown: false,
  autogoalDefault: false,
  taskFolders: [{ id: '', label: '기본' }],
  usage: { scope: 'shared-pool' },
  limits: { maxPromptChars: 12000, maxFiles: 10, maxFileBytes: 20971520, maxTotalBytes: 31457280 },
};

const WS_STUB = [
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
  // No speech recogniser: the new task would open listening (live dictation), which this run does not test.
  'window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;',
].join('\n');

/** 17,000 characters of log lines — past the 12,000 limit on its own. */
const BIG = Array.from({ length: 1000 }, (_, i) => `[${String(i).padStart(4, '0')}] 로그 한 줄 ok\n`).join('');
const TYPED = '아래 로그 분석해줘\n';

interface Posted {
  body: any;
}

async function openPage(browser: Browser, posted: Posted[]): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.addInitScript({ content: WS_STUB });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'csrf-x' } }),
  );
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/sessions**', (r) =>
    r.fulfill({ json: { board: { waiting: [], working: [], done: [] } } }),
  );
  await page.route('**/api/dashboard/new-task/context', (r) => r.fulfill({ json: { context: CONTEXT } }));
  await page.route('**/api/dashboard/new-task', async (r) => {
    posted.push({ body: JSON.parse(r.request().postData() || '{}') });
    await r.fulfill({
      json: { ok: true, channel: 'C_ALPHA', threadTs: '1.1', sessionKey: 'C_ALPHA:1.1', status: 'running' },
    });
  });
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForSelector('#new-task-btn', { state: 'attached' });
  // Not awaited in the page: openNewTask resolves once its context has loaded, which the next wait covers.
  await page.evaluate(() => {
    (window as any).openNewTask();
  });
  await page.waitForFunction(() => (window as any)._ntCtx && (window as any)._ntState, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  return { page, context };
}

/** The composer as drawn: its field's text and its files (names, types). */
async function composerView(page: Page) {
  return page.evaluate(() => {
    const el = document.getElementById('nt-composer') as any;
    return {
      value: String(el.value || ''),
      files: (el.files || []).map((f: File) => ({ name: f.name, type: f.type, size: f.size })),
    };
  });
}

/** Focus the composer's field (its shadow root): the caret at the end, or everything selected. */
async function focusField(page: Page, select: 'end' | 'all' = 'end') {
  await page.evaluate((sel) => {
    const el = document.getElementById('nt-composer') as any;
    const ta = (el.shadowRoot || el).querySelector('textarea') as HTMLTextAreaElement;
    ta.focus();
    if (sel === 'all') ta.select();
    else ta.setSelectionRange(ta.value.length, ta.value.length);
  }, select);
}

/** A real paste from the system clipboard (Chromium: clipboard permissions + the platform shortcut). */
async function realPaste(page: Page, text: string, select: 'end' | 'all' = 'end') {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await focusField(page, select);
  await page.keyboard.press('ControlOrMeta+V');
  await page.waitForTimeout(200);
}

/** A paste event dispatched on the field, as a browser fires it (bubbles, composed, cancelable). */
async function dispatchedPaste(page: Page, text: string, select: 'end' | 'all' = 'end') {
  await focusField(page, select);
  await page.evaluate((t) => {
    const el = document.getElementById('nt-composer') as any;
    const ta = (el.shadowRoot || el).querySelector('textarea') as HTMLTextAreaElement;
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    ta.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }),
    );
  }, text);
  await page.waitForTimeout(200);
}

async function typeInto(page: Page, text: string) {
  await focusField(page);
  await page.keyboard.insertText(text);
}

async function send(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('nt-composer') as any;
    ((el.shadowRoot || el).querySelector('[data-mk="send"]') as HTMLElement).click();
  });
}

async function run(browser: Browser, engine: string) {
  const posted: Posted[] = [];
  const { page, context } = await openPage(browser, posted);
  const real = engine === 'chromium';
  if (real) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
  const paste = real ? realPaste : dispatchedPaste;
  const tag = `${engine}-pc`;

  await typeInto(page, TYPED);
  if (real) {
    await paste(page, '짧은 붙여넣기');
    const v = await composerView(page);
    check(
      `${tag}: a paste that fits goes into the field`,
      v.value === `${TYPED}짧은 붙여넣기` && v.files.length === 0,
      JSON.stringify(v),
    );
    // Back to the typed instruction only.
    await page.evaluate((t) => {
      (document.getElementById('nt-composer') as any).value = t;
    }, TYPED);
  }

  await paste(page, BIG);
  const v = await composerView(page);
  check(
    `${tag}: a paste past 12,000 characters does not go into the field`,
    v.value === TYPED,
    `field ${v.value.length} chars`,
  );
  check(
    `${tag}: it is attached as pasted-text-<stamp>.txt (text/plain, the whole paste)`,
    v.files.length === 1 &&
      /^pasted-text-\d{8}-\d{6}\.txt$/.test(v.files[0].name) &&
      v.files[0].type === 'text/plain' &&
      v.files[0].size === Buffer.byteLength(BIG),
    JSON.stringify(v.files),
  );
  await page.screenshot({ path: path.join(OUT, `${tag}-chip.png`) });

  await send(page);
  for (let i = 0; i < 50 && posted.length === 0; i++) await page.waitForTimeout(100);
  const body = posted[0]?.body;
  const att = body?.attachments?.[0];
  const decoded = att ? Buffer.from(att.data, 'base64').toString('utf-8') : '';
  check(
    `${tag}: 작업 시작 posts the typed instruction and the file carrying all of the paste`,
    !!body &&
      String(body.prompt).trim() === TYPED.trim() &&
      body.attachments.length === 1 &&
      /^pasted-text-/.test(att.name) &&
      att.mimetype === 'text/plain' &&
      decoded === BIG,
    JSON.stringify({
      prompt: body?.prompt,
      attachments: body?.attachments?.map((a: any) => a.name),
      decoded: decoded.length,
    }),
  );
  await context.close();

  // A dashboard task takes no attachments yet: the long paste is left alone (the limit is said on send).
  const posted2: Posted[] = [];
  const second = await openPage(browser, posted2);
  if (real) await second.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
  await second.page.evaluate(() => {
    (window as any)._ntState.destination = 'task';
    (window as any).paintNtComposer();
  });
  await paste(second.page, BIG);
  const t = await composerView(second.page);
  check(
    `${tag}: a dashboard task leaves the long paste alone (no file)`,
    t.files.length === 0,
    JSON.stringify(t.files),
  );
  await second.context.close();

  // Ten files already (the composer's cap): it refuses the pasted-text file, and the paste is not lost — it goes
  // into the field (Chromium, a real paste; a dispatched paste inserts nothing, so WebKit checks no 11th file).
  const third = await openPage(browser, []);
  if (real) await third.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
  await third.page.evaluate(() => {
    const el = document.getElementById('nt-composer') as any;
    el.addFiles(Array.from({ length: 10 }, (_, i) => new File([`f${i}`], `f${i}.txt`, { type: 'text/plain' })));
  });
  await paste(third.page, BIG);
  const r = await composerView(third.page);
  check(
    `${tag}: with 10 files attached the file is refused and the paste is not lost`,
    r.files.length === 10 && (real ? r.value === BIG : true),
    `files ${r.files.length}, field ${r.value.length} chars`,
  );
  await third.page.screenshot({ path: path.join(OUT, `${tag}-refused.png`) });
  await third.context.close();

  // Everything selected, then a long paste: it replaces the selection — the old text leaves the field (and the
  // draft), the paste is the file.
  const fourth = await openPage(browser, []);
  if (real) await fourth.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
  await typeInto(fourth.page, 'OLD instruction to replace');
  await paste(fourth.page, BIG, 'all');
  const sel = await composerView(fourth.page);
  const draft = await fourth.page.evaluate(() => (window as any)._ntState.prompt);
  check(
    `${tag}: a long paste over a selection replaces it (field and draft empty, one file)`,
    sel.value === '' && draft === '' && sel.files.length === 1 && /^pasted-text-/.test(sel.files[0].name),
    JSON.stringify({ value: sel.value, draft, files: sel.files.map((f: { name: string }) => f.name) }),
  );
  await fourth.context.close();
}

async function main() {
  const dashboard = await import('../src/conversation/dashboard');
  dashboard.setDashboardSessionAccessor(() => new Map());
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  const engines: Array<[string, typeof chromium]> = [
    ['chromium', chromium],
    ['webkit', webkit],
  ];
  try {
    for (const [name, type] of engines) {
      const browser = await type.launch({ headless: true });
      try {
        await run(browser, name);
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
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
