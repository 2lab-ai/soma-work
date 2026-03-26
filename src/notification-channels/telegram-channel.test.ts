import { describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './telegram-channel';

// Contract tests — Scenario 4: Telegram DM Channel
// Trace: docs/turn-notification/trace.md

describe('TelegramChannel', () => {
  const mockEvent = {
    category: 'UIUserAskQuestion' as const,
    userId: 'U123',
    channel: 'C123',
    threadTs: '1234567890.123456',
    sessionTitle: 'Test Session',
    durationMs: 5000,
  };

  it('sends message when configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { telegramChatId: '12345' },
      }),
    };

    const channel = new TelegramChannel(mockSettingsStore, 'fake-bot-token', mockFetch);
    await channel.send(mockEvent);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/botfake-bot-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"chat_id":"12345"'),
      }),
    );
  });

  it('skips when no bot token', async () => {
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { telegramChatId: '12345' },
      }),
    };

    const channel = new TelegramChannel(mockSettingsStore, undefined);
    const enabled = await channel.isEnabled('U123');
    expect(enabled).toBe(false);
  });

  it('skips when no chatId', async () => {
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({ notification: {} }),
    };

    const channel = new TelegramChannel(mockSettingsStore, 'fake-token');
    const enabled = await channel.isEnabled('U123');
    expect(enabled).toBe(false);
  });

  it('handles blocked user gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { telegramChatId: '12345' },
      }),
    };

    const channel = new TelegramChannel(mockSettingsStore, 'fake-token', mockFetch);
    await expect(channel.send(mockEvent)).resolves.toBeUndefined();
  });

  it('message includes thread link', async () => {
    let capturedBody: any;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200 };
    });
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { telegramChatId: '12345' },
      }),
    };

    const channel = new TelegramChannel(mockSettingsStore, 'fake-token', mockFetch);
    await channel.send(mockEvent);

    expect(capturedBody.text).toContain('slack.com/archives/C123');
  });
});
