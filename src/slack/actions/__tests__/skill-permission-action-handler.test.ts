import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VALUE_KIND_PERM_ALLOW_ALL,
  VALUE_KIND_PERM_ALLOW_SKILL,
  VALUE_KIND_PERM_YES_ONCE,
} from '../../skill-permission-blocks';
import { SkillPermissionActionHandler } from '../skill-permission-action-handler';

const h = vi.hoisted(() => ({
  getReq: vi.fn(),
  markHandled: vi.fn(),
  addOneTime: vi.fn(),
  grantSkill: vi.fn(),
  grantAll: vi.fn(),
  copy: vi.fn(() => ({ ok: true, message: 'copied' })),
  getUserSkill: vi.fn(() => ({ name: 'deploy', description: 'd', content: 'BODY' })),
  userSkillExists: vi.fn(() => true),
}));

vi.mock('../../../skill-permission-request-store', () => ({
  getPermissionRequest: h.getReq,
  markRequestHandled: h.markHandled,
}));
vi.mock('../../../user-skill-grants-store', () => ({
  addOneTimeGrant: h.addOneTime,
  grantSkill: h.grantSkill,
  grantAllSkills: h.grantAll,
}));
vi.mock('../../../user-skill-store', () => ({
  copyUserSkill: h.copy,
  getUserSkill: h.getUserSkill,
  userSkillExists: h.userSkillExists,
}));

/**
 * RED tests for the 3-button permission grant handler (Q2). Owner-bound;
 * server-side request lookup; persist grant + fulfill by operation.
 */
describe('SkillPermissionActionHandler', () => {
  let slackApi: any;
  let messageHandler: any;
  let respond: any;
  let handler: SkillPermissionActionHandler;

  const invokeReq = {
    requestId: 'r1',
    operation: 'invoke' as const,
    requesterId: 'U0A',
    ownerId: 'U0B',
    skillName: 'deploy',
    channel: 'C1',
    threadTs: 'T1',
    originalText: '$<@U0B>:deploy',
    handled: false,
  };

  const body = (kind: string, clicker = 'U0B') => ({
    actions: [{ type: 'button', value: JSON.stringify({ kind, requestId: 'r1' }) }],
    user: { id: clicker },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    slackApi = { postMessage: vi.fn().mockResolvedValue({ ts: 'x' }) };
    messageHandler = vi.fn().mockResolvedValue(undefined);
    respond = vi.fn().mockResolvedValue(undefined);
    handler = new SkillPermissionActionHandler({ slackApi, claudeHandler: {} as any, messageHandler });
    h.getReq.mockReturnValue({ ...invokeReq });
    h.userSkillExists.mockReturnValue(true);
  });

  it('allow-skill: persists per-skill grant, marks handled, re-dispatches A’s request', async () => {
    await handler.handleAction(body(VALUE_KIND_PERM_ALLOW_SKILL), respond);
    expect(h.grantSkill).toHaveBeenCalledWith('U0B', 'deploy', 'U0A');
    expect(h.markHandled).toHaveBeenCalledWith('r1');
    expect(messageHandler).toHaveBeenCalledTimes(1);
    expect(messageHandler.mock.calls[0][0]).toMatchObject({ user: 'U0A', text: '$<@U0B>:deploy' });
  });

  it('allow-all: persists all-skills grant', async () => {
    await handler.handleAction(body(VALUE_KIND_PERM_ALLOW_ALL), respond);
    expect(h.grantAll).toHaveBeenCalledWith('U0B', 'U0A');
  });

  it('yes-once: arms a one-time grant then re-dispatches', async () => {
    await handler.handleAction(body(VALUE_KIND_PERM_YES_ONCE), respond);
    expect(h.addOneTime).toHaveBeenCalledWith('U0B', 'deploy', 'U0A');
    expect(messageHandler).toHaveBeenCalledTimes(1);
  });

  it('owner-bound: a non-owner clicker is rejected and nothing is granted', async () => {
    await handler.handleAction(body(VALUE_KIND_PERM_ALLOW_SKILL, 'U0A'), respond);
    expect(h.grantSkill).not.toHaveBeenCalled();
    expect(messageHandler).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0].response_type).toBe('ephemeral');
  });

  it('expired/missing request: ephemeral notice, no grant', async () => {
    h.getReq.mockReturnValue(null);
    await handler.handleAction(body(VALUE_KIND_PERM_ALLOW_SKILL), respond);
    expect(h.grantSkill).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0].response_type).toBe('ephemeral');
  });

  it('already handled: rejected (replay guard)', async () => {
    h.getReq.mockReturnValue({ ...invokeReq, handled: true });
    await handler.handleAction(body(VALUE_KIND_PERM_ALLOW_SKILL), respond);
    expect(h.grantSkill).not.toHaveBeenCalled();
  });

  it('view operation: posts the SKILL.md content to the thread on grant', async () => {
    h.getReq.mockReturnValue({ ...invokeReq, operation: 'view', originalText: undefined });
    await handler.handleAction(body(VALUE_KIND_PERM_ALLOW_SKILL), respond);
    expect(h.getUserSkill).toHaveBeenCalledWith('U0B', 'deploy');
    expect(slackApi.postMessage).toHaveBeenCalled();
    expect(JSON.stringify(slackApi.postMessage.mock.calls)).toContain('BODY');
  });

  it('copy operation: copies on grant', async () => {
    h.getReq.mockReturnValue({ ...invokeReq, operation: 'copy', originalText: undefined });
    await handler.handleAction(body(VALUE_KIND_PERM_ALLOW_SKILL), respond);
    expect(h.copy).toHaveBeenCalledWith('U0B', 'deploy', 'U0A');
  });

  it('skill gone: marks handled and reports, no grant', async () => {
    h.userSkillExists.mockReturnValue(false);
    await handler.handleAction(body(VALUE_KIND_PERM_ALLOW_SKILL), respond);
    expect(h.grantSkill).not.toHaveBeenCalled();
    expect(h.markHandled).toHaveBeenCalledWith('r1');
  });
});
