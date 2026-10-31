/**
 * Dashboard "New task" — live dictation, browser receipts (SSOT 2026-11-01).
 *
 * The real web server serves the real dashboard page; the composer's API calls are mocked and the browser's speech
 * recogniser is replaced by a scripted one (window.__recs), so the run needs no microphone and no speech service.
 * Exit 1 on any failed check; screenshots are written for every scenario.
 *
 *   Chromium + WebKit, PC 1280 and phone (Pixel 7 / iPhone 13):
 *     - with a recogniser the composer shows one mic — 받아쓰기 — and no audio voice note tool;
 *     - on the device or only on a yes: WebKit (Apple's engine) starts at once; Chromium (no on-device Korean)
 *       first says the voice would leave the device, and the second press is the yes;
 *     - pressing it starts a ko-KR, interim, continuous recogniser and shows the tool pressed;
 *     - words still being heard appear in the field as they arrive; settled words stay;
 *     - pressing again stops it; 작업 시작 sends the text — no attachment;
 *     - a dashboard task (no attachments) gets the same tool;
 *     - without a recogniser (Firefox) the old voice note tool is back and there is no 받아쓰기.
 *
 * Run from the repo root (keeps state out of the checkout):
 *   env -i HOME="$HOME" PATH="$PATH" SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst \
 *     npx tsx scripts/screenshot-new-task-dictation.ts [outDir]
 * (env -i: a bot-spawned shell carries the live viewer token and port — the run must not inherit them.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, type BrowserContextOptions, chromium, devices, type Page, webkit } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'new-task-dictation');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CONVERSATION_VIEWER_PORT || '33921';
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
].join('\n');

/** A scripted recogniser: each instance is kept in window.__recs; __say(results) and __end() drive the newest. */
const FAKE_RECOGNISER = `
(function () {
  window.__recs = [];
  function FakeRec() { this.lang = ''; this.interimResults = false; this.continuous = false; this.starts = 0;
    this.stops = 0; this.aborts = 0; window.__recs.push(this); }
  FakeRec.prototype.start = function () { this.starts++; };
  FakeRec.prototype.stop = function () { this.stops++; };
  FakeRec.prototype.abort = function () { this.aborts++; };
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = FakeRec;
  function result(t, isFinal) { var r = [{ transcript: t }]; r.isFinal = isFinal; return r; }
  window.__say = function (list) {
    var rec = window.__recs[window.__recs.length - 1];
    rec.onresult({ resultIndex: 0, results: list.map(function (x) { return result(x[0], x[1]); }) });
  };
  window.__end = function () { var rec = window.__recs[window.__recs.length - 1]; rec.onend(); };
})();
`;
/** The device has already said yes to a speech service off the device. */
const REMOTE_OK = "try { localStorage.setItem('soma-nt-dictation-remote', 'ok'); } catch (e) {}";
const NO_RECOGNISER = 'window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;';

interface Posted {
  body: any;
}

async function openPage(browser: Browser, options: BrowserContextOptions, init: string, posted: Posted[]) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.addInitScript({ content: WS_STUB });
  await page.addInitScript({ content: init });
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
  return { page, context };
}

/** The composer's tools as drawn (its shadow root): their keys and pressed state, and the field's text. */
async function composerView(page: Page) {
  return page.evaluate(() => {
    const el = document.getElementById('nt-composer') as any;
    const root = el.shadowRoot || el;
    const tools = Array.from(root.querySelectorAll('.cp-tools button')).map((b: any) => ({
      mk: b.getAttribute('data-mk'),
      pressed: b.getAttribute('aria-pressed'),
      label: b.getAttribute('aria-label'),
    }));
    return { tools, value: String(el.value || ''), status: document.getElementById('nt-status')?.textContent || '' };
  });
}

async function openComposer(page: Page) {
  await page.evaluate(() => (window as any).openNewTask());
  await page.waitForFunction(() => (window as any)._ntCtx, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function pressDictate(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('nt-composer') as any;
    const root = el.shadowRoot || el;
    (root.querySelector('[data-mk="tool:dictate"]') as HTMLElement).click();
  });
  await page.waitForTimeout(100);
}

