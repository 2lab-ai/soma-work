/**
 * Device sweep for the responsive dashboard (SSOT 2026-10-24).
 *
 * Renders the real /dashboard (mock sessions, stubbed WebSocket) at every posture of
 * the target devices and asserts the layout contract, then replays fold / unfold
 * transitions. Exits non-zero on any failure. Screenshots go to
 * screenshots/responsive/<browser>-<device>-<state>.png.
 *
 *   npx tsx scripts/screenshot-responsive.ts [outDir]
 *
 * Postures (CSS px; research: docs/misc/research/2026-10-24-dashboard-device-viewports.md):
 *   iPhone Duo        cover 382×580 · cover landscape 678×340 · inner 951×543 · inner portrait 669×825
 *   iPhone 18 Pro Max 440×956 · landscape 956×440
 *   Galaxy Z Fold8    cover 476×751 · cover landscape 751×476 · main 933×704 · main portrait 704×933
 *   PC                1440×900 · 1920×1080
 *
 * Per posture, panel closed:
 *   - no horizontal page overflow;
 *   - inbox ≥ 840px wide: the three board columns fit inside the board; narrower: they
 *     scroll sideways (every column reachable);
 *   - below 640px: the last card is not under the FAB once scrolled to the end.
 * Per posture, panel open (with pinned Tasks and Artifacts filled in):
 *   - the drawer is inside the viewport; below 840px it is the full width with the dim,
 *     from 840px it is docked (no dim) and the page ends where it starts;
 *   - the composer is fully visible;
 *   - the main scroll area is at least half the panel body (R/2) and actually scrolls;
 *   - on touch, the composer input is 16px or more (no iOS focus zoom).
 * Transitions (Chromium, touch): Duo 382×580 → 466×498 → 951×543 → back, with and
 * without the panel open, with and without a saved view, with a 700px saved width,
 * and under reduced motion (no transform animations, a fade only).
 *
 * Chromium's setViewportSize is not a hinge: it proves the layout and the animation
 * scheduling, not the real device's OS transition or its on-screen keyboard.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, type BrowserType, chromium, type Page, webkit } from 'playwright';

type Posture = { device: string; w: number; h: number };
const POSTURES: Posture[] = [
  { device: 'duo-cover', w: 382, h: 580 },
  { device: 'duo-cover-land', w: 678, h: 340 },
  { device: 'duo-inner', w: 951, h: 543 },
  { device: 'duo-inner-portrait', w: 669, h: 825 },
  { device: 'promax', w: 440, h: 956 },
  { device: 'promax-land', w: 956, h: 440 },
  { device: 'fold8-cover', w: 476, h: 751 },
  { device: 'fold8-cover-land', w: 751, h: 476 },
  { device: 'fold8-main', w: 933, h: 704 },
  { device: 'fold8-main-portrait', w: 704, h: 933 },
  { device: 'pc', w: 1440, h: 900 },
  { device: 'pc-wide', w: 1920, h: 1080 },
];

async function setupMockSessions() {
  const { setDashboardSessionAccessor } = await import('../src/conversation/dashboard');
  const now = Date.now();
  const base = {
    ownerId: 'U001',
    ownerName: 'Zhuge',
    channelId: 'C123',
    model: 'claude-opus-4-6',
    state: 'MAIN',
    workflow: 'zwork',
    links: {},
    usage: { totalInputTokens: 900000, totalOutputTokens: 200000, totalCostUsd: 9.5, contextWindow: 200000 },
  };
  const sessions = new Map<string, Record<string, unknown>>();
  const add = (n: number, title: string, activityState: string) =>
    sessions.set(`C123:17000000${n}.000001`, {
      ...base,
      threadTs: `17000000${n}.000001`,
      sessionId: `sess-${n}`,
      conversationId: `conv-${n}`,
      title,
      activityState,
      lastActivity: new Date(now - n * 60000),
    });
  add(1, 'Waiting on a decision', 'waiting');
  add(2, 'Running the device sweep', 'working');
  add(3, 'Refactor the drawer', 'working');
  add(4, 'Ship release notes', 'idle');
  add(5, 'Triage open PRs', 'working');
  setDashboardSessionAccessor(() => sessions);
  return sessions;
}

async function preparePage(page: Page, opts: { savedView?: string; savedWidth?: number } = {}) {
  // Plain-JS init scripts (tsx would wrap named functions in __name()).
  await page.addInitScript({
    content: [
      'window.WebSocket = function StubWebSocket(url) { this.url = url; };',
      'window.WebSocket.prototype.close = function () {};',
      'try { localStorage.clear(); } catch (_e) {}',
      // Count the script animations that move board items (the layout-shift FLIPs), so a
      // probe that lands after a 320ms animation ended still sees that it ran.
      'window.__shiftAnims = 0;',
      // And the drawer's own width animation (sheet ↔ dock).
      'window.__panelWidthAnims = 0;',
      'var __animate = Element.prototype.animate;',
      'Element.prototype.animate = function (kf, opts) {',
      "  try { if (this.matches('#kanban .card, #kanban .kanban-col-header') && JSON.stringify(kf).indexOf('transform') >= 0) window.__shiftAnims++; } catch (_e) {}",
      "  try { if (this.id === 'slide-panel' && JSON.stringify(kf).indexOf('width') >= 0) window.__panelWidthAnims++; } catch (_e) {}",
      '  return __animate.call(this, kf, opts);',
      '};',
      opts.savedView ? `localStorage.setItem('soma-board-view', ${JSON.stringify(opts.savedView)});` : '',
      opts.savedWidth ? `localStorage.setItem('soma-panel-width', '${opts.savedWidth}');` : '',
    ].join('\n'),
  });
}

async function openDashboard(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/dashboard`);
  await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length > 0, { timeout: 15000 });
  await page.waitForTimeout(500);
}

/** Open the first card's panel and fill the pinned blocks and the turns with content. */
async function openFilledPanel(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { openPanel(k: string): void };
    const card = document.querySelector('#kanban [data-session-key]') as HTMLElement;
    w.openPanel(card.getAttribute('data-session-key') as string);
  });
  // Let the panel's own loads (turns, work log) land before filling it in.
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const tasks = document.getElementById('panel-tasks') as HTMLElement;
    tasks.innerHTML = `<div class="panel-tasks-header"><span>Tasks</span></div>${Array.from(
      { length: 8 },
      (_, i) => `<div class="task-item" style="padding:6px 0">Task ${i + 1} — check the layout</div>`,
    ).join('')}`;
    const arts = document.getElementById('panel-artifacts') as HTMLElement;
    arts.style.display = '';
    arts.innerHTML = `<div class="panel-arts-head">Artifacts</div><div class="art-strip art-strip-panel">${Array.from(
      { length: 4 },
      (_, i) =>
        `<div class="art-tile"><button class="art-open" type="button"><div class="art-thumb"></div><div class="art-tile-name">report-${i}.html</div><div class="art-tile-meta">2 min ago</div></button></div>`,
    ).join('')}</div>`;
    const turns = document.getElementById('panel-turns') as HTMLElement;
    turns.innerHTML = Array.from(
      { length: 12 },
      (_, i) =>
        `<div class="turn assistant"><div class="turn-body"><div class="turn-content">Turn ${i + 1}: the drawer keeps its conversation readable at every size.</div></div></div>`,
    ).join('');
  });
  await page.waitForTimeout(450);
}

