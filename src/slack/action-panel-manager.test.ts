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
    expect(slackApi.getPermalink).not.toHaveBeenCalled();
    const postedBlocks = (slackApi.postMessage.mock.calls[0]?.[2] as any)?.blocks || [];
    const sectionText = postedBlocks.find((block: any) => block.type === 'section')?.text?.text || '';
    expect(sectionText).toContain('(Thread)');
    expect(session.actionPanel?.styleVariant).toBeTypeOf('number');
    expect(session.actionPanel?.styleVariant).toBeGreaterThanOrEqual(0);
    expect(session.actionPanel?.styleVariant).toBeLessThan(10);
  });

  it('keeps the same dialog style variant after initial random selection', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.72);
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
    const initialVariant = session.actionPanel?.styleVariant;

    session.activityState = 'working';
    await manager.updatePanel(session, 'C123:thread123');

    expect(initialVariant).toBe(7);
    expect(session.actionPanel?.styleVariant).toBe(initialVariant);
    expect(randomSpy).toHaveBeenCalledTimes(1);
    randomSpy.mockRestore();
  });

  it('does not auto-populate title from issue/pr labels', async () => {
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
      links: {
        issue: {
          type: 'issue',
          provider: 'jira',
          url: 'https://jira.example.com/browse/MIN-63',
          label: 'MIN-63',
        },
      },
    };

    await manager.ensurePanel(session, 'C123:thread123');

    const postedBlocks = (slackApi.postMessage.mock.calls[0]?.[2] as any)?.blocks || [];
    const sectionText = postedBlocks.find((block: any) => block.type === 'section')?.text?.text || '';
    expect(sectionText).not.toContain('MIN-63');
  });
});
