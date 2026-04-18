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

// ─── Carousel (v2) types ────────────────────────────────────────────
// Trace: docs/usage-card-dark/trace.md — Scenario 2

/** Tab IDs in button render order. */
export type TabId = '24h' | '7d' | '30d' | 'all';

/** Top-N token ranking entry (global across all users). */
export interface CarouselRanking {
  userId: string;
  userName?: string;
  totalTokens: number;
  rank: number;
}

/** One session entry in per-tab top-sessions list. */
export interface CarouselSession {
  sessionKey: string;
  totalTokens: number;
  durationMs: number;
}

/**
 * Per-tab carousel stats. One tab = one time window.
 * Heatmap shape is tab-specific (see `heatmap` field doc).
 */
export interface CarouselTabStats {
  empty: false;
  tabId: TabId;
  targetUserId: string;
  targetUserName?: string;
  windowStart: string; // YYYY-MM-DD (KST)
  windowEnd: string; // YYYY-MM-DD (KST)
  totals: {
    tokens: number;
    costUsd: number;
    sessions: number;
  };
  favoriteModel: { model: string; tokens: number } | null;
  /** Hourly 24-bin — always present but all-zero for 30d/all tabs. */
  hourly: number[]; // length 24
  /**
   * Heatmap cells — `tabId` determines shape:
   *  - '24h' → empty array (no heatmap; hourly bar chart instead)
   *  - '7d'  → 7*24 = 168 cells, cellIndex = dayIdx*24 + hour
   *  - '30d' → 35 cells (7 cols × 5 rows), cellIndex = row*7 + col
   *  - 'all' → up to 84 cells (12 months × 7 weekdays)
   */
  heatmap: Array<{ date: string; tokens: number; cellIndex: number; label?: string }>;
  /** Top-N rankings (global). Computed from 30d window only — shared across all tabs. */
  rankings: {
    tokensTop: CarouselRanking[];
    targetTokenRow: CarouselRanking | null;
  };
  /** Streak metrics */
  activeDays: number;
  longestStreakDays: number;
  currentStreakDays: number;
  /** Top sessions by total tokens — up to 3 */
  topSessions: CarouselSession[];
  longestSession: { sessionKey: string; durationMs: number } | null;
  mostActiveDay: { date: string; tokens: number } | null;
}

/** Empty-tab marker (0 events in window for target user). */
export interface EmptyTabStats {
  empty: true;
  tabId: TabId;
  windowStart: string;
  windowEnd: string;
}

export type TabResult = CarouselTabStats | EmptyTabStats;

/** Top-level carousel stats — 4 tabs keyed by `TabId`. */
export interface CarouselStats {
  targetUserId: string;
  targetUserName?: string;
  now: string; // ISO 8601
  tabs: Record<TabId, TabResult>;
}
