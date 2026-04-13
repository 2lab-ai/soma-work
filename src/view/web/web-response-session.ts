/**
 * WebResponseSession — WebSocket-based native streaming (Issue #412)
 *
 * Unlike Slack/Telegram/Discord which use edit-polling (throttled message edits),
 * the Web Dashboard supports true streaming via WebSocket.
 *
 * Each `appendText` call is sent immediately as a WebSocket message.
 * The frontend reconstructs the full response by accumulating deltas.
 *
 * Protocol:
 *   { type: 'response_start', sessionKey }
 *   { type: 'response_text', sessionKey, delta }
 *   { type: 'response_status', sessionKey, phase, detail? }
 *   { type: 'response_replace', sessionKey, partId, content }
 *   { type: 'response_file', sessionKey, name, mimeType }
 *   { type: 'response_complete', sessionKey, messageId }
 *   { type: 'response_abort', sessionKey, reason? }
 */

import { Logger } from '../../logger.js';
import type { ResponseSession, StatusDetail } from '../response-session.js';
import type { ContentBlock, FileData, MessageHandle } from '../types.js';
import { webMessageHandle } from './web-refs.js';

// ─── Types ───────────────────────────────────────────────────────

/** Minimal interface for broadcasting to WebSocket clients. */
export interface WebSocketBroadcaster {
  /** Send a typed message to all connected clients for a session. */
  send(sessionKey: string, message: Record<string, unknown>): void;
}

// ─── Implementation ─────────────────────────────────────────────

export class WebResponseSession implements ResponseSession {
  private logger = new Logger('WebResponseSession');
  private completed = false;
  private aborted = false;
  private messageId: string;
  private textLength = 0;

  constructor(
    private sessionKey: string,
    private broadcaster: WebSocketBroadcaster,
  ) {
    this.messageId = `web-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.broadcaster.send(this.sessionKey, {
      type: 'response_start',
      sessionKey: this.sessionKey,
      messageId: this.messageId,
    });
  }

  appendText(delta: string): void {
    if (this.completed || this.aborted) return;
    this.textLength += delta.length;

    this.broadcaster.send(this.sessionKey, {
      type: 'response_text',
      sessionKey: this.sessionKey,
      delta,
    });
  }

  setStatus(phase: string, detail?: StatusDetail): void {
    if (this.completed || this.aborted) return;

    this.broadcaster.send(this.sessionKey, {
      type: 'response_status',
      sessionKey: this.sessionKey,
      phase,
      ...(detail && { detail }),
    });
  }

  replacePart(partId: string, content: ContentBlock): void {
    if (this.completed || this.aborted) return;

    this.broadcaster.send(this.sessionKey, {
      type: 'response_replace',
      sessionKey: this.sessionKey,
      partId,
      content,
    });
  }

  attachFile(file: FileData): void {
    if (this.completed || this.aborted) return;

    this.broadcaster.send(this.sessionKey, {
      type: 'response_file',
      sessionKey: this.sessionKey,
      name: file.name,
      mimeType: file.mimeType,
      size: file.data instanceof Buffer ? file.data.length : file.data.length,
    });
  }

  async complete(): Promise<MessageHandle> {
    if (this.completed || this.aborted) {
      return webMessageHandle(this.sessionKey, this.messageId);
    }

    this.completed = true;
    this.broadcaster.send(this.sessionKey, {
      type: 'response_complete',
      sessionKey: this.sessionKey,
      messageId: this.messageId,
      textLength: this.textLength,
    });

    this.logger.debug('Response completed', {
      sessionKey: this.sessionKey,
      textLength: this.textLength,
    });

    return webMessageHandle(this.sessionKey, this.messageId);
  }

  abort(reason?: string): void {
    if (this.completed || this.aborted) return;

    this.aborted = true;
    this.broadcaster.send(this.sessionKey, {
      type: 'response_abort',
      sessionKey: this.sessionKey,
      reason,
    });

    this.logger.debug('Response aborted', {
      sessionKey: this.sessionKey,
      reason,
    });
  }
}
