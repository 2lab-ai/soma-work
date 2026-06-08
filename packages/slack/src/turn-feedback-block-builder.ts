/**
 * Builders for the turn-completion feedback affordance — a Slack
 * `context_actions` block carrying a `feedback_buttons` element (👍/👎).
 *
 * This is the agent-workflow modernization surface from issue #1064 / spec
 * `docs/current/spec/14-turn-surface-output.md`. Newer interactive blocks are
 * NOT reliably supported inside legacy message attachments, so the caller posts
 * these as TOP-LEVEL message blocks (codex c411a78a).
 */

/** Stable, versioned action_ids. Collision-checked against all existing prefixes. */
export const TURN_FEEDBACK_ACTION_ID = 'turn_feedback_v1';
export const TURN_DISMISS_ACTION_ID = 'turn_dismiss_v1';

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

const DISMISS_SEP = '\u0000';

/**
 * Encode `(turnId, ownerUserId)` into the dismiss `icon_button` value. The owner
 * is carried so the click handler can server-side verify the actor (defence in
 * depth on top of `visible_to_user_ids`). NUL separates — it can't appear in a
 * Slack id or the `sessionKey:ts:uuid` turnId.
 */
export function encodeDismissValue(turnId: string, ownerUserId: string): string {
  const raw = `${turnId}${DISMISS_SEP}${ownerUserId}`;
  return raw.length > MAX_BUTTON_VALUE ? raw.slice(0, MAX_BUTTON_VALUE) : raw;
}

/** Parse the dismiss value back into `(turnId, ownerUserId)`. Null when malformed. */
export function parseDismissValue(value: string | undefined): { turnId: string; ownerUserId: string } | null {
  if (!value) return null;
  const sep = value.indexOf(DISMISS_SEP);
  if (sep <= 0) return null;
  const turnId = value.slice(0, sep);
  const ownerUserId = value.slice(sep + 1);
  if (!turnId || !ownerUserId) return null;
  return { turnId, ownerUserId };
}

/** The 🗑 `icon_button` element that dismisses (deletes) the completion card. */
function dismissIconButton(turnId: string, ownerUserId: string): Record<string, unknown> {
  return {
    type: 'icon_button',
    action_id: TURN_DISMISS_ACTION_ID,
    icon: 'trash',
    value: encodeDismissValue(turnId, ownerUserId),
    accessibility_label: 'Dismiss this completion card',
    // Only the turn owner sees the trash affordance.
    visible_to_user_ids: [ownerUserId],
  };
}

/**
 * Build the `context_actions` block for a completed turn: a 👍/👎
 * `feedback_buttons` element plus a 🗑 `icon_button` (owner-only) that dismisses
 * the card. `turnId` is encoded into each element value so the handlers can act
 * without a side lookup. Two elements — well within the 5-element cap.
 */
export function buildFeedbackContextActions(turnId: string, ownerUserId: string): Record<string, unknown> {
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
      dismissIconButton(turnId, ownerUserId),
    ],
  };
}

/**
 * After a feedback click, rebuild the `context_actions` row to drop the
 * `feedback_buttons` (it's been answered) while KEEPING any `icon_button`
 * elements (e.g. the dismiss trash) so the user can still dismiss the card.
 * Returns the trimmed block, or `null` when nothing interactive remains (so the
 * caller can omit the block entirely).
 */
export function keepIconButtonsOnly(block: any): Record<string, unknown> | null {
  if (!block || block.type !== 'context_actions' || !Array.isArray(block.elements)) return null;
  const icons = block.elements.filter((e: any) => e?.type === 'icon_button');
  if (icons.length === 0) return null;
  return { type: 'context_actions', elements: icons };
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
