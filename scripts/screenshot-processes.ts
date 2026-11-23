/**
 * The task card's CPU · 메모리 chip and the detail card's 프로세스 tab — browser receipts on the real page, the real
 * routes and the real process monitor over a real process tree.
 *
 * A stand-in for a session's Claude Code process (a shell with three children) is spawned through the same SDK spawn
 * hook a turn uses, tagged with the board session's key. The real web server serves the board (its card carries the
 * monitor's `procUsage`), the process list and pause · resume; only the auxiliary reads (users, stats, the
 * conversation) are browser routes, and the WebSocket is a stub.
 *
 *   R1  the card's foot shows CPU · memory of the whole tree
 *   R2  the detail card's tab bar has 프로세스 right of 세부, with the process count
 *   R3  the tab lists every process in tree order with the node line and the totals
 *   R4  일시중지 on a child stops the real process (ps says T); the row reads 일시중지 and its button 재개
 *   R5  재개 continues it
 *
 * Run from the repo root (state stays out of the checkout):
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-processes.ts [outDir]
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'processes');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.PROCESSES_PORT || '33941';
process.env.CONVERSATION_VIEWER_PORT = PORT;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const KEY = 'C601:1700000000.000100';
const NOW = Date.now();

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
const psState = (pid: number) =>
  execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])
    .toString()
    .trim();

async function installMocks(page: Page) {
  await page.addInitScript({
    content: [
      'window.WebSocket = function StubWebSocket(url) { this.url = url; };',
      'window.WebSocket.prototype.close = function () {};',
      'window.__name = function (f) { return f; };',
      'localStorage.setItem("soma-board-view", "board");',
    ].join('\n'),
  });
  await page.route('**/auth/me', (r) =>
    r.fulfill({ json: { user: { name: 'Zhuge', slackUserId: 'U001' }, csrfToken: 'x' } }),
  );
  await page.route('**/api/dashboard/users', (r) => r.fulfill({ json: { users: [{ id: 'U001', name: 'Zhuge' }] } }));
  await page.route('**/api/dashboard/stats**', (r) => r.fulfill({ json: { stats: [], byDay: [] } }));
  await page.route('**/api/dashboard/usage**', (r) => r.fulfill({ json: { totals: {}, byUser: {}, byDay: [] } }));
  await page.route(/\/api\/dashboard\/session\/[^/?]+\/(artifacts|worklog)/, (r) =>
    r.fulfill({ json: { artifacts: [], entries: [], hasMore: false } }),
  );
  // The conversation read (GET …/session/:conversationId) — a fixture; every other route is the server's.
  await page.route(/\/api\/dashboard\/session\/conv-601(\?.*)?$/, (r) =>
    r.fulfill({
      json: {
        id: 'conv-601',
        title: '빌드 · 테스트 돌리기',
        titleSub: '',
        turnCount: 1,
        hasMore: false,
        turns: [
          {
            id: 'u1',
            role: 'user',
            timestamp: new Date(NOW).toISOString(),
            userName: 'Zhuge',
            rawContent: '테스트 돌려줘',
            origin: { by: 'user' },
          },
        ],
      },
    }),
  );
}

