/**
 * Conversation history types for recording and viewing session dialogues.
 */

import type { TurnAttachment } from '@soma/slack/user-media';

/**
 * Who put a user-role turn into the conversation (dashboard SSOT 2026-10-27 T1).
 * `system`: soma-work injected it — a synthetic event (restart resume, error
 * retry, goal continuation, cron), a host continuation (renew/load, handoff,
 * emergency compact) or the threshold auto-compact that swapped the user's
 * message for `/compact`. `user`: a person sent it. Absent on turns recorded
 * before the field existed: the dashboard then reads the text alone.
 */
export interface TurnOrigin {
  by: 'user' | 'system';
}

/**
 * A `/compact` turn's compaction (dashboard SSOT 2026-10-27 T2): how long it
 * was expected to take when it started, and what the SDK reported when it
 * ended. `endedAt` is absent while it runs and when it never finished.
 */
export interface TurnCompaction {
  /** The conversation's previous compaction duration — absent when there was none. */
  estimateMs?: number;
  endedAt?: number;
  durationMs?: number;
  preTokens?: number;
  postTokens?: number;
  trigger?: 'manual' | 'auto';
}

/**
 * A single turn in a conversation (user message or assistant response)
 */
export interface ConversationTurn {
  id: string; // Unique turn ID (uuid)
  role: 'user' | 'assistant';
  timestamp: number; // Unix ms

  // User turn fields
  userName?: string; // Slack display name
  userId?: string; // Slack user ID

  // Content
  rawContent: string; // Full raw content
  /**
   * User turn: the files the user attached to this instruction (user media,
   * SSOT 2026-10-25). The turn is their index; the bytes live in
   * `src/conversation/user-media.ts`. Absent when none.
   */
  attachments?: TurnAttachment[];
  /** User turn: who sent it (absent on older turns). */
  origin?: TurnOrigin;
  /** User turn that is a `/compact`: its compaction. */
  compact?: TurnCompaction;
  /**
   * User turn: the SDK cut point just before it (#743, `@soma/slack/context-anchor`).
   * "Roll back to just before this input" resumes the next turn there.
   */
  anchor?: string;

  // Assistant turn fields (populated for role === 'assistant')
  summaryTitle?: string; // 1-line title from SUMMARY_MODEL
  summaryBody?: string; // 3-line summary from SUMMARY_MODEL
  summarized?: boolean; // Whether summary has been generated
}

/**
 * A recorded conversation (one per session/thread)
 */
export interface ConversationRecord {
  id: string; // Unique conversation ID (uuid)
  channelId: string; // Slack channel
  threadTs: string; // Slack thread timestamp
  ownerId: string; // Session owner user ID
  ownerName: string; // Session owner display name
  title?: string; // Session title (from dispatch)
  titleSub?: string; // Subordinate model (codex) generated title
  workflow?: string; // Workflow type
  createdAt: number; // Unix ms
  updatedAt: number; // Unix ms
  turns: ConversationTurn[]; // Ordered list of turns
}

/**
 * Lightweight conversation metadata (for list view)
 */
export interface ConversationMeta {
  id: string;
  ownerName: string;
  title?: string;
  titleSub?: string;
  workflow?: string;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
}
