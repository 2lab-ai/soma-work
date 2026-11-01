/**
 * Dashboard "New task" — live dictation, browser receipts (SSOT 2026-11-01).
 *
 * The real web server serves the real dashboard page; the composer's API calls are mocked and the browser's speech
 * recogniser is replaced by a scripted one (window.__recs), so the run needs no microphone and no speech service.
 * Exit 1 on any failed check; screenshots are written for every scenario.
 *
 *   Chromium + WebKit, PC 1280 and phone (Pixel 7 / iPhone 13), and Samsung Internet on a Galaxy (its user agent):
 *     - with a recogniser the composer keeps the voice note (mic) and shows 받아쓰기 beside it, fully in view;
 *     - the new task opens listening on Apple's engine (WebKit) and on a phone's own recogniser (Android — Chrome
 *       and Samsung Internet, SSOT_5); desktop Chromium (no on-device Korean) opens off, and its first press listens;
 *     - pressing it starts a ko-KR, interim recogniser (continuous; one utterance per session on Android) and shows
 *       the tool pressed;
 *     - words still being heard appear in the field as they arrive; settled words stay;
 *     - pressing again stops it; 작업 시작 sends the text — no attachment;
 *     - a dashboard task (no attachments) gets the same tool;
 *     - without a recogniser (Firefox) the voice note only, no 받아쓰기;
 *     - the session panel composer: voice note + 받아쓰기, and dictating writes into it;
 *     - a recogniser error lands on the red error line (on a Galaxy: what to turn on); a recogniser that hears speech
 *       and gives back no words (Samsung Internet) is said plainly there too.
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
  FakeRec.prototype.start = function () { this.starts++; if (this.onaudiostart) this.onaudiostart(); };
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
  window.__err = function (code) { var rec = window.__recs[window.__recs.length - 1]; rec.onerror({ error: code }); };
  window.__speech = function () { var rec = window.__recs[window.__recs.length - 1]; rec.onspeechstart(); };
})();
`;
const PANEL_KEY = 'mock-inst::work:C_ALPHA:1700000000.000200';
const PANEL_SESSION = {
  key: PANEL_KEY,
  title: '받아쓰기 세션',
  displayHeadline: '받아쓰기 세션',
  ownerId: 'U001',
  ownerName: 'Zhuge',
  workflow: 'default',
  model: 'claude-opus-5-5[1m]',
  effort: 'high',
  channelId: 'C_ALPHA',
  sessionState: 'MAIN',
  activityState: 'idle',
  conversationId: 'conv-1',
  lastActivity: new Date().toISOString(),
};

/** Samsung Internet on a Galaxy S24 (what the person tested, SSOT_5). */
const SAMSUNG_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const NO_RECOGNISER = 'window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;';

interface Posted {
  body: any;
}

async function openPage(
  browser: Browser,
  options: BrowserContextOptions,
  init: string,
  posted: Posted[],
  withSession = false,
) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.addInitScript({ content: WS_STUB });
  await page.addInitScript({ content: init });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'csrf-x' } }),
  );
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/sessions**', (r) =>
    r.fulfill({ json: { board: { waiting: [], working: withSession ? [PANEL_SESSION] : [], done: [] } } }),
  );
  if (withSession) {
    await page.route(/\/api\/dashboard\/session\/[^/?]+\/(artifacts|worklog)/, (r) =>
      r.fulfill({ json: { artifacts: [], entries: [], hasMore: false } }),
    );
    await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) =>
      r.fulfill({ json: { id: 'conv-1', title: 'conv-1', turnCount: 0, turns: [], hasMore: false } }),
    );
  }
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
async function composerView(page: Page, id = 'nt-composer') {
  return page.evaluate((cid) => {
    const el = document.getElementById(cid) as any;
    const root = el.shadowRoot || el;
    const bar = (root.querySelector('.cp-tools') as HTMLElement | null)?.getBoundingClientRect();
    // The row's other end, by what it draws: the leftmost of its visible children.
    const endKids = Array.from(root.querySelectorAll('.cp-end > *'))
      .map((k: any) => k.getBoundingClientRect())
      .filter((r: DOMRect) => r.width > 0);
    const end = endKids.length ? { left: Math.min(...endKids.map((r: DOMRect) => r.left)) } : null;
    const tools = Array.from(root.querySelectorAll('.cp-tools button')).map((b: any) => {
      const r = b.getBoundingClientRect();
      return {
        mk: b.getAttribute('data-mk'),
        pressed: b.getAttribute('aria-pressed'),
        label: b.getAttribute('aria-label') || b.textContent.trim(),
        // Fully in view: drawn, and not cut by the tool row (it hides what overflows).
        inView: !!bar && r.width > 0 && r.left >= bar.left - 1 && r.right <= bar.right + 1,
        // Clear of the row's other end (the counter, the key hint, 작업 시작).
        clear: !end || r.right <= end.left + 1,
      };
    });
    const err = document.getElementById('nt-error') as HTMLElement | null;
    return {
      tools,
      value: String(el.value || ''),
      status: document.getElementById('nt-status')?.textContent || '',
      error: err && !err.hidden ? err.textContent || '' : '',
    };
  }, id);
}

