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

// Loaded with the dashboard (after the env is set): the capacity fixture runs the real model.
let buildCapacityView: typeof import('../src/conversation/capacity-view').buildCapacityView;

async function setupMockSessions() {
  const { setDashboardSessionAccessor } = await import('../src/conversation/dashboard');
  ({ buildCapacityView } = await import('../src/conversation/capacity-view'));
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
  // A cron run (#374): it leaves the columns for the CRON lane above them.
  add(6, 'Nightly usage report', 'idle');
  (sessions.get('C123:170000006.000001') as Record<string, unknown>).cronJob = {
    id: 'job-nightly',
    name: 'nightly-usage',
  };
  setDashboardSessionAccessor(() => sessions);
  return sessions;
}

/**
 * LLM capacity (#374, v2 2026-10-25) with two provider groups: an llmux snapshot
 * through the real buildCapacityView. Claude ok; Codex low (▲) and weekly-only.
 */
function capacityFixture(nowMs: number) {
  const nowS = Math.floor(nowMs / 1000);
  const w = (used: number, hours: number) => ({
    utilization: used,
    resets_at: nowS + hours * 3600,
    resets_in_secs: hours * 3600,
  });
  const acct = (name: string, group: string, over: Record<string, unknown>) => ({
    name: `${group}:${name}@corp.example`,
    type: group === 'codex' ? 'codex' : 'oauth',
    group,
    status: 'ok',
    order: 1,
    blocked: null,
    ...over,
  });
  const status = {
    current: null,
    accounts: [
      acct('acct-a', 'claude', { five_hour: w(0.7, 2), seven_day: w(0.3, 90) }),
      acct('acct-b', 'claude', { five_hour: w(0.1, 3), seven_day: w(0.6, 30) }),
      acct('acct-c', 'claude', { five_hour: null, seven_day: w(1, 50), blocked: '7d 100.0% > 99%' }),
      acct('acct-d', 'claude', { five_hour: w(0, 1), seven_day: w(0.2, 120) }),
      acct('acct-e', 'codex', { seven_day: w(0.9, 100) }),
      acct('acct-f', 'codex', { seven_day: w(0.95, 60) }),
    ],
  };
  const tiers = {
    'claude:acct-a': 'claude-max-20x',
    'claude:acct-b': 'claude-max-5x',
    'claude:acct-c': 'claude-max-20x',
    'claude:acct-d': 'claude-max-5x',
    'codex:acct-e': 'chatgpt-pro-500',
    'codex:acct-f': 'chatgpt-pro-200',
  };
  return { capacity: buildCapacityView(status as never, tiers as never, nowMs) };
}

