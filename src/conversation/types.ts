/**
 * Conversation history types for recording and viewing session dialogues.
 */

/**
 * A single turn in a conversation (user message or assistant response)
 */
export interface ConversationTurn {
  id: string;                   // Unique turn ID (uuid)
  role: 'user' | 'assistant';
  timestamp: number;            // Unix ms

  // User turn fields
  userName?: string;            // Slack display name
  userId?: string;              // Slack user ID

  // Content
  rawContent: string;           // Full raw content

  // Assistant turn fields (populated for role === 'assistant')
  summaryTitle?: string;        // 1-line title from SUMMARY_MODEL
  summaryBody?: string;         // 3-line summary from SUMMARY_MODEL
  summarized?: boolean;         // Whether summary has been generated
}

/**
 * A recorded conversation (one per session/thread)
 */
export interface ConversationRecord {
  id: string;                   // Unique conversation ID (uuid)
  channelId: string;            // Slack channel
  threadTs: string;             // Slack thread timestamp
  ownerId: string;              // Session owner user ID
  ownerName: string;            // Session owner display name
  title?: string;               // Session title (from dispatch)
  workflow?: string;            // Workflow type
  createdAt: number;            // Unix ms
  updatedAt: number;            // Unix ms
  turns: ConversationTurn[];    // Ordered list of turns
}

/**
 * Lightweight conversation metadata (for list view)
 */
export interface ConversationMeta {
  id: string;
  ownerName: string;
  title?: string;
  workflow?: string;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
}
