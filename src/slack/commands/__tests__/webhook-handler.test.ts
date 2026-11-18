import { describe, expect, it, vi } from 'vitest';
import { userSettingsStore } from '../../../user-settings-store';
import { WebhookHandler } from '../webhook-handler';

// Contract tests — Scenario 6: Webhook Command Handler
// Trace: docs/turn-notification/trace.md

describe('WebhookHandler', () => {
  const createCtx = (text: string) => ({
    user: 'U123',
    channel: 'C123',
    threadTs: '123.456',
    text,
    say: vi.fn().mockResolvedValue({}),
  });

  it('register saves valid URL', async () => {
    const handler = new WebhookHandler();
    const ctx = createCtx('webhook register https://example.com/hook');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('등록'),
      }),
    );
  });

  it('register rejects invalid URL', async () => {
    const handler = new WebhookHandler();
    const ctx = createCtx('webhook register not-a-url');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('❌'),
      }),
    );
  });

  it('remove clears URL', async () => {
    const handler = new WebhookHandler();
    const ctx = createCtx('webhook remove');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('삭제'),
      }),
    );
  });

  it('test posts a test payload to the registered URL and reports the HTTP status', async () => {
    const handler = new WebhookHandler();
    // A public IP literal skips the DNS lookup, so no network is touched.
    const url = 'https://93.184.216.34/hook';
    await handler.execute(createCtx(`webhook register ${url}`));

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const testCtx = createCtx('webhook test');
      const result = await handler.execute(testCtx);

      expect(result.handled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe(url);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(JSON.parse(init.body)).toMatchObject({ event: 'turn_completed', userId: 'U123' });
      expect(testCtx.say).toHaveBeenCalledWith({
        text: '✅ 테스트 웹훅 발송 성공 (HTTP 204)',
        thread_ts: '123.456',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('test fails when no URL registered', async () => {
    const handler = new WebhookHandler();
    // Clear any previously registered URL
    userSettingsStore.patchNotification('U123', { webhookUrl: undefined });
    const ctx = createCtx('webhook test');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('❌'),
      }),
    );
  });

  it('persists URL to user settings', async () => {
    const handler = new WebhookHandler();
    const ctx = createCtx('webhook register https://example.com/hook');
    await handler.execute(ctx);

    const settings = userSettingsStore.getUserSettings('U123');
    expect(settings?.notification?.webhookUrl).toBe('https://example.com/hook');
  });
});
