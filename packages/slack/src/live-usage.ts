/**
 * Usage of the RUNNING turn (SSOT 2026-10-22 T1/T2).
 *
 * The SDK reports each API call's usage on its assistant message while the
 * turn runs; the turn's billing total arrives only with its result. The
 * dashboard shows the session's totals live, so the stream executor records
 * every call here (`session.liveUsage`, one entry per message id — a call that
 * is reported on several frames counts once) and the dashboard folds the sum
 * into the committed totals until the result lands in `usage.total*`, when the
 * executor clears it. Runtime-only state; never persisted.
 */

import { foldTaskSpend, type TaskUsage } from './session-usage-math';

export interface LiveUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface LiveUsageCall extends LiveUsageTotals {
  messageId?: string;
  /**
   * Spec 12 §2.5 — a subagent's call. It is spent (it counts in the totals)
   * but it read the subagent's own context, not the main agent's: never the
   * occupancy reading.
   */
  sidechain?: boolean;
}

/** Key prefix of a subagent's call in the live map (see {@link LiveUsageCall.sidechain}). */
const SIDECHAIN_KEY = 's:';

type LiveUsageHolder = {
  liveUsage?: Record<string, LiveUsageTotals>;
  liveUsageTurnId?: string;
  /** The turn whose result usage is already in the totals — never folded again. */
  liveUsageSettledTurnId?: string;
  /** The turn that adopted a compact boundary's occupancy (stream executor, issue #196). */
  postCompactOccupancyTurnId?: string;
  /**
   * The latest compact boundary: its turn and the calls that turn had made
   * before it (they read the pre-compact context). Keyed by turn like the
   * executor's shield, not by who owns the call map — same-session turns
   * overlap.
   */
  liveUsageBoundary?: { turnId?: string; keys: string[] };
  /** The task total (persisted) — a fold adds to it too (`foldTaskSpend`). */
  taskUsage?: TaskUsage;
  // A session object carries many other fields.
  [key: string]: unknown;
};

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Record one call's usage on the session (replaces an earlier report of the
 * same message). Same-session turns can overlap (a superseded turn's tail runs
 * next to its successor), so the calls belong to one turn: a call of another
 * turn starts the map afresh.
 */
export function recordLiveUsage(session: LiveUsageHolder, call: LiveUsageCall, turnId?: string): void {
  if (turnId !== undefined && session.liveUsageTurnId !== turnId) {
    session.liveUsage = undefined;
    session.liveUsageTurnId = turnId;
  }
  const map = session.liveUsage ?? {};
  session.liveUsage = map;
  const base = call.messageId ? `m:${call.messageId}` : `n:${Object.keys(map).length + 1}`;
  const key = call.sidechain ? `${SIDECHAIN_KEY}${base}` : base;
  map[key] = {
    inputTokens: count(call.inputTokens),
    outputTokens: count(call.outputTokens),
    cacheReadTokens: count(call.cacheReadTokens),
    cacheCreateTokens: count(call.cacheCreateTokens),
  };
}

/** Sum of the running turn's calls (zeros when there are none). */
export function sumLiveUsage(map: Record<string, LiveUsageTotals> | undefined): LiveUsageTotals {
  const total: LiveUsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
  if (!map) return total;
  for (const k of Object.keys(map)) {
    const c = map[k];
    total.inputTokens += count(c?.inputTokens);
    total.outputTokens += count(c?.outputTokens);
    total.cacheReadTokens += count(c?.cacheReadTokens);
    total.cacheCreateTokens += count(c?.cacheCreateTokens);
  }
  return total;
}

function callTotal(c: LiveUsageTotals): number {
  return count(c.inputTokens) + count(c.outputTokens) + count(c.cacheReadTokens) + count(c.cacheCreateTokens);
}

/**
 * A turn crossed a compact boundary: the calls it made so far read the
 * pre-compact context. Remembered so only its calls after the boundary count
 * as the context it holds (`liveOccupancyCall`). Recorded against the turn —
 * the same turn the executor's occupancy shield names — so a superseded turn's
 * boundary can neither block nor erase its successor's (review R5-1, R6). A
 * turn that has no calls in the map yet (none made, or the map is another
 * turn's) had none before the boundary.
 */
export function markLiveUsageBoundary(session: LiveUsageHolder, turnId: string | undefined): void {
  const own = turnId === undefined || session.liveUsageTurnId === turnId;
  session.liveUsageBoundary = { turnId, keys: own ? Object.keys(session.liveUsage ?? {}) : [] };
}

/**
 * The call that shows how full the context is now: the running turn's
 * largest. After a compact boundary in this turn (the executor's occupancy
 * shield, issue #196) only the calls made after it count — the earlier ones
 * read the pre-compact transcript; with no boundary mark, none do.
 */
export function liveOccupancyCall(
  session: Pick<LiveUsageHolder, 'liveUsage' | 'liveUsageTurnId' | 'postCompactOccupancyTurnId' | 'liveUsageBoundary'>,
): LiveUsageTotals | undefined {
  const turnId = session.liveUsageTurnId;
  const shielded = turnId !== undefined && session.postCompactOccupancyTurnId === turnId;
  const mark = session.liveUsageBoundary;
  const before = shielded && mark && mark.turnId === turnId ? mark.keys : undefined;
  if (shielded && !before) return undefined;
  let top: LiveUsageTotals | undefined;
  let topTotal = 0;
  for (const k of Object.keys(session.liveUsage ?? {})) {
    if (before?.includes(k)) continue;
    if (k.startsWith(SIDECHAIN_KEY)) continue;
    const c = session.liveUsage?.[k];
    if (!c) continue;
    const n = callTotal(c);
    if (n > topTotal) {
      topTotal = n;
      top = c;
    }
  }
  return top;
}

