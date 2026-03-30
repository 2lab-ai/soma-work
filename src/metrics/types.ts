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
