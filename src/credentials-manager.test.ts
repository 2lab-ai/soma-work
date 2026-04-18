import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock TokenManager module before importing credentials-manager
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

vi.mock('./token-manager', () => ({
  getTokenManager: vi.fn(() => mockTokenManager),
  TokenManager: class {},
}));

// Avoid touching config / logger filesystem
vi.mock('./config', () => ({
  config: { credentials: { enabled: false } },
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
  it('returns a lease with the expected shape (setup_token)', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L1',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ slotId: 'slot-A', name: 'setup1', kind: 'setup_token' });
    mockGetValidAccessToken.mockResolvedValue('sk-ant-oat01-TEST');

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'test:owner');

    expect(lease.slotId).toBe('slot-A');
    expect(lease.kind).toBe('setup_token');
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
    mockGetActiveToken.mockReturnValue({ slotId: 'slot-A', name: 'setup1', kind: 'setup_token' });
    mockGetValidAccessToken.mockResolvedValue('tok');

    await ensureActiveSlotAuth(mockTokenManager as any, 'tag', 30_000);
    expect(mockAcquireLease).toHaveBeenCalledWith('tag', 30_000);
  });

  it('throws NoHealthySlotError when acquireLease fails (no leak)', async () => {
    mockAcquireLease.mockRejectedValue(new Error('no healthy slot available'));

    await expect(ensureActiveSlotAuth(mockTokenManager as any, 'test')).rejects.toBeInstanceOf(NoHealthySlotError);
    expect(mockReleaseLease).not.toHaveBeenCalled();
  });

  it('for oauth_credentials slots, accessToken is the value returned by getValidAccessToken (refresh)', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L3',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ slotId: 'slot-O', name: 'oauth1', kind: 'oauth_credentials' });
    mockGetValidAccessToken.mockResolvedValue('refreshed-access-token');

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'owner');
    expect(lease.accessToken).toBe('refreshed-access-token');
    expect(lease.kind).toBe('oauth_credentials');
    expect(mockGetValidAccessToken).toHaveBeenCalledWith('slot-O');
  });

  it('release() is idempotent', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L4',
      ownerTag: 'test',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetActiveToken.mockReturnValue({ slotId: 'slot-A', name: 'setup1', kind: 'setup_token' });
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
    mockGetActiveToken.mockReturnValue({ slotId: 'slot-O', name: 'oauth1', kind: 'oauth_credentials' });
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
    mockGetActiveToken.mockReturnValue({ slotId: 'slot-A', name: 'setup1', kind: 'setup_token' });
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
    mockGetActiveToken.mockReturnValue({ slotId: 'slot-A', name: 'setup1', kind: 'setup_token' });
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
