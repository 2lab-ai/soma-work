/**
 * Phone chrome (SSOT 2026-11-04) — browser receipts and assertions.
 *
 *   T1  the board's top bar is one line on a phone: the scope group (admin approvals · admin write mode · the
 *       board's user · the defaults) leaves the bar for the board's own head and scrolls with the board.
 *   T2  the detail card on a phone: only the title bar stays while the reader scrolls the chat or the work log —
 *       the status bar, the tab bar, the agent tabs and the section tabs scroll out with the content; a tap on
 *       the title bar brings them back.
 *   T3  the session's model picker sits on the composer's own row, left of Send — on a phone and on the desktop
 *       (SSOT 2026-11-05) — slotted into the composer (#918: no docked box, no shadow measuring); a phone's narrow
 *       row draws it compact (the maker's mark and the level), the desktop's draws its name.
 *   #918 a named control in the title bar (˅, only while reading) brings the head back from the keyboard, and focus
 *       lands on the card's title.
 *   E   an effort pick in the picker shows at once — no busy, no progress cursor, before the server answers
 *       (SSOT 2026-11-05: "추론 강도 버튼 변경하면 왜 로딩을해").
 *   T4  the composer slides away while the reader scrolls back through the chat or the log, comes back at the very
 *       bottom, and a ^ button at the bottom right brings it back on demand.
 *   and the desktop page keeps the rest of its layout (the bar's toolbar, the pinned status bar, the composer).
 *
 * The real web server serves the real page; the browser's HTTP layer is mocked (board, turns, answers, work log)
 * and the WebSocket is a stub, so every run is the same. Touch scrolls are Chromium's own gesture synthesis.
 *
 * Run from the repo root in a clean env (keeps state out of the checkout; a CONVERSATION_VIEWER_TOKEN / OAuth or
 * CONVERSATION_VIEWER_URL in the shell sends the page to /login or the canonical origin — prefix `env -i PATH="$PATH"`):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-mobile-chrome.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'mobile-chrome');
fs.mkdirSync(OUT, { recursive: true });
// Its own port — never one inherited from a shell that runs soma-work (the page would load the live dashboard).
const PORT = process.env.MOBILE_CHROME_PORT || '33937';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const NOW = Date.now();
const M = 60_000;
const KEY = 'mock-inst::work:C123:1700000000.000200';

const ANSWER = Array.from(
  { length: 6 },
  (_, i) => `${i + 1}. 단계 ${i + 1}: 화면을 다시 그리고, 결과를 확인했습니다.`,
).join('\n');

function session() {
  return {
    key: KEY,
    title: 'Phone chrome',
    displayHeadline: '새작업 단축키 n → ctrl+n 변경',
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model: 'claude-opus-5-5[1m]',
    effort: 'xhigh',
    channelId: 'C123',
    sessionState: 'MAIN',
    activityState: 'working',
    conversationId: 'conv-run',
    lastActivity: new Date(NOW).toISOString(),
    activeLegStartedAtMs: NOW - 9 * M,
    activeAccumulatedMs: 0,
    slackThreadUrl: 'https://slack.example/archives/C123/p1700000000000',
    tokenUsage: { totalInputTokens: 1_200_000, totalOutputTokens: 91_000, totalCostUsd: 1.3, contextUsagePercent: 31 },
    goal: {
      current: {
        goalId: 'g1',
        objective: '단축키를 바꾼다',
        status: 'active',
        continuationCount: 0,
        maxContinuations: 5,
      },
      queue: [],
      completedCount: 0,
      history: [],
    },
    tasks: [
      {
        id: 'T1',
        content: '조사',
        status: 'completed',
        startedAt: NOW - 8 * M,
        completedAt: NOW - 7 * M,
        toolCalls: 4,
      },
      { id: 'T2', content: '구현', activeForm: '구현 중', status: 'in_progress', startedAt: NOW - 6 * M, toolCalls: 7 },
      { id: 'T3', content: '검증', status: 'pending', toolCalls: 0 },
      { id: 'T4', content: 'PR', status: 'pending', toolCalls: 0 },
    ],
    earlierTasks: [],
    artifacts: { count: 0, recent: [] },
  };
}

// A long chat: 24 exchanges, enough to scroll a phone several screens.
const TURNS = Array.from({ length: 24 }, (_, i) => [
  {
    id: `u${i}`,
    role: 'user',
    timestamp: new Date(NOW - (60 - i * 2) * M).toISOString(),
    userName: 'Zhuge',
    rawContent: `지시 ${i + 1}: 이 부분을 다시 확인해줘. 모바일에서 화면을 더 넓게 쓰고 싶어.`,
  },
  {
    id: `a${i}`,
    role: 'assistant',
    timestamp: new Date(NOW - (59 - i * 2) * M).toISOString(),
    summaryTitle: `답변 ${i + 1}`,
    summaryBody: `summary ${i + 1}`,
    summarized: true,
  },
]).flat();

const E = (seq: number, o: Record<string, unknown>) => ({
  seq,
  ts: NOW - (200 - seq) * 10_000,
  attributed: true,
  ...o,
});
const WORKLOG = Array.from({ length: 80 }, (_, i) =>
  i % 2 === 0
    ? E(i + 1, { kind: 'tool', tool: 'Bash', text: `Bash npm test -- step ${i + 1}` })
    : E(i + 1, { kind: 'tool_result', tool: 'Bash', text: `ok ${i + 1}`, ok: true }),
);

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) {',
  '  this.url = url; this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;',
  '  window.__ws = this;',
  '};',
  'window.WebSocket.prototype.close = function () {};',
  'window.WebSocket.prototype.send = function () {};',
  'window.__name = function (f) { return f; };',
  'delete window.webkitSpeechRecognition; delete window.SpeechRecognition;',
  // Headless Chromium paints only when asked: keep frames coming so transitions and scroll end.
  '(function tick() { requestAnimationFrame(tick); })();',
].join('\n');

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
    r.fulfill({ json: { board: { waiting: [], working: [session()], idle: [], closed: [] } } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts/, (r) => r.fulfill({ json: { artifacts: [] } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog\/\d+\/raw/, (r) =>
    r.fulfill({ json: { raw: 'raw', rawBytes: 3 } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog(\?.*)?$/, (r) =>
    r.fulfill({ json: { entries: WORKLOG, hasMore: false } }),
  );
  await page.route(/\/api\/conversations\/[^/]+\/turns\/[^/]+\/raw/, (r) => r.fulfill({ json: { raw: ANSWER } }));
  // The effort write: the server answers after it saved the sessions and pushed the board (slow on a big store).
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/effort$/, async (r) => {
    const effort = JSON.parse(r.request().postData() || '{}').effort;
    await sleep(EFFORT_DELAY_MS);
    WIRE.push(`effort:${effort}`);
    // One level the server refuses: a 지시 waiting on it must not go on the old level.
    if (effort === 'low') return r.fulfill({ status: 500, json: { error: 'Internal Server Error' } });
    return r.fulfill({
      json: { ok: true, result: { status: 'switched', effort, previous: 'xhigh', effective: effort } },
    });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/command$/, (r) => {
    WIRE.push(`command:${JSON.parse(r.request().postData() || '{}').message}`);
    return r.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    return r.fulfill({
      json: { id: 'conv-run', title: 'conv-run', turnCount: TURNS.length, turns: TURNS, hasMore: false },
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
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const EFFORT_DELAY_MS = 1500;
/** What the server answered, in order: an effort write (when it was saved) and a command (when it arrived). */
const WIRE: string[] = [];

