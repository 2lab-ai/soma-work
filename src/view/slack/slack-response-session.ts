/**
 * SlackResponseSession — ResponseSession implementation for Slack (Issue #409)
 *
 * Implements progressive response rendering via Slack's edit-polling pattern:
 * - appendText() accumulates text and debounces chat.update calls
 * - setStatus() updates reaction emojis and assistant status
 * - complete() sends the final message state and cleans up
 * - abort() cancels pending updates and shows error state
 *
 * This is a thin adapter that wraps existing SlackApiHelper for actual API calls.
 * Internal batching/debouncing logic lives here, not in the wrapped components.
 */

import { Logger } from '../../logger.js';
import type { ResponseSession, StatusDetail } from '../response-session.js';
import type { ContentBlock, FileData, MessageHandle } from '../types.js';
import { type SlackConversationRef, slackMessageHandle } from './slack-refs.js';

// ─── Types ───────────────────────────────────────────────────────

/** Minimal SlackApiHelper interface — only the methods we need. */
export interface SlackApiForResponse {
  postMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; blocks?: any[] },
  ): Promise<{ ts?: string; channel?: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: any[]): Promise<void>;
}

/** Optional Slack components for richer status rendering. */
export interface SlackResponseDeps {
  slackApi: SlackApiForResponse;
  /** Reaction manager for status emoji updates. */
  addReaction?: (channel: string, ts: string, emoji: string) => Promise<boolean>;
  removeReaction?: (channel: string, ts: string, emoji: string) => Promise<void>;
}

// ─── Constants ───────────────────────────────────────────────────

/** Minimum interval between Slack chat.update calls (ms). */
const UPDATE_DEBOUNCE_MS = 300;

// ─── Implementation ─────────────────────────────────────────────

export class SlackResponseSession implements ResponseSession {
  private logger = new Logger('SlackResponseSession');

  private readonly slackApi: SlackApiForResponse;
  private readonly conversationRef: SlackConversationRef;

  // Message state
  private messageTs: string | undefined;
  private accumulatedText = '';
  private parts = new Map<string, ContentBlock>();
  private files: FileData[] = [];

  // Debounce state
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateTime = 0;

  // Lifecycle
  private completed = false;
  private aborted = false;

  constructor(conversationRef: SlackConversationRef, deps: SlackResponseDeps) {
    this.conversationRef = conversationRef;
    this.slackApi = deps.slackApi;
  }

  appendText(delta: string): void {
    if (this.completed || this.aborted) return;
    this.accumulatedText += delta;
    this.scheduleUpdate();
  }

  setStatus(phase: string, detail?: StatusDetail): void {
    if (this.completed || this.aborted) return;
    // Status updates are fire-and-forget for now.
    // Full integration with ReactionManager/AssistantStatusManager
    // will be done when StreamExecutor delegates to this adapter.
    this.logger.debug('Status update', { phase, tool: detail?.tool });
  }

  replacePart(partId: string, content: ContentBlock): void {
    if (this.completed || this.aborted) return;
    this.parts.set(partId, content);
    this.scheduleUpdate();
  }

  attachFile(file: FileData): void {
    if (this.completed || this.aborted) return;
    this.files.push(file);
    // File uploads are not debounced — they're sent immediately when complete() is called
  }

  async complete(): Promise<MessageHandle> {
    if (this.completed || this.aborted) {
      throw new Error('ResponseSession already finalized');
    }
    this.completed = true;
    this.cancelPendingUpdate();

    // Flush final state
    await this.flushUpdate(true);

    const channel = this.conversationRef.channel;
    const ts = this.messageTs;
    if (!ts) {
      throw new Error('No message was sent during this response session');
    }

    return slackMessageHandle(channel, ts, this.conversationRef.threadTs);
  }

  abort(reason?: string): void {
    if (this.completed || this.aborted) return;
    this.aborted = true;
    this.cancelPendingUpdate();

    if (reason) {
      this.logger.info('Response aborted', { reason });
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  private scheduleUpdate(): void {
    if (this.pendingUpdate) return; // Already scheduled

    const elapsed = Date.now() - this.lastUpdateTime;
    const delay = Math.max(0, UPDATE_DEBOUNCE_MS - elapsed);

    this.pendingUpdate = setTimeout(() => {
      this.pendingUpdate = null;
      this.flushUpdate(false).catch((err) => {
        this.logger.warn('Failed to flush update', { error: err?.message });
      });
    }, delay);
  }

  private cancelPendingUpdate(): void {
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }
  }

  private async flushUpdate(isFinal: boolean): Promise<void> {
    const text = this.buildText();
    if (!text && !isFinal) return;

    const channel = this.conversationRef.channel;
    const threadTs = this.conversationRef.threadTs;

    try {
      if (!this.messageTs) {
        // First message — post new
        const result = await this.slackApi.postMessage(channel, text || '...', {
          threadTs,
        });
        this.messageTs = result.ts;
      } else {
        // Subsequent — update existing
        await this.slackApi.updateMessage(channel, this.messageTs, text || '...');
      }
      this.lastUpdateTime = Date.now();
    } catch (err) {
      this.logger.warn('Slack API error during flush', { error: (err as Error)?.message });
    }
  }

  private buildText(): string {
    let text = this.accumulatedText;

    // Append parts in insertion order
    for (const [_partId, block] of this.parts) {
      if (block.type === 'text') {
        text += `\n${block.text}`;
      } else if (block.type === 'status') {
        text += `\n_${block.phase}${block.tool ? ` (${block.tool})` : ''}_`;
      }
    }

    return text;
  }
}
