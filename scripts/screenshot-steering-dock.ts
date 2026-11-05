/**
 * The detail card's follow-up queue as a dock (SSOT 2026-11-05) — browser receipts and assertions.
 *
 *   D1  notes the queue holds no longer cover the chat: they wait behind a round count button at the composer's top
 *       right; only a note on its way in shows above the field.
 *   D2  on a mouse, hovering the button peeks the queue and a click pins it; Esc closes the queue, not the card.
 *   D3  on a phone (iPhone 17 Pro / Pro Max, Galaxy Z Fold 8 cover and Ultra cover) a tap opens a bottom sheet the
 *       screen's width on its bottom, with 44px buttons; the scrim closes it, the card stays.
 *   D4  the Fold 8 unfolded (816×616, touch) gets the popover beside the button, 44px buttons, nothing off-screen.
 *   D5  the queue's controls reach the server: Cancel in the open queue posts /queue/<id>/cancel.
 *   D6  on a phone, the composer tucked away while reading takes its queue button with it: nothing of it shows
 *       under ^ and a tap there opens nothing.
 *
 * The real web server serves the real page; the browser's HTTP layer is mocked (board, turns) and the WebSocket is
 * a stub, so every run is the same. UI_DIST=<dir> serves a candidate @2lab.ai/ui build instead of the installed one.
 *
 * Run from the repo root in a clean env (prefix `env -i PATH="$PATH"`):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-steering-dock.ts [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, type BrowserType, chromium, type Page, webkit } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'steering-dock');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.STEERING_DOCK_PORT || '33951';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const UI_DIST = process.env.UI_DIST || '';

const NOW = Date.now();
const M = 60_000;
const KEY = 'mock-inst::work:C123:1700000000.000300';

// Three notes shaped like the report's (2026-11-05): one delivered, two waiting — the last one long.
const NOTES = [
  { id: 'f1', text: '팀 인원수랑 권한도 리포트에 넣어줘', state: 'steered', at: NOW - 3 * M },
  {
    id: 'f2',
    text: '이게 최선이야?\n\n의도:\n- 비용 추세를 알고 싶다.\n- 버튼 하나로 바로 비용을 줄이고 싶다.\n- 운영상 문제를 P0, P1로',
    state: 'queued',
    at: NOW - 2 * M,
  },
  {
    id: 'f3',
    text: '이게 최선이야?\n\n의도:\n- 비용 추세를 알고 싶다.\n- 버튼 하나로 바로 비용을 줄이고 싶다.\n- 운영상 문제를 P0, P1, P2, P3로 받아보고 싶다. (코드 리뷰처럼)\n\n이걸 끝내면 같은 방법으로 다른 환경에서도 같은 리포트를 받고 싶다.',
    state: 'queued',
    at: NOW - M,
  },
];

function session() {
  return {
    key: KEY,
    title: 'Steering dock',
    displayHeadline: '작업 카드 큐 UI 개선',
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model: 'claude-opus-5-5[1m]',
    effort: 'xhigh',
    channelId: 'C123',
    sessionState: 'MAIN',
    activityState: 'working',
    conversationId: 'conv-dock',
    lastActivity: new Date(NOW).toISOString(),
    activeLegStartedAtMs: NOW - 9 * M,
    activeAccumulatedMs: 0,
    slackThreadUrl: 'https://slack.example/archives/C123/p1700000000000',
    tokenUsage: { totalInputTokens: 1_200_000, totalOutputTokens: 91_000, totalCostUsd: 1.3, contextUsagePercent: 31 },
    tasks: [],
    earlierTasks: [],
    artifacts: { count: 0, recent: [] },
    followups: {
      turnEpoch: 3,
      items: NOTES.map((n) => ({
        id: n.id,
        text: n.text,
        files: [],
        enqueuedAt: n.at,
        state: n.state,
        epoch: 1,
        editable: n.state === 'queued',
        authorId: 'U001',
      })),
    },
  };
}

const TURNS = Array.from({ length: 24 }, (_, i) => [
  {
    id: `u${i}`,
    role: 'user',
    timestamp: new Date(NOW - (60 - i * 2) * M).toISOString(),
    userName: 'Zhuge',
    rawContent: `지시 ${i + 1}: 이 부분을 다시 확인해줘. 큐가 대화를 가리면 안 된다.`,
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

/** POSTs the queue's controls sent: `<op> <id>`. */
const posted: string[] = [];

