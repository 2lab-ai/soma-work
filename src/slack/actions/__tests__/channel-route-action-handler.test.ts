import { describe, expect, it, vi } from 'vitest';
import { buildChannelRouteBlocks, ChannelRouteActionHandler } from '../channel-route-action-handler';

describe('buildChannelRouteBlocks', () => {
  it('hides stay-in-channel button by default', () => {
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

    const actionsBlock = blocks.find((block) => block.type === 'actions');
    expect(actionsBlock).toBeDefined();
    const actionIds = actionsBlock.elements.map((el: any) => el.action_id);
    expect(actionIds).toContain('channel_route_move');
    expect(actionIds).toContain('channel_route_stop');
    expect(actionIds).not.toContain('channel_route_stay');
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

    const actionsBlock = blocks.find((block) => block.type === 'actions');
    const actionIds = actionsBlock.elements.map((el: any) => el.action_id);
    expect(actionIds).toContain('channel_route_stay');
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

    const actionsBlock = blocks.find((block) => block.type === 'actions');
    const actionIds = actionsBlock.elements.map((el: any) => el.action_id);
    expect(actionIds).not.toContain('channel_route_move');
    expect(actionIds).toContain('channel_route_stop');
    expect(actionIds).toContain('channel_route_stay');
  });

  it('round-trips cleanupTs in button value payload (Issue #516)', () => {
    // Durability: the handler may fire after the server restarted or the
    // source session was halted. We can't rely on the session registry —
    // the cleanup targets must be transported inside the Slack button value.
    const cleanupTs = ['conv-link-ts', 'dispatch-ts'];
    const { blocks } = buildChannelRouteBlocks({
      prUrl: 'https://github.com/acme/repo/pull/1',
      targetChannelName: 'dev',
      targetChannelId: 'C123',
      originalChannel: 'C999',
      originalTs: '111.222',
      originalThreadTs: '333.444',
      userMessage: 'Review this PR',
      userId: 'U123',
      cleanupTs,
    });

    const actionsBlock = blocks.find((block) => block.type === 'actions');
    expect(actionsBlock).toBeDefined();
    for (const el of actionsBlock.elements as any[]) {
      const decoded = JSON.parse(el.value);
      expect(decoded.cleanupTs).toEqual(cleanupTs);
    }
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

describe('ChannelRouteActionHandler source-thread cleanup (#516)', () => {
  function buildDeps() {
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
    return { slackApi, handler };
  }

  it('handleMove deletes every cleanupTs individually and never sweeps the thread', async () => {
    const { slackApi, handler } = buildDeps();
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
      cleanupTs: ['conv-link-ts', 'dispatch-ts'],
    });
    const body = {
      actions: [{ value }],
      user: { id: 'U_OWNER' },
      message: { thread_ts: '111.222' },
    };

    await handler.handleMove(body, vi.fn().mockResolvedValue(undefined));

    expect(slackApi.deleteMessage).toHaveBeenCalledWith('C123', 'conv-link-ts');
    expect(slackApi.deleteMessage).toHaveBeenCalledWith('C123', 'dispatch-ts');
    expect(slackApi.deleteMessage).toHaveBeenCalledWith('C123', '999.000'); // advisory
    expect(slackApi.deleteThreadBotMessages).not.toHaveBeenCalled();

    // A fabricated prior model-reply ts must NOT be deleted.
    expect(slackApi.deleteMessage).not.toHaveBeenCalledWith('C123', 'model-reply-ts');
  });

  it('handleStay deletes every cleanupTs individually and never sweeps the thread', async () => {
    const { slackApi, handler } = buildDeps();
    const value = JSON.stringify({
      targetChannel: 'C123',
      targetChannelName: 'current',
      originalChannel: 'C123',
      originalTs: '111.222',
      originalThreadTs: '111.222',
      advisoryTs: '999.000',
      userMessage: 'Review this PR',
      userId: 'U_OWNER',
      prUrl: 'https://github.com/acme/repo/pull/1',
      advisoryEphemeral: false,
      cleanupTs: ['conv-link-ts', 'dispatch-ts'],
    });
    const body = {
      actions: [{ value }],
      user: { id: 'U_OWNER' },
      message: { thread_ts: '111.222' },
    };

    await handler.handleStay(body, vi.fn().mockResolvedValue(undefined));

    expect(slackApi.deleteMessage).toHaveBeenCalledWith('C123', 'conv-link-ts');
    expect(slackApi.deleteMessage).toHaveBeenCalledWith('C123', 'dispatch-ts');
    expect(slackApi.deleteMessage).toHaveBeenCalledWith('C123', '999.000');
    expect(slackApi.deleteThreadBotMessages).not.toHaveBeenCalled();
    expect(slackApi.deleteMessage).not.toHaveBeenCalledWith('C123', 'model-reply-ts');
  });

  it('handleMove tolerates missing cleanupTs (back-compat with old buttons)', async () => {
    const { slackApi, handler } = buildDeps();
    // Old buttons minted before this fix won't carry cleanupTs. The handler
    // must still run (advisory delete + route) without throwing.
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
      // cleanupTs deliberately absent
    });
    const body = {
      actions: [{ value }],
      user: { id: 'U_OWNER' },
      message: { thread_ts: '111.222' },
    };

    await expect(handler.handleMove(body, vi.fn().mockResolvedValue(undefined))).resolves.toBeUndefined();
    expect(slackApi.deleteMessage).toHaveBeenCalledWith('C123', '999.000');
    expect(slackApi.deleteThreadBotMessages).not.toHaveBeenCalled();
  });
});
