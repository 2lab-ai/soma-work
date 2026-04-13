/**
 * TelegramViewAdapter tests (Issue #414)
 */

import { describe, expect, it, vi } from 'vitest';
import type { ContentBlock, ConversationTarget, MessageHandle } from '../types.js';
import {
  type TelegramBotApi,
  type TelegramConversationRef,
  type TelegramMessageRef,
  TelegramViewAdapter,
} from './telegram-view-adapter.js';

// ─── Helpers ────────────────────────────────────────────────────

function telegramTarget(chatId: string | number, userId = 'U001'): ConversationTarget {
  const ref: TelegramConversationRef = { chatId };
  return { platform: 'telegram', ref, userId };
}

function telegramHandle(chatId: string | number, messageId: number): MessageHandle {
  const ref: TelegramMessageRef = { chatId, messageId };
  return { platform: 'telegram', ref };
}

function createMockBot(): TelegramBotApi {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('TelegramViewAdapter', () => {
  it('reports platform as telegram', () => {
    const adapter = new TelegramViewAdapter();
    expect(adapter.platform).toBe('telegram');
  });

  describe('featuresFor', () => {
    it('returns correct capabilities', () => {
      const adapter = new TelegramViewAdapter();
      const features = adapter.featuresFor(telegramTarget(123));

      expect(features.canEdit).toBe(true);
      expect(features.canThread).toBe(false);
      expect(features.canReact).toBe(false);
      expect(features.canModal).toBe(false);
      expect(features.canUploadFile).toBe(true);
      expect(features.canEphemeral).toBe(false);
      expect(features.maxMessageLength).toBe(4096);
      expect(features.maxFileSize).toBe(50 * 1024 * 1024);
    });
  });

  describe('postMessage', () => {
    it('sends message via bot API', async () => {
      const bot = createMockBot();
      const adapter = new TelegramViewAdapter(bot);
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello Telegram!' }];

      const handle = await adapter.postMessage(telegramTarget(123), blocks);

      expect(bot.sendMessage).toHaveBeenCalledWith(123, 'Hello Telegram!', { parse_mode: 'MarkdownV2' });
      expect(handle.platform).toBe('telegram');
      expect((handle.ref as TelegramMessageRef).messageId).toBe(42);
    });

    it('returns stub handle without bot', async () => {
      const adapter = new TelegramViewAdapter();
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello' }];

      const handle = await adapter.postMessage(telegramTarget(123), blocks);

      expect(handle.platform).toBe('telegram');
      expect((handle.ref as TelegramMessageRef).messageId).toBe(0);
    });
  });

  describe('beginResponse', () => {
    it('returns a ResponseSession that collects text', async () => {
      const bot = createMockBot();
      const adapter = new TelegramViewAdapter(bot);
      const session = adapter.beginResponse(telegramTarget(123));

      session.appendText('Hello ');
      session.appendText('world');
      const handle = await session.complete();

      expect(bot.sendMessage).toHaveBeenCalledWith(123, 'Hello world', { parse_mode: 'MarkdownV2' });
      expect(handle.platform).toBe('telegram');
    });

    it('sends typing action on setStatus', () => {
      const bot = createMockBot();
      const adapter = new TelegramViewAdapter(bot);
      const session = adapter.beginResponse(telegramTarget(456));

      session.setStatus('Thinking');

      expect(bot.sendChatAction).toHaveBeenCalledWith(456, 'typing');
    });

    it('does not append text after abort', async () => {
      const bot = createMockBot();
      const adapter = new TelegramViewAdapter(bot);
      const session = adapter.beginResponse(telegramTarget(123));

      session.appendText('Hello');
      session.abort('cancelled');
      session.appendText(' world');

      // No message should be sent since we aborted before complete
      expect(bot.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('Editable', () => {
    it('edits message via bot API', async () => {
      const bot = createMockBot();
      const adapter = new TelegramViewAdapter(bot);
      const handle = telegramHandle(123, 42);
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Updated text' }];

      await adapter.updateMessage(handle, blocks);

      expect(bot.editMessageText).toHaveBeenCalledWith('Updated text', {
        chat_id: 123,
        message_id: 42,
        parse_mode: 'MarkdownV2',
      });
    });

    it('deletes message via bot API', async () => {
      const bot = createMockBot();
      const adapter = new TelegramViewAdapter(bot);
      const handle = telegramHandle(123, 42);

      await adapter.deleteMessage(handle);

      expect(bot.deleteMessage).toHaveBeenCalledWith(123, 42);
    });

    it('is safe to call without bot', async () => {
      const adapter = new TelegramViewAdapter();
      const handle = telegramHandle(123, 42);

      // Should not throw
      await adapter.updateMessage(handle, [{ type: 'text', text: 'x' }]);
      await adapter.deleteMessage(handle);
    });
  });
});
