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
 *      the /compact turn's stream end (see `compactPendingDispatch` on the
 *      session) instead of dispatching from inside the PostCompact hook.
 *   2. Session-initializer consults `isCompactionInProgress` and refuses to
 *      abort an in-flight compaction — the incoming message is stashed via
 *      `stashUserMessageDuringCompaction` and replayed after the boundary.
 */

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
  pendingUserText?: string | null;
  pendingEventContext?: { channel: string; threadTs: string; user: string; ts: string } | null;
  compactPendingDispatch?: {
    ctx: { channel: string; threadTs: string; user: string; ts: string };
    text: string;
  } | null;
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
 * replayed after the compact cycle seals. Ordered merge rules:
 *
 *   - A deferred dispatch already exists (`compactPendingDispatch`, i.e. the
 *     cycle sealed but the /compact turn's stream hasn't ended yet) → append
 *     to its text so one re-dispatch carries both messages in arrival order.
 *   - A pre-compact pending message exists (`pendingUserText`) → append.
 *   - Nothing stashed yet → become the pending message (context captured for
 *     the synthetic re-dispatch).
 */
export function stashUserMessageDuringCompaction(
  session: CompactStateSession,
  ctx: { channel: string; threadTs: string; user: string; ts: string },
  text: string,
): void {
  if (!text) return;
  if (session.compactPendingDispatch) {
    session.compactPendingDispatch.text += `\n${text}`;
    return;
  }
  if (session.pendingUserText) {
    session.pendingUserText += `\n${text}`;
    return;
  }
  session.pendingUserText = text;
  session.pendingEventContext = ctx;
}