/** A real touch drag (Chromium's gesture synthesis): negative dy scrolls back toward older items. */
async function swipe(page: Page, x: number, y: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', {
    x,
    y,
    yDistance: -dy,
    gestureSourceType: 'touch',
    speed: 1600,
    preventFling: true,
  });
  await cdp.detach();
  await sleep(450);
}

/** Where the parts of the open detail card are, in viewport px. */
const panelGeometry = (page: Page) =>
  page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = (el as HTMLElement).getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        h: Math.round(r.height),
      };
    };
    // The open section's scroll box: the chat, or the work log once it is the section shown.
    const logBox = document.getElementById('psec-log');
    const onLog = !!logBox && logBox.getBoundingClientRect().height > 0;
    const sectionEl = document.getElementById(onLog ? 'worklog-list' : 'panel-conv');
    const sc = sectionEl?.shadowRoot?.querySelector('ui-log-scroller');
    const vp = sc?.shadowRoot?.querySelector('.ls-vp') as HTMLElement | null;
    const steer = document.getElementById('cmd-steer');
    const comp = document.getElementById('pc-composer');
    const send = comp?.shadowRoot?.querySelector('.cp-send') ?? null;
    const picker = document.querySelector('#panel-controls ui-model-picker');
    const up = document.getElementById('pc-reveal');
    const visibleIn = (el: Element | null) => {
      const r = rect(el);
      if (!r || r.h === 0) return false;
      const cs = getComputedStyle(el as Element);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
      // Clipped by the panel's scroll area when it is inside it (scrolled out under the title bar).
      const sc = (el as HTMLElement).closest('#panel-scroll');
      const clip = sc ? sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      return r.bottom > Math.max(0, clip.top) + 1 && r.top < Math.min(window.innerHeight, clip.bottom) - 1;
    };
    return {
      vh: window.innerHeight,
      header: rect(document.querySelector('#slide-panel .panel-header')),
      title: rect(document.getElementById('panel-title')),
      status: rect(document.getElementById('panel-status')),
      statusShown: visibleIn(document.getElementById('panel-status')),
      midbarShown: visibleIn(document.getElementById('panel-midbar')),
      sectionsList: rect(document.getElementById('panel-sections')),
      // The section tabs (대화 · 작업 로그): <ui-tabs>' tab strip in its open shadow root.
      strip: rect(document.getElementById('panel-sections')?.shadowRoot?.querySelector('.tb-scroll') ?? null),
      stripShown: visibleIn(document.getElementById('panel-sections')?.shadowRoot?.querySelector('.tb-scroll') ?? null),
      viewport: rect(vp),
      // The part of the chat the reader can touch: inside the panel's scroll area, above the composer.
      touch: (() => {
        const r = vp?.getBoundingClientRect();
        const sc = (document.getElementById('panel-scroll') as HTMLElement).getBoundingClientRect();
        if (!r) return null;
        const top = Math.max(r.top, sc.top);
        const bottom = Math.min(r.bottom, sc.bottom);
        if (bottom - top < 40) return null; // below the fold (a short screen at rest: the head fills it)
        return {
          x: Math.round((Math.max(r.left, sc.left) + Math.min(r.right, sc.right)) / 2),
          y: Math.round((top + bottom) / 2),
        };
      })(),
      vpScroll: vp ? { top: Math.round(vp.scrollTop), max: Math.round(vp.scrollHeight - vp.clientHeight) } : null,
      command: rect(document.getElementById('panel-command')),
      commandShown: visibleIn(document.getElementById('panel-command')),
      steer: rect(steer),
      send: rect(send),
      picker: rect(picker),
      pickerShown: visibleIn(picker),
      pickerCompact: !!picker?.hasAttribute('compact'),
      pickerName: picker?.shadowRoot?.querySelector('.mp-name')?.textContent ?? '',
      pickerSlotted:
        picker?.closest('#panel-controls')?.getAttribute('slot') === 'end' && !!picker?.closest('#pc-composer'),
      pickDock: document.getElementById('panel-command')?.hasAttribute('data-pick-dock') ?? false,
      headBackShown: visibleIn(document.getElementById('panel-head-back')),
      up: rect(up),
      upShown: visibleIn(up),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      outer: (() => {
        const sc = document.getElementById('panel-scroll') as HTMLElement;
        const box = document.querySelector('.psec:not([hidden])') as HTMLElement | null;
        return {
          top: Math.round(sc.scrollTop),
          max: Math.round(sc.scrollHeight - sc.clientHeight),
          view: sc.clientHeight,
          boxH: box ? Math.round(box.getBoundingClientRect().height) : 0,
          boxTop: box ? Math.round(box.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop) : 0,
          read: document.getElementById('slide-panel')?.getAttribute('data-read'),
        };
      })(),
    };
  });

