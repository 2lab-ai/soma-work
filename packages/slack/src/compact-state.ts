/**
 * Compaction in-flight state predicates — shared by the message pipeline
 * (session-initializer concurrency control) and the compact hook helpers.
 *
 * Why this exists (compact re-loop bug, work-m64 dev 2026-07-08):
 *
 * The SDK CLI performs `/compact` as a long (2–3 min) turn that emits no
 * stream events while the summarization request is in flight. The compacted
 * transcript (summary entry + `compact_boundary`) is only flushed to disk a
 * few seconds AFTER the PostCompact hook fires. Any abort in that window —
 * e.g. a new user message displacing the "stalled-looking" request via
 * `RequestCoordinator.abortSession` — kills the CLI before the flush. The
 * session then resumes from the UNCOMPACTED transcript: context usage stays
 * at pre-compact levels (`now ~85% ← was ~85%`), the threshold re-trips, and
 * the session enters a compact→abort→compact loop that burns minutes per
 * cycle and never frees context.
 *
 * The fix has two halves:
 *   1. `postCompactCompleteIfNeeded` defers the pending-user re-dispatch to
 *      the /compact turn's stream end (see `compactPendingDispatches` on the
 *      session) instead of dispatching from inside the PostCompact hook.
 *   2. Session-initializer consults `shouldStashForCompaction` and refuses to
 *      abort an in-flight compaction — the incoming message is stashed via
 *      `stashUserMessageDuringCompaction` and replayed after the turn ends.
 */

export interface CompactDispatchPayload {
  ctx: { channel: string; threadTs: string; user: string; ts: string };
  text: string;
}

/**
 * Minimal structural view of the session fields this module reads/writes.
 * The pipeline's `ConversationSession` is an open record (`[key: string]:
 * any`), so this keeps the contract explicit without importing src/ types
 * (packages must not depend on src/).
 */
export interface CompactStateSession {
  compactEpoch?: number;
  compactPostedByEpoch?: Record<number, { pre: boolean; post: boolean }>;
  compactStartedAtMs?: number | null;
  /**
   * Runtime-only marker: true while a dedicated `/compact` SDK turn is
   * executing for this session (set when the local slash command query
   * starts, cleared in the stream-executor `finally`). Codex review F1:
   * the epoch marker alone is insufficient — PostCompact seals the cycle
   * (`marker.post=true`) several seconds BEFORE the CLI flushes the
   * compacted transcript and emits `result`. A message arriving in that
   * post-hook/pre-result window must still be stashed, not allowed to
   * abort the process.
   */
  compactTurnActive?: boolean;
  pendingUserText?: string | null;
  pendingEventContext?: { channel: string; threadTs: string; user: string; ts: string } | null;
  /**
   * Deferred post-compact re-dispatch queue, in arrival order. Multiple
   * entries occur when different users (or non-contiguous messages) arrive
   * during compaction — each keeps its OWN event context so replayed
   * messages are attributed to the correct author (codex review F4:
   * merging U2's text under U1's ctx corrupted permissions / working-dir /
   * initiator attribution downstream).
   */
  compactPendingDispatches?: CompactDispatchPayload[] | null;
}

/**
 * Safety ceiling: a compact cycle older than this is treated as dead so a
 * dropped END signal can never leave the session permanently un-abortable.
 * Matches `COMPACT_STARTING_TICKER_MAX_MS` in compact-hooks.
 */
export const COMPACTION_IN_PROGRESS_MAX_MS = 10 * 60 * 1000;

/**
 * True while a compaction cycle is open: a START signal (PreCompact hook or
 * `status === 'compacting'` fallback) has claimed the current epoch and no
 * END signal (PostCompact hook / `compact_boundary`) has sealed it yet.
 *
 * Time-bounded by `COMPACTION_IN_PROGRESS_MAX_MS` measured from
 * `compactStartedAtMs`; a missing start timestamp (Slack post failure still
 * sets it before posting, so this is defensive only) is treated as
 * not-in-progress rather than risking a stuck guard.
 */
export function isCompactionInProgress(session: CompactStateSession, nowMs: number = Date.now()): boolean {
  const epoch = session.compactEpoch ?? 0;
  const marker = session.compactPostedByEpoch?.[epoch];
  if (!marker || marker.pre !== true || marker.post === true) return false;
  const startedAt = session.compactStartedAtMs;
  if (typeof startedAt !== 'number') return false;
  return nowMs - startedAt <= COMPACTION_IN_PROGRESS_MAX_MS;
}

/**
 * Stash a user message that arrived while compaction is running so it can be
 * replayed after the /compact turn ends. Ordered, author-preserving merge:
 *
 *   - Same author as the last queued entry → append to that entry's text
 *     (one re-dispatch carries the contiguous burst).
 *   - Same author as the pre-compact pending message → append there.
 *   - Otherwise → push a NEW entry with its own event context, so the replay
 *     never attributes one user's text to another (codex review F4).
 */
export function stashUserMessageDuringCompaction(
  session: CompactStateSession,
  ctx: { channel: string; threadTs: string; user: string; ts: string },
  text: string,
): void {
  if (!text) return;
  const queue = (session.compactPendingDispatches ??= []);
  const last = queue[queue.length - 1];
  if (last && last.ctx.user === ctx.user) {
    last.text += `\n${text}`;
    return;
  }
  if (queue.length === 0 && session.pendingUserText && session.pendingEventContext?.user === ctx.user) {
    session.pendingUserText += `\n${text}`;
    return;
  }
  queue.push({ ctx, text });
}

/**
 * Move the pre-compact intercepted message (`pendingUserText` +
 * `pendingEventContext`) to the FRONT of the deferred-dispatch queue — it is
 * always the earliest message. Atomic consume: idempotent on a second END
 * signal (fields already nulled). Also the strand-rescue path (codex review
 * F3): the stream-executor calls this in `finally` for a /compact turn that
 * died without ANY END signal, so the intercepted message can never be
 * silently overwritten by the next auto-compact interception.
 */
export function promotePendingToDispatchQueue(session: CompactStateSession): void {
  if (!session.pendingUserText || !session.pendingEventContext) return;
  const payload: CompactDispatchPayload = {
    ctx: session.pendingEventContext,
    text: session.pendingUserText,
  };
  session.pendingUserText = null;
  session.pendingEventContext = null;
  const queue = (session.compactPendingDispatches ??= []);
  queue.unshift(payload);
}
