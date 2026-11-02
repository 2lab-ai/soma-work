/**
 * 작업 카드의 연결 (SSOT 2026-11-02 goal: "작업 카드에 디폴트로 표시해야 하는 중요한 것: 연결된 이슈(지라 혹은
 * 깃허브 이슈)들과 이슈 상태, 연결된 PR들과 머지 상태, 연결된 위키들") — browser receipts.
 *
 * Nothing about the board is mocked: the real web server, real sign-in (/auth/sso), the settings API wired as the
 * host wires it (productionSettingsRegistry), the real sessions through
 * sessionToKanban → cardLinksOf, the real link-metadata cache (primed through warmLinkMetadata with a stub fetch, so
 * nothing leaves the machine), the real settings store (a temp dir — the user never opened the editor), Chromium.
 * Asserts (exit 1 on any failure) and writes screenshots:
 *
 *   L1  the user never opened the editor: 설정 › 대시보드 화면 has 연결 on, right after 현재 작업
 *   L2  the board card's face, by default: the 연결 row below the task — the Jira issue and the GitHub issue with
 *       their states, the PRs with their merge states, the wiki — issues, PRs, wikis, the active ones first
 *   L3  states in words and tones: Jira's own name (the cache's), GitHub 열림 · 닫힘, PR 열림 · 머지됨
 *   L4  a chip is a link to the page (a new tab, noopener) and does not open or close the card
 *   L5  a card with no links has no 연결 row; the PR foot chip is off by default (no second PR on the face)
 *   L6  the open card's refs show the same links with their states
 *   L7  the thread's live PR check wins: the PR merged → the next board says 머지됨
 *   L8  390px: the row wraps, no side scroll
 *
 * Run from the repo root with a clean env:
 *   T=$(mktemp -d); env -i PATH="$PATH" HOME="$T" TMPDIR="$T" SOMA_CONFIG_DIR=$T/cfg SOMA_INSTANCE_DIR=$T/inst \
 *     PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" npx tsx scripts/screenshot-card-links.ts [outDir]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'card-links');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CARD_LINKS_PORT || '33947';
process.env.CONVERSATION_VIEWER_PORT = PORT;
process.env.CONVERSATION_VIEWER_TOKEN = 'shot-token';
const BASE = `http://127.0.0.1:${PORT}`;
const CH = 'C_LINKS';
const KEY = `${CH}:1793000000.000100`;
const KEY_BARE = `${CH}:1793000000.000200`;
const M = 60_000;

const JIRA = 'https://2lab.atlassian.net/browse/PAY-12';
const GH_ISSUE = 'https://github.com/2lab-ai/soma-work/issues/41';
const PR = 'https://github.com/2lab-ai/soma-work/pull/733';
const PR_OLD = 'https://github.com/2lab-ai/soma-work/pull/700';
const WIKI = 'https://2lab.atlassian.net/wiki/spaces/PAY/pages/123456/Payment+Form+Design';

// What GitHub and Jira would answer — the fetcher's cache is primed with it through warmLinkMetadata.
const REMOTE: Record<string, { title: string; status: string }> = {
  [JIRA]: { title: '결제 폼 검증 추가', status: 'In Progress' },
  [GH_ISSUE]: { title: '카드 폼 검증 규칙', status: 'closed' },
  [PR]: { title: 'feat: 결제 폼 검증', status: 'open' },
  [PR_OLD]: { title: 'feat: 결제 폼 1차', status: 'merged' },
};

const failures: string[] = [];
const report: string[] = [];
function log(line: string) {
  report.push(line);
  console.log(line);
}
function check(ok: boolean, what: string, detail?: unknown) {
  log(`${ok ? '[ok]  ' : '[FAIL]'} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ''}`);
  if (!ok) failures.push(what);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function sessions() {
  const now = Date.now();
  const base = {
    ownerId: 'U001',
    ownerName: 'Zhuge',
    channelId: CH,
    model: 'claude-opus-5-5[1m]',
    state: 'MAIN',
    workflow: 'zwork',
    lastActivity: new Date(now),
  };
  return new Map<string, any>([
    [
      KEY,
      {
        ...base,
        sessionId: 'sess-links',
        threadTs: '1793000000.000100',
        title: '결제 페이지 리뉴얼',
        activityState: 'working',
        activeLegStartedAtMs: now - 20 * M,
        links: {
          issue: { url: JIRA, type: 'issue', provider: 'jira', label: 'PAY-12', status: 'To Do' },
          pr: { url: PR, type: 'pr', provider: 'github', label: 'PR #733', status: 'open' },
          doc: { url: WIKI, type: 'doc', provider: 'confluence', label: 'Confluence', title: '결제 폼 설계' },
        },
        linkHistory: {
          issues: [
            { url: GH_ISSUE, type: 'issue', provider: 'github', label: 'Issue #41', status: 'open' },
            { url: JIRA, type: 'issue', provider: 'jira', label: 'PAY-12' },
          ],
          prs: [
            { url: PR_OLD, type: 'pr', provider: 'github', label: 'PR #700', status: 'open' },
            { url: PR, type: 'pr', provider: 'github', label: 'PR #733' },
          ],
          docs: [{ url: WIKI, type: 'doc', provider: 'confluence', label: 'Confluence', title: '결제 폼 설계' }],
        },
        // The Slack thread surface's live check of the active PR.
        actionPanel: { prStatus: { state: 'open', merged: false, draft: false, fetchedForUrl: PR } },
      },
    ],
    [
      KEY_BARE,
      {
        ...base,
        sessionId: 'sess-bare',
        threadTs: '1793000000.000200',
        title: '대시보드 메모리 탭 정리',
        activityState: 'idle',
        state: 'MAIN',
      },
    ],
  ]);
}

type Chip = { kind: string; text: string; status: string; tone: string; href: string; target: string; rel: string };
async function face(page: Page, key: string) {
  return page.evaluate((k) => {
    const host = document.getElementById('kanban');
    const card = Array.from(host?.shadowRoot?.querySelectorAll<HTMLElement>('li.ib-card[data-card]') ?? []).find((c) =>
      (c.getAttribute('data-card') || '').endsWith(k),
    );
    if (!card) return null;
    const f = card.querySelector('.ib-face') as HTMLElement;
    const rows = Array.from(f.children)
      .map((x) => (x as HTMLElement).className.split(' ')[0])
      .filter((c) => c !== 'ib-head' && c !== 'ib-foot');
    const chips = Array.from(card.querySelectorAll<HTMLAnchorElement>('.ib-links a.ib-link')).map((a) => ({
      kind: (a.className.match(/is-(\w+)/) || [])[1] || '',
      text: (a.querySelector('.ib-link-text') as HTMLElement | null)?.innerText.trim() || '',
      status: (a.querySelector('.ib-link-st') as HTMLElement | null)?.innerText.trim() || '',
      tone: (a.querySelector('.ib-link-st') as HTMLElement | null)?.getAttribute('data-tone') || '',
      href: a.getAttribute('href') || '',
      target: a.getAttribute('target') || '',
      rel: a.getAttribute('rel') || '',
    }));
    const foot = Array.from(f.querySelectorAll<HTMLElement>('.ib-foot .ib-metric')).map((m) => m.innerText.trim());
    return { rows, chips, foot, open: card.classList.contains('is-open'), id: card.getAttribute('data-card') || '' };
  }, key);
}
const fmt = (c: Chip[]) =>
  c.map((x) => `${x.kind}:${x.text}${x.status ? ` ${x.status}` : ''}${x.tone ? `(${x.tone})` : ''}`);

async function main() {
  const fetcher = await import('../src/link-metadata-fetcher');
  const live = sessions();
  // Prime the cache the board reads (the same module instance the server uses): one background "fetch" per link.
  const started = fetcher.warmLinkMetadata(
    [JIRA, GH_ISSUE, PR, PR_OLD].map((url) => ({
      url,
      type: url.includes('/pull/') ? 'pr' : 'issue',
      provider: url.includes('atlassian') ? 'jira' : 'github',
    })) as never,
    { fetch: async (l) => REMOTE[l.url] },
  );
  await sleep(50);
  check(
    started === 4 && fetcher.peekLinkMetadata(JIRA)?.status === 'In Progress',
    'setup: the link-metadata cache holds what GitHub and Jira answered',
    { started, jira: fetcher.peekLinkMetadata(JIRA) },
  );

  const dashboard = await import('../src/conversation/dashboard');
  dashboard.setDashboardSessionAccessor(() => live);
  // The linked session's task list (the real ledger), so the face has its current task above the 연결 row.
  const { applyTodoList, ledgerTasks } = await import('../src/session/task-ledger');
  const ledger = applyTodoList(
    undefined,
    [
      { content: '요구 정리', status: 'completed' },
      { content: '카드 폼 검증 추가', status: 'in_progress', activeForm: '카드 폼 검증 추가 중' },
      { content: '확인', status: 'pending' },
    ] as never,
    Date.now() - 10 * M,
  );
  dashboard.setDashboardTaskAccessor((k) => (k === KEY ? ledgerTasks(ledger as never) : undefined));
  // The settings API as the host wires it (src/index.ts): the real registry over the real store.
  const { setSettingsRegistry } = await import('../src/conversation/settings-routes');
  const { productionSettingsRegistry } = await import('../src/user-settings-registry-production');
  setSettingsRegistry(productionSettingsRegistry());
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE}`);
  const { issueSlackToken } = await import('../src/conversation/oauth');
  const token = issueSlackToken({ slackUserId: 'U001', email: 'z@2lab.ai', name: 'Zhuge' });
  const sso = await fetch(`${BASE}/auth/sso?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const [cookieName, cookieValue] = String(sso.headers.get('set-cookie')).split(';')[0].split('=');

  try {
    for (const vp of [
      { tag: '1280', width: 1280, height: 900 },
      { tag: '390', width: 390, height: 844 },
    ]) {
      log(`\n── ${vp.tag} ──`);
      // A browser per viewport: a single-process Chromium does not open a second context.
      const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
      live.get(KEY).actionPanel.prStatus = { state: 'open', merged: false, draft: false, fetchedForUrl: PR };
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      await ctx.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
      // The linked pages themselves (a chip opens one in a new tab): stubbed, nothing leaves the machine.
      await ctx.route(/^https:\/\/(github\.com|2lab\.atlassian\.net)\//, (r) =>
        r.fulfill({ contentType: 'text/html', body: '<title>linked page</title>' }),
      );
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));

      // L1 — the settings tab for a user with no saved layout.
      if (vp.tag === '1280') {
        await page.goto(`${BASE}/dashboard/settings#layout`);
        await page.waitForSelector('#lay-controls .lay-zone', { timeout: 15_000 });
        await sleep(400);
        const l1 = await page.evaluate(() => {
          const items = Array.from(
            document.querySelectorAll<HTMLElement>('#lay-controls li.lay-item[data-zone="rows"]'),
          );
          return items.map((li) => ({
            id: li.querySelector<HTMLInputElement>('input[data-lay="toggle"]')?.getAttribute('data-id') || '',
            on: !!li.querySelector<HTMLInputElement>('input[data-lay="toggle"]')?.checked,
            label: (li.querySelector('.lay-name, label, span') as HTMLElement | null)?.innerText.trim() || '',
          }));
        });
        const at = l1.findIndex((r) => r.id === 'links');
        check(
          at > 0 && l1[at].on && l1[at - 1].id === 'task',
          'L1 never opened the editor: 연결 is on by default, right after 현재 작업',
          l1,
        );
        const prChip = await page.evaluate(
          () =>
            (
              document.querySelector(
                '#lay-controls input[data-lay="toggle"][data-zone="foot"][data-id="pr"]',
              ) as HTMLInputElement | null
            )?.checked,
        );
        check(prChip === false, 'L1 the PR foot chip is off by default (the 연결 row carries the PRs)', prChip);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(OUT, `${vp.tag}-0-settings-default.png`), fullPage: true });
      }

      await page.goto(`${BASE}/dashboard/U001`);
      await page.waitForFunction(
        (k) =>
          Array.from(
            document.getElementById('kanban')?.shadowRoot?.querySelectorAll('li.ib-card[data-card]') ?? [],
          ).some((c) => (c.getAttribute('data-card') || '').endsWith(k) && c.querySelector('.ib-links')),
        KEY,
        { timeout: 15_000 },
      );
      await sleep(600);

      // L2 · L3
      const f = await face(page, KEY);
      check(!!f, `${vp.tag} the linked session's card is on the board`, f?.id);
      if (!f) {
        await browser.close();
        continue;
      }
      const taskAt = f.rows.indexOf('ib-task');
      check(
        taskAt >= 0 && f.rows.indexOf('ib-links') === taskAt + 1,
        `${vp.tag} L2 the default face has the 연결 row, right below the current task`,
        f.rows,
      );
      check(
        JSON.stringify(fmt(f.chips)) ===
          JSON.stringify([
            'issue:PAY-12 In Progress(run)',
            'issue:#41 닫힘(done)',
            'pr:#733 열림(run)',
            'pr:#700 머지됨(done)',
            'wiki:결제 폼 설계',
          ]),
        `${vp.tag} L2·L3 issues (Jira, GitHub) with states, PRs with merge states, the wiki — in that order`,
        fmt(f.chips),
      );
      check(
        f.chips.map((c) => c.href).join() === [JIRA, GH_ISSUE, PR, PR_OLD, WIKI].join() &&
          f.chips.every((c) => c.target === '_blank' && /noopener/.test(c.rel)),
        `${vp.tag} L4 each chip links to its page in a new tab (noopener)`,
        f.chips.map((c) => [c.href, c.target, c.rel]),
      );
      const bare = await face(page, KEY_BARE);
      check(
        !!bare && !bare.rows.includes('ib-links') && bare.chips.length === 0,
        `${vp.tag} L5 a card with no links has no 연결 row`,
        bare,
      );
      check(
        !f.foot.some((m) => /#733|#700/.test(m)),
        `${vp.tag} L5 no second PR on the face (the PR foot chip is off by default)`,
        f.foot,
      );
      // L8
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(overflow <= 0, `${vp.tag} L8 no side scroll`, { overflow });
      const cardBox = page.locator(`#kanban li.ib-card[data-card$="${KEY}"]`);
      await cardBox.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `${vp.tag}-1-board-default.png`), fullPage: vp.tag === '390' });
      await cardBox.screenshot({ path: path.join(OUT, `${vp.tag}-2-card-default.png`) });

      // L4 — a chip opens its page and leaves the card as it was.
      const [popup] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 5000 }),
        page.locator(`#kanban li.ib-card[data-card$="${KEY}"] a.ib-link.is-wiki`).click(),
      ]);
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      const opened = popup.url();
      await popup.close();
      await sleep(400);
      const afterClick = await face(page, KEY);
      check(
        opened === WIKI && afterClick?.open === false,
        `${vp.tag} L4 the wiki chip opened the wiki in a new tab; the card did not open`,
        { opened, open: afterClick?.open },
      );

      // L6 — the open card.
      await page.locator(`#kanban li.ib-card[data-card$="${KEY}"] .ib-face .ib-title`).click();
      await sleep(1000);
      const refs = await page.evaluate((k) => {
        const host = document.getElementById('kanban') as HTMLElement;
        const slot = Array.from(host.children).find((c) => (c.getAttribute('slot') || '').endsWith(k)) as
          | HTMLElement
          | undefined;
        return Array.from(slot?.querySelectorAll<HTMLAnchorElement>('.card-refs a.card-ref') ?? []).map(
          (a) => `${a.className.replace('card-ref ', '')}:${a.innerText.replace(/\s+/g, ' ').trim()}`,
        );
      }, KEY);
      check(
        refs.join('|') ===
          'is-issue:PAY-12 In Progress|is-issue:#41 닫힘|is-pr:#733 열림|is-pr:#700 머지됨|is-wiki:결제 폼 설계',
        `${vp.tag} L6 the open card's refs: the same links with their states`,
        refs,
      );
      await cardBox.screenshot({ path: path.join(OUT, `${vp.tag}-3-card-open.png`) });

      // L7 — the PR merges; the thread's live check says so; the next board says 머지됨.
      live.get(KEY).actionPanel.prStatus = { state: 'closed', merged: true, draft: false, fetchedForUrl: PR };
      await page.reload();
      await page.waitForFunction(
        (k) =>
          Array.from(
            document.getElementById('kanban')?.shadowRoot?.querySelectorAll('li.ib-card[data-card]') ?? [],
          ).some((c) => (c.getAttribute('data-card') || '').endsWith(k) && c.querySelector('.ib-links')),
        KEY,
        { timeout: 15_000 },
      );
      await sleep(600);
      const merged = await face(page, KEY);
      const pr733 = merged?.chips.find((c) => c.text === '#733');
      check(
        pr733?.status === '머지됨' && pr733?.tone === 'done',
        `${vp.tag} L7 the live check wins over the cached state: #733 머지됨`,
        merged && fmt(merged.chips),
      );
      const mergedCard = page.locator(`#kanban li.ib-card[data-card$="${KEY}"]`);
      await mergedCard.scrollIntoViewIfNeeded();
      await mergedCard.screenshot({ path: path.join(OUT, `${vp.tag}-4-card-merged.png`) });
      check(errors.length === 0, `${vp.tag} no page errors`, errors);
      await ctx.close();
      await browser.close();
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
