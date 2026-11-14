/** A cron job an environment user owns is asked of the admins: the environment user is never a person. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ createReq: vi.fn(), markHandled: vi.fn() }));
vi.mock('../../cron-run-request-store', () => ({
  createCronRunRequest: h.createReq,
  markCronRunRequestHandled: h.markHandled,
}));
vi.mock('../../admin-utils', () => ({ getAdminUsers: () => new Set(['UADMIN1', 'UADMIN2']) }));
vi.mock('../../env-users', () => ({ isEnvironmentUser: (u: string) => u === 'env:acme-stage0' }));

import { describeDelivery, requestCronRunPermission } from '../cron-run-permission-request';

const input = {
  requesterId: 'U_BOB',
  ownerId: 'env:acme-stage0',
  jobId: 'job-1',
  jobName: 'stage0-daily-deploy',
  channel: 'C1',
  threadTs: 'T1',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.createReq.mockReturnValue({ requestId: 'r1', ...input, handled: false, reused: false });
});

describe('requestCronRunPermission — environment user owner', () => {
  it('DMs every admin instead of the environment user', async () => {
    const slackApi = {
      openDmChannel: vi.fn(async (u: string) => `D_${u}`),
      postMessage: vi.fn().mockResolvedValue({ ts: 'x' }),
    };
    const res = await requestCronRunPermission({ ...input, slackApi });
    expect(res.delivered).toBe('dm');
    expect(slackApi.openDmChannel.mock.calls.map((c) => c[0]).sort()).toEqual(['UADMIN1', 'UADMIN2']);
    expect(slackApi.openDmChannel).not.toHaveBeenCalledWith('env:acme-stage0');
    expect(JSON.stringify(slackApi.postMessage.mock.calls)).toContain('cron_run_perm_');
  });

  it('tells the requester the admins were asked', () => {
    expect(describeDelivery('dm', 'env:acme-stage0', 'stage0-daily-deploy')).toContain('어드민');
  });
});