type Check = { ok: boolean; msg: string };

async function checkClosed(page: Page): Promise<Check[]> {
  return page.evaluate(() => {
    const out: { ok: boolean; msg: string }[] = [];
    const vw = window.innerWidth;
    const overflow = document.documentElement.scrollWidth - vw;
    out.push({ ok: overflow <= 0, msg: `page overflow ${overflow}px` });
    const kb = document.getElementById('kanban') as HTMLElement;
    const inbox = document.getElementById('inbox') as HTMLElement;
    if (kb.getAttribute('data-view') === 'board') {
      const kr = kb.getBoundingClientRect();
      const cols = Array.from(kb.querySelectorAll(':scope > .kanban-col')).map((c) => c.getBoundingClientRect());
      if (inbox.getBoundingClientRect().width >= 840) {
        const fit = cols.every((c) => c.right <= kr.right + 1 && c.left >= kr.left - 1);
        out.push({ ok: fit, msg: 'inbox ≥ 840: three columns fit the board' });
      } else {
        out.push({ ok: kb.scrollWidth >= kb.clientWidth, msg: 'inbox < 840: columns reachable by sideways scroll' });
      }
    }
    return out;
  });
}

async function checkFab(page: Page): Promise<Check[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const fab = document.querySelector('.new-task-fab') as HTMLElement;
    const cards = Array.from(document.querySelectorAll('#kanban .card'));
    const last = cards[cards.length - 1] as HTMLElement | undefined;
    if (!fab || !last || getComputedStyle(fab).display === 'none') return [];
    const f = fab.getBoundingClientRect();
    const c = last.getBoundingClientRect();
    const overlap = c.bottom > f.top && c.top < f.bottom && c.right > f.left && c.left < f.right;
    return [{ ok: !overlap, msg: 'the FAB does not cover the last card at the end of the page' }];
  });
}

