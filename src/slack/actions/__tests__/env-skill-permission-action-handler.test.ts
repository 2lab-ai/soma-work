import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requests: new Map<string, any>(),
  addThreadGrant: vi.fn(),
  grantSkill: vi.fn(),
  grantAllSkills: vi.fn(),
  envSkillExists: vi.fn((_k: string) => true),
  admins: new Set<string>(['UADMIN1', 'UADMIN2']),
}));
vi.mock('../../../skill-permission-request-store', () => ({
  getPermissionRequest: (id: string) => h.requests.get(id) ?? null,
  markRequestHandled: (id: string) => {
    const r = h.requests.get(id);
    if (r) r.handled = true;
  },
}));
vi.mock('../../../user-skill-grants-store', () => ({
  ENV_SKILL_GRANT_OWNER: 'env-skills',
  addThreadGrant: h.addThreadGrant,
  grantSkill: h.grantSkill,
  grantAllSkills: h.grantAllSkills,
}));
vi.mock('../../../env-skill-registry', () => ({
  envSkillRegistry: () => ({ pluginNames: new Set(['acme-env']), pluginsDir: '/mock' }),
  envSkillExists: h.envSkillExists,
}));
vi.mock('../../../admin-utils', () => ({ isAdminUser: (u: string) => h.admins.has(u) }));

import {
  VALUE_KIND_ENV_SKILL_ALL,
  VALUE_KIND_ENV_SKILL_ALWAYS,
  VALUE_KIND_ENV_SKILL_DENY,
  VALUE_KIND_ENV_SKILL_ONCE,
} from '../../env-skill-permission-blocks';
import { EnvSkillPermissionActionHandler } from '../env-skill-permission-action-handler';

/**
 * The admins' answer to an environment-skill request. Any admin may answer, nobody else; the
 * request is read server-side by id and handled once; a grant re-sends the requester's turn.
 */
describe('EnvSkillPermissionActionHandler', () => {
  const slackApi = { postMessage: vi.fn(async () => ({ ts: '1' })), updateMessage: vi.fn(async () => undefined) };
  const messageHandler = vi.fn(async () => undefined);
  const handler = new EnvSkillPermissionActionHandler({ slackApi: slackApi as any, messageHandler });
  const respond = vi.fn(async () => undefined);

  const click = (kind: string, user = 'UADMIN1', requestId = 'req-1') => ({
    user: { id: user },
    actions: [{ value: JSON.stringify({ kind, requestId }) }],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.envSkillExists.mockReturnValue(true);
    h.requests.clear();
    h.requests.set('req-1', {
      requestId: 'req-1',
      operation: 'invoke',
      requesterId: 'U1',
      ownerId: 'env-skills',
      skillName: 'acme-env:post-deploy',
      channel: 'C1',
      threadTs: '171.1',
      originalText: 'continue the deploy',
      prompts: [
        { channel: 'D1', ts: '1.1' },
        { channel: 'D2', ts: '2.2' },
      ],
      handled: false,
    });
  });

  it('rejects a non-admin click and grants nothing', async () => {
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_ALWAYS, 'U1'), respond);

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    expect(h.grantSkill).not.toHaveBeenCalled();
    expect(messageHandler).not.toHaveBeenCalled();
    expect(h.requests.get('req-1').handled).toBe(false);
  });

  it('1회 허용: a thread grant for the asking thread, then the requester turn is sent again', async () => {
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_ONCE), respond);

    expect(h.addThreadGrant).toHaveBeenCalledWith('env-skills', 'acme-env:post-deploy', 'U1', {
      channel: 'C1',
      threadTs: '171.1',
    });
    expect(h.grantSkill).not.toHaveBeenCalled();
    expect(h.requests.get('req-1').handled).toBe(true);
    // The turn rides on the "이어서 실행합니다" notice (ts '1'): a real Slack message, so it
    // has a queue identity when the session is still busy and its controls land somewhere
    // the requester can see.
    expect(messageHandler).toHaveBeenCalledWith(
      { user: 'U1', channel: 'C1', thread_ts: '171.1', ts: '1', text: 'continue the deploy' },
      expect.any(Function),
    );
    expect(slackApi.postMessage.mock.invocationCallOrder[0]).toBeLessThan(messageHandler.mock.invocationCallOrder[0]);
    // Every admin's copy of the prompt is closed, and the requester is told.
    expect(slackApi.updateMessage.mock.calls.map((c: any[]) => [c[0], c[1]])).toEqual([
      ['D1', '1.1'],
      ['D2', '2.2'],
    ]);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ replace_original: true }));
    expect(slackApi.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('허용했습니다'), {
      threadTs: '171.1',
    });
  });

  it('항상 허용: a persisted per-skill grant', async () => {
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_ALWAYS), respond);
    expect(h.grantSkill).toHaveBeenCalledWith('env-skills', 'acme-env:post-deploy', 'U1');
    expect(messageHandler).toHaveBeenCalledTimes(1);
  });

  it('모든 환경 스킬 항상 허용: a persisted all-environment-skills grant', async () => {
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_ALL), respond);
    expect(h.grantAllSkills).toHaveBeenCalledWith('env-skills', 'U1');
    expect(messageHandler).toHaveBeenCalledTimes(1);
  });

  it('거부: no grant, no re-dispatch, the requester is told', async () => {
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_DENY), respond);

    expect(h.addThreadGrant).not.toHaveBeenCalled();
    expect(h.grantSkill).not.toHaveBeenCalled();
    expect(h.grantAllSkills).not.toHaveBeenCalled();
    expect(messageHandler).not.toHaveBeenCalled();
    expect(h.requests.get('req-1').handled).toBe(true);
    expect(slackApi.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('거부'), { threadTs: '171.1' });
  });

  it('a second click — another admin, or the same one — finds it handled and changes nothing', async () => {
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_ONCE, 'UADMIN1'), respond);
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_ALL, 'UADMIN2'), respond);

    expect(h.addThreadGrant).toHaveBeenCalledTimes(1);
    expect(h.grantAllSkills).not.toHaveBeenCalled();
    expect(messageHandler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenLastCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', text: expect.stringContaining('이미 처리') }),
    );
  });

  it('refuses a request that is not an environment-skill request (forged id of a user-skill ask)', async () => {
    h.requests.set('req-2', { ...h.requests.get('req-1'), requestId: 'req-2', ownerId: 'U0B' });
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_ALL, 'UADMIN1', 'req-2'), respond);

    expect(h.grantAllSkills).not.toHaveBeenCalled();
    expect(h.requests.get('req-2').handled).toBe(false);
  });

  it('a skill that left the host is retired without a grant', async () => {
    h.envSkillExists.mockReturnValue(false);
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_ALWAYS), respond);

    expect(h.grantSkill).not.toHaveBeenCalled();
    expect(messageHandler).not.toHaveBeenCalled();
    expect(h.requests.get('req-1').handled).toBe(true);
  });

  it('ignores malformed payloads and expired ids', async () => {
    await handler.handleAction({ user: { id: 'UADMIN1' }, actions: [{ value: 'not json' }] }, respond);
    await handler.handleAction(click('env_skill_bogus'), respond);
    await handler.handleAction(click(VALUE_KIND_ENV_SKILL_ONCE, 'UADMIN1', 'missing'), respond);

    expect(h.addThreadGrant).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('만료') }));
  });
});
