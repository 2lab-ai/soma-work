import { describe, it, expect, vi } from 'vitest';
import { ChannelRouteActionHandler } from './channel-route-action-handler';

describe('ChannelRouteActionHandler', () => {
  it('responds with reason when user stops routing', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
    };
    const handler = new ChannelRouteActionHandler({
      slackApi: slackApi as any,
      claudeHandler: {} as any,
      messageHandler: vi.fn(),
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const body = {
      user: { id: 'U1' },
      actions: [{
        value: JSON.stringify({
          targetChannel: 'C2',
          targetChannelName: 'repo-channel',
          originalChannel: 'C1',
          originalTs: '111.222',
          originalThreadTs: '111.222',
          userMessage: 'test',
        }),
      }],
      message: { thread_ts: '111.222' },
    };

    await handler.handleStop(body, respond);

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      replace_original: true,
      text: expect.stringContaining('채널 이동하지 않음'),
    }));
    expect(slackApi.postMessage).not.toHaveBeenCalled();
  });

  it('posts reason in thread when respond fails', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
    };
    const handler = new ChannelRouteActionHandler({
      slackApi: slackApi as any,
      claudeHandler: {} as any,
      messageHandler: vi.fn(),
    });

    const respond = vi.fn().mockRejectedValue(new Error('respond failed'));
    const body = {
      user: { id: 'U1' },
      actions: [{
        value: JSON.stringify({
          targetChannel: 'C2',
          targetChannelName: 'repo-channel',
          originalChannel: 'C1',
          originalTs: '111.222',
          originalThreadTs: '111.222',
          userMessage: 'test',
        }),
      }],
      message: { thread_ts: '111.222' },
    };

    await handler.handleStop(body, respond);

    expect(slackApi.postMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('채널 이동하지 않음'),
      { threadTs: '111.222' }
    );
  });
});