type OccupancyHolder = LiveUsageHolder & {
  usage?: {
    currentInputTokens?: number;
    currentOutputTokens?: number;
    currentCacheReadTokens?: number;
    currentCacheCreateTokens?: number;
  };
};

function writeOccupancy(u: NonNullable<OccupancyHolder['usage']>, top: LiveUsageTotals): void {
  u.currentInputTokens = count(top.inputTokens);
  u.currentOutputTokens = count(top.outputTokens);
  u.currentCacheReadTokens = count(top.cacheReadTokens);
  u.currentCacheCreateTokens = count(top.cacheCreateTokens);
}

/**
 * Make the running turn's context the session's occupancy as its calls land:
 * its largest main-agent call (`liveOccupancyCall`). Automatic compaction is
 * decided from this occupancy, so it must not wait for the turn's end — a turn
 * can run for hours, and one killed by a restart never ends (a dev deployment
 * 2026-10-30: three restarts killed one goal's turns at 528k, 701k and 950k;
 * no check ever ran). It REPLACES what was stored: the stored figure can be
 * stale (a compaction without `post_tokens` leaves the pre-compact one), and a
 * stale high would arm — and stop — the turn on its first small call.
 * Returns whether the turn had a reading.
 */
export function adoptLiveOccupancy(session: OccupancyHolder): boolean {
  const top = liveOccupancyCall(session);
  if (!session.usage || !top) return false;
  writeOccupancy(session.usage, top);
  return true;
}

/**
 * At a turn's end without its result (`foldLiveUsage`): the context the turn
 * reached becomes the occupancy only when larger, so a later switch still sees
 * how full it is.
 */
function raiseLiveOccupancy(session: OccupancyHolder): void {
  const u = session.usage;
  const top = liveOccupancyCall(session);
  if (!u || !top) return;
  const current =
    count(u.currentInputTokens) +
    count(u.currentOutputTokens) +
    count(u.currentCacheReadTokens) +
    count(u.currentCacheCreateTokens);
  if (callTotal(top) > current) writeOccupancy(u, top);
}

/**
 * A turn that ended without its result usage (stopped, transport lost) still
 * spent its reported calls: add them to the committed totals — priced by
 * `price` — so the live numbers the dashboard showed do not fall back. Only
 * this turn's calls; returns whether anything was folded. Clears the calls.
 */
export function foldLiveUsage(
  session: LiveUsageHolder & {
    usage?: {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreateTokens: number;
      totalCostUsd: number;
      currentInputTokens?: number;
      currentOutputTokens?: number;
      currentCacheReadTokens?: number;
      currentCacheCreateTokens?: number;
      /** What this fold added — the next resumed result settles it (`settleFoldedLiveUsage`). */
      foldedLiveUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreateTokens: number;
        costUsd: number;
        sdkSessionId?: string;
      };
    };
  },
  turnId: string | undefined,
  price: (totals: LiveUsageTotals) => number,
): boolean {
  if (turnId !== undefined && session.liveUsageTurnId !== undefined && session.liveUsageTurnId !== turnId) return false;
  if (turnId !== undefined && session.liveUsageSettledTurnId === turnId) {
    clearLiveUsage(session, turnId);
    return false;
  }
  const t = sumLiveUsage(session.liveUsage);
  const any = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreateTokens > 0;
  if (any && session.usage) {
    session.usage.totalInputTokens += t.inputTokens;
    session.usage.totalOutputTokens += t.outputTokens;
    session.usage.totalCacheReadTokens += t.cacheReadTokens;
    session.usage.totalCacheCreateTokens += t.cacheCreateTokens;
    let cost = 0;
    try {
      cost = price(t);
    } catch {
      cost = 0;
    }
    if (!Number.isFinite(cost) || cost < 0) cost = 0;
    session.usage.totalCostUsd += cost;
    // The transcript keeps these calls, so the next resumed result's running
    // total includes them again: remember what was folded so that result can
    // settle it instead of adding it twice.
    const folded = session.usage.foldedLiveUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd: 0,
    };
    folded.inputTokens += t.inputTokens;
    folded.outputTokens += t.outputTokens;
    folded.cacheReadTokens += t.cacheReadTokens;
    folded.cacheCreateTokens += t.cacheCreateTokens;
    folded.costUsd += cost;
    session.usage.foldedLiveUsage = folded;
    // The task total takes the same calls, remembered against the SDK session
    // whose next result carries them again.
    foldTaskSpend(
      session,
      { ...t, costUsd: cost },
      typeof session.sessionId === 'string' && session.sessionId ? session.sessionId : undefined,
    );
    // The context the turn reached (its largest call, after its compact
    // boundary when it had one) becomes the occupancy when larger, so a later
    // switch still sees how full it is.
    raiseLiveOccupancy(session);
  }
  clearLiveUsage(session, turnId);
  return any && !!session.usage;
}

/** The turn's result usage is in the totals: its live calls must never be folded on top. */
export function markLiveUsageSettled(session: LiveUsageHolder, turnId: string | undefined): void {
  if (turnId !== undefined) session.liveUsageSettledTurnId = turnId;
}

/**
 * Drop the running turn's calls — its result usage is in the totals now (or the
 * turn is over). With a turnId, only that turn's calls: a superseded turn's
 * cleanup must not wipe its successor's.
 */
export function clearLiveUsage(session: LiveUsageHolder, turnId?: string): void {
  if (turnId === undefined || session.liveUsageBoundary?.turnId === turnId) session.liveUsageBoundary = undefined;
  if (turnId !== undefined && session.liveUsageTurnId !== undefined && session.liveUsageTurnId !== turnId) return;
  session.liveUsage = undefined;
  session.liveUsageTurnId = undefined;
}
