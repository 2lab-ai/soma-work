import { describe, expect, it, vi } from 'vitest';

vi.mock('../env-users', () => ({ isEnvironmentUser: (u: string) => u === 'env:acme-dev2' }));

import {
  createPermissionRequest,
  getPermissionRequest,
  hasPendingRequestsFor,
  retirePendingRequests,
} from '../skill-permission-request-store';

describe('createPermissionRequest — environment user owner', () => {
  const base = { operation: 'invoke' as const, requesterId: 'U1', ownerId: 'env:acme-dev2', skillName: 'deploy' };

  it('different words are a new request — an admin never approves one message and runs another', () => {
    const a = createPermissionRequest({ ...base, channel: 'C1', threadTs: 'T1', originalText: '$acme-dev2:deploy A' });
    const b = createPermissionRequest({ ...base, channel: 'C1', threadTs: 'T1', originalText: '$acme-dev2:deploy B' });
    expect(b.reused).toBeFalsy();
    expect(b.requestId).not.toBe(a.requestId);
    expect(b.originalText).toBe('$acme-dev2:deploy B');
  });

  it('another thread is a new request', () => {
    const a = createPermissionRequest({ ...base, channel: 'C1', threadTs: 'T2', originalText: 'same' });
    const b = createPermissionRequest({ ...base, channel: 'C1', threadTs: 'T3', originalText: 'same' });
    expect(b.requestId).not.toBe(a.requestId);
  });

  it('the same words in the same thread are the same request', () => {
    const a = createPermissionRequest({ ...base, channel: 'C9', threadTs: 'T9', originalText: 'again' });
    const b = createPermissionRequest({ ...base, channel: 'C9', threadTs: 'T9', originalText: 'again' });
    expect(b.reused).toBe(true);
    expect(b.requestId).toBe(a.requestId);
  });

  it('retires every pending request for the same message, and only those', () => {
    const a = createPermissionRequest({ ...base, channel: 'C5', threadTs: 'T5', originalText: 'run it' });
    const other = createPermissionRequest({ ...base, channel: 'C5', threadTs: 'T5', originalText: 'something else' });
    retirePendingRequests({
      ownerId: base.ownerId,
      requesterId: 'U1',
      channel: 'C5',
      threadTs: 'T5',
      originalText: 'run it',
    });
    expect(getPermissionRequest(a.requestId)?.handled).toBe(true);
    expect(getPermissionRequest(other.requestId)?.handled).toBe(false);
  });

  it('knows whether another request for the same message is still pending', () => {
    const m = { ownerId: base.ownerId, requesterId: 'U1', channel: 'C7', threadTs: 'T7', originalText: 'two skills' };
    const deploy = createPermissionRequest({
      ...base,
      skillName: 'deploy',
      channel: 'C7',
      threadTs: 'T7',
      originalText: 'two skills',
    });
    createPermissionRequest({ ...base, skillName: 'qa', channel: 'C7', threadTs: 'T7', originalText: 'two skills' });
    expect(hasPendingRequestsFor(m)).toBe(true);
    retirePendingRequests(m);
    expect(hasPendingRequestsFor(m)).toBe(false);
    expect(getPermissionRequest(deploy.requestId)?.handled).toBe(true);
  });
});
