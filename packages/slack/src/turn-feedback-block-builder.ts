/**
 * Builders for the turn-completion feedback affordance — a Slack
 * `context_actions` block carrying a `feedback_buttons` element (👍/👎).
 *
 * This is the agent-workflow modernization surface from issue #1064 / spec
 * `docs/current/spec/14-turn-surface-output.md`. Newer interactive blocks are
 * NOT reliably supported inside legacy message attachments, so the caller posts
 * these as TOP-LEVEL message blocks (codex c411a78a).
 */

/** Stable, versioned action_id. Collision-checked against all existing prefixes. */
export const TURN_FEEDBACK_ACTION_ID = 'turn_feedback_v1';

/** Slack limits (docs.slack.dev): button text ≤75, value ≤2000, ≤5 context_actions elements. */
const MAX_BUTTON_TEXT = 75;
const MAX_BUTTON_VALUE = 2000;

export type FeedbackSentiment = 'positive' | 'negative';

/**
 * Encode `(sentiment, turnId)` into a button `value`. The block_actions payload
 * delivers the clicked button's `value`, so this is how the handler learns both
 * the sentiment and which turn it applies to without a side lookup.
 *
 * Format: `up:<turnId>` / `down:<turnId>`. turnId is `sessionKey:ts:uuid`
 * (well under 2000 chars); we still guard the cap defensively.
 */
export function encodeFeedbackValue(sentiment: FeedbackSentiment, turnId: string): string {
  const prefix = sentiment === 'positive' ? 'up' : 'down';
  const raw = `${prefix}:${turnId}`;
  return raw.length > MAX_BUTTON_VALUE ? raw.slice(0, MAX_BUTTON_VALUE) : raw;
}

/** Parse a button `value` back into `(sentiment, turnId)`. Returns null when malformed. */
export function parseFeedbackValue(value: string | undefined): { sentiment: FeedbackSentiment; turnId: string } | null {
  if (!value) return null;
  const sep = value.indexOf(':');
  if (sep <= 0) return null;
  const tag = value.slice(0, sep);
  const turnId = value.slice(sep + 1);
  if (!turnId) return null;
  if (tag === 'up') return { sentiment: 'positive', turnId };
  if (tag === 'down') return { sentiment: 'negative', turnId };
  return null;
}

function clampText(text: string): string {
  return text.length > MAX_BUTTON_TEXT ? text.slice(0, MAX_BUTTON_TEXT) : text;
}

/**
 * Build the `context_actions` block with a 👍/👎 `feedback_buttons` element for
 * a completed turn. Encodes `turnId` into each button value so the action
 * handler can persist feedback against the turn.
 */
export function buildFeedbackContextActions(turnId: string): Record<string, unknown> {
  return {
    type: 'context_actions',
    elements: [
      {
        type: 'feedback_buttons',
        action_id: TURN_FEEDBACK_ACTION_ID,
        positive_button: {
          text: { type: 'plain_text', text: clampText('👍 도움됨') },
          value: encodeFeedbackValue('positive', turnId),
          accessibility_label: 'Mark this response as helpful',
        },
        negative_button: {
          text: { type: 'plain_text', text: clampText('👎 아쉬움') },
          value: encodeFeedbackValue('negative', turnId),
          accessibility_label: 'Mark this response as not helpful',
        },
      },
    ],
  };
}

/**
 * Build the acknowledgment block that REPLACES the feedback buttons after a
 * click. A plain `context` block (no interactive element) sidesteps stale
 * `block_id` reuse on `chat.update` entirely.
 */
export function buildFeedbackAckBlock(sentiment: FeedbackSentiment): Record<string, unknown> {
  const emoji = sentiment === 'positive' ? '👍' : '👎';
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `🙏 피드백 감사합니다 — ${emoji}` }],
  };
}
