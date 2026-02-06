import { describe, it, expect, vi } from 'vitest';
import { ChannelRouteActionHandler, buildChannelRouteBlocks } from './channel-route-action-handler';

describe('buildChannelRouteBlocks', () => {
  it('includes disabled stay-in-channel button by default', () => {
    const { blocks } = buildChannelRouteBlocks({
      prUrl: 'https://github.com/acme/repo/pull/1',
      targetChannelName: 'dev',
      targetChannelId: 'C123',
      originalChannel: 'C999',
      originalTs: '111.222',
      originalThreadTs: '333.444',
      userMessage: 'Review this PR',
      userId: 'U123',
    });

    const actionsBlock = blocks.find(block => block.type === 'actions');
    expect(actionsBlock).toBeDefined();
    const actionIds = actionsBlock.elements.map((el: any) => el.action_id);
    expect(actionIds).toContain('channel_route_move');
    expect(actionIds).toContain('channel_route_stop');
    expect(actionIds).toContain('channel_route_stay');

    const stayButton = actionsBlock.elements.find((el: any) => el.action_id === 'channel_route_stay');
    expect(stayButton?.disabled).toBe(true);
  });

  it('enables stay-in-channel button when allowStay is true', () => {
    const { blocks } = buildChannelRouteBlocks({
      prUrl: 'https://github.com/acme/repo/pull/1',
      targetChannelName: 'dev',
      targetChannelId: 'C123',
      originalChannel: 'C999',
      originalTs: '111.222',
      originalThreadTs: '333.444',
      userMessage: 'Review this PR',
      userId: 'U123',
      allowStay: true,
    });

    const actionsBlock = blocks.find(block => block.type === 'actions');
    const stayButton = actionsBlock.elements.find((el: any) => el.action_id === 'channel_route_stay');
    expect(stayButton?.disabled).toBeFalsy();
  });

  it('hides move button when allowMove is false', () => {
    const { blocks } = buildChannelRouteBlocks({
      prUrl: 'https://github.com/acme/repo/pull/1',
      targetChannelName: 'current',
      targetChannelId: 'C999',
      originalChannel: 'C999',
      originalTs: '111.222',
      originalThreadTs: '333.444',
      userMessage: 'Review this PR',
      userId: 'U123',
      allowStay: true,
      allowMove: false,
    });

    const actionsBlock = blocks.find(block => block.type === 'actions');
    const actionIds = actionsBlock.elements.map((el: any) => el.action_id);
    expect(actionIds).not.toContain('channel_route_move');
    expect(actionIds).toContain('channel_route_stop');
    expect(actionIds).toContain('channel_route_stay');
  });
});

describe('ChannelRouteActionHandler owner checks', () => {
  it('blocks non-owner move action', async () => {
    const slackApi = {
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      getUserName: vi.fn().mockResolvedValue('Owner'),
    };
    const claudeHandler = {
      getSessionKey: vi.fn().mockReturnValue('C123:thread123'),
      terminateSession: vi.fn(),
      setBotThread: vi.fn(),
    };
    const messageHandler = vi.fn();
    const handler = new ChannelRouteActionHandler({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      messageHandler,
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const value = JSON.stringify({
      targetChannel: 'C999',
      targetChannelName: 'target',
      originalChannel: 'C123',
      originalTs: '111.222',
      originalThreadTs: '111.222',
      userMessage: 'Review this PR',
      userId: 'U_OWNER',
      prUrl: 'https://github.com/acme/repo/pull/1',
      advisoryEphemeral: false,
    });
    const body = {
      actions: [{ value }],
      user: { id: 'U_OTHER' },
      message: { thread_ts: '111.222' },
    };

    await handler.handleMove(body, respond);

    expect(respond).toHaveBeenCalled();
    expect(slackApi.postMessage).not.toHaveBeenCalled();
  });

  it('blocks non-owner stop action', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
    };
    const claudeHandler = {};
    const messageHandler = vi.fn();
    const handler = new ChannelRouteActionHandler({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      messageHandler,
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const value = JSON.stringify({
      targetChannel: 'C999',
      targetChannelName: 'target',
      originalChannel: 'C123',
      originalTs: '111.222',
      originalThreadTs: '111.222',
      userMessage: 'Review this PR',
      userId: 'U_OWNER',
      prUrl: 'https://github.com/acme/repo/pull/1',
      advisoryEphemeral: false,
    });
    const body = {
      actions: [{ value }],
      user: { id: 'U_OTHER' },
      message: { thread_ts: '111.222' },
    };

    await handler.handleStop(body, respond);

    expect(respond).toHaveBeenCalled();
  });
});

describe('ChannelRouteActionHandler advisory cleanup', () => {
  it('deletes advisory message using advisoryTs when provided', async () => {
    const slackApi = {
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'new-thread' }),
      getUserName: vi.fn().mockResolvedValue('Owner'),
    };
    const claudeHandler = {
      getSessionKey: vi.fn().mockReturnValue('C123:thread123'),
      terminateSession: vi.fn(),
      setBotThread: vi.fn(),
    };
    const messageHandler = vi.fn();
    const handler = new ChannelRouteActionHandler({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      messageHandler,
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const value = JSON.stringify({
      targetChannel: 'C999',
      targetChannelName: 'target',
      originalChannel: 'C123',
      originalTs: '111.222',
      originalThreadTs: '111.222',
      advisoryTs: '999.000',
      userMessage: 'Review this PR',
      userId: 'U_OWNER',
      prUrl: 'https://github.com/acme/repo/pull/1',
      advisoryEphemeral: false,
    });
    const body = {
      actions: [{ value }],
      user: { id: 'U_OWNER' },
      message: { thread_ts: '111.222' },
    };

    await handler.handleMove(body, respond);

    expect(slackApi.deleteMessage).toHaveBeenCalledWith('C123', '999.000');
  });

  it('does not delete advisory message when advisoryTs is missing', async () => {
    const slackApi = {
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'new-thread' }),
      getUserName: vi.fn().mockResolvedValue('Owner'),
    };
    const claudeHandler = {
      getSessionKey: vi.fn().mockReturnValue('C123:thread123'),
      terminateSession: vi.fn(),
      setBotThread: vi.fn(),
    };
    const messageHandler = vi.fn();
    const handler = new ChannelRouteActionHandler({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      messageHandler,
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const value = JSON.stringify({
      targetChannel: 'C999',
      targetChannelName: 'target',
      originalChannel: 'C123',
      originalTs: '111.222',
      originalThreadTs: '111.222',
      userMessage: 'Review this PR',
      userId: 'U_OWNER',
      prUrl: 'https://github.com/acme/repo/pull/1',
      advisoryEphemeral: false,
    });
    const body = {
      actions: [{ value }],
      user: { id: 'U_OWNER' },
      message: { thread_ts: '111.222' },
    };

    await handler.handleMove(body, respond);

    expect(slackApi.deleteMessage).not.toHaveBeenCalled();
  });
});
