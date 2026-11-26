/**
 * The detail card's 산출물 tab shows previews, like the open task card (owner 2026-11-26) — browser receipts on the
 * real dashboard page.
 *
 * The real web server serves the real page and the installed @2lab.ai/ui; the board JSON, the conversation, the
 * artifact list and the artifact bytes are browser routes and the WebSocket is a stub, so every run is the same.
 * Every check prints what it judged (variants, rows, widths), never a bare boolean.
 *
 *   A1  the open task card (▽ — the reference): its 산출물 are preview tiles
 *   A2  the detail card's 산출물 tab in the default layout (처음부터 펼침 off): every file is a preview tile too — no
 *       name chip — and an image shows its own picture
 *   A3  a tall panel body: a grid that shows every file without sideways scrolling, tiles at least the open card's width
 *   A4  a short panel body (a phone held sideways): still preview tiles, one row that scrolls sideways
 *   A5  no sideways page scroll with the tab open
 *   A6  an opening on 산출물 (the open card's 전체 N개 →) lands on the tab bar: the open tab and the first tiles in view
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-artifacts-tab.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'artifacts-tab');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.ARTIFACTS_TAB_PORT || '33941';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NOW = Date.now();
const M = 60_000;
const KEY = 'mock-inst::work:C601:1700000000.000100';
const CID = 'conv-C601';

const art = (id: string, name: string, kind: string, mime: string, size: number, ago: number) => ({
  id,
  name,
  kind,
  mime,
  size,
  stored: true,
  source: 'slack_upload',
  createdAt: NOW - ago * M,
});
const ARTS = [
  art('A1', 'login-fixed.png', 'image', 'image/png', 182_000, 2),
  art('A2', 'report.html', 'html', 'text/html', 48_211, 4),
  art('A3', 'design-notes.md', 'markdown', 'text/markdown', 6_400, 6),
  art('A4', 'before-after.png', 'image', 'image/png', 176_000, 8),
  art('A5', 'guide-v3.pdf', 'pdf', 'application/pdf', 2_200_000, 10),
  art('A6', 'summary.txt', 'text', 'text/plain', 1_200, 12),
];
const BOARD = {
  waiting: [],
  working: [],
  idle: [
    {
      key: KEY,
      title: '로그인 버튼 잘림 수정',
      displayHeadline: '로그인 버튼 잘림 수정',
      summaryTitle: '로그인 버튼 잘림 수정',
      summaryBody: '모바일에서 잘리는 로그인 버튼을 고치고 결과 파일을 올렸다.',
      ownerId: 'U001',
      ownerName: 'Zhuge',
      workflow: 'zwork',
      model: 'claude-opus-5-5[1m]',
      effort: 'high',
      channelId: 'C601',
      sessionState: 'MAIN',
      activityState: 'idle',
      conversationId: CID,
      lastActivity: new Date(NOW - 2 * M).toISOString(),
      slackThreadUrl: 'https://slack.example/archives/C601/p1700000000000',
      tokenUsage: { totalInputTokens: 300_000, totalOutputTokens: 40_000, totalCostUsd: 6.2, contextUsagePercent: 22 },
      artifacts: { count: ARTS.length, recent: ARTS.slice(0, 4) },
      tasks: [],
    },
  ],
};
const TURNS = [
  {
    id: 'u1',
    role: 'user',
    timestamp: new Date(NOW - 20 * M).toISOString(),
    userName: 'Zhuge',
    rawContent: '로그인 버튼 잘림 고쳐줘',
    origin: { by: 'user' },
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: new Date(NOW - 2 * M).toISOString(),
    summaryTitle: '수정 완료',
    summaryBody: '파일 6개를 올렸습니다.',
    summarized: true,
  },
];

const PAGE_HELPERS = [
  'window.__card = function (k) { var h = document.getElementById("kanban"); var r = h && h.shadowRoot; var all = r ? r.querySelectorAll("li.ib-card[data-card]") : []; for (var i = 0; i < all.length; i++) if (all[i].getAttribute("data-card") === k) return all[i]; return null; };',
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
  'window.__name = function (f) { return f; };',
].join('\n');

async function makeImages(browser: Browser): Promise<Record<string, Buffer>> {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 300 } });
  const page = await ctx.newPage();
  const shot = async (html: string) => {
    await page.setContent(html);
    return page.screenshot();
  };
  const base =
    'body{margin:0;font:18px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:300px}';
  const out = {
    A1: await shot(
      `<style>${base} body{background:#eef4ff} button{padding:14px 40px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:20px}</style><button>로그인하기 — 계속</button>`,
    ),
    A4: await shot(
      `<style>${base} body{background:linear-gradient(90deg,#fde2e2 50%,#dcfce7 50%);gap:60px} b{font-size:28px}</style><b>before</b><b>after</b>`,
    ),
  };
  await ctx.close();
  return out;
}

async function installMocks(page: Page, images: Record<string, Buffer>) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'x' } }),
  );
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: BOARD } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts\/[^/]+\/content/, (r) => {
    const id = decodeURIComponent(r.request().url().split('/artifacts/')[1].split('/')[0]);
    if (images[id]) return r.fulfill({ body: images[id], contentType: 'image/png' });
    return r.fulfill({ body: Buffer.from('# notes\n\nline\n'), contentType: 'text/plain; charset=utf-8' });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts(\?.*)?$/, (r) =>
    r.fulfill({ json: { artifacts: ARTS } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/media(\?.*)?$/, (r) => r.fulfill({ json: { media: [] } }));
  await page.route(/\/api\/conversations\/[^/]+\/turns\/[^/]+\/raw/, (r) =>
    r.fulfill({
      json: { raw: '로그인 버튼이 모바일에서 잘리던 원인(flex 축소)을 고치고, 결과 파일 6개를 올렸습니다.' },
    }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog/, (r) =>
    r.fulfill({ json: { entries: [], hasMore: false } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    const cid = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    return r.fulfill({
      json: { id: cid, title: cid, titleSub: '', turnCount: TURNS.length, turns: TURNS, hasMore: false },
    });
  });
}

const failures: string[] = [];
const report: string[] = [];
function log(line: string) {
  report.push(line);
  console.log(line);
}
function check(ok: boolean, what: string, detail?: unknown) {
  log(`${ok ? '[ok]  ' : '[FAIL]'} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(what);
}

type CardInfo = { variant: string; thumb: boolean; picture: boolean; name: string; w: number; top: number };
/** Every <ui-file-card> under a root: its variant, its thumbnail (and whether that holds a loaded picture), its box. */
function cardsUnder(page: Page, selector: string): Promise<CardInfo[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const cards = root ? (Array.from(root.querySelectorAll('ui-file-card')) as HTMLElement[]) : [];
    return cards.map((c) => {
      const sr = c.shadowRoot;
      const thumb = sr?.querySelector('.fc-thumb') as HTMLElement | null;
      const img = thumb?.querySelector('img') as HTMLImageElement | null;
      const box = c.getBoundingClientRect();
      return {
        variant: c.getAttribute('variant') || '',
        thumb: !!thumb,
        picture: !!(img?.complete && img.naturalWidth > 0),
        name: (sr?.querySelector('.fc-name') as HTMLElement | null)?.textContent || '',
        w: Math.round(box.width),
        top: Math.round(box.top),
      };
    });
  }, selector);
}

