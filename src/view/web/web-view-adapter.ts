/**
 * WebViewAdapter — Web Dashboard view surface (Issue #412)
 *
 * Implements the full ViewSurface hierarchy for Web Dashboard.
 * Web is the superset platform — supports all capabilities.
 *
 * Key difference from Slack:
 * - Native streaming via WebSocket (no edit-polling)
 * - Unlimited message length
 * - Unlimited file size (server-dependent)
 * - Full modal/form support via React components
 *
 * This is a thin adapter over the existing dashboard.ts broadcast
 * functions. It does NOT restructure dashboard internals —
 * that's a separate refactoring task.
 */

import type { ResponseSession } from '../response-session.js';
import type { Editable, HasModals, Reactable, Threadable, ViewSurfaceCore } from '../surface.js';
import type { ContentBlock, ConversationTarget, FeatureSet, FormSpec, MessageHandle, Platform } from '../types.js';
import { extractWebMessageRef, extractWebRef, webMessageHandle, webTarget } from './web-refs.js';
import { WebResponseSession, type WebSocketBroadcaster } from './web-response-session.js';

// ─── Implementation ─────────────────────────────────────────────

export class WebViewAdapter implements ViewSurfaceCore, Editable, Threadable, Reactable, HasModals {
  readonly platform: Platform = 'web';

  constructor(private broadcaster: WebSocketBroadcaster) {}

  // ─── ViewSurfaceCore ──────────────────────────────────────

  async postMessage(target: ConversationTarget, blocks: readonly ContentBlock[]): Promise<MessageHandle> {
    const ref = extractWebRef(target);
    const messageId = `web-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.broadcaster.send(ref.sessionKey, {
      type: 'message',
      sessionKey: ref.sessionKey,
      messageId,
      blocks,
    });

    return webMessageHandle(ref.sessionKey, messageId);
  }

  beginResponse(target: ConversationTarget): ResponseSession {
    const ref = extractWebRef(target);
    return new WebResponseSession(ref.sessionKey, this.broadcaster);
  }

  featuresFor(_target: ConversationTarget): FeatureSet {
    // Web Dashboard supports everything — it's the superset platform.
    return {
      canEdit: true,
      canThread: true,
      canReact: true,
      canModal: true,
      canUploadFile: true,
      canEphemeral: false, // Web doesn't have user-scoped visibility
      maxMessageLength: 0, // Unlimited
      maxFileSize: 0, // Server-dependent, not limited by platform
    };
  }

  // ─── Editable ─────────────────────────────────────────────

  async updateMessage(handle: MessageHandle, blocks: readonly ContentBlock[]): Promise<void> {
    const ref = extractWebMessageRef(handle);

    this.broadcaster.send(ref.sessionKey, {
      type: 'message_update',
      sessionKey: ref.sessionKey,
      messageId: ref.messageId,
      blocks,
    });
  }

  async deleteMessage(handle: MessageHandle): Promise<void> {
    const ref = extractWebMessageRef(handle);

    this.broadcaster.send(ref.sessionKey, {
      type: 'message_delete',
      sessionKey: ref.sessionKey,
      messageId: ref.messageId,
    });
  }

  // ─── Threadable ───────────────────────────────────────────

  async createThread(target: ConversationTarget, _rootBlocks: readonly ContentBlock[]): Promise<ConversationTarget> {
    const ref = extractWebRef(target);
    const threadId = `thread-${Date.now()}`;

    this.broadcaster.send(ref.sessionKey, {
      type: 'thread_created',
      sessionKey: ref.sessionKey,
      threadId,
    });

    return webTarget(ref.sessionKey, target.userId, threadId);
  }

  // ─── Reactable ────────────────────────────────────────────

  async addReaction(handle: MessageHandle, emoji: string): Promise<void> {
    const ref = extractWebMessageRef(handle);

    this.broadcaster.send(ref.sessionKey, {
      type: 'reaction_add',
      sessionKey: ref.sessionKey,
      messageId: ref.messageId,
      emoji,
    });
  }

  async removeReaction(handle: MessageHandle, emoji: string): Promise<void> {
    const ref = extractWebMessageRef(handle);

    this.broadcaster.send(ref.sessionKey, {
      type: 'reaction_remove',
      sessionKey: ref.sessionKey,
      messageId: ref.messageId,
      emoji,
    });
  }

  // ─── HasModals ────────────────────────────────────────────

  async openForm(target: ConversationTarget, form: FormSpec): Promise<string> {
    const ref = extractWebRef(target);
    const formId = `form-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.broadcaster.send(ref.sessionKey, {
      type: 'form_open',
      sessionKey: ref.sessionKey,
      formId,
      form,
    });

    return formId;
  }

  async updateForm(formId: string, form: FormSpec): Promise<void> {
    // Extract sessionKey from formId pattern or broadcast to all
    this.broadcaster.send('*', {
      type: 'form_update',
      formId,
      form,
    });
  }

  async closeForm(formId: string): Promise<void> {
    this.broadcaster.send('*', {
      type: 'form_close',
      formId,
    });
  }
}