async function checkOpen(page: Page, touch: boolean): Promise<Check[]> {
  return page.evaluate((touchArg) => {
    const out: { ok: boolean; msg: string }[] = [];
    // The layout width: desktop WebKit draws a classic scrollbar inside innerWidth.
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const panel = document.getElementById('slide-panel') as HTMLElement;
    const p = panel.getBoundingClientRect();
    out.push({ ok: p.left >= -1 && p.right <= vw + 1, msg: `drawer inside the viewport (${p.left}..${p.right})` });
    const overlay = getComputedStyle(document.getElementById('panel-overlay') as HTMLElement).display;
    if (vw < 840) {
      out.push({ ok: Math.abs(p.width - vw) <= 1, msg: `sheet is full width (${p.width} vs ${vw})` });
      out.push({ ok: overlay !== 'none', msg: 'sheet dims the page' });
    } else {
      out.push({ ok: overlay === 'none', msg: 'docked: no dim' });
      out.push({ ok: p.width <= vw / 2 + 1, msg: `docked width ≤ 50vw (${p.width})` });
      const main = (document.querySelector('.main') as HTMLElement).getBoundingClientRect();
      out.push({
        ok: main.right <= p.left + 1,
        msg: `docked: the page ends where the drawer starts (${main.right} ≤ ${p.left})`,
      });
    }
    const cmd = (document.getElementById('panel-command') as HTMLElement).getBoundingClientRect();
    out.push({
      ok: cmd.bottom <= vh + 1 && cmd.top >= 0,
      msg: `composer fully visible (${cmd.top}..${cmd.bottom} / ${vh})`,
    });
    const body = (document.getElementById('panel-body') as HTMLElement).getBoundingClientRect();
    const scrollEl = document.getElementById('panel-scroll') as HTMLElement;
    const s = scrollEl.getBoundingClientRect();
    // R/2, or what the two 44px pinned floors leave on the shortest bodies.
    const need = Math.min(body.height / 2, body.height - 88);
    out.push({ ok: s.height >= need - 1, msg: `main scroll ≥ R/2 (${s.height} ≥ ${need})` });
    // The body clips overflow: every row must also end inside it, or a "tall" scroll
    // area could be partly hidden under the composer.
    for (const id of ['panel-tasks', 'panel-artifacts', 'panel-scroll']) {
      const el = document.getElementById(id) as HTMLElement;
      if (getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      out.push({
        ok: r.top >= body.top - 1 && r.bottom <= body.bottom + 1,
        msg: `#${id} inside the body, not clipped (${r.top}..${r.bottom} in ${body.top}..${body.bottom})`,
      });
    }
    scrollEl.scrollTo({ top: 0, behavior: 'instant' });
    const top = scrollEl.scrollTop;
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'instant' });
    out.push({
      ok: scrollEl.scrollHeight > scrollEl.clientHeight && scrollEl.scrollTop > top,
      msg: `the conversation scrolls (${scrollEl.clientHeight}/${scrollEl.scrollHeight})`,
    });
    const tasks = (document.getElementById('panel-tasks') as HTMLElement).getBoundingClientRect();
    out.push({ ok: tasks.height >= 43, msg: `pinned Tasks keep at least one row (${tasks.height})` });
    if (touchArg) {
      const fs = parseFloat(getComputedStyle(document.getElementById('cmd-input') as HTMLElement).fontSize);
      out.push({ ok: fs >= 16, msg: `composer input ${fs}px ≥ 16px on touch` });
    }
    return out;
  }, touch);
}

