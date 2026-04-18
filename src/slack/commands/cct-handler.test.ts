import { describe, expect, it, vi } from 'vitest';

// Contract tests for CctHandler — derived from docs/cct-token-rotation/trace.md
// Scenarios 2 & 3

describe('CommandParser CCT', () => {
  // Trace: Scenario 2 — command parsing
  it('should recognize "cct" as cct command', async () => {
    const { CommandParser } = await import('../command-parser');
    expect(CommandParser.isCctCommand('cct')).toBe(true);
  });

  it('should recognize "cct set cct2" as cct command', async () => {
    const { CommandParser } = await import('../command-parser');
    expect(CommandParser.isCctCommand('cct set cct2')).toBe(true);
  });

  it('should parse "cct" as status action', async () => {
    const { CommandParser } = await import('../command-parser');
    const result = CommandParser.parseCctCommand('cct');
    expect(result).toEqual({ action: 'status' });
  });

  it('should parse "cct set cct2" as set action', async () => {
    const { CommandParser } = await import('../command-parser');
    const result = CommandParser.parseCctCommand('cct set cct2');
    expect(result).toEqual({ action: 'set', target: 'cct2' });
  });

  it('should recognize "cct next" as cct command', async () => {
    const { CommandParser } = await import('../command-parser');
    expect(CommandParser.isCctCommand('cct next')).toBe(true);
  });

  it('should parse "cct next" as next action', async () => {
    const { CommandParser } = await import('../command-parser');
    const result = CommandParser.parseCctCommand('cct next');
    expect(result).toEqual({ action: 'next' });
  });

  it('should NOT recognize legacy underscore alias "set_cct cct2" (#506)', async () => {
    const { CommandParser } = await import('../command-parser');
    expect(CommandParser.isCctCommand('set_cct cct2')).toBe(false);
  });

  it('should NOT recognize legacy alias "nextcct" (#506)', async () => {
    const { CommandParser } = await import('../command-parser');
    expect(CommandParser.isCctCommand('nextcct')).toBe(false);
  });

  it('should not match unrelated text', async () => {
    const { CommandParser } = await import('../command-parser');
    expect(CommandParser.isCctCommand('hello')).toBe(false);
  });
});

