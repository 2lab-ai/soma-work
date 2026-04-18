import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Contract tests for the slotId-keyed TokenManager rewrite.
// All tests drive a tmpdir-backed CctStore so we avoid pulling env-paths side effects.

// Hoisted mocks — must be declared before the SUT is imported inside each test.
const refreshClaudeCredentialsMock = vi.hoisted(() => vi.fn());
const fetchUsageMock = vi.hoisted(() => vi.fn());
const nextUsageBackoffMsMock = vi.hoisted(() =>
  vi.fn((ms: number | undefined) => (ms && ms > 0 ? ms * 2 : 2 * 60 * 1000)),
);

vi.mock('./oauth/refresher', async () => {
  const actual = await vi.importActual<typeof import('./oauth/refresher')>('./oauth/refresher');
  return {
    ...actual,
    refreshClaudeCredentials: refreshClaudeCredentialsMock,
  };
});

vi.mock('./oauth/usage', async () => {
  const actual = await vi.importActual<typeof import('./oauth/usage')>('./oauth/usage');
  return {
    ...actual,
    fetchUsage: fetchUsageMock,
    nextUsageBackoffMs: nextUsageBackoffMsMock,
  };
});

async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tm-test-'));
}

async function importSut() {
  vi.resetModules();
  const mod = await import('./token-manager');
  const storeMod = await import('./cct-store');
  return { mod, storeMod };
}

const VALID_OAUTH_SCOPES = ['user:profile', 'user:inference'];

/**
 * Resolve the CURRENT active-slot access token via the new lease API.
 * Pre-#575 this was checked by asserting on `process.env.CLAUDE_CODE_OAUTH_TOKEN`
 * (mirrored via `mirrorToEnv`). That mirror was removed to close a cross-tenant
 * race; consumers now obtain the token through
 * `credentials-manager#ensureActiveSlotAuth`, which wraps the TokenManager
 * primitive and resolves `accessToken` + `release()`. We use the same seam in
 * tests so the assertions exercise the real contract.
 */
async function activeAccessToken(tm: import('./token-manager').TokenManager): Promise<string> {
  const { ensureActiveSlotAuth } = await import('./credentials-manager');
  const lease = await ensureActiveSlotAuth(tm, 'test:activeAccessToken');
  try {
    return lease.accessToken;
  } finally {
    await lease.release();
  }
}

function makeOAuthCreds(
  overrides: Partial<import('./cct-store').OAuthCredentials> = {},
): import('./cct-store').OAuthCredentials {
  return {
    accessToken: 'sk-ant-oat01-abc',
    refreshToken: 'sk-ant-ort01-xyz',
    expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
    scopes: [...VALID_OAUTH_SCOPES],
    ...overrides,
  };
}

