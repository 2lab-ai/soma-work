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

/**
 * A32 — `block_id` prefix marking a feedback row that is hosted ON the streamed
 * answer message (appended by `chat.stopStream`) rather than on its own
 * completion card. The click handler keys the ack strategy off this marker: a
 * `chat.update` against the stream host would overwrite the user's answer, so
 * a marked row acks with an ephemeral `respond()` instead.
 */
export const TURN_FEEDBACK_BLOCK_ID_PREFIX = 'turn_feedback_v1:';

/** Slack limits (docs.slack.dev): button text ≤75, value ≤2000, ≤5 context_actions elements. */
const MAX_BUTTON_TEXT = 75;
const MAX_BUTTON_VALUE = 2000;
/** Slack limit (docs.slack.dev): `block_id` ≤255 chars. */
const MAX_BLOCK_ID = 255;

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

/**
 * The 🗑 `icon_button` element that dismisses (deletes) the completion card.
 *
 * `text` is REQUIRED by the Slack API (plain_text label). Omitting it makes
 * chat.postMessage reject the ENTIRE message with
 * `invalid_blocks: missing required field: text [json-pointer:/blocks/N/elements/1]`
 * — which silently killed every WorkflowComplete terminal card since #1067
 * (the failure was only logged as a WARN in SlackBlockKitChannel.send).
 */
function dismissIconButton(turnId: string, ownerUserId: string): Record<string, unknown> {
  return {
    type: 'icon_button',
    action_id: TURN_DISMISS_ACTION_ID,
    icon: 'trash',
    text: { type: 'plain_text', text: clampText('닫기') },
    value: encodeDismissValue(turnId, ownerUserId),
    accessibility_label: 'Dismiss this completion card',
    // Only the turn owner sees the trash affordance.
    visible_to_user_ids: [ownerUserId],
  };
}

/** `block_id` for a stream-hosted feedback row. Clamped to Slack's 255 chars. */
export function buildFeedbackBlockId(turnId: string): string {
  const raw = `${TURN_FEEDBACK_BLOCK_ID_PREFIX}${turnId}`;
  return raw.length > MAX_BLOCK_ID ? raw.slice(0, MAX_BLOCK_ID) : raw;
}

/** True when a `block_id` marks a feedback row hosted on a streamed message. */
export function isStreamHostedFeedbackBlockId(blockId: unknown): boolean {
  return typeof blockId === 'string' && blockId.startsWith(TURN_FEEDBACK_BLOCK_ID_PREFIX);
}

export interface FeedbackContextActionsOptions {
  /**
   * Include the 🗑 dismiss `icon_button`. Default true (own completion card).
   * MUST be false on the consolidated surface: the host message IS the user's
   * answer, and "답변 보존 방식" forbids an affordance that deletes it.
   */
  includeDismiss?: boolean;
  /**
   * Stamp {@link buildFeedbackBlockId} so the click handler can tell this row
   * lives on the streamed answer (ack via ephemeral respond, never
   * `chat.update`). Default false — legacy cards stay byte-identical.
   */
  streamHosted?: boolean;
}

/**
 * Build the `context_actions` block for a completed turn: a 👍/👎
 * `feedback_buttons` element plus (by default) a 🗑 `icon_button` (owner-only)
 * that dismisses the card. `turnId` is encoded into each element value so the
 * handlers can act without a side lookup. ≤2 elements — well within the
 * 5-element cap.
 */
export function buildFeedbackContextActions(
  turnId: string,
  ownerUserId: string,
  options: FeedbackContextActionsOptions = {},
): Record<string, unknown> {
  const { includeDismiss = true, streamHosted = false } = options;
  return {
    type: 'context_actions',
    ...(streamHosted ? { block_id: buildFeedbackBlockId(turnId) } : {}),
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
      ...(includeDismiss ? [dismissIconButton(turnId, ownerUserId)] : []),
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
