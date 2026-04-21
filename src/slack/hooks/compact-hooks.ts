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
 * Idempotent within a cycle via `marker.pre`.
 */
export async function postCompactStartingIfNeeded(deps: CompactHookDeps, trigger: string): Promise<void> {
  const { session, channel, threadTs, slackApi } = deps;
  const epoch = beginCompactionCycleIfNeeded(session);

  // Snapshot usage% at pre-compact for the "was ~X%" end-of-cycle message.
  session.preCompactUsagePct = session.lastKnownUsagePct ?? null;

  const marker = ensurePostedMap(session)[epoch];
  if (!marker || marker.pre) return;

  const resolvedTrigger = resolveStartingTrigger(session, trigger);
  const startedAtMs = Date.now();
  const initialText = buildCompactStartingMessage({ trigger: resolvedTrigger });

  const result = await slackApi.postSystemMessage(channel, initialText, { threadTs });
  marker.pre = true;

  // Track the live-message ts so the completion handler can chat.update it
  // in-place rather than posting a second message.
  session.compactStartedAtMs = startedAtMs;
  session.compactStartingMessageTs = result.ts ?? null;

  if (!result.ts) return; // Slack post failed — nothing to tick against.

  // Start the ticker. Each tick re-resolves the trigger from the session —
  // covers the "fallback path posted first, then onCompactBoundary filled in
  // session.compactTrigger" case so the live message self-corrects.
  const tsForUpdate = result.ts;
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
export async function postCompactCompleteIfNeeded(deps: CompactHookDeps): Promise<void> {
  const { session, channel, threadTs, slackApi, eventRouter } = deps;
  const epoch = getCurrentEpochForEnd(session);
  const marker = ensurePostedMap(session)[epoch];
  if (!marker) return;

  // Stop the ticker BEFORE posting so a racing tick cannot clobber the
  // "completed" text back to "starting".
  stopStartingTicker(session);

  const postPromise =
    marker.post === true
      ? Promise.resolve()
      : (async () => {
          const text = buildCompactCompleteMessage(session);
          const ts = session.compactStartingMessageTs;
          if (ts) {
            // Replace the live "starting" message in-place. If the update
            // fails (message deleted, edit window expired, etc.) fall back
            // to posting a fresh system message so the user still sees the
            // completion signal.
            try {
              await slackApi.updateMessage(channel, ts, text);
            } catch (err) {
              logger.warn('compact complete: chat.update failed, falling back to new message', {
                error: (err as Error)?.message ?? String(err),
              });
              await slackApi.postSystemMessage(channel, text, { threadTs });
            }
          } else {
            // No starting ts (fallback-only path) → post a fresh message.
            await slackApi.postSystemMessage(channel, text, { threadTs });
          }
          marker.post = true;
          // Clear runtime-only START tracking now that the cycle is sealed.
          session.compactStartingMessageTs = null;
          session.compactStartedAtMs = null;
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
