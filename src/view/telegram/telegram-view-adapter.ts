/**
 * TelegramViewAdapter — Telegram Bot API view surface stub (Issue #414)
 *
 * Implements ViewSurfaceCore & Editable for Telegram.
 * Telegram supports message editing but NOT threading, reactions, or modals.
 *
 * Streaming approach: edit-polling (same as Slack).
 * Telegram's editMessageText API is used to simulate streaming.
 *
 * Implementation will wrap the Telegram Bot API (node-telegram-bot-api
 * or telegraf) when the dependency is added.
 */

import type { ResponseSession } from '../response-session.js';
import type { Editable, ViewSurfaceCore } from '../surface.js';
import type { ContentBlock, ConversationTarget, FeatureSet, MessageHandle, Platform } from '../types.js';

// ─── Types ───────────────────────────────────────────────────────

/** Telegram conversation reference. */
export interface TelegramConversationRef {
  readonly chatId: string | number;
  readonly topicId?: number;
}

/** Telegram message reference. */
export interface TelegramMessageRef {
  readonly chatId: string | number;
  readonly messageId: number;
}

/** Minimal Telegram Bot API interface for dependency injection. */
export interface TelegramBotApi {
  sendMessage(
    chatId: string | number,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  editMessageText(
    text: string,
    options: { chat_id: string | number; message_id: number; parse_mode?: string },
  ): Promise<void>;
  deleteMessage(chatId: string | number, messageId: number): Promise<void>;
  sendChatAction(chatId: string | number, action: string): Promise<void>;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Extract typed TelegramConversationRef from a ConversationTarget. */
export function extractTelegramRef(target: ConversationTarget): TelegramConversationRef {
  if (target.platform !== 'telegram') {
    throw new Error(`Expected telegram platform target, got ${target.platform}`);
  }
  return target.ref as TelegramConversationRef;
}

/** Extract typed TelegramMessageRef from a MessageHandle. */
export function extractTelegramMessageRef(handle: MessageHandle): TelegramMessageRef {
  if (handle.platform !== 'telegram') {
    throw new Error(`Expected telegram platform handle, got ${handle.platform}`);
  }
  return handle.ref as TelegramMessageRef;
}

// ─── Implementation ─────────────────────────────────────────────

export class TelegramViewAdapter implements ViewSurfaceCore, Editable {
  readonly platform: Platform = 'telegram';

  constructor(private bot?: TelegramBotApi) {}

  async postMessage(target: ConversationTarget, blocks: readonly ContentBlock[]): Promise<MessageHandle> {
    const ref = extractTelegramRef(target);
    const text = this.blocksToText(blocks);

    if (this.bot) {
      const result = await this.bot.sendMessage(ref.chatId, text, { parse_mode: 'MarkdownV2' });
      return {
        platform: 'telegram',
        ref: { chatId: ref.chatId, messageId: result.message_id } as TelegramMessageRef,
      };
    }

    // Stub: return placeholder handle
    return {
      platform: 'telegram',
      ref: { chatId: ref.chatId, messageId: 0 } as TelegramMessageRef,
    };
  }

  beginResponse(target: ConversationTarget): ResponseSession {
    // Will use edit-polling similar to Slack (throttled editMessageText calls)
    // For now, return a minimal stub that collects text
    const ref = extractTelegramRef(target);
    const adapter = this;
    let text = '';
    let completed = false;

    return {
      appendText(delta: string) {
        if (!completed) text += delta;
      },
      setStatus(_phase: string) {
        // Telegram uses sendChatAction('typing') for status
        adapter.bot?.sendChatAction(ref.chatId, 'typing').catch(() => {});
      },
      replacePart(_partId: string, _content: ContentBlock) {
        // Not supported in simple mode
      },
      attachFile(_file) {
        // Will use sendDocument in full implementation
      },
      async complete() {
        if (completed) {
          return { platform: 'telegram' as Platform, ref: { chatId: ref.chatId, messageId: 0 } as TelegramMessageRef };
        }
        completed = true;
        const handle = await adapter.postMessage(target, [{ type: 'text', text }]);
        return handle;
      },
      abort(_reason?: string) {
        completed = true;
      },
    };
  }

  featuresFor(_target: ConversationTarget): FeatureSet {
    return {
      canEdit: true,
      canThread: false,
      canReact: false,
      canModal: false,
      canUploadFile: true,
      canEphemeral: false,
      maxMessageLength: 4096,
      maxFileSize: 50 * 1024 * 1024, // 50MB
    };
  }

  // ─── Editable ─────────────────────────────────────────────

  async updateMessage(handle: MessageHandle, blocks: readonly ContentBlock[]): Promise<void> {
    const ref = extractTelegramMessageRef(handle);
    const text = this.blocksToText(blocks);

    if (this.bot) {
      await this.bot.editMessageText(text, {
        chat_id: ref.chatId,
        message_id: ref.messageId,
        parse_mode: 'MarkdownV2',
      });
    }
  }

  async deleteMessage(handle: MessageHandle): Promise<void> {
    const ref = extractTelegramMessageRef(handle);
    if (this.bot) {
      await this.bot.deleteMessage(ref.chatId, ref.messageId);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────

  private blocksToText(blocks: readonly ContentBlock[]): string {
    return blocks
      .map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'status') return `_${b.phase}_`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
}