describe('TokenManager (slot-based)', () => {
  const originalEnv = { ...process.env };
  let tmp: string;

  beforeEach(async () => {
    vi.resetModules();
    refreshClaudeCredentialsMock.mockReset();
    fetchUsageMock.mockReset();
    nextUsageBackoffMsMock.mockClear();
    // Default: echo back with extended expiry
    refreshClaudeCredentialsMock.mockImplementation(async (current: import('./cct-store').OAuthCredentials) => ({
      ...current,
      accessToken: `${current.accessToken}-refreshed`,
      expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
    }));
    tmp = await makeTmp();
    process.env = { ...originalEnv };
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
    process.env.SOMA_CCT_DISABLE_ENV_SEED = 'true';
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // ── addSlot ────────────────────────────────────────────────

  describe('addSlot', () => {
    it('adds a setup_token slot with ULID slotId + createdAt', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();

      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-xxxxxxxx' });
      expect(slot.slotId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(slot.kind).toBe('setup_token');
      expect(slot.name).toBe('cct1');
      expect(new Date(slot.createdAt).toString()).not.toBe('Invalid Date');

      const snap = await store.load();
      expect(snap.registry.slots).toHaveLength(1);
      expect(snap.state[slot.slotId]).toEqual({ authState: 'healthy', activeLeases: [] });
    });

    it('adds an oauth_credentials slot when scopes include user:profile', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();

      const credentials = makeOAuthCreds();
      const slot = await tm.addSlot({
        name: 'ops',
        kind: 'oauth_credentials',
        credentials,
        acknowledgedConsumerTosRisk: true,
      });
      expect(slot.kind).toBe('oauth_credentials');
      if (slot.kind === 'oauth_credentials') {
        expect(slot.credentials.accessToken).toBe(credentials.accessToken);
        expect(slot.acknowledgedConsumerTosRisk).toBe(true);
      }
    });

    it('rejects oauth_credentials slot missing user:profile scope', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();

      await expect(
        tm.addSlot({
          name: 'bad',
          kind: 'oauth_credentials',
          credentials: makeOAuthCreds({ scopes: ['user:inference'] }),
          acknowledgedConsumerTosRisk: true,
        }),
      ).rejects.toThrow(/user:profile/);
    });

    it('auto-sets activeSlotId when first slot is added', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      const snap = await store.load();
      expect(snap.registry.activeSlotId).toBe(slot.slotId);
      expect(await activeAccessToken(tm)).toBe('sk-ant-oat01-aaa');
    });

    it('two parallel addSlot calls with the same name — one wins, one throws NAME_IN_USE', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const results = await Promise.allSettled([
        tm.addSlot({ name: 'shared', kind: 'setup_token', value: 'sk-ant-oat01-aaa' }),
        tm.addSlot({ name: 'shared', kind: 'setup_token', value: 'sk-ant-oat01-bbb' }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as Array<PromiseRejectedResult>;
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0].reason as Error).message).toMatch(/^NAME_IN_USE:shared$/);
      const snap = await store.load();
      expect(snap.registry.slots.filter((s: any) => s.name === 'shared')).toHaveLength(1);
    });
  });

  // ── applyToken ─────────────────────────────────────────────

  describe('applyToken', () => {
    it('updates activeSlotId + surfaces new access token via lease for setup_token', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'val-a' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'val-b' });

      await tm.applyToken(s2.slotId);
      const snap = await store.load();
      expect(snap.registry.activeSlotId).toBe(s2.slotId);
      expect(await activeAccessToken(tm)).toBe('val-b');

      await tm.applyToken(s1.slotId);
      const snap2 = await store.load();
      expect(snap2.registry.activeSlotId).toBe(s1.slotId);
      expect(await activeAccessToken(tm)).toBe('val-a');
    });

    it('surfaces oauth_credentials accessToken via lease', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'setup-a' });
      const s2 = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'sk-ant-oat01-ooo' }),
        acknowledgedConsumerTosRisk: true,
      });
      void s1;
      await tm.applyToken(s2.slotId);
      expect(await activeAccessToken(tm)).toBe('sk-ant-oat01-ooo');
    });
  });

  // ── rotateToNext ───────────────────────────────────────────

  describe('rotateToNext', () => {
    it('rotates to next healthy slot (skips cooling/revoked/tombstoned/refresh_failed)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });
      const s3 = await tm.addSlot({ name: 'cct3', kind: 'setup_token', value: 'v3' });
      const s4 = await tm.addSlot({ name: 'cct4', kind: 'setup_token', value: 'v4' });

      // s1 active. Mark s2 cooling, s3 revoked — expect rotate to s4.
      await store.mutate((snap) => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        snap.state[s2.slotId].cooldownUntil = future;
        snap.state[s3.slotId].authState = 'revoked';
      });
      const result = await tm.rotateToNext();
      expect(result).not.toBeNull();
      expect(result?.slotId).toBe(s4.slotId);
      const cur = tm.getActiveToken();
      expect(cur?.slotId).toBe(s4.slotId);
      expect(await activeAccessToken(tm)).toBe('v4');
      void s1;
    });

    it('returns null when no other slot available', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const result = await tm.rotateToNext();
      expect(result).toBeNull();
    });
  });

  // ── rotateOnRateLimit ──────────────────────────────────────

  describe('rotateOnRateLimit', () => {
    it('stamps rateLimitedAt + source + cooldownUntil on current, rotates to next', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });

      const cooldownUntilMs = Date.now() + 60 * 60 * 1000;
      const cooldownUntil = new Date(cooldownUntilMs).toISOString();
      await tm.rotateOnRateLimit('limit hit', {
        source: 'response_header',
        cooldownMinutes: 60,
      });

      const snap = await store.load();
      expect(snap.state[s1.slotId].rateLimitedAt).toBeDefined();
      expect(snap.state[s1.slotId].rateLimitSource).toBe('response_header');
      expect(snap.state[s1.slotId].cooldownUntil).toBeDefined();
      // within 5 seconds of the computed cooldownUntil
      const actual = new Date(snap.state[s1.slotId].cooldownUntil as string).getTime();
      expect(Math.abs(actual - cooldownUntilMs)).toBeLessThan(5000);
      expect(snap.registry.activeSlotId).toBe(s2.slotId);
      void cooldownUntil;
    });

    it('does NOT overwrite rateLimitedAt on a second call within cooldown window', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });

      await tm.rotateOnRateLimit('first', { source: 'response_header', cooldownMinutes: 60 });
      const snap1 = await store.load();
      const firstAt = snap1.state[s1.slotId].rateLimitedAt;
      expect(firstAt).toBeDefined();

      // Simulate a second rate-limit hit for the same slot while still in cooldown.
      // We need to re-activate s1 to call rotate again.
      await tm.applyToken(s1.slotId);
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60 });
      const snap2 = await store.load();
      expect(snap2.state[s1.slotId].rateLimitedAt).toBe(firstAt);
    });

    it('defaults to 60 minute cooldown when cooldownMinutes omitted', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });

      const beforeMs = Date.now();
      await tm.rotateOnRateLimit('limit', { source: 'manual' });
      const snap = await store.load();
      const until = new Date(snap.state[s1.slotId].cooldownUntil as string).getTime();
      // ~60 min from "now"
      expect(until).toBeGreaterThan(beforeMs + 59 * 60 * 1000);
      expect(until).toBeLessThan(beforeMs + 61 * 60 * 1000);
    });

    it('recordRateLimitHint refreshes rateLimitedAt once it ages past the 5h window (no cooldownUntil)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });

      // Seed a rate-limit hint with NO cooldownUntil (simulates a manual hint
      // or a response_header hint where cooldown was not parseable).
      await tm.recordRateLimitHint(s1.slotId, 'response_header');
      const firstAt = (await store.load()).state[s1.slotId].rateLimitedAt;
      expect(firstAt).toBeDefined();

      // Second hint a few seconds later — should NOT overwrite.
      await new Promise((r) => setTimeout(r, 5));
      await tm.recordRateLimitHint(s1.slotId, 'response_header');
      const secondAt = (await store.load()).state[s1.slotId].rateLimitedAt;
      expect(secondAt).toBe(firstAt);

      // Age the stored timestamp past the 5h window by rewriting it.
      await store.mutate((snap) => {
        snap.state[s1.slotId].rateLimitedAt = new Date(Date.now() - (5 * 60 + 1) * 60 * 1000).toISOString();
      });

      await tm.recordRateLimitHint(s1.slotId, 'error_string');
      const thirdAt = (await store.load()).state[s1.slotId].rateLimitedAt as string;
      expect(new Date(thirdAt).getTime()).toBeGreaterThan(new Date(firstAt as string).getTime());
    });
  });

  // ── Leases ────────────────────────────────────────────────

  describe('lease lifecycle', () => {
    it('acquireLease on a healthy active slot appends a Lease with TTL', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });

      const beforeMs = Date.now();
      const acquired = await tm.acquireLease('stream-executor:C1:t1', 60_000);
      expect(acquired.leaseId).toBeTruthy();
      expect(acquired.slotId).toBe(s1.slotId);
      expect(acquired.kind).toBe('setup_token');
      expect(acquired.name).toBe('cct1');
      expect(acquired.accessToken).toBe('v1');

      // The persisted Lease carries ownerTag + expiresAt; AcquiredLease does not.
      const snap = await store.load();
      expect(snap.state[s1.slotId].activeLeases).toHaveLength(1);
      const persisted = snap.state[s1.slotId].activeLeases[0];
      expect(persisted.leaseId).toBe(acquired.leaseId);
      expect(persisted.ownerTag).toBe('stream-executor:C1:t1');
      const ttl = new Date(persisted.expiresAt).getTime() - beforeMs;
      expect(ttl).toBeGreaterThan(59_000);
      expect(ttl).toBeLessThan(61_000);
    });

    it('heartbeatLease extends expiresAt', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const acquired = await tm.acquireLease('svc', 2_000);
      const snap0 = await store.load();
      const activeId0 = snap0.registry.activeSlotId!;
      const firstExp = new Date(snap0.state[activeId0].activeLeases[0].expiresAt).getTime();

      await new Promise((r) => setTimeout(r, 50));
      await tm.heartbeatLease(acquired.leaseId);
      const snap = await store.load();
      const active = snap.registry.activeSlotId;
      if (!active) throw new Error('active missing');
      const newExp = new Date(snap.state[active].activeLeases[0].expiresAt).getTime();
      expect(newExp).toBeGreaterThan(firstExp);
    });

    it('heartbeatLease rejects unknown leaseId', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      await expect(tm.heartbeatLease('nonexistent')).rejects.toThrow();
    });

    it('releaseLease removes the lease; idempotent', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const lease = await tm.acquireLease('svc', 60_000);
      await tm.releaseLease(lease.leaseId);
      await tm.releaseLease(lease.leaseId); // idempotent
      const snap = await store.load();
      expect(snap.state[s1.slotId].activeLeases).toHaveLength(0);
    });

    it('reapExpiredLeases removes leases whose expiresAt < now', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      // Manually inject an expired lease
      await store.mutate((snap) => {
        snap.state[s1.slotId].activeLeases = [
          {
            leaseId: 'stale',
            ownerTag: 'x',
            acquiredAt: new Date(Date.now() - 60_000).toISOString(),
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          },
        ];
      });
      await tm.reapExpiredLeases();
      const snap = await store.load();
      expect(snap.state[s1.slotId].activeLeases).toHaveLength(0);
    });

    it('acquireLease throws when no healthy slot exists', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await expect(tm.acquireLease('svc', 60_000)).rejects.toThrow();
    });
  });

  // ── removeSlot + tombstone/drain ───────────────────────────

  describe('removeSlot', () => {
    it('fully removes a slot that has no active leases', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });
      const result = await tm.removeSlot(s2.slotId);
      expect(result.removed).toBe(true);
      const snap = await store.load();
      expect(snap.registry.slots).toHaveLength(1);
      expect(snap.state[s2.slotId]).toBeUndefined();
      expect(snap.registry.activeSlotId).toBe(s1.slotId);
    });

    it('tombstones a slot that has active leases; reaper later fully removes it', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });
      await tm.applyToken(s1.slotId);
      const lease = await tm.acquireLease('svc', 60_000);

      const result = await tm.removeSlot(s1.slotId);
      expect(result.removed).toBe(false);
      expect(result.pendingDrain).toBe(true);

      let snap = await store.load();
      expect(snap.state[s1.slotId].tombstoned).toBe(true);
      // active should be rotated away from tombstoned
      expect(snap.registry.activeSlotId).toBe(s2.slotId);

      // Release the lease, then run reaper
      await tm.releaseLease(lease.leaseId);
      await tm.reapExpiredLeases();
      snap = await store.load();
      expect(snap.registry.slots.find((s) => s.slotId === s1.slotId)).toBeUndefined();
      expect(snap.state[s1.slotId]).toBeUndefined();
    });

    it('force removes a slot even with active leases', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });
      const lease = await tm.acquireLease('svc', 60_000);
      void lease;
      const result = await tm.removeSlot(s2.slotId, { force: true });
      // lease was on active s2 (no rotation during addSlot for s2 since s1 was first)
      // re-read and assert s2 is gone
      void result;
      const snap = await store.load();
      expect(snap.registry.slots.find((s) => s.slotId === s2.slotId)).toBeUndefined();
    });
  });

  // ── renameSlot ────────────────────────────────────────────

  describe('renameSlot', () => {
    it('updates name in the registry', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      await tm.renameSlot(s1.slotId, 'production');
      const snap = await store.load();
      expect(snap.registry.slots[0].name).toBe('production');
    });
  });

  // ── getValidAccessToken ───────────────────────────────────

  describe('getValidAccessToken', () => {
    it('returns the setup_token value directly', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'a', kind: 'setup_token', value: 'sk-ant-oat01-xyz' });
      const token = await tm.getValidAccessToken(s.slotId);
      expect(token).toBe('sk-ant-oat01-xyz');
      expect(refreshClaudeCredentialsMock).not.toHaveBeenCalled();
    });

    it('returns current accessToken without refresh when expiresAtMs > now + 7h', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({
          accessToken: 'sk-ant-oat01-fresh',
          expiresAtMs: Date.now() + 12 * 60 * 60 * 1000,
        }),
        acknowledgedConsumerTosRisk: true,
      });
      const token = await tm.getValidAccessToken(s.slotId);
      expect(token).toBe('sk-ant-oat01-fresh');
      expect(refreshClaudeCredentialsMock).not.toHaveBeenCalled();
    });

    it('triggers refresh when expiresAtMs < now + 7h and persists new creds', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({
          accessToken: 'sk-ant-oat01-stale',
          expiresAtMs: Date.now() + 60 * 60 * 1000,
        }),
        acknowledgedConsumerTosRisk: true,
      });
      const token = await tm.getValidAccessToken(s.slotId);
      expect(token).toBe('sk-ant-oat01-stale-refreshed');
      expect(refreshClaudeCredentialsMock).toHaveBeenCalledTimes(1);

      const snap = await store.load();
      const slot = snap.registry.slots[0];
      if (slot.kind !== 'oauth_credentials') throw new Error('expected oauth slot');
      expect(slot.credentials.accessToken).toBe('sk-ant-oat01-stale-refreshed');
    });

    it('dedupes 10 concurrent refreshes to a single refresh call', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({
          accessToken: 'sk-ant-oat01-stale',
          expiresAtMs: Date.now() + 60 * 60 * 1000,
        }),
        acknowledgedConsumerTosRisk: true,
      });
      let resolveRefresh: (v: import('./cct-store').OAuthCredentials) => void = () => {};
      const refreshPromise = new Promise<import('./cct-store').OAuthCredentials>((resolve) => {
        resolveRefresh = resolve;
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockImplementation(async (_current: import('./cct-store').OAuthCredentials) => {
        return refreshPromise;
      });

      const p = Promise.all(Array.from({ length: 10 }, () => tm.getValidAccessToken(s.slotId)));
      // Give refreshes a microtask to register into the dedupe map
      await new Promise((r) => setTimeout(r, 10));
      resolveRefresh({
        accessToken: 'sk-ant-oat01-new',
        refreshToken: 'sk-ant-ort01-new',
        expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
        scopes: VALID_OAUTH_SCOPES,
      });
      const results = await p;
      expect(results.every((t) => t === 'sk-ant-oat01-new')).toBe(true);
      expect(refreshClaudeCredentialsMock).toHaveBeenCalledTimes(1);
    });

    it('401 from refresh → authState=refresh_failed', async () => {
      const { mod, storeMod } = await importSut();
      const { OAuthRefreshError } = await import('./oauth/refresher');
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ expiresAtMs: Date.now() + 60 * 1000 }),
        acknowledgedConsumerTosRisk: true,
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockRejectedValue(new OAuthRefreshError(401, '', 'unauthorized'));
      await expect(tm.getValidAccessToken(s.slotId)).rejects.toThrow();
      const snap = await store.load();
      expect(snap.state[s.slotId].authState).toBe('refresh_failed');
    });

    it('403 from refresh → authState=revoked', async () => {
      const { mod, storeMod } = await importSut();
      const { OAuthRefreshError } = await import('./oauth/refresher');
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ expiresAtMs: Date.now() + 60 * 1000 }),
        acknowledgedConsumerTosRisk: true,
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockRejectedValue(new OAuthRefreshError(403, '', 'forbidden'));
      await expect(tm.getValidAccessToken(s.slotId)).rejects.toThrow();
      const snap = await store.load();
      expect(snap.state[s.slotId].authState).toBe('revoked');
    });
  });

  // ── fetchAndStoreUsage ────────────────────────────────────

  describe('fetchAndStoreUsage', () => {
    it('honours nextUsageFetchAllowedAt (returns null when too early)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      await store.mutate((snap) => {
        snap.state[s.slotId].nextUsageFetchAllowedAt = new Date(Date.now() + 60_000).toISOString();
      });
      const result = await tm.fetchAndStoreUsage(s.slotId);
      expect(result).toBeNull();
      expect(fetchUsageMock).not.toHaveBeenCalled();
    });

    it('persists usage snapshot on success', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      fetchUsageMock.mockResolvedValueOnce({
        snapshot: {
          fetchedAt: new Date().toISOString(),
          fiveHour: { utilization: 0.5, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 2 * 60 * 1000,
      });
      const result = await tm.fetchAndStoreUsage(s.slotId);
      expect(result).not.toBeNull();
      expect(result?.fiveHour?.utilization).toBe(0.5);
      const snap = await store.load();
      expect(snap.state[s.slotId].usage?.fiveHour?.utilization).toBe(0.5);
      expect(snap.state[s.slotId].lastUsageFetchedAt).toBeDefined();
    });

    it('401 → refresh → retry once → success', async () => {
      const { mod, storeMod } = await importSut();
      const { UsageFetchError } = await import('./oauth/usage');
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ expiresAtMs: Date.now() + 60 * 1000 }),
        acknowledgedConsumerTosRisk: true,
      });
      fetchUsageMock.mockRejectedValueOnce(new UsageFetchError(401, '', 'unauth'));
      fetchUsageMock.mockResolvedValueOnce({
        snapshot: {
          fetchedAt: new Date().toISOString(),
          fiveHour: { utilization: 0.1, resetsAt: new Date().toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 120_000,
      });
      const result = await tm.fetchAndStoreUsage(s.slotId);
      expect(result).not.toBeNull();
      expect(refreshClaudeCredentialsMock).toHaveBeenCalled();
    });

    it('403 → markAuthState revoked', async () => {
      const { mod, storeMod } = await importSut();
      const { UsageFetchError } = await import('./oauth/usage');
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      fetchUsageMock.mockRejectedValueOnce(new UsageFetchError(403, '', 'forbidden'));
      const result = await tm.fetchAndStoreUsage(s.slotId);
      expect(result).toBeNull();
      const snap = await store.load();
      expect(snap.state[s.slotId].authState).toBe('revoked');
    });

    it('429 → bumps nextUsageFetchAllowedAt via backoff', async () => {
      const { mod, storeMod } = await importSut();
      const { UsageFetchError } = await import('./oauth/usage');
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      fetchUsageMock.mockRejectedValueOnce(new UsageFetchError(429, '', 'too many'));
      const beforeMs = Date.now();
      const result = await tm.fetchAndStoreUsage(s.slotId);
      expect(result).toBeNull();
      const snap = await store.load();
      const next = snap.state[s.slotId].nextUsageFetchAllowedAt;
      expect(next).toBeDefined();
      const nextMs = new Date(next as string).getTime();
      expect(nextMs).toBeGreaterThan(beforeMs);
    });
  });

  // ── markAuthState ──────────────────────────────────────────

  describe('markAuthState', () => {
    it('updates authState for a slot', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      await tm.markAuthState(s.slotId, 'revoked');
      const snap = await store.load();
      expect(snap.state[s.slotId].authState).toBe('revoked');
    });
  });

  // ── listTokens + getActiveToken ────────────────────────────

  describe('listTokens / getActiveToken', () => {
    it('returns slot summaries with derived status', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });
      await tm.markAuthState(s1.slotId, 'revoked');
      const list = tm.listTokens();
      expect(list).toHaveLength(2);
      const revoked = list.find((t) => t.slotId === s1.slotId);
      expect(revoked?.status).toContain('revoked');

      const active = tm.getActiveToken();
      expect(active?.slotId).toBe(s1.slotId);
    });
  });

  // ── Legacy env seeding ─────────────────────────────────────

  describe('legacy env seeding', () => {
    it('seeds slots from CLAUDE_CODE_OAUTH_TOKEN_LIST', async () => {
      process.env.SOMA_CCT_DISABLE_ENV_SEED = 'false';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai2:sk-ant-oat01-a,ai3:sk-ant-oat01-b';
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.cooldownsRestored;
      const snap = await store.load();
      expect(snap.registry.slots).toHaveLength(2);
      expect(snap.registry.slots[0].name).toBe('ai2');
      expect(snap.registry.slots[1].name).toBe('ai3');
      if (snap.registry.slots[0].kind !== 'setup_token') throw new Error('expected setup_token');
      expect(snap.registry.slots[0].value).toBe('sk-ant-oat01-a');
      expect(snap.registry.activeSlotId).toBe(snap.registry.slots[0].slotId);
    });

    it('falls back to cctN names when name: omitted', async () => {
      process.env.SOMA_CCT_DISABLE_ENV_SEED = 'false';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'sk-ant-oat01-a,sk-ant-oat01-b';
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const snap = await store.load();
      expect(snap.registry.slots.map((s) => s.name)).toEqual(['cct1', 'cct2']);
    });

    it('falls back to CLAUDE_CODE_OAUTH_TOKEN when list not set', async () => {
      process.env.SOMA_CCT_DISABLE_ENV_SEED = 'false';
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-only';
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const snap = await store.load();
      expect(snap.registry.slots).toHaveLength(1);
      expect(snap.registry.slots[0].name).toBe('legacy');
    });

    it('skips seeding when SOMA_CCT_DISABLE_ENV_SEED=true', async () => {
      process.env.SOMA_CCT_DISABLE_ENV_SEED = 'true';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'sk-ant-oat01-a';
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const snap = await store.load();
      expect(snap.registry.slots).toHaveLength(0);
    });

    it('sets activeSlotId when registry has slots but no active (e.g. after load)', async () => {
      // Pre-populate the store WITHOUT activeSlotId, then init and expect it to self-heal.
      const storePath = path.join(tmp, 'cct-store.json');
      const { storeMod } = await importSut();
      const bootstrap = new storeMod.CctStore(storePath);
      await bootstrap.mutate((snap) => {
        const slotId = '01HZZZAAAA0000000000000111';
        snap.registry.slots.push({
          slotId,
          name: 'preexisting',
          kind: 'setup_token',
          value: 'sk-ant-oat01-zzz',
          createdAt: new Date().toISOString(),
        });
        snap.state[slotId] = { authState: 'healthy', activeLeases: [] };
      });

      process.env.SOMA_CCT_DISABLE_ENV_SEED = 'true';
      const { mod } = await importSut();
      const store = new storeMod.CctStore(storePath);
      const tm = new mod.TokenManager(store);
      await tm.init();
      const snap = await store.load();
      expect(snap.registry.activeSlotId).toBe('01HZZZAAAA0000000000000111');
      expect(await activeAccessToken(tm)).toBe('sk-ant-oat01-zzz');
    });
  });

  // ── Legacy token-cooldowns.json migration round-trip ──────

  describe('token-cooldowns.json migration round-trip', () => {
    it('applies legacy cooldowns to seeded slots by name', async () => {
      process.env.SOMA_CCT_DISABLE_ENV_SEED = 'false';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai2:sk-ant-oat01-a,ai3:sk-ant-oat01-b';
      const legacyPath = path.join(tmp, 'token-cooldowns.json');
      const cooldownUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      // Use the 'cooldowns' map shape
      await fs.writeFile(legacyPath, JSON.stringify({ cooldowns: { ai2: { until: cooldownUntil } } }), 'utf-8');

      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.cooldownsRestored;

      const snap = await store.load();
      const ai2Slot = snap.registry.slots.find((s) => s.name === 'ai2');
      if (!ai2Slot) throw new Error('ai2 slot missing');
      expect(snap.state[ai2Slot.slotId].cooldownUntil).toBe(cooldownUntil);

      // The legacy file should have been renamed by the migrator
      const siblings = await fs.readdir(tmp);
      expect(siblings.find((e) => e.startsWith('token-cooldowns.json.migrated.'))).toBeTruthy();
    });
  });

  // ── getTokenManager factory ────────────────────────────────

  describe('getTokenManager', () => {
    it('returns a singleton instance', async () => {
      const { mod } = await importSut();
      const a = mod.getTokenManager();
      const b = mod.getTokenManager();
      expect(a).toBe(b);
    });
  });

  // ── Reaper timer ──────────────────────────────────────────

  describe('reaper timer', () => {
    it('stop() clears the interval (no throw)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init({ startReaper: true, reaperIntervalMs: 50 });
      tm.stop();
      // If stop() did not clear the interval the process would hang; we just
      // assert no throw and re-calling stop() is a no-op.
      tm.stop();
      expect(true).toBe(true);
    });
  });

  // ── schema-v2 per-slot configDir lifecycle ────────────────────

  describe('schema-v2 configDir lifecycle', () => {
    it('acquireLease returns the new AcquiredLease shape (leaseId/slotId/name/kind/accessToken/configDir)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({
          accessToken: 'sk-ant-oat01-fresh',
          expiresAtMs: Date.now() + 12 * 60 * 60 * 1000,
        }),
        acknowledgedConsumerTosRisk: true,
      });
      const acquired = await tm.acquireLease('t', 60_000);
      expect(acquired.leaseId).toBeTruthy();
      expect(acquired.slotId).toBe(s.slotId);
      expect(acquired.name).toBe('oauth');
      expect(acquired.kind).toBe('oauth_credentials');
      expect(acquired.accessToken).toBe('sk-ant-oat01-fresh');
      expect(acquired.configDir).toBe(path.join(tmp, 'cct-store.dirs', s.slotId));
    });

    it('acquireLease retries when the picked slot is tombstoned between mutate and revalidate', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });

      // Intercept `load` to tombstone s1 on the first post-mutate read — the
      // retry loop should then pick s2 and succeed.
      const originalLoad = store.load.bind(store);
      let tombstonedOnce = false;
      const loadSpy = vi.spyOn(store, 'load').mockImplementation(async () => {
        const snap = await originalLoad();
        if (!tombstonedOnce && snap.state[s1.slotId]?.activeLeases.length) {
          tombstonedOnce = true;
          // Mutate the snapshot the caller will see — but persist it too so
          // the subsequent retry observes the tombstone.
          snap.state[s1.slotId] = { ...snap.state[s1.slotId], tombstoned: true };
          await store.mutate((s) => {
            s.state[s1.slotId] = { ...s.state[s1.slotId], tombstoned: true };
          });
        }
        return snap;
      });

      const acquired = await tm.acquireLease('svc', 60_000);
      expect(acquired.slotId).toBe(s2.slotId);
      loadSpy.mockRestore();
    });

    it('acquireLease throws NoEligibleSlotError after 3 retries', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });

      // Flip a flag to "revalidate mode" for the single load() immediately
      // after each mutate commit. We detect "just after mutate" by wrapping
      // mutate itself to set the flag post-commit, then the NEXT load call
      // alters its returned view (dropping the slot) and clears the flag.
      const originalMutate = store.mutate.bind(store);
      const originalLoad = store.load.bind(store);
      let revalidateNext = false;
      vi.spyOn(store, 'mutate').mockImplementation(async (fn: any) => {
        const result = await originalMutate(fn);
        revalidateNext = true;
        return result;
      });
      vi.spyOn(store, 'load').mockImplementation(async () => {
        const snap = await originalLoad();
        if (revalidateNext) {
          revalidateNext = false;
          snap.registry.slots = [];
        }
        return snap;
      });

      await expect(tm.acquireLease('svc', 60_000)).rejects.toMatchObject({ name: 'NoEligibleSlotError' });
      vi.restoreAllMocks();
    });

    it('acquireLease refresh error bubbles without retry', async () => {
      const { mod, storeMod } = await importSut();
      const { OAuthRefreshError } = await import('./oauth/refresher');
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ expiresAtMs: Date.now() + 60 * 1000 }),
        acknowledgedConsumerTosRisk: true,
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockRejectedValue(new OAuthRefreshError(401, '', 'unauthorized'));
      await expect(tm.acquireLease('svc', 60_000)).rejects.toThrow();
      expect(refreshClaudeCredentialsMock).toHaveBeenCalledTimes(1);
    });

    it('acquireLease does not leak stale leases on retry (released before retrying)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });

      const originalLoad = store.load.bind(store);
      let tombstonedOnce = false;
      const loadSpy = vi.spyOn(store, 'load').mockImplementation(async () => {
        const snap = await originalLoad();
        if (!tombstonedOnce && snap.state[s1.slotId]?.activeLeases.length) {
          tombstonedOnce = true;
          await store.mutate((s) => {
            s.state[s1.slotId] = { ...s.state[s1.slotId], tombstoned: true };
          });
          snap.state[s1.slotId] = { ...snap.state[s1.slotId], tombstoned: true };
        }
        return snap;
      });

      const acquired = await tm.acquireLease('svc', 60_000);
      expect(acquired.slotId).toBe(s2.slotId);
      loadSpy.mockRestore();

      // After the retry, the ORIGINAL (stale) lease must not be lingering on s1.
      const snap = await store.load();
      const s1Leases = snap.state[s1.slotId]?.activeLeases ?? [];
      expect(s1Leases.map((l: any) => l.leaseId)).not.toContain(acquired.leaseId);
      expect(s1Leases).toHaveLength(0);
    });

    it('init throws when store.upgradeIfNeeded fails (fail-fast, never persists unprovisioned configDir)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const upgradeErr = new Error('upgrade-boom: simulated mkdir denied');
      vi.spyOn(store, 'upgradeIfNeeded').mockRejectedValue(upgradeErr);
      const tm = new mod.TokenManager(store);
      await expect(tm.init()).rejects.toThrow(/upgrade-boom/);
      // Regression guard: no downstream mutate must have landed, so the
      // on-disk file should not exist (or be empty v2). If the init had
      // swallowed the error, ensureActiveSlot() would have written a v2
      // snapshot via mutate(), creating the file on disk.
      await expect(fs.stat(path.join(tmp, 'cct-store.json'))).rejects.toThrow();
    });

    it('acquireLease retries when slot goes refresh_failed mid-flight (isEligible revalidation)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });

      const originalLoad = store.load.bind(store);
      let flipped = false;
      vi.spyOn(store, 'load').mockImplementation(async () => {
        const snap = await originalLoad();
        if (!flipped && snap.state[s1.slotId]?.activeLeases.length) {
          flipped = true;
          await store.mutate((s) => {
            s.state[s1.slotId] = { ...s.state[s1.slotId], authState: 'refresh_failed' };
          });
          snap.state[s1.slotId] = { ...snap.state[s1.slotId], authState: 'refresh_failed' };
        }
        return snap;
      });

      const acquired = await tm.acquireLease('svc', 60_000);
      // The retry must have routed around the refresh_failed slot — the old
      // ad hoc subset (only tombstoned/revoked) would have returned s1.
      expect(acquired.slotId).toBe(s2.slotId);
    });

    it('acquireLease retries when slot enters cooldown mid-flight (isEligible revalidation)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });

      const originalLoad = store.load.bind(store);
      let flipped = false;
      vi.spyOn(store, 'load').mockImplementation(async () => {
        const snap = await originalLoad();
        if (!flipped && snap.state[s1.slotId]?.activeLeases.length) {
          flipped = true;
          const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
          await store.mutate((s) => {
            s.state[s1.slotId] = { ...s.state[s1.slotId], cooldownUntil };
          });
          snap.state[s1.slotId] = { ...snap.state[s1.slotId], cooldownUntil };
        }
        return snap;
      });

      const acquired = await tm.acquireLease('svc', 60_000);
      expect(acquired.slotId).toBe(s2.slotId);
    });

    it('addSlot(oauth) provisions the private configDir with 0o700 and stores it on the slot', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      expect(s.kind).toBe('oauth_credentials');
      if (s.kind !== 'oauth_credentials') return;
      const expectedDir = path.join(tmp, 'cct-store.dirs', s.slotId);
      expect(s.configDir).toBe(expectedDir);
      const st = await fs.stat(expectedDir);
      expect(st.isDirectory()).toBe(true);
      if (process.platform !== 'win32') {
        expect(st.mode & 0o077).toBe(0);
      }
    });

    it('addSlot(oauth) cleans up orphaned configDir when mutate fails', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      // Seed a slot with the same name so the second addSlot will trip NAME_IN_USE.
      await tm.addSlot({
        name: 'dup',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      const dirsRoot = path.join(tmp, 'cct-store.dirs');
      const before = (await fs.readdir(dirsRoot).catch(() => [])).length;
      await expect(
        tm.addSlot({
          name: 'dup',
          kind: 'oauth_credentials',
          credentials: makeOAuthCreds({ accessToken: 'sk-ant-oat01-other' }),
          acknowledgedConsumerTosRisk: true,
        }),
      ).rejects.toThrow(/NAME_IN_USE/);
      // No orphan dir left behind from the failed second attempt.
      const after = (await fs.readdir(dirsRoot).catch(() => [])).length;
      expect(after).toBe(before);
    });

    it('addSlot(setup_token) does NOT create a configDir on disk', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({ name: 'plain', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      const dirsRoot = path.join(tmp, 'cct-store.dirs');
      // Either the root was never created, or it exists but is empty.
      const entries = await fs.readdir(dirsRoot).catch(() => []);
      expect(entries).toHaveLength(0);
    });

    it('removeSlot force: zero-lease oauth slot dir is rm-rfd', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      if (s.kind !== 'oauth_credentials') throw new Error('expected oauth');
      const dir = s.configDir!;
      expect((await fs.stat(dir)).isDirectory()).toBe(true);
      await tm.removeSlot(s.slotId, { force: true });
      await expect(fs.stat(dir)).rejects.toThrow();
    });

    it('removeSlot force: ENOENT on the configDir is silently swallowed (no throw)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      if (s.kind !== 'oauth_credentials') throw new Error('expected oauth');
      // Pre-delete the configDir to simulate external cleanup.
      await fs.rm(s.configDir!, { recursive: true, force: true });
      // removeSlot force must not throw even though the dir is already gone.
      await expect(tm.removeSlot(s.slotId, { force: true })).resolves.toEqual({ removed: true });
    });

    it('removeSlot tombstone → reap path also cleans the oauth configDir', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });
      void s2;
      if (s1.kind !== 'oauth_credentials') throw new Error('expected oauth');
      const dir = s1.configDir!;

      await tm.applyToken(s1.slotId);
      const acquired = await tm.acquireLease('svc', 60_000);

      const result = await tm.removeSlot(s1.slotId);
      expect(result.removed).toBe(false);
      expect(result.pendingDrain).toBe(true);
      // Dir still present while drain is in flight.
      expect((await fs.stat(dir)).isDirectory()).toBe(true);

      await tm.releaseLease(acquired.leaseId);
      await tm.reapExpiredLeases();

      // Dir cleaned up by the reaper.
      await expect(fs.stat(dir)).rejects.toThrow();
    });
  });
});
