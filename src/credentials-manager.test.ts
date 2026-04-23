import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock TokenManager module before importing credentials-manager. Keep the
// REAL `TokenManager` class exported so the real-integration test below can
// construct one against a tmp CctStore; only `getTokenManager()` is stubbed
// to return the in-test mock double.
const mockAcquireLease = vi.fn();
const mockReleaseLease = vi.fn(async () => {});
const mockHeartbeatLease = vi.fn(async () => {});
const mockGetActiveToken = vi.fn();
const mockGetValidAccessToken = vi.fn();
const mockApplyToken = vi.fn(async () => {});
const mockMarkAuthState = vi.fn(async () => {});

const mockTokenManager = {
  acquireLease: mockAcquireLease,
  releaseLease: mockReleaseLease,
  heartbeatLease: mockHeartbeatLease,
  getActiveToken: mockGetActiveToken,
  getValidAccessToken: mockGetValidAccessToken,
  applyToken: mockApplyToken,
  markAuthState: mockMarkAuthState,
  listTokens: vi.fn(() => []),
};

vi.mock('./token-manager', async () => {
  const actual = await vi.importActual<typeof import('./token-manager')>('./token-manager');
  return {
    ...actual,
    getTokenManager: vi.fn(() => mockTokenManager),
  };
});

// Avoid touching config / logger filesystem
vi.mock('./config', () => ({
  config: { credentials: { enabled: false }, oauthProfile: { enabled: false, timeoutMs: 5000 } },
}));

import { ensureActiveSlotAuth, ensureValidCredentials, NoHealthySlotError } from './credentials-manager';

beforeEach(() => {
  mockAcquireLease.mockReset();
  mockReleaseLease.mockReset();
  mockReleaseLease.mockResolvedValue(undefined);
  mockHeartbeatLease.mockReset();
  mockHeartbeatLease.mockResolvedValue(undefined);
  mockGetActiveToken.mockReset();
  mockGetValidAccessToken.mockReset();
});

describe('ensureActiveSlotAuth', () => {
  it('returns a lease with the expected shape (cct slot)', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L1',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ keyId: 'slot-A', name: 'setup1', kind: 'cct' });
    mockGetValidAccessToken.mockResolvedValue('sk-ant-oat01-TEST');

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'test:owner');

    expect(lease.keyId).toBe('slot-A');
    expect(lease.kind).toBe('cct');
    expect(lease.accessToken).toBe('sk-ant-oat01-TEST');
    expect(typeof lease.release).toBe('function');
    expect(typeof lease.heartbeat).toBe('function');
    expect(mockAcquireLease).toHaveBeenCalledWith('test:owner', undefined);
  });

  it('forwards ttlMs to acquireLease', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L2',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ keyId: 'slot-A', name: 'setup1', kind: 'cct' });
    mockGetValidAccessToken.mockResolvedValue('tok');

    await ensureActiveSlotAuth(mockTokenManager as any, 'tag', 30_000);
    expect(mockAcquireLease).toHaveBeenCalledWith('tag', 30_000);
  });

  it('throws NoHealthySlotError when acquireLease fails (no leak)', async () => {
    mockAcquireLease.mockRejectedValue(new Error('no healthy slot available'));

    await expect(ensureActiveSlotAuth(mockTokenManager as any, 'test')).rejects.toBeInstanceOf(NoHealthySlotError);
    expect(mockReleaseLease).not.toHaveBeenCalled();
  });

  it('for cct slots with oauth attachment, accessToken is the value returned by getValidAccessToken (refresh)', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L3',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ keyId: 'slot-O', name: 'oauth1', kind: 'cct' });
    mockGetValidAccessToken.mockResolvedValue('refreshed-access-token');

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'owner');
    expect(lease.accessToken).toBe('refreshed-access-token');
    expect(lease.kind).toBe('cct');
    expect(mockGetValidAccessToken).toHaveBeenCalledWith('slot-O', 'dispatch');
  });

  it('release() is idempotent', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L4',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ keyId: 'slot-A', name: 'setup1', kind: 'cct' });
    mockGetValidAccessToken.mockResolvedValue('tok');

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'owner');
    await lease.release();
    await lease.release();
    await lease.release();
    expect(mockReleaseLease).toHaveBeenCalledTimes(1);
  });

  it('releases the underlying lease when getValidAccessToken throws', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L5',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ keyId: 'slot-O', name: 'oauth1', kind: 'cct' });
    mockGetValidAccessToken.mockRejectedValue(new Error('refresh 401'));

    await expect(ensureActiveSlotAuth(mockTokenManager as any, 'owner')).rejects.toBeInstanceOf(NoHealthySlotError);
    expect(mockReleaseLease).toHaveBeenCalledWith('L5');
  });

  it('throws NoHealthySlotError (and releases) when getActiveToken returns null', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L6',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue(null);

    await expect(ensureActiveSlotAuth(mockTokenManager as any, 'owner')).rejects.toBeInstanceOf(NoHealthySlotError);
    expect(mockReleaseLease).toHaveBeenCalledWith('L6');
  });

  it('heartbeat() forwards to tokenManager.heartbeatLease while active', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L7',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ keyId: 'slot-A', name: 'setup1', kind: 'cct' });
    mockGetValidAccessToken.mockResolvedValue('tok');

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'owner');
    await lease.heartbeat();
    expect(mockHeartbeatLease).toHaveBeenCalledWith('L7');

    await lease.release();
    // After release, heartbeat is a no-op.
    mockHeartbeatLease.mockClear();
    await lease.heartbeat();
    expect(mockHeartbeatLease).not.toHaveBeenCalled();
  });
});

