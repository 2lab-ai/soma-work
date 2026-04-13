/**
 * SlackViewAdapter — ViewSurface implementation for Slack (Issue #409)
 *
 * Implements ViewSurfaceCore + Editable + Threadable + Reactable + HasModals
 * by wrapping existing Slack components (SlackApiHelper, etc.).
 *
 * This is a thin integration layer. It does NOT restructure StreamExecutor.
 * It proves the View abstraction works with real Slack APIs.
 * Internal StreamExecutor decomposition happens in Phase 4.
 *
 * Usage:
 *   const adapter = new SlackViewAdapter(slackApi);
 *   const ref = await adapter.postMessage(target, [{ type: 'text', text: 'Hello' }]);
 *   const session = adapter.beginResponse(target);
 *   session.appendText('Thinking...');
 *   await session.complete();
 */

import { Logger } from '../../logger.js';
import type { ResponseSession } from '../response-session.js';
import type { Editable, HasModals, Reactable, Threadable, ViewSurfaceCore } from '../surface.js';
import type { ContentBlock, ConversationTarget, FeatureSet, FormSpec, MessageHandle, Platform } from '../types.js';
import { extractSlackMessageRef, extractSlackRef, slackMessageHandle, slackTarget } from './slack-refs.js';
import { type SlackApiForResponse, SlackResponseSession } from './slack-response-session.js';

// ─── Types ───────────────────────────────────────────────────────

/** Full SlackApiHelper interface — only the methods we delegate to. */
export interface SlackApiForView extends SlackApiForResponse {
  deleteMessage(channel: string, ts: string): Promise<void>;
  addReaction(channel: string, ts: string, emoji: string): Promise<boolean>;
  removeReaction(channel: string, ts: string, emoji: string): Promise<void>;
  getClient(): any;
}

// ─── Slack Capabilities ──────────────────────────────────────────

/** Default Slack feature set. Some features depend on channel type. */
const SLACK_DEFAULT_FEATURES: FeatureSet = {
  canEdit: true,
  canThread: true,
  canReact: true,
  canModal: true,
  canUploadFile: true,
  canEphemeral: true,
  maxMessageLength: 4000,
  maxFileSize: 0, // Slack handles limits internally
};

/** DM channels have limited threading support. */
const SLACK_DM_FEATURES: FeatureSet = {
  ...SLACK_DEFAULT_FEATURES,
  canThread: false, // DMs don't have true threading
  canEphemeral: false, // No ephemeral in DMs
};

// ─── Implementation ─────────────────────────────────────────────

export class SlackViewAdapter implements ViewSurfaceCore, Editable, Threadable, Reactable, HasModals {
  private logger = new Logger('SlackViewAdapter');
  readonly platform: Platform = 'slack';

  constructor(private slackApi: SlackApiForView) {}

  // ─── ViewSurfaceCore ───────────────────────────────────────

  async postMessage(target: ConversationTarget, blocks: readonly ContentBlock[]): Promise<MessageHandle> {
    const ref = extractSlackRef(target);
    const text = this.contentBlocksToText(blocks);

    const result = await this.slackApi.postMessage(ref.channel, text, {
      threadTs: ref.threadTs,
    });

    if (!result.ts) {
      throw new Error('Slack postMessage did not return a timestamp');
    }

    return slackMessageHandle(ref.channel, result.ts, ref.threadTs);
  }

  beginResponse(target: ConversationTarget): ResponseSession {
    const ref = extractSlackRef(target);
    return new SlackResponseSession(ref, {
      slackApi: this.slackApi,
      addReaction: (ch, ts, emoji) => this.slackApi.addReaction(ch, ts, emoji),
      removeReaction: (ch, ts, emoji) => this.slackApi.removeReaction(ch, ts, emoji),
    });
  }

  featuresFor(target: ConversationTarget): FeatureSet {
    const ref = extractSlackRef(target);

    // DM channels (start with 'D') have limited features
    if (ref.channel.startsWith('D')) {
      return SLACK_DM_FEATURES;
    }

    return SLACK_DEFAULT_FEATURES;
  }

  // ─── Editable ──────────────────────────────────────────────

