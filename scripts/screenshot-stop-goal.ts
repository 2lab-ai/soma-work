/**
 * 중지 while a goal runs (SSOT 2026-11-19: "작업 카드 중지누르면 현재 진행중이 골이 있으면 골때문에 중지가 안됨 그래서 작업 카드
 * 눌렀을때 진행중인 goal이 있으면 진행중인 goal을 puase하고 중지하겠냐고 한번더 물어보고 최종 확인 받으면, goal부터 pause 처리하고
 * 작업 중지처리해줘") — browser receipts.
 *
 * The real web server serves the real dashboard to a real sign-in; the sessions go through sessionToKanban as the
 * host's do; the stop handler is recorded. Chromium presses the opened card's 중지 (exit 1 on any failure):
 *
 *   G1  a card whose goal runs: 중지 opens the question — the objective, the queued goal that keeps waiting — and
 *       sends nothing
 *   G2  취소 closes it and still sends nothing
 *   G3  the yes sends one stop carrying the goal to pause; the toast says both happened
 *   G4  a card with no goal: 중지 stops at once, no question, no goal to pause
 *   G5  no page errors
 *
 * Run from the repo root with a clean env:
 *   T=$(mktemp -d); env -i PATH="$PATH" HOME="$T" TMPDIR="$T" SOMA_CONFIG_DIR=$T/cfg SOMA_INSTANCE_DIR=$T/inst \
 *     PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" npx tsx scripts/screenshot-stop-goal.ts [outDir]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'stop-goal');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.STOP_GOAL_PORT || '33963';
process.env.CONVERSATION_VIEWER_PORT = PORT;
process.env.CONVERSATION_VIEWER_TOKEN = 'shot-token';
const BASE = `http://127.0.0.1:${PORT}`;
const CH = 'C_STOPGOAL';
const M = 60_000;
const GOAL_TS = '1793000000.000101';
const PLAIN_TS = '1793000000.000102';

const failures: string[] = [];
function check(ok: boolean, what: string, detail?: unknown) {
  console.log(
    `${ok ? '[ok]  ' : '[FAIL]'} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ''}`,
  );
  if (!ok) failures.push(what);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function goal(goalId: string, objective: string, status: string) {
  return {
    goalId,
    objective,
    status,
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U001',
    continuationCount: 3,
    maxContinuations: 10,
    epoch: 4,
  };
}
function sessions() {
  const now = Date.now();
  const base = (ts: string, title: string) => ({
    ownerId: 'U001',
    ownerName: 'Zhuge',
    channelId: CH,
    threadTs: ts,
    sessionId: `sess-${ts}`,
    model: 'claude-opus-5-5[1m]',
    state: 'MAIN',
    workflow: 'zwork',
    title,
    activityState: 'working',
    lastActivity: new Date(now - M),
    activeLegStartedAtMs: now - 4 * M,
  });
  return new Map<string, Record<string, unknown>>([
    [
      `${CH}:${GOAL_TS}`,
      {
        ...base(GOAL_TS, 'goal이 도는 작업 — 결제 폼 검증'),
        goal: goal('g1', '결제 폼 검증을 끝까지 — 테스트 전부 통과', 'active'),
        goalQueue: [goal('g2', '릴리즈 노트 쓰기', 'queued')],
      },
    ],
    [`${CH}:${PLAIN_TS}`, base(PLAIN_TS, 'goal 없는 작업 — 로그 파서 정리')],
  ]);
}

const cardSel = (ts: string) => `li.ib-card[data-card$="${ts}"]`;
// An opened card's body is light DOM slotted into the board element (slot="body:<key>"): its actions live there.
const stopSel = (ts: string) => `#kanban > [slot^="body:"][slot$="${ts}"] button[data-action="stop"]`;
async function openCard(page: Page, ts: string) {
  await page.click(`${cardSel(ts)} [data-win="expand"]`);
  await page.waitForSelector(stopSel(ts), { timeout: 10_000 });
  await sleep(700);
}
const dialogOpen = (page: Page) =>
  page.evaluate(() => {
    const d = document.getElementById('stop-goal-dialog') as (HTMLElement & { open?: boolean }) | null;
    return !!d && (d.hasAttribute('open') || d.open === true);
  });

async function main() {
  const live = sessions();
  const stops: Array<{ key: string; opts: unknown }> = [];
  const dashboard = await import('../src/conversation/dashboard');
  dashboard.setDashboardSessionAccessor(() => live);
  dashboard.setDashboardStopHandler(async (key, opts) => {
    stops.push({ key, opts });
  });
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  console.log(`server ${BASE}`);
  const { issueSlackToken } = await import('../src/conversation/oauth');
  const token = issueSlackToken({ slackUserId: 'U001', email: 'z@2lab.ai', name: 'Zhuge' });
  const sso = await fetch(`${BASE}/auth/sso?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const [cookieName, cookieValue] = String(sso.headers.get('set-cookie')).split(';')[0].split('=');

  const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
    await ctx.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
    // tsx names inner functions with __name(): the page needs it for the evaluated probes.
    await ctx.addInitScript('window.__name = function (f) { return f; };');
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/dashboard/U001`);
    await page.waitForSelector(`${cardSel(GOAL_TS)} [data-win="expand"]`, { timeout: 20_000 });
    await sleep(800);

    // G1 — the card whose goal runs asks first.
    await openCard(page, GOAL_TS);
    await page.screenshot({ path: path.join(OUT, '0-card-open.png') });
    await page.click(stopSel(GOAL_TS));
    await page.waitForFunction(
      () => (document.getElementById('stop-goal-body')?.textContent || '').includes('진행 중인 goal'),
      undefined,
      { timeout: 5_000 },
    );
    await sleep(500);
    const body = await page.evaluate(() => document.getElementById('stop-goal-body')?.textContent || '');
    await page.screenshot({ path: path.join(OUT, '1-question.png') });
    check(
      (await dialogOpen(page)) &&
        body.includes('결제 폼 검증을 끝까지') &&
        body.includes('대기 중인 goal 1개는 시작하지 않고') &&
        stops.length === 0,
      'G1 중지 on a card whose goal runs opens the question and sends nothing',
      { body, stops },
    );

    // G2 — 취소.
    await page.click('#stop-goal-dialog button:has-text("취소")');
    await sleep(500);
    check(!(await dialogOpen(page)) && stops.length === 0, 'G2 취소 closes the question; nothing sent', { stops });

    // G3 — the yes.
    await page.click(stopSel(GOAL_TS));
    await page.waitForSelector('#stop-goal-confirm', { state: 'visible', timeout: 5_000 });
    await sleep(400);
    await page.click('#stop-goal-confirm');
    // The toast draws inside a shadow root: search every open root's text.
    await page.waitForFunction(
      (text) => {
        const seen = (root: Document | ShadowRoot): boolean => {
          if ((root as any).body ? document.body.textContent?.includes(text) : root.textContent?.includes(text))
            return true;
          for (const el of Array.from(root.querySelectorAll('*')))
            if (el.shadowRoot && seen(el.shadowRoot)) return true;
          return false;
        };
        return seen(document);
      },
      'goal을 일시정지하고 세션을 중지했어요',
      { timeout: 5_000 },
    );
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, '2-paused-and-stopped.png') });
    check(
      stops.length === 1 &&
        stops[0].key === `${CH}:${GOAL_TS}` &&
        JSON.stringify(stops[0].opts) === JSON.stringify({ pauseGoalId: 'g1' }),
      'G3 the yes sends one stop with the goal to pause; the toast says both happened',
      stops,
    );

    // G4 — no goal: stops at once.
    await openCard(page, PLAIN_TS);
    await page.click(stopSel(PLAIN_TS));
    await sleep(800);
    check(
      !(await dialogOpen(page)) &&
        stops.length === 2 &&
        stops[1].key === `${CH}:${PLAIN_TS}` &&
        stops[1].opts === undefined,
      'G4 a card with no goal stops at once — no question, no goal to pause',
      stops,
    );

    check(errors.length === 0, 'G5 no page errors', errors);
  } finally {
    await browser.close();
    await ws.stopWebServer();
  }
  console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
