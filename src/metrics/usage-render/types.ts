/**
 * Types for `/usage card` — personal usage stats carousel.
 * Trace: docs/usage-card-dark/trace.md — Scenario 2
 */

/**
 * Tab IDs in button render order.
 *
 * - `'24h' | '7d' | '30d' | 'all'` — period tabs (Overview view, period-scoped).
 * - `'models'`                     — per-model breakdown view (fixed 30d window).
 *
 * The carousel renders one PNG per id and switches between them via Block Kit
 * action buttons. `'models'` is treated as a peer tab so it shares the existing
 * cache / upload / `chat.update` plumbing instead of growing a parallel pipeline.
 */
export type TabId = '24h' | '7d' | '30d' | 'all' | 'models';

/** Subset of TabId that represents a calendar period (Overview view). */
export type PeriodTabId = Exclude<TabId, 'models'>;

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
  tabId: PeriodTabId;
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

/**
 * Synthetic model id used as the fold-row when there are more distinct models
 * in the window than `MODELS_TAB_MAX_ROWS`. A dedicated id (instead of an
 * empty string or null) so the breakdown table can show it as a normal row.
 */
export const OTHER_MODEL_ID = 'other';

/**
 * Per-model totals row for the Models tab breakdown list.
 *
 * Field names mirror `ModelTokenUsage` so a row can be built directly from a
 * model bucket via spread (`{ model, ...bucket }`). The total is derived via
 * `rowTotalTokens(row)` rather than stored — single source of truth.
 */
export interface ModelsTabRow {
  /** Full model id as recorded in `token_usage.metadata.modelBreakdown` keys, or `OTHER_MODEL_ID`. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** input + output + cacheRead + cacheCreate. Use everywhere a row's "total tokens" is needed. */
export function rowTotalTokens(row: ModelsTabRow): number {
  return row.inputTokens + row.outputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens;
}

/**
 * Per-model breakdown view (Models tab).
 *
 * Window is fixed at 30 days (matches the default Overview tab). Stacked bar
 * series are per-(day, model); one series per model in `rows`, keyed by
 * `dayKeys[i]` for the x-axis.
 */
export interface ModelsTabStats {
  empty: false;
  tabId: 'models';
  targetUserId: string;
  targetUserName?: string;
  windowStart: string; // YYYY-MM-DD (KST)
  windowEnd: string; // YYYY-MM-DD (KST)
  /** Sum of `totalTokens` across all rows — denominator for percentages. */
  totalTokens: number;
  /**
   * Per-model rows sorted by `totalTokens` desc. Limited to the top 8 at most;
   * remaining models (if any) are folded into a synthetic `model: 'other'`
   * row at the tail so the stacked bar's series count stays bounded.
   */
  rows: ModelsTabRow[];
  /**
   * 30 day-key labels (YYYY-MM-DD, KST), oldest → newest. Always length 30.
   * `dailyByModel[model][i]` is the token count for that model on `dayKeys[i]`.
   */
  dayKeys: string[];
  /**
   * Per-model per-day token series. Key = model id (matches `rows[*].model`).
   * Each value array has the same length as `dayKeys`. Includes the 'other'
   * fold row when the source data exceeded the top-N limit.
   */
  dailyByModel: Record<string, number[]>;
}

/** Empty-tab marker (0 events in window for target user). */
export interface EmptyTabStats {
  empty: true;
  tabId: TabId;
  windowStart: string;
  windowEnd: string;
}

/**
 * Result for one carousel tab.
 *
 * Period tabs (`'24h' | '7d' | '30d' | 'all'`) carry `CarouselTabStats`.
 * The `'models'` tab carries `ModelsTabStats`. Both fall back to
 * `EmptyTabStats` when no events exist in the window.
 */
export type TabResult = CarouselTabStats | ModelsTabStats | EmptyTabStats;

/**
 * Result for one period tab — narrower than `TabResult` so a `tab.empty`
 * guard alone is enough to narrow to `CarouselTabStats`. Used by callers
 * (and tests) that index `CarouselStats.tabs[periodId]`.
 */
export type PeriodTabResult = CarouselTabStats | EmptyTabStats;

/** Result for the Models tab — same shape rule, narrower. */
export type ModelsTabResult = ModelsTabStats | EmptyTabStats;

/**
 * Top-level carousel stats. Indexing `tabs[periodId]` yields a precise
 * `PeriodTabResult` so consumers don't have to redundantly check `tabId`
 * after the empty narrow. `tabs.models` yields `ModelsTabResult` for the
 * same reason.
 */
export interface CarouselStats {
  targetUserId: string;
  targetUserName?: string;
  now: string; // ISO 8601
  tabs: {
    '24h': PeriodTabResult;
    '7d': PeriodTabResult;
    '30d': PeriodTabResult;
    all: PeriodTabResult;
    models: ModelsTabResult;
  };
}
