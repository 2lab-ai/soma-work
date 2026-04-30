import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Contract tests for the AuthKey-v2 keyed TokenManager rewrite.
// All tests drive a tmpdir-backed CctStore so we avoid pulling env-paths side effects.

// Hoisted mocks — must be declared before the SUT is imported inside each test.
const refreshClaudeCredentialsMock = vi.hoisted(() => vi.fn());
const fetchUsageMock = vi.hoisted(() => vi.fn());
const fetchOAuthProfileMock = vi.hoisted(() => vi.fn());
const nextUsageBackoffMsMock = vi.hoisted(() =>
  vi.fn((ms: number | undefined) => (ms && ms > 0 ? ms * 2 : 2 * 60 * 1000)),
);

vi.mock('../oauth/refresher', async () => {
  const actual = await vi.importActual<typeof import('../oauth/refresher')>('../oauth/refresher');
  return {
    ...actual,
    refreshClaudeCredentials: refreshClaudeCredentialsMock,
  };
});

vi.mock('../oauth/usage', async () => {
  const actual = await vi.importActual<typeof import('../oauth/usage')>('../oauth/usage');
  return {
    ...actual,
    fetchUsage: fetchUsageMock,
    nextUsageBackoffMs: nextUsageBackoffMsMock,
  };
});

vi.mock('../oauth/profile', async () => {
  const actual = await vi.importActual<typeof import('../oauth/profile')>('../oauth/profile');
  return {
    ...actual,
    fetchOAuthProfile: fetchOAuthProfileMock,
  };
});

async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tm-test-'));
}

