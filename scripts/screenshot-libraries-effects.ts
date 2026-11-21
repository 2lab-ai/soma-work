/**
 * The Libraries.dev effects on the dashboard's own spots (Z 2026-11-21: "모든 컴포넌트 … 어디에 적용할지 고민해서 최적한
 * 스팟이 있으면 적용해줘") — browser receipts on the real page, the real server and the installed @2lab.ai/ui (≥ 0.44.0).
 * The board, the turns and the call are browser routes; the WebSocket is a stub. Each check prints what it measured.
 *
 *   L1  the detail card's head shows the card's face: <ui-bot-avatar> star (Fable) · working
 *   L2  the next steps are one liquid (<ui-gooey>): the new answer's steps split out of the first; a press swallows the
 *       others and the bar goes once that is over
 *   L3  the writing row's orb follows the agent's last tool (Edit → composing)
 *   L4  a live call's view wears <ui-voice-ring> (speaking while the agent's speech plays); the end of the call takes it
 *   L5  the sign-in wordmark is liquid metal (<ui-metal-text>, defined and drawn)
 *
 * Run from the repo root (keeps state out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-libraries-effects.ts [outDir]
 * Software WebGL (SwiftShader) draws a few frames a second: the shots show the shapes, not the real pace.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'libraries-effects');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.LIB_FX_PORT || '33942';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NOW = Date.now();
const M = 60_000;
const KEY_F = 'mock-inst::work:C701:1700000000.000100';
const KEY_W = 'mock-inst::work:C702:1700000000.000200';
const CALL_ID = 'call-fx-1';

function session(key: string, title: string, channel: string, state: string, model: string, extra = {}) {
  return {
    key,
    title,
    displayHeadline: title,
    summaryTitle: title,
    summaryBody: '',
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model,
    effort: 'high',
    channelId: channel,
    sessionState: 'MAIN',
    activityState: state,
    conversationId: `conv-${channel}`,
    lastActivity: new Date(NOW - 3 * M).toISOString(),
    activeLegStartedAtMs: NOW - 12 * M,
    activeAccumulatedMs: 0,
    tokenUsage: { totalInputTokens: 300_000, totalOutputTokens: 40_000, totalCostUsd: 6.2, contextUsagePercent: 22 },
    artifacts: { count: 0, recent: [] },
    ...extra,
  };
}
// An idle Fable task whose last answer names its next steps; a working Opus task whose agent is editing.
const FABLE = session(KEY_F, 'Fable — 다음 행동 고르기', 'C701', 'idle', 'claude-fable-5-2[1m]');
const WORKER = session(KEY_W, 'Opus — 문서 고치는 중', 'C702', 'working', 'claude-opus-5-5[1m]', {
  agentRoot: { lastTool: 'Edit' },
});
const BOARD = { waiting: [], working: [WORKER], idle: [FABLE] };
const STEPS = [
  { label: 'dev에 배포해서 확인합니다', command: '$user:dev', recommended: true },
  { label: '확인 후 prod에 배포합니다', command: '$user:prod' },
  { label: '', command: '1193 진행' },
];
const turnsOf = (cid: string) =>
  cid === 'conv-C701'
    ? [
        { id: 'u1', role: 'user', timestamp: NOW - 9 * M, userName: 'Zhuge', rawContent: '배포 준비해줘' },
        {
          id: 'a1',
          role: 'assistant',
          timestamp: NOW - 4 * M,
          rawContent: '준비했어요. 다음 행동을 고르세요.',
          summaryTitle: '준비 완료',
          nextActions: STEPS,
        },
      ]
    : [{ id: 'u2', role: 'user', timestamp: NOW - 2 * M, userName: 'Zhuge', rawContent: 'README 고쳐줘' }];
// A live call whose agent started speaking 2 s before `at` (a minute of audio): the ring speaks. Made fresh per run.
const liveCall = (at: number): Record<string, unknown> => ({
  id: CALL_ID,
  env: 'dev',
  direction: 'outbound',
  ourNumber: '0200000000',
  peerNumber: '01000000000',
  title: '예약 확인 전화',
  status: 'active',
  createdAt: at - 2 * M,
  answeredAt: at - 2 * M,
  model: 'claude-sonnet-4-6',
  voice: 'cwon',
  transcript: [
    { role: 'agent', at: at - 100_000, text: '안녕하세요, 예약 확인차 연락드렸어요.' },
    { role: 'peer', at: at - 80_000, text: '네, 말씀하세요.' },
    { role: 'agent', at: at - 2_000, text: '내일 오후 세 시 예약 맞으시죠?' },
  ],
  work: [
    { kind: 'reply', at: at - 2_500, text: '내일 오후 세 시 예약 맞으시죠?', ms: 400 },
    { kind: 'tts', at: at - 2_000, text: '내일 오후 세 시 예약 맞으시죠?', firstByteMs: 200, audioMs: 60_000 },
  ],
});
let CALL: Record<string, unknown> = liveCall(NOW);

const PAGE_HELPERS = [
  'window.WebSocket = function StubWebSocket(url) { this.url = url; window.__ws = this; };',
  'window.WebSocket.prototype.close = function () {};',
  'window.__name = function (f) { return f; };',
].join('\n');

async function installMocks(page: Page) {
  await page.addInitScript({ content: PAGE_HELPERS });
  await page.addInitScript({ content: 'localStorage.setItem("soma-board-view", "board");' });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'x' } }),
  );
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: BOARD } }));
  await page.route('**/api/dashboard/phone-calls/**', (r) => r.fulfill({ json: { call: CALL } }));
  await page.route(/\/api\/dashboard\/session\/.*/, (r) => {
    const u = new URL(r.request().url());
    const cid = decodeURIComponent(u.pathname.split('/')[4] || '');
    if (r.request().method() === 'POST') return r.fulfill({ json: { ok: true } });
    return r.fulfill({ json: { ok: true, turns: turnsOf(cid), hasMore: false } });
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
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const shot = (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 120_000, ...(clip ? { clip } : {}) });

