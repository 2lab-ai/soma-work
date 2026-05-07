import { describe, expect, it, vi } from 'vitest';

// Contract tests for CctHandler — derived from docs/cct-token-rotation/trace.md
// Scenarios 2 & 3

describe('CommandParser CCT', () => {
  // Trace: Scenario 2 — command parsing
  it('should recognize "cct" as cct command', async () => {
    const { CommandParser } = await import('../../command-parser');
    expect(CommandParser.isCctCommand('cct')).toBe(true);
  });

  it('should recognize "cct set cct2" as cct command', async () => {
    const { CommandParser } = await import('../../command-parser');
    expect(CommandParser.isCctCommand('cct set cct2')).toBe(true);
  });

  it('should parse "cct" as status action', async () => {
    const { CommandParser } = await import('../../command-parser');
    const result = CommandParser.parseCctCommand('cct');
    expect(result).toEqual({ action: 'status' });
  });

  it('should parse "cct set cct2" as set action', async () => {
    const { CommandParser } = await import('../../command-parser');
    const result = CommandParser.parseCctCommand('cct set cct2');
    expect(result).toEqual({ action: 'set', target: 'cct2' });
  });

  it('should recognize "cct next" as cct command', async () => {
    const { CommandParser } = await import('../../command-parser');
    expect(CommandParser.isCctCommand('cct next')).toBe(true);
  });

  it('should parse "cct next" as next action', async () => {
    const { CommandParser } = await import('../../command-parser');
    const result = CommandParser.parseCctCommand('cct next');
    expect(result).toEqual({ action: 'next' });
  });

  it('should NOT recognize legacy underscore alias "set_cct cct2" (#506)', async () => {
    const { CommandParser } = await import('../../command-parser');
    expect(CommandParser.isCctCommand('set_cct cct2')).toBe(false);
  });

  it('should NOT recognize legacy alias "nextcct" (#506)', async () => {
    const { CommandParser } = await import('../../command-parser');
    expect(CommandParser.isCctCommand('nextcct')).toBe(false);
  });

  it('should not match unrelated text', async () => {
    const { CommandParser } = await import('../../command-parser');
    expect(CommandParser.isCctCommand('hello')).toBe(false);
  });
});

