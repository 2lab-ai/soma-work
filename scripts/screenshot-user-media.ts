/**
 * User media (SSOT 2026-10-25) — browser receipts and assertions for the files a
 * user attached to an instruction.
 *
 * The real web server serves the real dashboard; the browser-side HTTP layer is
 * mocked (session turns with attachments, the media list and the media bytes) and
 * the WebSocket is a stub, so every scenario is deterministic.
 *
 * Asserts (exit 1 on any failure), with a screenshot for each:
 *   - card face: a paperclip count, and no <img> anywhere on the board
 *   - open card 지시 row: compact thumbnails above the words
 *   - panel user turn: files above the text — 80px image tiles with "+N" past four,
 *     file cards, a files-only turn without an empty text block
 *   - pinned 지시 첨부 row: one collapsed line, opens to the session's files
 *   - viewer: a tile opens the shared viewer on the media route; ←/→ page within
 *     that instruction; Escape closes and focus returns to the tile
 *   - 1440 / 390 × light / dark: no sideways page scroll with the panel open
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst DATA_DIR=$TMP/data npx tsx scripts/screenshot-user-media.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'user-media');
fs.mkdirSync(OUT, { recursive: true });

const NOW = Date.now();
const CID = 'conv-media';
const KEY = 'C123:1700000001.000001';

/** A screenshot-like image: the "broken login button" the instruction talks about. */
async function makeImages(browser: Browser): Promise<Record<string, Buffer>> {
  const page = await browser.newPage({ viewport: { width: 390, height: 560 } });
  const shot = async (html: string) => {
    await page.setContent(html);
    return page.screenshot();
  };
  const base =
    'body{margin:0;font:16px -apple-system,sans-serif;background:#f6f7f9;display:flex;flex-direction:column;align-items:center;gap:14px;padding:40px 24px}';
  const images = {
    login: await shot(
      `<style>${base} input{width:100%;padding:12px;border:1px solid #ccd;border-radius:8px}button{width:46%;padding:12px;border:0;border-radius:8px;background:#2563eb;color:#fff;white-space:nowrap;overflow:hidden;align-self:flex-start}</style><h2>로그인</h2><input placeholder="이메일"><input placeholder="비밀번호"><button>로그인하기 — 계속</button><p style="color:#c00">버튼이 잘림</p>`,
    ),
    expected: await shot(
      `<style>${base} input{width:100%;padding:12px;border:1px solid #ccd;border-radius:8px}button{width:100%;padding:12px;border:0;border-radius:8px;background:#2563eb;color:#fff}</style><h2>로그인</h2><input placeholder="이메일"><input placeholder="비밀번호"><button>로그인하기 — 계속</button><p style="color:#080">기대 화면</p>`,
    ),
    flow: await shot(
      `<style>${base} .b{width:100%;padding:16px;border-radius:10px;background:#fff;border:1px solid #dde}</style><div class="b">1. 앱 실행</div><div class="b">2. 로그인 탭</div><div class="b">3. 버튼 잘림 확인</div>`,
    ),
  };
  await page.close();
  return images;
}

const att = (id: string, name: string, kind: string, mime: string, size: number, stored = true, extra = {}) => ({
  id,
  name,
  kind,
  mime,
  size,
  stored,
  ...extra,
});

const T1_ATTS = [
  att('IMG1', 'login-broken.png', 'image', 'image/png', 182_000),
  att('IMG2', 'login-expected.png', 'image', 'image/png', 176_000),
  att('IMG3', 'repro-flow.png', 'image', 'image/png', 96_000),
  att('IMG4', 'iphone-se.png', 'image', 'image/png', 120_000),
  att('IMG5', 'galaxy-fold.png', 'image', 'image/png', 131_000),
  att('PDF1', '로그인-디자인-가이드-v3-final.pdf', 'pdf', 'application/pdf', 2_200_000),
  att('VOX1', 'voice-memo.m4a', 'audio', 'audio/mp4', 48_000),
  // Videos are downloaded (≤ 50 MB) and kept, so this one plays in the dashboard.
  att('MOV1', 'screen-recording.mp4', 'video', 'video/mp4', 38_000_000),
];
const T3_ATTS = [att('IMG6', 'after-fix.png', 'image', 'image/png', 150_000)];