describe('ensureValidCredentials (legacy wrapper)', () => {
  it('returns {valid:true} on successful acquisition', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L-compat',
      ownerTag: 'legacy',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ keyId: 'slot-A', name: 'setup1', kind: 'cct' });
    mockGetValidAccessToken.mockResolvedValue('tok');

    const r = await ensureValidCredentials();
    expect(r.valid).toBe(true);
    // Lease must be released immediately by the legacy wrapper.
    expect(mockReleaseLease).toHaveBeenCalledTimes(1);
  });

  it('returns {valid:false, error} on NoHealthySlotError', async () => {
    mockAcquireLease.mockRejectedValue(new Error('empty pool'));

    const r = await ensureValidCredentials();
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.error).toMatch(/No healthy CCT slot/);
  });
});

// ── Integration: issue #673 — lease.accessToken must be the slot's
// setupToken for cct/setup+attachment slots, NOT the 1h OAuth access_token. ─
describe('ensureActiveSlotAuth (issue #673 dispatch-token integration)', () => {
  it('for cct/setup WITH attachment, lease.accessToken === slot.setupToken', async () => {
    const { TokenManager } = await import('./token-manager');
    const { CctStore } = await import('./cct-store');

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-673-'));
    const prevSeedFlag = process.env.SOMA_CCT_DISABLE_ENV_SEED;
    const prevList = process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
    const prevSingle = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.SOMA_CCT_DISABLE_ENV_SEED = 'true';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const store = new CctStore(path.join(tmp, 'cct-store.json'));
    const tm = new TokenManager(store);
    try {
      await tm.init();

      const SETUP_TOKEN = 'sk-ant-oat01-SETUP-ONE-YEAR';
      const slot = await tm.addSlot({ name: 'setup-673', kind: 'setup_token', value: SETUP_TOKEN });

      // Attach an OAuth blob whose accessToken is DIFFERENT from setupToken.
      // A correctly-fixed dispatch path must ignore this and surface setupToken.
      await tm.attachOAuth(
        slot.keyId,
        {
          accessToken: 'sk-ant-oat01-ONE-HOUR-OAUTH',
          refreshToken: 'sk-ant-ort01-refresh',
          expiresAtMs: Date.now() + 10 * 60 * 60 * 1000,
          scopes: ['user:profile', 'user:inference'],
        },
        true,
      );

      const lease = await ensureActiveSlotAuth(tm as any, 'test:issue-673');
      try {
        expect(lease.keyId).toBe(slot.keyId);
        expect(lease.accessToken).toBe(SETUP_TOKEN);
      } finally {
        await lease.release();
      }
    } finally {
      tm.stop();
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      if (prevSeedFlag === undefined) delete process.env.SOMA_CCT_DISABLE_ENV_SEED;
      else process.env.SOMA_CCT_DISABLE_ENV_SEED = prevSeedFlag;
      if (prevList === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = prevList;
      if (prevSingle === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevSingle;
    }
  });
});
