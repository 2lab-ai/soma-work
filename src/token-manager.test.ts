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

  // ── T6/T6b: fetchUsageForAllAttached + per-key dedupe (Z1) ─

  describe('fetchUsageForAllAttached (Z1 — /cct usage-on-open fan-out)', () => {
    it('T6: fans out usage fetch only for OAuth-attached CCT slots (skips api_key + bare-setup)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const apiSlot = await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-abcdefghij' });
      const bareSetup = await tm.addSlot({ name: 'bare', kind: 'setup_token', value: 'sk-ant-oat01-xxx' });
      const attached1 = await tm.addSlot({
        name: 'oauth1',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'sk-ant-oat01-a1' }),
        acknowledgedConsumerTosRisk: true,
      });
      const attached2 = await tm.addSlot({
        name: 'oauth2',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'sk-ant-oat01-a2' }),
        acknowledgedConsumerTosRisk: true,
      });
      fetchUsageMock.mockReset();
      fetchUsageMock.mockImplementation(async () => ({
        snapshot: {
          fetchedAt: new Date().toISOString(),
          fiveHour: { utilization: 0.3, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 2 * 60 * 1000,
      }));
      const results = await tm.fetchUsageForAllAttached({ timeoutMs: 5000 });
      expect(Object.keys(results).sort()).toEqual([attached1.keyId, attached2.keyId].sort());
      expect(results[apiSlot.keyId]).toBeUndefined();
      expect(results[bareSetup.keyId]).toBeUndefined();
      expect(fetchUsageMock).toHaveBeenCalledTimes(2);
    });

    it('T6b: usageFetchInFlight dedupes parallel fetchAndStoreUsage calls for the same keyId', async () => {
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
      // Block the upstream until we signal, so 5 concurrent calls observe
      // the dedupe map (all queue on the same in-flight Promise).
      let resolveFetch: (v: any) => void = () => {};
      const upstream = new Promise<any>((r) => {
        resolveFetch = r;
      });
      fetchUsageMock.mockReset();
      fetchUsageMock.mockImplementation(async () => upstream);
      const parallel = Promise.all(Array.from({ length: 5 }, () => tm.fetchAndStoreUsage(s.keyId)));
      // Give the first call a microtask to land in the in-flight map.
      await new Promise((r) => setTimeout(r, 10));
      resolveFetch({
        snapshot: {
          fetchedAt: new Date().toISOString(),
          fiveHour: { utilization: 0.5, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 2 * 60 * 1000,
      });
      const results = await parallel;
      expect(results.every((r) => r?.fiveHour?.utilization === 0.5)).toBe(true);
      // Critical assertion: upstream fetch hit at most once thanks to dedupe.
      expect(fetchUsageMock).toHaveBeenCalledTimes(1);
    });

    it('T6c: fetchUsageForAllAttached timeout returns partial results without blocking longer than timeoutMs', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({
        name: 'oauth',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      // Make the upstream never resolve within the test window.
      fetchUsageMock.mockReset();
      fetchUsageMock.mockImplementation(async () => new Promise(() => {}));
      const t0 = Date.now();
      const results = await tm.fetchUsageForAllAttached({ timeoutMs: 60 });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(500); // did NOT block indefinitely
      // Best-effort: no keys will have landed yet.
      expect(Object.keys(results).length === 0 || Object.values(results).every((v) => v === null)).toBe(true);
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

    // ── Codex P0 fix #3: authState reset on attach/detach ──────
    it('T5e: attachOAuth resets stale authState=refresh_failed to healthy (Codex P0 fix #3)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      // Simulate a stale refresh_failed mark from a prior attachment cycle.
      await tm.markAuthState(slot.keyId, 'refresh_failed');
      let snap = await store.load();
      expect(snap.state[slot.keyId].authState).toBe('refresh_failed');
      // Attach fresh creds — the reset MUST clear the stale mark so the
      // slot is eligible again in isEligible().
      await tm.attachOAuth(slot.keyId, makeOAuthCreds(), true);
      snap = await store.load();
      expect(snap.state[slot.keyId].authState).toBe('healthy');
    });

    it('T5f: detachOAuth clears stale authState=revoked to healthy (Codex P0 fix #3)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      await tm.attachOAuth(slot.keyId, makeOAuthCreds(), true);
      // Mark revoked as if a 403 fired mid-lifecycle.
      await tm.markAuthState(slot.keyId, 'revoked');
      await tm.detachOAuth(slot.keyId);
      const snap = await store.load();
      // With no attachment, the revoked mark is meaningless; must reset.
      expect(snap.state[slot.keyId].authState).toBe('healthy');
      expect((snap.registry.slots[0] as any).oauthAttachment).toBeUndefined();
    });

    // ── Codex P0 fix #3: in-flight writer race guards ──────────
    it('T5g: fetchAndStoreUsage drops snapshot when detach lands before persist (Codex P0 fix #3)', async () => {
      // Race scenario:
      //   1. fetchAndStoreUsage(keyId) enters #doFetchAndStoreUsage, calls
      //      upstream fetchUsage (mocked to stall on an explicit gate).
      //   2. Before the persist mutate runs, detachOAuth(keyId) lands.
      //   3. Persist must NOT write ANY state onto the now-detached slot —
      //      otherwise the next card open renders stale percentages.
      //
      // Tightened from the initial T5g (Codex test-review feedback):
      //   • Explicit `started` handshake proves the upstream fetch was
      //     genuinely in flight before detach ran (setImmediate alone is not
      //     a guarantee that the mock was entered).
      //   • Post-detach snapshot is captured and deep-compared to the final
      //     post-release snapshot — any persist-side leak of state onto the
      //     detached slot, not just `usage`, fails the test.
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      await tm.attachOAuth(slot.keyId, makeOAuthCreds(), true);
      // Explicit two-promise handshake: the mock signals `started` on entry
      // so the test can await it before proceeding to detach, and stalls on
      // `fetchGate` so the race window is large and deterministic.
      let releaseFetch!: () => void;
      const fetchGate = new Promise<void>((r) => {
        releaseFetch = r;
      });
      let signalStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        signalStarted = r;
      });
      fetchUsageMock.mockImplementationOnce(async () => {
        signalStarted();
        await fetchGate;
        return {
          snapshot: {
            fetchedAt: '2026-04-19T00:00:00Z',
            fiveHour: { utilization: 0.5, resetsAt: '2026-04-19T05:00:00Z' },
          },
          nextFetchAllowedAtMs: Date.now() + 60_000,
        };
      });
      const usagePromise = tm.fetchAndStoreUsage(slot.keyId);
      // Proof-of-in-flight: wait for the mock to enter BEFORE detach. This
      // makes the race deterministic — without this barrier, a regression
      // where detach happens before fetch starts would trivially pass.
      await startedPromise;
      await tm.detachOAuth(slot.keyId);
      // Snapshot the post-detach state; the post-release snapshot MUST match
      // this exactly — any mutation by the stale persist corrupts the test.
      const postDetachSnap = structuredClone(await store.load());
      releaseFetch();
      await usagePromise;
      const finalSnap = await store.load();
      // WHOLE-SNAPSHOT equality (Codex v2 tightening). `mutate` always bumps
      // revision on commit — even when the guarded callback is a no-op —
      // so we normalize revision before comparing the data shape. Every
      // other field (registry, state, version) must be byte-identical; a
      // stale persist touching anything outside slots[0] / state[keyId]
      // would still fail this assertion.
      const normalize = <T extends { revision: number }>(s: T): T => ({ ...s, revision: 0 });
      expect(normalize(finalSnap)).toEqual(normalize(postDetachSnap));
      // Spot-checks that pinpoint the two most common regression modes.
      expect(finalSnap.state[slot.keyId]?.usage).toBeUndefined();
      expect((finalSnap.registry.slots[0] as any).oauthAttachment).toBeUndefined();
    });

    it('T5h: refreshAccessToken does NOT resurrect attachment when detach lands mid-refresh (Codex P0 fix #3)', async () => {
      // Same structure as T5g, but for the refresh pipeline. The refresh
      // persist MUST NOT overwrite any detached-slot field after stale
      // credentials resolve.
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      await tm.attachOAuth(slot.keyId, makeOAuthCreds({ expiresAtMs: Date.now() - 60_000 }), true);
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((r) => {
        releaseRefresh = r;
      });
      let signalStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        signalStarted = r;
      });
      refreshClaudeCredentialsMock.mockImplementationOnce(async (current: any) => {
        signalStarted();
        await refreshGate;
        return {
          ...current,
          accessToken: `${current.accessToken}-refreshed`,
          expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
        };
      });
      const refreshPromise = tm.refreshCredentialsIfNeeded(slot.keyId);
      // Proof-of-in-flight: the upstream mock has actually entered before
      // detach runs — otherwise this race could pass even under a regression
      // where detach happens first.
      await startedPromise;
      await tm.detachOAuth(slot.keyId);
      const postDetachSnap = structuredClone(await store.load());
      releaseRefresh();
      await refreshPromise;
      const finalSnap = await store.load();
      // WHOLE-SNAPSHOT equality (Codex v2 tightening). `mutate` always bumps
      // revision on commit — even when the guarded callback is a no-op —
      // so we normalize revision before comparing the data shape.
      const normalize = <T extends { revision: number }>(s: T): T => ({ ...s, revision: 0 });
      expect(normalize(finalSnap)).toEqual(normalize(postDetachSnap));
      // Spot-check: no attachment resurrection.
      expect((finalSnap.registry.slots[0] as any).oauthAttachment).toBeUndefined();
    });

    // ── T5i / T5j: detach + re-attach before persist — attachment-generation
    // guard (Codex P0 fix #3, attachedAt fingerprint).
    //
    // These prove the deeper failure mode from the code review: if the
    // operator detaches AND re-attaches the same keyId while an old
    // refresh/usage fetch is still in flight, the stale persist must not
    // clobber the newer attachment generation.
    it('T5i: stale refresh does NOT overwrite a fresh re-attached generation (pure-generation guard)', async () => {
      // Codex v3 tightening — BOTH attach generations use a BYTE-IDENTICAL
      // credential payload (same accessToken, refreshToken, expiresAtMs,
      // scopes). The ONLY difference between them is the `attachedAt`
      // fingerprint stamped internally by attachOAuth. This closes two
      // loopholes from prior rounds:
      //   (a) v2 used different accessTokens, so a regression to a
      //       value-based guard on accessToken would still pass.
      //   (b) v3 still had asymmetric expiresAtMs (first attach expired,
      //       reattach default future), so a regression keyed on
      //       expiresAtMs would still pass.
      // Here only `attachedAt` differs, and we explicitly capture both
      // generations' fingerprints to assert they are strictly unequal.
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      // Single creds literal reused for BOTH attaches → identical payload
      // across generations; `attachedAt` is the only thing that differs.
      // The creds are expired so the stale `refreshCredentialsIfNeeded`
      // fires; the fresh reattach does not trigger another refresh
      // because we do not call refreshCredentialsIfNeeded on the fresh gen.
      const identicalCreds = makeOAuthCreds({
        accessToken: 'oat-SHARED',
        expiresAtMs: Date.now() - 60_000,
      });
      await tm.attachOAuth(slot.keyId, identicalCreds, true);
      // Capture the stale generation's fingerprint BEFORE detach so we can
      // later assert the fresh generation minted a strictly different one.
      const postAttachStaleSnap = await store.load();
      const staleAttachedAt: number | undefined = (postAttachStaleSnap.registry.slots[0] as any).oauthAttachment
        ?.attachedAt;
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((r) => {
        releaseRefresh = r;
      });
      let signalStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        signalStarted = r;
      });
      refreshClaudeCredentialsMock.mockImplementationOnce(async (current: any) => {
        signalStarted();
        await refreshGate;
        return {
          ...current,
          // Force a token-change: a regression keyed on accessToken diff
          // would say "no change, safe to write" and clobber the fresh gen.
          accessToken: `${current.accessToken}-refreshed`,
          expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
        };
      });
      const staleRefreshPromise = tm.refreshCredentialsIfNeeded(slot.keyId);
      await startedPromise;
      // Force a wall-clock gap so the fresh reattach gets a strictly
      // different `attachedAt` (Date.now() resolution is 1ms).
      await new Promise((r) => setTimeout(r, 5));
      await tm.detachOAuth(slot.keyId);
      // Reattach with the IDENTICAL creds payload — only attachedAt differs.
      await tm.attachOAuth(slot.keyId, identicalCreds, true);
      const postReattachSnap = await store.load();
      const freshAttachment = structuredClone((postReattachSnap.registry.slots[0] as any).oauthAttachment);
      const freshAttachedAt: number | undefined = freshAttachment.attachedAt;
      // The two generations minted DIFFERENT fingerprints — this is the
      // single distinguisher the guard has to work with. If this ever
      // becomes equal, the test would stop exercising the guard at all.
      expect(typeof staleAttachedAt).toBe('number');
      expect(typeof freshAttachedAt).toBe('number');
      expect(freshAttachedAt).not.toBe(staleAttachedAt);
      releaseRefresh();
      await staleRefreshPromise;
      const finalSnap = await store.load();
      const finalAttachment = (finalSnap.registry.slots[0] as any).oauthAttachment;
      // Pure-generation guard: fresh attachment survives byte-for-byte.
      expect(finalAttachment).toEqual(freshAttachment);
      expect(finalAttachment.accessToken).toBe('oat-SHARED');
      expect(finalAttachment.accessToken).not.toBe('oat-SHARED-refreshed');
      expect(finalAttachment.attachedAt).toBe(freshAttachedAt);
    });

    it('T5j: stale usage fetch does NOT write state onto a freshly re-attached generation (pure-generation guard)', async () => {
      // Codex v3 tightening — credential payload is BYTE-IDENTICAL across
      // the stale and fresh attachments; the ONLY generational
      // distinguisher is `attachedAt`, and we explicitly assert the two
      // fingerprints are strictly unequal before exercising the race.
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      const identicalCreds = makeOAuthCreds({ accessToken: 'oat-SHARED' });
      await tm.attachOAuth(slot.keyId, identicalCreds, true);
      // Capture the stale generation's fingerprint BEFORE detach.
      const postAttachStaleSnap = await store.load();
      const staleAttachedAt: number | undefined = (postAttachStaleSnap.registry.slots[0] as any).oauthAttachment
        ?.attachedAt;
      let releaseFetch!: () => void;
      const fetchGate = new Promise<void>((r) => {
        releaseFetch = r;
      });
      let signalStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        signalStarted = r;
      });
      fetchUsageMock.mockImplementationOnce(async () => {
        signalStarted();
        await fetchGate;
        return {
          snapshot: {
            fetchedAt: '2026-04-19T00:00:00Z',
            fiveHour: { utilization: 0.99, resetsAt: '2026-04-19T05:00:00Z' },
          },
          nextFetchAllowedAtMs: Date.now() + 60_000,
        };
      });
      const staleUsagePromise = tm.fetchAndStoreUsage(slot.keyId);
      await startedPromise;
      // Force wall-clock gap so the fresh generation's `attachedAt` differs.
      await new Promise((r) => setTimeout(r, 5));
      await tm.detachOAuth(slot.keyId);
      // Reattach with the IDENTICAL creds payload — only attachedAt differs.
      await tm.attachOAuth(slot.keyId, identicalCreds, true);
      const postReattachSnap = structuredClone(await store.load());
      const freshAttachedAt: number | undefined = (postReattachSnap.registry.slots[0] as any).oauthAttachment
        ?.attachedAt;
      // Two generations → two strictly different fingerprints. If this
      // ever collapses to equality, the race below would pass trivially.
      expect(typeof staleAttachedAt).toBe('number');
      expect(typeof freshAttachedAt).toBe('number');
      expect(freshAttachedAt).not.toBe(staleAttachedAt);
      releaseFetch();
      await staleUsagePromise;
      const finalSnap = await store.load();
      // WHOLE-SNAPSHOT equality (revision-normalized). Any stale write to
      // state or slot fails the assertion — not only the `usage` field.
      const normalize = <T extends { revision: number }>(s: T): T => ({ ...s, revision: 0 });
      expect(normalize(finalSnap)).toEqual(normalize(postReattachSnap));
      // Spot-checks.
      expect(finalSnap.state[slot.keyId]?.usage).toBeUndefined();
      expect((finalSnap.registry.slots[0] as any).oauthAttachment?.attachedAt).toBe(freshAttachedAt);
      expect((finalSnap.registry.slots[0] as any).oauthAttachment?.accessToken).toBe('oat-SHARED');
    });
  });

  // ── T10/T10b: api_key runtime fence (Z3) ───────────────────

  describe('api_key runtime fence (Z3 — not runtime-selectable in phase 1)', () => {
    it('T10: applyToken throws for an api_key slot; activeKeyId unchanged', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const cctSlot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      const apiSlot = await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-abcdefghij' });
      await expect(tm.applyToken(apiSlot.keyId)).rejects.toThrow(/api_key is not runtime-selectable/);
      const snap = await store.load();
      // The cct slot remains active — the fence must not have flipped it.
      expect(snap.registry.activeKeyId).toBe(cctSlot.keyId);
    });

    it('T10b: acquireLease rejects when only api_key slots exist (no healthy cct slot)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({ name: 'api1', kind: 'api_key', value: 'sk-ant-api03-aaaaaaaaa' });
      await tm.addSlot({ name: 'api2', kind: 'api_key', value: 'sk-ant-api03-bbbbbbbbb' });
      // No cct slot at all → acquireLease must refuse rather than lease on api_key.
      await expect(tm.acquireLease('svc:fence', 60_000)).rejects.toThrow(/no healthy slot/);
    });

    it('T10b-ii: acquireLease falls through an api_key active slot and leases the first healthy cct', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const cctSlot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      const apiSlot = await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-aaaaaaaaa' });
      // Force activeKeyId to point at the api_key slot (bypassing applyToken's
      // fence so we can verify acquireLease handles the pre-existing state).
      await store.mutate((snap) => {
        snap.registry.activeKeyId = apiSlot.keyId;
      });
      const lease = await tm.acquireLease('svc:fall-through', 60_000);
      const snap = await store.load();
      // acquireLease must have pivoted activeKeyId to a cct slot.
      expect(snap.registry.activeKeyId).toBe(cctSlot.keyId);
      expect(snap.state[cctSlot.keyId].activeLeases.map((l) => l.leaseId)).toContain(lease.leaseId);
      expect(snap.state[apiSlot.keyId].activeLeases.map((l) => l.leaseId)).not.toContain(lease.leaseId);
    });

    it('T10-rotate: rotateToNext skips api_key candidates', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const cctA = await tm.addSlot({ name: 'a', kind: 'setup_token', value: 'vA' });
      await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-xxxxxxxxxxx' });
      const cctB = await tm.addSlot({ name: 'b', kind: 'setup_token', value: 'vB' });
      // Currently active is cctA. rotateToNext should skip the api_key and
      // land on cctB.
      const result = await tm.rotateToNext();
      expect(result?.keyId).toBe(cctB.keyId);
      const snap = await store.load();
      expect(snap.registry.activeKeyId).toBe(cctB.keyId);
      void cctA;
    });

    it('T10-rotate-rl: rotateOnRateLimit skips api_key candidates', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const cctA = await tm.addSlot({ name: 'a', kind: 'setup_token', value: 'vA' });
      await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-yyyyyyyyyyy' });
      const cctB = await tm.addSlot({ name: 'b', kind: 'setup_token', value: 'vB' });
      const result = await tm.rotateOnRateLimit('hit', { source: 'response_header', cooldownMinutes: 60 });
      expect(result?.keyId).toBe(cctB.keyId);
      const snap = await store.load();
      expect(snap.registry.activeKeyId).toBe(cctB.keyId);
      void cctA;
    });

    it('T10-ensure: ensureActiveSlot re-picks a cct slot when the persisted active is an api_key', async () => {
      // Pre-populate the store with an api_key as activeKeyId, then init()
      // and expect ensureActiveSlot() to self-heal by pivoting to a cct.
      const storePath = path.join(tmp, 'cct-store.json');
      const { storeMod } = await importSut();
      const bootstrap = new storeMod.CctStore(storePath);
      const apiKeyId = '01HZZZAPIKEY000000000000001';
      const cctKeyId = '01HZZZCCTAAA00000000000000A';
      await bootstrap.mutate((snap) => {
        snap.registry.slots.push({
          kind: 'api_key',
          keyId: apiKeyId,
          name: 'api',
          value: 'sk-ant-api03-seededseed',
          createdAt: new Date().toISOString(),
        });
        snap.registry.slots.push({
          kind: 'cct',
          source: 'setup',
          keyId: cctKeyId,
          name: 'cct',
          setupToken: 'sk-ant-oat01-seed',
          createdAt: new Date().toISOString(),
        });
        snap.state[apiKeyId] = { authState: 'healthy', activeLeases: [] };
        snap.state[cctKeyId] = { authState: 'healthy', activeLeases: [] };
        // Deliberately point active at the api_key slot.
        snap.registry.activeKeyId = apiKeyId;
      });
      process.env.SOMA_CCT_DISABLE_ENV_SEED = 'true';
      const { mod } = await importSut();
      const store = new storeMod.CctStore(storePath);
      const tm = new mod.TokenManager(store);
      await tm.init();
      const snap = await store.load();
      expect(snap.registry.activeKeyId).toBe(cctKeyId);
    });
  });

  // ── M1-S4: fetchAndStoreUsage { force } + fetchUsageForAllAttached { force } ──

  describe('fetchAndStoreUsage { force } + fetchUsageForAllAttached { force } (M1-S4)', () => {
    it('force:true bypasses nextUsageFetchAllowedAt gate (local throttle only)', async () => {
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
      // Pin the gate into the future.
      await store.mutate((snap) => {
        snap.state[s.keyId].nextUsageFetchAllowedAt = new Date(Date.now() + 60_000).toISOString();
      });
      fetchUsageMock.mockResolvedValueOnce({
        snapshot: {
          fetchedAt: new Date().toISOString(),
          fiveHour: { utilization: 0.9, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 2 * 60 * 1000,
      });
      // With force, fetchUsage MUST be invoked despite the gate.
      const result = await tm.fetchAndStoreUsage(s.keyId, { force: true });
      expect(fetchUsageMock).toHaveBeenCalledTimes(1);
      expect(result?.fiveHour?.utilization).toBe(0.9);
    });

    it('force:false (default) still respects nextUsageFetchAllowedAt gate — regression guard', async () => {
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
      // No-opts overload — existing callers MUST keep the gate.
      const result = await tm.fetchAndStoreUsage(s.keyId);
      expect(result).toBeNull();
      expect(fetchUsageMock).not.toHaveBeenCalled();
    });

    it('fetchUsageForAllAttached does NOT forward force to per-slot calls (#644 review #5 — dedupe-over-force)', async () => {
      // Contract change (#644 review #5): `fetchUsageForAllAttached` no longer
      // threads `force` through to per-slot `fetchAndStoreUsage`. The per-keyId
      // in-flight dedupe (`usageFetchInFlight`) already handles cheap re-entry
      // when an admin-triggered refresh-all overlaps a scheduler tick. Keeping
      // `force` out of the fan-out also prevents an operator from accidentally
      // bypassing every slot's local throttle gate in one click — the card-open
      // and admin refresh-all paths MUST respect `nextUsageFetchAllowedAt`.
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s1 = await tm.addSlot({
        name: 'o1',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'a1' }),
        acknowledgedConsumerTosRisk: true,
      });
      const s2 = await tm.addSlot({
        name: 'o2',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'a2' }),
        acknowledgedConsumerTosRisk: true,
      });
      // Gate BOTH into the future. If force were forwarded, fetchUsageMock
      // would still be called twice; because it is NOT forwarded, the gate
      // holds and neither slot reaches the transport.
      await store.mutate((snap) => {
        snap.state[s1.keyId].nextUsageFetchAllowedAt = new Date(Date.now() + 60_000).toISOString();
        snap.state[s2.keyId].nextUsageFetchAllowedAt = new Date(Date.now() + 60_000).toISOString();
      });
      fetchUsageMock.mockResolvedValue({
        snapshot: {
          fetchedAt: new Date().toISOString(),
          fiveHour: { utilization: 0.1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 2 * 60 * 1000,
      });
      const results = await tm.fetchUsageForAllAttached({ timeoutMs: 5000, force: true });
      // Force was NOT forwarded — both per-slot calls hit the gate and returned null.
      expect(fetchUsageMock).not.toHaveBeenCalled();
      expect(results[s1.keyId]).toBeNull();
      expect(results[s2.keyId]).toBeNull();
    });

    it('force:true + server 429 still bumps consecutiveUsageFailures and backoff (server-side 429 not bypassed)', async () => {
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
      const result = await tm.fetchAndStoreUsage(s.keyId, { force: true });
      expect(result).toBeNull();
      const snap = await store.load();
      expect(snap.state[s.keyId].consecutiveUsageFailures).toBe(1);
      const nextAllowed = snap.state[s.keyId].nextUsageFetchAllowedAt;
      expect(nextAllowed).toBeDefined();
      const allowedMs = new Date(nextAllowed!).getTime();
      expect(allowedMs).toBeGreaterThan(beforeMs);
    });

    it('generation guard: mid-flight detach + re-attach drops the write even under force', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      const sharedCreds = makeOAuthCreds({ accessToken: 'oat-FORCED' });
      await tm.attachOAuth(slot.keyId, sharedCreds, true);
      let releaseFetch!: () => void;
      const fetchGate = new Promise<void>((r) => {
        releaseFetch = r;
      });
      let signalStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        signalStarted = r;
      });
      fetchUsageMock.mockImplementationOnce(async () => {
        signalStarted();
        await fetchGate;
        return {
          snapshot: {
            fetchedAt: '2026-04-19T00:00:00Z',
            fiveHour: { utilization: 0.42, resetsAt: '2026-04-19T05:00:00Z' },
          },
          nextFetchAllowedAtMs: Date.now() + 60_000,
        };
      });
      const usagePromise = tm.fetchAndStoreUsage(slot.keyId, { force: true });
      await startedPromise;
      await new Promise((r) => setTimeout(r, 5));
      await tm.detachOAuth(slot.keyId);
      await tm.attachOAuth(slot.keyId, sharedCreds, true);
      releaseFetch();
      await usagePromise;
      const final = await store.load();
      // Generation guard must reject the stale write even though force was set.
      expect(final.state[slot.keyId]?.usage).toBeUndefined();
    });

    // #644 review #9 — attachedAt fingerprint guard regression.
    // The reviewer flagged that the attachedAt write-time check lacks a
    // dedicated, named regression test. The generation-guard test above uses
    // force-through-the-public-API and the dedupe map as side effects. This
    // test isolates the invariant: the write-time comparison
    // `slotNow.oauthAttachment.attachedAt !== preAttachedAt` MUST drop the
    // stale usage payload even when the keyId and the credentials are
    // otherwise unchanged — what matters is only the attachedAt stamp.
    it('attachedAt fingerprint guard drops stale usage write across detach+re-attach (#644 review #9)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct-fp', kind: 'setup_token', value: 'sk-ant-oat01-bbb' });
      const creds = makeOAuthCreds({ accessToken: 'oat-FP' });
      await tm.attachOAuth(slot.keyId, creds, true);
      const before = await store.load();
      const slotV1 = before.registry.slots.find((s) => s.keyId === slot.keyId) as any;
      const attachedAtV1: number | undefined = slotV1?.oauthAttachment?.attachedAt;
      expect(attachedAtV1).toBeGreaterThan(0);

      // Suspend the fetch so we can flip attachedAt between dispatch and commit.
      let releaseFetch!: () => void;
      const fetchGate = new Promise<void>((r) => {
        releaseFetch = r;
      });
      let signalStarted!: () => void;
      const started = new Promise<void>((r) => {
        signalStarted = r;
      });
      fetchUsageMock.mockImplementationOnce(async () => {
        signalStarted();
        await fetchGate;
        return {
          snapshot: {
            fetchedAt: '2026-04-20T00:00:00Z',
            fiveHour: { utilization: 0.77, resetsAt: '2026-04-20T05:00:00Z' },
          },
          nextFetchAllowedAtMs: Date.now() + 60_000,
        };
      });

      const fetchPromise = tm.fetchAndStoreUsage(slot.keyId, { force: true });
      await started;
      // Give the fetch pre-capture a microtask window to snapshot attachedAt.
      await new Promise((r) => setTimeout(r, 5));

      // Detach + re-attach deliberately to bump the attachedAt stamp. Same
      // credentials on purpose — the guard is keyed on attachedAt, not creds.
      await tm.detachOAuth(slot.keyId);
      await tm.attachOAuth(slot.keyId, creds, true);
      const after = await store.load();
      const slotV2 = after.registry.slots.find((s) => s.keyId === slot.keyId) as any;
      const attachedAtV2: number | undefined = slotV2?.oauthAttachment?.attachedAt;
      expect(attachedAtV2).toBeDefined();
      expect(attachedAtV2).not.toBe(attachedAtV1);

      releaseFetch();
      await fetchPromise;

      // The write MUST have been dropped: the pre-captured attachedAt (v1) no
      // longer matches the current attachedAt (v2). No usage must be stored.
      const final = await store.load();
      expect(final.state[slot.keyId]?.usage).toBeUndefined();
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