const TURNS = [
  {
    id: 'u1',
    role: 'user',
    timestamp: NOW - 9 * 60_000,
    userName: 'Zhuge',
    rawContent: '이 스크린샷처럼 모바일에서 로그인 버튼이 잘려. 첨부한 디자인 가이드 PDF대로 고쳐줘',
    attachments: T1_ATTS,
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: NOW - 7 * 60_000,
    summaryTitle: '로그인 버튼 레이아웃 분석',
    summaryBody: '첨부 이미지 5장과 가이드를 읽고 flex 축소 원인을 찾았습니다.',
    summarized: true,
  },
  { id: 'u2', role: 'user', timestamp: NOW - 3 * 60_000, userName: 'Zhuge', rawContent: '', attachments: T3_ATTS },
];

async function setupServer() {
  const { setDashboardSessionAccessor } = await import('../src/conversation/dashboard');
  const sessions = new Map<string, Record<string, unknown>>();
  sessions.set(KEY, {
    ownerId: 'U001',
    ownerName: 'Zhuge',
    channelId: 'C123',
    threadTs: '1700000001.000001',
    sessionId: 'sess-1',
    conversationId: CID,
    title: '로그인 버튼 잘림 수정',
    model: 'claude-opus-4-6',
    state: 'MAIN',
    workflow: 'zwork',
    activityState: 'working',
    lastActivity: new Date(NOW - 60_000),
    links: {},
    usage: { totalInputTokens: 90000, totalOutputTokens: 20000, totalCostUsd: 1.2, contextWindow: 200000 },
  });
  setDashboardSessionAccessor(() => sessions as never);
  const { startWebServer, stopWebServer, getViewerBaseUrl } = await import('../src/conversation/web-server');
  await startWebServer({ listen: true });
  return { stopWebServer, baseUrl: getViewerBaseUrl().replace(/\/\/[^:/]+/, '//127.0.0.1') };
}

async function preparePage(page: Page, images: Record<string, Buffer>) {
  await page.addInitScript({
    content: 'window.WebSocket = function(u){this.url=u;}; window.WebSocket.prototype.close=function(){};',
  });
  const media = [
    ...T1_ATTS.map((a) => ({ ...a, turnId: 'u1', turnTs: TURNS[0].timestamp })),
    ...T3_ATTS.map((a) => ({ ...a, turnId: 'u2', turnTs: TURNS[2].timestamp })),
  ];
  // The board card carries the count the server derives from the store.
  await page.route('**/api/dashboard/sessions*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const col of Object.values(body.board || {}) as Array<Array<Record<string, unknown>>>) {
      for (const c of col) if (c.conversationId === CID) c.userMedia = { count: media.length };
    }
    await route.fulfill({ response: res, json: body });
  });
  await page.route(`**/api/dashboard/session/${CID}?*`, (r) =>
    r.fulfill({ json: { id: CID, turns: TURNS, hasMore: false } }),
  );
  await page.route(`**/api/dashboard/session/${CID}`, (r) =>
    r.fulfill({ json: { id: CID, turns: TURNS, hasMore: false } }),
  );
  await page.route(`**/api/dashboard/session/${CID}/artifacts`, (r) => r.fulfill({ json: { artifacts: [] } }));
  await page.route(`**/api/dashboard/session/${CID}/worklog*`, (r) =>
    r.fulfill({ json: { entries: [], hasMore: false } }),
  );
  await page.route(`**/api/dashboard/session/${CID}/media`, (r) => r.fulfill({ json: { media } }));
  const bytes: Record<string, Buffer> = {
    IMG1: images.login,
    IMG2: images.expected,
    IMG3: images.flow,
    IMG4: images.login,
    IMG5: images.expected,
    IMG6: images.expected,
  };
  await page.route(`**/api/dashboard/session/${CID}/media/*/content*`, (r) => {
    const id = r.request().url().split('/media/')[1].split('/')[0];
    if (bytes[id]) return r.fulfill({ body: bytes[id], contentType: 'image/png' });
    return r.fulfill({ body: Buffer.from('%PDF-1.4\n'), contentType: 'application/octet-stream' });
  });
}

type Check = { ok: boolean; msg: string };

