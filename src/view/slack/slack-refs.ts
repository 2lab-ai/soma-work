/**
 * Slack-specific opaque reference types (Issue #409)
 *
 * These are the concrete shapes behind ConversationTarget.ref and MessageHandle.ref
 * for the Slack platform. Only Slack adapter code should import these.
 * Controller code uses the opaque `unknown` types.
 */

import type { ConversationTarget, MessageHandle } from '../types.js';

// ─── Slack Reference Shapes ─────────────────────────────────────

/** Slack conversation address (channel + optional thread). */
export interface SlackConversationRef {
  readonly channel: string;
  readonly threadTs?: string;
}

/** Slack message reference (channel + message timestamp). */
export interface SlackMessageRef {
  readonly channel: string;
  readonly ts: string;
  readonly threadTs?: string;
}

// ─── Factory Functions ──────────────────────────────────────────

/** Create a Slack ConversationTarget. */
export function slackTarget(userId: string, channel: string, threadTs?: string): ConversationTarget {
  const ref: SlackConversationRef = { channel, threadTs };
  return { platform: 'slack', ref, userId };
}

/** Create a Slack MessageHandle. */
export function slackMessageHandle(channel: string, ts: string, threadTs?: string): MessageHandle {
  const ref: SlackMessageRef = { channel, ts, threadTs };
  return { platform: 'slack', ref };
}

// ─── Type Extractors ────────────────────────────────────────────

/** Extract the SlackConversationRef from a ConversationTarget. Throws if not Slack. */
export function extractSlackRef(target: ConversationTarget): SlackConversationRef {
  if (target.platform !== 'slack') {
    throw new Error(`Expected Slack target, got ${target.platform}`);
  }
  return target.ref as SlackConversationRef;
}

/** Extract the SlackMessageRef from a MessageHandle. Throws if not Slack. */
export function extractSlackMessageRef(handle: MessageHandle): SlackMessageRef {
  if (handle.platform !== 'slack') {
    throw new Error(`Expected Slack message handle, got ${handle.platform}`);
  }
  return handle.ref as SlackMessageRef;
}
