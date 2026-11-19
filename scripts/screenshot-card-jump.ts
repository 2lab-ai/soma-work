/**
 * Task card jump (2026-11-19) — browser receipt: a live update of one card (its cost) moves no card under it.
 *
 * The bug: <ui-agent-inbox> (@2lab.ai/ui ≤ 0.43.0) rewrote a changed card's face with its clocks empty and drew them
 * only after it measured the board for its move animation. A card whose foot wraps once its status clock shows
 * (repo · channel · cost · model chips beside "실행 중 · 12분 11초") was measured one line short, so every card under
 * it started a line lower (+22.8px) and slid back up — on every cost push. Fixed in @2lab.ai/ui 0.43.1.
 *
 * The real web server serves the real page and the installed @2lab.ai/ui; the board JSON is a browser route and the
 * WebSocket a stub. Each check records every card's top and height on every frame for 1.5 s after the push and
 * prints the cards that moved (top before → [min..max] → after), never a bare boolean.
 *
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-card-jump.ts
 */

import { chromium, type Page } from 'playwright';

const PORT = process.env.CARD_JUMP_PORT || '33941';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const NOW = Date.now();
const M = 60_000;
const NAMES = ['A', 'B', 'C', 'D', 'E'];
const KEYS = NAMES.map((_, i) => `mock-inst::work:C50${i}:1700000000.00010${i}`);