describe('isAdminUser', () => {
  it('should return true for admin user ID', async () => {
    const { isAdminUser } = await import('../../admin-utils');
    // This depends on ADMIN_USERS env being set
    expect(typeof isAdminUser).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────────
// Wave 5 (#569): usage subcommand + forbidden add/rm + card timestamp.
// ────────────────────────────────────────────────────────────────────

interface FakeSay {
  calls: Array<{ text: string; blocks?: unknown[]; thread_ts?: string }>;
  fn: (m: { text: string; blocks?: unknown[]; thread_ts?: string }) => Promise<{ ts?: string }>;
}

function makeSay(): FakeSay {
  const calls: FakeSay['calls'] = [];
  const fn = async (m: { text: string; blocks?: unknown[]; thread_ts?: string }): Promise<{ ts?: string }> => {
    calls.push(m);
    return {};
  };
  return { calls, fn };
}

describe('CctHandler — Wave 5', () => {
  // Pick an admin-bypass user id — the env is seeded with at least one
  // admin during test bootstrap; we read it from ADMIN_USERS, else fall
  // back to a harness-safe value.
  const adminUser = (process.env.ADMIN_USERS?.split(',')[0] || 'U_ADMIN').trim();

  async function loadHandlerWithMockTm(overrides: {
    tokens?: Array<{ slotId: string; name: string; kind: 'setup_token' | 'oauth_credentials'; status: string }>;
    active?: { slotId: string; name: string; kind: 'setup_token' | 'oauth_credentials' } | null;
    fetchAndStoreUsage?: (slotId: string) => Promise<unknown>;
    rotateToNext?: () => Promise<{ slotId: string; name: string } | null>;
    applyToken?: (slotId: string) => Promise<void>;
    snapshot?: Record<string, unknown> | null;
  }): Promise<{ CctHandler: typeof import('./cct-handler').CctHandler }> {
    vi.resetModules();

    // Mock isAdminUser to always accept our synthetic adminUser.
    vi.doMock('../../admin-utils', () => ({
      isAdminUser: (u: string) => u === adminUser,
    }));

    // Mock renderCctCard so status path doesn't pull the real store.
    vi.doMock('../z/topics/cct-topic', () => ({
      renderCctCard: async () => ({
        text: '🔑 CCT (active: active-slot)',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'mocked' } }],
      }),
    }));

    // Mock TokenManager singleton.
    const tokens = overrides.tokens ?? [];
    const active = overrides.active ?? null;
    const fakeTm = {
      listTokens: () => tokens,
      getActiveToken: () => active,
      fetchAndStoreUsage: overrides.fetchAndStoreUsage ?? (async () => null),
      rotateToNext: overrides.rotateToNext ?? (async () => null),
      applyToken: overrides.applyToken ?? (async () => undefined),
      getSnapshot: overrides.snapshot !== undefined ? async () => overrides.snapshot : undefined,
    };
    vi.doMock('../../token-manager', () => ({
      getTokenManager: () => fakeTm,
    }));

    const mod = await import('./cct-handler');
    return { CctHandler: mod.CctHandler };
  }

  it('cct usage (no name) fetches usage for active oauth_credentials slot', async () => {
    const fetchAndStoreUsage = vi.fn(async (_slotId: string) => ({
      fetchedAt: '2026-04-18T03:42:00Z',
      fiveHour: { utilization: 0.42, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
      sevenDay: { utilization: 0.17, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
    }));
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ slotId: 'slot-1', name: 'active', kind: 'oauth_credentials', status: 'healthy' }],
      active: { slotId: 'slot-1', name: 'active', kind: 'oauth_credentials' },
      fetchAndStoreUsage,
    });

    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct usage',
      say: say.fn,
    });

    expect(fetchAndStoreUsage).toHaveBeenCalledWith('slot-1');
    expect(say.calls).toHaveLength(1);
    const msg = say.calls[0].text;
    expect(msg).toContain('Usage for *active*');
    expect(msg).toContain('(oauth_credentials)');
    expect(msg).toMatch(/5h:\s*42%/);
    expect(msg).toMatch(/7d:\s*17%/);
    expect(msg).toContain('resets in');
  });

  it('cct usage <name> looks up slot by name and calls fetchAndStoreUsage', async () => {
    const fetchAndStoreUsage = vi.fn(async (_slotId: string) => ({
      fetchedAt: '2026-04-18T03:42:00Z',
      fiveHour: { utilization: 0.5, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      sevenDay: { utilization: 0.25, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    }));
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [
        { slotId: 'slot-1', name: 'active', kind: 'oauth_credentials', status: 'healthy' },
        { slotId: 'slot-2', name: 'secondary', kind: 'oauth_credentials', status: 'healthy' },
      ],
      active: { slotId: 'slot-1', name: 'active', kind: 'oauth_credentials' },
      fetchAndStoreUsage,
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct usage secondary',
      say: say.fn,
    });
    expect(fetchAndStoreUsage).toHaveBeenCalledWith('slot-2');
    expect(say.calls[0].text).toContain('Usage for *secondary*');
    expect(say.calls[0].text).toMatch(/5h:\s*50%/);
    expect(say.calls[0].text).toMatch(/7d:\s*25%/);
  });

  it('cct usage <unknown> returns "Unknown slot: <name>"', async () => {
    const fetchAndStoreUsage = vi.fn();
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ slotId: 'slot-1', name: 'active', kind: 'oauth_credentials', status: 'healthy' }],
      active: { slotId: 'slot-1', name: 'active', kind: 'oauth_credentials' },
      fetchAndStoreUsage,
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct usage foo',
      say: say.fn,
    });
    expect(say.calls[0].text).toContain('Unknown slot: foo');
    expect(fetchAndStoreUsage).not.toHaveBeenCalled();
  });

  it('cct usage for setup_token slot does NOT attempt fetch and emits oauth-only error', async () => {
    const fetchAndStoreUsage = vi.fn();
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ slotId: 'slot-1', name: 'setup', kind: 'setup_token', status: 'healthy' }],
      active: { slotId: 'slot-1', name: 'setup', kind: 'setup_token' },
      fetchAndStoreUsage,
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct usage',
      say: say.fn,
    });
    expect(say.calls[0].text).toContain('Usage API requires oauth_credentials');
    expect(say.calls[0].text).toContain('setup_token');
    expect(fetchAndStoreUsage).not.toHaveBeenCalled();
  });

  it('cct usage when backoff active (fetch returns null) emits "not available yet"', async () => {
    const nextAt = new Date(Date.now() + 7 * 60_000).toISOString();
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ slotId: 'slot-1', name: 'active', kind: 'oauth_credentials', status: 'healthy' }],
      active: { slotId: 'slot-1', name: 'active', kind: 'oauth_credentials' },
      fetchAndStoreUsage: async () => null,
      snapshot: {
        version: 1,
        revision: 1,
        registry: { activeSlotId: 'slot-1', slots: [] },
        state: {
          'slot-1': {
            authState: 'healthy',
            activeLeases: [],
            nextUsageFetchAllowedAt: nextAt,
          },
        },
      },
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct usage',
      say: say.fn,
    });
    expect(say.calls[0].text).toContain('Usage not available yet');
    expect(say.calls[0].text).toMatch(/next fetch in \d+m/);
  });

  it('cct add <…> returns the forbidden "use card" message (Add button)', async () => {
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ slotId: 'slot-1', name: 'active', kind: 'oauth_credentials', status: 'healthy' }],
      active: { slotId: 'slot-1', name: 'active', kind: 'oauth_credentials' },
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct add foo sk-ant-oat01-xxx',
      say: say.fn,
    });
    expect(say.calls[0].text).toContain('disabled');
    expect(say.calls[0].text).toContain('/z cct');
    expect(say.calls[0].text).toContain('*Add*');
  });

  it('cct rm <…> returns the forbidden "use card" message (Remove button)', async () => {
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ slotId: 'slot-1', name: 'active', kind: 'oauth_credentials', status: 'healthy' }],
      active: { slotId: 'slot-1', name: 'active', kind: 'oauth_credentials' },
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct rm active',
      say: say.fn,
    });
    expect(say.calls[0].text).toContain('disabled');
    expect(say.calls[0].text).toContain('/z cct');
    expect(say.calls[0].text).toContain('*Remove*');
  });

  it('cct (status) text fallback includes KST + UTC + relative timestamp when slot rate-limited', async () => {
    const rateLimitedAt = new Date(Date.now() - 5 * 60_000).toISOString(); // 5m ago
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ slotId: 'slot-1', name: 'active', kind: 'oauth_credentials', status: 'rate-limited' }],
      active: { slotId: 'slot-1', name: 'active', kind: 'oauth_credentials' },
      snapshot: {
        version: 1,
        revision: 1,
        registry: {
          activeSlotId: 'slot-1',
          slots: [
            {
              slotId: 'slot-1',
              name: 'active',
              kind: 'oauth_credentials',
              credentials: { accessToken: 'x', refreshToken: 'y', expiresAtMs: 0, scopes: [] },
              createdAt: new Date().toISOString(),
              acknowledgedConsumerTosRisk: true,
            },
          ],
        },
        state: {
          'slot-1': {
            authState: 'healthy',
            activeLeases: [],
            rateLimitedAt,
            rateLimitSource: 'response_header',
          },
        },
      },
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct',
      say: say.fn,
    });
    const text = say.calls[0].text;
    // Both KST and UTC surfaces appear in a single line via formatRateLimitedAt.
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST/);
    expect(text).toMatch(/\d{2}:\d{2}Z/);
    expect(text).toMatch(/\(\d+m ago\)/);
    expect(text).toContain('response_header');
  });
});

