/**
 * The session panel's goal tab (2026-11-26) — browser receipts.
 *
 * "신규 goal 추가시 한줄로 나옴 여기에 마우스로 클릭해서 포커스를 받으면 이 창이 지시창 처럼 변경해서 모든 기능
 * 쓸수 있도록해줘. 다음 목표들의 순서를 드래그로 옮기고 편집 버튼으로 편집할 수 있게 해줘."
 *
 * Real web server + the real dashboard page + Chromium, signed in as the owner; the goal route's host handler is a
 * stand-in that applies each action to the session the board reads (so the page's reload shows the outcome) and
 * records what it was sent. Asserts (exit 1 on any failure) and writes screenshots at 1280 and 390:
 *   G1  the add box is one line (a <ui-composer collapse> in the card's add slot, toolbar hidden)
 *   G2  a click opens it into the instruction composer: attach, image, voice, 받아쓰기, the counter, 추가
 *   G3  typed words + a picked file → Enter posts add with the objective and the file (base64), then it clears
 *   G4  dragging the first queued goal's handle below the second posts move { to: 1 } and the list redraws in order
 *   G5  Edit opens the text in place; Enter posts edit and the row shows the new text
 *
 *   SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst npx tsx scripts/screenshot-goal-composer.ts [outDir]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'goal-composer');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.GOAL_COMPOSER_PORT || '33937';
process.env.CONVERSATION_VIEWER_PORT = PORT;
process.env.CONVERSATION_VIEWER_TOKEN = 'shot-token';
const BASE = `http://127.0.0.1:${PORT}`;
const CH = 'C_GOAL';
const TS = '1792827600.000300';
const KEY = `${CH}:${TS}`;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '[ok]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const goal = (goalId: string, objective: string, status = 'queued') => ({
  goalId,
  objective,
  status,
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'U001',
  continuationCount: status === 'active' ? 2 : 0,
  maxContinuations: 10,
});

function freshSession() {
  return {
    sessionId: 'sess-goal',
    ownerId: 'U001',
    ownerName: 'Zhuge',
    channelId: CH,
    threadTs: TS,
    title: '디테일 작업 창 goal 개선',
    model: 'claude-opus-5-5[1m]',
    state: 'MAIN',
    workflow: 'default',
    activityState: 'working',
    activeLegStartedAtMs: Date.now() - 60_000,
    lastActivity: new Date(),
    goal: goal('g1', '대시보드 상세 패널의 목표 편집기를 지시창 수준으로', 'active'),
    goalQueue: [
      goal('q1', '다음 목표 순서를 드래그로 바꾸기'),
      goal('q2', '편집 버튼으로 대기 목표 고치기'),
      goal('q3', 'dev 배포 후 실카드 QA'),
    ],
  };
}

async function openGoalTab(page: Page) {
  await page.goto(`${BASE}/dashboard/U001`);
  await page.getByText('디테일 작업 창 goal 개선').first().waitFor({ timeout: 20000 });
  // The board's wire key (instance-prefixed) — the panel opens on it, at the 목표 tab.
  const wireKey = await page.evaluate(async (k) => {
    const r = await fetch('/api/dashboard/sessions');
    const board = (await r.json()).board;
    for (const col of Object.values(board) as any[]) for (const s of col) if (String(s.key).endsWith(k)) return s.key;
    return null;
  }, KEY);
  await page.evaluate((k) => (window as any).openPanel(k, 'goal'), wireKey);
  await page.waitForSelector('#panel-goal > ui-goal-card ui-composer[slot="add"]', { timeout: 15000 });
  await page.waitForTimeout(400);
}

async function main() {
  const dashboard = await import('../src/conversation/dashboard');
  let session = freshSession();
  const sessions = new Map<string, any>([[KEY, session]]);
  dashboard.setDashboardSessionAccessor(() => sessions);
  const calls: any[] = [];
  dashboard.setDashboardGoalHandler(async (_key, action) => {
    calls.push(action);
    if (action.action === 'add') {
      session.goalQueue.push(goal(`n${calls.length}`, action.objective.trim()));
      return { outcome: 'queued', goalId: `n${calls.length}`, position: session.goalQueue.length };
    }
    if (action.action === 'move') {
      const q = session.goalQueue;
      const from = q.findIndex((g: any) => g.goalId === action.goalId);
      const [g] = q.splice(from, 1);
      q.splice(Math.min(action.to, q.length), 0, g);
      return { outcome: 'moved', goalId: action.goalId, position: action.to + 1 };
    }
    if (action.action === 'edit') {
      const g = session.goalQueue.find((x: any) => x.goalId === action.goalId);
      if (g) g.objective = action.objective.trim();
      return { outcome: 'edited', goalId: action.goalId };
    }
    return { outcome: 'deleted', goalId: (action as any).goalId };
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
      session = freshSession();
      sessions.set(KEY, session);
      calls.length = 0;
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await context.addCookies([{ name, value, url: BASE }]);
      const page = await context.newPage();
      page.on('pageerror', (e) => check(`${vp.tag}: no page error`, false, e.message));
      await openGoalTab(page);
      const panelGoal = page.locator('#panel-goal');
      const composer = page.locator('#panel-goal ui-composer[slot="add"]');

      // G1 — one line.
      const folded = await composer.evaluate((c: any) => ({
        collapsed: c.collapsed,
        h: Math.round(c.getBoundingClientRect().height),
        barHidden: !!c.shadowRoot.querySelector('.cp-bar')?.hidden,
      }));
      check(
        `${vp.tag} G1: the add box is one line`,
        folded.collapsed && folded.barHidden && folded.h < 60,
        JSON.stringify(folded),
      );
      await panelGoal.screenshot({ path: path.join(OUT, `${vp.tag}-1-one-line.png`) });

      // G2 — a click opens the instruction composer.
      await composer.locator('textarea.cp-field').click();
      await page.waitForTimeout(300);
      const open = await composer.evaluate((c: any) => {
        const r = c.shadowRoot;
        return {
          collapsed: c.collapsed,
          h: Math.round(c.getBoundingClientRect().height),
          tools: Array.from(r.querySelectorAll('.cp-tool')).map(
            (b: any) => b.getAttribute('aria-label') || b.textContent.trim(),
          ),
          count: r.querySelector('.cp-count')?.textContent || '',
          send: r.querySelector('.cp-send')?.textContent.trim() || '',
        };
      });
      check(
        `${vp.tag} G2: focus opens the whole composer (files, images, voice, counter, 추가)`,
        !open.collapsed &&
          open.h > folded.h &&
          open.tools.length >= 2 &&
          /4,000/.test(open.count) &&
          open.send.includes('추가'),
        JSON.stringify(open),
      );
      await panelGoal.screenshot({ path: path.join(OUT, `${vp.tag}-2-open.png`) });

      // G3 — words + a file → Enter → add with the file.
      await composer.locator('textarea.cp-field').fill('스크린샷 보고 목표 카드 여백 고치기');
      await composer.locator('input.cp-in-file').setInputFiles({
        name: 'goal-card.png',
        mimeType: 'image/png',
        buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
      });
      await page.waitForTimeout(200);
      await panelGoal.screenshot({ path: path.join(OUT, `${vp.tag}-3-with-file.png`) });
      await composer.locator('textarea.cp-field').press('Enter');
      await page.waitForFunction(
        () => {
          const c: any = document.querySelector('#panel-goal ui-composer[slot="add"]');
          return c && c.value === '';
        },
        null,
        { timeout: 10000 },
      );
      const add = calls.find((c) => c.action === 'add');
      check(
        `${vp.tag} G3: Enter posts the goal with its file; the composer clears`,
        !!add &&
          add.objective === '스크린샷 보고 목표 카드 여백 고치기' &&
          add.attachments?.[0]?.name === 'goal-card.png',
        JSON.stringify(add && { ...add, attachments: add.attachments?.map((a: any) => a.name) }),
      );
      await page.waitForFunction(
        () => {
          const card: any = document.querySelector('#panel-goal > ui-goal-card');
          return (card?.shadowRoot?.querySelectorAll('.gc-q-row') || []).length === 4;
        },
        null,
        { timeout: 10000 },
      );

      // G4 — drag the first queued goal below the second.
      const card = page.locator('#panel-goal > ui-goal-card');
      const grip = card.locator('.gc-grip').first();
      await grip.scrollIntoViewIfNeeded();
      const gb = await grip.boundingBox();
      const rows = await card
        .locator('.gc-q-row')
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      if (gb) {
        const x = gb.x + gb.width / 2;
        const y = gb.y + gb.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + 10, { steps: 3 });
        await page.mouse.move(x, y + rows[0] + 12, { steps: 8 });
        await page.screenshot({ path: path.join(OUT, `${vp.tag}-4-dragging.png`) });
        await page.mouse.up();
      }
      await page.waitForTimeout(800);
      const move = calls.find((c) => c.action === 'move');
      const order = await card.locator('.gc-q-text').allInnerTexts();
      check(
        `${vp.tag} G4: the drop posts move and the list redraws in that order`,
        !!move &&
          move.goalId === 'q1' &&
          move.to === 1 &&
          order[0] === '편집 버튼으로 대기 목표 고치기' &&
          order[1] === '다음 목표 순서를 드래그로 바꾸기',
        JSON.stringify({ move, order }),
      );

      // G5 — Edit in place.
      await card.locator('[data-act="edit"]').nth(2).click();
      const box = card.locator('textarea.gc-q-edit');
      await box.waitFor({ timeout: 5000 });
      await box.fill('dev 배포 후 실카드 QA — 폰에서도 드래그 확인');
      await panelGoal.screenshot({ path: path.join(OUT, `${vp.tag}-5-editing.png`) });
      await box.press('Enter');
      await page.waitForFunction(
        () => {
          const c: any = document.querySelector('#panel-goal > ui-goal-card');
          return !c?.shadowRoot?.querySelector('.gc-q-edit');
        },
        null,
        { timeout: 10000 },
      );
      const edit = calls.find((c) => c.action === 'edit');
      const texts = await card.locator('.gc-q-text').allInnerTexts();
      check(
        `${vp.tag} G5: Enter posts edit and the row shows the new text`,
        !!edit && edit.goalId === 'q3' && texts.includes('dev 배포 후 실카드 QA — 폰에서도 드래그 확인'),
        JSON.stringify({ edit, texts }),
      );
      await panelGoal.screenshot({ path: path.join(OUT, `${vp.tag}-6-after.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${vp.tag}: no horizontal overflow`, overflow <= 0, `overflow=${overflow}`);
      await context.close();
    }
  } finally {
    await browser.close();
    await ws.stopWebServer();
  }
  console.log(`screenshots → ${OUT}`);
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