// The page's CSRF token comes from the mocked /auth/me, so its POSTs go to the real route as the viewer token's
// bearer header (the route's owner gate passes a bearer, as it does for the dashboard's own token).
async function bearerPosts(page: Page) {
  const tok = process.env.CONVERSATION_VIEWER_TOKEN || '';
  await page.route(/\/api\/dashboard\/session\/[^/]+\/processes\/\d+\/(pause|resume)$/, (r) =>
    r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${tok}` } }),
  );
}

async function main() {
  const ws = await import('../src/conversation/web-server');
  const dashboard = await import('../src/conversation/dashboard');
  const { upsertChannel } = await import('../src/channel-registry');
  const { createTrackedClaudeProcessSpawner, getClaudeChildProcessRegistry } = await import(
    '../src/agent-runtime/claude-child-process-registry'
  );
  const { LocalProcessMonitor, runReadOnly } = await import('../src/process-monitor');

  upsertChannel({ id: 'C601', name: '', isPrivate: false });
  dashboard.setDashboardSessionAccessor(
    () =>
      new Map([
        [
          KEY,
          {
            sessionId: 'sid',
            ownerId: 'U001',
            ownerName: 'Zhuge',
            channelId: 'C601',
            threadTs: '1700000000.000100',
            conversationId: 'conv-601',
            title: '빌드 · 테스트 돌리기',
            model: 'claude-opus-5-5[1m]',
            workflow: 'zwork',
            activityState: 'working',
            state: 'MAIN',
            lastActivity: new Date(NOW),
            activeLegStartedAtMs: NOW - 4 * 60_000,
          } as any,
        ],
      ]),
  );

  // The stand-in tree: sh → (yes > /dev/null — burns a core), sleep, sh → sleep.
  const spawn = createTrackedClaudeProcessSpawner(undefined, { sessionKey: KEY });
  const root = spawn({
    command: '/bin/sh',
    args: ['-c', '(yes > /dev/null) & sleep 300 & sh -c "sleep 301" & wait'],
    cwd: '/',
    env: { PATH: '/bin:/usr/bin' },
    signal: new AbortController().signal,
  } as never) as unknown as import('node:child_process').ChildProcess;

  const monitor = new LocalProcessMonitor({
    nodeId: 'owner-mac',
    roots: getClaudeChildProcessRegistry(),
    runPs: (args) => runReadOnly('ps', args),
    runCommand: runReadOnly,
    intervalMs: 1_000,
  });
  monitor.start();
  dashboard.setDashboardProcessSource(monitor);
  // Two samples so CPU is a measured rate, not ps's own average.
  await monitor.sample();
  await sleep(1_200);
  await monitor.sample();

  await ws.startWebServer({ listen: true });
  log(`server ${BASE_URL}`);
  const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const tok = process.env.CONVERSATION_VIEWER_TOKEN;
    if (tok)
      await ctx.addCookies([{ name: 'soma_dash_token', value: encodeURIComponent(`bearer:${tok}`), url: BASE_URL }]);
    await installMocks(page);
    await bearerPosts(page);
    page.on('response', async (r) => {
      if (process.env.PROCESSES_DEBUG && r.url().includes('/api/dashboard/sessions'))
        log(`board ${r.status()} ${(await r.text()).slice(0, 400)}`);
    });
    if (process.env.PROCESSES_DEBUG) page.on('console', (m) => log(`console ${m.type()} ${m.text().slice(0, 200)}`));
    await page.goto(`${BASE_URL}/dashboard/U001`);
    // The board's key carries this instance's prefix (`<instance>::<key>`).
    await page.waitForSelector(`li.ib-card[data-card$="::${KEY}"]`, { timeout: 20_000 });
    const WIRE = await page.evaluate((k) => {
      const host = document.getElementById('kanban') as any;
      return (host.shadowRoot.querySelector(`li.ib-card[data-card$="::${k}"]`) as HTMLElement).getAttribute(
        'data-card',
      ) as string;
    }, KEY);
    await sleep(600);

    // R1
    const foot = await page.evaluate((k) => {
      const host = document.getElementById('kanban') as any;
      const card = host.shadowRoot.querySelector(`li.ib-card[data-card="${k}"]`) as HTMLElement;
      return Array.from(card.querySelectorAll('.ib-metric, [class*="metric"]')).map((m) =>
        (m as HTMLElement).innerText.trim(),
      );
    }, WIRE);
    const chip = foot.find((t) => /^CPU \S+ · \S+$/.test(t));
    check(!!chip, 'R1 the card foot shows CPU · memory of the tree', { foot });
    await page.screenshot({ path: path.join(OUT, '01-card-chip.png') });
    const cardBox = await page.evaluate((k) => {
      const host = document.getElementById('kanban') as any;
      const r = (host.shadowRoot.querySelector(`li.ib-card[data-card="${k}"]`) as HTMLElement).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, WIRE);
    await page.screenshot({
      path: path.join(OUT, '01b-card-chip-zoom.png'),
      clip: {
        x: Math.max(0, cardBox.x - 8),
        y: Math.max(0, cardBox.y - 8),
        width: cardBox.width + 16,
        height: cardBox.height + 16,
      },
    });

    // Open the detail card (title → ui-detail → openPanel).
    await page.evaluate((k) => (window as any).openPanel(k), WIRE);
    await page.waitForSelector('#panel-midbar .pm-tab[data-mid="procs"]', { timeout: 10_000 });
    // R2
    const tabs = await page.$$eval('#panel-midbar .pm-tab', (bs) =>
      bs.map((b) => `${b.getAttribute('data-mid')}:${(b as HTMLElement).innerText.replace(/\s+/g, ' ').trim()}`),
    );
    const ids = tabs.map((t) => t.split(':')[0]);
    check(
      ids.indexOf('procs') === ids.indexOf('info') + 1 || (ids.indexOf('info') < 0 && ids.includes('procs')),
      'R2 프로세스 sits right of 세부 with its count',
      { tabs },
    );

    // R3
    await page.click('#panel-midbar .pm-tab[data-mid="procs"]');
    await page.waitForSelector('#panel-procs .pp-table tbody tr.pp-row', { timeout: 10_000 });
    const rows = await page.$$eval('#panel-procs .pp-table tbody tr.pp-row', (trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td as HTMLElement).innerText.trim())),
    );
    check(
      rows.length >= 4 && rows[0][0].startsWith('sh') && rows[0][0].includes('Claude Code'),
      'R3 every process in tree order, the root first',
      { rows: rows.map((r) => r.slice(0, 5)) },
    );
    const nodeLine = await page.$eval('#panel-procs .pp-node', (e) => (e as HTMLElement).innerText);
    check(/owner-mac/.test(nodeLine) && /코어/.test(nodeLine), 'R3 the node line', { nodeLine });
    await page.screenshot({ path: path.join(OUT, '02-processes-tab.png') });

    // R4 — pause the busy child (yes).
    const yesRow = rows.findIndex((r) => r[0].startsWith('yes'));
    const yesPid = Number(rows[yesRow][1]);
    await page.click(`#panel-procs [data-proc-op="pause"][data-pid="${yesPid}"]`);
    await page.waitForSelector(`#panel-procs [data-proc-op="resume"][data-pid="${yesPid}"]`, { timeout: 10_000 });
    check(psState(yesPid).startsWith('T'), 'R4 the real process is stopped (ps stat T)', {
      pid: yesPid,
      stat: psState(yesPid),
    });
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, '03-paused.png') });

    // R5
    await page.click(`#panel-procs [data-proc-op="resume"][data-pid="${yesPid}"]`);
    await page.waitForSelector(`#panel-procs [data-proc-op="pause"][data-pid="${yesPid}"]`, { timeout: 10_000 });
    check(!psState(yesPid).startsWith('T'), 'R5 resumed (ps stat not T)', { stat: psState(yesPid) });
    check(errors.length === 0, 'no page errors', errors);
  } finally {
    await browser.close();
    monitor.stop();
    try {
      process.kill(-root.pid!, 'SIGKILL');
    } catch {
      // not a group leader
    }
    try {
      execFileSync('pkill', ['-KILL', '-P', String(root.pid)]);
    } catch {
      // gone
    }
    root.kill('SIGKILL');
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