async function run(
  browser: Browser,
  images: Record<string, Buffer>,
  w: number,
  h: number,
  theme: 'light' | 'dark',
): Promise<void> {
  const tag = `${w}x${h}-${theme}`;
  log(`\n── ${tag}`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => check(false, `[${tag}] page error`, e.message));
  // The viewer token (CONVERSATION_VIEWER_TOKEN) as the dashboard's bearer cookie.
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await ctx.addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  await installMocks(page, images);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForFunction((k) => !!(window as any).__card(k), KEY, { timeout: 15000 });
  await page.waitForTimeout(400);

  // A1 — the reference: the open task card (▽), its 산출물 — 어드밴스드, whose open card lists them (미니멀's does not).
  if (w >= 600) {
    await page.evaluate(() => (window as any).setViewMode('advanced'));
    await page.waitForTimeout(300);
    await page.evaluate((k) => {
      const c = (window as any).__card(k) as HTMLElement;
      (c.querySelector('[data-win="expand"]') as HTMLElement).click();
    }, KEY);
    const openSel = `.card-slot[data-session-key="${KEY}"] .card-artifacts`;
    await page.waitForFunction((s) => document.querySelectorAll(`${s} ui-file-card`).length > 0, openSel, {
      timeout: 8000,
    });
    await page.waitForTimeout(700);
    const open = await cardsUnder(page, openSel);
    check(
      open.length > 0 && open.every((c) => c.variant === 'tile' && c.thumb),
      `[${tag}] A1 open card: preview tiles`,
      open.map((c) => `${c.name}:${c.variant}`),
    );
    await (await page.$(openSel))?.screenshot({ path: path.join(OUT, `open-card-${tag}.png`) });
    // Back to 미니멀 — its detail card does not open with 처음부터 펼침, the case the owner saw name chips in.
    await page.evaluate(() => (window as any).setViewMode('minimal'));
    await page.waitForTimeout(300);
  }

  // A2 — the detail card on its 산출물 tab (the open card's 전체 N개 → lands there).
  await page.evaluate((k) => (window as any).openPanel(k, 'artifacts'), KEY);
  await page.waitForFunction(() => document.querySelectorAll('#panel-artifacts ui-file-card').length >= 6, {
    timeout: 8000,
  });
  await page.waitForTimeout(900);
  const state = await page.evaluate(() => {
    const panel = document.getElementById('slide-panel');
    const body = document.querySelector('#slide-panel .panel-body') as HTMLElement | null;
    const strip = document.querySelector('#panel-artifacts .art-strip-panel') as HTMLElement | null;
    return {
      midtab: panel?.getAttribute('data-midtab') || '',
      detail: !!panel?.classList.contains('is-detail'),
      bodyH: body ? body.clientHeight : 0,
      sideways: strip ? strip.scrollWidth - strip.clientWidth : -1,
      display: strip ? getComputedStyle(strip).display : '',
      pageOver: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  check(state.midtab === 'artifacts' && !state.detail, `[${tag}] A2 the 산출물 tab, 처음부터 펼침 off`, state);
  // A6 — the opening lands on the tab bar: the open 산출물 tab and the first row of tiles are in view, not scrolled away
  // under the title bar toward the chat.
  const landed = await page.evaluate(() => {
    const sc = document.getElementById('panel-scroll') as HTMLElement;
    const tabBtn = document.querySelector('#panel-midbar .pm-tab[data-mid="artifacts"]') as HTMLElement | null;
    const first = document.querySelector('#panel-artifacts ui-file-card') as HTMLElement | null;
    const view = sc.getBoundingClientRect();
    const r = (el: HTMLElement | null) => (el ? el.getBoundingClientRect() : null);
    const t = r(tabBtn);
    const f = r(first);
    return {
      scrollTop: Math.round(sc.scrollTop),
      view: [Math.round(view.top), Math.round(view.bottom)],
      tab: t ? [Math.round(t.top), Math.round(t.bottom)] : null,
      firstTile: f ? [Math.round(f.top), Math.round(f.bottom)] : null,
      pressed: tabBtn?.getAttribute('aria-expanded') || '',
    };
  });
  const inView = (b: number[] | null) => !!b && b[0] >= landed.view[0] - 1 && b[1] <= landed.view[1] + 1;
  check(
    landed.pressed === 'true' && inView(landed.tab) && !!landed.firstTile && landed.firstTile[0] < landed.view[1],
    `[${tag}] A6 lands on the tab bar: the open 산출물 tab and the first tiles in view`,
    landed,
  );
  const tab = await cardsUnder(page, '#panel-artifacts');
  check(
    tab.length === ARTS.length && tab.every((c) => c.variant === 'tile' && c.thumb),
    `[${tag}] A2 every file a preview tile, no name chip`,
    tab.map((c) => `${c.name}:${c.variant}`),
  );
  const pics = tab.filter((c) => c.name.endsWith('.png'));
  check(
    pics.length === 2 && pics.every((c) => c.picture),
    `[${tag}] A2 the images show their own picture`,
    pics.map((c) => `${c.name}:${c.picture}`),
  );
  const rows = new Set(tab.map((c) => c.top)).size;
  if (state.bodyH > 560) {
    check(state.sideways <= 1 && rows > 1, `[${tag}] A3 tall body: a grid — every file without sideways scrolling`, {
      bodyH: state.bodyH,
      rows,
      sideways: state.sideways,
    });
    check(
      tab.every((c) => c.w >= 128),
      `[${tag}] A3 tiles at least the open card's 128px`,
      tab.map((c) => c.w),
    );
  } else {
    check(rows === 1 && state.sideways > 0, `[${tag}] A4 short body: one row of previews that scrolls sideways`, {
      bodyH: state.bodyH,
      rows,
      sideways: state.sideways,
    });
  }
  check(state.pageOver <= 0, `[${tag}] A5 no sideways page scroll`, state.pageOver);
  await page.screenshot({ path: path.join(OUT, `detail-tab-${tag}.png`) });
  await (await page.$('#panel-artifacts'))?.screenshot({ path: path.join(OUT, `detail-tab-section-${tag}.png`) });
  await ctx.close();
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  try {
    const postures: Array<[number, number, 'light' | 'dark']> = [
      [1440, 900, 'light'],
      [1440, 900, 'dark'],
      [390, 844, 'light'],
      [844, 390, 'light'],
    ];
    // Single-process Chromium (a sandboxed agent shell cannot register its Mach port for child processes) holds one
    // context per browser: a browser per run.
    let images: Record<string, Buffer> = {};
    {
      const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
      try {
        images = await makeImages(browser);
      } finally {
        await browser.close();
      }
    }
    for (const [w, h, theme] of postures) {
      const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
      try {
        await run(browser, images, w, h, theme);
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
