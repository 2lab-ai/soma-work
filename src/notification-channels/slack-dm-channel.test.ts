import { describe, expect, it, vi } from 'vitest';
import { SlackDmChannel } from './slack-dm-channel';

// Contract tests — Scenario 2: Slack DM Channel
// Trace: docs/turn-notification/trace.md

describe('SlackDmChannel', () => {
  const mockEvent = {
    category: 'WorkflowComplete' as const,
    userId: 'U123',
    channel: 'C123',
    threadTs: '1234567890.123456',
    sessionTitle: 'Test Session',
    durationMs: 5000,
  };

  it('sends DM when enabled', async () => {
    const mockSlackApi = {
      openDmChannel: vi.fn().mockResolvedValue('D999'),
      postMessage: vi.fn().mockResolvedValue(undefined),
    };
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { slackDm: true },
      }),
    };

    const channel = new SlackDmChannel(mockSlackApi, mockSettingsStore);
    await channel.send(mockEvent);

    expect(mockSlackApi.openDmChannel).toHaveBeenCalledWith('U123');
    expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
      'D999',
      expect.any(String),
      expect.objectContaining({ blocks: expect.any(Array) }),
    );
  });

  it('skips when disabled', async () => {
    const mockSlackApi = { openDmChannel: vi.fn(), postMessage: vi.fn() };
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { slackDm: false },
      }),
    };

    const channel = new SlackDmChannel(mockSlackApi, mockSettingsStore);
    const enabled = await channel.isEnabled('U123');

    expect(enabled).toBe(false);
    expect(mockSlackApi.openDmChannel).not.toHaveBeenCalled();
  });

  it('opens conversation then posts message', async () => {
    const callOrder: string[] = [];
    const mockSlackApi = {
      openDmChannel: vi.fn().mockImplementation(async () => {
        callOrder.push('open');
        return 'D999';
      }),
      postMessage: vi.fn().mockImplementation(async () => {
        callOrder.push('post');
      }),
    };
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { slackDm: true },
      }),
    };

    const channel = new SlackDmChannel(mockSlackApi, mockSettingsStore);
    await channel.send(mockEvent);

    expect(callOrder).toEqual(['open', 'post']);
  });

  it('handles DM blocked gracefully', async () => {
    const mockSlackApi = {
      openDmChannel: vi.fn().mockRejectedValue(new Error('not_allowed_to_dm')),
      postMessage: vi.fn(),
    };
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { slackDm: true },
      }),
    };

    const channel = new SlackDmChannel(mockSlackApi, mockSettingsStore);
    await expect(channel.send(mockEvent)).resolves.toBeUndefined();
    expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
  });
});
