import { describe, expect, it, vi } from 'vitest';
import { JiraActionHandler } from '../jira-action-handler';
import { PRActionHandler } from '../pr-action-handler';

/**
 * Behavior contract for the Jira/PR action handlers, which now share the
 * `runSessionInjectionAction` template. Covers the three guard branches and
 * the successful message-injection path for both handlers.
 */

function makeCtx(session: any) {
  const setActivityStateByKey = vi.fn();
  const messageHandler = vi.fn().mockResolvedValue(undefined);
  const postMessage = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    slackApi: { postMessage } as any,
    claudeHandler: {
      getSessionByKey: vi.fn().mockReturnValue(session),
      setActivityStateByKey,
    } as any,
    messageHandler: messageHandler as any,
  };
  return { ctx, setActivityStateByKey, messageHandler };
}

const jiraBody = (overrides: Record<string, unknown> = {}) => ({
  user: { id: 'U1' },
  channel: { id: 'C1' },
  actions: [
    {
      value: JSON.stringify({
        sessionKey: 'sess-1',
        issueKey: 'PTN-9',
        transitionId: '31',
        transitionName: 'In Review',
        ...overrides,
      }),
    },
  ],
});

const prBody = () => ({
  user: { id: 'U1' },
  channel: { id: 'C1' },
  actions: [
    {
      value: JSON.stringify({
        sessionKey: 'sess-1',
        prUrl: 'https://github.com/o/r/pull/1',
        prLabel: 'PR #1',
        headBranch: 'feat',
        baseBranch: 'main',
      }),
    },
  ],
});

describe('JiraActionHandler.handleTransition', () => {
  it('errors ephemerally when the session is missing', async () => {
    const { ctx, messageHandler } = makeCtx(null);
    const respond = vi.fn().mockResolvedValue(undefined);
    await new JiraActionHandler(ctx).handleTransition(jiraBody(), respond);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', text: expect.stringContaining('세션을 찾을 수 없습니다') }),
    );
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('blocks a non-owner', async () => {
    const { ctx, messageHandler } = makeCtx({ ownerId: 'someone-else', threadTs: 't1', channelId: 'C1' });
    const respond = vi.fn().mockResolvedValue(undefined);
    await new JiraActionHandler(ctx).handleTransition(jiraBody(), respond);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('세션 소유자만') }));
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('injects the transition instruction on success', async () => {
    const { ctx, setActivityStateByKey, messageHandler } = makeCtx({
      ownerId: 'U1',
      threadTs: 't1',
      channelId: 'C1',
    });
    const respond = vi.fn().mockResolvedValue(undefined);
    await new JiraActionHandler(ctx).handleTransition(jiraBody(), respond);
    expect(setActivityStateByKey).toHaveBeenCalledWith('sess-1', 'working');
    expect(messageHandler).toHaveBeenCalledTimes(1);
    const injected = messageHandler.mock.calls[0][0].text as string;
    expect(injected).toContain('PTN-9');
    expect(injected).toContain('In Review');
  });
});

describe('PRActionHandler.handleMerge', () => {
  it('injects the merge instruction on success', async () => {
    const { ctx, setActivityStateByKey, messageHandler } = makeCtx({
      ownerId: 'U1',
      threadTs: 't1',
      channelId: 'C1',
    });
    const respond = vi.fn().mockResolvedValue(undefined);
    await new PRActionHandler(ctx).handleMerge(prBody(), respond);
    expect(setActivityStateByKey).toHaveBeenCalledWith('sess-1', 'working');
    const injected = messageHandler.mock.calls[0][0].text as string;
    expect(injected).toContain('https://github.com/o/r/pull/1');
    expect(injected).toContain('squash merge');
  });

  it('errors ephemerally when the session thread is missing', async () => {
    const { ctx, messageHandler } = makeCtx({ ownerId: 'U1', threadTs: undefined, channelId: 'C1' });
    const respond = vi.fn().mockResolvedValue(undefined);
    await new PRActionHandler(ctx).handleMerge(prBody(), respond);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('스레드를 찾을 수 없습니다') }),
    );
    expect(messageHandler).not.toHaveBeenCalled();
  });
});
