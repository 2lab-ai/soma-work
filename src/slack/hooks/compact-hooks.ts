/**
 * Compaction Tracking (#617) — SDK hook callbacks for PreCompact / PostCompact /
 * SessionStart(source=compact).
 *
 * These callbacks post human-readable thread messages that announce compaction
 * start/end (AC4/AC5), rebuild the preservation context after a successful
 * compaction (AC6), and re-dispatch any user message that was captured by
 * the auto-compact interception path (AC3 end-to-end).
 *
 * Epoch-based idempotency:
 *
 *   START signals (PreCompact hook, or the `status === 'compacting'` stream
 *   fallback used by stream-executor.ts:777) call `beginCompactionCycleIfNeeded`,
 *   which bumps `session.compactEpoch` iff the previous cycle is either absent
 *   or closed (marker.post === true). Within an open cycle it is a no-op.
 *
 *   END signals (PostCompact hook, and the `onCompactBoundary` stream
 *   callback) call `getCurrentEpochForEnd`, which NEVER bumps — it only
 *   initializes the very first cycle when no START signal was ever seen
 *   (dropped-START guard). This prevents double-bump when `compact_boundary`
 *   arrives before the PreCompact hook fires.
 *
 * Whichever of {PreCompact, compacting-status} fires first posts the
 * "starting" message and flips `marker.pre=true`; the other is skipped. Same
 * logic applies to {PostCompact, compact_boundary} with `marker.post`.
 */

