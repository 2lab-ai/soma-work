/**
 * re-context-window D1–D4 (.prd/affectui/re-context-window.md §4.1) — the card
 * payload carries what fills the context now, by the SDK's cache categories,
 * the scheduled auto-compact, and the last compaction's SDK counts. Server
 * side of the panel's context block; the client is pinned in
 * dashboard-affectui-context-window-client.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
const mockListRecent = vi.fn().mockReturnValue([]);
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: mockListRecent }),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

/** The card fields this suite reads. */
type Card = {
  title?: string;
  contextTokens?: number;
  tokenUsage: { contextUsagePercent: number };
  contextParts: {
    window: number;
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    unsplit?: string;
  };
  compactPending?: boolean;
  lastCompact?: { preTokens: number; postTokens: number; trigger?: string };
};

/** A live session whose last request read 412,000 tokens of a 1M window. */
function live(over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    title: 'Context',
    ownerId: 'U1',
    ownerName: 'Alice',
    channelId: 'C1',
    threadTs: 't1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'idle',
    lastActivity: new Date(),
    usage: {
      totalInputTokens: 900_000,
      totalOutputTokens: 40_000,
      totalCacheReadTokens: 3_000_000,
      totalCacheCreateTokens: 90_000,
      totalCostUsd: 4.2,
      currentInputTokens: 32_960,
      currentCacheReadTokens: 354_320,
      currentCacheCreateTokens: 16_480,
      currentOutputTokens: 8_240,
      contextWindow: 1_000_000,
      ...usage,
    },
    ...over,
  };
}

describe('re-context-window — the card payload says what fills the context (D1–D4)', () => {
  let stopWebServer: () => Promise<void>;
  let injectWebServer: (opts: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>;
  let setDashboardSessionAccessor: (fn: () => Map<string, unknown>) => void;

  beforeEach(async () => {
    vi.resetModules();
    mockListRecent.mockReturnValue([]);
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer as typeof injectWebServer;
    const dashboard = await import('../dashboard');
    setDashboardSessionAccessor = dashboard.setDashboardSessionAccessor as typeof setDashboardSessionAccessor;
    await webServer.startWebServer({ listen: false });
    // The first cold import of the web server transforms the whole dashboard (slow on a busy machine).
  }, 60_000);

  afterEach(async () => {
    await stopWebServer();
  });

  async function cards(sessions: Map<string, unknown>): Promise<Card[]> {
    setDashboardSessionAccessor(() => sessions);
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const board = JSON.parse(res.body).board;
    return [...board.working, ...board.waiting, ...board.idle, ...board.closed];
  }
  const one = async (s: Record<string, unknown>) => (await cards(new Map([['C1:t1', s]])))[0];

  it('D1 — the four current-request counters and the window, the same source as contextTokens and the %', async () => {
    const card = await one(live());
    expect(card.contextParts).toEqual({
      window: 1_000_000,
      cacheRead: 354_320,
      cacheWrite: 16_480,
      input: 32_960,
      output: 8_240,
    });
    const p = card.contextParts;
    expect(p.cacheRead + p.cacheWrite + p.input + p.output).toBe(card.contextTokens);
    expect(card.tokenUsage.contextUsagePercent).toBeCloseTo(41.2, 5);
  });

  it('D1 — no window, no usage or an archived session: no parts (nothing is guessed)', async () => {
    expect((await one(live({}, { contextWindow: 0 }))).contextParts).toBeUndefined();
    expect((await one(live({ usage: undefined }))).contextParts).toBeUndefined();
    mockListRecent.mockReturnValue([
      {
        archivedAt: Date.now(),
        archiveReason: 'terminated',
        sessionKey: 'C9:t9',
        sessionId: 'sid-archived',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: 'C9',
        threadTs: 't9',
        title: 'Archived',
        model: 'claude-opus-5-5[1m]',
        lastActivity: new Date().toISOString(),
        usage: {
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalCostUsd: 0.1,
          currentInputTokens: 9,
          contextWindow: 200_000,
        },
      },
    ]);
    const archived = (await cards(new Map())).find((c) => c.title === 'Archived');
    expect(archived).toBeDefined();
    expect(archived?.contextParts).toBeUndefined();
  });

  it('D2 — a compaction’s post_tokens held in the input counter is one unsplit total, said as such', async () => {
    const zeroed = {
      currentInputTokens: 64_000,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
      currentOutputTokens: 0,
    };
    expect((await one(live({ compactPostTokens: 64_000 }, zeroed))).contextParts).toEqual({
      window: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      input: 64_000,
      output: 0,
      unsplit: 'compact',
    });
    expect((await one(live({ compactPostTokens: null }, zeroed))).contextParts.unsplit).toBe('unknown');
    expect((await one(live({ compactPostTokens: 50_000 }, zeroed))).contextParts.unsplit).toBe('unknown');
    // A real split (any of the other three counters) is never marked.
    expect((await one(live({ compactPostTokens: 32_960 }))).contextParts.unsplit).toBeUndefined();
  });

  it('D3 — a scheduled auto-compact is on the card; absent otherwise', async () => {
    expect((await one(live({ autoCompactPending: true }))).compactPending).toBe(true);
    expect((await one(live({ autoCompactPending: false }))).compactPending).toBeUndefined();
    expect((await one(live())).compactPending).toBeUndefined();
  });

  it('D4 — the last compaction’s SDK counts only when both are known, with its trigger', async () => {
    expect(
      (await one(live({ compactPreTokens: 812_000, compactPostTokens: 64_000, compactTrigger: 'manual' }))).lastCompact,
    ).toEqual({ preTokens: 812_000, postTokens: 64_000, trigger: 'manual' });
    expect((await one(live({ compactPreTokens: 812_000, compactPostTokens: 64_000 }))).lastCompact).toEqual({
      preTokens: 812_000,
      postTokens: 64_000,
    });
    expect((await one(live({ compactPreTokens: 812_000, compactPostTokens: null }))).lastCompact).toBeUndefined();
    expect((await one(live())).lastCompact).toBeUndefined();
  });
});
