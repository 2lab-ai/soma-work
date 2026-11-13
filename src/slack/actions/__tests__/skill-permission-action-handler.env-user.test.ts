import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VALUE_KIND_PERM_ALLOW_ALL,
  VALUE_KIND_PERM_DENY,
  VALUE_KIND_PERM_YES_ONCE,
} from '../../skill-permission-blocks';
import { SkillPermissionActionHandler } from '../skill-permission-action-handler';

const h = vi.hoisted(() => ({
  getReq: vi.fn(),
  markHandled: vi.fn(),
  addOneTime: vi.fn(),
  consumeOneTime: vi.fn(() => true),
  grantSkill: vi.fn(),
  grantAll: vi.fn(),
  userSkillExists: vi.fn(() => true),
}));

vi.mock('../../../skill-permission-request-store', () => ({
  getPermissionRequest: h.getReq,
  markRequestHandled: h.markHandled,
}));
vi.mock('../../../user-skill-grants-store', () => ({
  addOneTimeGrant: h.addOneTime,
  consumeOneTimeGrant: h.consumeOneTime,
  grantSkill: h.grantSkill,
  grantAllSkills: h.grantAll,
}));
vi.mock('../../../user-skill-store', () => ({
  copyUserSkill: vi.fn(),
  getUserSkill: vi.fn(),
  userSkillExists: h.userSkillExists,
}));
vi.mock('../../../admin-utils', () => ({
  isAdminUser: (u: string) => u === 'UADMIN' || u.startsWith('env:'),
  getAdminUsers: () => new Set(['UADMIN']),
}));
vi.mock('../../../env-users', () => ({ isEnvironmentUser: (u: string) => u === 'env:acme-dev2' }));

/** An environment user's card is decided by an admin, not by the (never-human) owner. */
describe('SkillPermissionActionHandler — environment user owner', () => {
  let slackApi: any;
  let messageHandler: any;
  let respond: any;
  let handler: SkillPermissionActionHandler;

  const req = {
    requestId: 'r1',
    operation: 'invoke' as const,
    requesterId: 'U0A',
    ownerId: 'env:acme-dev2',
    skillName: 'deploy',
    channel: 'C1',
    threadTs: 'T1',
    originalText: '$acme-dev2:deploy',
    handled: false,
  };
  const body = (kind: string, clicker: string) => ({
    actions: [{ type: 'button', value: JSON.stringify({ kind, requestId: 'r1' }) }],
    user: { id: clicker },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    slackApi = { postMessage: vi.fn().mockResolvedValue({ ts: 'x' }) };
    messageHandler = vi.fn().mockResolvedValue(undefined);
    respond = vi.fn().mockResolvedValue(undefined);
    handler = new SkillPermissionActionHandler({ slackApi, claudeHandler: {} as any, messageHandler });
    h.getReq.mockReturnValue({ ...req });
  });

  it('an admin grants the whole environment and the request is sent again as the requester', async () => {
    await handler.handleAction(body(VALUE_KIND_PERM_ALLOW_ALL, 'UADMIN'), respond);
    expect(h.grantAll).toHaveBeenCalledWith('env:acme-dev2', 'U0A');
    expect(h.markHandled).toHaveBeenCalledWith('r1');
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U0A', channel: 'C1', thread_ts: 'T1', text: '$acme-dev2:deploy' }),
      expect.any(Function),
    );
    expect(JSON.stringify(respond.mock.calls)).toContain('acme-dev2');
  });

  it('a non-admin cannot decide an environment user card', async () => {
    await handler.handleAction(body(VALUE_KIND_PERM_YES_ONCE, 'U0A'), respond);
    expect(h.addOneTime).not.toHaveBeenCalled();
    expect(messageHandler).not.toHaveBeenCalled();
    expect(JSON.stringify(respond.mock.calls)).toContain('어드민');
  });

  it('deny: no grant, the request is closed and the requester is told', async () => {
    await handler.handleAction(body(VALUE_KIND_PERM_DENY, 'UADMIN'), respond);
    expect(h.grantAll).not.toHaveBeenCalled();
    expect(h.grantSkill).not.toHaveBeenCalled();
    expect(h.addOneTime).not.toHaveBeenCalled();
    expect(messageHandler).not.toHaveBeenCalled();
    expect(h.markHandled).toHaveBeenCalledWith('r1');
    expect(slackApi.postMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('거절'),
      expect.objectContaining({ threadTs: 'T1' }),
    );
  });

  it('a view or copy request for an environment skill is never fulfilled', async () => {
    h.getReq.mockReturnValue({ ...req, operation: 'view' });
    await handler.handleAction(body(VALUE_KIND_PERM_YES_ONCE, 'UADMIN'), respond);
    expect(JSON.stringify(slackApi.postMessage.mock.calls)).toContain('보거나 복사할 수 없습니다');
    expect(messageHandler).not.toHaveBeenCalled();
  });
});