import type {
  HookInput,
  HookJSONOutput,
  PostCompactHookInput,
  PreCompactHookInput,
  SessionStartHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '../../logger';
import { resolveContextWindow } from '../../metrics/model-registry';
import { buildCompactionContext, snapshotFromSession } from '../../session/compaction-context-builder';
import type { ConversationSession } from '../../types';
import type { EventRouter } from '../event-router';
import type { SlackApiHelper } from '../slack-api-helper';

const logger = new Logger('CompactHooks');

/**
 * START-signal epoch helper. Bumps the session's `compactEpoch` iff no cycle
 * is currently open (previous is closed or absent). Idempotent when called
 * twice inside the same cycle (PreCompact hook + compacting-status fallback).
 *
 * When the epoch actually bumps we also wipe the boundary-populated metadata
 * fields (`compactPreTokens/PostTokens/Trigger/DurationMs`). These are set by
 * `onCompactBoundary` (stream-executor.ts:831-834) and read by
 * `hasBoundaryMetadata()` + `buildCompactCompleteMessage()`. Without the reset,
 * cycle N+1 inherits cycle N's values: `hasBoundaryMetadata` returns true
 * immediately, skipping the 500ms grace window in `postCompactCompleteIfNeeded`,
 * and the completion message renders cycle N's pre/post tokens on cycle N+1's
 * announcement (see docs/issues/compact-bugs-trace — stale-metadata P1).
 *
 * Returns the current epoch — callers store per-cycle dedupe state under
 * `session.compactPostedByEpoch[epoch]`.
 */
export function beginCompactionCycleIfNeeded(session: ConversationSession): number {
  const map = ensurePostedMap(session);
  const epoch = session.compactEpoch ?? 0;
  const marker = map[epoch];
  if (!marker || marker.post === true) {
    const nextEpoch = epoch + 1;
    session.compactEpoch = nextEpoch;
    map[nextEpoch] = { pre: false, post: false };
    // Clear prior cycle's boundary metadata so the new cycle starts clean.
    session.compactPreTokens = null;
    session.compactPostTokens = null;
    session.compactTrigger = null;
    session.compactDurationMs = null;
    return nextEpoch;
  }
  return epoch;
}

/**
 * END-signal epoch helper. Never starts a second cycle. If no cycle is open
 * (marker absent) this means the SDK dropped the START signal — we initialize
 * one cycle for this END signal only and log a warning. Semantic contract per
 * plan §3.
 */
export function getCurrentEpochForEnd(session: ConversationSession): number {
  const map = ensurePostedMap(session);
  const epoch = session.compactEpoch ?? 0;
  const marker = map[epoch];
  if (!marker) {
    const nextEpoch = epoch + 1;
    session.compactEpoch = nextEpoch;
    map[nextEpoch] = { pre: false, post: false };
    logger.warn('compact-hooks: END signal dropped (no START for new cycle)', {
      sessionId: session.sessionId,
      channelId: session.channelId,
      epoch: nextEpoch,
    });
    return nextEpoch;
  }
  return epoch;
}

function ensurePostedMap(session: ConversationSession): Record<number, { pre: boolean; post: boolean }> {
  if (!session.compactPostedByEpoch) session.compactPostedByEpoch = {};
  return session.compactPostedByEpoch;
}

function ensureRehydratedMap(session: ConversationSession): Record<number, boolean> {
  if (!session.compactionRehydratedByEpoch) session.compactionRehydratedByEpoch = {};
  return session.compactionRehydratedByEpoch;
}

export interface CompactHookDeps {
  session: ConversationSession;
  channel: string;
  threadTs: string;
  slackApi: SlackApiHelper;
  /**
   * Optional — used only by the PostCompact path to re-dispatch a captured
   * user message (AC3 end-to-end). Omitted in tests that only need PreCompact
   * / PostCompact slackPost behaviour.
   */
  eventRouter?: EventRouter;
}

export interface CompactHookSet {
  PreCompact: (input: HookInput) => Promise<HookJSONOutput>;
  PostCompact: (input: HookInput) => Promise<HookJSONOutput>;
  SessionStart: (input: HookInput) => Promise<HookJSONOutput>;
}

/**
 * Build the 3-hook set for the current query. Hooks close over the Slack
 * routing context so they don't need to look up the session from the
 * hook payload's `session_id` (there is no index for that in our registry).
 *
 * The same `ConversationSession` reference is mutated across hook calls —
 * dedupe state lives on the session so multiple paths (PreCompact hook,
 * `compacting` fallback, `compact_boundary` stream callback, PostCompact hook)
 * see a consistent cycle view.
 */
export function buildCompactHooks(deps: CompactHookDeps): CompactHookSet {
  return {
    PreCompact: async (input: HookInput): Promise<HookJSONOutput> => {
      const payload = input as PreCompactHookInput;
      try {
        await handlePreCompact(deps, payload);
      } catch (err) {
        logger.error('PreCompact hook failed', {
          error: (err as Error)?.message ?? String(err),
        });
      }
      return { continue: true };
    },

    PostCompact: async (input: HookInput): Promise<HookJSONOutput> => {
      const payload = input as PostCompactHookInput;
      try {
        await handlePostCompact(deps, payload);
      } catch (err) {
        logger.error('PostCompact hook failed', {
          error: (err as Error)?.message ?? String(err),
        });
      }
      return { continue: true };
    },

    SessionStart: async (input: HookInput): Promise<HookJSONOutput> => {
      const payload = input as SessionStartHookInput;
      try {
        await handleSessionStart(deps, payload);
      } catch (err) {
        logger.error('SessionStart hook failed', {
          error: (err as Error)?.message ?? String(err),
        });
      }
      return { continue: true };
    },
  };
}

/** Format a nullable usage% for the "was ~X% → now ~Y%" messages. */
function fmtPct(pct: number | null | undefined): string {
  return pct === null || pct === undefined ? '?' : String(pct);
}

/**
 * Compact token formatter: `35k`, `1.2M`, `500`. Returns `?` when missing.
 * Used inside the "Context: now X% (Nk/Wk)" summary line — full-precision
 * thousands-separator counts are too noisy for a 1-line status.
 */
function fmtTokensCompact(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return '?';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Format ms → `1.2s` / `120ms`. Returns null when unset so callers can omit. */
function fmtDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/**
 * Format elapsed seconds for the live "starting" message. Matches the
 * MCP-status convention (`Xs` / `Xm Ys`). Input is wall-clock ms.
 */
function fmtElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Decide which trigger string to show on the live "starting" message. The
 * PreCompact hook provides the real `'manual'|'auto'` value; the
 * `onStatusUpdate('compacting')` fallback passes `'unknown (fallback)'` —
 * that's noise the user complained about, so we drop it from the rendered
 * line. If the SDK later populates `session.compactTrigger` via
 * `onCompactBoundary`, ticking picks it up.
 *
 * Returns `null` when we genuinely don't know the trigger — callers omit the
 * `· trigger=…` suffix rather than print a lie.
 */
function resolveStartingTrigger(session: ConversationSession, initialTrigger: string): 'manual' | 'auto' | null {
  if (session.compactTrigger === 'manual' || session.compactTrigger === 'auto') return session.compactTrigger;
  if (initialTrigger === 'manual' || initialTrigger === 'auto') return initialTrigger;
  return null;
}

/**
 * Build the live "Compaction starting" thread message. Shape:
 *   ⏳ 🗜️ Compaction starting · trigger=auto           (initial post, no elapsed yet)
 *   ⏳ 🗜️ Compaction starting · trigger=auto — 5s      (ticker update)
 *   ⏳ 🗜️ Compaction starting                           (no known trigger, fallback path)
 */
export function buildCompactStartingMessage(opts: { trigger: 'manual' | 'auto' | null; elapsedMs?: number }): string {
  const parts: string[] = ['⏳ 🗜️ Compaction starting'];
  if (opts.trigger) parts.push(`trigger=${opts.trigger}`);
  let text = parts.join(' · ');
  if (typeof opts.elapsedMs === 'number' && opts.elapsedMs > 0) {
    text += ` — ${fmtElapsed(opts.elapsedMs)}`;
  }
  return text;
}

/**
 * Build the "Compaction completed" thread message. Now a 2-line block that
 * captures every SDK-reported field plus the full context-window snapshot the
 * user asked for (#617 followup v2).
 *
 * Line 1: `🟢 🗜️ Compaction completed · trigger=auto (5.2s)`
 * Line 2: `Context: now 16% (35k/200k) ← was 80% (160k/200k) · compaction #3`
 *
 * Trigger/duration/compaction-count segments are omitted when the
 * corresponding field is absent — the message never prints a lie about
 * unknown data. If nothing is known at all (no pre/post tokens and no pct
 * snapshot), line 2 falls back to `Context: now ~?% ← was ~?%`.
 */
export function buildCompactCompleteMessage(session: ConversationSession): string {
  const headerParts: string[] = ['🟢 🗜️ Compaction completed'];
  if (session.compactTrigger) headerParts.push(`trigger=${session.compactTrigger}`);
  let header = headerParts.join(' · ');
  const dur = fmtDuration(session.compactDurationMs);
  if (dur) header += ` (${dur})`;

  const contextWindow = resolveContextWindow(session.model);
  const windowLabel = fmtTokensCompact(contextWindow);

  const hasPreTokens = typeof session.compactPreTokens === 'number';
  const hasPostTokens = typeof session.compactPostTokens === 'number';

  const nowSeg =
    hasPostTokens && contextWindow > 0
      ? `now ${fmtPct(session.lastKnownUsagePct)}% (${fmtTokensCompact(session.compactPostTokens)}/${windowLabel})`
      : `now ~${fmtPct(session.lastKnownUsagePct)}%`;
  const wasSeg =
    hasPreTokens && contextWindow > 0
      ? `was ${fmtPct(session.preCompactUsagePct)}% (${fmtTokensCompact(session.compactPreTokens)}/${windowLabel})`
      : `was ~${fmtPct(session.preCompactUsagePct)}%`;

  const contextParts = [`Context: ${nowSeg} ← ${wasSeg}`];
  if (typeof session.compactionCount === 'number' && session.compactionCount > 0) {
    contextParts.push(`compaction #${session.compactionCount}`);
  }

  return `${header}\n${contextParts.join(' · ')}`;
}

/**
 * Tick interval for the live "starting" message elapsed-time updates.
 * 3s matches the MCP-status tracker's adaptive floor — fast enough to feel
 * live, slow enough to stay well inside Slack's chat.update rate limits.
 */
const COMPACT_STARTING_TICK_MS = 3_000;

/**
 * Safety ceiling for the ticker. If the SDK never emits
 * `compact_boundary`/`PostCompact` (catastrophic failure mode), we stop
 * spamming chat.update after this budget.
 */
const COMPACT_STARTING_TICKER_MAX_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Clear the live-starting ticker + its tracking fields. Idempotent —
 * `postCompactCompleteIfNeeded` calls this regardless of whether a ticker is
 * actually running (fallback-only codepaths never start one).
 */
function stopStartingTicker(session: ConversationSession): void {
  if (session.compactTickInterval) {
    clearInterval(session.compactTickInterval);
    session.compactTickInterval = undefined;
  }
}

/**
 * Shared START-post helper. Called by both the PreCompact hook and the
 * `status === 'compacting'` fallback in stream-executor.ts so the two paths
 * agree on epoch bookkeeping and the "starting" message text.
 *
 * On the first START signal per epoch we:
 *   1. Post the initial "⏳ 🗜️ Compaction starting · trigger=X" line.
 *   2. Capture its Slack ts on the session.
 *   3. Start a setInterval that `chat.update`s the message every 3s with
 *      elapsed time (MCP-status style live indicator).
 *
 * The ticker is cleared by `postCompactCompleteIfNeeded`; if that never
 * fires (SDK failure), a 10-minute safety ceiling stops the ticker anyway.
 *
 * Idempotent within a cycle via `marker.pre`. The dedupe latch is claimed
 * SYNCHRONOUSLY (before any await) so racing callers — PreCompact hook and
 * the `onStatusUpdate('compacting')` fallback IIFE in stream-executor — can
 * never both slip past the guard. Previously the assignment happened after
 * `await slackApi.postSystemMessage(...)`, which produced two posts + two
 * tickers; the first ticker's handle was overwritten and leaked (see
 * docs/issues/compact-bugs-trace/trace.md Hypothesis 1).
 */
export async function postCompactStartingIfNeeded(deps: CompactHookDeps, trigger: string): Promise<void> {
  const { session, channel, threadTs, slackApi } = deps;
  const epoch = beginCompactionCycleIfNeeded(session);

  const marker = ensurePostedMap(session)[epoch];
  if (!marker || marker.pre) return;

  // ATOMIC: claim the cycle synchronously BEFORE any await. This is the
  // only correct position — setting it after the Slack round-trip leaves a
  // race window where a parallel caller passes the guard and double-posts.
  marker.pre = true;

  // Snapshot usage% at pre-compact for the "was ~X%" end-of-cycle message,
  // then INVALIDATE the heuristic so we never present it as "now ~X%".
  //
  // Why null: `lastKnownUsagePct` is the last turn-end sample. Once we promote
  // it to `preCompactUsagePct`, the heuristic value is by definition a
  // pre-compact reading. If we leave it in place and `onCompactBoundary`
  // never fires with `post_tokens` (SDK doesn't always provide it),
  // `buildCompactCompleteMessage` falls into the `now ~${lastKnownUsagePct}%`
  // branch and prints the SAME number for both segments — e.g.
  // `now ~83% ← was ~83%`, the user-reported "auto-compact 후 남은
  // 컨텍스트량 계산 잘못" bug.
  //
  // Repopulation paths (any one is sufficient before the completion message):
  //   1. stream-executor.ts:1174 — onCompactBoundary post_tokens → real %.
  //   2. compact-threshold-checker.ts:70 — next turn-end usage sample.
  //
  // If neither runs in time, `nowSeg` honestly renders `now ~?%` instead of
  // regurgitating the pre-compact value as if it described post-compact state.
  //
  // CRITICAL: must run AFTER the marker.pre dedupe guard above, not before.
  // Two START paths exist (PreCompact hook + `status === 'compacting'`
  // fallback in stream-executor) and may both fire in the same cycle. If the
  // snapshot/invalidate ran before the guard, the second caller would read
  // `lastKnownUsagePct === null` (already invalidated by the first caller)
  // and overwrite `preCompactUsagePct` with null — destroying the captured
  // pre-compact value. The "was ~83%" segment would degrade to "was ~?%".
  // Caught by Codex review on PR #932.
  session.preCompactUsagePct = session.lastKnownUsagePct ?? null;
  session.lastKnownUsagePct = null;

  // Defensive: clear any pre-existing interval before we create a new one.
  // A prior cycle's ticker *should* have been stopped by
  // `postCompactCompleteIfNeeded`, but if anything slipped (crash, early
  // return, test harness leak) we must not stack intervals on the same
  // session — that's the runaway-ticker bug.
  stopStartingTicker(session);

  const resolvedTrigger = resolveStartingTrigger(session, trigger);
  const startedAtMs = Date.now();
  const initialText = buildCompactStartingMessage({ trigger: resolvedTrigger });
  session.compactStartedAtMs = startedAtMs;

  let postResult: { ts?: string; channel?: string };
  try {
    postResult = await slackApi.postSystemMessage(channel, initialText, { threadTs });
  } catch (err) {
    // Leave marker.pre=true so completion logic still considers the cycle
    // opened. No ts captured → completion path falls back to a fresh
    // `postSystemMessage`.
    logger.warn('compact-starting: initial post failed', {
      error: (err as Error)?.message ?? String(err),
    });
    session.compactStartingMessageTs = null;
    return;
  }

  // Track the live-message ts so the completion handler can chat.update it
  // in-place rather than posting a second message.
  session.compactStartingMessageTs = postResult.ts ?? null;

  if (!postResult.ts) return; // Slack post returned no ts — nothing to tick against.

  // Start the ticker. Each tick re-resolves the trigger from the session —
  // covers the "fallback path posted first, then onCompactBoundary filled in
  // session.compactTrigger" case so the live message self-corrects.
  const tsForUpdate = postResult.ts;
  session.compactTickInterval = setInterval(() => {
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= COMPACT_STARTING_TICKER_MAX_MS) {
      stopStartingTicker(session);
      return;
    }
    const tickTrigger = resolveStartingTrigger(session, trigger);
    const text = buildCompactStartingMessage({ trigger: tickTrigger, elapsedMs });
    // chat.update is fire-and-forget here; a single failure is harmless
    // because the next tick (or the completion update) will retry.
    slackApi.updateMessage(channel, tsForUpdate, text).catch((err) => {
      logger.debug('compact-starting ticker update failed (will retry next tick)', {
        error: (err as Error)?.message ?? String(err),
      });
    });
  }, COMPACT_STARTING_TICK_MS);
}

/**
 * Grace window for the PostCompact hook to let `onCompactBoundary` race in
 * first when it carries authoritative `compact_metadata` (pre/post tokens,
 * duration). The SDK emits `compact_boundary` as a system message AND fires
 * the PostCompact hook with no guaranteed ordering. Only the system message
 * carries token counts — so if PostCompact arrives first we'd render
 * `Context: now ~?% ← was ~?%` (see docs/issues/compact-bugs-trace Hypothesis
 * 2). 500 ms is generous vs. the microsecond-scale gap observed in practice
 * while short enough to stay invisible to users.
 */
const COMPACT_METADATA_WAIT_MS = 500;

/**
 * Whether the session already has SDK-authoritative metadata populated from
 * `onCompactBoundary`. We treat "any of the three boundary-only fields is
 * present" as sufficient — the three fields ship together on the
 * `compact_boundary` system message so if one is set, the boundary callback
 * already ran.
 */
function hasBoundaryMetadata(session: ConversationSession): boolean {
  return (
    typeof session.compactPreTokens === 'number' ||
    typeof session.compactPostTokens === 'number' ||
    typeof session.compactDurationMs === 'number'
  );
}

export interface PostCompactCompleteOpts {
  /**
   * Which callback invoked this. When `post-compact-hook` arrives without
   * boundary metadata we briefly wait for `onCompactBoundary` — it carries
   * the only source of pre/post token counts. `on-compact-boundary` posts
   * immediately because it's already the authoritative path.
   */
  source?: 'post-compact-hook' | 'on-compact-boundary';
}

/**
 * Shared END-post helper. Called by both the PostCompact hook and the
 * `onCompactBoundary` stream callback. On first call per epoch:
 *   1. Stops the live-starting ticker.
 *   2. Builds the rich 2-line completion message with SDK-reported
 *      pre/post tokens, trigger, duration, and Context-window snapshot.
 *   3. Replaces the "starting" message in-place via `chat.update` when we
 *      still have its ts (typical path), or posts a fresh system message as
 *      a fallback (e.g. the ts wasn't captured — Slack post failure on START).
 *   4. Marks the epoch rehydrated, clears `autoCompactPending`, and
 *      re-dispatches any captured user message atomically.
 *
 * The Slack post and the pending re-dispatch are independent → run in parallel.
 */
export async function postCompactCompleteIfNeeded(
  deps: CompactHookDeps,
  opts: PostCompactCompleteOpts = {},
): Promise<void> {
  const { session, channel, threadTs, slackApi, eventRouter } = deps;
  const epoch = getCurrentEpochForEnd(session);
  const marker = ensurePostedMap(session)[epoch];
  if (!marker) return;

  // PostCompact-hook-first ordering guard (see docs/issues/compact-bugs-trace
  // Hypothesis 2). When the SDK fires the PostCompact hook before the
  // `compact_boundary` system message, session.compactPreTokens/PostTokens/
  // DurationMs are still null and the completion message would render
  // `~?% ← was ~?%`. Give onCompactBoundary a brief grace window to arrive
  // and fill in metadata; if it races in, it will seal the cycle via
  // `marker.post = true` and this invocation becomes a no-op.
  if (opts.source === 'post-compact-hook' && !hasBoundaryMetadata(session) && !marker.post) {
    await new Promise<void>((resolve) => setTimeout(resolve, COMPACT_METADATA_WAIT_MS));
    // Early exit if the boundary callback sealed the cycle during the wait.
    // Re-read through the map because TS would narrow marker.post to `false`
    // through the enclosing guard — the boundary callback mutates via a
    // different reference on the same object, so the value may now be true.
    const current = ensurePostedMap(session)[epoch];
    if (current?.post) return;
  }

  // Stop the ticker BEFORE posting so a racing tick cannot clobber the
  // "completed" text back to "starting".
  stopStartingTicker(session);

  const postPromise =
    marker.post === true
      ? Promise.resolve()
      : (async () => {
          const text = buildCompactCompleteMessage(session);
          const startingTs = session.compactStartingMessageTs;
          // Track the ts of the message that actually carries the completion
          // text — chat.update keeps the original ts; the postSystemMessage
          // fallback creates a new one. We capture it for the deferred
          // "now %" update path below.
          let completionTs: string | null = null;
          if (startingTs) {
            // Replace the live "starting" message in-place. If the update
            // fails (message deleted, edit window expired, etc.) fall back
            // to posting a fresh system message so the user still sees the
            // completion signal.
            try {
              await slackApi.updateMessage(channel, startingTs, text);
              completionTs = startingTs;
            } catch (err) {
              logger.warn('compact complete: chat.update failed, falling back to new message', {
                error: (err as Error)?.message ?? String(err),
              });
              const fallback = await slackApi.postSystemMessage(channel, text, { threadTs });
              completionTs = fallback?.ts ?? null;
            }
          } else {
            // No starting ts (fallback-only path) → post a fresh message.
            const fallback = await slackApi.postSystemMessage(channel, text, { threadTs });
            completionTs = fallback?.ts ?? null;
          }
          marker.post = true;
          // Clear runtime-only START tracking now that the cycle is sealed.
          session.compactStartingMessageTs = null;
          session.compactStartedAtMs = null;
          // Deferred "now %" update path. The just-posted completion message
          // shows `now ~?% ← was ~80%` whenever the SDK didn't supply
          // `post_tokens` via onCompactBoundary (observed in production).
          // The literal `?` is honest but useless to the user — they want a
          // real number. Save the ts so the next turn-end usage sample (in
          // `checkAndSchedulePendingCompact`) can chat.update this message
          // in-place with `now ~25% ← was ~80%`. Skip the deferral when we
          // already rendered real numbers (compactPostTokens populated).
          if (completionTs && session.compactPostTokens === null) {
            session.compactCompletionMessageTs = completionTs;
          }
          // One-shot threshold-check suppression. The very first post-compact
          // turn's `session.usage` often still carries large cache_read tokens
          // from the pre-compact prefix (the SDK doesn't reset usage atomically
          // with the boundary), so `checkAndSchedulePendingCompact` would
          // immediately re-trip the threshold and post `Context usage 83% ≥
          // threshold 80%` right after we just announced "Compaction
          // completed". User-reported as a confusing auto-compact loop.
          // Skipping ONE check gives the next turn a chance to produce a
          // fresh, post-compact `session.usage` sample before we decide.
          //
          // CRITICAL: must be inside the IIFE (not after it). A second END
          // signal in the same cycle (PostCompact hook + onCompactBoundary
          // race) re-enters this function with `marker.post === true`, taking
          // the `Promise.resolve()` branch above. If suppression were set
          // outside the IIFE it would re-arm AFTER the next-turn threshold
          // check already consumed it, suppressing a legitimate later check.
          session.skipThresholdCheckOnce = true;
        })();

  // Rehydration dedupe: whichever END signal fires first marks the epoch so
  // the SessionStart(source=compact) hook doesn't double-rebuild.
  // Idempotent (set to the same value on re-entry), so safe outside the IIFE.
  ensureRehydratedMap(session)[epoch] = true;

  // Clear the "pending" flag so InputProcessor stops intercepting.
  // Idempotent (already false on re-entry), so safe outside the IIFE.
  session.autoCompactPending = false;

  // Consume pending atomically so a second END signal in the same cycle
  // cannot double-fire, then re-dispatch in parallel with the Slack post.
  let dispatchPromise: Promise<void> = Promise.resolve();
  if (session.pendingUserText && session.pendingEventContext && eventRouter) {
    const text = session.pendingUserText;
    const ctx = session.pendingEventContext;
    session.pendingUserText = null;
    session.pendingEventContext = null;
    dispatchPromise = eventRouter.dispatchPendingUserMessage(ctx, text);
  }

  await Promise.all([postPromise, dispatchPromise]);
}

/**
 * Deferred "now %" recovery for compact-completion messages that rendered
 * `now ~?%` because no SDK-authoritative `post_tokens` arrived in time.
 *
 * Called by `compact-threshold-checker.ts` after it writes a fresh
 * `session.lastKnownUsagePct` from the next turn-end usage sample. If the
 * prior compact cycle saved a `compactCompletionMessageTs`, rebuild the
 * completion text with the now-populated `lastKnownUsagePct` and chat.update
 * the message in-place. One-shot — clears the field on first call.
 *
 * Failure mode: chat.update can fail (message deleted, edit window expired).
 * We log and clear the field anyway — there's no retry budget for an
 * already-stale message, and re-attempting next turn just risks looping.
 *
 * Keeps Slack-message construction in this module so `compact-threshold-checker`
 * doesn't have to import `buildCompactCompleteMessage`.
 */
export async function updateDeferredCompactCompletionIfPending(
  deps: Pick<CompactHookDeps, 'session' | 'channel' | 'slackApi'>,
): Promise<void> {
  const { session, channel, slackApi } = deps;
  const ts = session.compactCompletionMessageTs;
  if (!ts) return;

  // Clear synchronously BEFORE the await so a concurrent caller (unlikely —
  // this runs from the threshold checker which is per-turn-end serialized,
  // but defensive) can't double-fire.
  session.compactCompletionMessageTs = null;

  const text = buildCompactCompleteMessage(session);
  try {
    await slackApi.updateMessage(channel, ts, text);
  } catch (err) {
    logger.warn('compact complete deferred update: chat.update failed', {
      error: (err as Error)?.message ?? String(err),
    });
  }
}

async function handlePreCompact(deps: CompactHookDeps, payload: PreCompactHookInput): Promise<void> {
  await postCompactStartingIfNeeded(deps, payload.trigger ?? 'unknown');
}

async function handlePostCompact(deps: CompactHookDeps, payload: PostCompactHookInput): Promise<void> {
  // Capture the trigger from the PostCompact payload ONLY when
  // `onCompactBoundary` hasn't already set it. Both signals carry the same
  // trigger in practice, but compact_boundary is the authoritative source
  // (it also carries token counts/duration), so if it raced in first we
  // keep its value verbatim. This guarantees the "trigger=manual|auto"
  // segment on the completion message regardless of ordering
  // (see docs/issues/compact-bugs-trace Hypothesis 2).
  if (!deps.session.compactTrigger && (payload?.trigger === 'manual' || payload?.trigger === 'auto')) {
    deps.session.compactTrigger = payload.trigger;
  }
  // `payload.compact_summary` is available for future diagnostics; unused today.
  await postCompactCompleteIfNeeded(deps, { source: 'post-compact-hook' });
}

async function handleSessionStart(deps: CompactHookDeps, payload: SessionStartHookInput): Promise<void> {
  const { session } = deps;
  // Only the post-compact session-start concerns us. Other sources (startup,
  // resume, clear) go through normal paths.
  if (payload.source !== 'compact') return;

  const epoch = getCurrentEpochForEnd(session);
  const rehydrated = ensureRehydratedMap(session);
  if (rehydrated[epoch]) return; // Already rebuilt via compact_boundary path.

  // The actual re-injection happens on the NEXT user prompt
  // (stream-executor.ts:399-406 consumes `session.compactionOccurred`).
  // Setting the legacy flag + the per-epoch dedupe keeps both paths consistent.
  if (buildCompactionContext(snapshotFromSession(session))) {
    session.compactionOccurred = true;
    // PLAN §3 — reset point (c): invalidate the cached systemPrompt snapshot
    // so the next rebuild lands on the reset branch in claude-handler.
    // The rebuild-gate also checks `compactionOccurred`, but clearing the
    // snapshot here makes the post-compact contract explicit and survives
    // refactors where the gate's condition changes.
    session.systemPrompt = undefined;
  }
  rehydrated[epoch] = true;
}
