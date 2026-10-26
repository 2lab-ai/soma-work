import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * affectUI Model Picker → the dashboard's model · effort picker, server half
 * (.prd/affectui/re-model-picker.md §4):
 *   D5  the registry price of each representative model, injected with the
 *       list — and no price at all for an id the registry does not know
 *       (`findModelPricing`; `getModelPricing` keeps its fallback);
 *   D6  the effort levels the session's model runs (catalog menu ∩ levels).
 */

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
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [] }),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    model: 'claude-opus-5-5[1m]',
    effort: 'max',
    activityState: 'working',
    state: 'MAIN',
    lastActivity: new Date('2026-10-26T00:00:00Z'),
    ...overrides,
  };
}

describe('D5 — findModelPricing: the registry price, or none', () => {
  it('a known id has its row; an unknown id has none; getModelPricing keeps the Sonnet fallback', {
    timeout: 30_000,
  }, async () => {
    const reg = await import('../../metrics/model-registry');
    // Opus 5.5 official rates ($4 / $20) — not Opus 5's ($5 / $25), whose id it contains.
    expect(reg.findModelPricing('claude-opus-5-5[1m]')).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(reg.findModelPricing('claude-sonnet-4-6[1m]')).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(reg.findModelPricing('gpt-5.6-sol[1m]')).toMatchObject({ inputPerMTok: 5, outputPerMTok: 30 });
    expect(reg.findModelPricing('grok-4.6')).toBeNull();
    expect(reg.findModelPricing('')).toBeNull();
    expect(reg.findModelPricing(undefined)).toBeNull();
    // Existing callers: unchanged behaviour (cost math still prices an unknown id at the fallback).
    expect(reg.getModelPricing('grok-4.6')).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(reg.getModelPricing('claude-opus-5-5[1m]')).toBe(reg.findModelPricing('claude-opus-5-5[1m]'));
    expect(reg.getModelPricing(undefined)).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 });
  });
});

describe('Dashboard — model picker payload', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    await startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    await stopWebServer?.();
    vi.restoreAllMocks();
  });

  it('D6 — pickerEffortLevels: the catalog menu ∩ the levels, in level order; none without a menu', () => {
    const { pickerEffortLevels } = dashboard;
    expect(pickerEffortLevels(['high', 'LOW', 'ultra'])).toEqual(['low', 'high']);
    expect(pickerEffortLevels(['max', 'xhigh', 'high', 'medium', 'low'])).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(pickerEffortLevels(['ultra'])).toBeUndefined();
    expect(pickerEffortLevels([])).toBeUndefined();
    expect(pickerEffortLevels(null)).toBeUndefined();
  });

  it('D5 — the page lists each representative model with its price per M tokens; grok has none', {
    timeout: 30_000,
  }, async () => {
    const res = await injectWebServer({ method: 'GET', url: '/dashboard', headers: AUTH_HEADER });
    const m = /const REPRESENTATIVE_MODELS = (\[.*?\]);\n/.exec(res.body);
    expect(m).not.toBeNull();
    const list = JSON.parse(m![1]);
    const by = (n: string) => list.find((x: any) => x.nickname === n);
    expect(by('opus[1m]').price).toEqual({ input: 4, output: 20 }); // Opus 5.5 official rates
    expect(by('sonnet[1m]').price).toEqual({ input: 3, output: 15 });
    expect(by('astra[1m]').price).toEqual({ input: 10, output: 50 });
    expect(by('grok[1m]')).not.toHaveProperty('price');
    // The rest of the contract is untouched.
    expect(by('grok[1m]')).toMatchObject({ model: 'grok-4.6', contextWindow: 500_000, autoCompactTokens: 450_000 });
  });

  it('D6 — a card carries the levels its model runs when the catalog knows the model, nothing otherwise', {
    timeout: 30_000,
  }, async () => {
    const catalog = await import('../../model-catalog');
    vi.spyOn(catalog.modelCatalog, 'getEffortsFor').mockImplementation((id: string) =>
      id === 'grok-4.6' ? ['low', 'high'] : null,
    );
    dashboard.setDashboardSessionAccessor(
      () =>
        new Map([
          ['C1:t1', liveSession({ model: 'grok-4.6' })],
          ['C2:t2', liveSession({ channelId: 'C2', threadTs: 't2', sessionId: 'sid2' })],
        ]),
    );
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const cards = JSON.parse(res.body).board.working;
    const grok = cards.find((c: any) => c.model === 'grok-4.6');
    const opus = cards.find((c: any) => c.model === 'claude-opus-5-5[1m]');
    expect(grok.effortLevels).toEqual(['low', 'high']);
    expect(grok.effortEffective).toBe('high');
    expect(opus).not.toHaveProperty('effortLevels');
  });
});
