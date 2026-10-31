/**
 * The Slack surface a task turn hands to the compaction helpers (#598 ④b2).
 *
 * The compaction "starting / complete" posts and the auto-compact threshold
 * announcement are thread posts; a Slack-less task has no thread. Those
 * helpers also do the bookkeeping a task needs (the pending-compact flag, the
 * compaction numbers, their work-log notices), so instead of skipping them the
 * task executor gives them this surface: the two methods they post through
 * resolve with no message, and nothing reaches Slack. Any other method is not
 * provided — a helper that starts calling one fails loudly in tests.
 */
import type { SlackApiHelper } from '../slack-api-helper';

export const NO_POST_SLACK = {
  postSystemMessage: async () => ({}),
  updateMessage: async () => undefined,
} as unknown as SlackApiHelper;
