import { describe, it, expect, vi } from 'vitest';
import { ActionPanelManager } from './action-panel-manager';
import { ConversationSession } from '../types';

function getPostedBlocks(slackApi: { postMessage: ReturnType<typeof vi.fn> }): any[] {
  return (slackApi.postMessage.mock.calls[0]?.[2] as any)?.blocks || [];
}

describe('ActionPanelManager', () => {
  it('posts a public dashboard panel with interactive controls', async () => {
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
      workflow: 'jira-brainstorming',
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

    expect(slackApi.postMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postEphemeral).not.toHaveBeenCalled();
    expect(slackApi.getPermalink).not.toHaveBeenCalled();

    const blocks = getPostedBlocks(slackApi);
    const summarySection = blocks.find((block: any) =>
      block.type === 'section'
        && /(비활성|작업 중|입력 대기|사용 가능|요청 처리 중|대기 중)/.test(String(block.text?.text || ''))
    );
    expect(summarySection).toBeDefined();
    const summaryText = String(summarySection.text?.text || '');
    expect(summaryText).toContain('📦 --%');
    expect(summaryText).not.toContain('`jira-brainstorming`');

    const actionsCount = blocks.filter((block: any) => block.type === 'actions').length;
    expect(actionsCount).toBeGreaterThan(0);
  });

  it('updates dashboard status to working when session is active', async () => {
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
      workflow: 'default',
      actionPanel: {
        channelId: 'C123',
        userId: 'U123',
        messageTs: '123.456',
      },
    };

    await manager.updatePanel(session, 'C123:thread123');
    session.activityState = 'working';
    await manager.updatePanel(session, 'C123:thread123');

    const updateBlocks = (slackApi.updateMessage.mock.calls[1]?.[3] as any[]) || [];
    const summarySection = updateBlocks.find((block: any) =>
      block.type === 'section'
        && /(비활성|작업 중|입력 대기|사용 가능|요청 처리 중|대기 중)/.test(String(block.text?.text || ''))
    );
    const summaryText = String(summarySection?.text?.text || '');
    expect(summaryText).toContain('⚙️ 작업 중');
  });

  it('does not fetch thread permalink while rendering panel', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p111222333'),
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
      threadTs: '111.222',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      workflow: 'default',
    };

    await manager.ensurePanel(session, 'C123:111.222');

    expect(slackApi.getPermalink).not.toHaveBeenCalled();
  });

  it('fetches choice permalink only when waitingForChoice is active', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p111222333'),
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
      activityState: 'waiting',
      workflow: 'default',
      actionPanel: {
        channelId: 'C123',
        userId: 'U123',
        waitingForChoice: true,
        choiceMessageTs: '111.222',
        choiceBlocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '❓ *질문이 있습니다*' },
          },
        ],
      },
    };

    await manager.ensurePanel(session, 'C123:choice-thread');

    expect(slackApi.getPermalink).toHaveBeenCalledTimes(1);
    const blocks = getPostedBlocks(slackApi);
    const ctaBlock = blocks.find((block: any) =>
      block.type === 'actions' && block.elements?.[0]?.action_id === 'panel_focus_choice'
    );
    expect(ctaBlock).toBeDefined();
    expect(ctaBlock.elements[0].url).toContain('slack.com/archives');
  });
});
