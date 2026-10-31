/**
 * #620 — an environment-skill run request on the dashboard: the real request
 * store and the real decision (`EnvSkillPermissionActionHandler.decide`), so a
 * dashboard answer grants, rewrites EVERY admin's DM and re-sends the
 * requester's turn exactly as a Slack click does — and either answer is the
 * only one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ admins: new Set<string>(['UADMIN1', 'UADMIN2']) }));
vi.mock('../../admin-utils', () => ({
  isAdminUser: (u: string) => h.admins.has(u),
  getAdminUsers: () => h.admins,
}));
vi.mock('../../env-skill-registry', () => ({
  envSkillRegistry: () => ({ pluginNames: new Set(['acme-env']), pluginsDir: '/mock' }),
  envSkillExists: () => true,
}));

import { createPermissionRequest, setRequestPrompts } from '../../skill-permission-request-store';
import { ENV_SKILL_GRANT_OWNER, hasThreadGrant } from '../../user-skill-grants-store';
import { EnvSkillPermissionActionHandler } from '../actions/env-skill-permission-action-handler';
import { envSkillAdminApprovalAdapter } from '../env-skill-admin-approval';
import { VALUE_KIND_ENV_SKILL_DENY, VALUE_KIND_ENV_SKILL_ONCE } from '../env-skill-permission-blocks';
import { requestEnvSkillPermission } from '../env-skill-permission-request';

function makeRequest(thread: string) {
  const req = createPermissionRequest({
    operation: 'invoke',
    requesterId: 'U1',
    ownerId: ENV_SKILL_GRANT_OWNER,
    skillName: 'acme-env:post-deploy',
    channel: 'C1',
    threadTs: thread,
    originalText: 'continue the deploy',
  });
  setRequestPrompts(req.requestId, [
    { channel: 'D1', ts: '1.1' },
    { channel: 'D2', ts: '2.2' },
  ]);
  return req.requestId;
}

describe('environment-skill requests as admin approvals (#620)', () => {
  let slackApi: { postMessage: ReturnType<typeof vi.fn>; updateMessage: ReturnType<typeof vi.fn> };
  let messageHandler: ReturnType<typeof vi.fn>;
  let handler: EnvSkillPermissionActionHandler;

  beforeEach(() => {
    slackApi = { postMessage: vi.fn(async () => ({ ts: '9.9' })), updateMessage: vi.fn(async () => undefined) };
    messageHandler = vi.fn(async () => undefined);
    handler = new EnvSkillPermissionActionHandler({ slackApi: slackApi as any, messageHandler: messageHandler as any });
  });

  it('a pending request is a question card with the DM choices, the narrowest grant recommended', async () => {
    const id = makeRequest(`t-${Math.random()}`);
    const card = (await envSkillAdminApprovalAdapter(handler).pending(Date.now())).find(
      (a) => a.id === `env_skill:${id}`,
    );
    expect(card).toMatchObject({
      kind: 'env_skill',
      card: 'question',
      requesterId: 'U1',
      place: { channel: 'C1' },
      recommendedId: VALUE_KIND_ENV_SKILL_ONCE,
    });
    expect(card?.title).toContain('acme-env:post-deploy');
    expect(card?.choices?.map((c) => c.label)).toEqual([
      '✅ 1회 허용 (이 스레드)',
      '📋 `acme-env:post-deploy` 항상 허용',
      '🌐 모든 환경 스킬 항상 허용',
      '❌ 거부',
    ]);
  });

  it('answered on the dashboard: granted, every admin DM rewritten, the turn re-sent, the card gone (T3/T5)', async () => {
    const thread = `t-${Math.random()}`;
    const id = makeRequest(thread);
    const adapter = envSkillAdminApprovalAdapter(handler);
    const result = await adapter.answer(id, VALUE_KIND_ENV_SKILL_ONCE, 'UADMIN1');
    expect(result).toEqual({ ok: true, outcome: 'approved' });
    // The decision is taken before answer() resolves.
    expect(
      hasThreadGrant(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', 'U1', { channel: 'C1', threadTs: thread }),
    ).toBe(true);
    expect((await adapter.pending(Date.now())).some((a) => a.id === `env_skill:${id}`)).toBe(false);
    await vi.waitFor(() => expect(messageHandler).toHaveBeenCalled());
    // Both admins' DMs — not only one — say what happened and where.
    const rewritten = slackApi.updateMessage.mock.calls.map((c) => [c[0], c[1], c[2]]);
    expect(rewritten.map((r) => r[0])).toEqual(['D1', 'D2']);
    for (const r of rewritten) expect(r[2]).toContain('대시보드에서 응답');
    expect(slackApi.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('허용했습니다'), {
      threadTs: thread,
    });
    expect((await adapter.resolved(0)).find((r) => r.id === `env_skill:${id}`)).toMatchObject({
      outcome: 'approved',
      by: 'UADMIN1',
      via: 'dashboard',
      choiceId: VALUE_KIND_ENV_SKILL_ONCE,
    });
  });

  it('answered in Slack first: the dashboard answer is already answered and grants nothing more', async () => {
    const id = makeRequest(`t-${Math.random()}`);
    const respond = vi.fn(async () => undefined);
    await handler.handleAction(
      {
        user: { id: 'UADMIN2' },
        actions: [{ value: JSON.stringify({ kind: VALUE_KIND_ENV_SKILL_DENY, requestId: id }) }],
      },
      respond,
    );
    const adapter = envSkillAdminApprovalAdapter(handler);
    expect((await adapter.resolved(0)).find((r) => r.id === `env_skill:${id}`)).toMatchObject({
      outcome: 'denied',
      by: 'UADMIN2',
      via: 'slack',
    });
    expect(await adapter.answer(id, VALUE_KIND_ENV_SKILL_ONCE, 'UADMIN1')).toEqual({
      ok: false,
      reason: 'already_answered',
    });
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('a non-admin, an unknown choice, or a missing request is refused', async () => {
    const id = makeRequest(`t-${Math.random()}`);
    const adapter = envSkillAdminApprovalAdapter(handler);
    expect(await adapter.answer(id, VALUE_KIND_ENV_SKILL_ONCE, 'U1')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await adapter.answer(id, 'env_skill_bogus', 'UADMIN1')).toEqual({ ok: false, reason: 'invalid' });
    expect(await adapter.answer('missing', VALUE_KIND_ENV_SKILL_ONCE, 'UADMIN1')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect((await adapter.pending(Date.now())).some((a) => a.id === `env_skill:${id}`)).toBe(true);
  });

  it('answered on the dashboard while the DMs were still going out: the late DMs are closed, not left live', async () => {
    const adapter = envSkillAdminApprovalAdapter(handler);
    const thread = `t-${Math.random()}`;
    let answered: unknown;
    const api = {
      openDmChannel: vi.fn(async (admin: string) => `D-${admin}`),
      postMessage: vi.fn(async (channel: string) => {
        // The request is listed on the dashboard from the moment it is created;
        // an admin answers it there before the second DM has even been posted.
        if (channel === 'D-UADMIN2' && !answered) {
          const card = (await adapter.pending(Date.now())).find((a) => a.place?.threadTs === thread);
          answered = await adapter.answer(card!.id.slice('env_skill:'.length), VALUE_KIND_ENV_SKILL_DENY, 'UADMIN1');
        }
        return { ts: `ts-${channel}`, channel };
      }),
      updateMessage: vi.fn(async () => undefined),
    };
    const { delivered } = await requestEnvSkillPermission({
      slackApi: api as any,
      requesterId: 'U1',
      skillKey: 'acme-env:post-deploy',
      channel: 'C1',
      threadTs: thread,
      originalText: 'continue the deploy',
      admins: ['UADMIN1', 'UADMIN2'],
    });
    expect(delivered).toBe('dm');
    expect(answered).toEqual({ ok: true, outcome: 'denied' });
    // Both DMs — posted before and after the answer — end without buttons, saying who answered where.
    const closed = api.updateMessage.mock.calls as unknown as Array<[string, string, string, any[]]>;
    expect(closed.map((c) => c[0]).sort()).toEqual(['D-UADMIN1', 'D-UADMIN2']);
    for (const c of closed) {
      expect(c[2]).toContain('대시보드');
      expect(c[2]).toContain('거부');
      expect(JSON.stringify(c[3])).not.toContain('"actions"');
    }
  });
});
