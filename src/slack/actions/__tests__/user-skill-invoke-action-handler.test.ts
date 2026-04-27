import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as userSkillStore from '../../../user-skill-store';
import { UserSkillInvokeActionHandler } from '../user-skill-invoke-action-handler';

vi.mock('../../../user-skill-store');

describe('UserSkillInvokeActionHandler', () => {
  let slackApi: any;
  let claudeHandler: any;
  let messageHandler: any;
  let respond: any;
  let handler: UserSkillInvokeActionHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    slackApi = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
    };
    claudeHandler = {};
    messageHandler = vi.fn().mockResolvedValue(undefined);
    respond = vi.fn().mockResolvedValue(undefined);

    handler = new UserSkillInvokeActionHandler({
      slackApi,
      claudeHandler,
      messageHandler,
    });
  });

  const makeBody = (overrides: { value?: any; userId?: string; channel?: string; messageTs?: string } = {}) => ({
    actions: [
      {
        value:
          overrides.value !== undefined
            ? typeof overrides.value === 'string'
              ? overrides.value
              : JSON.stringify(overrides.value)
            : JSON.stringify({
                kind: 'user_skill_invoke',
                skillName: 'a',
                requesterId: 'U1',
              }),
      },
    ],
    user: { id: overrides.userId ?? 'U1' },
    channel: { id: overrides.channel ?? 'C1' },
    message: { ts: overrides.messageTs ?? 'msg-ts', thread_ts: 'thread-ts' },
  });

  it('rejects clickers other than the requester (ephemeral, no re-injection)', async () => {
    vi.mocked(userSkillStore.listUserSkills).mockReturnValue([{ name: 'a', description: 'sk' }]);

    await handler.handleInvoke(makeBody({ userId: 'U2' }), respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const arg = respond.mock.calls[0][0];
    expect(arg.response_type).toBe('ephemeral');
    expect(arg.text).toMatch(/U1/);
    expect(messageHandler).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
  });

  it('blocks invocation when the skill no longer exists (stale click)', async () => {
    vi.mocked(userSkillStore.listUserSkills).mockReturnValue([{ name: 'something-else', description: '' }]);

    await handler.handleInvoke(makeBody(), respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const arg = respond.mock.calls[0][0];
    expect(arg.response_type).toBe('ephemeral');
    expect(arg.text).toMatch(/존재하지 않습니다|not found|deleted/i);
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('replaces the buttons message and re-injects "$user:{name}" when valid', async () => {
    vi.mocked(userSkillStore.listUserSkills).mockReturnValue([{ name: 'a', description: 'sk' }]);

    await handler.handleInvoke(makeBody(), respond);

    // Buttons replaced
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    const updateArgs = slackApi.updateMessage.mock.calls[0];
    expect(updateArgs[0]).toBe('C1');
    expect(updateArgs[1]).toBe('msg-ts');
    expect(updateArgs[4]).toEqual([]); // attachments cleared

    // $user:{name} re-injected with requesterId as user
    expect(messageHandler).toHaveBeenCalledTimes(1);
    const event = messageHandler.mock.calls[0][0];
    expect(event.user).toBe('U1');
    expect(event.channel).toBe('C1');
    expect(event.text).toBe('$user:a');
    expect(event.thread_ts).toBe('thread-ts');
    expect(respond).not.toHaveBeenCalled();
  });

  it('silently drops malformed JSON values (no throw, no side effects)', async () => {
    await handler.handleInvoke(makeBody({ value: '{not json' }), respond);

    expect(messageHandler).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('rejects skill names that fail the kebab-case pattern (defense)', async () => {
    vi.mocked(userSkillStore.listUserSkills).mockReturnValue([{ name: '../etc/passwd', description: '' } as any]);

    await handler.handleInvoke(
      makeBody({ value: { kind: 'user_skill_invoke', skillName: '../etc/passwd', requesterId: 'U1' } }),
      respond,
    );

    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('uses messageTs as thread_ts fallback when message.thread_ts is absent', async () => {
    vi.mocked(userSkillStore.listUserSkills).mockReturnValue([{ name: 'a', description: '' }]);
    const body = makeBody();
    delete (body.message as any).thread_ts;

    await handler.handleInvoke(body, respond);

    expect(messageHandler).toHaveBeenCalledTimes(1);
    expect(messageHandler.mock.calls[0][0].thread_ts).toBe('msg-ts');
  });
});
