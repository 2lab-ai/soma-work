import { describe, it, expect, vi } from 'vitest';
import { ActionPanelActionHandler } from './action-panel-action-handler';

describe('ActionPanelActionHandler', () => {
  it('rejects action while session is working', async () => {
    const messageHandler = vi.fn();
    const handler = new ActionPanelActionHandler({
      slackApi: {
        postMessage: vi.fn(),
      } as any,
      claudeHandler: {
        getSessionByKey: vi.fn().mockReturnValue({
          ownerId: 'U123',
          channelId: 'C123',
          threadTs: '111.222',
          activityState: 'working',
          links: {
            pr: { url: 'https://github.com/acme/repo/pull/1', label: 'PR #1' },
          },
        }),
      } as any,
      messageHandler,
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const body = {
      user: { id: 'U123' },
      actions: [
        {
          value: JSON.stringify({ sessionKey: 'session-1', action: 'pr_review' }),
        },
      ],
    };

    await handler.handleAction(body, respond as any);

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      response_type: 'ephemeral',
    }));
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('rejects action while waiting for choice', async () => {
    const messageHandler = vi.fn();
    const handler = new ActionPanelActionHandler({
      slackApi: {
        postMessage: vi.fn(),
      } as any,
      claudeHandler: {
        getSessionByKey: vi.fn().mockReturnValue({
          ownerId: 'U123',
          channelId: 'C123',
          threadTs: '111.222',
          activityState: 'idle',
          actionPanel: { waitingForChoice: true },
          links: {
            pr: { url: 'https://github.com/acme/repo/pull/1', label: 'PR #1' },
          },
        }),
      } as any,
      messageHandler,
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const body = {
      user: { id: 'U123' },
      actions: [
        {
          value: JSON.stringify({ sessionKey: 'session-1', action: 'pr_review' }),
        },
      ],
    };

    await handler.handleAction(body, respond as any);

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      response_type: 'ephemeral',
    }));
    expect(messageHandler).not.toHaveBeenCalled();
  });
});
