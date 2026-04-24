/**
 * Tests for #701 — refresh diagnostic fields on `SlotState`, wired through
 * `TokenManager.refreshAccessToken` + `markRefreshFailure` +
 * `#detachOAuthOnSetupSlot` + `attachOAuth`.
 *
 * Covers:
 *   - Per-kind failure persistence (401/403/429/5xx/network/timeout/parse).
 *   - authState flip: unauthorized→refresh_failed, revoked→revoked, others stay healthy.
 *   - Success path clears all four refresh fields + zeroes counter.
 *   - Consecutive-failure counter accumulates and resets.
 *   - Generation guard: `markRefreshFailure` no-ops when detach or re-attach
 *     lands mid-refresh (no orphan `state[keyId]` resurrection).
 *   - Attach + detach both clear the four refresh fields.
 *   - Adversarial token pattern in `err.message` never reaches the stored
 *     `lastRefreshError.message`.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshClaudeCredentialsMock = vi.hoisted(() => vi.fn());
const fetchUsageMock = vi.hoisted(() => vi.fn());
const fetchOAuthProfileMock = vi.hoisted(() => vi.fn());

vi.mock('./oauth/refresher', async () => {
  const actual = await vi.importActual<typeof import('./oauth/refresher')>('./oauth/refresher');
  return { ...actual, refreshClaudeCredentials: refreshClaudeCredentialsMock };
});

vi.mock('./oauth/usage', async () => {
  const actual = await vi.importActual<typeof import('./oauth/usage')>('./oauth/usage');
  return { ...actual, fetchUsage: fetchUsageMock };
});

vi.mock('./oauth/profile', async () => {
  const actual = await vi.importActual<typeof import('./oauth/profile')>('./oauth/profile');
  return { ...actual, fetchOAuthProfile: fetchOAuthProfileMock };
});

const VALID_OAUTH_SCOPES = ['user:profile', 'user:inference'];

async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tm-refresh-diag-'));
}

async function importSut() {
  vi.resetModules();
  const mod = await import('./token-manager');
  const storeMod = await import('./cct-store');
  return { mod, storeMod };
}

function makeOAuthCreds(
  overrides: Partial<import('./oauth/refresher').OAuthCredentials> = {},
): import('./oauth/refresher').OAuthCredentials {
  return {
    accessToken: 'sk-ant-oat01-abc',
    refreshToken: 'sk-ant-ort01-xyz',
    // expiresAtMs in the past so refreshAccessToken actually fires on first
    // resolve; the refresh-credentials helper in prod buffers at 7h.
    expiresAtMs: Date.now() - 60_000,
    scopes: [...VALID_OAUTH_SCOPES],
    ...overrides,
  };
}

describe('refresh diagnostics (#701)', () => {
  const originalEnv = { ...process.env };
  let tmp: string;

  beforeEach(async () => {
    vi.resetModules();
    refreshClaudeCredentialsMock.mockReset();
    fetchUsageMock.mockReset();
    fetchOAuthProfileMock.mockReset();
    fetchOAuthProfileMock.mockImplementation(async () => ({
      fetchedAt: Date.now(),
      email: 'test@example.com',
      rateLimitTier: 'default_claude_max_20x',
    }));
    // fetchAndStoreUsage is fired from attachOAuth — give it a benign default.
    fetchUsageMock.mockResolvedValue({
      snapshot: { fetchedAt: new Date().toISOString() },
      nextFetchAllowedAtMs: Date.now() + 60_000,
    });
    tmp = await makeTmp();
    process.env = { ...originalEnv };
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
    process.env.SOMA_CCT_DISABLE_ENV_SEED = 'true';
  });

  afterEach(async () => {
    process.env = originalEnv;
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

  // Helper: stand up a TokenManager with a single attached OAuth slot whose
  // access token is already expired, so the next `refreshCredentialsIfNeeded`
  // invocation triggers the refresh endpoint.
  async function setup() {
    const { mod, storeMod } = await importSut();
    const { OAuthRefreshError } = await import('./oauth/refresher');
    const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
    const tm = new mod.TokenManager(store);
    await tm.init();
    const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
    await tm.attachOAuth(slot.keyId, makeOAuthCreds(), true);
    return { mod, storeMod, store, tm, slot, OAuthRefreshError };
  }

  describe('per-kind failure persistence', () => {
    it('401 → lastRefreshError.kind=unauthorized + authState=refresh_failed', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(
        new OAuthRefreshError(401, '{"error":"invalid_grant"}', 'boom'),
      );
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      const st = (await store.load()).state[slot.keyId];
      expect(st?.authState).toBe('refresh_failed');
      expect(st?.lastRefreshError).toMatchObject({
        kind: 'unauthorized',
        status: 401,
        message: 'Refresh rejected (401 invalid_grant)',
      });
      expect(st?.lastRefreshFailedAt).toBeTypeOf('number');
      expect(st?.consecutiveRefreshFailures).toBe(1);
    });

    it('403 → revoked + authState=revoked', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new OAuthRefreshError(403, '{"error":"revoked"}', 'boom'));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      const st = (await store.load()).state[slot.keyId];
      expect(st?.authState).toBe('revoked');
      expect(st?.lastRefreshError).toMatchObject({ kind: 'revoked', status: 403 });
    });

    it('429 → rate_limited + authState stays healthy', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new OAuthRefreshError(429, '', 'slow down'));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      const st = (await store.load()).state[slot.keyId];
      expect(st?.authState).toBe('healthy');
      expect(st?.lastRefreshError).toMatchObject({ kind: 'rate_limited', status: 429 });
    });

    it('500 → server + authState stays healthy', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new OAuthRefreshError(500, '', 'oops'));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      const st = (await store.load()).state[slot.keyId];
      expect(st?.authState).toBe('healthy');
      expect(st?.lastRefreshError).toMatchObject({
        kind: 'server',
        status: 500,
        message: 'Refresh server error (500)',
      });
    });

    it('network (TypeError fetch failed) → network + authState stays healthy', async () => {
      const { tm, store, slot } = await setup();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      const st = (await store.load()).state[slot.keyId];
      expect(st?.authState).toBe('healthy');
      expect(st?.lastRefreshError).toMatchObject({ kind: 'network', message: 'Refresh network error' });
    });

    it('timeout (AbortError) → timeout', async () => {
      const { tm, store, slot } = await setup();
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      refreshClaudeCredentialsMock.mockRejectedValueOnce(abortErr);
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      const st = (await store.load()).state[slot.keyId];
      expect(st?.authState).toBe('healthy');
      expect(st?.lastRefreshError).toMatchObject({ kind: 'timeout', message: 'Refresh timed out after 30s' });
    });

    it('parse (empty body + "not valid JSON" prefix) → parse', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(
        new OAuthRefreshError(200, '', 'OAuth refresh response was not valid JSON: Unexpected'),
      );
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      const st = (await store.load()).state[slot.keyId];
      expect(st?.authState).toBe('healthy');
      expect(st?.lastRefreshError).toMatchObject({ kind: 'parse', message: 'Refresh response malformed' });
    });
  });

  describe('success clears failure fields', () => {
    it('failure → success clears lastRefreshError, lastRefreshFailedAt and zeros counter', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      // First: 429 — persists failure.
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new OAuthRefreshError(429, '', 'boom'));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      // Second: success — should clear. Default mock is success.
      refreshClaudeCredentialsMock.mockResolvedValueOnce({
        accessToken: 'sk-ant-oat01-fresh',
        refreshToken: 'sk-ant-ort01-fresh',
        expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
        scopes: [...VALID_OAUTH_SCOPES],
      });
      await tm.refreshCredentialsIfNeeded(slot.keyId);
      const st = (await store.load()).state[slot.keyId];
      expect(st?.lastRefreshError).toBeUndefined();
      expect(st?.lastRefreshFailedAt).toBeUndefined();
      expect(st?.consecutiveRefreshFailures).toBe(0);
      expect(st?.lastRefreshAt).toBeTypeOf('number');
      expect(st?.authState).toBe('healthy');
    });

    it('consecutive failures increment; success resets', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new OAuthRefreshError(429, '', 'x'));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new OAuthRefreshError(429, '', 'x'));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new OAuthRefreshError(500, '', 'x'));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      let st = (await store.load()).state[slot.keyId];
      expect(st?.consecutiveRefreshFailures).toBe(3);
      // Success resets.
      refreshClaudeCredentialsMock.mockResolvedValueOnce({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
        scopes: [...VALID_OAUTH_SCOPES],
      });
      await tm.refreshCredentialsIfNeeded(slot.keyId);
      st = (await store.load()).state[slot.keyId];
      expect(st?.consecutiveRefreshFailures).toBe(0);
    });
  });

  describe('generation guard', () => {
    it('refresh failure lost to detach does NOT persist onto removed slot', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((r) => {
        releaseRefresh = r;
      });
      let signalStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        signalStarted = r;
      });
      refreshClaudeCredentialsMock.mockImplementationOnce(async () => {
        signalStarted();
        await refreshGate;
        throw new OAuthRefreshError(500, '', 'boom');
      });
      const refreshPromise = tm.refreshCredentialsIfNeeded(slot.keyId);
      await startedPromise;
      await tm.detachOAuth(slot.keyId);
      const postDetachSnap = structuredClone(await store.load());
      releaseRefresh();
      await expect(refreshPromise).rejects.toThrow();
      const finalSnap = await store.load();
      // detach clears the four refresh fields. A markRefreshFailure that won
      // the generation race would re-write them — assert that didn't happen.
      const normalize = <T extends { revision: number }>(s: T): T => ({ ...s, revision: 0 });
      expect(normalize(finalSnap)).toEqual(normalize(postDetachSnap));
      expect(finalSnap.state[slot.keyId]?.lastRefreshError).toBeUndefined();
      expect(finalSnap.state[slot.keyId]?.lastRefreshFailedAt).toBeUndefined();
    });

    it('refresh failure does NOT leak onto a fresh attach generation', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((r) => {
        releaseRefresh = r;
      });
      let signalStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        signalStarted = r;
      });
      refreshClaudeCredentialsMock.mockImplementationOnce(async () => {
        signalStarted();
        await refreshGate;
        throw new OAuthRefreshError(429, '', 'boom');
      });
      const refreshPromise = tm.refreshCredentialsIfNeeded(slot.keyId);
      await startedPromise;
      await tm.detachOAuth(slot.keyId);
      // Re-attach with fresh creds — new `attachedAt` generation.
      await new Promise((r) => setTimeout(r, 5));
      await tm.attachOAuth(slot.keyId, makeOAuthCreds({ accessToken: 'sk-ant-oat01-new' }), true);
      releaseRefresh();
      await expect(refreshPromise).rejects.toThrow();
      const st = (await store.load()).state[slot.keyId];
      // Fresh generation must be pristine — the refused write belongs to the
      // old `attachedAt` and the generation guard should have dropped it.
      expect(st?.lastRefreshError).toBeUndefined();
      expect(st?.lastRefreshFailedAt).toBeUndefined();
      expect(st?.consecutiveRefreshFailures).toBeUndefined();
      expect(st?.authState).toBe('healthy');
    });
  });

  describe('attach / detach clear diagnostics', () => {
    it('detachOAuth clears all four refresh fields', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new OAuthRefreshError(500, '', 'x'));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      let st = (await store.load()).state[slot.keyId];
      expect(st?.lastRefreshError).toBeDefined();
      await tm.detachOAuth(slot.keyId);
      st = (await store.load()).state[slot.keyId];
      expect(st?.lastRefreshAt).toBeUndefined();
      expect(st?.lastRefreshFailedAt).toBeUndefined();
      expect(st?.lastRefreshError).toBeUndefined();
      expect(st?.consecutiveRefreshFailures).toBeUndefined();
    });

    it('attachOAuth clears diagnostics pre-seeded in state[keyId]', async () => {
      const { mod, storeMod } = await importSut();
      const store = new storeMod.CctStore(path.join(tmp, 'cct-store.json'));
      const tm = new mod.TokenManager(store);
      await tm.init();
      const slot = await tm.addSlot({ name: 'cct1', kind: 'setup_token', value: 'sk-ant-oat01-aaa' });
      // Seed state with stale diagnostics via direct mutate (simulating a
      // prior attach → failure → detach sequence that left residue).
      await (store as any).mutate((snap: any) => {
        snap.state[slot.keyId] = {
          authState: 'refresh_failed',
          activeLeases: [],
          lastRefreshAt: 1_000,
          lastRefreshFailedAt: 2_000,
          lastRefreshError: { kind: 'rate_limited', status: 429, message: 'Refresh throttled (429)', at: 2_000 },
          consecutiveRefreshFailures: 5,
        };
      });
      // Now attach — the new generation must start clean.
      await tm.attachOAuth(slot.keyId, makeOAuthCreds(), true);
      const st = (await store.load()).state[slot.keyId];
      expect(st?.authState).toBe('healthy');
      expect(st?.lastRefreshAt).toBeUndefined();
      expect(st?.lastRefreshFailedAt).toBeUndefined();
      expect(st?.lastRefreshError).toBeUndefined();
      expect(st?.consecutiveRefreshFailures).toBeUndefined();
    });
  });

  describe('adversarial secret redaction', () => {
    it('sk-ant-oat01- pattern in OAuthRefreshError.message never reaches stored message', async () => {
      const { tm, store, slot, OAuthRefreshError } = await setup();
      const adversary = 'sk-ant-oat01-LEAKEDLEAKEDLEAKEDLEAKED';
      refreshClaudeCredentialsMock.mockRejectedValueOnce(new OAuthRefreshError(500, adversary, `oops ${adversary}`));
      await expect(tm.refreshCredentialsIfNeeded(slot.keyId)).rejects.toThrow();
      const st = (await store.load()).state[slot.keyId];
      const msg = st?.lastRefreshError?.message ?? '';
      expect(msg).toBe('Refresh server error (500)');
      expect(msg).not.toContain('sk-ant-');
      expect(msg).not.toContain(adversary);
    });
  });
});
