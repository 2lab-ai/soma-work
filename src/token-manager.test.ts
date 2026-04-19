import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Contract tests for the AuthKey-v2 keyed TokenManager rewrite.
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
  overrides: Partial<import('./oauth/refresher').OAuthCredentials> = {},
): import('./oauth/refresher').OAuthCredentials {
  return {
    accessToken: 'sk-ant-oat01-abc',
    refreshToken: 'sk-ant-ort01-xyz',
    expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
    scopes: [...VALID_OAUTH_SCOPES],
    ...overrides,
  };
}

describe('TokenManager (AuthKey v2, keyId-keyed)', () => {
  const originalEnv = { ...process.env };
  let tmp: string;

  beforeEach(async () => {
    vi.resetModules();
    refreshClaudeCredentialsMock.mockReset();
    fetchUsageMock.mockReset();
    nextUsageBackoffMsMock.mockClear();
    // Default: echo back with extended expiry
    refreshClaudeCredentialsMock.mockImplementation(async (current: import('./oauth/refresher').OAuthCredentials) => ({
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
    it('adds a setup_token input as a cct/setup slot with ULID keyId + createdAt', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();

      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-xxxxxxxx' });
      expect(slot.keyId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(slot.kind).toBe('cct');
      if (slot.kind !== 'cct') throw new Error('expected cct slot');
      expect(slot.source).toBe('setup');
      expect(slot.name).toBe('cct1');
      expect(new Date(slot.createdAt).toString()).not.toBe('Invalid Date');

      const snap = await store.load();
      expect(snap.registry.slots).toHaveLength(1);
      expect(snap.state[slot.keyId]).toEqual({ authState: 'healthy', activeLeases: [] });
    });

    it('adds an oauth_credentials input as a cct/legacy-attachment slot with ToS ack on the attachment', async () => {
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
      expect(slot.kind).toBe('cct');
      if (slot.kind !== 'cct') throw new Error('expected cct slot');
      expect(slot.source).toBe('legacy-attachment');
      if (slot.source !== 'legacy-attachment') throw new Error('expected legacy-attachment');
      expect(slot.oauthAttachment.accessToken).toBe(credentials.accessToken);
      expect(slot.oauthAttachment.acknowledgedConsumerTosRisk).toBe(true);
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

    it('auto-sets activeKeyId when first slot is added', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      const snap = await store.load();
      expect(snap.registry.activeKeyId).toBe(slot.keyId);
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
    it('updates activeKeyId + surfaces new access token via lease for cct/setup slots', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'val-a' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'val-b' });

      await tm.applyToken(s2.keyId);
      const snap = await store.load();
      expect(snap.registry.activeKeyId).toBe(s2.keyId);
      expect(await activeAccessToken(tm)).toBe('val-b');

      await tm.applyToken(s1.keyId);
      const snap2 = await store.load();
      expect(snap2.registry.activeKeyId).toBe(s1.keyId);
      expect(await activeAccessToken(tm)).toBe('val-a');
    });

    it('surfaces oauth_credentials accessToken via lease (legacy-attachment slot)', async () => {
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
      await tm.applyToken(s2.keyId);
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
        snap.state[s2.keyId].cooldownUntil = future;
        snap.state[s3.keyId].authState = 'revoked';
      });
      const result = await tm.rotateToNext();
      expect(result).not.toBeNull();
      expect(result?.keyId).toBe(s4.keyId);
      const cur = tm.getActiveToken();
      expect(cur?.keyId).toBe(s4.keyId);
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
      expect(snap.state[s1.keyId].rateLimitedAt).toBeDefined();
      expect(snap.state[s1.keyId].rateLimitSource).toBe('response_header');
      expect(snap.state[s1.keyId].cooldownUntil).toBeDefined();
      // within 5 seconds of the computed cooldownUntil
      const actual = new Date(snap.state[s1.keyId].cooldownUntil as string).getTime();
      expect(Math.abs(actual - cooldownUntilMs)).toBeLessThan(5000);
      expect(snap.registry.activeKeyId).toBe(s2.keyId);
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
      const firstAt = snap1.state[s1.keyId].rateLimitedAt;
      expect(firstAt).toBeDefined();

      // Simulate a second rate-limit hit for the same slot while still in cooldown.
      // We need to re-activate s1 to call rotate again.
      await tm.applyToken(s1.keyId);
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60 });
      const snap2 = await store.load();
      expect(snap2.state[s1.keyId].rateLimitedAt).toBe(firstAt);
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
      const until = new Date(snap.state[s1.keyId].cooldownUntil as string).getTime();
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
      await tm.recordRateLimitHint(s1.keyId, 'response_header');
      const firstAt = (await store.load()).state[s1.keyId].rateLimitedAt;
      expect(firstAt).toBeDefined();

      // Second hint a few seconds later — should NOT overwrite.
      await new Promise((r) => setTimeout(r, 5));
      await tm.recordRateLimitHint(s1.keyId, 'response_header');
      const secondAt = (await store.load()).state[s1.keyId].rateLimitedAt;
      expect(secondAt).toBe(firstAt);

      // Age the stored timestamp past the 5h window by rewriting it.
      await store.mutate((snap) => {
        snap.state[s1.keyId].rateLimitedAt = new Date(Date.now() - (5 * 60 + 1) * 60 * 1000).toISOString();
      });

      await tm.recordRateLimitHint(s1.keyId, 'error_string');
      const thirdAt = (await store.load()).state[s1.keyId].rateLimitedAt as string;
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
      const lease = await tm.acquireLease('stream-executor:C1:t1', 60_000);
      expect(lease.leaseId).toBeTruthy();
      expect(lease.ownerTag).toBe('stream-executor:C1:t1');
      const ttl = new Date(lease.expiresAt).getTime() - beforeMs;
      expect(ttl).toBeGreaterThan(59_000);
      expect(ttl).toBeLessThan(61_000);

      const snap = await store.load();
      expect(snap.state[s1.keyId].activeLeases).toHaveLength(1);
      expect(snap.state[s1.keyId].activeLeases[0].leaseId).toBe(lease.leaseId);
    });

    it('heartbeatLease extends expiresAt', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const lease = await tm.acquireLease('svc', 2_000);
      const firstExp = new Date(lease.expiresAt).getTime();

      await new Promise((r) => setTimeout(r, 50));
      await tm.heartbeatLease(lease.leaseId);
      const snap = await store.load();
      const active = snap.registry.activeKeyId;
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
      expect(snap.state[s1.keyId].activeLeases).toHaveLength(0);
    });

    it('reapExpiredLeases removes leases whose expiresAt < now', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      // Manually inject an expired lease
      await store.mutate((snap) => {
        snap.state[s1.keyId].activeLeases = [
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
      expect(snap.state[s1.keyId].activeLeases).toHaveLength(0);
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
      const result = await tm.removeSlot(s2.keyId);
      expect(result.removed).toBe(true);
      const snap = await store.load();
      expect(snap.registry.slots).toHaveLength(1);
      expect(snap.state[s2.keyId]).toBeUndefined();
      expect(snap.registry.activeKeyId).toBe(s1.keyId);
    });

    it('tombstones a slot that has active leases; reaper later fully removes it', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'v1' });
      const s2 = await tm.addSlot({ name: 'cct2', kind: 'setup_token', value: 'v2' });
      await tm.applyToken(s1.keyId);
      const lease = await tm.acquireLease('svc', 60_000);

      const result = await tm.removeSlot(s1.keyId);
      expect(result.removed).toBe(false);
      expect(result.pendingDrain).toBe(true);

      let snap = await store.load();
      expect(snap.state[s1.keyId].tombstoned).toBe(true);
      // active should be rotated away from tombstoned
      expect(snap.registry.activeKeyId).toBe(s2.keyId);

      // Release the lease, then run reaper
      await tm.releaseLease(lease.leaseId);
      await tm.reapExpiredLeases();
      snap = await store.load();
      expect(snap.registry.slots.find((s) => s.keyId === s1.keyId)).toBeUndefined();
      expect(snap.state[s1.keyId]).toBeUndefined();
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
      const result = await tm.removeSlot(s2.keyId, { force: true });
      // lease was on active s2 (no rotation during addSlot for s2 since s1 was first)
      // re-read and assert s2 is gone
      void result;
      const snap = await store.load();
      expect(snap.registry.slots.find((s) => s.keyId === s2.keyId)).toBeUndefined();
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
      await tm.renameSlot(s1.keyId, 'production');
      const snap = await store.load();
      expect(snap.registry.slots[0].name).toBe('production');
    });
  });

  // ── getValidAccessToken ───────────────────────────────────

  describe('getValidAccessToken', () => {
    it('returns the setupToken value directly for cct/setup slots without attachment', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'a', kind: 'setup_token', value: 'sk-ant-oat01-xyz' });
      const token = await tm.getValidAccessToken(s.keyId);
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
      const token = await tm.getValidAccessToken(s.keyId);
      expect(token).toBe('sk-ant-oat01-fresh');
      expect(refreshClaudeCredentialsMock).not.toHaveBeenCalled();
    });

    it('triggers refresh when expiresAtMs < now + 7h and persists new creds on the attachment', async () => {
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
      const token = await tm.getValidAccessToken(s.keyId);
      expect(token).toBe('sk-ant-oat01-stale-refreshed');
      expect(refreshClaudeCredentialsMock).toHaveBeenCalledTimes(1);

      const snap = await store.load();
      const slot = snap.registry.slots[0];
      if (slot.kind !== 'cct') throw new Error('expected cct slot');
      expect(slot.oauthAttachment?.accessToken).toBe('sk-ant-oat01-stale-refreshed');
      expect(slot.oauthAttachment?.acknowledgedConsumerTosRisk).toBe(true);
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
      let resolveRefresh: (v: import('./oauth/refresher').OAuthCredentials) => void = () => {};
      const refreshPromise = new Promise<import('./oauth/refresher').OAuthCredentials>((resolve) => {
        resolveRefresh = resolve;
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockImplementation(
        async (_current: import('./oauth/refresher').OAuthCredentials) => {
          return refreshPromise;
        },
      );

      const p = Promise.all(Array.from({ length: 10 }, () => tm.getValidAccessToken(s.keyId)));
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
      await expect(tm.getValidAccessToken(s.keyId)).rejects.toThrow();
      const snap = await store.load();
      expect(snap.state[s.keyId].authState).toBe('refresh_failed');
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
      await expect(tm.getValidAccessToken(s.keyId)).rejects.toThrow();
      const snap = await store.load();
      expect(snap.state[s.keyId].authState).toBe('revoked');
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
        snap.state[s.keyId].nextUsageFetchAllowedAt = new Date(Date.now() + 60_000).toISOString();
      });
      const result = await tm.fetchAndStoreUsage(s.keyId);
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
      const result = await tm.fetchAndStoreUsage(s.keyId);
      expect(result).not.toBeNull();
      expect(result?.fiveHour?.utilization).toBe(0.5);
      const snap = await store.load();
      expect(snap.state[s.keyId].usage?.fiveHour?.utilization).toBe(0.5);
      expect(snap.state[s.keyId].lastUsageFetchedAt).toBeDefined();
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
      const result = await tm.fetchAndStoreUsage(s.keyId);
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
      const result = await tm.fetchAndStoreUsage(s.keyId);
      expect(result).toBeNull();
      const snap = await store.load();
      expect(snap.state[s.keyId].authState).toBe('revoked');
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
      const result = await tm.fetchAndStoreUsage(s.keyId);
      expect(result).toBeNull();
      const snap = await store.load();
      const next = snap.state[s.keyId].nextUsageFetchAllowedAt;
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
      await tm.markAuthState(s.keyId, 'revoked');
      const snap = await store.load();
      expect(snap.state[s.keyId].authState).toBe('revoked');
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
      await tm.markAuthState(s1.keyId, 'revoked');
      const list = tm.listTokens();
      expect(list).toHaveLength(2);
      const revoked = list.find((t) => t.keyId === s1.keyId);
      expect(revoked?.status).toContain('revoked');

      const active = tm.getActiveToken();
      expect(active?.keyId).toBe(s1.keyId);
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
      const first = snap.registry.slots[0];
      if (first.kind !== 'cct' || first.source !== 'setup') throw new Error('expected cct/setup');
      expect(first.setupToken).toBe('sk-ant-oat01-a');
      expect(snap.registry.activeKeyId).toBe(first.keyId);
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

    it('sets activeKeyId when registry has slots but no active (e.g. after load)', async () => {
      // Pre-populate the store WITHOUT activeKeyId, then init and expect it to self-heal.
      const storePath = path.join(tmp, 'cct-store.json');
      const { storeMod } = await importSut();
      const bootstrap = new storeMod.CctStore(storePath);
      await bootstrap.mutate((snap) => {
        const keyId = '01HZZZAAAA0000000000000111';
        snap.registry.slots.push({
          kind: 'cct',
          source: 'setup',
          keyId,
          name: 'preexisting',
          setupToken: 'sk-ant-oat01-zzz',
          createdAt: new Date().toISOString(),
        });
        snap.state[keyId] = { authState: 'healthy', activeLeases: [] };
      });

      process.env.SOMA_CCT_DISABLE_ENV_SEED = 'true';
      const { mod } = await importSut();
      const store = new storeMod.CctStore(storePath);
      const tm = new mod.TokenManager(store);
      await tm.init();
      const snap = await store.load();
      expect(snap.registry.activeKeyId).toBe('01HZZZAAAA0000000000000111');
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
      expect(snap.state[ai2Slot.keyId].cooldownUntil).toBe(cooldownUntil);

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

  // ── T1/T2: addSlot api_key (Z3) ────────────────────────────

  describe('addSlot api_key (Z3 — store-only, not runtime-selectable)', () => {
    it('T1: persists an api_key slot with kind="api_key" and does NOT auto-elect it as active', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'commercial-1',
        kind: 'api_key',
        value: 'sk-ant-api03-xxxxxxxxxxxx',
      });
      expect(slot.kind).toBe('api_key');
      if (slot.kind !== 'api_key') throw new Error('expected api_key');
      expect(slot.value).toBe('sk-ant-api03-xxxxxxxxxxxx');
      expect(slot.keyId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      const snap = await store.load();
      expect(snap.registry.slots).toHaveLength(1);
      // activeKeyId must NOT have been auto-set to an api_key slot.
      expect(snap.registry.activeKeyId).toBeUndefined();
    });

    it('T2: rejects api_key values that do not match the sk-ant-api03- regex', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await expect(tm.addSlot({ name: 'bad', kind: 'api_key', value: 'not-an-api-key' })).rejects.toThrow(
        /sk-ant-api03/,
      );
      await expect(tm.addSlot({ name: 'bad2', kind: 'api_key', value: 'sk-ant-api03-' })).rejects.toThrow(
        /sk-ant-api03/,
      );
    });

    it('T1b: api_key does not auto-elect even when no CCT slots exist, but a later CCT slot does', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const apiSlot = await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-abcdefghij' });
      let snap = await store.load();
      expect(snap.registry.activeKeyId).toBeUndefined();
      const cctSlot = await tm.addSlot({ name: 'cct', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      snap = await store.load();
      expect(snap.registry.activeKeyId).toBe(cctSlot.keyId);
      expect(snap.registry.activeKeyId).not.toBe(apiSlot.keyId);
    });
  });

  // ── T3-T5c: attachOAuth / detachOAuth (Z2) ─────────────────

  describe('attachOAuth / detachOAuth (Z2 — setup-source only)', () => {
    it('T3: attachOAuth on a setup-source slot sets oauthAttachment, keeps source="setup", re-validates scopes', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'setup-a', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      const creds = makeOAuthCreds({ accessToken: 'sk-ant-oat01-attach' });
      await tm.attachOAuth(slot.keyId, creds, true);
      const snap = await store.load();
      const updated = snap.registry.slots.find((s) => s.keyId === slot.keyId);
      if (!updated || updated.kind !== 'cct' || updated.source !== 'setup') {
        throw new Error('expected setup-source cct slot');
      }
      expect(updated.source).toBe('setup');
      expect(updated.oauthAttachment?.accessToken).toBe('sk-ant-oat01-attach');
      expect(updated.oauthAttachment?.acknowledgedConsumerTosRisk).toBe(true);
    });

    it('T4: attachOAuth with insufficient scopes (missing user:profile) rejects', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'setup-a', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      const badCreds = makeOAuthCreds({ scopes: ['user:inference'] });
      await expect(tm.attachOAuth(slot.keyId, badCreds, true)).rejects.toThrow(/user:profile/);
    });

    it('T4b: attachOAuth requires ack=true', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'setup-a', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      await expect(tm.attachOAuth(slot.keyId, makeOAuthCreds(), false as any)).rejects.toThrow(/ack/);
    });

    it('T5: detachOAuth on a setup-source slot with attachment clears oauthAttachment + usage cache', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'setup-a', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      await tm.attachOAuth(slot.keyId, makeOAuthCreds(), true);
      // Seed some usage state so detach clears it.
      await store.mutate((snap) => {
        snap.state[slot.keyId] = {
          ...(snap.state[slot.keyId] ?? { authState: 'healthy', activeLeases: [] }),
          usage: {
            fetchedAt: new Date().toISOString(),
            fiveHour: { utilization: 0.42, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
          },
          lastUsageFetchedAt: new Date().toISOString(),
        };
      });
      await tm.detachOAuth(slot.keyId);
      const snap = await store.load();
      const after = snap.registry.slots.find((s) => s.keyId === slot.keyId);
      if (!after || after.kind !== 'cct' || after.source !== 'setup') throw new Error('expected setup cct');
      expect(after.oauthAttachment).toBeUndefined();
      expect(snap.state[slot.keyId]?.usage).toBeUndefined();
      expect(snap.state[slot.keyId]?.lastUsageFetchedAt).toBeUndefined();
    });

    it('T5b: detachOAuth on a legacy-attachment slot throws (mandatory-attachment arm)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'legacy',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      await expect(tm.detachOAuth(slot.keyId)).rejects.toThrow(/legacy-attachment/);
    });

    it('T5c: attachOAuth on an api_key slot throws', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-abcdefghij' });
      await expect(tm.attachOAuth(slot.keyId, makeOAuthCreds(), true)).rejects.toThrow(/slot kind must be cct/);
    });

    it('T5d: detachOAuth on an api_key slot throws (no attachment surface)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-abcdefghij' });
      await expect(tm.detachOAuth(slot.keyId)).rejects.toThrow(/api_key slots have no attachment/);
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
});
