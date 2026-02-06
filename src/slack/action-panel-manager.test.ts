import { describe, it, expect, vi } from 'vitest';
import { ActionPanelManager } from './action-panel-manager';
import { ConversationSession } from '../types';

describe('ActionPanelManager', () => {
  it('posts a public action panel message when first rendered', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue(null),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn(),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const manager = new ActionPanelManager({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
    });

    const session: ConversationSession = {
      ownerId: 'U123',
      userId: 'U123',
      channelId: 'C123',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
    };

    await manager.ensurePanel(session, 'C123:thread123');

    expect(slackApi.postMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postEphemeral).not.toHaveBeenCalled();
  });
});
