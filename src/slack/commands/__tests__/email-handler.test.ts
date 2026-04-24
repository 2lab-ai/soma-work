import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock modules before imports
vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserEmail: vi.fn(),
    setUserEmail: vi.fn(),
  },
}));

import { userSettingsStore } from '../../../user-settings-store';
import { EmailHandler } from '../email-handler';
import type { CommandContext } from '../types';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_TEST',
    channel: 'C123',
    threadTs: 'thread123',
    text: '',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

describe('EmailHandler', () => {
  let handler: EmailHandler;

  beforeEach(() => {
    handler = new EmailHandler();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── canHandle ──
  describe('canHandle', () => {
    it.each([
      'show email',
      'set email user@example.com',
      '/show email',
      '/set email user@example.com',
    ])('recognizes "%s"', (text) => {
      expect(handler.canHandle(text)).toBe(true);
    });

    it.each(['hello', 'email me', 'set something', 'show prompt'])('rejects "%s"', (text) => {
      expect(handler.canHandle(text)).toBe(false);
    });
  });

  // ── show email (email is set) ──
  describe('show email when email is set', () => {
    it('shows the configured email', async () => {
      vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('alice@example.com');
      const ctx = makeCtx({ text: 'show email' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('alice@example.com'),
        }),
      );
    });
  });

  // ── show email (email is not set) ──
  describe('show email when email is not set', () => {
    it('shows "not set" guidance message', async () => {
      vi.mocked(userSettingsStore.getUserEmail).mockReturnValue(undefined);
      const ctx = makeCtx({ text: 'show email' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('설정되지 않음'),
        }),
      );
    });
  });

  // ── set email (valid) ──
  describe('set email with valid address', () => {
    it('sets email and shows success message', async () => {
      const ctx = makeCtx({ text: 'set email valid@email.com' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(userSettingsStore.setUserEmail).toHaveBeenCalledWith('U_TEST', 'valid@email.com');
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('이메일 설정 완료'),
        }),
      );
    });
  });

  // ── set email (invalid format) ──
  describe('set email with invalid format', () => {
    it('shows error for bad format', async () => {
      const ctx = makeCtx({ text: 'set email invalid' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(userSettingsStore.setUserEmail).not.toHaveBeenCalled();
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('잘못된 이메일 형식'),
        }),
      );
    });
  });

  // ── set email (Slack mailto auto-link) ──
  describe('set email with Slack mailto format', () => {
    it('strips Slack mailto and sets correct email', async () => {
      const ctx = makeCtx({ text: 'set email <mailto:x@y.com|x@y.com>' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(userSettingsStore.setUserEmail).toHaveBeenCalledWith('U_TEST', 'x@y.com');
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('이메일 설정 완료'),
        }),
      );
    });
  });
});
