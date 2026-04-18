/**
 * Types for `/usage card` — personal usage stats PNG.
 * Trace: docs/usage-card/trace.md, Scenario 3
 */

export interface UsageCardRanking {
  userId: string;
  userName?: string;
  totalTokens: number;
  totalCost: number;
  rank: number;
}

export interface UsageCardSession {
  sessionKey: string;
  totalTokens: number;
  durationMs: number;
  firstEventAt: string; // ISO
  lastEventAt: string; // ISO
}

export interface UsageCardStats {
  empty?: false;
  targetUserId: string;
  targetUserName?: string;
  windowStart: string; // KST YYYY-MM-DD
  windowEnd: string;
  totals: {
    last24h: number;
    last7d: number;
    last30d: number;
    costLast30dUsd: number;
  };
  /**
   * 42-cell heatmap grid (7 cols × 6 rows).
   * Real 30 days fill the tail; leading blank cells have `date: ''` and `tokens: 0`.
   * Consumer reads `cellIndex % 7` = day-of-week, `Math.floor(cellIndex / 7)` = week row.
   */
  heatmap: Array<{ date: string; tokens: number; cellIndex: number }>;
  hourly: number[]; // length 24 (KST hour 0..23)
  rankings: {
    tokensTop: UsageCardRanking[];
    costTop: UsageCardRanking[];
    /**
     * Target user's token ranking row when they are outside the rendered top-5
     * (null when target is already inside the top-5). Rank reflects position in
     * the full sorted list, not the sliced view.
     */
    targetTokenRow: UsageCardRanking | null;
    /** Same as `targetTokenRow` but for cost-sorted rankings. */
    targetCostRow: UsageCardRanking | null;
  };
  sessions: {
    tokenTop3: UsageCardSession[];
    spanTop3: UsageCardSession[];
  };
  favoriteModel: { model: string; tokens: number } | null;
  /** Consecutive days (≥1 token) ending at windowEnd in KST. */
  currentStreakDays: number;
  totalSessions: number;
}

export interface EmptyStats {
  empty: true;
  windowStart: string;
  windowEnd: string;
  targetUserId: string;
}

export type UsageCardResult = UsageCardStats | EmptyStats;
