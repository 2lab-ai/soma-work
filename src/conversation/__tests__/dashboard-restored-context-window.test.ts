/**
 * RED — a session restored from sessions.json still shows its context on the
 * dashboard card. `session.usage` was runtime-only, so after every restart
 * (each dev deploy restarts the service) the card's context window
 * (<ui-context-window>, PR #547) and its "ctx N%" stayed empty until the
 * session's next turn ended. Drives the REAL save → load → card path.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
// `vi.mock` is hoisted — keep the path computation inside the factory.
vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  DATA_DIR: require('path').join(
    process.env.TMPDIR ?? require('os').tmpdir(),
    'soma-work-dashboard-restored-context-window-test',
  ),
}));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [], exists: () => false, archive: () => {} }),
}));

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-dashboard-restored-context-window-test');
const AUTH_HEADER = { Authorization: 'Bearer test-token' };

type Card = {
  title?: string;
  contextTokens?: number;
  tokenUsage?: { contextUsagePercent: number };
  contextParts?: { window: number; cacheRead: number; cacheWrite: number; input: number; output: number };
};

describe('dashboard — a restored session keeps its context window on the card', () => {
  let stopWebServer: () => Promise<void>;
  let injectWebServer: (opts: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>;
  let setDashboardSessionAccessor: (fn: () => Map<string, unknown>) => void;
  let SessionRegistry: typeof import('../../session-registry').SessionRegistry;

  beforeAll(async () => {
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer as typeof injectWebServer;
    const dashboard = await import('../dashboard');
    setDashboardSessionAccessor = dashboard.setDashboardSessionAccessor as typeof setDashboardSessionAccessor;
    SessionRegistry = (await import('../../session-registry')).SessionRegistry;
    await webServer.startWebServer({ listen: false });
    // The first cold import of the web server transforms the whole dashboard (slow on a busy machine).
  }, 240_000);

  afterAll(async () => {
    await stopWebServer?.();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  it('save → restart (fresh registry + load) → the card still has the window, the fill and the %', async () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Alice', 'C1', '171.401', 'claude-opus-5-5[1m]');
    session.sessionId = 'sdk-A';
    session.title = 'Restored';
    session.usage = {
      currentInputTokens: 32_960,
      currentOutputTokens: 8_240,
      currentCacheReadTokens: 354_320,
      currentCacheCreateTokens: 16_480,
      contextWindow: 1_000_000,
      totalInputTokens: 900_000,
      totalOutputTokens: 40_000,
      totalCacheReadTokens: 3_000_000,
      totalCacheCreateTokens: 90_000,
      totalCostUsd: 4.2,
      lastUpdated: Date.now(),
    };
    writer.saveSessions();

    const reader = new SessionRegistry();
    expect(reader.loadSessions()).toBe(1);
    setDashboardSessionAccessor(() => reader.getAllSessions());
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const board = JSON.parse(res.body).board;
    const cards: Card[] = [...board.working, ...board.waiting, ...board.idle, ...board.closed];
    const card = cards.find((c) => c.title === 'Restored');

    expect(card).toBeDefined();
    expect(card?.contextParts?.window).toBe(1_000_000);
    expect(card?.contextTokens).toBeGreaterThan(0);
    expect(card?.contextTokens).toBe(412_000);
    expect(card?.tokenUsage?.contextUsagePercent).toBeCloseTo(41.2, 5);
  });
});
