/**
 * Screenshot the dashboard HTML using Playwright for visual UI testing.
 *
 * Two responsibilities:
 *
 * 1. **Visual screenshots** — full / viewport / mobile / tablet renders
 *    using a realistic mock kanban state, served from a real HTTP server
 *    so client-side fetch() works. Output: screenshots/dashboard-*.png.
 *
 * 2. **Mobile topbar overflow assertion (#800)** — for every combination of
 *    {chromium, webkit} × {fine, coarse pointer} ×
 *    {360, 375, 390, 414, 480, 680} × {connecting, live, admin, long-korean}
 *    (= 96 cases), assert that
 *    `documentElement.scrollWidth - window.innerWidth <= 0`. Any positive
 *    overflow throws and exits non-zero. Per-case screenshots are written to
 *    `screenshots/topbar/<browser>-<pointer>-<vw>-<state>.png`. The coarse
 *    branch matters because real phones match `@media (pointer: coarse)`,
 *    which dashboard.ts uses to enlarge tap targets — a regression that
 *    only blows up on touch devices is silent under desktop emulation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser, type BrowserType, chromium, type Page, webkit } from 'playwright';

type WsState = 'connecting' | 'live' | 'admin' | 'long-korean';
type Pointer = 'fine' | 'coarse';

const MOBILE_VIEWPORTS = [360, 375, 390, 414, 480, 680] as const;
const STATES: WsState[] = ['connecting', 'live', 'admin', 'long-korean'];
// Real phones match `(pointer: coarse)` which adds bigger nav-item
// padding via dashboard.ts `@media (pointer: coarse)`. We exercise both
// the desktop (fine) and touch (coarse) cascades so a regression that
// only blows up on real touch devices is not silently passed.
const POINTERS: Pointer[] = ['fine', 'coarse'];
// 30+ character Korean username (kept above the 30-char threshold called
// out in the issue acceptance criteria).
const LONG_KOREAN_NAME = '가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라'; // 32 chars

async function setupMockSessions() {
  const { setDashboardSessionAccessor } = await import('../src/conversation/dashboard');
  const mockSessions = new Map();

  // Working session
  mockSessions.set('C123:1234567890.123456', {
    ownerId: 'U001',
    ownerName: 'Zhuge',
    channelId: 'C123',
    threadTs: '1234567890.123456',
    sessionId: 'sess-1',
    title: 'Dashboard Slack UX Integration',
    model: 'claude-opus-4-6',
    state: 'MAIN',
    workflow: 'zwork',
    activityState: 'working',
    lastActivity: new Date(Date.now() - 5 * 60000),
    conversationId: 'conv-1',
    links: {
      issue: { url: 'https://github.com/2lab-ai/soma-work/issues/330', label: '#330', title: 'Dashboard Slack UX' },
      pr: {
        url: 'https://github.com/2lab-ai/soma-work/pull/331',
        label: '#331',
        title: 'feat: seamless Slack UX',
        status: 'open',
      },
    },
    usage: {
      totalInputTokens: 1250000,
      totalOutputTokens: 380000,
      totalCostUsd: 12.45,
      contextWindow: 200000,
      currentInputTokens: 85000,
    },
    mergeStats: { totalLinesAdded: 254, totalLinesDeleted: 33 },
  });

  // Waiting session
  mockSessions.set('C123:1234567891.654321', {
    ownerId: 'U001',
    ownerName: 'Zhuge',
    channelId: 'C123',
    threadTs: '1234567891.654321',
    sessionId: 'sess-2',
    title: 'Fix OAuth Token Refresh',
    model: 'claude-sonnet-4-20250514',
    state: 'MAIN',
    workflow: 'stv',
    activityState: 'waiting',
    lastActivity: new Date(Date.now() - 20 * 60000),
    conversationId: 'conv-2',
    links: {
      issue: { url: 'https://github.com/2lab-ai/soma-work/issues/325', label: '#325', title: 'OAuth refresh bug' },
    },
    usage: {
      totalInputTokens: 520000,
      totalOutputTokens: 120000,
      totalCostUsd: 3.8,
      contextWindow: 200000,
      currentInputTokens: 45000,
    },
  });

  // Idle session
  mockSessions.set('C456:1234567892.111111', {
    ownerId: 'U002',
    ownerName: 'Alice',
    channelId: 'C456',
    threadTs: '1234567892.111111',
    sessionId: 'sess-3',
    title: 'Add Redis Query Support',
    model: 'claude-opus-4-6',
    state: 'MAIN',
    workflow: 'default',
    activityState: 'idle',
    lastActivity: new Date(Date.now() - 2 * 3600000),
    conversationId: 'conv-3',
    links: {},
    usage: {
      totalInputTokens: 200000,
      totalOutputTokens: 50000,
      totalCostUsd: 1.2,
      contextWindow: 200000,
      currentInputTokens: 20000,
    },
  });

  // Closed session
  mockSessions.set('C123:1234567893.222222', {
    ownerId: 'U001',
    ownerName: 'Zhuge',
    channelId: 'C123',
    threadTs: '1234567893.222222',
    sessionId: 'sess-4',
    title: 'Cron Scheduler Fix',
    model: 'claude-sonnet-4-20250514',
    state: 'SLEEPING',
    workflow: 'stv',
    activityState: 'idle',
    terminated: true,
    lastActivity: new Date(Date.now() - 6 * 3600000),
    conversationId: 'conv-4',
    links: {
      pr: {
        url: 'https://github.com/2lab-ai/soma-work/pull/325',
        label: '#325',
        title: 'fix: cron dedup',
        status: 'merged',
      },
    },
    mergeStats: { totalLinesAdded: 89, totalLinesDeleted: 12 },
    usage: {
      totalInputTokens: 850000,
      totalOutputTokens: 200000,
      totalCostUsd: 6.5,
      contextWindow: 200000,
      currentInputTokens: 0,
    },
  });

  // Another working session (different user)
  mockSessions.set('C789:1234567894.333333', {
    ownerId: 'U003',
    ownerName: 'Bob',
    channelId: 'C789',
    threadTs: '1234567894.333333',
    sessionId: 'sess-5',
    title: 'Implement MCP Tool Permissions',
    model: 'claude-opus-4-6',
    state: 'MAIN',
    workflow: 'zwork',
    activityState: 'working',
    lastActivity: new Date(Date.now() - 2 * 60000),
    conversationId: 'conv-5',
    links: {
      issue: { url: 'https://github.com/2lab-ai/soma-work/issues/320', label: '#320', title: 'MCP permissions' },
    },
    usage: {
      totalInputTokens: 3200000,
      totalOutputTokens: 800000,
      totalCostUsd: 28.9,
      contextWindow: 200000,
      currentInputTokens: 150000,
    },
  });

  setDashboardSessionAccessor(() => mockSessions);
}

/**
 * Install a stub WebSocket that never fires events so the dashboard's
 * connectWs() leaves ws-status in its initial 'Connecting...' state. We
 * drive each WS state explicitly via page.evaluate below so the assertion
 * is deterministic and not race-prone.
 *
 * Only the surface dashboard.ts actually touches is stubbed — onopen /
 * onclose / onerror / onmessage properties. The constructor and `close()`
 * are kept because connectWs constructs a new WebSocket and calls close()
 * on error. Everything else (readyState constants, addEventListener) is
 * unused by production code and intentionally omitted.
 */
