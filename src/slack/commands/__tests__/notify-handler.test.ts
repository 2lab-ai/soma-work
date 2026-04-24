import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userSettingsStore } from '../../../user-settings-store';
import { NotifyHandler } from '../notify-handler';

// Contract tests — Scenario 5: Notify Command Handler
// Trace: docs/turn-notification/trace.md

describe('NotifyHandler', () => {
  const createCtx = (text: string) => ({
    user: 'U123',
    channel: 'C123',
    threadTs: '123.456',
    text,
    say: vi.fn().mockResolvedValue({}),
  });

  it('on enables Slack DM notifications', async () => {
    const handler = new NotifyHandler();
    const ctx = createCtx('notify on');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('활성화'),
      }),
    );
  });

  it('off disables Slack DM notifications', async () => {
    const handler = new NotifyHandler();
    const ctx = createCtx('notify off');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('비활성화'),
      }),
    );
  });

  it('status shows current settings', async () => {
    const handler = new NotifyHandler();
    const ctx = createCtx('notify status');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalled();
  });

  it('telegram registers chat ID', async () => {
    const handler = new NotifyHandler();
    const ctx = createCtx('notify telegram 12345');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('12345'),
      }),
    );
  });

  it('telegram off removes chat ID', async () => {
    const handler = new NotifyHandler();
    const ctx = createCtx('notify telegram off');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('해제'),
      }),
    );
  });

  it('invalid action shows usage', async () => {
    const handler = new NotifyHandler();
    const ctx = createCtx('notify foobar');
    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/사용법|usage|help/i),
      }),
    );
  });

  it('persists settings to user settings store', async () => {
    const handler = new NotifyHandler();
    const ctx = createCtx('notify on');
    await handler.execute(ctx);

    const settings = userSettingsStore.getUserSettings('U123');
    expect(settings?.notification?.slackDm).toBe(true);
  });
});