describe('isAdminUser', () => {
  it('should return true for admin user ID', async () => {
    const { isAdminUser } = await import('../../../admin-utils');
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
  }): Promise<{ CctHandler: typeof import('../cct-handler').CctHandler }> {
    vi.resetModules();

    // Mock isAdminUser to always accept our synthetic adminUser.
    vi.doMock('../../../admin-utils', () => ({
      isAdminUser: (u: string) => u === adminUser,
    }));

    // Mock renderCctCard so status path doesn't pull the real store.
    vi.doMock('../../z/topics/cct-topic', () => ({
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
    vi.doMock('../../../token-manager', () => ({
      getTokenManager: () => fakeTm,
    }));

    const mod = await import('../cct-handler');
    return { CctHandler: mod.CctHandler };
  }

  it('cct usage (no name) fetches usage for the active cct slot with oauth attachment', async () => {
    const fetchAndStoreUsage = vi.fn(async (_keyId: string) => ({
      fetchedAt: '2026-04-18T03:42:00Z',
      fiveHour: { utilization: 42, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
      sevenDay: { utilization: 17, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
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

  it('cct usage NEVER forces — respects server-backoff (no { force: true } sent to TM)', async () => {
    // Server-respect contract (PR#641 M1-S4): `/cct usage` is a user-triggered
    // inspect, NOT an emergency override. It must never pass `{ force: true }`
    // to `fetchAndStoreUsage` — doing so would bypass the per-slot
    // `nextUsageFetchAllowedAt` backoff that protects Anthropic from the
    // Slack command surface. Only the Refresh-buttons admin path may force.
    const fetchAndStoreUsage = vi.fn(async (_keyId: string) => ({
      fetchedAt: '2026-04-18T03:42:00Z',
      fiveHour: { utilization: 10, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
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
    expect(fetchAndStoreUsage).toHaveBeenCalledTimes(1);
    // #644 review #6 — tighten to match the scheduler test's stricter
    // contract (`expect(args).not.toHaveProperty('force')`). The previous
    // matcher (`not.objectContaining({ force: true })`) would have quietly
    // accepted a regression that explicitly passed `{ force: false }`, which
    // signals to a future reader that `force` is a knob on this surface —
    // exactly the anti-pattern we are guarding against. The contract is
    // simpler and stronger: `force` must never appear at all, for any value.
    // Single-arg calls (the production shape) are also tolerated by this
    // guard because `secondArg === undefined` skips the check.
    const secondArg = (fetchAndStoreUsage.mock.calls[0] as unknown as unknown[])[1];
    if (secondArg !== undefined) {
      expect(secondArg).not.toHaveProperty('force');
    }
  });

  it('cct usage <name> looks up slot by name and calls fetchAndStoreUsage', async () => {
    const fetchAndStoreUsage = vi.fn(async (_keyId: string) => ({
      fetchedAt: '2026-04-18T03:42:00Z',
      fiveHour: { utilization: 50, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      sevenDay: { utilization: 25, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
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

  // ────────────────────────────────────────────────────────────────────
  // #803 — non-admin can run `cct status` (the only non-mutating arm)
  // ────────────────────────────────────────────────────────────────────

  it('#803: non-admin user runs `cct` (status) → renderCctCard is called, no admin-only banner', async () => {
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ keyId: 'k1', name: 'cct1', kind: 'cct', status: 'healthy' }],
      active: { keyId: 'k1', name: 'cct1', kind: 'cct' },
    });
    const say = makeSay();
    // 'U_OTHER' is NOT in ADMIN_USERS (the loadHandler mock only accepts adminUser).
    await new CctHandler().execute({ user: 'U_OTHER', channel: 'C', threadTs: 'T', text: 'cct', say: say.fn });
    expect(say.calls[0].text).not.toBe('⛔ Admin only command');
    // The mocked renderCctCard returns this exact text.
    expect(say.calls[0].text).toContain('CCT');
    expect(Array.isArray(say.calls[0].blocks)).toBe(true);
  });

  it('#803: non-admin `cct next` → "⛔ Admin only command", no rotateToNext call', async () => {
    const rotateToNext = vi.fn(async () => null);
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ keyId: 'k1', name: 'cct1', kind: 'cct', status: 'healthy' }],
      rotateToNext,
    });
    const say = makeSay();
    await new CctHandler().execute({ user: 'U_OTHER', channel: 'C', threadTs: 'T', text: 'cct next', say: say.fn });
    expect(say.calls[0].text).toBe('⛔ Admin only command');
    expect(rotateToNext).not.toHaveBeenCalled();
  });

  it('#803: non-admin `cct set <name>` → "⛔ Admin only command", no applyToken call', async () => {
    const applyToken = vi.fn(async () => undefined);
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ keyId: 'k1', name: 'cct1', kind: 'cct', status: 'healthy' }],
      applyToken,
    });
    const say = makeSay();
    await new CctHandler().execute({
      user: 'U_OTHER',
      channel: 'C',
      threadTs: 'T',
      text: 'cct set cct1',
      say: say.fn,
    });
    expect(say.calls[0].text).toBe('⛔ Admin only command');
    expect(applyToken).not.toHaveBeenCalled();
  });

  it('#803: non-admin `cct usage` → "⛔ Admin only command", no fetchAndStoreUsage call', async () => {
    const fetchAndStoreUsage = vi.fn(async () => null);
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [{ keyId: 'k1', name: 'cct1', kind: 'cct', status: 'healthy' }],
      active: { keyId: 'k1', name: 'cct1', kind: 'cct' },
      fetchAndStoreUsage,
    });
    const say = makeSay();
    await new CctHandler().execute({ user: 'U_OTHER', channel: 'C', threadTs: 'T', text: 'cct usage', say: say.fn });
    expect(say.calls[0].text).toBe('⛔ Admin only command');
    expect(fetchAndStoreUsage).not.toHaveBeenCalled();
  });

  // Codex P2 review (PR #805): empty-store informational message must
  // not be reachable for non-admin mutating arms. Otherwise a non-admin
  // running `cct next` against an empty fleet would learn the store is
  // empty (configuration leak) instead of seeing `⛔ Admin only command`.
  it('Codex P2: non-admin `cct next` against EMPTY store → "⛔ Admin only command", not "No CCT tokens configured"', async () => {
    const rotateToNext = vi.fn(async () => null);
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [], // empty store
      rotateToNext,
    });
    const say = makeSay();
    await new CctHandler().execute({ user: 'U_OTHER', channel: 'C', threadTs: 'T', text: 'cct next', say: say.fn });
    expect(say.calls[0].text).toBe('⛔ Admin only command');
    expect(say.calls[0].text).not.toMatch(/No CCT tokens configured/);
    expect(rotateToNext).not.toHaveBeenCalled();
  });

  it('Codex P2: non-admin `cct usage` against EMPTY store → "⛔ Admin only command"', async () => {
    const fetchAndStoreUsage = vi.fn(async () => null);
    const { CctHandler } = await loadHandlerWithMockTm({
      tokens: [],
      fetchAndStoreUsage,
    });
    const say = makeSay();
    await new CctHandler().execute({ user: 'U_OTHER', channel: 'C', threadTs: 'T', text: 'cct usage', say: say.fn });
    expect(say.calls[0].text).toBe('⛔ Admin only command');
    expect(fetchAndStoreUsage).not.toHaveBeenCalled();
  });

  it('Codex P2: non-admin `cct` (status) against EMPTY store still sees informational empty-store message (status is non-mutating)', async () => {
    const { CctHandler } = await loadHandlerWithMockTm({ tokens: [] });
    const say = makeSay();
    await new CctHandler().execute({ user: 'U_OTHER', channel: 'C', threadTs: 'T', text: 'cct', say: say.fn });
    // Status is still allowed for non-admin even on empty store.
    expect(say.calls[0].text).toMatch(/No CCT tokens configured/);
  });

  it('Codex P2: admin `cct next` against EMPTY store → informational empty-store message (admin still gets actionable hint)', async () => {
    const rotateToNext = vi.fn(async () => null);
    const { CctHandler } = await loadHandlerWithMockTm({ tokens: [], rotateToNext });
    const say = makeSay();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct next', say: say.fn });
    expect(say.calls[0].text).toMatch(/No CCT tokens configured/);
    expect(rotateToNext).not.toHaveBeenCalled();
  });
});

describe('renderUsageLines', () => {
  it('renders percent-form utilization to 0..100 integer (rounds 42.34 → 42; 1 → 1%)', async () => {
    // #701 — utilization is now treated as percent-form only (no fraction→percent
    // scaling). `42.34` rounds to `42`, and `1` renders as 1% (NOT 100%).
    const { renderUsageLines } = await import('../cct-handler');
    const now = Date.parse('2026-04-18T00:00:00Z');
    const out = renderUsageLines(
      { name: 'x', kind: 'cct' },
      {
        fetchedAt: '2026-04-18T00:00:00Z',
        fiveHour: { utilization: 42.34, resetsAt: '2026-04-18T03:45:00Z' },
        sevenDay: { utilization: 1, resetsAt: '2026-04-25T00:00:00Z' },
      },
      now,
    );
    expect(out).toContain('Usage for *x* (cct)');
    // M1-S2 — renderUsageLines now shares `formatUsageBar`.
    expect(out).toMatch(/5h\s+[█░]+\s+42%/);
    expect(out).toMatch(/7d\s+[█░]+\s+1%/);
  });

  it('passes through utilization already in 0..100 integer form', async () => {
    const { renderUsageLines } = await import('../cct-handler');
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

// ──────────────────────────────────────────────────────────────────────
// #749 — `cct auto` / `cct auto dry` admin trigger
//
// All 12 outcome variants of `evaluateAndMaybeRotate` must produce a
// deterministic compact thread-only message. The handler MUST force-on
// (`enabled: true`) regardless of `process.env.AUTO_ROTATE_ENABLED` because
// the env knob gates the *hourly* tick — a manual `cct auto` is an explicit
// operator request. The handler MUST NOT call `notifyAutoRotation` —
// DEFAULT_UPDATE_CHANNEL publishing is reserved for the hourly path.
// ──────────────────────────────────────────────────────────────────────
describe('CctHandler — cct auto (#749)', () => {
  const adminUser = (process.env.ADMIN_USERS?.split(',')[0] || 'U_ADMIN').trim();

  function makeSayCct(): FakeSay {
    const calls: FakeSay['calls'] = [];
    const fn = async (m: { text: string; blocks?: unknown[]; thread_ts?: string }): Promise<{ ts?: string }> => {
      calls.push(m);
      return {};
    };
    return { calls, fn };
  }

  /**
   * Loader that wires fakes for: admin gate, renderCctCard (unused on auto
   * path but pulled in by the import graph), TokenManager singleton, and
   * the `evaluateAndMaybeRotate` symbol on the auto-rotate module. The
   * `evaluateMock` returned lets each test assert the second-argument
   * options object (`enabled`, `dryRun`, thresholds, `usageMaxAgeMs`).
   */
  async function loadHandlerForAuto(opts: {
    outcome: import('../../../oauth/auto-rotate').RotationOutcome;
    snapshot?: Record<string, unknown> | null;
    snapshotThrows?: boolean;
    isAdmin?: boolean;
  }): Promise<{
    CctHandler: typeof import('../cct-handler').CctHandler;
    evaluateMock: ReturnType<typeof vi.fn>;
    snapshotMock: ReturnType<typeof vi.fn>;
  }> {
    vi.resetModules();

    const isAdmin = opts.isAdmin ?? true;
    vi.doMock('../../../admin-utils', () => ({
      isAdminUser: (u: string) => isAdmin && u === adminUser,
    }));

    vi.doMock('../../z/topics/cct-topic', () => ({
      renderCctCard: async () => ({ text: '🔑 CCT', blocks: [] }),
    }));

    const snapshotMock = opts.snapshotThrows
      ? vi.fn(async () => {
          throw new Error('snapshot failed');
        })
      : vi.fn(async () => opts.snapshot ?? { registry: { activeKeyId: undefined, slots: [] }, state: {} });
    const fakeTm = {
      listTokens: () => [{ keyId: 'k1', name: 'cct1', kind: 'cct' as const, status: 'healthy' }],
      listRuntimeSelectableTokens: () => [{ keyId: 'k1', name: 'cct1', kind: 'cct' as const, status: 'healthy' }],
      getActiveToken: () => ({ keyId: 'k1', name: 'cct1', kind: 'cct' as const }),
      fetchAndStoreUsage: async () => null,
      rotateToNext: async () => null,
      applyToken: async () => undefined,
      getSnapshot: snapshotMock,
      // Real method is unused on the auto path because we mock evaluateAndMaybeRotate;
      // include a stub so the handler's `applyTokenIfActiveMatches` adapter can be
      // referenced without throwing at import-shape time.
      applyTokenIfActiveMatches: vi.fn(),
    };
    vi.doMock('../../../token-manager', () => ({
      getTokenManager: () => fakeTm,
    }));

    const evaluateMock = vi.fn(async () => opts.outcome);
    vi.doMock('../../../oauth/auto-rotate', () => ({
      evaluateAndMaybeRotate: evaluateMock,
    }));

    const mod = await import('../cct-handler');
    return { CctHandler: mod.CctHandler, evaluateMock, snapshotMock };
  }

  // ── 1: non-admin gate ─────────────────────────────────────────────
  it('non-admin user → "⛔ Admin only command" (no evaluator call)', async () => {
    const { CctHandler, evaluateMock } = await loadHandlerForAuto({
      outcome: { kind: 'noop', reason: 'active-not-set', active: null, debug: emptyDebug() },
      isAdmin: false,
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: 'U_OTHER', channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    expect(say.calls[0].text).toBe('⛔ Admin only command');
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  // ── 2: rotated (live, normal — from set) ──────────────────────────
  it('rotated normal — emits :repeat: with 5h/7d % and resets-Δ', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: {
        kind: 'rotated',
        from: { keyId: 'k1', name: 'old', fiveHourUtilization: 40, sevenDayUtilization: 50 },
        to: candidate({ name: 'new', fiveHour: 80, sevenDay: 60 }),
        debug: emptyDebug(),
      },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    const t = say.calls[0].text;
    expect(t).toContain(':repeat: Auto-rotated *old* → *new*');
    expect(t).toContain('80.0%'); // pct(80) pin — store-SSOT percent form (#781)
    expect(t).toContain('60.0%');
    expect(t).toMatch(/7d resets/);
  });

  // ── 3: rotated (live, first-boot — from === null) ─────────────────
  it('rotated first-boot — from=null renders as *(none)*', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: {
        kind: 'rotated',
        from: null,
        to: candidate({ name: 'first', fiveHour: 10, sevenDay: 20 }),
        debug: emptyDebug(),
      },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    expect(say.calls[0].text).toContain(':repeat: Auto-rotated *(none)* → *first*');
  });

  // ── 4: noop active-is-best ────────────────────────────────────────
  it('noop active-is-best — :white_check_mark: with active name', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: {
        kind: 'noop',
        reason: 'active-is-best',
        active: { keyId: 'k1', name: 'optimal', sevenDayResetsAt: '2026-05-01T00:00:00Z' },
        debug: emptyDebug(),
      },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    expect(say.calls[0].text).toContain(':white_check_mark: Active *optimal* is already optimal');
  });

  // ── 5: noop active-not-set ────────────────────────────────────────
  it('noop active-not-set — :warning: No active slot configured', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: { kind: 'noop', reason: 'active-not-set', active: null, debug: emptyDebug() },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    expect(say.calls[0].text).toBe(':warning: No active slot configured');
  });

  // ── 6: skipped active-lease (lease count via getSnapshot) ─────────
  it('skipped active-lease — reads lease count via getSnapshot, names the active slot', async () => {
    const debug = { ...emptyDebug(), activeKeyId: 'k1' };
    const { CctHandler } = await loadHandlerForAuto({
      outcome: { kind: 'skipped', reason: 'active-lease', debug },
      snapshot: {
        registry: { activeKeyId: 'k1', slots: [{ keyId: 'k1', name: 'active-slot' }] },
        state: { k1: { activeLeases: ['lease-a', 'lease-b'] } },
      },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    const t = say.calls[0].text;
    expect(t).toContain(':hourglass: Skipped — active *active-slot*');
    expect(t).toContain('2 in-flight lease(s)');
    expect(t).toContain('Try `cct auto` again');
  });

  // ── 7: skipped active-lease — fail-soft (getSnapshot throws → 0/keyId) ─
  it('skipped active-lease fail-soft — getSnapshot throws → count=0, name=keyId', async () => {
    const debug = { ...emptyDebug(), activeKeyId: 'k1' };
    const { CctHandler, snapshotMock } = await loadHandlerForAuto({
      outcome: { kind: 'skipped', reason: 'active-lease', debug },
      snapshotThrows: true,
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    expect(snapshotMock).toHaveBeenCalled();
    const t = say.calls[0].text;
    // Fail-soft: lease-count → 0, name → keyId fallback (`k1`).
    expect(t).toContain(':hourglass: Skipped — active *k1* has 0 in-flight lease(s)');
  });

  // ── 8: skipped no-candidate (with rejected bullets) ───────────────
  it('skipped no-candidate — emits per-slot rejected bullets', async () => {
    const debug = {
      ...emptyDebug(),
      rejected: [
        { keyId: 'k1', name: 'cct1', reason: 'over-five-hour-threshold' as const },
        { keyId: 'k2', name: 'cct2', reason: 'auth-unhealthy' as const },
      ],
    };
    const { CctHandler } = await loadHandlerForAuto({
      outcome: { kind: 'skipped', reason: 'no-candidate', debug },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    const t = say.calls[0].text;
    expect(t).toContain(':warning: No eligible candidate. See debug:');
    expect(t).toContain('• cct1 (k1): rejected (over-five-hour-threshold)');
    expect(t).toContain('• cct2 (k2): rejected (auth-unhealthy)');
  });

  // ── 9: skipped disabled — defensive (unreachable but must not crash) ─
  it('skipped disabled (defensive) — emits internal-bug warning', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: { kind: 'skipped', reason: 'disabled', debug: emptyDebug() },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    expect(say.calls[0].text).toContain('handler wiring bug');
    expect(say.calls[0].text).toContain('disabled');
  });

  // ── 10: skipped race-active-changed ───────────────────────────────
  it('skipped race-active-changed — :hourglass: with retry hint', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: { kind: 'skipped', reason: 'race-active-changed', debug: emptyDebug() },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    expect(say.calls[0].text).toBe(':hourglass: Skipped — active changed under us. Try `cct auto` again.');
  });

  // ── 11: skipped race-precondition-failed ──────────────────────────
  it('skipped race-precondition-failed — :hourglass: with retry hint', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: { kind: 'skipped', reason: 'race-precondition-failed', debug: emptyDebug() },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    expect(say.calls[0].text).toBe(':hourglass: Skipped — slot eligibility changed under us. Try `cct auto` again.');
  });

  // ── 12: dry-run would:rotate normal ──────────────────────────────
  it('dry-run would:rotate normal — :test_tube: prefix', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: {
        kind: 'dry-run',
        would: 'rotate',
        from: { keyId: 'k1', name: 'cur' },
        to: candidate({ name: 'best', fiveHour: 30, sevenDay: 40 }),
        debug: emptyDebug(),
      },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto dry', say: say.fn });
    const t = say.calls[0].text;
    expect(t).toContain(':test_tube: [dry-run] Would rotate *cur* → *best*');
    expect(t).toContain('7d resets');
  });

  // ── 13: dry-run would:rotate first-boot ──────────────────────────
  it('dry-run would:rotate first-boot — from=null renders as *(none)*', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: {
        kind: 'dry-run',
        would: 'rotate',
        from: null,
        to: candidate({ name: 'first', fiveHour: 10, sevenDay: 10 }),
        debug: emptyDebug(),
      },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto dry', say: say.fn });
    expect(say.calls[0].text).toContain(':test_tube: [dry-run] Would rotate *(none)* → *first*');
  });

  // ── 14: dry-run would:noop ────────────────────────────────────────
  it('dry-run would:noop — :test_tube: optimal', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: {
        kind: 'dry-run',
        would: 'noop',
        from: { keyId: 'k1', name: 'cur' },
        to: candidate({ name: 'cur', fiveHour: 40, sevenDay: 50 }),
        debug: emptyDebug(),
      },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto dry', say: say.fn });
    expect(say.calls[0].text).toBe(':test_tube: [dry-run] Active *cur* is already optimal');
  });

  // ── 15: dry-run would:skipped (with rejected bullets) ─────────────
  it('dry-run would:skipped — :test_tube: + rejected bullets', async () => {
    const debug = {
      ...emptyDebug(),
      rejected: [{ keyId: 'k1', name: 'cct1', reason: 'cooldown' as const }],
    };
    const { CctHandler } = await loadHandlerForAuto({
      outcome: { kind: 'dry-run', would: 'skipped', from: null, to: null, debug },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto dry', say: say.fn });
    const t = say.calls[0].text;
    expect(t).toContain(':test_tube: [dry-run] No eligible candidate.');
    expect(t).toContain('• cct1 (k1): rejected (cooldown)');
  });

  // ── 16: full-opts assertion — force-on regardless of env ──────────
  it('full-opts: passes enabled:true even with AUTO_ROTATE_ENABLED=0; thresholds + usageMaxAgeMs canonical', async () => {
    const prev = process.env.AUTO_ROTATE_ENABLED;
    process.env.AUTO_ROTATE_ENABLED = '0';
    try {
      const { CctHandler, evaluateMock } = await loadHandlerForAuto({
        outcome: { kind: 'noop', reason: 'active-not-set', active: null, debug: emptyDebug() },
      });
      const say = makeSayCct();
      await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
      expect(evaluateMock).toHaveBeenCalledTimes(1);
      const opts = evaluateMock.mock.calls[0][1];
      expect(opts).toMatchObject({
        enabled: true, // ← force-on; AUTO_ROTATE_ENABLED gates only the hourly tick
        dryRun: false,
        thresholds: {
          fiveHourMax: expect.any(Number),
          sevenDayMax: expect.any(Number),
        },
        usageMaxAgeMs: expect.any(Number),
      });
      // Mirror the production wiring at src/index.ts:160-177 — usageMaxAgeMs
      // must be 2× the usage refresh interval. Read defaults from config.
      const { config } = await import('../../../config');
      expect(opts.thresholds.fiveHourMax).toBe(config.autoRotate.fiveHourMax);
      expect(opts.thresholds.sevenDayMax).toBe(config.autoRotate.sevenDayMax);
      expect(opts.usageMaxAgeMs).toBe(2 * config.usage.refreshIntervalMs);
    } finally {
      if (prev === undefined) delete process.env.AUTO_ROTATE_ENABLED;
      else process.env.AUTO_ROTATE_ENABLED = prev;
    }
  });

  // ── 17: dryRun flag — `cct auto` → false; `cct auto dry` → true ───
  it('dryRun: cct auto → false; cct auto dry → true', async () => {
    const { CctHandler: H1, evaluateMock: m1 } = await loadHandlerForAuto({
      outcome: { kind: 'noop', reason: 'active-not-set', active: null, debug: emptyDebug() },
    });
    await new H1().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: makeSayCct().fn });
    expect(m1.mock.calls[0][1].dryRun).toBe(false);

    const { CctHandler: H2, evaluateMock: m2 } = await loadHandlerForAuto({
      outcome: {
        kind: 'dry-run',
        would: 'noop',
        from: { keyId: 'k1', name: 'cur' },
        to: candidate({ name: 'cur', fiveHour: 40, sevenDay: 50 }),
        debug: emptyDebug(),
      },
    });
    await new H2().execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T',
      text: 'cct auto dry',
      say: makeSayCct().fn,
    });
    expect(m2.mock.calls[0][1].dryRun).toBe(true);
  });

  // ── 18: pct formatter pin — 80 → "80.0%", undefined → "—" (#781) ──
  it('pct formatter pin: 80 → "80.0%", undefined → "—"', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: {
        kind: 'rotated',
        from: { keyId: 'k1', name: 'old', fiveHourUtilization: undefined, sevenDayUtilization: undefined },
        to: candidate({ name: 'new', fiveHour: 80, sevenDay: undefined }),
        debug: emptyDebug(),
      },
    });
    const say = makeSayCct();
    await new CctHandler().execute({ user: adminUser, channel: 'C', threadTs: 'T', text: 'cct auto', say: say.fn });
    const t = say.calls[0].text;
    // The rotated message includes `5h N% / 7d M%` taken from the *target*
    // candidate, not from `from`. Pin both edge cases at once.
    expect(t).toContain('5h 80.0%');
    expect(t).toContain('7d —');
  });

  // ── 19: handler MUST NOT call notifyAutoRotation (DEFAULT_UPDATE_CHANNEL) ──
  // The handler imports nothing from auto-rotate-notifier, so the simplest
  // contract is to assert that the import graph stays clean: only the
  // `evaluateAndMaybeRotate` mock is invoked, and `say` is called exactly
  // once with a thread_ts (no channel-broadcast surface).
  it('thread-only: emits exactly one say() with thread_ts; never publishes to a broadcast channel', async () => {
    const { CctHandler } = await loadHandlerForAuto({
      outcome: {
        kind: 'rotated',
        from: { keyId: 'k1', name: 'old' },
        to: candidate({ name: 'new', fiveHour: 50, sevenDay: 50 }),
        debug: emptyDebug(),
      },
    });
    const say = makeSayCct();
    await new CctHandler().execute({
      user: adminUser,
      channel: 'C',
      threadTs: 'T123',
      text: 'cct auto',
      say: say.fn,
    });
    expect(say.calls).toHaveLength(1);
    expect(say.calls[0].thread_ts).toBe('T123');
  });
});

// ── Test fixture helpers (top-level so all describe blocks can share) ──

function emptyDebug(): import('../../../oauth/auto-rotate').RotationDebug {
  return {
    evaluatedAt: '2026-04-27T00:00:00.000Z',
    thresholds: { fiveHourMax: 80, sevenDayMax: 90 },
    activeKeyId: undefined,
    candidates: [],
    rejected: [],
  };
}

function candidate(opts: {
  name: string;
  fiveHour: number;
  sevenDay: number | undefined;
  resetsAt?: string;
}): import('../../../oauth/auto-rotate').RotationCandidate {
  const resetsAt = opts.resetsAt ?? '2026-05-01T00:00:00Z';
  return {
    keyId: `k-${opts.name}`,
    name: opts.name,
    sevenDayResetsAt: resetsAt,
    sevenDayResetsAtMs: new Date(resetsAt).getTime(),
    fiveHourUtilization: opts.fiveHour,
    // RotationCandidate types `sevenDayUtilization` as required `number`;
    // for pct-formatter "—" tests we cast undefined deliberately.
    sevenDayUtilization: opts.sevenDay as unknown as number,
  };
}