  async updateMessage(handle: MessageHandle, blocks: readonly ContentBlock[]): Promise<void> {
    const ref = extractSlackMessageRef(handle);
    const text = this.contentBlocksToText(blocks);
    await this.slackApi.updateMessage(ref.channel, ref.ts, text);
  }

  async deleteMessage(handle: MessageHandle): Promise<void> {
    const ref = extractSlackMessageRef(handle);
    await this.slackApi.deleteMessage(ref.channel, ref.ts);
  }

  // ─── Threadable ────────────────────────────────────────────

  async createThread(target: ConversationTarget, rootBlocks: readonly ContentBlock[]): Promise<ConversationTarget> {
    const ref = extractSlackRef(target);
    const text = this.contentBlocksToText(rootBlocks);

    const result = await this.slackApi.postMessage(ref.channel, text);
    if (!result.ts) {
      throw new Error('Slack postMessage did not return a timestamp for thread root');
    }

    // Return a new target scoped to the thread
    return slackTarget(target.userId, ref.channel, result.ts);
  }

  // ─── Reactable ─────────────────────────────────────────────

  async addReaction(handle: MessageHandle, emoji: string): Promise<void> {
    const ref = extractSlackMessageRef(handle);
    await this.slackApi.addReaction(ref.channel, ref.ts, emoji);
  }

  async removeReaction(handle: MessageHandle, emoji: string): Promise<void> {
    const ref = extractSlackMessageRef(handle);
    await this.slackApi.removeReaction(ref.channel, ref.ts, emoji);
  }

  // ─── HasModals ─────────────────────────────────────────────

  async openForm(target: ConversationTarget, form: FormSpec): Promise<string> {
    // Slack modals require a trigger_id from an interaction event.
    // This is a placeholder — full modal support requires wiring
    // into Slack's views.open API with a trigger_id from the interaction payload.
    // For now, we render forms as inline messages.
    this.logger.debug('openForm called — inline rendering (trigger_id not available)', {
      title: form.title,
    });

    const ref = extractSlackRef(target);
    const text = this.formSpecToText(form);
    const result = await this.slackApi.postMessage(ref.channel, text, {
      threadTs: ref.threadTs,
    });

    return result.ts || `form-${Date.now()}`;
  }

  async updateForm(formId: string, form: FormSpec): Promise<void> {
    // With trigger_id-based modals this would call views.update.
    // Inline form rendering: we'd need channel context to update.
    this.logger.debug('updateForm called', { formId, title: form.title });
  }

  async closeForm(formId: string): Promise<void> {
    this.logger.debug('closeForm called', { formId });
  }

  // ─── Content Rendering ────────────────────────────────────

  /**
   * Convert ContentBlock array to Slack mrkdwn text.
   * This is a simplified renderer. Full Block Kit rendering
   * will be added when StreamExecutor delegates to this adapter.
   */
  private contentBlocksToText(blocks: readonly ContentBlock[]): string {
    const parts: string[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (block.format === 'code') {
            parts.push(`\`\`\`${block.language || ''}\n${block.text}\n\`\`\``);
          } else {
            parts.push(block.text);
          }
          break;
        case 'status':
          parts.push(`_${block.phase}${block.tool ? ` (${block.tool})` : ''}_`);
          break;
        case 'actions':
          for (const item of block.items) {
            parts.push(`• *${item.label}*${item.description ? ` — ${item.description}` : ''}`);
          }
          break;
        case 'attachment':
          parts.push(`📎 ${block.name} (${block.mimeType})`);
          break;
        case 'form':
          parts.push(this.formBlockToText(block));
          break;
      }
    }

    return parts.join('\n') || '...';
  }

  private formBlockToText(block: ContentBlock & { type: 'form' }): string {
    const lines: string[] = [];
    if (block.title) lines.push(`*${block.title}*`);
    for (const field of block.fields) {
      const required = field.required ? ' *(required)*' : '';
      lines.push(`• ${field.label}${required}`);
    }
    return lines.join('\n');
  }

  private formSpecToText(form: FormSpec): string {
    const lines: string[] = [`*${form.title}*`];
    for (const field of form.fields) {
      const required = field.required ? ' *(required)*' : '';
      lines.push(`• ${field.label}${required}`);
    }
    if (form.submitLabel) {
      lines.push(`\n_[${form.submitLabel}]_`);
    }
    return lines.join('\n');
  }
}
