/**
 * Dashboard "New task" — browser receipts and assertions (SSOT 2026-10-23).
 *
 * The real web server serves the real dashboard page; the composer's two API
 * calls (context + launch) and the board are mocked in the browser, the
 * WebSocket is a stub. Exit 1 on any failed check; screenshots are written for
 * every scenario.
 *
 *   PC (Chromium + WebKit, 1280 / 820, dark + light):
 *     - the New task button sits in the top bar, animated (sheen + pulse), the
 *       page never scrolls sideways;
 *     - N opens the composer; the dialog is centered and ≤ 720px wide; the
 *       camera button is hidden (no capture on desktop), file + mic shown;
 *     - typing, toggling autoz, attaching a file and pasting a screenshot,
 *       then ⌘/Ctrl+Enter posts exactly the payload the server validates and
 *       shows the launch toast;
 *     - the floating button appears once the top-bar button scrolls away.
 *   Phone (iPhone 13 on WebKit, Pixel 7 on Chromium, 390 / 412 wide):
 *     - the top-bar button is hidden, the floating button sits in the thumb
 *       zone above the home indicator, ≥ 44px;
 *     - the composer is a full-screen sheet; config chips stay on one
 *       scrollable row; camera, file, mic and 작업 시작 are reachable and
 *       ≥ 44px; the instruction text is 16px (no iOS zoom);
 *     - the battery shows the selected model's level and changes with it.
 *   Reduced motion: no button / FAB animation.
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-new-task.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, type BrowserContextOptions, chromium, devices, type Page, webkit } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'new-task');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CONVERSATION_VIEWER_PORT || '33919';
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

/** The launch toast as laid out: on-screen box, how many lines its message takes, action heights. */
async function toastLayout(page: Page) {
  await page.waitForTimeout(400); // past the 320ms entry animation
  return page.evaluate(() => {
    const toast = document.getElementById('nt-toast') as HTMLElement;
    const text = toast.querySelector('.nt-toast-text') as HTMLElement;
    const box = toast.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(text);
    const tops = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
    const actions = Array.from(toast.querySelectorAll('a, button')).map((el) =>
      Math.round(el.getBoundingClientRect().height),
    );
    return {
      lines: tops.size,
      left: Math.round(box.left),
      right: Math.round(box.right),
      width: Math.round(box.width),
      viewport: window.innerWidth,
      actions,
    };
  });
}

const NOW = Date.now();
const CONTEXT = {
  models: [
    {
      nickname: 'opus[1m]',
      model: 'claude-opus-5-5[1m]',
      label: 'Opus 5.5 (1M)',
      battery: {
        level: 0.72,
        best: 0.9,
        windows: [
          { label: '5h', remaining: 0.9 },
          { label: '7d', remaining: 0.76 },
          { label: '7d-opus', remaining: 0.72 },
        ],
        accounts: { measured: 3, total: 3, available: 3 },
      },
    },
    {
      nickname: 'fable[1m]',
      model: 'claude-fable-5-1[1m]',
      label: 'Fable 5.1 (1M)',
      battery: {
        level: 0.14,
        best: 0.3,
        windows: [{ label: '7d-fable', remaining: 0.14 }],
        accounts: { measured: 3, total: 3, available: 1 },
      },
    },
    {
      nickname: 'sol[1m]',
      model: 'gpt-5.6-sol[1m]',
      label: 'GPT-5.6 Sol (1M)',
      battery: { level: null, best: null, windows: [], accounts: { measured: 0, total: 0, available: 0 } },
    },
  ],
  defaultModel: 'opus[1m]',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'xhigh',
  channels: [
    { id: 'C_ALPHA', name: 'workspace-alpha', repos: ['2lab-ai/soma-work'] },
    { id: 'C_SOMA', name: 'soma', repos: ['2lab-ai/soma'] },
    { id: 'C_LIB', name: 'libsoma', repos: ['2lab-ai/libsoma'] },
  ],
  defaultChannelId: 'C_ALPHA',
  membershipUnknown: false,
  autogoalDefault: true,
  usage: { scope: 'shared-pool', source: 'llmux', fetchedAt: NOW - 60_000 },
  limits: { maxPromptChars: 12000, maxFiles: 10, maxFileBytes: 20971520, maxTotalBytes: 31457280 },
};

const WS_STUB = [
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
].join('\n');