async function installWsStub(page: Page) {
  await page.addInitScript(() => {
    class StubWebSocket {
      onopen: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      url: string;
      constructor(url: string) {
        this.url = url;
      }
      close() {}
    }
    // Override before the dashboard inline script runs.
    (window as unknown as { WebSocket: typeof StubWebSocket }).WebSocket = StubWebSocket;
  });
}

/**
 * Apply one of the four topbar states deterministically. Mirrors the
 * production code paths (ws.onopen body / _applyUserPill / admin-mode
 * localStorage) so the visual + measured layout matches what a real
 * user would see.
 *
 * The page-side helpers (`__setLive`, `__getDashWindow`) are installed
 * once per page in the init script so each branch below stays small and
 * the "what does Live look like" definition lives in one place.
 */
async function applyState(page: Page, state: WsState, longName: string) {
  // Reset between states to avoid bleed.
  await page.evaluate(() => {
    try {
      localStorage.removeItem('soma_admin_mode');
    } catch (_e) {}
  });

  if (state === 'connecting') {
    // Nothing to do — initial markup already says 'Connecting...'.
    return;
  }

  if (state === 'live') {
    await page.evaluate(() => {
      window.__setLive();
      window.__getDashWindow()._applyUserPill?.({ user: { name: 'Zhuge' } });
    });
    return;
  }

  if (state === 'admin') {
    await page.evaluate(() => {
      window.__setLive();
      const w = window.__getDashWindow();
      w._applyUserPill?.({ user: { name: 'Zhuge' }, isAdmin: true });
      try {
        localStorage.setItem('soma_admin_mode', 'on');
      } catch (_e) {}
      w._renderAdminModeButton?.();
    });
    return;
  }

  if (state === 'long-korean') {
    await page.evaluate((name) => {
      window.__setLive();
      window.__getDashWindow()._applyUserPill?.({ user: { name } });
    }, longName);
    return;
  }
}

