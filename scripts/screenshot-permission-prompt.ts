/**
 * Dashboard permission prompt — browser receipt (SSOT 2026-10-24).
 *
 * Real web server + real file store + Chromium, signed in as the requester:
 * a pending Bash prompt moves its card to NEEDS YOU, the card and the side
 * panel show the Slack card's content (tool, parameters, matched rule, the
 * four answers), there is no side scroll at 1280px and 390px, and Approve
 * clicked on the phone reaches the store the permission MCP server waits on;
 * once the answer is consumed the board push takes the prompt off the card.
 *
 *   npx tsx scripts/screenshot-permission-prompt.ts [outDir]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'permission-prompt');
fs.mkdirSync(OUT, { recursive: true });
const PORT = '33931';
process.env.CONVERSATION_VIEWER_PORT = PORT;
process.env.CONVERSATION_VIEWER_TOKEN = 'shot-token';
const BASE = `http://127.0.0.1:${PORT}`;
const CH = 'C_SHOT';
const TS = '1792827600.000100';
const KEY = `${CH}:${TS}`;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '[ok]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const dashboard = await import('../src/conversation/dashboard');
  const { answerPermissionPrompt } = await import('../src/permission-prompt-response');
  const { sharedStore } = await import('somalib/permission/shared-store');
  const sessions = new Map<string, any>([
    [
      KEY,
      {
        sessionId: 'sess-1',
        ownerId: 'U001',
        ownerName: 'Zhuge',
        channelId: CH,
        threadTs: TS,
        title: 'PR #409 리뷰 게이트 실행',
        model: 'claude-opus-5-5[1m]',
        state: 'MAIN',
        workflow: 'zwork',
        activityState: 'working',
        activeLegStartedAtMs: Date.now() - 95_000,
        lastActivity: new Date(),
      },
    ],
    [
      'C_SHOT:1792827600.000200',
      {
        sessionId: 'sess-2',
        ownerId: 'U001',
        ownerName: 'Zhuge',
        channelId: CH,
        threadTs: '1792827600.000200',
        title: '대시보드 메모리 탭 정리',
        model: 'claude-opus-5-5[1m]',
        state: 'MAIN',
        workflow: 'default',
        activityState: 'working',
        activeLegStartedAtMs: Date.now() - 30_000,
        lastActivity: new Date(),
      },
    ],
  ]);
  dashboard.setDashboardSessionAccessor(() => sessions);
  dashboard.setDashboardPermissionAnswerHandler((a) => answerPermissionPrompt(a));

  const approvalId = `approval_shot_${Date.now()}`;
  await sharedStore.storePendingApproval(approvalId, {
    kind: 'tool_permission',
    tool_name: 'Bash',
    input: {
      command:
        'T=$(cat ../scratch/gh-token); curl -s -X POST -H "Authorization: Bearer $T" -H "Accept: application/vnd.github+json" https://api.github.com/repos/2lab-ai/soma-work/pulls/409/reviews -d @../scratch/pr/review-gate-409.json | python3 -m json.tool',
      description: 'Post the review-gate verdict to PR #409',
    },
    channel: CH,
    thread_ts: TS,
    user: 'U001',
    created_at: Date.now(),
    expires_at: Date.now() + 5 * 60_000,
    rule_ids: ['pipe-to-interpreter'],
  });

  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const { issueSlackToken } = await import('../src/conversation/oauth');
    const token = issueSlackToken({ slackUserId: 'U001', email: 'z@2lab.ai', name: 'Zhuge' });
    const sso = await fetch(`${BASE}/auth/sso?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const [name, value] = String(sso.headers.get('set-cookie')).split(';')[0].split('=');

    for (const vp of [
      { tag: 'desktop', width: 1280, height: 900 },
      { tag: 'mobile', width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: 'dark',
      });
      await context.addCookies([{ name, value, url: BASE }]);
      const page = await context.newPage();
      await page.goto(`${BASE}/dashboard/U001`);
      const card = page.locator(`[data-session-key$="${KEY}"]`);
      await card.waitFor({ state: 'attached', timeout: 15000 });
      const col = await card.getAttribute('data-col');
      check(`${vp.tag}: blocked session sits in NEEDS YOU`, col === 'waiting', `data-col=${col}`);
      const face = await card.innerText();
      check(
        `${vp.tag}: card face names the prompt`,
        face.includes('Bash 실행 승인 필요'),
        face.split('\n').slice(0, 3).join(' | '),
      );
      await card.locator('.card-face, [aria-expanded]').first().click();
      await page.waitForSelector(`[data-session-key$="${KEY}"] .perm-request pre.perm-params`, { timeout: 10000 });
      const block = await card.locator('.perm-request').innerText();
      check(
        `${vp.tag}: parameters shown to the requester`,
        block.includes('api.github.com/repos/2lab-ai/soma-work/pulls/409'),
      );
      check(`${vp.tag}: matched rule shown`, block.includes('pipe-to-interpreter'));
      const labels = await card.locator('.perm-request .btn-perm').allInnerTexts();
      check(`${vp.tag}: four answers`, labels.length === 4, labels.join(' / '));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${vp.tag}: no horizontal overflow`, overflow <= 0, `overflow=${overflow}`);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `permission-${vp.tag}-board.png`), fullPage: vp.tag === 'mobile' });
      await card.screenshot({ path: path.join(OUT, `permission-${vp.tag}-card.png`) });
      if (vp.tag === 'desktop') {
        const wireKey = await card.getAttribute('data-session-key');
        await page.evaluate((k) => (window as any).openPanel(k), wireKey);
        await page.waitForSelector('#panel-permission .perm-request pre.perm-params', { timeout: 10000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, 'permission-desktop-panel.png') });
        await page.evaluate(() => (window as any).closePanel?.());
        await page.waitForTimeout(400);
      }
      if (vp.tag === 'mobile') {
        // Answer from the phone: Approve.
        await card.locator('.btn-perm-approve').click();
        const res = await sharedStore.waitForPermissionResponse(approvalId, 5000);
        check('mobile: Approve reached the MCP server', res.behavior === 'allow', JSON.stringify(res));
        await page.waitForFunction(
          (k) => {
            const el = document.querySelector(`[data-session-key$="${k}"]`);
            return !!el && !el.querySelector('.perm-request') && el.getAttribute('data-col') !== 'waiting';
          },
          KEY,
          { timeout: 10000 },
        );
        check('mobile: prompt left the card after the answer was consumed (WS push)', true);
        await page.screenshot({ path: path.join(OUT, 'permission-mobile-after.png'), fullPage: true });
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await sharedStore.cleanup(approvalId);
    await ws.stopWebServer();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
