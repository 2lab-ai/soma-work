/**
 * DiscordViewAdapter — Discord Bot view surface stub (Issue #414)
 *
 * Implements full ViewSurface hierarchy: ViewSurfaceCore & Editable & Threadable & Reactable & HasModals.
 * Discord supports all capabilities: message editing, threads, reactions, and modals.
 *
 * Streaming approach: edit-polling (throttled editMessage calls).
 *
 * Implementation wraps the Discord.js Client API via DiscordClientApi
 * interface for dependency injection. No discord.js dependency required
 * until the adapter is wired to the real bot.
 */

import type { ResponseSession } from '../response-session.js';
import type { Editable, HasModals, Reactable, Threadable, ViewSurfaceCore } from '../surface.js';
import type { ContentBlock, ConversationTarget, FeatureSet, FormSpec, MessageHandle, Platform } from '../types.js';

// ─── Types ───────────────────────────────────────────────────────

/** Discord conversation reference. */
export interface DiscordConversationRef {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
}

/** Discord message reference. */
export interface DiscordMessageRef {
  readonly channelId: string;
  readonly messageId: string;
}

/** Minimal Discord client interface for dependency injection. */
export interface DiscordClientApi {
  sendMessage(channelId: string, content: string): Promise<{ id: string }>;
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  createThread(channelId: string, name: string, messageId?: string): Promise<{ id: string }>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  showModal(interactionId: string, modal: Record<string, unknown>): Promise<string>;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Extract typed DiscordConversationRef from a ConversationTarget. */
export function extractDiscordRef(target: ConversationTarget): DiscordConversationRef {
  if (target.platform !== 'discord') {
    throw new Error(`Expected discord platform target, got ${target.platform}`);
  }
  return target.ref as DiscordConversationRef;
}

/** Create a Discord ConversationTarget. */
export function discordTarget(
  guildId: string,
  channelId: string,
  userId: string,
  threadId?: string,
): ConversationTarget {
  const ref: DiscordConversationRef = threadId ? { guildId, channelId, threadId } : { guildId, channelId };
  return { platform: 'discord', ref, userId };
}

/** Create a Discord MessageHandle. */
export function discordMessageHandle(channelId: string, messageId: string): MessageHandle {
  const ref: DiscordMessageRef = { channelId, messageId };
  return { platform: 'discord', ref };
}

/** Extract typed DiscordMessageRef from a MessageHandle. */
export function extractDiscordMessageRef(handle: MessageHandle): DiscordMessageRef {
  if (handle.platform !== 'discord') {
    throw new Error(`Expected discord platform handle, got ${handle.platform}`);
  }
  return handle.ref as DiscordMessageRef;
}

// ─── Implementation ─────────────────────────────────────────────

export class DiscordViewAdapter implements ViewSurfaceCore, Editable, Threadable, Reactable, HasModals {
  readonly platform: Platform = 'discord';

  constructor(private client?: DiscordClientApi) {}

  // ─── ViewSurfaceCore ──────────────────────────────────────

  async postMessage(target: ConversationTarget, blocks: readonly ContentBlock[]): Promise<MessageHandle> {
    const ref = extractDiscordRef(target);
    const text = this.blocksToText(blocks);
    const targetChannel = ref.threadId ?? ref.channelId;

    if (this.client) {
      const result = await this.client.sendMessage(targetChannel, text);
      return discordMessageHandle(targetChannel, result.id);
    }

    // Stub: return placeholder handle
    return discordMessageHandle(targetChannel, '0');
  }

  beginResponse(target: ConversationTarget): ResponseSession {
    const ref = extractDiscordRef(target);
    const targetChannel = ref.threadId ?? ref.channelId;
    const adapter = this;
    let text = '';
    let completed = false;

    return {
      appendText(delta: string) {
        if (!completed) text += delta;
      },
      setStatus(_phase: string) {
        // Discord uses "typing" indicator
      },
      replacePart(_partId: string, _content: ContentBlock) {
        // Not supported in simple stub mode
      },
      attachFile(_file) {
        // Will use message attachments in full implementation
      },
      async complete() {
        if (completed) {
          return discordMessageHandle(targetChannel, '0');
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
      canThread: true,
      canReact: true,
      canModal: true,
      canUploadFile: true,
      canEphemeral: true,
      maxMessageLength: 2000,
      maxFileSize: 25 * 1024 * 1024, // 25MB (Nitro: 100MB, but base is 25MB)
    };
  }

  // ─── Editable ─────────────────────────────────────────────

  async updateMessage(handle: MessageHandle, blocks: readonly ContentBlock[]): Promise<void> {
    const ref = extractDiscordMessageRef(handle);
    const text = this.blocksToText(blocks);

    if (this.client) {
      await this.client.editMessage(ref.channelId, ref.messageId, text);
    }
  }

  async deleteMessage(handle: MessageHandle): Promise<void> {
    const ref = extractDiscordMessageRef(handle);
    if (this.client) {
      await this.client.deleteMessage(ref.channelId, ref.messageId);
    }
  }

  // ─── Threadable ───────────────────────────────────────────

  async createThread(target: ConversationTarget, rootBlocks: readonly ContentBlock[]): Promise<ConversationTarget> {
    const ref = extractDiscordRef(target);
    const threadName = this.blocksToText(rootBlocks).slice(0, 100) || 'Thread';

    if (this.client) {
      const result = await this.client.createThread(ref.channelId, threadName);
      return discordTarget(ref.guildId, ref.channelId, target.userId, result.id);
    }

    // Stub: return target with a placeholder threadId
    return discordTarget(ref.guildId, ref.channelId, target.userId, `thread-${Date.now()}`);
  }

  // ─── Reactable ────────────────────────────────────────────

  async addReaction(handle: MessageHandle, emoji: string): Promise<void> {
    const ref = extractDiscordMessageRef(handle);
    if (this.client) {
      await this.client.addReaction(ref.channelId, ref.messageId, emoji);
    }
  }

  async removeReaction(handle: MessageHandle, emoji: string): Promise<void> {
    const ref = extractDiscordMessageRef(handle);
    if (this.client) {
      await this.client.removeReaction(ref.channelId, ref.messageId, emoji);
    }
  }

  // ─── HasModals ────────────────────────────────────────────

  async openForm(_target: ConversationTarget, form: FormSpec): Promise<string> {
    const formId = `discord-form-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (this.client) {
      // Discord modals require an interaction ID; stub uses placeholder
      await this.client.showModal('stub-interaction', {
        custom_id: formId,
        title: form.title,
        components: form.fields.map((f) => ({
          type: 4, // TextInput
          custom_id: f.id,
          label: f.label,
          style: f.fieldType === 'textarea' ? 2 : 1,
        })),
      });
    }

    return formId;
  }

  async updateForm(_formId: string, _form: FormSpec): Promise<void> {
    // Discord doesn't support updating modals after opening.
    // This is a no-op but the interface requires it.
  }

  async closeForm(_formId: string): Promise<void> {
    // Discord modals are closed by the user or interaction response.
    // No-op in this adapter.
  }

  // ─── Helpers ──────────────────────────────────────────────

  private blocksToText(blocks: readonly ContentBlock[]): string {
    return blocks
      .map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'status') return `*${b.phase}*`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
}
