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
 * Shared START-post helper. Called by both the PreCompact hook and the
 * `status === 'compacting'` fallback in stream-executor.ts so the two paths
 * agree on epoch bookkeeping and the "starting" message text.
 *
 * Idempotent within a cycle via `marker.pre`.
 */
export async function postCompactStartingIfNeeded(deps: CompactHookDeps, trigger: string): Promise<void> {
  const { session, channel, threadTs, slackApi } = deps;
  const epoch = beginCompactionCycleIfNeeded(session);

  // Snapshot usage% at pre-compact for the "was ~X%" end-of-cycle message.
  session.preCompactUsagePct = session.lastKnownUsagePct ?? null;

  const marker = ensurePostedMap(session)[epoch];
  if (!marker || marker.pre) return;

  await slackApi.postSystemMessage(channel, `🗜️ Compaction starting · trigger=${trigger}`, { threadTs });
  marker.pre = true;
}

/**
 * Shared END-post helper. Called by both the PostCompact hook and the
 * `onCompactBoundary` stream callback. Posts the "complete" message once per
 * epoch, marks the epoch rehydrated, clears `autoCompactPending`, and
 * re-dispatches any captured user message atomically.
 *
 * The Slack post and the pending re-dispatch are independent → run in parallel.
 */
export async function postCompactCompleteIfNeeded(deps: CompactHookDeps): Promise<void> {
  const { session, channel, threadTs, slackApi, eventRouter } = deps;
  const epoch = getCurrentEpochForEnd(session);
  const marker = ensurePostedMap(session)[epoch];
  if (!marker) return;

  const postPromise =
    marker.post === true
      ? Promise.resolve()
      : (async () => {
          await slackApi.postSystemMessage(
            channel,
            `✅ Compaction complete · was ~${fmtPct(session.preCompactUsagePct)}% → now ~${fmtPct(session.lastKnownUsagePct)}%`,
            { threadTs },
          );
          marker.post = true;
        })();

  // Rehydration dedupe: whichever END signal fires first marks the epoch so
  // the SessionStart(source=compact) hook doesn't double-rebuild.
  ensureRehydratedMap(session)[epoch] = true;

  // Clear the "pending" flag so InputProcessor stops intercepting.
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

async function handlePreCompact(deps: CompactHookDeps, payload: PreCompactHookInput): Promise<void> {
  await postCompactStartingIfNeeded(deps, payload.trigger ?? 'unknown');
}

async function handlePostCompact(deps: CompactHookDeps, payload: PostCompactHookInput): Promise<void> {
  // `payload` carries `compact_summary` for future diagnostics; unused today.
  void payload;
  await postCompactCompleteIfNeeded(deps);
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
  }
  rehydrated[epoch] = true;
}
