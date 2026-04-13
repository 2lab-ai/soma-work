/**
 * WebRefs — Opaque reference types for Web Dashboard (Issue #412)
 *
 * Web Dashboard uses session-based references instead of Slack's
 * channel/thread model. Each conversation is identified by a
 * session key (matching SessionRegistry) and optional thread ID.
 */

import type { ConversationTarget, MessageHandle, Platform } from '../types.js';

// ─── Ref Types ──────────────────────────────────────────────────

/** Web conversation reference (opaque to the Controller). */
export interface WebConversationRef {
  readonly sessionKey: string;
  readonly userId: string;
  readonly threadId?: string;
}

/** Web message reference (opaque to the Controller). */
export interface WebMessageRef {
  readonly sessionKey: string;
  readonly messageId: string;
  readonly timestamp: number;
}

// ─── Factory Functions ──────────────────────────────────────────

/** Create a ConversationTarget for Web Dashboard. */
export function webTarget(sessionKey: string, userId: string, threadId?: string): ConversationTarget {
  const ref: WebConversationRef = { sessionKey, userId, threadId };
  return {
    platform: 'web' as Platform,
    ref,
    userId,
  };
}

/** Create a MessageHandle for a Web message. */
export function webMessageHandle(sessionKey: string, messageId: string): MessageHandle {
  const ref: WebMessageRef = { sessionKey, messageId, timestamp: Date.now() };
  return {
    platform: 'web' as Platform,
    ref,
  };
}

// ─── Extractors ─────────────────────────────────────────────────

/** Extract WebConversationRef from a ConversationTarget. */
export function extractWebRef(target: ConversationTarget): WebConversationRef {
  if (target.platform !== 'web') {
    throw new Error(`Expected web platform target, got ${target.platform}`);
  }
  return target.ref as WebConversationRef;
}

/** Extract WebMessageRef from a MessageHandle. */
export function extractWebMessageRef(handle: MessageHandle): WebMessageRef {
  if (handle.platform !== 'web') {
    throw new Error(`Expected web platform handle, got ${handle.platform}`);
  }
  return handle.ref as WebMessageRef;
}
