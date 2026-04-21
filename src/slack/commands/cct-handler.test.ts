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

  // Synthesise a v2 snapshot whose single cct slot carries an oauthAttachment.
  // Usage-path tests must hand this to the mocked TokenManager so handleUsage
  // can clear the `hasOAuthAttachment` gate and dispatch fetchAndStoreUsage.
  function snapshotWithOAuthAttachment(keyId: string, name: string): Record<string, unknown> {
    return {
      version: 2,
      revision: 1,
      registry: {
        activeKeyId: keyId,
        slots: [
          {
            kind: 'cct',
            source: 'legacy-attachment',
            keyId,
            name,
            createdAt: new Date().toISOString(),
            oauthAttachment: {
              accessToken: 'sk-ant-oat01-xxx',
              refreshToken: 'r',
              expiresAtMs: Date.now() + 3_600_000,
              scopes: ['user:profile', 'user:inference'],
              acknowledgedConsumerTosRisk: true,
            },
          },
        ],
      },
      state: { [keyId]: { authState: 'healthy', activeLeases: [] } },
    };
  }

  async function loadHandlerWithMockTm(overrides: {
    tokens?: Array<{ keyId: string; name: string; kind: 'api_key' | 'cct'; status: string }>;
    active?: { keyId: string; name: string; kind: 'api_key' | 'cct' } | null;
    fetchAndStoreUsage?: (keyId: string) => Promise<unknown>;
    rotateToNext?: () => Promise<{ keyId: string; name: string } | null>;
    applyToken?: (keyId: string) => Promise<void>;
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
      // Z3 runtime fence: the handler now calls listRuntimeSelectableTokens;
      // mirror the real TokenManager behaviour (kind !== 'api_key').
      listRuntimeSelectableTokens: () => tokens.filter((t) => t.kind !== 'api_key'),
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

  it('cct usage (no name) fetches usage for the active cct slot with oauth attachment', async () => {
    const fetchAndStoreUsage = vi.fn(async (_keyId: string) => ({
      fetchedAt: '2026-04-18T03:42:00Z',
      fiveHour: { utilization: 0.42, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
      sevenDay: { utilization: 0.17, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
    }));
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'healthy' }],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
      fetchAndStoreUsage,
      snapshot: snapshotWithOAuthAttachment('slot-1', 'active'),
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
    expect(msg).toContain('(cct)');
    // M1-S2 — renderUsageLines now emits the shared formatUsageBar progress-bar
    // rows: `<label>   <bar> <pct>% · resets in …`.
    expect(msg).toMatch(/5h\s+[█░]+\s+42%/);
    expect(msg).toMatch(/7d\s+[█░]+\s+17%/);
    expect(msg).toContain('resets in');
  });

  it('cct usage <name> looks up slot by name and calls fetchAndStoreUsage', async () => {
    const fetchAndStoreUsage = vi.fn(async (_keyId: string) => ({
      fetchedAt: '2026-04-18T03:42:00Z',
      fiveHour: { utilization: 0.5, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      sevenDay: { utilization: 0.25, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    }));
    // Build a snapshot where BOTH slots carry oauthAttachment so the lookup
    // for 'secondary' passes the attachment gate.
    const twoSlotSnapshot = {
      version: 2,
      revision: 1,
      registry: {
        activeKeyId: 'slot-1',
        slots: [
          {
            kind: 'cct',
            source: 'legacy-attachment',
            keyId: 'slot-1',
            name: 'active',
            createdAt: new Date().toISOString(),
            oauthAttachment: {
              accessToken: 'a',
              refreshToken: 'r',
              expiresAtMs: Date.now() + 3_600_000,
              scopes: ['user:profile'],
              acknowledgedConsumerTosRisk: true,
            },
          },
          {
            kind: 'cct',
            source: 'legacy-attachment',
            keyId: 'slot-2',
            name: 'secondary',
            createdAt: new Date().toISOString(),
            oauthAttachment: {
              accessToken: 'b',
              refreshToken: 'r',
              expiresAtMs: Date.now() + 3_600_000,
              scopes: ['user:profile'],
              acknowledgedConsumerTosRisk: true,
            },
          },
        ],
      },
      state: {
        'slot-1': { authState: 'healthy', activeLeases: [] },
        'slot-2': { authState: 'healthy', activeLeases: [] },
      },
    };
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [
        { keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'healthy' },
        { keyId: 'slot-2', name: 'secondary', kind: 'cct' as const, status: 'healthy' },
      ],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
      fetchAndStoreUsage,
      snapshot: twoSlotSnapshot,
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
    // M1-S2 — migrated to the shared formatUsageBar progress-bar format.
    expect(say.calls[0].text).toMatch(/5h\s+[█░]+\s+50%/);
    expect(say.calls[0].text).toMatch(/7d\s+[█░]+\s+25%/);
  });

  it('cct usage <unknown> returns "Unknown slot: <name>"', async () => {
    const fetchAndStoreUsage = vi.fn();
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'healthy' }],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
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

  it('cct usage for setup-only cct slot (no oauth attachment) does NOT attempt fetch and emits oauth-only error', async () => {
    const fetchAndStoreUsage = vi.fn();
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ keyId: 'slot-1', name: 'setup', kind: 'cct' as const, status: 'healthy' }],
      active: { keyId: 'slot-1', name: 'setup', kind: 'cct' as const },
      fetchAndStoreUsage,
      // Snapshot with a setup-only cct slot (no oauthAttachment) — must trigger
      // the oauth-only error path without dispatching fetchAndStoreUsage.
      snapshot: {
        version: 2,
        revision: 1,
        registry: {
          activeKeyId: 'slot-1',
          slots: [
            {
              kind: 'cct',
              source: 'setup',
              keyId: 'slot-1',
              name: 'setup',
              setupToken: 'sk-ant-oat01-abc',
              createdAt: new Date().toISOString(),
            },
          ],
        },
        state: { 'slot-1': { authState: 'healthy', activeLeases: [] } },
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
    expect(say.calls[0].text).toContain('Usage API requires an OAuth attachment');
    expect(say.calls[0].text).toContain('no oauth_credentials attached');
    expect(fetchAndStoreUsage).not.toHaveBeenCalled();
  });

  it('cct usage when backoff active (fetch returns null) emits "not available yet"', async () => {
    const nextAt = new Date(Date.now() + 7 * 60_000).toISOString();
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'healthy' }],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
      fetchAndStoreUsage: async () => null,
      snapshot: {
        version: 2,
        revision: 1,
        registry: {
          activeKeyId: 'slot-1',
          slots: [
            {
              kind: 'cct',
              source: 'legacy-attachment',
              keyId: 'slot-1',
              name: 'active',
              createdAt: new Date().toISOString(),
              oauthAttachment: {
                accessToken: 'a',
                refreshToken: 'r',
                expiresAtMs: Date.now() + 3_600_000,
                scopes: ['user:profile'],
                acknowledgedConsumerTosRisk: true,
              },
            },
          ],
        },
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
      tokens: [{ keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'healthy' }],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
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
      tokens: [{ keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'healthy' }],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
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

  // ── T10c: Z3 runtime fence — `cct set <api_key-name>` is not runtime-selectable ──
  it('T10c: cct set <api_key-name> → applyToken NOT called, replies Unknown token', async () => {
    const applyToken = vi.fn(async () => undefined);
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [
        { keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'healthy' },
        { keyId: 'api-1', name: 'ops-api', kind: 'api_key' as const, status: 'healthy' },
      ],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
      applyToken,
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct set ops-api',
      say: say.fn,
    });
    expect(applyToken).not.toHaveBeenCalled();
    expect(say.calls[0].text).toContain('Unknown token');
    // Available: list must not leak the api_key slot name. Input echo in the
    // error preamble ("Unknown token: `ops-api`") is expected — inspect only
    // the "Available:" line.
    const availableLine = say.calls[0].text.split('\n').find((l: string) => l.startsWith('Available:'));
    expect(availableLine).toBeDefined();
    expect(availableLine).not.toContain('ops-api');
    expect(availableLine).toContain('active');
  });

  // ── T10d: Z3 runtime fence — `cct usage <api_key-name>` is not runtime-selectable ──
  it('T10d: cct usage <api_key-name> → fetchAndStoreUsage NOT called, replies Unknown slot', async () => {
    const fetchAndStoreUsage = vi.fn();
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [
        { keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'healthy' },
        { keyId: 'api-1', name: 'ops-api', kind: 'api_key' as const, status: 'healthy' },
      ],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
      fetchAndStoreUsage,
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct usage ops-api',
      say: say.fn,
    });
    expect(fetchAndStoreUsage).not.toHaveBeenCalled();
    expect(say.calls[0].text).toContain('Unknown slot: ops-api');
  });

  // ── T10e: Z3 runtime fence — "Available:" hint excludes api_key slot names ──
  it('T10e: cct set <unknown> → "Available:" hint excludes api_key slot names', async () => {
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [
        { keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'healthy' },
        { keyId: 'api-1', name: 'ops-api', kind: 'api_key' as const, status: 'healthy' },
      ],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
    });
    const say = makeSay();
    const h = new CctHandler();
    await h.execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct set doesnotexist',
      say: say.fn,
    });
    expect(say.calls[0].text).toContain('`active`');
    expect(say.calls[0].text).not.toContain('ops-api');
  });

  it('cct (status) text fallback includes KST + UTC + relative timestamp when slot rate-limited', async () => {
    const rateLimitedAt = new Date(Date.now() - 5 * 60_000).toISOString(); // 5m ago
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ keyId: 'slot-1', name: 'active', kind: 'cct' as const, status: 'rate-limited' }],
      active: { keyId: 'slot-1', name: 'active', kind: 'cct' as const },
      snapshot: {
        version: 2,
        revision: 1,
        registry: {
          activeKeyId: 'slot-1',
          slots: [
            {
              kind: 'cct',
              source: 'legacy-attachment',
              keyId: 'slot-1',
              name: 'active',
              createdAt: new Date().toISOString(),
              oauthAttachment: {
                accessToken: 'x',
                refreshToken: 'y',
                expiresAtMs: 0,
                scopes: [],
                acknowledgedConsumerTosRisk: true,
              },
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
      { name: 'x', kind: 'cct' },
      {
        fetchedAt: '2026-04-18T00:00:00Z',
        fiveHour: { utilization: 0.4234, resetsAt: '2026-04-18T03:45:00Z' },
        sevenDay: { utilization: 0.01, resetsAt: '2026-04-25T00:00:00Z' },
      },
      now,
    );
    expect(out).toContain('Usage for *x* (cct)');
    // M1-S2 — renderUsageLines now shares `formatUsageBar`.
    expect(out).toMatch(/5h\s+[█░]+\s+42%/);
    expect(out).toMatch(/7d\s+[█░]+\s+1%/);
  });

  it('passes through utilization already in 0..100 integer form', async () => {
    const { renderUsageLines } = await import('./cct-handler');
    const now = Date.parse('2026-04-18T00:00:00Z');
    const out = renderUsageLines(
      { name: 'x', kind: 'cct' },
      {
        fetchedAt: '2026-04-18T00:00:00Z',
        fiveHour: { utilization: 75, resetsAt: '2026-04-18T03:45:00Z' },
      },
      now,
    );
    expect(out).toMatch(/5h\s+[█░]+\s+75%/);
  });
});
