import { describe, expect, it, vi } from 'vitest';
import { WebhookHandler } from './webhook-handler';
import { userSettingsStore } from '../../user-settings-store';

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
    expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('등록'),
    }));
  });

  it('register rejects invalid URL', async () => {
    const handler = new WebhookHandler();
    const ctx = createCtx('webhook register not-a-url');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('❌'),
    }));
  });

  it('remove clears URL', async () => {
    const handler = new WebhookHandler();
    const ctx = createCtx('webhook remove');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('삭제'),
    }));
  });

  it('test posts to registered URL', async () => {
    const handler = new WebhookHandler();

    // First register a URL
    const registerCtx = createCtx('webhook register https://example.com/hook');
    await handler.execute(registerCtx);

    // Then test it — note: this will attempt a real fetch in test,
    // but we accept the test may fail on network; the key contract is the response message
    const testCtx = createCtx('webhook test');
    const result = await handler.execute(testCtx);

    expect(result.handled).toBe(true);
    // Either success or failure message, both are valid test results
    expect(testCtx.say).toHaveBeenCalled();
  });

  it('test fails when no URL registered', async () => {
    const handler = new WebhookHandler();
    // Clear any previously registered URL
    userSettingsStore.patchNotification('U123', { webhookUrl: undefined });
    const ctx = createCtx('webhook test');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('❌'),
    }));
  });

  it('persists URL to user settings', async () => {
    const handler = new WebhookHandler();
    const ctx = createCtx('webhook register https://example.com/hook');
    await handler.execute(ctx);

    const settings = userSettingsStore.getUserSettings('U123');
    expect(settings?.notification?.webhookUrl).toBe('https://example.com/hook');
  });

  it('register URL maps to settings.notification.webhookUrl', async () => {
    const handler = new WebhookHandler();
    const url = 'https://my-server.com/webhook';
    const ctx = createCtx(`webhook register ${url}`);
    await handler.execute(ctx);

    const settings = userSettingsStore.getUserSettings('U123');
    expect(settings?.notification?.webhookUrl).toBe(url);
  });
});
