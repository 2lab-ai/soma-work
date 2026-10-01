/**
 * Does this `result` frame answer the turn the host opened? (#257)
 *
 * A streaming-input `query()` can emit a `result` that belongs to no message
 * the host sent. Measured with SDK 0.3.284: resuming a session whose previous
 * CLI exited with background agents still running first drains a "previous
 * session's background agents stopped" task-notification, and the CLI closes
 * that drain with its own `result` (`subtype:'success'`, `num_turns: 0`, no
 * `user_message_uuid`) BEFORE it reads the host's prompt. A host that ends the
 * turn on the first `result` closes the input channel and stops consuming
 * there — the prompt is recorded, never answered.
 *
 * The join key is the uuid the host stamps on the turn's opening message: the
 * CLI echoes it as the result's `user_message_uuid` (the send that STARTED the
 * turn). `num_turns` is no signature either way — an opening `/compact` reports
 * 0 but echoes the opening uuid, and a drained `completed` notification can
 * make the model run a turn of its own (`num_turns >= 1`) that echoes nothing.
 * Since the host ALWAYS stamps the opening uuid and the CLI echoes it on the
 * result that answers it (measured, `/compact` included), a result without the
 * echo answers something else and never ends the turn.
 *
 * Pure and duck-typed on the raw frame, like `isHealthyTurnResult` in
 * `claude-handler.ts`: it reads whatever actually arrived rather than trusting
 * a declared shape.
 */

/** The verdict plus the branch that produced it (for the skip log). */
export interface TurnResultAttribution {
  /** `true` → this result ends the turn; `false` → it answers something else. */
  terminal: boolean;
  reason: string;
}

/**
 * Classify a raw `result` frame against this turn's sends. In this order:
 *   1. not a clean success (`subtype !== 'success'` or `is_error`) → terminal:
 *      an error always ends the turn, attributed or not.
 *   2. echoes the opening uuid → terminal.
 *   3. echoes a uuid pushed into this turn → terminal (defensive — a steered
 *      send that started a turn of its own is still this turn's business).
 *   4. anything else → NOT terminal: no uuid (whatever `num_turns` says — an
 *      orphan drain or a notification-driven turn) or a foreign uuid. The
 *      handler skips it and bounds the silence after it.
 */
export function classifyTurnResult(
  raw: Record<string, unknown>,
  openingUuid: string,
  pushedUuids: readonly string[],
): TurnResultAttribution {
  if (raw.subtype !== 'success' || raw.is_error === true) {
    return { terminal: true, reason: 'error-result' };
  }
  const echoed = raw.user_message_uuid;
  if (echoed === openingUuid) {
    return { terminal: true, reason: 'opening-uuid' };
  }
  if (typeof echoed === 'string' && pushedUuids.includes(echoed)) {
    return { terminal: true, reason: 'pushed-uuid' };
  }
  const hasEcho = typeof echoed === 'string' && echoed.length > 0;
  return { terminal: false, reason: hasEcho ? 'foreign-uuid' : 'no-uuid' };
}
