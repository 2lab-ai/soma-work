import { describe, it, expect, vi } from 'vitest';
import { ThreadPanel } from './thread-panel';
import { ConversationSession } from '../types';

function getPostedBlocks(slackApi: { postMessage: ReturnType<typeof vi.fn> }): any[] {
  return (slackApi.postMessage.mock.calls[0]?.[2] as any)?.blocks || [];
}

describe('ThreadPanel', () => {
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

    const panel = new ThreadPanel({
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

    await panel.create(session, 'C123:thread123');

    expect(slackApi.postMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postEphemeral).not.toHaveBeenCalled();
    expect(slackApi.getPermalink).not.toHaveBeenCalled();
    expect((slackApi.postMessage.mock.calls[0]?.[2] as any)?.unfurlLinks).toBe(false);
    expect((slackApi.postMessage.mock.calls[0]?.[2] as any)?.unfurlMedia).toBe(false);

    const blocks = getPostedBlocks(slackApi);
    // Status section block
    const statusSection = blocks.find((block: any) =>
      block.type === 'section'
        && /(대기|작업 중|입력 대기|사용 가능|요청 처리 중)/.test(String(block.text?.text || ''))
    );
    expect(statusSection).toBeDefined();

    // Fields section block (context% in fields)
    const fieldsSection = blocks.find((block: any) =>
      block.type === 'section' && Array.isArray(block.fields)
    );
    expect(fieldsSection).toBeDefined();
    const fieldsText = fieldsSection.fields.map((f: any) => String(f.text || '')).join(' ');
    expect(fieldsText).toContain('--%');

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

    const panel = new ThreadPanel({
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

    await panel.updatePanel(session, 'C123:thread123');
    session.activityState = 'working';
    await panel.updatePanel(session, 'C123:thread123');

    const updateBlocks = (slackApi.updateMessage.mock.calls[1]?.[3] as any[]) || [];
    const statusSection = updateBlocks.find((block: any) =>
      block.type === 'section'
        && /(대기|작업 중|입력 대기|사용 가능|요청 처리 중)/.test(String(block.text?.text || ''))
    );
    const statusText = String(statusSection?.text?.text || '');
    expect(statusText).toContain('🟢 *작업 중*');
    expect(slackApi.updateMessage.mock.calls[1]?.[5]).toEqual({
      unfurlLinks: false,
      unfurlMedia: false,
    });
  });

  it('renders remaining context percent based on input+output tokens', async () => {
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

    const panel = new ThreadPanel({
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
      usage: {
        currentInputTokens: 70000,
        currentOutputTokens: 10000,
        currentCacheReadTokens: 5000,
        currentCacheCreateTokens: 2000,
        contextWindow: 200000,
        totalInputTokens: 70000,
        totalOutputTokens: 10000,
        totalCostUsd: 0,
        lastUpdated: Date.now(),
      },
    };

    await panel.create(session, 'C123:context-thread');

    const blocks = getPostedBlocks(slackApi);
    const fieldsSection = blocks.find((block: any) =>
      block.type === 'section' && Array.isArray(block.fields)
    );
    const fieldsText = fieldsSection?.fields?.map((f: any) => String(f.text || '')).join(' ') || '';
    expect(fieldsText).toContain('60%');
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

    const panel = new ThreadPanel({
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

    await panel.create(session, 'C123:111.222');

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

    const panel = new ThreadPanel({
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
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'user_choice_1',
                text: { type: 'plain_text', text: '1️⃣ 옵션 A' },
                value: '{"sessionKey":"C123:choice-thread","choiceId":"1"}',
              },
            ],
          },
        ],
      },
    };

    await panel.create(session, 'C123:choice-thread');

    expect(slackApi.getPermalink).toHaveBeenCalledTimes(1);
    // Choice blocks are restored in the panel (without message preview)
    const blocks = getPostedBlocks(slackApi);
    const mirroredActionBlock = blocks.find((block: any) =>
      block.type === 'actions' && block.elements?.some((el: any) => el.action_id === 'user_choice_1')
    );
    expect(mirroredActionBlock).toBeDefined();
  });

  it('keeps existing thread choiceMessageTs when attachChoice is called without sourceMessageTs', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue(null),
    };

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
        choiceMessageTs: 'thread-choice-ts',
      },
    };

    const claudeHandler = {
      getSessionByKey: vi.fn().mockReturnValue(session),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
    });

    await panel.attachChoice(
      'C123:thread',
      {
        attachments: [
          {
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '❓ *질문*' },
              },
            ],
          },
        ],
      }
    );

    expect(session.actionPanel?.choiceMessageTs).toBe('thread-choice-ts');
  });

  it('setStatus updates combined surface for bot-initiated threads', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '100.200' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      getPermalink: vi.fn().mockResolvedValue(null),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn(),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
    });

    // In combined surface mode, bot-initiated threads use threadRootTs as the single surface message
    const session: ConversationSession = {
      ownerId: 'U123',
      userId: 'U123',
      channelId: 'C123',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'working',
      workflow: 'default',
      threadModel: 'bot-initiated',
      threadRootTs: '100.200',
      actionPanel: {
        channelId: 'C123',
        userId: 'U123',
        messageTs: '100.200',
      },
    };

    await panel.setStatus(session, 'C123:100.200', {
      agentPhase: '도구 실행 중',
      activeTool: 'Edit',
    });

    // Combined surface: single updateMessage call containing header + panel blocks
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage.mock.calls[0][1]).toBe('100.200');
  });
});