async function installMocks(page: Page) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  if (UI_DIST) {
    await page.route('**/dashboard/ui/*', (r) => {
      const file = path.join(UI_DIST, path.basename(new URL(r.request().url()).pathname));
      if (!fs.existsSync(file)) return r.fulfill({ status: 404 });
      return r.fulfill({ body: fs.readFileSync(file), contentType: 'text/javascript; charset=utf-8' });
    });
  }
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
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/queue\/[^/]+\/[a-z]+$/, (r) => {
    const parts = new URL(r.request().url()).pathname.split('/');
    posted.push(`${parts[parts.length - 1]} ${decodeURIComponent(parts[parts.length - 2])}`);
    return r.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts/, (r) => r.fulfill({ json: { artifacts: [] } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog(\?.*)?$/, (r) =>
    r.fulfill({ json: { entries: [], hasMore: false } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ json: { ok: true } });
    return r.fulfill({
      json: { id: 'conv-dock', title: 'conv-dock', turnCount: TURNS.length, turns: TURNS, hasMore: false },
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

/** The chat's visible height, the composer, the dock and the open queue, in viewport px. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const rect = (el: Element | null | undefined) => {
      if (!el) return null;
      const r = (el as HTMLElement).getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const steer = document.getElementById('cmd-steer') as any;
    const sr = steer?.shadowRoot as ShadowRoot | undefined;
    const conv = document.getElementById('panel-conv');
    const vp = conv?.shadowRoot?.querySelector('ui-log-scroller')?.shadowRoot?.querySelector('.ls-vp');
    const scroll = document.getElementById('panel-scroll');
    const chat = (() => {
      const a = vp?.getBoundingClientRect();
      const b = scroll?.getBoundingClientRect();
      if (!a || !b) return 0;
      return Math.max(0, Math.round(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)));
    })();
    const dock = sr?.querySelector('.as-dock') as HTMLElement | null;
    const pop = sr?.querySelector('.as-pop') as HTMLElement | null;
    const btns = [...(sr?.querySelectorAll('.as-pop .as-btn') ?? [])].map((b) =>
      Math.round((b as HTMLElement).getBoundingClientRect().height),
    );
    const comp = document.getElementById('pc-composer');
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      chat,
      inlineRows: sr?.querySelectorAll('.as-queue .as-item:not([data-leaving])').length ?? -1,
      dockShown: !!dock?.hasAttribute('data-shown') && getComputedStyle(dock as Element).visibility === 'visible',
      dockText: dock?.textContent ?? '',
      dock: rect(dock),
      field: rect(comp?.shadowRoot?.querySelector('textarea') ?? comp),
      send: rect(comp?.shadowRoot?.querySelector('.cp-send') ?? null),
      picker: rect(document.querySelector('#panel-controls ui-model-picker')),
      command: rect(document.getElementById('panel-command')),
      panel: rect(document.querySelector('#slide-panel .panel-surface') ?? document.getElementById('slide-panel')),
      open: !!steer?.queueOpen,
      sheet: !!pop?.hasAttribute('data-sheet'),
      pop: rect(pop),
      popRows: sr?.querySelectorAll('.as-list.is-docked .as-item:not([data-leaving])').length ?? 0,
      minBtn: btns.length ? Math.min(...btns) : 0,
      panelOpen: !!(window as any).panelOpen || !!document.getElementById('slide-panel')?.hasAttribute('open'),
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

interface Profile {
  name: string;
  engine: BrowserType;
  width: number;
  height: number;
  touch: boolean;
}

async function run(browser: Browser, p: Profile) {
  const ctx = await browser.newContext({
    viewport: { width: p.width, height: p.height },
    hasTouch: p.touch,
    isMobile: p.touch,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const tag = p.name;
  page.on('pageerror', (err) => {
    // WebKit reports a ResizeObserver whose notifications slipped to the next frame as an error event; it is the
    // dashboard's own observers on the composer coming back (A/B: also without this PR's CSS) and loses nothing.
    if (/ResizeObserver loop/.test(err.message)) return log(`${tag}: (webkit) ${err.message}`);
    check(false, `${tag}: page error: ${err.message}`);
  });
  await installMocks(page);
  await page.goto(`${BASE_URL}/dashboard/U001`);
  await page.waitForFunction(() => typeof (window as any).openPanel === 'function', null, { timeout: 20000 });
  await sleep(600);
  await openCard(page);

  // Before: the same notes laid out inline (the layout before the dock).
  await page.evaluate(() => {
    const el = document.getElementById('cmd-steer') as any;
    el.data = { ...el.data, queue: 'inline' };
  });
  await sleep(700);
  const before = await geometry(page);
  await page.screenshot({ path: path.join(OUT, `${tag}-0-inline-before.png`) });
  // After: the dashboard's own data again (renderPanelComposer, forced) — its queue: 'dock', not the library default.
  // A string expression: the page's top-level lets (_sessionCache, panelSessionKey) are in its global scope.
  await page.evaluate('renderPanelComposer(_sessionCache[panelSessionKey], true)');
  const handed = await page.evaluate(() => (document.getElementById('cmd-steer') as any).data?.queue);
  await sleep(700);
  const g = await geometry(page);
  check(handed === 'dock', `${tag}: D1 the dashboard hands the element queue: 'dock' (${handed})`);
  await page.screenshot({ path: path.join(OUT, `${tag}-1-dock.png`) });
  log(`${tag}: chat ${before.chat}px inline → ${g.chat}px docked; dock ${JSON.stringify(g.dock)}`);
  check(
    g.dockShown && g.dockText === '3' && g.inlineRows === 0,
    `${tag}: D1 the three notes wait behind the button (3)`,
  );
  check(g.chat > before.chat, `${tag}: D1 the chat shows more (${before.chat} → ${g.chat}px)`);
  const d = g.dock;
  const panelRight = g.panel ? g.panel.right : g.vw;
  check(
    !!d &&
      d.right <= panelRight &&
      d.right >= panelRight - 40 &&
      d.left > (g.panel?.left ?? 0) + (g.panel?.w ?? g.vw) / 2,
    `${tag}: D1 the button sits on the right (right edge ${d?.right} of ${panelRight})`,
  );
  const overlaps = (a: typeof d, b: typeof d) =>
    !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  check(!overlaps(d, g.field) && !overlaps(d, g.send), `${tag}: D1 the button covers neither the field nor Send`);
  check(!overlaps(d, g.picker), `${tag}: D1 the button covers no part of the model picker`);
  check(
    !!d && d.w === d.h && d.w >= (p.touch ? 44 : 32),
    `${tag}: D1 round, ${d?.w}px (${p.touch ? '≥44 touch' : '≥32'})`,
  );

  const dockSel = 'ui-agent-steering#cmd-steer >> .as-dock';
  if (!p.touch) {
    await page.hover(dockSel);
    await sleep(450);
    const peek = await geometry(page);
    check(peek.open && !peek.sheet, `${tag}: D2 hovering the button peeks the queue`);
    await page.screenshot({ path: path.join(OUT, `${tag}-2-peek.png`) });
    await page.click(dockSel);
    await page.mouse.move(20, 20);
    await sleep(500);
    const pinned = await geometry(page);
    check(pinned.open, `${tag}: D2 a click pins it — the pointer leaving keeps it open`);
    check(
      !!pinned.pop && pinned.pop.top >= 0 && pinned.pop.bottom <= pinned.vh && pinned.pop.right <= pinned.vw,
      `${tag}: D2 the queue is on screen ${JSON.stringify(pinned.pop)}`,
    );
    check(pinned.popRows === 3, `${tag}: D2 it lists the three notes`);
    await page.screenshot({ path: path.join(OUT, `${tag}-3-open.png`) });
    await page.click('ui-agent-steering#cmd-steer >> .as-list.is-docked .as-item >> nth=2 >> [data-act="cancel"]');
    await sleep(500);
    check(posted.includes('cancel f3'), `${tag}: D5 Cancel in the queue posts /queue/f3/cancel`);
    await page.keyboard.press('Escape');
    await sleep(500);
    const after = await geometry(page);
    check(!after.open && after.panelOpen, `${tag}: D2 Esc closes the queue, the card stays open`);
  } else {
    await page.tap(dockSel);
    await sleep(700);
    const o = await geometry(page);
    await page.screenshot({ path: path.join(OUT, `${tag}-3-open.png`) });
    if (p.width < 640) {
      check(o.open && o.sheet, `${tag}: D3 a tap opens the bottom sheet`);
      check(
        !!o.pop && o.pop.left === 0 && o.pop.w === o.vw && Math.abs(o.pop.bottom - o.vh) <= 1 && o.pop.top >= 0,
        `${tag}: D3 the sheet spans the screen and sits on its bottom ${JSON.stringify(o.pop)}`,
      );
    } else {
      check(o.open && !o.sheet, `${tag}: D4 a tap opens the popover beside the button`);
      check(
        !!o.pop && o.pop.top >= 0 && o.pop.bottom <= o.vh && o.pop.right <= o.vw && o.pop.left >= 0,
        `${tag}: D4 the popover is on screen ${JSON.stringify(o.pop)}`,
      );
    }
    check(o.popRows === 3 && o.minBtn >= 44, `${tag}: D3 three notes, buttons ≥ 44px (${o.minBtn})`);
    await page.tap('ui-agent-steering#cmd-steer >> .as-list.is-docked .as-item >> nth=2 >> [data-act="cancel"]');
    await sleep(500);
    check(posted.includes('cancel f3'), `${tag}: D5 Cancel in the queue posts /queue/f3/cancel`);
    if (p.width < 640) await page.tap('ui-agent-steering#cmd-steer >> .as-scrim', { position: { x: 30, y: 30 } });
    else await page.keyboard.press('Escape');
    await sleep(600);
    const c = await geometry(page);
    check(!c.open && c.panelOpen, `${tag}: D3 the ${p.width < 640 ? 'scrim' : 'Esc'} closes the queue, the card stays`);
    if (p.width < 640) {
      // D6: the reader scrolls back; the composer tucks away (rdTuck — what reading does).
      const dockAt = c.dock;
      await page.evaluate(() => (window as any).rdTuck(true));
      await sleep(700);
      const t = await page.evaluate((d) => {
        const sr = (document.getElementById('cmd-steer') as any).shadowRoot as ShadowRoot;
        const dock = sr.querySelector('.as-dock') as HTMLElement;
        const r = dock.getBoundingClientRect();
        // Its lowest strip still on screen — below ^ (#pc-reveal), where a peeking button would be seen and tapped.
        const x = Math.round(r.left + r.width / 2);
        const y = Math.min(window.innerHeight - 2, Math.round(r.bottom - 3));
        let hit = document.elementFromPoint(x, y) as Element | null;
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        return {
          x,
          y,
          tucked: !!document.getElementById('slide-panel')?.hasAttribute('data-tuck'),
          hitDock: hit === dock || !!hit?.closest?.('.as-dock'),
          was: d,
        };
      }, dockAt);
      await page.screenshot({ path: path.join(OUT, `${tag}-5-tucked.png`) });
      check(t.tucked && !t.hitDock, `${tag}: D6 tucked, the queue button is not under the finger at its place`);
      await page.touchscreen.tap(t.x, t.y);
      await sleep(500);
      const after = await geometry(page);
      check(!after.open, `${tag}: D6 a tap where it was opens no queue`);
      await page.evaluate(() => (window as any).rdTuck(false));
      await sleep(600);
      const back = await geometry(page);
      check(back.dockShown, `${tag}: D6 the composer back, the button is back`);
    }
  }
  posted.length = 0;
  await ctx.close();
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}${UI_DIST ? ` · ui ${UI_DIST}` : ''}`);
  const profiles: Profile[] = [
    { name: 'desktop-1440x900', engine: chromium, width: 1440, height: 900, touch: false },
    { name: 'iphone17pro-402x874', engine: webkit, width: 402, height: 874, touch: true },
    { name: 'iphone17promax-440x956', engine: webkit, width: 440, height: 956, touch: true },
    { name: 'fold8-cover-416x657', engine: chromium, width: 416, height: 657, touch: true },
    { name: 'fold8-open-816x616', engine: chromium, width: 816, height: 616, touch: true },
    { name: 'fold8ultra-cover-360x840', engine: chromium, width: 360, height: 840, touch: true },
  ];
  const only = process.env.STEERING_DOCK_ONLY;
  try {
    for (const engine of [chromium, webkit]) {
      const list = profiles.filter((p) => p.engine === engine && (!only || p.name.startsWith(only)));
      if (!list.length) continue;
      const browser = await engine.launch({ headless: true });
      try {
        for (const p of list) await run(browser, p);
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
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