/**
 * Install per-page helpers used by `applyState`. Done once at page boot
 * (not per state) so each `applyState` branch is a 2-line call instead
 * of a copy-paste of the 6-property "set ws-status to Live" mutation.
 */
async function installApplyStateHelpers(page: Page) {
  await page.addInitScript(() => {
    type DashboardWindow = Window & {
      _applyUserPill?: (data: unknown) => void;
      _renderAdminModeButton?: () => void;
    };
    (window as unknown as { __getDashWindow: () => DashboardWindow }).__getDashWindow = () =>
      window as unknown as DashboardWindow;

    (window as unknown as { __setLive: () => void }).__setLive = () => {
      const el = document.getElementById('ws-status');
      if (!el) return;
      el.textContent = 'Live';
      el.title = 'WebSocket: Live';
      el.setAttribute('aria-label', 'WebSocket: Live');
      el.style.background = 'rgba(62,207,142,0.2)';
      el.style.borderColor = 'var(--green)';
      el.style.color = 'var(--green)';
    };
  });
}

/**
 * Run all viewport/state assertions for a single browser. Pulled out of
 * the outer loop so we can run chromium and webkit in parallel.
 */
async function runBrowserAssertions(
  name: 'chromium' | 'webkit',
  type: BrowserType,
  baseUrl: string,
  overflowDir: string,
): Promise<{ failures: string[]; total: number }> {
  const failures: string[] = [];
  let total = 0;

  let browser: Browser;
  try {
    browser = await type.launch({ headless: true });
  } catch (err) {
    console.warn(`[topbar] ${name} unavailable, skipping: ${(err as Error).message}`);
    return { failures, total };
  }
  try {
    for (const pointer of POINTERS) {
      for (const vw of MOBILE_VIEWPORTS) {
        // hasTouch + isMobile triggers `(pointer: coarse)` media-query
        // matching in both chromium and webkit, exercising the
        // dashboard.ts `@media (pointer: coarse)` cascade that real
        // phones hit. Without this, the desktop (fine-pointer) branch
        // is the only one tested.
        const ctx = await browser.newContext({
          viewport: { width: vw, height: 800 },
          hasTouch: pointer === 'coarse',
          isMobile: pointer === 'coarse' && name === 'chromium',
        });
        const page = await ctx.newPage();
        try {
          await installWsStub(page);
          await installApplyStateHelpers(page);
          await page.goto(`${baseUrl}/dashboard`);
          // Wait for the inline script to finish wiring up globals
          // (_applyUserPill / _renderAdminModeButton). If it never
          // appears, the per-state mutations become silent no-ops and
          // assertions would pass spuriously — throw and fail the run
          // instead of swallowing.
          await page.waitForFunction(
            () => typeof (window as unknown as { _applyUserPill?: unknown })._applyUserPill === 'function',
            { timeout: 10000 },
          );

          for (const state of STATES) {
            total++;
            await applyState(page, state, LONG_KOREAN_NAME);
            // Let layout settle.
            await page.waitForTimeout(120);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            const tag = `${name}-${pointer}-${vw}-${state}`;
            // Topbar is the focus — full page would be wasteful; use the
            // viewport-cropped capture so reviewers see exactly the
            // "above the fold" layout the assertion measured.
            await page.screenshot({ path: path.join(overflowDir, `${tag}.png`) });
            if (overflow > 0) {
              const msg = `[overflow] ${tag}: scrollWidth-innerWidth=${overflow}px (>0)`;
              console.error(msg);
              failures.push(msg);
            } else {
              console.log(`[ok] ${tag}: overflow=${overflow}px`);
            }
          }
        } finally {
          await page.close();
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  return { failures, total };
}

async function runOverflowAssertions(
  baseUrl: string,
  outputDir: string,
): Promise<{ failures: string[]; total: number }> {
  const overflowDir = path.join(outputDir, 'topbar');
  if (!fs.existsSync(overflowDir)) fs.mkdirSync(overflowDir, { recursive: true });

  const browsers: { name: 'chromium' | 'webkit'; type: BrowserType }[] = [
    { name: 'chromium', type: chromium },
    { name: 'webkit', type: webkit },
  ];

  // Browsers are independent processes — run them concurrently so the
  // 48-case wall-clock is dominated by the slower of the two, not their
  // sum. (Per-viewport inside each browser stays sequential because
  // launching 6 contexts at once on a single machine adds noise without
  // saving meaningful time.)
  const results = await Promise.all(
    browsers.map(({ name, type }) => runBrowserAssertions(name, type, baseUrl, overflowDir)),
  );

  return {
    failures: results.flatMap((r) => r.failures),
    total: results.reduce((sum, r) => sum + r.total, 0),
  };
}

async function captureLegacyScreenshots(baseUrl: string, outputDir: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // Navigate to real HTTP endpoint so client-side fetch() works
    await page.goto(`${baseUrl}/dashboard`);
    // Wait for sessions to load via API
    await page
      .waitForFunction(
        () => {
          const cards = document.querySelectorAll('.card');
          return cards.length > 0;
        },
        { timeout: 10000 },
      )
      .catch(() => {
        console.warn('Warning: No cards rendered after 10s — taking screenshot anyway');
      });
    await page.waitForTimeout(500); // Let CSS animations settle

    // Full page screenshot
    await page.screenshot({ path: path.join(outputDir, 'dashboard-full.png'), fullPage: true });
    console.log('Screenshot: dashboard-full.png');

    // Viewport screenshot (what user sees first)
    await page.screenshot({ path: path.join(outputDir, 'dashboard-viewport.png') });
    console.log('Screenshot: dashboard-viewport.png');

    // Mobile viewport
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outputDir, 'dashboard-mobile.png'), fullPage: true });
    console.log('Screenshot: dashboard-mobile.png');

    // Tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outputDir, 'dashboard-tablet.png'), fullPage: true });
    console.log('Screenshot: dashboard-tablet.png');
  } finally {
    await browser.close();
  }
}

async function main() {
  const outputDir = path.join(__dirname, '..', 'screenshots');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  await setupMockSessions();

  const { startWebServer, stopWebServer, getViewerBaseUrl } = await import('../src/conversation/web-server');

  // Start real HTTP server (auth disabled when no CONVERSATION_VIEWER_TOKEN is set)
  await startWebServer({ listen: true });
  const baseUrl = getViewerBaseUrl();
  console.log(`Server started at ${baseUrl}`);

  let failures: string[] = [];
  let total = 0;

  try {
    await captureLegacyScreenshots(baseUrl, outputDir);

    const result = await runOverflowAssertions(baseUrl, outputDir);
    failures = result.failures;
    total = result.total;
  } finally {
    await stopWebServer();
  }

  console.log(`\nAll screenshots saved to: ${outputDir}`);
  console.log(`Topbar overflow assertions: ${total - failures.length}/${total} passed`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} overflow failure(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
