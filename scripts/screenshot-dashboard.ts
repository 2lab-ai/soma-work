/**
 * Screenshot the dashboard HTML using Playwright for visual UI testing.
 * Generates mock data to simulate realistic kanban board state.
 * Starts a real HTTP server so client-side fetch() calls work properly.
 */
import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

async function main() {
  const outputDir = path.join(__dirname, '..', 'screenshots');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const { startWebServer, stopWebServer, getViewerBaseUrl } = await import('../src/conversation/web-server');
  const { setDashboardSessionAccessor } = await import('../src/conversation/dashboard');

  // Create mock sessions for realistic rendering
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
      pr: { url: 'https://github.com/2lab-ai/soma-work/pull/331', label: '#331', title: 'feat: seamless Slack UX', status: 'open' },
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
      totalCostUsd: 3.80,
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
      totalCostUsd: 1.20,
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
      pr: { url: 'https://github.com/2lab-ai/soma-work/pull/325', label: '#325', title: 'fix: cron dedup', status: 'merged' },
    },
    mergeStats: { totalLinesAdded: 89, totalLinesDeleted: 12 },
    usage: {
      totalInputTokens: 850000,
      totalOutputTokens: 200000,
      totalCostUsd: 6.50,
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
      totalCostUsd: 28.90,
      contextWindow: 200000,
      currentInputTokens: 150000,
    },
  });

  setDashboardSessionAccessor(() => mockSessions);

  // Start real HTTP server (auth disabled when no CONVERSATION_VIEWER_TOKEN is set)
  await startWebServer({ listen: true });
  const baseUrl = getViewerBaseUrl();
  console.log(`Server started at ${baseUrl}`);

  // Take screenshots
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Navigate to real HTTP endpoint so client-side fetch() works
  await page.goto(`${baseUrl}/dashboard`);
  // Wait for sessions to load via API
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll('.card');
    return cards.length > 0;
  }, { timeout: 10000 }).catch(() => {
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

  await browser.close();
  await stopWebServer();

  console.log(`\nAll screenshots saved to: ${outputDir}`);
}

main().catch(console.error);