async function newPage(browser: Browser, theme: 'dark' | 'light') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const tok = process.env.CONVERSATION_VIEWER_TOKEN;
  if (tok)
    await ctx.addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
  await ctx.addInitScript({ content: `localStorage.setItem("soma-theme", ${JSON.stringify(theme)});` });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
  await installMocks(page);
  return page;
}

async function panelRun(browser: Browser, theme: 'dark' | 'light') {
  const page = await newPage(browser, theme);
  // Watch the next-actions bar from the start: the split runs the moment the set is painted.
  await page.addInitScript({
    content: `window.__naLog = []; new MutationObserver(function () {
      var b = document.getElementById('panel-next-bar'); if (!b || window.__naWatching) return; window.__naWatching = true;
      var t0 = performance.now();
      (function tick() {
        var items = b.querySelectorAll('ui-gooey-item');
        window.__naLog.push([Math.round(performance.now() - t0), b.hidden, Array.prototype.map.call(items, function (i) { return i.style.transform; }).join('|')]);
        if (performance.now() - t0 < 30000) requestAnimationFrame(tick);
      })();
    }).observe(document, { childList: true, subtree: true });`,
  });
  await page.goto(`${BASE_URL}/dashboard/U001?session=${encodeURIComponent(KEY_F)}`);
  await page.waitForFunction(() => !!document.querySelector('#panel-next-bar ui-gooey-item'), null, {
    timeout: 60_000,
  });
  await sleep(2500);

  // L1 — the face.
  const face = await page.evaluate(() => {
    const a = document.getElementById('panel-avatar');
    return a
      ? {
          hidden: a.hidden,
          shape: a.getAttribute('shape'),
          state: a.getAttribute('state'),
          defined: !!customElements.get('ui-bot-avatar'),
        }
      : null;
  });
  check(
    !!face && !face.hidden && face.shape === 'star' && face.defined,
    `L1 ${theme} the detail card's face (Fable star)`,
    face,
  );
  // The whole page: the board, and the detail card with its face in the head and the liquid bar above the composer.
  const rect = await page.evaluate(() => {
    const r = document.getElementById('panel-avatar')?.getBoundingClientRect();
    return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null;
  });
  log(`      avatar rect ${JSON.stringify(rect)}`);
  await shot(page, `L1-panel-${theme}`);

  // L2 — split in.
  const split = (await page.evaluate(() => (window as any).__naLog)) as [number, boolean, string][];
  const moved = split.filter(([, hidden, tf]) => !hidden && /translate\((?!0px, 0px)/.test(tf));
  const rest = split.at(-1)?.[2] ?? '';
  check(
    moved.length > 0 && !/translate\((?!0px, 0px)/.test(rest),
    `L2 ${theme} the steps split out of one drop, then rest`,
    {
      framesMoving: moved.length,
      firstMoving: moved[0],
      rest,
    },
  );
  const bar = await page.evaluate(() => {
    const r = document.getElementById('panel-next-bar')!.getBoundingClientRect();
    return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 };
  });
  await shot(page, `L2-gooey-rest-${theme}`, bar);
  // A press: the others run into it; the bar keeps them while that runs, then goes.
  await page.evaluate(() => {
    (window as any).__naLog.length = 0;
  });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('#panel-next-bar .na-btn')).find(
      (x) => x.getAttribute('data-na-cmd') === '$user:prod',
    );
    b!.click();
  });
  await sleep(3000);
  const merge = (await page.evaluate(() => (window as any).__naLog)) as [number, boolean, string][];
  const merging = merge.filter(([, hidden, tf]) => !hidden && /scale\(0\.[4-9]/.test(tf));
  const hiddenNow = await page.evaluate(() => document.getElementById('panel-next-bar')!.hidden);
  check(merging.length > 0 && hiddenNow, `L2 ${theme} the press swallows the others, then the bar goes`, {
    framesMerging: merging.length,
    firstMerging: merging[0],
    hiddenNow,
  });
  await page.context().close();
}

