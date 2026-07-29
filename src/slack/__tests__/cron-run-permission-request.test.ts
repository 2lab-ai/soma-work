/**
 * Delivery contract of the owner prompt.
 *
 * Two properties matter beyond "a DM was sent":
 *  - a repeated ask must NOT re-deliver (otherwise `cron run` in a loop is a
 *    DM cannon aimed at the owner), and
 *  - a prompt that reached nobody must NOT leave a live request behind, or
 *    every later ask dedupes into "already pending" against a prompt the owner
 *    never saw, until the 24h TTL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createReq: vi.fn(),
  markHandled: vi.fn(),
}));

vi.mock('../../cron-run-request-store', () => ({
  createCronRunRequest: h.createReq,
  markCronRunRequestHandled: h.markHandled,
}));

import { requestCronRunPermission } from '../cron-run-permission-request';

const input = {
  requesterId: 'U_BOB',
  ownerId: 'U_ALICE',
  jobId: 'job-1',
  jobName: 'deploy',
  channel: 'C1',
  threadTs: 'T1',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.createReq.mockReturnValue({ requestId: 'r1', ...input, handled: false, reused: false });
});

describe('requestCronRunPermission', () => {
  it('DMs the owner and reports dm delivery', async () => {
    const slackApi = {
      openDmChannel: vi.fn().mockResolvedValue('D_ALICE'),
      postMessage: vi.fn().mockResolvedValue({ ts: 'x' }),
    };
    const res = await requestCronRunPermission({ ...input, slackApi });
    expect(res.delivered).toBe('dm');
    expect(slackApi.postMessage.mock.calls[0][0]).toBe('D_ALICE');
    expect(JSON.stringify(slackApi.postMessage.mock.calls[0])).toContain('cron_run_perm_');
    expect(h.markHandled).not.toHaveBeenCalled();
  });

  it('sends nothing at all when the request was reused', async () => {
    h.createReq.mockReturnValue({ requestId: 'r1', ...input, handled: false, reused: true });
    const slackApi = {
      openDmChannel: vi.fn().mockResolvedValue('D_ALICE'),
      postMessage: vi.fn().mockResolvedValue({ ts: 'x' }),
    };
    const res = await requestCronRunPermission({ ...input, slackApi, postFallback: vi.fn() });
    expect(res.delivered).toBe('pending');
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
    expect(slackApi.postMessage).not.toHaveBeenCalled();
  });

  it('falls back to the asking thread when the DM throws', async () => {
    const slackApi = {
      openDmChannel: vi.fn().mockRejectedValue(new Error('cannot_dm_bot')),
      postMessage: vi.fn(),
    };
    const postFallback = vi.fn().mockResolvedValue(undefined);
    const res = await requestCronRunPermission({ ...input, slackApi, postFallback });
    expect(res.delivered).toBe('fallback');
    expect(postFallback).toHaveBeenCalledOnce();
    expect(h.markHandled).not.toHaveBeenCalled();
  });

  it('retires the request when nothing could be delivered — no 24h poison', async () => {
    const res = await requestCronRunPermission({ ...input, slackApi: undefined, postFallback: undefined });
    expect(res.delivered).toBe('none');
    expect(h.markHandled).toHaveBeenCalledWith('r1');
  });

  it('retires the request when even the thread fallback throws', async () => {
    const slackApi = {
      openDmChannel: vi.fn().mockRejectedValue(new Error('cannot_dm_bot')),
      postMessage: vi.fn(),
    };
    const postFallback = vi.fn().mockRejectedValue(new Error('channel_not_found'));
    const res = await requestCronRunPermission({ ...input, slackApi, postFallback });
    expect(res.delivered).toBe('none');
    expect(h.markHandled).toHaveBeenCalledWith('r1');
  });
});
