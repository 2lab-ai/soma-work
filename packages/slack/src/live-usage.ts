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

export interface LiveUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface LiveUsageCall extends LiveUsageTotals {
  messageId?: string;
}

type LiveUsageHolder = {
  liveUsage?: Record<string, LiveUsageTotals>;
  liveUsageTurnId?: string;
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
  const key = call.messageId ? `m:${call.messageId}` : `n:${Object.keys(map).length + 1}`;
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

/**
 * Drop the running turn's calls — its result usage is in the totals now (or the
 * turn is over). With a turnId, only that turn's calls: a superseded turn's
 * cleanup must not wipe its successor's.
 */
export function clearLiveUsage(session: LiveUsageHolder, turnId?: string): void {
  if (turnId !== undefined && session.liveUsageTurnId !== undefined && session.liveUsageTurnId !== turnId) return;
  session.liveUsage = undefined;
  session.liveUsageTurnId = undefined;
}