async function importSut() {
  vi.resetModules();
  const mod = await import('../token-manager');
  const storeMod = await import('../cct-store');
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
async function activeAccessToken(tm: import('../token-manager').TokenManager): Promise<string> {
  const { ensureActiveSlotAuth } = await import('../credentials-manager');
  const lease = await ensureActiveSlotAuth(tm, 'test:activeAccessToken');
  try {
    return lease.accessToken;
  } finally {
    await lease.release();
  }
}

function makeOAuthCreds(
  overrides: Partial<import('../oauth/refresher').OAuthCredentials> = {},
): import('../oauth/refresher').OAuthCredentials {
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
    fetchOAuthProfileMock.mockReset();
    nextUsageBackoffMsMock.mockClear();
    // Default profile fetch: resolve with a minimal shape so fire-and-forget
    // chains don't reject with "mock not implemented" and spam console.warn.
    fetchOAuthProfileMock.mockImplementation(async () => ({
      fetchedAt: Date.now(),
      email: 'test@example.com',
      rateLimitTier: 'default_claude_max_20x',
    }));
    // Default: echo back with extended expiry
    refreshClaudeCredentialsMock.mockImplementation(async (current: import('../oauth/refresher').OAuthCredentials) => ({
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
    // Card v2 fire-and-forget profile syncs (attachOAuth / addSlot /
    // forceRefreshOAuth) can still be in flight when the test body returns,
    // plus the (pre-existing) fetchAndStoreUsage fire-and-forget on attach.
    // Drain a few macrotask ticks before nuking the tmpdir; retry the rm
    // loop so a stray `fs.writeFile` landing mid-cleanup doesn't surface as
    // a flaky ENOTEMPTY.
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(tmp, { recursive: true, force: true });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err;
        await new Promise((r) => setTimeout(r, 40));
      }
    }
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
      // Issue #673 — setup slots stay eligible even when their
      // attachment-scoped authState is 'revoked' (dispatch uses setupToken
      // unconditionally). Use a legacy-attachment slot here so the hard
      // gate still applies and we can assert the skip-on-revoked path.
      const s3 = await tm.addSlot({
        name: 'cct3',
        kind: 'oauth_credentials',
        credentials: {
          accessToken: 'sk-ant-oat01-v3',
          refreshToken: 'sk-ant-ort01-v3',
          expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
          scopes: [...VALID_OAUTH_SCOPES],
        },
        acknowledgedConsumerTosRisk: true,
      });
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
      const token = await tm.getValidAccessToken(s.keyId, 'dispatch');
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
      const token = await tm.getValidAccessToken(s.keyId, 'dispatch');
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
      const token = await tm.getValidAccessToken(s.keyId, 'dispatch');
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
      let resolveRefresh: (v: import('../oauth/refresher').OAuthCredentials) => void = () => {};
      const refreshPromise = new Promise<import('../oauth/refresher').OAuthCredentials>((resolve) => {
        resolveRefresh = resolve;
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockImplementation(
        async (_current: import('../oauth/refresher').OAuthCredentials) => {
          return refreshPromise;
        },
      );

      const p = Promise.all(Array.from({ length: 10 }, () => tm.getValidAccessToken(s.keyId, 'dispatch')));
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
      const { OAuthRefreshError } = await import('../oauth/refresher');
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
      await expect(tm.getValidAccessToken(s.keyId, 'dispatch')).rejects.toThrow();
      const snap = await store.load();
      expect(snap.state[s.keyId].authState).toBe('refresh_failed');
    });

    it('403 from refresh → authState=revoked', async () => {
      const { mod, storeMod } = await importSut();
      const { OAuthRefreshError } = await import('../oauth/refresher');
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
      await expect(tm.getValidAccessToken(s.keyId, 'dispatch')).rejects.toThrow();
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
          fiveHour: { utilization: 50, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 2 * 60 * 1000,
      });
      const result = await tm.fetchAndStoreUsage(s.keyId);
      expect(result).not.toBeNull();
      // #701 — percent-form stored verbatim.
      expect(result?.fiveHour?.utilization).toBe(50);
      const snap = await store.load();
      expect(snap.state[s.keyId].usage?.fiveHour?.utilization).toBe(50);
      expect(snap.state[s.keyId].lastUsageFetchedAt).toBeDefined();
    });

    it('401 → refresh → retry once → success', async () => {
      const { mod, storeMod } = await importSut();
      const { UsageFetchError } = await import('../oauth/usage');
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
          fiveHour: { utilization: 10, resetsAt: new Date().toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 120_000,
      });
      const result = await tm.fetchAndStoreUsage(s.keyId);
      expect(result).not.toBeNull();
      expect(refreshClaudeCredentialsMock).toHaveBeenCalled();
    });

    it('403 → markAuthState revoked', async () => {
      const { mod, storeMod } = await importSut();
      const { UsageFetchError } = await import('../oauth/usage');
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
      const { UsageFetchError } = await import('../oauth/usage');
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
          fiveHour: { utilization: 30, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
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
          fiveHour: { utilization: 50, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 2 * 60 * 1000,
      });
      const results = await parallel;
      expect(results.every((r) => r?.fiveHour?.utilization === 50)).toBe(true);
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
      // Issue #673 — even though the attachment landed, the dispatch path
      // must still surface the 1-year setupToken, not the 1h OAuth access.
      expect(await tm.getValidAccessToken(slot.keyId, 'dispatch')).toBe('sk-ant-oat01-aaa');
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
            fiveHour: { utilization: 42, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
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
            fiveHour: { utilization: 50, resetsAt: '2026-04-19T05:00:00Z' },
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
            fiveHour: { utilization: 99, resetsAt: '2026-04-19T05:00:00Z' },
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
          fiveHour: { utilization: 90, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 2 * 60 * 1000,
      });
      // With force, fetchUsage MUST be invoked despite the gate.
      const result = await tm.fetchAndStoreUsage(s.keyId, { force: true });
      expect(fetchUsageMock).toHaveBeenCalledTimes(1);
      // #701 — percent-form stored verbatim.
      expect(result?.fiveHour?.utilization).toBe(90);
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

    it('fetchUsageForAllAttached does NOT accept or forward force to per-slot calls (dedupe-over-force)', async () => {
      // `fetchUsageForAllAttached`'s opts type no longer carries `force` —
      // even if a caller tries to pass it via `as any`, the per-slot fan-out
      // still calls `fetchAndStoreUsage(keyId, {})`, so the local
      // `nextUsageFetchAllowedAt` gate blocks the transport hit. Card-open
      // and admin refresh-all paths always respect the throttle.
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
          fiveHour: { utilization: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 2 * 60 * 1000,
      });
      // Caller tries to force — opts type rejects it, so we smuggle through
      // `as any` to simulate a future regression where someone re-adds `force`.
      // Both per-slot calls must still hit the gate and return null.
      const results = await tm.fetchUsageForAllAttached({ timeoutMs: 5000, force: true } as any);
      expect(fetchUsageMock).not.toHaveBeenCalled();
      expect(results[s1.keyId]).toBeNull();
      expect(results[s2.keyId]).toBeNull();
    });

    it('force:true + server 429 still bumps consecutiveUsageFailures and backoff (server-side 429 not bypassed)', async () => {
      const { mod, storeMod } = await importSut();
      const { UsageFetchError } = await import('../oauth/usage');
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
            fiveHour: { utilization: 42, resetsAt: '2026-04-19T05:00:00Z' },
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
            fiveHour: { utilization: 77, resetsAt: '2026-04-20T05:00:00Z' },
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

  // ── #668 follow-up — disableRotation filter (isEligible) ─
  describe('disableRotation filter (card v2)', () => {
    async function setDisable(store: any, keyId: string, flag: boolean) {
      await store.mutate((snap: any) => {
        const target = snap.registry.slots.find((s: any) => s.keyId === keyId);
        if (!target) throw new Error('not found');
        if (flag) target.disableRotation = true;
        else delete target.disableRotation;
      });
    }

    it('acquireLease skips a slot flagged with disableRotation=true', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const parked = await tm.addSlot({ name: 'parked', kind: 'setup_token', value: 'sk-ant-oat01-p' });
      const live = await tm.addSlot({ name: 'live', kind: 'setup_token', value: 'sk-ant-oat01-l' });
      await setDisable(store, parked.keyId, true);
      // Force active to the parked slot, then acquire — must rotate to `live`.
      await store.mutate((snap: any) => {
        snap.registry.activeKeyId = parked.keyId;
      });
      const lease = await tm.acquireLease('test');
      const snap = await tm.getSnapshot();
      expect(snap.registry.activeKeyId).toBe(live.keyId);
      expect(lease.leaseId).toBeDefined();
    });

    it('rotateToNext skips a disableRotation=true slot in the cycle', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const a = await tm.addSlot({ name: 'a', kind: 'setup_token', value: 'sk-ant-oat01-a' });
      const parked = await tm.addSlot({ name: 'b', kind: 'setup_token', value: 'sk-ant-oat01-b' });
      const c = await tm.addSlot({ name: 'c', kind: 'setup_token', value: 'sk-ant-oat01-c' });
      await setDisable(store, parked.keyId, true);
      await tm.applyToken(a.keyId);
      const rotated = await tm.rotateToNext();
      expect(rotated?.keyId).toBe(c.keyId);
    });

    it('rotateOnRateLimit skips a disableRotation=true candidate', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const a = await tm.addSlot({ name: 'a', kind: 'setup_token', value: 'sk-ant-oat01-a' });
      const parked = await tm.addSlot({ name: 'b', kind: 'setup_token', value: 'sk-ant-oat01-b' });
      const c = await tm.addSlot({ name: 'c', kind: 'setup_token', value: 'sk-ant-oat01-c' });
      await setDisable(store, parked.keyId, true);
      await tm.applyToken(a.keyId);
      const rotated = await tm.rotateOnRateLimit('test', { source: 'manual' });
      expect(rotated?.keyId).toBe(c.keyId);
    });

    it('disableRotation=false (or absent) does not affect eligibility', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const a = await tm.addSlot({ name: 'a', kind: 'setup_token', value: 'sk-ant-oat01-a' });
      const b = await tm.addSlot({ name: 'b', kind: 'setup_token', value: 'sk-ant-oat01-b' });
      await tm.applyToken(a.keyId);
      const rotated = await tm.rotateToNext();
      expect(rotated?.keyId).toBe(b.keyId);
    });
  });

  // ── #653 M2 — forceRefreshOAuth + refreshAllAttachedOAuthTokens ──

  describe('forceRefreshOAuth (#653 M2)', () => {
    it('force-refreshes a single attached slot regardless of TTL (no 7h-buffer short-circuit)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'o',
        kind: 'oauth_credentials',
        // fresh token, expires 10h out — well outside the 7h refresh buffer
        credentials: makeOAuthCreds({
          accessToken: 'old-access',
          refreshToken: 'ref-1',
          expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
        }),
        acknowledgedConsumerTosRisk: true,
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'ref-2',
        expiresAtMs: Date.now() + 8 * 60 * 60 * 1000,
        scopes: [...VALID_OAUTH_SCOPES],
      });
      // The legacy `refreshCredentialsIfNeeded` would SKIP this call because
      // expiresAtMs is 10h out (> 7h REFRESH_BUFFER_MS). The new public
      // method must bypass that short-circuit.
      await tm.refreshCredentialsIfNeeded(slot.keyId);
      expect(refreshClaudeCredentialsMock).not.toHaveBeenCalled();
      // forceRefreshOAuth fires the HTTP call.
      await tm.forceRefreshOAuth(slot.keyId);
      expect(refreshClaudeCredentialsMock).toHaveBeenCalledTimes(1);
      // Persisted — the active access token is the new one.
      const accessToken = await activeAccessToken(tm);
      expect(accessToken).toBe('new-access');
    });

    it('no-op when slot has no oauthAttachment (bare setup-token / api_key / unknown keyId)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const api = await tm.addSlot({ name: 'a', kind: 'api_key', value: 'sk-ant-api03-abcdefgh' });
      const bare = await tm.addSlot({ name: 'b', kind: 'setup_token', value: 'sk-ant-oat01-xyz' });
      refreshClaudeCredentialsMock.mockReset();
      await tm.forceRefreshOAuth(api.keyId);
      await tm.forceRefreshOAuth(bare.keyId);
      await tm.forceRefreshOAuth('unknown-keyid');
      expect(refreshClaudeCredentialsMock).not.toHaveBeenCalled();
    });

    it('propagates OAuthRefreshError (401→refresh_failed / 403→revoked) for caller awareness', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'o',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      const { OAuthRefreshError } = await import('../oauth/refresher');
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockRejectedValue(
        new OAuthRefreshError(401, '{"error":"invalid_grant"}', 'invalid_grant'),
      );
      await expect(tm.forceRefreshOAuth(slot.keyId)).rejects.toThrow(/invalid_grant/);
      // Side-effect — authState transitions to refresh_failed on 401.
      const snap = await tm.getSnapshot();
      expect(snap.state[slot.keyId]?.authState).toBe('refresh_failed');
    });

    it('preserves oauthAttachment.profile across a successful refresh (v2 card)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'o',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      // Seed a profile directly on the persisted attachment (mimics what
      // `refreshOAuthProfile` writes after the first fetch).
      const fetchedAt = 1_700_000_000_000;
      await store.mutate((snap) => {
        const target = snap.registry.slots.find((s: any) => s.keyId === slot.keyId);
        if (!target || target.kind !== 'cct' || !target.oauthAttachment) throw new Error('seed failed');
        target.oauthAttachment.profile = {
          email: 'alice@example.com',
          accountUuid: 'acc-1',
          rateLimitTier: 'default_claude_max_20x',
          fetchedAt,
        };
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAtMs: Date.now() + 8 * 60 * 60 * 1000,
        scopes: [...VALID_OAUTH_SCOPES],
      });
      await tm.forceRefreshOAuth(slot.keyId);
      const snap = await tm.getSnapshot();
      const after = snap.registry.slots.find((s: any) => s.keyId === slot.keyId) as any;
      expect(after.oauthAttachment.accessToken).toBe('new-access');
      expect(after.oauthAttachment.profile).toEqual({
        email: 'alice@example.com',
        accountUuid: 'acc-1',
        rateLimitTier: 'default_claude_max_20x',
        fetchedAt,
      });
    });
  });

  // ── #668 follow-up — refreshOAuthProfile ─────────────────
  describe('refreshOAuthProfile (card v2)', () => {
    it('persists the fetched profile onto the slot attachment', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'p1',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      fetchOAuthProfileMock.mockReset();
      fetchOAuthProfileMock.mockResolvedValue({
        fetchedAt: 1_800_000_000_000,
        email: 'alice@example.com',
        accountUuid: 'uuid-1',
        rateLimitTier: 'default_claude_max_20x',
      });
      const result = await tm.refreshOAuthProfile(slot.keyId);
      expect(result?.email).toBe('alice@example.com');
      const snap = await tm.getSnapshot();
      const after = snap.registry.slots.find((s: any) => s.keyId === slot.keyId) as any;
      expect(after.oauthAttachment.profile).toEqual({
        fetchedAt: 1_800_000_000_000,
        email: 'alice@example.com',
        accountUuid: 'uuid-1',
        rateLimitTier: 'default_claude_max_20x',
      });
    });

    it('dedupes concurrent calls for the same slot — single network fetch', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'p2',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      fetchOAuthProfileMock.mockReset();
      let resolve: (v: any) => void = () => {};
      const gate = new Promise<any>((r) => {
        resolve = r;
      });
      fetchOAuthProfileMock.mockImplementation(async () => gate);
      const p1 = tm.refreshOAuthProfile(slot.keyId);
      const p2 = tm.refreshOAuthProfile(slot.keyId);
      resolve({ fetchedAt: Date.now(), email: 'x@y.com' });
      await Promise.all([p1, p2]);
      expect(fetchOAuthProfileMock).toHaveBeenCalledTimes(1);
    });

    it('attachedAt guard: detach + reattach mid-flight drops the stale write', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'setup-p',
        kind: 'setup_token',
        value: 'sk-ant-oat01-zzz',
      });
      // First generation: attach (also triggers a fire-and-forget profile
      // sync that we let complete under the default mock so it doesn't mix
      // with the explicit in-flight call below).
      fetchOAuthProfileMock.mockReset();
      fetchOAuthProfileMock.mockResolvedValue({ fetchedAt: 1, email: 'bootstrap@example.com' });
      await tm.attachOAuth(
        slot.keyId,
        {
          accessToken: 'a1',
          refreshToken: 'r1',
          expiresAtMs: Date.now() + 10 * 3_600_000,
          scopes: [...VALID_OAUTH_SCOPES],
        },
        true,
      );
      await new Promise((r) => setTimeout(r, 10));
      // Clear profile the attach-triggered fetch wrote so we can observe the
      // guard rejecting the stale generation's write cleanly.
      await store.mutate((snap: any) => {
        const target = snap.registry.slots.find((s: any) => s.keyId === slot.keyId);
        if (target?.oauthAttachment) delete target.oauthAttachment.profile;
      });
      // Now set up the gated mock for the explicit in-flight call.
      fetchOAuthProfileMock.mockReset();
      let resolveGated: (v: any) => void = () => {};
      const gate = new Promise<any>((r) => {
        resolveGated = r;
      });
      fetchOAuthProfileMock.mockImplementation(async () => gate);
      const inFlight = tm.refreshOAuthProfile(slot.keyId);
      // Detach, then re-attach under a new generation. We swap the mock to a
      // no-network resolver for the attach-triggered sync so it doesn't
      // deadlock on the gate.
      await tm.detachOAuth(slot.keyId);
      fetchOAuthProfileMock.mockImplementation(async () => ({
        fetchedAt: 99,
        email: 'new@gen.com',
      }));
      await tm.attachOAuth(
        slot.keyId,
        {
          accessToken: 'a2',
          refreshToken: 'r2',
          expiresAtMs: Date.now() + 10 * 3_600_000,
          scopes: [...VALID_OAUTH_SCOPES],
        },
        true,
      );
      await new Promise((r) => setTimeout(r, 10));
      // Now release the stale generation's fetch. Its write must be rejected
      // because the current attachedAt belongs to the new generation.
      resolveGated({ fetchedAt: 42, email: 'stale@gen.com' });
      await inFlight;
      const snap = await tm.getSnapshot();
      const after = snap.registry.slots.find((s: any) => s.keyId === slot.keyId) as any;
      // The new generation's profile persisted; the stale write was dropped.
      expect(after.oauthAttachment.profile?.email).toBe('new@gen.com');
    });

    it('401 triggers one token refresh + one retry; success persists the fresh profile', async () => {
      const { mod, storeMod } = await importSut();
      const { OAuthProfileUnauthorizedError } = await import('../oauth/profile');
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'p3',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'pre-refresh', refreshToken: 'r-1' }),
        acknowledgedConsumerTosRisk: true,
      });
      fetchOAuthProfileMock.mockReset();
      let firstCall = true;
      fetchOAuthProfileMock.mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          throw new OAuthProfileUnauthorizedError();
        }
        return { fetchedAt: 7, email: 'retry@example.com' };
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockResolvedValue({
        accessToken: 'post-refresh',
        refreshToken: 'r-2',
        expiresAtMs: Date.now() + 8 * 3_600_000,
        scopes: [...VALID_OAUTH_SCOPES],
      });
      const result = await tm.refreshOAuthProfile(slot.keyId);
      expect(result?.email).toBe('retry@example.com');
      expect(fetchOAuthProfileMock).toHaveBeenCalledTimes(2);
      expect(refreshClaudeCredentialsMock).toHaveBeenCalledTimes(1);
      const snap = await tm.getSnapshot();
      const after = snap.registry.slots.find((s: any) => s.keyId === slot.keyId) as any;
      expect(after.oauthAttachment.profile?.email).toBe('retry@example.com');
    });

    it('non-401 error returns null and leaves existing profile untouched', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'p4',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      // Drain the fire-and-forget profile sync triggered by addSlot.
      await new Promise((r) => setTimeout(r, 10));
      // Seed a known profile so we can assert it stays put after the failure.
      await store.mutate((snap: any) => {
        const target = snap.registry.slots.find((s: any) => s.keyId === slot.keyId);
        target.oauthAttachment.profile = { fetchedAt: 100, email: 'prior@example.com' };
      });
      fetchOAuthProfileMock.mockReset();
      fetchOAuthProfileMock.mockRejectedValue(new Error('status=500 body=boom'));
      const result = await tm.refreshOAuthProfile(slot.keyId);
      expect(result).toBeNull();
      const snap = await tm.getSnapshot();
      const after = snap.registry.slots.find((s: any) => s.keyId === slot.keyId) as any;
      expect(after.oauthAttachment.profile?.email).toBe('prior@example.com');
    });

    it('addSlot(oauth_credentials) fires a one-shot profile sync (fire-and-forget)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      fetchOAuthProfileMock.mockReset();
      fetchOAuthProfileMock.mockResolvedValue({ fetchedAt: 1, email: 'created@example.com' });
      const slot = await tm.addSlot({
        name: 'legacy-att',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      // Allow the fire-and-forget chain to land. Poll up to ~500ms so this
      // isn't flaky under loaded runners (the chain spans addSlot →
      // refreshOAuthProfile → getValidAccessToken → store.mutate → persist,
      // which can take 50+ms with the tmp-store fs overhead).
      for (let i = 0; i < 50; i++) {
        if ((fetchOAuthProfileMock.mock.calls.length ?? 0) >= 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      // And another short drain for the persist step after the mock resolved.
      await new Promise((r) => setTimeout(r, 20));
      expect(fetchOAuthProfileMock).toHaveBeenCalledTimes(1);
      const snap = await tm.getSnapshot();
      const after = snap.registry.slots.find((s: any) => s.keyId === slot.keyId) as any;
      expect(after.oauthAttachment.profile?.email).toBe('created@example.com');
    });

    it('attachOAuth on a setup-source slot fires a one-shot profile sync', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 's', kind: 'setup_token', value: 'sk-ant-oat01-zz' });
      fetchOAuthProfileMock.mockReset();
      fetchOAuthProfileMock.mockResolvedValue({ fetchedAt: 2, email: 'attach@example.com' });
      await tm.attachOAuth(
        slot.keyId,
        {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAtMs: Date.now() + 10 * 3_600_000,
          scopes: [...VALID_OAUTH_SCOPES],
        },
        true,
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(fetchOAuthProfileMock).toHaveBeenCalledTimes(1);
    });

    it('forceRefreshOAuth chains the profile sync by default; syncProfile=false isolates the token leg', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({
        name: 'f1',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      // Wait for the addSlot-driven fire-and-forget profile sync to land BEFORE
      // resetting the mock — same poll pattern as the addSlot test above. The
      // bare `setTimeout(5ms)` was tight enough to race under loaded CI runners
      // (#737 PR — observed 2 vs 1 expected calls because the addSlot sync
      // landed AFTER the reset, then forceRefreshOAuth fired its own).
      for (let i = 0; i < 50; i++) {
        if ((fetchOAuthProfileMock.mock.calls.length ?? 0) >= 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 20));
      fetchOAuthProfileMock.mockReset();
      fetchOAuthProfileMock.mockResolvedValue({ fetchedAt: 3, email: 'chained@example.com' });
      await tm.forceRefreshOAuth(slot.keyId);
      // Same poll pattern for the chained sync — drain up to 500ms.
      for (let i = 0; i < 50; i++) {
        if ((fetchOAuthProfileMock.mock.calls.length ?? 0) >= 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(fetchOAuthProfileMock).toHaveBeenCalledTimes(1);

      fetchOAuthProfileMock.mockReset();
      await tm.forceRefreshOAuth(slot.keyId, { syncProfile: false });
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchOAuthProfileMock).not.toHaveBeenCalled();
    });

    it('returns null for slots without an OAuth attachment (bare setup / api_key / unknown)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const api = await tm.addSlot({ name: 'a', kind: 'api_key', value: 'sk-ant-api03-abcdefgh' });
      const bare = await tm.addSlot({ name: 'b', kind: 'setup_token', value: 'sk-ant-oat01-xyz' });
      fetchOAuthProfileMock.mockReset();
      expect(await tm.refreshOAuthProfile(api.keyId)).toBeNull();
      expect(await tm.refreshOAuthProfile(bare.keyId)).toBeNull();
      expect(await tm.refreshOAuthProfile('unknown')).toBeNull();
      expect(fetchOAuthProfileMock).not.toHaveBeenCalled();
    });
  });

  describe('refreshAllAttachedOAuthTokens (#653 M2)', () => {
    it('fans out force-refresh to every attached slot, skipping api_key + bare setup', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-abcdefgh' });
      await tm.addSlot({ name: 'bare', kind: 'setup_token', value: 'sk-ant-oat01-bare' });
      const a = await tm.addSlot({
        name: 'oa',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'a1', refreshToken: 'r1' }),
        acknowledgedConsumerTosRisk: true,
      });
      const b = await tm.addSlot({
        name: 'ob',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'a2', refreshToken: 'r2' }),
        acknowledgedConsumerTosRisk: true,
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockImplementation(async (current: any) => ({
        accessToken: current.accessToken + '-refreshed',
        refreshToken: current.refreshToken,
        expiresAtMs: Date.now() + 8 * 60 * 60 * 1000,
        scopes: [...VALID_OAUTH_SCOPES],
      }));
      const results = await tm.refreshAllAttachedOAuthTokens({ timeoutMs: 5_000 });
      expect(Object.keys(results).sort()).toEqual([a.keyId, b.keyId].sort());
      expect(results[a.keyId]).toBe('ok');
      expect(results[b.keyId]).toBe('ok');
      expect(refreshClaudeCredentialsMock).toHaveBeenCalledTimes(2);
    });

    it('per-slot error surfaces as "error" in the result map without poisoning the tick', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const ok = await tm.addSlot({
        name: 'ok',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ refreshToken: 'good' }),
        acknowledgedConsumerTosRisk: true,
      });
      const bad = await tm.addSlot({
        name: 'bad',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ refreshToken: 'stale' }),
        acknowledgedConsumerTosRisk: true,
      });
      const { OAuthRefreshError } = await import('../oauth/refresher');
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockImplementation(async (current: any) => {
        if (current.refreshToken === 'stale')
          throw new OAuthRefreshError(401, '{"error":"invalid_grant"}', 'invalid_grant');
        return {
          accessToken: 'new-good',
          refreshToken: 'good',
          expiresAtMs: Date.now() + 8 * 60 * 60 * 1000,
          scopes: [...VALID_OAUTH_SCOPES],
        };
      });
      const results = await tm.refreshAllAttachedOAuthTokens({ timeoutMs: 5_000 });
      expect(results[ok.keyId]).toBe('ok');
      expect(results[bad.keyId]).toBe('error');
      // The healthy slot completed despite the bad one throwing.
      expect(refreshClaudeCredentialsMock).toHaveBeenCalledTimes(2);
      // Bad slot's authState transitioned to refresh_failed.
      const snap = await tm.getSnapshot();
      expect(snap.state[bad.keyId]?.authState).toBe('refresh_failed');
    });

    it('returns partial results within timeoutMs when upstream hangs', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({
        name: 'hang',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockImplementation(async () => new Promise(() => {}));
      const t0 = Date.now();
      const results = await tm.refreshAllAttachedOAuthTokens({ timeoutMs: 60 });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(500);
      // No keys land because the deadline fires first.
      expect(Object.keys(results).length).toBe(0);
    });

    it('awaitProfile: true returns within total deadline when profile fetch hangs', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({
        name: 'ok',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds(),
        acknowledgedConsumerTosRisk: true,
      });
      // Token refresh resolves fast; profile fetch hangs forever. Under
      // awaitProfile: true the second leg must also be bounded by the
      // shared deadline — otherwise the call never returns.
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockImplementation(async (current: any) => ({
        ...current,
        accessToken: `${current.accessToken}-refreshed`,
        expiresAtMs: Date.now() + 8 * 60 * 60 * 1000,
      }));
      fetchOAuthProfileMock.mockReset();
      fetchOAuthProfileMock.mockImplementation(async () => new Promise(() => {}));
      const t0 = Date.now();
      const results = await tm.refreshAllAttachedOAuthTokens({ timeoutMs: 200, awaitProfile: true });
      const elapsed = Date.now() - t0;
      // Bounded by the shared deadline (200ms + a little scheduler slack).
      expect(elapsed).toBeLessThan(1500);
      // Token result landed even though the profile leg hung.
      const outcomes = Object.values(results);
      expect(outcomes.length).toBe(1);
      expect(outcomes[0]).toBe('ok');
    });

    it('awaitProfile: true suppresses the fire-and-forget profile leg (one profile fetch per slot, not two)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await tm.addSlot({
        name: 'one',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'a1', refreshToken: 'r1' }),
        acknowledgedConsumerTosRisk: true,
      });
      await tm.addSlot({
        name: 'two',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: 'a2', refreshToken: 'r2' }),
        acknowledgedConsumerTosRisk: true,
      });
      refreshClaudeCredentialsMock.mockReset();
      refreshClaudeCredentialsMock.mockImplementation(async (current: any) => ({
        ...current,
        accessToken: `${current.accessToken}-refreshed`,
        expiresAtMs: Date.now() + 8 * 60 * 60 * 1000,
      }));
      // Drain the fire-and-forget profile syncs that the two addSlot calls
      // fire (one each). Bare setTimeout(20ms) raced under loaded CI runners
      // and let one of the addSlot profile calls land AFTER the reset, then
      // counted against the fan-out assertion (#737 PR observed 1 vs 2 expected).
      // Poll up to 3000ms for both calls to land before resetting — bumped from
      // 500ms because PR #810 CI saw the same race on a slower hosted runner.
      for (let i = 0; i < 300; i++) {
        if ((fetchOAuthProfileMock.mock.calls.length ?? 0) >= 2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 50));
      fetchOAuthProfileMock.mockReset();
      fetchOAuthProfileMock.mockImplementation(async () => ({
        fetchedAt: Date.now(),
        email: 'test@example.com',
        rateLimitTier: 'default_claude_max_20x',
      }));
      await tm.refreshAllAttachedOAuthTokens({ timeoutMs: 5_000, awaitProfile: true });
      // Exactly one profile fetch per slot (awaited leg). The fire-and-forget
      // leg inside forceRefreshOAuth is suppressed by syncProfile:false.
      expect(fetchOAuthProfileMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── Issue #673 — getValidAccessToken purpose split ─────────

  describe('getValidAccessToken purpose split (issue #673)', () => {
    it("'dispatch': cct/setup WITH oauthAttachment returns setupToken (NOT attachment access)", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const SETUP_TOKEN = 'sk-ant-oat01-SETUP-1Y';
      const slot = await tm.addSlot({ name: 'setup-673', kind: 'setup_token', value: SETUP_TOKEN });
      await tm.attachOAuth(slot.keyId, makeOAuthCreds({ accessToken: 'sk-ant-oat01-1h-oauth' }), true);

      const token = await tm.getValidAccessToken(slot.keyId, 'dispatch');
      expect(token).toBe(SETUP_TOKEN);
      // And no refresh should have been triggered — the attachment is ignored
      // for dispatch even if it were near-expiry.
      expect(refreshClaudeCredentialsMock).not.toHaveBeenCalled();
    });

    it("'dispatch': cct/setup WITHOUT attachment returns setupToken", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'bare-setup', kind: 'setup_token', value: 'sk-ant-oat01-bare' });
      expect(await tm.getValidAccessToken(s.keyId, 'dispatch')).toBe('sk-ant-oat01-bare');
      expect(refreshClaudeCredentialsMock).not.toHaveBeenCalled();
    });

    it("'dispatch': legacy-attachment returns attachment.accessToken and triggers refresh when near expiry", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'legacy',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({
          accessToken: 'sk-ant-oat01-stale',
          expiresAtMs: Date.now() + 60 * 60 * 1000,
        }),
        acknowledgedConsumerTosRisk: true,
      });
      const token = await tm.getValidAccessToken(s.keyId, 'dispatch');
      expect(token).toBe('sk-ant-oat01-stale-refreshed');
      expect(refreshClaudeCredentialsMock).toHaveBeenCalledTimes(1);
    });

    it("'dispatch': api_key returns slot.value", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-abcdefghij' });
      expect(await tm.getValidAccessToken(s.keyId, 'dispatch')).toBe('sk-ant-api03-abcdefghij');
    });

    it("'oauth-api': cct/setup WITH attachment returns attachment.accessToken", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'setup-attached', kind: 'setup_token', value: 'sk-ant-oat01-setup' });
      await tm.attachOAuth(slot.keyId, makeOAuthCreds({ accessToken: 'sk-ant-oat01-attachment' }), true);
      expect(await tm.getValidAccessToken(slot.keyId, 'oauth-api')).toBe('sk-ant-oat01-attachment');
    });

    it("'oauth-api': cct/setup WITHOUT attachment throws NoOAuthAttachmentError", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'bare-setup', kind: 'setup_token', value: 'sk-ant-oat01-bare' });
      await expect(tm.getValidAccessToken(s.keyId, 'oauth-api')).rejects.toBeInstanceOf(mod.NoOAuthAttachmentError);
    });

    it("'oauth-api': legacy-attachment returns attachment.accessToken", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({
        name: 'legacy',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({
          accessToken: 'sk-ant-oat01-legacy',
          expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
        }),
        acknowledgedConsumerTosRisk: true,
      });
      expect(await tm.getValidAccessToken(s.keyId, 'oauth-api')).toBe('sk-ant-oat01-legacy');
    });

    it("'oauth-api': api_key throws NoOAuthAttachmentError", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-abcdefghij' });
      await expect(tm.getValidAccessToken(s.keyId, 'oauth-api')).rejects.toBeInstanceOf(mod.NoOAuthAttachmentError);
    });
  });

  // ── Issue #673 — isEligible setup-slot dispatch guard ──────

  describe('isEligible (issue #673 setup-slot dispatch guard)', () => {
    it("cct/setup with authState='refresh_failed' + setupToken remains eligible (picked by acquireLease)", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'setup-rf', kind: 'setup_token', value: 'sk-ant-oat01-rf' });
      await tm.markAuthState(s.keyId, 'refresh_failed');

      const lease = await tm.acquireLease('test:673-eligible-rf');
      try {
        // The slot was picked — confirm via activeToken identity.
        expect(tm.getActiveToken()?.keyId).toBe(s.keyId);
      } finally {
        await tm.releaseLease(lease.leaseId);
      }
    });

    it("cct/setup with authState='revoked' + setupToken remains eligible (picked by acquireLease)", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'setup-rv', kind: 'setup_token', value: 'sk-ant-oat01-rv' });
      await tm.markAuthState(s.keyId, 'revoked');

      const lease = await tm.acquireLease('test:673-eligible-rv');
      try {
        expect(tm.getActiveToken()?.keyId).toBe(s.keyId);
      } finally {
        await tm.releaseLease(lease.leaseId);
      }
    });

    it("legacy-attachment with authState='refresh_failed' remains INELIGIBLE (acquireLease skips)", async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      // Legacy-attachment slot (broken) + setup slot (healthy fallback).
      const legacy = await tm.addSlot({
        name: 'legacy-broken',
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ expiresAtMs: Date.now() + 10 * 60 * 60 * 1000 }),
        acknowledgedConsumerTosRisk: true,
      });
      const healthy = await tm.addSlot({ name: 'setup-ok', kind: 'setup_token', value: 'sk-ant-oat01-ok' });
      await tm.markAuthState(legacy.keyId, 'refresh_failed');

      const lease = await tm.acquireLease('test:673-legacy-skip');
      try {
        expect(tm.getActiveToken()?.keyId).toBe(healthy.keyId);
      } finally {
        await tm.releaseLease(lease.leaseId);
      }
    });

    it('cct/setup with active cooldownUntil still INELIGIBLE (cooldown gate independent of auth)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const cooling = await tm.addSlot({ name: 'setup-cool', kind: 'setup_token', value: 'sk-ant-oat01-cool' });
      const healthy = await tm.addSlot({ name: 'setup-ok', kind: 'setup_token', value: 'sk-ant-oat01-ok' });
      await store.mutate((snap) => {
        const st = snap.state[cooling.keyId] ?? { authState: 'healthy' as const, activeLeases: [] };
        st.cooldownUntil = new Date(Date.now() + 10 * 60_000).toISOString();
        snap.state[cooling.keyId] = st;
      });

      const lease = await tm.acquireLease('test:673-cooldown-skip');
      try {
        expect(tm.getActiveToken()?.keyId).toBe(healthy.keyId);
      } finally {
        await tm.releaseLease(lease.leaseId);
      }
    });
  });

  // ── Issue #673 — fetchAndStoreUsage uses oauth-api purpose ─

  describe('fetchAndStoreUsage (issue #673 oauth-api purpose)', () => {
    it('sends attachment.accessToken (NOT setupToken) to fetchUsage for setup+attachment slot', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 's1', kind: 'setup_token', value: 'sk-ant-oat01-SETUP-673' });
      await tm.attachOAuth(
        slot.keyId,
        makeOAuthCreds({
          accessToken: 'sk-ant-oat01-ATTACHMENT-673',
          expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
        }),
        true,
      );
      fetchUsageMock.mockReset();
      fetchUsageMock.mockResolvedValueOnce({
        snapshot: {
          fetchedAt: new Date().toISOString(),
          fiveHour: { utilization: 20, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        },
        nextFetchAllowedAtMs: Date.now() + 120_000,
      });
      await tm.fetchAndStoreUsage(slot.keyId);
      expect(fetchUsageMock).toHaveBeenCalledTimes(1);
      expect(fetchUsageMock.mock.calls[0][0]).toBe('sk-ant-oat01-ATTACHMENT-673');
    });

    it('no-ops and returns null for cct/setup WITHOUT attachment (early-return via NoOAuthAttachmentError path)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'bare', kind: 'setup_token', value: 'sk-ant-oat01-bare' });
      fetchUsageMock.mockReset();
      const result = await tm.fetchAndStoreUsage(s.keyId);
      expect(result).toBeNull();
      expect(fetchUsageMock).not.toHaveBeenCalled();
    });
  });

  // ── Issue #673 — regression guards from zcheck findings ───

  describe('regression guards (#673 zcheck)', () => {
    it('getValidAccessToken: throws descriptive error for unknown keyId on both purposes', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await expect(tm.getValidAccessToken('nope', 'dispatch')).rejects.toThrow(/unknown keyId/);
      await expect(tm.getValidAccessToken('nope', 'oauth-api')).rejects.toThrow(/unknown keyId/);
    });

    it('isEligible: cct/setup with EMPTY setupToken + authState=refresh_failed is NOT dispatch-independent', async () => {
      // Guards the `setupToken.length > 0` branch in `hasDispatchIndependentOfAttachment`.
      // A setup slot with an empty setupToken must NOT bypass the authState gate,
      // because its dispatch credential is effectively missing.
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      // addSlot rejects empty values, so mutate the store directly to plant
      // the degenerate fixture (empty-string setupToken). This is the only
      // reachable way to express the invariant `hasDispatchIndependentOfAttachment`
      // defends against — a migration landing such data in the registry.
      const planted = {
        kind: 'cct' as const,
        source: 'setup' as const,
        keyId: '01TESTEMPTYSETUP0000000001',
        name: 'empty',
        setupToken: '',
        createdAt: new Date().toISOString(),
      };
      await store.mutate((snap) => {
        snap.registry.slots.push(planted);
        snap.state[planted.keyId] = {
          authState: 'refresh_failed' as const,
          activeLeases: [],
        };
        if (!snap.registry.activeKeyId) snap.registry.activeKeyId = planted.keyId;
      });
      // Health-only slot is the planted empty-setup one; acquireLease must
      // not return it because the authState gate still applies.
      await expect(tm.acquireLease('test:empty-setup-ineligible')).rejects.toThrow();
    });

    it('getValidAccessToken dispatch: concurrent calls on setup+attachment never trigger attachment refresh', async () => {
      // Guards that the dispatch path for cct/setup is truly attachment-free:
      // under N concurrent callers, `refreshAccessToken` must be invoked 0 times
      // even when the attachment is near expiry (the attachment is supposed
      // to be ignored entirely on this path).
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const s = await tm.addSlot({ name: 'concurrent', kind: 'setup_token', value: 'sk-ant-oat01-SETUP' });
      // Attach near-expiry OAuth creds — dispatch must still ignore them.
      await tm.attachOAuth(
        s.keyId,
        makeOAuthCreds({
          accessToken: 'sk-ant-oat01-NEAR-EXPIRY',
          expiresAtMs: Date.now() + 60 * 1000, // 1 min — well inside the 7h refresh buffer
        }),
        true,
      );
      refreshClaudeCredentialsMock.mockReset();
      const tokens = await Promise.all(Array.from({ length: 10 }, () => tm.getValidAccessToken(s.keyId, 'dispatch')));
      expect(tokens.every((t) => t === 'sk-ant-oat01-SETUP')).toBe(true);
      expect(refreshClaudeCredentialsMock).not.toHaveBeenCalled();
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

  // ── #801 — inferred-shared cooldown propagation ─────────
  //
  // Cross-account shared-bucket heuristic: when two CCT slots cool down on
  // the same wall-clock reset within ±W ms (with both observations sourced
  // from a parsed wall-clock — `error_string` / `response_header`, NOT the
  // 60-minute fallback), propagate the cooldown to the rest of the eligible
  // CCT-with-attachment pool. Eliminates N-1 wasted CLI spawns under a
  // shared-bucket cascade. See `docs/cct-shared-bucket-cooldown-propagation/`.
  describe('rotateOnRateLimit > inferred-shared propagation (#801)', () => {
    async function addOauthSlot(
      tm: import('../token-manager').TokenManager,
      name: string,
      accessTokenSeed: string,
    ): Promise<{ keyId: string; name: string }> {
      return await tm.addSlot({
        name,
        kind: 'oauth_credentials',
        credentials: makeOAuthCreds({ accessToken: accessTokenSeed }),
        acknowledgedConsumerTosRisk: true,
      });
    }

    async function addSixOauthSlots(
      tm: import('../token-manager').TokenManager,
    ): Promise<Array<{ keyId: string; name: string }>> {
      const out: Array<{ keyId: string; name: string }> = [];
      for (const n of ['A', 'B', 'C', 'D', 'E', 'F']) {
        out.push(await addOauthSlot(tm, n, `sk-ant-oat01-${n}`));
      }
      return out;
    }

    it('AC-1: first 429 in pristine state marks only active slot', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [a, b, c] = await addSixOauthSlots(tm);
      // First call: A is active. No sibling has cooldownUntil → no match → no propagation.
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const snap = await store.load();
      // A — marked normally as the active slot.
      expect(snap.state[a.keyId].rateLimitSource).toBe('error_string');
      expect(snap.state[a.keyId].cooldownUntil).toBeDefined();
      // B, C — pristine.
      expect(snap.state[b.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[b.keyId].cooldownUntil).toBeUndefined();
      expect(snap.state[c.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[c.keyId].cooldownUntil).toBeUndefined();
    });

    it('AC-2a: second 429 within window propagates to all eligible siblings with source=inferred_shared', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [a, b, c, d, e, f] = await addSixOauthSlots(tm);
      // 1st: marks A. Active rotates to B.
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      // 2nd: marks B. cooldownUntil_B is within ±90s of cooldownUntil_A → match → propagate to C,D,E,F.
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const snap = await store.load();
      expect(snap.state[a.keyId].rateLimitSource).toBe('error_string');
      expect(snap.state[b.keyId].rateLimitSource).toBe('error_string');
      for (const sib of [c, d, e, f]) {
        expect(snap.state[sib.keyId].rateLimitSource).toBe('inferred_shared');
        expect(snap.state[sib.keyId].cooldownUntil).toBeDefined();
      }
    });

    it('AC-2b: propagated rateLimitedAt and cooldownUntil equal the call values (per-call now)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [, b, c] = await addSixOauthSlots(tm);
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const beforeMs = Date.now();
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const afterMs = Date.now();
      const snap = await store.load();
      // Propagated rateLimitedAt should be ~now of the 2nd call (between beforeMs and afterMs + slack).
      const cAt = new Date(snap.state[c.keyId].rateLimitedAt as string).getTime();
      expect(cAt).toBeGreaterThanOrEqual(beforeMs - 50);
      expect(cAt).toBeLessThanOrEqual(afterMs + 50);
      // Propagated cooldownUntil should equal B's cooldownUntil (the new anchor).
      expect(snap.state[c.keyId].cooldownUntil).toBe(snap.state[b.keyId].cooldownUntil);
      // SAME `nowIso` must be stamped on every propagation target — the spec
      // (§5.1) computes it once per call. A regression that minted a fresh
      // `new Date().toISOString()` per target would produce ms-level drift
      // that `cAt ∈ [beforeMs-50, afterMs+50]` would silently tolerate.
      expect(snap.state[c.keyId].rateLimitedAt).toBe(snap.state[b.keyId].rateLimitedAt);
    });

    it('AC-2d: |Δ| just outside window (5 min apart) does NOT propagate', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [a, , c] = await addSixOauthSlots(tm);
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      // Push A's cooldown 5 minutes earlier — well past the 90 s window.
      await store.mutate((snap) => {
        const aMs = new Date(snap.state[a.keyId].cooldownUntil as string).getTime();
        snap.state[a.keyId].cooldownUntil = new Date(aMs - 5 * 60_000).toISOString();
      });
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const snap = await store.load();
      expect(snap.state[c.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[c.keyId].cooldownUntil).toBeUndefined();
    });

    it('AC-2f: missing state row on a sibling — synthesized default still receives propagation', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [, , c] = await addSixOauthSlots(tm);
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      // Simulate registry/state desync: drop C's state row entirely.
      await store.mutate((snap) => {
        delete snap.state[c.keyId];
      });
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const snap = await store.load();
      // Helper synthesizes `{ authState:'healthy', activeLeases:[] }` and writes propagation.
      expect(snap.state[c.keyId]).toBeDefined();
      expect(snap.state[c.keyId].rateLimitSource).toBe('inferred_shared');
      expect(snap.state[c.keyId].cooldownUntil).toBeDefined();
    });

    it('AC-6c: env "90s" silently parsed as 90 ms is rejected — strict-integer guard', async () => {
      // `Number.parseInt("90s", 10) === 90`. Without the strict-integer guard
      // this would silently set a 90 ms window; with it, the value is rejected
      // and the default 90_000 ms applies.
      process.env.CCT_SHARED_BUCKET_WINDOW_MS = '90s';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { mod, storeMod } = await importSut();
        const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
        const tm = new mod.TokenManager(store);
        await tm.init();
        const [, , c] = await addSixOauthSlots(tm);
        // Two consecutive calls — within the default 90 000 ms window propagation should
        // fire. If the guard is missing the runtime window collapses to 90 ms and even
        // back-to-back calls (a few ms apart) won't reliably satisfy `<= W`. We also
        // assert the warning surfaced.
        await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
        await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
        const snap = await store.load();
        expect(snap.state[c.keyId].rateLimitSource).toBe('inferred_shared');
        const allCalls = [
          ...warnSpy.mock.calls.map((c) => c.join(' ')),
          ...errorSpy.mock.calls.map((c) => c.join(' ')),
        ].join('\n');
        expect(allCalls).toMatch(/CCT_SHARED_BUCKET_WINDOW_MS invalid \(90s\)/);
      } finally {
        delete process.env.CCT_SHARED_BUCKET_WINDOW_MS;
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('AC-2c: rotation returns null when all siblings just propagated', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      await addSixOauthSlots(tm);
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const second = await tm.rotateOnRateLimit('second', {
        source: 'error_string',
        cooldownMinutes: 60,
        knownReset: true,
      });
      // After call #2 every sibling A..F has a future cooldownUntil → no eligible left.
      expect(second).toBeNull();
    });

    it('AC-3: second 429 outside window does NOT propagate (independent buckets)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [a, b, c, d] = await addSixOauthSlots(tm);
      // Mark A first.
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      // Push A's cooldown far away (outside any reasonable window).
      await store.mutate((snap) => {
        snap.state[a.keyId].cooldownUntil = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
      });
      // Active is now B. Call rotate on B with cooldownMinutes:60 — B's cooldown
      // is ~60min from now; A's is ~10h from now → outside ±W ms.
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const snap = await store.load();
      expect(snap.state[b.keyId].rateLimitSource).toBe('error_string');
      // C, D pristine — no propagation.
      expect(snap.state[c.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[c.keyId].cooldownUntil).toBeUndefined();
      expect(snap.state[d.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[d.keyId].cooldownUntil).toBeUndefined();
    });

    it('AC-4: sibling already in future cooldown is not overwritten by propagation', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [, , c] = await addSixOauthSlots(tm);
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      // Pre-seed C with its OWN future cooldown distinct from the anchor.
      const preExistingC = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      await store.mutate((snap) => {
        snap.state[c.keyId].cooldownUntil = preExistingC;
        snap.state[c.keyId].rateLimitSource = 'manual';
        snap.state[c.keyId].rateLimitedAt = new Date().toISOString();
      });
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const snap = await store.load();
      // C must remain unchanged — its own cooldownUntil is intact.
      expect(snap.state[c.keyId].cooldownUntil).toBe(preExistingC);
      expect(snap.state[c.keyId].rateLimitSource).toBe('manual');
    });

    it('AC-5a: api_key + no-attachment + tombstoned siblings are skipped as propagation targets', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      // Two OAuth-attached slots (a active, b sibling that will be 2nd-cycle).
      const a = await addOauthSlot(tm, 'a', 'sk-ant-oat01-a');
      const b = await addOauthSlot(tm, 'b', 'sk-ant-oat01-b');
      // Ineligible siblings:
      const apiKey = await tm.addSlot({ name: 'api', kind: 'api_key', value: 'sk-ant-api03-xxxxxxxxxxx' });
      const setupOnly = await tm.addSlot({ name: 'setup', kind: 'setup_token', value: 'sk-ant-oat01-setuponly' });
      const tomb = await addOauthSlot(tm, 'tomb', 'sk-ant-oat01-tomb');
      await store.mutate((snap) => {
        snap.state[tomb.keyId].tombstoned = true;
      });
      // One eligible target so we can verify propagation actually fired.
      const target = await addOauthSlot(tm, 'target', 'sk-ant-oat01-target');

      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });

      const snap = await store.load();
      // a and b — direct marks.
      expect(snap.state[a.keyId].rateLimitSource).toBe('error_string');
      expect(snap.state[b.keyId].rateLimitSource).toBe('error_string');
      // target — propagated.
      expect(snap.state[target.keyId].rateLimitSource).toBe('inferred_shared');
      // ineligible siblings: untouched.
      expect(snap.state[apiKey.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[apiKey.keyId].cooldownUntil).toBeUndefined();
      expect(snap.state[setupOnly.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[setupOnly.keyId].cooldownUntil).toBeUndefined();
      // tomb has tombstoned=true — must NOT receive propagation cooldown either.
      expect(snap.state[tomb.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[tomb.keyId].cooldownUntil).toBeUndefined();
    });

    it('AC-5b: ineligible siblings cannot serve as match anchors even with cooldownUntil within window', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      // Active will be `active`. Sibling `target` is fully eligible.
      // Sibling `setupOnly` (CCT no attachment) carries a cooldownUntil that
      // would match within window — but is ineligible to anchor.
      const active = await addOauthSlot(tm, 'active', 'sk-ant-oat01-active');
      const setupOnly = await tm.addSlot({ name: 'setup', kind: 'setup_token', value: 'sk-ant-oat01-only' });
      const target = await addOauthSlot(tm, 'target', 'sk-ant-oat01-target');

      // Seed setupOnly with a cooldownUntil that would otherwise be within window
      // of a 60-min cooldown (set to ~60min from now, source=error_string).
      const fakeAnchor = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await store.mutate((snap) => {
        snap.state[setupOnly.keyId].cooldownUntil = fakeAnchor;
        snap.state[setupOnly.keyId].rateLimitSource = 'error_string';
        snap.state[setupOnly.keyId].rateLimitedAt = new Date().toISOString();
      });

      // active is currently active (first added). Call rotate with knownReset.
      await tm.rotateOnRateLimit('hit', { source: 'error_string', cooldownMinutes: 60, knownReset: true });

      const snap = await store.load();
      // active marked normally.
      expect(snap.state[active.keyId].rateLimitSource).toBe('error_string');
      // target NOT propagated — setupOnly cannot anchor (no oauthAttachment).
      expect(snap.state[target.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[target.keyId].cooldownUntil).toBeUndefined();
      // setupOnly's pre-seeded state untouched by us in this code path.
      expect(snap.state[setupOnly.keyId].cooldownUntil).toBe(fakeAnchor);
    });

    it('AC-5c: disableRotation sibling cannot anchor a match nor be a propagation target', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const active = await addOauthSlot(tm, 'active', 'sk-ant-oat01-active');
      const disabled = await addOauthSlot(tm, 'disabled', 'sk-ant-oat01-disabled');
      const target = await addOauthSlot(tm, 'target', 'sk-ant-oat01-target');
      // Mark `disabled` as disableRotation=true with a within-window cooldownUntil
      // that would otherwise anchor a match.
      const fakeAnchor = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await store.mutate((snap) => {
        const d = snap.registry.slots.find((s) => s.keyId === disabled.keyId);
        if (!d) throw new Error('disabled slot missing');
        d.disableRotation = true;
        snap.state[disabled.keyId].cooldownUntil = fakeAnchor;
        snap.state[disabled.keyId].rateLimitSource = 'error_string';
        snap.state[disabled.keyId].rateLimitedAt = new Date().toISOString();
      });

      await tm.rotateOnRateLimit('hit', { source: 'error_string', cooldownMinutes: 60, knownReset: true });

      const snap = await store.load();
      // active marked normally.
      expect(snap.state[active.keyId].rateLimitSource).toBe('error_string');
      // target NOT propagated (no eligible anchor).
      expect(snap.state[target.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[target.keyId].cooldownUntil).toBeUndefined();
      // disabled untouched (operator-opt-out preserved end-to-end).
      expect(snap.state[disabled.keyId].cooldownUntil).toBe(fakeAnchor);
    });

    it('AC-6a: env CCT_SHARED_BUCKET_WINDOW_MS=300000 widens the match window', async () => {
      process.env.CCT_SHARED_BUCKET_WINDOW_MS = '300000'; // 5 min
      try {
        const { mod, storeMod } = await importSut();
        const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
        const tm = new mod.TokenManager(store);
        await tm.init();
        const [a, , c] = await addSixOauthSlots(tm);
        // Mark A normally.
        await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
        // Shift A's cooldown 4 minutes (240 000 ms) earlier — outside the
        // default 90 s window but within the widened 5-min window.
        await store.mutate((snap) => {
          const aMs = new Date(snap.state[a.keyId].cooldownUntil as string).getTime();
          snap.state[a.keyId].cooldownUntil = new Date(aMs - 240_000).toISOString();
        });
        // Active is B now. Call rotate.
        await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
        const snap = await store.load();
        // C must be propagated (within widened 300 000 ms window).
        expect(snap.state[c.keyId].rateLimitSource).toBe('inferred_shared');
        expect(snap.state[c.keyId].cooldownUntil).toBeDefined();
      } finally {
        delete process.env.CCT_SHARED_BUCKET_WINDOW_MS;
      }
    });

    it('AC-6b: invalid env value falls back to default 90000 with warning logged', async () => {
      process.env.CCT_SHARED_BUCKET_WINDOW_MS = 'not-a-number';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { mod, storeMod } = await importSut();
        const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
        const tm = new mod.TokenManager(store);
        await tm.init();
        const [a, , c] = await addSixOauthSlots(tm);
        await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
        // Shift A's cooldown 4 minutes earlier — outside default 90 s.
        await store.mutate((snap) => {
          const aMs = new Date(snap.state[a.keyId].cooldownUntil as string).getTime();
          snap.state[a.keyId].cooldownUntil = new Date(aMs - 240_000).toISOString();
        });
        await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
        const snap = await store.load();
        // C must NOT be propagated (env was invalid → fallback to 90s window → outside).
        expect(snap.state[c.keyId].rateLimitSource).toBeUndefined();
        expect(snap.state[c.keyId].cooldownUntil).toBeUndefined();
        // Warning surfaced to console (the project's Logger funnels through console).
        const allCalls = [
          ...warnSpy.mock.calls.map((c) => c.join(' ')),
          ...errorSpy.mock.calls.map((c) => c.join(' ')),
        ].join('\n');
        expect(allCalls).toMatch(/CCT_SHARED_BUCKET_WINDOW_MS/);
      } finally {
        delete process.env.CCT_SHARED_BUCKET_WINDOW_MS;
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('AC-9: 6-slot cascade collapses after exactly 2 rotateOnRateLimit calls; 3rd is no-op', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const all = await addSixOauthSlots(tm);
      // Two cascade calls.
      const r1 = await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const r2 = await tm.rotateOnRateLimit('second', {
        source: 'error_string',
        cooldownMinutes: 60,
        knownReset: true,
      });
      expect(r1).not.toBeNull();
      // After call #2 the pool is exhausted — exactly 2 calls is the AC-9 invariant.
      // (A regression that propagated on the FIRST call would also leave r2 === null
      // but the snapshot would show all 6 slots already cooled before r2 fires; the
      // r1 !== null assertion above pins that the FIRST call still rotated to a sibling.)
      expect(r2).toBeNull();
      const snap2 = await store.load();
      const cooled2 = Object.values(snap2.state).filter((s) => s.cooldownUntil).length;
      expect(cooled2).toBe(6);
      // 3rd call must be a true no-op for the propagation pool — every healthy
      // sibling already carries a future cooldown, so AC-4 forbids overwrites.
      // (The active slot's own cooldownUntil is re-stamped by the direct-mark
      // path on every call — that's pre-#801 behavior; the AC-9 invariant is
      // about the propagated siblings, not the active slot.)
      const r3 = await tm.rotateOnRateLimit('third', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      expect(r3).toBeNull();
      const snap3 = await store.load();
      // Sources: first two stay error_string, last four stay inferred_shared
      // (NOT promoted to error_string by the 3rd call).
      expect(snap3.state[all[0].keyId].rateLimitSource).toBe('error_string');
      expect(snap3.state[all[1].keyId].rateLimitSource).toBe('error_string');
      for (let i = 2; i < 6; i++) {
        expect(snap3.state[all[i].keyId].rateLimitSource).toBe('inferred_shared');
        expect(snap3.state[all[i].keyId].cooldownUntil).toBeDefined();
      }
      // AC-4: propagation siblings (i ∈ 2..5) are NOT overwritten by call #3.
      // Slot all[1] is the active slot at call #3 (pinned by call #1 → no eligible
      // rotation in #2 → activeKeyId stays on all[1]) so its cooldownUntil gets
      // re-stamped by the direct-mark path; we explicitly exclude it.
      for (let i = 2; i < 6; i++) {
        expect(snap3.state[all[i].keyId].cooldownUntil).toBe(snap2.state[all[i].keyId].cooldownUntil);
      }
      // Slot all[0] was the active slot at call #1; after call #1 active rotated
      // to all[1] → all[0] is a sibling for calls #2 and #3. Its cooldownUntil
      // was last set by call #1's direct-mark and NOT overwritten by call #2's
      // propagation (AC-4) nor by call #3 (still in future).
      expect(snap3.state[all[0].keyId].cooldownUntil).toBe(snap2.state[all[0].keyId].cooldownUntil);
    });

    it('AC-10: knownReset=false suppresses propagation even when a within-window match exists', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [, b, c] = await addSixOauthSlots(tm);
      // First call seeds A's cooldown (knownReset:true, source=error_string).
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      // Second call has knownReset:false (caller's parseCooldownTime returned null).
      // A's cooldownUntil is within window but trigger gate must reject.
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: false });
      const snap = await store.load();
      // B marked normally, but no propagation to C.
      expect(snap.state[b.keyId].rateLimitSource).toBe('error_string');
      expect(snap.state[c.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[c.keyId].cooldownUntil).toBeUndefined();
    });

    it('AC-11a: sibling rateLimitSource=manual cannot anchor a match', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [a, , c] = await addSixOauthSlots(tm);
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      // Re-stamp A as manual.
      await store.mutate((snap) => {
        snap.state[a.keyId].rateLimitSource = 'manual';
      });
      // 2nd call: A has cooldownUntil within window but its source is 'manual' → cannot anchor.
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const snap = await store.load();
      expect(snap.state[c.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[c.keyId].cooldownUntil).toBeUndefined();
    });

    it('AC-11b: sibling rateLimitSource=inferred_shared cannot anchor a match (no chaining)', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const [a, , c] = await addSixOauthSlots(tm);
      await tm.rotateOnRateLimit('first', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      // Re-stamp A as inferred_shared.
      await store.mutate((snap) => {
        snap.state[a.keyId].rateLimitSource = 'inferred_shared';
      });
      // 2nd call: A's cooldownUntil within window but source 'inferred_shared' cannot anchor.
      await tm.rotateOnRateLimit('second', { source: 'error_string', cooldownMinutes: 60, knownReset: true });
      const snap = await store.load();
      expect(snap.state[c.keyId].rateLimitSource).toBeUndefined();
      expect(snap.state[c.keyId].cooldownUntil).toBeUndefined();
    });
  });
});