async function preparePage(
  page: Page,
  opts: {
    savedView?: string;
    savedWidth?: number;
    seedSecondary?: boolean;
    openSections?: string[];
    capacityDelayMs?: number;
  } = {},
) {
  if (opts.seedSecondary) {
    const now = Date.now();
    const delay = opts.capacityDelayMs || 0;
    await page.route('**/api/dashboard/capacity', async (r) => {
      // A slow llmux: the view lands after the board has settled.
      if (delay) await new Promise((res) => setTimeout(res, delay));
      await r.fulfill({ json: capacityFixture(now) });
    });
    await page.route('**/api/dashboard/cron*', (r) =>
      r.fulfill({
        json: {
          jobs: [
            {
              id: 'job-nightly',
              name: 'nightly-usage',
              expression: '0 9 * * *',
              nextRunAt: now + 3 * 3600e3,
              runs: [],
            },
          ],
        },
      }),
    );
  }
  // Plain-JS init scripts (tsx would wrap named functions in __name()).
  await page.addInitScript({
    content: [
      'window.WebSocket = function StubWebSocket(url) { this.url = url; };',
      'window.WebSocket.prototype.close = function () {};',
      // Count the script animations that move board items (the layout-shift FLIPs), so a
      // probe that lands after a 320ms animation ended still sees that it ran.
      'window.__shiftAnims = 0;',
      // And the drawer's own width animation (sheet ↔ dock).
      'window.__panelWidthAnims = 0;',
      'var __animate = Element.prototype.animate;',
      'Element.prototype.animate = function (kf, opts) {',
      "  try { if (this.matches('#kanban .card, #kanban .kanban-col-header') && JSON.stringify(kf).indexOf('transform') >= 0) window.__shiftAnims++; } catch (_e) {}",
      "  try { if (this.id === 'slide-panel' && JSON.stringify(kf).indexOf('width') >= 0) window.__panelWidthAnims++; } catch (_e) {}",
      // Where a CRON lane card's layout FLIP starts on screen: its layout spot plus the first translate.
      "  try { if (this.matches('.card') && kf[0] && kf[0].transform) { var m2 = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/.exec(kf[0].transform); var r2 = this.getBoundingClientRect(); if (m2) { window.__flipStarts = window.__flipStarts || {}; window.__flipStarts[this.getAttribute('data-session-key')] = { left: r2.left + Number(m2[1]), top: r2.top + Number(m2[2]) }; } } } catch (_e) {}",
      "  try { if (this.matches('.cron-lane .card') && kf[0] && kf[0].transform) { var m = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/.exec(kf[0].transform); var r = this.getBoundingClientRect(); if (m) window.__cronFlipStart = { left: r.left + Number(m[1]), top: r.top + Number(m[2]) }; } } catch (_e) {}",
      '  return __animate.call(this, kf, opts);',
      '};',
      // First load only: a reload keeps what the page itself saved.
      "try { if (!sessionStorage.getItem('__sweepInit')) { sessionStorage.setItem('__sweepInit', '1'); localStorage.clear();",
      opts.savedView ? `localStorage.setItem('soma-board-view', ${JSON.stringify(opts.savedView)});` : '',
      opts.savedWidth ? `localStorage.setItem('soma-panel-width', '${opts.savedWidth}');` : '',
      ...(opts.openSections || []).map((sec) => `localStorage.setItem('soma-sec-${sec}', 'open');`),
      '} } catch (_e) {}',
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

/**
 * The merged secondary sections (#374 LLM capacity, CRON lane) leave the board on the
 * first screen: its first card on screens at least 540px tall, its title row on the
 * short landscape phones. An expanded capacity section keeps every chart inside its card.
 */
async function checkSecondary(page: Page, touch: boolean): Promise<Check[]> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  return page.evaluate((touchArg) => {
    const out: { ok: boolean; msg: string }[] = [];
    const vh = window.innerHeight;
    const cap = document.getElementById('capacity') as HTMLElement;
    for (const id of ['capacity-toggle', 'cron-toggle']) {
      const t = document.getElementById(id) as HTMLElement | null;
      if (!t) continue;
      const r = t.getBoundingClientRect();
      const need = touchArg ? 44 : 28;
      out.push({
        ok: r.height >= need,
        msg: `#${id} is ${Math.round(r.height)}px tall (≥ ${need}${touchArg ? ' on touch' : ''})`,
      });
    }
    const lane = document.getElementById('cron-lane') as HTMLElement;
    out.push({ ok: !cap.hidden && !lane.hidden, msg: 'capacity and the CRON lane are shown (seeded)' });
    // Collapsed (capacity: every posture but an 840×1400+ window; CRON: 840×1000+): chips for capacity.
    if (cap.classList.contains('is-collapsed')) {
      const h = cap.getBoundingClientRect().height;
      out.push({ ok: h <= 64, msg: `collapsed capacity is one row (${Math.round(h)} ≤ 64px)` });
      const chips = Array.from(cap.querySelectorAll('.cap-chip')).map((c) =>
        (c as HTMLElement).innerText.replace(/\s+/g, ' '),
      );
      out.push({
        ok:
          chips.length === 2 &&
          chips[0].indexOf('Claude') === 0 &&
          chips[0].indexOf('·') > 0 &&
          chips[1].indexOf('▲ Codex') === 0 &&
          chips[1].indexOf('·') < 0,
        msg: `capacity chips: ${chips.join(' / ')}`,
      });
      // Whole chips: none runs past the row's visible edge (the glyph and % would hide).
      const row = (cap.querySelector('.cap-summary') as HTMLElement).getBoundingClientRect();
      const cut = Array.from(cap.querySelectorAll('.cap-chip')).filter(
        (c) => (c as HTMLElement).getBoundingClientRect().right > row.right + 0.5,
      ).length;
      out.push({
        ok: cut === 0,
        msg: `every capacity chip is whole on the row (${cut} cut at ${Math.round(row.right)})`,
      });
      const title = (cap.querySelector('.cap-title') as HTMLElement).getBoundingClientRect();
      out.push({ ok: title.height <= 24, msg: `the capacity title is one line (${Math.round(title.height)}px)` });
    }
    if (lane.classList.contains('is-collapsed') && !lane.querySelector('.cron-group.is-waiting')) {
      const h = lane.getBoundingClientRect().height;
      out.push({ ok: h <= 64, msg: `collapsed CRON lane is one row (${Math.round(h)} ≤ 64px)` });
    }
    const card = (document.querySelector('#kanban .card') as HTMLElement).getBoundingClientRect();
    const head = (document.querySelector('.inbox-head') as HTMLElement).getBoundingClientRect();
    if (vh >= 540) {
      out.push({
        ok: card.top <= vh - 60,
        msg: `the first board card starts on the first screen (${Math.round(card.top)} ≤ ${vh - 60})`,
      });
    } else {
      out.push({
        ok: head.top <= vh - 50,
        msg: `the board title row starts on the first screen (${Math.round(head.top)} ≤ ${vh - 50})`,
      });
    }
    // v2: every chart (unit bar, per-account bars, lanes) stays inside its provider card.
    const cards = Array.from(document.querySelectorAll('#capacity .cap-prov')) as HTMLElement[];
    let outside = 0;
    for (const c of cards) {
      const cr = c.getBoundingClientRect();
      if (cr.width === 0) continue;
      for (const g of Array.from(c.querySelectorAll('svg')) as SVGElement[]) {
        const r = g.getBoundingClientRect();
        if (r.width > 0 && (r.left < cr.left - 1 || r.right > cr.right + 1)) outside++;
      }
    }
    out.push({ ok: outside === 0, msg: `capacity charts stay inside their cards (${outside} outside)` });
    return out;
  }, touch);
}

/** Expand the capacity timeline if a disclosure collapsed it, then check its markers. */
async function checkCapacityExpanded(page: Page, state: string): Promise<Check[]> {
  await page.evaluate(() => {
    const t = document.querySelector('[data-sec-toggle="capacity"]') as HTMLElement | null;
    if (t && t.getAttribute('aria-expanded') === 'false') t.click();
  });
  await page.waitForTimeout(400);
  return page.evaluate((st) => {
    const out: { ok: boolean; msg: string }[] = [];
    const vw = document.documentElement.clientWidth;
    const cards = Array.from(document.querySelectorAll('#capacity .cap-prov')) as HTMLElement[];
    out.push({
      ok: cards.length === 2 && cards.every((c) => c.getBoundingClientRect().width > 0),
      msg: `${st}: the capacity section shows both providers`,
    });
    let outside = 0;
    for (const c of cards) {
      const cr = c.getBoundingClientRect();
      for (const g of Array.from(c.querySelectorAll('svg')) as SVGElement[]) {
        const r = g.getBoundingClientRect();
        if (r.width > 0 && (r.left < cr.left - 1 || r.right > cr.right + 1)) outside++;
      }
    }
    out.push({ ok: outside === 0, msg: `${st}: capacity charts stay inside their cards (${outside} outside)` });
    const capR = (document.getElementById('capacity') as HTMLElement).getBoundingClientRect();
    out.push({
      ok: capR.right <= vw + 1,
      msg: `${st}: capacity has no sideways overflow (${Math.round(capR.right)} ≤ ${vw})`,
    });
    return out;
  }, state);
}

/** The cron run drawer (#374), opened directly: it fits the viewport and its close button is reachable. */
async function checkCronDrawer(page: Page, touch: boolean): Promise<Check[]> {
  await page.evaluate(() => {
    const d = document.getElementById('cron-drawer') as HTMLElement;
    d.removeAttribute('inert');
    d.classList.add('open');
  });
  await page.waitForFunction(
    () => (document.getElementById('cron-drawer') as HTMLElement).getAnimations().length === 0,
  );
  const checks = await page.evaluate((touchArg) => {
    const out: { ok: boolean; msg: string }[] = [];
    const vw = document.documentElement.clientWidth;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const d = (document.getElementById('cron-drawer') as HTMLElement).getBoundingClientRect();
    out.push({
      ok: d.left >= -1 && d.right <= vw + 1 && d.top >= -1 && d.bottom <= vh + 1,
      msg: `cron drawer inside the visible viewport (${d.left},${d.top}..${d.right},${d.bottom} / ${vw}×${vh})`,
    });
    const c = (document.getElementById('cron-drawer-close') as HTMLElement).getBoundingClientRect();
    out.push({
      ok: c.left >= 0 && c.right <= vw && c.top >= 0 && c.bottom <= vh && c.width >= (touchArg ? 44 : 36),
      msg: `cron drawer close button on screen (${c.left},${c.top} ${c.width}px${touchArg ? ', ≥ 44px on touch' : ''})`,
    });
    return out;
  }, touch);
  await page.evaluate(() => {
    const d = document.getElementById('cron-drawer') as HTMLElement;
    d.classList.remove('open');
    d.setAttribute('inert', '');
  });
  return checks;
}

/** The settings page (#374), linked from the dashboard top bar: no sideways overflow, 16px fields on touch. */
async function checkSettings(page: Page, baseUrl: string, touch: boolean): Promise<Check[]> {
  await page.goto(`${baseUrl}/dashboard/settings`);
  await page.waitForTimeout(400);
  return page.evaluate((touchArg) => {
    const out: { ok: boolean; msg: string }[] = [];
    const vw = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    out.push({ ok: sw <= vw + 1, msg: `settings page has no sideways overflow (${sw} ≤ ${vw})` });
    if (touchArg) {
      const search = document.getElementById('pref-filter') as HTMLElement | null;
      const fsr = search ? parseFloat(getComputedStyle(search).fontSize) : 0;
      out.push({ ok: fsr >= 16, msg: `settings search field ${fsr}px ≥ 16px on touch` });
      // The rows load per user; probe the field rules with a detached row.
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<input type="text"><select><option>x</option></select>';
      document.body.appendChild(row);
      const fi = parseFloat(getComputedStyle(row.querySelector('input') as HTMLElement).fontSize);
      const fsel = parseFloat(getComputedStyle(row.querySelector('select') as HTMLElement).fontSize);
      row.remove();
      out.push({ ok: fi >= 16 && fsel >= 16, msg: `settings fields ${fi}px / ${fsel}px ≥ 16px on touch` });
    }
    return out;
  }, touch);
}

/** The settings page's 기억 tab (#379, linked from the dashboard top bar): no sideways overflow, 16px fields on touch. */
async function checkMemoryTab(page: Page, baseUrl: string, touch: boolean): Promise<Check[]> {
  await page.goto(`${baseUrl}/dashboard/settings#memory`);
  await page.waitForTimeout(500);
  return page.evaluate((touchArg) => {
    const out: { ok: boolean; msg: string }[] = [];
    const vw = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    out.push({ ok: sw <= vw + 1, msg: `memory tab has no sideways overflow (${sw} ≤ ${vw})` });
    if (touchArg) {
      // Its editors load per user; probe the tab's own field rules with detached copies.
      const box = document.createElement('div');
      box.innerHTML =
        '<div class="pages-list"><input type="search"></div><div class="pages-detail"><div class="field"><input type="text"></div></div><textarea></textarea><div class="ep-bar"><select><option>x</option></select></div>';
      document.body.appendChild(box);
      const sizes = Array.from(box.querySelectorAll('input, textarea, select')).map((el) =>
        parseFloat(getComputedStyle(el as HTMLElement).fontSize),
      );
      box.remove();
      out.push({ ok: sizes.every((n) => n >= 16), msg: `memory tab fields ${sizes.join(' / ')}px ≥ 16px on touch` });
    }
    return out;
  }, touch);
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
        await preparePage(page, { seedSecondary: true });
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
        record(await checkSecondary(page, touch), 'closed');
        await page.screenshot({ path: path.join(outDir, `${tag}-closed.png`) });
        if (pos.w < 640) record(await checkFab(page), 'closed');
        record(await checkCapacityExpanded(page, 'expanded'), 'closed');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(outDir, `${tag}-capacity.png`) });
        await page.evaluate(() => window.scrollTo(0, 0));
        await openFilledPanel(page);
        // Measure the settled drawer, not its slide-in (headless frames can lag).
        await page.waitForFunction(
          () => (document.getElementById('slide-panel') as HTMLElement).getAnimations().length === 0,
        );
        record(await checkOpen(page, touch), 'open');
        await page.screenshot({ path: path.join(outDir, `${tag}-open.png`) });
        // Docked, the page narrows without a window resize: the timeline repacks.
        if (pos.w >= 840) record(await checkCapacityExpanded(page, 'docked'), 'open');
        await page.evaluate(() => (window as unknown as { closePanel(): void }).closePanel());
        record(await checkCronDrawer(page, touch), 'cron');
        record(await checkSettings(page, baseUrl, touch), 'settings');
        record(await checkMemoryTab(page, baseUrl, touch), 'memory');
        await page.screenshot({ path: path.join(outDir, `${tag}-settings.png`) });
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
  const fresh = async (
    opts: {
      savedView?: string;
      savedWidth?: number;
      reduced?: boolean;
      seedSecondary?: boolean;
      openSections?: string[];
      capacityDelayMs?: number;
    } = {},
  ) => {
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
  // The board-motion checks (1-4d) measure the columns in view: the CRON lane joins at 4e.
  const CRON_KEY = 'C123:170000006.000001';
  const cronRun = sessions.get(CRON_KEY);
  sessions.delete(CRON_KEY);
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
        const col0 = card.getAttribute('data-col');
        // Where the render's FLIP starts: read in the same task as the render (a
        // mutation callback runs before the next frame), so it is the spot the card
        // was drawn at when the render landed — the path's true origin.
        let start: number | null = null;
        const mo = new MutationObserver(() => {
          if (start === null && card.getAttribute('data-col') !== col0) start = card.getBoundingClientRect().left;
        });
        mo.observe(card, { attributes: true, attributeFilter: ['data-col'] });
        // And where it was drawn just before that render ran (trinity R4, astra): the
        // FLIP must start there — a render that itself jumped would move "start".
        let pre: number | null = null;
        const g = window as unknown as { renderBoard: (b: unknown) => unknown };
        const realRender = g.renderBoard;
        g.renderBoard = function (b: unknown) {
          if (pre === null) pre = card.getBoundingClientRect().left;
          return realRender.call(this, b);
        };
        void w.loadSessions();
        const xs: number[] = [];
        const cols: (string | null)[] = [];
        for (let n = 0; n < 60; n++) {
          xs.push(card.getBoundingClientRect().left);
          cols.push(card.getAttribute('data-col'));
          await new Promise((res) => requestAnimationFrame(res));
        }
        mo.disconnect();
        g.renderBoard = realRender;
        return { before, xs, cols, col0, start, pre };
      });
      moving.activityState = was;
      const end = r.xs[r.xs.length - 1];
      // The path starts where the card was drawn when the render landed (its column
      // changed), not before the request: the docking shift keeps moving it meanwhile,
      // and a slow response is not a jump (trinity R2 on #409, astra and fable).
      const k = r.cols.findIndex((c) => c !== r.col0);
      const origin = r.start === null ? r.before : r.start;
      const lo = Math.min(origin, end) - 2;
      const hi = Math.max(origin, end) + 2;
      // Every frame from the landing on — the first one included (trinity R3, astra).
      const out = (k > 0 ? r.xs.slice(k) : r.xs).filter((x) => x < lo || x > hi);
      expect(k > 0 && r.start !== null, `the render lands while sampled (frame ${k}, FLIP from ${r.start})`);
      expect(
        r.pre !== null && r.start !== null && Math.abs(r.start - r.pre) <= 2,
        `the render's FLIP starts where the card was drawn just before it (${r.start} vs ${r.pre})`,
      );
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
    if (cronRun) sessions.set(CRON_KEY, cronRun);
    // 4e. A CRON lane card sits outside the board's sideways scroll: unfolding right after
    //     a board scroll starts it where it was on screen (trinity code review R4, astra/fable).
    {
      const { ctx, page } = await fresh({ savedView: 'board', openSections: ['cron'] });
      await page.setViewportSize({ width: 669, height: 825 });
      await page.waitForFunction(() => window.innerWidth === 669);
      await page.waitForTimeout(600);
      const before = await page.evaluate(async () => {
        const kb = document.getElementById('kanban') as HTMLElement;
        const card = document.querySelector('.cron-lane .card') as HTMLElement | null;
        if (!card) return null;
        const scrolled = new Promise((r) => kb.addEventListener('scroll', r, { once: true }));
        kb.scrollTo({ left: 250, behavior: 'instant' });
        await scrolled;
        // Unfold inside the 120ms before the cache refresh: hold that refresh.
        const w = window as unknown as { _layoutRefreshTimer: number; __cronFlipStart: unknown };
        clearTimeout(w._layoutRefreshTimer);
        w.__cronFlipStart = null;
        const r = card.getBoundingClientRect();
        return { left: r.left, top: r.top, k: kb.scrollLeft };
      });
      expect(
        before !== null && before.k > 0,
        `the CRON lane has a card and the board scrolled sideways (${before ? before.k : 'no card'})`,
      );
      await page.setViewportSize({ width: 951, height: 543 });
      await page.waitForFunction(() => window.innerWidth === 951);
      const seen = await page.evaluate(
        () =>
          new Promise<{ start: { left: number; top: number } | null; now: { left: number; top: number } }>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const card = document.querySelector('.cron-lane .card') as HTMLElement;
                const r = card.getBoundingClientRect();
                const w = window as unknown as { __cronFlipStart: { left: number; top: number } | null };
                resolve({ start: w.__cronFlipStart, now: { left: r.left, top: r.top } });
              }),
            ),
          ),
      );
      if (before) {
        const from = seen.start || seen.now;
        expect(
          Math.abs(from.left - before.left) <= 1 && Math.abs(from.top - before.top) <= 2,
          `the CRON card starts where it was (${seen.start ? 'FLIP from' : 'unmoved at'} ${from.left},${from.top} vs ${before.left},${before.top})`,
        );
      }
      await ctx.close();
    }
    // 4g. The same rule on the cache's write path: a CRON card FLIP that lands right after a
    //     board scroll records its own spot, not one shifted by the board (trinity R5).
    {
      const { ctx, page } = await fresh({ savedView: 'board', openSections: ['cron'] });
      await page.setViewportSize({ width: 669, height: 825 });
      await page.waitForFunction(() => window.innerWidth === 669);
      await page.waitForTimeout(600);
      const before = await page.evaluate(async () => {
        const kb = document.getElementById('kanban') as HTMLElement;
        const card = document.querySelector('.cron-lane .card') as HTMLElement | null;
        if (!card) return null;
        const scrolled = new Promise((r) => kb.addEventListener('scroll', r, { once: true }));
        kb.scrollTo({ left: 250, behavior: 'instant' });
        await scrolled;
        const w = window as unknown as {
          _layoutRefreshTimer: number;
          __cronFlipStart: unknown;
          playFlip(el: HTMLElement, dx: number, dy: number, raise: boolean): void;
        };
        clearTimeout(w._layoutRefreshTimer);
        // A live render lands the CRON card (a vertical nudge, as a reflow would).
        w.playFlip(card, 0, 12, false);
        w.__cronFlipStart = null;
        return { left: card.getBoundingClientRect().left, k: kb.scrollLeft };
      });
      expect(before !== null && before.k > 0, `CRON card FLIP after a board scroll (${before ? before.k : 'no card'})`);
      await page.setViewportSize({ width: 951, height: 543 });
      await page.waitForFunction(() => window.innerWidth === 951);
      const seen = await page.evaluate(
        () =>
          new Promise<{ start: { left: number } | null; now: number }>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const card = document.querySelector('.cron-lane .card') as HTMLElement;
                const w = window as unknown as { __cronFlipStart: { left: number } | null };
                resolve({ start: w.__cronFlipStart, now: card.getBoundingClientRect().left });
              }),
            ),
          ),
      );
      if (before) {
        const from = seen.start ? seen.start.left : seen.now;
        expect(
          Math.abs(from - before.left) <= 1,
          `a landed CRON card unfolds from its own spot (${seen.start ? 'FLIP from' : 'at'} ${from} vs ${before.left})`,
        );
      }
      await ctx.close();
    }
    // 4f. Escape over a docked panel with the cron drawer open closes the drawer only.
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => failures.push(`transition escape: page error ${e.message}`));
      await preparePage(page, { openSections: ['cron'] });
      await openDashboard(page, baseUrl);
      await openFilledPanel(page);
      await page.click('.cron-history-btn');
      await page.waitForTimeout(400);
      const opened = await page.evaluate(() =>
        (document.getElementById('cron-drawer') as HTMLElement).classList.contains('open'),
      );
      expect(opened, 'the CRON history button opens the cron drawer beside the docked panel');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      const st = await page.evaluate(() => ({
        drawer: (document.getElementById('cron-drawer') as HTMLElement).classList.contains('open'),
        panel: (document.getElementById('slide-panel') as HTMLElement).classList.contains('open'),
      }));
      expect(!st.drawer && st.panel, `Escape closes the cron drawer only (drawer ${st.drawer}, panel ${st.panel})`);
      await ctx.close();
    }
    // 4h. The capacity view loads after the board and pushes it down: the shift cache must
    //     learn that, or the next unfold starts the cards from where they were before.
    {
      const { ctx, page } = await fresh({ seedSecondary: true, capacityDelayMs: 1500 });
      await page.waitForFunction(() => !(document.getElementById('capacity') as HTMLElement).hidden, undefined, {
        timeout: 10000,
      });
      await page.waitForTimeout(300);
      const before = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#kanban .card')) as HTMLElement[];
        const card = cards.find((c) => {
          const r = c.getBoundingClientRect();
          return r.top >= 0 && r.top <= window.innerHeight - 40;
        });
        if (!card) return null;
        (window as unknown as { __flipStarts: Record<string, unknown> }).__flipStarts = {};
        const r = card.getBoundingClientRect();
        return { key: card.getAttribute('data-session-key') as string, left: r.left, top: r.top };
      });
      expect(before !== null, 'a board card is on the first screen after the capacity view loads (folded)');
      if (before) {
        await page.setViewportSize({ width: 951, height: 543 });
        await page.waitForFunction(() => window.innerWidth === 951);
        const start = await page.evaluate(
          (key) =>
            new Promise<{ left: number; top: number } | null>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const w = window as unknown as { __flipStarts: Record<string, { left: number; top: number }> };
                  resolve(w.__flipStarts[key] || null);
                }),
              ),
            ),
          before.key,
        );
        expect(
          start !== null && Math.abs(start.left - before.left) <= 2 && Math.abs(start.top - before.top) <= 2,
          `after the capacity load, the unfold starts the card where it was (${start ? `${Math.round(start.left)},${Math.round(start.top)}` : 'no FLIP'} vs ${Math.round(before.left)},${Math.round(before.top)})`,
        );
      }
      await ctx.close();
    }
    // 4i. The reader's toggle: the board below moves by the coordinator's FLIP (no jump),
    //     the toggle keeps keyboard focus across a repaint, and the choice survives a reload.
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => failures.push(`transition toggle: page error ${e.message}`));
      await preparePage(page, { seedSecondary: true });
      await openDashboard(page, baseUrl);
      await page.waitForFunction(() => !(document.getElementById('capacity') as HTMLElement).hidden);
      await page.waitForTimeout(900);
      const hasToggle = (await page.$('#capacity-toggle')) !== null;
      expect(hasToggle, 'capacity has a disclosure toggle');
      if (hasToggle) {
        const before = await page.evaluate(() => {
          const card = document.querySelector('#kanban .card') as HTMLElement;
          const w = window as unknown as { __flipStarts: Record<string, unknown>; __shiftAnims: number };
          w.__flipStarts = {};
          w.__shiftAnims = 0;
          const r = card.getBoundingClientRect();
          return {
            key: card.getAttribute('data-session-key') as string,
            left: r.left,
            top: r.top,
            expanded: (document.getElementById('capacity-toggle') as HTMLElement).getAttribute('aria-expanded'),
          };
        });
        expect(before.expanded === 'false', `1440×900 starts collapsed (${before.expanded})`);
        await page.focus('#capacity-toggle');
        await page.keyboard.press('Enter');
        const seen = await page.evaluate(
          (key) =>
            new Promise<{ start: { left: number; top: number } | null; anims: number; now: number }>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const w = window as unknown as {
                    __flipStarts: Record<string, { left: number; top: number }>;
                    __shiftAnims: number;
                  };
                  const card = document.querySelector(`[data-session-key="${key}"]`) as HTMLElement;
                  resolve({
                    start: w.__flipStarts[key] || null,
                    anims: w.__shiftAnims,
                    now: card.getBoundingClientRect().top,
                  });
                }),
              ),
            ),
          before.key,
        );
        expect(
          seen.anims > 0 && seen.start !== null && Math.abs(seen.start.top - before.top) <= 2,
          `expanding capacity slides the board from where it was (${seen.anims} FLIPs, from ${seen.start ? Math.round(seen.start.top) : '—'} vs ${Math.round(before.top)})`,
        );
        await page.waitForTimeout(500);
        const kept = await page.evaluate(() => {
          const w = window as unknown as { paintCapacity(): void };
          (document.getElementById('capacity-view') as HTMLElement & { _html: unknown })._html = null;
          w.paintCapacity();
          const t = document.getElementById('capacity-toggle') as HTMLElement;
          return { focus: document.activeElement === t, expanded: t.getAttribute('aria-expanded') };
        });
        expect(
          kept.focus && kept.expanded === 'true',
          `the toggle keeps focus and state across a repaint (${JSON.stringify(kept)})`,
        );
        await page.reload();
        await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length > 0);
        await page.waitForTimeout(900);
        const after = await page.evaluate(() =>
          (document.getElementById('capacity-toggle') as HTMLElement).getAttribute('aria-expanded'),
        );
        expect(after === 'true', `the reader's choice survives a reload (${after})`);
      }
      await ctx.close();
    }
    // 4j. A folded CRON lane still shows a job whose run waits for a reply.
    {
      const run = sessions.get(CRON_KEY) as Record<string, unknown>;
      run.activityState = 'waiting';
      const { ctx, page } = await fresh({ seedSecondary: true });
      await page.waitForTimeout(600);
      const st = await page.evaluate(() => {
        const lane = document.getElementById('cron-lane') as HTMLElement;
        const card = lane.querySelector('.card') as HTMLElement | null;
        return {
          folded: lane.classList.contains('is-collapsed'),
          card: !!card && card.getBoundingClientRect().height > 0,
        };
      });
      expect(st.folded && st.card, `a folded CRON lane keeps the waiting job's card (${JSON.stringify(st)})`);
      run.activityState = 'idle';
      await ctx.close();
    }
    // 4k. llmux unreachable: the collapsed capacity says so in its chip.
    {
      const ctx = await browser.newContext({ viewport: { width: 382, height: 580 }, hasTouch: true, isMobile: true });
      const page = await ctx.newPage();
      await preparePage(page, { seedSecondary: true });
      await page.route('**/api/dashboard/capacity', (r) =>
        r.fulfill({
          json: { capacity: { available: false, reason: 'llmux unreachable', fetchedAtMs: Date.now(), groups: [] } },
        }),
      );
      await openDashboard(page, baseUrl);
      await page.waitForFunction(() => !(document.getElementById('capacity') as HTMLElement).hidden);
      const chip = await page.evaluate(() => {
        const c = document.querySelector('#capacity .cap-chip') as HTMLElement | null;
        return c ? c.innerText : '';
      });
      expect(
        chip.indexOf('가용량 미확인') >= 0,
        `an unreachable llmux shows in the collapsed chip (${chip || 'no chip'})`,
      );
      await ctx.close();
    }
    // 4l. Expanding the CRON lane moves the board from where it was (one FLIP from the
    //     coordinator, not a render FLIP from a half-revealed lane — trinity R1, astra).
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => failures.push(`transition cron toggle: page error ${e.message}`));
      await preparePage(page, { seedSecondary: true });
      await openDashboard(page, baseUrl);
      await page.waitForFunction(() => !(document.getElementById('capacity') as HTMLElement).hidden);
      await page.waitForTimeout(900);
      const before = await page.evaluate(() => {
        const card = document.querySelector('#kanban .card') as HTMLElement;
        const w = window as unknown as { __flipStarts: Record<string, unknown> };
        w.__flipStarts = {};
        const r = card.getBoundingClientRect();
        return { key: card.getAttribute('data-session-key') as string, top: r.top };
      });
      await page.click('#cron-toggle');
      const seen = await page.evaluate(
        (key) =>
          new Promise<{ start: { top: number } | null; lane: boolean }>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const w = window as unknown as { __flipStarts: Record<string, { top: number }> };
                resolve({ start: w.__flipStarts[key] || null, lane: !!document.querySelector('.cron-lane .card') });
              }),
            ),
          ),
        before.key,
      );
      expect(
        seen.lane && seen.start !== null && Math.abs(seen.start.top - before.top) <= 2,
        `expanding the CRON lane slides the board from where it was (from ${seen.start ? Math.round(seen.start.top) : '—'} vs ${Math.round(before.top)}, lane card ${seen.lane})`,
      );
      await ctx.close();
    }
    // 4m. Storage refuses the write (private mode, a full quota): the toggle still works here.
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await preparePage(page, { seedSecondary: true });
      await page.addInitScript({
        content: "Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };",
      });
      await openDashboard(page, baseUrl);
      await page.waitForFunction(() => !(document.getElementById('capacity') as HTMLElement).hidden);
      await page.click('#capacity-toggle');
      await page.waitForTimeout(200);
      const expanded = await page.evaluate(() =>
        (document.getElementById('capacity-toggle') as HTMLElement).getAttribute('aria-expanded'),
      );
      expect(expanded === 'true', `the toggle works when storage refuses the write (${expanded})`);
      await ctx.close();
    }
    // 4n. A deep link to a CRON run in a folded lane opens the lane (this load only) and its panel.
    {
      const ctx = await browser.newContext({ viewport: { width: 382, height: 580 }, hasTouch: true, isMobile: true });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => failures.push(`transition deep link: page error ${e.message}`));
      await preparePage(page, { seedSecondary: true });
      await page.goto(`${baseUrl}/dashboard?session=${encodeURIComponent(CRON_KEY)}`);
      await page.waitForFunction(() => document.querySelectorAll('#kanban .card').length > 0, undefined, {
        timeout: 15000,
      });
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => ({
        lane: (document.getElementById('cron-toggle') as HTMLElement).getAttribute('aria-expanded'),
        card: !!document.querySelector('.cron-lane .card'),
        panel: (document.getElementById('slide-panel') as HTMLElement).classList.contains('open'),
        saved: localStorage.getItem('soma-sec-cron'),
      }));
      expect(
        st.lane === 'true' && st.card && st.panel && st.saved === null,
        `a deep link opens the folded lane for this load and the run's panel (${JSON.stringify(st)})`,
      );
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
    // SWEEP_ONLY=transitions reruns just the motion checks (a flake hunt, a quick loop).
    if (process.env.SWEEP_ONLY !== 'transitions') {
      await sweepBrowser('chromium', chromium, baseUrl, outDir, failures);
      await sweepBrowser('webkit', webkit, baseUrl, outDir, failures);
    }
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