async function openCard(page: Page) {
  await page.evaluate((k) => (window as any).openPanel(k), KEY);
  await page.waitForFunction(
    () => {
      const conv = document.getElementById('panel-conv') as any;
      return !!conv && !!conv.data && Array.isArray(conv.data.turns) && conv.data.turns.length > 10;
    },
    null,
    { timeout: 15000 },
  );
  await sleep(1200);
}

async function phone(browser: Browser, width: number, height: number) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const tag = `phone ${width}×${height}`;
  page.on('pageerror', (err) => check(false, `${tag}: page error: ${err.message}`));
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForFunction(() => document.querySelectorAll('#kanban .card, #kanban [data-key]').length >= 0, null, {
    timeout: 20000,
  });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('admin-mode-toggle') as HTMLElement).display !== 'none',
    null,
    {
      timeout: 20000,
    },
  );
  await sleep(800);

  // T1 · the top bar is one line; the admin chips stay on the page, in the board's head.
  const bar = await page.evaluate(() => {
    const ab = document.getElementById('app-bar') as HTMLElement;
    const head = (document.getElementById('topbar') as HTMLElement).getBoundingClientRect();
    const admin = (document.getElementById('admin-mode-toggle') as HTMLElement).getBoundingClientRect();
    const inbox = (document.getElementById('admin-inbox-btn') as HTMLElement).getBoundingClientRect();
    return {
      toolbarRow: ab.hasAttribute('toolbar-row'),
      headerH: Math.round(head.height),
      scopeInBar: !!(document.getElementById('topbar-scope') as HTMLElement).closest('ui-app-bar'),
      adminBelowBar: admin.top >= head.bottom - 1 && admin.height > 0,
      inboxBelowBar: inbox.top >= head.bottom - 1 && inbox.height > 0,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  check(
    !bar.toolbarRow && bar.headerH <= 60,
    `${tag}: the top bar is one line (${bar.headerH}px, toolbar row ${bar.toolbarRow})`,
  );
  check(
    !bar.scopeInBar && bar.adminBelowBar && bar.inboxBelowBar,
    `${tag}: 승인 · 관리자 sit in the board's head, under the bar (${JSON.stringify(bar)})`,
  );
  check(bar.overflow <= 0, `${tag}: no sideways overflow on the board (${bar.overflow})`);
  await page.screenshot({ path: path.join(OUT, `phone-${width}-board.png`) });
  await page.evaluate(() => window.scrollTo(0, 400));
  await sleep(300);
  const barScrolled = await page.evaluate(() =>
    Math.round((document.getElementById('topbar') as HTMLElement).getBoundingClientRect().height),
  );
  check(barScrolled <= 60, `${tag}: still one line with the board scrolled (${barScrolled}px)`);
  await page.screenshot({ path: path.join(OUT, `phone-${width}-board-scrolled.png`) });
  await page.evaluate(() => window.scrollTo(0, 0));

  // The detail card at rest: the whole head is there.
  await openCard(page);
  if (process.env.MOBILE_CHROME_DEBUG)
    await page.evaluate(() => {
      const w = window as any;
      w.__rdlog = [];
      new MutationObserver((ms) =>
        ms.forEach((m) =>
          w.__rdlog.push(
            `${m.attributeName}=${(m.target as Element).getAttribute(m.attributeName!)} @ ${(new Error().stack ?? '').split('\n').slice(2, 6).join(' | ')}`,
          ),
        ),
      ).observe(document.getElementById('slide-panel') as Element, {
        attributes: true,
        attributeFilter: ['data-read', 'data-tuck'],
      });
    });
  const rest = await panelGeometry(page);
  await page.screenshot({ path: path.join(OUT, `phone-${width}-card-rest.png`) });
  // A short screen (a phone sideways) lands on the chat already (psecLandingTop): its head may start out of view.
  check(
    rest.commandShown && (rest.statusShown || height < 560),
    `${tag}: the card opens with its composer${height < 560 ? '' : ' and its status bar'}`,
  );
  check(!rest.upShown, `${tag}: no ^ while the composer is out`);
  // T6 · the card's title bar is one line of the board's top bar's height (52px), not a taller block.
  check(
    !!rest.header && rest.header.h >= 51 && rest.header.h <= 53,
    `${tag}: the title bar is 52px, the top bar's height (${rest.header?.h}px)`,
  );

  // T3 · the model picker shares the composer's row, left of Send.
  const p = rest.picker;
  const s = rest.send;
  check(
    !!p &&
      !!s &&
      rest.pickerShown &&
      Math.abs((p.top + p.bottom) / 2 - (s.top + s.bottom) / 2) <= 6 &&
      p.right <= s.left,
    `${tag}: the model picker sits on Send's row, to its left (picker ${JSON.stringify(p)} · send ${JSON.stringify(s)})`,
  );
  check(!!p && !!rest.steer && p.top >= rest.steer.top, `${tag}: no model line above the composer`);
  // #918 · through the composer's slot, never a docked box; a phone's row draws it compact (mark · level).
  check(
    rest.pickerSlotted && !rest.pickDock,
    `${tag}: the picker is the composer's slot="end" content (no docked box)`,
  );
  check(
    rest.pickerCompact && rest.pickerName === '',
    `${tag}: a phone's row draws the picker compact — the maker's mark and the level (name "${rest.pickerName}")`,
  );
  check(!rest.headBackShown, `${tag}: no ˅ in the title bar while the head is in`);

  // T2 · T4 · the reader scrolls back through the chat: only the title bar stays, the composer goes.
  const at = rest.touch!;
  await swipe(page, at.x, at.y, -500);
  const read = await panelGeometry(page);
  await page.screenshot({ path: path.join(OUT, `phone-${width}-card-reading.png`) });
  check(
    !!read.status && !!read.header && read.status.bottom <= read.header.bottom && !read.midbarShown,
    `${tag}: the status bar and the tab bar scrolled out under the title bar (${JSON.stringify(read.outer)})`,
  );
  // T5 · the section tabs (대화 · 작업 로그) stay, right under the title bar; the chat starts under them.
  check(
    read.stripShown && !!read.strip && !!read.header && Math.abs(read.strip.top - read.header.bottom) <= 2,
    `${tag}: the 대화 · 작업 로그 tabs stay right under the title bar (tabs top ${read.strip?.top} · title bar bottom ${read.header?.bottom})`,
  );
  check(
    !!read.viewport && !!read.strip && read.viewport.top <= read.strip.bottom + 6, // the chat's own 4px top padding
    `${tag}: the chat starts right under the tabs (chat top ${read.viewport?.top} · tabs bottom ${read.strip?.bottom})`,
  );
  check(!read.commandShown, `${tag}: the composer slid away while reading (${JSON.stringify(read.command)})`);
  check(read.headBackShown, `${tag}: while reading, the title bar shows ˅ (카드 위쪽 보이기)`);
  check(
    read.upShown && !!read.up && read.up.right >= width - 32 && read.up.bottom >= read.vh - 96,
    `${tag}: a ^ button at the bottom right (${JSON.stringify(read.up)})`,
  );
  check(
    !!read.viewport && read.viewport.bottom >= read.vh - 2,
    `${tag}: the chat reaches the bottom of the screen (${read.viewport?.bottom} / ${read.vh})`,
  );

  // T4 · ^ brings the composer back where the reader is.
  await page.locator('#pc-reveal').tap();
  await sleep(450);
  const revealed = await panelGeometry(page);
  check(revealed.commandShown && !revealed.upShown, `${tag}: ^ brings the composer back`);
  await page.screenshot({ path: path.join(OUT, `phone-${width}-card-revealed.png`) });

  // Reading on hides it again; the very bottom shows it.
  const again0 = await panelGeometry(page);
  await swipe(page, again0.touch!.x, again0.touch!.y, -300);
  const again = await panelGeometry(page);
  check(!again.commandShown && again.upShown, `${tag}: scrolling back again tucks it away`);
  for (let i = 0; i < 8; i++) {
    const g = await panelGeometry(page);
    await swipe(page, g.touch!.x, g.touch!.y, 1200);
  }
  const bottom = await panelGeometry(page);
  await page.screenshot({ path: path.join(OUT, `phone-${width}-card-bottom.png`) });
  check(
    bottom.commandShown && !bottom.upShown,
    `${tag}: at the very bottom the composer is back (${JSON.stringify(bottom.vpScroll)})`,
  );
  // A short scroll back from the very bottom: the composer does not flap (tuck → the box grows onto the bottom →
  // back → tuck …) — it stays or goes once.
  const flips = await page.evaluate(() => {
    const w = window as any;
    w.__tuckFlips = 0;
    new MutationObserver(() => w.__tuckFlips++).observe(document.getElementById('slide-panel') as Element, {
      attributes: true,
      attributeFilter: ['data-tuck'],
    });
    return 0;
  });
  await swipe(page, bottom.touch?.x ?? Math.round(width / 2), bottom.touch?.y ?? Math.round(height / 2), -60);
  await sleep(600);
  const near1 = await panelGeometry(page);
  await sleep(400);
  const near2 = await panelGeometry(page);
  const flipCount = await page.evaluate(() => (window as any).__tuckFlips as number);
  check(
    flips === 0 && flipCount <= 1 && near1.commandShown === near2.commandShown,
    `${tag}: a short scroll back near the bottom does not flap the composer (${flipCount} change(s), shown ${near2.commandShown})`,
  );
  check(!bottom.statusShown, `${tag}: the head stays out at the bottom of the chat (${JSON.stringify(bottom.outer)})`);
  if (process.env.MOBILE_CHROME_DEBUG) log((await page.evaluate(() => (window as any).__rdlog)).join('\n'));

  // T2 · a tap on the title bar brings the head back.
  await page.locator('#panel-title').tap();
  await sleep(500);
  const back = await panelGeometry(page);
  check(back.statusShown, `${tag}: a tap on the title bar brings the head back`);

  // #918 · a finger whose node leaves the DOM mid-touch (a live re-render) still ends the reader's touch: native
  // touches through CDP, the touched node removed before the finger lifts.
  {
    // A short screen (a phone sideways) at rest has the head over the chat: reading first gives the chat its room.
    if (!(await panelGeometry(page)).touch) {
      await page.evaluate(() => (window as unknown as { rdRead(on: boolean): void }).rdRead(true));
      await sleep(900);
    }
    const g = await panelGeometry(page);
    if (g.touch) {
      const cdp = await page.context().newCDPSession(page);
      const pt = { x: g.touch.x, y: g.touch.y, id: 1 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...pt, y: pt.y - 4 }] });
      const mid = await page.evaluate(({ x, y }) => {
        let el: Element | null = document.elementFromPoint(x, y);
        while (el?.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === el) break;
          el = inner;
        }
        const touching = (window as unknown as { _rd: { touch: boolean } })._rd.touch;
        el?.remove();
        return { touching, removed: !!el && !el.isConnected };
      }, pt);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
      await sleep(100);
      const after = await page.evaluate(() => (window as unknown as { _rd: { touch: boolean } })._rd.touch);
      check(
        mid.touching && mid.removed && after === false,
        `${tag}: a touch whose node left the DOM still ends (touching ${mid.touching} · removed ${mid.removed} · after ${after})`,
      );
    } else check(false, `${tag}: the chat has room for a touch (${JSON.stringify(g.outer)})`);
  }

  // #918 · the keyboard's way: reading again, then Enter on the title bar's ˅ — the head back, focus on the title.
  const kb0 = await panelGeometry(page);
  // A short screen (a phone sideways) at rest has the head over the chat: reading starts the way a scroll starts it.
  if (kb0.touch) await swipe(page, kb0.touch.x, kb0.touch.y, -500);
  else await page.evaluate(() => (window as unknown as { rdRead(on: boolean): void }).rdRead(true));
  await sleep(900);
  {
    const kbRead = await panelGeometry(page);
    check(kbRead.headBackShown, `${tag}: reading again shows ˅`);
    await page.focus('#panel-head-back');
    await page.keyboard.press('Enter');
    await sleep(1200);
    const kb = await panelGeometry(page);
    const focused = await page.evaluate(() => document.activeElement?.id ?? '');
    check(kb.statusShown && !kb.headBackShown, `${tag}: Enter on ˅ brings the head back and ˅ steps aside`);
    check(focused === 'panel-title', `${tag}: focus lands on the card's title, not the page (${focused || 'body'})`);
    await page.screenshot({ path: path.join(OUT, `phone-${width}-head-back-key.png`) });
  }

  // T2 · T4 · the work log reads the same way.
  await page.evaluate(() => (window as any).selectPanelSection?.('log'));
  await sleep(1200);
  const logState = await page.evaluate(() => {
    const wl = document.getElementById('worklog-list');
    const sc = wl?.shadowRoot?.querySelector('ui-log-scroller');
    const v = sc?.shadowRoot?.querySelector('.ls-vp') as HTMLElement | null;
    const r = v?.getBoundingClientRect();
    return v && r ? { top: Math.round(r.top), h: Math.round(r.height), max: v.scrollHeight - v.clientHeight } : null;
  });
  if (logState && logState.max > 0) {
    let g = await panelGeometry(page);
    if (!g.touch) {
      // A short screen at rest: the head fills the panel — the reader scrolls it away by hand first.
      const sc = await page.evaluate(() => {
        const r = (document.getElementById('panel-scroll') as HTMLElement).getBoundingClientRect();
        return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
      });
      await swipe(page, sc.x, sc.y, 400);
      g = await panelGeometry(page);
    }
    await swipe(page, g.touch!.x, g.touch!.y, -400);
    const logRead = await panelGeometry(page);
    await page.screenshot({ path: path.join(OUT, `phone-${width}-log-reading.png`) });
    check(
      !logRead.statusShown && !logRead.commandShown,
      `${tag}: 작업 로그 — the head and the composer go while reading`,
    );
    check(
      logRead.stripShown &&
        !!logRead.strip &&
        !!logRead.header &&
        Math.abs(logRead.strip.top - logRead.header.bottom) <= 2,
      `${tag}: 작업 로그 — the tabs stay right under the title bar (tabs top ${logRead.strip?.top})`,
    );
    // T5 · a tap on 대화 while reading: the chat, the head still out, the tabs still there.
    if (process.env.MOBILE_CHROME_DEBUG)
      await page.evaluate(() => {
        const w = window as any;
        w.__calls = [];
        for (const n of ['rdReset', 'rdRead', 'selectPanelSection', 'rdTuck']) {
          const f = w[n];
          w[n] = function (...a: unknown[]) {
            w.__calls.push(
              `${n}(${JSON.stringify(a)}) read=${document.getElementById('slide-panel')?.getAttribute('data-read')} <- ${(
                new Error().stack ?? ''
              )
                .split('\n')
                .slice(2, 5)
                .map((l) => l.trim().split(' ')[1])
                .join(' < ')}`,
            );
            return f.apply(this, a);
          };
        }
      });
    await page.locator('#panel-sections .tb-tab', { hasText: '대화' }).first().tap();
    await sleep(900);
    const swapped = await panelGeometry(page);
    if (process.env.MOBILE_CHROME_DEBUG) log((await page.evaluate(() => (window as any).__calls)).join('\n'));
    await page.screenshot({ path: path.join(OUT, `phone-${width}-tab-switch-reading.png`) });
    check(
      !swapped.statusShown &&
        swapped.stripShown &&
        !!swapped.strip &&
        !!swapped.header &&
        Math.abs(swapped.strip.top - swapped.header.bottom) <= 2 &&
        !!swapped.viewport &&
        swapped.viewport.top <= swapped.strip.bottom + 6,
      `${tag}: a tab tap while reading keeps the head out and the tabs in place (${JSON.stringify(swapped.outer)})`,
    );
  } else check(false, `${tag}: 작업 로그 has something to scroll (${JSON.stringify(logState)})`);

  // A phone turned sideways while reading, then a tab tap (the composer back): the section box ends inside the view —
  // its newest rows are never under the composer (no 160px floor on a short screen).
  if (width === 390) {
    const g0 = await panelGeometry(page);
    if (g0.touch) await swipe(page, g0.touch.x, g0.touch.y, -300);
    await page.setViewportSize({ width: 844, height: 390 });
    await sleep(900);
    await page.locator('#panel-sections .tb-tab', { hasText: '작업 로그' }).first().tap();
    await sleep(900);
    const fit = await page.evaluate(() => {
      const box = document.getElementById('psec-log');
      const sc = (document.getElementById('panel-scroll') as HTMLElement).getBoundingClientRect();
      const b = box?.getBoundingClientRect();
      return {
        read: document.getElementById('slide-panel')?.getAttribute('data-read'),
        boxBottom: b ? Math.round(b.bottom) : null,
        clipBottom: Math.round(sc.bottom),
        view: Math.round(sc.height),
      };
    });
    await page.screenshot({ path: path.join(OUT, `phone-${width}-rotated-log.png`) });
    check(
      fit.boxBottom !== null && fit.boxBottom <= fit.clipBottom + 1,
      `${tag} → 844×390 while reading, then 작업 로그: the box ends inside the view (${JSON.stringify(fit)})`,
    );
    await page.setViewportSize({ width, height });
    await sleep(600);
  }

  const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(ov <= 0, `${tag}: no sideways overflow with the card open (${ov})`);
  await ctx.close();
}