async function run(
  browser: Browser,
  baseUrl: string,
  images: Record<string, Buffer>,
  width: number,
  theme: 'light' | 'dark',
) {
  const tag = `${width}-${theme}`;
  const checks: Check[] = [];
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: theme });
  await preparePage(page, images);
  page.on('pageerror', (e) => checks.push({ ok: false, msg: `page error: ${e.message}` }));
  await page.goto(`${baseUrl}/dashboard`);
  await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length > 0, { timeout: 15000 });
  await page.waitForTimeout(500);

  // Card face: a paperclip count only, no images on the board.
  const face = await page.evaluate(() => {
    const badge = document.querySelector('#kanban .card .um-face') as HTMLElement | null;
    return { text: badge?.innerText.trim() ?? '', imgs: document.querySelectorAll('#kanban img').length };
  });
  checks.push({ ok: face.text === '9', msg: `face paperclip count is 9 (got "${face.text}")` });
  checks.push({ ok: face.imgs === 0, msg: `board fetches no image (${face.imgs})` });
  await (await page.$('#kanban .card'))?.screenshot({ path: path.join(OUT, `face-${tag}.png`) });

  // The board keys a card by instance + session key: read it off the card.
  const boardKey = (await page.getAttribute('#kanban [data-session-key]', 'data-session-key')) as string;
  // Open card: the 지시 row carries compact thumbnails above the words.
  await page.evaluate(
    (k) => (window as unknown as { toggleCard(k: string, kb: boolean): void }).toggleCard(k, true),
    boardKey,
  );
  await page
    .waitForFunction(() => !!document.querySelector('#kanban .card .io-in .um-compact'), { timeout: 8000 })
    .catch(() => {});
  const io = await page.evaluate(() => {
    const row = document.querySelector('#kanban .card .io-in') as HTMLElement | null;
    const media = row?.querySelector('.um-compact');
    const text = row?.querySelector('.io-text');
    return {
      has: !!media,
      above: !!(media && text && media.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  });
  checks.push({ ok: io.has && io.above, msg: 'open card 지시 row shows its files above the words' });
  await (await page.$('#kanban .card'))?.screenshot({ path: path.join(OUT, `card-open-${tag}.png`) });

  // Panel.
  await page.evaluate((k) => (window as unknown as { openPanel(k: string): void }).openPanel(k), boardKey);
  await page.waitForFunction(() => document.querySelectorAll('#panel-turns .um-tile').length > 0, { timeout: 8000 });
  await page.waitForFunction(() => !!document.querySelector('#panel-user-media .panel-um-head'), { timeout: 8000 });
  await page.waitForTimeout(400);
  const panel = await page.evaluate(() => {
    const first = document.querySelector('#panel-turns .turn.user') as HTMLElement;
    const media = first.querySelector('.um-media') as HTMLElement;
    const text = first.querySelector('.turn-content') as HTMLElement;
    const tiles = Array.from(first.querySelectorAll('.um-img')) as HTMLElement[];
    const more = first.querySelector('.um-more') as HTMLElement | null;
    const second = document.querySelectorAll('#panel-turns .turn.user')[1] as HTMLElement;
    return {
      above: !!(media.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING),
      tiles: tiles.length,
      tileSize: tiles[0] ? Math.round(tiles[0].getBoundingClientRect().width) : 0,
      more: more?.innerText ?? '',
      cards: first.querySelectorAll('.um-file').length,
      filesOnlyText: second ? second.querySelectorAll('.turn-content').length : -1,
      pinnedCollapsed: document.querySelector('.panel-um-head')?.getAttribute('aria-expanded') === 'false',
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  checks.push({ ok: panel.above, msg: 'panel turn: files above the instruction text' });
  checks.push({
    ok: panel.tiles === 4 && panel.more === '+1',
    msg: `4 image tiles, "+1" on the 4th (${panel.tiles}, "${panel.more}")`,
  });
  checks.push({ ok: panel.tileSize === 80, msg: `image tile is 80px (${panel.tileSize})` });
  checks.push({ ok: panel.cards === 3, msg: `pdf, voice and video as file cards (${panel.cards})` });
  checks.push({ ok: panel.filesOnlyText === 0, msg: 'files-only turn has no empty text block' });
  checks.push({ ok: panel.pinnedCollapsed, msg: 'pinned 지시 첨부 row starts collapsed' });
  checks.push({ ok: panel.overflow <= 0, msg: `no sideways page scroll (${panel.overflow}px)` });
  await page.screenshot({ path: path.join(OUT, `panel-${tag}.png`) });
  // The first instruction with its image grid, framed on its own.
  const firstTurn = page.locator('#panel-turns .turn.user').first();
  await firstTurn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await firstTurn.screenshot({ path: path.join(OUT, `panel-turn-${tag}.png`) });

  // Pinned row opened.
  await page.click('.panel-um-head');
  await page.waitForTimeout(250);
  const pinned = await page.evaluate(
    () => document.querySelectorAll('#panel-user-media .um-tile, #panel-user-media .um-file').length,
  );
  checks.push({ ok: pinned > 0, msg: `pinned row opens to the session's files (${pinned})` });
  await (await page.$('#panel-artifacts'))?.screenshot({ path: path.join(OUT, `pinned-open-${tag}.png`) });

  // Viewer: open the first tile, page right, close with Escape.
  const tile = page.locator('#panel-turns .turn.user').first().locator('.um-img').first();
  await tile.click();
  await page.waitForFunction(() => (document.getElementById('art-modal') as HTMLDialogElement)?.open, {
    timeout: 5000,
  });
  await page.waitForTimeout(300);
  const viewer = await page.evaluate(() => ({
    src: (document.querySelector('#art-modal-body img') as HTMLImageElement | null)?.getAttribute('src') ?? '',
    pos: document.getElementById('art-modal-pos')?.textContent ?? '',
    name: document.getElementById('art-modal-name')?.textContent ?? '',
  }));
  checks.push({ ok: viewer.src.includes(`/media/IMG1/content`), msg: `viewer shows the media route (${viewer.src})` });
  checks.push({ ok: viewer.pos === '1 / 8', msg: `viewer pages within the instruction (${viewer.pos})` });
  checks.push({ ok: viewer.name.includes('지시 첨부'), msg: `viewer names it a user attachment (${viewer.name})` });
  await page.screenshot({ path: path.join(OUT, `viewer-${tag}.png`) });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  const next = await page.evaluate(() => document.getElementById('art-modal-pos')?.textContent ?? '');
  checks.push({ ok: next === '2 / 8', msg: `→ pages to the next file (${next})` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      closed: !(document.getElementById('art-modal') as HTMLDialogElement).open,
      id: el?.getAttribute('data-art-id'),
    };
  });
  checks.push({
    ok: focus.closed && focus.id === 'IMG1',
    msg: `Escape closes and focus returns to the tile (${focus.id})`,
  });

  // The kept video opens as a player on the media route.
  await page.locator('#panel-turns .turn.user').first().locator('[data-art-id="MOV1"]').first().click();
  await page.waitForFunction(() => (document.getElementById('art-modal') as HTMLDialogElement)?.open, {
    timeout: 5000,
  });
  const player = await page.evaluate(() => {
    const v = document.querySelector('#art-modal-body video') as HTMLVideoElement | null;
    return { src: v?.getAttribute('src') ?? '', controls: !!v?.controls };
  });
  checks.push({
    ok: player.controls && player.src.includes('/media/MOV1/content'),
    msg: `a kept video opens as a player (${player.src})`,
  });
  await page.screenshot({ path: path.join(OUT, `viewer-video-${tag}.png`) });
  await page.keyboard.press('Escape');

  await page.close();
  return checks.map((c) => ({ ...c, msg: `[${tag}] ${c.msg}` }));
}

async function main() {
  const { stopWebServer, baseUrl } = await setupServer();
  const browser = await chromium.launch();
  const failures: string[] = [];
  try {
    const images = await makeImages(browser);
    for (const width of [1440, 390]) {
      for (const theme of ['light', 'dark'] as const) {
        for (const c of await run(browser, baseUrl, images, width, theme)) {
          console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.msg}`);
          if (!c.ok) failures.push(c.msg);
        }
      }
    }
  } finally {
    await browser.close();
    await stopWebServer();
  }
  console.log(`\nScreenshots: ${OUT}`);
  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('All user-media checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
