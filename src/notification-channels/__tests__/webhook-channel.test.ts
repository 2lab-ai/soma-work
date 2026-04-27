import { describe, expect, it, vi } from 'vitest';
import { WebhookChannel } from '../webhook-channel';

// Contract tests — Scenario 3: Webhook Channel
// Trace: docs/turn-notification/trace.md

describe('WebhookChannel', () => {
  const mockEvent = {
    category: 'WorkflowComplete' as const,
    userId: 'U123',
    channel: 'C123',
    threadTs: '1234567890.123456',
    sessionTitle: 'Test Session',
    message: 'Done',
    durationMs: 5000,
  };

  it('posts payload to registered URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { webhookUrl: 'https://example.com/hook' },
      }),
    };

    const channel = new WebhookChannel(mockSettingsStore, mockFetch);
    await channel.send(mockEvent);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.any(String),
      }),
    );
  });

  it('skips when no URL registered', async () => {
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({ notification: {} }),
    };

    const channel = new WebhookChannel(mockSettingsStore);
    const enabled = await channel.isEnabled('U123');
    expect(enabled).toBe(false);
  });

  it('retries on 5xx with exponential backoff', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { webhookUrl: 'https://example.com/hook' },
      }),
    };

    const channel = new WebhookChannel(mockSettingsStore, mockFetch);
    await channel.send(mockEvent);

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 4xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { webhookUrl: 'https://example.com/hook' },
      }),
    };

    const channel = new WebhookChannel(mockSettingsStore, mockFetch);
    await expect(channel.send(mockEvent)).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('payload matches spec schema', async () => {
    let capturedBody: any;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200 };
    });
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { webhookUrl: 'https://example.com/hook' },
      }),
    };

    const channel = new WebhookChannel(mockSettingsStore, mockFetch);
    await channel.send(mockEvent);

    expect(capturedBody).toMatchObject({
      event: 'turn_completed',
      category: 'WorkflowComplete',
      userId: 'U123',
      sessionId: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('respects 5s timeout', async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      expect(opts.signal).toBeDefined();
      return { ok: true, status: 200 };
    });
    const mockSettingsStore = {
      getUserSettings: vi.fn().mockReturnValue({
        notification: { webhookUrl: 'https://example.com/hook' },
      }),
    };

    const channel = new WebhookChannel(mockSettingsStore, mockFetch);
    await channel.send(mockEvent);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