async function orbRun(browser: Browser) {
  const page = await newPage(browser, 'dark');
  await page.goto(`${BASE_URL}/dashboard/U001?session=${encodeURIComponent(KEY_W)}`);
  await page.waitForFunction(() => !!document.querySelector('ui-conversation'), null, { timeout: 60_000 });
  await sleep(3000);
  const orb = await page.evaluate(() => {
    const convs = Array.from(document.querySelectorAll<any>('ui-conversation'));
    const c = convs.find((x) => x.data && x.data.pending);
    if (!c) return null;
    // The writing row is a nested <ui-ai-answer>; its orb is in that element's own shadow root.
    const a = c.shadowRoot?.querySelector<any>('ui-ai-answer');
    const o = a?.shadowRoot?.querySelector('ui-thinking-orb.ans-orb');
    return { pending: c.data.pending, orb: !!o, state: o && (o.getAttribute('state') || o.getAttribute('activity')) };
  });
  check(
    !!orb && orb.pending && orb.pending.activity === 'composing' && orb.orb,
    'L3 the writing row’s orb follows Edit (composing)',
    orb,
  );
  await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll<any>('ui-conversation')).find((x) => x.data?.pending);
    (c.shadowRoot.querySelector('ui-ai-answer') as HTMLElement).scrollIntoView({ block: 'center' });
  });
  await shot(page, 'L3-orb-dark');
  await page.context().close();
}

async function phoneRun(browser: Browser, theme: 'dark' | 'light') {
  const page = await newPage(browser, theme);
  CALL = liveCall(Date.now());
  await page.goto(`${BASE_URL}/dashboard/U001?phoneCall=${CALL_ID}`);
  await page.waitForFunction(() => !!document.querySelector('#phone-ring-box ui-voice-ring'), null, {
    timeout: 60_000,
  });
  await page.waitForFunction(() => !!customElements.get('ui-voice-ring'), null, { timeout: 60_000 });
  await sleep(2500);
  const ring = await page.evaluate(() => {
    const box = document.getElementById('phone-ring-box')!;
    const r = box.querySelector<any>('ui-voice-ring');
    return {
      hidden: box.hidden,
      state: r && r.getAttribute('state'),
      levelIsGetter: !!r && typeof (r.data && r.data.level) === 'function',
      drawn: !!r && !!r.shadowRoot && !!r.shadowRoot.querySelector('canvas'),
    };
  });
  check(
    !ring.hidden && ring.state === 'speaking' && ring.levelIsGetter && ring.drawn,
    `L4 ${theme} a live call speaks through the ring`,
    ring,
  );
  const dlg = await page.evaluate(() => {
    const r = document.getElementById('phone-call-dialog')!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 520) };
  });
  await shot(page, `L4-ring-${theme}`, dlg);
  // The call ends: the next copy of it takes the ring away.
  CALL = { ...CALL, status: 'ended', endedStatus: 'completed', endedAt: Date.now(), updatedAt: Date.now() };
  await page.evaluate(() => (window as any).loadPhoneCall());
  await sleep(2500);
  const after = await page.evaluate(() => {
    const box = document.getElementById('phone-ring-box')!;
    return { hidden: box.hidden, ring: !!box.querySelector('ui-voice-ring') };
  });
  check(after.hidden && !after.ring, `L4 ${theme} the end of the call takes the ring away`, after);
  await page.context().close();
}

async function signInRun(browser: Browser, theme: 'dark' | 'light') {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
  await ctx.addInitScript({ content: `localStorage.setItem("soma-theme", ${JSON.stringify(theme)});` });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
  await page.goto(`${BASE_URL}/login`);
  await page.waitForFunction(() => !!customElements.get('ui-metal-text'), null, { timeout: 60_000 });
  await sleep(4000);
  const m = await page.evaluate(() => {
    const card = document.querySelector('ui-auth-card');
    const t = card && card.shadowRoot && card.shadowRoot.querySelector<any>('ui-metal-text');
    return t ? { text: t.textContent, preset: t.getAttribute('preset'), drawn: !!t.shadowRoot } : null;
  });
  check(!!m && m.text === 'soma-work' && m.drawn, `L5 ${theme} the sign-in wordmark is liquid metal`, m);
  await shot(page, `L5-metal-${theme}`);
  await ctx.close();
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  const runs: [string, (b: Browser) => Promise<void>][] = [
    ['panel dark', (b) => panelRun(b, 'dark')],
    ['panel light', (b) => panelRun(b, 'light')],
    ['orb', orbRun],
    ['phone dark', (b) => phoneRun(b, 'dark')],
    ['phone light', (b) => phoneRun(b, 'light')],
    ['sign-in dark', (b) => signInRun(b, 'dark')],
    ['sign-in light', (b) => signInRun(b, 'light')],
  ];
  const only = process.env.ONLY;
  try {
    for (const [name, run] of runs) {
      if (only && !only.split(',').some((o) => name.startsWith(o))) continue;
      const browser = await chromium.launch({
        headless: true,
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      });
      try {
        await run(browser);
      } catch (e) {
        check(false, `${name} ran`, String(e).slice(0, 300));
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