// A card as the board gets it while a turn runs: a task list, linked issue and PR, two sub-agents, artifacts — and a
// repo, so the foot holds repo · channel · cost · model next to the running clock (it wraps in a board column).
function session(i: number, title: string, state: string, cost: number) {
  const channel = `C50${i}`;
  return {
    key: KEYS[i],
    title,
    displayHeadline: title,
    summaryTitle: title,
    summaryBody: '요약',
    ownerId: 'U001',
    ownerName: 'Zhuge',
    workflow: 'zwork',
    model: 'claude-opus-5-5[1m]',
    effort: 'high',
    channelId: channel,
    sessionState: 'MAIN',
    activityState: state,
    conversationId: `conv-${channel}`,
    lastActivity: new Date(NOW - 3 * M).toISOString(),
    activeLegStartedAtMs: NOW - 12 * M,
    activeAccumulatedMs: 0,
    slackThreadUrl: `https://slack.example/archives/${channel}/p1700000000000`,
    tokenUsage: { totalInputTokens: 300_000, totalOutputTokens: 40_000, totalCostUsd: cost, contextUsagePercent: 22 },
    issueShortRef: '#11',
    issueUrl: 'https://github.com/example/repo/issues/11',
    issueTitle: 'card jump',
    prShortRef: 'PR #12',
    prUrl: 'https://github.com/example/repo/pull/12',
    prTitle: 'fix',
    agents: [
      { id: 'a1', name: 'explore', status: 'running', startedAt: NOW - 2 * M },
      { id: 'a2', name: 'review', status: 'completed', startedAt: NOW - 5 * M },
    ],
    agentsTotal: 2,
    artifacts: {
      count: 2,
      recent: [
        { id: 'f1', name: 'shot.png', kind: 'image' },
        { id: 'f2', name: 'report.html', kind: 'file' },
      ],
    },
    repo: 'example/soma-work',
    tasks: [
      { id: '1', content: '카드 튐 재현', activeForm: '재현 중', status: 'completed' },
      { id: '2', content: '원인 특정하고 고치기', activeForm: '고치는 중', status: 'in_progress' },
    ],
  };
}
type Session = ReturnType<typeof session>;
const SESSIONS: Session[] = [
  session(0, '첫 카드 — 비용이 오른다', 'working', 6.2),
  session(1, '둘째 카드', 'working', 3.1),
  session(2, '셋째 카드', 'working', 1.4),
  session(3, '넷째 카드', 'idle', 2.0),
  session(4, '다섯째 카드', 'idle', 0.5),
];
const board = (list: Session[]) => ({ waiting: [], working: list.slice(0, 3), idle: list.slice(3) });

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
  await page.route('**/api/dashboard/sessions**', (r) => r.fulfill({ json: { board: board(SESSIONS) } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/artifacts/, (r) => r.fulfill({ json: { artifacts: [] } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/worklog/, (r) =>
    r.fulfill({ json: { entries: [], hasMore: false } }),
  );
  await page.route(/\/api\/dashboard\/session\/[^/?]+(\?.*)?$/, (r) => {
    const cid = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    return r.fulfill({ json: { id: cid, title: cid, titleSub: '', turnCount: 0, turns: [], hasMore: false } });
  });
}

const failures: string[] = [];
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
type Frame = { t: number; s: ([number, number] | null)[] };

// Every card's top and height, each frame for `ms` after `msg` lands on the page's WebSocket.
async function check(page: Page, label: string, msg: unknown, ms = 1500) {
  const frames = (await page.evaluate(
    ({ data, ms, keys }) =>
      new Promise<Frame[]>((resolve) => {
        const root = (document.getElementById('kanban') as HTMLElement).shadowRoot as ShadowRoot;
        const snap = () =>
          keys.map((k: string) => {
            const c = root.querySelector(`li.ib-card[data-card="${k}"]`);
            if (!c) return null;
            const r = c.getBoundingClientRect();
            return [Math.round(r.y * 10) / 10, Math.round(r.height * 10) / 10] as [number, number];
          });
        const out: Frame[] = [{ t: -1, s: snap() }];
        const t0 = performance.now();
        (window as unknown as { __ws: { onmessage: (e: { data: string }) => void } }).__ws.onmessage({ data });
        const tick = () => {
          const t = performance.now() - t0;
          out.push({ t: Math.round(t), s: snap() });
          if (t < ms) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
    { data: JSON.stringify(msg), ms, keys: KEYS },
  )) as Frame[];
  const moved: string[] = [];
  for (let i = 0; i < KEYS.length; i++) {
    const ys = frames.map((f) => f.s[i]?.[0]).filter((v): v is number => v !== undefined);
    const hs = frames.map((f) => f.s[i]?.[1]).filter((v): v is number => v !== undefined);
    if (!ys.length) continue;
    const span = (v: number[]) => `${v[0]}→[${Math.min(...v)}..${Math.max(...v)}]→${v[v.length - 1]}`;
    if (Math.max(...ys) - Math.min(...ys) > 0.5 || Math.max(...hs) - Math.min(...hs) > 0.5)
      moved.push(`${NAMES[i]}: top ${span(ys)} height ${span(hs)}`);
  }
  console.log(`${moved.length ? '[FAIL]' : '[ok]  '} ${label} — ${moved.length ? 'a card moved' : 'no card moved'}`);
  for (const m of moved) console.log(`         ${m}`);
  if (moved.length) failures.push(label);
}

// The board with one card's cost raised by $0.07 (the cache keeps the raise for the next push).
function raise(i: number): Session[] {
  const t = SESSIONS[i].tokenUsage;
  SESSIONS[i] = { ...SESSIONS[i], tokenUsage: { ...t, totalCostUsd: Math.round((t.totalCostUsd + 0.07) * 100) / 100 } };
  return SESSIONS.slice();
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  // Single-process Chromium: a sandboxed agent shell cannot register its Mach port for child processes.
  const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const tok = process.env.CONVERSATION_VIEWER_TOKEN;
    if (tok)
      await ctx.addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await installMocks(page);
    await page.goto(`${BASE_URL}/dashboard/U001`);
    await page.waitForSelector(`li.ib-card[data-card="${KEYS[0]}"]`, { timeout: 20_000 });
    await sleep(1200);
    const one = (i: number) => ({ type: 'sessionUpdated', session: raise(i)[i] });
    await check(page, 'S1 one card push (sessionUpdated): A cost +$0.07, B and C under it', one(0));
    await sleep(300);
    await check(page, 'S2 board push (session_update): A cost +$0.07', {
      type: 'session_update',
      board: board(raise(0)),
    });
    await sleep(300);
    await check(page, 'S3 the middle card: B cost +$0.07, C under it', one(1));
    await page.click(`li.ib-card[data-card="${KEYS[0]}"] [data-win="expand"]`);
    await sleep(1500);
    await check(page, 'S4 A open in place: A cost +$0.07', one(0), 2000);
    console.log(`page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
    if (errors.length) failures.push('page errors');
  } finally {
    await browser.close();
    await ws.stopWebServer();
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  if (failures.length) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