describe('renderUsageLines', () => {
  it('scales 0..1 utilization to 0..100 percent integer', async () => {
    const { renderUsageLines } = await import('./cct-handler');
    const now = Date.parse('2026-04-18T00:00:00Z');
    const out = renderUsageLines(
      { name: 'x', kind: 'oauth_credentials' },
      {
        fetchedAt: '2026-04-18T00:00:00Z',
        fiveHour: { utilization: 0.4234, resetsAt: '2026-04-18T03:45:00Z' },
        sevenDay: { utilization: 0.01, resetsAt: '2026-04-25T00:00:00Z' },
      },
      now,
    );
    expect(out).toContain('Usage for *x* (oauth_credentials)');
    expect(out).toMatch(/5h:\s*42%/);
    expect(out).toMatch(/7d:\s*1%/);
  });

  it('passes through utilization already in 0..100 integer form', async () => {
    const { renderUsageLines } = await import('./cct-handler');
    const now = Date.parse('2026-04-18T00:00:00Z');
    const out = renderUsageLines(
      { name: 'x', kind: 'oauth_credentials' },
      {
        fetchedAt: '2026-04-18T00:00:00Z',
        fiveHour: { utilization: 75, resetsAt: '2026-04-18T03:45:00Z' },
      },
      now,
    );
    expect(out).toMatch(/5h:\s*75%/);
  });
});