async function sweepBrowser(name: string, type: BrowserType, baseUrl: string, outDir: string, failures: string[]) {
  let browser: Browser;
  try {
    browser = await type.launch({ headless: true });
  } catch (err) {
    console.warn(`[responsive] ${name} unavailable, skipping: ${(err as Error).message}`);
    return;
  }
  try {
    for (const pos of POSTURES) {
      const touch = pos.device !== 'pc' && pos.device !== 'pc-wide';
      const ctx = await browser.newContext({
        viewport: { width: pos.w, height: pos.h },
        hasTouch: touch,
        isMobile: touch && name === 'chromium',
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      const tag = `${name}-${pos.device}`;
      page.on('pageerror', (e) => failures.push(`${tag}: page error ${e.message}`));
      try {
        await preparePage(page);
        await openDashboard(page, baseUrl);
        const record = (checks: Check[], state: string) => {
          for (const c of checks) {
            const line = `${tag}-${state}: ${c.msg}`;
            if (c.ok) console.log(`[ok] ${line}`);
            else {
              console.error(`[FAIL] ${line}`);
              failures.push(line);
            }
          }
        };
        record(await checkClosed(page), 'closed');
        await page.screenshot({ path: path.join(outDir, `${tag}-closed.png`) });
        if (pos.w < 640) record(await checkFab(page), 'closed');
        await page.evaluate(() => window.scrollTo(0, 0));
        await openFilledPanel(page);
        // Measure the settled drawer, not its slide-in (headless frames can lag).
        await page.waitForFunction(
          () => (document.getElementById('slide-panel') as HTMLElement).getAnimations().length === 0,
        );
        record(await checkOpen(page, touch), 'open');
        await page.screenshot({ path: path.join(outDir, `${tag}-open.png`) });
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
}

type ShiftProbe = { view: string; transformAnimations: number; panelW: number; overlay: string };
/** Resize, wait for the page to see the new size and for the shift to finish, then report. */
async function resizeAndProbe(page: Page, w: number, h: number, settle = true): Promise<ShiftProbe> {
  await page.evaluate(() => {
    (window as unknown as { __shiftAnims: number }).__shiftAnims = 0;
  });
  await page.setViewportSize({ width: w, height: h });
  await page.waitForFunction((width) => window.innerWidth === width, w);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  if (settle) {
    // Settled: no script animation left (CSS spinners and transitions are not shifts).
    await page.waitForFunction(
      () => document.getAnimations().every((a) => a instanceof CSSAnimation || a instanceof CSSTransition),
      undefined,
      { timeout: 5000 },
    );
    await page.waitForTimeout(80);
  }
  return page.evaluate(() => {
    const panel = document.getElementById('slide-panel') as HTMLElement;
    return {
      view: (document.getElementById('kanban') as HTMLElement).getAttribute('data-view') || '',
      transformAnimations: (window as unknown as { __shiftAnims: number }).__shiftAnims,
      panelW: panel.getBoundingClientRect().width,
      overlay: getComputedStyle(document.getElementById('panel-overlay') as HTMLElement).display,
    };
  });
}

async function transitions(
  baseUrl: string,
  outDir: string,
  failures: string[],
  sessions: Map<string, Record<string, unknown>>,
) {
  const browser = await chromium.launch({ headless: true });
  const expect = (ok: boolean, msg: string) => {
    if (ok) console.log(`[ok] transition: ${msg}`);
    else {
      console.error(`[FAIL] transition: ${msg}`);
      failures.push(`transition: ${msg}`);
    }
  };
  const fresh = async (opts: { savedView?: string; savedWidth?: number; reduced?: boolean } = {}) => {
    const ctx = await browser.newContext({
      viewport: { width: 382, height: 580 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
      reducedMotion: opts.reduced ? 'reduce' : 'no-preference',
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => failures.push(`transition: page error ${e.message}`));
    await preparePage(page, opts);
    await openDashboard(page, baseUrl);
    return { ctx, page };
  };
  try {
    // 1. Unfold with no saved view: List on the cover → Board unfolded, animated; and back.
    {
      const { ctx, page } = await fresh();
      expect((await page.getAttribute('#kanban', 'data-view')) === 'list', 'cover starts in List');
      const mid = await resizeAndProbe(page, 466, 498);
      expect(
        mid.view === 'list' && mid.transformAnimations === 0,
        'the transient 466×498 frame does not start a shift',
      );
      const open = await resizeAndProbe(page, 951, 543);
      expect(open.view === 'board', 'unfolded switches to Board (not saved)');
      expect(
        open.transformAnimations > 0,
        `unfold animates the cards (${open.transformAnimations} transform animations)`,
      );
      await page.screenshot({ path: path.join(outDir, 'transition-unfold-mid.png') });
      const saved = await page.evaluate(() => localStorage.getItem('soma-board-view'));
      expect(saved === null, 'the automatic view is never saved');
      const back = await resizeAndProbe(page, 382, 580);
      expect(back.view === 'list', 'folding back returns to List');
      expect(back.transformAnimations > 0, 'fold animates the cards');
      // Retarget: a second resize while the cards fly continues from where they are.
      await resizeAndProbe(page, 951, 543, false);
      const again = await resizeAndProbe(page, 669, 825);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(again.transformAnimations > 0 && overflow <= 0, 'a resize mid-flight retargets without overflow');
      await ctx.close();
    }
    // 2. A saved view is never overridden.
    {
      const { ctx, page } = await fresh({ savedView: 'board' });
      await resizeAndProbe(page, 951, 543);
      const back = await resizeAndProbe(page, 382, 580);
      expect(back.view === 'board', 'a saved Board stays Board on the cover');
      await ctx.close();
    }
    // 3. Panel open across the fold, with a 700px saved width: sheet → dock → sheet.
    {
      const { ctx, page } = await fresh({ savedWidth: 700 });
      await openFilledPanel(page);
      const sheet = await page.evaluate(
        () => (document.getElementById('slide-panel') as HTMLElement).getBoundingClientRect().width,
      );
      expect(Math.abs(sheet - 382) <= 1, `cover sheet ignores the 700px saved width (${sheet})`);
      // The drawer's own width animates through the unfold (sheet 382 → dock 475.5).
      const docked = await resizeAndProbe(page, 951, 543);
      const widthAnims = await page.evaluate(
        () => (window as unknown as { __panelWidthAnims: number }).__panelWidthAnims,
      );
      expect(widthAnims > 0, `unfold animates the drawer width (${widthAnims} width animations)`);
      const dockW = docked.panelW;
      expect(docked.overlay === 'none', 'unfolded: the open drawer docks (no dim)');
      expect(dockW <= 951 / 2 + 1, `unfolded: docked width capped at 50vw (${dockW})`);
      await page.screenshot({ path: path.join(outDir, 'transition-docked.png') });
      const folded = await resizeAndProbe(page, 382, 580);
      const sheetAgain = folded.panelW;
      expect(
        folded.overlay !== 'none' && Math.abs(sheetAgain - 382) <= 1,
        `folded again: back to a full sheet (${sheetAgain})`,
      );
      const pref = await page.evaluate(() => localStorage.getItem('soma-panel-width'));
      expect(pref === '700', 'the saved width preference is untouched by the fold');
      // Closing keeps the slide-out visible (it is not hidden on frame one).
      const closing = await page.evaluate(async () => {
        (window as unknown as { closePanel(): void }).closePanel();
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        const panel = document.getElementById('slide-panel') as HTMLElement;
        return { visibility: getComputedStyle(panel).visibility, left: panel.getBoundingClientRect().left };
      });
      expect(
        closing.visibility === 'visible',
        `closing: the drawer stays visible while it slides out (${closing.visibility})`,
      );
      await ctx.close();
    }
    // 4b. A user Board/List switch animates once, from where the cards were: the
    //     first frame starts at the old spot and no frame overshoots the new one
    //     (a doubled FLIP translate would jump past it — trinity code review R1).
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => failures.push(`transition view switch: page error ${e.message}`));
      await preparePage(page);
      await openDashboard(page, baseUrl);
      const before = await page.evaluate(
        () => (document.querySelectorAll('#kanban .card')[1] as HTMLElement).getBoundingClientRect().left,
      );
      // Click and sample in one page task, so the first sample is the first frame
      // (a round trip after page.click can land after the 320ms move). detail: 1 is
      // what a real click carries; setBoardView animates only pointer clicks.
      // Plain async arrow (no named function: tsx would wrap it in __name()).
      const xs = await page.evaluate(async () => {
        const card = document.querySelectorAll('#kanban .card')[1] as HTMLElement;
        const out: number[] = [];
        (document.querySelector('.seg-btn[data-view="list"]') as HTMLElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
        );
        for (let n = 0; n < 40; n++) {
          out.push(card.getBoundingClientRect().left);
          await new Promise((r) => requestAnimationFrame(r));
        }
        return out;
      });
      const end = xs[xs.length - 1];
      const span = Math.abs(end - before);
      expect(span > 50, `the switch moves the card (${before} → ${end})`);
      expect(
        Math.abs(xs[0] - before) <= span * 0.25 + 2,
        `the switch starts at the old spot (first frame ${xs[0]}, was ${before})`,
      );
      expect(
        xs.every((x) => Math.abs(x - end) <= span + 2),
        `no frame overshoots (max distance ${Math.max(...xs.map((x) => Math.abs(x - end)))} ≤ ${span})`,
      );
      await ctx.close();
    }
    // 4c. A live render that moves a card to another column while a shift is still
    //      flying (the docked drawer just narrowed the board) never jumps back past
    //      where the card was: the render's own FLIP is the one the shift continues
    //      (trinity code review R2, astra).
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => failures.push(`transition live render: page error ${e.message}`));
      await preparePage(page);
      await openDashboard(page, baseUrl);
      const moving = sessions.get('C123:170000002.000001') as Record<string, unknown>;
      const was = moving.activityState;
      moving.activityState = 'idle'; // RUNNING → DONE on the next load
      const r = await page.evaluate(async () => {
        const w = window as unknown as { openPanel(k: string): void; loadSessions(): Promise<void> };
        const first = document.querySelector('#kanban [data-session-key]') as HTMLElement;
        const card = document.querySelector('#kanban [data-session-key$="170000002.000001"]') as HTMLElement;
        w.openPanel(first.getAttribute('data-session-key') as string);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const before = card.getBoundingClientRect().left;
        void w.loadSessions();
        const xs: number[] = [];
        for (let n = 0; n < 45; n++) {
          xs.push(card.getBoundingClientRect().left);
          await new Promise((res) => requestAnimationFrame(res));
        }
        return { before, xs };
      });
      moving.activityState = was;
      const end = r.xs[r.xs.length - 1];
      const lo = Math.min(r.before, end) - 2;
      const hi = Math.max(r.before, end) + 2;
      const out = r.xs.filter((x) => x < lo || x > hi);
      expect(Math.abs(end - r.before) > 50, `the render moves the card (${r.before} → ${end})`);
      expect(
        out.length === 0,
        `no frame leaves the path between the old and new spot (${out.slice(0, 3).join(', ') || 'none'})`,
      );
      await ctx.close();
    }
    // 4d. Dragging the docked drawer's edge across the inbox's 840px boundary moves the
    //     edge with the pointer: no width animation chases it (trinity code review R2, fable).
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => failures.push(`transition drag: page error ${e.message}`));
      await preparePage(page);
      await openDashboard(page, baseUrl);
      await openFilledPanel(page);
      await page.evaluate(() => {
        (window as unknown as { __panelWidthAnims: number }).__panelWidthAnims = 0;
      });
      const edge = await page.evaluate(
        () => (document.getElementById('slide-panel') as HTMLElement).getBoundingClientRect().left,
      );
      await page.mouse.move(edge + 3, 450);
      await page.mouse.down();
      await page.mouse.move(edge - 240, 450, { steps: 24 });
      await page.mouse.up();
      const after = await page.evaluate(() => ({
        anims: (window as unknown as { __panelWidthAnims: number }).__panelWidthAnims,
        left: (document.getElementById('slide-panel') as HTMLElement).getBoundingClientRect().left,
        saved: localStorage.getItem('soma-panel-width'),
      }));
      expect(after.anims === 0, `a handle drag starts no width animation (${after.anims})`);
      expect(Math.abs(after.left - (edge - 240)) <= 2, `the edge follows the pointer (${after.left} vs ${edge - 240})`);
      expect(after.saved !== null, `the dragged width is saved (${after.saved})`);
      await ctx.close();
    }
    // 4. Reduced motion: no movement, a fade only.
    {
      const { ctx, page } = await fresh({ reduced: true });
      const open = await resizeAndProbe(page, 951, 543);
      expect(open.view === 'board' && open.transformAnimations === 0, 'reduced motion: the unfold does not move cards');
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const outDir = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'responsive');
  fs.mkdirSync(outDir, { recursive: true });
  const sessions = await setupMockSessions();
  const { startWebServer, stopWebServer, getViewerBaseUrl } = await import('../src/conversation/web-server');
  await startWebServer({ listen: true });
  // The viewer advertises its LAN host name; the sweep talks to the loopback.
  const baseUrl = getViewerBaseUrl().replace(/\/\/[^:/]+/, '//127.0.0.1');
  const failures: string[] = [];
  try {
    await sweepBrowser('chromium', chromium, baseUrl, outDir, failures);
    await sweepBrowser('webkit', webkit, baseUrl, outDir, failures);
    await transitions(baseUrl, outDir, failures, sessions);
  } finally {
    await stopWebServer();
  }
  console.log(`\nScreenshots: ${outDir}`);
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log('All responsive checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
