/**
 * Native button poll — persisted record shape.
 *
 * A poll is posted as a bot-owned card in a thread. Any user votes with the
 * option buttons (last click per user wins); the creator can close early or
 * cancel. At `closesAt` (or on close) the card is rewritten into the roster
 * and a thread notice mentions every voter.
 *
 * Only fully created polls are persisted: the record is written once, AFTER
 * the card was posted, so there is never a half-created (`messageTs`-less)
 * record that could lock a thread.
 */

export type PollStatus = 'open' | 'closed' | 'canceled';

/**
 * Delivery of the frozen result to Slack, tracked separately from the domain
 * status: the domain transition (open → closed/canceled) happens exactly once,
 * delivery is retried until it lands or hits a permanent Slack error.
 */
export interface PollDelivery {
  /** The card was rewritten into its terminal (result / canceled) form. */
  cardDone: boolean;
  /** Permanent Slack error for the card update (e.g. card deleted) — card stops, notices continue. */
  cardError?: string;
  /** Number of roster notice parts posted (closed polls only); retries resume from here. */
  noticesDone: number;
  /** All roster notice parts posted (always true for canceled polls). */
  noticeDone: boolean;
  /** Permanent Slack error for the notices — notices stop, card is unaffected. */
  noticeError?: string;
  /** Consecutive transient failures, drives the backoff. */
  attempts: number;
  /** Epoch ms before which the scheduler must not retry. */
  nextAttemptAt: number;
  /**
   * Epoch ms after which transient retries stop (closedAt + 24h at close;
   * `min(resumeAt + 24h, closedAt + 7d)` after a restart resume).
   */
  retryUntil: number;
  /**
   * Index of a notice part whose post failed with an UNKNOWN outcome (it may
   * have landed). The next attempt first looks for that part's marker in the
   * thread instead of blindly reposting it.
   */
  noticeUnknownPart?: number;
  /**
   * Set when transient retries gave up (24h after close). Persisted, not just
   * logged: the frozen result stays intact and `resumeExpiredDeliveries()`
   * (run at scheduler start, i.e. on bot restart) resumes the unfinished parts
   * without reopening the poll.
   */
  expiredAt?: number;
}

export interface PollRecord {
  id: string;
  /** Tool invocation (tool_use id) that created the poll — applied once. */
  invocationId?: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  /** The user whose turn created the poll (never the session owner by default). */
  creatorId: string;
  title: string;
  options: string[];
  /** userId → option index. One vote per user. */
  votes: Record<string, number>;
  /** userId → Slack `action_ts` of the latest accepted click (ordering clock). */
  voteActionTs: Record<string, string>;
  /** Epoch ms. */
  closesAt: number;
  status: PollStatus;
  createdAt: number;
  closedAt?: number;
  delivery?: PollDelivery;
}

export interface PollStoreFile {
  version: 1;
  polls: Record<string, PollRecord>;
}