/** 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Posted {
  body: any;
  headers: Record<string, string>;
}

async function openPage(browser: Browser, options: BrowserContextOptions, posted: Posted[]): Promise<Page> {
  const context = await browser.newContext(options);
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
    posted.push({ body: JSON.parse(r.request().postData() || '{}'), headers: r.request().headers() });
    await r.fulfill({
      json: {
        ok: true,
        channel: 'C_ALPHA',
        threadTs: '1792735000.000100',
        sessionKey: 'C_ALPHA:1792735000.000100',
        permalink: 'https://slack.example/archives/C_ALPHA/p1792735000000100',
        status: 'running',
      },
    });
  });
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForSelector('#new-task-btn', { state: 'attached' });
  return page;
}

async function noSideScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function pcChecks(browser: Browser, engine: string) {
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [1280, 820]) {
      const posted: Posted[] = [];
      const page = await openPage(browser, { viewport: { width, height: 860 }, colorScheme: theme }, posted);
      await page.evaluate((t) => {
        localStorage.setItem('soma-theme', t);
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      const tag = `${engine}-pc-${width}-${theme}`;
      const btn = await page.locator('#new-task-btn').boundingBox();
      check(
        `${tag}: New task button visible in the top bar`,
        !!btn && btn.y < 60 && btn.height >= 30,
        JSON.stringify(btn),
      );
      const anim = await page.evaluate(() => {
        const el = document.getElementById('new-task-btn') as HTMLElement;
        return {
          pulse: getComputedStyle(el).animationName,
          sheen: getComputedStyle(el, '::before').animationName,
        };
      });
      check(
        `${tag}: button animates (pulse + rotating sheen)`,
        /nt-pulse/.test(anim.pulse) && /nt-sheen/.test(anim.sheen),
        JSON.stringify(anim),
      );
      check(
        `${tag}: FAB hidden while the top-bar button is in view`,
        !(await page.locator('#new-task-fab').isVisible()),
      );
      check(`${tag}: no sideways page scroll`, await noSideScroll(page));
      await page.screenshot({ path: path.join(OUT, `${tag}-topbar.png`), clip: { x: 0, y: 0, width, height: 140 } });

      // N opens the composer.
      await page.keyboard.press('n');
      await page.waitForSelector('#nt-dialog[open].is-shown');
      await page.waitForFunction(() => (document.getElementById('nt-channel') as HTMLSelectElement).options.length > 0);
      await page.waitForTimeout(320);
      const dlg = await page.locator('#nt-dialog').boundingBox();
      check(
        `${tag}: N opens a centered dialog ≤ 720px`,
        !!dlg && dlg.width <= 722 && Math.abs(dlg.x + dlg.width / 2 - width / 2) < 4,
        JSON.stringify(dlg),
      );
      check(`${tag}: camera hidden on PC`, !(await page.locator('#nt-camera').isVisible()));
      check(
        `${tag}: file + mic shown`,
        (await page.locator('#nt-attach').isVisible()) && (await page.locator('#nt-mic').isVisible()),
      );
      const defaults = await page.evaluate(() => ({
        model: (document.getElementById('nt-model') as HTMLSelectElement).value,
        effort: (document.getElementById('nt-effort') as HTMLSelectElement).value,
        channel: (document.getElementById('nt-channel') as HTMLSelectElement).value,
        autogoal: document.getElementById('nt-autogoal')?.getAttribute('aria-pressed'),
        autoz: document.getElementById('nt-autoz')?.getAttribute('aria-pressed'),
        pct: document.getElementById('nt-battery-pct')?.textContent,
      }));
      check(
        `${tag}: defaults = user settings (opus[1m] · xhigh · #workspace-alpha · autogoal on · autoz off · 72%)`,
        defaults.model === 'opus[1m]' &&
          defaults.effort === 'xhigh' &&
          defaults.channel === 'C_ALPHA' &&
          defaults.autogoal === 'true' &&
          defaults.autoz === 'false' &&
          defaults.pct === '72%',
        JSON.stringify(defaults),
      );
      await page.screenshot({ path: path.join(OUT, `${tag}-composer.png`) });

      await page.fill('#nt-prompt', 'soma-work 대시보드 개선해줘\n블라블라블라');
      await page.click('#nt-autoz');
      await page.setInputFiles('#nt-file-input', {
        name: 'spec.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('spec'),
      });
      // Paste a screenshot into the instruction field.
      await page.evaluate((b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        document.getElementById('nt-prompt')?.dispatchEvent(ev);
      }, PNG.toString('base64'));
      await page.waitForFunction(() => document.querySelectorAll('#nt-attachments .nt-att').length === 2);
      await page.selectOption('#nt-model', 'fable[1m]');
      const low = await page.evaluate(() => ({
        cls: document.getElementById('nt-battery-btn')?.className,
        pct: document.getElementById('nt-battery-pct')?.textContent,
      }));
      check(
        `${tag}: battery follows the model (fable → 14%, low)`,
        low.pct === '14%' && /nt-batt-low/.test(low.cls || ''),
        JSON.stringify(low),
      );
      await page.screenshot({ path: path.join(OUT, `${tag}-filled.png`) });

      await page.focus('#nt-prompt');
      await page.keyboard.press(engine === 'webkit' ? 'Meta+Enter' : 'Control+Enter');
      await page.waitForSelector('#nt-toast:not([hidden])');
      const sent = posted[0]?.body;
      check(
        `${tag}: ⌘/Ctrl+Enter posts the task (autoz on, 2 files, CSRF header)`,
        !!sent &&
          sent.prompt === 'soma-work 대시보드 개선해줘\n블라블라블라' &&
          sent.model === 'fable[1m]' &&
          sent.autoz === true &&
          sent.autogoal === true &&
          sent.channelId === 'C_ALPHA' &&
          sent.attachments?.length === 2 &&
          /^screenshot-/.test(sent.attachments[1].name) &&
          typeof sent.requestId === 'string' &&
          posted[0].headers['x-csrf-token'] === 'csrf-x',
        JSON.stringify({ ...sent, attachments: sent?.attachments?.map((a: any) => a.name) }),
      );
      await page.waitForTimeout(300);
      check(`${tag}: composer closes after launch`, !(await page.locator('#nt-dialog').isVisible()));
      const pcToast = await toastLayout(page);
      check(
        `${tag}: launch toast reads on one line, on screen`,
        pcToast.lines === 1 && pcToast.left >= 0 && pcToast.right <= pcToast.viewport,
        JSON.stringify(pcToast),
      );
      await page.screenshot({ path: path.join(OUT, `${tag}-toast.png`) });

      // Scrolling the top bar away brings the floating button.
      await page.evaluate(() => {
        document.body.style.minHeight = '3000px';
        window.scrollTo(0, 1200);
      });
      const floated = await page
        .waitForSelector('#new-task-fab', { state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      check(`${tag}: floating button appears once the top bar scrolls away`, floated);
      await page.context().close();
    }
  }
}

async function phoneChecks(browser: Browser, engine: string, device: string) {
  const posted: Posted[] = [];
  const page = await openPage(browser, { ...devices[device] }, posted);
  const tag = `${engine}-phone-${device.replace(/\s+/g, '-').toLowerCase()}`;
  const vw = await page.evaluate(() => window.innerWidth);
  const vh = await page.evaluate(() => window.innerHeight);
  check(`${tag}: top-bar button hidden`, !(await page.locator('#new-task-btn').isVisible()));
  await page.waitForTimeout(700); // the FAB's entrance (scale 0.6 → 1) is over
  const fab = await page.locator('#new-task-fab').boundingBox();
  check(
    `${tag}: FAB in the thumb zone (bottom-right, ≥ 44px)`,
    !!fab && fab.height >= 44 && fab.x + fab.width > vw - 40 && fab.y + fab.height > vh - 120,
    JSON.stringify(fab),
  );
  check(`${tag}: no sideways page scroll`, await noSideScroll(page));
  await page.screenshot({ path: path.join(OUT, `${tag}-board.png`) });

  await page.locator('#new-task-fab').tap();
  await page.waitForSelector('#nt-dialog[open].is-shown');
  await page.waitForFunction(() => (document.getElementById('nt-channel') as HTMLSelectElement).options.length > 0);
  await page.waitForTimeout(420);
  const sheet = await page.locator('#nt-dialog').boundingBox();
  check(
    `${tag}: composer is a full-screen sheet`,
    !!sheet && Math.abs(sheet.width - vw) < 2 && sheet.height >= vh - 2 && Math.abs(sheet.y) < 2,
    JSON.stringify(sheet),
  );
  const targets = await page.evaluate(() =>
    ['nt-camera', 'nt-attach', 'nt-mic', 'nt-submit', 'nt-autogoal', 'nt-autoz'].map((id) => {
      const el = document.getElementById(id) as HTMLElement;
      const r = el.getBoundingClientRect();
      return {
        id,
        w: Math.round(r.width),
        h: Math.round(r.height),
        bottom: Math.round(r.bottom),
        visible: r.width > 0,
      };
    }),
  );
  check(
    `${tag}: camera / file / mic / 작업 시작 / toggles visible, ≥ 44px, inside the screen`,
    targets.every((t) => t.visible && t.h >= 44 && t.bottom <= vh + 1),
    JSON.stringify(targets),
  );
  const font = await page.evaluate(
    () => getComputedStyle(document.getElementById('nt-prompt') as HTMLElement).fontSize,
  );
  check(`${tag}: instruction text is 16px (no iOS zoom)`, font === '16px', font);
  const camera = await page.evaluate(() => {
    const el = document.getElementById('nt-camera-input') as HTMLInputElement;
    return { accept: el.accept, capture: el.getAttribute('capture') };
  });
  check(
    `${tag}: camera input opens the rear camera`,
    camera.accept === 'image/*' && camera.capture === 'environment',
    JSON.stringify(camera),
  );
  const chips = await page.evaluate(() => {
    const row = document.querySelector('.nt-config') as HTMLElement;
    const kids = Array.from(row.children).map((c) => (c as HTMLElement).getBoundingClientRect().top);
    return { oneRow: kids.every((t) => Math.abs(t - kids[0]) < 2), scrollable: row.scrollWidth >= row.clientWidth };
  });
  check(
    `${tag}: model · effort · channel on one scrollable row`,
    chips.oneRow && chips.scrollable,
    JSON.stringify(chips),
  );
  await page.screenshot({ path: path.join(OUT, `${tag}-sheet.png`) });

  await page.fill('#nt-prompt', '사진 보고 버그 고쳐줘');
  await page.setInputFiles('#nt-camera-input', { name: 'image.jpg', mimeType: 'image/jpeg', buffer: PNG });
  await page.waitForFunction(() => document.querySelectorAll('#nt-attachments .nt-att').length === 1);
  const photoName = await page.locator('#nt-attachments .nt-att-name').first().textContent();
  check(
    `${tag}: a camera shot is attached with a dated name`,
    /^photo-\d{8}-\d{6}\.jpg$/.test(photoName || ''),
    photoName || '',
  );
  await page.waitForTimeout(400); // the chip's entry and the button's enable transition settle
  await page.screenshot({ path: path.join(OUT, `${tag}-sheet-filled.png`) });
  await page.locator('#nt-submit').tap();
  await page.waitForSelector('#nt-toast:not([hidden])');
  check(`${tag}: 작업 시작 posts the task`, posted.length === 1 && posted[0].body.attachments.length === 1);
  const phoneToast = await toastLayout(page);
  check(
    `${tag}: launch toast message ≤ 2 lines, inside the screen, actions ≥ 44px`,
    phoneToast.lines <= 2 &&
      phoneToast.left >= 0 &&
      phoneToast.right <= phoneToast.viewport &&
      phoneToast.width >= phoneToast.viewport * 0.6 &&
      phoneToast.actions.length > 0 &&
      phoneToast.actions.every((h) => h >= 44),
    JSON.stringify(phoneToast),
  );
  await page.screenshot({ path: path.join(OUT, `${tag}-toast.png`) });
  await page.context().close();
}

async function reducedMotion(browser: Browser, engine: string) {
  const page = await openPage(browser, { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }, []);
  const names = await page.evaluate(() => ({
    btn: getComputedStyle(document.getElementById('new-task-btn') as HTMLElement).animationName,
    sheen: getComputedStyle(document.getElementById('new-task-btn') as HTMLElement, '::before').animationName,
  }));
  check(
    `${engine}: reduced motion stops the button animations`,
    names.btn === 'none' && names.sheen === 'none',
    JSON.stringify(names),
  );
  await page.context().close();
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
        await pcChecks(browser, name);
        await phoneChecks(browser, name, name === 'webkit' ? 'iPhone 13' : 'Pixel 7');
        await reducedMotion(browser, name);
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