async function openComposer(page: Page) {
  await page.evaluate(() => (window as any).openNewTask());
  await page.waitForFunction(() => (window as any)._ntCtx, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function pressDictate(page: Page, id = 'nt-composer') {
  await page.evaluate((cid) => {
    const el = document.getElementById(cid) as any;
    const root = el.shadowRoot || el;
    (root.querySelector('[data-mk="tool:dictate"]') as HTMLElement).click();
  }, id);
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
    const dict = v.tools.find((t) => t.mk === 'tool:dictate');
    check(
      `${tag}: the voice note stays and 받아쓰기 sits beside it, fully in view`,
      mks.includes('voice') && !!dict && dict.inView && dict.clear && dict.label === '받아쓰기',
      JSON.stringify(v.tools),
    );
    // SSOT_4/5: Apple's engine (WebKit — on the device) and a phone's own recogniser (Android: Chrome, Samsung
    // Internet) open listening with the dialog. Desktop Chromium (no on-device Korean here) opens off and quiet, and
    // its first press listens — no second press, no question.
    const apple = await page.evaluate(() => (window as any).ntIsAppleSpeech(window));
    const android = await page.evaluate(() => (window as any).ntIsAndroid(window));
    const opened = await page.evaluate(() => (window as any).__recs.length);
    if (apple || android) {
      check(
        `${tag}: ${apple ? 'Apple’s engine' : 'the phone’s recogniser'} — the new task opens listening`,
        opened === 1 &&
          dict?.pressed === 'true' &&
          v.status.includes('키보드로 쓰면 멈춥니다') &&
          (apple || v.status.includes('이 휴대폰의 음성 인식')),
        `recs=${opened} · pressed=${dict?.pressed} · ${v.status}`,
      );
    } else {
      check(
        `${tag}: off the device — it opens off, saying nothing`,
        opened === 0 && dict?.pressed === 'false' && !v.status.includes('기기 밖'),
        `recs=${opened} · ${v.status}`,
      );
      await pressDictate(page);
      const said = (await composerView(page)).status;
      const firstMade = await page.evaluate(() => (window as any).__recs.length);
      check(
        `${tag}: off the device, the first press listens and says where the words go`,
        firstMade === 1 && said.includes('기기 밖') && said.includes('듣는 중'),
        `recs=${firstMade} · ${said}`,
      );
    }
    const rec = await page.evaluate(() => {
      const r = (window as any).__recs[0];
      return r ? { lang: r.lang, interim: r.interimResults, continuous: r.continuous, starts: r.starts } : null;
    });
    check(
      `${tag}: it listens with a ko-KR, interim recogniser — ${android ? 'one utterance per session (Android)' : 'continuous'}`,
      !!rec && rec.lang === 'ko-KR' && rec.interim && rec.continuous === !android && rec.starts === 1,
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
  // 1b) On the device it opens listening; a key typed stops it, and the typing goes on.
  {
    const { page, context } = await openPage(browser, options, FAKE_RECOGNISER, []);
    await openComposer(page);
    const opensListening = await page.evaluate(
      () => (window as any).ntIsAppleSpeech(window) || (window as any).ntIsAndroid(window),
    );
    if (opensListening) {
      await page.evaluate(() => (window as any).__say([['말하다가', false]]));
      await page.evaluate(() => {
        const el = document.getElementById('nt-composer') as any;
        const ta = (el.shadowRoot || el).querySelector('textarea') as HTMLTextAreaElement;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
      await page.keyboard.type(' 타자');
      await page.evaluate(() => (window as any).__say([['말하다가 늦은 말', true]]));
      await page.waitForTimeout(100);
      const v = await composerView(page);
      const aborts = await page.evaluate(() => (window as any).__recs[0].aborts);
      const pressed = v.tools.find((t) => t.mk === 'tool:dictate')?.pressed;
      check(
        `${tag}: a key typed stops it and the typing goes on`,
        aborts === 1 && v.value === '말하다가 타자' && pressed === 'false',
        `${v.value} · aborts=${aborts} · pressed=${pressed}`,
      );
    }
    await context.close();
  }
  // 2) A dashboard task (no attachments) gets the same tool.
  {
    const { page, context } = await openPage(browser, options, FAKE_RECOGNISER, []);
    await openComposer(page);
    // Switch the destination in the middle of a dictation (a repaint of the composer): the words stay and go on.
    // (On the device the dialog opened listening already — SSOT_4.)
    if (!(await page.evaluate(() => (window as any).ntDictating('nt')))) await pressDictate(page);
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
    check(
      `${tag}: no recogniser — the voice note only, no 받아쓰기`,
      mks.includes('voice') && !mks.includes('tool:dictate'),
      mks.join(','),
    );
    await page.screenshot({ path: path.join(OUT, `${engine}-${label}-no-recogniser.png`) });
    await context.close();
  }
  // 4) The session panel composer: voice note + 받아쓰기; dictating writes into it.
  {
    const { page, context } = await openPage(browser, options, FAKE_RECOGNISER, [], true);
    await page.evaluate((k) => (window as any).openPanel(k), PANEL_KEY);
    await page.waitForSelector('#pc-composer', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(600);
    let v = await composerView(page, 'pc-composer');
    const mks = v.tools.map((t) => t.mk);
    const dict = v.tools.find((t) => t.mk === 'tool:dictate');
    check(
      `${tag}: session panel — the voice note stays and 받아쓰기 sits beside it`,
      mks.includes('voice') && !!dict && dict.inView && dict.clear,
      JSON.stringify(v.tools),
    );
    await pressDictate(page, 'pc-composer');
    await page.evaluate(() => (window as any).__say([['세션에 보낼 말', false]]));
    v = await composerView(page, 'pc-composer');
    const pressed = v.tools.find((t) => t.mk === 'tool:dictate')?.pressed;
    check(
      `${tag}: session panel — 받아쓰기 writes into the panel composer while it listens`,
      v.value === '세션에 보낼 말' && pressed === 'true',
      `${v.value} · pressed=${pressed}`,
    );
    await page.screenshot({ path: path.join(OUT, `${engine}-${label}-panel-listening.png`) });
    await context.close();
  }
  // 5) A recogniser error lands on the red error line, not the small status line; on a Galaxy it names what to turn on.
  {
    const { page, context } = await openPage(browser, options, FAKE_RECOGNISER, []);
    await openComposer(page);
    if (!(await page.evaluate(() => (window as any).ntDictating('nt')))) await pressDictate(page);
    const android = await page.evaluate(() => (window as any).ntIsAndroid(window));
    await page.evaluate(() => (window as any).__err('service-not-allowed'));
    await page.evaluate(() => (window as any).__end());
    await page.waitForTimeout(100);
    let v = await composerView(page);
    check(
      `${tag}: a recogniser error shows on the red error line${android ? ' — Google’s speech app named' : ''}`,
      !!v.error && v.status === '' && (!android || v.error.includes('Google 음성 인식 및 합성')),
      `${v.error} · status=${v.status}`,
    );
    await page.screenshot({ path: path.join(OUT, `${engine}-${label}-error.png`) });
    // The next press clears it and listens.
    await pressDictate(page);
    v = await composerView(page);
    check(
      `${tag}: the next press clears the error and listens`,
      v.error === '' && v.status.includes('듣는 중'),
      `${v.error} · ${v.status}`,
    );
    // Speech heard, no words back, three times (Samsung Internet showing listening with no text): said plainly.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (window as any).__speech());
      await page.evaluate(() => (window as any).__end());
    }
    await page.waitForTimeout(100);
    v = await composerView(page);
    check(
      `${tag}: speech heard but no words back — the red line says so, not "들리지 않아"`,
      v.error.includes('글자를 돌려주지 않습니다') && !v.status.includes('들리지 않아'),
      `${v.error} · status=${v.status}`,
    );
    await page.screenshot({ path: path.join(OUT, `${engine}-${label}-no-words.png`) });
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
        // Samsung Internet on a Galaxy (Chromium underneath, its own user agent).
        if (name === 'chromium')
          await run(browser, name, 'samsung', {
            ...devices['Galaxy S9+'],
            userAgent: SAMSUNG_UA,
            colorScheme: 'light',
          });
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