async function run(browser: Browser, engine: string, label: string, options: BrowserContextOptions) {
  const tag = `${engine} ${label}`;
  // 1) With a recogniser: dictate, see the words arrive, stop, send.
  {
    const posted: Posted[] = [];
    const { page, context } = await openPage(browser, options, FAKE_RECOGNISER, posted);
    await openComposer(page);
    let v = await composerView(page);
    const mks = v.tools.map((t) => t.mk);
    check(
      `${tag}: one mic — 받아쓰기, no audio voice note`,
      mks.includes('tool:dictate') && !mks.includes('voice'),
      mks.join(','),
    );
    await pressDictate(page);
    // On the device or only on a yes: Apple's engine (WebKit) starts at once; a browser whose recogniser sends the
    // voice off the device (Chromium here: no on-device Korean) says so first, and the second press is the yes.
    const apple = await page.evaluate(() => (window as any).ntIsAppleSpeech(window));
    const firstMade = await page.evaluate(() => (window as any).__recs.length);
    if (apple) {
      check(`${tag}: Apple's engine (on the device) starts on the first press`, firstMade === 1, `recs=${firstMade}`);
    } else {
      const said = (await composerView(page)).status;
      check(
        `${tag}: off the device, the first press only says so (and points to the keyboard mic)`,
        firstMade === 0 && said.includes('기기 밖') && said.includes('키보드의 마이크'),
        `recs=${firstMade} · ${said}`,
      );
      await pressDictate(page);
      const kept = await page.evaluate(() => localStorage.getItem('soma-nt-dictation-remote'));
      check(`${tag}: the second press is the yes, kept on the device`, kept === 'ok', String(kept));
    }
    const rec = await page.evaluate(() => {
      const r = (window as any).__recs[0];
      return r ? { lang: r.lang, interim: r.interimResults, continuous: r.continuous, starts: r.starts } : null;
    });
    check(
      `${tag}: the press starts a ko-KR, interim, continuous recogniser`,
      !!rec && rec.lang === 'ko-KR' && rec.interim && rec.continuous && rec.starts === 1,
      JSON.stringify(rec),
    );
    v = await composerView(page);
    check(
      `${tag}: the tool shows pressed, the status says it listens`,
      v.tools.find((t) => t.mk === 'tool:dictate')?.pressed === 'true' && v.status.includes('듣는 중'),
      `${JSON.stringify(v.tools)} · ${v.status}`,
    );
    await page.evaluate(() => (window as any).__say([['새 작업 음성 입력을', false]]));
    v = await composerView(page);
    check(`${tag}: words still being heard appear at once`, v.value === '새 작업 음성 입력을', v.value);
    await page.screenshot({ path: path.join(OUT, `${engine}-${label}-listening.png`) });
    await page.evaluate(() =>
      (window as any).__say([
        ['새 작업 음성 입력을', true],
        [' 실시간 받아쓰기로', false],
      ]),
    );
    v = await composerView(page);
    check(
      `${tag}: settled words stay, the next ones follow`,
      v.value === '새 작업 음성 입력을 실시간 받아쓰기로',
      v.value,
    );
    await pressDictate(page);
    await page.evaluate(() =>
      (window as any).__say([
        ['새 작업 음성 입력을', true],
        [' 실시간 받아쓰기로 바꿔줘', true],
      ]),
    );
    await page.evaluate(() => (window as any).__end());
    v = await composerView(page);
    const stops = await page.evaluate(() => (window as any).__recs[0].stops);
    check(
      `${tag}: a second press stops it; the last words land; the tool lets go`,
      stops === 1 &&
        v.value === '새 작업 음성 입력을 실시간 받아쓰기로 바꿔줘' &&
        v.tools.find((t) => t.mk === 'tool:dictate')?.pressed === 'false' &&
        v.status === '',
      `${v.value} · stops=${stops} · ${v.status}`,
    );
    await page.screenshot({ path: path.join(OUT, `${engine}-${label}-done.png`) });
    await page.evaluate(() => {
      const el = document.getElementById('nt-composer') as any;
      ((el.shadowRoot || el).querySelector('[data-mk="send"]') as HTMLElement).click();
    });
    await page.waitForTimeout(500);
    const body = posted[0]?.body;
    check(
      `${tag}: 작업 시작 sends the text, no attachment`,
      !!body && body.prompt === '새 작업 음성 입력을 실시간 받아쓰기로 바꿔줘' && !(body.attachments || []).length,
      JSON.stringify(body && { prompt: body.prompt, attachments: (body.attachments || []).length }),
    );
    await context.close();
  }
  // 2) A dashboard task (no attachments) gets the same tool.
  {
    const { page, context } = await openPage(browser, options, FAKE_RECOGNISER + REMOTE_OK, []);
    await openComposer(page);
    // Switch the destination in the middle of a dictation (a repaint of the composer): the words stay and go on.
    await pressDictate(page);
    await page.evaluate(() => (window as any).__say([['대시보드 작업으로', false]]));
    await page.evaluate(() => (window as any).ntSetDestination('task'));
    await page.waitForTimeout(100);
    let v = await composerView(page);
    check(
      `${tag}: switching to a dashboard task mid-dictation keeps the words`,
      v.value === '대시보드 작업으로',
      v.value,
    );
    await page.evaluate(() => (window as any).__say([['대시보드 작업으로 보내줘', false]]));
    await page.evaluate(() => (window as any).ntLoadContext());
    await page.waitForTimeout(200);
    v = await composerView(page);
    check(
      `${tag}: the next words follow, and a context reload (repaint) keeps them`,
      v.value === '대시보드 작업으로 보내줘',
      v.value,
    );
    await pressDictate(page);
    const mks = v.tools.map((t) => t.mk);
    check(
      `${tag}: a dashboard task gets 받아쓰기 too`,
      mks.includes('tool:dictate') && !mks.includes('attach'),
      mks.join(','),
    );
    await context.close();
  }
  // 3) No recogniser: the old voice note is back, no 받아쓰기.
  {
    const { page, context } = await openPage(browser, options, NO_RECOGNISER, []);
    await openComposer(page);
    const v = await composerView(page);
    const mks = v.tools.map((t) => t.mk);
    check(`${tag}: no recogniser — the voice note stays, no 받아쓰기`, !mks.includes('tool:dictate'), mks.join(','));
    await page.screenshot({ path: path.join(OUT, `${engine}-${label}-no-recogniser.png`) });
    await context.close();
  }
}

async function main() {
  const dashboard = await import('../src/conversation/dashboard');
  dashboard.setDashboardSessionAccessor(() => new Map());
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  const engines: Array<[string, typeof chromium, string]> = [
    ['chromium', chromium, 'Pixel 7'],
    ['webkit', webkit, 'iPhone 13'],
  ];
  try {
    for (const [name, type, phone] of engines) {
      const browser = await type.launch({ headless: true });
      try {
        await run(browser, name, 'pc', { viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
        await run(browser, name, 'phone', { ...devices[phone], colorScheme: 'dark' });
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
