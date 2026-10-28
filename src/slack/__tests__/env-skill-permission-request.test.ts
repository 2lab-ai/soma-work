import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createReq: vi.fn((i: any) => ({ requestId: 'env-req-1', reused: false, ...i })),
  markHandled: vi.fn(),
  setPrompts: vi.fn(),
}));
vi.mock('../../skill-permission-request-store', () => ({
  createPermissionRequest: h.createReq,
  markRequestHandled: h.markHandled,
  setRequestPrompts: h.setPrompts,
}));

import { ENV_SKILL_PERM_ACTION_ID_PREFIX } from '../env-skill-permission-blocks';
import { describeEnvSkillDelivery, requestEnvSkillPermission } from '../env-skill-permission-request';

/**
 * The admins' ask: record the request under the reserved environment-skill owner, DM every admin
 * the 4-button prompt, fall back to the asking thread, and always tell the requester the truth.
 */
describe('requestEnvSkillPermission', () => {
  type PostOptions = { threadTs?: string; blocks?: any[] };
  const slackApi = {
    openDmChannel: vi.fn(async (u: string) => `D-${u}`),
    postMessage: vi.fn(async (channel: string, _text: string, _opts?: PostOptions) => ({
      ts: `${channel}.ts` as string | undefined,
      channel,
    })),
  };
  const base = {
    slackApi,
    requesterId: 'U1',
    skillKey: 'acme-env:post-deploy',
    channel: 'C1',
    threadTs: '171.1',
    originalText: 'continue the deploy',
    admins: ['UADMIN1', 'UADMIN2'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.createReq.mockImplementation((i: any) => ({ requestId: 'env-req-1', reused: false, ...i }));
    slackApi.openDmChannel.mockImplementation(async (u: string) => `D-${u}`);
    slackApi.postMessage.mockImplementation(async (channel: string) => ({ ts: `${channel}.ts`, channel }));
  });

  it('records the request under the environment-skill owner and DMs every admin the prompt', async () => {
    const result = await requestEnvSkillPermission(base);

    expect(result).toEqual({ requestId: 'env-req-1', delivered: 'dm' });
    expect(h.createReq).toHaveBeenCalledWith({
      operation: 'invoke',
      requesterId: 'U1',
      ownerId: 'env-skills',
      skillName: 'acme-env:post-deploy',
      channel: 'C1',
      threadTs: '171.1',
      originalText: 'continue the deploy',
    });
    expect(slackApi.openDmChannel.mock.calls.map((c) => c[0])).toEqual(['UADMIN1', 'UADMIN2']);
    const dms = slackApi.postMessage.mock.calls.filter((c) => String(c[0]).startsWith('D-'));
    expect(dms).toHaveLength(2);
    const blocks = JSON.stringify(dms[0][2]?.blocks);
    expect(blocks).toContain(`${ENV_SKILL_PERM_ACTION_ID_PREFIX}env_skill_once`);
    expect(blocks).toContain(`${ENV_SKILL_PERM_ACTION_ID_PREFIX}env_skill_always`);
    expect(blocks).toContain(`${ENV_SKILL_PERM_ACTION_ID_PREFIX}env_skill_all`);
    expect(blocks).toContain(`${ENV_SKILL_PERM_ACTION_ID_PREFIX}env_skill_deny`);
    // Buttons carry only the request id.
    expect(blocks).not.toContain('UADMIN1');
    expect(h.setPrompts).toHaveBeenCalledWith('env-req-1', [
      { channel: 'D-UADMIN1', ts: 'D-UADMIN1.ts' },
      { channel: 'D-UADMIN2', ts: 'D-UADMIN2.ts' },
    ]);
    // The requester is told in their thread.
    expect(slackApi.postMessage).toHaveBeenCalledWith('C1', describeEnvSkillDelivery('dm', 'acme-env:post-deploy'), {
      threadTs: '171.1',
    });
  });

  it('one failed DM does not stop the others', async () => {
    slackApi.openDmChannel.mockImplementation(async (u: string) => {
      if (u === 'UADMIN1') throw new Error('cannot_dm_bot');
      return `D-${u}`;
    });
    const result = await requestEnvSkillPermission(base);
    expect(result.delivered).toBe('dm');
    expect(h.setPrompts).toHaveBeenCalledWith('env-req-1', [{ channel: 'D-UADMIN2', ts: 'D-UADMIN2.ts' }]);
  });

  it('falls back to the asking thread, mentioning the admins, when every DM fails', async () => {
    slackApi.openDmChannel.mockRejectedValue(new Error('dm closed'));
    const result = await requestEnvSkillPermission(base);

    expect(result.delivered).toBe('fallback');
    const prompt = slackApi.postMessage.mock.calls.find((c) => Array.isArray(c[2]?.blocks));
    expect(prompt?.[0]).toBe('C1');
    expect(prompt?.[1]).toContain('<@UADMIN1> <@UADMIN2>');
    expect(prompt?.[2]?.threadTs).toBe('171.1');
    expect(h.markHandled).not.toHaveBeenCalled();
  });

  it('retires the request when nothing reaches an admin, so a retry asks again', async () => {
    slackApi.openDmChannel.mockRejectedValue(new Error('dm closed'));
    slackApi.postMessage.mockImplementation(async (channel: string, _t: string, opts?: PostOptions) => {
      if (opts?.blocks) throw new Error('channel_not_found');
      return { ts: 'x', channel };
    });
    const result = await requestEnvSkillPermission(base);

    expect(result.delivered).toBe('none');
    expect(h.markHandled).toHaveBeenCalledWith('env-req-1');
  });

  it('with no admin configured, says so and retires the request', async () => {
    const result = await requestEnvSkillPermission({ ...base, admins: [] });

    expect(result.delivered).toBe('none');
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
    expect(h.markHandled).toHaveBeenCalledWith('env-req-1');
    expect(slackApi.postMessage).toHaveBeenCalledWith('C1', describeEnvSkillDelivery('none', 'acme-env:post-deploy'), {
      threadTs: '171.1',
    });
  });

  it('does not re-DM the admins for an ask already pending in this thread', async () => {
    h.createReq.mockImplementation((i: any) => ({ requestId: 'env-req-1', reused: true, ...i }));
    const result = await requestEnvSkillPermission(base);

    expect(result.delivered).toBe('pending');
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
    expect(slackApi.postMessage).toHaveBeenCalledTimes(1);
  });

  it('the model-side ask stays quiet about an ask already pending (one notice per run is enough)', async () => {
    h.createReq.mockImplementation((i: any) => ({ requestId: 'env-req-1', reused: true, ...i }));
    const result = await requestEnvSkillPermission({ ...base, notifyWhenPending: false });

    expect(result.delivered).toBe('pending');
    expect(slackApi.postMessage).not.toHaveBeenCalled();
  });

  it('never throws when even the requester notice fails', async () => {
    slackApi.postMessage.mockRejectedValue(new Error('slack down'));
    slackApi.openDmChannel.mockRejectedValue(new Error('slack down'));
    await expect(requestEnvSkillPermission(base)).resolves.toEqual({ requestId: 'env-req-1', delivered: 'none' });
  });
});
