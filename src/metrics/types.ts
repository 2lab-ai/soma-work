/**
 * Metrics types for daily/weekly report feature.
 * Trace: docs/daily-weekly-report/spec.md, Section 5.3-5.6
 */

export type MetricsEventType =
  | 'session_created'
  | 'session_slept'
  | 'session_closed'
  | 'issue_created'
  | 'pr_created'
  | 'commit_created'
  | 'code_lines_added'
  | 'pr_merged'
  | 'merge_lines_added'
  | 'turn_used';

export interface MetricsEvent {
  id: string;
  timestamp: number;
  eventType: MetricsEventType;
  userId: string;
  userName: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
}

export interface AggregatedMetrics {
  sessionsCreated: number;
  sessionsSlept: number;
  sessionsClosed: number;
  issuesCreated: number;
  prsCreated: number;
  commitsCreated: number;
  codeLinesAdded: number;
  codeLinesDeleted: number;
  prsMerged: number;
  mergeLinesAdded: number;
  turnsUsed: number;
}

export interface DailyReport {
  date: string;
  period: 'daily';
  metrics: AggregatedMetrics;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  period: 'weekly';
  metrics: AggregatedMetrics;
  rankings: UserRanking[];
}

export interface UserRanking {
  userId: string;
  userName: string;
  metrics: AggregatedMetrics;
  rank: number;
}

// === Enriched Report Types ===

/**
 * Derived metrics computed from raw AggregatedMetrics.
 */
export interface DerivedMetrics {
  productivityScore: number;       // Weighted composite score
  /**
   * prsMerged / prsCreated * 100 (%).
   * Note: this is in-period throughput, not cohort conversion — a PR created
   * and merged in different periods will be counted in separate buckets.
   */
  prMergeRate: number;
  avgCodePerPr: number;            // codeLinesAdded / prsCreated
  avgCodePerCommit: number;        // codeLinesAdded / commitsCreated
  avgTurnsPerSession: number;      // turnsUsed / sessionsCreated
  sessionCompletionRate: number;   // sessionsClosed / sessionsCreated * 100 (%)
  netLines: number;                // codeLinesAdded - codeLinesDeleted
  churnRatio: number;              // codeLinesDeleted / (codeLinesAdded + codeLinesDeleted) * 100, or 0
  avgChangedLinesPerPr: number;    // (codeLinesAdded + codeLinesDeleted) / prsCreated
  commitPerActiveDay: number;      // commitsCreated / activeDays
  prPerActiveDay: number;          // prsCreated / activeDays
}

/**
 * Trend comparison vs previous period.
 */
export interface TrendComparison {
  sessionsCreatedDelta: number;    // % change
  turnsUsedDelta: number;
  prsCreatedDelta: number;
  commitsCreatedDelta: number;
  codeLinesAddedDelta: number;
  prsMergedDelta: number;
  productivityScoreDelta: number;
  baselineZero: boolean;           // true if previous period had no activity
}

/**
 * Per-day breakdown for weekly heatmap.
 */
export interface DailyBreakdown {
  date: string;           // YYYY-MM-DD
  dayLabel: string;       // 월,화,수,목,금,토,일
  totalEvents: number;
  metrics: AggregatedMetrics;
}

/**
 * Hourly distribution for peak hour analysis.
 */
export interface HourlyDistribution {
  hour: number;           // 0-23
  eventCount: number;
}

/**
 * Achievement badge.
 */
export interface Achievement {
  icon: string;           // Emoji
  title: string;
  description: string;
}

/**
 * Fun fact / highlight.
 */
export interface FunFact {
  icon: string;
  text: string;
}

/**
 * Enriched daily report with derived metrics and trends.
 */
export interface EnrichedDailyReport extends DailyReport {
  derived: DerivedMetrics;
  trend: TrendComparison | null;   // null if no previous data
  hourlyDistribution: HourlyDistribution[];
  peakHour: number | null;
  achievements: Achievement[];
  funFacts: FunFact[];
}

/**
 * Enriched weekly report with derived metrics, heatmap, trends, achievements.
 */
export interface EnrichedWeeklyReport extends WeeklyReport {
  derived: DerivedMetrics;
  trend: TrendComparison | null;
  dailyBreakdown: DailyBreakdown[];
  hourlyDistribution: HourlyDistribution[];
  peakHour: number | null;
  activeDays: number;
  achievements: Achievement[];
  funFacts: FunFact[];
}

export interface ScheduleState {
  lastDailyDate?: string;
  lastWeeklyDate?: string;
}

export interface ReportConfig {
  channelId: string;
  timezone: string;
  dailyHour: number;
  weeklyDay: number;
  weeklyHour: number;
}