async function desktop(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const tag = 'desktop 1280×900';
  page.on('pageerror', (err) => check(false, `${tag}: page error: ${err.message}`));
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('admin-mode-toggle') as HTMLElement).display !== 'none',
    null,
    {
      timeout: 20000,
    },
  );
  await sleep(800);
  const scopeInBar = await page.evaluate(
    () => !!(document.getElementById('topbar-scope') as HTMLElement).closest('ui-app-bar'),
  );
  check(scopeInBar, `${tag}: the scope group stays the bar's toolbar`);
  await openCard(page);
  const g0 = await panelGeometry(page);
  await page.mouse.move(1000, (g0.viewport?.top ?? 500) + 100);
  await page.mouse.wheel(0, -600);
  await sleep(500);
  const g = await panelGeometry(page);
  await page.screenshot({ path: path.join(OUT, 'desktop-card.png') });
  check(
    g.statusShown && g.commandShown && !g.upShown,
    `${tag}: the status bar and the composer stay put while the chat scrolls`,
  );
  // T3 · the desktop card too: the picker on Send's row, to its left; no model line above the composer.
  const p = g.picker;
  const s = g.send;
  check(
    !!p &&
      !!s &&
      g.pickerShown &&
      Math.abs((p.top + p.bottom) / 2 - (s.top + s.bottom) / 2) <= 6 &&
      p.right <= s.left &&
      s.left - p.right <= 16,
    `${tag}: the model picker sits on Send's row, right at its left (picker ${JSON.stringify(p)} · send ${JSON.stringify(s)})`,
  );
  check(!!p && !!g.steer && p.top >= g.steer.top, `${tag}: no model line above the composer`);
  check(g.pickerSlotted && !g.pickDock, `${tag}: the picker is the composer's slot="end" content (no docked box)`);
  check(!g.pickerCompact && g.pickerName.length > 0, `${tag}: a wide row draws the picker's name ("${g.pickerName}")`);
  const scope = await page.evaluate(() => {
    const el = document.querySelector('#panel-controls .pc-scope') as HTMLElement | null;
    return el ? getComputedStyle(el).display : 'none';
  });
  check(scope === 'none', `${tag}: no "이 세션" label on the composer's row (${scope})`);

  // E · an effort pick shows at once: the thumb moves and nothing is busy while the write is out.
  await page.locator('#panel-controls ui-model-picker .mp-trigger').click();
  await page.waitForSelector('#panel-controls ui-model-picker .mp-seg-btn[data-effort="high"]', { timeout: 5000 });
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'desktop-effort-menu.png') });
  const t0 = Date.now();
  await page.locator('#panel-controls ui-model-picker .mp-seg-btn[data-effort="high"]').click();
  await sleep(150);
  const mid = await page.evaluate(() => {
    const el = document.querySelector('#panel-controls ui-model-picker') as HTMLElement & {
      shadowRoot: ShadowRoot;
      open?: boolean;
    };
    const sr = el.shadowRoot;
    const on = sr.querySelector('.mp-seg-btn[aria-checked="true"]') as HTMLElement | null;
    const seg = sr.querySelector('.mp-seg-ctl') as HTMLElement | null;
    const trig = sr.querySelector('.mp-trigger') as HTMLElement | null;
    return {
      checked: on?.dataset.effort,
      segBusy: seg?.getAttribute('aria-busy'),
      trigBusy: trig?.getAttribute('aria-busy'),
      cursor: on ? getComputedStyle(on).cursor : '',
      open: !!el.open,
    };
  });
  const midMs = Date.now() - t0;
  await page.screenshot({ path: path.join(OUT, 'desktop-effort-picked.png') });
  check(
    midMs < EFFORT_DELAY_MS && mid.checked === 'high' && !mid.segBusy && !mid.trigBusy && mid.cursor !== 'progress',
    `${tag}: an effort pick shows at once, nothing busy, ${midMs}ms after the click with the write still out (${JSON.stringify(mid)})`,
  );
  // A level keeps the menu open (it is a setting of the same choice): the shorter words do not move the trigger.
  check(mid.open, `${tag}: the menu stays open after a level pick (open ${mid.open})`);
  await sleep(EFFORT_DELAY_MS + 300);
  const after = await page.evaluate(() => {
    const el = document.querySelector('#panel-controls ui-model-picker') as HTMLElement & {
      shadowRoot: ShadowRoot;
      open?: boolean;
    };
    return {
      effort: (el.shadowRoot.querySelector('.mp-seg-btn[aria-checked="true"]') as HTMLElement | null)?.dataset.effort,
      open: !!el.open,
    };
  });
  check(
    after.effort === 'high' && after.open,
    `${tag}: the server's answer keeps the picked level, the menu still open (${JSON.stringify(after)})`,
  );
  // Closed, the picker takes its own width and ends at Send again.
  await page.keyboard.press('Escape');
  await sleep(500);
  const closed = await panelGeometry(page);
  check(
    !!closed.picker &&
      !!closed.send &&
      closed.picker.right <= closed.send.left &&
      closed.send.left - closed.picker.right <= 16,
    `${tag}: closed, the picker ends right at Send again (picker ${JSON.stringify(closed.picker)} · send ${JSON.stringify(closed.send)})`,
  );
  // The switch's note floats above the field, then goes: it never sits on the text being typed.
  const note = () =>
    page.evaluate(() => {
      const el = document.querySelector('#panel-controls .cb-model-note') as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { text: el.textContent, shown: cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 };
    });
  const n0 = await note();
  await page.screenshot({ path: path.join(OUT, 'desktop-effort-closed.png') });
  await sleep(5000);
  const n1 = await note();
  await page.screenshot({ path: path.join(OUT, 'desktop-effort-note-gone.png') });
  check(
    !!n0 && n0.shown && !!n1 && !n1.shown,
    `${tag}: the effort note shows, then goes after a few seconds (${JSON.stringify(n0)} → ${JSON.stringify(n1)})`,
  );
  // A level picked, then 지시 at once: the instruction reaches the server after the level it was picked with
  // (trinity R1 on #971 — the turn never starts on an older level than the one shown).
  WIRE.length = 0;
  await page.locator('#panel-controls ui-model-picker .mp-trigger').click();
  await page.waitForSelector('#panel-controls ui-model-picker .mp-seg-btn[data-effort="medium"]', { timeout: 5000 });
  await sleep(300);
  await page.locator('#panel-controls ui-model-picker .mp-seg-btn[data-effort="medium"]').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).sendCommand('지시 테스트', ''));
  await sleep(EFFORT_DELAY_MS + 800);
  check(
    WIRE.join(' → ') === 'effort:medium → command:지시 테스트',
    `${tag}: 지시 right after a level goes after that level is saved (${WIRE.join(' → ')})`,
  );
  // The server refuses the level picked just before: the 지시 is not sent on the old level; the toast says why.
  WIRE.length = 0;
  await page.locator('#panel-controls ui-model-picker .mp-trigger').click();
  await page.waitForSelector('#panel-controls ui-model-picker .mp-seg-btn[data-effort="low"]', { timeout: 5000 });
  await sleep(300);
  await page.locator('#panel-controls ui-model-picker .mp-seg-btn[data-effort="low"]').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).sendCommand('거절 뒤 지시', ''));
  await sleep(EFFORT_DELAY_MS + 800);
  const refused = await page.evaluate(() => {
    const t = document.getElementById('dash-toaster');
    return (t?.shadowRoot?.textContent || '').includes('추론 강도를 바꾸지 못해 보내지 않았어요');
  });
  check(
    WIRE.join(' → ') === 'effort:low' && refused,
    `${tag}: a refused level holds the 지시 back and says why (${WIRE.join(' → ')}, toast ${refused})`,
  );
  await ctx.close();
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  const browser = await chromium.launch({ headless: true });
  try {
    if (!process.env.MOBILE_CHROME_DEBUG) {
      await phone(browser, 390, 844);
      await phone(browser, 412, 915);
      await phone(browser, 320, 640); // the drawer's floor (min-width 320): the picker never runs over Send
    }
    // A phone sideways: short, so the same chrome rules (the drawer docks beside the board from 840px).
    await phone(browser, 844, 390);
    await desktop(browser);
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
