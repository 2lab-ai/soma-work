import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock TokenManager module before importing credentials-manager
const mockAcquireLease = vi.fn();
const mockReleaseLease = vi.fn(async () => {});
const mockHeartbeatLease = vi.fn(async () => {});
const mockApplyToken = vi.fn(async () => {});
const mockMarkAuthState = vi.fn(async () => {});

const mockTokenManager = {
  acquireLease: mockAcquireLease,
  releaseLease: mockReleaseLease,
  heartbeatLease: mockHeartbeatLease,
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
});

describe('ensureActiveSlotAuth', () => {
  it('returns a lease with the expected shape (setup_token)', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L1',
      slotId: 'slot-A',
      name: 'setup1',
      kind: 'setup_token',
      accessToken: 'sk-ant-oat01-TEST',
    });

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'test:owner');

    expect(lease.slotId).toBe('slot-A');
    expect(lease.name).toBe('setup1');
    expect(lease.kind).toBe('setup_token');
    expect(lease.accessToken).toBe('sk-ant-oat01-TEST');
    expect(lease.configDir).toBeUndefined();
    expect(typeof lease.release).toBe('function');
    expect(typeof lease.heartbeat).toBe('function');
    expect(mockAcquireLease).toHaveBeenCalledWith('test:owner', undefined);
  });

  it('forwards ttlMs to acquireLease', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L2',
      slotId: 'slot-A',
      name: 'setup1',
      kind: 'setup_token',
      accessToken: 'tok',
    });

    await ensureActiveSlotAuth(mockTokenManager as any, 'tag', 30_000);
    expect(mockAcquireLease).toHaveBeenCalledWith('tag', 30_000);
  });

  it('throws NoHealthySlotError when acquireLease fails (no leak)', async () => {
    mockAcquireLease.mockRejectedValue(new Error('no healthy slot available'));

    await expect(ensureActiveSlotAuth(mockTokenManager as any, 'test')).rejects.toBeInstanceOf(NoHealthySlotError);
    expect(mockReleaseLease).not.toHaveBeenCalled();
  });

  it('carries accessToken from acquireLease through to the lease (oauth_credentials)', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L3',
      slotId: 'slot-O',
      name: 'oauth1',
      kind: 'oauth_credentials',
      accessToken: 'refreshed-access-token',
      configDir: '/var/soma/cct-store.dirs/slot-O',
    });

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'owner');
    expect(lease.accessToken).toBe('refreshed-access-token');
    expect(lease.kind).toBe('oauth_credentials');
    expect(lease.configDir).toBe('/var/soma/cct-store.dirs/slot-O');
  });

  it('populates lease.configDir for oauth_credentials slots', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L3b',
      slotId: 'slot-O2',
      name: 'oauth2',
      kind: 'oauth_credentials',
      accessToken: 'tok',
      configDir: '/data/cct-store.dirs/slot-O2',
    });

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'owner');
    expect(lease.configDir).toBe('/data/cct-store.dirs/slot-O2');
  });

  it('leaves lease.configDir undefined for setup_token slots', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L3c',
      slotId: 'slot-S',
      name: 'setup2',
      kind: 'setup_token',
      accessToken: 'tok',
      // configDir intentionally omitted — setup_token slots do not own one.
    });

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'owner');
    expect(lease.configDir).toBeUndefined();
  });

  it('release() is idempotent', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L4',
      slotId: 'slot-A',
      name: 'setup1',
      kind: 'setup_token',
      accessToken: 'tok',
    });

    const lease = await ensureActiveSlotAuth(mockTokenManager as any, 'owner');
    await lease.release();
    await lease.release();
    await lease.release();
    expect(mockReleaseLease).toHaveBeenCalledTimes(1);
  });

  it('heartbeat() forwards to tokenManager.heartbeatLease while active', async () => {
    mockAcquireLease.mockResolvedValue({
      leaseId: 'L7',
      slotId: 'slot-A',
      name: 'setup1',
      kind: 'setup_token',
      accessToken: 'tok',
    });

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
      slotId: 'slot-A',
      name: 'setup1',
      kind: 'setup_token',
      accessToken: 'tok',
    });

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
