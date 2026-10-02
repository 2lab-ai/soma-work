/**
 * Slack API failure classification — the single source for "what did Slack do
 * with this request?". Moved out of `thread-surface.ts` (which now imports it)
 * so other delivery paths (polls) reuse the same evidence rules instead of
 * keeping a second, drifting list.
 *
 * Evidence rule: only an explicit Slack API code in `data.error` says anything
 * about Slack's side. Transport fields (`err.code` = ETIMEDOUT/ECONNRESET)
 * describe the socket, not the request, and are never consulted; codes are
 * matched exactly, never by substring.
 */

/**
 * Codes that PROVE nothing was created, so a delivery intent may be released
 * for a retry without risking a duplicate.
 *
 * Deliberately a tiny allow-list of explicit API codes. Anything absent —
 * `ratelimited`, a 5xx, a socket timeout, an unrecognised string — means
 * "unknown outcome", because the alternative failure mode is a duplicate card
 * that nothing can clean up.
 *
 * `queue_overflow` is the one non-Slack code here and it is the strongest
 * evidence of the set: the api helper drops the request from its OWN rate-limit
 * queue before `execute()` runs, so no HTTP request was ever made.
 */
export const DEFINITIVE_POST_REJECTIONS: ReadonlySet<string> = new Set([
  'channel_not_found',
  'not_in_channel',
  'invalid_auth',
  'invalid_blocks',
  'invalid_arguments',
  'queue_overflow',
]);

function slackErrorCode(error: unknown): string | undefined {
  const code = (error as { data?: { error?: unknown } } | undefined)?.data?.error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The Slack error code when it PROVES nothing was created, else `undefined`.
 */
export function definitiveRejectionCode(error: unknown): string | undefined {
  const code = slackErrorCode(error);
  return code !== undefined && DEFINITIVE_POST_REJECTIONS.has(code) ? code : undefined;
}

/**
 * Codes after which retrying the same call can never succeed: the message or
 * channel is gone, the bot may not touch it, or the payload itself is too big
 * (`msg_too_long` — the same text is rejected every time).
 */
const PERMANENT_UPDATE_FAILURES: ReadonlySet<string> = new Set([
  'message_not_found',
  'cant_update_message',
  'is_archived',
  'thread_not_found',
  'msg_too_long',
]);

/** Definitively not sent, but a later retry can succeed. */
const TRANSIENT_DEFINITIVE: ReadonlySet<string> = new Set(['queue_overflow', 'ratelimited']);

export type SlackDeliveryErrorClass =
  | { kind: 'permanent'; code: string }
  | { kind: 'transient'; code: string }
  | { kind: 'unknown'; code?: string };

/**
 * Answers a different question than {@link definitiveRejectionCode}: not "was
 * anything created?" but "can a retry ever succeed?".
 *
 * - `permanent` — retrying is pointless (definitive rejections other than
 *   `queue_overflow`, plus update-path codes such as a deleted message).
 * - `transient` — nothing was sent and a retry may succeed (`queue_overflow`,
 *   `ratelimited`).
 * - `unknown` — no recognised Slack code; the request may have landed, so a
 *   repost must first check whether it already exists.
 */
export function classifySlackDeliveryError(error: unknown): SlackDeliveryErrorClass {
  const code = slackErrorCode(error);
  if (code === undefined) return { kind: 'unknown' };
  if (TRANSIENT_DEFINITIVE.has(code)) return { kind: 'transient', code };
  if (DEFINITIVE_POST_REJECTIONS.has(code) || PERMANENT_UPDATE_FAILURES.has(code)) return { kind: 'permanent', code };
  return { kind: 'unknown', code };
}
