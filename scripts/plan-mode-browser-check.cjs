/**
 * Plan mode (SSOT 2026-11-02) — browser check against the real server
 * (`scripts/plan-mode-browser-server.ts`). Playwright is not a repo dependency:
 * run with NODE_PATH pointing at a scratch install.
 *
 *   B1 (T1) the new-task composer: 대시보드 작업 shows 작업 계획, checked by default.
 *   B2 (T6) the board: the plan card opened by itself, its face asks, its body has 시작 · 취소 · 직접 입력.
 *   B3 (T5) clicking the card: the detail card shows the plan (levels 0–3) without another click.
 *   B4 (T6) the detail card's top has 시작 · 취소; its bottom bar 시작 · 취소 · 직접 입력.
 *   B5 (T7) the simple question's card shows 예 / 아니오 as buttons; one press answers.
 *   B6 (T4) 시작 at the bottom: the plan is approved and the start carried the plan.
 *   B7 the full-page plan.
 *
 *   NODE_PATH=<scratch>/node_modules node scripts/plan-mode-browser-check.cjs <ssoUrl> <cfgDir> <outDir>
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const [ssoUrl, cfgDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const base = new URL(ssoUrl).origin;
const failures = [];
const report = [];
function check(name, ok, detail) {
  const line = `${ok ? '[ok]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`;
  report.push(line);
  fs.writeFileSync(path.join(outDir, 'report.txt'), report.join('\n') + '\n');
  console.log(line);
  if (!ok) failures.push(name);
}
const keys = JSON.parse(fs.readFileSync(path.join(cfgDir, 'keys.json'), 'utf8'));
const effects = () => JSON.parse(fs.readFileSync(path.join(cfgDir, 'effects.json'), 'utf8'));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(ssoUrl);
  await page.waitForURL(/\/dashboard/, { timeout: 15000 }).catch(() => {});
  if (!/\/dashboard/.test(page.url())) await page.goto(`${base}/dashboard`);
  await page.waitForFunction(() => typeof _sessionCache === 'object' && Object.keys(_sessionCache).length >= 2, null, { timeout: 20000 });
  const wireOf = (local) =>
    page.evaluate((local) => Object.keys(_sessionCache).find((k) => k.endsWith(local)), local);
  const planned = await wireOf(keys.planned);
  const asking = await wireOf(keys.asking);
  check('both seeded cards are on the board', !!planned && !!asking, `${planned} · ${asking}`);
  await page.waitForTimeout(1200);

  // B2 — the plan card opened by itself; its body has the three buttons.
  const inboxText = await page.evaluate((k) => {
    const host = _cardHost[k];
    return (host && host.shadowRoot && host.shadowRoot.textContent) || '';
  }, planned);
  check('B2 the face asks: 작업 계획 v1 — 시작할까요?', inboxText.includes('작업 계획 v1 — 시작할까요?'));
  const opened = await page.evaluate((k) => _expanded.has(k), planned);
  check('B2 the plan card opened by itself (no click)', opened);
  const bodyBtns = await page.evaluate((k) => {
    const nodes = Array.from(document.querySelectorAll('.card-body .card-plan button'));
    return nodes.filter((b) => b.offsetParent !== null || b.getClientRects().length).map((b) => b.textContent.trim());
  }, planned);
  check('B2 the open task card: 시작 · 취소 · 직접 입력', JSON.stringify(bodyBtns) === JSON.stringify(['▶ 시작', '취소', '직접 입력']), JSON.stringify(bodyBtns));
  // B5 — the simple question's card: 예 / 아니오 as buttons.
  const quick = await page.evaluate(() => Array.from(document.querySelectorAll('.card-quick-choice')).map((b) => b.textContent.trim()));
  check('B5 the simple question is buttons on the task card', JSON.stringify(quick) === JSON.stringify(['예', '아니오']), JSON.stringify(quick));
  await page.screenshot({ path: path.join(outDir, '1-board-auto-open.png'), fullPage: false });

  // B5 — one press answers.
  await page.locator('.card-quick-choice', { hasText: '예' }).first().click();
  await page.waitForTimeout(800);
  const answered = effects().answered;
  check('B5 one press answers (single, choice yes, its askId)', answered.length === 1 && answered[0].includes('ask-check-1') && answered[0].includes('"choiceId":"yes"'), answered.join(' | '));

  // B3 — opening the card the way a click does (the element's toggle → ui-toggle → the page's handler): fold it
  // first (it opened by itself, quietly — no detail card), then open it → the detail card shows the plan at once.
  const panelBefore = await page.evaluate(() => panelOpen);
  check('B3 the auto-open did not open the detail card by itself', panelBefore === false, String(panelBefore));
  await page.evaluate((k) => {
    const host = _cardHost[k];
    const face = Array.from(host.shadowRoot.querySelectorAll('.ib-face')).find((f) => (f.textContent || '').includes('작업 계획 v1'));
    face.click(); // fold
  }, planned);
  await page.waitForTimeout(500);
  await page.evaluate((k) => {
    const host = _cardHost[k];
    const face = Array.from(host.shadowRoot.querySelectorAll('.ib-face')).find((f) => (f.textContent || '').includes('작업 계획 v1'));
    face.click(); // open — a real click on the card's face
  }, planned);
  await page.waitForSelector('#panel-plan:not([hidden]) .tp', { timeout: 10000 });
  const levels = await page.evaluate(() =>
    [0, 1, 2, 3].map((n) => document.querySelectorAll('#panel-plan [data-level="' + n + '"]').length),
  );
  check('B3 the detail card shows the plan at once — levels 0..3 present', levels.every((n) => n > 0), JSON.stringify(levels));
  const order = await page.evaluate(() => {
    const t = document.getElementById('panel-plan').textContent;
    return ['새 작업에 작업 계획 모드', '서버 게이트', '계획 제출 도구', 'plan_submit — 구조화된 4단 계획'].map((s) => t.indexOf(s));
  });
  check('B3 high level → detail order (conclusion, phase, step, detail)', order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), JSON.stringify(order));
  // B4 — top (status bar) and bottom bar.
  const head = await page.evaluate(() => {
    const el = document.getElementById('panel-status');
    return ((el && el.data && el.data.actions) || []).map((a) => a.label);
  });
  check('B4 the detail card top: 시작 · 취소 first', head[0] === '▶ 시작' && head[1] === '취소', JSON.stringify(head));
  const bar = await page.evaluate(() => {
    const el = document.getElementById('panel-plan-bar');
    return { hidden: el.hidden, labels: Array.from(el.querySelectorAll('button')).map((b) => b.textContent.trim()) };
  });
  check('B4 the detail card bottom: 시작 · 취소 · 직접 입력', !bar.hidden && JSON.stringify(bar.labels) === JSON.stringify(['▶ 시작', '취소', '직접 입력']), JSON.stringify(bar));
  const barAboveComposer = await page.evaluate(() => {
    const b = document.getElementById('panel-plan-bar').getBoundingClientRect();
    const c = document.getElementById('cmd-steer').getBoundingClientRect();
    return b.bottom <= c.top + 1 && b.height > 0;
  });
  check('B4 the bottom bar sits right above the composer', barAboveComposer);
  await page.screenshot({ path: path.join(outDir, '2-detail-plan.png'), fullPage: false });
  check('no page errors', errors.length === 0, errors.join(' | '));

  // B7 — the full-page plan.
  const full = await ctx.newPage();
  const resp = await full.goto(`${base}/dashboard/plan/${encodeURIComponent(planned)}`);
  check('B7 the full-page plan answers 200 with a no-script policy', resp.status() === 200 && /script-src 'none'/.test(resp.headers()['content-security-policy'] || ''), String(resp.status()));
  await full.screenshot({ path: path.join(outDir, '3-full-page-plan.png'), fullPage: true });
  await full.close();

  // B6 — 시작 at the bottom.
  await page.locator('#panel-plan-bar button', { hasText: '시작' }).click();
  await page.waitForTimeout(1200);
  const eff = effects();
  check('B6 시작 approves the plan', eff.gate === 'approved', String(eff.gate));
  check('B6 the start carried the plan', eff.started.length === 1 && eff.started[0].includes('[작업 계획 승인 — v1]') && eff.started[0].includes('계획 제출 도구'), String(eff.started[0] || '').slice(0, 80));
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    bar: document.getElementById('panel-plan-bar').hidden,
    head: ((document.getElementById('panel-status').data || {}).actions || []).map((a) => a.id),
  }));
  check('B6 after the start: no bottom bar, no plan actions in the top', after.bar && !after.head.includes('plan-start'), JSON.stringify(after));
  await page.screenshot({ path: path.join(outDir, '4-after-start.png'), fullPage: false });

  // B1 — the new-task composer, in a page of its own (no speech recogniser: headless has no microphone, and the
  // composer would start dictation by itself). A real click on 새 작업, then on 대시보드 작업.
  const nt = await ctx.newPage();
  await nt.addInitScript(() => {
    try { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; } catch (_) {}
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
  });
  await nt.goto(`${base}/dashboard`);
  await nt.waitForFunction(() => typeof _sessionCache === 'object' && Object.keys(_sessionCache).length >= 2, null, { timeout: 20000 });
  await nt.click('#new-task-btn');
  await nt.waitForFunction(() => typeof _ntCtx === 'object' && _ntCtx !== null, null, { timeout: 10000 });
  const destShown = await nt.evaluate(() => !document.getElementById('nt-dest').hidden);
  check('B1 the composer offers 대시보드 작업', destShown);
  const before = await nt.evaluate(() => ({ plan: _ntState.plan, wrapHidden: document.getElementById('nt-plan-wrap').hidden }));
  check('B1 plan is on by default; the switch is hidden for a Slack channel', before.plan === true && before.wrapHidden === true, JSON.stringify(before));
  await nt.click('#nt-dest-task');
  await nt.waitForTimeout(300);
  const sw = await nt.evaluate(() => ({ hidden: document.getElementById('nt-plan-wrap').hidden, checked: document.getElementById('nt-plan').checked }));
  check('B1 대시보드 작업 shows 작업 계획, checked by default', !sw.hidden && sw.checked, JSON.stringify(sw));
  await nt.screenshot({ path: path.join(outDir, '5-new-task-plan-toggle.png'), fullPage: false });
  await nt.click('#nt-plan-wrap');
  await nt.waitForTimeout(200);
  const off = await nt.evaluate(() => ({ state: _ntState.plan, body: ntBuildPayload(_ntState, [], 'req-check-1').plan }));
  check('B1 turning it off sends plan: false', off.state === false && off.body === false, JSON.stringify(off));
  await nt.close();
  fs.writeFileSync(path.join(outDir, 'report.txt'), report.join('\n') + '\n');
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
