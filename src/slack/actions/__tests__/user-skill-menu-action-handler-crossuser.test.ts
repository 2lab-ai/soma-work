import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as userSkillStore from '../../../user-skill-store';
import { UserSkillMenuActionHandler } from '../user-skill-menu-action-handler';

vi.mock('../../../user-skill-store');

// Controllable permission gate. Default: allow (these tests exercise view/copy
// mechanics). The deny path (permission requested) is asserted explicitly.
const perm = vi.hoisted(() => ({
  allow: vi.fn((_o: string, _s: string, _r: string) => true),
  createReq: vi.fn(() => ({ requestId: 'rq1' })),
}));
vi.mock('../../../user-skill-grants-store', () => ({ isSkillUseAllowed: perm.allow }));
vi.mock('../../../skill-permission-request-store', () => ({ createPermissionRequest: perm.createReq }));

/**
 * RED tests for the cross-user list verbs (S4): 보기(view) + 복사(copy), plus
 * cross-user invoke. The action value carries `ownerId` (the source user)
 * alongside `requesterId` (the clicker who rendered the list). The click guard
 * still binds to `requesterId`.
 */
describe('UserSkillMenuActionHandler — cross-user (S4)', () => {
  let slackApi: any;
  let claudeHandler: any;
  let messageHandler: any;
  let respond: any;
  let handler: UserSkillMenuActionHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    slackApi = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
      getClient: vi.fn().mockReturnValue({ filesUploadV2: vi.fn().mockResolvedValue({ ok: true }) }),
    };
    claudeHandler = { getSession: vi.fn().mockReturnValue({}), broadcastSessionUpdate: vi.fn() };
    messageHandler = vi.fn().mockResolvedValue(undefined);
    respond = vi.fn().mockResolvedValue(undefined);

    handler = new UserSkillMenuActionHandler({ slackApi, claudeHandler, messageHandler });

    vi.mocked(userSkillStore.isValidSkillName).mockImplementation((n: string) => /^[a-z0-9][a-z0-9-]*$/.test(n));
    vi.mocked(userSkillStore.userSkillExists).mockReturnValue(true);
    vi.mocked(userSkillStore.getUserSkill).mockReturnValue({ name: 'deploy', description: 'd', content: 'OWNER BODY' });
    vi.mocked(userSkillStore.copyUserSkill).mockReturnValue({ ok: true, message: 'copied' });
    perm.allow.mockReturnValue(true);
    perm.createReq.mockReturnValue({ requestId: 'rq1' } as any);
  });

  const overflowBody = (kind: string) => ({
    actions: [
      {
        type: 'overflow',
        selected_option: { value: JSON.stringify({ kind, skillName: 'deploy', requesterId: 'U1', ownerId: 'U094' }) },
      },
    ],
    user: { id: 'U1' },
    channel: { id: 'C1' },
    message: { ts: 'msg-ts', thread_ts: 'thread-ts' },
    trigger_id: 'trig-1',
  });

  it('VIEW: responds with the owner’s SKILL.md content (read-only)', async () => {
    await handler.handleAction(overflowBody('user_skill_view'), respond, {} as any);
    expect(userSkillStore.getUserSkill).toHaveBeenCalledWith('U094', 'deploy');
    const arg = respond.mock.calls[0][0];
    expect(arg.response_type).toBe('ephemeral');
    expect(arg.text).toContain('OWNER BODY');
  });

  it('COPY: copies the owner’s skill into the clicker’s set', async () => {
    await handler.handleAction(overflowBody('user_skill_copy'), respond, {} as any);
    expect(userSkillStore.copyUserSkill).toHaveBeenCalledWith('U094', 'deploy', 'U1');
    const arg = respond.mock.calls[0][0];
    expect(arg.response_type).toBe('ephemeral');
    expect(arg.text).toMatch(/복사|copied|copy/i);
  });

  it('COPY: surfaces a failure from the store', async () => {
    vi.mocked(userSkillStore.copyUserSkill).mockReturnValue({ ok: false, message: 'already exists' });
    await handler.handleAction(overflowBody('user_skill_copy'), respond, {} as any);
    const arg = respond.mock.calls[0][0];
    expect(arg.text).toMatch(/already exists|❌/);
  });

  it('INVOKE (cross-user): re-injects "$<@owner>:skill" synthetic message', async () => {
    await handler.handleAction(overflowBody('user_skill_invoke'), respond, {} as any);
    expect(messageHandler).toHaveBeenCalledTimes(1);
    const synthetic = messageHandler.mock.calls[0][0];
    expect(synthetic.text).toBe('$<@U094>:deploy');
    expect(synthetic.user).toBe('U1');
  });

  it('binds the menu to the requester (rejects a different clicker)', async () => {
    const body = overflowBody('user_skill_copy');
    body.user.id = 'U2';
    await handler.handleAction(body, respond, {} as any);
    expect(userSkillStore.copyUserSkill).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0].response_type).toBe('ephemeral');
  });

  // --- permission gate (deny path) ---

  it('VIEW denied: posts a permission request to the owner instead of the content', async () => {
    perm.allow.mockReturnValue(false);
    await handler.handleAction(overflowBody('user_skill_view'), respond, {} as any);
    // No content read; a request was created + prompt posted to the thread.
    expect(userSkillStore.getUserSkill).not.toHaveBeenCalled();
    expect(perm.createReq).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'view', ownerId: 'U094', requesterId: 'U1', skillName: 'deploy' }),
    );
    expect(slackApi.postMessage).toHaveBeenCalled();
    expect(JSON.stringify(slackApi.postMessage.mock.calls)).toContain('skill_perm_');
  });

  it('COPY denied: requests permission instead of copying', async () => {
    perm.allow.mockReturnValue(false);
    await handler.handleAction(overflowBody('user_skill_copy'), respond, {} as any);
    expect(userSkillStore.copyUserSkill).not.toHaveBeenCalled();
    expect(perm.createReq).toHaveBeenCalledWith(expect.objectContaining({ operation: 'copy', ownerId: 'U094' }));
  });
});
